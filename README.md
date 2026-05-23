# Options Dashboard

**v1.0.0** — Local web app for visualizing your options portfolio with live market data, Greeks, Monte Carlo simulation, and trade journal.

> **Scope:** Personal desk tool (localhost). Fidelity is the production-validated path. Schwab and IBKR parsers ship with fixture tests; live CSV validation is recommended before relying on them. See [CHANGELOG.md](CHANGELOG.md) and limitations below.

## Quick start (single click)

**First time (recommended):** create a virtual environment and install deps once.

| Platform | Setup | Run |
|----------|-------|-----|
| **Windows** | `powershell -ExecutionPolicy Bypass -File scripts\setup.ps1` | double-click `start.bat` |
| **macOS / Linux** | `bash scripts/setup.sh` | `./start.sh` |

`start.bat` / `start.sh` verify Python + dependencies, pick `.venv` if present, check that port 5000 is free, open the browser, and start the server at **http://localhost:5000**.

### CLI options

```bash
python scripts/launch.py              # default: localhost:5000 + browser
python scripts/launch.py --port 8080  # custom port
python scripts/launch.py --no-browser # headless / server mode
python scripts/check_env.py --check-port  # verify env + port only
```

Environment overrides (see `.env.example`):

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `5000` | Listen port |
| `FLASK_DEBUG` | `1` locally, `0` in Docker | Flask debug/reloader |
| `PORTFOLIO_DB` | `./portfolio.db` | SQLite path |

Manual start:

```bash
pip install -r requirements.txt
python scripts/check_env.py
python scripts/launch.py
```

## Tests

```bash
python -m pytest tests/test_smoke.py -v
```

Smoke tests cover OCC/history parsing, FIFO lot matching, `/api/trade-history`, `/api/greeks`, correlation matrix logic, packaging checks, and broker fixtures (**29 tests**).

## How it works

1. **Import** portfolio (+ optional history) CSV from Fidelity, Schwab, or IBKR Flex
2. **Fetch** live prices, IV, greeks, and option marks
3. Use **Positions · Risk · Simulation · Journal** tabs for desk workflow

## Project layout

```
options-app-final/
├── app.py                 # Flask API + Yahoo Finance
├── requirements.txt
├── start.bat / start.sh   # One-click run (uses scripts/launch.py)
├── stop.bat / stop.sh     # Hard-stop server on port 5000
├── scripts/
│   ├── check_env.py       # Python + dependency + layout verifier
│   ├── launch.py          # Env check, port check, browser, server
│   ├── setup.ps1 / setup.sh
│   └── build_exe.ps1      # Optional Windows portable build
├── Dockerfile             # Container deploy
├── docker-compose.yml
├── options-dashboard.spec # PyInstaller spec (optional .exe)
├── package.json           # Optional frontend bundle (esbuild)
├── static/
│   ├── index.html
│   ├── css/app.css
│   └── js/                # Ordered classic modules (see static/js/README.md)
└── tools/
    ├── build_frontend.mjs   # esbuild bundle + watch
    ├── frontend-manifest.mjs
    ├── frontend_scripts.py  # index.html script block helpers
    ├── split_frontend.py
    └── rebuild_index.py
```

## Docker

Run without installing Python locally. **Full guide:** [DOCKER.md](DOCKER.md)

```bash
touch portfolio.db          # create empty DB file before first run (see guide)
docker compose up --build   # foreground
docker compose up -d        # background
```

Open **http://localhost:5000**. Data persists in `portfolio.db` in the project root.

Release: **v1.0.0** — see [CHANGELOG.md](CHANGELOG.md).

## Optional Windows portable (.exe)

For sharing with non-Python users on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build_exe.ps1
dist\OptionsDashboard\OptionsDashboard.exe --no-browser
```

`portfolio.db` is created next to the `.exe`. First launch may take a few seconds while dependencies unpack.

## Frontend bundle (#7)

**Dev (default):** `index.html` loads 12 individual scripts — no build step, instant refresh.

**Production bundle** (esbuild IIFE, shared global scope preserved):

```bash
npm install
npm run build          # → static/dist/app.bundle.js + manifest.json
npm run build:watch    # rebuild on save (dev: sourcemaps, no minify)
npm run build:prod     # minified build + patch index.html to bundle mode
```

| Command | Purpose |
|---------|---------|
| `npm run index:bundle` | Point index.html at the bundle (after `npm run build`) |
| `npm run index:modules` | Restore individual script tags |
| `USE_JS_BUNDLE=1` | Flask serves bundle **without** editing index.html (Docker uses this) |

Module order lives in `tools/frontend-manifest.mjs`. See `static/js/README.md`.

## Brokers

| Broker | Positions | History | Status |
|--------|-----------|---------|--------|
| **Fidelity** | ✓ | ✓ | **Validated** (primary v1.0 path) |
| **Schwab** | ✓ | ✓ | Experimental — fixture tests pass |
| **IBKR** | ✓ Flex | ✓ Flex | Experimental — fixture tests pass |

Parsers: `static/js/01-parsers.js` + backend `/api/trade-history`. Unknown formats show a hint instead of silent failure.

## Known limitations (v1.0)

- **Yahoo Finance** — Live prices/IV/marks; subject to rate limits and missing chains
- **Local only** — No login, no HTTPS, no multi-user; do not expose to the public internet
- **Journal** — Strategy labels work well for single-leg and same-day spreads; complex multi-day structures may appear as leg-level names
- **Auto-refresh** — Updates spot, marks, and greeks only; full **Fetch** still required for sim, risk matrix, attribution, and events
- **Session data** — Uploaded CSVs live in browser localStorage; `portfolio.db` stores server snapshots from fetches

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `1`–`4` | Switch tabs |
| `/` | Jump to ticker (Simulation tab → fan chart; elsewhere → Positions) |
| `r` | Refresh option marks |

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Port 5000 in use | `python scripts/stop.py` or double-click `stop.bat`; or `python scripts/launch.py --port 8080` |
| Server still running after closing browser | Expected — run `stop.bat` or `Ctrl+C` in the server window |
| Server stuck after closing CMD | Run `stop.bat`; re-start with `start.bat` (reloader disabled by default on Windows) |
| Missing packages | `pip install -r requirements.txt` or run setup script |
| Python not found | Install 3.10+ from [python.org](https://python.org) and re-run setup |
| Docker issues | See [DOCKER.md](DOCKER.md) — port conflicts, `portfolio.db` mount, rebuild |

See [DOCKET.md](DOCKET.md) for backlog, [CHANGELOG.md](CHANGELOG.md) for releases, and [GITHUB.md](GITHUB.md) to publish on GitHub.
