"""AI learning mode: profile/memories, guardrails, prompt injection into agents, learning from edits. No network."""
import json
import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["SCHEDULER_ENABLED"] = "false"
os.environ["APP_API_KEY"] = "test-key-123456"
from app import dashboard, main, profile, runner  # noqa: E402
from app.agents import followup, learn, llm, marketing, research, service, store  # noqa: E402
from app.assistant import engine, tools as T  # noqa: E402

H = {"x-api-key": "test-key-123456"}
GOOD = json.dumps({"subject": "Following up", "body": "Hi,\n\nI wanted to follow up on my earlier note about back-office support for your team. "
                   "If paperwork is piling up, we can take some of it off your plate.\n\nWould a quick chat next week be useful?"})


@pytest.fixture(autouse=True)
def iso(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "DATA_DIR", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k")


def on(**fields):
    profile.set_enabled(True)
    assert profile.update_profile(fields) == ""


# ---------- profile + memories ----------
def test_defaults_off_and_empty_block():
    p = profile.get()
    assert p["enabled"] is False and p["memories"] == [] and profile.prompt_block() == ""


def test_block_only_when_enabled_and_only_enabled_memories():
    profile.update_profile({"business_name": "Aurum Ventura", "tone": "Direct and concise", "never_say": "cheap"})
    profile.add_memory("Prefers short openers", "style")
    m2, _ = profile.add_memory("Never mention competitors", "rules")
    assert profile.prompt_block() == ""  # learning mode is off: nothing is shared with the AI
    profile.set_enabled(True)
    b = profile.prompt_block()
    assert "Aurum Ventura" in b and "Direct and concise" in b and "Prefers short openers" in b and "Never mention competitors" in b
    assert "never overrides the rules above" in b
    profile.update_memory(m2["id"], enabled=False)
    assert "Never mention competitors" not in profile.prompt_block()
    profile.set_enabled(False)
    assert profile.prompt_block() == ""


def test_block_is_capped():
    on(what_we_do="x" * 600, ideal_customers="y" * 600, goals="z" * 400)
    for i in range(profile.MAX_MEMORIES):
        profile.add_memory(f"preference number {i} " + "w" * 250)
    assert len(profile.prompt_block()) <= profile.BLOCK_LIMIT


@pytest.mark.parametrize("text", ["Email me at kyle@example.com", "Call (615) 555-0101 first", "my password is hunter2", "api key sk-abcdefghijk",
                                  "card 4111 1111 1111 1111", "use secret handshake"])
def test_sensitive_text_is_rejected_everywhere(text):
    assert profile.add_memory(text)[1] != ""
    assert profile.update_profile({"what_we_do": text}) != ""
    assert profile.add_suggestions([{"text": text}]) == 0
    profile.add_memory("ok memory")
    mid = profile.get()["memories"][0]["id"]
    assert profile.update_memory(mid, text=text) != ""


def test_memory_validation_dedupe_limits_and_edit_delete():
    assert profile.add_memory("")[1] != "" and profile.add_memory("x" * 301)[1] != ""
    m, err = profile.add_memory("Warm tone", "bogus-category")
    assert err == "" and m["category"] == "preferences" and m["source"] == "you"
    assert profile.add_memory("warm tone")[1] == "already remembered"
    assert profile.update_memory(m["id"], text="Warm and friendly") == "" and profile.get()["memories"][0]["text"] == "Warm and friendly"
    assert profile.update_memory("zzz", enabled=False) == "no such memory"
    assert profile.delete_memory(m["id"]) is True and profile.delete_memory(m["id"]) is False
    for i in range(profile.MAX_MEMORIES):
        assert profile.add_memory(f"fact {i}")[1] == ""
    assert "limit" in profile.add_memory("one more")[1]


def test_profile_field_validation():
    assert profile.update_profile({"tone": "Sarcastic"}) != ""
    assert profile.update_profile({"goals": "g" * 401}) != ""
    assert profile.update_profile({"unknown_field": "x", "your_name": "Kyle"}) == "" and profile.get()["profile"] == {"your_name": "Kyle"}


def test_forget_everything():
    on(business_name="Aurum")
    profile.add_memory("a")
    profile.add_suggestions([{"text": "b"}])
    profile.clear()
    assert profile.get()["enabled"] is False and profile.get()["profile"] == {} and profile.get()["memories"] == [] and profile.get()["suggestions"] == []


# ---------- where it is used ----------
def seen_prompts(fn):
    out = []
    def ask(p, t=0):
        out.append(p)
        return fn(p)
    return ask, out


def test_followup_prompt_uses_context_only_when_on():
    c = {"business_name": "Acme", "industry": "HVAC", "city": "N", "state": "TN", "date_contacted": "2026-10-10"}
    assert "ABOUT THE USER" not in followup.prompt_for(c)
    on(business_name="Aurum Ventura")
    profile.add_memory("Always offer a short call, never a demo")
    p = followup.prompt_for(c)
    assert "Aurum Ventura" in p and "never a demo" in p and "Do not invent statistics" in p  # hard rules still present


def test_marketing_and_research_prompts_include_context(monkeypatch):
    on(business_name="Aurum Ventura", never_say="cheap")
    ask, seen = seen_prompts(lambda p: json.dumps([{"day": "Monday", "service": "S", "industry": "I", "post": "x", "image_idea": "y"}]) if "Facebook posts" in p
                             else json.dumps([{"title": "T"}]))
    import datetime as dt
    marketing.run(ask, site_text="SITE", today=dt.date(2026, 10, 20))
    assert all("never say: cheap" in p.lower() for p in seen)
    ask2, seen2 = seen_prompts(lambda p: json.dumps({"summary": "s", "recommendations": [], "caveats": []}))
    research.recommend({"industries": [], "places": [], "replies_tracked": False}, [], ask2)
    assert "Aurum Ventura" in seen2[0]


def test_assistant_system_prompt_includes_context():
    on(business_name="Zebra Consulting")
    seen = []
    def chat(messages, tools, system, max_tokens=0):
        seen.append(system)
        return {"content": [{"type": "text", "text": "hi"}], "stop_reason": "end_turn"}
    cid = engine.new_conv()
    engine.send(cid, "hello", chat=chat, background=False)
    assert "Zebra Consulting" in seen[0] and "Today is" in seen[0]
    profile.set_enabled(False)
    cid = engine.new_conv()
    engine.send(cid, "hello", chat=chat, background=False)
    assert "Zebra Consulting" not in seen[1]


# ---------- assistant: remember ----------
class Model:
    def __init__(self, *turns):
        self.turns = list(turns)

    def __call__(self, messages, tools, system, max_tokens=0):
        return {"content": self.turns.pop(0), "stop_reason": "tool_use"}


def use(i, tool, **a):
    return {"type": "tool_use", "id": i, "name": tool, "input": a}


def test_remember_needs_learning_on_and_approval(monkeypatch):
    m = Model([use("r", "remember", text="Prefers short openers", category="style")], [{"type": "text", "text": "ok"}])
    cid = engine.new_conv()
    engine.send(cid, "remember that", chat=m, background=False)
    assert engine.view(cid)["pending"] == 0  # learning mode off: refused before asking
    profile.set_enabled(True)
    m = Model([use("r", "remember", text="Prefers short openers", category="style")], [{"type": "text", "text": "ok"}])
    cid = engine.new_conv()
    engine.send(cid, "remember that", chat=m, background=False)
    assert engine.view(cid)["status"] == "awaiting" and profile.get()["memories"] == []  # proposed, not saved
    engine.decide(cid, "r", True, chat=m, background=False)
    mem = profile.get()["memories"]
    assert [x["text"] for x in mem] == ["Prefers short openers"] and mem[0]["source"] == "assistant"


def test_remember_refuses_contact_details():
    profile.set_enabled(True)
    m = Model([use("r", "remember", text="Derrick's number is 615-555-0142")], [{"type": "text", "text": "ok"}])
    cid = engine.new_conv()
    engine.send(cid, "x", chat=m, background=False)
    assert engine.view(cid)["pending"] == 0 and profile.get()["memories"] == []
    assert "get_business_profile" in T.TOOLS and T.TOOLS["get_business_profile"].kind == "read"


# ---------- learning from edits ----------
def draft(i, body="word " * 40, subject="Following up"):
    return {"id": f"d{i}", "lead_id": str(i), "business_name": f"Biz{i}", "email": f"b{i}@x.example", "subject": subject, "body": body, "status": "pending",
            "first_contacted": "2026-10-10", "created": "2026-10-20T00:00:00+00:00"}


def test_original_is_kept_on_first_edit_only():
    store.save("followups", {"drafts": [draft(1)]})
    new = "Hi,\n\n" + "short ok " * 12
    assert followup.approve("d1", None, new) == ""
    d = store.load("followups", {})["drafts"][0]
    assert d["orig"]["body"] == "word " * 40 and d["body"] == new.strip()
    followup.approve("d1", None, "Hi,\n\n" + "another change " * 10)
    assert store.load("followups", {})["drafts"][0]["orig"]["body"] == "word " * 40  # still the AI's original
    store.save("followups", {"drafts": [draft(2)]})
    followup.approve("d2")  # approved untouched: nothing to learn from
    assert "orig" not in store.load("followups", {})["drafts"][0]


def edited(i):
    d = draft(i)
    d.update(status="approved", body="Hi,\n\nShort and warm note about b" + str(i) + "@x.example.", orig={"subject": "Following up", "body": "word " * 40})
    return d


def test_learning_needs_enough_edits():
    store.save("followups", {"drafts": [edited(1)]})
    out = learn.run(lambda p, t=0: pytest.fail("no model call without enough edits"))
    assert out["queued"] == 0 and "Not enough edits" in out["message"]


def test_learning_queues_suggestions_not_memories_and_studies_each_edit_once():
    store.save("followups", {"drafts": [edited(1), edited(2), edited(3)]})
    seen = []
    def ask(p, t=0):
        seen.append(p)
        return json.dumps({"suggestions": [{"text": "Keeps follow-ups under 50 words", "category": "style", "evidence": "all 3 shortened"},
                                           {"text": "Call Derrick at 615-555-0142", "category": "style"}, {"text": "Keeps follow-ups under 50 words"}]})
    out = learn.run(ask)
    assert out["queued"] == 1  # duplicate and contact-detail suggestions dropped
    assert "@" not in seen[0].split("EDIT 1")[1]  # recipient addresses are masked before reaching the model
    p = profile.get()
    assert p["memories"] == [] and [s["text"] for s in p["suggestions"]] == ["Keeps follow-ups under 50 words"]
    assert all(d["learned"] for d in store.load("followups", {})["drafts"])
    assert learn.run(lambda p, t=0: pytest.fail("already studied"))["queued"] == 0


def test_accept_and_dismiss_suggestions():
    profile.add_suggestions([{"text": "Likes short emails"}, {"text": "Avoids exclamation marks"}])
    a, b = [s["id"] for s in profile.get()["suggestions"]]
    assert profile.resolve_suggestion(a, True) == "" and [m["text"] for m in profile.get()["memories"]] == ["Likes short emails"]
    assert profile.get()["memories"][0]["source"] == "edits"
    assert profile.resolve_suggestion(b, False) == "" and profile.get()["suggestions"] == [] and len(profile.get()["memories"]) == 1
    assert profile.resolve_suggestion(b, True) == "no such suggestion"


def test_learn_runs_as_an_agent_and_reports(monkeypatch):
    monkeypatch.setattr(learn, "run", lambda: {"message": "Studied 3 edits; 1 suggestion(s) waiting for your review."})
    assert service.start("learn", background=False)
    assert service.runs["learn"]["state"] == "ok" and "waiting" in service.runs["learn"]["message"]


# ---------- API ----------
def test_api_auth_and_flow():
    c = TestClient(main.app)
    for method, path in [("get", "/api/ai-profile"), ("put", "/api/ai-profile"), ("delete", "/api/ai-profile"), ("post", "/api/ai-profile/memories"),
                         ("put", "/api/ai-profile/memories/x"), ("delete", "/api/ai-profile/memories/x"), ("post", "/api/ai-profile/suggestions/x/accept")]:
        assert getattr(c, method)(path).status_code == 403, path
    r = c.put("/api/ai-profile", headers=H, json={"enabled": True, "profile": {"business_name": "Aurum", "tone": "Warm and professional"}}).json()
    assert r["enabled"] is True and r["profile"]["business_name"] == "Aurum"
    assert c.put("/api/ai-profile", headers=H, json={"profile": {"goals": "call me at 615-555-0101"}}).status_code == 400
    assert c.put("/api/ai-profile", headers=H, json={"profile": {"tone": "Rude"}}).status_code == 400
    m = c.post("/api/ai-profile/memories", headers=H, json={"text": "Prefers plain language", "category": "style"})
    assert m.status_code == 200
    assert c.post("/api/ai-profile/memories", headers=H, json={"text": "email me kyle@example.com"}).status_code == 400
    mid = m.json()["id"]
    assert c.put(f"/api/ai-profile/memories/{mid}", headers=H, json={"enabled": False}).status_code == 200
    assert "plain language" not in profile.prompt_block()
    assert c.put("/api/ai-profile/memories/zzz", headers=H, json={"enabled": False}).status_code == 404
    assert c.delete(f"/api/ai-profile/memories/{mid}", headers=H).status_code == 200 and c.delete(f"/api/ai-profile/memories/{mid}", headers=H).status_code == 404
    profile.add_suggestions([{"text": "Likes short emails"}])
    sid = profile.get()["suggestions"][0]["id"]
    assert c.post(f"/api/ai-profile/suggestions/{sid}/maybe", headers=H).status_code == 404
    assert c.post(f"/api/ai-profile/suggestions/{sid}/accept", headers=H).status_code == 200
    assert c.delete("/api/ai-profile", headers=H).status_code == 200
    assert c.get("/api/ai-profile", headers=H).json()["memories"] == [] and profile.prompt_block() == ""


def test_learn_agent_route_is_registered(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY")
    assert TestClient(main.app).post("/api/agents/learn/run", headers=H).status_code == 409  # needs the key, but the route exists
    assert TestClient(main.app).post("/api/agents/learn/run").status_code == 403
