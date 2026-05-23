# Changelog

All notable releases of Options Dashboard.

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
- **Schwab / IBKR** — Parsers + fixture tests; live CSV validation still recommended
- **Journal strategies** — Same-day spread grouping; complex multi-day structures may show as single-leg labels
- **Data** — Yahoo Finance (rate limits, no broker API); local-only, no auth
- **Auto-refresh** — Does not re-run simulation, risk matrix, or attribution snapshots

### Tests

- `pytest tests/test_smoke.py` — 29 smoke tests (parsers, APIs, packaging, bundle)
