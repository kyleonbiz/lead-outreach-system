"""Agent tests: fake model replies, fake sheets, fake send. No network, no email."""
import datetime as dt
import json
import os
import sys

import pytest
import requests
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["SCHEDULER_ENABLED"] = "false"
os.environ["APP_API_KEY"] = "test-key-123456"
import app.mail_core as se  # noqa: E402
from app import main, runner  # noqa: E402
from app.agents import followup, llm, marketing, research, service, store  # noqa: E402
from fakes import FakeWS  # noqa: E402

H = {"x-api-key": "test-key-123456"}
TODAY = dt.date(2026, 10, 20)
LH = ["lead_id", "business_name", "industry", "city", "state", "email", "contact_name", "enrichment_status",
      "outreach_status", "date_contacted", "date_last_followup", "notes"]
LOGH = ["log_id", "lead_id", "business_name", "email", "date_sent", "subject", "template_used", "send_status", "opened", "replied", "unsubscribed"]


@pytest.fixture(autouse=True)
def iso(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(se.time, "sleep", lambda s: None)
    monkeypatch.setattr(followup.time, "sleep", lambda s: None)


def lead(i, **kw):
    d = dict(lead_id=str(i), business_name=f"Biz{i}", industry="HVAC", city="Nashville", state="TN", email=f"b{i}@x.com",
             contact_name="", enrichment_status="enriched", outreach_status="contacted", date_contacted="2026-10-10",
             date_last_followup="", notes="")
    d.update(kw)
    return [d[h] for h in LH]


def logrow(email, status="sent", template="v2_intro", replied="", unsub="", lid="1"):
    return ["x", lid, "B", email, "2026-10-10", "s", template, status, "", replied, unsub]


GOOD = json.dumps({"subject": "Following up", "body": "Hi,\n\nI wanted to follow up on my earlier note about back-office support for your team. "
                   "If paperwork is piling up, we can take some of it off your plate.\n\nWould a quick chat next week be useful?"})


def ask_ok(prompt, max_tokens=0):
    return GOOD


def cands(rows, log=None, **kw):
    return followup.candidates([LH] + rows, [LOGH] + (log or []), kw.get("emails", set()), kw.get("domains", set()), TODAY, 5,
                               kw.get("exclude", ()))


# ---------- follow-up eligibility ----------
def test_only_eligible_leads_are_candidates():
    rows = [lead(1), lead(2, date_contacted="2026-10-18"), lead(3, outreach_status="new"), lead(4, date_last_followup="2026-10-15"),
            lead(5, notes="please unsubscribe me"), lead(6), lead(7), lead(8), lead(9, email="not-an-email"), lead(10, date_contacted="")]
    log = [logrow("b6@x.com", "hard_bounce"), logrow("b7@x.com", replied="Yes"), logrow("b8@x.com", unsub="x")]
    assert [c["lead_id"] for c in cands(rows, log)] == ["1"]


def test_suppressed_and_existing_followup_excluded():
    assert cands([lead(1)], emails={"b1@x.com"}) == []
    assert cands([lead(1)], domains={"x.com"}) == []
    assert cands([lead(1)], exclude={"1"}) == []
    assert cands([lead(1)], log=[logrow("b1@x.com", template=followup.TEMPLATE)]) == []


def test_validate_rules():
    ok = json.loads(GOOD)
    assert followup.validate(ok["subject"], ok["body"]) == ""
    assert followup.validate("Re: hello", ok["body"])
    assert followup.validate("Hi", "too short")
    assert followup.validate("Hi", ok["body"] + " {business_name}")
    assert followup.validate("Hi", ok["body"] + " see https://evil.example/x")
    assert followup.validate("Hi", ok["body"] + " see https://aurumventura.net/contact") == ""


# ---------- scan / approve / reject ----------
def test_scan_drafts_pending_only_and_skips_bad_replies():
    n = {"i": 0}
    def ask(p, t=0):
        n["i"] += 1
        return "not json" if n["i"] == 1 else GOOD
    s = followup.scan([LH, lead(1), lead(2)], [LOGH], set(), set(), TODAY, ask=ask)
    assert s["drafted"] == 1 and s["failed_validation"] == 1
    d = store.load("followups", {})["drafts"]
    assert len(d) == 1 and d[0]["status"] == "pending"
    again = followup.scan([LH, lead(1), lead(2)], [LOGH], set(), set(), TODAY, ask=ask_ok)
    assert again["eligible"] == 1  # lead already drafted is not drafted twice


def test_scan_respects_pending_cap(monkeypatch):
    monkeypatch.setattr(followup, "MAX_PENDING", 2)
    s = followup.scan([LH] + [lead(i) for i in range(1, 6)], [LOGH], set(), set(), TODAY, ask=ask_ok)
    assert s["drafted"] == 2 and s["left_for_later"] == 3


def test_approve_reject_and_suppression_shared_with_sender(monkeypatch):
    followup.scan([LH, lead(1), lead(2), lead(3)], [LOGH], set(), set(), TODAY, ask=ask_ok)
    ids = [d["id"] for d in store.load("followups", {})["drafts"]]
    assert followup.approve(ids[0], "New subject", json.loads(GOOD)["body"]) == ""
    assert followup.approve(ids[0], "Re: bad") != ""
    assert followup.reject(ids[1], "replied") == ""
    assert followup.reject(ids[2], "nonsense") == "bad reason"
    assert followup.approve("nope") == "no such draft"
    assert store.suppressed_emails() == {"b2@x.com"}
    monkeypatch.setenv("SUPPRESSION_FILE", store.suppression_path())
    class NoTab:
        def worksheet(self, n):
            raise Exception("no tab")
    emails, _ = se.load_suppression(NoTab())  # the main sender honors addresses suppressed here
    assert "b2@x.com" in emails


# ---------- sending approved drafts ----------
class Calls:
    def __init__(self, outcomes):
        self.outcomes, self.sent = list(outcomes), []

    def __call__(self, token, to, subject, body, logo):
        self.sent.append(to)
        o = self.outcomes.pop(0)
        return {"sent": (se.OK, "sent", se.STATUS_SENT, 202), "bad": (se.PERMANENT, "hard_bounce", se.STATUS_FAILED, 400),
                "timeout": (se.UNCERTAIN, "unknown", se.STATUS_UNKNOWN, None),
                "throttle": (se.TEMPORARY, "failed", se.STATUS_FAILED, 429)}[o]


def approved(n=3):
    followup.scan([LH] + [lead(i) for i in range(1, n + 1)], [LOGH], set(), set(), TODAY, ask=ask_ok)
    for d in store.load("followups", {})["drafts"]:
        assert followup.approve(d["id"]) == ""


def send(leads_ws, log_ws, calls, cap=50):
    return followup.send_approved(leads_ws, log_ws, "tok", TODAY.isoformat(), cap, set(), set(), send=calls)


def statuses():
    return {d["lead_id"]: d["status"] for d in store.load("followups", {})["drafts"]}


def test_only_approved_are_sent_once_and_sheet_updated():
    approved(2)
    followup.scan([LH, lead(3)], [LOGH], set(), set(), TODAY, ask=ask_ok)  # a third stays pending
    L, LOG, c = FakeWS([LH, lead(1), lead(2), lead(3)]), FakeWS([LOGH]), Calls(["sent", "sent"])
    s = send(L, LOG, c)
    assert c.sent == ["b1@x.com", "b2@x.com"] and s["sent"] == 2
    assert statuses()["3"] == "pending"
    assert L.rows[1][10] == "2026-10-20" and L.rows[3][10] == ""  # date_last_followup only for sent
    assert [r[6] for r in LOG.rows[1:]] == [followup.TEMPLATE] * 2 and LOG.rows[1][15] == "followup"
    send(L, LOG, Calls([]))  # second run: nothing approved, nothing sent
    assert statuses()["1"] == "sent"


@pytest.mark.parametrize("outcome,final", [("bad", "failed"), ("timeout", "unknown")])
def test_failed_or_uncertain_followup_never_retried(outcome, final):
    approved(1)
    L, LOG, c = FakeWS([LH, lead(1)]), FakeWS([LOGH]), Calls([outcome])
    send(L, LOG, c)
    assert statuses()["1"] == final and L.rows[1][10] == ""
    c2 = Calls(["sent"])
    send(L, LOG, c2)                      # later scheduled/manual run
    assert c2.sent == []
    # a re-scan can never re-draft it: the failed/uncertain attempt in the log blocks it
    assert cands([lead(1)], LOG.rows[1:]) == []


def test_throttling_stops_followups():
    approved(3)
    c = Calls(["throttle"])
    s = send(FakeWS([LH, lead(1), lead(2), lead(3)]), FakeWS([LOGH]), c)
    assert len(c.sent) == 1 and s["stopped"] == se.TEMPORARY


def test_cap_enforced():
    approved(3)
    c = Calls(["sent", "sent", "sent"])
    s = send(FakeWS([LH, lead(1), lead(2), lead(3)]), FakeWS([LOGH]), c, cap=2)
    assert len(c.sent) == 2 and s["stopped"] == "cap_reached"


def test_recheck_before_send_blocks_late_replies_and_changes():
    approved(3)
    rows = [LH, lead(1, notes="remove me"), lead(2, email="changed@x.com"), lead(3)]
    c = Calls(["sent"])
    s = send(FakeWS(rows), FakeWS([LOGH]), c)
    assert c.sent == ["b3@x.com"] and s["skipped"] == 2
    assert statuses()["1"] == "skipped" and statuses()["2"] == "skipped"


def test_sending_state_persisted_before_network_call():
    approved(1)
    seen = []
    def peek(token, to, subject, body, logo):
        seen.append(statuses()["1"])
        raise KeyboardInterrupt  # runner killed mid-send
    with pytest.raises(KeyboardInterrupt):
        send(FakeWS([LH, lead(1)]), FakeWS([LOGH]), peek)
    assert seen == ["sending"]
    c = Calls(["sent"])
    send(FakeWS([LH, lead(1)]), FakeWS([LOGH]), c)  # restart
    assert c.sent == [] and statuses()["1"] == "sending"


def test_html_is_escaped_and_has_unsubscribe():
    h = followup.to_html("Hi <script>alert(1)</script>\n\nSecond & last")
    assert "<script>" not in h and "&amp;" in h and "UNSUBSCRIBE" in h


# ---------- research ----------
def test_research_stats_and_privacy():
    leads = [["lead_id", "industry", "city", "state", "email", "enrichment_status", "outreach_status"]]
    for i in range(20):
        leads.append([str(i), "HVAC", "Nashville", "TN", f"secret{i}@private.com" if i < 16 else "", "enriched" if i < 16 else "no_email_found", "contacted" if i < 10 else "new"])
    log = [LOGH] + [logrow(f"secret{i}@private.com", lid=str(i)) for i in range(8)] + [logrow("secret9@private.com", "hard_bounce", lid="9")]
    st = research.analyze(leads, log)
    h = st["industries"][0]
    assert (h["leads"], h["email_rate"], h["sent"], h["bounced"], h["enough_data"]) == (20, 80, 8, 1, True)
    assert st["replies_tracked"] is False
    seen = []
    def ask(p, t=0):
        seen.append(p)
        return json.dumps({"summary": "s", "recommendations": [{"industry": "HVAC", "location": "Franklin, TN", "reason": "r", "confidence": "low"}] * 12, "caveats": ["c"]})
    rep = research.run(leads, log, [["industry", "location"]], ask)
    assert "secret" not in seen[0] and "private.com" not in seen[0]  # no emails go to the model
    assert len(rep["advice"]["recommendations"]) == 8 and store.load("research", None)["advice"]["summary"] == "s"


# ---------- marketing ----------
def test_marketing_reuses_post_rules_and_saves(monkeypatch):
    prompts = []
    def ask(p, t=0):
        prompts.append(p)
        if "Facebook posts" in p:
            return json.dumps([{"day": "Monday", "service": "S", "industry": "I", "post": "Post text", "image_idea": "img"}])
        return json.dumps([{"title": "T", "audience": "A", "search_intent": "i", "suggested_keyword": "k", "outline": ["h"]}])
    r = marketing.run(ask, site_text="SITE FACTS", today=dt.date(2026, 10, 20))
    assert "Do not invent statistics" in prompts[0] and "SITE FACTS" in prompts[0] and "no search volumes" not in prompts[1]
    assert r["posts"][0]["post"] == "Post text" and r["seo"][0]["title"] == "T"
    assert store.load("marketing", None)["week_of"] == "2026-10-19"


# ---------- model client ----------
def test_llm_one_call_no_retry_and_no_body_leak(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-secret-key-value")
    calls = []
    class R:
        status_code, text = 529, "overloaded sk-secret-key-value"
        def json(self):
            return {}
    monkeypatch.setattr(llm.requests, "post", lambda *a, **k: calls.append(1) or R())
    with pytest.raises(llm.LLMError) as e:
        llm.ask("hi")
    assert len(calls) == 1 and "sk-secret" not in str(e.value)
    monkeypatch.setattr(llm.requests, "post", lambda *a, **k: (_ for _ in ()).throw(requests.ConnectTimeout("x")))
    with pytest.raises(llm.LLMError):
        llm.ask("hi")
    monkeypatch.delenv("ANTHROPIC_API_KEY")
    with pytest.raises(llm.LLMError):
        llm.ask("hi")


# ---------- API ----------
def test_api_auth_and_run_requires_key(monkeypatch):
    c = TestClient(main.app)
    assert c.get("/api/agents/state").status_code == 403
    assert c.post("/api/agents/followup/run").status_code == 403
    assert c.post("/api/agents/nope/run", headers=H).status_code == 404
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert c.post("/api/agents/research/run", headers=H).status_code == 409  # clear message, nothing started


def test_followup_agent_end_to_end_via_service(monkeypatch):
    class WS:
        def __init__(self, rows): self.rows = rows
        def get_all_values(self): return self.rows
    class Sheet:
        def worksheet(self, n):
            if n == "Leads":
                return WS([LH, lead(1)])
            if n == "Outreach_Log":
                return WS([LOGH])
            raise Exception("no such tab")
    monkeypatch.setattr(service.dashboard, "get_sheet", lambda: Sheet())
    monkeypatch.setattr(service.followup.llm, "ask", ask_ok)
    monkeypatch.setattr(followup, "scan", lambda *a, **k: _real_scan(*a, **{**k, "ask": ask_ok}))
    service.start("followup", 5, background=False)
    assert service.runs["followup"]["state"] == "ok" and "drafted 1" in service.runs["followup"]["message"]


_real_scan = followup.scan


def test_api_draft_endpoints_and_state():
    followup.scan([LH, lead(1), lead(2)], [LOGH], set(), set(), TODAY, ask=ask_ok)
    c = TestClient(main.app)
    d = c.get("/api/agents/state", headers=H).json()["drafts"]
    assert len(d) == 2 and d[0]["status"] == "pending"
    assert c.post(f"/api/agents/followup/{d[0]['id']}/approve", headers=H, json={"subject": "Re: no"}).status_code == 400
    assert c.post(f"/api/agents/followup/{d[0]['id']}/approve", headers=H, json={}).status_code == 200
    assert c.post(f"/api/agents/followup/{d[1]['id']}/reject", headers=H, json={"reason": "do_not_contact"}).status_code == 200
    assert c.post("/api/agents/followup/zzz/approve", headers=H, json={}).status_code == 404
    st = c.get("/api/agents/state", headers=H).json()
    assert sorted(x["status"] for x in st["drafts"]) == ["approved", "rejected"]


def test_followup_sending_job_is_manual_sender_and_blocked_in_local_mode(tmp_path, monkeypatch):
    from app.jobs import JOBS
    j = JOBS["send_followups"]
    assert j.is_sender and j.crons == ()  # never on a timer, shares the sender lock and pause switch
    monkeypatch.setenv("LOCAL_DATA_PATH", str(tmp_path))
    assert TestClient(main.app).post("/jobs/send_followups/run", headers=H).status_code == 409


def test_agent_service_runs_and_reports_failures(monkeypatch):
    monkeypatch.setattr(service, "_do", lambda n, d: (_ for _ in ()).throw(llm.LLMError("Claude API returned 529")))
    assert service.start("research", background=False)
    assert service.runs["research"]["state"] == "failed" and "529" in service.runs["research"]["message"]
    monkeypatch.setattr(service, "_do", lambda n, d: (_ for _ in ()).throw(RuntimeError("secret detail")))
    service.start("research", background=False)
    assert "secret detail" not in service.runs["research"]["message"]
    monkeypatch.setattr(service, "_do", lambda n, d: "ok msg")
    service.start("research", background=False)
    assert service.runs["research"] == {**service.runs["research"], "state": "ok", "message": "ok msg"}
