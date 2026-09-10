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
    ws = sheet.worksheet("Industries")

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

        last_run = get("Last Run").strip()
        industry = get("Industry").strip()

        candidates.append((last_run, row_num, industry))

    if not candidates:
        raise SystemExit("No active industries in Industries tab.")

    # Sort by last_run (nulls first, then oldest first)
    candidates.sort(key=lambda c: (c[0] != "", c[0]))

    last_run, row_num, industry = candidates[0]

    # Update last_run timestamp
    now = datetime.datetime.utcnow().isoformat()
    last_run_col = col["Last Run"] + 1
    ws.update_cell(row_num, last_run_col, now)

    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with open(github_output, "a") as f:
            f.write(f"industry={industry}\n")

    print(f"Selected industry: {industry}")
