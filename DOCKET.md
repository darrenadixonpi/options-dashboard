# Options Dashboard — Docket

Living backlog for what’s done and what’s next.

**Current release:** [v1.0.0](CHANGELOG.md) — baseline for local desk use.

---

## v1.0 baseline checklist

| Item | Status |
|------|--------|
| Core tabs (Positions · Risk · Simulation · Journal) | ✅ |
| Fidelity import + fetch + journal P&L validated | ✅ |
| Desk alerts v2 + thresholds | ✅ |
| Auto-refresh (spot + marks + greeks) | ✅ |
| Packaging (start scripts, Docker, bundle) | ✅ |
| Smoke tests (`pytest tests/test_smoke.py`) | ✅ |
| Release notes + version tag | ✅ |
| Schwab/IBKR **live** CSV validation | ⏳ User-deferred |
| Journal complex multi-day strategy labels | ⏳ Partial (same-day spreads OK) |

---

## Done (v1.0)

| Phase | Scope |
|-------|--------|
| **P0–P2 + polish** | Session, fetch, roll analyzer, hub IA, rail, journal, snapshots, keyboard shortcuts |
| **Journal v6–v8** | Strategy-group KPIs, Sortino/Sharpe, rolls, MTM book snapshots |
| **Chart export** | Universal PNG + bulk fan charts |
| **IBKR journal** | Backend + frontend Flex/history parsers |
| **Risk horizon** | Matrix to 730d + expiry checkpoints |
| **Alerts v2** | Greek thresholds, event log, browser notify |
| **#6 Packaging** | launch.py, setup scripts, Docker, PyInstaller |
| **#7 Bundler** | esbuild, USE_JS_BUNDLE, Docker multi-stage |
| **#8 Auto-refresh** | 5/10/15m toggle; spot + marks + greeks; pause when hidden |
| **#9/#10** | Correlated MC + correlation heatmap |
| **Tests** | 29 smoke tests incl. Fidelity/IBKR/Schwab fixtures |

---

## Next up (v1.1+)

| # | Item | Why |
|---|------|-----|
| 1 | **Schwab/IBKR live smoke** | Promote brokers from “experimental” to validated |
| 2 | **Journal strategy v2** | Multi-day spread/condor grouping; outlier sanity flags |
| 3 | **Chart drill-down** | Journal cumulative chart → trades on click |
| 4 | **CI** | GitHub Actions: pytest + npm build on push |

---

## Backlog (deferred)

- FIFO lot-level journal (fill dates per lot in UI)
- Close-event typing polish (BTC/STC/expired/assigned badges)
- Roll-aware P&L in attribution
- Auth / multi-user (out of scope for local desk)

---

*Last updated: 2026-05-22 (v1.0.0 baseline)*
