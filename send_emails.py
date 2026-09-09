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
        city_state = row[13] if len(row) > 13 else ""  # Added city_state column
        
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
    for row in
