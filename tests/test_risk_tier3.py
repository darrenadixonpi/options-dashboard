"""Tier-3 factor tests — realized-vs-implied vol, sector rollup, benchmark.

Pure helpers fed synthetic inputs (no network); the `/api/risk/factors` endpoint
is smoke-tested for shape (it returns gracefully even when yfinance is offline).
"""

import numpy as np
import pandas as pd

from app import (
    app,
    _annualized_realized_vol,
    _rollup_by_sector,
    _compute_benchmark_metrics,
)


# ─── Realized vol ─────────────────────────────────────────────────────────────

def test_realized_vol_matches_formula():
    rng = np.random.default_rng(3)
    rets = rng.normal(0, 0.012, 40)
    closes = (100 * np.exp(np.cumsum(np.concatenate([[0], rets])))).tolist()  # 41 closes
    expected = round(float(np.std(rets[-20:], ddof=1) * np.sqrt(252) * 100), 1)
    assert _annualized_realized_vol(closes, 20) == expected


def test_realized_vol_constant_series_is_zero():
    assert _annualized_realized_vol([100.0] * 30, 20) == 0.0


def test_realized_vol_guards_short_series():
    assert _annualized_realized_vol([100, 101], 20) is None
    assert _annualized_realized_vol([], 20) is None


# ─── Sector rollup ────────────────────────────────────────────────────────────

def test_sector_rollup_groups_and_concentration():
    pg = [{"ticker": "AAA", "delta": 100}, {"ticker": "BBB", "delta": -50}, {"ticker": "CCC", "delta": 20}]
    mkt = {"AAA": {"price": 50}, "BBB": {"price": 100}, "CCC": {"price": 10}}
    sm = {"AAA": "Tech", "BBB": "Tech", "CCC": "Energy"}
    r = _rollup_by_sector(pg, mkt, sm)
    secs = {s["sector"]: s for s in r["sectors"]}
    # Tech: |5000| + |-5000| = 10000 gross, net 0; Energy 200
    assert secs["Tech"]["absDollarDelta"] == 10000.0
    assert secs["Tech"]["dollarDelta"] == 0.0
    assert secs["Energy"]["absDollarDelta"] == 200.0
    assert r["grossDollarDelta"] == 10200.0
    assert r["sectors"][0]["sector"] == "Tech"        # sorted by abs desc
    expected_hhi = round((10000 / 10200) ** 2 + (200 / 10200) ** 2, 4)
    assert r["hhi"] == expected_hhi


def test_sector_rollup_empty_guard():
    assert _rollup_by_sector([], {}, {}) is None


# ─── Benchmark ────────────────────────────────────────────────────────────────

def test_benchmark_dollar_beta_and_correlation():
    rng = np.random.default_rng(5)
    days = pd.date_range("2026-01-01", periods=12, freq="D")
    spy = 100 * np.cumprod(1 + rng.normal(0.001, 0.01, 12))
    spy[0] = 100.0
    spy_by_date = {str(d.date()): float(v) for d, v in zip(days, spy)}
    spy_ret = np.diff(spy) / spy[:-1]
    # Construct book P&L so each period's change is exactly 500 * SPY return.
    port = np.concatenate([[0.0], np.cumsum(500 * spy_ret)])
    book = [{"timestamp": str(d.date()), "unrealizedPnl": float(p), "bookValue": 10000.0}
            for d, p in zip(days, port)]
    bm = _compute_benchmark_metrics(book, spy_by_date)
    assert abs(bm["dollarBetaPer1pct"] - 5.0) < 0.01   # $500/unit -> $5 per +1%
    assert abs(bm["correlation"] - 1.0) < 1e-6
    assert abs(bm["rSquared"] - 1.0) < 1e-6
    assert bm["nPeriods"] == 11


def test_benchmark_guards_short_series():
    assert _compute_benchmark_metrics([], {}) is None
    assert _compute_benchmark_metrics([{"timestamp": "2026-01-01", "unrealizedPnl": 1}], {"2026-01-01": 100}) is None


# ─── Endpoint smoke ──────────────────────────────────────────────────────────

def test_risk_factors_endpoint_shape():
    client = app.test_client()
    res = client.post("/api/risk/factors", json={
        "positionGreeks": [{"ticker": "AAA", "delta": 100, "posType": "equity"}],
        "marketData": {"AAA": {"price": 50, "iv": 30}},
    })
    assert res.status_code == 200
    body = res.get_json()
    # keys always present; values may be None/Unknown when offline
    assert "volComparison" in body
    assert "sectors" in body
    assert "benchmark" in body
    assert isinstance(body["volComparison"], list)
