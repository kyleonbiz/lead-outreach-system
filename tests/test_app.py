"""App-layer tests. Job steps are mocked: no scripts run, nothing is sent."""
import os
import re
import sys
import threading

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["SCHEDULER_ENABLED"] = "false"
os.environ["APP_API_KEY"] = "test-key-123456"
from app import runner, main  # noqa: E402
from app.jobs import JOBS  # noqa: E402

H = {"x-api-key": "test-key-123456"}
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@pytest.fixture(autouse=True)
def isolate(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "DATA_DIR", str(tmp_path))
    runner.last_runs.clear()
    monkeypatch.setattr(runner, "_notify", lambda *a, **k: None)


def test_api_requires_key():
    c = TestClient(main.app)
    assert c.get("/health").status_code == 200
    assert c.get("/status").status_code == 403
    assert c.get("/status", headers={"x-api-key": "wrong"}).status_code == 403
    assert c.post("/jobs/send_outreach/run").status_code == 403
    assert c.get("/status", headers=H).status_code == 200


def test_api_locked_when_no_key_configured(monkeypatch):
    monkeypatch.delenv("APP_API_KEY")
    assert TestClient(main.app).get("/status", headers=H).status_code == 403


def test_unknown_job_404():
    assert TestClient(main.app).post("/jobs/nope/run", headers=H).status_code == 404


def test_failed_sender_job_runs_steps_once_no_retry(monkeypatch):
    calls = []
    monkeypatch.setattr(runner, "_run_steps", lambda job, env, cwd: calls.append(job.name) or 1)
    r = runner.run_job("send_outreach")
    assert r["state"] == "failed" and calls == ["send_outreach"]


def test_paused_sender_does_not_run(monkeypatch):
    calls = []
    monkeypatch.setattr(runner, "_run_steps", lambda *a: calls.append(1) or 0)
    c = TestClient(main.app)
    c.post("/sending/pause", headers=H)
    assert runner.run_job("send_outreach")["reason"] == "sending_paused"
    assert not calls
    assert runner.run_job("find_leads")["state"] == "ok"  # scraping unaffected by the pause
    c.post("/sending/resume", headers=H)
    assert runner.run_job("send_outreach")["state"] == "ok"


def test_overlapping_sender_runs_are_skipped(monkeypatch):
    started, release, calls = threading.Event(), threading.Event(), []
    def slow(job, env, cwd):
        calls.append(1)
        started.set()
        release.wait(5)
        return 0
    monkeypatch.setattr(runner, "_run_steps", slow)
    t = threading.Thread(target=runner.run_job, args=("send_outreach",))
    t.start()
    started.wait(5)
    assert runner.run_job("send_outreach")["reason"] == "already_running"
    release.set()
    t.join()
    assert len(calls) == 1


def test_sender_lock_file_blocks_other_process(monkeypatch):
    import fcntl
    os.makedirs(runner.DATA_DIR, exist_ok=True)
    fh = open(os.path.join(runner.DATA_DIR, "sender.lock"), "w")
    fcntl.flock(fh, fcntl.LOCK_EX)
    monkeypatch.setattr(runner, "_run_steps", lambda *a: pytest.fail("must not run"))
    assert runner.run_job("send_outreach")["reason"] == "another_sender_running"
    fh.close()


def test_scrapers_independent_of_sender_failure(monkeypatch):
    monkeypatch.setattr(runner, "_run_steps", lambda job, env, cwd: 1 if job.is_sender else 0)
    assert runner.run_job("send_outreach")["state"] == "failed"
    assert runner.run_job("find_leads")["state"] == "ok"


def test_status_has_no_log_output(monkeypatch):
    monkeypatch.setattr(runner, "_run_steps", lambda *a: 0)
    runner.run_job("daily_summary")
    body = TestClient(main.app).get("/status", headers=H).json()
    assert set(body["jobs"]["daily_summary"]) == {"state", "started", "finished", "exit_code"}


def test_secrets_scrubbed():
    env = {"MS_CLIENT_SECRET": "abcdef123456", "DISCORD_WEBHOOK_URL": "https://hook/xyz987", "PLAIN": "visible1"}
    out = runner.scrub("secret abcdef123456 hook https://hook/xyz987 plain visible1", env)
    assert "abcdef123456" not in out and "xyz987" not in out and "visible1" in out


def test_scheduler_config_has_no_replay_or_overlap():
    main.add_schedules()
    try:
        for j in main.scheduler.get_jobs():
            assert j.max_instances == 1 and j.coalesce and j.misfire_grace_time <= 300
    finally:
        main.scheduler.remove_all_jobs()


def test_schedules_match_workflows():
    def crons(wf):
        return re.findall(r"cron: '([^']+)'", open(os.path.join(ROOT, ".github/workflows", wf)).read())
    assert list(JOBS["send_outreach"].crons) == crons("send-outreach-auto.yml")
    assert list(JOBS["find_leads"].crons) == crons("find-leads.yml")
    assert list(JOBS["daily_summary"].crons) == crons("daily-summary.yml")


def test_all_job_scripts_exist():
    for j in JOBS.values():
        for s in j.steps:
            assert os.path.exists(os.path.join(ROOT, s.script)), s.script


def test_panel_served_and_has_no_external_scripts():
    r = TestClient(main.app).get("/")
    assert r.status_code == 200 and "Outreach Control Panel" in r.text
    assert "http://" not in r.text and "https://" not in r.text  # nothing loaded from outside


def test_settings_validated_and_applied_to_sender_only(monkeypatch):
    c = TestClient(main.app)
    assert c.put("/settings", json={"daily_send_cap": 40, "per_run_cap": 5}).status_code == 403
    assert c.put("/settings", headers=H, json={"daily_send_cap": 5000}).status_code == 422
    assert c.put("/settings", headers=H, json={"daily_send_cap": -1}).status_code == 422
    assert c.put("/settings", headers=H, json={"daily_send_cap": 40, "per_run_cap": 5}).json() == {"daily_send_cap": 40, "per_run_cap": 5}
    seen = {}
    monkeypatch.setattr(runner, "_run_steps", lambda job, env, cwd: seen.update({job.name: dict(env)}) or 0)
    runner.run_job("send_outreach")
    runner.run_job("find_leads")
    assert seen["send_outreach"]["DAILY_SEND_CAP"] == "40" and seen["send_outreach"]["PER_RUN_CAP"] == "5"
    assert seen["find_leads"].get("DAILY_SEND_CAP") != "40"
    assert c.put("/settings", headers=H, json={}).json() == {}  # blank = back to ramp
