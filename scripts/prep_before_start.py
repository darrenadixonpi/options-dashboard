#!/usr/bin/env python3
"""Install deps, build frontend, and run quick checks before starting the server."""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

VENDOR_FILES = (
    "static/vendor/chart.js/4.4.1/chart.umd.min.js",
    "static/vendor/chartjs-plugin-annotation/3.0.1/chartjs-plugin-annotation.min.js",
)


def _run(cmd: list[str], *, cwd: Path | None = None, label: str | None = None) -> None:
    title = label or " ".join(cmd)
    print(f"  -> {title}")
    run_cmd = cmd
    if cmd and cmd[0] in ("npm", "npx"):
        exe = shutil.which(cmd[0])
        if not exe:
            raise FileNotFoundError(f"{cmd[0]} not found on PATH")
        run_cmd = [exe, *cmd[1:]]
    subprocess.run(run_cmd, cwd=cwd or ROOT, check=True)


def _have_node() -> bool:
    return shutil.which("npm") is not None


def ensure_python_deps(install: bool) -> None:
    import importlib.util

    spec = importlib.util.spec_from_file_location("check_env", ROOT / "scripts" / "check_env.py")
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    if mod.run_checks() == 0:
        return
    if not install:
        raise SystemExit("Python environment check failed. Re-run start or use --install.")
    print("Installing Python dependencies...")
    req = ROOT / "requirements-dev.txt"
    if not req.is_file():
        req = ROOT / "requirements.txt"
    _run([sys.executable, "-m", "pip", "install", "-r", str(req)], label=f"pip install -r {req.name}")
    if mod.run_checks() != 0:
        raise SystemExit("Python setup failed after pip install.")


def ensure_frontend(install: bool) -> None:
    if not _have_node():
        bundle = ROOT / "static" / "dist" / "app.bundle.js"
        if bundle.is_file():
            print("  (Node/npm not found — using existing frontend bundle)")
            return
        print("WARNING: npm not found and no app.bundle.js — charts may fail.", file=sys.stderr)
        return

    if install or not (ROOT / "node_modules").is_dir():
        _run(["npm", "install"], label="npm install")

    missing_vendor = [rel for rel in VENDOR_FILES if not (ROOT / rel).is_file()]
    if missing_vendor:
        _run(["npm", "run", "vendor:charts"], label="npm run vendor:charts")

    _run(["npm", "run", "build"], label="npm run build")


def run_checks(*, full: bool) -> None:
    if not _have_node():
        print("  (skipping typecheck — npm not available)")
    else:
        _run(["npm", "run", "typecheck"], label="npm run typecheck")
        _run(["npm", "run", "typecheck:pilot"], label="npm run typecheck:pilot")

    _run([sys.executable, "-m", "pytest", "tests/", "-q"], label="pytest tests/")

    if full:
        if not _have_node():
            print("  (skipping e2e — npm not available)")
        else:
            _run(["npm", "run", "test:e2e"], label="npm run test:e2e")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Prepare Options Dashboard before launch.")
    parser.add_argument("--skip-checks", action="store_true", help="Only install/build; skip typecheck and tests")
    parser.add_argument("--full", action="store_true", help="Also run Playwright e2e tests (slower)")
    parser.add_argument("--no-install", action="store_true", help="Do not pip/npm install; fail if deps missing")
    args = parser.parse_args(argv)

    if os.environ.get("OD_SKIP_PREP", "").lower() in ("1", "true", "yes"):
        print("Prep skipped (OD_SKIP_PREP set).")
        return 0

    print("Preparing Options Dashboard...")
    try:
        ensure_python_deps(install=not args.no_install)
        ensure_frontend(install=not args.no_install)
        if not args.skip_checks:
            run_checks(full=args.full or os.environ.get("OD_FULL_PREP", "").lower() in ("1", "true", "yes"))
    except subprocess.CalledProcessError as exc:
        print(f"Prep failed (exit {exc.returncode}).", file=sys.stderr)
        return exc.returncode or 1

    print("Prep OK.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
