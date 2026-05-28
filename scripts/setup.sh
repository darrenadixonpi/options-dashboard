#!/usr/bin/env bash
# First-time setup: create .venv and install dependencies (macOS/Linux).
set -euo pipefail
cd "$(dirname "$0")/.."

echo "============================================"
echo "  Options Dashboard - Setup"
echo "============================================"
echo ""

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: Python 3 not found. Install Python 3.10+ from python.org"
  exit 1
fi

if [ ! -d .venv ]; then
  echo "Creating virtual environment (.venv)..."
  python3 -m venv .venv
fi

PY=".venv/bin/python"
echo "Installing dependencies..."
"$PY" -m pip install --upgrade pip
"$PY" -m pip install -r requirements-dev.txt

echo ""
"$PY" scripts/check_env.py

if command -v npm >/dev/null 2>&1; then
  echo ""
  echo "Installing frontend tooling..."
  npm install
  npm run vendor:charts
  npm run build
fi

echo ""
echo "Setup complete. Run ./start.sh or:"
echo "  .venv/bin/python scripts/launch.py"
