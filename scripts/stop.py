#!/usr/bin/env python3
"""Hard-stop the Options Dashboard server (pid lock + port fallback)."""
from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.pidlock import clear_lock, is_running, pids_on_port, read_lock  # noqa: E402


def kill_pid(pid: int) -> bool:
    if not is_running(pid):
        return False
    try:
        if sys.platform == "win32":
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                check=False,
                creationflags=flags,
            )
        else:
            os.kill(pid, signal.SIGTERM)
        return True
    except OSError:
        return False


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Stop Options Dashboard server.")
    parser.add_argument("--port", type=int, default=None, help="Port to scan if lock file missing")
    args = parser.parse_args(argv)

    lock = read_lock()
    port = args.port or (lock.get("port") if lock else 5000)
    killed: list[int] = []

    if lock:
        pid = int(lock.get("pid") or 0)
        if pid and kill_pid(pid):
            killed.append(pid)
        clear_lock()

    for pid in pids_on_port(port):
        if pid in killed:
            continue
        if kill_pid(pid):
            killed.append(pid)

    if killed:
        print(f"Stopped server (PID {', '.join(map(str, killed))}, port {port})")
        return 0

    print(f"No server listening on port {port}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
