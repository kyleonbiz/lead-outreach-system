"""Hosted service: scheduler + a small authenticated control API. No UI, no dashboards.

Run exactly ONE instance. Sending safety relies on a single scheduler and the one-attempt
state kept in Google Sheets (see send_emails.py).
"""
import datetime
import hmac
import json
import logging
import os
import stat
import threading
import uuid

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel, Field

from . import calendar_data, contacts, dashboard, runner
from .agents import followup, research as _research, service, store as agent_store
from .jobs import JOBS, trigger

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
                runner.run_job, trigger(cron), args=[job.name],
                id=f"{job.name}-{i}", max_instances=1, coalesce=True, misfire_grace_time=300,
                replace_existing=True,
            )  # no retry/rescheduling on failure


def local_mode():
    """Local-spreadsheet mode: read-only dashboard, no scheduler, no jobs, so nothing can send email."""
    return bool(os.environ.get("LOCAL_DATA_PATH", "").strip())


@app.on_event("startup")
def startup():
    if local_mode():
        return
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
def app_shell():
    return FileResponse(os.path.join(os.path.dirname(__file__), "app.html"))


@app.get("/dashboard")
def dashboard_page():
    return RedirectResponse("/#/dashboard")


@app.get("/agents")
def agents_page():
    return RedirectResponse("/#/followups")


@app.get("/api/dashboard", dependencies=[Depends(require_key)])
def dashboard_data():
    try:
        return dashboard.fetch(runner.load_settings())
    except Exception as e:  # sheet unreachable, missing tab, bad credentials
        logging.getLogger("dashboard").warning("dashboard fetch failed: %s", type(e).__name__)
        raise HTTPException(503, "could not read the sheet")


@app.get("/api/records/{tab}", dependencies=[Depends(require_key)])
def records(tab: str):
    if tab not in dashboard.TABS:
        raise HTTPException(404, "unknown tab")
    try:
        return dashboard.fetch_tab(tab)
    except Exception as e:
        logging.getLogger("dashboard").warning("records fetch failed: %s", type(e).__name__)
        raise HTTPException(503, "could not read the sheet")


class DraftEdit(BaseModel):
    subject: Optional[str] = None
    body: Optional[str] = None


class Reject(BaseModel):
    reason: str = "skip"


class AgentRun(BaseModel):
    after_days: int = Field(default=5, ge=1, le=60)


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
    events = agent_store.load("calendar", {"events": []})["events"]
    schedules = {j.name: list(j.crons) for j in JOBS.values() if j.crons}
    return calendar_data.build(leads, log, month, datetime.date.today(), after_days, schedules, events)


@app.post("/api/calendar/events", dependencies=[Depends(require_key)])
def calendar_event_add(e: NewEvent):
    try:
        datetime.date.fromisoformat(e.date)
    except ValueError:
        raise HTTPException(400, "not a real date")
    def go(d):
        if len(d["events"]) >= 500:
            return None
        ev = {"id": uuid.uuid4().hex[:8], "date": e.date, "title": e.title.strip(), "note": e.note.strip()}
        d["events"].append(ev)
        return ev
    ev = agent_store.mutate("calendar", go, {"events": []})
    if ev is None:
        raise HTTPException(400, "limit of 500 events")
    return ev


@app.delete("/api/calendar/events/{event_id}", dependencies=[Depends(require_key)])
def calendar_event_delete(event_id: str):
    def go(d):
        n = len(d["events"])
        d["events"] = [x for x in d["events"] if x["id"] != event_id]
        return len(d["events"]) < n
    if not agent_store.mutate("calendar", go, {"events": []}):
        raise HTTPException(404, "no such event")
    return {"ok": True}


class NewContact(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    company: str = Field(default="", max_length=120)
    email: str = Field(default="", max_length=200)
    phone: str = Field(default="", max_length=40)
    website: str = Field(default="", max_length=200)
    notes: str = Field(default="", max_length=1000)


class NewNote(BaseModel):
    text: str = Field(min_length=1, max_length=1000)


def _contact_tabs():
    try:
        return dashboard.fetch_tab("leads"), dashboard.fetch_tab("referrals"), dashboard.fetch_tab("log")
    except Exception as e:
        logging.getLogger("contacts").warning("contacts fetch failed: %s", type(e).__name__)
        raise HTTPException(503, "could not read the sheet")


def _contact_or_404(key):
    leads, refs, log = _contact_tabs()
    manual = agent_store.load("contacts", {"manual": [], "notes": {}})["manual"]
    c = contacts.find(key, leads, refs, log, manual, agent_store.suppressed_emails())
    if not c:
        raise HTTPException(404, "no such contact")
    return c, leads, refs, log, manual


@app.get("/api/contacts", dependencies=[Depends(require_key)])
def contacts_list():
    leads, refs, log = _contact_tabs()
    d = agent_store.load("contacts", {"manual": [], "notes": {}})
    rows = contacts.directory(leads, refs, log, d["manual"], agent_store.suppressed_emails())
    return {"contacts": rows, "total": len(rows)}


@app.get("/api/contacts/{key}", dependencies=[Depends(require_key)])
def contact_detail(key: str):
    c, leads, refs, log, manual = _contact_or_404(key)
    notes = agent_store.load("contacts", {"manual": [], "notes": {}})["notes"].get(key, [])
    drafts = agent_store.load("followups", {"drafts": []})["drafts"]
    return {"contact": c, "fields": contacts.fields_for(key, leads, refs, manual), "timeline": contacts.timeline(c, key, log, drafts, notes)}


@app.post("/api/contacts", dependencies=[Depends(require_key)])
def contact_add(c: NewContact):
    m, err = contacts.add_manual(c.name, c.company, c.email, c.phone, c.website, c.notes)
    if err:
        raise HTTPException(400, err)
    return {"key": "man:" + m["id"]}


@app.delete("/api/contacts/{key}", dependencies=[Depends(require_key)])
def contact_delete(key: str):
    if not key.startswith("man:") or not contacts.remove_manual(key[4:]):
        raise HTTPException(404, "only contacts you added yourself can be deleted")
    return {"ok": True}


@app.post("/api/contacts/{key}/notes", dependencies=[Depends(require_key)])
def contact_note_add(key: str, n: NewNote):
    _contact_or_404(key)
    note, err = contacts.add_note(key, n.text)
    if err:
        raise HTTPException(400, err)
    return note


@app.delete("/api/contacts/{key}/notes/{note_id}", dependencies=[Depends(require_key)])
def contact_note_delete(key: str, note_id: str):
    if not contacts.delete_note(key, note_id):
        raise HTTPException(404, "no such note")
    return {"ok": True}


@app.post("/api/contacts/{key}/do-not-contact", dependencies=[Depends(require_key)])
def contact_dnc(key: str):
    c = _contact_or_404(key)[0]
    if not c["e"]:
        raise HTTPException(400, "this contact has no email address to block")
    agent_store.add_suppressed(c["e"])  # the main sender and follow-up agent both honor this list
    contacts.add_note(key, "Marked do not contact.")
    return {"ok": True}


@app.post("/api/contacts/{key}/allow", dependencies=[Depends(require_key)])
def contact_allow(key: str):
    c = _contact_or_404(key)[0]
    if not c["e"]:
        raise HTTPException(400, "this contact has no email address")
    agent_store.remove_suppressed(c["e"])
    contacts.add_note(key, "Removed from do not contact.")
    return {"ok": True}


@app.get("/api/agents/state", dependencies=[Depends(require_key)])
def agents_state():
    return {"local_mode": local_mode(), "runs": service.runs,
            "drafts": agent_store.load("followups", {"drafts": []})["drafts"][::-1],
            "research": agent_store.load("research", None), "marketing": agent_store.load("marketing", None),
            "anthropic_key_set": bool(os.environ.get("ANTHROPIC_API_KEY", "").strip())}


@app.post("/api/agents/{name}/run", dependencies=[Depends(require_key)])
def agent_run(name: str, p: AgentRun = AgentRun()):
    if name not in ("followup", "research", "marketing"):
        raise HTTPException(404, "unknown agent")
    if not os.environ.get("ANTHROPIC_API_KEY", "").strip():
        raise HTTPException(409, "ANTHROPIC_API_KEY is not set")
    if not service.start(name, p.after_days):
        raise HTTPException(409, "already running")
    return {"started": name}


@app.post("/api/agents/followup/{draft_id}/approve", dependencies=[Depends(require_key)])
def draft_approve(draft_id: str, e: DraftEdit = DraftEdit()):
    err = followup.approve(draft_id, e.subject, e.body)
    if err:
        raise HTTPException(400 if err != "no such draft" else 404, err)
    return {"ok": True}


@app.post("/api/agents/followup/{draft_id}/reject", dependencies=[Depends(require_key)])
def draft_reject(draft_id: str, r: Reject = Reject()):
    err = followup.reject(draft_id, r.reason)
    if err:
        raise HTTPException(400 if err != "no such draft" else 404, err)
    return {"ok": True}


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
    return {"local_mode": local_mode(), "sending_paused": runner.sending_paused(), "jobs": runner.last_runs, "settings": runner.load_settings(),
            "schedules": {j.name: list(j.crons) for j in JOBS.values()}}


@app.post("/jobs/{name}/run", dependencies=[Depends(require_key)])
def run_now(name: str):
    """Manual run in the background. Sender safety still applies (state in Sheets, lock, pause flag)."""
    if name not in JOBS:
        raise HTTPException(404, "unknown job")
    if local_mode():
        raise HTTPException(409, "jobs are disabled in local mode")
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
