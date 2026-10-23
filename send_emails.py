import json
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
# NO automatic retries exist anywhere in this file: every recipient gets at most one send attempt.
MAX_FAILURES_PER_RUN = 5  # Stop if >5 consecutive failures
MAX_BOUNCE_RATE_PERCENT = 5  # Alarm if >5% of sends are hard bounces
MAX_EMAILS_PER_DOMAIN = 10  # Don't send >10 emails to same domain per run
SEND_TIMEOUT = (10, 60)  # (connect, read) seconds; a timeout is recorded as UNKNOWN, never resent

# Per-lead state kept in the existing outreach_status column (only "new" is ever eligible to send).
STATUS_NEW = "new"
STATUS_PENDING = "sending"        # PENDING: written BEFORE the network call
STATUS_SENT = "contacted"         # SENT: provider returned 202
STATUS_FAILED = "send_failed"     # FAILED: rejected / error / not accepted
STATUS_UNKNOWN = "send_unknown"   # UNKNOWN: outcome ambiguous; manual investigation only

# Outreach_Log statuses that count as a real send attempt (for the daily cap and dedupe).
ATTEMPT_LOG_STATUSES = {"sent", "hard_bounce", "soft_bounce", "failed", "unknown"}
# Log statuses that permanently block an address from automatic sending, in every campaign.
# To authorize a new attempt manually, change the log row's status to "retry_approved"
# and set the lead's outreach_status back to "new".
BLOCKING_LOG_STATUSES = ATTEMPT_LOG_STATUSES | {"invalid_email"}
SUPPRESSED_LEAD_STATUSES = {"unsubscribed", "opted_out", "do_not_contact", "suppressed", "invalid_email"}

CAMPAIGN_ID = os.environ.get("CAMPAIGN_ID") or TEMPLATE_VERSION
EMAIL_SENDING_ENABLED = os.environ.get("EMAIL_SENDING_ENABLED", "true").lower() == "true"

# Outcome categories (sanitized; never contain response bodies or credentials)
OK = "confirmed_submission"
PERMANENT = "permanent_rejection"
TEMPORARY = "temporary_provider_error"
AUTH_RESTRICTION = "auth_or_account_restriction"
CONNECTION = "connection_failure"
UNCERTAIN = "uncertain_delivery"
# Outcomes that mean the provider/account is the problem: stop the whole campaign.
STOP_CAMPAIGN = {TEMPORARY, AUTH_RESTRICTION, CONNECTION, UNCERTAIN}

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

RESTRICTION_MARKERS = (
    "quota", "throttl", "suspend", "restrict", "blocked", "spam", "5.7.", "senddenied",
    "sendas", "accessdenied", "mailboxnotenabled", "authentication", "unauthorized",
)

def classify_response(status_code, body_text=""):
    """Map a Graph sendMail response to (outcome_category, log_status, lead_status)."""
    if status_code == 202:
        return OK, "sent", STATUS_SENT
    text = (body_text or "").lower()
    if status_code in (401, 403) or (status_code >= 400 and any(m in text for m in RESTRICTION_MARKERS)):
        return AUTH_RESTRICTION, "failed", STATUS_FAILED
    if status_code in (429, 503):
        return TEMPORARY, "failed", STATUS_FAILED
    if status_code >= 500:
        # 500/502/504 etc: the server may or may not have accepted it. Never resend.
        return UNCERTAIN, "unknown", STATUS_UNKNOWN
    if 400 <= status_code < 500:
        return PERMANENT, "hard_bounce", STATUS_FAILED
    return UNCERTAIN, "unknown", STATUS_UNKNOWN

def send_email(token, to_email, subject, html_body, logo_b64=None):
    """Make exactly ONE send attempt. Never retries.

    Returns (outcome_category, log_status, lead_status, http_status).
    http_status is None for network-level failures. Response bodies are not returned.
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
    try:
        resp = requests.post(url, headers=headers, json=payload, timeout=SEND_TIMEOUT)
    except requests.exceptions.ConnectTimeout:
        # Connection was never established, so nothing was submitted. Still not retried.
        return CONNECTION, "failed", STATUS_FAILED, None
    except Exception:
        # Read timeout / dropped connection after sending: delivery status is unknowable.
        return UNCERTAIN, "unknown", STATUS_UNKNOWN, None
    category, log_status, lead_status = classify_response(resp.status_code, resp.text[:500])
    return category, log_status, lead_status, resp.status_code

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
    """Attempts made today, earlier send days since the ramp began, and bounce stats."""
    rows = log_ws.get_all_values()
    attempts_today = 0
    prior_days = set()
    bounce_stats = {"hard": 0, "soft": 0, "sent": 0}

    for row in rows[1:]:
        date_sent = row[4] if len(row) > 4 else ""
        status = row[7] if len(row) > 7 else ""

        if status in ATTEMPT_LOG_STATUSES:
            # Failed/unknown attempts count toward the cap too: they may have used provider quota.
            if date_sent == today:
                attempts_today += 1
            elif RAMP_START_DATE <= date_sent < today and status == "sent":
                prior_days.add(date_sent)
        if status == "sent":
            bounce_stats["sent"] += 1
        elif status in ["hard_bounce", "invalid_email"]:
            bounce_stats["hard"] += 1
        elif status == "soft_bounce":
            bounce_stats["soft"] += 1

    return attempts_today, len(prior_days), bounce_stats

def todays_caps(prior_days):
    """Ramp-up cap, lowered (never raised) by the DAILY_SEND_CAP / PER_RUN_CAP settings."""
    daily_cap = min(RAMP_MAX_CAP, RAMP_START_CAP + RAMP_STEP * prior_days)
    configured = os.environ.get("DAILY_SEND_CAP", "").strip()
    if configured:
        daily_cap = min(daily_cap, max(0, int(configured)))
    per_run_cap = math.ceil(daily_cap / RUNS_PER_DAY)
    per_run_cfg = os.environ.get("PER_RUN_CAP", "").strip()
    if per_run_cfg:
        per_run_cap = min(per_run_cap, max(0, int(per_run_cfg)))
    return daily_cap, per_run_cap

def normalize_email(email):
    e = (email or "").strip().lower()
    if e.startswith("mailto:"):
        e = e[7:]
    return e.strip(" <>\t\r\n")

def load_suppression(sheet):
    """Optional 'Suppression' worksheet: first column holds emails, or bare domains / @domain."""
    emails, domains = set(), set()
    path = os.environ.get("SUPPRESSION_FILE")  # addresses marked replied / do-not-contact in the control panel
    if path:
        try:
            with open(path) as f:
                emails |= {normalize_email(e) for e in json.load(f).get("emails", [])}
        except (OSError, ValueError):
            pass
    try:
        ws = sheet.worksheet("Suppression")
    except Exception:
        return emails, domains
    for row in ws.get_all_values()[1:]:
        v = normalize_email(row[0]) if row else ""
        if not v:
            continue
        if "@" in v and not v.startswith("@"):
            emails.add(v)
        else:
            domains.add(v.lstrip("@"))
    return emails, domains

def load_log_blocklists(log_ws, campaign_id):
    """(attempted_in_this_campaign, blocked_in_any_campaign) email sets from Outreach_Log."""
    attempted, blocked = set(), set()
    for row in log_ws.get_all_values()[1:]:
        recipient = normalize_email(row[3]) if len(row) > 3 else ""
        status = row[7] if len(row) > 7 else ""
        template = row[6] if len(row) > 6 else ""
        if not recipient:
            continue
        if status in BLOCKING_LOG_STATUSES:
            blocked.add(recipient)
        if status in ATTEMPT_LOG_STATUSES and template == campaign_id:
            attempted.add(recipient)
    return attempted, blocked

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

def send_bounce_rate_alert(bounce_rate):
    """Send Discord alert when bounce rate exceeds threshold."""
    webhook_url = os.environ.get("DISCORD_WEBHOOK_URL")
    if not webhook_url:
        return

    message = {
        "content": f"⚠️ CRITICAL: Bounce rate at {bounce_rate:.1f}% (threshold: 5%)",
        "embeds": [{
            "title": "Bounce Rate Alert",
            "description": "Email sending has been STOPPED due to high bounce rate.",
            "fields": [
                {"name": "Current Rate", "value": f"{bounce_rate:.1f}%", "inline": True},
                {"name": "Threshold", "value": "5%", "inline": True},
                {"name": "Action", "value": "STOPPED - Review bounces in Outreach_Log", "inline": False},
            ],
            "color": 16711680  # Red
        }]
    }

    try:
        requests.post(webhook_url, json=message)
    except Exception as e:
        print(f"Failed to send bounce rate alert: {e}")

def send_discord_notification(sent_count, leads_sent, referrals_sent, skipped_invalid, log_rows):
    """Send summary to Discord with email details."""
    webhook_url = os.environ.get("DISCORD_WEBHOOK_URL")
    if not webhook_url:
        return

    # Build email list from log_rows
    emails_sent = []
    for row in log_rows:
        if len(row) > 7 and row[7] == "sent":  # status is at index 7
            emails_sent.append(row[3])  # email is at index 3

    # Create Discord message
    email_list = "\n".join(emails_sent[:10]) if emails_sent else "None"
    if len(emails_sent) > 10:
        email_list += f"\n... and {len(emails_sent) - 10} more"

    message = {
        "content": f"✅ Outreach run complete: {sent_count} sent ({leads_sent} leads, {referrals_sent} referrals)",
        "embeds": [{
            "title": "Email Summary",
            "fields": [
                {"name": "Total Sent", "value": str(sent_count), "inline": True},
                {"name": "Leads", "value": str(leads_sent), "inline": True},
                {"name": "Referrals", "value": str(referrals_sent), "inline": True},
                {"name": "Skipped Invalid", "value": str(skipped_invalid), "inline": True},
                {"name": "Emails Sent", "value": f"```\n{email_list}\n```", "inline": False},
            ],
            "color": 3066993
        }]
    }

    try:
        requests.post(webhook_url, json=message)
    except Exception as e:
        print(f"Failed to send Discord notification: {e}")

def build_message(source, business_name, logo_html, test_mode):
    if source == "leads":
        subject = LEADS_SUBJECT_TEMPLATE.format(business_name=business_name)
        body_base = LEADS_BODY_TEMPLATE
    else:
        subject = REFERRALS_SUBJECT_TEMPLATE
        body_base = REFERRALS_BODY_TEMPLATE
    body = (body_base.format(business_name=business_name) +
            SIGNATURE_HTML +
            "<br><span style=\"font-size:11px;color:#888888;\">"
            "Aurum Ventura Enterprise LLC, Nashville, TN<br>"
            "Don't want to hear from us again? Just reply \"UNSUBSCRIBE\" and we'll take you off the list."
            "</span>"
            "</div>")
    if test_mode:
        subject = "[TEST] " + subject
    return subject, body

def run_campaign(leads_ws, referrals_ws, log_ws, token, logo_html, logo_b64, today,
                 run_cap, suppressed_emails, suppressed_domains, attempted, blocked,
                 test_mode=False, test_email="", campaign_id=CAMPAIGN_ID):
    """Send at most one attempt per eligible recipient. Returns a stats dict.

    Order for every send: eligibility checks -> write PENDING to the sheet -> ONE network
    attempt -> record the final outcome. A crash anywhere after PENDING leaves the lead
    out of the queue ('sending' is never eligible), so a restart cannot resend it.
    """
    stats = defaultdict(int)
    stats["stopped_reason"] = ""
    leads_rows = leads_ws.get_all_values()
    referrals_rows = referrals_ws.get_all_values()
    leads_col = {name: i for i, name in enumerate(leads_rows[0])}
    referrals_col = {name: i for i, name in enumerate(referrals_rows[0])}

    combined_rows = []
    for row_num, row in enumerate(leads_rows[1:], start=2):
        combined_rows.append(("leads", row_num, row, leads_col, leads_ws))
    for row_num, row in enumerate(referrals_rows[1:], start=2):
        combined_rows.append(("referrals", row_num, row, referrals_col, referrals_ws))

    log_rows = []
    invalid_rows = {"leads": [], "referrals": []}  # invalid_email markers (never sends)
    consecutive_failures = 0
    domain_send_count = defaultdict(int)
    seen = set(attempted)

    try:
        for source, row_num, row, col, worksheet in combined_rows:
            if stats["attempted"] >= run_cap:
                stats["stopped_reason"] = "cap_reached"
                break
            if source == "leads" and stats["leads_attempted"] >= LEADS_MAX_PER_RUN:
                continue
            if source == "referrals" and stats["referrals_attempted"] >= REFERRALS_MAX_PER_RUN:
                continue
            if consecutive_failures >= MAX_FAILURES_PER_RUN:
                stats["stopped_reason"] = "consecutive_failures"
                print(f"STOP: {MAX_FAILURES_PER_RUN} consecutive failures. Review errors.")
                break

            def get(field):
                idx = col.get(field)
                return row[idx] if idx is not None and idx < len(row) else ""

            if get("outreach_status") != STATUS_NEW or not get("email"):
                continue
            email = normalize_email(get("email"))
            business_name = get("business_name")
            lead_id = get("lead_id")
            city = get("city").strip()
            state = get("state").strip()
            domain = email.split("@")[-1]

            if email in seen:
                stats["skipped_duplicate"] += 1
                continue
            if email in suppressed_emails or domain in suppressed_domains or email in blocked:
                stats["skipped_suppressed"] += 1
                continue

            ok, reason = check_email(email)
            if ok is None:
                continue  # DNS check unavailable; leave as "new", it is not a send
            if not ok:
                invalid_rows[source].append(row_num)
                stats["skipped_invalid"] += 1
                continue

            if domain_send_count[domain] >= MAX_EMAILS_PER_DOMAIN:
                continue

            subject, body = build_message(source, business_name, logo_html, test_mode)
            recipient = test_email if test_mode else email

            # 1. Record the attempt BEFORE the network call. If this fails, do not send.
            if not test_mode:
                try:
                    worksheet.update_cell(row_num, col["outreach_status"] + 1, STATUS_PENDING)
                except Exception as e:
                    stats["stopped_reason"] = "state_store_unavailable"
                    print(f"STOP: could not record PENDING state ({type(e).__name__}); nothing sent for this lead.")
                    break
            seen.add(email)
            domain_send_count[domain] += 1
            stats["attempted"] += 1
            stats[f"{source}_attempted"] += 1

            # 2. Exactly one send attempt. No retry of any kind.
            category, log_status, lead_status, http_status = send_email(token, recipient, subject, body, logo_b64)
            stats[category] += 1
            print(f"[{source} row {row_num}] outcome={category} http={http_status}")

            if category == OK:
                consecutive_failures = 0
                stats["sent"] += 1
                stats[f"{source}_sent"] += 1
            else:
                consecutive_failures += 1
                stats["unknown" if lead_status == STATUS_UNKNOWN else "failed"] += 1

            # 3. Record the final outcome (if this write fails the lead stays 'sending': never resent).
            if not test_mode:
                try:
                    worksheet.update_cell(row_num, col["outreach_status"] + 1, lead_status)
                    if category == OK:
                        worksheet.update_cell(row_num, col["date_contacted"] + 1, today)
                except Exception as e:
                    print(f"WARNING: could not store final status ({type(e).__name__}); lead remains '{STATUS_PENDING}' and will not be resent.")
            log_row = [
                str(uuid.uuid4())[:8], lead_id, business_name, recipient, today, subject,
                campaign_id, "sent_test" if (test_mode and category == OK) else log_status,
                "", "", "",
                f"{category}|http={http_status}" if category != OK else "",
                city, state, f"{city}, {state}", source,
            ]
            log_rows.append(log_row)
            try:
                log_ws.append_rows([log_row], value_input_option="USER_ENTERED")
            except Exception as e:
                print(f"WARNING: could not append log row ({type(e).__name__}); lead status already recorded.")

            if category in STOP_CAMPAIGN:
                stats["stopped_reason"] = category
                print(f"STOP: provider-level outcome '{category}'. Campaign halted; no further sends this run.")
                break

            time.sleep(3)
    finally:
        if not test_mode:
            try:
                apply_invalid_markers(leads_ws, referrals_ws, invalid_rows)
            except Exception as e:
                print(f"WARNING: could not mark invalid addresses ({type(e).__name__}).")
    stats["log_rows"] = log_rows
    return stats

def apply_invalid_markers(leads_ws, referrals_ws, rows_by_source):
    """Persist 'invalid_email' for addresses that failed the format/DNS checks (never sent)."""
    for ws, rows in ((leads_ws, rows_by_source.get("leads", [])), (referrals_ws, rows_by_source.get("referrals", []))):
        if not rows:
            continue
        header = ws.row_values(1)
        status_col = header.index("outreach_status") + 1
        ws.batch_update([{"range": rowcol_to_a1(r, status_col), "values": [["invalid_email"]]} for r in rows])

def write_step_summary(lines):
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    try:
        with open(path, "a") as f:
            f.write("\n".join(lines) + "\n")
    except OSError:
        pass

def main():
    if not EMAIL_SENDING_ENABLED:
        print("Email sending is disabled (EMAIL_SENDING_ENABLED=false). Nothing sent; lead discovery is unaffected.")
        write_step_summary(["### Outreach", "Email sending disabled by `EMAIL_SENDING_ENABLED`."])
        return
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

    print(f"Running in {'TEST' if TEST_MODE else 'LIVE'} mode. Campaign: {CAMPAIGN_ID}")

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

    # Authentication check = obtaining a token. No test email is sent.
    try:
        token = get_graph_token()
    except Exception as e:
        raise SystemExit(f"Cannot proceed: could not obtain Microsoft Graph token ({type(e).__name__}).")

    suppressed_emails, suppressed_domains = load_suppression(sheet)
    attempted, blocked = load_log_blocklists(log_ws, CAMPAIGN_ID)

    if TEST_MODE:
        run_cap = 1
    else:
        attempts_today, prior_days, bounce_stats = sending_stats(log_ws, today)
        bounce_ok, bounce_msg = check_bounce_rate(bounce_stats)
        print(f"📊 {bounce_msg}")
        if not bounce_ok:
            sent = bounce_stats.get("sent", 0)
            rate = (bounce_stats.get("hard", 0) / sent) * 100 if sent > 0 else 0
            send_bounce_rate_alert(rate)
            raise SystemExit(f"STOPPING: {bounce_msg}. Review bounces in Outreach_Log before resuming.")
        daily_cap, per_run_cap = todays_caps(prior_days)
        remaining_daily = max(0, daily_cap - attempts_today)
        run_cap = min(per_run_cap, remaining_daily)
        print(f"Ramp day {prior_days + 1}: today's cap is {daily_cap}.")
        print(f"Already attempted {attempts_today}/{daily_cap} today. This run will send up to {run_cap} more.")
        if run_cap == 0:
            print("Daily cap reached — nothing to send this run.")

    stats = run_campaign(leads_ws, referrals_ws, log_ws, token, logo_html, logo_b64, today,
                         run_cap, suppressed_emails, suppressed_domains, attempted, blocked,
                         test_mode=TEST_MODE, test_email=TEST_EMAIL)

    sent = stats["sent"]
    summary = (f"Sent {sent} email(s) this run ({stats['leads_sent']} leads + {stats['referrals_sent']} referrals). "
               f"Logged {len(stats['log_rows'])} attempt(s). Skipped {stats['skipped_invalid']} invalid address(es).")
    print(summary)
    write_step_summary([
        "### Outreach run", f"- Campaign: `{CAMPAIGN_ID}` ({'TEST' if TEST_MODE else 'LIVE'})",
        f"- Confirmed submitted: {sent}", f"- Failed (not retried): {stats['failed']}",
        f"- Uncertain / UNKNOWN (not retried, review manually): {stats['unknown']}",
        f"- Skipped duplicates: {stats['skipped_duplicate']}",
        f"- Skipped suppressed/previously failed: {stats['skipped_suppressed']}",
        f"- Skipped invalid: {stats['skipped_invalid']}",
        f"- Stopped early: {stats['stopped_reason'] or 'no'}",
    ])
    send_discord_notification(sent, stats["leads_sent"], stats["referrals_sent"], stats["skipped_invalid"], stats["log_rows"])

    if stats["stopped_reason"] in STOP_CAMPAIGN:
        # Fail the job loudly so you notice. Nothing is retried automatically (see workflows).
        raise SystemExit(f"Campaign halted: {stats['stopped_reason']}. Investigate before resuming.")

if __name__ == "__main__":
    main()
