import os
import datetime
import gspread
import google.auth

SHEET_ID = os.environ.get("SHEET_ID")


def get_client():
    credentials, _ = google.auth.default(
        scopes=["https://www.googleapis.com/auth/spreadsheets"]
    )
    return gspread.authorize(credentials)


if __name__ == "__main__":
    if not SHEET_ID:
        raise SystemExit("Set SHEET_ID first.")

    gc = get_client()
    sheet = gc.open_by_key(SHEET_ID)
    industries_ws = sheet.worksheet("Industries")
    cities_ws = sheet.worksheet("Cities")

    # Get next industry
    rows = industries_ws.get_all_values()
    header = rows[0]
    col = {name: i for i, name in enumerate(header)}

    industry_candidates = []
    for row_num, row in enumerate(rows[1:], start=2):
        def get(field):
            idx = col.get(field)
            return row[idx] if idx is not None and idx < len(row) else ""

        status = get("Status").strip().upper()
        if status != "ACTIVE":
            continue

        last_run = get("Last Run").strip()
        industry = get("Industry").strip()
        industry_candidates.append((last_run, row_num, industry))

    if not industry_candidates:
        raise SystemExit("No active industries in Industries tab.")

    industry_candidates.sort(key=lambda c: (c[0] != "", c[0]))
    industry_last_run, industry_row_num, industry = industry_candidates[0]

    # Get next city
    rows = cities_ws.get_all_values()
    header = rows[0]
    col = {name: i for i, name in enumerate(header)}

    city_candidates = []
    for row_num, row in enumerate(rows[1:], start=2):
        def get(field):
            idx = col.get(field)
            return row[idx] if idx is not None and idx < len(row) else ""

        status = get("Status").strip().upper()
        if status != "ACTIVE":
            continue

        last_run = get("Last Run").strip()
        city = get("City").strip()
        state = get("State").strip()
        city_candidates.append((last_run, row_num, city, state))

    if not city_candidates:
        raise SystemExit("No active cities in Cities tab.")

    city_candidates.sort(key=lambda c: (c[0] != "", c[0]))
    city_last_run, city_row_num, city, state = city_candidates[0]

    # Update timestamps
    now = datetime.datetime.utcnow().isoformat()
    
    industries_ws.update_cell(industry_row_num, col["Last Run"] + 1, now)
    cities_ws.update_cell(city_row_num, col["Last Run"] + 1, now)

    location = f"{city}, {state}"

    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with open(github_output, "a") as f:
            f.write(f"industry={industry}\n")
            f.write(f"location={location}\n")

    print(f"Selected: {industry} in {location}")
