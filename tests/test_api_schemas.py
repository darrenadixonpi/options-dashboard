"""Tests for Pydantic API response schemas."""

import pytest
from pydantic import ValidationError

from api_schemas import (
    GreeksResponse,
    Histogram,
    PnlStats,
    SimulateResponse,
    ThetaData,
    validate_response,
)


def _sample_pnl_stats(**overrides):
    base = {
        "mean": 100.0,
        "median": 95.0,
        "p5": -500.0,
        "p25": -100.0,
        "p75": 300.0,
        "p95": 800.0,
        "min": -1200.0,
        "max": 1500.0,
        "prob_profit": 62.5,
    }
    base.update(overrides)
    return base


def _sample_histogram(n_bins=60):
    return {
        "counts": [10] * n_bins,
        "edges": [float(i * 100) for i in range(n_bins + 1)],
    }


def _sample_theta():
    return {
        "dates": ["May-22", "May-23", "May-24"],
        "groups": [
            {
                "label": "Jun 20 '26 (TEST)",
                "color": "#e05555",
                "daily": [12.5, 11.0, -8.0],
                "expiry": "2026-06-20",
            }
        ],
        "totalDaily": [12.5, 11.0, -8.0],
        "cumulative": [12.5, 23.5, 15.5],
        "cumulativeNet": [12.5, 23.5, 15.5],
        "milestones": [],
        "todayTheta": 12.5,
        "todayEarned": 12.5,
        "todayCost": 0.0,
        "totalCumulative": 15.5,
        "totalCumulativeNet": 15.5,
        "nextExpiry": "Jun 20",
        "postNextTheta": 5.0,
    }


def _sample_simulate():
    return {
        "n_paths": 1000,
        "portfolio": _sample_pnl_stats(),
        "by_ticker": {
            "TEST": {
                **_sample_pnl_stats(),
                "model": "gbm",
                "reason": "Normal vol",
                "price": 100.0,
                "iv": 45.0,
            }
        },
        "by_strategy": {"TEST Short Put": _sample_pnl_stats()},
        "histogram": _sample_histogram(),
        "portfolio_pnl": [100.0, -50.0, 200.0],
        "ticker_histograms": {"TEST": _sample_histogram(40)},
        "ticker_paths": {
            "TEST": {
                "dates": ["May-22", "May-23"],
                "p5": [98.0, 97.0],
                "p25": [99.0, 98.5],
                "p50": [100.0, 100.0],
                "p75": [101.0, 101.5],
                "p95": [102.0, 103.0],
                "mean": [100.0, 100.5],
                "strikes": [],
                "breakevens": [],
                "model": "gbm",
                "shares": 0,
                "adjCost": None,
            }
        },
        "theta": _sample_theta(),
        "correlation": None,
    }


class TestApiSchemas:
    def test_pnl_stats_validates(self):
        stats = PnlStats.model_validate(_sample_pnl_stats())
        assert stats.prob_profit == 62.5

    def test_histogram_edge_count(self):
        h = Histogram.model_validate(_sample_histogram(60))
        assert len(h.edges) == len(h.counts) + 1

    def test_theta_accepts_signed_daily(self):
        theta = ThetaData.model_validate(_sample_theta())
        assert theta.groups[0].daily[2] == -8.0
        assert theta.todayCost == 0.0

    def test_simulate_response_roundtrip(self):
        payload = _sample_simulate()
        out = validate_response(SimulateResponse, payload)
        assert out["n_paths"] == 1000
        assert out["theta"]["groups"][0]["daily"][2] == -8.0

    def test_simulate_theta_optional(self):
        payload = _sample_simulate()
        payload["theta"] = None
        out = validate_response(SimulateResponse, payload)
        assert out["theta"] is None

    def test_simulate_rejects_missing_portfolio(self):
        payload = _sample_simulate()
        del payload["portfolio"]
        with pytest.raises(ValidationError):
            SimulateResponse.model_validate(payload)

    def test_greeks_response_minimal(self):
        payload = {
            "positions": [{"ticker": "TEST", "delta": 100, "gamma": 0, "theta": -5, "vega": 10}],
            "byTicker": {"TEST": {"delta": 100, "gamma": 0, "theta": -5, "vega": 10}},
            "portfolio": {"delta": 100, "gamma": 0, "theta": -5, "vega": 10},
            "betaWeighted": None,
            "risk": {"maxLoss": 5000},
        }
        out = validate_response(GreeksResponse, payload)
        assert out["portfolio"]["delta"] == 100
