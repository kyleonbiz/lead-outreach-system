"""Hosted service: scheduler + a small authenticated control API. No UI, no dashboards.

Run exactly ONE instance. Sending safety relies on a single scheduler and the one-attempt
state kept in Google Sheets (see send_emails.py).
"""
import hmac
import json
import logging
import os
import stat
import threading

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from . import dashboard, runner
from .jobs import JOBS

logging.basicConfig(level=logging.INFO)
app = FastAPI(title="Aurum outreach service")
scheduler = BackgroundScheduler(timezone="UTC")  # in-memory store: missed runs are never replayed


def setup_google_credentials():
    """Accept the service-account key as GOOGLE_SERVICE_ACCOUNT_JSON (written to a private file)."""
    raw = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if raw and not os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
        json.loads(raw)  # fail fast on bad input
        os.makedirs(runner.DATA_DIR, exist_ok=True)
        path = os.path.join(runner.DATA_DIR, "sa.json")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, stat.S_IRUSR | stat.S_IWUSR)
        with os.fdopen(fd, "w") as f:
            f.write(raw)
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = path


def require_key(x_api_key: str = Header(default="")):
    expected = os.environ.get("APP_API_KEY", "")
    if not expected or not hmac.compare_digest(x_api_key.encode(), expected.encode()):
        raise HTTPException(status_code=403, detail="forbidden")


def add_schedules():
    for job in JOBS.values():
        for i, cron in enumerate(job.crons):
            scheduler.add_job(
                runner.run_job, CronTrigger.from_crontab(cron, timezone="UTC"), args=[job.name],
                id=f"{job.name}-{i}", max_instances=1, coalesce=True, misfire_grace_time=300,
                replace_existing=True,
            )  # no retry/rescheduling on failure


@app.on_event("startup")
def startup():
    setup_google_credentials()
    if os.environ.get("SCHEDULER_ENABLED", "true").lower() == "true":
        add_schedules()
        scheduler.start()


@app.on_event("shutdown")
def shutdown():
    if scheduler.running:
        scheduler.shutdown(wait=False)


class Settings(BaseModel):
    daily_send_cap: Optional[int] = Field(default=None, ge=0, le=300)
    per_run_cap: Optional[int] = Field(default=None, ge=0, le=300)


@app.get("/")
def panel():
    return FileResponse(os.path.join(os.path.dirname(__file__), "panel.html"))


@app.get("/dashboard")
def dashboard_page():
    return FileResponse(os.path.join(os.path.dirname(__file__), "dashboard.html"))


@app.get("/api/dashboard", dependencies=[Depends(require_key)])
def dashboard_data():
    try:
        return dashboard.fetch(runner.load_settings())
    except Exception as e:  # sheet unreachable, missing tab, bad credentials
        logging.getLogger("dashboard").warning("dashboard fetch failed: %s", type(e).__name__)
        raise HTTPException(503, "could not read the sheet")


@app.get("/settings", dependencies=[Depends(require_key)])
def get_settings():
    return runner.load_settings()


@app.put("/settings", dependencies=[Depends(require_key)])
def put_settings(s: Settings):
    return runner.save_settings(s.daily_send_cap, s.per_run_cap)


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/status", dependencies=[Depends(require_key)])
def status():
    return {"sending_paused": runner.sending_paused(), "jobs": runner.last_runs, "settings": runner.load_settings(),
            "schedules": {j.name: list(j.crons) for j in JOBS.values()}}


@app.post("/jobs/{name}/run", dependencies=[Depends(require_key)])
def run_now(name: str):
    """Manual run in the background. Sender safety still applies (state in Sheets, lock, pause flag)."""
    if name not in JOBS:
        raise HTTPException(404, "unknown job")
    threading.Thread(target=runner.run_job, args=(name,), daemon=True).start()
    return {"accepted": name}


@app.post("/sending/pause", dependencies=[Depends(require_key)])
def pause():
    runner.set_sending_paused(True)
    return {"sending_paused": True}


@app.post("/sending/resume", dependencies=[Depends(require_key)])
def resume():
    runner.set_sending_paused(False)
    return {"sending_paused": False}
