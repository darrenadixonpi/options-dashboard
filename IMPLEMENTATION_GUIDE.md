# Options Dashboard — Feature Implementation Guide

**Purpose**: This document specifies every new feature to add, in build order, with exact function signatures, data contracts, API response shapes, and placement instructions. Each section is self-contained and references the existing codebase by line number and function name.

**Architecture rule**: All heavy computation stays in `app.py` (Python/numpy/scipy). The frontend (`static/index.html`) handles rendering only. New API endpoints return JSON; the frontend consumes them.

**Build order**: Tier 1 features are independent of each other and can be built in any order. Tier 2 features may depend on Tier 1. Tier 3 depends on Tier 2.

---

## TABLE OF CONTENTS

### TIER 1 — Drop-in additions (hours each, no new dependencies)
1. [Full Greeks per Position (Delta, Gamma, Vega)](#1-full-greeks-per-position)
2. [Portfolio Beta-Weighted Delta](#2-portfolio-beta-weighted-delta)
3. [Max Loss & Margin Estimation](#3-max-loss--margin-estimation)
4. [Expected Move Display](#4-expected-move-display)
5. [Profit Target % Badges](#5-profit-target--badges)
6. [DTE Alert Badges](#6-dte-alert-badges)
7. [Dividend Ex-Date Flagging](#7-dividend-ex-date-flagging)

### TIER 2 — Moderate engineering (days each, still free data)
8. [Earnings & Catalyst Calendar](#8-earnings--catalyst-calendar)
9. [Correlated Monte Carlo (Cholesky)](#9-correlated-monte-carlo)
10. [Correlation Heatmap Widget](#10-correlation-heatmap)
11. [Roll Analyzer](#11-roll-analyzer)
12. [Historical Trade Performance](#12-historical-trade-performance)
13. [P&L Attribution / Greek Decomposition](#13-pnl-attribution)

### TIER 3 — Significant engineering (weeks, still free data)
14. [Risk Matrix Heatmap (Price × IV Scenario Grid)](#14-risk-matrix-heatmap)
15. [What-If Trade Analyzer](#15-what-if-trade-analyzer)
16. [Volatility Term Structure & Skew](#16-volatility-surface)
17. [Options Flow / Unusual Volume](#17-options-flow)

### CROSS-CUTTING
18. [SQLite Persistence Layer](#18-sqlite-persistence)
19. [New Tab Structure](#19-new-tab-structure)

---

## 1. Full Greeks per Position

### Backend: `app.py`

Add these functions after the existing `bs_theta_per_day` function (line ~556):

```python
def bs_greeks(S, K, r, iv, T_years, opt_type):
    """
    Compute all Black-Scholes greeks for a single option.
    Returns dict with delta, gamma, theta, vega (all per-share, not per-contract).
    """
    if T_years <= 1e-6 or iv <= 0 or S <= 0 or K <= 0:
        return {"delta": 0, "gamma": 0, "theta": 0, "vega": 0}

    sqrt_T = np.sqrt(T_years)
    d1 = (np.log(S / K) + (r + 0.5 * iv**2) * T_years) / (iv * sqrt_T)
    d2 = d1 - iv * sqrt_T
    phi_d1 = np.exp(-0.5 * d1**2) / np.sqrt(2 * np.pi)  # standard normal PDF

    if opt_type == "call":
        delta = float(norm.cdf(d1))
        theta = (-(S * phi_d1 * iv) / (2 * sqrt_T)
                 - r * K * np.exp(-r * T_years) * norm.cdf(d2))
    else:
        delta = float(norm.cdf(d1) - 1)
        theta = (-(S * phi_d1 * iv) / (2 * sqrt_T)
                 + r * K * np.exp(-r * T_years) * norm.cdf(-d2))

    gamma = float(phi_d1 / (S * iv * sqrt_T))
    vega = float(S * phi_d1 * sqrt_T / 100)  # per 1 vol point
    theta_daily = float(theta / 365)

    return {
        "delta": round(delta, 4),
        "gamma": round(gamma, 6),
        "theta": round(theta_daily, 4),
        "vega": round(vega, 4),
    }
```

### New API endpoint: `/api/greeks`

Add after the `/api/simulate` route:

```python
@app.route("/api/greeks", methods=["POST"])
def compute_greeks():
    """
    POST { "positions": [...], "marketData": { ticker: { price, iv } } }
    Returns per-position and per-ticker aggregate greeks.
    """
    try:
        body = request.json
        positions = body.get("positions", [])
        market = body.get("marketData", {})
        today = pd.Timestamp.now().normalize()

        position_greeks = []
        ticker_greeks = {}  # ticker → aggregated greeks

        for p in positions:
            tkr = p["ticker"]
            md = market.get(tkr, {})
            S = md.get("price", 0)
            iv_pct = md.get("iv", 0)
            iv = iv_pct / 100 if iv_pct else 0

            if p.get("posType") == "equity":
                shares = p.get("shares", p.get("contracts", 0))
                pg = {
                    "ticker": tkr, "posType": "equity",
                    "delta": shares,  # equity delta = shares
                    "gamma": 0, "theta": 0, "vega": 0,
                    "notional": shares * S if S else 0,
                }
                position_greeks.append(pg)
                agg = ticker_greeks.setdefault(tkr, {"delta": 0, "gamma": 0, "theta": 0, "vega": 0})
                agg["delta"] += shares
                continue

            # Option position
            if not S or not iv or not p.get("expiry"):
                position_greeks.append({
                    "ticker": tkr, "strike": p.get("strike"),
                    "optType": p.get("optType"), "expiry": p.get("expiry"),
                    "delta": 0, "gamma": 0, "theta": 0, "vega": 0,
                })
                continue

            dte = max((pd.Timestamp(p["expiry"]) - today).days, 1)
            T = dte / 365.0
            opt_type = (p.get("optType") or "put").lower()
            strike = p.get("strike", 0)
            contracts = p.get("contracts", 0)
            multiplier = contracts * 100  # sign captures long/short

            greeks = bs_greeks(S, strike, RISK_FREE, iv, T, opt_type)

            pg = {
                "ticker": tkr, "strike": strike,
                "optType": p.get("optType"), "expiry": p.get("expiry"),
                "contracts": contracts,
                # Position-level greeks (multiplied by contracts × 100)
                "delta": round(greeks["delta"] * multiplier, 2),
                "gamma": round(greeks["gamma"] * multiplier, 4),
                "theta": round(greeks["theta"] * multiplier, 2),
                "vega": round(greeks["vega"] * multiplier, 2),
                # Per-contract greeks (for display)
                "perContract": greeks,
            }
            position_greeks.append(pg)

            agg = ticker_greeks.setdefault(tkr, {"delta": 0, "gamma": 0, "theta": 0, "vega": 0})
            agg["delta"] += pg["delta"]
            agg["gamma"] += pg["gamma"]
            agg["theta"] += pg["theta"]
            agg["vega"] += pg["vega"]

        # Round aggregates
        for tkr in ticker_greeks:
            for k in ticker_greeks[tkr]:
                ticker_greeks[tkr][k] = round(ticker_greeks[tkr][k], 2)

        # Portfolio totals
        portfolio_greeks = {"delta": 0, "gamma": 0, "theta": 0, "vega": 0}
        for tg in ticker_greeks.values():
            for k in portfolio_greeks:
                portfolio_greeks[k] += tg[k]
        for k in portfolio_greeks:
            portfolio_greeks[k] = round(portfolio_greeks[k], 2)

        return jsonify({
            "positions": position_greeks,
            "byTicker": ticker_greeks,
            "portfolio": portfolio_greeks,
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500
```

### Frontend integration

**When to call**: After market data is fetched (inside the `btn-fetch` click handler, after `buildPortfolio`). Store result in `state.greeks`.

**Dashboard display**: Add a new summary row below the existing theta summary cards. Show:
- Portfolio Δ, Γ, Θ, V as four stat cards
- In each ticker header (`renderTickerHeader`), append per-ticker net delta below the IV line
- In each strike row (`renderStrike`), show per-contract delta in a small badge next to the ITM/OTM badge

**Data flow**:
```javascript
// After buildPortfolio in btn-fetch handler:
const greeksRes = await fetch("/api/greeks", {
  method: "POST",
  headers: {"Content-Type": "application/json"},
  body: JSON.stringify({
    positions: state.positions.map(p => ({
      ticker: p.ticker, expiry: p.expiry ? dateKey(p.expiry) : null,
      strike: p.strike, optType: p.optType,
      contracts: p.contracts, shares: p.shares || 0,
      posType: p.posType || "option",
    })),
    marketData: state.marketData,
  })
});
state.greeks = await greeksRes.json();
```

**Greeks summary HTML** (add inside `renderPortfolio`, after the theta summary):
```javascript
if (state.greeks && state.greeks.portfolio) {
  const g = state.greeks.portfolio;
  document.getElementById("greeks-dashboard-summary").hidden = false;
  document.getElementById("greeks-dashboard-summary").innerHTML = `
    <div class="stat" style="border-left:3px solid #90caf9">
      <div class="stat-label">Portfolio Δ</div>
      <div class="stat-val" style="font-size:18px;color:#90caf9">${g.delta.toFixed(0)}</div>
    </div>
    <div class="stat" style="border-left:3px solid #ce93d8">
      <div class="stat-label">Portfolio Γ</div>
      <div class="stat-val" style="font-size:18px;color:#ce93d8">${g.gamma.toFixed(2)}</div>
    </div>
    <div class="stat" style="border-left:3px solid #f5c518">
      <div class="stat-label">Portfolio Θ</div>
      <div class="stat-val" style="font-size:18px;color:#f5c518">$${g.theta.toFixed(0)}</div>
    </div>
    <div class="stat" style="border-left:3px solid #a5d6a7">
      <div class="stat-label">Portfolio V</div>
      <div class="stat-val" style="font-size:18px;color:#a5d6a7">$${g.vega.toFixed(0)}</div>
    </div>`;
}
```

Add the container div in the dashboard tab HTML (after `theta-dashboard-summary`):
```html
<div class="summary" id="greeks-dashboard-summary" hidden></div>
```

---

## 2. Portfolio Beta-Weighted Delta

### Backend: add to `/api/greeks` endpoint

Extend the `/api/greeks` handler to also compute beta-weighted delta. Add this block before the `return jsonify(...)`:

```python
        # Beta-weighted delta (to SPY)
        beta_weighted = None
        try:
            spy = yf.Ticker("SPY")
            spy_hist = spy.history(period="6mo")
            spy_price = float(spy_hist["Close"].iloc[-1])
            spy_ret = np.log(spy_hist["Close"] / spy_hist["Close"].shift(1)).dropna()

            bw_delta = 0
            for tkr in ticker_greeks:
                md = market.get(tkr, {})
                tkr_price = md.get("price", 0)
                if not tkr_price:
                    continue
                # Estimate beta from 60-90 day returns
                try:
                    tkr_hist = yf.Ticker(tkr).history(period="6mo")
                    tkr_ret = np.log(tkr_hist["Close"] / tkr_hist["Close"].shift(1)).dropna()
                    # Align dates
                    aligned = pd.DataFrame({"spy": spy_ret, "tkr": tkr_ret}).dropna()
                    if len(aligned) >= 30:
                        cov = np.cov(aligned["tkr"], aligned["spy"])
                        beta = float(cov[0, 1] / cov[1, 1])
                    else:
                        beta = 1.0
                except Exception:
                    beta = 1.0

                # Beta-weighted delta for this ticker
                # = position_delta × ticker_price × beta / spy_price
                pos_delta = ticker_greeks[tkr]["delta"]
                bw_delta += pos_delta * tkr_price * beta / spy_price

            beta_weighted = {
                "delta": round(bw_delta, 2),
                "spyPrice": round(spy_price, 2),
                "equivalent": f"{'Long' if bw_delta > 0 else 'Short'} {abs(round(bw_delta))} SPY shares",
            }
        except Exception as e:
            print(f"Beta-weight error: {e}", file=sys.stderr)
```

Add `"betaWeighted": beta_weighted` to the return dict.

### Frontend

Add another stat card to the greeks summary:
```javascript
if (state.greeks.betaWeighted) {
  const bw = state.greeks.betaWeighted;
  // Append to the greeks summary
  greeksSummaryEl.innerHTML += `
    <div class="stat" style="border-left:3px solid #ffcc02">
      <div class="stat-label">β-Weighted Δ (SPY)</div>
      <div class="stat-val" style="font-size:18px;color:#ffcc02">${bw.delta.toFixed(0)}</div>
      <div style="font-size:10px;color:var(--tx3);margin-top:2px">≈ ${bw.equivalent}</div>
    </div>`;
}
```

**Performance note**: This makes N+1 yfinance calls (SPY + each ticker). To avoid re-fetching, cache the 6-month histories from the initial `/api/market-data` call in a module-level dict, or combine this into the `/api/greeks` endpoint which already has access to market data. The beta calculation only needs to run once per session, not on every re-render.

---

## 3. Max Loss & Margin Estimation

### Backend: new function + embed in `/api/greeks` response

```python
def compute_risk_metrics(positions, market):
    """Compute max loss and estimated Reg-T margin for the portfolio."""
    total_max_loss = 0
    total_margin = 0
    position_risk = []

    for p in positions:
        tkr = p["ticker"]
        md = market.get(tkr, {})
        S = md.get("price", 0)

        if p.get("posType") == "equity":
            shares = p.get("shares", p.get("contracts", 0))
            cost = p.get("adjCost") or p.get("avgCost", 0)
            # Long shares: max loss = shares × cost (goes to zero)
            # Short shares: max loss = unlimited (cap at 3× price for display)
            if shares > 0:
                ml = shares * cost
                margin = shares * S * 0.25 if S else 0  # 25% Reg-T
            else:
                ml = abs(shares) * S * 2 if S else 0  # capped estimate
                margin = abs(shares) * S * 0.30 if S else 0
            position_risk.append({"ticker": tkr, "posType": "equity", "maxLoss": round(ml, 2), "margin": round(margin, 2)})
            total_max_loss += ml
            total_margin += margin
            continue

        strike = p.get("strike", 0)
        contracts = p.get("contracts", 0)
        avg_cost = p.get("avgCost", 0)
        opt_type = (p.get("optType") or "put").lower()

        if contracts < 0:
            # Short options
            n = abs(contracts)
            premium_received = avg_cost * n * 100

            if opt_type == "put":
                # Short put: max loss = (strike × 100 × n) - premium
                ml = strike * 100 * n - premium_received
                # Reg-T: greater of (20% underlying - OTM + prem) or (10% strike + prem)
                otm = max(strike - S, 0) if S else 0
                margin_a = (0.20 * S - otm + avg_cost) * n * 100 if S else 0
                margin_b = (0.10 * strike + avg_cost) * n * 100
                margin = max(margin_a, margin_b)
            else:
                # Short call: max loss = unlimited (cap at 5× price)
                ml = 5 * S * 100 * n if S else strike * 500 * n
                otm = max(S - strike, 0) if S else 0
                margin_a = (0.20 * S - otm + avg_cost) * n * 100 if S else 0
                margin_b = (0.10 * S + avg_cost) * n * 100 if S else 0
                margin = max(margin_a, margin_b)

            position_risk.append({
                "ticker": tkr, "strike": strike, "optType": p.get("optType"),
                "maxLoss": round(ml, 2), "margin": round(margin, 2),
            })
            total_max_loss += ml
            total_margin += margin
        else:
            # Long options: max loss = premium paid
            ml = avg_cost * contracts * 100
            position_risk.append({
                "ticker": tkr, "strike": strike, "optType": p.get("optType"),
                "maxLoss": round(ml, 2), "margin": 0,
            })
            total_max_loss += ml

    return {
        "positions": position_risk,
        "totalMaxLoss": round(total_max_loss, 2),
        "totalMargin": round(total_margin, 2),
    }
```

Call `compute_risk_metrics(positions, market)` inside the `/api/greeks` endpoint and include the result:
```python
risk = compute_risk_metrics(positions, market)
# ... add to return:
return jsonify({
    "positions": position_greeks,
    "byTicker": ticker_greeks,
    "portfolio": portfolio_greeks,
    "betaWeighted": beta_weighted,
    "risk": risk,
})
```

### Frontend

Add risk stat cards to the greeks summary section:
```javascript
if (state.greeks.risk) {
  const r = state.greeks.risk;
  greeksSummaryEl.innerHTML += `
    <div class="stat" style="border-left:3px solid var(--err-tx)">
      <div class="stat-label">Max Loss (theoretical)</div>
      <div class="stat-val" style="font-size:16px;color:var(--err-tx)">$${r.totalMaxLoss.toLocaleString()}</div>
    </div>
    <div class="stat" style="border-left:3px solid var(--warn-tx)">
      <div class="stat-label">Est. Margin Req.</div>
      <div class="stat-val" style="font-size:16px;color:var(--warn-tx)">$${r.totalMargin.toLocaleString()}</div>
    </div>`;
}
```

---

## 4. Expected Move Display

### Backend: add to `/api/market-data` response

Inside `fetch_ticker_data()`, add expected move calculations. After computing IV (around line 77), add:

```python
# Expected move for common periods
if data["iv"] and data["price"]:
    iv_dec = data["iv"] / 100
    price = data["price"]
    for label, days in [("1w", 7), ("2w", 14), ("1m", 30), ("2m", 60)]:
        em = round(price * iv_dec * np.sqrt(days / 365), 2)
        em_pct = round(iv_dec * np.sqrt(days / 365) * 100, 1)
        data[f"em_{label}"] = em
        data[f"em_{label}_pct"] = em_pct
```

This adds `em_1w`, `em_1w_pct`, `em_2w`, `em_2w_pct`, `em_1m`, `em_1m_pct`, `em_2m`, `em_2m_pct` to each ticker's market data.

### Frontend

In `renderTickerHeader()`, after the IV line, add:

```javascript
// Expected move for nearest expiry
let emLine = "";
if (tg.iv != null && tg.price > 0) {
  // Calculate expected move for the nearest expiry DTE
  // Use pre-computed values from market data
  const md = state.marketData?.[tg.ticker];
  if (md) {
    const em1m = md.em_1m;
    const em1mPct = md.em_1m_pct;
    if (em1m) {
      emLine = `<span class="tk-iv" style="color:var(--tx3);font-size:10px">EM ±$${em1m} (±${em1mPct}%) 30d</span>`;
    }
  }
}
```

Insert `${emLine}` in the ticker header HTML after the IV rank line.

---

## 5. Profit Target % Badges

This is a **frontend-only** change — no backend needed.

### Logic

For each short option position, compute:
```
current_value = market_mid_price_of_option  (not available from yfinance easily)
```

Since we don't have live option mid prices from the current data flow, use an approximation:
- For short options, the profit target is based on theta decay. A simpler approach: compute the Black-Scholes theoretical value at current price/IV/DTE and compare to the premium received.

**Alternative (simpler, no new data)**: Use the intrinsic value as a floor. If the option is OTM, the profit target badge is "max profit if held to expiry." Show DTE-based urgency instead.

Modify `renderStrike()` to add a badge for short options:

```javascript
// Inside renderStrike, for option positions:
if (sg.contracts < 0 && sg.lots.length > 0) {
  const avgFill = sg.lots.reduce((s, l) => s + l.price * l.quantity, 0) /
                  sg.lots.reduce((s, l) => s + l.quantity, 0);
  // Rough profit estimate: if OTM, most premium is captured already
  // Show as "X% of max" where max = total premium received
  const premReceived = avgFill;  // per-share premium
  if (premReceived > 0) {
    // This is a placeholder - proper implementation needs live option pricing
    // For now, show the fill info as premium captured context
    const totalPrem = premReceived * Math.abs(sg.contracts) * 100;
    html += `<span style="font-size:10px;color:var(--tx3);font-family:var(--mono)">$${totalPrem.toFixed(0)} prem</span>`;
  }
}
```

**Better implementation (requires adding to `/api/market-data`)**: Fetch the current option bid for each position's OCC symbol and compute exact profit % = (premium_received - current_ask) / premium_received.

To add this properly, extend the backend:

```python
# In fetch_ticker_data, after getting the option chain:
# Build a dict of option mid prices by strike/expiry/type
option_prices = {}
for exp in exps:
    chain = tk.option_chain(exp)
    for _, row in chain.puts.iterrows():
        key = f"{exp}|P|{row['strike']}"
        option_prices[key] = round((row.get("bid", 0) + row.get("ask", 0)) / 2, 4)
    for _, row in chain.calls.iterrows():
        key = f"{exp}|C|{row['strike']}"
        option_prices[key] = round((row.get("bid", 0) + row.get("ask", 0)) / 2, 4)
data["option_prices"] = option_prices
```

**Warning**: This dramatically increases the API call time since it fetches every expiry's chain. Consider making this a separate endpoint (`/api/option-prices`) that's called lazily only when the user clicks a "Show profit targets" button.

---

## 6. DTE Alert Badges

**Frontend-only** — add to `renderStrike()` for option positions.

```javascript
// After the ITM/OTM badge, add DTE badge:
if (pos.expiry) {
  const now = new Date();
  const exp = new Date(pos.expiry);
  const dte = Math.ceil((exp - now) / 86400000);
  let dteBadge = "";
  if (dte <= 7) {
    dteBadge = `<span class="badge badge-danger" style="font-size:9px;margin-left:4px">${dte}d ⚡</span>`;
  } else if (dte <= 21) {
    dteBadge = `<span class="badge badge-warn" style="font-size:9px;margin-left:4px">${dte}d</span>`;
  }
  // Append dteBadge next to the status badge
}
```

Integrate this into the `renderStrike` function by appending `dteBadge` after the status `<span class="badge ...">` element. The data is already available — each position has `pos.expiry`.

---

## 7. Dividend Ex-Date Flagging

### Backend: add to `fetch_ticker_data()`

After the IV computation block, add:

```python
# Dividend data
try:
    cal = tk.calendar
    if cal is not None and not cal.empty:
        if "Ex-Dividend Date" in cal.index:
            ex_date = cal.loc["Ex-Dividend Date"]
            if hasattr(ex_date, "iloc"):
                ex_date = ex_date.iloc[0]
            if pd.notna(ex_date):
                data["exDivDate"] = str(ex_date.date()) if hasattr(ex_date, "date") else str(ex_date)
        if "Dividend Date" in cal.index:
            div_date = cal.loc["Dividend Date"]
            if hasattr(div_date, "iloc"):
                div_date = div_date.iloc[0]
        # Get dividend amount from recent history
        divs = tk.dividends
        if not divs.empty:
            data["lastDividend"] = round(float(divs.iloc[-1]), 4)
except Exception:
    pass
```

### Frontend

In `renderTickerHeader()`, check for ex-div date and flag if a short call is ITM/ATM near that date:

```javascript
const md = state.marketData?.[tg.ticker];
if (md?.exDivDate) {
  const exDiv = new Date(md.exDivDate);
  const now = new Date();
  const daysToExDiv = Math.ceil((exDiv - now) / 86400000);
  if (daysToExDiv > 0 && daysToExDiv <= 30) {
    // Check if any short calls exist for this ticker
    const hasShortCalls = state.positions.some(p =>
      p.ticker === tg.ticker && p.optType === "Call" && p.contracts < 0
    );
    if (hasShortCalls) {
      ivLine += `<span class="tk-iv" style="color:var(--warn-tx)">⚠ Ex-div $${md.lastDividend || "?"} in ${daysToExDiv}d</span>`;
    }
  }
}
```

---

## 8. Earnings & Catalyst Calendar

### Backend: new endpoint `/api/events`

```python
@app.route("/api/events", methods=["POST"])
def get_events():
    """
    POST { "tickers": [...] }
    Returns earnings dates and any detectable events per ticker.
    """
    tickers = request.json.get("tickers", [])
    events = {}
    for tkr in tickers:
        tkr_events = []
        try:
            tk = yf.Ticker(tkr)
            # Earnings dates
            try:
                ed = tk.earnings_dates
                if ed is not None and not ed.empty:
                    for dt in ed.index[:4]:  # next 4 earnings dates
                        tkr_events.append({
                            "date": str(dt.date()),
                            "type": "earnings",
                            "label": "Earnings",
                        })
            except Exception:
                pass

            # Calendar (ex-div, earnings from calendar)
            try:
                cal = tk.calendar
                if cal is not None and not cal.empty:
                    if "Earnings Date" in cal.index:
                        ed_val = cal.loc["Earnings Date"]
                        if hasattr(ed_val, "iloc"):
                            for i in range(len(ed_val)):
                                d = ed_val.iloc[i]
                                if pd.notna(d):
                                    tkr_events.append({
                                        "date": str(d.date()) if hasattr(d, "date") else str(d),
                                        "type": "earnings",
                                        "label": "Earnings (calendar)",
                                    })
            except Exception:
                pass

        except Exception as e:
            print(f"Events error for {tkr}: {e}", file=sys.stderr)

        # Deduplicate by date+type
        seen = set()
        unique = []
        for ev in tkr_events:
            key = f"{ev['date']}|{ev['type']}"
            if key not in seen:
                seen.add(key)
                unique.append(ev)
        events[tkr] = sorted(unique, key=lambda x: x["date"])

    return jsonify(events)
```

### Frontend: overlay on charts

Call `/api/events` after fetching market data. Store in `state.events`.

On the theta chart and fan charts, add vertical annotation lines for each event:
```javascript
// In renderTickerPathCharts, when building annotations:
const tkrEvents = state.events?.[tkr] || [];
tkrEvents.forEach((ev, i) => {
  // Find the date index in pd.dates
  const evDate = new Date(ev.date);
  const today = new Date();
  const dayOffset = Math.ceil((evDate - today) / 86400000);
  // Map to chart label index (approximate)
  const totalDays = pd.dates.length;
  if (dayOffset > 0 && dayOffset < totalDays) {
    const chartIdx = Math.round(dayOffset / totalDays * pd.dates.length);
    annotations[`event_${i}`] = {
      type: "line",
      xMin: Math.min(chartIdx, pd.dates.length - 1),
      xMax: Math.min(chartIdx, pd.dates.length - 1),
      borderColor: ev.type === "earnings" ? "rgba(255,255,100,0.6)" : "rgba(100,200,255,0.6)",
      borderWidth: 1.5,
      borderDash: [2, 2],
      label: {
        display: true,
        content: `📅 ${ev.label}`,
        position: "start",
        backgroundColor: "rgba(30,30,28,0.85)",
        color: "#ffff64",
        font: { size: 9, family: "JetBrains Mono" },
        padding: 3,
      },
    };
  }
});
```

### User-defined catalysts

Add a simple form to the Data tab for manually entering catalyst dates:

```html
<div id="catalyst-section" style="margin-top:16px">
  <div style="font-size:12px;color:var(--tx2);font-weight:500;margin-bottom:6px">Custom Catalysts</div>
  <div style="display:flex;gap:8px;flex-wrap:wrap">
    <input id="cat-ticker" placeholder="Ticker" style="width:70px;padding:6px;border-radius:var(--radius);border:1px solid var(--bd);background:var(--bg2);color:var(--tx);font-family:var(--mono);font-size:12px">
    <input id="cat-date" type="date" style="padding:6px;border-radius:var(--radius);border:1px solid var(--bd);background:var(--bg2);color:var(--tx);font-family:var(--mono);font-size:12px">
    <input id="cat-label" placeholder="Event (e.g. PDUFA)" style="width:140px;padding:6px;border-radius:var(--radius);border:1px solid var(--bd);background:var(--bg2);color:var(--tx);font-family:var(--mono);font-size:12px">
    <button class="btn btn-sm" id="btn-add-catalyst">Add</button>
  </div>
  <div id="catalyst-list" style="margin-top:8px;font-size:11px;color:var(--tx3)"></div>
</div>
```

Store in `state.customCatalysts = []` and merge with API events when rendering charts.

---

## 9. Correlated Monte Carlo

### Backend: replace independent simulation in `/api/simulate`

This is the most impactful change. Replace the per-ticker independent simulation loop with correlated path generation.

**Step 1**: Add a correlation computation function:

```python
def compute_correlation_matrix(tickers, period="1y"):
    """
    Fetch historical returns for all tickers and compute correlation matrix.
    Returns (corr_matrix, cholesky_L, ticker_order) or (None, None, tickers) on failure.
    """
    returns_data = {}
    for tkr in tickers:
        try:
            hist = yf.download(tkr, period=period, progress=False, auto_adjust=True)
            if isinstance(hist.columns, pd.MultiIndex):
                hist.columns = [c[0] for c in hist.columns]
            close = hist["Close"].dropna()
            if len(close) >= 60:
                log_ret = np.log(close / close.shift(1)).dropna()
                returns_data[tkr] = log_ret
        except Exception:
            pass

    if len(returns_data) < 2:
        return None, None, tickers

    # Align all return series by date
    df = pd.DataFrame(returns_data).dropna()
    if len(df) < 30:
        return None, None, tickers

    ordered_tickers = list(df.columns)
    corr = df.corr().values

    # Ensure positive semi-definite (numerical stability)
    eigvals = np.linalg.eigvalsh(corr)
    if eigvals.min() < 0:
        corr += (-eigvals.min() + 1e-6) * np.eye(len(corr))

    try:
        L = np.linalg.cholesky(corr)
    except np.linalg.LinAlgError:
        return corr, None, ordered_tickers

    return corr, L, ordered_tickers
```

**Step 2**: Modify the simulation loop in `/api/simulate`:

Replace the per-ticker simulation block (lines ~155-180) with:

```python
        # Compute correlation matrix
        corr_matrix, cholesky_L, corr_tickers = compute_correlation_matrix(tickers)

        # Simulate paths — correlated if possible, independent otherwise
        ticker_paths = {}
        if cholesky_L is not None and len(corr_tickers) > 1:
            # Correlated simulation
            max_dtes = {}
            for tkr in corr_tickers:
                tkr_positions = [p for p in positions if p["ticker"] == tkr]
                dtes = []
                for tp in tkr_positions:
                    if tp.get("expiry"):
                        dte_val = (pd.Timestamp(tp["expiry"]) - today).days
                        if dte_val > 0:
                            dtes.append(dte_val)
                max_dtes[tkr] = max(dtes) if dtes else 60

            global_max_dte = max(max_dtes.values())
            n_tickers = len(corr_tickers)

            # Generate correlated random normals
            # Shape: (n_paths, global_max_dte, n_tickers)
            Z_indep = rng.standard_normal((n_paths, global_max_dte, n_tickers))
            Z_corr = np.einsum("ij,nkj->nki", cholesky_L, Z_indep)
            # Z_corr[:, :, i] are the correlated shocks for ticker i

            for ti, tkr in enumerate(corr_tickers):
                S0 = ticker_data[tkr]["price"]
                if not S0:
                    continue
                iv = ticker_data[tkr]["iv"]
                model = ticker_model[tkr]
                n_steps = max_dtes[tkr]
                dt = (n_steps / 252) / n_steps

                Z = Z_corr[:, :n_steps, ti]

                if model == "merton":
                    mp = MERTON_DEFAULTS
                    sigma_diff = iv * mp["sigma_diff_frac"]
                    k_bar = np.exp(mp["mu_j"] + 0.5 * mp["sig_j"]**2) - 1
                    drift = (RISK_FREE - 0.5 * sigma_diff**2 - mp["lam"] * k_bar) * dt
                    diffuse = drift + sigma_diff * np.sqrt(dt) * Z
                    # Jumps remain independent (idiosyncratic)
                    N_jumps = rng.poisson(mp["lam"] * dt, (n_paths, n_steps))
                    J = np.zeros((n_paths, n_steps))
                    mask = N_jumps > 0
                    if mask.any():
                        rows, cols = np.where(mask)
                        n_total = int(N_jumps[mask].sum())
                        jump_sizes = rng.normal(mp["mu_j"], mp["sig_j"], n_total)
                        idx = 0
                        for r_, c_ in zip(rows, cols):
                            n = int(N_jumps[r_, c_])
                            J[r_, c_] = jump_sizes[idx:idx + n].sum()
                            idx += n
                    log_r = diffuse + J
                else:
                    drift = (RISK_FREE - 0.5 * iv**2) * dt
                    log_r = drift + iv * np.sqrt(dt) * Z

                paths = S0 * np.exp(np.cumsum(log_r, axis=1))
                paths = np.hstack([np.full((n_paths, 1), S0), paths])
                ticker_paths[tkr] = paths

        # Simulate any tickers not in the correlation matrix independently
        for tkr in tickers:
            if tkr in ticker_paths:
                continue
            S0 = ticker_data[tkr]["price"]
            if not S0:
                continue
            iv = ticker_data[tkr]["iv"]
            model = ticker_model[tkr]
            tkr_positions = [p for p in positions if p["ticker"] == tkr]
            dtes = []
            for tp in tkr_positions:
                if tp.get("expiry"):
                    dte_val = (pd.Timestamp(tp["expiry"]) - today).days
                    if dte_val > 0:
                        dtes.append(dte_val)
            max_dte = max(dtes) if dtes else 60

            if model == "merton":
                mp = MERTON_DEFAULTS
                paths = sim_merton(S0, RISK_FREE, iv * mp["sigma_diff_frac"],
                                   mp["lam"], mp["mu_j"], mp["sig_j"],
                                   max_dte / 252, max_dte, n_paths)
            else:
                paths = sim_gbm(S0, RISK_FREE, iv, max_dte / 252, max_dte, n_paths)
            ticker_paths[tkr] = paths
```

**Step 3**: Include correlation data in the API response:

```python
        # Add correlation info to response
        corr_info = None
        if corr_matrix is not None:
            corr_info = {
                "tickers": corr_tickers,
                "matrix": [[round(float(corr_matrix[i][j]), 3)
                            for j in range(len(corr_tickers))]
                           for i in range(len(corr_tickers))],
            }

        result = {
            # ... existing fields ...
            "correlation": corr_info,
        }
```

---

## 10. Correlation Heatmap

### Frontend: new chart in simulation results

After the strategy probability chart, add a correlation heatmap:

```html
<div class="outer" style="padding:20px;margin-top:20px" id="corr-section" hidden>
  <div style="font-weight:500;font-size:14px;margin-bottom:12px">Correlation Matrix</div>
  <canvas id="chart-correlation" height="300"></canvas>
</div>
```

Render using Chart.js matrix plugin, or more simply, an HTML table with colored cells:

```javascript
function renderCorrelationHeatmap(corrData) {
  if (!corrData) return;
  document.getElementById("corr-section").hidden = false;
  const { tickers, matrix } = corrData;
  const n = tickers.length;

  let html = '<table style="border-collapse:collapse;width:100%;font-family:var(--mono);font-size:11px">';
  // Header row
  html += '<tr><td></td>';
  for (const t of tickers) html += `<td style="padding:6px;text-align:center;color:var(--tx2)">${t}</td>`;
  html += '</tr>';
  // Data rows
  for (let i = 0; i < n; i++) {
    html += `<tr><td style="padding:6px;color:var(--tx2);text-align:right">${tickers[i]}</td>`;
    for (let j = 0; j < n; j++) {
      const v = matrix[i][j];
      const absV = Math.abs(v);
      // Color: green = low corr (good diversification), red = high corr
      let bg;
      if (i === j) bg = "var(--bg3)";
      else if (absV >= 0.7) bg = `rgba(239,83,80,${0.3 + absV * 0.5})`;
      else if (absV >= 0.4) bg = `rgba(255,183,77,${0.2 + absV * 0.4})`;
      else bg = `rgba(76,175,80,${0.1 + absV * 0.3})`;
      html += `<td style="padding:6px;text-align:center;background:${bg};border-radius:2px">${v.toFixed(2)}</td>`;
    }
    html += '</tr>';
  }
  html += '</table>';

  document.getElementById("chart-correlation").parentElement.innerHTML =
    '<div style="font-weight:500;font-size:14px;margin-bottom:12px">Correlation Matrix</div>' + html;
}
```

Call `renderCorrelationHeatmap(data.correlation)` inside `renderSimResults`.

---

## 11. Roll Analyzer

### Backend: new endpoint `/api/roll-analysis`

```python
@app.route("/api/roll-analysis", methods=["POST"])
def roll_analysis():
    """
    POST {
      "ticker": "CCCC",
      "current": { "expiry": "2026-06-18", "strike": 3, "optType": "Put", "contracts": -5, "avgCost": 0.38 },
      "target": { "expiry": "2026-07-17", "strike": 3 }
    }
    Returns roll credit/debit, new greeks, new breakeven.
    """
    try:
        body = request.json
        tkr = body["ticker"]
        current = body["current"]
        target = body["target"]
        today = pd.Timestamp.now().normalize()

        tk = yf.Ticker(tkr)
        price = float(tk.history(period="5d")["Close"].iloc[-1])

        # Get option chain for target expiry
        target_expiry = target["expiry"]
        opt_type = current.get("optType", "Put").lower()

        # Find target option price from chain
        try:
            chain = tk.option_chain(target_expiry)
            df = chain.puts if opt_type == "put" else chain.calls
            # Find closest strike
            target_strike = target.get("strike", current["strike"])
            row = df.iloc[(df["strike"] - target_strike).abs().argsort()[:1]]
            if not row.empty:
                target_bid = float(row["bid"].iloc[0])
                target_ask = float(row["ask"].iloc[0])
                target_mid = round((target_bid + target_ask) / 2, 4)
                target_iv = float(row["impliedVolatility"].iloc[0])
            else:
                return jsonify({"error": "Target strike not found in chain"}), 400
        except Exception as e:
            return jsonify({"error": f"Could not fetch chain: {e}"}), 400

        # Current option: use Black-Scholes to estimate current value
        current_expiry = pd.Timestamp(current["expiry"])
        current_dte = max((current_expiry - today).days, 1)
        current_T = current_dte / 365.0
        current_iv = target_iv  # approximate with same IV (could fetch separately)

        # For short options, we BUY to close (pay the ask) and SELL to open (receive the bid)
        # Roll credit = target_bid - current_ask (for short roll-out)
        # Simplified: use mid prices
        current_greeks_raw = bs_greeks(price, current["strike"], RISK_FREE, current_iv, current_T, opt_type)

        # Estimate current option mid via Black-Scholes
        d1 = (np.log(price / current["strike"]) + (RISK_FREE + 0.5 * current_iv**2) * current_T) / (current_iv * np.sqrt(current_T))
        d2 = d1 - current_iv * np.sqrt(current_T)
        if opt_type == "put":
            current_theoretical = float(current["strike"] * np.exp(-RISK_FREE * current_T) * norm.cdf(-d2) - price * norm.cdf(-d1))
        else:
            current_theoretical = float(price * norm.cdf(d1) - current["strike"] * np.exp(-RISK_FREE * current_T) * norm.cdf(d2))
        current_theoretical = max(current_theoretical, 0)

        # Target greeks
        target_dte = max((pd.Timestamp(target_expiry) - today).days, 1)
        target_T = target_dte / 365.0
        target_greeks = bs_greeks(price, target_strike, RISK_FREE, target_iv, target_T, opt_type)

        contracts = current.get("contracts", 0)
        n = abs(contracts)

        # Roll credit/debit (for short options: positive = credit received)
        if contracts < 0:
            # Short: buy to close current (pay), sell to open target (receive)
            roll_net = target_mid - current_theoretical  # positive = credit
        else:
            # Long: sell current (receive), buy target (pay)
            roll_net = current_theoretical - target_mid  # positive = credit

        roll_total = round(roll_net * n * 100, 2)

        # New breakeven (for short puts)
        avg_cost_current = current.get("avgCost", 0)
        new_avg_cost = round(avg_cost_current + roll_net, 4) if contracts < 0 else round(avg_cost_current - roll_net, 4)

        return jsonify({
            "ticker": tkr,
            "price": round(price, 4),
            "current": {
                "expiry": str(current_expiry.date()),
                "strike": current["strike"],
                "dte": current_dte,
                "theoretical": round(current_theoretical, 4),
                "greeks": current_greeks_raw,
            },
            "target": {
                "expiry": target_expiry,
                "strike": target_strike,
                "dte": target_dte,
                "bid": target_bid,
                "ask": target_ask,
                "mid": target_mid,
                "iv": round(target_iv * 100, 1),
                "greeks": target_greeks,
            },
            "roll": {
                "netPerContract": round(roll_net, 4),
                "totalCredit": roll_total,
                "isCredit": roll_total > 0,
                "newAvgCost": new_avg_cost,
            },
            "greeksDelta": {
                "delta": round((target_greeks["delta"] - current_greeks_raw["delta"]) * n * 100, 2),
                "gamma": round((target_greeks["gamma"] - current_greeks_raw["gamma"]) * n * 100, 4),
                "theta": round((target_greeks["theta"] - current_greeks_raw["theta"]) * n * 100, 2),
                "vega": round((target_greeks["vega"] - current_greeks_raw["vega"]) * n * 100, 2),
            },
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500
```

### Frontend

Add a "Roll" button to each short option strike row in `renderStrike()`. On click, show a modal with:
- Current position summary
- Target expiry dropdown (populated from yfinance option expiries)
- Target strike input (default to same strike)
- "Analyze Roll" button that calls `/api/roll-analysis`
- Results: credit/debit, new greeks, delta to portfolio greeks

The modal HTML and JS are substantial — implement as a `<div id="roll-modal">` that's shown/hidden, with event listeners for the inputs and API call.

---

## 12. Historical Trade Performance

### Backend: new endpoint `/api/trade-history`

```python
@app.route("/api/trade-history", methods=["POST"])
def trade_history():
    """
    POST { "historyText": "..." }
    Parses the full history CSV and computes closed trade performance.
    """
    try:
        hist_text = request.json.get("historyText", "")
        lines = hist_text.replace("\ufeff", "").replace("\r", "").split("\n")

        # Track all transactions per OCC symbol
        trades = {}  # occ_key → list of {date, action, qty, price}

        for line in lines:
            r = line.split(",") if "," in line else []
            if len(r) < 7:
                continue
            ds = r[0].strip()
            if not ds or not ds[0].isdigit():
                continue
            action = r[1].strip().upper()
            sym = r[2].strip().lower().replace(" ", "")
            price = abs(float(r[5].replace("$", "").replace(",", "").replace("+", "") or "0"))
            qty = abs(int(float(r[6].strip() or "0")))

            if qty == 0 and "EXPIRED" not in action:
                continue

            dp = ds.split("/")
            try:
                dt = f"{dp[2]}-{dp[0].zfill(2)}-{dp[1].zfill(2)}"
            except (IndexError, ValueError):
                continue

            trades.setdefault(sym, []).append({
                "date": dt,
                "action": action,
                "qty": qty,
                "price": price,
            })

        # Match opens with closes
        closed_trades = []
        for sym, txns in trades.items():
            opens = [t for t in txns if "OPENING" in t["action"]]
            closes = [t for t in txns if any(k in t["action"] for k in ["CLOSING", "ASSIGNED", "EXPIRED", "EXERCISED"])]

            if not opens or not closes:
                continue

            # Compute aggregate P&L
            total_open_cost = sum(t["price"] * t["qty"] for t in opens)
            total_open_qty = sum(t["qty"] for t in opens)
            total_close_proceeds = sum(t["price"] * t["qty"] for t in closes)
            total_close_qty = sum(t["qty"] for t in closes)

            if total_open_qty == 0:
                continue

            avg_open = total_open_cost / total_open_qty
            avg_close = total_close_proceeds / total_close_qty if total_close_qty else 0

            # Determine if sold to open (short) or bought to open (long)
            is_short = "SOLD" in opens[0]["action"]
            if is_short:
                pnl = (avg_open - avg_close) * min(total_open_qty, total_close_qty) * 100
            else:
                pnl = (avg_close - avg_open) * min(total_open_qty, total_close_qty) * 100

            # Parse OCC symbol for metadata
            import re
            occ_match = re.match(r'-?([a-z]+)(\d{6})([cp])([\d.]+)', sym)
            ticker = occ_match.group(1).upper() if occ_match else sym
            opt_type = "Put" if occ_match and occ_match.group(3) == "p" else "Call"

            first_open = min(t["date"] for t in opens)
            last_close = max(t["date"] for t in closes)
            hold_days = (pd.Timestamp(last_close) - pd.Timestamp(first_open)).days

            closed_trades.append({
                "symbol": sym,
                "ticker": ticker,
                "optType": opt_type,
                "isShort": is_short,
                "strategy": "Short" if is_short else "Long",
                "openDate": first_open,
                "closeDate": last_close,
                "holdDays": hold_days,
                "avgOpen": round(avg_open, 4),
                "avgClose": round(avg_close, 4),
                "qty": min(total_open_qty, total_close_qty),
                "pnl": round(pnl, 2),
                "isWin": pnl > 0,
                "closeType": closes[0]["action"].split()[-1] if closes else "UNKNOWN",
            })

        # Compute aggregate stats
        if closed_trades:
            wins = [t for t in closed_trades if t["isWin"]]
            losses = [t for t in closed_trades if not t["isWin"]]
            total_pnl = sum(t["pnl"] for t in closed_trades)
            avg_win = np.mean([t["pnl"] for t in wins]) if wins else 0
            avg_loss = np.mean([t["pnl"] for t in losses]) if losses else 0
            gross_wins = sum(t["pnl"] for t in wins)
            gross_losses = abs(sum(t["pnl"] for t in losses))

            stats = {
                "totalTrades": len(closed_trades),
                "wins": len(wins),
                "losses": len(losses),
                "winRate": round(len(wins) / len(closed_trades) * 100, 1),
                "totalPnl": round(total_pnl, 2),
                "avgWin": round(avg_win, 2),
                "avgLoss": round(avg_loss, 2),
                "profitFactor": round(gross_wins / gross_losses, 2) if gross_losses > 0 else float("inf"),
                "expectancy": round(total_pnl / len(closed_trades), 2),
                "avgHoldDays": round(np.mean([t["holdDays"] for t in closed_trades]), 1),
            }
        else:
            stats = None

        # Sort by close date descending
        closed_trades.sort(key=lambda t: t["closeDate"], reverse=True)

        return jsonify({
            "trades": closed_trades,
            "stats": stats,
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500
```

### Frontend

Add a new tab "History" to the tab bar. Render as a sortable table with color-coded P&L and summary stats at the top.

---

## 13. P&L Attribution

### Backend: add to `/api/greeks` or new endpoint `/api/pnl-attribution`

This requires **two snapshots** — a "before" and "after." On first call, save the current state. On subsequent calls, compute the difference.

**Simplified approach (no persistence)**: Accept both snapshots from the frontend.

```python
@app.route("/api/pnl-attribution", methods=["POST"])
def pnl_attribution():
    """
    POST {
      "positions": [...],
      "prev": { "prices": {ticker: price}, "ivs": {ticker: iv}, "greeks": {ticker: {delta, gamma, theta, vega}} },
      "current": { "prices": {ticker: price}, "ivs": {ticker: iv} }
    }
    Returns P&L decomposition by greek.
    """
    try:
        body = request.json
        prev = body["prev"]
        curr = body["current"]
        positions = body["positions"]

        attribution = {}
        for tkr in set(p["ticker"] for p in positions):
            prev_price = prev["prices"].get(tkr, 0)
            curr_price = curr["prices"].get(tkr, 0)
            prev_iv = prev["ivs"].get(tkr, 0)
            curr_iv = curr["ivs"].get(tkr, 0)
            prev_g = prev.get("greeks", {}).get(tkr, {})

            delta_s = curr_price - prev_price
            delta_iv = (curr_iv - prev_iv) / 100  # convert to decimal

            pnl_delta = prev_g.get("delta", 0) * delta_s
            pnl_gamma = 0.5 * prev_g.get("gamma", 0) * delta_s**2
            pnl_theta = prev_g.get("theta", 0)  # already daily
            pnl_vega = prev_g.get("vega", 0) * delta_iv * 100  # vega is per 1 vol pt

            attribution[tkr] = {
                "pricePnl": round(pnl_delta, 2),
                "gammaPnl": round(pnl_gamma, 2),
                "thetaPnl": round(pnl_theta, 2),
                "vegaPnl": round(pnl_vega, 2),
                "total": round(pnl_delta + pnl_gamma + pnl_theta + pnl_vega, 2),
                "deltaS": round(delta_s, 4),
                "deltaIV": round(delta_iv * 100, 1),
            }

        # Portfolio totals
        portfolio = {"pricePnl": 0, "gammaPnl": 0, "thetaPnl": 0, "vegaPnl": 0, "total": 0}
        for a in attribution.values():
            for k in portfolio:
                portfolio[k] += a[k]
        for k in portfolio:
            portfolio[k] = round(portfolio[k], 2)

        return jsonify({"byTicker": attribution, "portfolio": portfolio})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
```

### Frontend

Save `state.prevSnapshot` whenever greeks are computed. On the next fetch, compute attribution and display as a stacked bar chart showing the four components.

---

## 14. Risk Matrix Heatmap

### Backend: new endpoint `/api/risk-matrix`

```python
@app.route("/api/risk-matrix", methods=["POST"])
def risk_matrix():
    """
    POST {
      "positions": [...],
      "marketData": {...},
      "priceSteps": [-20, -15, -10, -5, 0, 5, 10, 15, 20],
      "ivSteps": [-15, -10, -5, 0, 5, 10, 15],
      "daysForward": 0
    }
    Returns grid of portfolio P&L for each (priceChange%, ivChange) scenario.
    """
    try:
        body = request.json
        positions = body["positions"]
        market = body.get("marketData", {})
        price_steps = body.get("priceSteps", [-20, -15, -10, -5, -2, 0, 2, 5, 10, 15, 20])
        iv_steps = body.get("ivSteps", [-15, -10, -5, 0, 5, 10, 15])
        days_fwd = body.get("daysForward", 0)
        today = pd.Timestamp.now().normalize()

        grid = []  # list of lists, grid[iv_idx][price_idx] = P&L

        for iv_change in iv_steps:
            row = []
            for price_pct in price_steps:
                total_pnl = 0

                for p in positions:
                    tkr = p["ticker"]
                    md = market.get(tkr, {})
                    S = md.get("price", 0)
                    if not S:
                        continue

                    shocked_S = S * (1 + price_pct / 100)

                    if p.get("posType") == "equity":
                        shares = p.get("shares", p.get("contracts", 0))
                        cost = p.get("adjCost") or p.get("avgCost", 0)
                        total_pnl += shares * (shocked_S - S)  # P&L from current, not from cost
                        continue

                    if not p.get("expiry"):
                        continue

                    strike = p.get("strike", 0)
                    contracts = p.get("contracts", 0)
                    avg_cost = p.get("avgCost", 0)
                    opt_type = (p.get("optType") or "put").lower()
                    iv_base = (md.get("iv", 60)) / 100
                    shocked_iv = max(iv_base + iv_change / 100, 0.01)

                    dte = max((pd.Timestamp(p["expiry"]) - today).days - days_fwd, 1)
                    T = dte / 365.0

                    # Black-Scholes option value at shocked parameters
                    d1 = (np.log(shocked_S / strike) + (RISK_FREE + 0.5 * shocked_iv**2) * T) / (shocked_iv * np.sqrt(T))
                    d2 = d1 - shocked_iv * np.sqrt(T)

                    if opt_type == "call":
                        opt_val = shocked_S * norm.cdf(d1) - strike * np.exp(-RISK_FREE * T) * norm.cdf(d2)
                    else:
                        opt_val = strike * np.exp(-RISK_FREE * T) * norm.cdf(-d2) - shocked_S * norm.cdf(-d1)

                    opt_val = max(opt_val, 0)
                    position_pnl = contracts * (opt_val - avg_cost) * 100
                    total_pnl += position_pnl

                row.append(round(total_pnl, 2))
            grid.append(row)

        return jsonify({
            "priceSteps": price_steps,
            "ivSteps": iv_steps,
            "daysForward": days_fwd,
            "grid": grid,
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500
```

### Frontend

Render as an HTML table with colored cells. Add a "days forward" slider (0-30) that re-fetches the grid with the new `daysForward` value.

```javascript
function renderRiskMatrix(data) {
  const { priceSteps, ivSteps, grid } = data;
  // Find min/max for color scaling
  const allVals = grid.flat();
  const minVal = Math.min(...allVals);
  const maxVal = Math.max(...allVals);
  const maxAbs = Math.max(Math.abs(minVal), Math.abs(maxVal));

  let html = '<table style="border-collapse:collapse;width:100%;font-family:var(--mono);font-size:10px">';
  // Header: price changes
  html += '<tr><td style="padding:4px;text-align:center;color:var(--tx3);font-size:9px">IV \\ Price</td>';
  for (const ps of priceSteps) {
    html += `<td style="padding:4px;text-align:center;color:var(--tx3);font-size:9px">${ps > 0 ? "+" : ""}${ps}%</td>`;
  }
  html += '</tr>';

  for (let i = 0; i < ivSteps.length; i++) {
    html += `<tr><td style="padding:4px;text-align:right;color:var(--tx3);font-size:9px">${ivSteps[i] > 0 ? "+" : ""}${ivSteps[i]}pt</td>`;
    for (let j = 0; j < priceSteps.length; j++) {
      const val = grid[i][j];
      const intensity = maxAbs > 0 ? val / maxAbs : 0;
      let bg;
      if (val >= 0) {
        bg = `rgba(76,175,80,${Math.min(Math.abs(intensity) * 0.8, 0.8)})`;
      } else {
        bg = `rgba(239,83,80,${Math.min(Math.abs(intensity) * 0.8, 0.8)})`;
      }
      const isCenter = priceSteps[j] === 0 && ivSteps[i] === 0;
      const border = isCenter ? "border:2px solid #fff;" : "";
      html += `<td style="padding:4px;text-align:center;background:${bg};${border}">${fmtDollar(val)}</td>`;
    }
    html += '</tr>';
  }
  html += '</table>';
  return html;
}
```

---

## 15. What-If Trade Analyzer

### Backend: extend `/api/risk-matrix` or new endpoint `/api/what-if`

Accept additional `hypothetical` positions in the request and include them in the computation alongside existing positions. The risk matrix, greeks, and simulation endpoints should all accept an optional `hypothetical` array.

This is architecturally simple — when any endpoint receives `hypothetical` positions, it merges them with the real positions before computing.

---

## 16. Volatility Surface

### Backend: new endpoint `/api/vol-surface`

```python
@app.route("/api/vol-surface/<ticker>")
def vol_surface(ticker):
    """Returns IV by strike for each available expiry."""
    try:
        tk = yf.Ticker(ticker.upper())
        expiries = tk.options
        surface = []
        for exp in expiries[:8]:  # limit to nearest 8 expiries
            try:
                chain = tk.option_chain(exp)
                puts = chain.puts[["strike", "impliedVolatility", "volume", "openInterest"]].copy()
                puts["optType"] = "Put"
                calls = chain.calls[["strike", "impliedVolatility", "volume", "openInterest"]].copy()
                calls["optType"] = "Call"
                combined = pd.concat([puts, calls])
                combined = combined[combined["impliedVolatility"] > 0]
                surface.append({
                    "expiry": exp,
                    "data": combined.to_dict(orient="records"),
                })
            except Exception:
                continue
        return jsonify({"ticker": ticker.upper(), "expiries": surface})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
```

### Frontend

Render as a line chart: X-axis = strike, Y-axis = IV, one line per expiry. Mark the user's position strikes with dots. Add a toggle for puts vs calls vs both.

---

## 17. Options Flow

### Backend: add to `/api/market-data` or new endpoint

```python
@app.route("/api/unusual-activity", methods=["POST"])
def unusual_activity():
    """Check for unusual options volume vs open interest."""
    tickers = request.json.get("tickers", [])
    alerts = []
    for tkr in tickers:
        try:
            tk = yf.Ticker(tkr)
            for exp in tk.options[:3]:  # nearest 3 expiries
                chain = tk.option_chain(exp)
                for side, df in [("Put", chain.puts), ("Call", chain.calls)]:
                    for _, row in df.iterrows():
                        vol = int(row.get("volume", 0) or 0)
                        oi = int(row.get("openInterest", 0) or 0)
                        if oi > 0 and vol > 2 * oi:
                            alerts.append({
                                "ticker": tkr,
                                "expiry": exp,
                                "strike": float(row["strike"]),
                                "optType": side,
                                "volume": vol,
                                "openInterest": oi,
                                "ratio": round(vol / oi, 1),
                            })
        except Exception:
            continue
    alerts.sort(key=lambda a: a["ratio"], reverse=True)
    return jsonify({"alerts": alerts[:20]})  # top 20
```

---

## 18. SQLite Persistence

### Schema

```sql
CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    ticker TEXT NOT NULL,
    price REAL,
    iv REAL,
    delta REAL,
    gamma REAL,
    theta REAL,
    vega REAL,
    position_value REAL
);

CREATE TABLE IF NOT EXISTS closed_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    occ_symbol TEXT,
    ticker TEXT,
    opt_type TEXT,
    strike REAL,
    open_date TEXT,
    close_date TEXT,
    open_price REAL,
    close_price REAL,
    quantity INTEGER,
    pnl REAL,
    strategy TEXT,
    close_type TEXT
);

CREATE TABLE IF NOT EXISTS catalysts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    event_date TEXT NOT NULL,
    event_type TEXT,
    description TEXT
);

CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    condition TEXT NOT NULL,
    threshold REAL,
    triggered_at TEXT,
    acknowledged INTEGER DEFAULT 0
);
```

### Integration

Add to `app.py`:

```python
import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(__file__), "portfolio.db")

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS snapshots (...);
        CREATE TABLE IF NOT EXISTS closed_trades (...);
        CREATE TABLE IF NOT EXISTS catalysts (...);
        CREATE TABLE IF NOT EXISTS alerts (...);
    """)
    conn.close()

# Call on startup
init_db()
```

Save a snapshot after each `/api/greeks` call. Use stored snapshots for P&L attribution.

---

## 19. New Tab Structure

Currently: Data | Dashboard | Simulate

**Proposed**: Data | Dashboard | Simulate | Risk | History

- **Risk tab**: Contains the risk matrix heatmap, greeks exposure summary, correlation heatmap, max loss gauge, and vol surface charts.
- **History tab**: Contains closed trade performance table, cumulative P&L chart, win rate by strategy, and trade journal entries.

Add the new tabs to the HTML:
```html
<div class="tabs">
  <button class="tab active" data-tab="upload">Data</button>
  <button class="tab" data-tab="dashboard">Dashboard</button>
  <button class="tab" data-tab="simulate">Simulate</button>
  <button class="tab" data-tab="risk">Risk</button>
  <button class="tab" data-tab="history">History</button>
</div>
```

And corresponding content divs:
```html
<div id="tab-risk" hidden>
  <div class="summary" id="risk-summary"></div>
  <div class="outer" style="padding:20px" id="risk-matrix-container"></div>
  <div style="margin-top:20px">
    <label style="font-size:12px;color:var(--tx2)">Days forward:
      <input type="range" id="risk-days-slider" min="0" max="30" value="0" style="width:200px">
      <span id="risk-days-label">0</span>
    </label>
  </div>
  <div class="outer" style="padding:20px;margin-top:20px" id="vol-surface-container"></div>
</div>

<div id="tab-history" hidden>
  <div class="summary" id="history-summary"></div>
  <div class="outer" id="history-table-container"></div>
  <div class="outer" style="padding:20px;margin-top:20px">
    <canvas id="chart-cumulative-pnl" height="200"></canvas>
  </div>
</div>
```

Update the tab switching logic to include the new tabs.

---

## IMPLEMENTATION PRIORITY SUMMARY

### Build first (each independent, ~2-4 hours):
1. **Full Greeks** (#1) — unlocks #2, #3, #13, #14
2. **Expected Move** (#4) — trivial addition to existing endpoint
3. **DTE Badges** (#6) — frontend only, 30 minutes
4. **Dividend Flagging** (#7) — small backend addition

### Build second (after greeks work, ~1-2 days each):
5. **Beta-Weighted Delta** (#2)
6. **Max Loss & Margin** (#3)
7. **Earnings Calendar** (#8)
8. **Profit Target Badges** (#5) — needs option chain prices

### Build third (~2-5 days each):
9. **Correlated Monte Carlo** (#9) — biggest simulation upgrade
10. **Correlation Heatmap** (#10) — falls out of #9
11. **Historical Trade Performance** (#12)
12. **Risk Matrix** (#14) — uses greeks infrastructure

### Build fourth (~1-2 weeks each):
13. **Roll Analyzer** (#11)
14. **P&L Attribution** (#13) — needs persistence (#18)
15. **SQLite Persistence** (#18) — enables attribution + snapshots
16. **Vol Surface** (#16)
17. **What-If Analyzer** (#15)
18. **Options Flow** (#17)
19. **New Tab Structure** (#19) — refactor after features exist

---

## DEPENDENCIES / REQUIREMENTS

No new pip packages needed. Everything uses:
- `numpy` (already installed)
- `scipy.stats.norm` (already imported)
- `pandas` (already installed)
- `yfinance` (already installed)
- `sqlite3` (Python standard library)

The only potential concern is yfinance rate limiting when fetching option chains for multiple tickers/expiries. Add a simple delay (`time.sleep(0.5)`) between chain fetches if Yahoo starts returning errors.
