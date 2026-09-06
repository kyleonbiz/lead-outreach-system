import os
import json
import uuid
import datetime
import gspread
import google.auth

SHEET_ID = os.environ.get("SHEET_ID")

def parse_city_state(address):
    parts = [p.strip() for p in (address or "").split(",")]
    city = state = ""
    if len(parts) >= 3:
        city = parts[-3]
        state_zip = parts[-2].split()
        if state_zip:
            state = state_zip[0]
    return city, state


def get_client():
    credentials, _ = google.auth.default(
        scopes=["https://www.googleapis.com/auth/spreadsheets"]
    )
    return gspread.authorize(credentials)


if __name__ == "__main__":
    if not SHEET_ID:
        raise SystemExit("Set SHEET_ID first.")

    with open("leads_enriched.json") as f:
        leads = json.load(f)

    gc = get_client()
    sheet = gc.open_by_key(SHEET_ID)
    worksheet = sheet.worksheet("Leads")

    existing_rows = worksheet.get_all_values()
    existing_place_ids = set()
    if existing_rows:
        header = existing_rows[0]
        if "place_id" in header:
            place_id_col = header.index("place_id")
            for row in existing_rows[1:]:
                if len(row) > place_id_col and row[place_id_col]:
                    existing_place_ids.add(row[place_id_col])

    today = datetime.date.today().isoformat()
    new_rows = []
    skipped = 0

    for lead in leads:
        place_id = lead.get("place_id", "")
        if place_id and place_id in existing_place_ids:
            skipped += 1
            continue

        city, state = parse_city_state(lead.get("address", ""))
        has_email = bool(lead.get("email"))

        row = [
            str(uuid.uuid4())[:8],
            lead.get("business_name", ""),
            lead.get("industry", ""),
            lead.get("address", ""),
            city,
            state,
            lead.get("phone", ""),
            lead.get("website", ""),
            lead.get("rating", ""),
            lead.get("email", ""),
            "",
            "Google Places",
            today,
            lead.get("enrichment_status", ""),
            "new" if has_email else "not_contactable",
            "",
            "",
            "",
            place_id,
        ]
        new_rows.append(row)
        if place_id:
            existing_place_ids.add(place_id)

    if new_rows:
        worksheet.append_rows(new_rows, value_input_option="USER_ENTERED")

    print(f"Added {len(new_rows)} new leads. Skipped {skipped} duplicates already in the sheet.")
