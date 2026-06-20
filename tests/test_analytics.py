"""Analytics tests — drawdown metrics, trade cohorts, attribution timeline.

Locks in the first-sprint analytics features:
  1. Drawdown analytics on the realized cumulative-P&L (equity) curve.
  2. Trade-performance cohorts (underlying / hold / DTE / month / weekday).
  3. The cumulative P&L attribution timeline endpoint shape.

The pure helpers are fed synthetic series/trades so the expected numbers are
hand-computable; the endpoint is smoke-tested through the Flask test client.
"""

import pytest

from app import app, _compute_drawdown_metrics, _compute_trade_cohorts


# ─── Drawdown ────────────────────────────────────────────────────────────────

def _series(pairs):
    return [{"date": d, "dayPnl": 0.0, "cumPnl": c} for d, c in pairs]


def test_drawdown_basic_peak_trough_recovery():
    # cum: 0 -> 100 (peak) -> 60 (trough, -40) -> 150 (new high = recovered)
    dd = _compute_drawdown_metrics(_series([
        ("2026-01-01", 0), ("2026-01-02", 100),
        ("2026-01-05", 60), ("2026-01-09", 150),
    ]))
    assert dd["maxDrawdown"] == -40.0
    assert dd["maxDrawdownPct"] == -40.0          # -40 off a +100 peak
    assert dd["peakDate"] == "2026-01-02"
    assert dd["troughDate"] == "2026-01-05"
    assert dd["recoveryDate"] == "2026-01-09"
    assert dd["daysToRecover"] == 7               # Jan 2 -> Jan 9
    assert dd["stillUnderwater"] is False
    assert dd["currentDrawdown"] == 0.0
    assert dd["recoveryFactor"] == 3.75           # 150 / 40
    assert len(dd["underwater"]) == 4


def test_drawdown_still_underwater_and_longest_stretch():
    dd = _compute_drawdown_metrics(_series([
        ("2026-02-01", 0), ("2026-02-03", 50), ("2026-02-10", 20),
    ]))
    assert dd["stillUnderwater"] is True
    assert dd["recoveryDate"] is None
    assert dd["daysToRecover"] is None
    assert dd["longestUnderwaterDays"] == 7       # Feb 3 peak -> Feb 10 end


def test_drawdown_monotonic_curve_has_no_drawdown():
    dd = _compute_drawdown_metrics(_series([
        ("2026-03-01", 10), ("2026-03-02", 20), ("2026-03-03", 35),
    ]))
    assert dd["maxDrawdown"] == 0.0
    assert dd["recoveryFactor"] is None           # undefined with no drawdown


def test_drawdown_guards_short_series():
    assert _compute_drawdown_metrics([]) is None
    assert _compute_drawdown_metrics(_series([("2026-01-01", 5)])) is None


# ─── Cohorts ─────────────────────────────────────────────────────────────────

_TRADES = [
    {"ticker": "AAA", "strategy": "Short Put", "pnl": 100, "isWin": True,
     "holdDays": 3, "instrument": "option", "expiry": "2026-01-15",
     "openDate": "2026-01-02", "closeDate": "2026-01-05"},
    {"ticker": "AAA", "strategy": "Short Put", "pnl": -50, "isWin": False,
     "holdDays": 20, "instrument": "option", "expiry": "2026-02-20",
     "openDate": "2026-01-10", "closeDate": "2026-01-30"},
    {"ticker": "BBB", "strategy": "Covered Call", "pnl": 30, "isWin": True,
     "holdDays": 0, "instrument": "option", "expiry": "2026-01-03",
     "openDate": "2026-01-03", "closeDate": "2026-01-03"},
    {"ticker": "BBB", "strategy": "Long Shares", "pnl": 200, "isWin": True,
     "holdDays": 120, "instrument": "equity", "expiry": None,
     "openDate": "2025-09-01", "closeDate": "2026-01-30"},
]


def test_cohorts_by_underlying_aggregates_and_sorts():
    co = _compute_trade_cohorts(_TRADES)
    by = {r["key"]: r for r in co["byUnderlying"]}
    assert by["AAA"]["trades"] == 2
    assert by["AAA"]["totalPnl"] == 50.0
    assert by["AAA"]["wins"] == 1
    assert by["AAA"]["winRate"] == 50.0
    assert by["AAA"]["profitFactor"] == 2.0       # 100 / 50
    # BBB total = 230 > AAA 50 -> sorted by total P&L descending
    assert co["byUnderlying"][0]["key"] == "BBB"


def test_cohorts_hold_buckets_ordered():
    co = _compute_trade_cohorts(_TRADES)
    keys = [r["key"] for r in co["byHoldBucket"]]
    assert keys == ["0 (same day)", "1-7d", "8-30d", "90d+"]


def test_cohorts_dte_excludes_equity():
    co = _compute_trade_cohorts(_TRADES)
    keys = {r["key"] for r in co["byDteAtEntry"]}
    assert keys == {"0-7 DTE", "8-21 DTE", "22-45 DTE"}
    assert sum(r["trades"] for r in co["byDteAtEntry"]) == 3   # equity dropped


def test_cohorts_month_and_weekday():
    co = _compute_trade_cohorts(_TRADES)
    assert {r["key"]: r for r in co["byMonth"]}["2026-01"]["trades"] == 4
    # Jan 5 2026 is a Monday -> first weekday cohort row
    assert co["byWeekday"][0]["key"] == "Mon"


def test_cohorts_empty_guard():
    assert _compute_trade_cohorts([]) is None


# ─── Attribution timeline endpoint (smoke) ───────────────────────────────────

def test_attribution_timeline_endpoint_shape():
    client = app.test_client()
    res = client.get("/api/snapshots/attribution-timeline?limit=10")
    assert res.status_code == 200
    body = res.get_json()
    assert "points" in body
    assert "residualAvailable" in body
    for p in body["points"]:
        # cumulative keys present and numeric
        for k in ("cumPrice", "cumGamma", "cumTheta", "cumVega", "cumTotal"):
            assert k in p
            assert isinstance(p[k], (int, float))
