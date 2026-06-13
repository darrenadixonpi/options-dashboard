"""IBKR Flex Web Service client — token-based positions/transactions fetch.

No OAuth, no local gateway. Two-step async flow:
  1. SendRequest(token, query_id)  -> ReferenceCode + GetStatement URL
  2. GetStatement(token, ref_code) -> Flex XML (poll while "generation in progress")

Config (token + Activity-query id) persists to a local **gitignored** JSON file so
the in-app panel can save it without the user editing `.env`. Environment variables
take precedence when set.

Config / env:
  IBKR_FLEX_TOKEN      Flex Web Service token (Client Portal → Settings)
  IBKR_FLEX_QUERY_ID   Activity Flex Query id
  IBKR_FLEX_PATH       local config file (default ./ibkr_flex.json)
  IBKR_FLEX_VERSION    API version (default 3)

See docs/IBKR_API.md for setup and the XML→leg mapping.
"""

from __future__ import annotations

import json
import os
import sys
import time
import xml.etree.ElementTree as ET
from typing import Any

import requests

from brokers.base import coerce_expiry, normalize_leg

_SEND_URL = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest"
_GET_URL_FALLBACK = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement"

SOURCE = "ibkr_flex"


class IBKRFlexError(Exception):
    """Raised on a Flex Web Service error (bad token, query, or unreachable)."""


class IBKRFlexClient:
    """Thin synchronous wrapper around the IBKR Flex Web Service."""

    def __init__(
        self,
        token: str = "",
        query_id: str = "",
        config_path: str = "./ibkr_flex.json",
        version: str = "3",
    ) -> None:
        self.config_path = config_path
        self.version = str(version or "3")
        self._token = (token or "").strip()
        self._query_id = (query_id or "").strip()
        # Fill any missing field from the saved config file (env wins).
        self._load_config()

    @classmethod
    def from_env(cls) -> "IBKRFlexClient":
        return cls(
            token=os.environ.get("IBKR_FLEX_TOKEN", ""),
            query_id=os.environ.get("IBKR_FLEX_QUERY_ID", ""),
            config_path=os.environ.get("IBKR_FLEX_PATH", "./ibkr_flex.json"),
            version=os.environ.get("IBKR_FLEX_VERSION", "3"),
        )

    # ── Config / status ────────────────────────────────────────────────────
    def _load_config(self) -> None:
        if self._token and self._query_id:
            return
        try:
            with open(self.config_path, encoding="utf-8") as f:
                cfg = json.load(f)
            self._token = self._token or (cfg.get("token") or "").strip()
            self._query_id = self._query_id or (cfg.get("query_id") or "").strip()
        except FileNotFoundError:
            pass
        except Exception as exc:  # pragma: no cover - defensive
            print(f"[ibkr] config load warning: {exc}", file=sys.stderr)

    def save_config(self, token: str, query_id: str) -> None:
        """Persist token + query id to the local gitignored config file."""
        self._token = (token or "").strip()
        self._query_id = (query_id or "").strip()
        if not self._token or not self._query_id:
            raise IBKRFlexError("Both a Flex token and a query id are required")
        try:
            with open(self.config_path, "w", encoding="utf-8") as f:
                json.dump(
                    {"token": self._token, "query_id": self._query_id, "saved_at": time.time()},
                    f,
                    indent=2,
                )
        except Exception as exc:
            raise IBKRFlexError(f"Could not save IBKR config: {exc}")

    def clear_config(self) -> None:
        self._token = ""
        self._query_id = ""
        try:
            if os.path.exists(self.config_path):
                os.remove(self.config_path)
        except Exception as exc:  # pragma: no cover - defensive
            print(f"[ibkr] config clear warning: {exc}", file=sys.stderr)

    def is_configured(self) -> bool:
        return bool(self._token and self._query_id)

    def status(self) -> dict[str, Any]:
        return {
            "configured": self.is_configured(),
            "authenticated": self.is_configured(),  # token IS the credential
            "needs_reauth": False,
            "query_id": self._query_id or None,
            "source": SOURCE,
        }

    # ── Two-step fetch ─────────────────────────────────────────────────────
    def _send_request(self) -> tuple[str, str]:
        resp = requests.get(
            _SEND_URL,
            params={"t": self._token, "q": self._query_id, "v": self.version},
            timeout=20,
        )
        if not resp.ok:
            raise IBKRFlexError(f"SendRequest HTTP {resp.status_code}: {resp.text[:200]}")
        root = ET.fromstring(resp.text)
        status = (root.findtext("Status") or "").strip()
        if status != "Success":
            code = root.findtext("ErrorCode") or "?"
            msg = root.findtext("ErrorMessage") or resp.text[:200]
            raise IBKRFlexError(f"Flex SendRequest failed [{code}]: {msg}")
        ref = (root.findtext("ReferenceCode") or "").strip()
        url = (root.findtext("Url") or _GET_URL_FALLBACK).strip()
        if not ref:
            raise IBKRFlexError("No ReferenceCode in SendRequest response")
        return ref, url

    def _get_statement(self, ref: str, url: str, max_tries: int = 6, wait_s: float = 2.0) -> str:
        for _ in range(max_tries):
            resp = requests.get(
                url,
                params={"t": self._token, "q": ref, "v": self.version},
                timeout=30,
            )
            if not resp.ok:
                raise IBKRFlexError(f"GetStatement HTTP {resp.status_code}: {resp.text[:200]}")
            text = resp.text
            if text.lstrip().startswith("<FlexStatementResponse"):
                # Control response — either an error or "generation in progress".
                root = ET.fromstring(text)
                status = (root.findtext("Status") or "").strip()
                msg = (root.findtext("ErrorMessage") or "").lower()
                if status == "Warn" or "progress" in msg or "generat" in msg:
                    time.sleep(wait_s)
                    continue
                raise IBKRFlexError(
                    f"Flex GetStatement failed: {root.findtext('ErrorMessage') or text[:200]}"
                )
            # FlexQueryResponse — the actual statement.
            return text
        raise IBKRFlexError("Statement not ready after retries — try again shortly")

    def fetch_statement(self) -> str:
        """Run the two-step flow and return the Flex statement XML string."""
        if not self.is_configured():
            raise IBKRFlexError("Not configured — set the IBKR Flex token and query id")
        ref, url = self._send_request()
        return self._get_statement(ref, url)

    # ── Normalization ──────────────────────────────────────────────────────
    def get_positions(self) -> list[dict[str, Any]]:
        """Fetch the statement and return canonical legs (drop-in for buildPortfolio)."""
        return self.parse_positions_xml(self.fetch_statement())

    def parse_positions_xml(self, xml_text: str) -> list[dict[str, Any]]:
        root = ET.fromstring(xml_text)
        legs: list[dict[str, Any]] = []
        for op in root.iter("OpenPosition"):
            leg = self._normalize_open_position(op.attrib)
            if leg:
                legs.append(leg)
        return legs

    @staticmethod
    def _normalize_open_position(a: dict[str, Any]) -> dict[str, Any] | None:
        asset = (a.get("assetCategory") or "").upper()
        position = a.get("position") or "0"
        avg_cost = a.get("costBasisPrice") or a.get("openPrice") or "0"

        if asset == "OPT":
            ticker = (a.get("underlyingSymbol") or a.get("symbol") or "").upper()
            pc = (a.get("putCall") or "").upper()
            opt_type = "Put" if pc.startswith("P") else "Call" if pc.startswith("C") else None
            return normalize_leg(
                {
                    "ticker": ticker,
                    "posType": "option",
                    "optType": opt_type,
                    "strike": a.get("strike"),
                    "expiry": coerce_expiry(a.get("expiry") or a.get("expiryDate")),
                    "contracts": position,
                    "avgCost": avg_cost,
                },
                source=SOURCE,
            )
        if asset == "STK":
            return normalize_leg(
                {
                    "ticker": (a.get("symbol") or "").upper(),
                    "posType": "equity",
                    "shares": position,
                    "avgCost": avg_cost,
                },
                source=SOURCE,
            )
        return None


# ─── Module-level singleton ───────────────────────────────────────────────────

_ibkr_flex_client: IBKRFlexClient | None = None


def get_ibkr_flex_client() -> IBKRFlexClient:
    """Return the module-level client (created from env/config on first call)."""
    global _ibkr_flex_client
    if _ibkr_flex_client is None:
        _ibkr_flex_client = IBKRFlexClient.from_env()
    return _ibkr_flex_client
