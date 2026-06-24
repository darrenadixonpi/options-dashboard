# Changelog

All notable releases of Options Dashboard.

## [1.8.0] — 2026-06-24

### Added
- **Underlying exposure (% of portfolio) per ticker (Risk tab).** A new card shows each name's notional / assignment exposure — `shares×price` + short-put `(strike−premium)×100×n` (covered calls add nothing; long options count premium at risk) — as a % of account value, with a portfolio total. The account value is read **straight from the positions export** (the "Positions Total" / "Cash & Cash Investments" rows the parser used to discard), so no manual entry; if a load lacks it, the card prompts and still shows dollar exposures. Includes a **Ticker ⇄ Sector toggle** (same notional metric, regrouped via the sector map).

### Changed
- **Readability pass.** Lifted the faint secondary/tertiary text colors (`--tx2` / `--tx3`) in both light and dark themes so dark-grey labels, hints, and table headers are actually legible.
- **Account value surfaced in obvious places.** The parsed account value now appears as a stat on the dashboard summary and the Risk summary, and prominently atop the Underlying-exposure card (was tiny grey).
- **Table headers:** right-aligned numeric column headers now line up with their data (`.hist-tbl th.r`), fixing the Exposure / % of port misalignment.
- **History parse warnings collapsed.** The Journal's parse-warning list now shows the first 6 with a count and a **Show all / Show less** toggle (scrollable when expanded), so long "close with no matching open" lists no longer dominate the tab.

### Fixed
- **Header version badge now reflects the real version.** The top-bar badge was hard-coded to "v1.2" and never updated; it now fetches `/api/version` (the `VERSION` file) on load, so it always shows the running release.
- **Drawdown "% vs peak" no longer shows misleading >100% figures.** The drawdown card divides the dollar drawdown by the prior positive peak, but the realized-P&L curve has no capital base and crosses zero — so once the trough drops below $0 (all prior profit given back), the percent balloons past 100% (e.g. a −$16,679 max drawdown read "−225.2% vs peak"). The dollar figure was always correct; the percent is now **only shown while the curve stays in profit**, and reads "gave back all profit (equity went negative)" otherwise. (Backend + frontend.)
- **Securities reported by CUSIP are no longer dropped or shown as junk (recovers missing history).** Brokers report a CUSIP instead of a ticker for some holdings — leveraged/inverse ETFs, post-split shares, adjusted options. These failed both the ticker and OCC-symbol parsers, so plain-equity CUSIP trades (e.g. the T-REX 2X Inverse TSLA ETF) were routed to the option matcher, which couldn't classify "YOU BOUGHT/SOLD" and **silently dropped their entire P&L**, while option rows coded by CUSIP showed up as their own garbage "underlying" in cohorts. The history parser now: (a) routes CUSIP-coded equities to the equity FIFO matcher with a **readable name derived from the description** (cash/interest/collateral/fees/splits are excluded by the trade-action test, so no phantom P&L); (b) recovers a CUSIP-coded option's underlying from its description (e.g. "PUT (OPEN) OPENDOOR …" → groups under **OPEN**); and (c) parses **adjusted** option roots (`-OPEN1260515P5` → OPEN1). Effect on real history: the inverse-TSLA ETF's **−$7.3k 2024 loss reappears** (it reconciles to its net cash flow), the **2024 cumulative P&L now correctly draws down to ≈ −$9.3k** instead of sitting near zero, and the junk `26923N827` / `-OPEN…` / `8014949WS` rows resolve to real names. Backend-only — restart the server.
- **Intraday round-trips no longer produce phantom realized P&L (FIFO matching).** Both the equity and option FIFO matchers sorted same-date events by date alone (options by date+action, which alphabetizes "BOUGHT CLOSING" *before* "BOUGHT OPENING"). Broker history has no intraday timestamps and is exported newest-first, so a same-day close could be processed before the open it belongs to — the close found no lot, got dropped (equity) or zeroed as an orphan (options), and the offsetting leg was left unmatched. For day-traded names this turned round-tripped positions into large fictional losses or gains. Both matchers now sort **opens before closes within the same date**, so a lot always exists before a close consumes it. Example from real history: MSTR (heavily day-traded short stock + options) corrected from **−$25,382 to +$3,967**, reconciling to its actual net cash flow; whole-journal realized P&L was understated by ~$13k. 17 equity tickers and ~12 option tickers were affected. Backend-only — restart the server (no rebuild needed).

## [1.7.0] — 2026-06-22

### Added
- **Sortable Performance Cohorts.** Click any column header (group name, Trades, Win%, Total P&L, Avg, PF, Avg Hold) to sort the cohort table; click again to flip direction.

### Fixed
- **Wash-sale detection now actually fires (estimate).** The replacement scan previously only counted positions that were *never closed*, but the tax-lot engine is fed your closed round-trips — so it matched nothing and "Wash-sale disallowed" always read $0. It now treats every acquisition within ±30 days of a loss as a candidate replacement, **matches replacements to losses 1:1 and consumes them** (oldest sale first, so one purchase can't wash multiple losses), **pro-rates** the disallowed amount to the replaced quantity, and **rolls the disallowed loss into a still-open replacement lot's cost basis** (carrying the washed holding period). Substantially-identical matching keys on ticker|type|strike; options treatment is fact-specific, so the figure is labeled an estimate (UI now reads "Wash-sale disallowed (est.)"). Added wash-sale unit tests.

## [1.6.0] — 2026-06-21

### Added
- **Portfolio market-shock — depth.** The shock card now shows a per-underlying **P&L contribution breakdown** (ranked bars) at the current move, and a **vol-response** slider: implied vol rises N points per 10% down-move (and falls on up-moves), applied to the shocked reprice only — so you can model a realistic spot↔vol crash, not just a flat-vol shift.
- **Greeks Lab — hypothetical legs / spread builder.** Add custom legs (type / strike / DTE / contracts) to the lab scope to preview a spread's net greeks, curves, surface, and Taylor P&L before you trade it; remove each with a click. Works on a single leg or layered on top of a whole-underlying aggregate.

## [1.5.0] — 2026-06-21

### Added
- **Greeks Lab — whole-underlying aggregate.** The Scope dropdown now offers, for any ticker with ≥2 option legs, an "all N legs (net)" view that sums Δ/Γ/Θ/vega — and value, Taylor, surface, and Greek×Greek — across the underlying's legs over one shared spot and a single days-forward time axis (each leg keeps its own strike/expiry). Single-leg and aggregate share one net-position engine.
- **Color greek (∂Γ/∂t).** Gamma decay added to the readout and selectable as a surface Z / scatter axis.
- **Portfolio market-shock (Risk tab).** A new card reprices the whole book — shares and every option leg — across a ±25% market move and a days-forward axis, entirely client-side, showing the P&L curve (gamma convexity), net $Δ / Θ / vega, and the worst case in range. Parallel by default; a β-weight toggle moves each underlying by its 6-month beta vs SPY via a new `/api/risk/betas` endpoint.
- **Greeks Lab from the Simulation tab.** A "Greeks Lab ▸" button in the per-ticker sim toolbar opens the lab for the focused ticker — aggregated across its legs when it has more than one.

### Changed
- **Greeks Lab now speaks in net-position terms.** Every view (not just the readout) shows position greeks (×100×contracts), so single-leg and aggregate are directly comparable. The lab also remembers your last view, 3D surface orientation, and link/skew across opens.

## [1.4.0] — 2026-06-20

### Added
- **Greeks Lab — relationship & surface views.** The per-leg Black-Scholes lab gains a view switcher with four modes beyond the original curves: **Θ–Γ gamma-rent** (theta overlaid on its −½σ²S²Γ identity, with the gamma breakeven move vs the 1σ implied daily move — a read on whether theta fairly pays for gamma); **Surface** (value or any Greek over two of {spot, DTE, IV}, as a drag-to-rotate 3D wireframe or a 2D heatmap with contour bands — hand-rolled canvas, no new dependencies); **Taylor P&L** (decomposes a what-if move into Δ/Γ/Θ/vega/vanna/vomma/charm/speed contributions plus the residual versus an exact reprice); and **Greek×Greek** (any Greek plotted parametrically against another as spot or DTE sweeps). All ride the existing client-side BSM, so they add no server load.
- **Switch legs inside the Greeks Lab.** A Leg dropdown in the popup lists every option leg in the book; choosing one re-loads the lab for that leg while preserving your current view, surface orientation, and link/skew settings — no need to close it and hunt for another leg's button.

### Changed
- **More visible action buttons.** The per-leg **Roll** and **Greeks** buttons are now bordered chips (Greeks accent-outlined) instead of faint ghost text, and the shared `.btn-ghost` style platform-wide gets brighter text plus a subtle border, so secondary buttons are easier to spot.

### Fixes
- **Greeks / Roll no longer jump you to the Simulation tab.** The clickable ticker block treated a click anywhere — including on its Roll/Greeks buttons — as "send to Simulation." It now ignores clicks on buttons and other controls, so opening the Greeks Lab (or rolling) keeps you on Positions with the modal on top.
- **Portfolio P&L histogram pan/zoom survives a reload.** `saveSession` stripped `portfolio_pnl` (the raw Monte Carlo paths) to save space, so a restored session drew the histogram from the saved bins but had nothing to re-bin — wheel/drag zoom silently did nothing (the canvas never got its `od-panzoom` handlers). The paths are now persisted, rounded to whole dollars to stay compact; the existing quota fallback still drops `simResult` if the session won't fit (then the "re-run sim for fine zoom" path applies). Surfaced once the reload fix started rendering the restored simulation instead of leaving it blank.

## [1.3.0] — 2026-06-20

Analytics & risk release on top of v1.2.0. Adds three analytics tiers (drawdown / cohorts / cumulative attribution; component VaR, dollar-greeks & pin-risk calendar; implied-vs-realized vol, sector rollup & SPY benchmark), a premium-adjusted "effective" cost basis (All / Since-lot), and an interactive per-leg **Greeks Lab** (client-side Black-Scholes with higher-order Greeks and a spot↔vol link). Also completes the TypeScript / ES-module migration, ships IBKR Flex sync and in-app Schwab setup, a realized-P&L correctness pass, and reload-UX fixes. tsc + esbuild + full pytest suite green.

### Greeks Lab — per-leg interactive Black-Scholes
- **A "Greeks" button on every option leg** opens a modal that shows how the contract's value and Greeks evolve toward expiry and across the underlying — IBKR Risk-Navigator-style, but per leg. Black-Scholes runs **client-side** (`static/js/14-greeks-lab.ts`, mirroring the server `bs_greeks`/`bs_option_value`; validated to < 1.3e-5 against the backend on four contracts) so sliders update instantly with no round-trips.
- **Three sliders** — days-to-expiry (today → expiry), spot, IV — drive a live readout (value, intrinsic/extrinsic, position Δ/Γ/Θ/V scaled ×100×contracts, P&L vs your fill) and a chart with a metric selector (Value / Δ / Γ / Θ / Vega) and an x-axis toggle (time-to-expiry or underlying price), with a marker at the current slider position. Surfaces theta acceleration and the gamma spike into expiry.
- **Higher-order & cross Greeks + a spot↔vol link.** Vanna, charm, vomma, and speed are finite-differenced off the same client BSM (vanna validated against the closed form) and shown in the readout. An optional **Link IV → spot** toggle (skew in vol-points per −1% spot) couples a spot move to an IV move, so you can watch the Greeks respond to a realistic joint move (vanna/charm P&L) instead of a flat-vol shift. Note the value/P&L/curves already full-reprice with BSM at every slider position, so all orders are captured exactly within the model.
- Single leg, IV held flat across time (labeled); theoretical BSM (r=3.7%), consistent with the risk-matrix caveat. New module registered in `MODULE_ORDER` / `_bundle-entry.ts` / `tsconfig.frontend.json`.

### Reload UX fixes
- **Root cause of blank-positions-on-reload: session restore ran mid-bundle-init.** `restoreSession()` was called at module-init time (top-level of `11-roll-catalysts-init`), but under the circular import graph esbuild evaluates `03-render` (which defines `SEV_CLASS`) *after* that call — so restore rendered while `SEV_CLASS` was still `undefined`, throwing `Cannot read properties of undefined (reading 'atm')` on the first card and blanking the book until a manual Fetch (which re-renders post-init). Restore is now deferred to a macrotask (`setTimeout(…, 0)`) so it runs after every module has initialized. Verified in the built bundle: the restore call sits ~100 lines before the `SEV_CLASS` assignment in eval order.
- **Positions also render on restore without cached market data.** `restoreSession` separately gated all rendering on `state.marketData`, so a session saved without cached marks — or one where a localStorage-quota trim dropped marketData — restored the summary/greeks but left the position cards blank until you clicked Fetch. It now renders the book whenever a portfolio exists (avg-cost view when no live prices), matching the import flow; market-dependent extras (provenance, sim, risk, attribution) stay gated on marketData.
- **One bad position can no longer blank the whole book.** Each ticker card renders inside a try/catch — a render error shows a per-ticker placeholder (logged to console) instead of aborting the entire positions render.
- **"Since lot" effective-basis fallback is now visible.** When a name's share lot can't be dated from the uploaded history, the card labels the basis "all-time (no lot date)" rather than silently using all-time premium.

### Effective (premium-adjusted) cost basis
- **Optional "Effective basis" toggle** (Positions toolbar, off by default, persisted in `localStorage`) — reduces each long-share cost basis by **all realized option premium collected on that underlying** (the card's existing "options realized" figure, which excludes still-open legs). This is the wheel trader's economic basis, **not** tax basis (assignment/wash-sale rules differ — broker `Avg` is unchanged and still shown).
- **Position cards** show broker `Avg` and `Eff $` side by side plus an "Effective basis" line (`broker − $premium prem · P&L`), and the premium-adjusted unrealized P&L. Effective basis may go **negative** — labeled "house money" (cumulative premium exceeds what you paid; e.g. RGNX here).
- **Simulation** uses the effective basis for projected share P&L when the toggle is on, fed in via the equity `adjCost` the `/api/simulate` endpoint already reads. No double-count: the realized premium that lowers the basis excludes the open short legs the sim models separately.
- **Two premium scopes** (toolbar `All` / `Since lot`): *All* subtracts every realized option dollar on the name; *Since lot* subtracts only premium realized since the current share lot opened (`closeDate ≥ lot open` — the assigning put closes on that date so it's included), falling back to *All* when the lot's buys aren't in the uploaded history. `/api/trade-history` now returns `openShareLots` (per-ticker earliest open long-lot date from the equity FIFO) to anchor the lot scope. Example from real data: NKTR all-time options −$1,186 vs **+$1,180 since the 5/27 assignment** — the scope flips a premium-blind basis bump into a reduction.
- Frontend (`03-render.ts` `effBasisOn`/`effBasisMode`/`effectiveBasisFor`, `08-simulate.ts`, `main.ts`, positions toolbar) plus the one `openShareLots` backend field. Driven by validating real Schwab + Fidelity exports where broker averages (e.g. ABVX $101.87) ignore large collected premium (ABVX effective ≈ $46). tsc + full pytest green (150 pass; only the sandbox's missing-vendored-file env check fails).

### Factor analytics — realized-vs-implied vol, sector rollup, benchmark vs SPY (Tier 3)
- **Implied vs realized vol** — `_annualized_realized_vol` computes 20d/60d annualized realized vol from daily log returns; compared to current IV per ticker to surface the variance risk premium (IV − RV20), flagged **rich** (≥+3 pts, options expensive to own / good to sell), **cheap** (≤−3), or **fair**. New "Implied vs realized vol" table in the Risk tab.
- **Sector exposure** — `_rollup_by_sector` rolls dollar-delta up by GICS sector (sector pulled per-ticker from yfinance, cached 7d) with net/gross $Δ, % of book, and a sector Herfindahl + effective-sector count. New "Sector exposure" bar chart in the Risk tab — surfaces directional concentration the ticker view hides.
- **Benchmark vs SPY** — `_compute_benchmark_metrics` regresses per-period change in book unrealized P&L on SPY's return (dollar terms, no capital-base assumption): a **dollar beta** ($ P&L per +1% SPY), correlation, R², and average non-market P&L per period (alpha$), over the tracked book-snapshot window. Also a holdings-based **beta-weighted dollar delta** (SPY-equivalent exposure now). New "Benchmark vs SPY" cards in the Risk tab.
- All three are served by one best-effort `POST /api/risk/factors` (each lookup degrades to None/"Unknown" if yfinance is unavailable; price-history and sector results are cached so only the first risk-tab load per ticker is slow). Loads with the Risk tab from the live greeks.
- **Tests** — `tests/test_risk_tier3.py` (8 cases): realized-vol formula + guards, sector grouping/HHI, benchmark dollar-beta/correlation on a synthetic correlated series, and the `/api/risk/factors` endpoint shape. Full suite green.

### Risk decomposition — component VaR, dollar-greeks, pin-risk calendar (Tier 2)
- **Component / marginal VaR** — `_compute_component_var` decomposes portfolio tail risk into per-ticker contributions using the empirical expected-shortfall (Euler) allocation: each ticker's mean P&L over the portfolio's worst (1−confidence) Monte Carlo scenarios. Contributions are **additive** — they sum to the portfolio CVaR — and each ticker also reports its standalone (undiversified) VaR and % of tail, with a portfolio diversification-benefit figure. Computed inside `/api/simulate` from the per-ticker P&L draws already in memory and returned as `component_var`; rendered as a breakdown table under the Risk-tab VaR panel.
- **Dollar-greeks + concentration** — new `POST /api/risk/exposure` (`_compute_exposure_metrics`) reports dollar delta (delta×spot), dollar gamma per +1% move, and $theta/$vega by ticker and portfolio, plus a concentration block: Herfindahl index on |$Δ|, effective number of names (1/HHI), top-name and top-3 % of gross, net vs gross $Δ. Also a **vega-by-DTE-bucket ladder** (0-7 / 8-21 / 22-45 / 46-90 / 90+) showing vol term-structure exposure. New "Exposure & concentration" section in the Risk tab.
- **Expiration / pin-risk calendar** — `_compute_expiry_calendar` groups option legs by expiry with legs, net delta, |gamma|, vega, notional, and nearest-strike distance; flags **pin risk** for ≤10-DTE expiries sitting within 3% of a strike (gamma/assignment risk into expiry). New calendar table in the Risk tab with a gamma-magnitude heat bar.
- Exposure + calendar load with the Risk tab from the live greeks; component VaR appears after a simulation. `SimulateResponse` gained an optional `component_var` field.
- **Tests** — `tests/test_risk_tier2.py` (10 cases): component-VaR additivity to CVaR + diversification, dollar-greek math, HHI, vega-ladder bucketing, pin-risk flag/sort, and the `/api/risk/exposure` endpoint shape. Full suite green.

### Analytics — drawdown, trade cohorts, cumulative attribution
- **Drawdown analytics on the realized equity curve** — `_compute_drawdown_metrics` derives max drawdown ($ and % vs the prior positive peak), current drawdown, peak/trough/recovery dates, days-to-recover, longest underwater stretch (calendar days), and a unitless recovery factor (net realized P&L ÷ max drawdown) from the existing per-close-day `_build_daily_pnl` series. Surfaced in the Journal tab as stat cards + an underwater-curve chart (`#drawdown-section`). No `Calmar` is shown because a realized-$ curve has no capital base.
- **Trade-performance cohorts** — `_compute_trade_cohorts` slices realized stats (trades, win rate, total/avg P&L, profit factor, avg hold) by underlying, strategy, hold-period bucket, DTE-at-entry bucket (options with a parseable expiry), calendar month, and weekday closed. Rendered as a dimension-toggle table in the Journal tab (`#cohorts-section`). Win rate here is leg-level, since cohorts span strategy groups (distinct from the headline group-level win rate).
- **Cumulative P&L attribution timeline** — `GET /api/snapshots/attribution-timeline` sums each stored attribution snapshot's greek decomposition (price/Γ/Θ/V) into cumulative contribution curves, plus a residual line vs the actual Δ book unrealized P&L where book snapshots align by timestamp (±36h) — i.e. the unexplained term (position changes + higher-order). New multi-line chart in the desk snapshot section.
- Both Journal panels reflect the full loaded history (independent of the table's ticker/strategy filter); all three features build only on data already captured in `portfolio.db`.
- **Tests** — `tests/test_analytics.py` (10 cases): drawdown peak/trough/recovery/underwater + short-series guards, cohort aggregation/ordering/DTE-equity-exclusion, and the attribution-timeline endpoint shape. Full suite green.

### TypeScript migration + ES modules (Phase 3, complete)
- Converted **`13-ibkr`**, **`12-snapshots`**, and **`09-risk`** from JS to TypeScript (DOM-element casts, typed fetch helpers, narrowed `expiry` handling); extended the `state` ambient type with `_volSurfaceData`. **All 16 runtime modules are now TypeScript source** — the foundational four (`01-parsers`, `02-portfolio`, `03-render`, `04-state`) completed the pass; this required removing the `const`/`let` ambient declares from `types.ts` and annotating the real `const state = {…}` as `AppState` so every consumer stays typed. The pilot `tsconfig`/typecheck script were renamed `tsconfig.frontend.json` / `npm run typecheck:frontend` (green across the whole frontend), and the now-redundant ambient function declares were trimmed from `types.ts` (it is interfaces + the `Chart` global only).
- **Real ES modules — dropped the global-script concatenation.** Every module now uses `import`/`export` instead of sharing one global scope. esbuild bundles a generated `_bundle-entry.ts` (which imports the modules in `MODULE_ORDER` for side-effect ordering) into a single IIFE at `static/dist/app.bundle.js`, and `index.html` loads just that one file (no more 16 `<script>` tags). Two cross-module mutable `let`s (`autoRefreshTimer`, `simNavObserver`) moved local to the module that assigns them, since ES imports are read-only. Because the bundle is closure-scoped, the **16 functions invoked from inline `on*=` HTML handlers** (`addAlertRule`, `loadTaxLots`, `stageOrder`, …) are re-exposed on `window` from `10-phase7.ts` for compatibility. `build_frontend.mjs` + the Python `frontend_scripts.py` helper now emit bundle-only; `typecheck:frontend` and the full `pytest` suite (123) pass, and a live browser smoke confirmed the bundle renders the full portfolio (13 cards), switches tabs, and sorts with zero console errors.

### IBKR Flex Web Service sync
- **`ibkr_flex_client.py`** — `IBKRFlexClient`: token + Activity-query positions sync over the Flex Web Service (two-step SendRequest→GetStatement with poll/backoff), XML→canonical-leg normalizer, config persisted to a local gitignored `ibkr_flex.json` (env-overridable)
- **`IBKRAdapter.sync_positions()`** — IBKR is now a CSV broker that *also* pulls via the Flex API; `supports_api_sync` + an `api_sync` capability flag added to the adapter layer (`brokers/base.py`)
- **`GET /api/ibkr/status`, `POST /api/ibkr/config`, `POST /api/ibkr/sync`, `POST /api/ibkr/disconnect`** — mirror `/api/schwab/*`; the sync response is a drop-in for `buildPortfolio()`
- **In-app panel** — `static/js/13-ibkr.js` + an IBKR import-drawer panel: inline setup steps, a token/query-id form (saved locally, no `.env` editing), and one-click Sync/Disconnect
- **`coerce_expiry`** now also parses compact `YYYYMMDD` (IBKR Flex date format)
- **Tests** — `tests/test_ibkr_flex.py` (config, XML normalization, two-step fetch + poll, error mapping, Flask routes) + `tests/fixtures/ibkr_flex_statement.xml`
- See [docs/IBKR_API.md](docs/IBKR_API.md)

### Schwab in-app credential setup
- **In-UI App Key + Secret form** — the Schwab panel no longer hides when unconfigured; it shows a setup form (saved to a local gitignored `schwab_config.json`), so credentials no longer require editing `.env`. The existing Connect → OAuth → Sync flow then runs
- **`SchwabClient.save_config` / `clear_config` / `_load_config`** (env still wins over the file) + **`POST /api/schwab/config`**, mirroring `/api/ibkr/config`
- Tests added to `tests/test_schwab_api.py` (config save/reload, env precedence, the new route)

### Bug fixes
- **Schwab CSV silently dropped every option** — the parser now reads Schwab's native option symbol `TICKER MM/DD/YYYY STRIKE P/C` (e.g. `OVID 06/18/2026 2.50 P`) across positions, history fills, the closed-position filter, the journal (`_parse_fidelity_schwab_raw_txns` → OCC conversion), and the `brokers/` adapter; `Journal`/`Transfer` rows are skipped as non-trades
- **`GET /api/snapshots/book-timeline` 500** — `_compute_mtm_risk_metrics` normalizes tz-aware vs tz-naive snapshot timestamps before subtracting (mixed DB rows no longer raise `Cannot subtract tz-naive and tz-aware`)
- **Frontend `parseOCC` mis-scaled padded OCC strikes** — `…P00150000` now parses to strike 150 (was 150000), matching the backend; literal decimal strikes unchanged
- **Recently-expired options were dropped immediately** — `filterClosedPositions` no longer removes an option the moment it passes expiry; it's kept until the transaction history confirms it closed/assigned/expired (with a 7-day settlement-grace floor), since broker settlement of expiry/assignment posts a few days later
- **Greeks over-counted theta for expired-pending options** — `/api/greeks` and `/api/what-if-greeks` clamped an expired option's DTE to 1 day, producing a huge spurious theta (a near-ATM expired put could show ~$150/day of "decay" already realized). Expired contracts (DTE ≤ 0) now get theta/gamma/vega = 0 and intrinsic (assignment) delta, so Portfolio theta matches the theta projection's live daily theta
- **Multi-broker history (Fidelity + Schwab) was mis-parsed** — multiple history files were concatenated and run through a single format detection, dropping the other broker's rows. Each file is now parsed by its **own** format: `/api/trade-history` accepts `historyTexts[]` and merges the trade/equity maps; the frontend parses each file separately for journal fills and the closed-position filter. Because both brokers normalize to the same canonical OCC key, a contract **opened at Fidelity and closed at Schwab** now pairs into one journal round-trip
- **Closed-position key stripped trailing zeros from integer strikes** — `String(130).replace(/\.?0+$/,"")` produced `"13"`, so options like ABVX 130 / NKTR 70 never matched the history; the key now uses the minimal numeric string and matches the broker OCC symbol
- **Negative share cost basis with multi-broker history** — `reconstructSharePositions` read every history row with Fidelity's fixed columns (Price=col5, Qty=col6), so Schwab share rows (Quantity=col4) were read as qty 0 and dropped; it also netted *all-time* buys/sells to derive the basis, which is meaningless for an actively-traded ticker (e.g. QCLS: 1650 bought / 1775 sold over the year). Result: QCLS/SPRB showed negative average cost. Columns are now detected per row, and the cost basis comes straight from the **broker-reported** number for the currently-held lot. Schwab `Buy`/`Sell` share verbs and native option symbols are now recognized
- **Tax-lot analysis inflated every stock trade 100x** — `compute_tax_lots` applied the options contract multiplier (×100) to any lot whose `opt_type` was not exactly `"equity"`. Share round-trips carry `opt_type = "Stock"`, so all stock proceeds/cost/gain were multiplied by 100. The multiplier is now applied only to actual Call/Put lots; shares use ×1
- **Positions sort/filter never worked (orphaned `main.js`)** — the Phase 4.2 sort buttons, ticker-filter box, and background-refresh badge all live in `static/js/main.js`, which was never added to `MODULE_ORDER`, so it loaded in neither the dev script tags nor the prod bundle and its `DOMContentLoaded` handlers never registered. Added `main.js` to the manifest and the index.html script block; the sort render path itself was already correct (verified alpha/DTE/IV orderings)
- **Wheel break-evens silently ignored premium** — the share-strategy break-even/assignment-scenario calc subtracted `eq.totalPremium`, which became 0 once premium stopped being folded into equity. It now credits the premium of the currently-open short legs being modeled (each leg's entry price × 100 × contracts), so e.g. ABVX's assignment-zone break-even is the correct $95.37 (was $116.30, ignoring the $4,080 put premium)
- **Assignments now presented as stock sales on Form 8949** — an assigned short option was persisted to the tax-lot as an option row (`TICKER Put $strike`, ×100), even though economically it's a share acquisition + sale. The journal now stashes the linked equity-leg details on the rollup trade, and the tax-lot persists it as a single **Stock** line with **premium-adjusted basis** (acquisition price − premium per share), proceeds = the share sale, gain = the combined P&L. Labeled as the underlying, ×1 multiplier
- **Tax-lot double-counted assigned-share P&L** — `_rollup_assignment_pnl` folds an assigned put's equity P&L into the linked option row's combined `pnl` and flags the standalone equity row `journalSuppress` so the journal totals count it once. But the DB `closed_trades` table (which the tax-lot reads) was written with *every* row, so the tax-lot counted both the combined option row and the suppressed equity row — double-counting assigned-share P&L (−$5,821 here) and also pulling in zero-pnl roll-open reference rows. Only the journal-aggregate set is now persisted, so the tax-lot realized total matches the journal ($24,619)
- **Tax-lot analysis flipped the sign of every short option** — `compute_tax_lots` treated each round-trip as a long (`gain = close − open`), so short premium was booked as the "cost" and the buy-to-close as "proceeds", negating the P&L on 155 of 199 short option trades (it reported options realized as −$15,043 when the true figure was +$18,690). It now orients proceeds/cost by direction (derived from `close_type`) and trusts the journal's per-trade realized P&L — which already handles short direction, expiries, assignments (premium rolled into the assigned shares) and orphan closes. Combined with the multiplier fix, net realized goes from −$108,146 to +$18,798, matching the journal's FIFO total
- **Monte Carlo simulation zeroed every short option's premium credit** — `/api/simulate` carried an old double-count guard (`tickers_with_adj_equity`) that set an option leg's `avg_cost` to 0 whenever its underlying equity had an `adjCost`. Once premium stopped being folded into equity basis (now `adjCost == avgCost` for all equities), that guard fired for *every* ticker with shares, dropping the premium credit on every short put/call. This overstated projected losses by the full premium per leg (ABVX short $130 put: ~$4,080; the whole P&L distribution was skewed too negative). The guard is removed — options always credit their own entry premium, since it is no longer double-counted anywhere
- **Misleading "premium-adjusted" cost basis on equity cards** — earlier iterations folded option premium into the share basis (going negative), then into an `eff.` break-even, then into a "net option premium" line. All were misleading for active traders: they spread a full year of premium across the small residual share lot, counted premium from **still-open, underwater short puts** as if banked, and ignored realized share losses (NKTR `eff. $45.59` implied profit while the name was down thousands). Equity cards now show the **broker cost basis** (`Avg`), unrealized **Share P&L**, and a **Realized P&L** line sourced from the FIFO closed-trades — split into shares vs closed/assigned/expired options (e.g. NKTR `Realized −$4,187 (sh −$3,001 · opt −$1,186)`). Premium from currently-open options is no longer counted as realized; those legs are shown on their own rows

---

## [1.2.0] — 2026-06-13

Major feature release consolidating Phases 4–7 on top of v1.1.0: broker integration (a Schwab OAuth API client plus a unified multi-broker adapter layer — live Schwab sync activates once the developer-app credentials are approved), background/async market data with yfinance resilience, order and rules management, tax-lot and VaR analytics, a journal overhaul, desktop/email notifications and CSV export, and completion of the TypeScript pilot pass.

### Multi-broker adapter layer (7.1)
- **`brokers/` package** — a common `BrokerAdapter` interface so every broker (Schwab API, Fidelity CSV, IBKR CSV) plugs in behind one contract and emits the **same canonical leg shape**. Adding a broker is "write an adapter + register it" — no edits to `app.py` core, simulation, greeks, or the journal
- **`brokers/base.py`** — `BrokerAdapter` ABC, the canonical `normalize_leg()` chokepoint (signed `contracts`/`shares`, ISO expiry coercion, flat-position drop), and `BrokerError`/`BrokerNotFound`
- **`brokers/csvutil.py`** — dependency-free Python ports of the validated `static/js/01-parsers.js` helpers (`parse_occ` with correct OCC strike padding, Schwab/IBKR option parsing) so the backend reconstructs the same positions as the browser
- **`brokers/schwab.py`** — `SchwabAdapter` (source `api`) delegates to the existing `schwab_client.py` (single source of truth for OAuth/tokens); also parses Schwab CSV exports
- **`brokers/fidelity.py` + `brokers/ibkr.py`** — CSV adapters for positions + opening-fill history (header-name column detection, robust to layout variants)
- **`brokers/__init__.py`** — registry: `get_adapter(key)` / `list_adapters()`
- **`GET /api/brokers`** — list every broker + capabilities (source, oauth, positions, history)
- **`GET /api/brokers/<key>/status`** — per-broker connection status (CSV brokers ready; Schwab delegates to OAuth state)
- **`POST /api/brokers/<key>/positions`** — unified ingestion: parse posted CSV for CSV brokers, or live OAuth pull for Schwab; response matches `/api/schwab/sync` so the frontend passes `positions` straight into `buildPortfolio()`. Existing `/api/schwab/*` routes unchanged
- **`tests/test_brokers.py`** — registry/factory, canonical normalization, Fidelity/IBKR/Schwab CSV parsing against new positions fixtures, Schwab API delegation (mocked), and the new routes

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
- **Bundle fix** — registered `10-phase7.js` in `tools/frontend-manifest.mjs` `MODULE_ORDER` so all Phase 7 UI ships in the production esbuild bundle and Docker (`USE_JS_BUNDLE`), not just dev script tags

### Journal v2
- **Collapsible strategy groups** — closed trades group by strategy with expand/collapse
- **Cross-day open-date matching** — opening and closing fills paired across different days for multi-day structures
- **Outlier flags** — trades with anomalous P&L highlighted in the journal table

### Schwab API integration (Phase 6)

- **`schwab_client.py`** — new `SchwabClient` class: OAuth 2.0 Authorization Code flow (paste-URL, no local HTTPS listener), token persistence to `schwab_token.json`, auto-refresh of access token, 7-day refresh token expiry detection, `get_positions()` normalizer maps Schwab option + equity positions to internal leg format
- **`GET /api/schwab/status`** — returns `{configured, authenticated, needs_reauth, token_age_hours}`
- **`GET /api/schwab/auth/url`** — returns Schwab OAuth URL to open in browser
- **`POST /api/schwab/auth/callback`** — exchange code from pasted redirect URL; saves tokens
- **`POST /api/schwab/sync`** — fetch + normalize all positions across accounts; response is drop-in for CSV import
- **`POST /api/schwab/disconnect`** — delete local token
- **Frontend panel** — Schwab import drawer now shows Connect / Sync / Disconnect UI when `SCHWAB_CLIENT_ID` is configured; falls back to CSV instructions otherwise
- **`tests/test_schwab_api.py`** — 16 mocked tests covering config, auth URL, callback exchange, position normalization (option + equity + flat skip), disconnect, and all 5 Flask routes
- **`requests>=2.28`** added to `requirements.txt`

### Background refresh (Phase 5)

- **Server-side auto-refresh** — daemon thread refreshes the last-watched ticker set every `BG_REFRESH_INTERVAL_MIN` minutes (default 5; set to `0` to disable). Tickers are registered automatically on any `/api/market-data` POST.
- **`GET /api/market-data/cached`** — returns the most-recent background result plus `updated_at` timestamp; returns 204 if no background refresh has run yet.
- **Frontend badge** — polls `/api/market-data/cached` every 60s; shows a clickable "↻ refreshed Xm ago" badge near the Fetch button when the server has data newer than the last manual fetch. Clicking the badge merges the fresh data into state and re-renders.

### Resilience

- **yfinance retry** — all yfinance calls go through `_yf_call()`: exponential-backoff retry up to `YF_RETRY_COUNT` attempts (default 3); initial wait `YF_RETRY_BACKOFF` seconds (default 1.5, doubles per attempt). Env-overridable.
- **Per-ticker isolation** — a failing ticker in `/api/market-data` no longer silently returns `None` forever; after retries exhausted it falls back to the most-recent DB snapshot price and sets `_stale: true` so the UI can indicate staleness.
- **Rate-limit token bucket** — in-process leaky bucket limits yfinance calls to `YF_RATE_LIMIT_PER_MIN` (default 30/min); excess callers block rather than hit Yahoo's soft limits. Set to `0` to disable.

### Bug fixes (Phase 4)

- **Fractional strike parsing** — OCC symbols with Fidelity decimal notation (e.g. `-OVID260618P2.5`) now correctly parse strike=2.5 instead of truncating to 2.0
- **yfinance calendar API** — `tk.calendar` returns a `dict` in yfinance ≥0.2.x; `_calendar_field()` helper handles both dict and legacy DataFrame forms so dividend and earnings dates are no longer silently `None`
- **`RISK_FREE`** — now env-overridable (`RISK_FREE=0.037` in `.env`); default updated from 0.043 to 0.037 to match current T-bill rate

### Performance

- **Beta cache** — `/api/greeks` caches per-ticker beta (6 h TTL) and SPY history (15 min TTL); reduces yfinance calls from N+1 per refresh to 0 on cache hit
- **DB retention** — `init_db()` prunes `snapshots` and `alert_events` older than `SNAPSHOT_RETENTION_DAYS` (default 180) on startup; set to `0` to disable

### API

- **`GET /api/version`** — returns `{"name": "options-dashboard", "version": "1.2.0"}`; reads from `VERSION` file

### UX

- **Position table sort** — A–Z (default), nearest DTE, highest |Δ| (requires greeks), highest IV (requires market data); sort persists across re-fetches
- **Ticker filter** — text input above positions table; filters by ticker prefix; Escape clears
- **Loading spinners** — CSS `od-spin` animation on Fetch and Simulate buttons during async operations; subtle pulse overlay on dashboard while re-fetching

### Dev / test

- **Test DB isolation** — `tests/conftest.py` creates a temp DB before `import app` so pytest never writes to the live `portfolio.db`
- **Regression tests** — `test_parse_occ_symbol_fractional_strike`, `test_calendar_field_dict_and_dataframe`
- **Prep script parity** — `scripts/prep_before_start.py` now runs `npm run typecheck:pilot` to match CI

---

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
