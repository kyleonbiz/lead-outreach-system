import os
import time
import uuid
import base64
import datetime
import requests
import gspread
import google.auth
from google.auth.exceptions import TransportError

TENANT_ID = os.environ.get("MS_TENANT_ID")
CLIENT_ID = os.environ.get("MS_CLIENT_ID")
CLIENT_SECRET = os.environ.get("MS_CLIENT_SECRET")
SENDER_EMAIL = os.environ.get("SENDER_EMAIL")
SHEET_ID = os.environ.get("SHEET_ID")
TEST_MODE = os.environ.get("TEST_MODE", "true").lower() == "true"
TEST_EMAIL = os.environ.get("TEST_EMAIL", "")

DAILY_CAP = 100
PER_RUN_CAP = 10

LOGO_PATH = "logo.png"
TEMPLATE_VERSION = "v2_intro"

SUBJECT_TEMPLATE = "Quick intro"

NAVY = "#1B2A5A"

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
    "Hi there,<br><br>"
    "I'm Kyle with Aurum Ventura.<br><br>"
    "We provide human-led administrative support at a fraction of the cost of hiring in-house, "
    "handling the back-office work so you can stay focused on your customers.<br><br>"
    "No contracts. Just administrative support when you need it.<br><br>"
    "I'm simply reaching out to make you aware we exist.<br><br>"
    "<a href=\"https://aurumventura.net\">aurumventura.net</a><br><br>"
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

def send_email(token, to_email, subject, html_body, logo_b64=None):
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
    return requests.post(url, headers=headers, json=payload)

def get_sheets_client():
    credentials, _ = google.auth.default(
        scopes=["https://www.googleapis.com/auth/spreadsheets"]
    )
    return gspread.authorize(credentials)

def count_sent_today(log_ws, today):
    rows = log_ws.get_all_values()
    count = 0
    for row in rows[1:]:
        date_sent = row[4] if len(row) > 4 else ""
        status = row[7] if len(row) > 7 else ""
        if date_sent == today and status == "sent":
            count += 1
    return count

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

    print(f"Running in {'TEST' if TEST_MODE else 'LIVE'} mode.")

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
    log_ws = sheet.worksheet("Outreach_Log")

    today = datetime.date.today().isoformat()

    if TEST_MODE:
        run_cap = 1
    else:
        already_sent_today = count_sent_today(log_ws, today)
        remaining_daily = max(0, DAILY_CAP - already_sent_today)
        run_cap = min(PER_RUN_CAP, remaining_daily)
        print(f"Already sent {already_sent_today}/{DAILY_CAP} today. This run will send up to {run_cap} more.")
        if run_cap == 0:
            print("Daily cap already reached — nothing to send this run.")

    rows = leads_ws.get_all_values()
    header = rows[0]
    col = {name: i for i, name in enumerate(header)}

    token = get_graph_token()
    sent_count = 0
    log_rows = []

    for row_num, row in enumerate(rows[1:], start=2):
        if sent_count >= run_cap:
            break

        def get(field):
            idx = col.get(field)
            return row[idx] if idx is not None and idx < len(row) else ""

        outreach_status = get("outreach_status")
        email = get("email")
        business_name = get("business_name")
        lead_id = get("lead_id")
        city = get("city").strip()
        state = get("state").strip()

        if outreach_status != "new" or not email:
            continue

        subject = SUBJECT_TEMPLATE
        body = BODY_TEMPLATE.format(logo_html=logo_html)
        recipient = TEST_EMAIL if TEST_MODE else email

        if TEST_MODE:
            subject = "[TEST] " + subject

        resp = send_email(token, recipient, subject, body, logo_b64)

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
            TEMPLATE_VERSION,
            send_status,
            "", "", "",
            error_message,
            city,
            state,
            f"{city}, {state}",
        ])

        time.sleep(3)

    if log_rows:
        log_ws.append_rows(log_rows, value_input_option="USER_ENTERED")

    print(f"Sent {sent_count} email(s) this run. Logged {len(log_rows)} attempt(s).")
