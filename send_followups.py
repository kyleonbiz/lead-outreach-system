"""Send APPROVED follow-up drafts (one attempt each). Runs as the 'send_followups' job; same safety rules as send_emails.py."""
import datetime
import os

import send_emails as se
from app.agents import followup, store


def main():
    if os.environ.get("LOCAL_DATA_PATH", "").strip():
        raise SystemExit("Local mode: sending is disabled.")
    if not se.EMAIL_SENDING_ENABLED:
        print("Email sending is disabled (EMAIL_SENDING_ENABLED=false). Nothing sent.")
        return
    for name in ("MS_TENANT_ID", "MS_CLIENT_ID", "MS_CLIENT_SECRET", "SENDER_EMAIL", "SHEET_ID"):
        if not os.environ.get(name):
            raise SystemExit(f"Set {name} first.")
    if not any(d["status"] == "approved" for d in store.load("followups", {"drafts": []})["drafts"]):
        print("No approved follow-ups to send.")
        return
    sheet = se.get_sheets_with_retry()
    leads_ws, log_ws = sheet.worksheet("Leads"), sheet.worksheet("Outreach_Log")
    today = datetime.date.today().isoformat()
    attempts_today, prior_days, bounce = se.sending_stats(log_ws, today)
    ok, msg = se.check_bounce_rate(bounce)
    if not ok:
        raise SystemExit(f"STOPPING: {msg}")
    daily_cap, per_run = se.todays_caps(prior_days)
    run_cap = min(per_run, max(0, daily_cap - attempts_today))
    print(f"Already attempted {attempts_today}/{daily_cap} today. Follow-ups may send up to {run_cap}.")
    try:
        token = se.get_graph_token()
    except Exception as e:
        raise SystemExit(f"Could not obtain Microsoft Graph token ({type(e).__name__}).")
    emails, domains = se.load_suppression(sheet)
    s = followup.send_approved(leads_ws, log_ws, token, today, run_cap, emails, domains)
    print(f"Sent {s['sent']} follow-up(s). Failed {s['failed']}, uncertain {s['unknown']}, skipped {s['skipped']}.")
    if s["stopped"] in se.STOP_CAMPAIGN:
        raise SystemExit(f"Campaign halted: {s['stopped']}. Investigate before resuming.")


if __name__ == "__main__":
    main()
