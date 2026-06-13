"""Interactive Brokers adapter — IBKR Flex / Activity Statement CSV + Flex Web Service API.

CSV parsing ports `parseIBKRPositions` / `parseIBKRHistory` from
`static/js/01-parsers.js`. The API path (`sync_positions`) pulls the same Activity
statement over the Flex Web Service via `ibkr_flex_client.py` — see docs/IBKR_API.md.
IBKR layouts are column-named (not positional), so headers are detected dynamically.
"""

from __future__ import annotations

import re
from typing import Any

from .base import BrokerAdapter, normalize_leg
from .csvutil import (
    find_header_row,
    header_col_index,
    parse_csv_line,
    parse_money,
    parse_occ,
    parse_option_from_ibkr,
)

SOURCE = "ibkr_csv"


def _int(v: Any) -> int:
    try:
        return int(float(str(v).replace(",", "")))
    except (TypeError, ValueError):
        return 0


class IBKRAdapter(BrokerAdapter):
    key = "ibkr"
    label = "Interactive Brokers"
    source = "csv"
    supports_positions = True
    supports_history = True
    supports_oauth = False
    supports_api_sync = True  # via the Flex Web Service (token, not OAuth)

    # ── API sync (Flex Web Service) ────────────────────────────────────────
    def sync_positions(self) -> list[dict[str, Any]]:
        # Lazy import keeps `import brokers` working without `requests`.
        from ibkr_flex_client import get_ibkr_flex_client
        return get_ibkr_flex_client().get_positions()

    def status(self) -> dict[str, Any]:
        try:
            from ibkr_flex_client import get_ibkr_flex_client
            return get_ibkr_flex_client().status()
        except Exception as exc:  # pragma: no cover - defensive
            return {"configured": False, "authenticated": False, "source": "ibkr_flex", "error": str(exc)}

    # ── Positions (CSV) ────────────────────────────────────────────────────
    def parse_positions(self, text: str) -> list[dict[str, Any]]:
        lines = text.replace("﻿", "").replace("\r", "").split("\n")
        hdr_idx = find_header_row(lines, ["symbol", "quantity"])
        if hdr_idx < 0:
            return []
        headers = [h.strip().lower().replace('"', "") for h in parse_csv_line(lines[hdr_idx])]
        sym_i = header_col_index(headers, "symbol")
        qty_i = header_col_index(headers, "quantity")
        sec_i = header_col_index(headers, "sectype", "asset category")
        exp_i = header_col_index(headers, "expiry", "expiration")
        strike_i = header_col_index(headers, "strike")
        right_i = header_col_index(headers, "put/call", "right")
        desc_i = header_col_index(headers, "description", "financial instrument")
        mark_i = header_col_index(headers, "mark price", "mark")
        cost_i = header_col_index(headers, "cost basis price", "cost basis", "avg cost")

        legs: list[dict[str, Any]] = []
        for line in lines[hdr_idx + 1:]:
            r = parse_csv_line(line)
            if len(r) <= max(sym_i, qty_i):
                continue
            sym = (r[sym_i] or "").strip()
            if not sym or sym.lower() == "total" or sym.startswith("---"):
                continue
            qty = _int(r[qty_i])
            if not qty:
                continue
            sec = (r[sec_i] or "").strip().upper() if sec_i >= 0 else ""
            desc = (r[desc_i] or "").strip() if desc_i >= 0 else sym
            mark = parse_money(r[mark_i]) if mark_i >= 0 else 0.0
            cost = parse_money(r[cost_i]) if cost_i >= 0 else 0.0
            is_opt = sec in ("OPT", "OPTION") or bool(re.search(r"[PC]\d", sym.replace(" ", "")))

            if is_opt:
                p = parse_option_from_ibkr(
                    sym, desc,
                    r[exp_i] if exp_i >= 0 else "",
                    r[strike_i] if strike_i >= 0 else "",
                    r[right_i] if right_i >= 0 else "",
                )
                if not p:
                    continue
                leg = normalize_leg({
                    "ticker": p["ticker"],
                    "posType": "option",
                    "optType": p["optType"],
                    "strike": p["strike"],
                    "expiry": p["expiry"],
                    "contracts": qty,
                    "avgCost": cost,
                }, source=SOURCE)
            else:
                ticker = re.sub(r"[^A-Z0-9.]", "", sym.split(" ")[0].upper())
                if not ticker:
                    continue
                leg = normalize_leg({
                    "ticker": ticker,
                    "posType": "equity",
                    "shares": qty,
                    "avgCost": cost,
                    "_mark": mark,
                }, source=SOURCE)
            if leg:
                legs.append(leg)
        return legs

    # ── History (opening fills, CSV) ───────────────────────────────────────
    def parse_history(self, text: str) -> list[dict[str, Any]]:
        lines = text.replace("﻿", "").replace("\r", "").split("\n")
        hdr_idx = find_header_row(lines, ["symbol", "quantity"])
        if hdr_idx < 0:
            return []
        headers = [h.strip().lower().replace('"', "") for h in parse_csv_line(lines[hdr_idx])]
        date_i = header_col_index(headers, "tradedate", "date/time", "date", "trade date")
        sym_i = header_col_index(headers, "symbol")
        qty_i = header_col_index(headers, "quantity", "qty")
        price_i = header_col_index(headers, "t. price", "tradeprice", "trade price", "price")
        code_i = header_col_index(headers, "code")
        side_i = header_col_index(headers, "buy/sell", "buy/sell indicator")
        exp_i = header_col_index(headers, "expiry", "expiration", "exp")
        strike_i = header_col_index(headers, "strike")
        right_i = header_col_index(headers, "put/call", "right")
        desc_i = header_col_index(headers, "description", "financial instrument")
        if date_i < 0 or sym_i < 0 or qty_i < 0:
            return []

        fills: list[dict[str, Any]] = []
        for line in lines[hdr_idx + 1:]:
            r = parse_csv_line(line)
            if len(r) <= sym_i:
                continue
            sym = (r[sym_i] or "").strip()
            if not sym or sym.lower() == "total" or sym.startswith("---"):
                continue
            ds = (r[date_i] or "").strip()
            if not ds or not re.search(r"\d", ds):
                continue
            code = (r[code_i] or "").upper() if code_i >= 0 else ""
            side = (r[side_i] or "").upper() if side_i >= 0 else ""
            if not _ibkr_is_open(code) and "OPEN" not in side:
                continue
            desc = (r[desc_i] or "").strip() if desc_i >= 0 else sym
            p = (parse_occ(sym.replace(" ", ""))
                 or parse_option_from_ibkr(
                     sym, desc,
                     r[exp_i] if exp_i >= 0 else "",
                     r[strike_i] if strike_i >= 0 else "",
                     r[right_i] if right_i >= 0 else ""))
            if not p:
                continue
            iso = _ibkr_iso_date(ds)
            if not iso:
                continue
            fills.append({
                "date": iso,
                "ticker": p["ticker"],
                "expiry": p["expiry"].strftime("%Y-%m-%d"),
                "strike": p["strike"],
                "optType": p["optType"],
                "quantity": abs(_int(r[qty_i])),
                "price": parse_money(r[price_i]) if price_i >= 0 else 0.0,
                "source": SOURCE,
            })
        return fills


def _ibkr_is_open(code: str) -> bool:
    c = (code or "").upper()
    parts = re.split(r"[;,|/]", c)
    return any(p == "O" or p.startswith("OPEN") for p in parts) or c == "O"


def _ibkr_iso_date(ds: str) -> str | None:
    main = ds.split(";")[0].split(" ")[0]
    if re.match(r"^\d{8}$", main):
        return f"{main[0:4]}-{main[4:6]}-{main[6:8]}"
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", main)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    dp = re.split(r"[/\-]", main)
    if len(dp) >= 3:
        try:
            return f"{int(dp[2]):04d}-{int(dp[0]):02d}-{int(dp[1]):02d}"
        except ValueError:
            return None
    return None
