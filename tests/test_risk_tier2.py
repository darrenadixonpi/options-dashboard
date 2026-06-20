"""Tier-2 risk analytics tests — component VaR, dollar-greeks/concentration,
expiration/pin-risk calendar.

Pure helpers are fed synthetic inputs so the expected numbers are hand-computable;
the `/api/risk/exposure` endpoint is smoke-tested through the Flask test client.
"""

import numpy as np
import pandas as pd

from app import (
    app,
    _compute_component_var,
    _compute_exposure_metrics,
    _compute_expiry_calendar,
)


def _future(days):
    return (pd.Timestamp.now().normalize() + pd.Timedelta(days=days)).strftime("%Y-%m-%d")


# ─── Component VaR ────────────────────────────────────────────────────────────

def test_component_var_is_additive_to_cvar():
    rng = np.random.default_rng(0)
    a = rng.normal(0, 100, 5000)
    b = rng.normal(0, 50, 5000)
    cv = _compute_component_var(a + b, {"A": a, "B": b}, 0.95)
    comp_sum = sum(c["componentVar"] for c in cv["components"])
    # Component expected-shortfall contributions sum to portfolio CVaR.
    assert abs(comp_sum - cv["portfolioCvar"]) < 0.05
    assert abs(sum(c["pct"] for c in cv["components"]) - 100) < 0.5


def test_component_var_higher_vol_dominates_and_diversifies():
    rng = np.random.default_rng(1)
    a = rng.normal(0, 100, 4000)
    b = rng.normal(0, 50, 4000)
    cv = _compute_component_var(a + b, {"A": a, "B": b}, 0.95)
    assert cv["components"][0]["ticker"] == "A"          # bigger tail driver
    assert cv["diversificationBenefit"] > 0              # sum standalone > portfolio


def test_component_var_guards():
    assert _compute_component_var([1, 2, 3], {"A": [1, 2, 3]}) is None
    assert _compute_component_var(list(range(20)), {}) is None


# ─── Dollar-greeks + concentration ───────────────────────────────────────────

_PG = [
    {"ticker": "AAA", "posType": "equity", "delta": 100, "gamma": 0, "theta": 0, "vega": 0},
    {"ticker": "BBB", "optType": "Put", "strike": 95, "expiry": _future(14),
     "contracts": 3, "delta": -30, "gamma": 2, "theta": 5, "vega": 12},
]
_MKT = {"AAA": {"price": 50}, "BBB": {"price": 100}}


def test_exposure_dollar_greeks_math():
    ex = _compute_exposure_metrics(_PG, _MKT)
    assert ex["byTicker"]["AAA"]["dollarDelta"] == 5000.0     # 100 sh * $50
    assert ex["byTicker"]["BBB"]["dollarDelta"] == -3000.0    # -30 * $100
    assert ex["byTicker"]["BBB"]["dollarGamma1pct"] == 200.0  # 2 * 100^2 * 0.01
    assert ex["portfolio"]["dollarDelta"] == 2000.0


def test_exposure_concentration_hhi():
    ex = _compute_exposure_metrics(_PG, _MKT)
    c = ex["concentration"]
    assert c["grossDollarDelta"] == 8000.0
    assert c["netDollarDelta"] == 2000.0
    # (5000/8000)^2 + (3000/8000)^2 = 0.5313
    assert abs(c["hhi"] - 0.5313) < 0.001
    assert c["topName"] == "AAA"


def test_exposure_vega_ladder_buckets():
    ex = _compute_exposure_metrics(_PG, _MKT)
    ladder = {v["bucket"]: v["vega"] for v in ex["vegaLadder"]}
    assert ladder["8-21"] == 12.0    # 14 DTE put
    assert ladder["0-7"] == 0.0


def test_exposure_empty_guard():
    assert _compute_exposure_metrics([], {}) is None


# ─── Expiration / pin-risk calendar ──────────────────────────────────────────

def test_expiry_calendar_pin_risk_and_sort():
    pg = [
        {"ticker": "BBB", "optType": "Put", "strike": 99, "expiry": _future(5),
         "contracts": 2, "delta": -40, "gamma": 3, "vega": 8},
        {"ticker": "CCC", "optType": "Call", "strike": 120, "expiry": _future(60),
         "contracts": 1, "delta": 20, "gamma": 1, "vega": 15},
    ]
    mkt = {"BBB": {"price": 100}, "CCC": {"price": 100}}
    cal = _compute_expiry_calendar(pg, mkt)
    assert cal[0]["dte"] == 5 and cal[1]["dte"] == 60       # sorted ascending
    assert cal[0]["pinRisk"] is True                        # 5 DTE, 1% from strike
    assert cal[1]["pinRisk"] is False                       # 60 DTE, 20% away
    assert cal[0]["legs"] == 2 and cal[0]["netDelta"] == -40.0
    assert cal[1]["nearestStrikePct"] == 20.0


def test_expiry_calendar_excludes_equity_and_empty():
    assert _compute_expiry_calendar([{"ticker": "X", "posType": "equity", "delta": 100}], {"X": {"price": 10}}) == []
    assert _compute_expiry_calendar([], {}) is None


# ─── Endpoint smoke ──────────────────────────────────────────────────────────

def test_risk_exposure_endpoint_shape():
    client = app.test_client()
    res = client.post("/api/risk/exposure", json={"positionGreeks": _PG, "marketData": _MKT})
    assert res.status_code == 200
    body = res.get_json()
    assert body["exposure"]["portfolio"]["dollarDelta"] == 2000.0
    assert isinstance(body["expiryCalendar"], list)
