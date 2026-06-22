"""Tax lot tracking — FIFO/LIFO matching, wash-sale detection, Form 8949 export.

Computes realized gains/losses from closed_trades with:
  • FIFO or LIFO lot matching (user-selectable; default FIFO)
  • Short-term vs. long-term classification (≥365 days = long-term)
  • Wash-sale rule: if a substantially identical position is opened within
    30 days before or after a loss close, the loss is disallowed and the
    disallowed amount is added to the cost basis of the replacement lot
  • Form 8949-compatible CSV export

Usage (from app.py routes):
    from tax_lots import compute_tax_lots, to_8949_rows, METHODS

The input is a list of closed_trade dicts from the DB (closed_trades table).
Each dict must have: ticker, opt_type, strike, open_date, close_date,
open_price, close_price, quantity, pnl (pre-computed broker P&L for reference).
"""

from __future__ import annotations

import csv
import io
from datetime import date, datetime, timedelta
from typing import Any

METHODS = ("fifo", "lifo")


# ─── Core engine ─────────────────────────────────────────────────────────────


def _parse_date(val: str | None) -> date | None:
    if not val:
        return None
    for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%S", "%m/%d/%Y"):
        try:
            return datetime.strptime(val[:10], fmt[:len(fmt.split("%")[0]) + 8]).date()
        except ValueError:
            continue
    try:
        return date.fromisoformat(str(val)[:10])
    except Exception:
        return None


def _lot_key(trade: dict) -> str:
    """Unique key identifying a position type for wash-sale matching."""
    ticker = (trade.get("ticker") or "").upper()
    opt_type = (trade.get("opt_type") or "equity").lower()
    strike = trade.get("strike") or 0
    return f"{ticker}|{opt_type}|{strike}"


def compute_tax_lots(
    trades: list[dict[str, Any]],
    method: str = "fifo",
    tax_year: int | None = None,
) -> dict[str, Any]:
    """Compute realized gains, losses, and wash-sale adjustments.

    Args:
        trades:    List of closed_trade dicts from the DB.
        method:    "fifo" (default) or "lifo" — lot matching order.
        tax_year:  If provided, filter realized events to this calendar year.
                   Open lots from prior years are still used for basis.

    Returns:
        {
          "realized": [RealizationEvent, ...],
          "summary": {
              "short_term_gain": float,
              "long_term_gain": float,
              "wash_sale_disallowed": float,
              "net_gain": float,
          },
          "open_lots": [Lot, ...],   # unrealized positions still open
          "method": str,
        }

    RealizationEvent:
        ticker, description, open_date, close_date, open_price, close_price,
        quantity, proceeds, cost_basis, gain_loss, term ("S"/"L"),
        wash_sale_disallowed (float), adjusted_gain_loss, box (1a-1d for 8949)

    Lot:
        ticker, description, open_date, quantity, cost_basis_per_unit, remaining
    """
    method = method.lower()
    if method not in METHODS:
        raise ValueError(f"method must be one of {METHODS}")

    # Build open-lot pools per position key: list of lot dicts
    # Lot: {key, ticker, opt_type, strike, open_date, cost_per_unit, remaining, description}
    open_pools: dict[str, list[dict]] = {}
    realized: list[dict] = []

    # Sort trades by open_date ascending for FIFO; close_date for realization order
    sorted_trades = sorted(trades, key=lambda t: (t.get("open_date") or ""), reverse=False)

    for trade in sorted_trades:
        ticker = (trade.get("ticker") or "").upper()
        opt_type = trade.get("opt_type") or "equity"
        strike = trade.get("strike") or 0
        qty = abs(int(trade.get("quantity") or 0))
        if qty == 0:
            continue

        open_d = _parse_date(trade.get("open_date"))
        close_d = _parse_date(trade.get("close_date"))
        open_price = float(trade.get("open_price") or 0)
        close_price = float(trade.get("close_price") or 0)
        key = _lot_key(trade)

        # Only actual options carry the 100x contract multiplier. Anything else
        # (equity, "Stock", blank) is shares and must use multiplier 1 — otherwise
        # every share trade's proceeds/cost/gain is inflated 100x.
        is_option = bool(opt_type) and opt_type.lower() in ("call", "put", "c", "p")

        # Build description
        if is_option:
            desc = f"{ticker} {opt_type} ${strike} {trade.get('close_date', '')[:10]}"
        else:
            desc = ticker

        multiplier = 100 if is_option else 1

        # Direction matters: a SHORT position receives its proceeds at OPEN (premium)
        # and pays its cost at CLOSE — the reverse of a long round-trip — so its gain is
        # (open - close), not (close - open). The journal already knows the direction;
        # recover it from close_type (and pnl sign for expiries) or an explicit flag.
        ct = (trade.get("close_type") or "").lower()
        if trade.get("is_short") is not None:
            is_short = bool(trade.get("is_short"))
        elif ct in ("btc", "assigned", "short_close", "cover"):
            is_short = True
        elif ct in ("stc", "exercised", "long_close"):
            is_short = False
        elif ct == "expired":
            is_short = (trade.get("pnl") or 0) >= 0
        else:
            is_short = "short" in (trade.get("strategy") or "").lower()

        is_close = close_d is not None

        if not is_close:
            # Opening trade — add to lot pool
            lot = {
                "key": key,
                "ticker": ticker,
                "opt_type": opt_type,
                "strike": strike,
                "description": desc,
                "open_date": open_d,
                "cost_per_unit": open_price,
                "remaining": qty,
                "multiplier": multiplier,
                "is_short": is_short,
            }
            pool = open_pools.setdefault(key, [])
            if method == "lifo":
                pool.insert(0, lot)
            else:
                pool.append(lot)
        else:
            # Closing trade — match against open lots
            pool = open_pools.setdefault(key, [])
            rem_to_close = qty

            # If no open lots, create a synthetic lot (short sale opened at close)
            if not pool:
                synthetic = {
                    "key": key,
                    "ticker": ticker,
                    "opt_type": opt_type,
                    "strike": strike,
                    "description": desc,
                    "open_date": open_d or close_d,
                    "cost_per_unit": open_price,
                    "remaining": qty,
                    "multiplier": multiplier,
                    "is_short": is_short,
                    "pnl": trade.get("pnl"),
                    "orig_qty": qty,
                }
                pool.append(synthetic)

            while rem_to_close > 0 and pool:
                lot = pool[0]
                matched = min(lot["remaining"], rem_to_close)
                lot["remaining"] -= matched
                rem_to_close -= matched

                open_date_val = lot["open_date"]
                hold_days = (close_d - open_date_val).days if (close_d and open_date_val) else 0
                term = "L" if hold_days >= 365 else "S"

                # Proceeds = what you received: a short receives its premium at OPEN,
                # a long receives its sale proceeds at CLOSE.
                if lot.get("is_short"):
                    proceeds = lot["cost_per_unit"] * matched * multiplier
                else:
                    proceeds = close_price * matched * multiplier
                # Trust the journal's realized P&L for the gain when present — it already
                # accounts for short direction, expiries, assignments (premium rolled into
                # the assigned shares) and orphan closes that a raw open/close recompute
                # would mis-sign or double-count. Pro-rate across split lots, and derive the
                # cost basis so that proceeds - cost == gain for Form 8949.
                lot_pnl = lot.get("pnl")
                if lot_pnl is not None and lot.get("orig_qty"):
                    raw_gain = lot_pnl * (matched / lot["orig_qty"])
                    cost_basis = proceeds - raw_gain
                else:
                    if lot.get("is_short"):
                        cost_basis = close_price * matched * multiplier
                    else:
                        cost_basis = lot["cost_per_unit"] * matched * multiplier
                    raw_gain = proceeds - cost_basis

                event = {
                    "ticker": ticker,
                    "opt_type": opt_type,
                    "strike": strike,
                    "description": desc,
                    "open_date": str(open_date_val) if open_date_val else "",
                    "close_date": str(close_d) if close_d else "",
                    "open_price": lot["cost_per_unit"],
                    "close_price": close_price,
                    "quantity": matched,
                    "multiplier": multiplier,
                    "proceeds": round(proceeds, 2),
                    "cost_basis": round(cost_basis, 2),
                    "gain_loss": round(raw_gain, 2),
                    "term": term,
                    "hold_days": hold_days,
                    "wash_sale_disallowed": 0.0,
                    "adjusted_gain_loss": round(raw_gain, 2),
                    # 8949 box: A=short/reported, B=short/not-reported, D=long/reported, E=long/not-reported
                    "box": "A" if term == "S" else "D",
                }
                realized.append(event)

                if lot["remaining"] == 0:
                    pool.pop(0)

    # ─── Wash-sale pass (ESTIMATE) ────────────────────────────────────────────
    # A loss is (partly) disallowed if substantially identical property is
    # ACQUIRED within ±30 days of the sale (the 61-day window) — whether or not
    # that replacement was itself later closed. The disallowed amount is
    # pro-rated to the replaced quantity and rolled into a still-open replacement
    # lot's cost basis, which also inherits the washed holding period.
    # "Substantially identical" is keyed on ticker|type|strike; options
    # treatment is fact-specific, so this is an estimate.

    # Every opening is a candidate replacement acquisition (even if later closed).
    # Each opening is a replacement with a CONSUMABLE remaining quantity, so a
    # single purchase can wash at most the loss it actually replaces (1:1).
    acquisitions = []
    for t in sorted_trades:
        od = _parse_date(t.get("open_date"))
        if od:
            acquisitions.append({"key": _lot_key(t), "open_date": od, "remaining": abs(int(t.get("quantity") or 0))})

    acq_by_key: dict[str, list] = {}
    for a in acquisitions:
        acq_by_key.setdefault(a["key"], []).append(a)
    for k in acq_by_key:
        acq_by_key[k].sort(key=lambda a: a["open_date"])

    # Index still-open lots by (key, open_date) so a disallowed loss can be
    # rolled into the replacement's basis.
    open_by_acq: dict[tuple, list] = {}
    for k, pool in open_pools.items():
        for lot in pool:
            if lot["remaining"] > 0 and lot["open_date"]:
                open_by_acq.setdefault((k, lot["open_date"]), []).append(lot)

    # Process losses oldest-close first and consume replacement quantity FIFO.
    loss_events = [ev for ev in realized if ev["gain_loss"] < 0 and _parse_date(ev["close_date"])]
    loss_events.sort(key=lambda e: _parse_date(e["close_date"]))

    for ev in loss_events:
        close_d_ev = _parse_date(ev["close_date"])
        loss_qty = int(ev.get("quantity") or 0)
        if loss_qty <= 0:
            continue
        ev_open = _parse_date(ev["open_date"])
        ev_key = _lot_key({"ticker": ev["ticker"], "opt_type": ev.get("opt_type"), "strike": ev.get("strike")})
        window_start = close_d_ev - timedelta(days=30)
        window_end = close_d_ev + timedelta(days=30)

        # Consume same-key replacement acquisitions in the window (not this lot's
        # own opening), oldest first, until the loss quantity is covered.
        need = loss_qty
        consumed_dates = []
        for acq in acq_by_key.get(ev_key, []):
            if acq["remaining"] <= 0 or acq["open_date"] == ev_open:
                continue
            if not (window_start <= acq["open_date"] <= window_end):
                continue
            take = min(need, acq["remaining"])
            acq["remaining"] -= take
            need -= take
            consumed_dates.append((acq["open_date"], take))
            if need <= 0:
                break
        consumed = loss_qty - need
        if consumed <= 0:
            continue

        disallowed = round(abs(ev["gain_loss"]) * (consumed / loss_qty), 2)
        if disallowed <= 0:
            continue
        ev["wash_sale_disallowed"] = disallowed
        ev["adjusted_gain_loss"] = round(ev["gain_loss"] + disallowed, 2)
        ev["box"] = "B" if ev["term"] == "S" else "E"

        # Roll the disallowed loss into still-open replacement lots' basis
        # (pro-rated by consumed qty) and carry the washed holding period.
        for od, take in consumed_dates:
            lots = open_by_acq.get((ev_key, od))
            if lots:
                add = round(abs(ev["gain_loss"]) * (take / loss_qty), 2)
                lots[0]["wash_basis_add"] = lots[0].get("wash_basis_add", 0.0) + add
                if ev_open:
                    cur = lots[0].get("wash_hold_from")
                    lots[0]["wash_hold_from"] = ev_open if (cur is None or ev_open < cur) else cur

    # ─── Filter to tax year ───────────────────────────────────────────────────
    if tax_year:
        realized_in_year = [
            ev for ev in realized
            if (ev["close_date"] or "").startswith(str(tax_year))
        ]
    else:
        realized_in_year = realized

    # ─── Summary ─────────────────────────────────────────────────────────────
    st_gain = sum(ev["adjusted_gain_loss"] for ev in realized_in_year if ev["term"] == "S")
    lt_gain = sum(ev["adjusted_gain_loss"] for ev in realized_in_year if ev["term"] == "L")
    wash_total = sum(ev["wash_sale_disallowed"] for ev in realized_in_year)

    open_lots_out = []
    for key, pool in open_pools.items():
        for lot in pool:
            if lot["remaining"] > 0:
                wash_add = round(lot.get("wash_basis_add", 0.0), 2)
                base_cb = lot["cost_per_unit"] * lot["remaining"] * lot["multiplier"]
                open_lots_out.append({
                    "ticker": lot["ticker"],
                    "description": lot["description"],
                    "open_date": str(lot["open_date"]) if lot["open_date"] else "",
                    "quantity": lot["remaining"],
                    "cost_per_unit": lot["cost_per_unit"],
                    "cost_basis": round(base_cb + wash_add, 2),
                    "wash_basis_added": wash_add,
                    "wash_hold_from": str(lot["wash_hold_from"]) if lot.get("wash_hold_from") else None,
                })

    return {
        "realized": realized_in_year,
        "all_realized": realized,
        "summary": {
            "short_term_gain": round(st_gain, 2),
            "long_term_gain": round(lt_gain, 2),
            "wash_sale_disallowed": round(wash_total, 2),
            "net_gain": round(st_gain + lt_gain, 2),
            "event_count": len(realized_in_year),
        },
        "open_lots": open_lots_out,
        "method": method,
        "tax_year": tax_year,
    }


# ─── Form 8949 CSV export ────────────────────────────────────────────────────


_8949_HEADERS = [
    "Box",
    "Description of Property",
    "Date Acquired",
    "Date Sold or Disposed",
    "Proceeds",
    "Cost Basis",
    "Adjustment Code",
    "Adjustment Amount",
    "Gain or (Loss)",
]


def to_8949_rows(realized: list[dict]) -> list[dict]:
    """Convert realized events to Form 8949 row dicts."""
    rows = []
    for ev in realized:
        adj_code = "W" if ev["wash_sale_disallowed"] > 0 else ""
        adj_amount = ev["wash_sale_disallowed"] if ev["wash_sale_disallowed"] > 0 else ""
        rows.append({
            "Box": ev["box"],
            "Description of Property": ev["description"],
            "Date Acquired": ev["open_date"],
            "Date Sold or Disposed": ev["close_date"],
            "Proceeds": ev["proceeds"],
            "Cost Basis": ev["cost_basis"],
            "Adjustment Code": adj_code,
            "Adjustment Amount": adj_amount,
            "Gain or (Loss)": ev["adjusted_gain_loss"],
        })
    return rows


def export_8949_csv(realized: list[dict]) -> str:
    """Return a Form 8949-compatible CSV string."""
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=_8949_HEADERS, lineterminator="\n")
    writer.writeheader()
    writer.writerows(to_8949_rows(realized))
    return buf.getvalue()
