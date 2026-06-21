# Options Dashboard — Docket

Living **roadmap and backlog** for this project. For math/architecture, see [TECHNICAL_EXPLAINER.md](TECHNICAL_EXPLAINER.md).

**Current release:** [v1.5.0](CHANGELOG.md) — whole-book Greeks: per-underlying aggregate in the Greeks Lab (net Δ/Γ/Θ/vega + curves/surface/Taylor across a ticker's legs), the color greek, persisted views, and a Simulation-tab entry; plus a portfolio market-shock card (parallel + β-weighted vs SPY). (Prior: v1.4.0 — Greeks Lab surfaces & relationships: 3D/heatmap surfaces, Θ–Γ gamma-rent, Taylor P&L, Greek×Greek, in-popup leg switcher, button visibility.)

---

## Active work

| Track | Status | Doc |
|-------|--------|-----|
| **Schwab API registration** | In progress — waiting for developer app **Ready for Use** | [docs/SCHWAB_API.md](docs/SCHWAB_API.md) |
| **Schwab API activation** | ⏳ **Blocked on credentials** — code is fully built (Phase 6). Once app is *Ready for Use*: add `SCHWAB_CLIENT_ID` + `SCHWAB_CLIENT_SECRET` to `.env`, restart server, click **Schwab → Connect Schwab Account** in the import drawer. | [docs/SCHWAB_API.md](docs/SCHWAB_API.md) |
| **Schwab CSV import** | ✅ Validated on real positions + transaction exports (parser hardened this session); live API path still pending credentials | [docs/SCHWAB_API.md](docs/SCHWAB_API.md) § Part 4 |
| **Multi-broker history (Fidelity + Schwab)** | ✅ Shipped (unreleased) — one continuous journal across brokers, cross-broker round-trip pairing | [CHANGELOG.md](CHANGELOG.md) |
| **Realized-P&L correctness pass** | ✅ Shipped (unreleased) — cost-basis, tax-lot, simulation, break-even, and journal-reconciliation fixes (see below) | [CHANGELOG.md](CHANGELOG.md) |
| **IBKR Flex Web Service** | ✅ Shipped (unreleased) — Flex client + adapter sync + in-app panel; pending live-token validation | [docs/IBKR_API.md](docs/IBKR_API.md) |

---

## v1.0 baseline checklist

| Item | Status |
|------|--------|
| Core tabs (Positions · Risk · Simulation · Journal) | ✅ |
| Fidelity import + fetch + journal P&L validated | ✅ |
| Desk alerts v2 + thresholds | ✅ |
| Auto-refresh (spot + marks + greeks) | ✅ |
| Packaging (start/stop scripts, Docker, bundle) | ✅ |
| Smoke tests (`pytest tests/test_smoke.py`) | ✅ |
| GitHub CI (`.github/workflows/ci.yml`) | ✅ |
| Release notes + version tag | ✅ `v1.1.0` tagged; `v1.2.0` notes ready, tag pending |
| GitHub Releases page | ⏳ Optional — tag exists; draft release on GitHub UI if desired |
| Schwab/IBKR CSV validation | ✅ Schwab + Fidelity validated on real exports; IBKR fixture-tested (live token pending) |
| Journal complex multi-day strategy labels | ⏳ Partial (same-day spreads OK) |

---

## Phase 3 — remainder (post-pilot)

Pilot shipped in v1.1 (`05-session-api.ts`, `08-simulate.ts`). Full Phase 3 completion:

| Item | Status |
|------|--------|
| Convert remaining JS modules to TypeScript | ✅ **Done** — all 16 runtime modules are TypeScript; `state` annotated `AppState` in `04-state.ts`; `npm run typecheck:frontend` green across the whole frontend |
| Remove `@ts-nocheck` on pilot modules | ✅ Done — 0 errors (`typecheck:frontend`) |
| Run `typecheck:frontend` in `prep_before_start.py` / CI parity | ⏳ (CI runs it; prep script does not) |
| Full ES modules / drop global script concat | ✅ **Done** — every module uses `import`/`export`; esbuild bundles `_bundle-entry.ts` (modules imported in `MODULE_ORDER`) into one IIFE; `index.html` loads the single bundle; the 16 inline-handler entry points are re-exposed on `window` for compat |
| All runtime modules typechecked under one `tsconfig` | ✅ Done — 16 modules under `tsconfig.frontend.json` |

Target: **v1.2+** alongside or after Schwab API (see Next up).

---

## Shipped in v1.1

| Area | Scope |
|------|--------|
| **Phase 1** | Pydantic API schemas, pip-audit CI, vendored Chart.js, Playwright E2E |
| **Phase 2** | Shared `types.ts`, `npm run typecheck` |
| **Phase 3 pilot** | `05-session-api.ts`, `08-simulate.ts`, esbuild TS → JS, `typecheck:frontend` |
| **Sim UX** | Sticky summary bar, left ticker nav, combined P(profit) by book, histogram range pan/zoom |
| **Charts** | Crosshair tooltips, fan-chart label layout, export-all fix |
| **Journal** | Assignment rollup stays on Journal tab |
| **Start scripts** | Auto prep (build + checks) via `prep_before_start.py` |

---

## Shipped in v1.0

| Area | Scope |
|------|--------|
| **Core desk** | Session persist, fetch pipeline, Positions / Risk / Sim / Journal IA |
| **Journal v6–v8** | Strategy-group KPIs, Sortino/Sharpe, rolls, MTM book snapshots, equity round-trips |
| **Risk & sim** | Risk matrix (730d), correlated MC, correlation heatmap, fan charts |
| **Alerts** | DTE, IVR, ex-div, book/ticker greeks, sim P(profit), stale marks, event log |
| **Export & snapshots** | CSV/PNG everywhere, SQLite fetch log, attribution diff |
| **Packaging** | `launch.py`, `stop.py`, Docker, optional PyInstaller, esbuild bundle |
| **Brokers** | Fidelity (validated), Schwab + IBKR (fixture-tested CSV) |

---

## Shipped in Phase 7

| Area | Scope |
|------|-------|
| **7.1 Multi-broker adapter** | `brokers/` package — common `BrokerAdapter` interface + canonical `normalize_leg`; Schwab (API), Fidelity + IBKR (CSV) adapters; registry + `GET /api/brokers`, `POST /api/brokers/<key>/positions`; `tests/test_brokers.py` |
| **7.2 Orders** | Draft order builder, staging UI, local persistence (`draft_orders` table), Orders tab (5th tab, kbd `5`) |
| **7.3 Rules engine** | DB-backed alert rules, auto-evaluation on fetch, browser notifications, SMTP test |
| **7.4 Strategy templates** | Save/load/apply named leg configurations in what-if builder |
| **7.5 Tax lots** | `tax_lots.py` — FIFO/LIFO, wash-sale, Form 8949 CSV; Tax Lots panel in Journal tab |
| **7.6 VaR** | `POST /api/risk/var` — 1d/5d VaR + CVaR from MC distribution; VaR panel in Risk tab |
| **7.7 Notifications** | Browser push (Notification API) + optional SMTP email alerts |
| **7.8 Data export** | Portfolio history, journal, and greeks snapshot CSV endpoints + toolbar buttons |

---

## Shipped (unreleased) — realized-P&L correctness pass

Driven by validating real Fidelity + Schwab exports. Full detail in [CHANGELOG.md](CHANGELOG.md) `[Unreleased]`.

| Area | Scope |
|------|-------|
| **Multi-broker parsing** | Per-broker column detection (Schwab qty=col4 vs Fidelity col6); Schwab native option symbols + `Buy`/`Sell`/`Sell to Open` verbs; each history file parsed by its own format and merged; cross-broker round-trip pairing |
| **Share cost basis** | Uses the broker-reported basis for the held lot (no more negative averages from all-time netting); positions cards show broker `Avg`, unrealized **Share P&L**, and a **Realized P&L** line (shares vs closed options) from the FIFO journal |
| **Tax lots** | Fixed: stock trades no longer ×100-inflated; short-option sign no longer flipped; assigned-share P&L no longer double-counted; assignments presented as premium-adjusted **Stock** sales on 8949. Net realized reconciles to the journal |
| **Simulation** | Short-option premium credited again (was zeroed once premium left the equity basis) |
| **Break-evens** | Wheel/assignment break-evens credit the open short legs' premium again |
| **Positions sort/filter** | Orphaned `main.js` (sort buttons, ticker filter, bg-refresh badge) added to `MODULE_ORDER` + index — now loads |
| **Tests** | New `tests/test_tax_lots.py` (8 cases) locking in the tax-lot fixes |

---

## Shipped (unreleased) — Greeks Lab (per-leg interactive Black-Scholes)

A **"Greeks" button on every option leg** opens a modal plotting how the contract's value and Greeks evolve toward expiry and across the underlying (IBKR Risk-Navigator-style, per leg). Black-Scholes runs **client-side** (`static/js/14-greeks-lab.ts`, mirrors server `bs_greeks`/`bs_option_value`, validated to < 1.3e-5) for instant slider response. Sliders: days-to-expiry, spot, IV → live readout (value, intrinsic/extrinsic, position Δ/Γ/Θ/V, P&L vs fill) + chart with metric selector and time/price x-axis toggle. Single leg, IV flat across time (labeled), theoretical BSM. New module registered in MODULE_ORDER / bundle-entry / tsconfig; tsc + esbuild clean. Pure frontend — no API change.

> **Frontend rebuild required:** `npm run build` (Command Prompt) or relaunch `start.bat`.

---

## Shipped (unreleased) — effective (premium-adjusted) cost basis

Optional **"Effective basis"** toggle (Positions toolbar, off by default, `localStorage`-persisted): long-share basis − realized option premium on the name. Shows broker `Avg` vs `Eff $` on cards (negative = "house money") and feeds the simulation's share P&L via equity `adjCost` (no double-count — realized premium excludes open legs). Economic/wheel basis, **not** tax basis. **Two scopes** (`All` / `Since lot`): all-time premium, or only premium since the current share lot opened (anchored by a new `openShareLots` field in `/api/trade-history`, with graceful fallback to *All* when the lot's buys aren't in the uploaded history). Frontend (`03-render.ts`, `08-simulate.ts`, `main.ts`) + one backend response field; tsc + full pytest (150) green. Real-data example: NKTR options −$1,186 all-time vs +$1,180 since the 5/27 assignment.

> **Frontend rebuild required** for the toggle to appear: `npm run build` (use Command Prompt, not PowerShell — `npm.ps1` is blocked by the default execution policy) or just launch `start.bat`, which rebuilds via prep.

## Shipped (unreleased) — factor analytics pass (Tier 3: IV-vs-RV · sector · benchmark)

Third analytics sprint — factor/relative views (one best-effort `/api/risk/factors`). Full detail in [CHANGELOG.md](CHANGELOG.md) `[Unreleased]`.

| Area | Scope |
|------|-------|
| **Implied vs realized vol** | `_annualized_realized_vol` — 20d/60d RV vs current IV per ticker; variance-risk-premium signal (rich/cheap/fair). Risk-tab table |
| **Sector exposure** | `_rollup_by_sector` — dollar-delta by GICS sector (yfinance sector, cached 7d) + net/gross, % of book, sector HHI / effective sectors. Risk-tab bar chart |
| **Benchmark vs SPY** | `_compute_benchmark_metrics` — dollar beta ($ P&L per +1% SPY), correlation, R², alpha$/period from tracked book snapshots; plus holdings-based beta-weighted $Δ. Risk-tab cards |
| **Tests** | `tests/test_risk_tier3.py` (8 cases) — realized-vol, sector HHI, benchmark dollar-beta, endpoint shape |

> **Frontend rebuild required:** regenerate the bundle (`static/dist/app.bundle.js`) — `start.bat` / `prep_before_start.py` do this automatically, or run `npm run build`.

All three analytics tiers (drawdown/cohorts/attribution, risk decomposition, factor views) are now shipped. No analytics candidates remain in the backlog.

## Shipped (unreleased) — risk decomposition pass (Tier 2: component VaR · dollar-greeks · pin-risk)

Second analytics sprint — risk/exposure decompositions. Full detail in [CHANGELOG.md](CHANGELOG.md) `[Unreleased]`.

| Area | Scope |
|------|-------|
| **Component VaR** | `_compute_component_var` — per-ticker contribution to tail loss (expected-shortfall/Euler, additive to CVaR), standalone VaR, % of tail, diversification benefit; computed in `/api/simulate`, shown under the VaR panel |
| **Dollar-greeks + concentration** | `POST /api/risk/exposure` (`_compute_exposure_metrics`) — $delta/$gamma-per-1%/$theta/$vega by ticker + book; HHI / effective names / top-name / top-3 %; vega-by-DTE ladder. Risk-tab "Exposure & concentration" section |
| **Expiration / pin-risk calendar** | `_compute_expiry_calendar` — per-expiry legs / net Δ / |Γ| / vega / notional / nearest-strike %; pin flag (≤10 DTE within 3% of a strike). Risk-tab calendar with gamma heat bar |
| **Tests** | `tests/test_risk_tier2.py` (10 cases) — component-VaR additivity, dollar-greeks, HHI, pin-risk, endpoint shape |

> **Frontend rebuild required:** regenerate the bundle (`static/dist/app.bundle.js`) — `start.bat` / `prep_before_start.py` do this automatically, or run `npm run build`.

Remaining analytics candidates (not yet built): realized-vs-implied vol, benchmark-relative (alpha/beta vs SPY), sector rollup.

## Shipped (unreleased) — analytics pass (drawdown · cohorts · attribution timeline)

First analytics sprint — all three reuse data already captured in `portfolio.db`, no new fetch path. Full detail in [CHANGELOG.md](CHANGELOG.md) `[Unreleased]`.

| Area | Scope |
|------|-------|
| **Drawdown** | `_compute_drawdown_metrics` on the realized equity curve — max DD ($/%), current DD, peak/trough/recovery dates, days-to-recover, longest-underwater (cal. days), recovery factor; Journal stat cards + underwater chart (`#drawdown-section`) |
| **Trade cohorts** | `_compute_trade_cohorts` — win-rate/expectancy/profit-factor/total-pnl/avg-hold sliced by underlying, strategy, hold bucket, DTE-at-entry, month, weekday; Journal dimension-toggle table (`#cohorts-section`) |
| **Attribution timeline** | `GET /api/snapshots/attribution-timeline` — cumulative price/Γ/Θ/V contribution curves + residual vs actual book Δ (timestamp-aligned ±36h); snapshot-section chart |
| **Tests** | `tests/test_analytics.py` (10 cases) — drawdown, cohorts, endpoint shape |

> **Frontend rebuild required:** regenerate the bundle (`static/dist/app.bundle.js`) for the UI to appear — `start.bat` / `prep_before_start.py` do this automatically, or run `npm run build`.

All Tier-2 (component VaR, dollar-greeks, pin-risk) and Tier-3 (IV-vs-RV, sector, benchmark) analytics are shipped above. No analytics candidates remain.

---

## Next up (post-1.2.0)

| # | Item | Notes |
|---|------|--------|
| 1 | **Activate Schwab API sync** | Code built (Phase 6); add `SCHWAB_CLIENT_ID`/`SCHWAB_CLIENT_SECRET` once the developer app is *Ready for Use* — [docs/SCHWAB_API.md](docs/SCHWAB_API.md) |
| 2 | **TypeScript expansion** | Convert remaining JS modules to TS (see Phase 3 remainder checklist) |
| 3 | **IBKR live-token validation** | Schwab + Fidelity CSV already validated on real exports; IBKR Flex still needs a live-token smoke run |
| 4 | **Additional broker adapters** | Tastytrade / others via the `brokers/` `BrokerAdapter` interface (Schwab + IBKR are the templates) |
| 5 | **GitHub Releases page** | Draft a release for the `v1.2.0` tag |

---

## Backlog (deferred)

- FIFO lot-level journal UI (fill dates per lot)
- Close-event badge polish (BTC/STC/expired/assigned)
- Roll-aware P&L in attribution
- Schwab Market Data product (broker quotes instead of Yahoo)
- Auth / multi-user hosting (out of scope for local desk)
- FIFO lot-level **8949 split for assignments** (currently one premium-adjusted Stock line per assignment; per-lot date detail is a future refinement)

---

## Relocating the project

Everything plan-related lives in **git-tracked markdown** (this file, [CHANGELOG.md](CHANGELOG.md), [docs/SCHWAB_API.md](docs/SCHWAB_API.md)). Chat history is not required if these docs are current.

### Copy with git (recommended)

```powershell
git clone https://github.com/darrenadixonpi/options-dashboard.git
# or copy folder including .git, then: git pull
```

### Also copy manually (not in git)

| Path | Contents |
|------|----------|
| `portfolio.db` | SQLite snapshots, alert log |
| `.env` | Runtime overrides; future Schwab secrets |
| Browser **localStorage** | Uploaded CSVs + session UI (export/import not built — re-import CSVs after move) |
| `schwab_token.json` | Future OAuth token (when wired) |

### Recreate after move

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
npm install
npm run build
# optional: copy portfolio.db and .env into project root
start.bat
```

Skip slow prep during iteration: `set OD_SKIP_PREP=1` then `start.bat` (run `npm run build` after TS edits).

---

## Doc map

| File | Purpose |
|------|---------|
| [README.md](README.md) | Quick start, layout, limitations |
| [DOCKET.md](DOCKET.md) | Roadmap, backlog, checklists (this file) |
| [docs/SCHWAB_API.md](docs/SCHWAB_API.md) | Schwab registration + v1.2 API plan |
| [docs/IBKR_API.md](docs/IBKR_API.md) | IBKR Flex Web Service integration plan |
| [docs/BROKER_TESTING.md](docs/BROKER_TESTING.md) | Step-by-step Schwab + IBKR sync verification |
| [TECHNICAL_EXPLAINER.md](TECHNICAL_EXPLAINER.md) | BSM, greeks, MC, journal math |
| [CHANGELOG.md](CHANGELOG.md) | Version history |
| [GITHUB.md](GITHUB.md) | Publish to GitHub |
| [DOCKER.md](DOCKER.md) | Container deploy |
| [IMPLEMENTATION_GUIDE.md](IMPLEMENTATION_GUIDE.md) | Pointer only (v0 spec archived) |
| [static/js/README.md](static/js/README.md) | Frontend modules + TS pilot |
| [docs/archive/IMPLEMENTATION_GUIDE_v0.md](docs/archive/IMPLEMENTATION_GUIDE_v0.md) | Historical pre-v1.0 spec |

---

*Last updated: 2026-06-20 — cut **v1.3.0** (analytics & risk: 3 analytics tiers, effective basis, Greeks Lab w/ higher-order Greeks + spot↔vol link, reload-UX fixes). The "Shipped (unreleased)" sections below are now released in v1.3.0. tsc + esbuild + full pytest green.*
