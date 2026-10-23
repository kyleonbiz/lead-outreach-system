"""Aurum Outreach: a read-mostly web app with two screens, Dashboard and Calendar.

It reads your Google Sheet (or a local workbook in local mode). It does not send email and does not run jobs.
Calendar events you add are the only thing it stores itself."""
import datetime
import hmac
import json
import logging
import os
import stat

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel, Field

from . import calendar_data, dashboard, store
from .jobs import SCHEDULES

logging.basicConfig(level=logging.INFO)
app = FastAPI(title="Aurum Outreach")


def local_mode():
    """Local-spreadsheet mode: reads a workbook or CSV folder on this computer instead of Google Sheets."""
    return bool(os.environ.get("LOCAL_DATA_PATH", "").strip())


def setup_google_credentials():
    """Accept the service-account key as GOOGLE_SERVICE_ACCOUNT_JSON (written to a private file)."""
    raw = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if raw and not os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
        json.loads(raw)  # fail fast on bad input
        os.makedirs(store.DATA_DIR, exist_ok=True)
        path = os.path.join(store.DATA_DIR, "sa.json")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, stat.S_IRUSR | stat.S_IWUSR)
        with os.fdopen(fd, "w") as f:
            f.write(raw)
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = path


@app.on_event("startup")
def startup():
    if not local_mode():
        setup_google_credentials()


def require_key(x_api_key: str = Header(default="")):
    expected = os.environ.get("APP_API_KEY", "")
    if not expected or not hmac.compare_digest(x_api_key.encode(), expected.encode()):
        raise HTTPException(status_code=403, detail="forbidden")


@app.get("/")
def app_shell():
    return FileResponse(os.path.join(os.path.dirname(__file__), "app.html"))


@app.get("/dashboard")
def dashboard_page():
    return RedirectResponse("/#/dashboard")


@app.get("/calendar")
def calendar_page():
    return RedirectResponse("/#/calendar")


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/api/info", dependencies=[Depends(require_key)])
def info():
    return {"local_mode": local_mode()}


@app.get("/api/dashboard", dependencies=[Depends(require_key)])
def dashboard_data():
    try:
        return dashboard.fetch()
    except Exception as e:  # sheet unreachable, missing tab, bad credentials
        logging.getLogger("dashboard").warning("dashboard fetch failed: %s", type(e).__name__)
        raise HTTPException(503, "could not read the sheet")


class NewEvent(BaseModel):
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    title: str = Field(min_length=1, max_length=120)
    note: str = Field(default="", max_length=500)


@app.get("/api/calendar", dependencies=[Depends(require_key)])
def calendar_month(month: str, after_days: int = 5):
    if not calendar_data.MONTH_RE.match(month):
        raise HTTPException(400, "month must look like 2026-10")
    after_days = max(1, min(60, after_days))
    try:
        leads, log = dashboard.fetch_tab("leads"), dashboard.fetch_tab("log")
    except Exception as e:
        logging.getLogger("calendar").warning("calendar fetch failed: %s", type(e).__name__)
        raise HTTPException(503, "could not read the sheet")
    events = store.load("calendar", {"events": []})["events"]
    return calendar_data.build(leads, log, month, datetime.date.today(), after_days, SCHEDULES, events)


@app.post("/api/calendar/events", dependencies=[Depends(require_key)])
def calendar_event_add(e: NewEvent):
    ev, err = calendar_data.add_event(e.date, e.title, e.note)
    if err:
        raise HTTPException(400, err)
    return ev


@app.delete("/api/calendar/events/{event_id}", dependencies=[Depends(require_key)])
def calendar_event_delete(event_id: str):
    def go(d):
        n = len(d["events"])
        d["events"] = [x for x in d["events"] if x["id"] != event_id]
        return len(d["events"]) < n
    if not store.mutate("calendar", go, {"events": []}):
        raise HTTPException(404, "no such event")
    return {"ok": True}
