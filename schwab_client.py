"""Schwab Developer API client — OAuth 2.0 Authorization Code + Accounts & Trading.

Auth flow (paste-URL, no local HTTPS listener required):
  1. Call get_auth_url() → open URL in browser
  2. User logs in; Schwab redirects to https://127.0.0.1:8182?code=...&session=...
     (page may show a browser error — that's normal, the code is in the URL)
  3. User copies the full redirect URL from the address bar and pastes it here
  4. Call handle_callback(pasted_url) → exchanges code for tokens; saves to token file

Token lifetimes (Schwab policy):
  • Access token:  ~30 minutes (auto-refreshed on every call)
  • Refresh token: 7 days hard expiry — user must re-authenticate weekly

Env vars (set in .env — NEVER commit):
  SCHWAB_CLIENT_ID      App Key from developer.schwab.com
  SCHWAB_CLIENT_SECRET  App Secret
  SCHWAB_CALLBACK_URL   Must exactly match the app registration (default https://127.0.0.1:8182)
  SCHWAB_TOKEN_PATH     Local path for token JSON (default ./schwab_token.json)
"""

from __future__ import annotations

import base64
import json
import os
import sys
import time
from datetime import datetime
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse

import requests

# ─── Schwab API base URLs ─────────────────────────────────────────────────────

_AUTH_URL    = "https://api.schwabapi.com/v1/oauth/authorize"
_TOKEN_URL   = "https://api.schwabapi.com/v1/oauth/token"
_ACCOUNTS_URL = "https://api.schwabapi.com/trader/v1/accounts"


class SchwabAuthError(Exception):
    """Raised when OAuth fails or credentials are missing."""


class SchwabApiError(Exception):
    """Raised when an API call returns a non-2xx response."""


class SchwabClient:
    """Thin synchronous wrapper around the Schwab Developer API.

    Instantiate via SchwabClient.from_env() to pick up credentials from
    environment variables / .env file.
    """

    def __init__(
        self,
        client_id: str,
        client_secret: str,
        callback_url: str = "https://127.0.0.1:8182",
        token_path: str = "./schwab_token.json",
    ) -> None:
        self.client_id = client_id
        self.client_secret = client_secret
        self.callback_url = callback_url
        self.token_path = token_path
        self._tokens: dict[str, Any] = {}
        self._load_tokens()

    # ─── Factory ─────────────────────────────────────────────────────────────

    @classmethod
    def from_env(cls) -> "SchwabClient":
        """Create client from environment variables."""
        return cls(
            client_id=os.environ.get("SCHWAB_CLIENT_ID", ""),
            client_secret=os.environ.get("SCHWAB_CLIENT_SECRET", ""),
            callback_url=os.environ.get("SCHWAB_CALLBACK_URL", "https://127.0.0.1:8182"),
            token_path=os.environ.get("SCHWAB_TOKEN_PATH", "./schwab_token.json"),
        )

    # ─── Configuration & auth state ──────────────────────────────────────────

    def is_configured(self) -> bool:
        """Return True if client_id and client_secret are set."""
        return bool(self.client_id and self.client_secret)

    def is_authenticated(self) -> bool:
        """Return True if a token file exists and contains a refresh token."""
        return bool(self._tokens.get("refresh_token"))

    def needs_reauth(self) -> bool:
        """Return True if the refresh token is expired (> 7 days old)."""
        fetched_at = self._tokens.get("fetched_at", 0)
        # Schwab refresh tokens hard-expire after 7 days
        return time.time() - fetched_at > 7 * 24 * 3600

    def token_age_seconds(self) -> float | None:
        """Seconds since the refresh token was issued, or None if not authenticated."""
        if not self.is_authenticated():
            return None
        return time.time() - self._tokens.get("fetched_at", time.time())

    def status(self) -> dict[str, Any]:
        """Return a status dict suitable for /api/schwab/status response."""
        configured = self.is_configured()
        authenticated = self.is_authenticated()
        age = self.token_age_seconds()
        needs_reauth = self.needs_reauth() if authenticated else False
        return {
            "configured": configured,
            "authenticated": authenticated,
            "needs_reauth": needs_reauth,
            "token_age_hours": round(age / 3600, 1) if age is not None else None,
            "callback_url": self.callback_url if configured else None,
        }

    # ─── OAuth flow ───────────────────────────────────────────────────────────

    def get_auth_url(self) -> str:
        """Return the Schwab authorization URL to open in the browser."""
        if not self.is_configured():
            raise SchwabAuthError("SCHWAB_CLIENT_ID and SCHWAB_CLIENT_SECRET must be set in .env")
        params = {
            "client_id": self.client_id,
            "redirect_uri": self.callback_url,
            "response_type": "code",
            "scope": "api",
        }
        return f"{_AUTH_URL}?{urlencode(params)}"

    def handle_callback(self, pasted_url: str) -> dict[str, Any]:
        """Exchange the authorization code from the pasted redirect URL for tokens.

        Args:
            pasted_url: The full redirect URL the user copied from the browser bar,
                        e.g. https://127.0.0.1:8182?code=C0%2B...&session=...

        Returns:
            Token dict (also persisted to token_path).

        Raises:
            SchwabAuthError: if code is missing or token exchange fails.
        """
        if not self.is_configured():
            raise SchwabAuthError("Client not configured — set SCHWAB_CLIENT_ID and SCHWAB_CLIENT_SECRET")

        # Extract code from URL
        parsed = urlparse(pasted_url)
        qs = parse_qs(parsed.query)
        codes = qs.get("code", [])
        if not codes:
            raise SchwabAuthError(
                "No 'code' parameter found in the URL. "
                "Make sure you copied the full redirect URL after logging in."
            )
        code = codes[0]

        # Exchange code for tokens
        creds = base64.b64encode(f"{self.client_id}:{self.client_secret}".encode()).decode()
        resp = requests.post(
            _TOKEN_URL,
            headers={
                "Authorization": f"Basic {creds}",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": self.callback_url,
            },
            timeout=15,
        )
        if not resp.ok:
            raise SchwabAuthError(
                f"Token exchange failed ({resp.status_code}): {resp.text[:300]}"
            )

        tokens = resp.json()
        tokens["fetched_at"] = time.time()
        self._tokens = tokens
        self._save_tokens()
        return tokens

    def _refresh_access_token(self) -> None:
        """Use the refresh token to obtain a new access token."""
        refresh_token = self._tokens.get("refresh_token")
        if not refresh_token:
            raise SchwabAuthError("No refresh token — please re-authenticate via /api/schwab/auth/url")

        creds = base64.b64encode(f"{self.client_id}:{self.client_secret}".encode()).decode()
        resp = requests.post(
            _TOKEN_URL,
            headers={
                "Authorization": f"Basic {creds}",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            data={
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
            },
            timeout=15,
        )
        if not resp.ok:
            # Likely refresh token expired (7-day hard limit)
            raise SchwabAuthError(
                f"Access token refresh failed ({resp.status_code}) — "
                f"refresh token may be expired. Re-authenticate via /api/schwab/auth/url. "
                f"Detail: {resp.text[:200]}"
            )

        tokens = resp.json()
        # Schwab may or may not return a new refresh token on refresh
        if "refresh_token" not in tokens:
            tokens["refresh_token"] = refresh_token
        tokens["fetched_at"] = self._tokens.get("fetched_at", time.time())
        tokens["access_fetched_at"] = time.time()
        self._tokens.update(tokens)
        self._save_tokens()

    def _ensure_valid_access_token(self) -> str:
        """Return a valid access token, refreshing if needed."""
        if not self.is_authenticated():
            raise SchwabAuthError("Not authenticated — call /api/schwab/auth/url first")
        if self.needs_reauth():
            raise SchwabAuthError(
                "Refresh token expired (7-day Schwab limit) — re-authenticate via /api/schwab/auth/url"
            )

        # Refresh if access token is close to expiry (within 2 minutes)
        access_fetched = self._tokens.get("access_fetched_at", self._tokens.get("fetched_at", 0))
        expires_in = self._tokens.get("expires_in", 1800)
        if time.time() - access_fetched > expires_in - 120:
            self._refresh_access_token()

        return self._tokens["access_token"]

    # ─── Accounts API ─────────────────────────────────────────────────────────

    def get_accounts(self) -> list[dict[str, Any]]:
        """Return raw account list with positions from the Schwab Accounts API."""
        token = self._ensure_valid_access_token()
        resp = requests.get(
            f"{_ACCOUNTS_URL}?fields=positions",
            headers={"Authorization": f"Bearer {token}"},
            timeout=20,
        )
        if not resp.ok:
            raise SchwabApiError(
                f"Accounts API error ({resp.status_code}): {resp.text[:300]}"
            )
        return resp.json()

    def get_positions(self) -> list[dict[str, Any]]:
        """Fetch and normalize all positions across all accounts.

        Returns a list of internal leg dicts compatible with buildPortfolio().
        """
        accounts = self.get_accounts()
        legs: list[dict[str, Any]] = []
        for account in accounts:
            sec = account.get("securitiesAccount", {})
            for pos in sec.get("positions", []):
                normalized = self._normalize_position(pos)
                if normalized:
                    legs.append(normalized)
        return legs

    # ─── Position normalization ───────────────────────────────────────────────

    def _normalize_position(self, pos: dict[str, Any]) -> dict[str, Any] | None:
        """Map a single Schwab position dict to the internal leg format.

        Internal leg format (mirrors what 01-parsers.js produces after CSV parse):
          ticker, posType, optType?, strike?, expiry?, contracts?, shares?, avgCost
        """
        instr = pos.get("instrument", {})
        asset_type = instr.get("assetType", "")
        long_qty = float(pos.get("longQuantity", 0))
        short_qty = float(pos.get("shortQuantity", 0))
        avg_cost = float(pos.get("averagePrice", 0))

        if asset_type == "OPTION":
            ticker = instr.get("underlyingSymbol", "").upper()
            if not ticker:
                return None
            put_call = instr.get("putCall", "CALL").capitalize()
            opt_type = "Put" if put_call.startswith("Put") else "Call"
            strike = float(instr.get("strikePrice", 0))

            # expirationDate is ISO 8601: "2023-01-20T00:00:00+0000"
            exp_raw = instr.get("expirationDate", "")
            try:
                expiry = datetime.fromisoformat(exp_raw.replace("+0000", "+00:00")).strftime("%Y-%m-%d")
            except Exception:
                expiry = exp_raw[:10] if len(exp_raw) >= 10 else ""

            # Schwab: shortQuantity = contracts short, longQuantity = contracts long
            # Internal: negative contracts = short
            contracts = int(long_qty - short_qty)
            if contracts == 0:
                return None  # skip flat positions

            return {
                "ticker": ticker,
                "posType": "option",
                "optType": opt_type,
                "strike": strike,
                "expiry": expiry,
                "contracts": contracts,
                "shares": 0,
                "avgCost": avg_cost,
                "source": "schwab_api",
            }

        elif asset_type == "EQUITY":
            ticker = instr.get("symbol", "").upper()
            if not ticker:
                return None
            shares = int(long_qty - short_qty)
            if shares == 0:
                return None

            return {
                "ticker": ticker,
                "posType": "equity",
                "shares": shares,
                "contracts": 0,
                "avgCost": avg_cost,
                "source": "schwab_api",
            }

        # CASH_EQUIVALENT, FIXED_INCOME, etc. — skip
        return None

    # ─── Token persistence ────────────────────────────────────────────────────

    def _load_tokens(self) -> None:
        try:
            with open(self.token_path) as f:
                self._tokens = json.load(f)
        except FileNotFoundError:
            self._tokens = {}
        except Exception as exc:
            print(f"[schwab] Warning: could not load token file: {exc}", file=sys.stderr)
            self._tokens = {}

    def _save_tokens(self) -> None:
        try:
            with open(self.token_path, "w") as f:
                json.dump(self._tokens, f, indent=2)
        except Exception as exc:
            print(f"[schwab] Warning: could not save token file: {exc}", file=sys.stderr)

    def disconnect(self) -> None:
        """Delete the local token file and clear in-memory tokens."""
        self._tokens = {}
        try:
            if os.path.exists(self.token_path):
                os.remove(self.token_path)
        except Exception as exc:
            print(f"[schwab] Warning: could not delete token file: {exc}", file=sys.stderr)


# ─── Module-level singleton ───────────────────────────────────────────────────

def get_schwab_client() -> SchwabClient:
    """Return the module-level Schwab client (created from env on first call)."""
    global _schwab_client
    if _schwab_client is None:
        _schwab_client = SchwabClient.from_env()
    return _schwab_client


_schwab_client: SchwabClient | None = None
