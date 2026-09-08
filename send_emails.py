import os
import time
import uuid
import datetime
import requests
import gspread
import google.auth

TENANT_ID = os.environ.get("MS_TENANT_ID")
CLIENT_ID = os.environ.get("MS_CLIENT_ID")
CLIENT_SECRET = os.environ.get("MS_CLIENT_SECRET")
SENDER_EMAIL = os.environ.get("SENDER_EMAIL")
SHEET_ID = os.environ.get("SHEET_ID")

TEST_MODE = os.environ.get("TEST_MODE", "true").lower() == "true"
TEST_EMAIL = os.environ.get("TEST_EMAIL", "")

DAILY_CAP = 1 if TEST_MODE else 50

SUBJECT_TEMPLATE = "Quick question about {business_name}'s back-office workload"

BODY_TEMPLATE = """Hi {business_name} team,<br><br>
I'll keep this short — running a business like {business_name} usually means the paperwork piles up around the edges: invoices to track, licenses and renewals to stay on top of, vendor files, data entry, reporting. It's necessary, but it's rarely why anyone got into the business.<br><br>
That's exactly the work Aurum Ventura Enterprise takes off your plate. We're a Tennessee-based administrative back-office for small and growing businesses — handling documents, invoices, license tracking, vendor administration, and reporting within a clearly defined scope, so you always know what's covered and what it costs. Think of it as outsourced admin support without the overhead of a new hire.<br><br>
If any of that sounds like a headache you'd rather hand off, I'd love to send over more details or set up a quick call — no pressure either way.<br><br>
Best,<br>
Kyle Fulwood Jr<br>
Chief Executive Officer<br>
Aurum Ventura Enterprise LLC — Business Administration Services<br>
850-653-7797 | admin@aurumventura.net | aurumventura.net<br>
"Your Business. Our Back Office."<br><br>
---<br>
Nashville, TN 37214<br>
Don't want to hear from us again? Just reply "UNSUBSCRIBE" and we'll take you off the list.
"""


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


def send_email(token, to_email, subject, html_body):
    url = f"https://graph.microsoft.com/v1.0/users/{SENDER_EMAIL}/sendMail"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    payload = {
        "message": {
            "subject": subject,
            "body": {"contentType": "HTML", "content": html_body},
            "toRecipients": [{"emailAddress": {"address": to_email}}],
        },
        "saveToSentItems": "true",
    }
    return requests.post(url, headers=headers, json=payload)


def get_sheets_client():
    credentials, _ = google.auth.default(
        scopes=["https://www.googleapis.com/auth/spreadsheets"]
    )
    return gspread.authorize(credentials)


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

    print(f"Running in {'TEST' if TEST_MODE else 'LIVE'} mode. Cap: {DAILY_CAP} email(s).")

    gc = get_sheets_client()
    sheet = gc.open_by_key(SHEET_ID)
    leads_ws = sheet.worksheet("Leads")
    log_ws = sheet.worksheet("Outreach_Log")

    rows = leads_ws.get_all_values()
    header = rows[0]
    col = {name: i for i, name in enumerate(header)}

    token = get_graph_token()

    sent_count = 0
    today = datetime.date.today().isoformat()
    log_rows = []

    for row_num, row in enumerate(rows[1:], start=2):
        if sent_count >= DAILY_CAP:
            break

        def get(field):
            idx = col.get(field)
            return row[idx] if idx is not None and idx < len(row) else ""

        outreach_status = get("outreach_status")
        email = get("email")
        business_name = get("business_name")
        lead_id = get("lead_id")

        if outreach_status != "new" or not email:
            continue

        subject = SUBJECT_TEMPLATE.format(business_name=business_name)
        body = BODY_TEMPLATE.format(business_name=business_name)

        recipient = TEST_EMAIL if TEST_MODE else email
        if TEST_MODE:
            subject = "[TEST] " + subject

        resp = send_email(token, recipient, subject, body)

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

        log_rows.append([
            str(uuid.uuid4())[:8],
            lead_id,
            business_name,
            recipient,
            today,
            subject,
            "v1_backoffice_pitch",
            send_status,
            "", "", "",
            error_message,
        ])

        time.sleep(2)

    if log_rows:
        log_ws.append_rows(log_rows, value_input_option="USER_ENTERED")

    print(f"Sent {sent_count} email(s). Logged {len(log_rows)} attempt(s).")
