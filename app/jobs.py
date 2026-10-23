"""Cron schedules of the GitHub Actions workflows (UTC). The Calendar shows them; this app does not run anything."""
import re

from apscheduler.triggers.cron import CronTrigger

SCHEDULES = {
    "find_leads": ["0 12-22/2 * * 1-5", "0 0 * * 2-6"],
    "send_outreach": ["0 16-23 * * 1-5", "0 0-2 * * 2-6"],
    "daily_summary": ["0 18 * * 1-5"],
    "organize_leads": ["0 0 * * *"],
    "create_fb_posts": ["0 13 * * 1"],
}

_DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def trigger(cron):
    """CronTrigger from a standard 5-field cron string (UTC).

    APScheduler numbers weekdays Monday=0, but standard cron (and GitHub Actions) uses Sunday=0, so the
    weekday field is converted to names. Without this, "1-5" would mean Tue-Sat instead of Mon-Fri."""
    minute, hour, dom, month, dow = cron.split()
    dow = re.sub(r"(?<!/)\d+", lambda m: _DOW[int(m.group())], dow)
    return CronTrigger(minute=minute, hour=hour, day=dom, month=month, day_of_week=dow, timezone="UTC")
