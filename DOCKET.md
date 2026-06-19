# Options Dashboard — Docket

Living **roadmap and backlog** for this project. For math/architecture, see [TECHNICAL_EXPLAINER.md](TECHNICAL_EXPLAINER.md).

**Current release:** [v1.2.0](CHANGELOG.md) — Phases 4–7: broker integration, async market data, orders & rules, tax lots & VaR, journal v2, notifications & export.

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
| Convert remaining JS modules to TypeScript | ✅ **Done** — all 16 runtime modules are TypeScript; `state` annotated `AppState` in `04-state.ts`; `npm run typecheck:pilot` green across the whole frontend |
| Remove `@ts-nocheck` on pilot modules | ✅ Done — 0 errors (`typecheck:pilot`) |
| Run `typecheck:pilot` in `prep_before_start.py` / CI parity | ⏳ (CI runs it; prep script does not) |
| Full ES modules / drop global script concat | ⏳ Backlog |
| All runtime modules typechecked under one `tsconfig` | ✅ Done — 16 modules under `tsconfig.pilot.json` |

Target: **v1.2+** alongside or after Schwab API (see Next up).

---

## Shipped in v1.1

| Area | Scope |
|------|--------|
| **Phase 1** | Pydantic API schemas, pip-audit CI, vendored Chart.js, Playwright E2E |
| **Phase 2** | Shared `types.ts`, `npm run typecheck` |
| **Phase 3 pilot** | `05-session-api.ts`, `08-simulate.ts`, esbuild TS → JS, `typecheck:pilot` |
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
- Full ES modules / drop global script concat
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

*Last updated: 2026-06-19 (unreleased realized-P&L correctness pass — multi-broker parsing, cost basis, tax lots, simulation, break-evens, sort/filter; validated on real Fidelity + Schwab exports)*
