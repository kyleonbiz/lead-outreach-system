"""Tools the in-app assistant can use. READ tools run immediately. WRITE tools never run on the model's say-so: the person
must approve the exact call first, and the server then runs the arguments it stored (not anything sent back by the browser).

Deliberately absent: sending an email directly, and starting the main outreach sender (use Settings for that)."""
import datetime
import json
import os
import threading
from dataclasses import dataclass, field
from typing import Callable, Optional

from .. import calendar_data, contacts, dashboard, profile, runner
from ..agents import followup, service, store
from ..jobs import JOBS

RESULT_LIMIT = 6000
RUNNABLE_JOBS = ("find_leads", "daily_summary", "organize_leads", "create_fb_posts", "send_followups")
AGENTS = ("followup", "research", "marketing")


class ToolError(Exception):
    pass


@dataclass
class Tool:
    name: str
    description: str
    schema: dict
    kind: str                      # "read" or "write"
    run: Callable
    describe: Callable             # args -> sentence shown to the person
    validate: Optional[Callable] = None   # args -> error string or ""
    warn: str = ""                 # extra warning on the approval card


def local_mode():
    return bool(os.environ.get("LOCAL_DATA_PATH", "").strip())


def _tabs():
    try:
        return dashboard.fetch_tab("leads"), dashboard.fetch_tab("referrals"), dashboard.fetch_tab("log")
    except Exception:
        raise ToolError("could not read the sheet")


def _manual():
    return store.load("contacts", {"manual": [], "notes": {}})["manual"]


def _contact(key):
    leads, refs, log = _tabs()
    return contacts.find(key, leads, refs, log, _manual(), store.suppressed_emails()), leads, refs, log


def _name(key):
    try:
        c = _contact(key)[0]
        return f"{c['n']} ({c['e']})" if c and c["e"] else (c["n"] if c else key)
    except ToolError:
        return key


def _obj(props, required=()):
    return {"type": "object", "properties": props, "required": list(required)}


S = {"type": "string"}


# ---------------- read tools ----------------
def search_contacts(a):
    leads, refs, log = _tabs()
    rows = contacts.directory(leads, refs, log, _manual(), store.suppressed_emails())
    q = str(a.get("query", "")).lower().strip()
    out = [c for c in rows if (not q or q in " ".join([c["n"], c["c"], c["e"], c["p"], c["l"], c["i"]]).lower())
           and (not a.get("type") or c["t"] == a["type"]) and (not a.get("status") or c["s"] == a["status"])
           and (a.get("has_email") is None or bool(c["e"]) == bool(a["has_email"]))
           and (a.get("do_not_contact") is None or c["d"] == bool(a["do_not_contact"]))]
    n = max(1, min(25, int(a.get("limit") or 10)))
    return {"total_matches": len(out), "showing": min(n, len(out)),
            "contacts": [{"key": c["k"], "name": c["n"], "contact_name": c["c"], "email": c["e"], "phone": c["p"], "location": c["l"],
                          "industry": c["i"], "status": c["s"], "type": c["t"], "last_email": c["a"], "emails_sent": c["m"],
                          "do_not_contact": c["d"]} for c in out[:n]]}


def get_contact(a):
    c, leads, refs, log = _contact(str(a.get("key", "")))
    if not c:
        raise ToolError("no such contact")
    notes = store.load("contacts", {"manual": [], "notes": {}})["notes"].get(c["k"], [])
    drafts = store.load("followups", {"drafts": []})["drafts"]
    return {"contact": c, "fields": contacts.fields_for(c["k"], leads, refs, _manual()),
            "timeline": contacts.timeline(c, c["k"], log, drafts, notes)[:20]}


def dashboard_summary(a):
    try:
        d = dashboard.fetch(runner.load_settings())
    except Exception:
        raise ToolError("could not read the sheet")
    return {"as_of": d["as_of"], "kpis": d["kpis"], "needs_attention": d["attention"], "leads_by_status": dict(d["outreach_status"][:10]),
            "send_totals_30_days": d["send_totals"]}


def list_followups(a):
    st = a.get("status") or "open"
    ds = store.load("followups", {"drafts": []})["drafts"]
    ds = [d for d in ds if st == "all" or (st == "open" and d["status"] in ("pending", "approved")) or d["status"] == st]
    return {"count": len(ds), "drafts": [{"id": d["id"], "business": d["business_name"], "email": d["email"], "status": d["status"],
                                           "subject": d["subject"], "body": d["body"][:600], "first_contacted": d["first_contacted"]} for d in ds[:15]]}


def calendar_month(a):
    month = str(a.get("month", ""))
    if not calendar_data.MONTH_RE.match(month):
        raise ToolError("month must look like 2026-10")
    try:
        leads, log = dashboard.fetch_tab("leads"), dashboard.fetch_tab("log")
    except Exception:
        raise ToolError("could not read the sheet")
    ev = store.load("calendar", {"events": []})["events"]
    d = calendar_data.build(leads, log, month, datetime.date.today(), 5, {}, ev)
    days = [{"date": k, "sent": v["sent"], "failed": v["failed"], "uncertain": v["unknown"], "follow_ups_due": v["due_count"]}
            for k, v in sorted(d["days"].items()) if v["sent"] or v["failed"] or v["unknown"] or v["due_count"]]
    return {"month": month, "days": days[:40], "events": d["events"]}


def status(a):
    return {"sending_paused": runner.sending_paused(), "caps": runner.load_settings(), "local_mode": local_mode(),
            "last_job_runs": {k: {"state": v.get("state"), "finished": v.get("finished", "")} for k, v in runner.last_runs.items()},
            "agent_runs": {k: v for k, v in service.runs.items()}, "today": datetime.date.today().isoformat()}


def business_profile(a):
    p = profile.get()
    return {"learning_mode_on": p["enabled"], "profile": p["profile"], "memories": [{"id": m["id"], "text": m["text"], "enabled": m["enabled"]} for m in p["memories"]]}


# ---------------- write tools ----------------
def v_remember(a):
    if not profile.get()["enabled"]:
        return "learning mode is off; the user can turn it on in Settings → AI learning"
    t = str(a.get("text", "")).strip()
    if not t or len(t) > profile.MAX_MEMORY_LEN:
        return f"memory must be 1-{profile.MAX_MEMORY_LEN} characters"
    return profile.check_text(t)


def r_remember(a):
    m, err = profile.add_memory(a["text"], a.get("category", "preferences"), "assistant")
    if err:
        raise ToolError(err)
    return {"remembered": m["text"]}


def v_contact_key(a):
    try:
        return "" if _contact(str(a.get("key", "")))[0] else "no such contact"
    except ToolError as e:
        return str(e)


def v_note(a):
    t = str(a.get("text", "")).strip()
    return "note text must be 1-1000 characters" if not t or len(t) > 1000 else v_contact_key(a)


def r_note(a):
    n, err = contacts.add_note(a["key"], a["text"])
    if err:
        raise ToolError(err)
    return {"added": True}


def r_contact(a):
    m, err = contacts.add_manual(a.get("name", ""), a.get("company", ""), a.get("email", ""), a.get("phone", ""), a.get("website", ""), a.get("notes", ""))
    if err:
        raise ToolError(err)
    return {"key": "man:" + m["id"]}


def v_contact_new(a):
    return "name is required" if not str(a.get("name", "")).strip() else ""


def v_event(a):
    try:
        datetime.date.fromisoformat(str(a.get("date", "")))
    except ValueError:
        return "date must be a real date like 2026-10-30"
    t = str(a.get("title", "")).strip()
    return "" if t and len(t) <= 120 else "title must be 1-120 characters"


def r_event(a):
    ev, err = calendar_data.add_event(a["date"], a["title"], a.get("note", ""))
    if err:
        raise ToolError(err)
    return {"added": True}


def v_dnc(a):
    err = v_contact_key(a)
    if err:
        return err
    c = _contact(a["key"])[0]
    return "" if c["e"] else "this contact has no email address to block"


def r_dnc(a):
    c = _contact(a["key"])[0]
    store.add_suppressed(c["e"])
    contacts.add_note(c["k"], "Marked do not contact (by the assistant, with approval).")
    return {"blocked": c["e"]}


def r_allow(a):
    c = _contact(a["key"])[0]
    store.remove_suppressed(c["e"])
    contacts.add_note(c["k"], "Removed from do not contact (by the assistant, with approval).")
    return {"allowed": c["e"]}


def _draft(a):
    return next((d for d in store.load("followups", {"drafts": []})["drafts"] if d["id"] == str(a.get("draft_id", ""))), None)


def v_draft(a):
    d = _draft(a)
    return "no such draft" if not d else ("" if d["status"] in ("pending", "approved") else f"that draft is already {d['status']}")


def r_approve(a):
    err = followup.approve(a["draft_id"], a.get("subject"), a.get("body"))
    if err:
        raise ToolError(err)
    return {"approved": a["draft_id"]}


def v_reject(a):
    return v_draft(a) or ("" if a.get("reason", "skip") in followup.REJECT_REASONS else "reason must be skip, replied or do_not_contact")


def r_reject(a):
    err = followup.reject(a["draft_id"], a.get("reason", "skip"))
    if err:
        raise ToolError(err)
    return {"rejected": a["draft_id"]}


def v_agent(a):
    if local_mode():
        return "agents are disabled in local mode"
    if not os.environ.get("ANTHROPIC_API_KEY", "").strip():
        return "ANTHROPIC_API_KEY is not set"
    return "" if a.get("name") in AGENTS else f"name must be one of {', '.join(AGENTS)}"


def r_agent(a):
    if not service.start(a["name"], int(a.get("after_days") or 5)):
        raise ToolError("that agent is already running")
    return {"started": a["name"]}


def v_job(a):
    if local_mode():
        return "jobs are disabled in local mode"
    if a.get("name") not in RUNNABLE_JOBS:
        return f"the assistant can only run: {', '.join(RUNNABLE_JOBS)}"
    return ""


def r_job(a):
    if a["name"] not in JOBS:
        raise ToolError("unknown job")
    threading.Thread(target=runner.run_job, args=(a["name"],), daemon=True).start()
    return {"started": a["name"]}


def r_pause(a):
    runner.set_sending_paused(True)
    return {"sending_paused": True}


def r_resume(a):
    runner.set_sending_paused(False)
    return {"sending_paused": False}


def v_caps(a):
    for k in ("daily_send_cap", "per_run_cap"):
        v = a.get(k)
        if v is not None and (not isinstance(v, int) or isinstance(v, bool) or not 0 <= v <= 300):
            return f"{k} must be a whole number from 0 to 300"
    return "" if a.get("daily_send_cap") is not None or a.get("per_run_cap") is not None else "give at least one cap"


def r_caps(a):
    return runner.save_settings(a.get("daily_send_cap"), a.get("per_run_cap"))


T = Tool
TOOLS = {t.name: t for t in [
    T("search_contacts", "Find contacts (leads, referral partners, people the user added). Returns up to 25 matches with keys.",
      _obj({"query": S, "type": {"type": "string", "enum": ["lead", "referral", "manual"]}, "status": S, "has_email": {"type": "boolean"},
            "do_not_contact": {"type": "boolean"}, "limit": {"type": "integer"}}), "read", search_contacts,
      lambda a: "Searched contacts" + (f" for “{a['query']}”" if a.get("query") else "")),
    T("get_contact", "Get one contact's full details and activity timeline by key (e.g. lead:1234).", _obj({"key": S}, ["key"]), "read", get_contact,
      lambda a: f"Looked up contact {a.get('key', '')}"),
    T("dashboard_summary", "Totals, today's sending vs cap, bounce rate, and items needing attention.", _obj({}), "read", dashboard_summary,
      lambda a: "Checked the dashboard"),
    T("list_followups", "List follow-up email drafts. status: open (default), pending, approved, sent, rejected, all.",
      _obj({"status": S}), "read", list_followups, lambda a: "Listed follow-up drafts"),
    T("calendar_month", "Sends and follow-ups due per day, plus the user's events, for a month (YYYY-MM).", _obj({"month": S}, ["month"]), "read",
      calendar_month, lambda a: f"Checked the calendar for {a.get('month', '')}"),
    T("get_status", "Whether sending is paused, the daily caps, and recent job/agent runs.", _obj({}), "read", status, lambda a: "Checked app status"),

    T("get_business_profile", "What the user has taught the AI about themselves and their business (profile and memories).", _obj({}), "read",
      business_profile, lambda a: "Checked what I know about your business"),
    T("add_note", "Add a note to a contact's timeline.", _obj({"key": S, "text": S}, ["key", "text"]), "write", r_note,
      lambda a: f"Add a note to {_name(a.get('key', ''))}: “{a.get('text', '')}”", v_note),
    T("add_contact", "Add a new contact (name required).", _obj({"name": S, "company": S, "email": S, "phone": S, "website": S, "notes": S}, ["name"]),
      "write", r_contact, lambda a: f"Add contact “{a.get('name', '')}”" + (f" ({a['email']})" if a.get("email") else ""), v_contact_new),
    T("add_calendar_event", "Add an event or reminder to the calendar.", _obj({"date": S, "title": S, "note": S}, ["date", "title"]), "write", r_event,
      lambda a: f"Add calendar event “{a.get('title', '')}” on {a.get('date', '')}", v_event),
    T("mark_do_not_contact", "Block a contact's email so no automated email is ever sent to them.", _obj({"key": S}, ["key"]), "write", r_dnc,
      lambda a: f"Mark {_name(a.get('key', ''))} as DO NOT CONTACT", v_dnc),
    T("allow_contact", "Remove a contact from the do-not-contact list.", _obj({"key": S}, ["key"]), "write", r_allow,
      lambda a: f"Allow contact again: {_name(a.get('key', ''))}", v_dnc),
    T("approve_followup", "Approve a follow-up draft (optionally with edited subject/body). It is only SENT later, when the follow-up send job runs.",
      _obj({"draft_id": S, "subject": S, "body": S}, ["draft_id"]), "write", r_approve,
      lambda a: f"Approve follow-up draft {a.get('draft_id', '')}" + (" with your edits" if a.get("subject") or a.get("body") else ""), v_draft,
      "Approving does not send anything by itself."),
    T("reject_followup", "Reject a follow-up draft. reason: skip, replied, or do_not_contact (the last two also block the address).",
      _obj({"draft_id": S, "reason": S}, ["draft_id"]), "write", r_reject,
      lambda a: f"Reject follow-up draft {a.get('draft_id', '')} ({a.get('reason', 'skip')})", v_reject),
    T("run_agent", "Run an AI agent now: followup (draft follow-ups), research (market research), or marketing (posts and SEO ideas). Uses the AI service.",
      _obj({"name": {"type": "string", "enum": list(AGENTS)}, "after_days": {"type": "integer"}}, ["name"]), "write", r_agent,
      lambda a: f"Run the {a.get('name', '')} agent", v_agent, "This uses the AI service and may take a minute."),
    T("run_job", "Start a background job: find_leads, daily_summary, organize_leads, create_fb_posts, or send_followups (sends approved follow-ups). "
      "The main outreach sender cannot be started from here.", _obj({"name": {"type": "string", "enum": list(RUNNABLE_JOBS)}}, ["name"]), "write", r_job,
      lambda a: f"Start the “{str(a.get('name', '')).replace('_', ' ')}” job", v_job,
      "SENDS EMAIL: every approved follow-up gets one send attempt, within your daily cap. Failed ones are never retried." ),
    T("remember", "Save one durable fact or preference about the user or their business (category: business, customers, style, rules, preferences). "
      "Never save contact details, secrets, or facts about individual leads.", _obj({"text": S, "category": S}, ["text"]), "write", r_remember,
      lambda a: f"Remember: “{a.get('text', '')}”", v_remember),
    T("pause_sending", "Pause all automated email sending.", _obj({}), "write", r_pause, lambda a: "Pause email sending"),
    T("resume_sending", "Resume automated email sending.", _obj({}), "write", r_resume, lambda a: "Resume email sending"),
    T("set_sending_caps", "Set daily and/or per-run sending caps (0-300). Caps can only lower the built-in ramp.",
      _obj({"daily_send_cap": {"type": "integer"}, "per_run_cap": {"type": "integer"}}), "write", r_caps,
      lambda a: "Set sending caps: " + ", ".join(f"{k.replace('_', ' ')} = {v}" for k, v in a.items() if v is not None), v_caps),
]}


def specs():
    return [{"name": t.name, "description": t.description, "input_schema": t.schema} for t in TOOLS.values()]


def result_text(obj):
    s = json.dumps(obj, default=str)
    return s if len(s) <= RESULT_LIMIT else s[:RESULT_LIMIT] + '..."(truncated)"'
