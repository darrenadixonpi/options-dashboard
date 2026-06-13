# Options Dashboard v1.2.0

**Local options portfolio tracker** — fetch live IV + greeks, run Monte Carlo simulation, manage orders and rules, track tax lots, and sync positions from your broker.

A large feature release consolidating Phases 4–7 on top of v1.1.0. See [CHANGELOG.md](../CHANGELOG.md) for the full list.

## Highlights

### Broker integration
- **Multi-broker adapter layer** — a unified `brokers/` package with one `BrokerAdapter` interface. Schwab (OAuth API), Fidelity, and IBKR (CSV) all emit the same canonical position shape. New routes: `GET /api/brokers`, `GET /api/brokers/<key>/status`, `POST /api/brokers/<key>/positions`.
- **Schwab OAuth API client** — `schwab_client.py` implements the paste-URL Authorization Code flow, token persistence/refresh, and a positions normalizer. Live sync activates once your developer app is approved and `SCHWAB_CLIENT_ID`/`SCHWAB_CLIENT_SECRET` are set (see [SCHWAB_API.md](SCHWAB_API.md)).

### Order & rules management
- **Orders tab (5th tab, kbd `5`)** — draft order builder, staging UI, local persistence.
- **Rules engine** — DB-backed alert rules auto-evaluated on each fetch (Δ, Θ, IV, P(profit), DTE, VaR), with browser notifications and optional SMTP email.
- **Strategy templates** — save and re-apply named leg configurations in the what-if builder.

### Risk, tax & journal analytics
- **Tax lots** — FIFO/LIFO matching, short/long-term classification, wash-sale detection, Form 8949 CSV export.
- **VaR** — 1-day and 5-day Value at Risk + CVaR from the Monte Carlo P&L distribution.
- **Journal v2** — collapsible strategy groups, cross-day open/close matching for multi-day structures, and outlier flags.

### Async market data & resilience
- **Background refresh** — a daemon thread refreshes the last-watched tickers every few minutes; the UI polls a cache endpoint and shows a "refreshed Xm ago" badge.
- **yfinance resilience** — exponential-backoff retry, per-ticker stale-price fallback, and an in-process rate-limit token bucket.

### Notifications & export
- Desktop (browser) notifications and optional SMTP email for triggered rules.
- CSV export of portfolio history, full journal, and the latest greeks snapshot.

### Frontend & tooling
- **TypeScript pass 2** — `@ts-nocheck` removed from the pilot modules; `typecheck:pilot` passes clean.
- **Bundle fix** — Phase 7 UI (`10-phase7.js`) is now registered in the bundle manifest, so it ships in the production esbuild bundle and Docker, not just dev mode.
- **Phase 4 hardening** — fractional OCC strike fix, yfinance calendar compatibility, env-overridable `RISK_FREE`, DB retention pruning, beta cache, position table sort/filter, loading spinners, and `GET /api/version`.

## Installing / running

```powershell
git clone https://github.com/darrenadixonpi/options-dashboard.git
cd options-dashboard
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
npm install
start.bat
```

Open `http://127.0.0.1:5000` in your browser.

## Requirements
- Python 3.10+
- Node 18+
- Windows or macOS/Linux (`start.bat` / `start.sh`)

## Known limitations
- Market data via Yahoo Finance — subject to rate limits and availability.
- **Schwab API** — client is implemented but live sync requires an approved Schwab developer app + credentials in `.env`. CSV import works today for all brokers.
- Broker CSV imports: Fidelity (validated), Schwab + IBKR (fixture-tested; live CSV validation deferred).
- Order staging is local only — broker order submission is not wired (manual execution).
- No multi-user auth — local desk use only; do not expose to the public internet.
