"""Tiny JSON file store for the app's own data (calendar events). Lives in DATA_DIR, never in your sheets."""
import json
import os
import threading

REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(REPO_DIR, ".data"))
_lock = threading.RLock()


def _path(name):
    os.makedirs(DATA_DIR, exist_ok=True)
    return os.path.join(DATA_DIR, name + ".json")


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
