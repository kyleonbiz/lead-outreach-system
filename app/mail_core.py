"""Sending helpers for the app (agents, dashboard, follow-up sender).

A trimmed copy of the helpers from the one-attempt sender work, kept separate so the live outreach
(send_emails.py and its workflows) is untouched. It makes exactly ONE send attempt per call and never retries.
When this project moves to its final repo, merge this with send_emails.py. NOTE: the ramp constants below
duplicate send_emails.py; keep them in sync until then.
"""
import json
import math
import os
import re
import time

import google.auth
import gspread
import requests
from google.auth.exceptions import TransportError


TENANT_ID = os.environ.get("MS_TENANT_ID")

CLIENT_ID = os.environ.get("MS_CLIENT_ID")

CLIENT_SECRET = os.environ.get("MS_CLIENT_SECRET")

SENDER_EMAIL = os.environ.get("SENDER_EMAIL")

SHEET_ID = os.environ.get("SHEET_ID")

RAMP_START_DATE = "2026-09-29"

RAMP_START_CAP = 150

RAMP_STEP = 25

RAMP_MAX_CAP = 300

RUNS_PER_DAY = 9

MAX_BOUNCE_RATE_PERCENT = 5

SEND_TIMEOUT = (10, 60)

STATUS_NEW = "new"

STATUS_PENDING = "sending"

STATUS_SENT = "contacted"

STATUS_FAILED = "send_failed"

STATUS_UNKNOWN = "send_unknown"

ATTEMPT_LOG_STATUSES = {"sent", "hard_bounce", "soft_bounce", "failed", "unknown"}

BLOCKING_LOG_STATUSES = ATTEMPT_LOG_STATUSES | {"invalid_email"}

EMAIL_SENDING_ENABLED = os.environ.get("EMAIL_SENDING_ENABLED", "true").lower() == "true"

OK = "confirmed_submission"

PERMANENT = "permanent_rejection"

TEMPORARY = "temporary_provider_error"

AUTH_RESTRICTION = "auth_or_account_restriction"

CONNECTION = "connection_failure"

UNCERTAIN = "uncertain_delivery"

STOP_CAMPAIGN = {TEMPORARY, AUTH_RESTRICTION, CONNECTION, UNCERTAIN}

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

EMAIL_RE = re.compile(r"^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$")

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
