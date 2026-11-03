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

Set DESKBUDDY_HOST to the board's IP if deskbuddy.local doesn't resolve.
Never blocks Claude: hooks are registered as async, every network call has
a 1 s timeout, and all failures are silently ignored.
"""
import json
import os
import re
import socket
import sys
import tempfile
import time
import urllib.request
from urllib.parse import urlparse

HOST = os.environ.get("DESKBUDDY_HOST", "deskbuddy.local")
STATE_FILE = os.path.join(tempfile.gettempdir(), "deskbuddy_state.json")
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


def resolve(state):
    """Cache the board's IP: .local lookups on Windows can take a while."""
    ip = state.get("ip")
    if ip and state.get("host") == HOST and time.time() - state.get("ip_ts", 0) < 3600:
        return ip
    name, _, port = HOST.partition(":")
    try:
        ip = socket.gethostbyname(name)
    except OSError:
        return None
    if port:
        ip = f"{ip}:{port}"
    state["ip"], state["ip_ts"], state["host"] = ip, time.time(), HOST
    return ip


def post(state, path, payload):
    ip = resolve(state)
    if not ip:
        return False
    req = urllib.request.Request(
        f"http://{ip}{path}", data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            r.read()
        return True
    except OSError:
        state.pop("ip", None)  # re-resolve next time (board may have a new IP)
        return False


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
    state = load_state()
    stale = time.time() - state.get("last_sent", 0) > RESEND_EVERY
    if key != state.get("last_payload") or stale:
        if post(state, "/usage", windows):
            state["last_payload"], state["last_sent"] = key, time.time()
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
