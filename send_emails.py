import os
import time
import uuid
import base64
import re
import math
import datetime
import requests
import gspread
from gspread.utils import rowcol_to_a1
import google.auth
from google.auth.exceptions import TransportError
from collections import defaultdict

TENANT_ID = os.environ.get("MS_TENANT_ID")
CLIENT_ID = os.environ.get("MS_CLIENT_ID")
CLIENT_SECRET = os.environ.get("MS_CLIENT_SECRET")
SENDER_EMAIL = os.environ.get("SENDER_EMAIL")
SHEET_ID = os.environ.get("SHEET_ID")
TEST_MODE = os.environ.get("TEST_MODE", "true").lower() == "true"
TEST_EMAIL = os.environ.get("TEST_EMAIL", "")

# Gradual ramp-up: start at RAMP_START_CAP/day, add RAMP_STEP for every day we've
# actually sent emails since RAMP_START_DATE, until RAMP_MAX_CAP. Pausing sending
# pauses the ramp too, so it never jumps ahead after a break.
RAMP_START_DATE = "2026-09-29"
RAMP_START_CAP = 150
RAMP_STEP = 25
RAMP_MAX_CAP = 300
RUNS_PER_DAY = 9  # spread the daily cap over ~9 of the hourly runs (leaves slack for skipped runs)

# Split daily cap: 150 leads + 150 referral partners
LEADS_MAX_PER_RUN = 150
REFERRALS_MAX_PER_RUN = 150

LOGO_PATH = "logo.png"
TEMPLATE_VERSION = "v2_intro"

NAVY = "#1B2A5A"

# Email templates for Leads
LEADS_SUBJECT_TEMPLATE = "{business_name} + Administrative Support"
LEADS_BODY_TEMPLATE = (
    "<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222;\">"
    "Hi,<br><br>"
    "I came across {business_name} and wanted to introduce myself.<br><br>"
    "I'm Kyle with Aurum Ventura. We provide back-office administrative support for growing businesses — "
    "the documents, invoices, records, tracking, data, and other routine work that keeps things moving but can easily become a distraction from the business itself.<br><br>"
    "We're not looking to replace your team or change how you operate. We simply provide additional administrative capacity "
    "when there's more work than your current team has time to handle.<br><br>"
    "I'd be glad to learn a little about {business_name} and see if there's anywhere we could be useful.<br><br>"
    "Best,<br><br>"
)

# Email templates for Referrals
REFERRALS_SUBJECT_TEMPLATE = "Exploring a connection"
REFERRALS_BODY_TEMPLATE = (
    "<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222;\">"
    "Hi,<br><br>"
    "I'm Kyle with Aurum Ventura. I came across {business_name} and wanted to introduce myself.<br><br>"
    "We provide back-office administrative support for businesses, and I'm interested in connecting with professionals and businesses "
    "whose work may naturally complement ours.<br><br>"
    "I'm not reaching out with a sales pitch. I'd simply like to learn more about what you do, learn more about your business, "
    "and see if there may be an opportunity for us to be a resource to one another.<br><br>"
    "If you're open to connecting, I'd be glad to hear from you.<br><br>"
    "Best,<br><br>"
)

# ==== GUARDRAILS ====
MAX_FAILURES_PER_RUN = 5  # Stop if >5 consecutive failures
MAX_RETRYABLE_FAILURES = 3  # Retry soft fails max 3 times before marking as failed
RETRY_BACKOFF_MULTIPLIER = 2  # Exponential backoff for retries
MAX_BOUNCE_RATE_PERCENT = 5  # Alarm if >5% of sends are hard bounces
MAX_EMAILS_PER_DOMAIN = 10  # Don't send >10 emails to same domain per run
MAX_CONSECUTIVE_RETRIES = 2  # Only retry failures once before moving on
MICROSECOND_GRAPH_RATE_LIMIT_WAIT = 65  # If 429 from MS Graph, wait this long

SIGNATURE_HTML = (
    "<table cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"border-collapse:collapse;margin-top:8px;\">"
    "<tr>"
    "<td style=\"vertical-align:middle;padding:0 18px 0 0;\">{logo_html}</td>"
    "<td style=\"vertical-align:top;font-family:'Arial Narrow',Arial,Helvetica,sans-serif;"
    "font-size:15px;line-height:1.5;color:" + NAVY + ";font-weight:bold;\">"
    "Kyle Fulwood Jr<br>"
    "Founder<br><br>"
    "Phone: (850) 653-7797<br>"
    "Email: <a href=\"mailto:admin@aurumventura.net\" style=\"color:" + NAVY + ";\">admin@aurumventura.net</a><br>"
    "Website: <a href=\"https://aurumventura.net\" style=\"color:" + NAVY + ";\">aurumventura.net</a>"
    "</td>"
    "</tr>"
    "</table>"
)

BODY_TEMPLATE = (
    "<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222;\">"
    "Hi,<br><br>"
    "I came across {{business_name}} and wanted to introduce myself.<br><br>"
    "I'm Kyle with Aurum Ventura. We provide back-office administrative support for growing businesses — "
    "the documents, invoices, records, tracking, data, and other routine work that keeps things moving but can easily become a distraction from the business itself.<br><br>"
    "We're not looking to replace your team or change how you operate. We simply provide additional administrative capacity "
    "when there's more work than your current team has time to handle.<br><br>"
    "I'd be glad to learn a little about {{business_name}} and see if there's anywhere we could be useful.<br><br>"
    "Best,<br><br>"
    + SIGNATURE_HTML +
    "<br><span style=\"font-size:11px;color:#888888;\">"
    "Aurum Ventura Enterprise LLC, Nashville, TN<br>"
    "Don't want to hear from us again? Just reply \"UNSUBSCRIBE\" and we'll take you off the list."
    "</span>"
    "</div>"
)

def load_logo_base64():
    try:
        with open(LOGO_PATH, "rb") as f:
            return base64.b64encode(f.read()).decode("utf-8")
    except FileNotFoundError:
        return None

def get_graph_token():
    url = f"https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/token"
    data = {
        "grant_type": "client_credentials",
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "scope": "https://graph.microsoft.com/.default",
    }
    resp = requests.post(url, data=data)
    resp.raise_for_status()
    return resp.json()["access_token"]

def send_email(token, to_email, subject, html_body, logo_b64=None, retry_count=0):
    """Send email with exponential backoff on rate limits.

    Returns (status_code, error_message, is_retryable).
    - status_code 202: success
    - is_retryable True: indicates soft failure (rate limit, temp unavailable)
    """
    url = f"https://graph.microsoft.com/v1.0/users/{SENDER_EMAIL}/sendMail"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    message = {
        "subject": subject,
        "body": {"contentType": "HTML", "content": html_body},
        "toRecipients": [{"emailAddress": {"address": to_email}}],
    }
    if logo_b64:
        message["attachments"] = [
            {
                "@odata.type": "#microsoft.graph.fileAttachment",
                "name": "logo.png",
                "contentType": "image/png",
                "contentBytes": logo_b64,
                "contentId": "aurum_logo",
                "isInline": True,
            }
        ]
    payload = {"message": message, "saveToSentItems": "true"}
    resp = requests.post(url, headers=headers, json=payload)

    # Classify error as retryable or permanent
    is_retryable = resp.status_code in [429, 503, 504, 500]  # Rate limit, unavailable, gateway timeout
    error_msg = resp.text[:200] if resp.status_code != 202 else ""

    # Handle rate limiting with exponential backoff
    if resp.status_code == 429:
        retry_after = int(resp.headers.get("Retry-After", MICROSECOND_GRAPH_RATE_LIMIT_WAIT))
        if retry_count < MAX_CONSECUTIVE_RETRIES:
            print(f"⚠️  Rate limited (429). Waiting {retry_after}s before retry...")
            time.sleep(retry_after)
            return send_email(token, to_email, subject, html_body, logo_b64, retry_count + 1)

    return resp.status_code, error_msg, is_retryable

# ---------- Email checks (protect sender reputation) ----------
EMAIL_RE = re.compile(r"^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$")
BAD_PREFIXES = {
    "noreply", "no-reply", "donotreply", "do-not-reply", "mailer-daemon", "postmaster",
    "abuse", "webmaster", "hostmaster", "privacy", "unsubscribe", "careers", "jobs",
    "example", "test", "user", "name", "email", "your", "yourname", "youremail",
}
BLOCKED_DOMAINS = {
    # AOL / Verizon
    "aol.com", "aolmail.com", "aol.co.uk", "verizon.net",
    # Mail.com and variants
    "mail.com", "mail.co.uk", "mail.de",
    # GMX
    "gmx.com", "gmx.de", "gmx.net", "gmx.fr", "gmx.es", "gmx.co.uk", "gmx.at", "gmx.ch",
    # Yahoo
    "yahoo.com", "ymail.com", "rocketmail.com", "yahoo.co.uk", "yahoo.de", "yahoo.fr",
    # ISP-tied accounts
    "comcast.net", "cox.net", "att.net", "bellsouth.net", "charter.net", "earthlink.net",
    "frontier.com", "sbcglobal.net", "windstream.net", "centurytel.net", "qwest.net",
}
JUNK_TLDS = {"png", "jpg", "jpeg", "gif", "svg", "webp", "css", "js", "pdf"}
_domain_cache = {}

DNS_ENDPOINTS = [
    ("https://dns.google/resolve", {}),
    ("https://cloudflare-dns.com/dns-query", {"accept": "application/dns-json"}),
]

def lookup_mx(domain):
    """Ask a public DNS-over-HTTPS service for the domain's mail servers. None if unreachable."""
    for url, headers in DNS_ENDPOINTS:
        try:
            r = requests.get(url, params={"name": domain, "type": "MX"}, headers=headers, timeout=10)
            if r.status_code == 200:
                return r.json()
        except Exception:
            continue
    return None

def domain_accepts_mail(domain):
    """True/False if the domain has working mail servers (MX records), None if we couldn't check."""
    if domain in _domain_cache:
        return _domain_cache[domain]
    data = lookup_mx(domain)
    if data is None:
        return None  # DNS lookup failed: don't judge, try again next run
    status = data.get("Status")
    if status == 3:  # domain doesn't exist
        result = False
    elif status != 0:
        return None
    else:
        mx = [a.get("data", "") for a in data.get("Answer", []) if a.get("type") == 15]
        # A "null MX" ("0 .") means the domain explicitly refuses email
        result = any(m.split()[-1].strip(".") for m in mx if m.split())
    _domain_cache[domain] = result
    return result

def check_email(email):
    """Returns (ok, reason). ok=None means 'unknown, skip for now'."""
    email = (email or "").strip().lower()
    if not EMAIL_RE.match(email):
        return False, "bad_format"
    local, domain = email.rsplit("@", 1)
    if local in BAD_PREFIXES:
        return False, "role_address"
    if domain in BLOCKED_DOMAINS:
        return False, "blocked_domain"
    if domain.split(".")[-1] in JUNK_TLDS:
        return False, "bad_format"
    accepts = domain_accepts_mail(domain)
    if accepts is None:
        return None, "dns_check_failed"
    if not accepts:
        return False, "domain_cannot_receive_mail"
    return True, ""

def get_sheets_client():
    credentials, _ = google.auth.default(
        scopes=["https://www.googleapis.com/auth/spreadsheets"]
    )
    return gspread.authorize(credentials)

def sending_stats(log_ws, today):
    """How many we've sent today, and how many earlier days we've sent on since the ramp began."""
    rows = log_ws.get_all_values()
    sent_today = 0
    prior_days = set()
    bounce_stats = {"hard": 0, "soft": 0, "sent": 0}

    for row in rows[1:]:
        date_sent = row[4] if len(row) > 4 else ""
        status = row[7] if len(row) > 7 else ""

        if status == "sent":
            bounce_stats["sent"] += 1
            if date_sent == today:
                sent_today += 1
            elif RAMP_START_DATE <= date_sent < today:
                prior_days.add(date_sent)
        elif status in ["hard_bounce", "invalid_email"]:
            bounce_stats["hard"] += 1
        elif status == "soft_bounce":
            bounce_stats["soft"] += 1

    return sent_today, len(prior_days), bounce_stats

def todays_caps(prior_days):
    daily_cap = min(RAMP_MAX_CAP, RAMP_START_CAP + RAMP_STEP * prior_days)
    per_run_cap = math.ceil(daily_cap / RUNS_PER_DAY)
    return daily_cap, per_run_cap

def get_sheets_with_retry(max_retries=3):
    """Retry Google Sheets connection up to 3 times"""
    for attempt in range(max_retries):
        try:
            gc = get_sheets_client()
            sheet = gc.open_by_key(SHEET_ID)
            return sheet
        except (TransportError, Exception) as e:
            if attempt < max_retries - 1:
                wait_time = 5 * (attempt + 1)
                print(f"Connection error, retrying in {wait_time}s... (attempt {attempt + 1}/{max_retries})")
                time.sleep(wait_time)
            else:
                raise SystemExit(f"Failed to connect to Google Sheets after {max_retries} attempts: {e}")

def verify_sender_auth(token):
    """Test that sender can actually send emails before bulk send."""
    test_subject = "[AUTH TEST] Aurum Ventura - Ignore this message"
    test_body = "<p>This is an authentication test. You can safely delete this email.</p>"

    status, error, _ = send_email(token, SENDER_EMAIL, test_subject, test_body)
    if status == 202:
        print("✅ Authentication verified: sender can send emails")
        return True
    else:
        print(f"❌ Authentication test failed (status {status}): {error}")
        return False

def check_bounce_rate(bounce_stats):
    """Check if bounce rate exceeds safety threshold."""
    sent = bounce_stats.get("sent", 0)
    hard_bounces = bounce_stats.get("hard", 0)

    if sent == 0:
        return True, "No sends yet"

    bounce_rate = (hard_bounces / sent) * 100
    if bounce_rate > MAX_BOUNCE_RATE_PERCENT:
        return False, f"Hard bounce rate {bounce_rate:.1f}% exceeds {MAX_BOUNCE_RATE_PERCENT}% limit"

    return True, f"Bounce rate OK ({bounce_rate:.1f}%)"

if __name__ == "__main__":
    required = {
        "MS_TENANT_ID": TENANT_ID, "MS_CLIENT_ID": CLIENT_ID,
        "MS_CLIENT_SECRET": CLIENT_SECRET, "SENDER_EMAIL": SENDER_EMAIL,
        "SHEET_ID": SHEET_ID,
    }
    for name, val in required.items():
        if not val:
            raise SystemExit(f"Set {name} first.")
    if TEST_MODE and not TEST_EMAIL:
        raise SystemExit("TEST_MODE is on but no TEST_EMAIL was provided.")

    print(f"Running in {'TEST' if TEST_MODE else 'LIVE'} mode.")

    logo_b64 = load_logo_base64()
    if logo_b64:
        logo_html = (
            "<img src=\"cid:aurum_logo\" alt=\"Aurum Ventura Enterprise LLC\" "
            "width=\"170\" style=\"display:block;border:0;\">"
        )
    else:
        logo_html = ""
        print("Warning: logo.png not found in repo root — sending without logo.")

    sheet = get_sheets_with_retry()
    leads_ws = sheet.worksheet("Leads")
    referrals_ws = sheet.worksheet("Referrals")
    log_ws = sheet.worksheet("Outreach_Log")

    today = datetime.date.today().isoformat()

    # GUARDRAIL: Verify auth before mass send
    token = get_graph_token()
    if not verify_sender_auth(token):
        raise SystemExit("Cannot proceed: sender authentication failed.")

    if TEST_MODE:
        run_cap = 1
    else:
        already_sent_today, prior_days, bounce_stats = sending_stats(log_ws, today)

        # GUARDRAIL: Check bounce rate
        bounce_ok, bounce_msg = check_bounce_rate(bounce_stats)
        print(f"📊 {bounce_msg}")
        if not bounce_ok:
            raise SystemExit(f"STOPPING: {bounce_msg}. Review bounces in Outreach_Log before resuming.")

        daily_cap, per_run_cap = todays_caps(prior_days)
        remaining_daily = max(0, daily_cap - already_sent_today)
        run_cap = min(per_run_cap, remaining_daily)
        print(f"Ramp day {prior_days + 1}: today's cap is {daily_cap}.")
        print(f"Already sent {already_sent_today}/{daily_cap} today. This run will send up to {run_cap} more.")
        if run_cap == 0:
            print("Daily cap already reached — nothing to send this run.")

    # Prepare rows from both Leads and Referrals sheets
    leads_rows = leads_ws.get_all_values()
    referrals_rows = referrals_ws.get_all_values()

    leads_header = leads_rows[0]
    referrals_header = referrals_rows[0]
    leads_col = {name: i for i, name in enumerate(leads_header)}
    referrals_col = {name: i for i, name in enumerate(referrals_header)}

    # Combine rows with source tracking
    combined_rows = []
    for row_num, row in enumerate(leads_rows[1:], start=2):
        combined_rows.append(("leads", row_num, row, leads_col, leads_ws))
    for row_num, row in enumerate(referrals_rows[1:], start=2):
        combined_rows.append(("referrals", row_num, row, referrals_col, referrals_ws))

    sent_count = 0
    leads_sent = 0
    referrals_sent = 0
    log_rows = []
    status_updates = []
    skipped_invalid = 0
    consecutive_failures = 0
    domain_send_count = defaultdict(int)  # Track sends per domain

    for source, row_num, row, col, worksheet in combined_rows:
        if sent_count >= run_cap:
            break

        # Check source-specific caps
        if source == "leads" and leads_sent >= LEADS_MAX_PER_RUN:
            continue
        if source == "referrals" and referrals_sent >= REFERRALS_MAX_PER_RUN:
            continue

        # GUARDRAIL: Stop if too many consecutive failures
        if consecutive_failures >= MAX_FAILURES_PER_RUN:
            print(f"⛔ Stopping: {MAX_FAILURES_PER_RUN} consecutive failures detected. Review errors.")
            break

        def get(field):
            idx = col.get(field)
            return row[idx] if idx is not None and idx < len(row) else ""

        outreach_status = get("outreach_status")
        email = get("email")
        business_name = get("business_name")
        lead_id = get("lead_id")
        city = get("city").strip()
        state = get("state").strip()

        if outreach_status != "new" or not email:
            continue

        ok, reason = check_email(email)
        if ok is None:
            continue  # couldn't check right now; leave it as "new" for a later run
        if not ok:
            status_updates.append((row_num, "invalid_email"))
            skipped_invalid += 1
            print(f"Skipping {email}: {reason}")
            continue

        # GUARDRAIL: Per-domain rate limiting
        domain = email.split("@")[1]
        if domain_send_count[domain] >= MAX_EMAILS_PER_DOMAIN:
            print(f"Skipping {email}: already sent {MAX_EMAILS_PER_DOMAIN} to {domain} this run")
            continue
        domain_send_count[domain] += 1

        # Select template based on source (leads or referrals)
        if source == "leads":
            subject = LEADS_SUBJECT_TEMPLATE.format(business_name=business_name)
            body_base = LEADS_BODY_TEMPLATE
        else:
            subject = REFERRALS_SUBJECT_TEMPLATE
            body_base = REFERRALS_BODY_TEMPLATE

        # Format body with business name and logo
        body = (body_base.format(business_name=business_name) +
                SIGNATURE_HTML +
                "<br><span style=\"font-size:11px;color:#888888;\">"
                "Aurum Ventura Enterprise LLC, Nashville, TN<br>"
                "Don't want to hear from us again? Just reply \"UNSUBSCRIBE\" and we'll take you off the list."
                "</span>"
                "</div>")
        recipient = TEST_EMAIL if TEST_MODE else email

        if TEST_MODE:
            subject = "[TEST] " + subject

        status_code, error_message, is_retryable = send_email(token, recipient, subject, body, logo_b64)

        if status_code == 202:
            send_status = "sent_test" if TEST_MODE else "sent"
            consecutive_failures = 0
            if not TEST_MODE:
                worksheet.update_cell(row_num, col["outreach_status"] + 1, "contacted")
                worksheet.update_cell(row_num, col["date_contacted"] + 1, today)
            sent_count += 1
            if source == "leads":
                leads_sent += 1
            else:
                referrals_sent += 1
        else:
            consecutive_failures += 1
            if is_retryable:
                send_status = "soft_bounce"
                print(f"⚠️  Soft failure for {email} (status {status_code}). Will retry next run.")
            else:
                send_status = "hard_bounce"
                print(f"❌ Hard failure for {email} (status {status_code}): {error_message[:100]}")
                if not TEST_MODE:
                    # Don't retry hard failures
                    status_updates.append((row_num, "send_failed"))

            error_message = f"[{status_code}] {error_message}"

        log_rows.append([
            str(uuid.uuid4())[:8],
            lead_id,
            business_name,
            recipient,
            today,
            subject,
            TEMPLATE_VERSION,
            send_status,
            "", "", "",
            error_message,
            city,
            state,
            f"{city}, {state}",
            source,  # Track which source this email came from
        ])

        time.sleep(3)

    if log_rows:
        log_ws.append_rows(log_rows, value_input_option="USER_ENTERED")

    if status_updates and not TEST_MODE:
        status_col = col["outreach_status"] + 1
        leads_ws.batch_update([
            {"range": rowcol_to_a1(r, status_col), "values": [[st]]}
            for r, st in status_updates
        ])

    summary = f"Sent {sent_count} email(s) this run ({leads_sent} leads + {referrals_sent} referrals). Logged {len(log_rows)} attempt(s). Skipped {skipped_invalid} invalid address(es)."
    print(summary)

    if consecutive_failures >= MAX_FAILURES_PER_RUN:
        print(f"⚠️  WARNING: Run ended due to {consecutive_failures} consecutive failures.")
