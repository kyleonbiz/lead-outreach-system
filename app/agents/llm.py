"""One Claude call, no retries. Tests replace `ask`."""
import json
import os

import requests


class LLMError(Exception):
    pass


def ask(prompt, max_tokens=3000):
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not key:
        raise LLMError("ANTHROPIC_API_KEY is not set")
    try:
        r = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
            json={"model": os.environ.get("CLAUDE_MODEL", "claude-sonnet-5-5"), "max_tokens": max_tokens,
                  "messages": [{"role": "user", "content": prompt}]},
            timeout=120,
        )
    except requests.RequestException as e:
        raise LLMError(f"could not reach the Claude API ({type(e).__name__})")
    if r.status_code != 200:
        raise LLMError(f"Claude API returned {r.status_code}")  # body not included: it may echo the prompt
    return "".join(b.get("text", "") for b in r.json().get("content", []))


def parse_json(raw, opener):
    """Pull the first JSON array/object out of a model reply. opener is '[' or '{'."""
    closer = "]" if opener == "[" else "}"
    s, e = raw.find(opener), raw.rfind(closer)
    if s == -1 or e == -1:
        raise LLMError("the model did not return JSON")
    try:
        return json.loads(raw[s:e + 1])
    except ValueError:
        raise LLMError("the model returned malformed JSON")


def chat(messages, tools, system, max_tokens=2000):
    """One tool-use turn of the Messages API. Returns {"content": [blocks], "stop_reason": str}. One call, no retries."""
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not key:
        raise LLMError("ANTHROPIC_API_KEY is not set")
    try:
        r = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
            json={"model": os.environ.get("CLAUDE_MODEL", "claude-sonnet-5-5"), "max_tokens": max_tokens, "system": system,
                  "tools": tools, "messages": messages},
            timeout=120,
        )
    except requests.RequestException as e:
        raise LLMError(f"could not reach the Claude API ({type(e).__name__})")
    if r.status_code != 200:
        raise LLMError(f"Claude API returned {r.status_code}")
    d = r.json()
    return {"content": d.get("content", []), "stop_reason": d.get("stop_reason", "")}
