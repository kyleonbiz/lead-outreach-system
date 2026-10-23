"""Contacts tab: directory over leads/referrals/manual, timeline, notes, do-not-contact. No network."""
import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["SCHEDULER_ENABLED"] = "false"
os.environ["APP_API_KEY"] = "test-key-123456"
from app import contacts as ct, dashboard, main, runner  # noqa: E402
from app.agents import store  # noqa: E402
import app.mail_core as mc  # noqa: E402

H = {"x-api-key": "test-key-123456"}
LH = ["lead_id", "business_name", "industry", "city", "state", "phone", "website", "email", "contact_name", "outreach_status", "date_contacted", "notes"]
RH = ["Business", "Category", "Type", "Website", "Contact", "Why they could refer"]
GH = ["log_id", "lead_id", "business_name", "email", "date_sent", "subject", "template_used", "send_status"]


def tab(h, rows):
    return {"header": h, "rows": rows, "total": len(rows)}


LEADS = [["1", "Acme Property Group", "Property Management", "Nashville", "TN", "(615) 555-0101", "https://acme.example", "Owner@Acme.example", "Dana", "contacted", "2026-10-10", "likes email"],
         ["2", "Beta Roofing", "Roofing", "Franklin", "TN", "", "", "", "", "not_contactable", "", ""]]
REFS = [["Cumberland CPA", "Accounting", "Firm", "https://cpa.example", "Pat", "Clients need admin help"], ["", "", "", "", "", ""]]
LOG = [["a", "1", "Acme Property Group", "owner@acme.example", "2026-10-10", "Acme + Administrative Support", "v2_intro", "sent"],
       ["b", "1", "Acme Property Group", "owner@acme.example", "2026-10-16", "Following up", "followup_v1", "sent"],
       ["c", "1", "Acme", "owner@acme.example", "2026-09-01", "[TEST] x", "v1", "sent_test"],
       ["d", "9", "Someone Else", "else@x.example", "2026-10-12", "Hello", "v2_intro", "sent"]]


@pytest.fixture(autouse=True)
def iso(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "DATA_DIR", str(tmp_path))


@pytest.fixture
def api(monkeypatch):
    t = {"leads": tab(LH, LEADS), "referrals": tab(RH, REFS), "log": tab(GH, LOG)}
    monkeypatch.setattr(dashboard, "fetch_tab", lambda k, ttl=60: t[k])
    return TestClient(main.app)


def dirs(manual=(), supp=()):
    return ct.directory(tab(LH, LEADS), tab(RH, REFS), tab(GH, LOG), list(manual), set(supp))


def test_directory_merges_sources_with_unique_stable_keys():
    d = dirs([{"id": "m1", "name": "Derrick", "company": "Holloway HVAC", "email": "d@h.example"}])
    assert [c["t"] for c in d] == ["lead", "lead", "referral", "manual"]  # blank referral row skipped
    assert len({c["k"] for c in d}) == len(d)
    assert [c["k"] for c in dirs()][:2] == ["lead:1", "lead:2"] and dirs()[2]["k"] == dirs()[2]["k"]  # referral key is stable across calls


def test_lead_activity_counts_sends_not_tests_and_uses_lowercase_email():
    c = dirs()[0]
    assert c["e"] == "owner@acme.example" and c["m"] == 2 and c["a"] == "2026-10-16"  # test send ignored
    assert c["l"] == "Nashville, TN" and c["s"] == "contacted"
    assert dirs()[1]["m"] == 0 and dirs()[1]["a"] == ""


def test_do_not_contact_flag_comes_from_suppression_list():
    assert dirs(supp={"owner@acme.example"})[0]["d"] is True and dirs()[0]["d"] is False


def test_timeline_joins_log_drafts_and_notes_newest_first():
    c = dirs()[0]
    tl = ct.timeline(c, "lead:1", tab(GH, LOG), [{"lead_id": "1", "status": "pending", "subject": "Draft subj", "created": "2026-10-20T10:00:00+00:00"}],
                     [{"id": "n1", "date": "2026-10-18", "text": "Called, left voicemail"}])
    assert [i["kind"] for i in tl] == ["followup", "note", "email", "email"]
    assert [i["date"] for i in tl] == ["2026-10-20", "2026-10-18", "2026-10-16", "2026-10-10"]
    assert all("[TEST]" not in i["text"] for i in tl) and all(i["text"] != "Hello" for i in tl)  # other contacts' emails excluded


def test_fields_for_each_kind():
    leads, refs = tab(LH, LEADS), tab(RH, REFS)
    assert ct.fields_for("lead:1", leads, refs, [])["notes"] == "likes email"
    assert "email" not in ct.fields_for("lead:2", leads, refs, [])  # empty columns omitted
    ref_key = dirs()[2]["k"]
    assert ct.fields_for(ref_key, leads, refs, [])["Contact"] == "Pat"
    assert ct.fields_for("man:m1", leads, refs, [{"id": "m1", "name": "D", "email": ""}]) == {"name": "D"}
    assert ct.fields_for("lead:999", leads, refs, []) == {}


# ---------- API ----------
def test_api_requires_key(api):
    for method, path in [("get", "/api/contacts"), ("get", "/api/contacts/lead:1"), ("post", "/api/contacts"), ("delete", "/api/contacts/man:x"),
                         ("post", "/api/contacts/lead:1/notes"), ("post", "/api/contacts/lead:1/do-not-contact"), ("post", "/api/contacts/lead:1/allow")]:
        assert getattr(api, method)(path).status_code == 403, path


def test_list_and_detail(api):
    r = api.get("/api/contacts", headers=H).json()
    assert r["total"] == 3 and r["contacts"][0]["n"] == "Acme Property Group"
    d = api.get("/api/contacts/lead:1", headers=H).json()
    assert d["contact"]["e"] == "owner@acme.example" and len(d["timeline"]) == 2 and d["fields"]["contact_name"] == "Dana"
    assert api.get("/api/contacts/lead:404", headers=H).status_code == 404
    assert api.get("/api/contacts/garbage", headers=H).status_code == 404


def test_manual_contacts_validation_dedupe_and_delete(api):
    assert api.post("/api/contacts", headers=H, json={"name": ""}).status_code == 422
    assert api.post("/api/contacts", headers=H, json={"name": "D", "email": "not-an-email"}).status_code == 400
    r = api.post("/api/contacts", headers=H, json={"name": "Derrick George", "company": "Holloway HVAC", "email": "D@Holloway.example", "phone": "615"})
    assert r.status_code == 200
    key = r.json()["key"]
    assert api.post("/api/contacts", headers=H, json={"name": "Dup", "email": "d@holloway.example"}).status_code == 400
    assert api.get("/api/contacts", headers=H).json()["total"] == 4
    assert api.get(f"/api/contacts/{key}", headers=H).json()["contact"]["n"] == "Holloway HVAC"
    assert api.delete("/api/contacts/lead:1", headers=H).status_code == 404  # sheet contacts cannot be deleted here
    assert api.delete(f"/api/contacts/{key}", headers=H).status_code == 200
    assert api.get(f"/api/contacts/{key}", headers=H).status_code == 404


def test_notes_crud_limits_and_unknown_contact(api):
    assert api.post("/api/contacts/lead:404/notes", headers=H, json={"text": "x"}).status_code == 404
    assert api.post("/api/contacts/lead:1/notes", headers=H, json={"text": "  "}).status_code in (400, 422)
    assert api.post("/api/contacts/lead:1/notes", headers=H, json={"text": "x" * 1001}).status_code == 422
    n = api.post("/api/contacts/lead:1/notes", headers=H, json={"text": " Spoke with Dana "}).json()
    tl = api.get("/api/contacts/lead:1", headers=H).json()["timeline"]
    assert tl[0]["kind"] == "note" and tl[0]["text"] == "Spoke with Dana"
    assert api.delete("/api/contacts/lead:1/notes/zzz", headers=H).status_code == 404
    assert api.delete(f"/api/contacts/lead:1/notes/{n['id']}", headers=H).status_code == 200
    store.save("contacts", {"manual": [], "notes": {"lead:1": [{"id": str(i), "date": "2026-10-01", "text": "t"} for i in range(ct.MAX_NOTES)]}})
    assert api.post("/api/contacts/lead:1/notes", headers=H, json={"text": "one more"}).status_code == 400


def test_do_not_contact_blocks_future_sends_and_can_be_undone(api, monkeypatch):
    assert api.post("/api/contacts/lead:1/do-not-contact", headers=H).status_code == 200
    assert store.suppressed_emails() == {"owner@acme.example"}
    assert api.get("/api/contacts", headers=H).json()["contacts"][0]["d"] is True
    assert api.get("/api/contacts/lead:1", headers=H).json()["timeline"][0]["text"] == "Marked do not contact."
    # the main sender reads the same file, so it will not email this person
    monkeypatch.setenv("SUPPRESSION_FILE", store.suppression_path())
    class NoTab:
        def worksheet(self, n):
            raise Exception("no tab")
    assert "owner@acme.example" in mc.load_suppression(NoTab())[0]
    assert api.post("/api/contacts/lead:1/allow", headers=H).status_code == 200
    assert store.suppressed_emails() == set()
    assert api.get("/api/contacts", headers=H).json()["contacts"][0]["d"] is False


def test_do_not_contact_needs_an_email(api):
    assert api.post("/api/contacts/lead:2/do-not-contact", headers=H).status_code == 400  # lead without an email
    assert api.post("/api/contacts/lead:2/allow", headers=H).status_code == 400
    assert store.suppressed_emails() == set()


def test_sheet_failure_is_clean(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("secret detail")
    monkeypatch.setattr(dashboard, "fetch_tab", boom)
    r = TestClient(main.app).get("/api/contacts", headers=H)
    assert r.status_code == 503 and "secret detail" not in r.text


def test_contacts_in_sidebar():
    assert "{i:'user',t:'Contacts',to:'/contacts'}" in TestClient(main.app).get("/").text
