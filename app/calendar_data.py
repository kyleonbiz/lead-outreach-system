"""Month data for the Calendar tab: sends per day, follow-ups due, scheduled job runs. Counts and names only (no emails)."""
import datetime
import re
import uuid

from .agents import store
from .jobs import trigger

MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
MAX_DUE_NAMES = 30


def month_range(month):
    y, m = int(month[:4]), int(month[5:7])
    first = datetime.date(y, m, 1)
    last = (first + datetime.timedelta(days=32)).replace(day=1) - datetime.timedelta(days=1)
    return first, last


def _idx(header):
    return {h: i for i, h in enumerate(header)}


def _g(r, ix, f, default=""):
    i = ix.get(f)
    return r[i].strip() if i is not None and i < len(r) else default


def job_runs(schedules, first, last):
    """{date_iso: {job: number_of_runs}} for cron schedules (UTC) between first and last."""
    out = {}
    for job, crons in schedules.items():
        for cron in crons:
            trig = trigger(cron)
            now = datetime.datetime.combine(first, datetime.time(0), tzinfo=datetime.timezone.utc) - datetime.timedelta(seconds=1)
            while True:
                t = trig.get_next_fire_time(None, now)
                if t is None or t.date() > last:
                    break
                d = out.setdefault(t.date().isoformat(), {})
                d[job] = d.get(job, 0) + 1
                now = t + datetime.timedelta(seconds=1)
    return out


def build(leads, log, month, today, after_days, schedules, events):
    first, last = month_range(month)
    days = {}
    def day(k):
        return days.setdefault(k, {"sent": 0, "failed": 0, "unknown": 0, "due_count": 0, "due": [], "jobs": {}})

    lh = _idx(log["header"]) if log.get("header") else {}
    for r in log.get("rows", []):
        d = _g(r, lh, "date_sent") or (r[4] if len(r) > 4 else "")
        s = _g(r, lh, "send_status") or (r[7] if len(r) > 7 else "")
        if not (first.isoformat() <= d <= last.isoformat()):
            continue
        k = {"sent": "sent", "hard_bounce": "failed", "soft_bounce": "failed", "failed": "failed", "unknown": "unknown"}.get(s)
        if k:
            day(d)[k] += 1

    ix = _idx(leads.get("header", []))
    for r in leads.get("rows", []):
        if _g(r, ix, "outreach_status") != "contacted" or _g(r, ix, "date_last_followup"):
            continue
        try:
            due = datetime.date.fromisoformat(_g(r, ix, "date_contacted")[:10]) + datetime.timedelta(days=after_days)
        except ValueError:
            continue
        if first <= due <= last:
            e = day(due.isoformat())
            e["due_count"] += 1
            if len(e["due"]) < MAX_DUE_NAMES:
                e["due"].append({"id": _g(r, ix, "lead_id"), "name": _g(r, ix, "business_name")})

    for d, jobs in job_runs(schedules, first, last).items():
        day(d)["jobs"] = jobs
    mine = sorted((e for e in events if first.isoformat() <= e["date"] <= last.isoformat()), key=lambda e: (e["date"], e["title"]))
    return {"month": month, "today": today.isoformat(), "after_days": after_days, "days": days, "events": mine}


def add_event(date, title, note=""):
    """Add a calendar event. Returns (event, error)."""
    try:
        datetime.date.fromisoformat(date or "")
    except ValueError:
        return None, "not a real date (use YYYY-MM-DD)"
    title = (title or "").strip()
    if not title or len(title) > 120:
        return None, "title must be 1-120 characters"
    def go(d):
        if len(d["events"]) >= 500:
            return None, "limit of 500 events"
        ev = {"id": uuid.uuid4().hex[:8], "date": date, "title": title, "note": (note or "").strip()[:500]}
        d["events"].append(ev)
        return ev, ""
    return store.mutate("calendar", go, {"events": []})
