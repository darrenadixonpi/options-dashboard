# Changelog

All notable releases of Options Dashboard.

## [Unreleased] — Phase 5 in progress

### Background refresh

- **Server-side auto-refresh** — daemon thread refreshes the last-watched ticker set every `BG_REFRESH_INTERVAL_MIN` minutes (default 5; set to `0` to disable). Tickers are registered automatically on any `/api/market-data` POST.
- **`GET /api/market-data/cached`** — returns the most-recent background result plus `updated_at` timestamp; returns 204 if no background refresh has run yet.
- **Frontend badge** — polls `/api/market-data/cached` every 60s; shows a clickable "↻ refreshed Xm ago" badge near the Fetch button when the server has data newer than the last manual fetch. Clicking the badge merges the fresh data into state and re-renders.

### Resilience

- **yfinance retry** — all yfinance calls go through `_yf_call()`: exponential-backoff retry up to `YF_RETRY_COUNT` attempts (default 3); initial wait `YF_RETRY_BACKOFF` seconds (default 1.5, doubles per attempt). Env-overridable.
- **Per-ticker isolation** — a failing ticker in `/api/market-data` no longer silently returns `None` forever; after retries exhausted it falls back to the most-recent DB snapshot price and sets `_stale: true` so the UI can indicate staleness.
- **Rate-limit token bucket** — in-process leaky bucket limits yfinance calls to `YF_RATE_LIMIT_PER_MIN` (default 30/min); excess callers block rather than hit Yahoo's soft limits. Set to `0` to disable.

---

## [Unreleased] — Phase 4 in progress

### Bug fixes

- **Fractional strike parsing** — OCC symbols with Fidelity decimal notation (e.g. `-OVID260618P2.5`) now correctly parse strike=2.5 instead of truncating to 2.0
- **yfinance calendar API** — `tk.calendar` returns a `dict` in yfinance ≥0.2.x; `_calendar_field()` helper handles both dict and legacy DataFrame forms so dividend and earnings dates are no longer silently `None`
- **`RISK_FREE`** — now env-overridable (`RISK_FREE=0.037` in `.env`); default updated from 0.043 to 0.037 to match current T-bill rate

### Performance

- **Beta cache** — `/api/greeks` caches per-ticker beta (6 h TTL) and SPY history (15 min TTL); reduces yfinance calls from N+1 per refresh to 0 on cache hit
- **DB retention** — `init_db()` prunes `snapshots` and `alert_events` older than `SNAPSHOT_RETENTION_DAYS` (default 180) on startup; set to `0` to disable

### API

- **`GET /api/version`** — returns `{"name": "options-dashboard", "version": "1.1.0"}`; reads from `VERSION` file

### UX

- **Position table sort** — A–Z (default), nearest DTE, highest |Δ| (requires greeks), highest IV (requires market data); sort persists across re-fetches
- **Ticker filter** — text input above positions table; filters by ticker prefix; Escape clears
- **Loading spinners** — CSS `od-spin` animation on Fetch and Simulate buttons during async operations; subtle pulse overlay on dashboard while re-fetching

### Dev / test

- **Test DB isolation** — `tests/conftest.py` creates a temp DB before `import app` so pytest never writes to the live `portfolio.db`
- **Regression tests** — `test_parse_occ_symbol_fractional_strike`, `test_calendar_field_dict_and_dataframe`
- **Prep script parity** — `scripts/prep_before_start.py` now runs `npm run typecheck:pilot` to match CI

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
