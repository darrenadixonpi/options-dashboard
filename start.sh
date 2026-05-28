#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo "============================================"
echo "  Options Dashboard - Starting..."
echo "============================================"
echo ""

PYTHON="python3"
if [ -x ".venv/bin/python" ]; then
  PYTHON=".venv/bin/python"
fi

if ! command -v "$PYTHON" >/dev/null 2>&1 && [ ! -x ".venv/bin/python" ]; then
  echo "ERROR: Python 3 not found. Install from python.org"
  echo "       Or run: bash scripts/setup.sh"
  exit 1
fi

if ! "$PYTHON" scripts/prep_before_start.py; then
  echo "Prep failed. Try: bash scripts/setup.sh"
  echo "Or fast start: OD_SKIP_PREP=1 ./start.sh"
  exit 1
fi
echo ""
echo "  Stop later: ./stop.sh  (or Ctrl+C in this window)"
echo "  Closing the browser does NOT stop the server."
echo ""

exec "$PYTHON" scripts/launch.py "$@"
