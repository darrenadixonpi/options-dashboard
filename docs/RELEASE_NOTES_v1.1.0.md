# Options Dashboard v1.1.0

**Local options portfolio tracker** — fetch live IV + greeks, run Monte Carlo simulation, track your trade journal, and get automated desk alerts.

## What's new in v1.1.0

### Simulation & chart UX
- **Sticky sim summary bar** — P(Profit) / Mean / Median / P5–P95 always visible while scrolling through fan charts
- **Portfolio P&L histogram** — scroll/drag to pan and zoom the dollar range; syncs with the Range slider
- **Fan chart improvements** — sticky left ticker nav, dynamic strike/BE label layout, bulk PNG export fix
- **Combined P(profit)** — per-ticker book view (all legs); expiry-slice toggle
- **Chart crosshair** — follow-along vertical/horizontal tooltips on all charts
- **Journal** — assignment rollup rows filter in-place without jumping tabs

### Phase 1 — API contracts & tooling
- **Pydantic schemas** — `api_schemas.py` validates `/api/simulate` and `/api/greeks` responses at runtime
- **Vendored Chart.js** — local copy under `static/vendor/` — no CDN dependency at runtime
- **Pinned dependencies** — upper bounds in `requirements.txt`; `pip-audit` in CI
- **Playwright E2E** — smoke tests for P&L histogram, theta chart, vendored JS

### Phase 2 — Shared TypeScript types
- `static/js/types.ts` — `SimulateResult`, `ThetaData`, `AppState`, and more
- `npm run typecheck` — compile-time checks on shared type definitions

### Phase 3 — TypeScript pilot
- `05-session-api.ts` and `08-simulate.ts` are now TypeScript source-of-truth modules
- `npm run typecheck:pilot` — incremental TS checking on pilot modules
- esbuild pipeline emits `.js` at build time; generated files are gitignored

### CI
- GitHub Actions: `pip-audit`, frontend build, typecheck, pytest (40 tests), and Playwright E2E jobs

### Packaging
- `scripts/prep_before_start.py` — `start.bat` / `start.sh` run build + typecheck + pytest before launch
- `OD_SKIP_PREP=1` env var to bypass prep during rapid iteration

## Installing / running

```powershell
git clone https://github.com/darrenadixonpi/options-dashboard.git
cd options-dashboard
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
npm install
start.bat
```

Open `http://127.0.0.1:5000` in your browser.

## Requirements
- Python 3.10+
- Node 18+
- Windows or macOS/Linux (start.bat / start.sh)

## Known limitations
- Market data via Yahoo Finance — subject to rate limits and availability
- Broker CSV imports: Fidelity (validated), Schwab + IBKR (fixture-tested; live CSV validation deferred)
- No multi-user auth — local use only
