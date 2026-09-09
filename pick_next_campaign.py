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
    ws = sheet.worksheet("Cities")

    rows = ws.get_all_values()
    header = rows[0]
    col = {name: i for i, name in enumerate(header)}

    candidates = []
    for row_num, row in enumerate(rows[1:], start=2):
        def get(field):
            idx = col.get(field)
            return row[idx] if idx is not None and idx < len(row) else ""

        status = get("Status").strip().upper()
        if status != "ACTIVE":
            continue

        priority_str = get("Priority").strip()
        last_run = get("Last Run").strip()
        city = get("City").strip()
        state = get("State").strip()
        
        # Convert priority to int for proper sorting
        try:
            priority = int(priority_str)
        except (ValueError, TypeError):
            priority = 999

        candidates.append((priority, last_run, row_num, city, state))

    if not candidates:
        raise SystemExit("No active cities in Cities tab.")

    # Sort by priority (ascending), then by last_run (nulls first, then oldest)
    candidates.sort(key=lambda c: (c[1] != "", c[0], c[1]))

    priority, last_run, row_num, city, state = candidates[0]

    # Update last_run timestamp
    now = datetime.datetime.utcnow().isoformat()
    last_run_col = col["Last Run"] + 1
    ws.update_cell(row_num, last_run_col, now)

    # Output city and state for location
    location = f"{city}, {state}"
    industry = "Accountants"

    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with open(github_output, "a") as f:
            f.write(f"industry={industry}\n")
            f.write(f"location={location}\n")

    print(f"Selected campaign: {industry} in {location}")
