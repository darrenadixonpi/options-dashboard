# Changelog

All notable releases of Options Dashboard.

## [1.1.0] — 2026-05-22

Modernization (Phases 1–3) plus Simulation and chart UX improvements.

### Phase 1 — API contracts & tooling

- **Pydantic schemas** — `api_schemas.py` validates `/api/simulate` and `/api/greeks` responses
- **Pinned dependencies** — upper bounds in `requirements.txt`; `requirements-dev.txt` adds `pip-audit`
- **Vendored Chart.js** — local copies under `static/vendor/` (no CDN at runtime)
- **Playwright E2E** — `e2e/simulate-charts.spec.js` (P&L histogram, theta chart, vendored JS)
- **CI** — `pip-audit`, frontend build, typecheck, pytest, and E2E jobs

### Phase 2 — Shared types

- **`static/js/types.ts`** — `SimulateResult`, `ThetaData`, `AppState`, etc.
- **`npm run typecheck`** — compile-time checks on shared type definitions

### Phase 3 — TypeScript pilot

- **Source of truth:** `05-session-api.ts`, `08-simulate.ts` (esbuild emits dev `.js`; generated files gitignored)
- **`npm run typecheck:pilot`** — typecheck for TS modules
- **Build pipeline** — `tools/build_frontend.mjs` resolves `.ts` over `.js`, tracks `tsModules` in manifest

### Simulation & chart UX

- **Chart crosshair** — vertical/horizontal follow-along tooltips via `03-chart-utils.js`
- **Sticky sim summary** — jump nav + P(Profit) / Mean / Median / P5–P95 always visible while scrolling
- **Fan charts** — sticky left ticker nav; dynamic strike/BE label layout; bulk PNG export fix
- **Combined P(profit)** — per-ticker book view (all legs); expiry-slice toggle; sim strategy grouping aligned with portfolio UI
- **Portfolio P&L histogram** — scroll/drag updates dollar range and re-bins paths (syncs with Range slider)
- **Journal** — assignment rollup rows filter in-place instead of jumping to Positions

### Packaging

- **`scripts/prep_before_start.py`** — `start.bat` / `start.sh` run deps, `npm run build`, typecheck, and pytest before launch (`OD_SKIP_PREP=1` to skip)

### Tests

- `pytest` — **40** tests (includes `tests/test_api_schemas.py`, strategy-map smoke)
- `npm run test:e2e` — 3 Playwright tests

---

## [1.0.0] — 2026-05-22

First baseline release for local desk use.

### Features

- **Positions** — CSV import (Fidelity primary; Schwab/IBKR parsers included), live Yahoo marks, greeks strip, P&L attribution, what-if legs, roll analyzer, desk alerts rail
- **Risk** — Scenario matrix (up to 2y forward), vol surface, unusual activity, correlation heatmap
- **Simulation** — Correlated Monte Carlo, fan charts, focus/collapse, ticker jump from Positions or `/`
- **Journal** — Closed-trade history, strategy filters, Sortino/Sharpe, roll rows, snapshot history, MTM book metrics
- **Alerts v2** — DTE, IVR, ex-div, greeks (book + ticker), sim P(profit), stale marks; dismiss + threshold panel + event log
- **Auto-refresh** — Optional 5/10/15m spot + marks + greeks refresh (pauses when tab hidden)
- **Export** — CSV and PNG on charts/tables
- **Packaging** — `start.bat` / `start.sh`, Docker ([DOCKER.md](DOCKER.md)), optional PyInstaller `.exe`, esbuild bundle

### Known limitations (v1.0)

- **Fidelity** — Production-validated workflow
- **Schwab / IBKR** — CSV parsers + fixture tests; Schwab API sync planned v1.2 ([docs/SCHWAB_API.md](docs/SCHWAB_API.md))
- **Journal strategies** — Same-day spread grouping; complex multi-day structures may show as single-leg labels
- **Data** — Yahoo Finance (rate limits, no broker API yet); local-only, no auth
- **Auto-refresh** — Does not re-run simulation, risk matrix, or attribution snapshots

### Tests

- `pytest tests/test_smoke.py` — 29 smoke tests (parsers, APIs, packaging, bundle)
