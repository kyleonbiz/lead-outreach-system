#!/usr/bin/env python3
"""Track replies vs emails sent, overall and per industry.

Reads the sender mailbox (Microsoft Graph, needs Mail.Read), matches incoming mail to
contacted leads, marks replied/unsubscribed leads in the Leads tab, and writes a
Reply_Stats tab (plus a Discord summary if DISCORD_WEBHOOK_URL is set).
"""

import os
import datetime
from collections import defaultdict

import requests
import gspread
import google.auth

TENANT_ID = os.environ.get("MS_TENANT_ID")
CLIENT_ID = os.environ.get("MS_CLIENT_ID")
CLIENT_SECRET = os.environ.get("MS_CLIENT_SECRET")
SENDER_EMAIL = os.environ.get("SENDER_EMAIL")
SHEET_ID = os.environ.get("SHEET_ID")
DISCORD_WEBHOOK_URL = os.environ.get("DISCORD_WEBHOOK_URL")

TRACK_START_DATE = os.environ.get("TRACK_START_DATE", "2026-09-29")  # same as RAMP_START_DATE

# Outreach_Log column positions (see send_emails.py)
LOG_LEAD_ID, LOG_EMAIL, LOG_DATE, LOG_STATUS = 1, 3, 4, 7

FREE_DOMAINS = {"gmail.com", "outlook.com", "hotmail.com", "live.com", "icloud.com", "msn.com", "me.com"}
AUTO_SENDERS = ("mailer-daemon", "postmaster", "noreply", "no-reply", "donotreply")
AUTO_SUBJECTS = ("undeliverable", "delivery status", "automatic reply", "out of office", "autoreply", "auto-reply")
UNSUB_WORDS = ("unsubscribe", "remove me", "stop emailing", "stop contacting", "do not contact", "take me off")


def get_sheets_client():
    credentials, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/spreadsheets"])
    return gspread.authorize(credentials)


def get_graph_token():
    resp = requests.post(
        f"https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/token",
        data={
            "grant_type": "client_credentials",
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
            "scope": "https://graph.microsoft.com/.default",
        },
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


def fetch_inbox(token, since):
    url = f"https://graph.microsoft.com/v1.0/users/{SENDER_EMAIL}/mailFolders/inbox/messages"
    params = {
        "$filter": f"receivedDateTime ge {since}T00:00:00Z",
        "$select": "from,subject,receivedDateTime,bodyPreview",
        "$top": 100,
    }
    headers = {"Authorization": f"Bearer {token}"}
    messages = []
    while url:
        resp = requests.get(url, headers=headers, params=params)
        resp.raise_for_status()
        data = resp.json()
        messages.extend(data.get("value", []))
        url, params = data.get("@odata.nextLink"), None
    return messages


def is_automated(sender, subject):
    return sender.startswith(AUTO_SENDERS) or any(w in subject for w in AUTO_SUBJECTS)


def main():
    for name, val in {"MS_TENANT_ID": TENANT_ID, "MS_CLIENT_ID": CLIENT_ID, "MS_CLIENT_SECRET": CLIENT_SECRET,
                      "SENDER_EMAIL": SENDER_EMAIL, "SHEET_ID": SHEET_ID}.items():
        if not val:
            raise SystemExit(f"Set {name} first.")

    sheet = get_sheets_client().open_by_key(SHEET_ID)
    leads_ws = sheet.worksheet("Leads")
    log_rows = sheet.worksheet("Outreach_Log").get_all_values()[1:]
    leads_rows = leads_ws.get_all_values()
    col = {name: i for i, name in enumerate(leads_rows[0])}
    industry_by_lead = {}
    row_by_lead = {}
    for row_num, row in enumerate(leads_rows[1:], start=2):
        lead_id = row[col["lead_id"]] if "lead_id" in col and col["lead_id"] < len(row) else ""
        if lead_id:
            industry_by_lead[lead_id] = (row[col["industry"]].strip() if "industry" in col and col["industry"] < len(row) else "") or "unknown"
            row_by_lead[lead_id] = row_num

    # Contacted leads (live sends only), keyed by address and by business domain
    sent_by_industry = defaultdict(int)
    by_email, by_domain = {}, {}
    total_sent = 0
    for row in log_rows:
        if len(row) <= LOG_STATUS or row[LOG_STATUS] != "sent" or row[LOG_DATE] < TRACK_START_DATE:
            continue
        lead_id, email = row[LOG_LEAD_ID], row[LOG_EMAIL].strip().lower()
        if lead_id not in industry_by_lead:
            continue  # referral partners (no lead row) aren't part of the niche stats
        total_sent += 1
        sent_by_industry[industry_by_lead[lead_id]] += 1
        by_email[email] = lead_id
        domain = email.rsplit("@", 1)[-1]
        if domain not in FREE_DOMAINS:
            by_domain[domain] = lead_id

    since = (datetime.date.fromisoformat(TRACK_START_DATE)).isoformat()
    messages = fetch_inbox(get_graph_token(), since)

    replied, unsubscribed, reply_detail = {}, set(), []
    for m in messages:
        sender = (m.get("from", {}).get("emailAddress", {}).get("address") or "").lower()
        subject = (m.get("subject") or "").lower()
        if not sender or is_automated(sender, subject):
            continue
        lead_id = by_email.get(sender) or by_domain.get(sender.rsplit("@", 1)[-1])
        if not lead_id:
            continue
        replied.setdefault(lead_id, m.get("receivedDateTime", "")[:10])
        text = subject + " " + (m.get("bodyPreview") or "").lower()
        if any(w in text for w in UNSUB_WORDS):
            unsubscribed.add(lead_id)

    replies_by_industry = defaultdict(int)
    for lead_id in replied:
        replies_by_industry[industry_by_lead[lead_id]] += 1

    # Mark leads so nobody who replied or opted out gets contacted again
    status_col = col["outreach_status"] + 1
    updates = []
    for lead_id in replied:
        status = "unsubscribed" if lead_id in unsubscribed else "replied"
        updates.append({"range": gspread.utils.rowcol_to_a1(row_by_lead[lead_id], status_col), "values": [[status]]})
    if updates:
        leads_ws.batch_update(updates)

    # Report
    pct = lambda r, s: f"{(r / s * 100):.1f}%" if s else "0.0%"
    total_replies = len(replied)
    table = [["Industry", "Sent", "Replies", "Reply rate"]]
    for industry in sorted(sent_by_industry, key=lambda i: -sent_by_industry[i]):
        s, r = sent_by_industry[industry], replies_by_industry.get(industry, 0)
        table.append([industry, s, r, pct(r, s)])
    table.append(["ALL", total_sent, total_replies, pct(total_replies, total_sent)])

    try:
        ws = sheet.worksheet("Reply_Stats")
        ws.clear()
    except gspread.exceptions.WorksheetNotFound:
        ws = sheet.add_worksheet(title="Reply_Stats", rows=100, cols=6)
    header = [[f"Updated {datetime.datetime.utcnow().isoformat(timespec='minutes')}Z", f"Since {TRACK_START_DATE}"], []]
    ws.update(values=header + table + [[], ["Unsubscribe requests", len(unsubscribed)]], range_name="A1")

    summary = (f"📬 **Reply tracking** (since {TRACK_START_DATE})\n"
               f"Sent: **{total_sent}** | Replies: **{total_replies}** ({pct(total_replies, total_sent)}) | "
               f"Unsubscribes: **{len(unsubscribed)}**\n"
               + "\n".join(f"{r[0]}: {r[2]}/{r[1]} ({r[3]})" for r in table[1:-1]))
    print(summary)
    if DISCORD_WEBHOOK_URL:
        requests.post(DISCORD_WEBHOOK_URL, json={"content": summary[:1900]})


if __name__ == "__main__":
    main()
