"""Approvals inbox: changes an external AI wants to make. Nothing runs until the owner approves it inside the app."""
import datetime
import uuid

from ..assistant import tools as T
from ..agents import store

MAX_PENDING, EXPIRE_DAYS = 20, 7


def _now():
    return datetime.datetime.now(datetime.timezone.utc)


def _data():
    return store.load("proposals", {"items": []})


def _expire(d):
    cut = (_now() - datetime.timedelta(days=EXPIRE_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    for p in d["items"]:
        if p["status"] == "pending" and p["created"] < cut:
            p["status"] = "expired"


def create(tool, args, source):
    """Queue a proposal. Returns (proposal, error)."""
    t = T.TOOLS.get(tool)
    if not t or t.kind != "write":
        return None, "unknown tool"
    err = T.external_validate(tool, args) or (t.validate(args) if t.validate else "")
    if err:
        return None, err
    def go(d):
        _expire(d)
        if sum(1 for p in d["items"] if p["status"] == "pending") >= MAX_PENDING:
            return None, f"{MAX_PENDING} proposals are already waiting for approval; ask the owner to review them"
        p = {"id": uuid.uuid4().hex[:8], "tool": tool, "args": args, "description": t.describe(args), "warn": t.warn, "source": source,
             "created": _now().strftime("%Y-%m-%dT%H:%M:%SZ"), "status": "pending", "result": ""}
        d["items"].append(p)
        d["items"] = d["items"][-300:]
        return p, ""
    return store.mutate("proposals", go, {"items": []})


def listing(status=None):
    d = _data()
    items = [p for p in reversed(d["items"]) if not status or (p["status"] == "pending") == (status == "pending")]
    return [{k: v for k, v in p.items() if k != "args"} | {"args": p["args"]} for p in items][:100]


def status_of(pid):
    p = next((x for x in _data()["items"] if x["id"] == pid), None)
    return None if not p else {"id": p["id"], "status": p["status"], "result": p["result"]}


def _claim(pid, to):
    """Atomically move a pending proposal to `to`. Returns the proposal, or None if it was not pending (so it cannot run twice)."""
    def go(d):
        p = next((x for x in d["items"] if x["id"] == pid), None)
        if p and p["status"] == "pending":
            p["status"] = to
            return dict(p)
        return None
    return store.mutate("proposals", go, {"items": []})


def decide(pid, approve):
    """Approve (runs the stored call exactly once) or decline. Returns '' or an error."""
    p = _claim(pid, "running" if approve else "declined")
    if not p:
        return "nothing is waiting for that decision"
    if not approve:
        return ""
    err = T.external_validate(p["tool"], p["args"])  # re-validate with current data and rules
    ok, out = (False, err) if err else T.execute(p["tool"], p["args"])
    _set(pid, "executed" if ok else "failed", "Done." if ok else str(out)[:200])
    from ..assistant import engine
    engine._log({"time": _now().strftime("%Y-%m-%dT%H:%M:%SZ"), "tool": p["tool"], "description": f"[{p['source']}] {p['description']}", "ok": ok})
    return ""


def _set(pid, status, result):
    def go(d):
        for p in d["items"]:
            if p["id"] == pid:
                p["status"], p["result"] = status, result
    store.mutate("proposals", go, {"items": []})


def pending_count():
    d = _data()
    _expire(d)
    return sum(1 for p in d["items"] if p["status"] == "pending")
