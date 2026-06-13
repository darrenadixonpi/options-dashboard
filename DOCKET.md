# Options Dashboard — Docket

Living **roadmap and backlog** for this project. For math/architecture, see [TECHNICAL_EXPLAINER.md](TECHNICAL_EXPLAINER.md).

**Current release:** [v1.1.0](CHANGELOG.md) — Phases 1–3 modernization + sim/chart UX.

---

## Active work

| Track | Status | Doc |
|-------|--------|-----|
| **Schwab API registration** | In progress — waiting for developer app **Ready for Use** | [docs/SCHWAB_API.md](docs/SCHWAB_API.md) |
| **Schwab API activation** | ⏳ **Blocked on credentials** — code is fully built (Phase 6). Once app is *Ready for Use*: add `SCHWAB_CLIENT_ID` + `SCHWAB_CLIENT_SECRET` to `.env`, restart server, click **Schwab → Connect Schwab Account** in the import drawer. | [docs/SCHWAB_API.md](docs/SCHWAB_API.md) |
| **Schwab live CSV validation** | Deferred — user chose API-first path | [docs/SCHWAB_API.md](docs/SCHWAB_API.md) § Part 4 |

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
| Release notes + version tag | ✅ (`v1.1.0` tagged on origin) |
| GitHub Releases page | ⏳ Optional — tag exists; draft release on GitHub UI if desired |
| Schwab/IBKR **live** CSV validation | ⏳ Deferred (API-first for Schwab) |
| Journal complex multi-day strategy labels | ⏳ Partial (same-day spreads OK) |

---

## Phase 3 — remainder (post-pilot)

Pilot shipped in v1.1 (`05-session-api.ts`, `08-simulate.ts`). Full Phase 3 completion:

| Item | Status |
|------|--------|
| Convert remaining JS modules to TypeScript | ⏳ |
| Remove `@ts-nocheck` on pilot modules | ⏳ |
| Run `typecheck:pilot` in `prep_before_start.py` / CI parity | ⏳ (CI runs it; prep script does not) |
| Full ES modules / drop global script concat | ⏳ Backlog |
| All 13 runtime modules typechecked under one `tsconfig` | ⏳ |

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
| **7.2 Orders** | Draft order builder, staging UI, local persistence (`draft_orders` table), Orders tab (5th tab, kbd `5`) |
| **7.3 Rules engine** | DB-backed alert rules, auto-evaluation on fetch, browser notifications, SMTP test |
| **7.4 Strategy templates** | Save/load/apply named leg configurations in what-if builder |
| **7.5 Tax lots** | `tax_lots.py` — FIFO/LIFO, wash-sale, Form 8949 CSV; Tax Lots panel in Journal tab |
| **7.6 VaR** | `POST /api/risk/var` — 1d/5d VaR + CVaR from MC distribution; VaR panel in Risk tab |
| **7.7 Notifications** | Browser push (Notification API) + optional SMTP email alerts |
| **7.8 Data export** | Portfolio history, journal, and greeks snapshot CSV endpoints + toolbar buttons |

---

## Next up (v1.2+)

| # | Item | Notes |
|---|------|--------|
| 1 | **Schwab API sync** | OAuth + position pull; see [docs/SCHWAB_API.md](docs/SCHWAB_API.md). Registration in progress. |
| 2 | **TypeScript expansion** | See Phase 3 remainder checklist above |
| 3 | **Schwab/IBKR live CSV smoke** | Fallback if API delayed; real exports → parser fixes |
| 4 | **Journal strategy v2** | Multi-day spread/condor grouping; outlier flags |
| 5 | **GitHub Releases page** | Optional UI release for `v1.1.0` (git tag already pushed) |

---

## Backlog (deferred)

- FIFO lot-level journal UI (fill dates per lot)
- Close-event badge polish (BTC/STC/expired/assigned)
- Roll-aware P&L in attribution
- Full ES modules / drop global script concat
- Schwab Market Data product (broker quotes instead of Yahoo)
- IBKR API integration
- Auth / multi-user hosting (out of scope for local desk)

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
| [TECHNICAL_EXPLAINER.md](TECHNICAL_EXPLAINER.md) | BSM, greeks, MC, journal math |
| [CHANGELOG.md](CHANGELOG.md) | Version history |
| [GITHUB.md](GITHUB.md) | Publish to GitHub |
| [DOCKER.md](DOCKER.md) | Container deploy |
| [IMPLEMENTATION_GUIDE.md](IMPLEMENTATION_GUIDE.md) | Pointer only (v0 spec archived) |
| [static/js/README.md](static/js/README.md) | Frontend modules + TS pilot |
| [docs/archive/IMPLEMENTATION_GUIDE_v0.md](docs/archive/IMPLEMENTATION_GUIDE_v0.md) | Historical pre-v1.0 spec |

---

*Last updated: 2026-05-22 (v1.1.0 + Schwab API planning)*
