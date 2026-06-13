# Options Dashboard

**v1.2.0** — Local web app for your options portfolio: live market data, Greeks, Monte Carlo simulation, order & rules management, tax lots, VaR, a trade journal, and broker position sync.

> **Scope:** Personal desk tool (localhost). Fidelity is the production-validated path. Schwab and IBKR parse via CSV (fixture-tested); the Schwab OAuth API client is built and activates once developer-app credentials are approved — see [docs/SCHWAB_API.md](docs/SCHWAB_API.md). All brokers share one adapter layer (`brokers/`).

## Documentation

| Doc | Use when you need… |
|-----|---------------------|
| **This file** | Install, run, stop server, Docker, brokers |
| [DOCKET.md](DOCKET.md) | Roadmap, backlog, release checklist, moving the project |
| [docs/SCHWAB_API.md](docs/SCHWAB_API.md) | Schwab developer app registration + v1.2 API plan |
| [docs/IBKR_API.md](docs/IBKR_API.md) | IBKR Flex Web Service integration plan |
| [TECHNICAL_EXPLAINER.md](TECHNICAL_EXPLAINER.md) | BSM, greeks, Monte Carlo, journal math |
| [CHANGELOG.md](CHANGELOG.md) | What changed per release |
| [GITHUB.md](GITHUB.md) | Publish to GitHub (no password in chat — use token/`gh auth`) |
| [DOCKER.md](DOCKER.md) | Container deploy |

## Quick start (single click)

**First time (recommended):** create a virtual environment and install deps once.

| Platform | Setup | Run |
|----------|-------|-----|
| **Windows** | `powershell -ExecutionPolicy Bypass -File scripts\setup.ps1` | double-click `start.bat` |
| **macOS / Linux** | `bash scripts/setup.sh` | `./start.sh` |

`start.bat` / `start.sh` verify Python + dependencies, run **`scripts/prep_before_start.py`** (build frontend, typecheck, pytest — skip with `OD_SKIP_PREP=1`), pick `.venv` if present, check that port 5000 is free, open the browser, and start the server at **http://localhost:5000**.

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
| `OD_SKIP_PREP` | unset | Set to `1` to skip prep (build/checks) on start |
| `OD_FULL_PREP` | unset | Set to `1` to include Playwright e2e in prep |

Manual start:

```bash
pip install -r requirements-dev.txt
python scripts/prep_before_start.py   # or OD_SKIP_PREP=1 to skip
python scripts/launch.py
```

## Tests

```bash
pip install -r requirements-dev.txt
npm install
npm run build
python -m pytest tests/ -q          # 40 tests
npm run typecheck                   # shared types
npm run typecheck:pilot             # TS pilot modules
npm run test:e2e                    # Playwright (optional)
```

Smoke tests cover parsers, APIs, Pydantic schemas, packaging, and broker fixtures.

## How it works

1. **Import** portfolio (+ optional history) CSV from Fidelity, Schwab, or IBKR Flex
2. **Fetch** live prices, IV, greeks, and option marks
3. Use **Positions · Risk · Simulation · Journal** tabs for desk workflow

## Project layout

```
options-app/
├── app.py                 # Flask API + Yahoo Finance
├── api_schemas.py         # Pydantic response validation (simulate, greeks)
├── requirements.txt
├── requirements-dev.txt   # pytest, pip-audit, dev deps
├── start.bat / start.sh   # One-click run (includes prep)
├── stop.bat / stop.sh     # Hard-stop server
├── scripts/               # launch, stop, setup, prep_before_start, check_env
├── e2e/                   # Playwright chart tests
├── Dockerfile / docker-compose.yml
├── static/                # index.html, css/, js/ (14 runtime modules + TS pilot)
├── brokers/               # Multi-broker adapter layer (Schwab API, Fidelity/IBKR CSV)
├── tests/                 # Smoke + API schema tests + CSV fixtures
├── docs/                  # SCHWAB_API.md, archive/
└── tools/                 # Frontend bundle + vendor scripts
```

## Docker

Run without installing Python locally. **Full guide:** [DOCKER.md](DOCKER.md)

```bash
touch portfolio.db          # create empty DB file before first run (see guide)
docker compose up --build   # foreground
docker compose up -d        # background
```

Open **http://localhost:5000**. Data persists in `portfolio.db` in the project root.

Release: **v1.2.0** — see [CHANGELOG.md](CHANGELOG.md).

## Optional Windows portable (.exe)

For sharing with non-Python users on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build_exe.ps1
dist\OptionsDashboard\OptionsDashboard.exe --no-browser
```

`portfolio.db` is created next to the `.exe`. First launch may take a few seconds while dependencies unpack.

## Frontend bundle (#7)

**Dev (default):** `index.html` loads 14 individual scripts. TypeScript pilot modules (`05-session-api.ts`, `08-simulate.ts`) require **`npm run build`** to emit dev `.js` files — `start.bat` does this automatically.

**Production bundle** (esbuild IIFE, shared global scope preserved):

```bash
npm install
npm run build          # transpile TS + static/dist/app.bundle.js + manifest.json
npm run build:watch    # rebuild on save (dev: sourcemaps, no minify)
npm run build:prod     # minified build + patch index.html to bundle mode
```

| Command | Purpose |
|---------|---------|
| `npm run typecheck` | Check shared types (`types.ts`) |
| `npm run typecheck:pilot` | Check TS pilot modules |
| `npm run test:e2e` | Playwright simulate/theta chart tests |
| `npm run vendor:charts` | Re-download vendored Chart.js |
| `npm run index:bundle` | Point index.html at the bundle (after `npm run build`) |
| `npm run index:modules` | Restore individual script tags |
| `USE_JS_BUNDLE=1` | Flask serves bundle **without** editing index.html (Docker uses this) |

Module order lives in `tools/frontend-manifest.mjs`. See `static/js/README.md`.

## Brokers

| Broker | Positions | History | Status |
|--------|-----------|---------|--------|
| **Fidelity** | ✓ | ✓ | **Validated** (primary v1.0 path) |
| **Schwab** | ✓ | ✓ | CSV (fixtures); **OAuth API client built** — activate with credentials ([docs/SCHWAB_API.md](docs/SCHWAB_API.md)) |
| **IBKR** | ✓ Flex | ✓ Flex | CSV (fixtures) + **Flex Web Service API sync** — [docs/IBKR_API.md](docs/IBKR_API.md) |

All brokers share one adapter layer: `brokers/` (`GET /api/brokers`, `POST /api/brokers/<key>/positions`) — see [brokers/README.md](brokers/README.md). CSV parsers: `static/js/01-parsers.js` + backend `/api/trade-history`. Unknown formats show a hint instead of silent failure.

## Backend API (quick reference)

All routes are on `http://localhost:5000` by default.

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/api/version` | `{"name":"options-dashboard","version":"1.2.0"}` |
| `GET` | `/api/brokers` | List brokers + capabilities; `POST /api/brokers/<key>/positions` to import/sync |
| `POST` | `/api/market-data` | Prices + IV for a list of tickers |
| `POST` | `/api/greeks` | BSM greeks + beta-weighted delta |
| `POST` | `/api/simulate` | Monte Carlo simulation (GBM or Merton) |
| `POST` | `/api/events` | Earnings + dividend dates |
| `POST` | `/api/trade-history` | Parse trade history CSV |
| `POST` | `/api/roll-analysis` | Roll candidate scoring |
| `GET/POST` | `/api/catalysts` | Custom catalyst CRUD |
| `POST` | `/api/snapshots/book` | Save book snapshot |
| `GET` | `/api/snapshots/history` | Snapshot history |

Full schema validation on `/api/simulate` and `/api/greeks` responses via `api_schemas.py` (Pydantic v2).

## Known limitations

- **Yahoo Finance** — Live prices/IV/marks; subject to rate limits and missing chains
- **Local only** — No login, no HTTPS, no multi-user; do not expose to the public internet
- **Journal** — Strategy labels work well for single-leg and same-day spreads; complex multi-day structures may appear as leg-level names
- **Auto-refresh** — Updates spot, marks, and greeks only; full **Fetch** still required for sim, risk matrix, attribution, and events
- **Session data** — Uploaded CSVs live in browser localStorage; `portfolio.db` stores server snapshots from fetches
- **TypeScript** — Pilot only (`05-session-api`, `08-simulate`); remaining modules are JavaScript — see [DOCKET.md](DOCKET.md) Phase 3 remainder
- **Schwab API** — OAuth client built (Phase 6); live sync activates once developer-app credentials are approved — see [docs/SCHWAB_API.md](docs/SCHWAB_API.md)

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
| Missing packages | `pip install -r requirements-dev.txt` or run setup script |
| Prep slow on every start | `set OD_SKIP_PREP=1` then `start.bat` (run `npm run build` manually after TS edits) |
| Python not found | Install 3.10+ from [python.org](https://python.org) and re-run setup |
| Docker issues | See [DOCKER.md](DOCKER.md) — port conflicts, `portfolio.db` mount, rebuild |

See [DOCKET.md](DOCKET.md) for the roadmap.
