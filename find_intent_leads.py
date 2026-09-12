#!/usr/bin/env python3
"""
Web Intent Lead Finder — searches public web for businesses actively seeking admin help.
Runs 1x/day, qualifies results via Claude, logs HIGH/MEDIUM to Google Sheets.
"""

import os
import json
from datetime import datetime
import requests
from googleapiclient.discovery import build
from anthropic import Anthropic

# Config
GOOGLE_SEARCH_ENGINE_ID = "d1750679433a24384"
SHEET_ID = os.getenv("SHEET_ID")
GOOGLE_SEARCH_API_KEY = os.getenv("GOOGLE_SEARCH_API_KEY")
DISCORD_WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL")

# Constants
SEARCH_TAB_NAME = "Web Intent Search"
RESULTS_TAB_NAME = "Web Intent Leads"
RESULTS_PER_QUERY = 10  # max 10 per search
CLAUDE_MODEL = "claude-opus-4-20250805"

# Anthropic client
anthropic_client = Anthropic()


def get_google_sheets_client():
    """Authenticate to Google Sheets via Application Default Credentials."""
    from google.auth import default
    
    credentials, project = default(scopes=["https://www.googleapis.com/auth/spreadsheets"])
    return build("sheets", "v4", credentials=credentials)


def get_sheet_values(sheets_client, tab_name, range_string):
    """Read a range from a Google Sheet."""
    try:
        result = sheets_client.spreadsheets().values().get(
            spreadsheetId=SHEET_ID,
            range=f"{tab_name}!{range_string}"
        ).execute()
        return result.get("values", [])
    except Exception as e:
        print(f"Error reading Sheet: {e}")
        return []


def append_sheet_values(sheets_client, tab_name, values):
    """Append rows to a Google Sheet."""
    try:
        sheets_client.spreadsheets().values().append(
            spreadsheetId=SHEET_ID,
            range=f"{tab_name}!A:G",
            valueInputOption="USER_ENTERED",
            body={"values": values}
        ).execute()
    except Exception as e:
        print(f"Error appending to Sheet: {e}")


def get_enabled_phrases(sheets_client):
    """Read enabled search phrases from Web Intent Search tab."""
    rows = get_sheet_values(sheets_client, SEARCH_TAB_NAME, "A2:C")
    phrases = []
    for row in rows:
        if len(row) >= 2 and row[1].upper() == "TRUE":
            phrases.append(row[0])
    return phrases


def get_existing_urls(sheets_client):
    """Get all URLs already in Web Intent Leads to check for duplicates."""
    rows = get_sheet_values(sheets_client, RESULTS_TAB_NAME, "D2:D")
    urls = set()
    for row in rows:
        if len(row) > 0:
            urls.add(row[0])
    return urls


def search_web(phrase):
    """Search the public web using Google Custom Search API."""
    url = "https://www.googleapis.com/customsearch/v1"
    params = {
        "q": phrase,
        "cx": GOOGLE_SEARCH_ENGINE_ID,
        "key": GOOGLE_SEARCH_API_KEY,
        "num": RESULTS_PER_QUERY,
        "sort": "date"  # Prioritize recent results
    }
    try:
        response = requests.get(url, params=params)
        response.raise_for_status()
        data = response.json()
        return data.get("items", [])
    except Exception as e:
        print(f"Error searching for '{phrase}': {e}")
        return []


def fetch_page_content(url):
    """Fetch the content of a URL."""
    try:
        response = requests.get(url, timeout=10)
        response.raise_for_status()
        return response.text[:5000]  # Limit to first 5000 chars to avoid huge pages
    except Exception as e:
        print(f"Error fetching {url}: {e}")
        return ""


def qualify_lead(title, snippet, content, source):
    """Use Claude to determine if this is a HIGH/MEDIUM/SKIP lead."""
    prompt = f"""
You are evaluating a search result for a business or person actively seeking administrative support.

Result:
- Title: {title}
- Snippet: {snippet}
- Source: {source}
- Page Content (first 5000 chars): {content}

Aurum Ventura provides:
- Administrative support
- Back-office support
- Document management
- Invoice administration
- Vendor administration
- Data entry
- CRM support
- File organization
- Forms and paperwork
- License and renewal tracking
- General business administration

Based on this result, is the person/business actively seeking help with something Aurum Ventura can solve?

Respond ONLY with ONE of:
- HIGH: actively asking for help or recommendations now
- MEDIUM: clearly describing an administrative problem Aurum Ventura could solve
- SKIP: informational content, job posting, irrelevant, outdated, or no clear business intent

Then on the next line, provide a 1-2 sentence explanation (for logging purposes).
"""
    
    try:
        message = anthropic_client.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=100,
            messages=[
                {"role": "user", "content": prompt}
            ]
        )
        response_text = message.content[0].text.strip()
        lines = response_text.split("\n", 1)
        intent = lines[0].strip().upper()
        explanation = lines[1].strip() if len(lines) > 1 else ""
        
        if intent in ["HIGH", "MEDIUM", "SKIP"]:
            return intent, explanation
        else:
            return "SKIP", "Could not determine intent"
    except Exception as e:
        print(f"Error qualifying lead: {e}")
        return "SKIP", f"Claude error: {str(e)}"


def generate_reply(business_name, what_they_need):
    """Generate a short, natural reply for the Suggested Reply column."""
    prompt = f"""
Generate a short, natural, non-salesy reply to someone asking for help with: {what_they_need}

Business/Person: {business_name}

The reply should be:
- 1-2 sentences max
- Friendly and helpful
- Not overly promotional
- Something like: "Hey, we actually help small businesses with this kind of work. Happy to connect if you're still looking."

Respond with ONLY the reply text, nothing else.
"""
    
    try:
        message = anthropic_client.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=50,
            messages=[
                {"role": "user", "content": prompt}
            ]
        )
        return message.content[0].text.strip()
    except Exception as e:
        return "We help small businesses with administrative support. Interested in chatting?"


def run():
    """Main workflow."""
    print("Starting Web Intent Lead Finder...")
    
    sheets_client = get_google_sheets_client()
    
    # Get search phrases
    phrases = get_enabled_phrases(sheets_client)
    print(f"Found {len(phrases)} enabled search phrases")
    
    # Get existing URLs to avoid duplicates
    existing_urls = get_existing_urls(sheets_client)
    print(f"Found {len(existing_urls)} existing URLs (will skip duplicates)")
    
    new_leads = []
    discord_summary = {
        "total_results": 0,
        "qualified_high": 0,
        "qualified_medium": 0,
        "skipped": 0,
        "leads": []
    }
    
    # Search each phrase
    for phrase in phrases:
        print(f"\nSearching: '{phrase}'")
        results = search_web(phrase)
        
        for result in results:
            url = result.get("link", "")
            title = result.get("title", "")
            snippet = result.get("snippet", "")
            source_domain = url.split("/")[2] if url else "unknown"
            
            discord_summary["total_results"] += 1
            
            # Skip if URL already exists
            if url in existing_urls:
                print(f"  ✓ Duplicate: {url}")
                continue
            
            # Fetch page content
            print(f"  → Fetching: {url}")
            content = fetch_page_content(url)
            
            if not content:
                print(f"    Could not fetch content")
                continue
            
            # Qualify via Claude
            intent, explanation = qualify_lead(title, snippet, content, source_domain)
            
            if intent == "SKIP":
                discord_summary["skipped"] += 1
                print(f"    ✗ SKIP: {explanation}")
                continue
            
            # Generate suggested reply
            reply = generate_reply(title, snippet)
            
            # Extract business name from title or snippet
            business_name = title.split(" - ")[0] if " - " in title else title
            
            # Prepare row for sheet
            date_found = datetime.utcnow().strftime("%Y-%m-%d")
            row = [
                date_found,
                source_domain,
                business_name,
                url,
                snippet[:100],
                intent,
                reply
            ]
            new_leads.append(row)
            
            if intent == "HIGH":
                discord_summary["qualified_high"] += 1
                print(f"    ✓ HIGH: {explanation}")
            else:
                discord_summary["qualified_medium"] += 1
                print(f"    ◆ MEDIUM: {explanation}")
            
            discord_summary["leads"].append({
                "business": business_name,
                "source": source_domain,
                "intent": intent
            })
    
    # Append new leads to sheet
    if new_leads:
        print(f"\nAppending {len(new_leads)} new leads to Sheet...")
        append_sheet_values(sheets_client, RESULTS_TAB_NAME, new_leads)
    
    # Send Discord summary
    send_discord_summary(discord_summary)
    
    print("\n✓ Web Intent Lead Finder complete")


def send_discord_summary(summary):
    """Send a Discord webhook summary."""
    if not DISCORD_WEBHOOK_URL:
        print("No Discord webhook configured")
        return
    
    message = {
        "content": f"🔍 **Web Intent Lead Finder** — {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}",
        "embeds": [
            {
                "color": 3447003,
                "fields": [
                    {
                        "name": "Total Results Scanned",
                        "value": str(summary["total_results"]),
                        "inline": True
                    },
                    {
                        "name": "HIGH Intent",
                        "value": str(summary["qualified_high"]),
                        "inline": True
                    },
                    {
                        "name": "MEDIUM Intent",
                        "value": str(summary["qualified_medium"]),
                        "inline": True
                    },
                    {
                        "name": "Skipped",
                        "value": str(summary["skipped"]),
                        "inline": True
                    }
                ]
            }
        ]
    }
    
    if summary["leads"]:
        leads_text = "\n".join([f"• {l['business']} ({l['intent']}) — {l['source']}" for l in summary["leads"][:5]])
        message["embeds"][0]["fields"].append({
            "name": "Sample Leads",
            "value": leads_text,
            "inline": False
        })
    
    try:
        requests.post(DISCORD_WEBHOOK_URL, json=message)
    except Exception as e:
        print(f"Error sending Discord message: {e}")


if __name__ == "__main__":
    run()
