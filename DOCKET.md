# Options Dashboard — Docket

Living **roadmap and backlog** for this project. For math/architecture, see [TECHNICAL_EXPLAINER.md](TECHNICAL_EXPLAINER.md).

**Current release:** [v1.0.0](CHANGELOG.md) — baseline for local desk use.

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
| **Tests** | 30 smoke tests |

---

## Next up (v1.1+)

| # | Item | Notes |
|---|------|--------|
| 1 | **Schwab/IBKR live smoke** | Import real CSVs; fix parser edge cases |
| 2 | **Journal strategy v2** | Multi-day spread/condor grouping; outlier flags |
| 3 | **Chart drill-down** | Journal cumulative P&L → trades on click |
| 4 | **GitHub release** | Push repo, tag `v1.0.0`, optional Releases page |

---

## Backlog (deferred)

- FIFO lot-level journal UI (fill dates per lot)
- Close-event badge polish (BTC/STC/expired/assigned)
- Roll-aware P&L in attribution
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

---

*Last updated: 2026-05-22 (v1.0.0)*
