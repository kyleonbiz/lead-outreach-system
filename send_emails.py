import os
import time
import uuid
import base64
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

DAILY_CAP = 125     # total live sends allowed per calendar day, across all runs
PER_RUN_CAP = 2     # live sends allowed in a single run — spreads volume across the day

LOGO_PATH = "logo.png"

SUBJECT_TEMPLATE = "Quick question about {business_name}'s back-office workload"

BODY_TEMPLATE = (
    "Hi {business_name} team,<br><br>"
    "I'll keep this short — running a business like {business_name} usually means the paperwork piles up around the edges: invoices to track, licenses and renewals to stay on top of, vendor files, data entry, reporting. It's necessary, but it's rarely why anyone got into the business.<br><br>"
    "That's exactly the work Aurum Ventura Enterprise takes off your plate. We're a Tennessee-based administrative back-office for small and growing businesses — handling documents, invoices, license tracking, vendor administration, and reporting within a clearly defined scope, so you always know what's covered and what it costs. Think of it as outsourced admin support without the overhead of a new hire.<br><br>"
    "If any of that sounds like a headache you'd rather hand off, I'd love to send over more details or set up a quick call — no pressure either way.<br><br>"
    "Best,<br><br>"
    "{logo_html}"
    "Kyle Fulwood Jr<br>"
    "Chief Executive Officer<br>"
    "Aurum Ventura Enterprise LLC — Business Administration Services<br>"
    "850-653-7797 | admin@aurumventura.net | aurumventura.net<br>"
    "\"Your Business. Our Back Office.\"<br><br>"
    "Nashville, TN<br>"
    "Don't want to hear from us again? Just reply \"UNSUBSCRIBE\" and we'll take you off the list."
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

def count_sent_this_month_by_city(log_ws):
    """Return a dict of {city_state: count} for emails sent this month"""
    rows = log_ws.get_all_values()
    today = datetime.date.today()
    month_start = today.replace(day=1)
    
    city_counts = {}
    for row in rows[1:]:
        date_sent = row[4] if len(row) > 4 else ""
        status = row[7] if len(row) > 7 else ""
        city_state = row[13] if len(row) > 13 else ""
        
        if status != "sent" or not date_sent:
            continue
        
        try:
            sent_date = datetime.datetime.fromisoformat(date_sent).date()
        except (ValueError, TypeError):
            continue
        
        if sent_date >= month_start:
            city_counts[city_state] = city_counts.get(city_state, 0) + 1
    
    return city_counts

def get_city_quotas(cities_ws):
    """Return a dict of {city_state: max_emails} from Cities tab"""
    rows = cities_ws.get_all_values()
    header = rows[0]
    col = {name: i for i, name in enumerate(header)}
    
    quotas = {}
    for row in rows[1:]:
        def get(field):
            idx = col.get(field)
            return row[idx] if idx is not None and idx < len(row) else ""
        
        status = get("Status").strip().upper()
        if status != "ACTIVE":
            continue
        
        city = get("City").strip()
        state = get("State").strip()
        max_emails_str = get("Max Monthly Emails").strip()
        
        try:
            max_emails = int(max_emails_str)
        except (ValueError, TypeError):
            max_emails = 625
        
        city_state = f"{city}, {state}"
        quotas[city_state] = max_emails
    
    return quotas

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
            "width=\"160\" style=\"display:block;margin:8px 0;\"><br>"
        )
    else:
        logo_html = ""
        print("Warning: logo.png not found in repo root — sending without logo.")

    gc = get_sheets_client()
    sheet = gc.open_by_key(SHEET_ID)
    leads_ws = sheet.worksheet("Leads")
    log_ws = sheet.worksheet("Outreach_Log")
    cities_ws = sheet.worksheet("Cities")

    today = datetime.date.today().isoformat()

    # Load city quotas and current month counts
    city_quotas = get_city_quotas(cities_ws)
    city_sent_this_month = count_sent_this_month_by_city(log_ws)

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

        # Check if city has hit its monthly quota
        city_state = f"{city}, {state}"
        max_for_city = city_quotas.get(city_state, 625)
        sent_for_city = city_sent_this_month.get(city_state, 0)
        
        if sent_for_city >= max_for_city:
            print(f"Skipping {business_name} — {city_state} has hit monthly quota ({sent_for_city}/{max_for_city}).")
            continue

        subject = SUBJECT_TEMPLATE.format(business_name=business_name)
        body = BODY_TEMPLATE.format(business_name=business_name, logo_html=logo_html)
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
                city_sent_this_month[city_state] = city_sent_this_month.get(city_state, 0) + 1
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
            city,
            state,
            city_state,
        ])

        time.sleep(3)

    if log_rows:
        log_ws.append_rows(log_rows, value_input_option="USER_ENTERED")

    print(f"Sent {sent_count} email(s) this run. Logged {len(log_rows)} attempt(s).")
