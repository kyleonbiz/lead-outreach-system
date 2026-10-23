"""Open the dashboard on your own computer, reading your local spreadsheets. Nothing is sent, nothing leaves your machine.

    python run_local.py path/to/your_workbook.xlsx
    python run_local.py path/to/folder_with_csvs

Then open http://127.0.0.1:8000/dashboard and sign in with the key "local".
"""
import os
import sys

if len(sys.argv) != 2:
    raise SystemExit(__doc__)
path = os.path.abspath(sys.argv[1])
if not os.path.exists(path):
    raise SystemExit(f"Not found: {path}")
os.environ["LOCAL_DATA_PATH"] = path
os.environ.setdefault("APP_API_KEY", "local")

import uvicorn  # noqa: E402

print("\nDashboard: http://127.0.0.1:8000/dashboard   (key: %s)\nReading: %s\nRead-only. No email is sent in this mode.\n" % (os.environ["APP_API_KEY"], path))
uvicorn.run("app.main:app", host="127.0.0.1", port=8000, log_level="warning")
