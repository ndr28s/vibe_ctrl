#!/usr/bin/env python3
"""
Vibes Hook for Claude Code
Sends status updates to Vibes WebSocket relay server via HTTP bridge.
Install: copy to ~/.claude/hooks/ and register in settings.json
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import Request, urlopen

# ============================================================================
# Configuration
# ============================================================================

DEBUG = os.environ.get("VIBES_DEBUG", "0") == "1"

# Load config from ~/.vibes/config.json
def load_config() -> dict[str, Any]:
    config_path = Path.home() / ".vibes" / "config.json"
    if config_path.exists():
        try:
            with open(config_path) as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    return {}

CONFIG = load_config()
SERVER_URL = CONFIG.get("serverUrl", "http://89.167.114.185:8765")
TOKEN = CONFIG.get("token", "bygwna_home")
MACHINE_ID = CONFIG.get("machineId", "unknown-pc")
HTTP_TIMEOUT = 5

# ============================================================================
# Utility
# ============================================================================

def debug_log(msg: str) -> None:
    if DEBUG:
        print(f"[vibes] {msg}", file=sys.stderr)


def read_input() -> str:
    try:
        return sys.stdin.read()
    except Exception:
        return ""


def parse_json(data: str) -> dict[str, Any]:
    try:
        return json.loads(data)
    except (json.JSONDecodeError, TypeError):
        return {}

# ============================================================================
# State Mapping
# ============================================================================

EVENT_STATE_MAP = {
    "SessionStart": "start",
    "UserPromptSubmit": "thinking",
    "PreToolUse": "working",
    "PreCompact": "packing",
    "Notification": "notification",
    "PermissionRequest": "notification",
    "SubagentStart": "working",
    "SessionEnd": "done",
    "Stop": "done",
}


def get_state(event_name: str, permission_mode: str = "default") -> str:
    state = EVENT_STATE_MAP.get(event_name, "working")
    if permission_mode == "plan" and state in ("thinking", "working"):
        return "planning"
    return state


def get_project_name(cwd: str, transcript_path: str) -> str:
    if cwd:
        try:
            result = subprocess.run(
                ["git", "-C", cwd, "rev-parse", "--show-toplevel"],
                capture_output=True, text=True, timeout=2,
            )
            if result.returncode == 0:
                name = os.path.basename(result.stdout.strip())
                if name:
                    return name
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
            pass
        name = os.path.basename(cwd.rstrip("/\\"))
        if name:
            return name

    if transcript_path:
        name = os.path.basename(os.path.dirname(transcript_path))
        if name:
            return name

    return os.path.basename(os.getcwd()) or "default"

# ============================================================================
# Send Status
# ============================================================================

def get_session_id(data: dict[str, Any]) -> tuple[str, str]:
    """Get session ID. Returns (file_key, full_session_id).
    file_key: short name for the status file
    full_session_id: real Claude session ID for --resume
    """
    # Claude Code passes session_id directly in hook data
    real_sid = data.get("session_id", "")
    transcript_path = data.get("transcript_path", "")

    if real_sid:
        # Use first 8 chars as file key, full ID for resume
        return real_sid[:8], real_sid

    if transcript_path:
        name = Path(transcript_path).stem
        return (name[:8], name) if name else ("default", "default")

    return "default", "default"


def send_status(payload: dict[str, Any], session_id: str) -> bool:
    """Write status to per-session file in ~/.vibes/sessions/."""
    try:
        sessions_dir = Path.home() / ".vibes" / "sessions"
        sessions_dir.mkdir(parents=True, exist_ok=True)
        status_path = sessions_dir / f"{session_id}.json"
        with open(status_path, "w") as f:
            json.dump(payload, f)
        debug_log(f"Status written: {payload.get('state')} -> {status_path.name}")
        return True
    except Exception as e:
        debug_log(f"Failed to write status: {e}")
        return False

# ============================================================================
# Main
# ============================================================================

def main() -> None:
    input_raw = read_input()
    data = parse_json(input_raw)

    event_name = data.get("hook_event_name", "Unknown")
    tool_name = data.get("tool_name", "")
    cwd = data.get("cwd", "")
    transcript_path = data.get("transcript_path", "")
    permission_mode = data.get("permission_mode", "default")

    project_name = get_project_name(cwd, transcript_path)
    state = get_state(event_name, permission_mode)
    model = data.get("model", "")
    file_key, full_session_id = get_session_id(data)

    # Estimate memory usage from transcript file size vs typical max (~2MB for most models)
    memory = 0
    if transcript_path:
        try:
            size = Path(transcript_path).stat().st_size
            # Rough heuristic: 2MB transcript ~ 100% context for typical sessions
            memory = min(100, int(size / 20000))
        except (OSError, ValueError):
            memory = 0

    debug_log(f"Event: {event_name}, State: {state}, Project: {project_name}, Session: {file_key}, Model: {model}, Memory: {memory}%")

    payload = {
        "type": "status",
        "state": state,
        "tool": tool_name,
        "project": project_name,
        "model": model,
        "memory": memory,
        "machineId": MACHINE_ID,
        "sessionId": file_key,
        "fullSessionId": full_session_id,
        "timestamp": __import__("time").time(),
    }

    send_status(payload, file_key)


if __name__ == "__main__":
    main()
    sys.exit(0)
