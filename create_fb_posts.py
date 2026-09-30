"""
create_fb_posts.py
Weekly Facebook post generator for Aurum Ventura.

- Reads aurumventura.net so posts stay on-topic and on-brand
- Rotates through services x industries (77 unique combos) so topics don't repeat
- Has Claude write 5 Facebook posts (Mon-Fri)
- Sends them to the Discord channel webhook in DISCORD_FB_POSTS_WEBHOOK

Env vars:
  ANTHROPIC_API_KEY          (required)
  DISCORD_FB_POSTS_WEBHOOK   (required)
  CLAUDE_MODEL               (optional, default below)
"""

import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timedelta
from html.parser import HTMLParser
from zoneinfo import ZoneInfo

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
DISCORD_WEBHOOK = os.environ.get("DISCORD_FB_POSTS_WEBHOOK", "").strip()
CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-5").strip()

SITE_PAGES = [
    "https://aurumventura.net/",
    "https://aurumventura.net/services",
    "https://aurumventura.net/how-it-works",
    "https://aurumventura.net/about",
]

SERVICES = [
    "Document Preparation & Management",
    "Invoice Administration",
    "License & Renewal Tracking",
    "Vendor Administration",
    "CRM & Data Management",
    "Project Administration",
    "Forms & Paperwork",
    "Data Entry & Reporting",
    "General Administrative Support",
    "Business File Reset (one-time project)",
    "Back Office Setup (one-time project)",
]

INDUSTRIES = [
    "Contractors & Trades",
    "Property Management",
    "Cleaning & Facility Services",
    "Construction / Subcontractors",
    "Staffing & Recruiting",
    "Real Estate",
    "Professional Services",
]

DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
CENTRAL = ZoneInfo("America/Chicago")
USER_AGENT = "Mozilla/5.0 (compatible; AurumPostBot/1.0; +https://aurumventura.net)"


# ---------- website text ----------

class _TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "noscript", "svg"):
            self._skip += 1

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript", "svg") and self._skip:
            self._skip -= 1

    def handle_data(self, data):
        if not self._skip:
            text = data.strip()
            if text:
                self.parts.append(text)


def fetch_page_text(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=20) as resp:
            html = resp.read().decode("utf-8", errors="ignore")
        parser = _TextExtractor()
        parser.feed(html)
        text = " ".join(parser.parts)
        return re.sub(r"\s+", " ", text)[:6000]
    except Exception as e:
        print(f"WARN: could not fetch {url}: {e}")
        return ""


def get_site_text():
    chunks = []
    for url in SITE_PAGES:
        text = fetch_page_text(url)
        if text:
            chunks.append(f"--- PAGE: {url} ---\n{text}")
    if not chunks:
        raise RuntimeError("Could not read any pages from aurumventura.net")
    return "\n\n".join(chunks)


# ---------- topic rotation ----------

def week_topics(today):
    """5 (service, industry) pairs for this ISO week. 11 and 7 are coprime,
    so the rotation covers all 77 combos before any repeat (~15 weeks)."""
    iso_year, iso_week, _ = today.isocalendar()
    base = (iso_year * 53 + iso_week) * 5
    topics = []
    for i in range(5):
        idx = base + i
        topics.append((SERVICES[idx % len(SERVICES)], INDUSTRIES[idx % len(INDUSTRIES)]))
    return topics


def week_dates(today):
    monday = today - timedelta(days=today.weekday())
    return [monday + timedelta(days=i) for i in range(5)]


# ---------- Claude ----------

def build_prompt(site_text, topics, dates):
    plan_lines = []
    for day, d, (service, industry) in zip(DAYS, dates, topics):
        plan_lines.append(f"- {day} {d.strftime('%b %d')}: service = {service}; audience = {industry}")
    plan = "\n".join(plan_lines)

    return f"""You write Facebook posts for Aurum Ventura's business page.

SOURCE OF TRUTH - the company website (use ONLY facts found here):
{site_text}

THIS WEEK'S PLAN (one post per line, follow exactly):
{plan}

RULES
- Stay strictly on topic: back-office / administrative support as described on the website. Never drift into other topics.
- Only mention services, process steps, and claims that appear on the website. Do not invent statistics, pricing, testimonials, clients, or guarantees.
- The only numeric claim allowed is the website's "10-16 hours/week" if it fits.
- Respect the site's limits: invoice work is not debt collection; license tracking is administrative, not legal advice; forms needing licensed judgment go to licensed professionals.
- Tone: professional, direct, problem-focused. Open with a relatable pain point for the audience, then show how the service solves it.
- 60-140 words per post. Short paragraphs. 0-3 emojis max. 2-4 relevant hashtags at the end.
- End each post with ONE call to action using one of: aurumventura.net/contact, aurumventura.net/services, aurumventura.net/how-it-works, admin@aurumventura.net, 850-653-7797.
- You may use the tagline "Back Office. Without the Hire." sparingly (max 2 of the 5 posts).
- Each of the 5 posts must feel different (question hook, checklist, before/after, quick tip, etc.).

OUTPUT
Return ONLY a JSON array of 5 objects, no other text:
[{{"day": "Monday", "service": "...", "industry": "...", "post": "full post text", "image_idea": "one-sentence image/graphic suggestion"}}]
"""


def call_claude(prompt):
    body = json.dumps({
        "model": CLAUDE_MODEL,
        "max_tokens": 4000,
        "messages": [{"role": "user", "content": prompt}],
    }).encode("utf-8")
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        headers={
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Claude API error {e.code}: {e.read().decode('utf-8', errors='ignore')}")
    return "".join(block.get("text", "") for block in data.get("content", []))


def parse_posts(raw):
    raw = raw.strip()
    start, end = raw.find("["), raw.rfind("]")
    if start == -1 or end == -1:
        raise RuntimeError(f"Claude did not return JSON:\n{raw[:500]}")
    posts = json.loads(raw[start:end + 1])
    if not isinstance(posts, list) or not posts:
        raise RuntimeError("Claude returned an empty or invalid post list")
    return posts


# ---------- Discord ----------

def send_discord(content):
    body = json.dumps({"username": "Aurum FB Posts", "content": content[:1990]}).encode("utf-8")
    req = urllib.request.Request(
        DISCORD_WEBHOOK,
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": "DiscordBot (lead-outreach-system, 1.0)"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        if resp.status not in (200, 204):
            raise RuntimeError(f"Discord returned {resp.status}")


# ---------- main ----------

def main():
    if not ANTHROPIC_API_KEY:
        sys.exit("ERROR: ANTHROPIC_API_KEY is not set")
    if not DISCORD_WEBHOOK:
        sys.exit("ERROR: DISCORD_FB_POSTS_WEBHOOK is not set")

    today = datetime.now(CENTRAL).date()
    topics = week_topics(today)
    dates = week_dates(today)

    print("Reading aurumventura.net ...")
    site_text = get_site_text()

    print(f"Asking Claude ({CLAUDE_MODEL}) for 5 posts ...")
    posts = parse_posts(call_claude(build_prompt(site_text, topics, dates)))

    send_discord(
        f"📣 **Aurum Ventura - Facebook posts for the week of {dates[0].strftime('%b %d, %Y')}**\n"
        f"{len(posts)} posts below. Copy each into Facebook / Meta Business Suite."
    )

    for i, p in enumerate(posts):
        date_label = dates[i].strftime("%a %b %d") if i < len(dates) else p.get("day", "")
        msg = (
            f"**Post {i + 1} - {date_label}**\n"
            f"*{p.get('service', '')} · {p.get('industry', '')}*\n"
            f"```\n{p.get('post', '').strip()}\n```\n"
            f"🖼️ Image idea: {p.get('image_idea', '').strip()}"
        )
        send_discord(msg)
        print(f"Sent post {i + 1}")

    print("Done.")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"FAILED: {e}")
        if DISCORD_WEBHOOK:
            try:
                send_discord(f"⚠️ Aurum FB post generator failed: {str(e)[:1500]}")
            except Exception:
                pass
        sys.exit(1)
