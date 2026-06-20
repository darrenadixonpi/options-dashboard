# Options Dashboard v1.3.0 — Analytics & Risk

Released 2026-06-20. Builds on v1.2.0 (broker integration, orders & rules, tax lots, VaR, journal v2).

## Highlights

### Journal analytics
- **Drawdown** on the realized equity curve — max/current drawdown ($ and %), recovery factor, underwater curve, longest-underwater stretch, time-to-recover.
- **Trade-performance cohorts** — win rate / expectancy / profit factor / total P&L / avg hold, sliced by underlying, strategy, hold-period bucket, DTE-at-entry, calendar month, and weekday.
- **Cumulative P&L attribution timeline** — price / Γ / Θ / V contributions accumulated across your fetch history, with a residual-vs-book check.

### Risk decomposition (Risk tab)
- **Component / marginal VaR** — each ticker's contribution to portfolio tail loss (additive to CVaR), its standalone VaR, and the portfolio diversification benefit, computed from the Monte Carlo draws.
- **Dollar-greeks & concentration** — $delta / $gamma-per-1% / $theta / $vega by ticker and book; Herfindahl concentration with effective number of names; a vega-by-DTE-bucket ladder.
- **Expiration / pin-risk calendar** — per-expiry legs, net delta, |gamma|, vega, notional, nearest-strike distance, and a pin-risk flag for ≤10-DTE strikes within 3% of spot.

### Factor analytics
- **Implied vs realized vol** — 20d/60d realized vol vs current IV, with a rich/cheap/fair signal (variance risk premium).
- **Sector exposure** — dollar-delta rolled up by GICS sector, with concentration.
- **Benchmark vs SPY** — dollar beta, correlation, R², and alpha from your tracked book snapshots, plus a holdings-based beta-weighted dollar delta.

### Effective (premium-adjusted) cost basis
- Optional toggle that reduces each long-share basis by realized option premium collected on the name — the wheel trader's economic basis, **not** tax basis. Two scopes: **All** (all-time) and **Since lot** (only premium since the current share lot opened). Shown on the cards and fed into the simulation's projected share P&L.

### Greeks Lab (interactive, per leg)
- A **Greeks** button on every option leg opens a client-side Black-Scholes scrubber: drag **days-to-expiry, spot, and IV** and watch value and Δ/Γ/Θ/V evolve toward expiry and across price, with a metric selector and a time/price axis toggle.
- Includes **higher-order / cross Greeks** (vanna, charm, vomma, speed) and an optional **spot↔vol link** (skew) to model a realistic joint move rather than a flat-vol shift. Client BSM mirrors the server and is validated against the closed form.

### Platform
- TypeScript / ES-module migration completed; the app loads a single esbuild bundle.
- **IBKR Flex Web Service** position sync, and **in-app Schwab** App Key/Secret setup (no `.env` editing).
- Realized-P&L correctness pass — multi-broker parsing, share cost basis, tax lots, simulation premium, and break-evens, validated on real Fidelity + Schwab exports.
- Reload-UX fixes — positions render on session restore without a manual Fetch; one bad position can no longer blank the whole book.

## Upgrade

Local desk app — no data migration. After updating the code, rebuild the frontend bundle:

```
npm run build      # or just launch start.bat, which builds in its prep step
```

On Windows use **Command Prompt** for `npm` (PowerShell blocks `npm.ps1` by default), or run `start.bat`.

## Verification

`tsc` and `esbuild` clean; full `pytest` suite green. The analytics and risk helpers ship with dedicated unit tests, and the client-side Black-Scholes in the Greeks Lab is validated against the server's `bs_greeks` to < 1.3e-5.
