#!/usr/bin/env python3
"""Bridge between Claude Code and ClawdBuddy (ESP32 desk mascot).

Two modes, both read Claude Code's JSON from stdin:

  deskbuddy.py statusline   Prints a compact status line and pushes the
                            5-hour / weekly rate limits to the ESP32.
  deskbuddy.py hook         Tells the mascot what Claude is doing:
                              UserPromptSubmit -> working / think
                              PreToolUse       -> working / read|search|edit|run|web|agent|tool
                              PostToolUse      -> working / think
                              Notification     -> waiting (needs you)
                              Stop             -> done
                              SessionEnd       -> idle

Messages go to every target in parallel:
  DESKBUDDY_HOST  the ESP32 board  (default deskbuddy.local)
  DESKBUDDY_WEB   the on-screen buddy, web/webbuddy.py  (default 127.0.0.1:8787)
Set either to "off" to disable it.
Never blocks Claude: hooks are registered as async, every network call has
a 1 s timeout, and all failures are silently ignored.
"""
import json
import os
import re
import socket
import sys
import tempfile
import threading
import time
import urllib.request
from urllib.parse import urlparse

TARGETS = [h for h in (os.environ.get("DESKBUDDY_HOST", "deskbuddy.local"),
                       os.environ.get("DESKBUDDY_WEB", "127.0.0.1:8787")) if h and h != "off"]
STATE_FILE = os.path.join(tempfile.gettempdir(), "deskbuddy_state.json")
# Latest activity + usage, kept even when no buddy is listening, so a buddy
# started mid-task can catch up (web/webbuddy.py reads these on start).
LAST_EVENT_FILE = os.path.join(tempfile.gettempdir(), "deskbuddy_last_event.json")
LAST_USAGE_FILE = os.path.join(tempfile.gettempdir(), "deskbuddy_last_usage.json")
TIMEOUT = 1.0
RESEND_EVERY = 120  # seconds; re-push unchanged usage so a rebooted board catches up
DETAIL_MAX = 90

TOOL_TASKS = {
    "Read": "read", "NotebookRead": "read",
    "Glob": "search", "Grep": "search", "LS": "search", "ToolSearch": "search",
    "Edit": "edit", "MultiEdit": "edit", "Write": "edit", "NotebookEdit": "edit",
    "Bash": "run", "PowerShell": "run", "BashOutput": "run", "Monitor": "run",
    "WebFetch": "web", "WebSearch": "web",
    "Agent": "agent", "Task": "agent",
}


# ---------------------------------------------------------------- helpers
def load_state():
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(state):
    try:
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(state, f)
    except OSError:
        pass


def resolve(state, host):
    """Cache resolved IPs: .local lookups on Windows can take a while."""
    ips = state.setdefault("ips", {})
    hit = ips.get(host)
    if hit and time.time() - hit[1] < 3600:
        return hit[0]
    name, _, port = host.partition(":")
    try:
        ip = socket.gethostbyname(name)
    except OSError:
        return None
    if port:
        ip = f"{ip}:{port}"
    ips[host] = [ip, time.time()]
    return ip


def post_one(state, host, path, payload, results):
    ip = resolve(state, host)
    ok = False
    if ip:
        req = urllib.request.Request(
            f"http://{ip}{path}", data=json.dumps(payload).encode(), method="POST",
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                r.read()
            ok = True
        except OSError:
            state.get("ips", {}).pop(host, None)  # re-resolve next time
    results[host] = ok


def post(state, path, payload, hosts=None):
    """POST to all targets in parallel; returns {host: succeeded}."""
    results = {}
    threads = [threading.Thread(target=post_one, args=(state, h, path, payload, results))
               for h in (TARGETS if hosts is None else hosts)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(TIMEOUT + 2)
    return results


def write_snapshot(path, data, ts=None):
    """Atomically save the latest event/usage. With ts, never overwrite a newer one
    (async hooks can finish out of order)."""
    try:
        if ts is not None:
            try:
                with open(path, encoding="utf-8") as f:
                    if json.load(f).get("ts", 0) > ts:
                        return
            except (OSError, ValueError):
                pass
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(tmp, path)
    except OSError:
        pass


def read_stdin_json():
    try:
        return json.loads(sys.stdin.buffer.read().decode("utf-8") or "{}")
    except ValueError:
        return {}


def screen_text(text):
    """The OLED font is ASCII only: flatten whitespace, replace the rest."""
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    text = text.encode("ascii", "replace").decode("ascii")
    return text[:DETAIL_MAX - 3] + "..." if len(text) > DETAIL_MAX else text


def tool_detail(name, task, inp):
    inp = inp if isinstance(inp, dict) else {}
    if task == "search" and inp.get("pattern"):
        return inp["pattern"]
    for key in ("file_path", "notebook_path", "path"):
        if inp.get(key):
            p = str(inp[key]).rstrip("/\\")
            return os.path.basename(p) or p
    if inp.get("command"):
        return inp["command"]
    if inp.get("url"):
        u = urlparse(str(inp["url"]))
        return (u.netloc + u.path) or inp["url"]
    for key in ("query", "description", "prompt"):
        if inp.get(key):
            return inp[key]
    if name.startswith("mcp__"):
        return name.split("__")[-1].replace("_", " ")
    return name


# ---------------------------------------------------------------- modes
def statusline():
    data = read_stdin_json()
    rl = data.get("rate_limits") or {}

    parts = []
    model = (data.get("model") or {}).get("display_name")
    if model:
        parts.append(model)
    ctx = (data.get("context_window") or {}).get("used_percentage")
    if ctx is not None:
        parts.append(f"ctx {ctx:.0f}%")
    for key, label in (("five_hour", "5h"), ("seven_day", "wk")):
        pct = (rl.get(key) or {}).get("used_percentage")
        if pct is not None:
            parts.append(f"{label} {pct:.0f}%")
    print(" | ".join(parts))
    sys.stdout.flush()  # show the status line before touching the network

    windows = {k: rl[k] for k in ("five_hour", "seven_day") if rl.get(k)}
    if not windows:
        return
    key = json.dumps(windows, sort_keys=True)
    write_snapshot(LAST_USAGE_FILE, windows)
    state = load_state()
    sent = state.setdefault("sent", {})   # per target: [payload, time]
    due = [h for h in TARGETS
           if sent.get(h, [None])[0] != key or time.time() - sent[h][1] > RESEND_EVERY]
    if due:
        for host, ok in post(state, "/usage", windows, due).items():
            if ok:
                sent[host] = [key, time.time()]
        save_state(state)


def hook():
    data = read_stdin_json()
    event = data.get("hook_event_name")
    msg = {"ts": int(time.time() * 1000)}

    if event == "UserPromptSubmit":
        msg.update(type="working", task="think", detail=data.get("prompt", ""))
    elif event == "PreToolUse":
        name = data.get("tool_name", "")
        task = TOOL_TASKS.get(name, "tool")
        msg.update(type="working", task=task,
                   detail=tool_detail(name, task, data.get("tool_input")))
    elif event == "PostToolUse":
        msg.update(type="working", task="think", detail="")
    elif event == "Notification":
        msg.update(type="waiting", detail=data.get("message", ""))
    elif event == "Stop":
        msg.update(type="done", detail=data.get("last_assistant_message", ""))
    elif event == "SessionEnd":
        msg.update(type="idle")
    else:
        return

    msg["detail"] = screen_text(msg.get("detail", ""))
    write_snapshot(LAST_EVENT_FILE, msg, msg["ts"])
    state = load_state()
    post(state, "/event", msg)
    save_state(state)


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "statusline":
        statusline()
    elif mode == "hook":
        hook()
    else:
        sys.exit("usage: deskbuddy.py statusline|hook")
