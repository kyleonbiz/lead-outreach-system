#!/usr/bin/env python3
"""Check current bounce rate from Outreach_Log sheet."""

import os
import gspread
import google.auth

SHEET_ID = os.environ.get("SHEET_ID")

def get_sheets_client():
    credentials, _ = google.auth.default(
        scopes=["https://www.googleapis.com/auth/spreadsheets"]
    )
    return gspread.authorize(credentials)

def check_bounce_rate():
    if not SHEET_ID:
        print("Error: SHEET_ID environment variable not set")
        return

    try:
        gc = get_sheets_client()
        sheet = gc.open_by_key(SHEET_ID)
        log_ws = sheet.worksheet("Outreach_Log")

        rows = log_ws.get_all_values()
        if len(rows) <= 1:
            print("No data in Outreach_Log yet")
            return

        # Find column indices
        header = rows[0]
        status_idx = None
        for i, col in enumerate(header):
            if col.lower() == "status":
                status_idx = i
                break

        if status_idx is None:
            print("Error: Could not find 'status' column")
            return

        # Count statuses
        sent = 0
        hard_bounces = 0
        soft_bounces = 0
        failed = 0

        for row in rows[1:]:
            if len(row) > status_idx:
                status = row[status_idx].lower()
                if status == "sent":
                    sent += 1
                elif status in ["hard_bounce", "invalid_email"]:
                    hard_bounces += 1
                elif status == "soft_bounce":
                    soft_bounces += 1
                elif status == "send_failed":
                    failed += 1

        # Calculate bounce rate
        if sent == 0:
            print("No emails sent yet")
            return

        bounce_rate = (hard_bounces / sent) * 100

        print("=" * 50)
        print("📊 BOUNCE RATE REPORT")
        print("=" * 50)
        print(f"Total Sent:        {sent}")
        print(f"Hard Bounces:      {hard_bounces}")
        print(f"Soft Bounces:      {soft_bounces}")
        print(f"Failed:            {failed}")
        print(f"\nBounce Rate:       {bounce_rate:.1f}%")
        print(f"Threshold:         5.0%")

        if bounce_rate > 5:
            print(f"\n⚠️  WARNING: Bounce rate exceeds 5%!")
        else:
            print(f"\n✅ Healthy: Bounce rate within limits")
        print("=" * 50)

    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    check_bounce_rate()
