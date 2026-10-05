#!/usr/bin/env python3
"""Organize leads by industry into a separate Google Sheet."""

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

        # Read from existing sheet
        source_sheet = gc.open_by_key(SHEET_ID)
        leads_ws = source_sheet.worksheet("Leads")

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

        for row in rows[1:]:
            if len(row) > industry_idx:
                industry = row[industry_idx].strip()
                if industry:
                    if industry not in industries:
                        industries[industry] = [header]
                    industries[industry].append(row)

        print(f"Found {len(industries)} industries")
        print("\nCreating new Google Sheet...")

        # Create NEW sheet for organized leads
        new_sheet = gc.create("Leads by Industry")
        new_sheet.share(None, perm_type='anyone', role='writer')

        print(f"✅ Created new sheet: {new_sheet.url}")

        # Remove default sheet
        try:
            default_ws = new_sheet.sheet1
            new_sheet.del_worksheet(default_ws)
        except:
            pass

        print("\nAdding industry tabs...")
        created_count = 0

        # Create sheet for each industry
        for industry, data in sorted(industries.items()):
            sheet_name = industry[:31]  # Google Sheets limit is 31 chars
            count = len(data) - 1  # Exclude header

            try:
                ws = new_sheet.add_worksheet(title=sheet_name, rows=len(data) + 100, cols=len(header))
                ws.append_rows(data, value_input_option="USER_ENTERED")
                print(f"  ✨ '{sheet_name}' ({count} leads)")
                created_count += 1
            except gspread.exceptions.APIError as e:
                print(f"  ❌ Error with '{sheet_name}': {e}")

        print("\n" + "=" * 60)
        print(f"✅ NEW SHEET CREATED!")
        print("=" * 60)
        print(f"Industries: {len(industries)}")
        print(f"Total leads: {sum(len(data) - 1 for data in industries.values())}")
        print(f"\nSheet URL: {new_sheet.url}")
        print("\n✅ Share this link to sell the leads by industry!")
        print("=" * 60)

    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    organize_by_industry()
