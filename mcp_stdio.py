#!/usr/bin/env python3
"""Bridge so Claude Desktop / Claude Cowork can use this app on your own computer.

It speaks MCP over stdin/stdout and forwards each message to the app's connector endpoint. Add it to the app's MCP config:

  {"mcpServers": {"aurum-outreach": {"command": "python3", "args": ["/full/path/to/mcp_stdio.py"],
     "env": {"APP_URL": "http://127.0.0.1:8000", "MCP_TOKEN": "<a key from Settings > Connectors>"}}}}

Changes are never made by the connector: they appear in the app's Approvals inbox for you to approve."""
import json
import os
import sys
import urllib.error
import urllib.request

URL = os.environ.get("APP_URL", "http://127.0.0.1:8000").rstrip("/") + "/mcp"
TOKEN = os.environ.get("MCP_TOKEN", "")


def http_post(body):
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "Authorization": f"Bearer {TOKEN}"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def handle_line(line, post=http_post):
    """Returns the line to print for one incoming message, or None (notifications print nothing)."""
    try:
        msg = json.loads(line)
    except ValueError:
        return json.dumps({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}})
    status, data = post(msg)
    if status == 202:
        return None
    if status == 200:
        return data.decode() if isinstance(data, bytes) else data
    rid = msg.get("id") if isinstance(msg, dict) else None
    if rid is None:
        return None
    note = {401: "the key was rejected (check MCP_TOKEN)", 429: "rate limit: slow down"}.get(status, f"the app returned HTTP {status}")
    return json.dumps({"jsonrpc": "2.0", "id": rid, "error": {"code": -32000, "message": note}})


def main():
    if not TOKEN:
        sys.exit("Set MCP_TOKEN to a connector key from Settings > Connectors.")
    for line in sys.stdin:
        if line.strip():
            out = handle_line(line)
            if out:
                sys.stdout.write(out.strip() + "\n")
                sys.stdout.flush()


if __name__ == "__main__":
    main()
