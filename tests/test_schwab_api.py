"""Tests for Phase 6 — Schwab API client and Flask routes.

All tests use mocked HTTP calls (no live Schwab credentials required).
Run: pytest tests/test_schwab_api.py -v
"""
from __future__ import annotations

import json
import os
import time
from unittest.mock import MagicMock, patch

import pytest

# ─── Fixtures ────────────────────────────────────────────────────────────────


@pytest.fixture()
def tmp_token(tmp_path):
    """Return a writable token file path under tmp_path."""
    return str(tmp_path / "schwab_token.json")


@pytest.fixture()
def client_unconfigured(tmp_token):
    from schwab_client import SchwabClient
    return SchwabClient("", "", token_path=tmp_token)


@pytest.fixture()
def client_configured(tmp_token):
    from schwab_client import SchwabClient
    return SchwabClient("test_key", "test_secret", token_path=tmp_token)


@pytest.fixture()
def client_authenticated(tmp_token):
    from schwab_client import SchwabClient
    c = SchwabClient("test_key", "test_secret", token_path=tmp_token)
    # Seed token file
    tokens = {
        "access_token": "access_abc",
        "refresh_token": "refresh_xyz",
        "expires_in": 1800,
        "fetched_at": time.time(),
        "access_fetched_at": time.time(),
    }
    with open(tmp_token, "w") as f:
        json.dump(tokens, f)
    c._load_tokens()
    return c


# ─── SchwabClient unit tests ─────────────────────────────────────────────────


class TestSchwabClientConfig:
    def test_unconfigured_is_not_configured(self, client_unconfigured):
        assert client_unconfigured.is_configured() is False

    def test_configured_is_configured(self, client_configured):
        assert client_configured.is_configured() is True

    def test_not_authenticated_without_token(self, client_configured):
        assert client_configured.is_authenticated() is False

    def test_authenticated_after_loading_token(self, client_authenticated):
        assert client_authenticated.is_authenticated() is True

    def test_status_not_configured(self, client_unconfigured):
        s = client_unconfigured.status()
        assert s["configured"] is False
        assert s["authenticated"] is False

    def test_status_authenticated(self, client_authenticated):
        s = client_authenticated.status()
        assert s["configured"] is True
        assert s["authenticated"] is True
        assert s["needs_reauth"] is False
        assert s["token_age_hours"] is not None and s["token_age_hours"] >= 0


class TestSchwabAuthUrl:
    def test_get_auth_url_contains_client_id(self, client_configured):
        url = client_configured.get_auth_url()
        assert "test_key" in url
        assert "api.schwabapi.com" in url
        assert "response_type=code" in url

    def test_get_auth_url_raises_when_not_configured(self, client_unconfigured):
        from schwab_client import SchwabAuthError
        with pytest.raises(SchwabAuthError):
            client_unconfigured.get_auth_url()


class TestHandleCallback:
    def test_raises_on_missing_code(self, client_configured):
        from schwab_client import SchwabAuthError
        with pytest.raises(SchwabAuthError, match="No 'code'"):
            client_configured.handle_callback("https://127.0.0.1:8182?session=abc")

    def test_exchanges_code_and_saves_token(self, client_configured, tmp_token):
        mock_resp = MagicMock()
        mock_resp.ok = True
        mock_resp.json.return_value = {
            "access_token": "new_access",
            "refresh_token": "new_refresh",
            "expires_in": 1800,
        }
        with patch("schwab_client.requests.post", return_value=mock_resp) as mock_post:
            client_configured.handle_callback("https://127.0.0.1:8182?code=AUTHCODE123&session=s")
            mock_post.assert_called_once()
            # Code should be in the POST data
            _, kwargs = mock_post.call_args
            assert kwargs["data"]["code"] == "AUTHCODE123"
            assert kwargs["data"]["grant_type"] == "authorization_code"

        assert client_configured.is_authenticated()
        assert os.path.exists(tmp_token)

    def test_raises_on_bad_token_response(self, client_configured):
        from schwab_client import SchwabAuthError
        mock_resp = MagicMock()
        mock_resp.ok = False
        mock_resp.status_code = 400
        mock_resp.text = "Bad request"
        with patch("schwab_client.requests.post", return_value=mock_resp):
            with pytest.raises(SchwabAuthError, match="Token exchange failed"):
                client_configured.handle_callback("https://127.0.0.1:8182?code=BAD&session=s")


class TestGetPositions:
    _SAMPLE_ACCOUNTS = [
        {
            "securitiesAccount": {
                "accountNumber": "12345678",
                "positions": [
                    {
                        "shortQuantity": 1.0,
                        "longQuantity": 0.0,
                        "averagePrice": 2.50,
                        "instrument": {
                            "assetType": "OPTION",
                            "symbol": "AAPL  230120C00150000",
                            "underlyingSymbol": "AAPL",
                            "putCall": "CALL",
                            "strikePrice": 150.0,
                            "expirationDate": "2023-01-20T00:00:00+0000",
                        },
                    },
                    {
                        "shortQuantity": 0.0,
                        "longQuantity": 100.0,
                        "averagePrice": 145.00,
                        "instrument": {
                            "assetType": "EQUITY",
                            "symbol": "AAPL",
                        },
                    },
                    {
                        "shortQuantity": 0.0,
                        "longQuantity": 0.0,
                        "averagePrice": 0.0,
                        "instrument": {
                            "assetType": "EQUITY",
                            "symbol": "ZERO",
                        },
                    },
                ],
            }
        }
    ]

    def _mock_get(self, accounts_data):
        mock_resp = MagicMock()
        mock_resp.ok = True
        mock_resp.json.return_value = accounts_data
        return mock_resp

    def test_normalizes_short_call(self, client_authenticated):
        with patch("schwab_client.requests.get", return_value=self._mock_get(self._SAMPLE_ACCOUNTS)):
            positions = client_authenticated.get_positions()

        option_legs = [p for p in positions if p["posType"] == "option"]
        assert len(option_legs) == 1
        leg = option_legs[0]
        assert leg["ticker"] == "AAPL"
        assert leg["optType"] == "Call"
        assert leg["strike"] == 150.0
        assert leg["expiry"] == "2023-01-20"
        assert leg["contracts"] == -1  # short
        assert leg["avgCost"] == 2.50

    def test_normalizes_long_equity(self, client_authenticated):
        with patch("schwab_client.requests.get", return_value=self._mock_get(self._SAMPLE_ACCOUNTS)):
            positions = client_authenticated.get_positions()

        equity_legs = [p for p in positions if p["posType"] == "equity"]
        assert len(equity_legs) == 1
        leg = equity_legs[0]
        assert leg["ticker"] == "AAPL"
        assert leg["shares"] == 100
        assert leg["avgCost"] == 145.00

    def test_skips_flat_positions(self, client_authenticated):
        with patch("schwab_client.requests.get", return_value=self._mock_get(self._SAMPLE_ACCOUNTS)):
            positions = client_authenticated.get_positions()
        tickers = [p["ticker"] for p in positions]
        assert "ZERO" not in tickers

    def test_raises_auth_error_when_not_authenticated(self, client_configured):
        from schwab_client import SchwabAuthError
        with pytest.raises(SchwabAuthError):
            client_configured.get_positions()


class TestDisconnect:
    def test_disconnect_removes_token_file(self, client_authenticated, tmp_token):
        assert os.path.exists(tmp_token)
        client_authenticated.disconnect()
        assert not os.path.exists(tmp_token)
        assert not client_authenticated.is_authenticated()


# ─── Flask route integration tests ───────────────────────────────────────────


class TestSchwabRoutes:
    @pytest.fixture()
    def app_client(self):
        """Flask test client with a mocked schwab_client singleton."""
        import app as app_mod
        app_mod.app.config["TESTING"] = True
        with app_mod.app.test_client() as c:
            yield c

    def test_status_route_returns_200(self, app_client):
        mock_status = {
            "configured": False,
            "authenticated": False,
            "needs_reauth": False,
            "token_age_hours": None,
            "callback_url": None,
        }
        with patch("app.get_schwab_client") as mock_get:
            mock_get.return_value.status.return_value = mock_status
            resp = app_client.get("/api/schwab/status")
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert data["configured"] is False

    def test_auth_url_returns_url_when_configured(self, app_client):
        with patch("app.get_schwab_client") as mock_get:
            mock_get.return_value.get_auth_url.return_value = "https://api.schwabapi.com/v1/oauth/authorize?client_id=KEY"
            resp = app_client.get("/api/schwab/auth/url")
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert "auth_url" in data

    def test_auth_callback_400_on_missing_url(self, app_client):
        resp = app_client.post(
            "/api/schwab/auth/callback",
            json={},
            content_type="application/json",
        )
        assert resp.status_code == 400

    def test_sync_returns_401_when_not_authenticated(self, app_client):
        from schwab_client import SchwabAuthError
        with patch("app.get_schwab_client") as mock_get:
            mock_get.return_value.get_positions.side_effect = SchwabAuthError("Not authenticated")
            resp = app_client.post("/api/schwab/sync")
        assert resp.status_code == 401

    def test_disconnect_returns_ok(self, app_client):
        with patch("app.get_schwab_client") as mock_get:
            mock_get.return_value.disconnect.return_value = None
            resp = app_client.post("/api/schwab/disconnect")
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert data["ok"] is True
