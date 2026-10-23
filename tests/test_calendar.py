"""Calendar tab: month data, follow-up due dates, cron run counts, events API. No network."""
import datetime as dt
import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["SCHEDULER_ENABLED"] = "false"
os.environ["APP_API_KEY"] = "test-key-123456"
from app import calendar_data as cd, dashboard, main, store  # noqa: E402
from app.jobs import SCHEDULES  # noqa: E402

H = {"x-api-key": "test-key-123456"}
TODAY = dt.date(2026, 10, 22)
LH = ["lead_id", "business_name", "email", "outreach_status", "date_contacted", "date_last_followup"]
GH = ["log_id", "lead_id", "business_name", "email", "date_sent", "subject", "template_used", "send_status"]


def tab(h, rows):
    return {"header": h, "rows": rows, "total": len(rows)}


def lead(i, status="contacted", contacted="2026-10-10", follow="", email=None):
    return [str(i), f"Biz{i}", email or f"secret{i}@private.example", status, contacted, follow]


def logrow(date, status):
    return ["x", "1", "B", "secret@private.example", date, "s", "v", status]


@pytest.fixture(autouse=True)
def iso(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", str(tmp_path))


def build(leads, log, month="2026-10", after=5, sched=None, events=()):
    return cd.build(tab(LH, leads), tab(GH, log), month, TODAY, after, sched or {}, list(events))


def test_month_ranges():
    assert cd.month_range("2026-02")[1] == dt.date(2026, 2, 28)
    assert cd.month_range("2028-02")[1] == dt.date(2028, 2, 29)
    assert cd.month_range("2026-12")[1] == dt.date(2026, 12, 31)
    assert cd.MONTH_RE.match("2026-10") and not cd.MONTH_RE.match("2026-13") and not cd.MONTH_RE.match("2026-1")


def test_sends_counted_per_day_and_month_filtered():
    log = [logrow("2026-10-05", "sent"), logrow("2026-10-05", "sent"), logrow("2026-10-05", "hard_bounce"), logrow("2026-10-05", "unknown"),
           logrow("2026-10-05", "sent_test"), logrow("2026-10-05", "invalid_email"), logrow("2026-09-30", "sent"), logrow("2026-11-01", "sent")]
    d = build([], log)["days"]
    assert d["2026-10-05"]["sent"] == 2 and d["2026-10-05"]["failed"] == 1 and d["2026-10-05"]["unknown"] == 1
    assert "2026-09-30" not in d and "2026-11-01" not in d  # other months excluded; test sends and invalid addresses ignored


def test_follow_up_due_dates_and_exclusions():
    leads = [lead(1, contacted="2026-10-10"), lead(2, contacted="2026-10-10"), lead(3, status="replied"), lead(4, follow="2026-10-15"),
             lead(5, status="send_unknown"), lead(6, contacted="2026-10-12"), lead(7, contacted="bad date"), lead(8, status="unsubscribed")]
    d = build(leads, [])["days"]
    assert d["2026-10-15"]["due_count"] == 2 and [x["id"] for x in d["2026-10-15"]["due"]] == ["1", "2"]  # contacted 10th + 5 days
    assert d["2026-10-17"]["due_count"] == 1
    assert sum(v["due_count"] for v in d.values()) == 3  # replied, followed-up, uncertain, bad-date and unsubscribed leads are not due
    assert build(leads, [], after=7)["days"]["2026-10-17"]["due_count"] == 2  # setting changes the due date
    assert "2026-10-15" not in build(leads, [], month="2026-11")["days"]


def test_due_names_are_capped_but_count_is_exact():
    leads = [lead(i) for i in range(100)]
    day = build(leads, [])["days"]["2026-10-15"]
    assert day["due_count"] == 100 and len(day["due"]) == cd.MAX_DUE_NAMES


def test_output_has_no_email_addresses():
    out = str(build([lead(1)], [logrow("2026-10-05", "sent")]))
    assert "secret" not in out and "private.example" not in out and "@" not in out


def test_cron_run_counts_match_real_calendar():
    # Oct 2026: 22 weekdays x 8 hourly runs (16-23 UTC), plus Tue-Sat 00-02 UTC: 23 days x 3 runs
    first, last = cd.month_range("2026-10")
    runs = cd.job_runs({"send_outreach": ["0 16-23 * * 1-5", "0 0-2 * * 2-6"]}, first, last)
    assert sum(v["send_outreach"] for v in runs.values()) == 22 * 8 + 23 * 3
    assert runs["2026-10-05"]["send_outreach"] == 8 + 0  # Monday: no early-morning window
    assert runs["2026-10-06"]["send_outreach"] == 8 + 3  # Tuesday
    assert "2026-10-03" in runs and runs["2026-10-03"]["send_outreach"] == 3  # Saturday: early window only
    assert cd.job_runs({"manual": []}, first, last) == {}


def test_real_job_schedules_produce_runs():
    d = build([], [], sched=SCHEDULES)["days"]
    assert d["2026-10-05"]["jobs"]["send_outreach"] >= 8


def test_events_filtered_to_month_and_sorted():
    ev = [{"id": "a", "date": "2026-10-20", "title": "B", "note": ""}, {"id": "b", "date": "2026-10-02", "title": "A", "note": ""}, {"id": "c", "date": "2026-11-02", "title": "C", "note": ""}]
    assert [e["id"] for e in build([], [], events=ev)["events"]] == ["b", "a"]


# ---------- API ----------
@pytest.fixture
def api(monkeypatch):
    t = {"leads": tab(LH, [lead(1)]), "log": tab(GH, [logrow("2026-10-05", "sent")])}
    monkeypatch.setattr(dashboard, "fetch_tab", lambda k, ttl=60: t[k])
    return TestClient(main.app)


def test_calendar_api_auth_and_validation(api):
    assert api.get("/api/calendar?month=2026-10").status_code == 403
    assert api.get("/api/calendar?month=2026-13", headers=H).status_code == 400
    assert api.get("/api/calendar?month=oct", headers=H).status_code == 400
    r = api.get("/api/calendar?month=2026-10&after_days=9999", headers=H).json()
    assert r["after_days"] == 60 and r["days"]["2026-10-05"]["sent"] == 1
    

def test_calendar_api_sheet_failure_is_clean(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("secret detail")
    monkeypatch.setattr(dashboard, "fetch_tab", boom)
    r = TestClient(main.app).get("/api/calendar?month=2026-10", headers=H)
    assert r.status_code == 503 and "secret detail" not in r.text


def test_event_crud_and_validation(api):
    assert api.post("/api/calendar/events", json={"date": "2026-10-20", "title": "x"}).status_code == 403
    for bad in [{"date": "2026-10-20", "title": ""}, {"date": "20-10-2026", "title": "x"}, {"date": "2026-02-31", "title": "x"},
                {"date": "2026-10-20", "title": "x" * 121}, {"date": "2026-10-20", "title": "x", "note": "n" * 501}]:
        assert api.post("/api/calendar/events", headers=H, json=bad).status_code in (400, 422), bad
    r = api.post("/api/calendar/events", headers=H, json={"date": "2026-10-20", "title": " Call Derrick ", "note": "re: renewals"})
    assert r.status_code == 200 and r.json()["title"] == "Call Derrick"
    got = api.get("/api/calendar?month=2026-10", headers=H).json()["events"]
    assert [e["title"] for e in got] == ["Call Derrick"]
    assert api.get("/api/calendar?month=2026-11", headers=H).json()["events"] == []
    assert api.delete("/api/calendar/events/zzz", headers=H).status_code == 404
    assert api.delete(f"/api/calendar/events/{r.json()['id']}").status_code == 403
    assert api.delete(f"/api/calendar/events/{r.json()['id']}", headers=H).status_code == 200
    assert api.get("/api/calendar?month=2026-10", headers=H).json()["events"] == []


def test_event_limit(api, monkeypatch):
    store.save("calendar", {"events": [{"id": str(i), "date": "2026-10-01", "title": "t", "note": ""} for i in range(500)]})
    assert api.post("/api/calendar/events", headers=H, json={"date": "2026-10-20", "title": "one too many"}).status_code == 400


def test_calendar_is_in_the_sidebar():
    html = TestClient(main.app).get("/").text
    assert "{i:'cal',t:'Calendar',to:'/calendar'}" in html


def test_cron_weekdays_follow_standard_cron_not_apscheduler_numbering():
    """The app's scheduler must fire on the same days as the GitHub workflow cron (1-5 = Mon-Fri)."""
    from app.jobs import trigger
    utc = dt.timezone.utc
    t = trigger("0 16-23 * * 1-5")
    fri_night = dt.datetime(2026, 10, 2, 23, 30, tzinfo=utc)  # Friday
    assert t.get_next_fire_time(None, fri_night).date() == dt.date(2026, 10, 5)  # next Monday, not Saturday
    assert trigger("0 0-2 * * 2-6").get_next_fire_time(None, fri_night).date() == dt.date(2026, 10, 3)  # Saturday early window
    assert trigger("0 18 * * 1-5").get_next_fire_time(None, dt.datetime(2026, 10, 3, 0, 0, tzinfo=utc)).weekday() == 0  # Mon
    assert trigger("0 13 * * 1").get_next_fire_time(None, dt.datetime(2026, 10, 3, 0, 0, tzinfo=utc)).weekday() == 0  # Mon
    assert trigger("0 12-22/2 * * 1-5").get_next_fire_time(None, dt.datetime(2026, 10, 3, 0, 0, tzinfo=utc)).hour == 12
    assert trigger("0 0 * * *").get_next_fire_time(None, fri_night).date() == dt.date(2026, 10, 3)  # daily
    assert trigger("0 9 * * 0").get_next_fire_time(None, fri_night).weekday() == 6  # cron 0 = Sunday
