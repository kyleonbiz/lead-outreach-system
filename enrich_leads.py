import json
import time
import re
import html as htmllib
import requests
from urllib.parse import urljoin, urlparse, unquote
from concurrent.futures import ThreadPoolExecutor

HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; LeadEnrichmentBot/1.0)"}
TIMEOUT = 8
WORKERS = 12  # check 12 different websites at the same time
MAX_EXTRA_PAGES = 4  # extra pages per site beyond the homepage

EMAIL_RE = re.compile(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}')
CFEMAIL_RE = re.compile(r'data-cfemail=["\']([0-9a-fA-F]+)["\']')
CONTACT_LINK_RE = re.compile(r'href=["\']([^"\']*(?:contact|about)[^"\']*)["\']', re.IGNORECASE)
FALLBACK_PATHS = ["/contact", "/contact-us", "/about", "/about-us"]

JUNK_TLDS = {"png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp", "css", "js", "pdf", "mp4"}
JUNK_DOMAINS = {
    "sentry.io", "sentry-next.wixpress.com", "example.com", "wixpress.com", "godaddy.com",
    "schema.org", "w3.org", "domain.com", "email.com", "test.com", "yourdomain.com",
    "sentry.wixpress.com", "squarespace.com", "wordpress.com", "mysite.com", "website.com",
}
FREE_PROVIDERS = {
    "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "aol.com", "icloud.com",
    "live.com", "msn.com", "comcast.net", "att.net", "bellsouth.net", "sbcglobal.net",
    "verizon.net", "me.com", "protonmail.com", "ymail.com",
}
# Addresses we never want to pitch to
BAD_PREFIXES = {
    "noreply", "no-reply", "donotreply", "do-not-reply", "careers", "career", "jobs", "job",
    "hr", "recruiting", "recruitment", "resume", "resumes", "privacy", "legal", "abuse",
    "postmaster", "webmaster", "hostmaster", "unsubscribe", "billing", "invoices", "invoice",
    "press", "media", "dmca", "example", "test", "user", "name", "email", "your", "yourname",
    "youremail", "someone", "firstname", "first.last", "johndoe", "john.doe", "wordpress",
}
# Good shared inboxes, best first
GOOD_GENERIC = ["owner", "info", "contact", "office", "hello", "admin", "frontdesk",
                "appointments", "service", "sales", "team", "mail", "inquiries", "support"]

# Other department inboxes: usable, but below the ones above and below a person's name
ROLE_WORDS = {
    "marketing", "accounting", "accounts", "scheduling", "schedule", "orders", "order",
    "bookings", "booking", "dispatch", "estimates", "estimate", "quotes", "quote",
    "customerservice", "help", "reception", "manager", "general", "enquiries", "enquiry",
    "service", "services", "social", "events", "web", "website", "online", "leads",
}

SOCIAL_DOMAINS = {
    "facebook": "facebook.com",
    "instagram": "instagram.com",
    "linkedin": "linkedin.com",
    "twitter": "twitter.com",
    "x": "x.com",
}


def fetch(url):
    try:
        resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        if resp.status_code == 200 and "html" in resp.headers.get("Content-Type", "html"):
            return resp.text
    except requests.RequestException:
        return None
    return None


def root_domain(url_or_domain):
    host = urlparse(url_or_domain).netloc if "//" in url_or_domain else url_or_domain
    host = host.lower().split(":")[0]
    return host[4:] if host.startswith("www.") else host


def decode_cfemail(hexstr):
    """Decode Cloudflare-protected emails (common on small business sites)."""
    try:
        key = int(hexstr[:2], 16)
        return "".join(chr(int(hexstr[i:i + 2], 16) ^ key) for i in range(2, len(hexstr), 2))
    except ValueError:
        return ""


def extract_emails(page):
    if not page:
        return set()
    text = htmllib.unescape(unquote(page))
    candidates = set(EMAIL_RE.findall(text))
    for hexstr in CFEMAIL_RE.findall(page):
        candidates.add(decode_cfemail(hexstr))

    found = set()
    for match in candidates:
        email = match.lower().strip(".").strip()
        if "@" not in email:
            continue
        local, domain = email.rsplit("@", 1)
        tld = domain.split(".")[-1]
        if tld in JUNK_TLDS or domain in JUNK_DOMAINS or not tld.isalpha():
            continue
        if len(local) > 40 or re.fullmatch(r"[0-9a-f]{16,}", local):
            continue  # tracking IDs, not real inboxes
        if local in BAD_PREFIXES:
            continue
        found.add(email)
    return found


def score_email(email, site_domain):
    local, domain = email.rsplit("@", 1)
    on_domain = site_domain and (domain == site_domain or domain.endswith("." + site_domain))
    if on_domain:
        score = 100
    elif domain in FREE_PROVIDERS:
        score = 60  # lots of small businesses use gmail etc.
    else:
        score = 0   # probably a web designer or platform address

    if local in GOOD_GENERIC:
        score += 20 - GOOD_GENERIC.index(local)  # owner/info/contact rank highest
    elif local in ROLE_WORDS:
        score += 5
    elif re.fullmatch(r"[a-z]+([._-][a-z]+)?", local):
        score += 30  # looks like a person's name, e.g. mike@ or mike.jones@
    return score


def best_email(emails, site_domain):
    if not emails:
        return ""
    return max(sorted(emails), key=lambda e: score_email(e, site_domain))


def has_good_email(emails, site_domain):
    return any(score_email(e, site_domain) >= 100 for e in emails)


def extract_socials(page):
    socials = {}
    for name, domain in SOCIAL_DOMAINS.items():
        m = re.search(rf'https?://(?:www\.)?{re.escape(domain)}/[A-Za-z0-9_./-]+', page or "")
        if m:
            socials[name] = m.group(0)
    return socials


def extra_pages(base_url, page):
    """Contact/about links found on the homepage first, then common paths."""
    urls = []
    site = root_domain(base_url)
    for href in CONTACT_LINK_RE.findall(page or ""):
        full = urljoin(base_url, href)
        if root_domain(full) == site and full not in urls:
            urls.append(full)
    for path in FALLBACK_PATHS:
        full = urljoin(base_url, path)
        if full not in urls:
            urls.append(full)
    return [u for u in urls if u.rstrip("/") != base_url.rstrip("/")][:MAX_EXTRA_PAGES]


def empty(lead, status):
    lead["email"] = ""
    lead["all_emails_found"] = ""
    lead["socials"] = {}
    lead["enrichment_status"] = status
    return lead


def enrich_lead(lead):
    website = lead.get("website")
    if not website:
        return empty(lead, "no_website")

    home = fetch(website)
    if home is None:
        return empty(lead, "site_unreachable")

    site_domain = root_domain(website)
    emails = extract_emails(home)
    socials = extract_socials(home)

    # Keep checking contact/about pages until we find an email on the business's own domain
    for url in extra_pages(website, home):
        if has_good_email(emails, site_domain):
            break
        time.sleep(0.5)  # be polite to the same site between page loads
        page = fetch(url)
        if page:
            emails |= extract_emails(page)
            for k, v in extract_socials(page).items():
                socials.setdefault(k, v)

    lead["email"] = best_email(emails, site_domain)
    lead["all_emails_found"] = ", ".join(sorted(emails))
    lead["socials"] = socials
    lead["enrichment_status"] = "enriched" if emails else "no_email_found"
    return lead


def safe_enrich(lead):
    try:
        return enrich_lead(lead)
    except Exception as e:
        return empty(lead, f"error: {type(e).__name__}")


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
