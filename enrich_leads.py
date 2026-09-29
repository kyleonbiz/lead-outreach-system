import json
import time
import re
import requests
from urllib.parse import urljoin
from concurrent.futures import ThreadPoolExecutor

HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; LeadEnrichmentBot/1.0)"}
TIMEOUT = 8
WORKERS = 12  # check 12 different websites at the same time

EMAIL_RE = re.compile(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}')
JUNK_TLDS = {"png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp", "css", "js"}
JUNK_DOMAINS = {"sentry.io", "example.com", "wixpress.com", "godaddy.com", "schema.org", "w3.org", "domain.com", "email.com", "test.com"}

SOCIAL_DOMAINS = {
    "facebook": "facebook.com",
    "instagram": "instagram.com",
    "linkedin": "linkedin.com",
    "twitter": "twitter.com",
    "x": "x.com",
}

CONTACT_LINK_RE = re.compile(r'href=["\']([^"\']*(?:contact|about)[^"\']*)["\']', re.IGNORECASE)


def fetch(url):
    try:
        resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        if resp.status_code == 200:
            return resp.text
    except requests.RequestException:
        return None
    return None


def extract_emails(html):
    found = set()
    for match in EMAIL_RE.findall(html or ""):
        email = match.lower().strip(".")
        domain = email.split("@")[-1]
        tld = domain.split(".")[-1]
        if tld in JUNK_TLDS or domain in JUNK_DOMAINS:
            continue
        found.add(email)
    return found


def extract_socials(html):
    socials = {}
    for name, domain in SOCIAL_DOMAINS.items():
        m = re.search(rf'https?://(?:www\.)?{re.escape(domain)}/[A-Za-z0-9_./-]+', html or "")
        if m:
            socials[name] = m.group(0)
    return socials


def find_contact_page(base_url, html):
    match = CONTACT_LINK_RE.search(html or "")
    if match:
        return urljoin(base_url, match.group(1))
    return None


def enrich_lead(lead):
    website = lead.get("website")
    if not website:
        lead["email"] = ""
        lead["all_emails_found"] = ""
        lead["socials"] = {}
        lead["enrichment_status"] = "no_website"
        return lead

    html = fetch(website)
    if html is None:
        lead["email"] = ""
        lead["all_emails_found"] = ""
        lead["socials"] = {}
        lead["enrichment_status"] = "site_unreachable"
        return lead

    emails = extract_emails(html)
    socials = extract_socials(html)

    contact_url = find_contact_page(website, html)
    if contact_url and contact_url != website:
        time.sleep(1)  # be polite to the same site between page loads
        contact_html = fetch(contact_url)
        if contact_html:
            emails |= extract_emails(contact_html)
            socials.update(extract_socials(contact_html))

    lead["email"] = sorted(emails)[0] if emails else ""
    lead["all_emails_found"] = ", ".join(sorted(emails))
    lead["socials"] = socials
    lead["enrichment_status"] = "enriched" if emails else "no_email_found"
    return lead


def safe_enrich(lead):
    try:
        return enrich_lead(lead)
    except Exception as e:
        lead["email"] = ""
        lead["all_emails_found"] = ""
        lead["socials"] = {}
        lead["enrichment_status"] = f"error: {type(e).__name__}"
        return lead


if __name__ == "__main__":
    with open("leads_raw.json") as f:
        leads = json.load(f)

    print(f"Enriching {len(leads)} businesses ({WORKERS} at a time)...")
    start = time.time()
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        enriched = list(pool.map(safe_enrich, leads))

    with open("leads_enriched.json", "w") as f:
        json.dump(enriched, f, indent=2)

    found_count = sum(1 for l in enriched if l.get("email"))
    print(f"\nDone in {int(time.time() - start)}s. Found emails for {found_count}/{len(enriched)} businesses.")
    print("Saved to leads_enriched.json")
