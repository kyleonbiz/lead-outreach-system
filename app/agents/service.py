"""Runs agents in the background and records their status (no personal data in the status)."""
import datetime
import threading

import send_emails as se

from .. import dashboard
from . import followup, llm, marketing, research, store

runs = {}  # name -> {state, message, finished}
_locks = {n: threading.Lock() for n in ("followup", "research", "marketing")}


def _rows(sheet, tab):
    try:
        return sheet.worksheet(tab).get_all_values()
    except Exception:
        return []


def _do(name, after_days):
    if name == "marketing":
        r = marketing.run()
        return f"Drafted {len(r['posts'])} posts and {len(r['seo'])} page ideas."
    sheet = dashboard.get_sheet()
    leads, log = _rows(sheet, "Leads"), _rows(sheet, "Outreach_Log")
    if not leads:
        raise llm.LLMError("the Leads tab is empty or missing")
    if name == "research":
        r = research.run(leads, log, _rows(sheet, "Campaign_Queue"))
        return f"Analyzed {sum(i['leads'] for i in r['stats']['industries'])} leads; {len(r['advice']['recommendations'])} recommendations."
    emails, domains = se.load_suppression(sheet)
    emails |= store.suppressed_emails()
    s = followup.scan(leads, log, emails, domains, datetime.date.today(), after_days)
    return (f"{s['eligible']} leads eligible; drafted {s['drafted']}"
            f"{', ' + str(s['failed_validation']) + ' failed checks' if s['failed_validation'] else ''}"
            f"{', ' + str(s['left_for_later']) + ' left for later' if s['left_for_later'] else ''}.")


def start(name, after_days=5, background=True):
    """Returns False if that agent is already running."""
    lock = _locks[name]
    if not lock.acquire(blocking=False):
        return False

    def go():
        runs[name] = {"state": "running", "message": ""}
        try:
            msg, state = _do(name, after_days), "ok"
        except llm.LLMError as e:
            msg, state = str(e), "failed"
        except Exception as e:  # sheet unreachable, website unreadable, ...
            msg, state = f"{type(e).__name__}: could not complete", "failed"
        runs[name] = {"state": state, "message": msg,
                      "finished": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
        lock.release()

    if background:
        threading.Thread(target=go, daemon=True).start()
    else:
        go()
    return True
