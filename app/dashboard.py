"""Aggregate counts for the dashboard. Pure functions over sheet rows; output has no emails or business names."""
import datetime
import os
import time
from collections import Counter

import send_emails as se

DAYS = 30
_cache = {"at": 0, "data": None}


def _col(header):
    return {n: i for i, n in enumerate(header)}


def _get(row, col, field):
    i = col.get(field)
    return row[i] if i is not None and i < len(row) else ""


def outcome(log_status):
    if log_status == "sent":
        return "sent"
    if log_status in ("hard_bounce", "soft_bounce", "failed"):
        return "failed"
    if log_status == "unknown":
        return "unknown"
    return None  # invalid_email, sent_test, etc. are not send attempts


def build(leads_rows, referrals_rows, log_rows, today, settings=None):
    settings = settings or {}
    status, enrich, states = Counter(), Counter(), Counter()
    total = 0
    for rows in (leads_rows, referrals_rows):
        if not rows:
            continue
        col = _col(rows[0])
        for r in rows[1:]:
            total += 1
            status[_get(r, col, "outreach_status") or "unknown"] += 1
            enrich[_get(r, col, "enrichment_status") or "n/a"] += 1
            st = _get(r, col, "state").strip().upper()
            if st:
                states[st] += 1

    start = (datetime.date.fromisoformat(today) - datetime.timedelta(days=DAYS - 1))
    days = {(start + datetime.timedelta(days=i)).isoformat(): {"sent": 0, "failed": 0, "unknown": 0} for i in range(DAYS)}
    totals = Counter()
    for r in log_rows[1:]:
        o = outcome(r[7] if len(r) > 7 else "")
        if not o:
            continue
        totals[o] += 1
        d = r[4] if len(r) > 4 else ""
        if d in days:
            days[d][o] += 1

    attempts_today, prior_days, bounce = se.sending_stats(log_rows_ws(log_rows), today)
    cap = se.todays_caps(prior_days)[0]
    if "daily_send_cap" in settings:
        cap = min(cap, settings["daily_send_cap"])
    sent = bounce["sent"]
    return {
        "as_of": today,
        "kpis": {
            "total_leads": total,
            "contacted": status.get(se.STATUS_SENT, 0),
            "attempts_today": attempts_today,
            "daily_cap": cap,
            "bounce_rate": round(bounce["hard"] / sent * 100, 1) if sent else 0.0,
            "bounce_limit": se.MAX_BOUNCE_RATE_PERCENT,
        },
        "attention": {
            "unknown": status.get(se.STATUS_UNKNOWN, 0),
            "pending": status.get(se.STATUS_PENDING, 0),
            "failed": status.get(se.STATUS_FAILED, 0),
        },
        "sends_by_day": [{"date": d, **v} for d, v in days.items()],
        "send_totals": {k: totals.get(k, 0) for k in ("sent", "failed", "unknown")},
        "outreach_status": status.most_common(),
        "enrichment": enrich.most_common(),
        "top_states": states.most_common(10),
    }


class log_rows_ws:
    """Adapter so se.sending_stats (which expects a worksheet) can read plain rows."""
    def __init__(self, rows):
        self.rows = rows

    def get_all_values(self):
        return self.rows


def fetch(settings=None, ttl=60):
    """Read the sheets (cached briefly to stay inside Google's read quota)."""
    if _cache["data"] and time.time() - _cache["at"] < ttl:
        return _cache["data"]
    sheet = se.get_sheets_with_retry()
    today = datetime.date.today().isoformat()
    data = build(sheet.worksheet("Leads").get_all_values(), sheet.worksheet("Referrals").get_all_values(),
                 sheet.worksheet("Outreach_Log").get_all_values(), today, settings)
    _cache.update(at=time.time(), data=data)
    return data
