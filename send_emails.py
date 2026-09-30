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

LOGO_PATH = "logo.png"
TEMPLATE_VERSION = "v2_intro"

SUBJECT_TEMPLATE = "Quick intro"

NAVY = "#1B2A5A"

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
    "Hi there,<br><br>"
    "I'm Kyle with Aurum Ventura.<br><br>"
    "We provide human-led administrative support at a fraction of the cost of hiring in-house, "
    "handling the back-office work so you can stay focused on your customers.<br><br>"
    "No contracts. Just administrative support when you need it.<br><br>"
    "I'm simply reaching out to make you aware we exist.<br><br>"
    "<a href=\"https://aurumventura.net\">aurumventura.net</a><br><br>"
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

def send_email(token, to_email, subject, html_body, logo_b64=None):
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
    return requests.post(url, headers=headers, json=payload)

# ---------- Email checks (protect sender reputation) ----------
EMAIL_RE = re.compile(r"^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$")
BAD_PREFIXES = {
    "noreply", "no-reply", "donotreply", "do-not-reply", "mailer-daemon", "postmaster",
    "abuse", "webmaster", "hostmaster", "privacy", "unsubscribe", "careers", "jobs",
    "example", "test", "user", "name", "email", "your", "yourname", "youremail",
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
    for row in rows[1:]:
        date_sent = row[4] if len(row) > 4 else ""
        status = row[7] if len(row) > 7 else ""
        if status != "sent":
            continue
        if date_sent == today:
            sent_today += 1
        elif RAMP_START_DATE <= date_sent < today:
            prior_days.add(date_sent)
    return sent_today, len(prior_days)

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
    log_ws = sheet.worksheet("Outreach_Log")

    today = datetime.date.today().isoformat()

    if TEST_MODE:
        run_cap = 1
    else:
        already_sent_today, prior_days = sending_stats(log_ws, today)
        daily_cap, per_run_cap = todays_caps(prior_days)
        remaining_daily = max(0, daily_cap - already_sent_today)
        run_cap = min(per_run_cap, remaining_daily)
        print(f"Ramp day {prior_days + 1}: today's cap is {daily_cap}.")
        print(f"Already sent {already_sent_today}/{daily_cap} today. This run will send up to {run_cap} more.")
        if run_cap == 0:
            print("Daily cap already reached — nothing to send this run.")

    rows = leads_ws.get_all_values()
    header = rows[0]
    col = {name: i for i, name in enumerate(header)}

    token = get_graph_token()
    sent_count = 0
    log_rows = []
    status_updates = []  # (row_num, new_status) written in one batch at the end
    skipped_invalid = 0

    for row_num, row in enumerate(rows[1:], start=2):
        if sent_count >= run_cap:
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

        subject = SUBJECT_TEMPLATE
        body = BODY_TEMPLATE.format(logo_html=logo_html)
        recipient = TEST_EMAIL if TEST_MODE else email

        if TEST_MODE:
            subject = "[TEST] " + subject

        resp = send_email(token, recipient, subject, body, logo_b64)

        if resp.status_code == 202:
            send_status = "sent_test" if TEST_MODE else "sent"
            error_message = ""
            if not TEST_MODE:
                leads_ws.update_cell(row_num, col["outreach_status"] + 1, "contacted")
                leads_ws.update_cell(row_num, col["date_contacted"] + 1, today)
            sent_count += 1
        else:
            send_status = "failed"
            error_message = resp.text[:200]
            if not TEST_MODE:
                # Don't keep retrying the same address every run
                status_updates.append((row_num, "send_failed"))

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

    print(f"Sent {sent_count} email(s) this run. Logged {len(log_rows)} attempt(s). "
          f"Skipped {skipped_invalid} invalid address(es).")
