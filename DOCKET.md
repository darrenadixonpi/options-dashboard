# Options Dashboard — Docket

Living **roadmap and backlog** for this project. For math/architecture, see [TECHNICAL_EXPLAINER.md](TECHNICAL_EXPLAINER.md).

**Current release:** [v1.1.0](CHANGELOG.md) — Phases 1–3 modernization + sim/chart UX.

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
| Release notes + version tag | ✅ |
| Schwab/IBKR **live** CSV validation | ⏳ User-deferred |
| Journal complex multi-day strategy labels | ⏳ Partial (same-day spreads OK) |

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
| **Brokers** | Fidelity (validated), Schwab + IBKR (fixture-tested) |

---

## Next up (v1.2+)

| # | Item | Notes |
|---|------|--------|
| 1 | **TypeScript expansion** | Convert more modules; remove `@ts-nocheck` on pilot files |
| 2 | **Schwab/IBKR live smoke** | Import real CSVs; fix parser edge cases |
| 3 | **Journal strategy v2** | Multi-day spread/condor grouping; outlier flags |
| 4 | **GitHub release** | Tag `v1.1.0`, optional Releases page |

---

## Backlog (deferred)

- FIFO lot-level journal UI (fill dates per lot)
- Close-event badge polish (BTC/STC/expired/assigned)
- Roll-aware P&L in attribution
- Full ES modules / drop global script concat
- Auth / multi-user hosting (out of scope for local desk)

---

## Doc map

| File | Purpose |
|------|---------|
| [README.md](README.md) | Quick start, layout, limitations |
| [TECHNICAL_EXPLAINER.md](TECHNICAL_EXPLAINER.md) | BSM, greeks, MC, journal math |
| [CHANGELOG.md](CHANGELOG.md) | Version history |
| [GITHUB.md](GITHUB.md) | Publish to GitHub |
| [DOCKER.md](DOCKER.md) | Container deploy |
| [IMPLEMENTATION_GUIDE.md](IMPLEMENTATION_GUIDE.md) | Pointer only (v0 spec archived) |
| [static/js/README.md](static/js/README.md) | Frontend modules + TS pilot |

---

*Last updated: 2026-05-22 (v1.1.0)*
