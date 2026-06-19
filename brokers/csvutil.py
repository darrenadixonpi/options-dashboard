"""Low-level CSV + option-symbol parsing helpers.

Faithful Python ports of the validated browser parsers in
``static/js/01-parsers.js`` so the backend broker adapters reconstruct the exact
same positions the frontend does. Kept dependency-free (stdlib only) so the
``brokers`` package never imports ``app.py``.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any


# ─── Primitive CSV ────────────────────────────────────────────────────────────

def parse_csv_line(line: str) -> list[str]:
    """Split a single CSV line, honoring double-quoted fields."""
    out: list[str] = []
    cur = ""
    in_q = False
    for ch in line:
        if ch == '"':
            in_q = not in_q
        elif ch == "," and not in_q:
            out.append(cur)
            cur = ""
        else:
            cur += ch
    out.append(cur)
    return out


def parse_money(s: Any) -> float:
    """Parse a currency-ish string ('$1,234.50', '+2.00') into a float."""
    if s is None:
        return 0.0
    txt = re.sub(r"[$,\s+]", "", str(s))
    try:
        return float(txt) if txt else 0.0
    except ValueError:
        return 0.0


def find_header_row(lines: list[str], required: list[str]) -> int:
    """Return the index of the first header row containing all ``required`` tokens."""
    for i in range(min(len(lines), 20)):
        lo = (lines[i] or "").lower()
        if "," not in lo:
            continue
        if all(tok in lo for tok in required):
            return i
    return -1


def header_col_index(headers: list[str], *names: str) -> int:
    """Find the column index whose header equals or contains any of ``names``."""
    for name in names:
        n = name.lower()
        for idx, h in enumerate(headers):
            if h == n or n in h:
                return idx
    return -1


# ─── Option symbol parsing ────────────────────────────────────────────────────

_OCC_RE = re.compile(r"^-?\s*([a-z]+)(\d{6})([cp])(\d+(?:\.\d+)?)$", re.IGNORECASE)


def parse_occ(sym: str) -> dict[str, Any] | None:
    """Parse an OCC option symbol → {ticker, expiry(date), optType, strike}.

    Handles both standard 8-digit padded strikes (``00150000`` → 150.0) and
    broker decimal strikes (``2.5`` → 2.5), matching the backend
    ``_parse_occ_symbol`` strike logic.
    """
    if not sym:
        return None
    norm = re.sub(r"^[\s-]+", "", str(sym).strip()).replace(" ", "")
    m = _OCC_RE.match(norm)
    if not m:
        return None
    ds = m.group(2)
    try:
        expiry = datetime(2000 + int(ds[0:2]), int(ds[2:4]), int(ds[4:6]))
    except ValueError:
        return None
    strike_raw = m.group(4)
    if "." in strike_raw:
        strike = float(strike_raw)
    elif len(strike_raw) > 6:
        strike = float(strike_raw) / 1000.0
    else:
        strike = float(strike_raw)
    return {
        "ticker": m.group(1).upper(),
        "expiry": expiry,
        "optType": "Put" if m.group(3).lower() == "p" else "Call",
        "strike": strike,
    }


def parse_option_from_schwab(sym: str, desc: str = "") -> dict[str, Any] | None:
    """Parse a Schwab option from its symbol or 'PUT XYZ 06/20/2026 10.0' description."""
    p = parse_occ((sym or "").replace(" ", ""))
    if p:
        return p
    # Schwab native symbol: "TICKER MM/DD/YYYY STRIKE P/C" (e.g. "OVID 06/18/2026 2.50 P")
    sm = re.match(r"^([A-Za-z.]+)\s+(\d{2})/(\d{2})/(\d{4})\s+([\d.]+)\s+([PCpc])$", (sym or "").strip())
    if sm:
        s_ticker, s_mm, s_dd, s_yyyy, s_strike, s_pc = sm.groups()
        try:
            return {
                "ticker": s_ticker.upper(),
                "expiry": datetime(int(s_yyyy), int(s_mm), int(s_dd)),
                "optType": "Put" if s_pc.lower() == "p" else "Call",
                "strike": float(s_strike),
            }
        except ValueError:
            return None
    m = re.search(
        r"(PUT|CALL|P|C)\s+([A-Z]+)\s+(\d{2})/(\d{2})/(\d{4})\s+([\d.]+)",
        desc or "",
        re.IGNORECASE,
    )
    if m:
        opt_type = "Put" if re.match(r"^p", m.group(1), re.IGNORECASE) else "Call"
        try:
            expiry = datetime(int(m.group(5)), int(m.group(3)), int(m.group(4)))
        except ValueError:
            return None
        return {"ticker": m.group(2).upper(), "expiry": expiry, "optType": opt_type, "strike": float(m.group(6))}
    return None


def parse_option_from_ibkr(
    sym: str, desc: str = "", expiry_str: str = "", strike_str: str = "", right_str: str = ""
) -> dict[str, Any] | None:
    """Parse an IBKR option from symbol, explicit columns, or description."""
    if sym:
        p = parse_occ(sym.replace(" ", ""))
        if p:
            return p

    if expiry_str and strike_str and right_str:
        exp = None
        d = (expiry_str or "").strip()
        if re.match(r"^\d{8}$", d):
            try:
                exp = datetime(int(d[0:4]), int(d[4:6]), int(d[6:8]))
            except ValueError:
                exp = None
        elif re.match(r"^\d{4}-\d{2}-\d{2}$", d):
            pts = d.split("-")
            try:
                exp = datetime(int(pts[0]), int(pts[1]), int(pts[2]))
            except ValueError:
                exp = None
        opt_type = "Put" if re.match(r"^p", right_str, re.IGNORECASE) else "Call"
        if exp:
            ticker = (sym or "").split(" ")[0].upper()
            try:
                return {"ticker": ticker, "expiry": exp, "optType": opt_type, "strike": float(strike_str)}
            except ValueError:
                return None

    m = re.search(
        r"([A-Z]{1,6})\s+([A-Z]{3}\d{2}'?\d{2})\s+([\d.]+)\s+([PC])",
        (desc or "").upper(),
    )
    if m:
        mo = {"JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
              "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12}
        mp = re.match(r"^([A-Z]{3})(\d{2})(\d{2})$", m.group(2).replace("'", ""))
        if mp:
            yr = 2000 + int(mp.group(3))
            try:
                return {
                    "ticker": m.group(1).upper(),
                    "expiry": datetime(yr, mo.get(mp.group(1), 1), 1),
                    "optType": "Put" if m.group(4).upper() == "P" else "Call",
                    "strike": float(mp.group(2)),
                }
            except ValueError:
                return None
    return None
