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

BODY_TEMPLATE = (
    "Hi {business_name} team,<br><br>"
    "I'll keep this short — running a business like {business_name} usually means the paperwork piles up around the edges: invoices to track, licenses and renewals to stay on top of, vendor files, data entry, reporting. It's necessary, but it's rarely why anyone got into the business.<br><br>"
    "That's exactly the work Aurum Ventura Enterprise takes off your plate. We're a Tennessee-based administrative back-office for small and growing businesses — handling documents, invoices, license tracking, vendor administration, and reporting within a clearly defined scope, so you always know what's covered and what it costs. Think of it as outsourced admin support without the overhead of a new hire.<br><br>"
    "If any of that sounds like a headache you'd rather hand off, I'd love to send over more details or set up a quick call — no pressure either way.<br><br>"
    "Best,<br><br>"
    "Kyle Fulwood Jr<br>"
    "Chief Executive Officer<br>"
    "Aurum Ventura Enterprise LLC — Business Administration Services<br>"
    "850-653-7797 | admin@aurumventura.net | aurumventura.net<br>"
    "\"Your Business. Our Back Office.\"<br><br>"
    "---<br>"
    "Nashville, TN<br>"
    "Don't want to hear from us again? Just reply \"UNSUBSCRIBE\" and we'll take you off the list."
)

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
