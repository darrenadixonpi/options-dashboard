#!/usr/bin/env python3
"""
Options Dashboard — Flask backend
Run: python app.py
Then open http://localhost:5000
"""

import csv
import io
import json
import os
import re
import sqlite3
import sys
import time
import traceback
from datetime import datetime, date
from collections import Counter, OrderedDict, defaultdict
from flask import Flask, request, jsonify, send_from_directory

import yfinance as yf
import numpy as np
import pandas as pd
from scipy.stats import norm

from api_schemas import GreeksResponse, SimulateResponse, validate_response

app = Flask(__name__, static_folder="static", static_url_path="/static")
rng = np.random.default_rng(42)

# ─── Config ────────────────────────────────────────────────────────────────

N_PATHS = 10_000
IV_HV_RATIO_THRESHOLD = 1.8
PRICE_MOVE_THRESHOLD = 0.15
CATALYST_LOOKAHEAD_DAYS = 90
CATALYST_LOOKBACK_DAYS = 30
MERTON_DEFAULTS = {"sigma_diff_frac": 0.5, "lam": 2.0, "mu_j": -0.10, "sig_j": 0.15}
# Annualized risk-free rate (≈ 3-month T-bill). Override via env: RISK_FREE=0.040
RISK_FREE = float(os.environ.get("RISK_FREE", "0.037"))

# ─── yfinance resilience (Phase 5.2) ────────────────────────────────────────

_YF_RETRY_COUNT = int(os.environ.get("YF_RETRY_COUNT", "3"))
_YF_RETRY_BACKOFF = float(os.environ.get("YF_RETRY_BACKOFF", "1.5"))  # seconds; doubles each attempt

# ─── Rate-limit token bucket (Phase 5.3) ─────────────────────────────────────
# Limits yfinance calls to YF_RATE_LIMIT_PER_MIN per minute (default 30).
# Excess callers block (sleep) rather than fail; set to 0 to disable.

import threading as _threading

_YF_RATE_LIMIT = int(os.environ.get("YF_RATE_LIMIT_PER_MIN", "30"))
_yf_bucket_lock = _threading.Lock()
_yf_bucket_tokens = _YF_RATE_LIMIT      # starts full
_yf_bucket_last_refill = time.monotonic()


def _yf_acquire_token():
    """Block until a rate-limit token is available, then consume one."""
    if _YF_RATE_LIMIT <= 0:
        return
    global _yf_bucket_tokens, _yf_bucket_last_refill
    while True:
        with _yf_bucket_lock:
            now = time.monotonic()
            elapsed = now - _yf_bucket_last_refill
            # Refill at rate of _YF_RATE_LIMIT tokens per 60 seconds
            if elapsed >= 1.0:
                refill = int(elapsed / 60.0 * _YF_RATE_LIMIT)
                if refill > 0:
                    _yf_bucket_tokens = min(_YF_RATE_LIMIT, _yf_bucket_tokens + refill)
                    _yf_bucket_last_refill = now
            if _yf_bucket_tokens > 0:
                _yf_bucket_tokens -= 1
                return
        # Bucket empty — wait a bit and retry
        print("[yf] rate limit: bucket empty, waiting 2s", file=sys.stderr)
        time.sleep(2.0)


def _yf_call(fn, *args, retries=None, backoff=None, **kwargs):
    """Call a yfinance function with rate-limiting + exponential-backoff retry.

    Acquires a token from the rate-limit bucket before each attempt, then retries
    on transient failure up to YF_RETRY_COUNT times (default 3).
    Env overrides: YF_RETRY_COUNT, YF_RETRY_BACKOFF, YF_RATE_LIMIT_PER_MIN.
    """
    retries = _YF_RETRY_COUNT if retries is None else retries
    backoff = _YF_RETRY_BACKOFF if backoff is None else backoff
    last_exc = None
    for attempt in range(retries):
        _yf_acquire_token()
        try:
            return fn(*args, **kwargs)
        except Exception as exc:
            last_exc = exc
            wait = backoff * (2 ** attempt)
            print(
                f"[yf] attempt {attempt + 1}/{retries} failed ({type(exc).__name__}: {exc}); "
                f"retrying in {wait:.1f}s",
                file=sys.stderr,
            )
            time.sleep(wait)
    raise last_exc


def _last_known_price(tkr):
    """Return the most-recent snapshot price for tkr from the DB, or None."""
    try:
        conn = get_db()
        row = conn.execute(
            "SELECT price FROM snapshots WHERE ticker=? AND price IS NOT NULL "
            "ORDER BY timestamp DESC LIMIT 1",
            (tkr,),
        ).fetchone()
        conn.close()
        return float(row["price"]) if row else None
    except Exception:
        return None


# ─── SQLite Persistence (#18) ─────────────────────────────────────────────

def _default_db_path():
    if getattr(sys, "frozen", False):
        return os.path.join(os.path.dirname(sys.executable), "portfolio.db")
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "portfolio.db")


DB_PATH = os.environ.get("PORTFOLIO_DB", _default_db_path())

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    conn.executescript("""
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
        CREATE TABLE IF NOT EXISTS alert_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            alert_key TEXT NOT NULL,
            ticker TEXT,
            category TEXT,
            severity TEXT,
            message TEXT NOT NULL,
            triggered_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_alert_events_key_ts ON alert_events(alert_key, triggered_at);
        CREATE TABLE IF NOT EXISTS attribution_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            portfolio_total REAL,
            data_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS fetch_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            position_count INTEGER,
            ticker_count INTEGER,
            data_json TEXT
        );
        CREATE TABLE IF NOT EXISTS portfolio_book_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            unrealized_pnl REAL,
            book_value REAL,
            position_count INTEGER
        );
        CREATE TABLE IF NOT EXISTS strategy_templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            description TEXT,
            legs_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS alert_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            ticker TEXT,
            condition_type TEXT NOT NULL,
            threshold REAL,
            action TEXT NOT NULL DEFAULT 'notify',
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS draft_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticker TEXT NOT NULL,
            strategy TEXT,
            legs_json TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'draft',
            notes TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
    """)
    # Retention: high-churn tables grow on every fetch/auto-refresh; prune
    # rows older than SNAPSHOT_RETENTION_DAYS (default 180) on startup.
    try:
        retention_days = int(os.environ.get("SNAPSHOT_RETENTION_DAYS", "180"))
        if retention_days > 0:
            cutoff = (datetime.now() - pd.Timedelta(days=retention_days)).isoformat()
            conn.execute("DELETE FROM snapshots WHERE timestamp < ?", (cutoff,))
            conn.execute("DELETE FROM alert_events WHERE triggered_at < ?", (cutoff,))
            conn.commit()
    except Exception:
        pass
    conn.close()

def _parse_occ_symbol(sym):
    """Parse OCC option symbol into ticker, expiry, type, strike.

    Supports both standard OCC padded strikes (00002500 → 2.5) and
    broker CSV decimal strikes (2.5 → 2.5).
    """
    # Root is letters plus an optional trailing digit, to support ADJUSTED option
    # symbols (corporate-action deliverables) like "-OPEN1260515P5" → root "OPEN1".
    # The \d? backtracks for normal symbols ("-mstr250502c400" still → "MSTR").
    m = re.match(r"-?([a-z]+\d?)(\d{6})([cp])(\d+(?:\.\d+)?)", sym.lower().replace(" ", ""))
    if not m:
        return None
    ds = m.group(2)
    expiry = f"20{ds[0:2]}-{ds[2:4]}-{ds[4:6]}"
    opt_type = "Put" if m.group(3) == "p" else "Call"
    strike_raw = m.group(4)
    if "." in strike_raw:
        strike = float(strike_raw)  # literal decimal strike (Fidelity-style)
    elif len(strike_raw) > 6:
        strike = float(strike_raw) / 1000.0  # standard OCC 8-digit padded strike
    else:
        strike = float(strike_raw)
    return {"ticker": m.group(1).upper(), "expiry": expiry, "optType": opt_type, "strike": strike}

init_db()

# ─── Background market-data refresh (Phase 5.1) ──────────────────────────────
# A daemon thread silently refreshes the last-watched ticker set every
# BG_REFRESH_INTERVAL_MIN minutes (default 5; set to 0 to disable).
# The cached result is available via GET /api/market-data/cached.

_BG_INTERVAL_MIN = int(os.environ.get("BG_REFRESH_INTERVAL_MIN", "5"))
_bg_watch_tickers = set()          # tickers registered by any market-data POST
_bg_market_cache = {               # last background-refresh result
    "data": {},
    "updated_at": None,
}
_bg_lock = _threading.Lock()


def _bg_refresh_loop():
    if _BG_INTERVAL_MIN <= 0:
        return
    interval_s = _BG_INTERVAL_MIN * 60
    while True:
        time.sleep(interval_s)
        with _bg_lock:
            tickers = list(_bg_watch_tickers)
        if not tickers:
            continue
        print(f"[bg-refresh] Refreshing {len(tickers)} tickers...", file=sys.stderr)
        try:
            new_data = {tkr: fetch_ticker_data(tkr) for tkr in tickers}
            with _bg_lock:
                _bg_market_cache["data"] = new_data
                _bg_market_cache["updated_at"] = datetime.now().isoformat()
            print(f"[bg-refresh] Done ({len(tickers)} tickers)", file=sys.stderr)
        except Exception as exc:
            print(f"[bg-refresh] Error: {exc}", file=sys.stderr)


_bg_thread = _threading.Thread(
    target=_bg_refresh_loop, daemon=True, name="bg-market-refresh"
)
_bg_thread.start()


def _calendar_field(cal, key):
    """Read a field from yf.Ticker.calendar across yfinance versions.

    Older yfinance returned a DataFrame (keys in .index); current versions
    return a plain dict. Returns the raw value (or first element of a
    list/Series) or None.
    """
    if cal is None:
        return None
    try:
        if isinstance(cal, dict):
            val = cal.get(key)
        elif hasattr(cal, "index") and key in cal.index:
            val = cal.loc[key]
        else:
            return None
        if hasattr(val, "iloc"):
            val = val.iloc[0] if len(val) else None
        elif isinstance(val, (list, tuple)):
            val = val[0] if val else None
        if val is None or (hasattr(pd, "isna") and not isinstance(val, (list, tuple)) and pd.isna(val)):
            return None
        return val
    except Exception:
        return None


# ─── Black-Scholes Greeks (#1) ────────────────────────────────────────────

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
    phi_d1 = np.exp(-0.5 * d1**2) / np.sqrt(2 * np.pi)

    if opt_type == "call":
        delta = float(norm.cdf(d1))
        theta = (-(S * phi_d1 * iv) / (2 * sqrt_T)
                 - r * K * np.exp(-r * T_years) * norm.cdf(d2))
    else:
        delta = float(norm.cdf(d1) - 1)
        theta = (-(S * phi_d1 * iv) / (2 * sqrt_T)
                 + r * K * np.exp(-r * T_years) * norm.cdf(-d2))

    gamma = float(phi_d1 / (S * iv * sqrt_T))
    vega = float(S * phi_d1 * sqrt_T / 100)
    theta_daily = float(theta / 365)

    return {
        "delta": round(delta, 4),
        "gamma": round(gamma, 6),
        "theta": round(theta_daily, 4),
        "vega": round(vega, 4),
    }


def bs_option_value(S, K, r, iv, T_years, opt_type):
    """Compute Black-Scholes option value."""
    if T_years <= 1e-6 or iv <= 0 or S <= 0 or K <= 0:
        if opt_type == "call":
            return max(S - K, 0)
        else:
            return max(K - S, 0)
    sqrt_T = np.sqrt(T_years)
    d1 = (np.log(S / K) + (r + 0.5 * iv**2) * T_years) / (iv * sqrt_T)
    d2 = d1 - iv * sqrt_T
    if opt_type == "call":
        return float(S * norm.cdf(d1) - K * np.exp(-r * T_years) * norm.cdf(d2))
    else:
        return float(K * np.exp(-r * T_years) * norm.cdf(-d2) - S * norm.cdf(-d1))


# ─── Max Loss & Margin (#3) ──────────────────────────────────────────────

def compute_risk_metrics(positions, market):
    """Compute max loss and estimated Reg-T margin for the portfolio.
    Accounts for cash-secured puts (CSPs) and covered calls to avoid overstating risk."""
    total_max_loss = 0
    total_margin = 0
    position_risk = []

    # Group positions by ticker to detect hedged positions
    by_ticker = {}
    for p in positions:
        by_ticker.setdefault(p["ticker"], []).append(p)

    for tkr, tkr_positions in by_ticker.items():
        md = market.get(tkr, {})
        S = md.get("price", 0)

        equity_shares = 0
        equity_cost = 0
        for p in tkr_positions:
            if p.get("posType") == "equity":
                shares = p.get("shares", p.get("contracts", 0))
                cost = p.get("adjCost") or p.get("avgCost", 0)
                equity_shares += shares
                equity_cost += abs(shares) * cost

        # Track short options for hedging detection
        short_puts = []
        short_calls = []
        for p in tkr_positions:
            if p.get("posType") == "equity":
                continue
            contracts = p.get("contracts", 0)
            if contracts < 0:
                opt_type = (p.get("optType") or "put").lower()
                if opt_type == "put":
                    short_puts.append(p)
                else:
                    short_calls.append(p)

        # Shares hedging capacity
        shares_for_calls = max(equity_shares, 0)  # long shares can cover short calls
        # Cash-secured capacity: if we have shares, we assume puts may be CSPs

        for p in tkr_positions:
            if p.get("posType") == "equity":
                shares = p.get("shares", p.get("contracts", 0))
                cost = p.get("adjCost") or p.get("avgCost", 0)
                if shares > 0:
                    ml = shares * cost  # max loss = stock goes to zero
                    margin = shares * S * 0.25 if S else 0
                else:
                    ml = abs(shares) * S * 2 if S else 0
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
                n = abs(contracts)
                premium_received = avg_cost * n * 100
                if opt_type == "put":
                    # CSP: max loss = (strike - premium) × 100 × n
                    # This is already the formula, but for CSPs the margin is just the cash reserved
                    ml = strike * 100 * n - premium_received
                    # Margin: CSP margin = strike × 100 × n (cash-secured)
                    # Reg-T naked: max(20% × S - OTM + prem, 10% × strike + prem)
                    otm = max(strike - S, 0) if S else 0
                    margin_naked = max(
                        (0.20 * S - otm + avg_cost) * n * 100 if S else 0,
                        (0.10 * strike + avg_cost) * n * 100
                    )
                    margin_csp = strike * n * 100  # cash-secured
                    margin = min(margin_naked, margin_csp)  # use the lower of the two
                else:
                    # Short call
                    covered_contracts = min(n, shares_for_calls // 100)
                    naked_contracts = n - covered_contracts
                    shares_for_calls -= covered_contracts * 100

                    # Covered calls: max loss comes from shares (already counted), call just caps upside
                    # Naked calls: max loss capped at 3× price (more realistic than 5×)
                    ml_naked = 3 * S * 100 * naked_contracts if S else strike * 300 * naked_contracts
                    ml = ml_naked  # covered portion has no additional max loss
                    otm = max(S - strike, 0) if S else 0
                    margin_naked_a = (0.20 * S - otm + avg_cost) * naked_contracts * 100 if S else 0
                    margin_naked_b = (0.10 * S + avg_cost) * naked_contracts * 100 if S else 0
                    margin = max(margin_naked_a, margin_naked_b) if naked_contracts > 0 else 0

                position_risk.append({
                    "ticker": tkr, "strike": strike, "optType": p.get("optType"),
                    "maxLoss": round(ml, 2), "margin": round(margin, 2),
                })
                total_max_loss += ml
                total_margin += margin
            else:
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


# ─── API: Fetch price + IV for a list of tickers ──────────────────────────

@app.route("/api/market-data", methods=["POST"])
def market_data():
    tickers = request.json.get("tickers", [])
    if not tickers:
        return jsonify({"error": "No tickers provided"}), 400
    # Register for background auto-refresh
    with _bg_lock:
        _bg_watch_tickers.update(tickers)
    results = {}
    for tkr in tickers:
        results[tkr] = fetch_ticker_data(tkr)
    return jsonify(results)


@app.route("/api/market-data/<ticker>")
def single_ticker(ticker):
    return jsonify(fetch_ticker_data(ticker.upper()))


@app.route("/api/market-data/cached")
def market_data_cached():
    """Return the most recent background-refreshed market data and metadata.

    Response shape:
      { data: {TICKER: {...}}, updated_at: ISO-string|null,
        ticker_count: int, interval_min: int }
    Clients can poll this to get auto-refreshed data without triggering a live
    yfinance fetch. Returns 204 if no background refresh has run yet.
    """
    with _bg_lock:
        data = dict(_bg_market_cache["data"])
        updated_at = _bg_market_cache["updated_at"]
        ticker_count = len(_bg_watch_tickers)
    if updated_at is None:
        return "", 204
    return jsonify({
        "data": data,
        "updated_at": updated_at,
        "ticker_count": ticker_count,
        "interval_min": _BG_INTERVAL_MIN,
    })


def fetch_ticker_data(tkr):
    data = {"price": None, "iv": None, "hv20": None, "hv60": None, "iv_rank": None, "iv_pct": None, "iv_hv_ratio": None}
    try:
        tk = yf.Ticker(tkr)

        # Price + historical volatility from 1yr history (retry on transient failure)
        hist = _yf_call(tk.history, period="1y")
        if not hist.empty:
            close = hist["Close"].dropna()
            if len(close) >= 2:
                data["price"] = round(float(close.iloc[-1]), 4)
                log_ret = np.log(close / close.shift(1)).dropna()
                if len(log_ret) >= 20:
                    data["hv20"] = round(float(log_ret.tail(20).std() * np.sqrt(252) * 100), 1)
                if len(log_ret) >= 60:
                    data["hv60"] = round(float(log_ret.tail(60).std() * np.sqrt(252) * 100), 1)

        # IV from options chain (retry on transient failure)
        try:
            exps = tk.options
            if exps:
                chain = _yf_call(tk.option_chain, exps[0])
                puts_df = _safe_chain_df(chain.puts) if hasattr(chain, 'puts') else pd.DataFrame()
                calls_df = _safe_chain_df(chain.calls) if hasattr(chain, 'calls') else pd.DataFrame()

                if "impliedVolatility" in puts_df.columns:
                    ivs = puts_df[puts_df["impliedVolatility"] > 0]["impliedVolatility"]
                else:
                    ivs = pd.Series(dtype=float)

                if not ivs.empty:
                    current_iv = float(ivs.median()) * 100
                    data["iv"] = round(current_iv, 1)

                    # Cache chain data for vol surface reuse
                    try:
                        cache_records = []
                        for side, df, otype in [("puts", puts_df, "Put"), ("calls", calls_df, "Call")]:
                            if "strike" in df.columns and "impliedVolatility" in df.columns:
                                for _, row in df[df["impliedVolatility"] > 0].iterrows():
                                    vol = row.get("volume", 0)
                                    oi = row.get("openInterest", 0)
                                    cache_records.append({
                                        "strike": float(row["strike"]),
                                        "impliedVolatility": float(row["impliedVolatility"]),
                                        "volume": int(vol) if pd.notna(vol) else 0,
                                        "openInterest": int(oi) if pd.notna(oi) else 0,
                                        "optType": otype,
                                    })
                        if cache_records:
                            _chain_cache[tkr] = [{"expiry": exps[0], "data": cache_records}]
                    except Exception:
                        pass

                    if hist is not None and len(hist) > 60:
                        close = hist["Close"].dropna()
                        log_ret = np.log(close / close.shift(1)).dropna()
                        rolling_hv = log_ret.rolling(20).std() * np.sqrt(252) * 100
                        rolling_hv = rolling_hv.dropna()
                        if len(rolling_hv) >= 20:
                            hv_min = float(rolling_hv.min())
                            hv_max = float(rolling_hv.max())
                            if hv_max > hv_min:
                                data["iv_rank"] = round((current_iv - hv_min) / (hv_max - hv_min) * 100, 1)
                                data["iv_rank"] = max(0, min(100, data["iv_rank"]))
                            data["iv_pct"] = round(float((rolling_hv < current_iv).mean() * 100), 1)

                    if data["hv20"] and data["hv20"] > 0:
                        data["iv_hv_ratio"] = round(current_iv / data["hv20"], 2)
        except Exception:
            pass

        # Expected move (#4)
        if data["iv"] and data["price"]:
            iv_dec = data["iv"] / 100
            price = data["price"]
            for label, days in [("1w", 7), ("2w", 14), ("1m", 30), ("2m", 60)]:
                em = round(price * iv_dec * np.sqrt(days / 365), 2)
                em_pct = round(iv_dec * np.sqrt(days / 365) * 100, 1)
                data[f"em_{label}"] = em
                data[f"em_{label}_pct"] = em_pct
        elif data["hv20"] and data["price"]:
            # No option chain IV available — estimate from HV20
            data["iv"] = data["hv20"]
            data["iv_source"] = "hv_estimate"
            iv_dec = data["hv20"] / 100
            price = data["price"]
            for label, days in [("1w", 7), ("2w", 14), ("1m", 30), ("2m", 60)]:
                em = round(price * iv_dec * np.sqrt(days / 365), 2)
                em_pct = round(iv_dec * np.sqrt(days / 365) * 100, 1)
                data[f"em_{label}"] = em
                data[f"em_{label}_pct"] = em_pct

        # Dividend ex-date (#7) — yfinance calendar is a dict in current
        # versions (was a DataFrame); _calendar_field handles both.
        try:
            cal = tk.calendar
            ex_date = _calendar_field(cal, "Ex-Dividend Date")
            if ex_date is not None:
                data["exDivDate"] = str(ex_date.date()) if hasattr(ex_date, "date") else str(ex_date)
            if ex_date is not None or _calendar_field(cal, "Dividend Date") is not None:
                divs = tk.dividends
                if not divs.empty:
                    data["lastDividend"] = round(float(divs.iloc[-1]), 4)
        except Exception:
            pass

    except Exception as e:
        print(f"  Error fetching {tkr} after retries: {e}", file=sys.stderr)
        # Fall back to the most-recent DB snapshot so the UI doesn't go blank
        stale = _last_known_price(tkr)
        if stale is not None:
            data["price"] = stale
            data["_stale"] = True
            print(f"  Using last-known price {stale} for {tkr}", file=sys.stderr)
    return data


# ─── API: Greeks + Beta-Weighted Delta + Risk (#1, #2, #3) ────────────────

# Beta cache: {ticker: (beta, fetched_at)}; "__SPY__" holds ((price, returns), ts)
_beta_cache = {}
BETA_TTL_S = 6 * 3600       # per-ticker beta: 6 hours
BETA_SPY_TTL_S = 15 * 60    # SPY price/returns: 15 minutes

# Tier-3 factor caches (realized vol, sector). {ticker: (value, fetched_at)};
# "__SPY_CLOSES__" holds ({date: close}, ts) for the benchmark alignment.
_hist_cache = {}
_sector_cache = {}
HIST_TTL_S = 30 * 60        # price-history closes: 30 minutes
SECTOR_TTL_S = 7 * 24 * 3600  # GICS sector: 7 days (rarely changes)


@app.route("/api/greeks", methods=["POST"])
def compute_greeks():
    try:
        body = request.json
        positions = body.get("positions", [])
        market = body.get("marketData", {})
        today = pd.Timestamp.now().normalize()

        position_greeks = []
        ticker_greeks = {}

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
                    "delta": shares, "gamma": 0, "theta": 0, "vega": 0,
                    "notional": shares * S if S else 0,
                }
                position_greeks.append(pg)
                agg = ticker_greeks.setdefault(tkr, {"delta": 0, "gamma": 0, "theta": 0, "vega": 0})
                agg["delta"] += shares
                continue

            if not S or not iv or not p.get("expiry"):
                position_greeks.append({
                    "ticker": tkr, "strike": p.get("strike"),
                    "optType": p.get("optType"), "expiry": p.get("expiry"),
                    "delta": 0, "gamma": 0, "theta": 0, "vega": 0,
                })
                continue

            opt_type = (p.get("optType") or "put").lower()
            strike = p.get("strike", 0)
            contracts = p.get("contracts", 0)
            multiplier = contracts * 100
            raw_dte = (pd.Timestamp(p["expiry"]) - today).days

            if raw_dte <= 0:
                # Expired / pending settlement: no time value remains, so the
                # time-decay greeks are zero. (Clamping DTE to 1 day instead would
                # produce a huge spurious theta — e.g. a near-ATM put showing
                # ~$150/day of "decay" that is already realized.) Delta is the
                # intrinsic assignment exposure: ±1 per share if ITM, else 0.
                if opt_type == "call":
                    intrinsic_delta = 1.0 if S > strike else 0.0
                else:
                    intrinsic_delta = -1.0 if S < strike else 0.0
                greeks = {"delta": intrinsic_delta, "gamma": 0.0, "theta": 0.0, "vega": 0.0}
            else:
                T = max(raw_dte, 1) / 365.0
                greeks = bs_greeks(S, strike, RISK_FREE, iv, T, opt_type)

            pg = {
                "ticker": tkr, "strike": strike,
                "optType": p.get("optType"), "expiry": p.get("expiry"),
                "contracts": contracts,
                "delta": round(greeks["delta"] * multiplier, 2),
                "gamma": round(greeks["gamma"] * multiplier, 4),
                "theta": round(greeks["theta"] * multiplier, 2),
                "vega": round(greeks["vega"] * multiplier, 2),
                "perContract": greeks,
            }
            position_greeks.append(pg)

            agg = ticker_greeks.setdefault(tkr, {"delta": 0, "gamma": 0, "theta": 0, "vega": 0})
            agg["delta"] += pg["delta"]
            agg["gamma"] += pg["gamma"]
            agg["theta"] += pg["theta"]
            agg["vega"] += pg["vega"]

        for tkr in ticker_greeks:
            for k in ticker_greeks[tkr]:
                ticker_greeks[tkr][k] = round(ticker_greeks[tkr][k], 2)

        portfolio_greeks = {"delta": 0, "gamma": 0, "theta": 0, "vega": 0}
        for tg in ticker_greeks.values():
            for k in portfolio_greeks:
                portfolio_greeks[k] += tg[k]
        for k in portfolio_greeks:
            portfolio_greeks[k] = round(portfolio_greeks[k], 2)

        # Beta-weighted delta (#2) — betas cached (TTL) so auto-refresh does
        # not re-download 6-month histories on every greeks call.
        beta_weighted = None
        try:
            now_ts = time.time()
            spy_price, spy_ret = None, None
            if _beta_cache.get("__SPY__") and now_ts - _beta_cache["__SPY__"][1] < BETA_SPY_TTL_S:
                spy_price, spy_ret = _beta_cache["__SPY__"][0]
            else:
                spy_tk = yf.Ticker("SPY")
                spy_hist = _yf_call(spy_tk.history, period="6mo")
                spy_price = float(spy_hist["Close"].iloc[-1])
                spy_ret = np.log(spy_hist["Close"] / spy_hist["Close"].shift(1)).dropna()
                _beta_cache["__SPY__"] = ((spy_price, spy_ret), now_ts)

            bw_delta = 0
            for tkr in ticker_greeks:
                md = market.get(tkr, {})
                tkr_price = md.get("price", 0)
                if not tkr_price:
                    continue
                cached = _beta_cache.get(tkr)
                if cached and now_ts - cached[1] < BETA_TTL_S:
                    beta = cached[0]
                else:
                    try:
                        tkr_hist = _yf_call(yf.Ticker(tkr).history, period="6mo")
                        tkr_ret = np.log(tkr_hist["Close"] / tkr_hist["Close"].shift(1)).dropna()
                        aligned = pd.DataFrame({"spy": spy_ret, "tkr": tkr_ret}).dropna()
                        if len(aligned) >= 30:
                            cov = np.cov(aligned["tkr"], aligned["spy"])
                            beta = float(cov[0, 1] / cov[1, 1])
                        else:
                            beta = 1.0
                    except Exception:
                        beta = 1.0
                    _beta_cache[tkr] = (beta, now_ts)

                pos_delta = ticker_greeks[tkr]["delta"]
                bw_delta += pos_delta * tkr_price * beta / spy_price

            beta_weighted = {
                "delta": round(bw_delta, 2),
                "spyPrice": round(spy_price, 2),
                "equivalent": f"{'Long' if bw_delta > 0 else 'Short'} {abs(round(bw_delta))} SPY shares",
            }
        except Exception as e:
            print(f"Beta-weight error: {e}", file=sys.stderr)

        # Max loss & margin (#3)
        risk = compute_risk_metrics(positions, market)

        # Save snapshot to DB (#18)
        try:
            conn = get_db()
            ts = datetime.now().isoformat()
            for tkr, tg in ticker_greeks.items():
                md = market.get(tkr, {})
                conn.execute(
                    "INSERT INTO snapshots (timestamp, ticker, price, iv, delta, gamma, theta, vega) VALUES (?,?,?,?,?,?,?,?)",
                    (ts, tkr, md.get("price"), md.get("iv"), tg["delta"], tg["gamma"], tg["theta"], tg["vega"])
                )
            conn.commit()
            conn.close()
        except Exception:
            pass

        return jsonify(validate_response(GreeksResponse, {
            "positions": position_greeks,
            "byTicker": ticker_greeks,
            "portfolio": portfolio_greeks,
            "betaWeighted": beta_weighted,
            "risk": risk,
        }))
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


def _compute_betas(tickers):
    """Per-ticker ~6mo beta vs SPY, reusing the shared _beta_cache (TTL)."""
    out = {}
    try:
        now_ts = time.time()
        if _beta_cache.get("__SPY__") and now_ts - _beta_cache["__SPY__"][1] < BETA_SPY_TTL_S:
            _, spy_ret = _beta_cache["__SPY__"][0]
        else:
            spy_hist = _yf_call(yf.Ticker("SPY").history, period="6mo")
            spy_price = float(spy_hist["Close"].iloc[-1])
            spy_ret = np.log(spy_hist["Close"] / spy_hist["Close"].shift(1)).dropna()
            _beta_cache["__SPY__"] = ((spy_price, spy_ret), now_ts)
        for tkr in tickers:
            cached = _beta_cache.get(tkr)
            if cached and now_ts - cached[1] < BETA_TTL_S:
                out[tkr] = round(cached[0], 3)
                continue
            try:
                tkr_hist = _yf_call(yf.Ticker(tkr).history, period="6mo")
                tkr_ret = np.log(tkr_hist["Close"] / tkr_hist["Close"].shift(1)).dropna()
                aligned = pd.DataFrame({"spy": spy_ret, "tkr": tkr_ret}).dropna()
                if len(aligned) >= 30:
                    cov = np.cov(aligned["tkr"], aligned["spy"])
                    beta = float(cov[0, 1] / cov[1, 1])
                else:
                    beta = 1.0
            except Exception:
                beta = 1.0
            _beta_cache[tkr] = (beta, now_ts)
            out[tkr] = round(beta, 3)
    except Exception as e:
        print(f"betas error: {e}", file=sys.stderr)
    return out


@app.route("/api/risk/betas", methods=["POST"])
def risk_betas():
    """Per-ticker beta vs SPY for the portfolio market-shock view (client-side)."""
    tickers = (request.json or {}).get("tickers", [])
    return jsonify({"betas": _compute_betas(tickers)})


# ─── API: Events / Earnings Calendar (#8) ─────────────────────────────────

@app.route("/api/events", methods=["POST"])
def get_events():
    tickers = request.json.get("tickers", [])
    events = {}
    for tkr in tickers:
        tkr_events = []
        try:
            tk = yf.Ticker(tkr)
            try:
                ed = tk.earnings_dates
                if ed is not None and not ed.empty:
                    for dt in ed.index[:4]:
                        tkr_events.append({
                            "date": str(dt.date()),
                            "type": "earnings",
                            "label": "Earnings",
                        })
            except Exception:
                pass
            try:
                cal = tk.calendar
                ed_raw = None
                if isinstance(cal, dict):
                    ed_raw = cal.get("Earnings Date")
                elif cal is not None and hasattr(cal, "index") and "Earnings Date" in cal.index:
                    ed_raw = cal.loc["Earnings Date"]
                if ed_raw is not None:
                    if hasattr(ed_raw, "iloc"):
                        ed_list = [ed_raw.iloc[i] for i in range(len(ed_raw))]
                    elif isinstance(ed_raw, (list, tuple)):
                        ed_list = list(ed_raw)
                    else:
                        ed_list = [ed_raw]
                    for d in ed_list:
                        if d is None or (not isinstance(d, (list, tuple)) and pd.isna(d)):
                            continue
                        tkr_events.append({
                            "date": str(d.date()) if hasattr(d, "date") else str(d),
                            "type": "earnings",
                            "label": "Earnings (calendar)",
                        })
            except Exception:
                pass
        except Exception as e:
            print(f"Events error for {tkr}: {e}", file=sys.stderr)

        seen = set()
        unique = []
        for ev in tkr_events:
            key = f"{ev['date']}|{ev['type']}"
            if key not in seen:
                seen.add(key)
                unique.append(ev)
        events[tkr] = sorted(unique, key=lambda x: x["date"])

    # Add custom catalysts from DB
    try:
        conn = get_db()
        rows = conn.execute("SELECT ticker, event_date, event_type, description FROM catalysts").fetchall()
        conn.close()
        for row in rows:
            tkr = row["ticker"]
            if tkr in events or tkr in tickers:
                events.setdefault(tkr, []).append({
                    "date": row["event_date"],
                    "type": row["event_type"] or "catalyst",
                    "label": row["description"] or "Custom catalyst",
                })
    except Exception:
        pass

    return jsonify(events)


# ─── API: Custom Catalysts CRUD (#8) ──────────────────────────────────────

@app.route("/api/catalysts", methods=["GET"])
def get_catalysts():
    conn = get_db()
    rows = conn.execute("SELECT * FROM catalysts ORDER BY event_date").fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])

@app.route("/api/catalysts", methods=["POST"])
def add_catalyst():
    body = request.json
    conn = get_db()
    conn.execute(
        "INSERT INTO catalysts (ticker, event_date, event_type, description) VALUES (?,?,?,?)",
        (body["ticker"].upper(), body["date"], body.get("type", "catalyst"), body.get("label", ""))
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})

@app.route("/api/catalysts/<int:cid>", methods=["DELETE"])
def delete_catalyst(cid):
    conn = get_db()
    conn.execute("DELETE FROM catalysts WHERE id=?", (cid,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ─── API: Correlated Monte Carlo Simulation (#9) ──────────────────────────

def compute_correlation_matrix(tickers, period="1y"):
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

    df = pd.DataFrame(returns_data).dropna()
    if len(df) < 30:
        return None, None, tickers

    ordered_tickers = list(df.columns)
    corr = df.corr().values

    eigvals = np.linalg.eigvalsh(corr)
    if eigvals.min() < 0:
        corr += (-eigvals.min() + 1e-6) * np.eye(len(corr))

    try:
        L = np.linalg.cholesky(corr)
    except np.linalg.LinAlgError:
        return corr, None, ordered_tickers

    return corr, L, ordered_tickers


@app.route("/api/simulate", methods=["POST"])
def simulate():
    try:
        body = request.json
        positions = body.get("positions", [])
        n_paths = min(body.get("n_paths", N_PATHS), 50_000)

        if not positions:
            return jsonify({"error": "No positions"}), 400

        today = pd.Timestamp.now().normalize()
        tickers = sorted(set(p["ticker"] for p in positions))

        # Fetch market data
        ticker_data = {}
        for tkr in tickers:
            td = fetch_ticker_data(tkr)
            hist = None
            try:
                hist = yf.download(tkr, period="60d", progress=False, auto_adjust=True)
                if isinstance(hist.columns, pd.MultiIndex):
                    hist.columns = [c[0] for c in hist.columns]
            except Exception:
                pass
            ticker_data[tkr] = {
                "price": td["price"],
                "iv": (td["iv"] / 100) if td["iv"] else 0.6,
                "hist": hist,
            }

        # Classify tickers
        ticker_model = {}
        ticker_reason = {}
        for tkr in tickers:
            td = ticker_data[tkr]
            model, reason = classify_ticker(tkr, td["hist"], td["iv"], today)
            ticker_model[tkr] = model
            ticker_reason[tkr] = reason

        # Correlated simulation (#9)
        corr_matrix, cholesky_L, corr_tickers = compute_correlation_matrix(tickers)

        ticker_paths = {}
        if cholesky_L is not None and len(corr_tickers) > 1:
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

            Z_indep = rng.standard_normal((n_paths, global_max_dte, n_tickers))
            Z_corr = np.einsum("ij,nkj->nki", cholesky_L, Z_indep)

            for ti, tkr in enumerate(corr_tickers):
                S0 = ticker_data[tkr]["price"]
                if not S0:
                    continue
                iv = ticker_data[tkr]["iv"]
                model = ticker_model[tkr]
                n_steps = max_dtes[tkr]
                dt = (n_steps / 252) / n_steps if n_steps > 0 else 1/252

                Z = Z_corr[:, :n_steps, ti]

                if model == "merton":
                    mp = MERTON_DEFAULTS
                    sigma_diff = iv * mp["sigma_diff_frac"]
                    k_bar = np.exp(mp["mu_j"] + 0.5 * mp["sig_j"]**2) - 1
                    drift = (RISK_FREE - 0.5 * sigma_diff**2 - mp["lam"] * k_bar) * dt
                    diffuse = drift + sigma_diff * np.sqrt(dt) * Z
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

        # Independent paths for remaining tickers
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

        # Compute P&L
        all_pnl = np.zeros(n_paths)
        ticker_pnl = {}
        strategy_pnl = {}

        strat_map = _build_sim_strategy_map(positions)

        for p in positions:
            tkr = p["ticker"]
            if tkr not in ticker_paths:
                continue
            paths = ticker_paths[tkr]
            pos_type = p.get("posType", "option")
            qty = p.get("contracts", 0) or p.get("shares", 0)

            if pos_type == "equity":
                cost = p.get("adjCost") or p.get("avgCost", 0)
                ST = paths[:, -1]
                pnl = qty * (ST - cost)
            else:
                dte = max((pd.Timestamp(p["expiry"]) - today).days, 1)
                step_idx = min(dte, paths.shape[1] - 1)
                ST = paths[:, step_idx]
                strike = p.get("strike", 0)
                opt_type = (p.get("optType") or "put").lower()
                if opt_type == "call":
                    intrinsic = np.maximum(ST - strike, 0.0)
                else:
                    intrinsic = np.maximum(strike - ST, 0.0)
                # Credit the option's own entry premium (avgCost). Premium is no
                # longer folded into the equity's adjusted basis, so there is no
                # double-count to guard against — the short put's premium belongs here.
                avg_cost = p.get("avgCost", 0)
                pnl = qty * (intrinsic - avg_cost) * 100

            all_pnl += pnl
            ticker_pnl[tkr] = ticker_pnl.get(tkr, np.zeros(n_paths)) + pnl
            # Options only per expiry slice — equity rolls into by_ticker combined book
            if p.get("posType") == "equity":
                continue
            sl = strat_map.get(_pos_strat_key(p))
            if sl:
                full_label = f"{tkr} {sl}"
                strategy_pnl[full_label] = strategy_pnl.get(full_label, np.zeros(n_paths)) + pnl

        # Build path chart data
        ticker_path_data = {}
        for tkr in tickers:
            if tkr not in ticker_paths:
                continue
            paths = ticker_paths[tkr]
            n_steps = paths.shape[1]
            step = max(1, n_steps // 100)
            indices = list(range(0, n_steps, step))
            if indices[-1] != n_steps - 1:
                indices.append(n_steps - 1)

            p5 = [round(float(np.percentile(paths[:, i], 5)), 4) for i in indices]
            p25 = [round(float(np.percentile(paths[:, i], 25)), 4) for i in indices]
            p50 = [round(float(np.percentile(paths[:, i], 50)), 4) for i in indices]
            p75 = [round(float(np.percentile(paths[:, i], 75)), 4) for i in indices]
            p95 = [round(float(np.percentile(paths[:, i], 95)), 4) for i in indices]
            mean_line = [round(float(paths[:, i].mean()), 4) for i in indices]

            tkr_positions = [p for p in positions if p["ticker"] == tkr]
            dates = pd.date_range(today, periods=n_steps, freq="D")
            date_labels = [dates[i].strftime("%b-%d") for i in indices]

            strikes_info = []
            equity_legs = []
            option_legs = []
            for p in tkr_positions:
                pos_type = p.get("posType", "option")
                if pos_type == "equity":
                    equity_legs.append(p)
                    adj_cost = p.get("adjCost") or p.get("avgCost", 0)
                    shares = p.get("shares", p.get("contracts", 0))
                    direction = "Long" if shares > 0 else "Short"
                    if adj_cost:
                        strikes_info.append({
                            "strike": adj_cost,
                            "label": f"${adj_cost:g} adj basis ({direction} {abs(shares)}sh)",
                            "optType": None, "contracts": shares,
                            "isEquity": True, "lineType": "basis",
                        })
                else:
                    option_legs.append(p)
                    direction = "L" if p.get("contracts", 0) > 0 else "S"
                    kind = "C" if p.get("optType") == "Call" else "P"
                    exp_short = pd.Timestamp(p["expiry"]).strftime("%b-%d") if p.get("expiry") else ""
                    strikes_info.append({
                        "strike": p.get("strike", 0),
                        "label": f"${p.get('strike',0):g} {direction}{abs(p.get('contracts',0))}{kind} {exp_short}",
                        "optType": p.get("optType"),
                        "contracts": p.get("contracts", 0),
                    })

            breakevens = []
            has_equity = len(equity_legs) > 0
            short_puts = [l for l in option_legs if l.get("optType") == "Put" and l.get("contracts", 0) < 0]
            short_calls = [l for l in option_legs if l.get("optType") == "Call" and l.get("contracts", 0) < 0]
            has_short_options = len(short_puts) + len(short_calls) > 0

            if has_equity:
                eq = equity_legs[0]
                current_shares = eq.get("shares", eq.get("contracts", 0))
                adj_cost = eq.get("adjCost") or eq.get("avgCost", 0)
                raw_cost = eq.get("avgCost", 0)
                # Premium credited toward break-even = premium collected on the CURRENTLY
                # OPEN short options modeled here (each leg's entry price × 100 × contracts).
                # Replaces the removed equity-level totalPremium and, by design, excludes
                # realized premium from already-closed trades (that belongs in Realized P&L,
                # not a forward break-even).
                total_premium = sum(
                    abs(l.get("contracts", 0)) * (l.get("avgCost", 0) or 0) * 100
                    for l in short_puts + short_calls
                )
                net_investment = abs(current_shares) * raw_cost

                shares_abs = abs(current_shares) or 0
                # "All expire" = every short option expires worthless and you keep the
                # premium, so the share break-even is the cost basis minus premium per share.
                be_expire = round(adj_cost - (total_premium / shares_abs if shares_abs else 0), 4)
                if be_expire and be_expire > 0:
                    breakevens.append({
                        "value": be_expire,
                        "label": f"${be_expire:g} BE (all expire, {shares_abs}sh)",
                        "beType": "expire",
                    })

                if has_short_options:
                    boundaries = sorted(set(
                        [l.get("strike", 0) for l in short_puts + short_calls]
                    ))
                    zones = []
                    for i in range(len(boundaries) + 1):
                        lo = boundaries[i - 1] if i > 0 else 0
                        hi = boundaries[i] if i < len(boundaries) else float("inf")
                        mid = (lo + hi) / 2 if hi != float("inf") else lo + 1
                        if lo == 0:
                            mid = boundaries[0] - 1 if boundaries else 1
                        new_shares = abs(current_shares)
                        new_cost = net_investment
                        for sp in short_puts:
                            strike = sp.get("strike", 0)
                            cts = abs(sp.get("contracts", 0))
                            sh = cts * 100
                            if mid < strike:
                                if current_shares >= 0:
                                    new_shares += sh
                                    new_cost += strike * sh
                                else:
                                    new_shares -= sh
                                    new_cost -= strike * sh
                        for sc in short_calls:
                            strike = sc.get("strike", 0)
                            cts = abs(sc.get("contracts", 0))
                            sh = cts * 100
                            if mid >= strike:
                                if current_shares >= 0:
                                    new_shares -= sh
                                    new_cost -= strike * sh
                                else:
                                    new_shares += sh
                                    new_cost += strike * sh
                        if new_shares > 0:
                            be = round((new_cost - total_premium) / new_shares, 4)
                            if hi == float("inf"):
                                zone_label = f">{lo:g}"
                            elif lo == 0:
                                zone_label = f"<{hi:g}"
                            else:
                                zone_label = f"${lo:g}-${hi:g}"
                            zones.append({
                                "value": be,
                                "label": f"${be:g} BE ({zone_label}, {new_shares}sh)",
                                "beType": "scenario",
                                "zone": zone_label,
                                "newShares": new_shares,
                            })
                        elif new_shares == 0:
                            pnl_val = round(-new_cost + total_premium, 2)
                            zones.append({
                                "value": raw_cost,
                                "label": f"All called away ({zone_label}) → P&L ${pnl_val:g}",
                                "beType": "scenario",
                                "zone": zone_label,
                                "newShares": 0,
                            })
                    seen_be = set()
                    for z in zones:
                        # Filter out negative or zero breakevens — they distort charts
                        if z["value"] <= 0:
                            continue
                        key = round(z["value"], 2)
                        if key not in seen_be:
                            seen_be.add(key)
                            breakevens.append(z)
            elif option_legs:
                exp_groups = {}
                for ol in option_legs:
                    if ol.get("expiry"):
                        exp_groups.setdefault(ol["expiry"], []).append(ol)
                for exp_str, exp_legs in sorted(exp_groups.items()):
                    spot = ticker_data[tkr]["price"] or float(paths[0, 0])
                    bes = _find_breakevens_py(exp_legs, spot)
                    exp_short = pd.Timestamp(exp_str).strftime("%b-%d")
                    for i, be_val in enumerate(bes):
                        suffix = f" ({i+1})" if len(bes) > 1 else ""
                        breakevens.append({
                            "value": be_val,
                            "label": f"${be_val:g} BE{suffix} [{exp_short}]",
                            "beType": "standard",
                        })

            share_count = sum(p.get("shares", 0) or 0 for p in tkr_positions if p.get("posType") == "equity")

            ticker_path_data[tkr] = {
                "dates": date_labels,
                "p5": p5, "p25": p25, "p50": p50, "p75": p75, "p95": p95,
                "mean": mean_line,
                "strikes": strikes_info,
                "breakevens": breakevens,
                "model": ticker_model.get(tkr, "gbm"),
                "shares": share_count,
                "adjCost": equity_legs[0].get("adjCost") if equity_legs else None,
            }

        theta_data = build_theta_data(positions, ticker_data, today)

        # Correlation info (#10)
        corr_info = None
        if corr_matrix is not None:
            corr_info = {
                "tickers": corr_tickers,
                "matrix": [[round(float(corr_matrix[i][j]), 3)
                            for j in range(len(corr_tickers))]
                           for i in range(len(corr_tickers))],
            }

        result = {
            "n_paths": n_paths,
            "portfolio": _pnl_stats(all_pnl),
            "by_ticker": {
                tkr: {
                    **_pnl_stats(pnl),
                    "model": ticker_model.get(tkr, "gbm"),
                    "reason": ticker_reason.get(tkr, ""),
                    "price": ticker_data[tkr]["price"],
                    "iv": round(ticker_data[tkr]["iv"] * 100, 1),
                }
                for tkr, pnl in sorted(ticker_pnl.items())
            },
            "by_strategy": {
                label: _pnl_stats(pnl)
                for label, pnl in sorted(strategy_pnl.items())
            },
            "histogram": _histogram(all_pnl, 60),
            "portfolio_pnl": [round(float(x), 2) for x in all_pnl.tolist()],
            "ticker_histograms": {
                tkr: _histogram(pnl, 40)
                for tkr, pnl in sorted(ticker_pnl.items())
            },
            "ticker_paths": ticker_path_data,
            "theta": theta_data,
            "correlation": corr_info,
            "component_var": _compute_component_var(all_pnl, ticker_pnl, 0.95),
        }
        return jsonify(validate_response(SimulateResponse, result))

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ─── API: Roll Analyzer (#11) ─────────────────────────────────────────────

@app.route("/api/roll-analysis", methods=["POST"])
def roll_analysis():
    try:
        body = request.json
        tkr = body["ticker"]
        current = body["current"]
        target = body["target"]
        today = pd.Timestamp.now().normalize()

        tk = yf.Ticker(tkr)
        price = float(tk.history(period="5d")["Close"].iloc[-1])

        if not current.get("expiry"):
            return jsonify({
                "error": "Current expiry is unknown. Ensure the portfolio CSV includes option expiry, or re-fetch after fixing position data.",
            }), 400

        target_expiry = target["expiry"]
        opt_type = current.get("optType", "Put").lower()

        try:
            chain = tk.option_chain(target_expiry)
            df = chain.puts if opt_type == "put" else chain.calls
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

        try:
            current_expiry = pd.Timestamp(current["expiry"])
        except Exception:
            return jsonify({"error": f"Invalid current expiry: {current.get('expiry')}"}), 400
        current_dte = max((current_expiry - today).days, 1)
        current_T = current_dte / 365.0
        current_iv = target_iv

        current_greeks_raw = bs_greeks(price, current["strike"], RISK_FREE, current_iv, current_T, opt_type)
        current_theoretical = max(bs_option_value(price, current["strike"], RISK_FREE, current_iv, current_T, opt_type), 0)

        target_dte = max((pd.Timestamp(target_expiry) - today).days, 1)
        target_T = target_dte / 365.0
        target_greeks = bs_greeks(price, target_strike, RISK_FREE, target_iv, target_T, opt_type)

        contracts = current.get("contracts", 0)
        n = abs(contracts)

        if contracts < 0:
            roll_net = target_mid - current_theoretical
        else:
            roll_net = current_theoretical - target_mid

        roll_total = round(roll_net * n * 100, 2)
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


# ─── API: Historical Trade Performance (#12) ──────────────────────────────

from io import StringIO


def _parse_hist_csv_line(line):
    try:
        return next(csv.reader(StringIO(line)))
    except Exception:
        return line.split(",") if "," in line else []


def _find_hist_header_row(lines, required_keys, max_scan=30):
    for i, line in enumerate(lines[:max_scan]):
        lo = (line or "").lower()
        if "," not in lo:
            continue
        if all(k in lo for k in required_keys):
            return i
    return -1


def _hist_header_col(headers, *names):
    for name in names:
        n = name.lower()
        for idx, h in enumerate(headers):
            hl = h.lower().strip().strip('"').replace("($)", "").strip()
            if hl == n or n in hl:
                return idx
    return -1


def _parse_hist_money(val):
    if val is None:
        return 0.0
    s = str(val).strip().strip('"').replace("$", "").replace(",", "").replace("+", "")
    if not s or s in ("--", "—"):
        return 0.0
    try:
        return abs(float(s))
    except ValueError:
        return 0.0


def _parse_hist_date_iso(ds):
    ds = (ds or "").strip().strip('"')
    if not ds or not re.search(r"\d", ds):
        return None
    ds_main = ds.split(";")[0].split(" ")[0]
    if re.match(r"^\d{8}$", ds_main):
        return f"{ds_main[0:4]}-{ds_main[4:6]}-{ds_main[6:8]}"
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", ds_main)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    if "/" in ds_main:
        parts = ds_main.split("/")
        if len(parts) >= 3:
            try:
                if len(parts[0]) == 4:
                    return f"{parts[0]}-{parts[1].zfill(2)}-{parts[2].zfill(2)}"
                return f"{parts[2]}-{parts[0].zfill(2)}-{parts[1].zfill(2)}"
            except (ValueError, IndexError):
                pass
    return None


def _detect_history_format(lines):
    for line in lines[:15]:
        lo = (line or "").lower()
        if "run date" in lo and "action" in lo:
            return "fidelity"
        if "tradedate" in lo and "symbol" in lo and ("code" in lo or "buy/sell" in lo):
            return "ibkr"
        if "date/time" in lo and "symbol" in lo and ("code" in lo or "quantity" in lo):
            return "ibkr"
        if "asset category" in lo and "symbol" in lo and "quantity" in lo:
            return "ibkr"
        if "date" in lo and "action" in lo and "fees" in lo and "run date" not in lo:
            return "schwab"
    return "unknown"


def _ibkr_expiry_to_yymmdd(expiry_str):
    d = (expiry_str or "").strip().split(" ")[0].replace("/", "-")
    if re.match(r"^\d{8}$", d):
        return d[2:8]
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", d)
    if m:
        return f"{m.group(1)[2:]}{m.group(2)}{m.group(3)}"
    return None


def _ibkr_build_occ_key(sym, desc="", expiry="", strike="", right=""):
    norm = re.sub(r"\s+", "", (sym or "")).lower()
    if not norm.startswith("-") and re.search(r"\d{6}[pc]\d", norm):
        norm = "-" + norm
    if _parse_occ_symbol(norm):
        return norm.lstrip("-")
    ticker = re.sub(r"[^a-z0-9.]", "", (sym or "").split()[0].lower()) if sym else ""
    yymmdd = _ibkr_expiry_to_yymmdd(expiry)
    if not ticker or not yymmdd or not strike or not right:
        dm = re.search(
            r"([A-Z]{1,6})\s+([A-Z]{3}\d{2}'?\d{2})\s+([\d.]+)\s+([PC])",
            (desc or "").upper(),
        )
        if dm:
            mo = {"JAN": "01", "FEB": "02", "MAR": "03", "APR": "04", "MAY": "05", "JUN": "06",
                  "JUL": "07", "AUG": "08", "SEP": "09", "OCT": "10", "NOV": "11", "DEC": "12"}
            mp = dm.group(2).replace("'", "").upper()
            mpp = re.match(r"^([A-Z]{3})(\d{2})(\d{2})$", mp)
            if mpp:
                ticker = dm.group(1).lower()
                yymmdd = f"{mpp.group(3)}{mo.get(mpp.group(1), '01')}{mpp.group(2)}"
                strike = dm.group(3)
                right = dm.group(4)
    if not ticker or not yymmdd:
        return None
    try:
        strike_f = float(str(strike).replace(",", ""))
    except (TypeError, ValueError):
        return None
    pc = "p" if str(right).lower().startswith("p") else "c"
    strike_raw = int(round(strike_f * 1000))
    return f"{ticker}{yymmdd}{pc}{strike_raw:08d}"


def _ibkr_code_to_action(code, buy_sell, qty, sec_type=""):
    c = (code or "").upper().replace(" ", "")
    parts = re.split(r"[;,|/]", c)
    bs = (buy_sell or "").upper()
    is_buy = "BUY" in bs or bs in ("BOT", "B")
    is_sell = "SELL" in bs or bs in ("SLD", "S")
    if not is_buy and not is_sell:
        if qty < 0:
            is_sell = True
        elif qty > 0:
            is_buy = True
    opt_word = "PUT"

    if any(p in ("A", "ASGN") or "ASSIGN" in p for p in parts) or "ASSIGN" in c:
        return f"{opt_word} ASSIGNED"
    if any(p.startswith("EP") or p in ("EXPIRE", "EXPIRED") for p in parts) or "EXPIR" in c:
        return f"{opt_word} EXPIRED"
    if any(p in ("EX", "EXER") or "EXERCISE" in p for p in parts):
        return f"{opt_word} EXERCISED"

    is_open = any(p == "O" or p.startswith("OPEN") for p in parts) or c == "O"
    is_close = any(p == "C" or p.startswith("CLOSE") for p in parts) or c == "C"
    if not is_open and not is_close:
        if is_buy and not is_sell:
            is_open = True
        elif is_sell and not is_buy:
            is_close = True

    if is_open:
        return "SELL TO OPEN" if is_sell or (not is_buy and qty < 0) else "BUY TO OPEN"
    if is_close:
        return "BUY TO CLOSE" if is_buy or (not is_sell and qty > 0) else "SELL TO CLOSE"
    return None


def _ibkr_equity_side(code, buy_sell, qty):
    c = (code or "").upper()
    bs = (buy_sell or "").upper()
    is_open = "O" in c or "OPEN" in c
    is_close = "C" in c or "CLOSE" in c
    is_buy = "BUY" in bs or bs in ("BOT", "B") or qty > 0
    is_sell = "SELL" in bs or bs in ("SLD", "S") or qty < 0
    if is_open:
        return "long_open" if is_buy else "short_open"
    if is_close:
        return "long_close" if is_sell else "short_close"
    if is_buy and not is_sell:
        return "long_open"
    if is_sell and not is_buy:
        return "long_close"
    return None


def _parse_ibkr_raw_txns(lines):
    """Parse IBKR Flex / Activity Statement trade rows into FIFO txn maps."""
    hdr_idx = _find_hist_header_row(lines, ["symbol", "quantity"])
    if hdr_idx < 0:
        hdr_idx = _find_hist_header_row(lines, ["symbol", "qty"])
    if hdr_idx < 0:
        return {}, {}, ["Could not find IBKR header row (Symbol + Quantity)."]

    headers = [h.strip().strip('"').lower() for h in _parse_hist_csv_line(lines[hdr_idx])]
    date_idx = _hist_header_col(headers, "tradedate", "date/time", "date", "trade date")
    sym_idx = _hist_header_col(headers, "symbol")
    qty_idx = _hist_header_col(headers, "quantity", "qty")
    price_idx = _hist_header_col(headers, "t. price", "tradeprice", "trade price", "price")
    code_idx = _hist_header_col(headers, "code")
    side_idx = _hist_header_col(headers, "buy/sell", "buy/sell indicator")
    sec_idx = _hist_header_col(headers, "asset category", "sectype", "assetclass")
    exp_idx = _hist_header_col(headers, "expiry", "expiration", "exp")
    strike_idx = _hist_header_col(headers, "strike")
    right_idx = _hist_header_col(headers, "put/call", "right")
    desc_idx = _hist_header_col(headers, "description", "financial instrument")

    trades = {}
    equity_txns = {}
    warnings = []

    for i in range(hdr_idx + 1, len(lines)):
        r = _parse_hist_csv_line(lines[i])
        if len(r) <= max(sym_idx, qty_idx, 0):
            continue
        sym_raw = (r[sym_idx] if sym_idx >= 0 else "").strip().strip('"')
        if not sym_raw or sym_raw.lower() in ("total", "subtotal") or sym_raw.startswith("---"):
            continue
        ds_raw = (r[date_idx] if date_idx >= 0 else "").strip()
        dt = _parse_hist_date_iso(ds_raw)
        if not dt:
            continue
        try:
            qty_signed = int(float((r[qty_idx] if qty_idx >= 0 else "0").replace(",", "")))
        except (ValueError, TypeError):
            qty_signed = 0
        qty = abs(qty_signed)
        if qty == 0 and code_idx >= 0 and "EP" not in (r[code_idx] or "").upper():
            continue
        price = _parse_hist_money(r[price_idx] if price_idx >= 0 else "0")
        code = r[code_idx] if code_idx >= 0 else ""
        buy_sell = r[side_idx] if side_idx >= 0 else ""
        sec = (r[sec_idx] if sec_idx >= 0 else "").strip().upper()
        desc = r[desc_idx] if desc_idx >= 0 else sym_raw
        expiry = r[exp_idx] if exp_idx >= 0 else ""
        strike = r[strike_idx] if strike_idx >= 0 else ""
        right = r[right_idx] if right_idx >= 0 else ""

        is_opt = (
            sec in ("OPT", "OPTION", "OPTIONS")
            or _parse_occ_symbol(re.sub(r"\s+", "", sym_raw))
            or _ibkr_build_occ_key(sym_raw, desc, expiry, strike, right)
        )
        if not is_opt and sec not in ("STK", "STOCK", "EQUITY", ""):
            if sec and sec not in ("CASH", "TOTAL"):
                continue

        eq_ticker = _plain_equity_ticker(sym_raw) if not is_opt else None
        if eq_ticker and not _parse_occ_symbol(re.sub(r"\s+", "", sym_raw)):
            side = _ibkr_equity_side(code, buy_sell, qty_signed)
            if side:
                equity_txns.setdefault(eq_ticker, []).append({
                    "date": dt, "side": side, "qty": qty or 1, "price": price,
                })
            continue

        occ_key = _ibkr_build_occ_key(sym_raw, desc, expiry, strike, right)
        if not occ_key:
            warnings.append(f"Skipped unparseable IBKR option row: {sym_raw[:40]}")
            continue
        action = _ibkr_code_to_action(code, buy_sell, qty_signed, sec)
        if not action:
            continue
        trades.setdefault(occ_key, []).append({
            "date": dt,
            "action": action,
            "qty": qty or 1,
            "price": price,
        })

    return trades, equity_txns, warnings


def _schwab_symbol_to_occ(sym_raw):
    """Convert a Schwab option symbol 'TICKER MM/DD/YYYY STRIKE P/C' into an
    OCC-ish '-tickeryymmddpcstrike' string so _parse_occ_symbol can read it.
    Returns None if the symbol isn't in Schwab's option format."""
    m = re.match(r"^([A-Za-z.]+)\s+(\d{2})/(\d{2})/(\d{4})\s+([\d.]+)\s+([PCpc])$", (sym_raw or "").strip())
    if not m:
        return None
    ticker, mm, dd, yyyy, strike, pc = m.groups()
    strike_str = ("%f" % float(strike)).rstrip("0").rstrip(".")
    return f"-{ticker.lower()}{yyyy[2:]}{mm}{dd}{pc.lower()}{strike_str}"


def _parse_fidelity_schwab_raw_txns(lines):
    """Parse Fidelity Run Date / Schwab Date+Action history into FIFO txn maps."""
    header_idx = -1
    header = ""
    for i, line in enumerate(lines[:12]):
        lo = line.lower()
        if ("run date" in lo and "action" in lo) or (
            "date" in lo and "action" in lo and "symbol" in lo and "run date" not in lo
        ):
            header = lo
            header_idx = i
            break

    cols = [c.strip().strip('"') for c in header.split(",")] if header else []
    col_map = {}
    for ci, c in enumerate(cols):
        cl = c.lower().replace("($)", "").strip()
        if cl in ("run date", "date"):
            col_map["date"] = ci
        elif cl == "action":
            col_map["action"] = ci
        elif cl == "symbol":
            col_map["symbol"] = ci
        elif cl in ("quantity", "qty"):
            col_map["qty"] = ci
        elif cl in ("price", "price ($)"):
            col_map["price"] = ci
        elif cl in ("description", "desc"):
            col_map["description"] = ci

    date_idx = col_map.get("date", 0)
    action_idx = col_map.get("action", 1)
    sym_idx = col_map.get("symbol", 2)
    qty_idx = col_map.get("qty", 5)
    price_idx = col_map.get("price", 6)
    desc_idx = col_map.get("description", 3)

    trades = {}
    equity_txns = {}

    for li, line in enumerate(lines):
        if li <= header_idx:
            continue
        r = _parse_hist_csv_line(line)
        if len(r) <= max(date_idx, action_idx, sym_idx, qty_idx, price_idx):
            continue
        ds = r[date_idx].strip().strip('"')
        if not ds or not ds[0].isdigit():
            continue
        action = r[action_idx].strip().strip('"').upper()
        if "JOURNAL" in action or "TRANSFER" in action:
            continue  # Schwab account transfers / journal entries are not trades
        sym_raw = r[sym_idx].strip().strip('"')
        sym = _schwab_symbol_to_occ(sym_raw) or sym_raw.lower().replace(" ", "")
        price = _parse_hist_money(r[price_idx] if price_idx < len(r) else "0")
        try:
            qty = abs(int(float(r[qty_idx].strip().strip('"').replace(",", ""))))
        except (ValueError, IndexError):
            qty = 0
        if qty == 0 and "EXPIRED" not in action:
            continue
        dt = _parse_hist_date_iso(ds)
        if not dt:
            continue

        desc = r[desc_idx].strip().strip('"') if 0 <= desc_idx < len(r) else ""
        is_occ = _parse_occ_symbol(sym) is not None
        desc_is_option = bool(re.match(r"\s*(PUT|CALL)\b", desc, re.I))
        eq_ticker = _plain_equity_ticker(sym_raw)

        # 1) Plain-ticker equity trade.
        if eq_ticker and not is_occ and "OPENING TRANSACTION" not in action and "CLOSING TRANSACTION" not in action:
            side = _equity_trade_side(action)
            if side:
                equity_txns.setdefault(eq_ticker, []).append({
                    "date": dt, "side": side, "qty": qty, "price": price,
                })
            continue

        # 2) CUSIP-coded equity (broker reported a CUSIP, not a ticker — e.g. inverse/
        #    leveraged ETFs, post-split shares). Only genuine buy/sell/short rows pass
        #    the side test; cash, interest, collateral, fees, splits, transfers do not,
        #    so they are dropped instead of being mislabeled as their own "underlying".
        if not eq_ticker and not is_occ and not desc_is_option and _is_cusip(sym_raw):
            side = _equity_trade_side(action)
            if side:
                equity_txns.setdefault(sym_raw.upper(), []).append({
                    "date": dt, "side": side, "qty": qty, "price": price,
                    "name": _friendly_security_name(desc),
                })
            continue

        # 3) Options: a real OCC symbol, or a CUSIP-coded option Fidelity describes as
        #    PUT/CALL, or any row whose action is itself an option open/close.
        if not (is_occ or desc_is_option or _classify_option_event(action)):
            continue  # 4) everything else (cash / interest / collateral / fees) — not a trade

        trades.setdefault(sym, []).append({
            "date": dt,
            "action": action,
            "qty": qty,
            "price": price,
            "underlying": _option_underlying_from_desc(desc),
        })

    return trades, equity_txns, []


def _parse_history_raw_txns(hist_text):
    lines = hist_text.replace("\ufeff", "").replace("\r", "").split("\n")
    fmt = _detect_history_format(lines)
    if fmt == "ibkr":
        trades, equity, warnings = _parse_ibkr_raw_txns(lines)
        return trades, equity, fmt, warnings
    trades, equity, _ = _parse_fidelity_schwab_raw_txns(lines)
    if trades or equity:
        return trades, equity, fmt if fmt != "unknown" else "fidelity", []
    if fmt == "unknown":
        trades, equity, warnings = _parse_ibkr_raw_txns(lines)
        if trades or equity:
            return trades, equity, "ibkr", warnings
    return trades, equity, fmt, []


def _merge_history_texts(texts):
    """Parse each history file by its OWN broker format and merge the trade/equity
    maps into one journal. Lets multi-broker history (e.g. Fidelity + Schwab) combine
    correctly: every file gets its own format detection, and cross-broker opens/closes
    pair because both normalize to the same canonical OCC key (the FIFO matcher sorts
    each symbol's merged txns by date)."""
    merged_trades = {}
    merged_equity = {}
    fmts = []
    warnings = []
    for text in texts or []:
        if not text or not text.strip():
            continue
        trades, equity, fmt, warns = _parse_history_raw_txns(text)
        for sym, txns in trades.items():
            merged_trades.setdefault(sym, []).extend(txns)
        for ticker, txns in equity.items():
            merged_equity.setdefault(ticker, []).extend(txns)
        if fmt and fmt != "unknown":
            fmts.append(fmt)
        warnings.extend(warns or [])
    hist_fmt = "+".join(dict.fromkeys(fmts)) if fmts else "unknown"
    return merged_trades, merged_equity, hist_fmt, warnings


def _is_cusip(sym):
    """True if a symbol looks like a 9-char CUSIP. Brokers report a CUSIP instead of a
    ticker for some securities (delisted names, leveraged/inverse ETFs, post-split
    shares), which otherwise get dropped or mislabeled."""
    s = (sym or "").strip().upper()
    return bool(re.fullmatch(r"[0-9A-Z]{9}", s)) and any(c.isdigit() for c in s)


_SECURITY_NAME_BOILERPLATE = (
    "ETF OPPORTUNITIES TR", "TIDAL TRUST II", "TIDAL TR II", "PROSHARES TRUST",
    "PROSHARES TR", "INVESTMENT MANAGERS SER TR II", "DIREXION SHARES ETF TRUST",
    "INC COM", "COMMON STOCK", "CLASS A", "COM NPV", "TRUST",
)


def _friendly_security_name(desc):
    """Best-effort readable label from a broker security description for CUSIP rows,
    e.g. 'ETF OPPORTUNITIES TR T-REX 2X INVERSE TSLA' -> 'T-REX 2X INVERSE TSLA'."""
    s = re.sub(r"\s+", " ", (desc or "").strip().upper())
    # Drop corporate-action / reorg tails so the same security collapses to one label.
    s = re.split(r"\b\d+\s+FOR\s+\d+\b|R/S|REVERSE SPLIT|CASH MERGER|REORGANIZATION|EXCHANGED FOR", s)[0].strip()
    for b in _SECURITY_NAME_BOILERPLATE:
        s = s.replace(b, " ")
    s = re.sub(r"\s+", " ", s).strip(" -")
    return s[:22] or None


def _option_underlying_from_desc(desc):
    """Pull the underlying ticker from a Fidelity option description, e.g.
    'PUT (OPEN) OPENDOOR JAN 15 27 $5' -> 'OPEN' (for CUSIP-coded option rows)."""
    m = re.match(r"\s*(?:PUT|CALL)\s*\(([A-Z0-9]{1,6})\)", (desc or "").upper())
    return m.group(1) if m else None


def _equity_trade_side(action):
    """Classify a plain equity history action into a long/short open/close, or None
    for non-trades (cash, interest, collateral, fees, splits, transfers)."""
    a = action.upper()
    if "SOLD SHORT" in a or ("SOLD" in a and "SHORT SALE" in a):
        return "short_open"
    if "BOUGHT SHORT COVER" in a or ("BOUGHT" in a and "SHORT COVER" in a):
        return "short_close"
    if "BOUGHT" in a and "SHORT" not in a:
        return "long_open"
    if "SOLD" in a and "SHORT" not in a:
        return "long_close"
    return None


def _plain_equity_ticker(sym):
    """Return uppercase ticker if symbol is plain equity, else None."""
    if _parse_occ_symbol(sym):
        return None
    raw = sym.strip().split("(")[0].strip()
    ticker = re.sub(r"[\*\s]", "", raw).upper()
    if not ticker or len(ticker) > 6 or re.search(r"\d{6}", ticker) or "," in ticker:
        return None
    return ticker


_STRATEGY_SINGULAR = {
    "Covered Calls": "Covered Call",
    "Covered Puts": "Covered Put",
    "Covered Straddles": "Covered Straddle",
    "Covered Strangles": "Covered Strangle",
    "Protective Puts": "Protective Put",
    "Long Calls": "Long Call",
    "Short Calls": "Short Call",
    "Long Puts": "Long Put",
    "Short Puts": "Short Put",
    "Long Shares + Short Puts": "Long Shares + Short Put",
    "Overwritten Calls": "Overwritten Call",
    "Overwritten Puts": "Overwritten Put",
}


def _normalize_strategy_label(label):
    """Map plural / legacy strategy labels to canonical singular form."""
    if not label:
        return "Unknown"
    parts = [p.strip() for p in str(label).split(" + ")]
    return " + ".join(_STRATEGY_SINGULAR.get(p, p) for p in parts)


def _join_strategy_labels(labels):
    """Collapse duplicate spread labels: ['Bull Call Spread', 'Bull Call Spread'] → 'Bull Call Spread (2)'."""
    if not labels:
        return None
    counts = Counter(labels)
    return " + ".join(f"{name} ({n})" if n > 1 else name for name, n in counts.items())


def _aggregate_legs_for_classify(legs):
    """Net option legs by (type, strike) so spread pairing sees one row per strike."""
    share_qty = 0
    opt_map = defaultdict(int)
    for leg in legs:
        if leg.get("posType") == "equity":
            share_qty += leg.get("shares") or leg.get("contracts") or 0
        else:
            key = (leg.get("optType"), round(float(leg.get("strike") or 0), 4))
            opt_map[key] += int(leg.get("contracts", 0))
    out = []
    if share_qty:
        out.append({"posType": "equity", "shares": share_qty, "contracts": share_qty})
    for (opt_type, strike), cts in sorted(opt_map.items(), key=lambda x: (x[0][0], x[0][1])):
        if cts:
            out.append({"posType": "option", "optType": opt_type, "strike": strike, "contracts": cts})
    return out


def _pair_vertical_spreads(option_legs, opt_type):
    """Greedy long/short pairing into vertical spread names."""
    buckets = defaultdict(int)
    for leg in option_legs:
        strike = round(float(leg.get("strike") or 0), 4)
        buckets[strike] += int(leg.get("contracts", 0))

    work = []
    for strike, cts in sorted(buckets.items()):
        if cts > 0:
            work.append({"strike": strike, "rem": cts, "sign": 1})
        elif cts < 0:
            work.append({"strike": strike, "rem": -cts, "sign": -1})

    labels = []
    longs = [l for l in work if l["sign"] > 0]
    shorts = [l for l in work if l["sign"] < 0]

    for lg in sorted(longs, key=lambda x: x["strike"]):
        while lg["rem"] > 0:
            candidates = [s for s in shorts if s["rem"] > 0 and s["strike"] > lg["strike"]]
            if not candidates:
                break
            partner = min(candidates, key=lambda x: x["strike"])
            matched = min(lg["rem"], partner["rem"])
            labels.append("Bull Call Spread" if opt_type == "Call" else "Bull Put Spread")
            lg["rem"] -= matched
            partner["rem"] -= matched

    for lg in sorted(longs, key=lambda x: -x["strike"]):
        while lg["rem"] > 0:
            candidates = [s for s in shorts if s["rem"] > 0 and s["strike"] < lg["strike"]]
            if not candidates:
                break
            partner = max(candidates, key=lambda x: x["strike"])
            matched = min(lg["rem"], partner["rem"])
            labels.append("Bear Call Spread" if opt_type == "Call" else "Bear Put Spread")
            lg["rem"] -= matched
            partner["rem"] -= matched

    unpaired = []
    for leg in work:
        if leg["rem"] > 0:
            cts = leg["rem"] if leg["sign"] > 0 else -leg["rem"]
            unpaired.append({"posType": "option", "optType": opt_type, "strike": leg["strike"], "contracts": cts})
    return labels, unpaired


def _detect_butterfly(option_legs, opt_type):
    """Detect 1:-2:1 (or inverse) butterfly on three strikes."""
    if len(option_legs) != 3:
        return None
    by_strike = defaultdict(int)
    for leg in option_legs:
        by_strike[round(float(leg.get("strike") or 0), 4)] += int(leg.get("contracts", 0))
    if len(by_strike) != 3:
        return None
    low, mid, high = sorted(by_strike)
    wing = by_strike[low]
    body = by_strike[mid]
    wing2 = by_strike[high]
    if wing > 0 and wing2 > 0 and body < 0 and abs(wing + wing2) == abs(body):
        return "Call Butterfly" if opt_type == "Call" else "Put Butterfly"
    if wing < 0 and wing2 < 0 and body > 0 and abs(wing + wing2) == abs(body):
        return "Short Call Butterfly" if opt_type == "Call" else "Short Put Butterfly"
    return None


def _label_unpaired_options(legs):
    """Singular labels for legs that did not form spreads."""
    labels = []
    for opt_type in ("Call", "Put"):
        typed = [l for l in legs if l.get("optType") == opt_type]
        if not typed:
            continue
        long_ct = sum(l["contracts"] for l in typed if l["contracts"] > 0)
        short_ct = sum(-l["contracts"] for l in typed if l["contracts"] < 0)
        if long_ct and not short_ct:
            labels.append("Long Call" if opt_type == "Call" else "Long Put")
        elif short_ct and not long_ct:
            labels.append("Short Call" if opt_type == "Call" else "Short Put")
        else:
            for leg in typed:
                side = "Long" if leg["contracts"] > 0 else "Short"
                labels.append(f"{side} {opt_type}")
    return labels


def _decompose_option_strategies(options):
    """Pair vertical spreads; label any leftover legs."""
    call_opts = [o for o in options if o.get("optType") == "Call"]
    put_opts = [o for o in options if o.get("optType") == "Put"]

    if call_opts and not put_opts:
        butterfly = _detect_butterfly(call_opts, "Call")
        if butterfly:
            return butterfly
    if put_opts and not call_opts:
        butterfly = _detect_butterfly(put_opts, "Put")
        if butterfly:
            return butterfly

    labels = []
    call_labels, rem_calls = _pair_vertical_spreads(call_opts, "Call")
    put_labels, rem_puts = _pair_vertical_spreads(put_opts, "Put")
    labels.extend(call_labels)
    labels.extend(put_labels)
    labels.extend(_label_unpaired_options(rem_calls + rem_puts))
    return _join_strategy_labels(labels) if labels else None


def _expiry_key(exp):
    if exp is None or (isinstance(exp, float) and pd.isna(exp)):
        return "none"
    if isinstance(exp, pd.Timestamp):
        return exp.strftime("%Y-%m-%d")
    return str(exp)[:10]


def _pos_strat_key(p):
    """Position key aligned with frontend detectStrategies map keys."""
    tkr = p["ticker"]
    if p.get("posType") == "equity":
        sh = p.get("shares") or p.get("contracts") or 0
        return f"{tkr}|equity|{sh}"
    return f"{tkr}|{_expiry_key(p.get('expiry'))}|{p.get('strike', '')}|{p.get('optType', '')}"


def _build_sim_strategy_map(positions):
    """Mirror frontend detectStrategies — equity context for each expiry bucket."""
    ticker_groups = defaultdict(list)
    for p in positions:
        ticker_groups[p["ticker"]].append(p)

    strat_map = {}
    for _tkr, all_legs in ticker_groups.items():
        equity_legs = [l for l in all_legs if l.get("posType") == "equity"]
        option_legs = [l for l in all_legs if l.get("posType") != "equity"]
        by_expiry = defaultdict(list)
        for ol in option_legs:
            by_expiry[_expiry_key(ol.get("expiry"))].append(ol)

        if not by_expiry and equity_legs:
            label = _classify_legs_py(equity_legs)
            for leg in equity_legs:
                strat_map[_pos_strat_key(leg)] = label
        else:
            for _ek, exp_legs in by_expiry.items():
                combined = list(equity_legs) + exp_legs
                label = _classify_legs_py(combined)
                for leg in exp_legs:
                    strat_map[_pos_strat_key(leg)] = label
    return strat_map


def _classify_legs_py(legs):
    """Mirror frontend classifyLegs() — canonical singular strategy names."""
    legs = _aggregate_legs_for_classify(legs)
    equities = [l for l in legs if l.get("posType") == "equity"]
    options = [l for l in legs if l.get("posType") != "equity"]
    short_calls = sorted([l for l in options if l.get("optType") == "Call" and l.get("contracts", 0) < 0], key=lambda x: x.get("strike", 0))
    long_calls = sorted([l for l in options if l.get("optType") == "Call" and l.get("contracts", 0) > 0], key=lambda x: x.get("strike", 0))
    short_puts = sorted([l for l in options if l.get("optType") == "Put" and l.get("contracts", 0) < 0], key=lambda x: x.get("strike", 0))
    long_puts = sorted([l for l in options if l.get("optType") == "Put" and l.get("contracts", 0) > 0], key=lambda x: x.get("strike", 0))
    calls = sorted(short_calls + long_calls, key=lambda x: x.get("strike", 0))
    puts = sorted(short_puts + long_puts, key=lambda x: x.get("strike", 0))
    nc, np_, n_opts = len(calls), len(puts), len(calls) + len(puts)
    has_shares = bool(equities)
    share_qty = sum(l.get("shares") or l.get("contracts") or 0 for l in equities)

    if n_opts == 0 and has_shares:
        return "Long Shares" if share_qty > 0 else "Short Shares"

    if has_shares and n_opts > 0:
        covered_lots = abs(share_qty) // 100
        is_long = share_qty > 0
        total_sc = sum(abs(c.get("contracts", 0)) for c in short_calls)
        total_sp = sum(abs(p.get("contracts", 0)) for p in short_puts)
        covered_call_cts = min(total_sc, covered_lots) if is_long else 0
        covered_put_cts = min(total_sp, covered_lots) if not is_long else 0

        if is_long and short_calls and short_puts and covered_call_cts > 0:
            parts = []
            rem_calls = [{"strike": c.get("strike", 0), "rem": abs(c.get("contracts", 0))} for c in short_calls]
            rem_puts = [{"strike": p.get("strike", 0), "rem": abs(p.get("contracts", 0))} for p in short_puts]
            for rc in rem_calls:
                for rp in rem_puts:
                    if rp["rem"] > 0 and rc["rem"] > 0 and abs(rc["strike"] - rp["strike"]) < 0.01:
                        paired = min(rc["rem"], rp["rem"], covered_lots)
                        if paired > 0:
                            parts.append("Covered Straddle")
                            rc["rem"] -= paired
                            rp["rem"] -= paired
            for rc in rem_calls:
                for rp in rem_puts:
                    if rp["rem"] > 0 and rc["rem"] > 0:
                        paired = min(rc["rem"], rp["rem"], covered_lots)
                        if paired > 0:
                            parts.append("Covered Strangle")
                            rc["rem"] -= paired
                            rp["rem"] -= paired
            rem_c = sum(c["rem"] for c in rem_calls)
            rem_p = sum(p["rem"] for p in rem_puts)
            if rem_c > 0:
                parts.append("Covered Call")
            if rem_p > 0:
                parts.append("Short Put")
            if long_puts:
                parts.append("Protective Put")
            if long_calls:
                parts.append("Long Call")
            return " + ".join(parts) if parts else "Long Shares"

        if is_long and short_calls and not short_puts and not long_puts:
            if covered_call_cts >= total_sc:
                return "Covered Call"
            return "Overwritten Call"
        if is_long and not short_calls and short_puts:
            return "Long Shares + Short Put"
        if is_long and not short_calls and not short_puts and long_puts:
            return "Protective Put"
        if is_long and len(short_calls) == 1 and len(long_puts) == 1 and not short_puts:
            return "Collar w/ Shares"
        if not is_long and short_puts and not short_calls:
            if covered_put_cts >= total_sp:
                return "Covered Put"
            return "Overwritten Put"

        fp = []
        fp.append(f"+{abs(share_qty)}sh" if is_long else f"-{abs(share_qty)}sh")
        if total_sc:
            fp.append(f"{total_sc}SC")
        if total_sp:
            fp.append(f"{total_sp}SP")
        if long_calls:
            fp.append(f"{sum(c.get('contracts', 0) for c in long_calls)}LC")
        if long_puts:
            fp.append(f"{sum(p.get('contracts', 0) for p in long_puts)}LP")
        return "/".join(fp)

    if n_opts == 1:
        p = options[0]
        side = "Long" if p.get("contracts", 0) > 0 else "Short"
        return f"{side} {p.get('optType', 'Option')}"
    if nc == 0 and np_ >= 2:
        if all(l.get("contracts", 0) < 0 for l in puts):
            return "Short Put"
        if all(l.get("contracts", 0) > 0 for l in puts):
            return "Long Put"
    if np_ == 0 and nc >= 2:
        if all(l.get("contracts", 0) < 0 for l in calls):
            return "Short Call"
        if all(l.get("contracts", 0) > 0 for l in calls):
            return "Long Call"
    if n_opts == 2 and nc == 2:
        q, s = [c.get("contracts", 0) for c in calls], [c.get("strike", 0) for c in calls]
        if q[0] * q[1] < 0:
            low = s[0] if q[0] > 0 else s[1]
            high = s[1] if q[0] > 0 else s[0]
            return "Bull Call Spread" if low < high else "Bear Call Spread"
    if n_opts == 2 and np_ == 2:
        q, s = [p.get("contracts", 0) for p in puts], [p.get("strike", 0) for p in puts]
        if q[0] * q[1] < 0:
            low = s[0] if q[0] > 0 else s[1]
            high = s[1] if q[0] > 0 else s[0]
            return "Bear Put Spread" if low < high else "Bull Put Spread"
    if n_opts == 2 and nc == 1 and np_ == 1:
        cq, pq = calls[0].get("contracts", 0), puts[0].get("contracts", 0)
        same = abs(calls[0].get("strike", 0) - puts[0].get("strike", 0)) < 0.01
        if cq < 0 and pq < 0:
            return "Short Straddle" if same else "Short Strangle"
        if cq > 0 and pq > 0:
            return "Long Straddle" if same else "Long Strangle"
        if cq < 0 and pq > 0:
            return "Collar"
        if cq > 0 and pq < 0:
            return "Risk Reversal"
    if n_opts == 3:
        if nc == 3:
            bf = _detect_butterfly(calls, "Call")
            if bf:
                return bf
            return "Call Ladder"
        if np_ == 3:
            bf = _detect_butterfly(puts, "Put")
            if bf:
                return bf
            return "Put Ladder"
        if nc == 2 and np_ == 1:
            if calls and puts and all(c.get("contracts", 0) < 0 for c in calls) and puts[0].get("contracts", 0) < 0:
                return "Jade Lizard"
            decomposed = _decompose_option_strategies(options)
            if decomposed:
                return decomposed
            return "3-Leg 2C/1P"
        if nc == 1 and np_ == 2:
            if puts and calls and all(p.get("contracts", 0) < 0 for p in puts) and calls[0].get("contracts", 0) < 0:
                return "Twisted Sister"
            decomposed = _decompose_option_strategies(options)
            if decomposed:
                return decomposed
            return "3-Leg 1C/2P"
    if n_opts == 4 and nc == 2 and np_ == 2:
        if (any(c.get("contracts", 0) > 0 for c in calls) and any(c.get("contracts", 0) < 0 for c in calls)
                and any(p.get("contracts", 0) > 0 for p in puts) and any(p.get("contracts", 0) < 0 for p in puts)):
            put_hi = max(p.get("strike", 0) for p in puts)
            call_lo = min(c.get("strike", 0) for c in calls)
            return "Iron Butterfly" if abs(put_hi - call_lo) < 0.01 else "Iron Condor"
    decomposed = _decompose_option_strategies(options)
    if decomposed:
        return decomposed
    parts = []
    if nc:
        parts.append(f"{nc}C")
    if np_:
        parts.append(f"{np_}P")
    return f"{n_opts}-Leg {'/'.join(parts)}"


def _apply_strategy_groups(closed_trades):
    """Tag legs closed same day with portfolio-style strategy names."""
    groups = defaultdict(list)
    for i, t in enumerate(closed_trades):
        groups[(t["ticker"], t["closeDate"])].append(i)
    for indices in groups.values():
        if len(indices) < 2:
            continue
        legs = []
        for i in indices:
            t = closed_trades[i]
            if t.get("instrument") == "equity":
                sh = t["qty"] if not t["isShort"] else -t["qty"]
                legs.append({"posType": "equity", "shares": sh, "contracts": sh})
            else:
                cts = -t["qty"] if t["isShort"] else t["qty"]
                legs.append({
                    "posType": "option",
                    "contracts": cts,
                    "optType": t.get("optType"),
                    "strike": t.get("strike") or 0,
                })
        label = _classify_legs_py(legs)
        if label:
            for i in indices:
                closed_trades[i]["strategy"] = label


def _is_generic_strategy_label(label):
    if not label:
        return True
    if label.endswith(" Roll"):
        return True
    if label.startswith("Short ") or label.startswith("Long "):
        return True
    return "-Leg" in label


_CROSS_DAY_WINDOW = int(os.environ.get("JOURNAL_CROSS_DAY_WINDOW_DAYS", "30"))


def _apply_cross_day_strategy_groups(closed_trades, window_days=None):
    """Link spread legs closed on different dates within a configurable window.

    Groups legs with the same ticker and open_date (same opening trade) that
    were closed on different dates — the common pattern when legging out of a
    spread over multiple days.  Falls back to same-ticker proximity clustering
    when open_date is unavailable.
    """
    if window_days is None:
        window_days = _CROSS_DAY_WINDOW

    # Pass 1: group by (ticker, openDate) — most reliable signal
    by_open = defaultdict(list)
    for i, t in enumerate(closed_trades):
        if t.get("instrument") != "option" or t.get("isRoll"):
            continue
        if not _is_generic_strategy_label(t.get("strategy")):
            continue
        open_d = (t.get("openDate") or "")[:10]
        if open_d:
            by_open[(t["ticker"], open_d)].append(i)

    already_grouped: set = set()
    for indices in by_open.values():
        if len(indices) < 2:
            continue
        # Only group if legs span different close dates within the window
        dates = [pd.Timestamp(closed_trades[i]["closeDate"]) for i in indices]
        if len({str(d) for d in dates}) < 2:
            continue
        spread = (max(dates) - min(dates)).days
        if spread > window_days:
            continue
        _apply_strategy_label_to_indices(closed_trades, indices)
        for i in indices:
            already_grouped.add(i)

    # Pass 2: proximity clustering for legs without a shared openDate
    by_ticker = defaultdict(list)
    for i, t in enumerate(closed_trades):
        if i in already_grouped:
            continue
        if t.get("instrument") != "option" or t.get("isRoll"):
            continue
        if not _is_generic_strategy_label(t.get("strategy")):
            continue
        by_ticker[t["ticker"]].append(i)

    for indices in by_ticker.values():
        indices.sort(key=lambda i: (closed_trades[i]["closeDate"], closed_trades[i].get("symbol", "")))
        cluster = []
        for i in indices:
            if not cluster:
                cluster = [i]
                continue
            last_dt = pd.Timestamp(closed_trades[cluster[-1]]["closeDate"])
            this_dt = pd.Timestamp(closed_trades[i]["closeDate"])
            if (this_dt - last_dt).days <= window_days:
                cluster.append(i)
            else:
                if len(cluster) >= 2 and len({closed_trades[j]["closeDate"] for j in cluster}) >= 2:
                    _apply_strategy_label_to_indices(closed_trades, cluster)
                cluster = [i]
        if len(cluster) >= 2 and len({closed_trades[j]["closeDate"] for j in cluster}) >= 2:
            _apply_strategy_label_to_indices(closed_trades, cluster)


def _apply_strategy_label_to_indices(closed_trades, indices):
    legs = []
    for i in indices:
        t = closed_trades[i]
        cts = -t["qty"] if t["isShort"] else t["qty"]
        legs.append({
            "posType": "option",
            "contracts": cts,
            "optType": t.get("optType"),
            "strike": t.get("strike") or 0,
        })
    label = _classify_legs_py(legs)
    if not label or _is_generic_strategy_label(label):
        return
    for i in indices:
        closed_trades[i]["strategy"] = label
        closed_trades[i]["crossDayGroup"] = True


def _format_roll_rows(closed_trades):
    """Tag linked rolls for display. Keeps leg close P&L in `pnl` (realized); `rollNetPnl` is informational."""
    for t in closed_trades:
        if not t.get("isRoll") or not t.get("rollTo"):
            continue
        rt = t["rollTo"]
        opt = t.get("optType") or "Option"
        old_strike = t.get("strike")
        new_strike = rt.get("strike")
        old_exp = (t.get("expiry") or "")[:10]
        new_exp = (rt.get("expiry") or "")[:10]
        strike_part = ""
        if old_strike is not None and new_strike is not None:
            strike_part = f"${old_strike:g} → ${new_strike:g}"
        elif old_exp and new_exp:
            strike_part = f"{old_exp} → {new_exp}"
        t["legPnl"] = t.get("pnl")
        t["strategy"] = f"{opt} Roll"
        t["closeTypeLabel"] = "Roll"
        t["rollLabel"] = strike_part or "Roll"


def _link_assignments_to_equity(closed_trades):
    """Tie assigned/exercised options to nearby equity history rows."""
    options = [
        (i, t) for i, t in enumerate(closed_trades)
        if t.get("instrument") == "option" and t.get("closeType") in ("assigned", "exercised")
    ]
    equity_idxs = [i for i, t in enumerate(closed_trades) if t.get("instrument") == "equity"]
    used_equity = set()

    for opt_i, opt in options:
        opt_dt = pd.Timestamp(opt["closeDate"])
        share_qty = opt["qty"] * 100
        best_j = None
        best_score = None
        for j in equity_idxs:
            if j in used_equity:
                continue
            eq = closed_trades[j]
            if eq["ticker"] != opt["ticker"]:
                continue
            day_gap = abs((pd.Timestamp(eq["closeDate"]) - opt_dt).days)
            if day_gap > 3:
                continue
            qty_gap = abs(eq["qty"] - share_qty)
            ct = opt.get("closeType")
            opt_type = opt.get("optType")
            direction_ok = True
            if ct == "assigned" and opt_type == "Put" and opt.get("isShort"):
                direction_ok = not eq.get("isShort")
            elif ct == "assigned" and opt_type == "Call" and opt.get("isShort"):
                direction_ok = eq.get("closeType") == "sold" or not eq.get("isShort")
            elif ct == "exercised" and opt_type == "Call" and not opt.get("isShort"):
                direction_ok = not eq.get("isShort")
            elif ct == "exercised" and opt_type == "Put" and not opt.get("isShort"):
                direction_ok = eq.get("closeType") == "sold"
            if not direction_ok:
                continue
            score = day_gap * 1000 + qty_gap
            if best_score is None or score < best_score:
                best_score = score
                best_j = j
        if best_j is None:
            continue
        eq = closed_trades[best_j]
        used_equity.add(best_j)
        link = {
            "ticker": eq["ticker"],
            "qty": eq["qty"],
            "date": eq["closeDate"],
            "price": eq.get("avgClose") or eq.get("avgOpen"),
            "strategy": eq.get("strategy"),
        }
        opt["linkedEquity"] = link
        eq["linkedOption"] = {
            "optType": opt.get("optType"),
            "strike": opt.get("strike"),
            "expiry": opt.get("expiry"),
            "closeType": opt.get("closeType"),
            "closeDate": opt.get("closeDate"),
            "qty": opt.get("qty"),
        }
        eq["strategy"] = f"{eq.get('strategy', 'Stock')} ({opt.get('closeTypeLabel', 'Assignment')})"


def _rollup_assignment_pnl(closed_trades):
    """Combine linked assignment/exercise option + equity P&L; suppress equity from aggregates."""
    for t in closed_trades:
        if not t.get("linkedEquity"):
            continue
        eq_trade = None
        for et in closed_trades:
            if et.get("instrument") != "equity" or et.get("journalSuppress"):
                continue
            lo = et.get("linkedOption")
            if not lo:
                continue
            if (
                et["ticker"] == t["ticker"]
                and lo.get("closeDate") == t.get("closeDate")
                and lo.get("qty") == t.get("qty")
            ):
                eq_trade = et
                break
        if not eq_trade:
            continue
        opt_pnl = t.get("pnl", 0)
        eq_pnl = eq_trade.get("pnl", 0)
        combined = round(opt_pnl + eq_pnl, 2)
        t["optionLegPnl"] = round(opt_pnl, 2)
        t["equityLegPnl"] = round(eq_pnl, 2)
        t["combinedPnl"] = combined
        t["pnl"] = combined
        t["isWin"] = combined > 0
        t["assignmentRollup"] = True
        # Stash the equity-leg details so the tax-lot / Form 8949 layer can present this
        # assignment as a STOCK sale with premium-adjusted basis (strike − premium),
        # rather than mislabeling it as an option row.
        t["assignedEquity"] = {
            "qty": eq_trade.get("qty"),
            "openDate": eq_trade.get("openDate"),
            "closeDate": eq_trade.get("closeDate"),
            "acquirePrice": eq_trade.get("avgOpen"),
            "salePrice": eq_trade.get("avgClose"),
        }
        eq_trade["journalSuppress"] = True
        eq_trade["rollupInto"] = {
            "ticker": t["ticker"],
            "closeDate": t.get("closeDate"),
            "combinedPnl": combined,
        }


def _journal_aggregate_trades(closed_trades):
    """Trades included in journal totals, chart, and CSV export."""
    return [
        t for t in closed_trades
        if not t.get("journalSuppress") and not t.get("journalSuppressStats") and not t.get("isRollOpenRef")
    ]


def _assign_strategy_group_ids(closed_trades):
    """Tag spread/multi-leg closes so win rate counts one outcome per strategy close."""
    seq = [0]

    def new_group_id():
        seq[0] += 1
        return f"sg{seq[0]}"

    day_buckets = defaultdict(list)
    for i, t in enumerate(closed_trades):
        if t.get("journalSuppress"):
            continue
        day_buckets[(t["ticker"], t["closeDate"], t.get("strategy") or "")].append(i)

    for (_ticker, _date, strat), indices in day_buckets.items():
        if len(indices) < 2 or _is_generic_strategy_label(strat):
            continue
        gid = new_group_id()
        for i in indices:
            closed_trades[i]["strategyGroupId"] = gid

    by_cross = defaultdict(list)
    for i, t in enumerate(closed_trades):
        if t.get("journalSuppress") or not t.get("crossDayGroup"):
            continue
        if t.get("strategyGroupId"):
            continue
        by_cross[(t["ticker"], t.get("strategy") or "")].append(i)

    for indices in by_cross.values():
        indices.sort(key=lambda i: closed_trades[i]["closeDate"])
        cluster = []
        for i in indices:
            if not cluster:
                cluster = [i]
                continue
            last_dt = pd.Timestamp(closed_trades[cluster[-1]]["closeDate"])
            this_dt = pd.Timestamp(closed_trades[i]["closeDate"])
            if (this_dt - last_dt).days <= 7:
                cluster.append(i)
            else:
                if len(cluster) >= 2:
                    gid = new_group_id()
                    for j in cluster:
                        closed_trades[j]["strategyGroupId"] = gid
                cluster = [i]
        if len(cluster) >= 2:
            gid = new_group_id()
            for j in cluster:
                closed_trades[j]["strategyGroupId"] = gid

    for i, t in enumerate(closed_trades):
        if t.get("journalSuppress") or t.get("strategyGroupId"):
            continue
        sym = t.get("symbol") or str(i)
        t["strategyGroupId"] = f"solo|{t['ticker']}|{t['closeDate']}|{sym}"


def _compute_journal_stats(journal_trades):
    """Leg-level and strategy-group stats for journal summary."""
    if not journal_trades:
        return None

    leg_wins = [t for t in journal_trades if t.get("isWin")]
    leg_losses = [t for t in journal_trades if not t.get("isWin")]
    total_pnl = sum(t["pnl"] for t in journal_trades)

    groups = defaultdict(lambda: {"pnl": 0.0, "legs": 0})
    for t in journal_trades:
        gid = t.get("strategyGroupId") or f"solo|{t['ticker']}|{t['closeDate']}|{t.get('symbol', '')}"
        groups[gid]["pnl"] += t["pnl"]
        groups[gid]["legs"] += 1

    group_wins = group_losses = group_flat = 0
    for g in groups.values():
        if g["pnl"] > 0:
            group_wins += 1
        elif g["pnl"] < 0:
            group_losses += 1
        else:
            group_flat += 1

    group_total = len(groups)
    win_pnls = [g["pnl"] for g in groups.values() if g["pnl"] > 0]
    loss_pnls = [g["pnl"] for g in groups.values() if g["pnl"] < 0]
    gross_wins = sum(win_pnls)
    gross_losses = abs(sum(loss_pnls))

    flagged = [
        t for t in journal_trades
        if any(w.get("code") in ("large_pnl", "zero_close", "orphan_close", "close_mismatch") for w in t.get("warnings", []))
    ]

    return {
        "totalTrades": len(journal_trades),
        "groupTrades": group_total,
        "groupLegs": len(journal_trades),
        "optionTrades": len([t for t in journal_trades if t.get("instrument") != "equity"]),
        "equityTrades": len([t for t in journal_trades if t.get("instrument") == "equity"]),
        "wins": len(leg_wins),
        "losses": len(leg_losses),
        "winRate": round(group_wins / group_total * 100, 1) if group_total else 0,
        "legWinRate": round(len(leg_wins) / len(journal_trades) * 100, 1) if journal_trades else 0,
        "groupWins": group_wins,
        "groupLosses": group_losses,
        "groupBreakeven": group_flat,
        "totalPnl": round(total_pnl, 2),
        "avgWin": round(float(np.mean(win_pnls)), 2) if win_pnls else 0,
        "avgLoss": round(float(np.mean(loss_pnls)), 2) if loss_pnls else 0,
        "profitFactor": round(gross_wins / gross_losses, 2) if gross_losses > 0 else 999.99,
        "expectancy": round(total_pnl / group_total, 2) if group_total else 0,
        "legExpectancy": round(total_pnl / len(journal_trades), 2) if journal_trades else 0,
        "avgHoldDays": round(float(np.mean([t["holdDays"] for t in journal_trades])), 1),
        "rollTrades": len([t for t in journal_trades if t.get("isRoll")]),
        "assignmentRollups": len([t for t in journal_trades if t.get("assignmentRollup")]),
        "flaggedTrades": len(flagged),
    }


def _compute_journal_risk_metrics(daily_pnl_series):
    """
    Sharpe/Sortino on calendar-day realized P&L (zeros on days without closes).
    Informational only — not mark-to-market book Sharpe.
    """
    if not daily_pnl_series or len(daily_pnl_series) < 5:
        return None

    day_map = {d["date"]: float(d["dayPnl"]) for d in daily_pnl_series}
    dates = sorted(day_map)
    start = pd.Timestamp(dates[0])
    end = pd.Timestamp(dates[-1])
    calendar_pnls = []
    cur = start
    while cur <= end:
        calendar_pnls.append(day_map.get(cur.strftime("%Y-%m-%d"), 0.0))
        cur += pd.Timedelta(days=1)

    if len(calendar_pnls) < 5:
        return None

    arr = np.array(calendar_pnls, dtype=float)
    mean_daily = float(np.mean(arr))
    std_daily = float(np.std(arr, ddof=1))
    downside = arr[arr < 0]
    downside_std = float(np.std(downside, ddof=1)) if len(downside) > 1 else None

    annual = np.sqrt(252)
    sharpe = (mean_daily / std_daily * annual) if std_daily > 1e-9 else None
    sortino = (mean_daily / downside_std * annual) if downside_std and downside_std > 1e-9 else None

    return {
        "sharpe": round(float(sharpe), 2) if sharpe is not None else None,
        "sortino": round(float(sortino), 2) if sortino is not None else None,
        "avgDailyPnl": round(mean_daily, 2),
        "dailyPnlStd": round(std_daily, 2),
        "riskDays": len(calendar_pnls),
        "riskCloseDays": len(daily_pnl_series),
    }


def _compute_drawdown_metrics(daily_pnl_series):
    """Drawdown analytics on the realized cumulative-P&L (equity) curve.

    Operates on the same per-close-day series _build_daily_pnl produces (each
    row has date, dayPnl, cumPnl). The curve is realized P&L in dollars, so it
    can sit at or below zero and has no capital base — percentage drawdown is
    therefore reported only against positive running peaks, and we expose a
    unitless recovery factor (net profit / max drawdown) rather than a
    capital-based Calmar ratio.
    """
    if not daily_pnl_series or len(daily_pnl_series) < 2:
        return None

    chrono = sorted(daily_pnl_series, key=lambda d: d["date"])
    peak = float(chrono[0]["cumPnl"])
    peak_date = chrono[0]["date"]
    max_dd = 0.0
    max_dd_pct = None
    trough_cum = None
    trough_date = None
    dd_peak_date = None
    underwater = []

    longest_uw = 0          # longest underwater stretch in calendar days
    uw_start_date = None    # peak date that began the current underwater stretch

    for row in chrono:
        cum = float(row["cumPnl"])
        if cum >= peak:
            if uw_start_date is not None:
                span = (pd.Timestamp(row["date"]) - pd.Timestamp(uw_start_date)).days
                longest_uw = max(longest_uw, span)
                uw_start_date = None
            peak = cum
            peak_date = row["date"]
        else:
            if uw_start_date is None:
                uw_start_date = peak_date
        dd = cum - peak  # <= 0
        if dd < max_dd:
            max_dd = dd
            trough_date = row["date"]
            dd_peak_date = peak_date
            trough_cum = cum
            # % of peak is meaningful only while the curve stays in profit. Once the
            # trough drops below zero (all prior gains given back), the drawdown
            # exceeds 100% of the small prior peak and the percent misleads — omit it.
            max_dd_pct = (dd / peak * 100) if (peak > 1e-9 and cum >= 0) else None
        underwater.append({
            "date": row["date"],
            "drawdown": round(dd, 2),
            "cum": round(cum, 2),
            "peak": round(peak, 2),
        })

    if uw_start_date is not None:
        span = (pd.Timestamp(chrono[-1]["date"]) - pd.Timestamp(uw_start_date)).days
        longest_uw = max(longest_uw, span)

    # Recovery: first date after the trough where the curve regains the pre-DD peak.
    recovery_date = None
    days_to_recover = None
    still_underwater = False
    if trough_date is not None and dd_peak_date is not None:
        pre_peak = None
        for row in chrono:
            if row["date"] == dd_peak_date:
                pre_peak = float(row["cumPnl"])
                break
        if pre_peak is not None:
            past_trough = False
            for row in chrono:
                if row["date"] == trough_date:
                    past_trough = True
                    continue
                if past_trough and float(row["cumPnl"]) >= pre_peak:
                    recovery_date = row["date"]
                    break
            if recovery_date is not None:
                days_to_recover = (pd.Timestamp(recovery_date) - pd.Timestamp(dd_peak_date)).days
            else:
                still_underwater = max_dd < -1e-9

    final_cum = float(chrono[-1]["cumPnl"])
    cur_dd = round(final_cum - peak, 2)
    cur_dd_pct = round((final_cum - peak) / peak * 100, 1) if (peak > 1e-9 and final_cum >= 0) else None
    recovery_factor = round(final_cum / abs(max_dd), 2) if max_dd < -1e-9 else None

    return {
        "maxDrawdown": round(max_dd, 2),
        "maxDrawdownPct": round(max_dd_pct, 1) if max_dd_pct is not None else None,
        "maxDrawdownBelowZero": bool(trough_cum is not None and trough_cum < 0),
        "peakDate": dd_peak_date,
        "troughDate": trough_date,
        "recoveryDate": recovery_date,
        "daysToRecover": days_to_recover,
        "stillUnderwater": still_underwater,
        "currentDrawdown": cur_dd,
        "currentDrawdownPct": cur_dd_pct,
        "longestUnderwaterDays": longest_uw,
        "recoveryFactor": recovery_factor,
        "finalCum": round(final_cum, 2),
        "underwater": underwater,
    }


def _compute_trade_cohorts(journal_trades):
    """Slice realized performance into cohorts across several dimensions:
    underlying, strategy, hold-period bucket, DTE-at-entry bucket (options with
    a parseable expiry), calendar month closed, and weekday closed.

    Metrics per cohort are leg-level (a cohort can span strategy groups), so the
    winRate here is leg-level — distinct from the group-level winRate in the
    headline journal stats.
    """
    if not journal_trades:
        return None

    def _summ(trades):
        n = len(trades)
        if not n:
            return None
        wins = [t for t in trades if t.get("isWin")]
        pnls = [float(t.get("pnl", 0) or 0) for t in trades]
        gross_w = sum(p for p in pnls if p > 0)
        gross_l = abs(sum(p for p in pnls if p < 0))
        holds = [t["holdDays"] for t in trades if t.get("holdDays") is not None]
        total = sum(pnls)
        return {
            "trades": n,
            "wins": len(wins),
            "winRate": round(len(wins) / n * 100, 1),
            "totalPnl": round(total, 2),
            "avgPnl": round(total / n, 2),
            "profitFactor": round(gross_w / gross_l, 2) if gross_l > 1e-9 else (999.99 if gross_w > 0 else 0),
            "avgHoldDays": round(float(np.mean(holds)), 1) if holds else None,
        }

    def _grouped(key_fn):
        buckets = defaultdict(list)
        for t in journal_trades:
            k = key_fn(t)
            if k is None:
                continue
            buckets[k].append(t)
        rows = []
        for k, ts in buckets.items():
            s = _summ(ts)
            if s:
                s["key"] = k
                rows.append(s)
        return rows

    def _hold_bucket(t):
        h = t.get("holdDays")
        if h is None:
            return None
        if h <= 0:
            return "0 (same day)"
        if h <= 7:
            return "1-7d"
        if h <= 30:
            return "8-30d"
        if h <= 90:
            return "31-90d"
        return "90d+"
    hold_order = ["0 (same day)", "1-7d", "8-30d", "31-90d", "90d+"]

    def _dte_at_entry(t):
        if t.get("instrument") == "equity":
            return None
        exp = t.get("expiry")
        od = t.get("openDate")
        if not exp or not od:
            return None
        try:
            dte = (pd.Timestamp(exp) - pd.Timestamp(od)).days
        except Exception:
            return None
        if dte < 0:
            return None
        if dte <= 7:
            return "0-7 DTE"
        if dte <= 21:
            return "8-21 DTE"
        if dte <= 45:
            return "22-45 DTE"
        if dte <= 90:
            return "46-90 DTE"
        return "90+ DTE"
    dte_order = ["0-7 DTE", "8-21 DTE", "22-45 DTE", "46-90 DTE", "90+ DTE"]

    def _month(t):
        d = t.get("closeDate")
        if not d:
            return None
        try:
            return pd.Timestamp(d).strftime("%Y-%m")
        except Exception:
            return None

    dow_names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

    def _dow(t):
        d = t.get("closeDate")
        if not d:
            return None
        try:
            return dow_names[pd.Timestamp(d).weekday()]
        except Exception:
            return None

    def _reorder(rows, order):
        idx = {k: i for i, k in enumerate(order)}
        return sorted(rows, key=lambda r: idx.get(r["key"], 99))

    def _by_pnl(rows):
        return sorted(rows, key=lambda r: r["totalPnl"], reverse=True)

    def _by_key(rows):
        return sorted(rows, key=lambda r: r["key"])

    return {
        "byUnderlying": _by_pnl(_grouped(lambda t: t.get("ticker"))),
        "byStrategy": _by_pnl(_grouped(
            lambda t: _normalize_strategy_label(t.get("strategy")) if t.get("strategy") else "Unknown")),
        "byHoldBucket": _reorder(_grouped(_hold_bucket), hold_order),
        "byDteAtEntry": _reorder(_grouped(_dte_at_entry), dte_order),
        "byMonth": _by_key(_grouped(_month)),
        "byWeekday": _reorder(_grouped(_dow), dow_names),
    }


def _option_mark_key(p):
    exp = p.get("expiry") or ""
    if isinstance(exp, str) and "T" in exp:
        exp = exp.split("T")[0]
    opt = (p.get("optType") or "Put")
    opt_ch = "P" if str(opt).lower().startswith("p") else "C"
    strike = float(p.get("strike") or 0)
    return f"{p.get('ticker', '').upper()}|{exp}|{opt_ch}|{strike}"


def compute_portfolio_mtm(positions, market_data, option_marks=None):
    """Mark-to-market unrealized P&L and gross book value for open positions."""
    unrealized = 0.0
    book_value = 0.0
    marks = option_marks or {}
    for p in positions:
        tkr = p.get("ticker", "").upper()
        md = market_data.get(tkr) or market_data.get(p.get("ticker")) or {}
        if p.get("posType") == "equity":
            shares = float(p.get("shares") or 0)
            px = float(md.get("price") or 0)
            cost = float(p.get("adjCost") or p.get("avgCost") or 0)
            unrealized += shares * (px - cost)
            book_value += abs(shares * px)
            continue
        contracts = float(p.get("contracts") or 0)
        if not contracts:
            continue
        cost = float(p.get("avgCost") or 0)
        mark = marks.get(_option_mark_key(p))
        mid = mark.get("mid") if isinstance(mark, dict) else None
        if mid is None:
            continue
        unrealized += contracts * 100 * (float(mid) - cost)
        book_value += abs(contracts * 100 * float(mid))
    return {
        "unrealizedPnl": round(unrealized, 2),
        "bookValue": round(book_value, 2),
    }


def _compute_mtm_risk_metrics(book_points):
    """Sharpe/Sortino on fetch-to-fetch changes in book unrealized P&L."""
    if not book_points or len(book_points) < 3:
        return None

    def _naive_ts(v):
        # Snapshots may be stored tz-aware (frontend toISOString → "...Z") or
        # tz-naive (backend datetime.now().isoformat()); normalize so mixed rows
        # don't raise "Cannot subtract tz-naive and tz-aware".
        t = pd.Timestamp(v)
        return t.tz_convert("UTC").tz_localize(None) if t.tzinfo is not None else t

    chrono = sorted(book_points, key=lambda x: _naive_ts(x["timestamp"]))
    deltas = []
    day_gaps = []
    for i in range(1, len(chrono)):
        t0 = _naive_ts(chrono[i - 1]["timestamp"])
        t1 = _naive_ts(chrono[i]["timestamp"])
        gap = max((t1 - t0).total_seconds() / 86400.0, 1 / 24)
        delta = float(chrono[i]["unrealizedPnl"]) - float(chrono[i - 1]["unrealizedPnl"])
        deltas.append(delta)
        day_gaps.append(gap)
    if len(deltas) < 2:
        return None
    arr = np.array(deltas, dtype=float)
    mean_delta = float(np.mean(arr))
    std_delta = float(np.std(arr, ddof=1))
    downside = arr[arr < 0]
    downside_std = float(np.std(downside, ddof=1)) if len(downside) > 1 else None
    avg_gap = float(np.mean(day_gaps)) if day_gaps else 1.0
    periods_per_year = 252 / max(avg_gap, 1.0)
    annual = np.sqrt(periods_per_year)
    sharpe = (mean_delta / std_delta * annual) if std_delta > 1e-9 else None
    sortino = (mean_delta / downside_std * annual) if downside_std and downside_std > 1e-9 else None
    return {
        "mtmSharpe": round(float(sharpe), 2) if sharpe is not None else None,
        "mtmSortino": round(float(sortino), 2) if sortino is not None else None,
        "avgFetchDeltaPnl": round(mean_delta, 2),
        "fetchDeltaStd": round(std_delta, 2),
        "fetchCount": len(chrono),
        "avgFetchGapDays": round(avg_gap, 2),
    }


def _classify_option_event(action):
    """Classify history row as open/close with direction and close-event type."""
    a = action.upper()
    close_type = None
    if "EXPIRED" in a:
        close_type = "expired"
    elif "ASSIGNED" in a:
        close_type = "assigned"
    elif "EXERCISED" in a:
        close_type = "exercised"

    is_open = (
        "OPENING TRANSACTION" in a or "TO OPEN" in a
        or "BUY TO OPEN" in a or "SELL TO OPEN" in a
    )
    is_close = close_type or (
        "CLOSING TRANSACTION" in a or "TO CLOSE" in a
        or "BUY TO CLOSE" in a or "SELL TO CLOSE" in a
    )
    if not is_open and not is_close:
        return None

    if is_open:
        if "BOUGHT" in a or "BUY TO OPEN" in a:
            is_short = False
        elif "SOLD" in a or "SELL TO OPEN" in a:
            is_short = True
        else:
            is_short = "SELL" in a and "BUY" not in a
        return {"event": "open", "is_short": is_short, "close_type": None}

    if not close_type:
        if "BOUGHT" in a or "BUY TO CLOSE" in a:
            close_type = "btc"
        elif "SOLD" in a or "SELL TO CLOSE" in a:
            close_type = "stc"
        else:
            close_type = "unknown"
    return {"event": "close", "is_short": None, "close_type": close_type}


def _close_type_label(close_type):
    return {
        "btc": "Buy to Close",
        "stc": "Sell to Close",
        "expired": "Expired",
        "assigned": "Assigned",
        "exercised": "Exercised",
        "sold": "Sold",
        "cover": "Cover",
        "unknown": "Close",
    }.get(close_type or "", "Close")


def _option_occ_meta(sym):
    occ_match = re.match(r"-?([a-z]+)(\d{6})([cp])([\d.]+)", sym)
    occ = _parse_occ_symbol(sym)
    ticker = occ["ticker"] if occ else (occ_match.group(1).upper() if occ_match else sym.upper())
    opt_type_str = occ["optType"] if occ else ("Put" if occ_match and occ_match.group(3) == "p" else "Call")
    strike_val = occ["strike"] if occ else None
    expiry_val = occ["expiry"] if occ else None
    return {
        "symbol": sym,
        "ticker": ticker,
        "optType": opt_type_str,
        "strike": strike_val,
        "expiry": expiry_val,
    }


def _fifo_closed_option_trades(sym, txns):
    """FIFO lot matching per OCC symbol — one closed-trade row per matched lot."""
    meta = _option_occ_meta(sym)
    # CUSIP-coded options don't parse to a ticker; recover the underlying from the
    # broker description (e.g. "PUT (OPEN) OPENDOOR …") so they group under "OPEN"
    # instead of the raw CUSIP.
    if not _parse_occ_symbol(sym):
        und = next((t.get("underlying") for t in txns if t.get("underlying")), None)
        if und:
            meta = {**meta, "ticker": und}
    events = []
    for txn in txns:
        kind = _classify_option_event(txn["action"])
        if not kind:
            continue
        events.append({**txn, **kind})
    # Sort by date, then OPENS BEFORE CLOSES on the same date. Broker history has no
    # intraday timestamps and is often newest-first, so a same-day close can otherwise
    # be processed before the open it belongs to — orphaning intraday round-trips and
    # zeroing their P&L. Opens-first guarantees a lot exists before a close consumes it.
    events.sort(key=lambda e: (e["date"], 0 if e["event"] == "open" else 1))

    lots = []
    closed = []
    open_events = []
    orphan_close_qty = 0

    for ev in events:
        if ev["event"] == "open":
            lots.append({"date": ev["date"], "qty": ev["qty"], "price": ev["price"], "is_short": ev["is_short"]})
            open_events.append({
                "date": ev["date"],
                "symbol": sym,
                "ticker": meta["ticker"],
                "optType": meta["optType"],
                "strike": meta["strike"],
                "expiry": meta["expiry"],
                "qty": ev["qty"],
                "price": ev["price"],
                "is_short": ev["is_short"],
            })
            continue

        remaining = ev["qty"]
        close_type = ev["close_type"]
        close_price = ev["price"]
        while remaining > 0:
            if not lots:
                orphan_close_qty += remaining
                side = "Short" if close_type == "btc" else "Long"
                pnl_val = 0
                if close_type == "expired":
                    pnl_val = 0
                closed.append({
                    **meta,
                    "instrument": "option",
                    "isShort": side == "Short",
                    "strategy": f"{side} {meta['optType']}",
                    "openDate": ev["date"],
                    "closeDate": ev["date"],
                    "holdDays": 0,
                    "avgOpen": 0,
                    "avgClose": close_price,
                    "qty": remaining,
                    "pnl": round(pnl_val, 2),
                    "isWin": pnl_val > 0,
                    "closeType": close_type,
                    "closeTypeLabel": _close_type_label(close_type),
                    "orphanClose": True,
                })
                remaining = 0
                break

            lot = lots[0]
            matched = min(remaining, lot["qty"])
            is_short = lot["is_short"]
            if is_short:
                pnl_val = (lot["price"] - close_price) * matched * 100
            else:
                pnl_val = (close_price - lot["price"]) * matched * 100
            hold_days = (pd.Timestamp(ev["date"]) - pd.Timestamp(lot["date"])).days
            side = "Short" if is_short else "Long"
            closed.append({
                **meta,
                "instrument": "option",
                "isShort": is_short,
                "strategy": f"{side} {meta['optType']}",
                "openDate": lot["date"],
                "closeDate": ev["date"],
                "holdDays": hold_days,
                "avgOpen": round(lot["price"], 4),
                "avgClose": round(close_price, 4),
                "qty": matched,
                "pnl": round(pnl_val, 2),
                "isWin": pnl_val > 0,
                "closeType": close_type,
                "closeTypeLabel": _close_type_label(close_type),
                "orphanClose": False,
            })
            lot["qty"] -= matched
            remaining -= matched
            if lot["qty"] == 0:
                lots.pop(0)

    ledger = {
        "open_qty": sum(e["qty"] for e in events if e["event"] == "open"),
        "close_qty": sum(e["qty"] for e in events if e["event"] == "close"),
        "unmatched_opens": sum(l["qty"] for l in lots),
        "orphan_close_qty": orphan_close_qty,
    }
    return closed, open_events, ledger


def _link_rolls(closed_trades, open_events):
    """Tag closes paired with a near-date open on same ticker as rolls."""
    used = set()
    for trade in closed_trades:
        if trade.get("instrument") == "equity":
            continue
        close_dt = pd.Timestamp(trade["closeDate"])
        for idx, op in enumerate(open_events):
            if idx in used:
                continue
            if op["ticker"] != trade["ticker"]:
                continue
            if op["symbol"] == trade["symbol"]:
                continue
            if op["is_short"] != trade["isShort"]:
                continue
            if op["optType"] != trade["optType"]:
                continue
            if abs((pd.Timestamp(op["date"]) - close_dt).days) > 2:
                continue
            qty = min(trade["qty"], op["qty"])
            if qty <= 0:
                continue
            open_flow = op["price"] * qty * 100
            if op["is_short"]:
                roll_net = trade["pnl"] + open_flow
            else:
                roll_net = trade["pnl"] - open_flow
            trade["isRoll"] = True
            trade["rollNetPnl"] = round(roll_net, 2)
            trade["rollTo"] = {
                "symbol": op["symbol"],
                "strike": op.get("strike"),
                "expiry": op.get("expiry"),
                "openPrice": op["price"],
                "qty": qty,
                "openDate": op["date"],
            }
            trade["rollOpenEventIndex"] = idx
            used.add(idx)
            break
    return used


def _append_roll_open_references(closed_trades, open_events, used_open_idxs):
    """Add non-P&L reference rows for roll opening legs."""
    for idx in sorted(used_open_idxs):
        op = open_events[idx]
        meta = _option_occ_meta(op["symbol"])
        ref = {
            "symbol": op["symbol"],
            "ticker": op["ticker"],
            "instrument": "option",
            "optType": op.get("optType") or meta.get("optType"),
            "strike": op.get("strike") or meta.get("strike"),
            "expiry": op.get("expiry") or meta.get("expiry"),
            "isShort": op["is_short"],
            "strategy": f"{op.get('optType') or meta.get('optType') or 'Option'} Roll Open",
            "openDate": op["date"],
            "closeDate": op["date"],
            "holdDays": 0,
            "avgOpen": round(op["price"], 4),
            "avgClose": 0,
            "qty": op["qty"],
            "pnl": 0,
            "isWin": False,
            "closeType": "open",
            "closeTypeLabel": "Roll Open",
            "isRollOpenRef": True,
            "journalSuppressStats": True,
            "warnings": [],
        }
        for t in closed_trades:
            if t.get("isRoll") and t.get("rollOpenEventIndex") == idx:
                ref["linkedRollClose"] = {
                    "ticker": t["ticker"],
                    "closeDate": t.get("closeDate"),
                    "symbol": t.get("symbol"),
                    "rollLabel": t.get("rollLabel"),
                }
                if t.get("strategyGroupId"):
                    ref["strategyGroupId"] = t["strategyGroupId"]
                break
        closed_trades.append(ref)


def _apply_trade_sanity_flags(trade, sym_ledger):
    """Attach per-trade warning objects."""
    warnings = []
    mult = 1 if trade.get("instrument") == "equity" else 100
    ref_px = max(trade.get("avgOpen") or 0, trade.get("avgClose") or 0, 0.05)
    threshold = max(15000, trade.get("qty", 1) * mult * ref_px * 3)
    if abs(trade.get("pnl", 0)) > threshold:
        warnings.append({"code": "large_pnl", "msg": "Unusually large P&L for this lot size"})
    ct = trade.get("closeType", "")
    if trade.get("instrument") == "option" and ct not in ("expired", "assigned", "exercised"):
        if (trade.get("avgClose") or 0) == 0 and abs(trade.get("pnl", 0)) > 0.01:
            warnings.append({"code": "zero_close", "msg": "Zero close price on a priced close event"})
    if trade.get("orphanClose"):
        warnings.append({"code": "orphan_close", "msg": "Close without a matching open in history CSV"})
    trade["warnings"] = warnings


def _build_symbol_data_warnings(sym_ledger):
    """Only flag true parse problems — not still-open positions (expected in partial history)."""
    out = []
    for sym, info in sorted(sym_ledger.items()):
        if info.get("orphan_close_qty", 0) > 0:
            ticker = _option_occ_meta(sym)["ticker"]
            out.append(f"{ticker}: {info['orphan_close_qty']} contracts closed without matching opens in CSV")
    return out


def _count_open_lots_remaining(sym_ledger):
    return sum(info.get("unmatched_opens", 0) for info in sym_ledger.values())


def _build_daily_pnl(closed_trades):
    """Per close-date aggregates for cumulative chart drill-down."""
    by_date = defaultdict(lambda: {"dayPnl": 0.0, "trades": [], "rollPnl": 0.0, "rollCount": 0, "rollNetPnl": 0.0})
    for t in _journal_aggregate_trades(closed_trades):
        d = t["closeDate"]
        pnl = t.get("pnl", 0)
        by_date[d]["dayPnl"] += pnl
        if t.get("isRoll"):
            by_date[d]["rollPnl"] += pnl
            by_date[d]["rollCount"] += 1
            if t.get("rollNetPnl") is not None:
                by_date[d]["rollNetPnl"] = by_date[d].get("rollNetPnl", 0.0) + t["rollNetPnl"]
        entry = {
            "ticker": t["ticker"],
            "strategy": t.get("strategy"),
            "pnl": pnl,
            "qty": t["qty"],
            "closeTypeLabel": t.get("closeTypeLabel"),
            "isRoll": bool(t.get("isRoll")),
        }
        if t.get("isRoll"):
            entry["rollLabel"] = t.get("rollLabel")
            entry["legPnl"] = t.get("legPnl")
            entry["rollNetPnl"] = t.get("rollNetPnl", pnl)
        if t.get("assignmentRollup"):
            entry["assignmentRollup"] = True
            entry["optionLegPnl"] = t.get("optionLegPnl")
            entry["equityLegPnl"] = t.get("equityLegPnl")
            entry["combinedPnl"] = t.get("combinedPnl", pnl)
        by_date[d]["trades"].append(entry)
    cum = 0.0
    series = []
    for d in sorted(by_date):
        cum += by_date[d]["dayPnl"]
        series.append({
            "date": d,
            "dayPnl": round(by_date[d]["dayPnl"], 2),
            "cumPnl": round(cum, 2),
            "tradeCount": len(by_date[d]["trades"]),
            "rollCount": by_date[d]["rollCount"],
            "rollPnl": round(by_date[d]["rollPnl"], 2),
            "rollNetPnl": round(by_date[d].get("rollNetPnl", 0.0), 2),
            "trades": by_date[d]["trades"],
        })
    return series


def _build_equity_closed_trades(ticker, txns):
    """FIFO round trips for share buys/sells (not * 100 multiplier)."""
    results = []
    long_lots = []
    short_lots = []
    # CUSIP-keyed securities carry a friendly display name; matching still uses the
    # stable CUSIP key, but the emitted rows show the readable label.
    display = next((t["name"] for t in txns if t.get("name")), None) or ticker

    def emit_close(is_short, lot, close_date, close_price, qty, close_type):
        hold_days = (pd.Timestamp(close_date) - pd.Timestamp(lot["date"])).days
        if is_short:
            pnl = (lot["price"] - close_price) * qty
        else:
            pnl = (close_price - lot["price"]) * qty
        results.append({
            "symbol": display.lower(),
            "ticker": display,
            "instrument": "equity",
            "optType": "Stock",
            "strike": None,
            "expiry": None,
            "isShort": is_short,
            "strategy": "Short Shares" if is_short else "Long Shares",
            "openDate": lot["date"],
            "closeDate": close_date,
            "holdDays": hold_days,
            "avgOpen": round(lot["price"], 4),
            "avgClose": round(close_price, 4),
            "qty": qty,
            "pnl": round(pnl, 2),
            "isWin": pnl > 0,
            "closeType": close_type,
            "closeTypeLabel": _close_type_label(close_type),
            "orphanClose": False,
        })

    # Date order, OPENS BEFORE CLOSES on the same date (see _fifo_closed_option_trades):
    # without this, a same-day cover/sell can be processed before the short/buy it pairs
    # with, dropping the match and turning round-tripped positions into phantom P&L.
    for txn in sorted(txns, key=lambda x: (x["date"], 0 if x["side"].endswith("_open") else 1)):
        side = txn["side"]
        if side == "long_open":
            long_lots.append({"date": txn["date"], "qty": txn["qty"], "price": txn["price"]})
        elif side == "long_close":
            rem = txn["qty"]
            while rem > 0 and long_lots:
                lot = long_lots[0]
                m = min(rem, lot["qty"])
                emit_close(False, lot, txn["date"], txn["price"], m, "sold")
                lot["qty"] -= m
                rem -= m
                if lot["qty"] == 0:
                    long_lots.pop(0)
        elif side == "short_open":
            short_lots.append({"date": txn["date"], "qty": txn["qty"], "price": txn["price"]})
        elif side == "short_close":
            rem = txn["qty"]
            while rem > 0 and short_lots:
                lot = short_lots[0]
                m = min(rem, lot["qty"])
                emit_close(True, lot, txn["date"], txn["price"], m, "cover")
                lot["qty"] -= m
                rem -= m
                if lot["qty"] == 0:
                    short_lots.pop(0)

    # leftover long_lots = currently-held open long shares (with acquisition dates)
    return results, long_lots


@app.route("/api/trade-history", methods=["POST"])
def trade_history():
    try:
        body = request.json or {}
        hist_texts = body.get("historyTexts")
        if not hist_texts:
            single = body.get("historyText", "")
            hist_texts = [single] if single else []
        trades, equity_txns, hist_fmt, parse_warnings = _merge_history_texts(hist_texts)

        closed_trades = []
        all_open_events = []
        sym_ledger = {}
        for sym, txns in trades.items():
            matched, open_events, ledger = _fifo_closed_option_trades(sym, txns)
            sym_ledger[sym] = ledger
            all_open_events.extend(open_events)
            closed_trades.extend(matched)

        open_share_lots = {}
        for ticker, txns in equity_txns.items():
            eq_closed, eq_open_lots = _build_equity_closed_trades(ticker, txns)
            closed_trades.extend(eq_closed)
            long_open = [l for l in (eq_open_lots or []) if l.get("qty", 0) > 0]
            if long_open:
                earliest = min(pd.Timestamp(l["date"]) for l in long_open)
                open_share_lots[ticker] = {
                    "openDate": str(earliest.date()),
                    "qty": sum(l["qty"] for l in long_open),
                }

        used_roll_opens = _link_rolls(closed_trades, all_open_events)
        _format_roll_rows(closed_trades)
        for t in closed_trades:
            if t.get("instrument") == "equity":
                t["warnings"] = []
            else:
                _apply_trade_sanity_flags(t, sym_ledger)
            if not t.get("closeTypeLabel"):
                t["closeTypeLabel"] = _close_type_label(t.get("closeType"))

        _apply_strategy_groups(closed_trades)
        _apply_cross_day_strategy_groups(closed_trades)
        _link_assignments_to_equity(closed_trades)
        _rollup_assignment_pnl(closed_trades)
        for t in closed_trades:
            t["strategy"] = _normalize_strategy_label(t.get("strategy"))

        _assign_strategy_group_ids(closed_trades)
        _append_roll_open_references(closed_trades, all_open_events, used_roll_opens)

        data_warnings = _build_symbol_data_warnings(sym_ledger)
        open_lots_remaining = _count_open_lots_remaining(sym_ledger)
        for w in parse_warnings[:20]:
            data_warnings.append({"code": "ibkr_parse", "msg": w})
        journal_trades = _journal_aggregate_trades(closed_trades)

        daily_series = _build_daily_pnl(closed_trades)
        stats = _compute_journal_stats(journal_trades)
        if stats:
            stats["dataWarnings"] = data_warnings
            stats["openLotsRemaining"] = open_lots_remaining
            stats["historyFormat"] = hist_fmt
            risk = _compute_journal_risk_metrics(daily_series)
            if risk:
                stats["risk"] = risk
            drawdown = _compute_drawdown_metrics(daily_series)
            if drawdown:
                stats["drawdown"] = drawdown
            cohorts = _compute_trade_cohorts(journal_trades)
            if cohorts:
                stats["cohorts"] = cohorts
        elif data_warnings or open_lots_remaining:
            stats = {"dataWarnings": data_warnings, "openLotsRemaining": open_lots_remaining}

        closed_trades.sort(key=lambda t: t["closeDate"], reverse=True)

        try:
            conn = get_db()
            conn.execute("DELETE FROM closed_trades")
            # Persist only the journal-aggregate trades (the same set the journal totals
            # use): this excludes roll-open reference rows (pnl 0) and the equity legs of
            # assignments, whose P&L is already folded into the linked option row's combined
            # pnl. Writing every row would double-count assigned-share P&L in the tax-lot.
            for t in journal_trades:
                ae = t.get("assignedEquity")
                if ae:
                    # Present an assigned option as a STOCK sale with premium-adjusted
                    # basis: proceeds = share sale, cost basis = strike − premium per share
                    # (derived from the combined pnl downstream). One 8949 line per the
                    # economic event, labeled as the underlying rather than an option.
                    shares = ae.get("qty") or (t["qty"] * 100)
                    sale_price = ae.get("salePrice") or 0
                    prem_per_share = (t.get("optionLegPnl") or 0) / shares if shares else 0
                    acquire = ae.get("acquirePrice")
                    if acquire is None:
                        acquire = t.get("strike") or 0
                    adj_basis = round(acquire - prem_per_share, 4)
                    row = (t["ticker"].lower(), t["ticker"], "Stock", 0,
                           ae.get("openDate") or t["openDate"], ae.get("closeDate") or t["closeDate"],
                           adj_basis, sale_price, shares, t["pnl"], t.get("strategy"), "sold")
                else:
                    row = (t["symbol"], t["ticker"], t["optType"], t.get("strike"),
                           t["openDate"], t["closeDate"], t["avgOpen"], t["avgClose"],
                           t["qty"], t["pnl"], t["strategy"], t["closeType"])
                conn.execute(
                    """INSERT INTO closed_trades (occ_symbol, ticker, opt_type, strike, open_date, close_date,
                       open_price, close_price, quantity, pnl, strategy, close_type)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                    row,
                )
            conn.commit()
            conn.close()
        except Exception:
            pass

        return jsonify({
            "trades": closed_trades,
            "stats": stats,
            "dailyPnl": daily_series,
            "openShareLots": open_share_lots,
            "historyFormat": hist_fmt,
            "parseWarnings": parse_warnings[:20],
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ─── API: P&L Attribution (#13) ──────────────────────────────────────────

@app.route("/api/pnl-attribution", methods=["POST"])
def pnl_attribution():
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
            delta_iv = (curr_iv - prev_iv) / 100

            pnl_delta = prev_g.get("delta", 0) * delta_s
            pnl_gamma = 0.5 * prev_g.get("gamma", 0) * delta_s**2
            pnl_theta = prev_g.get("theta", 0)
            pnl_vega = prev_g.get("vega", 0) * delta_iv * 100

            attribution[tkr] = {
                "pricePnl": round(pnl_delta, 2),
                "gammaPnl": round(pnl_gamma, 2),
                "thetaPnl": round(pnl_theta, 2),
                "vegaPnl": round(pnl_vega, 2),
                "total": round(pnl_delta + pnl_gamma + pnl_theta + pnl_vega, 2),
                "deltaS": round(delta_s, 4),
                "deltaIV": round(delta_iv * 100, 1),
            }

        portfolio = {"pricePnl": 0, "gammaPnl": 0, "thetaPnl": 0, "vegaPnl": 0, "total": 0}
        for a in attribution.values():
            for k in portfolio:
                portfolio[k] += a[k]
        for k in portfolio:
            portfolio[k] = round(portfolio[k], 2)

        return jsonify({"byTicker": attribution, "portfolio": portfolio})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/snapshots/attribution", methods=["POST"])
def save_attribution_snapshot():
    try:
        body = request.json
        ts = body.get("timestamp") or datetime.now().isoformat()
        data = body.get("attribution", {})
        total = (data.get("portfolio") or {}).get("total", 0)
        conn = get_db()
        conn.execute(
            "INSERT INTO attribution_snapshots (timestamp, portfolio_total, data_json) VALUES (?,?,?)",
            (ts, total, json.dumps(data)),
        )
        conn.commit()
        conn.close()
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/snapshots/attribution", methods=["GET"])
def get_attribution_snapshots():
    limit = min(int(request.args.get("limit", 30)), 100)
    conn = get_db()
    rows = conn.execute(
        "SELECT id, timestamp, portfolio_total, data_json FROM attribution_snapshots ORDER BY id DESC LIMIT ?",
        (limit,),
    ).fetchall()
    conn.close()
    out = []
    for r in rows:
        try:
            data = json.loads(r["data_json"])
        except Exception:
            data = {}
        out.append({
            "id": r["id"],
            "timestamp": r["timestamp"],
            "portfolioTotal": r["portfolio_total"],
            "attribution": data,
        })
    return jsonify({"snapshots": out})


@app.route("/api/snapshots/attribution-timeline", methods=["GET"])
def attribution_timeline():
    """Cumulative greek-based P&L attribution across stored attribution
    snapshots (chronological). Each attribution snapshot is one fetch-to-fetch
    step's decomposition (price/gamma/theta/vega); we sum them into cumulative
    contribution curves. Where book snapshots are alignable by timestamp, we
    also attach a residual = actual cumulative Δ book unrealized P&L − attributed
    cumulative — the unexplained part (position changes + higher-order terms)."""
    limit = min(int(request.args.get("limit", 60)), 200)
    conn = get_db()
    rows = conn.execute(
        "SELECT timestamp, portfolio_total, data_json FROM attribution_snapshots ORDER BY id DESC LIMIT ?",
        (limit,),
    ).fetchall()
    book_rows = conn.execute(
        "SELECT timestamp, unrealized_pnl FROM portfolio_book_snapshots ORDER BY id ASC",
    ).fetchall()
    conn.close()

    rows = list(reversed(rows))  # chronological
    points = []
    cum = {"price": 0.0, "gamma": 0.0, "theta": 0.0, "vega": 0.0, "total": 0.0}
    for r in rows:
        try:
            data = json.loads(r["data_json"])
        except Exception:
            data = {}
        port = data.get("portfolio") or {}
        price = float(port.get("pricePnl", 0) or 0)
        gamma = float(port.get("gammaPnl", 0) or 0)
        theta = float(port.get("thetaPnl", 0) or 0)
        vega = float(port.get("vegaPnl", 0) or 0)
        step_total = float(port.get("total", price + gamma + theta + vega) or 0)
        cum["price"] += price
        cum["gamma"] += gamma
        cum["theta"] += theta
        cum["vega"] += vega
        cum["total"] += step_total
        points.append({
            "timestamp": r["timestamp"],
            "price": round(price, 2),
            "gamma": round(gamma, 2),
            "theta": round(theta, 2),
            "vega": round(vega, 2),
            "stepTotal": round(step_total, 2),
            "cumPrice": round(cum["price"], 2),
            "cumGamma": round(cum["gamma"], 2),
            "cumTheta": round(cum["theta"], 2),
            "cumVega": round(cum["vega"], 2),
            "cumTotal": round(cum["total"], 2),
        })

    # Residual vs actual book unrealized P&L (best-effort timestamp alignment).
    residual_available = False

    def _naive_ts(v):
        try:
            t = pd.Timestamp(v)
            return t.tz_convert("UTC").tz_localize(None) if t.tzinfo is not None else t
        except Exception:
            return None

    if len(book_rows) >= 2 and len(points) >= 2:
        book = [(_naive_ts(b["timestamp"]), float(b["unrealized_pnl"])) for b in book_rows]
        book = [b for b in book if b[0] is not None]
        if len(book) >= 2:
            tol = 36 * 3600  # 36h alignment tolerance

            def _nearest(ts):
                best, best_gap = None, None
                for bt, bv in book:
                    gap = abs((bt - ts).total_seconds())
                    if best_gap is None or gap < best_gap:
                        best_gap, best = gap, bv
                return best, best_gap

            base_ts = _naive_ts(points[0]["timestamp"])
            base_book, base_gap = _nearest(base_ts) if base_ts is not None else (None, None)
            if base_book is not None and base_gap is not None and base_gap <= tol:
                matched = 0
                for p in points:
                    pts = _naive_ts(p["timestamp"])
                    if pts is None:
                        continue
                    bv, gap = _nearest(pts)
                    if bv is not None and gap is not None and gap <= tol:
                        actual_cum = bv - base_book
                        p["cumBookChange"] = round(actual_cum, 2)
                        p["residual"] = round(actual_cum - p["cumTotal"], 2)
                        matched += 1
                residual_available = matched >= 2

    return jsonify({
        "points": points,
        "residualAvailable": residual_available,
        "residualNote": "Residual = actual Δ book unrealized P&L − attributed; includes position changes & higher-order terms.",
    })


@app.route("/api/snapshots/book", methods=["POST"])
def save_book_snapshot():
    """Persist mark-to-market book snapshot after a live fetch."""
    try:
        body = request.json or {}
        positions = body.get("positions", [])
        market = body.get("marketData", {})
        marks = body.get("optionMarks") or {}
        ts = body.get("timestamp") or datetime.now().isoformat()
        mtm = compute_portfolio_mtm(positions, market, marks)
        conn = get_db()
        conn.execute(
            "INSERT INTO portfolio_book_snapshots (timestamp, unrealized_pnl, book_value, position_count) VALUES (?,?,?,?)",
            (ts, mtm["unrealizedPnl"], mtm["bookValue"], len(positions)),
        )
        conn.commit()
        conn.close()
        return jsonify({"ok": True, **mtm})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/snapshots/book-timeline", methods=["GET"])
def book_snapshot_timeline():
    limit = min(int(request.args.get("limit", 60)), 200)
    conn = get_db()
    rows = conn.execute(
        """
        SELECT timestamp, unrealized_pnl, book_value, position_count
        FROM portfolio_book_snapshots
        ORDER BY id DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    conn.close()
    points = [
        {
            "timestamp": r["timestamp"],
            "unrealizedPnl": r["unrealized_pnl"],
            "bookValue": r["book_value"],
            "positionCount": r["position_count"],
        }
        for r in rows
    ]
    points.reverse()
    risk = _compute_mtm_risk_metrics(points)
    return jsonify({"points": points, "risk": risk})


@app.route("/api/snapshots/diff", methods=["GET"])
def diff_attribution_snapshots():
    """Delta between two stored attribution snapshots (fetch-interval attribution)."""
    try:
        id_a = int(request.args.get("id_a", 0))
        id_b = int(request.args.get("id_b", 0))
        if not id_a or not id_b:
            return jsonify({"error": "id_a and id_b required"}), 400
        conn = get_db()
        rows = conn.execute(
            "SELECT id, timestamp, portfolio_total, data_json FROM attribution_snapshots WHERE id IN (?, ?)",
            (id_a, id_b),
        ).fetchall()
        conn.close()
        by_id = {}
        for r in rows:
            try:
                data = json.loads(r["data_json"])
            except Exception:
                data = {}
            by_id[r["id"]] = {
                "id": r["id"],
                "timestamp": r["timestamp"],
                "portfolioTotal": r["portfolio_total"],
                "attribution": data,
            }
        if id_a not in by_id or id_b not in by_id:
            return jsonify({"error": "Snapshot not found"}), 404

        snap_a = by_id[id_a]
        snap_b = by_id[id_b]
        port_a = snap_a["attribution"].get("portfolio") or {}
        port_b = snap_b["attribution"].get("portfolio") or {}
        port_keys = ["pricePnl", "gammaPnl", "thetaPnl", "vegaPnl", "total"]
        portfolio_delta = {
            k: round(float(port_b.get(k, 0)) - float(port_a.get(k, 0)), 2) for k in port_keys
        }

        tickers_a = snap_a["attribution"].get("byTicker") or {}
        tickers_b = snap_b["attribution"].get("byTicker") or {}
        all_tickers = sorted(set(tickers_a) | set(tickers_b))
        ticker_delta = []
        for tkr in all_tickers:
            a = tickers_a.get(tkr, {})
            b = tickers_b.get(tkr, {})
            ticker_delta.append({
                "ticker": tkr,
                "totalA": a.get("total", 0),
                "totalB": b.get("total", 0),
                "totalDelta": round(float(b.get("total", 0)) - float(a.get("total", 0)), 2),
                "priceDelta": round(float(b.get("pricePnl", 0)) - float(a.get("pricePnl", 0)), 2),
                "thetaDelta": round(float(b.get("thetaPnl", 0)) - float(a.get("thetaPnl", 0)), 2),
                "vegaDelta": round(float(b.get("vegaPnl", 0)) - float(a.get("vegaPnl", 0)), 2),
            })
        ticker_delta.sort(key=lambda x: abs(x["totalDelta"]), reverse=True)

        return jsonify({
            "snapshotA": {"id": snap_a["id"], "timestamp": snap_a["timestamp"]},
            "snapshotB": {"id": snap_b["id"], "timestamp": snap_b["timestamp"]},
            "portfolioDelta": portfolio_delta,
            "byTicker": ticker_delta,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/snapshots/history", methods=["GET"])
def get_snapshot_history():
    ticker = request.args.get("ticker", "").upper()
    limit = min(int(request.args.get("limit", 50)), 200)
    conn = get_db()
    if ticker:
        rows = conn.execute(
            "SELECT timestamp, ticker, price, iv, delta, gamma, theta, vega FROM snapshots WHERE ticker=? ORDER BY id DESC LIMIT ?",
            (ticker, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT timestamp, ticker, price, iv, delta, gamma, theta, vega FROM snapshots ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    conn.close()
    return jsonify({"snapshots": [dict(r) for r in rows]})


@app.route("/api/snapshots/sessions", methods=["GET"])
def get_fetch_sessions():
    limit = min(int(request.args.get("limit", 20)), 100)
    conn = get_db()
    rows = conn.execute(
        "SELECT id, timestamp, position_count, ticker_count, data_json FROM fetch_sessions ORDER BY id DESC LIMIT ?",
        (limit,),
    ).fetchall()
    conn.close()
    sessions = []
    for r in rows:
        meta = {}
        try:
            meta = json.loads(r["data_json"]) if r["data_json"] else {}
        except Exception:
            pass
        sessions.append({
            "id": r["id"],
            "timestamp": r["timestamp"],
            "positionCount": r["position_count"],
            "tickerCount": r["ticker_count"],
            "meta": meta,
        })
    return jsonify({"sessions": sessions})


@app.route("/api/snapshots/portfolio-timeline", methods=["GET"])
def portfolio_timeline():
    """Sum book greeks by fetch timestamp (each /api/greeks save)."""
    limit = min(int(request.args.get("limit", 40)), 120)
    conn = get_db()
    rows = conn.execute(
        """
        SELECT timestamp,
               SUM(delta) AS delta,
               SUM(theta) AS theta,
               SUM(vega) AS vega,
               COUNT(DISTINCT ticker) AS tickers
        FROM snapshots
        GROUP BY timestamp
        ORDER BY timestamp DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    conn.close()
    points = [dict(r) for r in rows]
    points.reverse()
    return jsonify({"points": points})


@app.route("/api/snapshots/session", methods=["POST"])
def save_fetch_session():
    try:
        body = request.json
        ts = body.get("timestamp") or datetime.now().isoformat()
        conn = get_db()
        conn.execute(
            "INSERT INTO fetch_sessions (timestamp, position_count, ticker_count, data_json) VALUES (?,?,?,?)",
            (ts, body.get("positionCount", 0), body.get("tickerCount", 0), json.dumps(body.get("meta", {}))),
        )
        conn.commit()
        conn.close()
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/desk-alerts", methods=["POST"])
def desk_alerts():
    """Compute actionable desk alerts from portfolio + market + sim + greeks."""
    try:
        body = request.json
        positions = body.get("positions", [])
        market = body.get("marketData", {})
        sim = body.get("simResult") or {}
        greeks = body.get("greeks") or {}
        marks_at = body.get("marksFetchedAt")
        today = date.today()
        sev_order = {"high": 0, "medium": 1, "low": 2}

        thresholds = body.get("thresholds") or {}
        dte_high = int(thresholds.get("dteHigh", 7))
        dte_medium = int(thresholds.get("dteMedium", 21))
        iv_rank_min = float(thresholds.get("ivRank", 75))
        ex_div_days = int(thresholds.get("exDivDays", 14))
        port_p_profit = float(thresholds.get("portfolioPProfit", 45))
        tkr_p_profit = float(thresholds.get("tickerPProfit", 35))
        marks_stale_min = float(thresholds.get("marksStaleMin", 15))
        book_delta_abs = float(thresholds.get("bookDeltaAbs", 500))
        book_vega_abs = float(thresholds.get("bookVegaAbs", 2500))
        ticker_delta_abs = float(thresholds.get("tickerDeltaAbs", 300))
        book_theta_below = float(thresholds.get("bookThetaBelow", -500))
        dismissed = set(body.get("dismissedKeys") or [])

        alerts = []
        port_g = greeks.get("portfolio") or {}
        by_tkr_g = greeks.get("byTicker") or {}

        pdelta = float(port_g.get("delta") or 0)
        pvega = float(port_g.get("vega") or 0)
        ptheta = float(port_g.get("theta") or 0)
        if abs(pdelta) >= book_delta_abs:
            alerts.append({
                "severity": "high" if abs(pdelta) >= book_delta_abs * 1.5 else "medium",
                "category": "greek", "ticker": "BOOK",
                "message": f"Book Δ {pdelta:+.0f} sh-eq (limit ±{book_delta_abs:.0f})",
                "legKey": None,
            })
        if abs(pvega) >= book_vega_abs:
            alerts.append({
                "severity": "medium", "category": "greek", "ticker": "BOOK",
                "message": f"Book V {pvega:+.0f} ($/1% IV, limit ±{book_vega_abs:.0f})",
                "legKey": None,
            })
        if ptheta < book_theta_below:
            alerts.append({
                "severity": "medium", "category": "greek", "ticker": "BOOK",
                "message": f"Book Θ {ptheta:+.0f}/d below {book_theta_below:.0f}/d",
                "legKey": None,
            })

        for tkr, tg in by_tkr_g.items():
            td = float(tg.get("delta") or 0)
            if abs(td) >= ticker_delta_abs:
                alerts.append({
                    "severity": "medium", "category": "greek", "ticker": tkr,
                    "message": f"{tkr} Δ {td:+.0f} sh-eq (limit ±{ticker_delta_abs:.0f})",
                    "legKey": None,
                })

        for p in positions:
            tkr = p.get("ticker", "")
            md = market.get(tkr, {})
            if p.get("posType") == "equity":
                continue
            exp = p.get("expiry")
            if not exp:
                continue
            try:
                dte = (pd.Timestamp(exp).date() - today).days
            except Exception:
                continue
            contracts = p.get("contracts", 0)
            leg_key = f"{tkr}|{exp}|{p.get('strike')}|{p.get('optType')}"
            if contracts < 0 and dte <= dte_high:
                alerts.append({
                    "severity": "high", "category": "dte", "ticker": tkr,
                    "message": f"{tkr} short {p.get('optType','')} ${p.get('strike','')} expires in {dte}d",
                    "legKey": leg_key,
                })
            elif contracts < 0 and dte <= dte_medium:
                alerts.append({
                    "severity": "medium", "category": "dte", "ticker": tkr,
                    "message": f"{tkr} short leg {dte}d to expiry",
                    "legKey": leg_key,
                })
            iv_rank = md.get("iv_rank")
            if iv_rank is not None and iv_rank >= iv_rank_min and contracts < 0:
                alerts.append({
                    "severity": "medium", "category": "iv", "ticker": tkr,
                    "message": f"{tkr} IVR {iv_rank}% — elevated vol on short",
                    "legKey": leg_key,
                })
            ex_div = md.get("exDivDate")
            if ex_div and p.get("optType") == "Call" and contracts < 0:
                try:
                    days = (pd.Timestamp(ex_div).date() - today).days
                    if 0 < days <= ex_div_days:
                        alerts.append({
                            "severity": "high", "category": "dividend", "ticker": tkr,
                            "message": f"{tkr} ex-div in {days}d with short calls",
                            "legKey": f"{tkr}|{exp}|{p.get('strike')}|Call",
                        })
                except Exception:
                    pass

        p_profit = (sim.get("portfolio") or {}).get("prob_profit")
        if p_profit is not None and p_profit < port_p_profit:
            alerts.append({
                "severity": "medium", "category": "sim", "ticker": "BOOK",
                "message": f"Portfolio P(profit) {p_profit}% — run sim review",
                "legKey": None,
            })

        if marks_at:
            try:
                ts = marks_at.replace("Z", "").split(".")[0]
                fetched = datetime.fromisoformat(ts)
                age_min = (datetime.now() - fetched).total_seconds() / 60
                if age_min > marks_stale_min:
                    alerts.append({
                        "severity": "low", "category": "marks", "ticker": "BOOK",
                        "message": f"Option marks {int(age_min)}m stale — press r to refresh",
                        "legKey": None,
                    })
            except Exception:
                pass

        by_ticker_sim = sim.get("by_ticker") or {}
        for tkr, st in by_ticker_sim.items():
            pp = st.get("prob_profit")
            if pp is not None and pp < tkr_p_profit:
                alerts.append({
                    "severity": "medium", "category": "sim", "ticker": tkr,
                    "message": f"{tkr} P(profit) {pp}%",
                    "legKey": None,
                })

        for a in alerts:
            a["alertKey"] = f"{a['category']}|{a['ticker']}|{a.get('legKey') or ''}"

        alerts = [a for a in alerts if a["alertKey"] not in dismissed]
        alerts.sort(key=lambda a: (sev_order.get(a["severity"], 9), a["ticker"]))

        _persist_alert_events(alerts)

        return jsonify({"alerts": alerts})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e), "alerts": []}), 500


def _persist_alert_events(alerts, dedupe_hours=4):
    """Log alert firings to SQLite; skip duplicate keys within dedupe window."""
    if not alerts:
        return
    try:
        conn = get_db()
        ts = datetime.now().isoformat()
        cutoff = (datetime.now() - pd.Timedelta(hours=dedupe_hours)).isoformat()
        for a in alerts[:30]:
            key = a.get("alertKey")
            if not key:
                continue
            recent = conn.execute(
                "SELECT id FROM alert_events WHERE alert_key = ? AND triggered_at >= ? LIMIT 1",
                (key, cutoff),
            ).fetchone()
            if recent:
                continue
            conn.execute(
                """INSERT INTO alert_events (alert_key, ticker, category, severity, message, triggered_at)
                   VALUES (?,?,?,?,?,?)""",
                (key, a.get("ticker"), a.get("category"), a.get("severity"), a.get("message"), ts),
            )
        conn.commit()
        conn.close()
    except Exception:
        pass


@app.route("/api/alerts/history", methods=["GET"])
def alert_history():
    limit = min(int(request.args.get("limit", 25)), 100)
    conn = get_db()
    rows = conn.execute(
        """
        SELECT id, alert_key, ticker, category, severity, message, triggered_at
        FROM alert_events
        ORDER BY id DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    conn.close()
    return jsonify({"events": [dict(r) for r in rows]})


@app.route("/api/alerts/recent", methods=["GET"])
def recent_alerts():
    limit = min(int(request.args.get("limit", 30)), 100)
    conn = get_db()
    rows = conn.execute(
        "SELECT id, ticker, condition, triggered_at, acknowledged FROM alerts ORDER BY id DESC LIMIT ?",
        (limit,),
    ).fetchall()
    conn.close()
    return jsonify({"alerts": [dict(r) for r in rows]})


# ─── API: Risk Matrix (#14) ──────────────────────────────────────────────

@app.route("/api/risk-matrix", methods=["POST"])
def risk_matrix():
    try:
        body = request.json
        positions = list(body.get("positions", []))
        positions.extend(body.get("hypothetical", []))
        market = body.get("marketData", {})
        price_steps = body.get("priceSteps", [-20, -15, -10, -5, -2, 0, 2, 5, 10, 15, 20])
        iv_steps = body.get("ivSteps", [-15, -10, -5, 0, 5, 10, 15])
        days_fwd = body.get("daysForward", 0)
        days_fwd = max(0, min(int(days_fwd or 0), 730))
        today = pd.Timestamp.now().normalize()

        grid = []
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
                        total_pnl += shares * (shocked_S - S)
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

                    opt_val = max(bs_option_value(shocked_S, strike, RISK_FREE, shocked_iv, T, opt_type), 0)
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


# ─── API: Vol Surface (#16) ──────────────────────────────────────────────

# Cache option chain data fetched during market-data calls
_chain_cache = {}

def _safe_chain_df(df):
    """Flatten MultiIndex columns if present (yfinance compat)."""
    if isinstance(df.columns, pd.MultiIndex):
        df = df.copy()
        df.columns = [c[0] if isinstance(c, tuple) else c for c in df.columns]
    return df

@app.route("/api/option-strikes/<ticker>/<expiry>")
def option_strikes(ticker, expiry):
    """Strikes with bid/ask/mid for one expiry (puts and calls)."""
    tkr = ticker.upper()
    try:
        tk = yf.Ticker(tkr)
        chain = tk.option_chain(expiry)
        rows = []
        for opt_type, df_key in [("Put", "puts"), ("Call", "calls")]:
            df = _safe_chain_df(getattr(chain, df_key))
            if "strike" not in df.columns:
                continue
            for _, row in df.iterrows():
                bid_raw = row.get("bid", 0)
                ask_raw = row.get("ask", 0)
                bid = float(bid_raw) if pd.notna(bid_raw) else 0
                ask = float(ask_raw) if pd.notna(ask_raw) else 0
                if bid <= 0 and ask <= 0:
                    continue
                strike = float(row["strike"])
                mid = round((bid + ask) / 2, 4) if (bid or ask) else 0
                rows.append({
                    "strike": strike,
                    "optType": opt_type,
                    "bid": round(bid, 4),
                    "ask": round(ask, 4),
                    "mid": mid,
                })
        rows.sort(key=lambda r: (r["optType"], r["strike"]))
        return jsonify({"ticker": tkr, "expiry": expiry, "strikes": rows})
    except Exception as e:
        return jsonify({"error": str(e), "ticker": tkr, "expiry": expiry, "strikes": []}), 500


@app.route("/api/option-expiries/<ticker>")
def option_expiries(ticker):
    """Listed option expiry dates for roll analyzer dropdown."""
    tkr = ticker.upper()
    try:
        tk = yf.Ticker(tkr)
        expiries = list(tk.options or [])
        today = date.today()
        out = []
        for exp in expiries:
            try:
                d = datetime.strptime(exp, "%Y-%m-%d").date()
                dte = (d - today).days
                if dte >= 0:
                    out.append({"expiry": exp, "dte": dte})
            except ValueError:
                continue
        return jsonify({"ticker": tkr, "expiries": out})
    except Exception as e:
        return jsonify({"error": str(e), "ticker": tkr, "expiries": []}), 500


@app.route("/api/option-marks", methods=["POST"])
def option_marks():
    """
    POST { "positions": [{ ticker, expiry, strike, optType }, ...] }
    Returns mid/bid/ask per position key (expiry|type|strike).
    """
    positions = request.json.get("positions", [])
    marks = {}
    by_expiry = {}
    for p in positions:
        if p.get("posType") == "equity" or not p.get("expiry"):
            continue
        tkr = p["ticker"].upper()
        exp = p["expiry"]
        if isinstance(exp, str) and "T" in exp:
            exp = exp.split("T")[0]
        by_expiry.setdefault(tkr, {}).setdefault(exp, []).append(p)

    for tkr, exps in by_expiry.items():
        try:
            tk = yf.Ticker(tkr)
            for exp, legs in exps.items():
                try:
                    chain = tk.option_chain(exp)
                    for p in legs:
                        opt_type = (p.get("optType") or "put").lower()
                        df = _safe_chain_df(chain.puts if opt_type == "put" else chain.calls)
                        if "strike" not in df.columns:
                            continue
                        strike = float(p.get("strike", 0))
                        row = df.iloc[(df["strike"] - strike).abs().argsort()[:1]]
                        if row.empty:
                            continue
                        bid_raw = row["bid"].iloc[0] if "bid" in row.columns else 0
                        ask_raw = row["ask"].iloc[0] if "ask" in row.columns else 0
                        bid = float(bid_raw) if pd.notna(bid_raw) else 0
                        ask = float(ask_raw) if pd.notna(ask_raw) else 0
                        mid = round((bid + ask) / 2, 4) if bid or ask else 0
                        iv = float(row["impliedVolatility"].iloc[0]) if "impliedVolatility" in row.columns and pd.notna(row["impliedVolatility"].iloc[0]) else None
                        key = f"{tkr}|{exp}|{opt_type[0].upper()}|{strike}"
                        marks[key] = {
                            "bid": round(bid, 4),
                            "ask": round(ask, 4),
                            "mid": mid,
                            "iv": round(iv * 100, 1) if iv else None,
                        }
                    time.sleep(0.2)
                except Exception as e:
                    print(f"  option-marks {tkr} {exp}: {e}", file=sys.stderr)
        except Exception as e:
            print(f"  option-marks {tkr}: {e}", file=sys.stderr)

    return jsonify({
        "marks": marks,
        "fetchedAt": datetime.now().isoformat(),
        "note": "Mid from Yahoo option chain bid/ask; may lag broker marks.",
    })


@app.route("/api/vol-surface/<ticker>")
def vol_surface(ticker):
    tkr = ticker.upper()
    surface = []
    try:
        tk = yf.Ticker(tkr)
        expiries = tk.options
        if not expiries:
            raise ValueError("No expiries listed")

        for exp in expiries[:8]:
            try:
                chain = tk.option_chain(exp)
                puts = _safe_chain_df(chain.puts)
                calls = _safe_chain_df(chain.calls)

                # Select only columns that exist
                want_cols = ["strike", "impliedVolatility", "volume", "openInterest"]
                have_cols_p = [c for c in want_cols if c in puts.columns]
                have_cols_c = [c for c in want_cols if c in calls.columns]

                if "strike" not in have_cols_p or "impliedVolatility" not in have_cols_p:
                    continue

                pdf = puts[have_cols_p].copy()
                pdf["optType"] = "Put"
                cdf = calls[have_cols_c].copy()
                cdf["optType"] = "Call"
                combined = pd.concat([pdf, cdf], ignore_index=True)
                combined = combined[combined["impliedVolatility"] > 0]
                # Filter to strikes with actual market activity (volume or OI > 0)
                # Use fillna(0) to handle NaN in volume/OI columns
                if "openInterest" in combined.columns:
                    combined["volume"] = combined["volume"].fillna(0)
                    combined["openInterest"] = combined["openInterest"].fillna(0)
                    combined = combined[(combined["volume"] > 0) | (combined["openInterest"] > 0)]

                if not combined.empty:
                    records = []
                    for _, row in combined.iterrows():
                        vol = row.get("volume", 0)
                        oi = row.get("openInterest", 0)
                        records.append({
                            "strike": float(row["strike"]),
                            "impliedVolatility": float(row["impliedVolatility"]),
                            "volume": int(vol) if pd.notna(vol) else 0,
                            "openInterest": int(oi) if pd.notna(oi) else 0,
                            "optType": row["optType"],
                        })
                    surface.append({"expiry": exp, "data": records})

                time.sleep(0.3)  # Rate-limit protection
            except Exception as e:
                print(f"  Vol surface chain error for {tkr} {exp}: {e}", file=sys.stderr)
                continue

    except Exception as e:
        print(f"  Vol surface error for {tkr}: {e}", file=sys.stderr)

    if surface:
        _chain_cache[tkr] = surface
        return jsonify({"ticker": tkr, "expiries": surface})

    # Fall back to cached data
    if tkr in _chain_cache and _chain_cache[tkr]:
        return jsonify({"ticker": tkr, "expiries": _chain_cache[tkr], "note": "Using cached data"})

    return jsonify({"ticker": tkr, "expiries": [], "note": "No option chain data available. Yahoo Finance may be rate-limiting or the ticker has no listed options."})


# ─── API: Unusual Options Activity (#17) ─────────────────────────────────

@app.route("/api/unusual-activity", methods=["POST"])
def unusual_activity():
    tickers = request.json.get("tickers", [])
    alerts = []
    for tkr in tickers:
        try:
            tk = yf.Ticker(tkr)
            for exp in tk.options[:3]:
                chain = tk.option_chain(exp)
                for side, df in [("Put", _safe_chain_df(chain.puts)), ("Call", _safe_chain_df(chain.calls))]:
                    for _, row in df.iterrows():
                        v = row.get("volume", 0)
                        o = row.get("openInterest", 0)
                        vol = int(v) if pd.notna(v) else 0
                        oi = int(o) if pd.notna(o) else 0
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
    return jsonify({"alerts": alerts[:20]})


# ─── API: What-If (#15) ──────────────────────────────────────────────────

@app.route("/api/what-if-greeks", methods=["POST"])
def what_if_greeks():
    """Same as /api/greeks but merges hypothetical positions."""
    try:
        body = request.json
        positions = body.get("positions", [])
        hypothetical = body.get("hypothetical", [])
        market = body.get("marketData", {})
        merged = positions + hypothetical

        # Reuse greeks logic
        today = pd.Timestamp.now().normalize()
        position_greeks = []
        ticker_greeks = {}

        for p in merged:
            tkr = p["ticker"]
            md = market.get(tkr, {})
            S = md.get("price", 0)
            iv_pct = md.get("iv", 0)
            iv = iv_pct / 100 if iv_pct else 0

            if p.get("posType") == "equity":
                shares = p.get("shares", p.get("contracts", 0))
                agg = ticker_greeks.setdefault(tkr, {"delta": 0, "gamma": 0, "theta": 0, "vega": 0})
                agg["delta"] += shares
                continue

            if not S or not iv or not p.get("expiry"):
                continue

            opt_type = (p.get("optType") or "put").lower()
            strike = p.get("strike", 0)
            contracts = p.get("contracts", 0)
            multiplier = contracts * 100
            raw_dte = (pd.Timestamp(p["expiry"]) - today).days

            if raw_dte <= 0:
                # Expired: no time value → zero time-decay greeks; delta = intrinsic.
                if opt_type == "call":
                    intrinsic_delta = 1.0 if S > strike else 0.0
                else:
                    intrinsic_delta = -1.0 if S < strike else 0.0
                greeks = {"delta": intrinsic_delta, "gamma": 0.0, "theta": 0.0, "vega": 0.0}
            else:
                T = max(raw_dte, 1) / 365.0
                greeks = bs_greeks(S, strike, RISK_FREE, iv, T, opt_type)
            agg = ticker_greeks.setdefault(tkr, {"delta": 0, "gamma": 0, "theta": 0, "vega": 0})
            agg["delta"] += round(greeks["delta"] * multiplier, 2)
            agg["gamma"] += round(greeks["gamma"] * multiplier, 4)
            agg["theta"] += round(greeks["theta"] * multiplier, 2)
            agg["vega"] += round(greeks["vega"] * multiplier, 2)

        for tkr in ticker_greeks:
            for k in ticker_greeks[tkr]:
                ticker_greeks[tkr][k] = round(ticker_greeks[tkr][k], 2)

        portfolio_greeks = {"delta": 0, "gamma": 0, "theta": 0, "vega": 0}
        for tg in ticker_greeks.values():
            for k in portfolio_greeks:
                portfolio_greeks[k] += tg[k]
        for k in portfolio_greeks:
            portfolio_greeks[k] = round(portfolio_greeks[k], 2)

        return jsonify({
            "byTicker": ticker_greeks,
            "portfolio": portfolio_greeks,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ─── Existing helpers ─────────────────────────────────────────────────────

def _pnl_stats(pnl):
    return {
        "mean": round(float(np.mean(pnl)), 2),
        "median": round(float(np.median(pnl)), 2),
        "p5": round(float(np.percentile(pnl, 5)), 2),
        "p25": round(float(np.percentile(pnl, 25)), 2),
        "p75": round(float(np.percentile(pnl, 75)), 2),
        "p95": round(float(np.percentile(pnl, 95)), 2),
        "min": round(float(np.min(pnl)), 2),
        "max": round(float(np.max(pnl)), 2),
        "prob_profit": round(float((pnl >= 0).mean() * 100), 1),
    }


def _histogram(pnl, n_bins=60):
    counts, edges = np.histogram(pnl, bins=n_bins)
    return {
        "counts": counts.tolist(),
        "edges": [round(float(e), 2) for e in edges.tolist()],
    }


# ─── Simulation engines ───────────────────────────────────────────────────

def sim_gbm(S0, mu, sigma, T, n_steps, n_paths):
    dt = T / n_steps
    Z = rng.standard_normal((n_paths, n_steps))
    log_r = (mu - 0.5 * sigma ** 2) * dt + sigma * np.sqrt(dt) * Z
    paths = S0 * np.exp(np.cumsum(log_r, axis=1))
    return np.hstack([np.full((n_paths, 1), S0), paths])


def sim_merton(S0, mu, sigma_diff, lam, mu_j, sig_j, T, n_steps, n_paths):
    dt = T / n_steps
    k_bar = np.exp(mu_j + 0.5 * sig_j ** 2) - 1
    drift = (mu - 0.5 * sigma_diff ** 2 - lam * k_bar) * dt
    Z = rng.standard_normal((n_paths, n_steps))
    diffuse = drift + sigma_diff * np.sqrt(dt) * Z
    N_jumps = rng.poisson(lam * dt, (n_paths, n_steps))
    J = np.zeros((n_paths, n_steps))
    mask = N_jumps > 0
    if mask.any():
        rows, cols = np.where(mask)
        n_total = int(N_jumps[mask].sum())
        jump_sizes = rng.normal(mu_j, sig_j, n_total)
        idx = 0
        for r_, c_ in zip(rows, cols):
            n = int(N_jumps[r_, c_])
            J[r_, c_] = jump_sizes[idx:idx + n].sum()
            idx += n
    log_r = diffuse + J
    paths = S0 * np.exp(np.cumsum(log_r, axis=1))
    return np.hstack([np.full((n_paths, 1), S0), paths])


# ─── Black-Scholes Theta ───────────────────────────────────────────────────

def bs_theta_per_day(S, K, r, iv, T_years, opt_type, qty):
    if T_years <= 1e-6 or iv <= 0 or S <= 0 or K <= 0:
        return 0.0
    d1 = (np.log(S / K) + (r + 0.5 * iv ** 2) * T_years) / (iv * np.sqrt(T_years))
    d2 = d1 - iv * np.sqrt(T_years)
    phi = np.exp(-0.5 * d1 ** 2) / np.sqrt(2 * np.pi)
    if opt_type == "call":
        theta = -(S * phi * iv) / (2 * np.sqrt(T_years)) - r * K * np.exp(-r * T_years) * norm.cdf(d2)
    else:
        theta = -(S * phi * iv) / (2 * np.sqrt(T_years)) + r * K * np.exp(-r * T_years) * norm.cdf(-d2)
    return qty * (theta / 365.0) * 100


def build_theta_data(positions, ticker_data, today):
    option_positions = [p for p in positions if p.get("posType") != "equity" and p.get("expiry")]
    if not option_positions:
        return None

    all_expiries = sorted(set(pd.Timestamp(p["expiry"]) for p in option_positions))
    if not all_expiries:
        return None

    latest_exp = all_expiries[-1]
    end_dt = latest_exp + pd.Timedelta(days=7)
    date_arr = pd.date_range(today, end_dt, freq="D")
    n_days = len(date_arr)

    exp_groups = OrderedDict()
    for exp in all_expiries:
        legs = [p for p in option_positions if pd.Timestamp(p["expiry"]) == exp]
        tickers_in_group = sorted(set(p["ticker"] for p in legs))
        exp_groups[exp] = {"legs": legs, "tickers": tickers_in_group}

    GROUP_COLORS = ["#e05555", "#e08c30", "#00b4b4", "#f5c518", "#8b5cf6", "#3b82f6", "#10b981", "#f472b6"]

    group_data = []
    for gi, (exp, info) in enumerate(exp_groups.items()):
        exp_label = exp.strftime("%b %d")
        yr = exp.strftime("'%y")
        tkr_str = ", ".join(info["tickers"][:3])
        if len(info["tickers"]) > 3:
            tkr_str += f" +{len(info['tickers']) - 3}"
        label = f"{exp_label} {yr} ({tkr_str})"
        color = GROUP_COLORS[gi % len(GROUP_COLORS)]

        daily = np.zeros(n_days)
        for p in info["legs"]:
            tkr = p["ticker"]
            td = ticker_data.get(tkr, {})
            S0 = td.get("price") or 0
            # IV from simulate's ticker_data is already in decimal (e.g. 1.888 for 188.8%)
            # Fall back to hv20 (percent) converted, or 0.60
            iv_raw = td.get("iv")
            if iv_raw and iv_raw > 0:
                # If > 5, it's likely in percent form (from raw market data), convert
                iv = iv_raw / 100.0 if iv_raw > 5 else iv_raw
            else:
                hv = td.get("hv20")
                iv = (hv / 100.0) if hv else 0.60
            if S0 <= 0:
                continue
            strike = p.get("strike", 0)
            qty = p.get("contracts", 0)
            opt_type = (p.get("optType") or "put").lower()

            for j, d in enumerate(date_arr):
                if d > exp:
                    continue
                t_rem = max((exp - d).days / 365.0, 1e-6)
                theta_val = bs_theta_per_day(S0, strike, RISK_FREE, iv, t_rem, opt_type, qty)
                daily[j] += theta_val

        group_data.append({
            "label": label,
            "color": color,
            "daily": [round(float(v), 2) for v in daily],
            "expiry": exp.strftime("%Y-%m-%d"),
        })

    total_daily = np.zeros(n_days)
    daily_earned = np.zeros(n_days)
    daily_cost = np.zeros(n_days)
    for g in group_data:
        arr = np.array(g["daily"])
        total_daily += arr
        daily_earned += np.maximum(arr, 0)
        daily_cost += np.minimum(arr, 0)

    cumulative = np.cumsum(daily_earned)
    cumulative_net = np.cumsum(total_daily)

    milestones = []
    for exp in all_expiries:
        if exp <= today:
            continue
        idx = min((exp - today).days, n_days - 1)
        milestones.append({
            "date": exp.strftime("%b %d"),
            "index": idx,
            "value": round(float(cumulative[idx]), 2),
        })

    today_theta = round(float(total_daily[0]), 2)
    today_earned = round(float(daily_earned[0]), 2)
    today_cost = round(float(daily_cost[0]), 2)
    next_exp = None
    post_theta = 0
    future_exps = [e for e in all_expiries if e > today]
    if future_exps:
        next_exp = future_exps[0]
        post_idx = min((next_exp - today).days + 1, n_days - 1)
        post_theta = round(float(total_daily[post_idx]), 2)

    return {
        "dates": [d.strftime("%b-%d") for d in date_arr],
        "groups": group_data,
        "totalDaily": [round(float(v), 2) for v in total_daily],
        "cumulative": [round(float(v), 2) for v in cumulative.tolist()],
        "cumulativeNet": [round(float(v), 2) for v in cumulative_net.tolist()],
        "milestones": milestones,
        "todayTheta": today_theta,
        "todayEarned": today_earned,
        "todayCost": today_cost,
        "totalCumulative": round(float(cumulative[-1]), 2),
        "totalCumulativeNet": round(float(cumulative_net[-1]), 2),
        "nextExpiry": next_exp.strftime("%b %d") if next_exp else None,
        "postNextTheta": post_theta,
    }


# ─── Ticker classification ────────────────────────────────────────────────

def compute_hv(hist_df, window=20):
    if hist_df is None or len(hist_df) < window + 1:
        return None
    close = hist_df["Close"].dropna()
    if len(close) < window + 1:
        return None
    log_ret = np.log(close / close.shift(1)).dropna()
    return float(log_ret.rolling(window).std().iloc[-1] * np.sqrt(252))


def classify_ticker(tkr, hist_df, iv, today):
    reasons = []
    hv = compute_hv(hist_df)
    if iv and hv and hv > 0:
        ratio = iv / hv
        if ratio >= IV_HV_RATIO_THRESHOLD:
            reasons.append(f"IV/HV={ratio:.2f}")

    if hist_df is not None and len(hist_df) >= 10:
        closes_arr = hist_df["Close"].dropna().values
        if len(closes_arr) >= 10:
            recent_move = abs(closes_arr[-1] / closes_arr[-10] - 1)
            if recent_move >= PRICE_MOVE_THRESHOLD:
                reasons.append(f"Price move {recent_move:.0%} in 10d")

    if reasons:
        return "merton", "; ".join(reasons)
    return "gbm", "No catalyst detected"


def _net_payoff_py(S, legs):
    S = np.atleast_1d(np.asarray(S, dtype=float))
    total = np.zeros_like(S)
    for p in legs:
        pos_type = p.get("posType", "option")
        if pos_type == "equity":
            shares = p.get("shares", p.get("contracts", 0))
            avg_cost = p.get("avgCost", 0)
            total += (shares / 100.0) * (S - avg_cost)
        else:
            strike = p.get("strike", 0)
            qty = p.get("contracts", 0)
            opt_type = (p.get("optType") or "put").lower()
            avg_cost = p.get("avgCost", 0)
            intrinsic = np.maximum(S - strike, 0.0) if opt_type == "call" else np.maximum(strike - S, 0.0)
            total += qty * (intrinsic - avg_cost)
    return total


def _find_breakevens_py(legs, spot, n_points=4000):
    lo, hi = spot * 0.01, spot * 4.0
    grid = np.linspace(lo, hi, n_points)
    pnl = _net_payoff_py(grid, legs)
    breakevens = []
    for i in range(len(pnl) - 1):
        if pnl[i] * pnl[i + 1] < 0:
            be = grid[i] - pnl[i] * (grid[i + 1] - grid[i]) / (pnl[i + 1] - pnl[i])
            breakevens.append(round(float(be), 4))
        elif abs(pnl[i]) < 1e-6:
            breakevens.append(round(float(grid[i]), 4))
    merged = []
    for be in sorted(set(breakevens)):
        if not merged or abs(be - merged[-1]) / max(abs(merged[-1]), 1e-6) > 0.005:
            merged.append(be)
    return merged


# ─── Serve the frontend ───────────────────────────────────────────────────

def _read_version():
    try:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "VERSION")
        with open(path, encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return "dev"


@app.route("/api/version")
def api_version():
    return jsonify({"version": _read_version(), "name": "options-dashboard"})


# ─── Schwab API routes (Phase 6) ─────────────────────────────────────────────

from schwab_client import SchwabAuthError, SchwabApiError, get_schwab_client
from tax_lots import compute_tax_lots, export_8949_csv
from brokers import get_adapter, list_adapters, BrokerError, BrokerNotFound


@app.route("/api/schwab/status")
def schwab_status():
    """Return Schwab connection status (configured, authenticated, token age)."""
    try:
        return jsonify(get_schwab_client().status())
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/schwab/auth/url")
def schwab_auth_url():
    """Return the OAuth authorization URL for the user to open in a browser."""
    try:
        url = get_schwab_client().get_auth_url()
        return jsonify({"auth_url": url})
    except SchwabAuthError as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/schwab/auth/callback", methods=["POST"])
def schwab_auth_callback():
    """Exchange authorization code from pasted redirect URL for tokens.

    Body: { "url": "<full redirect URL copied from browser address bar>" }
    """
    try:
        pasted_url = (request.json or {}).get("url", "")
        if not pasted_url:
            return jsonify({"error": "Body must contain 'url' field with the full redirect URL"}), 400
        get_schwab_client().handle_callback(pasted_url)
        return jsonify({"ok": True, "status": get_schwab_client().status()})
    except SchwabAuthError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/schwab/sync", methods=["POST"])
def schwab_sync():
    """Fetch live positions from Schwab and return them in internal leg format.

    Response: { "positions": [...], "account_count": int, "position_count": int }
    The frontend can pass this directly to buildPortfolio() just like a parsed CSV.
    """
    try:
        positions = get_schwab_client().get_positions()
        return jsonify({
            "positions": positions,
            "position_count": len(positions),
            "synced_at": datetime.now().isoformat(),
        })
    except SchwabAuthError as e:
        return jsonify({"error": str(e), "needs_reauth": True}), 401
    except SchwabApiError as e:
        return jsonify({"error": str(e)}), 502
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/schwab/disconnect", methods=["POST"])
def schwab_disconnect():
    """Delete the local token file and clear the in-memory client state."""
    try:
        get_schwab_client().disconnect()
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/schwab/config", methods=["POST"])
def schwab_config():
    """Save the Schwab App Key + Secret to the local config file (no .env editing).

    Body: { "client_id": "...", "client_secret": "...", "callback_url"?: "..." }
    """
    try:
        body = request.json or {}
        client_id = (body.get("client_id") or "").strip()
        client_secret = (body.get("client_secret") or "").strip()
        callback_url = (body.get("callback_url") or "").strip() or None
        if not client_id or not client_secret:
            return jsonify({"error": "Both 'client_id' and 'client_secret' are required"}), 400
        get_schwab_client().save_config(client_id, client_secret, callback_url)
        return jsonify({"ok": True, "status": get_schwab_client().status()})
    except SchwabAuthError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ─── Broker adapter routes (Phase 7.1) ────────────────────────────────────────
# Unified, broker-agnostic surface over the brokers/ registry. Adding a broker
# is "write an adapter + register it" — these routes need no changes.

@app.route("/api/brokers")
def brokers_list():
    """List every supported broker and its capabilities (source, oauth, etc.)."""
    try:
        return jsonify({"brokers": list_adapters()})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/brokers/<key>/status")
def broker_status(key):
    """Connection status for one broker. CSV brokers report ready; Schwab delegates to OAuth state."""
    try:
        return jsonify(get_adapter(key).status())
    except BrokerNotFound as e:
        return jsonify({"error": str(e)}), 404
    except SchwabAuthError as e:
        return jsonify({"error": str(e), "needs_reauth": True}), 401
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/brokers/<key>/positions", methods=["POST"])
def broker_positions(key):
    """Return canonical legs for a broker.

    Body: { "csv": "<exported CSV text>" } for CSV brokers (Fidelity, IBKR, or a
    Schwab CSV export). For API brokers (Schwab) with no CSV supplied, pulls live
    positions via OAuth. Response shape matches /api/schwab/sync so the frontend
    can pass `positions` straight into buildPortfolio().
    """
    try:
        adapter = get_adapter(key)
        csv_text = (request.json or {}).get("csv") if request.is_json else None
        positions = adapter.get_positions(csv_text)
        return jsonify({
            "broker": adapter.key,
            "source": "csv" if (csv_text and csv_text.strip()) else adapter.source,
            "positions": positions,
            "position_count": len(positions),
            "synced_at": datetime.now().isoformat(),
        })
    except BrokerNotFound as e:
        return jsonify({"error": str(e)}), 404
    except SchwabAuthError as e:
        return jsonify({"error": str(e), "needs_reauth": True}), 401
    except SchwabApiError as e:
        return jsonify({"error": str(e)}), 502
    except BrokerError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ─── IBKR Flex Web Service routes ─────────────────────────────────────────────
# Token-based positions sync (no OAuth, no gateway). Config saved to a local
# gitignored file via /api/ibkr/config so the UI panel never touches .env.

from ibkr_flex_client import IBKRFlexError, get_ibkr_flex_client


@app.route("/api/ibkr/status")
def ibkr_status():
    """Return IBKR Flex connection status (configured? which query id?)."""
    try:
        return jsonify(get_ibkr_flex_client().status())
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/ibkr/config", methods=["POST"])
def ibkr_config():
    """Save the Flex token + Activity query id to the local config file.

    Body: { "token": "...", "query_id": "..." }
    """
    try:
        body = request.json or {}
        token = (body.get("token") or "").strip()
        query_id = (body.get("query_id") or "").strip()
        if not token or not query_id:
            return jsonify({"error": "Both 'token' and 'query_id' are required"}), 400
        get_ibkr_flex_client().save_config(token, query_id)
        return jsonify({"ok": True, "status": get_ibkr_flex_client().status()})
    except IBKRFlexError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/ibkr/sync", methods=["POST"])
def ibkr_sync():
    """Fetch positions from the IBKR Flex Web Service; same shape as /api/schwab/sync."""
    try:
        positions = get_ibkr_flex_client().get_positions()
        return jsonify({
            "positions": positions,
            "position_count": len(positions),
            "synced_at": datetime.now().isoformat(),
        })
    except IBKRFlexError as e:
        return jsonify({"error": str(e)}), 502
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/ibkr/disconnect", methods=["POST"])
def ibkr_disconnect():
    """Delete the local IBKR Flex config file."""
    try:
        get_ibkr_flex_client().clear_config()
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ─── Tax lot routes (Phase 7.5) ───────────────────────────────────────────────

@app.route("/api/tax-lots/compute", methods=["POST"])
def tax_lots_compute():
    """Compute FIFO/LIFO realized gains, wash-sale adjustments, open lots.

    Body: { "method": "fifo"|"lifo", "tax_year": int|null,
            "trades": [...] | null (null = load from DB closed_trades) }
    """
    try:
        body = request.json or {}
        method = body.get("method", "fifo")
        tax_year = body.get("tax_year")
        trades_in = body.get("trades")

        if trades_in is None:
            conn = get_db()
            rows = conn.execute(
                "SELECT ticker, opt_type, strike, open_date, close_date, "
                "open_price, close_price, quantity, pnl, strategy, close_type FROM closed_trades "
                "ORDER BY open_date ASC"
            ).fetchall()
            conn.close()
            trades_in = [dict(r) for r in rows]

        result = compute_tax_lots(trades_in, method=method, tax_year=tax_year)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/tax-lots/export")
def tax_lots_export():
    """Export realized gains as a Form 8949-compatible CSV.

    Query params: method (fifo|lifo), tax_year (int)
    """
    try:
        method = request.args.get("method", "fifo")
        tax_year_raw = request.args.get("tax_year")
        tax_year = int(tax_year_raw) if tax_year_raw else None

        conn = get_db()
        rows = conn.execute(
            "SELECT ticker, opt_type, strike, open_date, close_date, "
            "open_price, close_price, quantity, pnl, strategy, close_type FROM closed_trades "
            "ORDER BY open_date ASC"
        ).fetchall()
        conn.close()
        trades = [dict(r) for r in rows]

        result = compute_tax_lots(trades, method=method, tax_year=tax_year)
        csv_text = export_8949_csv(result["realized"])
        fname = f"form8949_{tax_year or 'all'}_{method}.csv"
        return csv_text, 200, {
            "Content-Type": "text/csv",
            "Content-Disposition": f'attachment; filename="{fname}"',
        }
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ─── Strategy template routes (Phase 7.4) ────────────────────────────────────

@app.route("/api/strategy-templates", methods=["GET"])
def list_strategy_templates():
    try:
        conn = get_db()
        rows = conn.execute(
            "SELECT id, name, description, legs_json, created_at FROM strategy_templates ORDER BY name"
        ).fetchall()
        conn.close()
        return jsonify([dict(r) for r in rows])
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/strategy-templates", methods=["POST"])
def save_strategy_template():
    """Save a new strategy template.

    Body: { "name": str, "description": str, "legs": [...] }
    """
    try:
        body = request.json or {}
        name = (body.get("name") or "").strip()
        if not name:
            return jsonify({"error": "name is required"}), 400
        legs = body.get("legs", [])
        desc = body.get("description", "")
        now = datetime.now().isoformat()
        conn = get_db()
        conn.execute(
            "INSERT OR REPLACE INTO strategy_templates (name, description, legs_json, created_at) "
            "VALUES (?, ?, ?, ?)",
            (name, desc, json.dumps(legs), now),
        )
        conn.commit()
        row = conn.execute(
            "SELECT id, name, description, legs_json, created_at FROM strategy_templates WHERE name=?",
            (name,)
        ).fetchone()
        conn.close()
        return jsonify(dict(row))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/strategy-templates/<int:template_id>", methods=["DELETE"])
def delete_strategy_template(template_id):
    try:
        conn = get_db()
        conn.execute("DELETE FROM strategy_templates WHERE id=?", (template_id,))
        conn.commit()
        conn.close()
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ─── Alert rules routes (Phase 7.3) ──────────────────────────────────────────

@app.route("/api/alert-rules", methods=["GET"])
def list_alert_rules():
    try:
        conn = get_db()
        rows = conn.execute(
            "SELECT id, name, ticker, condition_type, threshold, action, enabled, created_at "
            "FROM alert_rules ORDER BY created_at DESC"
        ).fetchall()
        conn.close()
        return jsonify([dict(r) for r in rows])
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/alert-rules", methods=["POST"])
def create_alert_rule():
    """Create a new alert rule.

    Body: { "name": str, "ticker": str|null, "condition_type": str,
            "threshold": float|null, "action": "notify" }

    condition_type values: price_above, price_below, iv_rank_above,
    delta_above, delta_below, dte_below, p_profit_below
    """
    try:
        body = request.json or {}
        condition_type = body.get("condition_type", "")
        if not condition_type:
            return jsonify({"error": "condition_type is required"}), 400
        now = datetime.now().isoformat()
        conn = get_db()
        cur = conn.execute(
            "INSERT INTO alert_rules (name, ticker, condition_type, threshold, action, enabled, created_at) "
            "VALUES (?, ?, ?, ?, ?, 1, ?)",
            (
                body.get("name") or condition_type,
                (body.get("ticker") or "").upper() or None,
                condition_type,
                body.get("threshold"),
                body.get("action", "notify"),
                now,
            ),
        )
        row_id = cur.lastrowid
        conn.commit()
        row = conn.execute("SELECT * FROM alert_rules WHERE id=?", (row_id,)).fetchone()
        conn.close()
        return jsonify(dict(row))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/alert-rules/<int:rule_id>", methods=["PUT"])
def update_alert_rule(rule_id):
    try:
        body = request.json or {}
        conn = get_db()
        if "enabled" in body:
            conn.execute("UPDATE alert_rules SET enabled=? WHERE id=?", (int(body["enabled"]), rule_id))
        if "threshold" in body:
            conn.execute("UPDATE alert_rules SET threshold=? WHERE id=?", (body["threshold"], rule_id))
        if "name" in body:
            conn.execute("UPDATE alert_rules SET name=? WHERE id=?", (body["name"], rule_id))
        conn.commit()
        row = conn.execute("SELECT * FROM alert_rules WHERE id=?", (rule_id,)).fetchone()
        conn.close()
        return jsonify(dict(row) if row else {"error": "not found"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/alert-rules/<int:rule_id>", methods=["DELETE"])
def delete_alert_rule(rule_id):
    try:
        conn = get_db()
        conn.execute("DELETE FROM alert_rules WHERE id=?", (rule_id,))
        conn.commit()
        conn.close()
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/alert-rules/evaluate", methods=["POST"])
def evaluate_alert_rules():
    """Evaluate all enabled rules against current market + greeks data.

    Body: { "marketData": {...}, "greeks": {...}, "simResult": {...} }
    Returns: { "triggered": [{ rule_id, rule_name, message, ticker }, ...] }
    """
    try:
        body = request.json or {}
        market = body.get("marketData", {})
        greeks_data = body.get("greeks", {})
        sim = body.get("simResult", {})

        conn = get_db()
        rules = conn.execute(
            "SELECT id, name, ticker, condition_type, threshold FROM alert_rules WHERE enabled=1"
        ).fetchall()
        triggered = []
        now_iso = datetime.now().isoformat()

        for rule in rules:
            r = dict(rule)
            tkr = r["ticker"]
            ct = r["condition_type"]
            thresh = r["threshold"]
            md = market.get(tkr, {}) if tkr else {}
            tg = (greeks_data.get("byTicker") or {}).get(tkr, {}) if tkr else {}

            fired = False
            msg = ""

            if ct == "price_above" and tkr and md.get("price") and thresh is not None:
                if md["price"] > thresh:
                    fired = True; msg = f"{tkr} price ${md['price']:.2f} > ${thresh}"
            elif ct == "price_below" and tkr and md.get("price") and thresh is not None:
                if md["price"] < thresh:
                    fired = True; msg = f"{tkr} price ${md['price']:.2f} < ${thresh}"
            elif ct == "iv_rank_above" and tkr and md.get("iv_rank") is not None and thresh is not None:
                if md["iv_rank"] > thresh:
                    fired = True; msg = f"{tkr} IVR {md['iv_rank']:.0f} > {thresh}"
            elif ct == "delta_above" and tkr and tg.get("delta") is not None and thresh is not None:
                if abs(tg["delta"]) > thresh:
                    fired = True; msg = f"{tkr} |Δ| {abs(tg['delta']):.0f} > {thresh}"
            elif ct == "delta_below" and tkr and tg.get("delta") is not None and thresh is not None:
                if abs(tg["delta"]) < thresh:
                    fired = True; msg = f"{tkr} |Δ| {abs(tg['delta']):.0f} < {thresh}"
            elif ct == "dte_below" and thresh is not None:
                # Evaluate across all tickers in greeks
                by_ticker = greeks_data.get("byTicker") or {}
                for t2, g2 in by_ticker.items():
                    if tkr and t2 != tkr:
                        continue
                    dte = g2.get("minDte")
                    if dte is not None and dte < thresh:
                        fired = True; msg = f"{t2} DTE {dte} < {thresh}"; break
            elif ct == "p_profit_below" and thresh is not None:
                port_sim = (sim.get("portfolio") or {})
                pp = port_sim.get("prob_profit")
                if pp is not None and pp * 100 < thresh:
                    fired = True; msg = f"Portfolio P(profit) {pp*100:.0f}% < {thresh}%"

            if fired:
                alert_key = f"rule_{r['id']}_{now_iso[:10]}"
                try:
                    conn.execute(
                        "INSERT INTO alert_events (alert_key, ticker, category, severity, message, triggered_at) "
                        "VALUES (?, ?, 'rule', 'medium', ?, ?)",
                        (alert_key, tkr or "", msg, now_iso),
                    )
                except Exception:
                    pass
                triggered.append({"rule_id": r["id"], "rule_name": r["name"], "message": msg, "ticker": tkr})

        conn.commit()
        conn.close()
        return jsonify({"triggered": triggered, "evaluated_at": now_iso})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ─── Notification routes (Phase 7.7) ─────────────────────────────────────────

@app.route("/api/notify/test", methods=["POST"])
def notify_test():
    """Send a test email to verify SMTP configuration.

    Reads: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ALERT_EMAIL_TO from env.
    """
    try:
        import smtplib
        from email.message import EmailMessage

        host = os.environ.get("SMTP_HOST", "")
        port = int(os.environ.get("SMTP_PORT", "587"))
        user = os.environ.get("SMTP_USER", "")
        pwd = os.environ.get("SMTP_PASS", "")
        to_addr = os.environ.get("ALERT_EMAIL_TO", "")

        if not all([host, user, to_addr]):
            return jsonify({"error": "SMTP_HOST, SMTP_USER, and ALERT_EMAIL_TO must be set in .env"}), 400

        msg = EmailMessage()
        msg["Subject"] = "Options Dashboard — test alert"
        msg["From"] = user
        msg["To"] = to_addr
        msg.set_content("This is a test notification from Options Dashboard. SMTP is configured correctly.")

        with smtplib.SMTP(host, port) as server:
            server.starttls()
            if pwd:
                server.login(user, pwd)
            server.send_message(msg)

        return jsonify({"ok": True, "to": to_addr})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


def _send_alert_email(subject: str, body: str) -> None:
    """Send an alert email if SMTP is configured. Silent no-op if not."""
    try:
        import smtplib
        from email.message import EmailMessage
        host = os.environ.get("SMTP_HOST", "")
        port = int(os.environ.get("SMTP_PORT", "587"))
        user = os.environ.get("SMTP_USER", "")
        pwd = os.environ.get("SMTP_PASS", "")
        to_addr = os.environ.get("ALERT_EMAIL_TO", "")
        if not all([host, user, to_addr]):
            return
        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = user
        msg["To"] = to_addr
        msg.set_content(body)
        with smtplib.SMTP(host, port, timeout=10) as server:
            server.starttls()
            if pwd:
                server.login(user, pwd)
            server.send_message(msg)
    except Exception as exc:
        print(f"[notify] Email send failed: {exc}", file=sys.stderr)


# ─── Data export routes (Phase 7.8) ──────────────────────────────────────────

@app.route("/api/export/portfolio-history")
def export_portfolio_history():
    """Export all snapshots as CSV: timestamp, ticker, price, iv, delta, gamma, theta, vega."""
    try:
        conn = get_db()
        rows = conn.execute(
            "SELECT timestamp, ticker, price, iv, delta, gamma, theta, vega, position_value "
            "FROM snapshots ORDER BY timestamp ASC"
        ).fetchall()
        conn.close()

        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["timestamp", "ticker", "price", "iv", "delta", "gamma", "theta", "vega", "position_value"])
        for r in rows:
            writer.writerow(list(r))
        return buf.getvalue(), 200, {
            "Content-Type": "text/csv",
            "Content-Disposition": 'attachment; filename="portfolio_history.csv"',
        }
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/export/journal")
def export_journal():
    """Export closed trades as CSV."""
    try:
        conn = get_db()
        rows = conn.execute(
            "SELECT ticker, occ_symbol, opt_type, strike, open_date, close_date, "
            "open_price, close_price, quantity, pnl, strategy, close_type "
            "FROM closed_trades ORDER BY close_date DESC"
        ).fetchall()
        conn.close()

        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["ticker", "occ_symbol", "opt_type", "strike", "open_date",
                         "close_date", "open_price", "close_price", "quantity",
                         "pnl", "strategy", "close_type"])
        for r in rows:
            writer.writerow(list(r))
        return buf.getvalue(), 200, {
            "Content-Type": "text/csv",
            "Content-Disposition": 'attachment; filename="journal_export.csv"',
        }
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/export/greeks-snapshot")
def export_greeks_snapshot():
    """Export most-recent per-ticker greeks snapshot as JSON."""
    try:
        conn = get_db()
        rows = conn.execute(
            "SELECT ticker, price, iv, delta, gamma, theta, vega, timestamp "
            "FROM snapshots WHERE timestamp = (SELECT MAX(timestamp) FROM snapshots) "
            "ORDER BY ticker"
        ).fetchall()
        conn.close()
        return jsonify([dict(r) for r in rows])
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ─── Draft order routes (Phase 7.2) ──────────────────────────────────────────

@app.route("/api/orders", methods=["GET"])
def list_orders():
    try:
        status_filter = request.args.get("status")
        conn = get_db()
        if status_filter:
            rows = conn.execute(
                "SELECT id, ticker, strategy, legs_json, status, notes, created_at, updated_at "
                "FROM draft_orders WHERE status=? ORDER BY updated_at DESC",
                (status_filter,)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id, ticker, strategy, legs_json, status, notes, created_at, updated_at "
                "FROM draft_orders ORDER BY updated_at DESC"
            ).fetchall()
        conn.close()
        out = []
        for r in rows:
            d = dict(r)
            try:
                d["legs"] = json.loads(d["legs_json"])
            except Exception:
                d["legs"] = []
            out.append(d)
        return jsonify(out)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/orders", methods=["POST"])
def create_order():
    """Create a new draft order.

    Body: { "ticker": str, "strategy": str, "legs": [...],
            "notes": str, "status": "draft"|"staged"|"submitted" }
    """
    try:
        body = request.json or {}
        ticker = (body.get("ticker") or "").upper()
        if not ticker:
            return jsonify({"error": "ticker is required"}), 400
        now = datetime.now().isoformat()
        conn = get_db()
        cur = conn.execute(
            "INSERT INTO draft_orders (ticker, strategy, legs_json, status, notes, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                ticker,
                body.get("strategy", ""),
                json.dumps(body.get("legs", [])),
                body.get("status", "draft"),
                body.get("notes", ""),
                now, now,
            ),
        )
        row_id = cur.lastrowid
        conn.commit()
        row = conn.execute("SELECT * FROM draft_orders WHERE id=?", (row_id,)).fetchone()
        conn.close()
        d = dict(row)
        d["legs"] = json.loads(d["legs_json"])
        return jsonify(d)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/orders/<int:order_id>", methods=["PUT"])
def update_order(order_id):
    """Update order status, notes, or legs."""
    try:
        body = request.json or {}
        now = datetime.now().isoformat()
        conn = get_db()
        if "status" in body:
            conn.execute("UPDATE draft_orders SET status=?, updated_at=? WHERE id=?",
                         (body["status"], now, order_id))
        if "notes" in body:
            conn.execute("UPDATE draft_orders SET notes=?, updated_at=? WHERE id=?",
                         (body["notes"], now, order_id))
        if "legs" in body:
            conn.execute("UPDATE draft_orders SET legs_json=?, updated_at=? WHERE id=?",
                         (json.dumps(body["legs"]), now, order_id))
        if "strategy" in body:
            conn.execute("UPDATE draft_orders SET strategy=?, updated_at=? WHERE id=?",
                         (body["strategy"], now, order_id))
        conn.commit()
        row = conn.execute("SELECT * FROM draft_orders WHERE id=?", (order_id,)).fetchone()
        conn.close()
        if not row:
            return jsonify({"error": "not found"}), 404
        d = dict(row)
        d["legs"] = json.loads(d["legs_json"])
        return jsonify(d)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/orders/<int:order_id>", methods=["DELETE"])
def delete_order(order_id):
    try:
        conn = get_db()
        conn.execute("DELETE FROM draft_orders WHERE id=?", (order_id,))
        conn.commit()
        conn.close()
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/orders/<int:order_id>/submit", methods=["POST"])
def submit_order(order_id):
    """Stage order for broker submission.

    Currently marks status='staged' and notes the pending-broker constraint.
    When Schwab API order placement is wired (v1.3+), this route will call
    the Schwab Orders API.
    """
    try:
        now = datetime.now().isoformat()
        conn = get_db()
        row = conn.execute("SELECT * FROM draft_orders WHERE id=?", (order_id,)).fetchone()
        if not row:
            conn.close()
            return jsonify({"error": "not found"}), 404
        conn.execute(
            "UPDATE draft_orders SET status='staged', updated_at=?, "
            "notes=COALESCE(notes,'') || '[Staged " + now[:10] + " — awaiting broker submission]' "
            "WHERE id=?",
            (now, order_id)
        )
        conn.commit()
        row = conn.execute("SELECT * FROM draft_orders WHERE id=?", (order_id,)).fetchone()
        conn.close()
        d = dict(row)
        d["legs"] = json.loads(d["legs_json"])
        d["_pending_broker"] = True
        d["_message"] = "Order staged locally. Live broker submission requires Schwab API activation (see DOCKET.md)."
        return jsonify(d)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ─── Risk VaR route (Phase 7.6) ──────────────────────────────────────────────

def _annualized_realized_vol(closes, window=20):
    """Annualized realized volatility (%) from the last `window` daily log returns."""
    closes = np.asarray([c for c in (closes or []) if c and c > 0], dtype=float)
    if closes.size < window + 1:
        return None
    rets = np.diff(np.log(closes))[-window:]
    if rets.size < 2:
        return None
    return round(float(np.std(rets, ddof=1) * np.sqrt(252) * 100), 1)


def _rollup_by_sector(position_greeks, market, sector_map):
    """Dollar-delta exposure rolled up by GICS sector, with a concentration index."""
    if not position_greeks:
        return None
    by_sector = {}
    for pg in position_greeks:
        tkr = pg.get("ticker")
        if not tkr:
            continue
        spot = float((market.get(tkr) or {}).get("price") or 0)
        dd = float(pg.get("delta") or 0) * spot
        sector = sector_map.get(tkr) or "Unknown"
        s = by_sector.setdefault(sector, {"dollarDelta": 0.0, "absDollarDelta": 0.0, "tickers": set()})
        s["dollarDelta"] += dd
        s["absDollarDelta"] += abs(dd)
        s["tickers"].add(tkr)
    gross = sum(s["absDollarDelta"] for s in by_sector.values())
    rows = []
    for sector, s in by_sector.items():
        rows.append({
            "sector": sector,
            "dollarDelta": round(s["dollarDelta"], 2),
            "absDollarDelta": round(s["absDollarDelta"], 2),
            "tickers": sorted(s["tickers"]),
            "tickerCount": len(s["tickers"]),
            "pct": round(s["absDollarDelta"] / gross * 100, 1) if gross > 1e-9 else 0.0,
        })
    rows.sort(key=lambda r: r["absDollarDelta"], reverse=True)
    hhi = sum((r["absDollarDelta"] / gross) ** 2 for r in rows) if gross > 1e-9 else None
    return {
        "sectors": rows,
        "grossDollarDelta": round(gross, 2),
        "hhi": round(hhi, 4) if hhi is not None else None,
        "effectiveSectors": round(1.0 / hhi, 1) if hhi and hhi > 1e-9 else None,
    }


def _compute_benchmark_metrics(book_points, spy_by_date):
    """Returns-based benchmark stats from tracked book snapshots vs SPY.

    Works in dollar terms to avoid a capital-base assumption: regress per-period
    change in book unrealized P&L ($) on SPY's fractional return. The slope is a
    dollar beta (P&L per +1% SPY), the intercept an average non-market P&L per
    period (alpha$). Also returns correlation, R², and window totals. Position
    changes between snapshots add noise — this is a tracked-period estimate."""
    if not book_points or not spy_by_date or len(book_points) < 5:
        return None

    def _date(ts):
        try:
            return str(pd.Timestamp(ts).date())
        except Exception:
            return None

    chrono = sorted(book_points, key=lambda b: b.get("timestamp") or "")
    aligned = []
    for b in chrono:
        d = _date(b.get("timestamp"))
        upnl = b.get("unrealizedPnl")
        if d is None or upnl is None or d not in spy_by_date:
            continue
        aligned.append((d, float(upnl), float(spy_by_date[d])))
    if len(aligned) < 5:
        return None
    port = np.array([a[1] for a in aligned], dtype=float)
    spy = np.array([a[2] for a in aligned], dtype=float)
    port_chg = np.diff(port)
    spy_ret = np.diff(spy) / spy[:-1]
    mask = np.isfinite(port_chg) & np.isfinite(spy_ret)
    port_chg, spy_ret = port_chg[mask], spy_ret[mask]
    if port_chg.size < 4 or float(np.std(spy_ret)) < 1e-12:
        return None
    cov = np.cov(port_chg, spy_ret)
    beta_per_unit = float(cov[0, 1] / cov[1, 1])
    corr = float(np.corrcoef(port_chg, spy_ret)[0, 1])
    alpha = float(np.mean(port_chg) - beta_per_unit * np.mean(spy_ret))
    return {
        "nPeriods": int(port_chg.size),
        "dollarBetaPer1pct": round(beta_per_unit / 100.0, 2),
        "correlation": round(corr, 3),
        "rSquared": round(corr * corr, 3),
        "alphaPerPeriod": round(alpha, 2),
        "spyReturnPct": round((spy[-1] / spy[0] - 1) * 100, 2),
        "portfolioPnl": round(float(port[-1] - port[0]), 2),
        "startDate": aligned[0][0],
        "endDate": aligned[-1][0],
    }


def _compute_component_var(all_pnl, ticker_pnl, confidence=0.95):
    """Decompose tail risk into per-ticker contributions.

    Uses the empirical expected-shortfall (Euler) allocation: average each
    ticker's P&L over the portfolio's worst (1-confidence) scenarios. These
    component contributions are additive — they sum to the portfolio's CVaR
    (expected shortfall) — which is the stable way to attribute tail risk. Also
    reports each ticker's standalone VaR (undiversified) and the portfolio
    diversification benefit.
    """
    all_pnl = np.asarray(all_pnl, dtype=float)
    if all_pnl.size < 10 or not ticker_pnl:
        return None
    alpha = 1.0 - confidence
    var_threshold = float(np.percentile(all_pnl, alpha * 100))  # negative = a loss
    tail_mask = all_pnl <= var_threshold
    if not tail_mask.any():
        return None
    port_var = -var_threshold
    port_cvar = -float(all_pnl[tail_mask].mean())

    comps = []
    sum_standalone = 0.0
    for tkr, arr in ticker_pnl.items():
        arr = np.asarray(arr, dtype=float)
        if arr.size != all_pnl.size:
            continue
        comp = -float(arr[tail_mask].mean())  # contribution to ES (additive)
        standalone = -float(np.percentile(arr, alpha * 100))
        sum_standalone += standalone
        comps.append({
            "ticker": tkr,
            "componentVar": round(comp, 2),
            "standaloneVar": round(standalone, 2),
            "pct": round(comp / port_cvar * 100, 1) if abs(port_cvar) > 1e-9 else 0.0,
        })
    comps.sort(key=lambda c: c["componentVar"], reverse=True)
    return {
        "confidence": confidence,
        "portfolioVar": round(port_var, 2),
        "portfolioCvar": round(port_cvar, 2),
        "sumStandaloneVar": round(sum_standalone, 2),
        "diversificationBenefit": round(sum_standalone - port_cvar, 2),
        "components": comps,
    }


def _compute_exposure_metrics(position_greeks, market):
    """Dollar-greeks, concentration, and a vega-by-DTE ladder from per-position
    greeks (delta/gamma/theta/vega already scaled to share/contract units) plus
    spot prices. Dollar delta = delta_shares x spot; dollar gamma = the change in
    dollar delta for a +1% move (gamma_shares x spot^2 x 0.01); theta and vega are
    already dollar quantities ($/day, $/vol-pt)."""
    if not position_greeks:
        return None
    today = pd.Timestamp.now().normalize()
    by_ticker = {}
    port = {"dollarDelta": 0.0, "dollarGamma1pct": 0.0, "theta": 0.0, "vega": 0.0}
    vega_buckets = {"0-7": 0.0, "8-21": 0.0, "22-45": 0.0, "46-90": 0.0, "90+": 0.0}

    def _bucket(dte):
        if dte <= 7:
            return "0-7"
        if dte <= 21:
            return "8-21"
        if dte <= 45:
            return "22-45"
        if dte <= 90:
            return "46-90"
        return "90+"

    for pg in position_greeks:
        tkr = pg.get("ticker")
        if not tkr:
            continue
        spot = float((market.get(tkr) or {}).get("price") or 0)
        delta_sh = float(pg.get("delta") or 0)
        gamma_sh = float(pg.get("gamma") or 0)
        theta = float(pg.get("theta") or 0)
        vega = float(pg.get("vega") or 0)
        d_delta = delta_sh * spot
        d_gamma = gamma_sh * spot * spot * 0.01
        agg = by_ticker.setdefault(tkr, {"dollarDelta": 0.0, "dollarGamma1pct": 0.0, "theta": 0.0, "vega": 0.0})
        agg["dollarDelta"] += d_delta
        agg["dollarGamma1pct"] += d_gamma
        agg["theta"] += theta
        agg["vega"] += vega
        port["dollarDelta"] += d_delta
        port["dollarGamma1pct"] += d_gamma
        port["theta"] += theta
        port["vega"] += vega
        exp = pg.get("expiry")
        if exp and pg.get("posType") != "equity":
            try:
                dte = (pd.Timestamp(exp) - today).days
                if dte >= 0:
                    vega_buckets[_bucket(dte)] += vega
            except Exception:
                pass

    for tkr in by_ticker:
        for k in by_ticker[tkr]:
            by_ticker[tkr][k] = round(by_ticker[tkr][k], 2)
    for k in port:
        port[k] = round(port[k], 2)

    abs_dd = {t: abs(v["dollarDelta"]) for t, v in by_ticker.items()}
    gross = sum(abs_dd.values())
    net = round(sum(v["dollarDelta"] for v in by_ticker.values()), 2)
    concentration = None
    if gross > 1e-9:
        shares = sorted(abs_dd.values(), reverse=True)
        hhi = sum((s / gross) ** 2 for s in shares)
        ranked = sorted(by_ticker.items(), key=lambda kv: abs(kv[1]["dollarDelta"]), reverse=True)
        concentration = {
            "grossDollarDelta": round(gross, 2),
            "netDollarDelta": net,
            "hhi": round(hhi, 4),
            "effectiveNames": round(1.0 / hhi, 1) if hhi > 1e-9 else None,
            "names": len(by_ticker),
            "topName": ranked[0][0] if ranked else None,
            "topNamePct": round(abs(ranked[0][1]["dollarDelta"]) / gross * 100, 1) if ranked else None,
            "top3Pct": round(sum(shares[:3]) / gross * 100, 1),
        }

    vega_ladder = [{"bucket": b, "vega": round(vega_buckets[b], 2)} for b in ["0-7", "8-21", "22-45", "46-90", "90+"]]

    return {"portfolio": port, "byTicker": by_ticker, "concentration": concentration, "vegaLadder": vega_ladder}


def _compute_expiry_calendar(position_greeks, market):
    """Per-expiry exposure + pin-risk view. Groups option legs by expiry and sums
    legs, net delta (shares), |gamma|, vega, and notional (|dollar delta|).
    nearestStrikePct = closest strike to spot among that expiry's legs as a % of
    spot; pinRisk flags near-dated expiries (<= 10 DTE) within 3% of a strike."""
    if not position_greeks:
        return None
    today = pd.Timestamp.now().normalize()
    by_exp = {}
    for pg in position_greeks:
        if pg.get("posType") == "equity":
            continue
        exp = pg.get("expiry")
        if not exp:
            continue
        try:
            dte = (pd.Timestamp(exp) - today).days
        except Exception:
            continue
        tkr = pg.get("ticker")
        spot = float((market.get(tkr) or {}).get("price") or 0)
        strike = float(pg.get("strike") or 0)
        delta_sh = float(pg.get("delta") or 0)
        gamma_sh = float(pg.get("gamma") or 0)
        vega = float(pg.get("vega") or 0)
        contracts = abs(int(pg.get("contracts") or 0))
        key = str(exp)[:10]
        row = by_exp.setdefault(key, {
            "expiry": key, "dte": dte, "tickers": set(), "legs": 0,
            "netDelta": 0.0, "absGamma": 0.0, "vega": 0.0, "notional": 0.0, "_nearest": None,
        })
        row["tickers"].add(tkr)
        row["legs"] += contracts
        row["netDelta"] += delta_sh
        row["absGamma"] += abs(gamma_sh)
        row["vega"] += vega
        row["notional"] += abs(delta_sh * spot)
        if spot and strike:
            dist = abs(spot - strike) / spot
            if row["_nearest"] is None or dist < row["_nearest"]:
                row["_nearest"] = dist

    out = []
    for row in by_exp.values():
        nearest = row.pop("_nearest")
        nearest_pct = round(nearest * 100, 2) if nearest is not None else None
        pin = bool(row["dte"] is not None and row["dte"] <= 10 and nearest is not None and nearest <= 0.03)
        out.append({
            "expiry": row["expiry"], "dte": row["dte"],
            "tickers": sorted(row["tickers"]), "tickerCount": len(row["tickers"]),
            "legs": row["legs"], "netDelta": round(row["netDelta"], 2),
            "absGamma": round(row["absGamma"], 4), "vega": round(row["vega"], 2),
            "notional": round(row["notional"], 2), "nearestStrikePct": nearest_pct, "pinRisk": pin,
        })
    out.sort(key=lambda r: (r["dte"] if r["dte"] is not None else 1e9))
    return out


@app.route("/api/risk/var", methods=["POST"])
def risk_var():
    """Compute 1-day and 5-day VaR from a portfolio P&L path array.

    Body: { "portfolio_pnl": [float, ...], "confidence": 0.95 }
    Returns: { "var_1d": float, "var_5d": float, "cvar_1d": float, "confidence": float }
    """
    try:
        body = request.json or {}
        pnl = np.array(body.get("portfolio_pnl", []), dtype=float)
        confidence = float(body.get("confidence", 0.95))

        if len(pnl) < 10:
            return jsonify({"error": "Need at least 10 P&L paths"}), 400

        # 1-day VaR: percentile of terminal P&L distribution
        alpha = 1 - confidence
        var_1d = float(-np.percentile(pnl, alpha * 100))

        # 5-day VaR (square-root-of-time scaling — simplified)
        var_5d = float(var_1d * np.sqrt(5))

        # CVaR (expected shortfall): mean of losses beyond VaR
        tail = pnl[pnl < -var_1d]
        cvar_1d = float(-tail.mean()) if len(tail) > 0 else var_1d

        return jsonify({
            "var_1d": round(var_1d, 2),
            "var_5d": round(var_5d, 2),
            "cvar_1d": round(cvar_1d, 2),
            "confidence": confidence,
            "n_paths": len(pnl),
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/risk/exposure", methods=["POST"])
def risk_exposure():
    """Dollar-greeks, concentration, vega ladder, and an expiration/pin-risk
    calendar from already-computed per-position greeks + market prices."""
    try:
        body = request.json or {}
        position_greeks = body.get("positionGreeks") or body.get("positions") or []
        market = body.get("marketData", {})
        return jsonify({
            "exposure": _compute_exposure_metrics(position_greeks, market),
            "expiryCalendar": _compute_expiry_calendar(position_greeks, market),
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/risk/factors", methods=["POST"])
def risk_factors():
    """Realized-vs-implied vol, sector rollup, and benchmark-relative metrics.

    Network-dependent (yfinance) and best-effort: each piece is wrapped so a
    single failed lookup degrades gracefully (vol row / sector → None / "Unknown",
    benchmark → None) rather than failing the whole response. Results are cached
    (price history, sector) so only the first risk-tab load per ticker is slow."""
    try:
        body = request.json or {}
        position_greeks = body.get("positionGreeks") or []
        market = body.get("marketData", {})
        tickers = sorted({(pg.get("ticker") or "").upper() for pg in position_greeks if pg.get("ticker")})
        now_ts = time.time()

        vol_rows = []
        sector_map = {}
        for tkr in tickers:
            closes = None
            try:
                cached = _hist_cache.get(tkr)
                if cached and now_ts - cached[1] < HIST_TTL_S:
                    closes = cached[0]
                else:
                    hist = _yf_call(yf.Ticker(tkr).history, period="6mo")
                    closes = [float(x) for x in hist["Close"].dropna().tolist()]
                    _hist_cache[tkr] = (closes, now_ts)
            except Exception:
                closes = None
            iv = float((market.get(tkr) or {}).get("iv") or 0) or None
            rv20 = _annualized_realized_vol(closes, 20) if closes else None
            rv60 = _annualized_realized_vol(closes, 60) if closes else None
            spread = round(iv - rv20, 1) if (iv is not None and rv20 is not None) else None
            signal = None
            if spread is not None:
                signal = "rich" if spread >= 3 else ("cheap" if spread <= -3 else "fair")
            vol_rows.append({
                "ticker": tkr, "iv": round(iv, 1) if iv is not None else None,
                "rv20": rv20, "rv60": rv60, "ivRvSpread": spread, "signal": signal,
            })
            try:
                cached = _sector_cache.get(tkr)
                if cached and now_ts - cached[1] < SECTOR_TTL_S:
                    sector_map[tkr] = cached[0]
                else:
                    info = _yf_call(lambda: yf.Ticker(tkr).info)
                    sec = (info or {}).get("sector") or "Unknown"
                    sector_map[tkr] = sec
                    _sector_cache[tkr] = (sec, now_ts)
            except Exception:
                sector_map[tkr] = "Unknown"

        sectors = _rollup_by_sector(position_greeks, market, sector_map)

        benchmark = None
        try:
            cached = _hist_cache.get("__SPY_CLOSES__")
            if cached and now_ts - cached[1] < HIST_TTL_S:
                spy_by_date = cached[0]
            else:
                spy_hist = _yf_call(yf.Ticker("SPY").history, period="1y")
                spy_by_date = {str(idx.date()): float(c) for idx, c in spy_hist["Close"].dropna().items()}
                _hist_cache["__SPY_CLOSES__"] = (spy_by_date, now_ts)
            conn = get_db()
            rows = conn.execute(
                "SELECT timestamp, unrealized_pnl, book_value FROM portfolio_book_snapshots ORDER BY id ASC"
            ).fetchall()
            conn.close()
            book_points = [
                {"timestamp": r["timestamp"], "unrealizedPnl": r["unrealized_pnl"], "bookValue": r["book_value"]}
                for r in rows
            ]
            benchmark = _compute_benchmark_metrics(book_points, spy_by_date)
            try:
                bw_dd = 0.0
                for pg in position_greeks:
                    tkr = (pg.get("ticker") or "").upper()
                    spot = float((market.get(tkr) or {}).get("price") or 0)
                    bcache = _beta_cache.get(tkr)
                    beta = bcache[0] if bcache else 1.0
                    bw_dd += float(pg.get("delta") or 0) * spot * beta
                benchmark = benchmark or {}
                benchmark["betaWeightedDollarDelta"] = round(bw_dd, 2)
            except Exception:
                pass
        except Exception:
            pass

        return jsonify({"volComparison": vol_rows, "sectors": sectors, "benchmark": benchmark})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/")
def index():
    use_bundle = os.environ.get("USE_JS_BUNDLE", "").lower() in ("1", "true", "yes")
    if use_bundle:
        import importlib.util

        spec = importlib.util.spec_from_file_location(
            "frontend_scripts",
            os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools", "frontend_scripts.py"),
        )
        mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(mod)
        if mod.bundle_available():
            html_path = os.path.join(app.static_folder, "index.html")
            with open(html_path, encoding="utf-8") as f:
                html = f.read()
            if mod.MARKER_START in html and mod.MARKER_END in html:
                block = f"{mod.MARKER_START}\n{mod.render_script_block('bundle')}\n{mod.MARKER_END}"
                html = re.sub(
                    re.escape(mod.MARKER_START) + r".*?" + re.escape(mod.MARKER_END),
                    block,
                    html,
                    count=1,
                    flags=re.DOTALL,
                )
                return html, 200, {"Content-Type": "text/html; charset=utf-8"}
    return send_from_directory("static", "index.html")


@app.route("/<path:path>")
def static_files(path):
    return send_from_directory("static", path)


if __name__ == "__main__":  # pragma: no cover
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "5000"))
    debug = os.environ.get("FLASK_DEBUG", "1").lower() in ("1", "true", "yes")
    url_host = "localhost" if host in ("0.0.0.0", "::") else host
    print("=" * 50)
    print("  Options Dashboard")
    print(f"  Open http://{url_host}:{port}")
    print("=" * 50)
    app.run(debug=debug, host=host, port=port, use_reloader=debug)
# end of app.py
