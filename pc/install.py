#!/usr/bin/env python3
"""Connect ClawdBuddy to Claude Code by editing ~/.claude/settings.json.

    python install.py                       add the status line + hooks
    python install.py --replace-statusline  also replace an existing status line
    python install.py --uninstall           remove everything this script added

A backup is written to settings.json.bak-clawdbuddy before any change.
Running it twice is safe: old ClawdBuddy entries are replaced, not duplicated.
"""
import json
import shutil
import sys
from pathlib import Path

SETTINGS = Path.home() / ".claude" / "settings.json"
SCRIPT = Path(__file__).resolve().parent / "deskbuddy.py"
MARKER = "deskbuddy.py"
HOOK_EVENTS = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"]
NOTIFY_MATCHER = "permission_prompt|elicitation_dialog"


def command(mode):
    python = Path(sys.executable).as_posix()
    return f'"{python}" "{SCRIPT.as_posix()}" {mode}'


def is_ours(group):
    return any(MARKER in h.get("command", "") for h in group.get("hooks", []))


def strip_ours(settings):
    hooks = settings.get("hooks", {})
    for event in list(hooks):
        hooks[event] = [g for g in hooks[event] if not is_ours(g)]
        if not hooks[event]:
            del hooks[event]
    if not hooks:
        settings.pop("hooks", None)
    if MARKER in settings.get("statusLine", {}).get("command", ""):
        del settings["statusLine"]


def main():
    args = set(sys.argv[1:])
    settings = {}
    if SETTINGS.exists():
        settings = json.loads(SETTINGS.read_text(encoding="utf-8") or "{}")
        shutil.copy(SETTINGS, SETTINGS.with_name("settings.json.bak-clawdbuddy"))
    else:
        SETTINGS.parent.mkdir(parents=True, exist_ok=True)

    strip_ours(settings)

    if "--uninstall" in args:
        SETTINGS.write_text(json.dumps(settings, indent=2), encoding="utf-8")
        print("ClawdBuddy removed from", SETTINGS)
        return

    hook = lambda: [{"type": "command", "command": command("hook"), "async": True}]
    hooks = settings.setdefault("hooks", {})
    for event in HOOK_EVENTS:
        hooks.setdefault(event, []).append({"hooks": hook()})
    hooks.setdefault("Notification", []).append({"matcher": NOTIFY_MATCHER, "hooks": hook()})

    if "statusLine" in settings and "--replace-statusline" not in args:
        print("! You already have a status line, so it was left alone.")
        print("  Usage limits reach ClawdBuddy through the status line; rerun with")
        print("  --replace-statusline to use ClawdBuddy's (or call deskbuddy.py from yours).")
    else:
        settings["statusLine"] = {"type": "command", "command": command("statusline")}

    SETTINGS.write_text(json.dumps(settings, indent=2), encoding="utf-8")
    print("ClawdBuddy connected to Claude Code:", SETTINGS)
    print("Board address:", "DESKBUDDY_HOST env var, default deskbuddy.local")


if __name__ == "__main__":
    main()
