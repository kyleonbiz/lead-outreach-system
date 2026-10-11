"""Tests for send_emails.py. No network, no real email: requests.post and DNS are mocked."""
import ast
import glob
import os
import sys

import pytest
import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("SENDER_EMAIL", "sender@example.test")
import send_emails as se  # noqa: E402

HEADER = ["lead_id", "business_name", "email", "city", "state", "outreach_status", "date_contacted"]
LOG_HEADER = ["id", "lead", "biz", "recipient", "date", "subject", "template", "status", "", "", "", "err", "c", "s", "cs", "src"]
TODAY = "2026-10-11"
SECRET = "SUPER-SECRET-TOKEN-123"


class FakeWS:
    def __init__(self, rows):
        self.rows = [list(r) for r in rows]
        self.fail_updates = False

    def get_all_values(self):
        return [list(r) for r in self.rows]

    def row_values(self, n):
        return self.rows[n - 1]

    def update_cell(self, r, c, v):
        if self.fail_updates:
            raise RuntimeError("sheet down")
        self.rows[r - 1][c - 1] = v

    def append_rows(self, rows, value_input_option=None):
        self.rows.extend([list(r) for r in rows])

    def batch_update(self, data):
        pass


class Resp:
    def __init__(self, code, text=""):
        self.status_code, self.text = code, text


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setattr(se, "SENDER_EMAIL", "sender@example.test")
    monkeypatch.setattr(se.time, "sleep", lambda s: None)
    monkeypatch.setattr(se, "check_email", lambda e: (True, ""))  # no DNS
    calls = []
    monkeypatch.setattr(se.requests, "post", lambda *a, **k: calls.append((a, k)) or Resp(202))
    return calls


def leads(*emails, status="new"):
    return FakeWS([HEADER] + [[str(i), f"Biz{i}", e, "X", "TN", status, ""] for i, e in enumerate(emails)])


def run(leads_ws, log_ws=None, cap=50, sup=(set(), set()), referrals=None, **kw):
    log_ws = log_ws or FakeWS([LOG_HEADER])
    referrals = referrals or FakeWS([HEADER])
    attempted, blocked = se.load_log_blocklists(log_ws, se.CAMPAIGN_ID)
    stats = se.run_campaign(leads_ws, referrals, log_ws, SECRET, "", None, TODAY, cap,
                            sup[0], sup[1], attempted, blocked, **kw)
    return stats, log_ws


def set_post(monkeypatch, fn):
    calls = []
    def post(*a, **k):
        calls.append(1)
        return fn()
    monkeypatch.setattr(se.requests, "post", post)
    return calls


def status_of(ws, i=1):
    return ws.rows[i][5]


# 1. failed email attempted once, never retried (also across runs)
@pytest.mark.parametrize("code", [400, 500, 502])
def test_failed_email_attempted_once(monkeypatch, code):
    calls = set_post(monkeypatch, lambda: Resp(code))
    l = leads("a@x.com")
    run(l)
    assert len(calls) == 1
    run(l)  # next scheduled run
    assert len(calls) == 1


def test_429_not_retried_and_stops(monkeypatch):
    calls = set_post(monkeypatch, lambda: Resp(429))
    l = leads("a@x.com", "b@x.com")
    stats, _ = run(l)
    assert len(calls) == 1 and stats["stopped_reason"] == se.TEMPORARY
    assert status_of(l) == se.STATUS_FAILED and status_of(l, 2) == "new"


# 2 + 3. timeout never resent; uncertain -> UNKNOWN
def test_timeout_is_unknown_and_not_resent(monkeypatch):
    calls = []
    def boom(*a, **k):
        calls.append(1)
        raise requests.exceptions.ReadTimeout("slow")
    monkeypatch.setattr(se.requests, "post", boom)
    l = leads("a@x.com", "b@x.com")
    stats, log = run(l)
    assert len(calls) == 1
    assert status_of(l) == se.STATUS_UNKNOWN and log.rows[1][7] == "unknown"
    assert stats["stopped_reason"] == se.UNCERTAIN
    run(l, log)
    assert len(calls) == 2  # only b@x.com on the next run, never a@x.com again
    assert status_of(l) == se.STATUS_UNKNOWN


def test_5xx_is_unknown(monkeypatch):
    set_post(monkeypatch, lambda: Resp(504))
    l = leads("a@x.com")
    run(l)
    assert status_of(l) == se.STATUS_UNKNOWN


def test_never_sent_without_202(monkeypatch):
    set_post(monkeypatch, lambda: Resp(200))
    l = leads("a@x.com")
    run(l)
    assert status_of(l) != se.STATUS_SENT


# 4. restart / rerun: pending written before send; crash leaves lead un-sendable
def test_pending_recorded_before_send_and_restart_does_not_resend(monkeypatch):
    l = leads("a@x.com", "b@x.com")
    seen_during_send = []
    def crash(*a, **k):
        seen_during_send.append(status_of(l))
        raise KeyboardInterrupt  # runner killed mid-send
    monkeypatch.setattr(se.requests, "post", crash)
    with pytest.raises(KeyboardInterrupt):
        run(l)
    assert seen_during_send == [se.STATUS_PENDING]
    calls = set_post(monkeypatch, lambda: Resp(202))
    run(l)  # GitHub rerun
    assert status_of(l) == se.STATUS_PENDING  # still held for manual review
    assert len(calls) == 1  # only b@x.com


def test_no_send_if_pending_cannot_be_recorded(monkeypatch):
    calls = set_post(monkeypatch, lambda: Resp(202))
    l = leads("a@x.com")
    l.fail_updates = True
    stats, _ = run(l)
    assert not calls and stats["stopped_reason"] == "state_store_unavailable"


def test_final_status_write_failure_still_blocks_resend(monkeypatch):
    l = leads("a@x.com")
    orig = l.update_cell
    n = {"c": 0}
    def flaky(r, c, v):
        n["c"] += 1
        if n["c"] > 1:
            raise RuntimeError("down")
        orig(r, c, v)
    l.update_cell = flaky
    calls = set_post(monkeypatch, lambda: Resp(202))
    run(l)
    run(l)
    assert len(calls) == 1 and status_of(l) == se.STATUS_PENDING


# 5. scheduled run doesn't resend failures (also via the log when the sheet status was reset to new)
def test_log_blocks_failed_recipient_even_if_status_is_new(monkeypatch):
    calls = set_post(monkeypatch, lambda: Resp(400))
    l = leads("a@x.com")
    _, log = run(l)
    l.rows[1][5] = "new"  # e.g. status write lost
    stats, _ = run(l, log)
    assert len(calls) == 1 and stats["skipped_duplicate"] + stats["skipped_suppressed"] == 1


def test_manual_retry_approval(monkeypatch):
    calls = set_post(monkeypatch, lambda: Resp(400))
    l = leads("a@x.com")
    _, log = run(l)
    log.rows[1][7] = "retry_approved"
    l.rows[1][5] = "new"
    set_post(monkeypatch, lambda: Resp(202))
    stats, _ = run(l, log)
    assert stats["sent"] == 1


# 6. duplicates
def test_duplicates_filtered(monkeypatch):
    calls = set_post(monkeypatch, lambda: Resp(202))
    l = leads("A@X.com", " a@x.com ", "mailto:a@x.com")
    stats, _ = run(l)
    assert len(calls) == 1 and stats["skipped_duplicate"] == 2


def test_duplicate_across_leads_and_referrals(monkeypatch):
    calls = set_post(monkeypatch, lambda: Resp(202))
    run(leads("a@x.com"), referrals=leads("a@x.com"))
    assert len(calls) == 1


# 7. suppression
def test_suppressed_never_sent(monkeypatch):
    calls = set_post(monkeypatch, lambda: Resp(202))
    l = leads("a@x.com", "b@blocked.org", "c@y.com")
    stats, _ = run(l, sup=({"a@x.com"}, {"blocked.org"}))
    assert len(calls) == 1 and stats["skipped_suppressed"] == 2


def test_unsubscribed_status_never_sent(monkeypatch):
    calls = set_post(monkeypatch, lambda: Resp(202))
    run(leads("a@x.com", status="unsubscribed"))
    assert not calls


# 8. cap
def test_daily_cap_enforced(monkeypatch):
    calls = set_post(monkeypatch, lambda: Resp(202))
    run(leads("a@x.com", "b@y.com", "c@z.com"), cap=2)
    assert len(calls) == 2


def test_cap_counts_failed_and_unknown_attempts_and_env_lowers_it(monkeypatch):
    log = FakeWS([LOG_HEADER, ["1", "", "", "a@x.com", TODAY, "", "v", "failed"],
                  ["2", "", "", "b@x.com", TODAY, "", "v", "unknown"],
                  ["3", "", "", "c@x.com", TODAY, "", "v", "sent"]])
    assert se.sending_stats(log, TODAY)[0] == 3
    monkeypatch.setenv("DAILY_SEND_CAP", "40")
    monkeypatch.setenv("PER_RUN_CAP", "5")
    assert se.todays_caps(0) == (40, 5)
    monkeypatch.setenv("DAILY_SEND_CAP", "100000")
    assert se.todays_caps(0)[0] == se.RAMP_START_CAP  # can lower, never raise past the ramp


# 9. throttling / restriction stop sending
@pytest.mark.parametrize("code,body,reason", [
    (429, "", se.TEMPORARY), (503, "", se.TEMPORARY), (401, "", se.AUTH_RESTRICTION),
    (403, "", se.AUTH_RESTRICTION), (400, "ErrorSubmissionQuotaExceeded", se.AUTH_RESTRICTION),
    (550, "5.7.1 outbound spam blocked", se.AUTH_RESTRICTION),
])
def test_provider_problems_stop_campaign(monkeypatch, code, body, reason):
    calls = set_post(monkeypatch, lambda: Resp(code, body))
    l = leads("a@x.com", "b@x.com", "c@x.com")
    stats, _ = run(l)
    assert len(calls) == 1 and stats["stopped_reason"] == reason


def test_connect_failure_stops(monkeypatch):
    def boom(*a, **k):
        raise requests.exceptions.ConnectTimeout()
    monkeypatch.setattr(se.requests, "post", boom)
    stats, _ = run(leads("a@x.com", "b@x.com"))
    assert stats["stopped_reason"] == se.CONNECTION


def test_permanent_rejection_continues(monkeypatch):
    codes = iter([400, 202])
    calls = set_post(monkeypatch, lambda: Resp(next(codes)))
    stats, _ = run(leads("a@x.com", "b@x.com"))
    assert len(calls) == 2 and stats["sent"] == 1


# 10. no credentials in logs/sheet
def test_credentials_not_logged(monkeypatch, capsys):
    set_post(monkeypatch, lambda: Resp(401, f"bad token {SECRET} secret"))
    l = leads("a@x.com")
    _, log = run(l)
    out = capsys.readouterr()
    assert SECRET not in out.out + out.err
    assert SECRET not in str(log.rows) and "bad token" not in str(log.rows)


# 11. scraper independence
def test_scrapers_do_not_depend_on_sender():
    for f in ["find_leads.py", "find_intent_leads.py", "enrich_leads.py", "write_to_sheets.py"]:
        tree = ast.parse(open(os.path.join(os.path.dirname(__file__), "..", f)).read())
        for n in ast.walk(tree):
            names = [a.name for a in n.names] if isinstance(n, (ast.Import, ast.ImportFrom)) else []
            if isinstance(n, ast.ImportFrom) and n.module:
                names.append(n.module)
            assert "send_emails" not in names, f


def test_scraper_workflows_do_not_run_sender():
    for f in glob.glob(os.path.join(os.path.dirname(__file__), "..", ".github", "workflows", "find-*.yml")):
        assert "send_emails" not in open(f).read()


def test_sending_disabled_is_a_clean_noop(monkeypatch, capsys):
    calls = set_post(monkeypatch, lambda: Resp(202))
    monkeypatch.setattr(se, "EMAIL_SENDING_ENABLED", False)
    se.main()  # returns without touching sheets/credentials
    assert not calls


# 12. nothing real is sent in tests; no retry code remains
def test_send_email_makes_exactly_one_post(monkeypatch):
    calls = set_post(monkeypatch, lambda: Resp(429))
    se.send_email("t", "a@x.com", "s", "b")
    assert len(calls) == 1


def test_no_retry_constructs_left():
    src = open(os.path.join(os.path.dirname(__file__), "..", "send_emails.py")).read()
    for banned in ["retry_count", "MAX_RETRYABLE", "Will retry next run", "verify_sender_auth"]:
        assert banned not in src


def test_workflow_safety():
    wf = open(os.path.join(os.path.dirname(__file__), "..", ".github", "workflows", "send-outreach-auto.yml")).read()
    assert "concurrency:" in wf and "cancel-in-progress: false" in wf
    sup = open(os.path.join(os.path.dirname(__file__), "..", ".github", "workflows", "supervisor.yml")).read()
    assert 'send-outreach-auto' in sup.split("Retry failed workflows")[1]
