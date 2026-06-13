"""Schwab adapter — wraps the existing OAuth ``SchwabClient`` (Phase 6).

Schwab is the one *API* broker: positions come from the Accounts API over OAuth.
This adapter is a thin delegation layer so the unified registry exposes Schwab
through the same interface as the CSV brokers, while ``schwab_client.py`` remains
the single source of truth for tokens and OAuth (the original ``/api/schwab/*``
routes keep working unchanged). Schwab also exports CSV, so ``parse_positions``
is provided too (port of ``parseSchwabPositions``).
"""

from __future__ import annotations

from typing import Any

from .base import BrokerAdapter, normalize_leg
from .csvutil import (
    find_header_row,
    header_col_index,
    parse_csv_line,
    parse_money,
    parse_option_from_schwab,
)

SOURCE_API = "schwab_api"
SOURCE_CSV = "schwab_csv"


def _int(v: Any) -> int:
    try:
        return int(float(str(v).replace(",", "")))
    except (TypeError, ValueError):
        return 0


class SchwabAdapter(BrokerAdapter):
    key = "schwab"
    label = "Charles Schwab"
    source = "api"
    supports_positions = True
    supports_history = False
    supports_oauth = True

    # Lazy import keeps `import brokers` working even if optional deps for the
    # Schwab HTTP client aren't present in a given environment.
    def _client(self):
        from schwab_client import get_schwab_client
        return get_schwab_client()

    # ── API sync ───────────────────────────────────────────────────────────
    def sync_positions(self) -> list[dict[str, Any]]:
        raw_legs = self._client().get_positions()
        out: list[dict[str, Any]] = []
        for leg in raw_legs:
            n = normalize_leg(leg, source=leg.get("source") or SOURCE_API)
            if n:
                out.append(n)
        return out

    # ── OAuth delegation ───────────────────────────────────────────────────
    def status(self) -> dict[str, Any]:
        return self._client().status()

    def get_auth_url(self) -> str:
        return self._client().get_auth_url()

    def handle_callback(self, pasted_url: str) -> dict[str, Any]:
        return self._client().handle_callback(pasted_url)

    def disconnect(self) -> None:
        self._client().disconnect()

    # ── CSV fallback (Schwab positions export) ─────────────────────────────
    def parse_positions(self, text: str) -> list[dict[str, Any]]:
        lines = text.replace("﻿", "").replace("\r", "").split("\n")
        hdr_idx = find_header_row(lines, ["symbol", "quantity"])
        if hdr_idx < 0:
            return []
        headers = [h.strip().lower().replace('"', "") for h in parse_csv_line(lines[hdr_idx])]
        sym_i = header_col_index(headers, "symbol")
        qty_i = header_col_index(headers, "quantity")
        desc_i = header_col_index(headers, "description")
        cost_i = header_col_index(headers, "cost basis")

        legs: list[dict[str, Any]] = []
        for line in lines[hdr_idx + 1:]:
            r = parse_csv_line(line)
            if len(r) <= max(sym_i, qty_i):
                continue
            sym = (r[sym_i] or "").strip()
            lo = sym.lower()
            if not sym or "cash" in lo or "total" in lo:
                continue
            qty = _int(r[qty_i])
            if not qty:
                continue
            desc = (r[desc_i] or "").strip() if desc_i >= 0 else ""
            cost_basis = parse_money(r[cost_i]) if cost_i >= 0 else 0.0

            p = parse_option_from_schwab(sym, desc)
            if p:
                avg_cost = abs(cost_basis / (qty * 100)) if cost_basis else 0.0
                leg = normalize_leg({
                    "ticker": p["ticker"],
                    "posType": "option",
                    "optType": p["optType"],
                    "strike": p["strike"],
                    "expiry": p["expiry"],
                    "contracts": qty,
                    "avgCost": avg_cost,
                }, source=SOURCE_CSV)
            else:
                import re
                ticker = re.sub(r"[*\s]", "", sym).upper()
                if not ticker or re.search(r"\d{6}", ticker):
                    continue
                avg_cost = abs(cost_basis / qty) if cost_basis else 0.0
                leg = normalize_leg({
                    "ticker": ticker,
                    "posType": "equity",
                    "shares": qty,
                    "avgCost": avg_cost,
                }, source=SOURCE_CSV)
            if leg:
                legs.append(leg)
        return legs
