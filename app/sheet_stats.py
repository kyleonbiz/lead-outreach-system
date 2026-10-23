"""Read-only helpers for the dashboard: today's send counts, the daily cap ramp, bounce rate, and the Google Sheets connection.

Nothing in this app sends email. The RAMP_* constants duplicate send_emails.py; keep them in sync."""
import math
import os
import time

import google.auth
import gspread
from google.auth.exceptions import TransportError


SHEET_ID = os.environ.get("SHEET_ID")

RAMP_START_DATE = "2026-09-29"

RAMP_START_CAP = 150

RAMP_STEP = 25

RAMP_MAX_CAP = 300

RUNS_PER_DAY = 9

MAX_BOUNCE_RATE_PERCENT = 5

STATUS_NEW = "new"

STATUS_PENDING = "sending"

STATUS_SENT = "contacted"

STATUS_FAILED = "send_failed"

STATUS_UNKNOWN = "send_unknown"

ATTEMPT_LOG_STATUSES = {"sent", "hard_bounce", "soft_bounce", "failed", "unknown"}

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
