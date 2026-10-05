#!/usr/bin/env python3
"""Organize leads by industry into separate sheets."""

import os
import gspread
import google.auth
from collections import defaultdict

SHEET_ID = os.environ.get("SHEET_ID")

def get_sheets_client():
    credentials, _ = google.auth.default(
        scopes=["https://www.googleapis.com/auth/spreadsheets"]
    )
    return gspread.authorize(credentials)

def organize_by_industry():
    if not SHEET_ID:
        print("Error: SHEET_ID environment variable not set")
        return

    try:
        gc = get_sheets_client()
        sheet = gc.open_by_key(SHEET_ID)
        leads_ws = sheet.worksheet("Leads")

        # Read all data
        rows = leads_ws.get_all_values()
        if len(rows) <= 1:
            print("No data in Leads sheet")
            return

        # Get header and find industry column
        header = rows[0]
        industry_idx = None
        for i, col in enumerate(header):
            if col.lower() == "industry":
                industry_idx = i
                break

        if industry_idx is None:
            print("Error: Could not find 'industry' column")
            return

        # Group by industry
        industries = defaultdict(list)
        industries["All Leads"] = [header]  # Start with header

        for row in rows[1:]:
            if len(row) > industry_idx:
                industry = row[industry_idx].strip()
                if industry:
                    if industry not in industries:
                        industries[industry] = [header]
                    industries[industry].append(row)

        print(f"Found {len(industries) - 1} industries")
        print("\nCreating/updating sheets...")

        # Get existing sheets to avoid recreating
        existing_sheets = {ws.title for ws in sheet.worksheets()}

        # Create/update sheet for each industry
        created_count = 0
        updated_count = 0

        for industry, data in sorted(industries.items()):
            sheet_name = industry[:31]  # Google Sheets limit is 31 chars
            count = len(data) - 1  # Exclude header

            try:
                if sheet_name in existing_sheets:
                    # Update existing sheet
                    ws = sheet.worksheet(sheet_name)
                    ws.clear()
                    ws.append_rows(data, value_input_option="USER_ENTERED")
                    print(f"  ✅ Updated '{sheet_name}' ({count} leads)")
                    updated_count += 1
                else:
                    # Create new sheet
                    ws = sheet.add_worksheet(title=sheet_name, rows=len(data), cols=len(header))
                    ws.append_rows(data, value_input_option="USER_ENTERED")
                    print(f"  ✨ Created '{sheet_name}' ({count} leads)")
                    created_count += 1
            except gspread.exceptions.APIError as e:
                print(f"  ❌ Error with '{sheet_name}': {e}")

        print("\n" + "=" * 50)
        print(f"Created: {created_count} sheets")
        print(f"Updated: {updated_count} sheets")
        print(f"Total industries: {len(industries) - 1}")
        print("=" * 50)
        print("\n✅ Organization complete!")
        print(f"\nEach industry now has its own tab with all relevant leads.")

    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    organize_by_industry()
