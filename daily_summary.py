import os
import requests
import gspread
import google.auth

SHEET_ID = os.environ.get("SHEET_ID")
DISCORD_WEBHOOK_URL = os.environ.get("DISCORD_WEBHOOK_URL")

def get_client():
    credentials, _ = google.auth.default(
        scopes=["https://www.googleapis.com/auth/spreadsheets"]
    )
    return gspread.authorize(credentials)


def get_metric(rows, label):
    for row in rows:
        if len(row) >= 2 and row[0].strip() == label:
            return row[1]
    return "0"


if __name__ == "__main__":
    if not SHEET_ID or not DISCORD_WEBHOOK_URL:
        raise SystemExit("Set SHEET_ID and DISCORD_WEBHOOK_URL first.")

    gc = get_client()
    sheet = gc.open_by_key(SHEET_ID)
    ws = sheet.worksheet("Analytics")
    rows = ws.get_all_values()

    total_leads = get_metric(rows, "Total Leads Found")
    enriched = get_metric(rows, "Enriched (has email)")
    ready = get_metric(rows, "Ready to Contact (new)")
    contacted = get_metric(rows, "Contacted")
    sent = get_metric(rows, "Emails Sent (live)")
    failed = get_metric(rows, "Failed Sends")

    message = (
        "📊 **Daily Outreach Summary**\n"
        f"Total leads found: **{total_leads}**\n"
        f"Enriched (have email): **{enriched}**\n"
        f"Ready to contact: **{ready}**\n"
        f"Contacted so far: **{contacted}**\n"
        f"Emails sent (live): **{sent}**\n"
        f"Failed sends: **{failed}**"
    )

    resp = requests.post(DISCORD_WEBHOOK_URL, json={"content": message})
    resp.raise_for_status()
    print("Posted daily summary to Discord.")
