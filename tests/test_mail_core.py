"""The app's sending helpers: one attempt, correct classification, no retries. requests.post is always mocked."""
import os
import sys

import pytest
import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import app.mail_core as mc  # noqa: E402


class Resp:
    def __init__(self, code, text=""):
        self.status_code, self.text = code, text


def post_with(monkeypatch, fn):
    calls = []
    monkeypatch.setattr(mc.requests, "post", lambda *a, **k: calls.append(1) or fn())
    return calls


@pytest.mark.parametrize("code,body,cat", [
    (202, "", mc.OK), (429, "", mc.TEMPORARY), (503, "", mc.TEMPORARY), (401, "", mc.AUTH_RESTRICTION),
    (403, "", mc.AUTH_RESTRICTION), (400, "ErrorSubmissionQuotaExceeded", mc.AUTH_RESTRICTION),
    (400, "bad address", mc.PERMANENT), (500, "", mc.UNCERTAIN), (504, "", mc.UNCERTAIN),
])
def test_classification_and_single_post(monkeypatch, code, body, cat):
    mc.SENDER_EMAIL = "s@example.test"
    calls = post_with(monkeypatch, lambda: Resp(code, body))
    out = mc.send_email("tok", "a@x.com", "s", "b")
    assert out[0] == cat and len(calls) == 1  # 429 etc. are never retried
    assert (out[2] == mc.STATUS_SENT) == (code == 202)


def test_timeouts(monkeypatch):
    mc.SENDER_EMAIL = "s@example.test"
    def read_timeout(*a, **k):
        raise requests.exceptions.ReadTimeout()
    monkeypatch.setattr(mc.requests, "post", read_timeout)
    assert mc.send_email("t", "a@x.com", "s", "b")[0] == mc.UNCERTAIN  # may have been delivered: UNKNOWN, never resent
    def conn_timeout(*a, **k):
        raise requests.exceptions.ConnectTimeout()
    monkeypatch.setattr(mc.requests, "post", conn_timeout)
    assert mc.send_email("t", "a@x.com", "s", "b")[0] == mc.CONNECTION


def test_secret_never_returned(monkeypatch):
    mc.SENDER_EMAIL = "s@example.test"
    post_with(monkeypatch, lambda: Resp(401, "bad token SECRET-TOKEN-1"))
    assert "SECRET-TOKEN-1" not in str(mc.send_email("SECRET-TOKEN-1", "a@x.com", "s", "b"))


def test_caps_and_stats(monkeypatch):
    monkeypatch.delenv("DAILY_SEND_CAP", raising=False)
    monkeypatch.setenv("DAILY_SEND_CAP", "40")
    assert mc.todays_caps(0)[0] == 40
    monkeypatch.setenv("DAILY_SEND_CAP", "100000")
    assert mc.todays_caps(0)[0] == mc.RAMP_START_CAP  # lowers only, never raises
    class WS:
        def get_all_values(self):
            return [["h"], ["", "", "", "a", "2026-10-11", "", "v", "failed"], ["", "", "", "b", "2026-10-11", "", "v", "unknown"],
                    ["", "", "", "c", "2026-10-11", "", "v", "sent"], ["", "", "", "d", "2026-10-11", "", "v", "sent_test"]]
    assert mc.sending_stats(WS(), "2026-10-11")[0] == 3  # failed and unknown count; test sends do not


def test_suppression_file(tmp_path, monkeypatch):
    f = tmp_path / "s.json"
    f.write_text('{"emails": ["A@X.com "]}')
    monkeypatch.setenv("SUPPRESSION_FILE", str(f))
    class NoTab:
        def worksheet(self, n):
            raise Exception("no tab")
    assert mc.load_suppression(NoTab())[0] == {"a@x.com"}
