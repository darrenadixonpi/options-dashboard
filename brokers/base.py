"""Broker adapter base — the common contract every broker plugs into (Phase 7.1).

The whole point of this layer is that adding a broker (Schwab, IBKR, Fidelity,
Tastytrade, …) means writing one small ``BrokerAdapter`` subclass — no changes to
``app.py`` or the rest of the core. Every adapter, regardless of whether it pulls
positions from an OAuth API (Schwab), a token API (IBKR Flex), or an exported CSV
(Fidelity, IBKR), emits the *same* canonical "leg" dict so downstream code
(``buildPortfolio``, greeks, simulation, tax lots) never has to care which broker
the data came from.

Canonical leg format (identical to what ``schwab_client._normalize_position``
already produces, so existing consumers keep working unchanged):

    {
        "ticker":   "AAPL",          # uppercased
        "posType":  "option"|"equity",
        "optType":  "Put"|"Call"|None,
        "strike":   150.0|None,
        "expiry":   "2026-06-20"|None,   # ISO date string
        "contracts": -1,             # signed; negative = short. 0 for equity.
        "shares":    0,              # signed; negative = short. 0 for options.
        "avgCost":   2.50,           # per-share / per-contract avg cost (broker-native)
        "source":    "schwab_api",   # provenance tag set by the adapter
    }
"""

from __future__ import annotations

from abc import ABC
from datetime import date, datetime
from typing import Any


# ─── Errors ───────────────────────────────────────────────────────────────────

class BrokerError(Exception):
    """Generic broker-adapter failure (bad input, unsupported capability)."""


class BrokerNotFound(BrokerError):
    """Raised when a requested broker key is not in the registry."""


# ─── Coercion helpers ─────────────────────────────────────────────────────────

def _to_float(value: Any, default: float | None = 0.0) -> float | None:
    if value is None or value == "":
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _to_int(value: Any, default: int = 0) -> int:
    if value is None or value == "":
        return default
    try:
        # float() first so "2.0" and 2.0 both round-trip to 2
        return int(float(value))
    except (TypeError, ValueError):
        return default


def coerce_expiry(value: Any) -> str | None:
    """Normalize an expiry (date, datetime, or string) to an ISO ``YYYY-MM-DD``.

    Accepts ``datetime``/``date`` objects, ISO strings (with or without a time
    component / timezone), compact ``YYYYMMDD`` (IBKR Flex), and common
    ``MM/DD/YYYY`` broker strings. Returns ``None`` if it cannot be parsed.
    """
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, date):
        return value.strftime("%Y-%m-%d")

    s = str(value).strip()
    if not s:
        return None

    # ISO 8601 (possibly with a time/zone component, e.g. Schwab API).
    head = s.replace("+0000", "+00:00")
    try:
        return datetime.fromisoformat(head).strftime("%Y-%m-%d")
    except ValueError:
        pass

    # Bare ISO date prefix "2026-06-20T..." or "2026-06-20 ..."
    if len(s) >= 10 and s[4] == "-" and s[7] == "-":
        candidate = s[:10]
        try:
            datetime.strptime(candidate, "%Y-%m-%d")
            return candidate
        except ValueError:
            pass

    # Compact YYYYMMDD (IBKR Flex statements, some broker exports).
    if len(s) == 8 and s.isdigit():
        try:
            return datetime.strptime(s, "%Y%m%d").strftime("%Y-%m-%d")
        except ValueError:
            pass

    # US "MM/DD/YYYY"
    if "/" in s:
        parts = s.split("/")
        if len(parts) >= 3:
            try:
                mm, dd, yyyy = int(parts[0]), int(parts[1]), int(parts[2])
                if yyyy < 100:
                    yyyy += 2000
                return f"{yyyy:04d}-{mm:02d}-{dd:02d}"
            except (ValueError, IndexError):
                pass
    return None


# ─── Canonical leg normalizer ─────────────────────────────────────────────────

def normalize_leg(raw: dict[str, Any], source: str | None = None) -> dict[str, Any] | None:
    """Coerce a loose, broker-specific leg dict into the canonical leg format.

    Returns ``None`` for flat / non-tradeable rows (zero quantity, missing
    required option fields, blank ticker) so callers can simply filter ``None``.

    This is the single chokepoint that guarantees *every* adapter emits an
    identical shape — adapters should always run their parsed rows through it.
    """
    if not raw:
        return None

    ticker = str(raw.get("ticker") or "").strip().upper()
    if not ticker:
        return None

    src = source or raw.get("source") or ""
    avg_cost = _to_float(raw.get("avgCost"), 0.0) or 0.0

    pos_type = str(raw.get("posType") or "").strip().lower()
    if pos_type not in ("option", "equity"):
        # Infer: presence of any option attribute → option, else equity.
        has_opt = bool(raw.get("optType") or raw.get("strike") or raw.get("expiry"))
        pos_type = "option" if has_opt else "equity"

    if pos_type == "option":
        opt_raw = str(raw.get("optType") or "").strip().lower()
        if opt_raw.startswith("p"):
            opt_type: str | None = "Put"
        elif opt_raw.startswith("c"):
            opt_type = "Call"
        else:
            opt_type = None

        strike = _to_float(raw.get("strike"), None)
        expiry = coerce_expiry(raw.get("expiry"))
        contracts = _to_int(raw.get("contracts"), 0)

        # Drop incomplete or flat option legs.
        if contracts == 0 or opt_type is None or not strike or strike <= 0 or not expiry:
            return None

        return {
            "ticker": ticker,
            "posType": "option",
            "optType": opt_type,
            "strike": float(strike),
            "expiry": expiry,
            "contracts": int(contracts),
            "shares": 0,
            "avgCost": round(float(avg_cost), 6),
            "source": src,
        }

    # Equity: prefer an explicit non-zero `shares`, else fall back to `contracts`
    # (the frontend CSV parsers populate both with the same signed quantity).
    shares = _to_int(raw.get("shares"), 0)
    if shares == 0:
        shares = _to_int(raw.get("contracts"), 0)
    if shares == 0:
        return None

    return {
        "ticker": ticker,
        "posType": "equity",
        "optType": None,
        "strike": None,
        "expiry": None,
        "contracts": 0,
        "shares": int(shares),
        "avgCost": round(float(avg_cost), 6),
        "source": src,
    }


# ─── Adapter interface ────────────────────────────────────────────────────────

class BrokerAdapter(ABC):
    """Common interface for every supported broker.

    Subclasses set the class attributes and override the methods that match
    their ``source``:

    * ``source = "csv"``  → override :meth:`parse_positions` (and optionally
      :meth:`parse_history`).
    * ``source = "api"``  → override :meth:`sync_positions` plus the OAuth
      methods (:meth:`status`, :meth:`get_auth_url`, :meth:`handle_callback`,
      :meth:`disconnect`).

    A CSV broker that *also* offers an API pull (e.g. IBKR via Flex Web Service)
    keeps ``source = "csv"`` and sets ``supports_api_sync = True`` plus
    :meth:`sync_positions`.

    Callers should use the unified :meth:`get_positions` entry point and
    :meth:`capabilities` for discovery; they never need to know the source.
    """

    key: str = ""           # stable identifier, e.g. "schwab"
    label: str = ""         # human label, e.g. "Charles Schwab"
    source: str = "csv"     # "csv" | "api"
    supports_positions: bool = True
    supports_history: bool = False
    supports_oauth: bool = False
    supports_api_sync: bool = False   # CSV broker that can also pull via an API

    # ── Discovery ──────────────────────────────────────────────────────────
    def capabilities(self) -> dict[str, Any]:
        """Machine-readable descriptor used by ``GET /api/brokers``."""
        return {
            "key": self.key,
            "label": self.label,
            "source": self.source,
            "positions": self.supports_positions,
            "history": self.supports_history,
            "oauth": self.supports_oauth,
            "api_sync": self.source == "api" or self.supports_api_sync,
        }

    # ── Unified position ingestion ─────────────────────────────────────────
    def get_positions(self, csv_text: str | None = None) -> list[dict[str, Any]]:
        """Return canonical legs.

        If ``csv_text`` is provided, parse it (works for CSV-export-capable
        brokers). Otherwise, for API-capable brokers, pull live positions.
        """
        if csv_text and csv_text.strip():
            return self.parse_positions(csv_text)
        if self.source == "api" or self.supports_api_sync:
            return self.sync_positions()
        raise BrokerError(f"{self.label or self.key}: CSV text required to parse positions")

    # ── CSV brokers override these ─────────────────────────────────────────
    def parse_positions(self, text: str) -> list[dict[str, Any]]:
        raise BrokerError(f"{self.label or self.key} does not support CSV position import")

    def parse_history(self, text: str) -> list[dict[str, Any]]:
        raise BrokerError(f"{self.label or self.key} does not support CSV history import")

    # ── API brokers override these ─────────────────────────────────────────
    def sync_positions(self) -> list[dict[str, Any]]:
        raise BrokerError(f"{self.label or self.key} does not support API sync")

    def status(self) -> dict[str, Any]:
        """Connection status. CSV brokers are always 'ready' (no auth needed)."""
        return {
            "configured": True,
            "authenticated": False,
            "needs_reauth": False,
            "source": self.source,
        }

    def get_auth_url(self) -> str:
        raise BrokerError(f"{self.label or self.key} does not use OAuth")

    def handle_callback(self, pasted_url: str) -> dict[str, Any]:
        raise BrokerError(f"{self.label or self.key} does not use OAuth")

    def disconnect(self) -> None:
        return None
