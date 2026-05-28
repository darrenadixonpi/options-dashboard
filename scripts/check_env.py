#!/usr/bin/env python3
"""Verify Python version, dependencies, and project layout before starting."""
from __future__ import annotations

import argparse
import socket
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIN_PYTHON = (3, 10)
REQUIRED = ("flask", "yfinance", "numpy", "pandas", "scipy", "pydantic")
REQUIRED_PATHS = (
    "app.py",
    "api_schemas.py",
    "static/index.html",
    "static/css/app.css",
    "static/js/01-parsers.js",
    "static/vendor/chart.js/4.4.1/chart.umd.min.js",
    "static/vendor/chartjs-plugin-annotation/3.0.1/chartjs-plugin-annotation.min.js",
)


def port_in_use(port: int, host: str = "127.0.0.1") -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex((host, port)) == 0


def check_python() -> list[str]:
    if sys.version_info < MIN_PYTHON:
        return [
            f"Python {MIN_PYTHON[0]}.{MIN_PYTHON[1]}+ required "
            f"(found {sys.version.split()[0]})"
        ]
    return []


def check_packages() -> list[str]:
    missing = []
    for pkg in REQUIRED:
        try:
            __import__(pkg)
        except ImportError:
            missing.append(pkg)
    if missing:
        return [f"Missing packages: {', '.join(missing)}"]
    return []


def check_layout() -> list[str]:
    missing = [rel for rel in REQUIRED_PATHS if not (ROOT / rel).is_file()]
    if missing:
        return [f"Missing project files: {', '.join(missing)}"]
    return []


def check_port(port: int, host: str = "127.0.0.1") -> list[str]:
    if port_in_use(port, host):
        return [
            f"Port {port} is already in use on {host}. "
            "Stop the other process or run with --port <n>."
        ]
    return []


def run_checks(*, check_port_flag: bool = False, port: int = 5000, host: str = "127.0.0.1") -> int:
    errors = []
    errors.extend(check_python())
    errors.extend(check_layout())
    errors.extend(check_packages())
    if check_port_flag:
        errors.extend(check_port(port, host))

    if errors:
        for err in errors:
            print(f"ERROR: {err}", file=sys.stderr)
        print("Fix: pip install -r requirements-dev.txt", file=sys.stderr)
        print("Or run scripts/setup.ps1 (Windows) / scripts/setup.sh (macOS/Linux) once.", file=sys.stderr)
        return 1

    print("Environment OK — Python", sys.version.split()[0])
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Verify Options Dashboard runtime environment.")
    parser.add_argument("--port", type=int, default=5000, help="Port to verify is free")
    parser.add_argument("--host", default="127.0.0.1", help="Host for port check")
    parser.add_argument("--check-port", action="store_true", help="Fail if the port is already in use")
    args = parser.parse_args(argv)
    return run_checks(check_port_flag=args.check_port, port=args.port, host=args.host)


if __name__ == "__main__":
    raise SystemExit(main())
