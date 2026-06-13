# Options Dashboard — Technical Reference

## Overview

The Options Dashboard is a local-first portfolio analytics tool for equity options traders. It ingests brokerage CSV exports (Fidelity, Schwab, IBKR), fetches live market data via Yahoo Finance, and provides risk analytics, Monte Carlo simulation, and theta decay projections — all computed server-side in Python (Flask) and rendered client-side with Chart.js.

No data leaves your machine. The application runs entirely on `localhost`.

---

## Architecture

**Backend** (Flask + NumPy + SciPy + pandas + yfinance): Computation runs server-side. The frontend sends parsed positions and market data; APIs return JSON (greeks, simulation paths, trade history, desk alerts, etc.).

**Frontend** (`static/index.html` + `static/css/app.css` + 13 ordered JS modules under `static/js/`, two authored as TypeScript pilots): CSV parsing, position reconstruction, and fill matching run in the browser. Chart.js (vendored under `static/vendor/`) handles charts; optional production bundle via esbuild (`static/dist/app.bundle.js`).

**Persistence:** SQLite (`portfolio.db`) for fetch snapshots, alert event log, and catalysts. Uploaded CSVs and session UI state live in **browser localStorage** until cleared.

---

## Pricing Model

All option pricing uses the **Black-Scholes-Merton (BSM) framework** under the following assumptions: European exercise, zero continuous dividend yield, constant volatility, and a constant risk-free rate $r \approx 0.037$ (default; override with the `RISK_FREE` environment variable — see `app.py`).

Given spot price $S$, strike $K$, risk-free rate $r$, implied volatility $\sigma$ (annualized, in decimal form — e.g. 1.888 for 188.8%), and time to expiry $T$ (in years):

$$d_1 = \frac{\ln(S/K) + (r + \tfrac{1}{2}\sigma^2)\,T}{\sigma\sqrt{T}}, \qquad d_2 = d_1 - \sigma\sqrt{T}$$

**Call value:**

$$C = S\,\Phi(d_1) - K\,e^{-rT}\,\Phi(d_2)$$

**Put value:**

$$P = K\,e^{-rT}\,\Phi(-d_2) - S\,\Phi(-d_1)$$

where $\Phi(\cdot)$ is the standard normal CDF (`scipy.stats.norm.cdf`).

**Boundary condition:** When $T \leq 10^{-6}$ years (effectively at or past expiry), or when any of $\sigma$, $S$, $K$ are non-positive, the model returns intrinsic value: $\max(S - K,\, 0)$ for calls, $\max(K - S,\, 0)$ for puts.

---

## Greeks

Greeks are computed from BSM closed-form partial derivatives. All are computed per-share, then scaled to portfolio dollars as: $\text{Greek}_{\text{portfolio}} = \text{Greek}_{\text{per-share}} \times \text{contracts} \times 100$.

Let $\phi(x) = \frac{1}{\sqrt{2\pi}}e^{-x^2/2}$ denote the standard normal PDF.

### Delta ($\Delta$)

$$\Delta_{\text{call}} = \Phi(d_1), \qquad \Delta_{\text{put}} = \Phi(d_1) - 1$$

Interpretation: The change in option value per \$1 change in the underlying. A portfolio delta of 2899 means the portfolio gains approximately \$2,899 per \$1 increase across all underlyings (weighted by position size).

### Gamma ($\Gamma$)

$$\Gamma = \frac{\phi(d_1)}{S\,\sigma\,\sqrt{T}}$$

Interpretation: The rate of change of delta with respect to the underlying price. Equivalently, the second partial derivative $\partial^2 V / \partial S^2$. High gamma means delta shifts rapidly with price movement — significant for short gamma portfolios where adverse moves accelerate losses.

### Theta ($\Theta$)

$$\Theta_{\text{call}} = -\frac{S\,\phi(d_1)\,\sigma}{2\sqrt{T}} - r\,K\,e^{-rT}\,\Phi(d_2)$$

$$\Theta_{\text{put}} = -\frac{S\,\phi(d_1)\,\sigma}{2\sqrt{T}} + r\,K\,e^{-rT}\,\Phi(-d_2)$$

The raw BSM theta is annualized. The dashboard divides by 365 (calendar days, not trading days) to get per-day decay:

$$\Theta_{\text{daily, portfolio}} = \sum_i \frac{\Theta_i}{365} \times \text{qty}_i \times 100$$

Sign convention: A short option position has positive portfolio theta (time decay benefits the seller). Long option positions contribute negative theta (time decay is a cost). The dashboard reports the net.

### Vega ($\mathcal{V}$)

$$\mathcal{V} = \frac{S\,\phi(d_1)\,\sqrt{T}}{100}$$

The division by 100 means vega is expressed per 1 percentage-point change in implied volatility (i.e., $\partial V / \partial \sigma$ scaled so $\Delta\sigma = 0.01$). A portfolio vega of −\$157 means a 1-point IV increase across all positions decreases portfolio value by approximately \$157.

### Beta-Weighted Delta

Portfolio delta is converted to SPY-equivalent exposure. The computation:

1. For each ticker $i$, compute $\beta_i$ by regressing 6-month daily log returns against SPY:

$$\beta_i = \frac{\text{Cov}(r_i, r_{\text{SPY}})}{\text{Var}(r_{\text{SPY}})}$$

   where $r = \ln(P_t / P_{t-1})$. If fewer than 30 aligned observations exist, $\beta_i = 1$.

2. Convert each ticker's portfolio delta (already in share-equivalent units) to SPY-equivalent:

$$\Delta_{\text{SPY}} = \sum_i \Delta_i \times \frac{S_i}{S_{\text{SPY}}} \times \beta_i$$

This normalizes each ticker's delta by its price ratio to SPY and its systematic risk loading. The result represents how many SPY shares the portfolio behaves like directionally.

---

## Monte Carlo Simulation

### Model Selection

Each ticker is automatically classified as either **Geometric Brownian Motion (GBM)** or **Merton Jump-Diffusion** based on two criteria evaluated independently:

1. **IV/HV ratio ≥ 1.8** (`IV_HV_RATIO_THRESHOLD`) — implied volatility significantly exceeds realized 20-day historical volatility (annualized via $\sigma_{\text{HV}} = \hat\sigma_{\text{daily}} \times \sqrt{252}$), suggesting the market prices in discontinuous event risk not captured by recent realized moves.
2. **10-day absolute return ≥ 15%** (`PRICE_MOVE_THRESHOLD`) — defined as $|S_t / S_{t-10} - 1| \geq 0.15$, indicating a recent jump-like move.

If either criterion is met, the ticker uses Merton. Otherwise, GBM.

### GBM (Geometric Brownian Motion)

The discrete-time Euler scheme for log prices:

$$\ln S_{t+\Delta t} = \ln S_t + \left(\mu - \tfrac{1}{2}\sigma^2\right)\Delta t + \sigma\sqrt{\Delta t}\,Z_t$$

$$S_{t+\Delta t} = S_t \exp\!\Big[\left(\mu - \tfrac{1}{2}\sigma^2\right)\Delta t + \sigma\sqrt{\Delta t}\,Z_t\Big], \quad Z_t \stackrel{\text{iid}}{\sim} \mathcal{N}(0,1)$$

Parameters:

- $\mu = r \approx 0.037$ (risk-neutral drift; `RISK_FREE` env-overridable)
- $\sigma$: the ticker's implied volatility in decimal form (e.g. 1.888 for 188.8% IV)
- $\Delta t = T / n_{\text{steps}}$, with $n_{\text{steps}} = \lceil T \times 252 \rceil$ (one step per trading day)
- $n_{\text{paths}} = 10{,}000$

Note: Using risk-neutral drift ($\mu = r$) rather than historical drift is intentional — the simulation prices options at terminal intrinsic value, so risk-neutral dynamics are appropriate for computing expected P&L under the pricing measure. This is not a forecast of expected stock returns.

### Merton Jump-Diffusion

The Merton model augments GBM with a compound Poisson jump component:

$$\ln S_{t+\Delta t} = \ln S_t + \left(\mu - \tfrac{1}{2}\sigma_d^2 - \lambda\bar{k}\right)\Delta t + \sigma_d\sqrt{\Delta t}\,Z_t + \sum_{j=1}^{N_t} J_j$$

where:

- $\sigma_d = 0.5\,\sigma$ (`sigma_diff_frac`) — the diffusive volatility is set to 50% of total IV. The remaining variance is attributed to the jump component.
- $\lambda = 2$ (`lam`) — Poisson intensity, implying an expected 2 jumps per year.
- $N_t \sim \text{Poisson}(\lambda\,\Delta t)$ — the number of jumps in interval $[t, t+\Delta t]$.
- $J_j \stackrel{\text{iid}}{\sim} \mathcal{N}(\mu_J,\, \sigma_J)$ — individual jump sizes in log-space.
  - $\mu_J = -0.10$ (`mu_j`) — negative mean jump, reflecting the empirical asymmetry of crash risk.
  - $\sigma_J = 0.15$ (`sig_j`) — fixed jump volatility in log-space (does **not** scale with the ticker's IV).
- When $N_t > 1$, the total jump is the sum $\sum_{j=1}^{N_t} J_j$, which itself is $\mathcal{N}(N_t \mu_J,\, N_t \sigma_J^2)$.
- $\bar{k} = \exp(\mu_J + \tfrac{1}{2}\sigma_J^2) - 1$ — the drift compensator. This ensures $\mathbb{E}[e^{J}] = 1 + \bar{k}$, and the term $-\lambda\bar{k}$ in the drift removes the average effect of jumps so the process is still risk-neutral.

The Merton model produces leptokurtic (fat-tailed) terminal distributions compared to GBM. For high-IV biotech names where binary catalysts (PDUFA dates, data readouts) drive non-continuous price action, this more accurately reflects the range of outcomes.

### Correlation Structure

When the portfolio contains $\geq 2$ tickers with $\geq 60$ overlapping daily observations, the simulation induces cross-asset correlation via Cholesky decomposition of the historical correlation matrix.

**Step 1:** Compute the $k \times k$ correlation matrix $\mathbf{R}$ from 1-year daily log returns:

$$R_{ij} = \frac{\sum_t (r_{i,t} - \bar{r}_i)(r_{j,t} - \bar{r}_j)}{\sqrt{\sum_t (r_{i,t} - \bar{r}_i)^2 \sum_t (r_{j,t} - \bar{r}_j)^2}}$$

computed via `pandas.DataFrame.corr()` on the aligned return series (inner join, requiring $\geq 30$ overlapping dates).

**Step 2:** Ensure positive definiteness. Compute eigenvalues $\{\lambda_i\}$ of $\mathbf{R}$. If $\lambda_{\min} < 0$ (can occur with short/sparse histories or near-collinear tickers):

$$\mathbf{R}' = \mathbf{R} + (-\lambda_{\min} + 10^{-6})\,\mathbf{I}$$

This is a minimal spectral adjustment — it shifts all eigenvalues to be strictly positive while preserving the correlation structure as closely as possible.

**Step 3:** Cholesky factorization: $\mathbf{R}' = \mathbf{L}\mathbf{L}^\top$ where $\mathbf{L}$ is lower-triangular.

**Step 4:** At each timestep, generate $k$ independent standard normals $\mathbf{Z}_t \sim \mathcal{N}(\mathbf{0}, \mathbf{I}_k)$ and transform:

$$\tilde{\mathbf{Z}}_t = \mathbf{L}\,\mathbf{Z}_t$$

The resulting $\tilde{Z}_{i,t}$ has $\text{Corr}(\tilde{Z}_{i,t}, \tilde{Z}_{j,t}) = R_{ij}$, and these correlated normals feed into each ticker's respective GBM or Merton diffusion term. Jump components remain independent across tickers (jumps are idiosyncratic events by assumption).

### Terminal P&L Calculation

Each path is evaluated at the simulation horizon $T_{\text{sim}}$ (the number of calendar days to the earliest option expiry, converted to years). At terminal time, each position is settled:

**Options** (settled at intrinsic):

$$\mathrm{PnL}_i = \text{contracts}_i \times \big[\max(S_T - K_i,\, 0) \cdot \mathbb{1}_{\text{call}} + \max(K_i - S_T,\, 0) \cdot \mathbb{1}_{\text{put}} - c_i\big] \times 100$$

where $c_i$ is the average cost (premium paid or received per share).

**Equity:**

$$\mathrm{PnL}_i = \text{shares}_i \times (S_T - b_i)$$

where $b_i$ is the adjusted cost basis (raw cost minus collected premium per share).

**Portfolio P&L** is the sum across all positions. From 10,000 draws, the following statistics are reported:

- Mean, median
- Percentiles: P5, P25, P75, P95
- $P(\text{profit}) = \frac{1}{n}\sum_{j=1}^{n} \mathbb{1}\{\mathrm{PnL}_j \geq 0\}$
- Histogram (60 bins)

---

## Theta Decay Projection

The theta projection computes theoretical daily time decay for every option position (both long and short) from today through the last expiry, holding $S$, $\sigma$, and $r$ constant.

For each calendar day $d$ in the projection window and each option position $i$ with expiry $\text{exp}_i > d$:

$$\Theta_{\text{daily}}(d) = \sum_i \text{qty}_i \times \frac{\Theta_{\text{BS}}(S_0,\, K_i,\, r,\, \sigma_i,\, T_i(d))}{365} \times 100$$

where $T_i(d) = \max\!\big((\text{exp}_i - d) / 365,\, 10^{-6}\big)$.

Positions are grouped by expiry into colored bands. As an expiry date passes, its positions drop from the stacked bar, producing the characteristic step-down pattern.

**Cumulative theta** is the running sum $\sum_{d=1}^{D} \Theta_{\text{daily}}(d)$. Two lines are shown:

1. **Earned** — contributions from short positions only (positive theta)
2. **Net** — all positions including long option cost (negative theta from longs)

**Milestones** mark each expiry date on the cumulative curve.

**Important caveats:**

- The projection assumes frozen underlying price and IV. In reality, BSM theta is path-dependent: theta accelerates near expiry for ATM options (the "theta cliff"), gamma-delta interaction causes theta to change with price moves, and vega-theta interaction means IV changes shift the decay rate.
- This is best interpreted as a structural comparison tool — "how much premium is loaded into which expiry bucket" — not a P&L forecast.

---

## Risk Matrix

The risk matrix evaluates portfolio P&L under a Cartesian product of parallel shocks to underlying price and implied volatility, with optional time decay.

For each cell at price shock $\Delta S\%$ and IV shock $\Delta\sigma$ (in percentage points):

$$\mathrm{PnL}(\Delta S\%, \Delta\sigma) = \sum_i \text{qty}_i \times \big[V_i^{\text{shocked}} - c_i\big] \times 100$$

where the shocked option value for position $i$ is:

$$V_i^{\text{shocked}} = \max\!\Big(\text{BSM}\big(S_0(1 + \Delta S\%/100),\; K_i,\; r,\; \sigma_i + \Delta\sigma/100,\; T_i - t_{\text{fwd}}/365\big),\; 0\Big)$$

and $c_i$ is the position's average cost. Note this computes mark-to-model P&L relative to entry cost, not relative to current model value.

**Default grid:**

- Price shocks: {−20, −15, −10, −5, −2, 0, +2, +5, +10, +15, +20}%
- IV shocks: {−15, −10, −5, 0, +5, +10, +15} percentage points
- Days forward: 0–90 (slider), subtracted from each position's DTE (clamped to $\geq 1$ day)

**Equity positions** contribute linearly: $\mathrm{PnL}_{\text{equity}} = \text{shares} \times S_0 \times \Delta S\% / 100$.

The center cell $(0\%, 0\text{pt})$ at days forward $= 0$ should show approximately zero P&L (current mark = cost for recently opened positions). With days forward $> 0$, the center cell shows pure theta decay. The curvature of each row reflects gamma exposure; the slope of each column reflects vega exposure.

---

## Vol Surface

The volatility surface plots implied volatility by strike across up to 8 expiry dates, using live option chain data from Yahoo Finance. Only strikes with non-zero open interest or non-zero volume are included — this filters out theoretical/model-based IV entries from illiquid strikes where bid-ask spreads are meaningless.

A toggle allows viewing puts, calls, or both (calls shown dashed when overlaid). Each expiry is a separate line, colored distinctly.

The vol surface reveals:

- **Skew (smile asymmetry):** OTM puts typically trade at higher IV than ATM — this is the market pricing crash protection. The steepness of the put skew reflects demand for downside hedging.
- **Term structure:** Near-term expiries often show elevated IV around catalysts (earnings, PDUFA) while far-dated IV is more stable. An inverted term structure (near > far) signals the market expects a specific near-term event.
- **Smile symmetry:** For biotech/event-driven names, the smile is often more symmetric — both OTM puts and OTM calls are elevated, reflecting binary outcome risk.

---

## Unusual Options Activity

The scanner checks the first 3 expiry dates for each portfolio ticker and flags contracts where:

$$\frac{V_{\text{today}}}{\text{OI}_{\text{prior close}}} > 2$$

where $V_{\text{today}}$ is today's contract volume and $\text{OI}$ is open interest as of the prior session's close.

A ratio exceeding 2 means more contracts traded today than the total outstanding position entering the session. This can indicate new position opening (directional bet), hedging (institutional protection), or informed pre-catalyst trading.

**Color coding:** Vol/OI ≥ 5× in red, 3–5× in orange, 2–3× in neutral.

**Caveat on statistical significance:** The Vol/OI ratio is not normalized by the absolute level of activity. A contract with OI = 1 and Vol = 6 produces a 6× ratio but represents only 600 shares of notional exposure — likely not economically significant. For small-cap names with thin option markets, high ratios should be evaluated alongside absolute volume. A more robust measure would be Vol relative to average daily volume (ADV), but this requires historical volume data not currently available from yfinance's free tier.

Results are sorted by ratio descending and capped at 20 entries.

---

## Max Loss & Margin Estimation

### Max Loss

Max loss is computed per ticker with hedging detection. Positions are grouped by ticker to identify covered positions before calculating risk.

- **Long equity:** $\text{max loss} = \text{shares} \times \text{cost basis}$ (underlying goes to zero)
- **Short puts (cash-secured):** $\text{max loss} = (K \times 100 \times n) - (\bar{c} \times 100 \times n)$ where $\bar{c}$ is avg premium received per share. This assumes assignment at the strike and total loss of the underlying, offset by kept premium.
- **Short calls (covered):** \$0 additional max loss. The short call is backed by long shares — the equity's max loss is counted separately. The call caps upside but creates no new downside.
- **Short calls (naked):** $\text{max loss} \approx 3 \times S \times 100 \times n$. Theoretically unlimited, but a 3× price cap provides a practical upper-bound estimate.
- **Long options:** $\text{max loss} = \bar{c} \times \text{contracts} \times 100$ (total premium paid, lost if option expires worthless).

Coverage detection: For each ticker, long share quantity is tracked. Short calls are matched against available shares — up to $\lfloor\text{shares} / 100\rfloor$ contracts are considered covered, the remainder naked.

### Estimated Margin (Reg-T)

Reg-T maintenance margin for short equity options follows the CBOE minimum:

**Short puts:**

$$\text{Margin}_{\text{naked}} = \max\!\Big(0.20 \cdot S - \max(K - S,\, 0) + \bar{c},\;\; 0.10 \cdot K + \bar{c}\Big) \times n \times 100$$

$$\text{Margin}_{\text{CSP}} = K \times n \times 100$$

$$\text{Margin}_{\text{put}} = \min(\text{Margin}_{\text{naked}},\; \text{Margin}_{\text{CSP}})$$

The $\min$ reflects that a cash-secured account pledges the full strike value, while Reg-T naked margin may be lower for OTM puts. Brokers typically use the lower of the two.

**Short calls (naked):**

$$\text{Margin}_{\text{call}} = \max\!\Big(0.20 \cdot S - \max(S - K,\, 0) + \bar{c},\;\; 0.10 \cdot S + \bar{c}\Big) \times n \times 100$$

**Short calls (covered):** \$0 additional margin.

**Long equity:** $0.25 \times S \times \text{shares}$ (25% Reg-T maintenance).

**Note:** This is an approximation of CBOE/Reg-T minimums. Actual margin depends on broker risk parameters, portfolio margin eligibility (which uses OCC's STANS methodology — a full Monte Carlo VaR approach), and real-time risk checks. SPAN margin for futures-style options also differs significantly.

---

## Roll Analyzer

When you click "Roll" on a short option, the analyzer:

1. Computes the current position's **theoretical value** using BSM at the current spot, IV, and remaining DTE.
2. Fetches the target expiry/strike's option chain and extracts the **mid price** $(\text{bid} + \text{ask}) / 2$ and chain IV.
3. Computes the net credit/debit per contract:

$$\text{net} = \text{mid}_{\text{target}} - V_{\text{current}}^{\text{BS}}$$

   For a short position, this is what you'd receive (credit) or pay (debit) to close the current leg and open the new one.

4. Computes the **new average cost**: $\bar{c}_{\text{new}} = \bar{c}_{\text{current}} + \text{net}$. For credit rolls, this increases the premium cushion; for debit rolls, it reduces it.

5. Reports the **Greeks differential** — the change in each Greek from the current position to the target:

$$\Delta\Delta = \Delta_{\text{target}} - \Delta_{\text{current}}, \quad \text{etc. for } \Gamma, \Theta, \mathcal{V}$$

---

## Strategy Classification

Positions are classified per ticker per expiry by decomposing the leg structure. The classifier uses a greedy pairing algorithm:

**Phase 1 — Same-strike pairing:** For each short call strike, check for a short put at the same strike (within \$0.01). Paired legs with matching quantities form **Covered Straddles** (if shares back the calls).

**Phase 2 — Cross-strike pairing:** Remaining unpaired short calls and short puts are matched into **Covered Strangles** (if shares available) or **Short Strangles** (if no shares).

**Phase 3 — Residual classification:** Unpaired short calls become Covered Calls (if shares remain) or naked. Unpaired short puts become Short Puts. Long options become Protective Puts, Long Calls, etc.

| Pattern | Classification |
|---------|---------------|
| Long shares + short calls (≤ covered ratio) | Covered Call(s) |
| Long shares + short puts | Long Shares + Short Puts |
| Long shares + short calls + short puts (same strike) | Covered Straddle(s) |
| Long shares + short calls + short puts (different strikes) | Covered Strangle(s) |
| Long shares + long puts | Protective Put(s) |
| Long shares + 1 short call + 1 long put | Collar w/ Shares |
| Short put + short call (same strike, no shares) | Short Straddle |
| Short put + short call (different strikes, no shares) | Short Strangle |
| All short puts, no other legs | Short Puts |
| All short calls, no other legs | Short Calls |
| Complex multi-leg | N-Leg NC/NP |

For multi-strategy tickers (e.g., RGNX with straddles at one strike and strangles at another), the greedy algorithm processes same-strike first, so the classification reflects the dominant structure. Display names are compressed — "Covered Strangles ×4 + Covered Straddle + Short Put" — with the full name available on hover.

---

## Breakeven Calculation

For each ticker's combined position (all legs across expiries), breakevens are found by numerical root-finding on the terminal payoff function.

**Step 1:** Construct the net payoff function $f(S)$ at expiry, combining options and equity:

$$f(S) = \sum_{i \in \text{options}} \text{qty}_i \times \Big[\text{intrinsic}_i(S) - \bar{c}_i\Big] + \sum_{i \in \text{equity}} \frac{\text{shares}_i}{100} \times (S - b_i)$$

where:
- $\text{intrinsic}_{\text{call}}(S) = \max(S - K, 0)$
- $\text{intrinsic}_{\text{put}}(S) = \max(K - S, 0)$
- $\bar{c}_i$ = average cost per share
- $b_i$ = adjusted cost basis for equity
- Equity is scaled by $1/100$ for unit consistency with option contracts

**Step 2:** Evaluate $f$ on a uniform grid of 4,000 points over $[0.01 \cdot S_0,\; 4 \cdot S_0]$.

**Step 3:** Find sign changes: for each adjacent pair $(f(S_j),\, f(S_{j+1}))$ where $f$ changes sign, compute the zero crossing by linear interpolation:

$$S^* = S_j - f(S_j) \cdot \frac{S_{j+1} - S_j}{f(S_{j+1}) - f(S_j)}$$

**Step 4:** Filter: breakevens $\leq 0$ are discarded (mathematical artifacts from the grid extending to near-zero prices, not tradeable scenarios). Duplicates within rounding tolerance are removed.

Multiple breakevens arise naturally: a covered strangle, for example, has breakevens above and below the strike range. The adjusted cost basis (if shares are held) can create additional crossings.

---

## Trade History Analysis

The history parser reads brokerage transaction CSVs and pairs opening/closing trades by OCC symbol.

**Step 1 — Column detection:** The parser scans the first 10 lines for a header row containing column names (e.g., "Run Date", "Action", "Symbol", "Quantity", "Price"). Column indices are mapped dynamically rather than hardcoded, supporting Fidelity, Schwab, and IBKR formats.

**Step 2 — Grouping:** Transactions are grouped by OCC symbol (e.g., `-OVID260618P2.5`).

**Step 3 — Pairing:** Within each symbol group, OPENING transactions are paired with subsequent CLOSING or EXPIRED entries.

**Step 4 — P&L computation:**

For short positions (sold to open, bought to close):

$$\mathrm{PnL} = (\bar{p}_{\text{open}} - \bar{p}_{\text{close}}) \times \text{qty} \times 100$$

For long positions (bought to open, sold to close):

$$\mathrm{PnL} = (\bar{p}_{\text{close}} - \bar{p}_{\text{open}}) \times \text{qty} \times 100$$

For expired positions: $\bar{p}_{\text{close}} = 0$ (total loss for longs, full profit for shorts).

**Statistics:**

- **Win rate:** $\frac{|\{i : \mathrm{PnL}_i > 0\}|}{n}$
- **Profit factor:** $\frac{\sum_{i:\mathrm{PnL}_i > 0} \mathrm{PnL}_i}{\big|\sum_{i:\mathrm{PnL}_i < 0} \mathrm{PnL}_i\big|}$ — ratio of gross profits to gross losses. Values > 1 indicate net profitability. Undefined (displayed as ∞) when no losing trades exist.
- **Expectancy:** $\frac{1}{n}\sum_i \mathrm{PnL}_i$ — average P&L per trade.
- **Average hold:** Mean calendar days between open and close dates.

---

## Data Pipeline

The full fetch sequence runs in order:

1. **CSV parsing** — positions and fills extracted, closed positions filtered out, share positions reconstructed with premium-adjusted cost basis
2. **Market data** — batch fetch of price, IV (from option chain), HV20, HV60, IV rank, IV percentile, expected move, ex-dividend dates
3. **Greeks** — BSM greeks computed per position, aggregated by ticker and portfolio, beta-weighted to SPY
4. **Events** — earnings dates fetched per ticker via yfinance; custom catalysts loaded from SQLite
5. **Trade history** — round-trip trades paired, P&L computed, stats aggregated

Simulation runs separately on demand and produces fan charts, P&L distributions, correlation heatmaps, and theta projections.

---

## IV Data Sources & Fallbacks

| Priority | Source | Derivation |
|----------|--------|------------|
| 1 | Option chain median put IV | Median of `impliedVolatility` for all puts with IV > 0 from the nearest expiry, fetched via `yf.Ticker.option_chain()`. Reported in percent. |
| 2 | HV20 (20-day historical vol) | $\hat\sigma = \text{std}(\ln P_t / P_{t-1}, \text{window}=20) \times \sqrt{252} \times 100$. Used when no option chain exists. Marked "(est. from HV)" in the UI. |
| 3 | Default 60% | Last resort when neither chain nor price history is available. |

**IV Rank** (IVR): Measures where current IV sits relative to its 1-year range, using rolling 20-day HV as the reference distribution:

$$\text{IVR} = \frac{\text{IV}_{\text{current}} - \text{HV}_{\min}^{(1y)}}{\text{HV}_{\max}^{(1y)} - \text{HV}_{\min}^{(1y)}} \times 100$$

where $\text{HV}_{\min}^{(1y)}$ and $\text{HV}_{\max}^{(1y)}$ are the minimum and maximum values of the 20-day rolling HV over the trailing 252 trading days. IVR of 0% means IV equals the 1-year HV low; 100% means it equals the high.

**IV Percentile** (IVP): The empirical percentile rank of current IV within the trailing 1-year HV distribution:

$$\text{IVP} = \frac{|\{t : \text{HV}_{20,t} < \text{IV}_{\text{current}}\}|}{|\text{all rolling HV observations}|} \times 100$$

IVP of 85% means current IV exceeds 85% of the daily rolling HV readings over the past year. IVP is generally more robust than IVR because it's not sensitive to outlier HV extremes.

---

## Expected Move

The expected 1-standard-deviation move over $n$ calendar days:

$$\text{EM}_n = S \times \sigma \times \sqrt{\frac{n}{365}}$$

where $\sigma$ is IV in decimal form. This uses 365 (calendar days) rather than 252 (trading days) because option expiry is measured in calendar time, and the IV quoted by the market is conventionally annualized over calendar days in this context.

Under log-normal assumptions, approximately 68.2% of outcomes fall within $\pm \text{EM}$ of the current price. Displayed for $n \in \{7, 14, 30, 60\}$.

**Note:** This is a rough heuristic. The actual expected range depends on the full implied distribution (including skew and kurtosis embedded in the vol surface), not just ATM IV. For a more precise expected range, one would integrate the risk-neutral density implied by the full option chain (Breeden-Litzenberger).

---

## Desk alerts

After each **Fetch** (and on auto-refresh / marks refresh), the frontend POSTs to `/api/desk-alerts` with positions, market data, greeks, simulation results, marks timestamp, and user thresholds. Rules include:

| Category | Trigger (defaults) |
|----------|-------------------|
| **Book Δ / V / Θ** | Portfolio greek vs limit (e.g. \|Δ\| > 500 sh-eq) |
| **Ticker Δ** | Per-symbol delta concentration |
| **DTE** | Short legs within 7d (high) or 21d (medium) |
| **IVR** | Short leg with IV rank ≥ 75% |
| **Ex-div** | Short calls within 14d of ex-dividend |
| **Sim P(profit)** | Portfolio or ticker Monte Carlo win rate below floor |
| **Stale marks** | Option marks older than 15 minutes |

Alerts have stable keys for dismiss persistence (session) and deduped logging to SQLite (`alert_events`). See Positions right rail **⚙** for thresholds.

---

## Limitations & Assumptions

- **BSM model:** Assumes log-normal returns (geometric Brownian motion), constant volatility, zero dividends, continuous trading, and frictionless markets. Real markets exhibit volatility clustering (GARCH effects), leverage effects, discrete trading, transaction costs, and early exercise optionality (for American options, which are the standard for equity options — BSM prices European options, introducing systematic mispricing for deep ITM options where early exercise is optimal).
- **Risk-free rate:** Defaults to `0.037` in `app.py`; override with the `RISK_FREE` environment variable (e.g. in `.env`). Update if the effective rate moves materially.
- **Theta projection:** Static-vol, static-spot assumption. In practice, theta is path-dependent: ATM theta follows a $1/\sqrt{T}$ acceleration toward expiry, large price moves shift moneyness (changing the theta regime), and IV changes directly scale the vega-weighted theta contribution. Treat the projection as a premium structure map, not a P&L forecast.
- **Margin estimation:** Approximates CBOE/Reg-T minimums. Portfolio margin (OCC STANS, a full Monte Carlo VaR at 99.5% over a 2-day horizon with concentration and liquidity charges) produces substantially different — usually lower — requirements for hedged portfolios.
- **Yahoo Finance data:** Free tier has rate limits (~2,000 requests/hour), occasional stale data (especially for small-cap option chains), and returns NaN for illiquid contracts. The application handles NaN via `pd.notna()` checks, but data quality depends entirely on yfinance.
- **Strategy classification:** Greedy pairing heuristic operating per-ticker per-expiry. Cross-expiry structures (calendar spreads, diagonals) are not recognized as unified strategies. Exotic combinations may not classify precisely.
- **Correlation:** Uses trailing 1-year daily log-return correlation, which is stationary only in expectation. Correlation tends to increase during market stress (the "diversification breakdown" phenomenon), so the simulation may understate tail risk for multi-ticker portfolios in crisis scenarios. A more robust approach would use DCC-GARCH or regime-switching correlation models, but these require substantially more data and computation.
- **Jump-diffusion calibration:** The Merton parameters ($\lambda$, $\mu_J$, $\sigma_J$, $\sigma_d$ allocation) are heuristic rather than calibrated to the observed option surface. Proper calibration would require fitting the model to observed option prices across strikes and expiries via nonlinear least squares or the Fourier-based characteristic function approach (Carr-Madan), which is beyond the scope of a portfolio dashboard.
