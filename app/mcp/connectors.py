"""Connector keys for external AI apps (ChatGPT, Claude Cowork). Keys are shown once and stored only as hashes."""
import datetime
import hashlib
import hmac
import secrets
import time
import uuid
from collections import defaultdict, deque

from ..agents import store

SCOPES = ("read", "propose")
MAX_TOKENS, MAX_CALLS_LOG, RATE_PER_MIN = 10, 200, 60
_hits = defaultdict(deque)


def _h(token):
    return hashlib.sha256(token.encode()).hexdigest()


def _now():
    return datetime.datetime.now(datetime.timezone.utc)


def _data():
    return store.load("connectors", {"tokens": [], "calls": []})


def create(label, scope="propose", share_details=False, days=90):
    label = (label or "").strip()[:60]
    if not label:
        return None, "label is required"
    if scope not in SCOPES:
        return None, "scope must be read or propose"
    days = max(1, min(365, int(days or 90)))
    token = "mcp_" + secrets.token_urlsafe(32)
    rec = {"id": uuid.uuid4().hex[:8], "label": label, "scope": scope, "share_details": bool(share_details), "hash": _h(token),
           "created": _now().strftime("%Y-%m-%d"), "expires": (_now() + datetime.timedelta(days=days)).strftime("%Y-%m-%d"), "last_used": "", "calls": 0}
    def go(d):
        if len(d["tokens"]) >= MAX_TOKENS:
            return None, f"limit of {MAX_TOKENS} connector keys; revoke one first"
        d["tokens"].append(rec)
        return rec, ""
    out, err = store.mutate("connectors", go, {"tokens": [], "calls": []})
    return ({**public(out), "token": token}, "") if out else (None, err)


def public(t):
    return {k: v for k, v in t.items() if k != "hash"}


def listing():
    d = _data()
    return [public(t) for t in d["tokens"]], list(reversed(d["calls"]))[:30]


def revoke(tid):
    def go(d):
        n = len(d["tokens"])
        d["tokens"] = [t for t in d["tokens"] if t["id"] != tid]
        return len(d["tokens"]) < n
    return store.mutate("connectors", go, {"tokens": [], "calls": []})


def verify(token):
    """The key's record if it is valid and unexpired, else None. Compares hashes in constant time."""
    if not token or not token.startswith("mcp_"):
        return None
    h = _h(token)
    for t in _data()["tokens"]:
        if hmac.compare_digest(t["hash"], h):
            return None if t["expires"] < _now().strftime("%Y-%m-%d") else t
    return None


def rate_ok(tid):
    q, now = _hits[tid], time.time()
    while q and now - q[0] > 60:
        q.popleft()
    if len(q) >= RATE_PER_MIN:
        return False
    q.append(now)
    return True


def record_call(t, tool, ok):
    def go(d):
        for x in d["tokens"]:
            if x["id"] == t["id"]:
                x["last_used"] = _now().strftime("%Y-%m-%d %H:%M UTC")
                x["calls"] += 1
        d["calls"].append({"time": _now().strftime("%Y-%m-%dT%H:%M:%SZ"), "key": t["label"], "tool": tool, "ok": ok})  # never the arguments or results
        d["calls"] = d["calls"][-MAX_CALLS_LOG:]
    store.mutate("connectors", go, {"tokens": [], "calls": []})
