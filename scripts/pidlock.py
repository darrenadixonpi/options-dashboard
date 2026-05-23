#!/usr/bin/env python3
"""PID lock file helpers for launch/stop."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCK_PATH = ROOT / ".options-dashboard.lock"


def read_lock() -> dict | None:
    if not LOCK_PATH.is_file():
        return None
    text = LOCK_PATH.read_text(encoding="utf-8").strip()
    if not text:
        return None
    try:
        data = json.loads(text)
        if isinstance(data, dict) and "pid" in data:
            return data
    except json.JSONDecodeError:
        pass
    if text.isdigit():
        return {"pid": int(text), "port": 5000}
    return None


def write_lock(pid: int, port: int) -> None:
    LOCK_PATH.write_text(json.dumps({"pid": pid, "port": port}) + "\n", encoding="utf-8")


def clear_lock() -> None:
    try:
        LOCK_PATH.unlink(missing_ok=True)
    except OSError:
        pass


def is_running(pid: int) -> bool:
    if pid <= 0:
        return False
    if sys.platform == "win32":
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        result = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=flags,
        )
        return str(pid) in (result.stdout or "")
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def pids_on_port(port: int) -> list[int]:
    found: list[int] = []
    if sys.platform == "win32":
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        result = subprocess.run(
            ["netstat", "-ano"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=flags,
        )
        token = f":{port}"
        for line in (result.stdout or "").splitlines():
            upper = line.upper()
            if token not in line or "LISTENING" not in upper:
                continue
            parts = line.split()
            if not parts:
                continue
            try:
                found.append(int(parts[-1]))
            except ValueError:
                continue
    else:
        try:
            result = subprocess.run(
                ["lsof", "-ti", f":{port}"],
                capture_output=True,
                text=True,
            )
            if result.returncode == 0:
                for tok in result.stdout.replace("\n", " ").split():
                    if tok.isdigit():
                        found.append(int(tok))
        except FileNotFoundError:
            pass
    deduped: list[int] = []
    for pid in found:
        if pid not in deduped and pid != os.getpid():
            deduped.append(pid)
    return deduped
