"""Fidelity adapter — CSV positions + transaction history.

Fidelity is the production-validated broker. These parsers are Python ports of
``parseFidelityRaw`` / ``parseFidelityHistory`` in ``static/js/01-parsers.js``,
producing the same positions the browser does, then funnelled through
``normalize_leg`` for the canonical shape.
"""

from __future__ import annotations

import re
from typing import Any

from .base import BrokerAdapter, coerce_expiry, normalize_leg
from .csvutil import find_header_row, header_col_index, parse_csv_line, parse_money, parse_occ

SOURCE = "fidelity_csv"


class FidelityAdapter(BrokerAdapter):
    key = "fidelity"
    label = "Fidelity"
    source = "csv"
    supports_positions = True
    supports_history = True
    supports_oauth = False

    # ── Positions ──────────────────────────────────────────────────────────
    def parse_positions(self, text: str) -> list[dict[str, Any]]:
        lines = text.replace("﻿", "").replace("\r", "").split("\n")
        legs: list[dict[str, Any]] = []
        # Fidelity positions export has a single header row; data starts at line 1.
        for line in lines[1:]:
            r = parse_csv_line(line)
            if len(r) <= 2:
                continue
            sym = (r[2] or "").strip()
            lo = sym.lower()
            if not sym or "MONEY MARKET" in sym or "Pending" in sym or "account" in lo:
                continue
            qty = _int(_float(r[4]) if len(r) > 4 else 0)
            if not qty:
                continue
            acb = parse_money(r[14]) if len(r) > 14 else 0.0
            last_price = parse_money(r[5]) if len(r) > 5 else 0.0

            p = parse_occ(sym)
            if p:
                leg = normalize_leg({
                    "ticker": p["ticker"],
                    "posType": "option",
                    "optType": p["optType"],
                    "strike": p["strike"],
                    "expiry": p["expiry"],
                    "contracts": qty,
                    "avgCost": acb,
                }, source=SOURCE)
            else:
                ticker = re.sub(r"[*\s]", "", sym).upper()
                if not ticker or re.search(r"\d{6}", ticker):
                    continue
                leg = normalize_leg({
                    "ticker": ticker,
                    "posType": "equity",
                    "shares": qty,
                    "avgCost": acb,
                    "_lastPrice": last_price,
                }, source=SOURCE)
            if leg:
                legs.append(leg)
        return legs

    # ── History (opening fills) ────────────────────────────────────────────
    def parse_history(self, text: str) -> list[dict[str, Any]]:
        """Parse Fidelity transaction history → opening option fills.

        Columns are located by header name (not fixed position) so layout
        variants — e.g. an extra ``Type`` column — parse correctly.
        """
        lines = text.replace("﻿", "").replace("\r", "").split("\n")
        hdr_idx = find_header_row(lines, ["symbol", "quantity"])
        if hdr_idx < 0:
            return []
        headers = [h.strip().lower().replace('"', "") for h in parse_csv_line(lines[hdr_idx])]
        date_i = header_col_index(headers, "run date", "date")
        action_i = header_col_index(headers, "action")
        sym_i = header_col_index(headers, "symbol")
        qty_i = header_col_index(headers, "quantity")
        price_i = header_col_index(headers, "price ($)", "price")
        if sym_i < 0 or qty_i < 0:
            return []

        fills: list[dict[str, Any]] = []
        for line in lines[hdr_idx + 1:]:
            r = parse_csv_line(line)
            if len(r) <= max(sym_i, qty_i):
                continue
            action = r[action_i] if action_i >= 0 else ""
            if "OPENING TRANSACTION" not in (action or ""):
                continue
            p = parse_occ((r[sym_i] or "").strip())
            if not p:
                continue
            fills.append({
                "date": coerce_expiry(r[date_i]) if date_i >= 0 else None,
                "ticker": p["ticker"],
                "expiry": p["expiry"].strftime("%Y-%m-%d"),
                "strike": p["strike"],
                "optType": p["optType"],
                "quantity": abs(_int(_float(r[qty_i]))),
                "price": parse_money(r[price_i]) if price_i >= 0 else 0.0,
                "source": SOURCE,
            })
        return fills


def _float(v: Any) -> float:
    try:
        return float(str(v).replace("$", "").replace(",", "").replace("+", "").strip() or 0)
    except (TypeError, ValueError):
        return 0.0


def _int(v: Any) -> int:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return 0
