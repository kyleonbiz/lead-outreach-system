"""App tests: Dashboard, Calendar plumbing, local mode, auth. No network."""
import csv as _csv
import datetime as _dt
import os
import re
import sys

import openpyxl
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["APP_API_KEY"] = "test-key-123456"
from app import dashboard, main, store  # noqa: E402

H = {"x-api-key": "test-key-123456"}
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@pytest.fixture(autouse=True)
def isolate(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", str(tmp_path))
    monkeypatch.delenv("LOCAL_DATA_PATH", raising=False)
    dashboard._cache.update(at=0, data=None)
    dashboard._tab_cache.clear()


# ---- auth + shape of the app ----
def test_api_requires_key():
    c = TestClient(main.app)
    assert c.get("/health").status_code == 200
    for path in ("/api/info", "/api/dashboard", "/api/calendar?month=2026-10"):
        assert c.get(path).status_code == 403, path
        assert c.get(path, headers={"x-api-key": "wrong"}).status_code == 403, path
    assert c.get("/api/info", headers=H).status_code == 200


def test_api_locked_when_no_key_configured(monkeypatch):
    monkeypatch.delenv("APP_API_KEY")
    assert TestClient(main.app).get("/api/info", headers=H).status_code == 403
    monkeypatch.setenv("APP_API_KEY", "test-key-123456")


def test_app_exposes_only_dashboard_and_calendar():
    paths = {r.path for r in main.app.routes}
    assert {"/", "/health", "/api/info", "/api/dashboard", "/api/calendar", "/api/calendar/events"} <= paths
    for gone in ("/status", "/api/records/{tab}", "/api/contacts", "/api/assistant", "/api/agents/state", "/api/ai-profile", "/mcp", "/api/proposals",
                 "/api/connectors", "/settings", "/sending/pause"):
        assert gone not in paths, gone
    assert not [p for p in paths if p.startswith("/jobs")]


def test_nothing_in_the_app_can_send_email_or_run_jobs():
    src = "".join(open(os.path.join(ROOT, "app", f)).read() for f in os.listdir(os.path.join(ROOT, "app")) if f.endswith(".py"))
    for banned in ("sendMail", "def send_email", "get_graph_token", "subprocess", "import requests", "graph.microsoft.com", "BackgroundScheduler"):
        assert banned not in src, banned


def test_app_shell_has_only_two_screens_and_no_external_resources():
    r = TestClient(main.app).get("/")
    assert r.status_code == 200 and "Aurum Outreach" in r.text
    assert "{i:'dash',t:'Dashboard',to:'/dashboard'}" in r.text and "{i:'cal',t:'Calendar',to:'/calendar'}" in r.text
    for gone in ("Contacts", "Assistant", "Approvals", "Settings", "Campaign queue", "/api/records", "/api/agents", "/api/assistant", "/mcp"):
        assert gone not in r.text, gone
    assert "<script src" not in r.text and "<link" not in r.text
    assert not re.search(r"""(src|href|action)=["']https?://""", r.text) and "fetch('http" not in r.text
    for old in ("/dashboard", "/calendar"):  # bookmarks still land on the right screen
        loc = TestClient(main.app).get(old, follow_redirects=False)
        assert loc.status_code in (302, 307) and loc.headers["location"] == f"/#{old}"


def test_cron_schedules_match_the_github_workflows():
    from app.jobs import SCHEDULES
    def crons(wf):
        return re.findall(r"cron: '([^']+)'", open(os.path.join(ROOT, ".github/workflows", wf)).read())
    assert SCHEDULES["send_outreach"] == crons("send-outreach-auto.yml")
    assert SCHEDULES["find_leads"] == crons("find-leads.yml")
    assert SCHEDULES["daily_summary"] == crons("daily-summary.yml")


# ---- dashboard ----
L_HEAD = ["lead_id", "business_name", "email", "city", "state", "outreach_status", "enrichment_status"]
LOGH = ["id", "lead", "biz", "recipient", "date", "subject", "template", "status"]


def sample(today="2026-10-11"):
    leads = [L_HEAD,
             ["1", "Secret Biz Inc", "private@secret.com", "A", "tn", "contacted", "enriched"],
             ["2", "B", "b@x.com", "A", "TN", "send_unknown", "enriched"],
             ["3", "C", "c@x.com", "B", "KY", "send_failed", "enriched"],
             ["4", "D", "", "B", "KY", "not_contactable", "no_email_found"],
             ["5", "E", "e@x.com", "B", "", "sending", "enriched"]]
    log = [LOGH,
           ["a", "1", "Secret Biz Inc", "private@secret.com", today, "s", "v", "sent"],
           ["b", "2", "B", "b@x.com", today, "s", "v", "unknown"],
           ["c", "3", "C", "c@x.com", today, "s", "v", "hard_bounce"],
           ["d", "4", "D", "d@x.com", "2026-10-09", "s", "v", "sent"],
           ["e", "5", "E", "e@x.com", today, "s", "v", "invalid_email"],
           ["f", "6", "F", "f@x.com", today, "s", "v", "sent_test"],
           ["g", "7", "G", "g@x.com", "2020-01-01", "s", "v", "sent"]]
    return leads, [L_HEAD], log


def test_dashboard_aggregates_correctly():
    leads, refs, log = sample()
    d = dashboard.build(leads, refs, log, "2026-10-11")
    assert d["kpis"]["total_leads"] == 5 and d["kpis"]["contacted"] == 1
    assert d["attention"] == {"unknown": 1, "pending": 1, "failed": 1}
    today = [x for x in d["sends_by_day"] if x["date"] == "2026-10-11"][0]
    assert (today["sent"], today["failed"], today["unknown"]) == (1, 1, 1)  # invalid_email / sent_test excluded
    assert len(d["sends_by_day"]) == 30 and d["send_totals"]["sent"] == 3  # all-time totals include old rows
    assert dict(d["top_states"])["TN"] == 2  # states normalised
    assert d["kpis"]["attempts_today"] == 3


def test_referrals_tab_with_different_layout_is_not_counted_as_leads():
    leads, _, log = sample()
    refs = [["Business", "Category", "Type", "Website", "Contact", "Why they could refer"],
            ["Acme CPA", "Accounting", "Firm", "x.com", "Pat", "clients need admin help"], ["", "", "", "", "", ""]]
    d = dashboard.build(leads, refs, log, "2026-10-11")
    assert d["kpis"]["total_leads"] == 5 and d["kpis"]["referral_partners"] == 1
    assert dict(d["outreach_status"]).get("unknown") is None  # referrals did not add an "unknown" status


def test_dashboard_output_has_no_personal_data():
    leads, refs, log = sample()
    blob = str(dashboard.build(leads, refs, log, "2026-10-11"))
    for secret in ("private@secret.com", "Secret Biz", "b@x.com"):
        assert secret not in blob


def test_dashboard_api_handles_sheet_failure(monkeypatch):
    c = TestClient(main.app)
    def boom(*a, **k):
        raise RuntimeError("secret detail")
    monkeypatch.setattr(dashboard, "fetch", boom)
    r = c.get("/api/dashboard", headers=H)
    assert r.status_code == 503 and "secret detail" not in r.text
    monkeypatch.setattr(dashboard, "fetch", lambda *a, **k: {"ok": 1})
    assert c.get("/api/dashboard", headers=H).json() == {"ok": 1}


# ---- local spreadsheet mode ----
import csv as _csv  # noqa: E402
import datetime as _dt  # noqa: E402

import openpyxl  # noqa: E402


def make_workbook(path):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Leads"
    ws.append(L_HEAD)
    ws.append([1, "Acme", "a@x.com", "Nashville", "TN", "contacted", "enriched"])
    ws.append([2, "Beta", None, "Austin", "TX", "not_contactable", "no_email_found"])
    ws2 = wb.create_sheet("Referrals")
    ws2.append(L_HEAD)
    log = wb.create_sheet("outreach_log")  # tab-name case must not matter
    log.append(LOGH)
    log.append(["a", "1", "Acme", "a@x.com", _dt.date.today(), "s", "v", "sent"])
    wb.create_sheet("Campaign_Queue").append(["industry", "location", "active"])
    wb.save(path)


def test_local_workbook_reads_and_dashboard_works(tmp_path, monkeypatch):
    p = tmp_path / "outreach.xlsx"
    make_workbook(p)
    before = p.read_bytes()
    monkeypatch.setenv("LOCAL_DATA_PATH", str(p))
    dashboard._cache.update(at=0, data=None)
    dashboard._tab_cache.clear()
    monkeypatch.setattr(dashboard.se, "get_sheets_with_retry", lambda: pytest.fail("must not touch Google"))
    c = TestClient(main.app)
    d = c.get("/api/dashboard", headers=H).json()
    assert d["kpis"]["total_leads"] == 2 and d["kpis"]["contacted"] == 1
    assert d["kpis"]["attempts_today"] == 1  # the Excel date cell was read as a date
    tab = dashboard.fetch_tab("leads")
    assert tab["header"][1] == "business_name" and tab["total"] == 2
    assert tab["rows"][0][3] == "Austin" and tab["rows"][0][2] == ""  # empty cell -> "", newest first
    assert p.read_bytes() == before  # never written to


def test_local_csv_folder(tmp_path, monkeypatch):
    for name, rows in {"Leads": [L_HEAD, ["1", "Acme", "a@x.com", "N", "TN", "new", "enriched"]],
                       "Referrals": [L_HEAD], "Outreach_Log": [LOGH], "Campaign_Queue": [["industry"]]}.items():
        with open(tmp_path / f"{name}.csv", "w", newline="") as f:
            _csv.writer(f).writerows(rows)
    monkeypatch.setenv("LOCAL_DATA_PATH", str(tmp_path))
    dashboard._cache.update(at=0, data=None)
    assert dashboard.fetch()["kpis"]["total_leads"] == 1


def test_missing_tab_gives_clean_error(tmp_path, monkeypatch):
    wb = openpyxl.Workbook()
    wb.active.title = "Other"
    wb.save(tmp_path / "w.xlsx")
    monkeypatch.setenv("LOCAL_DATA_PATH", str(tmp_path / "w.xlsx"))
    dashboard._cache.update(at=0, data=None)
    assert TestClient(main.app).get("/api/dashboard", headers=H).status_code == 503


def test_local_mode_is_reported_and_never_touches_google(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_DATA_PATH", str(tmp_path))
    monkeypatch.setattr(dashboard.se, "get_sheets_with_retry", lambda: pytest.fail("must not touch Google"))
    assert TestClient(main.app).get("/api/info", headers=H).json() == {"local_mode": True}
    main.startup()  # does not try to set up Google credentials


def test_daily_cap_follows_the_ramp_and_env_can_only_lower_it(monkeypatch):
    leads, refs, log = sample()  # one earlier send day, so the ramp is one step up
    ramp = dashboard.se.RAMP_START_CAP + dashboard.se.RAMP_STEP
    assert dashboard.build(leads, refs, log, "2026-10-11")["kpis"]["daily_cap"] == ramp
    monkeypatch.delenv("DAILY_SEND_CAP", raising=False)
    monkeypatch.setenv("DAILY_SEND_CAP", "40")
    assert dashboard.build(leads, refs, log, "2026-10-11")["kpis"]["daily_cap"] == 40
    monkeypatch.setenv("DAILY_SEND_CAP", "100000")
    assert dashboard.build(leads, refs, log, "2026-10-11")["kpis"]["daily_cap"] == ramp  # can lower the ramp, never raise it
