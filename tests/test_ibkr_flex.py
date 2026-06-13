"""Tests for the IBKR Flex Web Service client (mocked HTTP, no live token).

Run: pytest tests/test_ibkr_flex.py -v
"""
from __future__ import annotations

import os
from unittest.mock import MagicMock, patch

import pytest

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


def _statement_xml() -> str:
    with open(os.path.join(FIXTURES, "ibkr_flex_statement.xml"), encoding="utf-8") as f:
        return f.read()


SEND_OK = """<FlexStatementResponse timestamp='13 June, 2026 12:00 PM EST'>
<Status>Success</Status>
<ReferenceCode>1234567890</ReferenceCode>
<Url>https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement</Url>
</FlexStatementResponse>"""

SEND_FAIL = """<FlexStatementResponse timestamp='13 June, 2026 12:00 PM EST'>
<Status>Fail</Status>
<ErrorCode>1020</ErrorCode>
<ErrorMessage>Invalid request or unable to validate request.</ErrorMessage>
</FlexStatementResponse>"""

IN_PROGRESS = """<FlexStatementResponse timestamp='13 June, 2026 12:00 PM EST'>
<Status>Warn</Status>
<ErrorCode>1019</ErrorCode>
<ErrorMessage>Statement generation in progress. Please try again shortly.</ErrorMessage>
</FlexStatementResponse>"""


def _resp(text: str, ok: bool = True, status: int = 200):
    m = MagicMock()
    m.ok = ok
    m.status_code = status
    m.text = text
    return m


@pytest.fixture()
def client(tmp_path):
    from ibkr_flex_client import IBKRFlexClient
    return IBKRFlexClient("tok123", "555", config_path=str(tmp_path / "ibkr_flex.json"))


# ─── Config / status ──────────────────────────────────────────────────────────


class TestConfig:
    def test_unconfigured(self, tmp_path):
        from ibkr_flex_client import IBKRFlexClient
        c = IBKRFlexClient("", "", config_path=str(tmp_path / "x.json"))
        assert c.is_configured() is False
        assert c.status()["configured"] is False

    def test_save_and_clear(self, tmp_path):
        from ibkr_flex_client import IBKRFlexClient
        path = str(tmp_path / "ibkr_flex.json")
        c = IBKRFlexClient("", "", config_path=path)
        c.save_config("tokABC", "999")
        assert c.is_configured() and os.path.exists(path)
        # A fresh client loads the saved config from disk.
        c2 = IBKRFlexClient("", "", config_path=path)
        assert c2.is_configured() and c2.status()["query_id"] == "999"
        c.clear_config()
        assert not os.path.exists(path) and c.is_configured() is False

    def test_save_requires_both_fields(self, tmp_path):
        from ibkr_flex_client import IBKRFlexClient, IBKRFlexError
        c = IBKRFlexClient("", "", config_path=str(tmp_path / "x.json"))
        with pytest.raises(IBKRFlexError):
            c.save_config("tokonly", "")


# ─── XML normalization ────────────────────────────────────────────────────────


class TestNormalize:
    def test_parse_positions_xml(self, client):
        legs = client.parse_positions_xml(_statement_xml())
        assert len(legs) == 2  # ZERO (flat) skipped
        opt = [l for l in legs if l["posType"] == "option"][0]
        assert opt["ticker"] == "TEST" and opt["optType"] == "Put"
        assert opt["strike"] == 10.0 and opt["expiry"] == "2026-06-20"
        assert opt["contracts"] == -2 and opt["avgCost"] == 1.25
        assert opt["source"] == "ibkr_flex"
        eq = [l for l in legs if l["posType"] == "equity"][0]
        assert eq["ticker"] == "AAPL" and eq["shares"] == 100 and eq["avgCost"] == 145.0


# ─── Two-step fetch ───────────────────────────────────────────────────────────


class TestFetch:
    def test_get_positions_two_step(self, client):
        responses = [_resp(SEND_OK), _resp(_statement_xml())]
        with patch("ibkr_flex_client.requests.get", side_effect=responses):
            legs = client.get_positions()
        assert len(legs) == 2

    def test_poll_until_ready(self, client):
        responses = [_resp(SEND_OK), _resp(IN_PROGRESS), _resp(_statement_xml())]
        with patch("ibkr_flex_client.requests.get", side_effect=responses), \
             patch("ibkr_flex_client.time.sleep", return_value=None):
            legs = client.get_positions()
        assert len(legs) == 2

    def test_send_request_failure_raises(self, client):
        from ibkr_flex_client import IBKRFlexError
        with patch("ibkr_flex_client.requests.get", return_value=_resp(SEND_FAIL)):
            with pytest.raises(IBKRFlexError, match="1020"):
                client.get_positions()

    def test_not_configured_raises(self, tmp_path):
        from ibkr_flex_client import IBKRFlexClient, IBKRFlexError
        c = IBKRFlexClient("", "", config_path=str(tmp_path / "x.json"))
        with pytest.raises(IBKRFlexError):
            c.fetch_statement()


# ─── Flask route integration tests ────────────────────────────────────────────


class TestIBKRRoutes:
    @pytest.fixture()
    def app_client(self):
        import app as app_mod
        app_mod.app.config["TESTING"] = True
        with app_mod.app.test_client() as c:
            yield c

    def test_status_route(self, app_client):
        with patch("app.get_ibkr_flex_client") as mock_get:
            mock_get.return_value.status.return_value = {"configured": False, "source": "ibkr_flex"}
            resp = app_client.get("/api/ibkr/status")
        assert resp.status_code == 200
        assert json_loads(resp)["configured"] is False

    def test_config_requires_fields(self, app_client):
        resp = app_client.post("/api/ibkr/config", json={"token": ""})
        assert resp.status_code == 400

    def test_config_saves(self, app_client):
        with patch("app.get_ibkr_flex_client") as mock_get:
            mock_get.return_value.save_config.return_value = None
            mock_get.return_value.status.return_value = {"configured": True, "source": "ibkr_flex"}
            resp = app_client.post("/api/ibkr/config", json={"token": "t", "query_id": "5"})
        assert resp.status_code == 200
        assert json_loads(resp)["ok"] is True

    def test_sync_route(self, app_client):
        with patch("app.get_ibkr_flex_client") as mock_get:
            mock_get.return_value.get_positions.return_value = [
                {"ticker": "AAPL", "posType": "equity", "shares": 100, "contracts": 0, "avgCost": 145.0, "source": "ibkr_flex"},
            ]
            resp = app_client.post("/api/ibkr/sync")
        assert resp.status_code == 200
        assert json_loads(resp)["position_count"] == 1

    def test_sync_flex_error_502(self, app_client):
        from ibkr_flex_client import IBKRFlexError
        with patch("app.get_ibkr_flex_client") as mock_get:
            mock_get.return_value.get_positions.side_effect = IBKRFlexError("bad token")
            resp = app_client.post("/api/ibkr/sync")
        assert resp.status_code == 502

    def test_disconnect_route(self, app_client):
        with patch("app.get_ibkr_flex_client") as mock_get:
            mock_get.return_value.clear_config.return_value = None
            resp = app_client.post("/api/ibkr/disconnect")
        assert resp.status_code == 200


def json_loads(resp):
    import json
    return json.loads(resp.data)
