import os
import json
import datetime
import gspread
import google.auth

SHEET_ID = os.environ.get("SHEET_ID")
OUTPUT_PATH = "docs/dashboard_data.json"

def get_sheets_client():
    credentials, _ = google.auth.default(
        scopes=["https://www.googleapis.com/auth/spreadsheets"]
    )
    return gspread.authorize(credentials)

def build_leads_summary(leads_ws):
    rows = leads_ws.get_all_values()
    if not rows:
        return {}, []
    header = rows[0]
    col = {name: i for i, name in enumerate(header)}

    def get(row, field):
        idx = col.get(field)
        return row[idx] if idx is not None and idx < len(row) else ""

    status_counts = {}
    enrichment_counts = {}
    recent = []

    for row in rows[1:]:
        status = get(row, "outreach_status") or "unknown"
        status_counts[status] = status_counts.get(status, 0) + 1

        enrich = get(row, "enrichment_status") or "unknown"
        enrichment_counts[enrich] = enrichment_counts.get(enrich, 0) + 1

        recent.append({
            "business_name": get(row, "business_name"),
            "city": get(row, "city"),
            "state": get(row, "state"),
            "outreach_status": status,
            "enrichment_status": enrich,
            "date_contacted": get(row, "date_contacted"),
        })

    recent.reverse()  # most recently added first
    return {
        "total_leads": len(rows) - 1,
        "status_counts": status_counts,
        "enrichment_counts": enrichment_counts,
    }, recent[:15]

def build_outreach_summary(log_ws):
    rows = log_ws.get_all_values()
    if len(rows) <= 1:
        return {}, []

    status_counts = {}
    recent = []

    # Columns written by send_emails.py, in order:
    # 0 log_id, 1 lead_id, 2 business_name, 3 recipient, 4 date_sent,
    # 5 subject, 6 template, 7 status, 8-10 unused, 11 error_message
    for row in rows[1:]:
        status = row[7] if len(row) > 7 else "unknown"
        status_counts[status] = status_counts.get(status, 0) + 1
        recent.append({
            "business_name": row[2] if len(row) > 2 else "",
            "date_sent": row[4] if len(row) > 4 else "",
            "subject": row[5] if len(row) > 5 else "",
            "status": status,
        })

    recent.reverse()
    return {
        "total_attempts": len(rows) - 1,
        "status_counts": status_counts,
    }, recent[:15]

def build_campaign_queue(queue_ws):
    rows = queue_ws.get_all_values()
    if len(rows) <= 1:
        return []
    header = rows[0]
    col = {name: i for i, name in enumerate(header)}

    def get(row, field):
        idx = col.get(field)
        return row[idx] if idx is not None and idx < len(row) else ""

    campaigns = []
    for row in rows[1:]:
        campaigns.append({
            "industry": get(row, "industry"),
            "location": get(row, "location"),
            "active": get(row, "active"),
            "last_run_at": get(row, "last_run_at"),
        })
    return campaigns

if __name__ == "__main__":
    if not SHEET_ID:
        raise SystemExit("Set SHEET_ID first.")

    gc = get_sheets_client()
    sheet = gc.open_by_key(SHEET_ID)

    leads_summary, recent_leads = build_leads_summary(sheet.worksheet("Leads"))
    outreach_summary, recent_outreach = build_outreach_summary(sheet.worksheet("Outreach_Log"))
    campaign_queue = build_campaign_queue(sheet.worksheet("Campaign_Queue"))

    data = {
        "last_updated": datetime.datetime.utcnow().isoformat() + "Z",
        "leads": leads_summary,
        "recent_leads": recent_leads,
        "outreach": outreach_summary,
        "recent_outreach": recent_outreach,
        "campaign_queue": campaign_queue,
    }

    os.makedirs("docs", exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(data, f, indent=2)

    print(f"Wrote {OUTPUT_PATH}")
