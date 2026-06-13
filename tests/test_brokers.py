"""Tests for Phase 7.1 — unified broker adapter layer (brokers/ package + routes).

No live credentials or network required. CSV adapters run against fixtures;
the Schwab API path is mocked at schwab_client.get_schwab_client.
Run: pytest tests/test_brokers.py -v
"""
from __future__ import annotations

import json
import os
from datetime import date, datetime
from unittest.mock import MagicMock, patch

import pytest

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


def _read(name: str) -> str:
    with open(os.path.join(FIXTURES, name), encoding="utf-8") as f:
        return f.read()


@pytest.fixture()
def fidelity_positions_text():
    return _read("fidelity_positions.csv")


@pytest.fixture()
def ibkr_positions_text():
    return _read("ibkr_positions.csv")


@pytest.fixture()
def schwab_positions_text():
    return _read("schwab_positions.csv")


# ─── Registry / factory ───────────────────────────────────────────────────────


class TestRegistry:
    def test_lists_all_brokers(self):
        from brokers import list_adapters
        keys = {b["key"] for b in list_adapters()}
        assert {"fidelity", "schwab", "ibkr"} <= keys

    def test_capability_shape(self):
        from brokers import list_adapters
        by_key = {b["key"]: b for b in list_adapters()}
        assert by_key["schwab"]["source"] == "api"
        assert by_key["schwab"]["oauth"] is True
        assert by_key["fidelity"]["source"] == "csv"
        assert by_key["fidelity"]["oauth"] is False
        for cap in by_key.values():
            assert set(cap) == {"key", "label", "source", "positions", "history", "oauth", "api_sync"}
        assert by_key["ibkr"]["api_sync"] is True   # CSV broker + Flex Web Service sync
        assert by_key["fidelity"]["api_sync"] is False

    def test_get_adapter_case_insensitive(self):
        from brokers import get_adapter
        assert get_adapter("FIDELITY").key == "fidelity"
        assert get_adapter("  Schwab ").key == "schwab"

    def test_unknown_broker_raises(self):
        from brokers import BrokerNotFound, get_adapter
        with pytest.raises(BrokerNotFound):
            get_adapter("etrade")


# ─── Canonical normalizer ─────────────────────────────────────────────────────


class TestNormalizeLeg:
    def test_short_option_signed(self):
        from brokers import normalize_leg
        leg = normalize_leg(
            {"ticker": "aapl", "optType": "put", "strike": 150, "expiry": "2026-06-20", "contracts": -2, "avgCost": 2.5},
            source="x",
        )
        assert leg == {
            "ticker": "AAPL", "posType": "option", "optType": "Put", "strike": 150.0,
            "expiry": "2026-06-20", "contracts": -2, "shares": 0, "avgCost": 2.5, "source": "x",
        }

    def test_flat_position_dropped(self):
        from brokers import normalize_leg
        assert normalize_leg({"ticker": "X", "posType": "equity", "shares": 0}) is None
        assert normalize_leg({"ticker": "X", "posType": "option", "optType": "Put",
                              "strike": 10, "expiry": "2026-06-20", "contracts": 0}) is None

    def test_incomplete_option_dropped(self):
        from brokers import normalize_leg
        # missing expiry
        assert normalize_leg({"ticker": "X", "optType": "Call", "strike": 10, "contracts": 1}) is None
        # missing/zero strike
        assert normalize_leg({"ticker": "X", "optType": "Call", "expiry": "2026-06-20", "contracts": 1}) is None

    def test_expiry_coercion_variants(self):
        from brokers import normalize_leg
        for exp in ["2026-06-20T00:00:00+0000", "2026-06-20 00:00:00", "06/20/2026", date(2026, 6, 20), datetime(2026, 6, 20)]:
            leg = normalize_leg({"ticker": "X", "optType": "Put", "strike": 10, "expiry": exp, "contracts": 1})
            assert leg["expiry"] == "2026-06-20", exp

    def test_equity_falls_back_to_contracts(self):
        from brokers import normalize_leg
        leg = normalize_leg({"ticker": "msft", "posType": "equity", "contracts": 50, "avgCost": 300})
        assert leg["posType"] == "equity" and leg["shares"] == 50 and leg["contracts"] == 0

    def test_standard_occ_strike_padding(self):
        # padded OCC strike 00150000 -> 150.0, not 150000
        from brokers.csvutil import parse_occ
        assert parse_occ("AAPL260620C00150000")["strike"] == 150.0
        # fidelity decimal strike stays literal
        assert parse_occ("-OVID260618P2.5")["strike"] == 2.5


# ─── CSV adapters ─────────────────────────────────────────────────────────────


class TestFidelityAdapter:
    def test_parse_positions(self, fidelity_positions_text):
        from brokers import get_adapter
        legs = get_adapter("fidelity").parse_positions(fidelity_positions_text)
        assert len(legs) == 2  # Pending Activity row skipped
        opt = [l for l in legs if l["posType"] == "option"][0]
        assert opt["ticker"] == "TEST" and opt["optType"] == "Put"
        assert opt["strike"] == 10.0 and opt["contracts"] == -2 and opt["avgCost"] == 1.25
        eq = [l for l in legs if l["posType"] == "equity"][0]
        assert eq["ticker"] == "AAPL" and eq["shares"] == 100 and eq["avgCost"] == 145.0
        assert all(l["source"] == "fidelity_csv" for l in legs)

    def test_parse_history_opens(self):
        from brokers import get_adapter
        fills = get_adapter("fidelity").parse_history(_read("fidelity_history.csv"))
        assert len(fills) >= 2
        test = [f for f in fills if f["ticker"] == "TEST"][0]
        assert test["optType"] == "Put" and test["strike"] == 10.0 and test["quantity"] == 2
        assert test["expiry"] == "2026-06-20"


class TestIBKRAdapter:
    def test_parse_positions(self, ibkr_positions_text):
        from brokers import get_adapter
        legs = get_adapter("ibkr").parse_positions(ibkr_positions_text)
        assert len(legs) == 2  # Total row skipped
        opt = [l for l in legs if l["posType"] == "option"][0]
        assert opt["ticker"] == "TEST" and opt["optType"] == "Put"
        assert opt["strike"] == 10.0 and opt["contracts"] == -1 and opt["avgCost"] == 1.25
        eq = [l for l in legs if l["posType"] == "equity"][0]
        assert eq["ticker"] == "AAPL" and eq["shares"] == 100
        assert all(l["source"] == "ibkr_csv" for l in legs)

    def test_parse_history_opens(self):
        from brokers import get_adapter
        fills = get_adapter("ibkr").parse_history(_read("ibkr_history.csv"))
        assert len(fills) >= 2
        assert any(f["ticker"] == "TEST" and f["optType"] == "Put" for f in fills)


class TestSchwabAdapter:
    def test_capabilities(self):
        from brokers import get_adapter
        a = get_adapter("schwab")
        assert a.source == "api" and a.supports_oauth is True

    def test_parse_csv_positions(self, schwab_positions_text):
        from brokers import get_adapter
        legs = get_adapter("schwab").parse_positions(schwab_positions_text)
        assert len(legs) == 2  # cash row skipped
        opt = [l for l in legs if l["posType"] == "option"][0]
        assert opt["ticker"] == "TEST" and opt["strike"] == 10.0 and opt["contracts"] == -1
        assert opt["avgCost"] == 1.25 and opt["source"] == "schwab_csv"

    def test_sync_positions_delegates_to_client(self):
        from brokers import get_adapter
        fake = MagicMock()
        fake.get_positions.return_value = [
            {"ticker": "AAPL", "posType": "option", "optType": "Call", "strike": 150.0,
             "expiry": "2023-01-20", "contracts": -1, "shares": 0, "avgCost": 2.5, "source": "schwab_api"},
            {"ticker": "AAPL", "posType": "equity", "shares": 100, "contracts": 0, "avgCost": 145.0, "source": "schwab_api"},
        ]
        with patch("schwab_client.get_schwab_client", return_value=fake):
            legs = get_adapter("schwab").sync_positions()
        assert len(legs) == 2
        assert legs[0]["contracts"] == -1 and legs[1]["shares"] == 100
        assert all(l["source"] == "schwab_api" for l in legs)

    def test_status_delegates(self):
        from brokers import get_adapter
        fake = MagicMock()
        fake.status.return_value = {"configured": True, "authenticated": False}
        with patch("schwab_client.get_schwab_client", return_value=fake):
            assert get_adapter("schwab").status()["configured"] is True

    def test_get_positions_dispatch_csv_over_api(self, schwab_positions_text):
        # When CSV text is supplied, the API client must not be called.
        from brokers import get_adapter
        fake = MagicMock()
        with patch("schwab_client.get_schwab_client", return_value=fake):
            legs = get_adapter("schwab").get_positions(schwab_positions_text)
        fake.get_positions.assert_not_called()
        assert len(legs) == 2


# ─── Flask routes ─────────────────────────────────────────────────────────────


class TestBrokerRoutes:
    def test_list_route(self, client):
        resp = client.get("/api/brokers")
        assert resp.status_code == 200
        data = json.loads(resp.data)
        keys = {b["key"] for b in data["brokers"]}
        assert {"fidelity", "schwab", "ibkr"} <= keys

    def test_status_route_csv_broker(self, client):
        resp = client.get("/api/brokers/fidelity/status")
        assert resp.status_code == 200
        assert json.loads(resp.data)["configured"] is True

    def test_status_route_unknown_404(self, client):
        resp = client.get("/api/brokers/nope/status")
        assert resp.status_code == 404

    def test_positions_route_fidelity_csv(self, client, fidelity_positions_text):
        resp = client.post("/api/brokers/fidelity/positions",
                           json={"csv": fidelity_positions_text})
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert data["broker"] == "fidelity" and data["source"] == "csv"
        assert data["position_count"] == 2

    def test_positions_route_ibkr_csv(self, client, ibkr_positions_text):
        resp = client.post("/api/brokers/ibkr/positions", json={"csv": ibkr_positions_text})
        assert resp.status_code == 200
        assert json.loads(resp.data)["position_count"] == 2

    def test_positions_route_schwab_api_sync(self, client):
        fake = MagicMock()
        fake.get_positions.return_value = [
            {"ticker": "AAPL", "posType": "equity", "shares": 100, "contracts": 0, "avgCost": 145.0, "source": "schwab_api"},
        ]
        with patch("schwab_client.get_schwab_client", return_value=fake):
            resp = client.post("/api/brokers/schwab/positions", json={})
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert data["source"] == "api" and data["position_count"] == 1

    def test_positions_route_schwab_needs_reauth_401(self, client):
        from schwab_client import SchwabAuthError
        fake = MagicMock()
        fake.get_positions.side_effect = SchwabAuthError("Not authenticated")
        with patch("schwab_client.get_schwab_client", return_value=fake):
            resp = client.post("/api/brokers/schwab/positions", json={})
        assert resp.status_code == 401
        assert json.loads(resp.data)["needs_reauth"] is True

    def test_positions_route_unknown_404(self, client):
        resp = client.post("/api/brokers/etrade/positions", json={"csv": "x"})
        assert resp.status_code == 404
