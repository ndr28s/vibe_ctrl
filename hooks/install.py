#!/usr/bin/env python3
"""
Vibes Hook Installer
Installs hooks and config for Claude Code on this machine.

Usage:
  python install.py --token MY_TOKEN --machine my-pc --server ws://1.2.3.4:8765
  python install.py  (interactive)
"""

import argparse
import json
import os
import shutil
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description="Install Vibes hooks for Claude Code")
    parser.add_argument("--token", default="bygwna_home", help="Auth token")
    parser.add_argument("--machine", default=os.environ.get("COMPUTERNAME", "my-pc").lower(), help="Machine ID")
    parser.add_argument("--server", default="ws://89.167.114.185:8765", help="WebSocket server URL")
    args = parser.parse_args()

    claude_home = Path.home() / ".claude"
    hooks_dir = claude_home / "hooks"
    vibes_home = Path.home() / ".vibes"

    # Create directories
    hooks_dir.mkdir(parents=True, exist_ok=True)
    vibes_home.mkdir(parents=True, exist_ok=True)

    # 1. Copy hook file
    src_hook = Path(__file__).parent / "vibes-hook.py"
    dst_hook = hooks_dir / "vibes-hook.py"
    shutil.copy2(src_hook, dst_hook)
    print(f"  Installed: {dst_hook}")

    # 2. Create vibes config
    config = {
        "serverUrl": args.server,
        "token": args.token,
        "machineId": args.machine,
    }
    config_path = vibes_home / "config.json"
    with open(config_path, "w") as f:
        json.dump(config, f, indent=2)
    print(f"  Config: {config_path}")

    # 3. Merge hooks into settings.json
    settings_path = claude_home / "settings.json"
    if settings_path.exists():
        with open(settings_path) as f:
            settings = json.load(f)
    else:
        settings = {}

    # Determine python command
    python_cmd = "python" if sys.platform == "win32" else "python3"
    hook_command = f"{python_cmd} ~/.claude/hooks/vibes-hook.py"

    hook_entry = {
        "type": "command",
        "command": hook_command,
        "async": True,
        "timeout": 10,
    }

    events = [
        "SessionStart", "UserPromptSubmit", "PreToolUse",
        "PermissionRequest", "PreCompact", "Notification",
        "SubagentStart", "SessionEnd", "Stop",
    ]

    hooks = settings.get("hooks", {})
    for event in events:
        event_hooks = hooks.get(event, [])
        # Check if vibes hook already registered
        already = any(
            any("vibes-hook" in h.get("command", "") for h in group.get("hooks", []))
            for group in event_hooks
        )
        if not already:
            event_hooks.append({"hooks": [hook_entry]})
        hooks[event] = event_hooks

    settings["hooks"] = hooks

    with open(settings_path, "w") as f:
        json.dump(settings, f, indent=2)
    print(f"  Settings: {settings_path}")

    print(f"\nVibes installed!")
    print(f"  Token:   {args.token}")
    print(f"  Machine: {args.machine}")
    print(f"  Server:  {args.server}")
    print(f"\nRestart Claude Code to activate hooks.")
    print(f"Then run the daemon: cd ../daemon && node daemon.js")


if __name__ == "__main__":
    main()
