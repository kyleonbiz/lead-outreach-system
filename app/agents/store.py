"""Tiny JSON file store for agent output (drafts, reports). Lives in DATA_DIR, never in your sheets."""
import json
import os
import threading

from .. import runner

_lock = threading.RLock()


def _path(name):
    d = os.path.join(runner.DATA_DIR, "agents")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, name + ".json")


def load(name, default):
    with _lock:
        try:
            with open(_path(name)) as f:
                return json.load(f)
        except (OSError, ValueError):
            return default


def save(name, data):
    with _lock:
        tmp = _path(name) + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f, indent=1)
        os.replace(tmp, _path(name))  # atomic: a crash never leaves a half-written file


def mutate(name, fn, default):
    """Read-modify-write under one lock. fn(data) mutates in place and may return a value."""
    with _lock:
        data = load(name, default)
        out = fn(data)
        save(name, data)
        return out


def suppression_path():
    return _path("suppression")


def suppressed_emails():
    return set(load("suppression", {"emails": []}).get("emails", []))


def add_suppressed(email):
    mutate("suppression", lambda d: d.setdefault("emails", []).append(email) if email not in d.setdefault("emails", []) else None,
           {"emails": []})
