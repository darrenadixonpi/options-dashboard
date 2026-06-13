# Changelog

All notable releases of Options Dashboard.

## [Unreleased] — Phase 7 in progress

### TypeScript pass 2 (Phase 3)
- **Removed `@ts-nocheck`** from `05-session-api.ts` and `08-simulate.ts` — both pilot modules now fully type-checked
- **`types.ts` additions** — `TickerPathData`, `WhatIfGreeksResult`, `AttributionData` interfaces; `SESSION_KEY`, `DEFAULT_ALERT_THRESHOLDS`, `autoRefreshTimer`, and missing function declarations added to `declare global`; `FetchJsonResult.data` typed as `any` (intentional — each endpoint returns a different shape)
- **DOM narrowing** — `getElementById` results cast to `HTMLButtonElement | null`, `HTMLInputElement | null`, `HTMLSelectElement | null` at every call site; `querySelectorAll` results cast via local `el as HTMLElement` before `.dataset` access; `EventTarget` narrowed to `HTMLElement` before `.closest()` calls
- **`typecheck:pilot` passes at 0 errors**; `npm run build` emits clean bundle

### Order management (7.2)
- **`GET/POST /api/orders`** — create and list draft orders with ticker, strategy label, legs JSON, and notes
- **`PUT/DELETE /api/orders/<id>`** — update or delete an order
- **`POST /api/orders/<id>/submit`** — stage order (marks as `staged`; broker execution is manual)
- **Orders tab** — new 5th tab in the UI with draft order list, stage button, and new-order form; legs auto-populated from current what-if builder
- **Keyboard shortcut `5`** — jump to Orders tab

### Rules engine (7.3)
- **`GET/POST /api/alert-rules`** — DB-backed alert rules (condition type, ticker, threshold, enabled flag)
- **`PUT/DELETE /api/alert-rules/<id>`** — update or delete rules
- **`POST /api/alert-rules/evaluate`** — evaluate all enabled rules against current market data + greeks + sim result; returns triggered rules
- **Alert rules panel** in the Alerts rail — add/toggle/delete rules inline; conditions include Δ, Θ, IV, P(profit), DTE, VaR
- Auto-evaluation on every market data fetch (5s debounce)

### Strategy templates (7.4)
- **`GET/POST /api/strategy-templates`** — save and list named leg configurations
- **`DELETE /api/strategy-templates/<id>`** — remove a template
- **Strategy Templates panel** in the Risk/What-if section — save current legs as a named template; apply any saved template to reload legs
- `strategy_templates` table added to SQLite schema

### Tax lots (7.5)
- **`tax_lots.py`** — FIFO/LIFO lot matching, short/long-term classification (≥365 days), wash-sale disallowance (±30-day window), Form 8949-compatible CSV export
- **`POST /api/tax-lots/compute`** — compute realized events with summary (ST/LT gain, wash-sale, net); accepts `method` and `tax_year`
- **`GET /api/tax-lots/export`** — download Form 8949 CSV
- **Tax Lots panel** in the Journal tab — FIFO/LIFO selector, year filter, realized events table with box/proceeds/basis/gain/wash-sale columns, Form 8949 download button

### VaR (7.6)
- **`POST /api/risk/var`** — 1-day and 5-day VaR (95%) from Monte Carlo P&L distribution; CVaR (expected shortfall); √5 scaling for 5-day
- **VaR panel** in the Risk tab — displays 1d VaR, 5d VaR, CVaR, and path count; populates from existing simulation results

### Notifications (7.7)
- **`POST /api/notify/test`** — send test SMTP email to `ALERT_EMAIL_TO`
- **`_send_alert_email()`** — internal helper for triggered rule email dispatch via SMTP
- **Browser notification** — `Notification.requestPermission()` triggered on first rule evaluation; triggered rules fire `new Notification()`
- **Enable browser alerts / Send test email** buttons in the Alerts rail

### Data export (7.8)
- **`GET /api/export/portfolio-history`** — all portfolio snapshots as CSV
- **`GET /api/export/journal`** — all closed trades as CSV
- **`GET /api/export/greeks-snapshot`** — latest per-ticker greeks as CSV
- **Export buttons** in Journal toolbar (Portfolio history, Full journal) and Risk tab (Greeks snapshot)

### Frontend (Phase 7 general)
- **`static/js/10-phase7.js`** — new module wiring all Phase 7 UI (tax lots, VaR, templates, alert rules, notifications, export, orders)
- TAB_MAP extended to include `orders: "tab-orders"`
- `switchToTab()` hooks: loads orders list on Orders tab, refreshes strategy templates on Risk tab

---

## [Unreleased] — Phase 6 in progress

### Schwab API integration

- **`schwab_client.py`** — new `SchwabClient` class: OAuth 2.0 Authorization Code flow (paste-URL, no local HTTPS listener), token persistence to `schwab_token.json`, auto-refresh of access token, 7-day refresh token expiry detection, `get_positions()` normalizer maps Schwab option + equity positions to internal leg format
- **`GET /api/schwab/status`** — returns `{configured, authenticated, needs_reauth, token_age_hours}`
- **`GET /api/schwab/auth/url`** — returns Schwab OAuth URL to open in browser
- **`POST /api/schwab/auth/callback`** — exchange code from pasted redirect URL; saves tokens
- **`POST /api/schwab/sync`** — fetch + normalize all positions across accounts; response is drop-in for CSV import
- **`POST /api/schwab/disconnect`** — delete local token
- **Frontend panel** — Schwab import drawer now shows Connect / Sync / Disconnect UI when `SCHWAB_CLIENT_ID` is configured; falls back to CSV instructions otherwise
- **`tests/test_schwab_api.py`** — 16 mocked tests covering config, auth URL, callback exchange, position normalization (option + equity + flat skip), disconnect, and all 5 Flask routes
- **`requests>=2.28`** added to `requirements.txt`

---

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
