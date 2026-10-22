"""Runs jobs as subprocesses. One run per job at a time; one sender at a time across processes.

There is deliberately NO retry logic here: a failed or timed-out job is reported and left alone.
"""
import fcntl
import datetime
import json
import logging
import os
import signal
import subprocess
import sys
import tempfile
import threading
import urllib.request

from .jobs import JOBS, Job

log = logging.getLogger("runner")
REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(REPO_DIR, ".data"))
SECRET_HINTS = ("SECRET", "KEY", "TOKEN", "PASSWORD", "WEBHOOK", "CREDENTIALS")

_job_locks = {name: threading.Lock() for name in JOBS}
last_runs = {}  # name -> {started, finished, exit_code, state}  (no log output, no personal data)


def pause_flag_path():
    return os.path.join(DATA_DIR, "sending_paused")


def sending_paused():
    return os.path.exists(pause_flag_path())


def set_sending_paused(paused):
    os.makedirs(DATA_DIR, exist_ok=True)
    if paused:
        open(pause_flag_path(), "w").close()
    elif os.path.exists(pause_flag_path()):
        os.remove(pause_flag_path())


def scrub(text, env):
    for k, v in env.items():
        if v and len(v) >= 6 and any(h in k.upper() for h in SECRET_HINTS):
            text = text.replace(v, "***")
    return text


def _notify(msg, env):
    url = env.get("DISCORD_WEBHOOK_URL")
    if not url:
        return
    try:
        req = urllib.request.Request(url, data=json.dumps({"content": msg}).encode(),
                                     headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=10)
    except Exception:
        pass  # notifications never affect jobs


def _run_steps(job: Job, env, cwd):
    for step in job.steps:
        cmd = [sys.executable, os.path.join(REPO_DIR, step.script), *step.args]
        proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, start_new_session=True)
        try:
            out, _ = proc.communicate(timeout=job.timeout_s)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            out, _ = proc.communicate()
            print(scrub(out or "", env))
            return 124
        print(scrub(out or "", env), flush=True)  # to server logs only, never returned by the API
        if proc.returncode != 0:
            return proc.returncode
    return 0


def run_job(name, extra_args=None):
    """Run a job once. Returns 'started-and-finished' dict, or {'state': 'skipped', 'reason': ...}."""
    job = JOBS[name]
    if job.is_sender and sending_paused():
        return {"state": "skipped", "reason": "sending_paused"}
    if not _job_locks[name].acquire(blocking=False):
        return {"state": "skipped", "reason": "already_running"}
    lock_fh = None
    try:
        if job.is_sender:
            # Cross-process guard on the same host, in addition to the in-process lock.
            os.makedirs(DATA_DIR, exist_ok=True)
            lock_fh = open(os.path.join(DATA_DIR, "sender.lock"), "w")
            try:
                fcntl.flock(lock_fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                return {"state": "skipped", "reason": "another_sender_running"}
        env = {**os.environ, **job.env}
        started = datetime.datetime.now(datetime.timezone.utc).isoformat() + "Z"
        last_runs[name] = {"state": "running", "started": started}
        with tempfile.TemporaryDirectory() as tmp:
            cwd = REPO_DIR if job.needs_repo_cwd else tmp
            code = _run_steps(job, env, cwd)
        result = {"state": "ok" if code == 0 else "failed", "started": started,
                  "finished": datetime.datetime.now(datetime.timezone.utc).isoformat() + "Z", "exit_code": code}
        last_runs[name] = result
        _notify(f"{'✅' if code == 0 else '❌'} {name} {'finished' if code == 0 else f'failed (exit {code})'}", env)
        return result
    finally:
        if lock_fh:
            lock_fh.close()
        _job_locks[name].release()
