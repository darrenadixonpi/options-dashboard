#!/usr/bin/env python3
"""Start the Options Dashboard with env checks, port selection, and optional browser open."""
from __future__ import annotations

import argparse
import atexit
import os
import sys
import threading
import time
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.pidlock import clear_lock, is_running, read_lock, write_lock  # noqa: E402


def _load_check_env():
    import importlib.util

    path = ROOT / "scripts" / "check_env.py"
    spec = importlib.util.spec_from_file_location("check_env", path)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _open_browser(url: str, delay: float) -> None:
    time.sleep(delay)
    try:
        webbrowser.open(url)
    except OSError:
        pass


def _ensure_lock(port: int, force: bool) -> bool:
    lock = read_lock()
    if lock and is_running(int(lock.get("pid") or 0)):
        if force:
            import subprocess

            subprocess.run(
                [sys.executable, str(ROOT / "scripts" / "stop.py"), "--port", str(port)],
                check=False,
            )
        else:
            pid = lock.get("pid")
            print(f"Server already running (PID {pid}, port {lock.get('port', port)})")
            print("Run stop.bat / python scripts/stop.py — or start with --force")
            return False
    clear_lock()
    write_lock(os.getpid(), port)
    atexit.register(clear_lock)
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Launch Options Dashboard.")
    parser.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "5000")))
    parser.add_argument("--no-browser", action="store_true", help="Do not open a browser tab")
    parser.add_argument("--skip-check", action="store_true", help="Skip environment verification")
    parser.add_argument("--force", action="store_true", help="Stop existing server on this port before starting")
    parser.add_argument(
        "--reload",
        action="store_true",
        help="Enable Flask auto-reloader (dev only; can orphan processes on Windows)",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        default=None,
        help="Force Flask debug mode (default: on for localhost, off for 0.0.0.0)",
    )
    args = parser.parse_args(argv)

    if not args.skip_check:
        code = _load_check_env().run_checks(check_port_flag=not args.force, port=args.port, host=args.host)
        if code != 0 and not args.force:
            return code

    if not _ensure_lock(args.port, args.force):
        return 1

    os.environ.setdefault("HOST", args.host)
    os.environ.setdefault("PORT", str(args.port))
    if args.debug is not None:
        os.environ["FLASK_DEBUG"] = "1" if args.debug else "0"
    elif "FLASK_DEBUG" not in os.environ:
        os.environ["FLASK_DEBUG"] = "0" if args.host in ("0.0.0.0", "::") else "1"

    url = f"http://{args.host if args.host not in ('0.0.0.0', '::') else 'localhost'}:{args.port}"
    if not args.no_browser and args.host in ("127.0.0.1", "localhost", "0.0.0.0", "::"):
        threading.Thread(target=_open_browser, args=(url, 2.0), daemon=True).start()

    print("=" * 50)
    print("  Options Dashboard")
    print(f"  Open {url}")
    print("  Stop: Ctrl+C here, or run stop.bat / python scripts/stop.py")
    print("  Note: closing the browser tab does NOT stop the server.")
    print("=" * 50)

    from app import app  # noqa: WPS433

    debug = os.environ.get("FLASK_DEBUG", "1").lower() in ("1", "true", "yes")
    use_reloader = bool(args.reload and debug)
    app.run(debug=debug, host=args.host, port=args.port, use_reloader=use_reloader)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
