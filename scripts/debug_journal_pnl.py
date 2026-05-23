"""One-off debug: journal P&L breakdown for a Fidelity history CSV."""
import csv
import io
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app import (  # noqa: E402
    _apply_cross_day_strategy_groups,
    _apply_strategy_groups,
    _build_equity_closed_trades,
    _fifo_closed_option_trades,
    _format_roll_rows,
    _journal_aggregate_trades,
    _link_assignments_to_equity,
    _link_rolls,
    _plain_equity_ticker,
    _rollup_assignment_pnl,
)


def parse_fidelity_history(text: str):
    reader = csv.reader(io.StringIO(text))
    rows = list(reader)
    header = [h.strip().strip('"') for h in rows[0]]
    idx = {h.lower(): i for i, h in enumerate(header)}
    date_idx = idx.get("run date", 0)
    action_idx = idx.get("action", 1)
    sym_idx = idx.get("symbol", 2)
    price_idx = idx.get("price ($)", 5)
    qty_idx = idx.get("quantity", 6)

    trades = {}
    equity_txns = {}
    for r in rows[1:]:
        if len(r) <= max(date_idx, action_idx, sym_idx):
            continue
        ds = r[date_idx].strip().strip('"')
        if not ds or not ds[0].isdigit():
            continue
        action = r[action_idx].strip().strip('"').upper()
        sym_raw = r[sym_idx].strip().strip('"')
        sym = sym_raw.lower().replace(" ", "")
        try:
            price_raw = r[price_idx].strip().strip('"').replace("$", "").replace(",", "").replace("+", "")
            price = abs(float(price_raw)) if price_raw else 0
        except (ValueError, IndexError):
            price = 0
        try:
            qty_raw = r[qty_idx].strip().strip('"').replace(",", "")
            qty = abs(int(float(qty_raw))) if qty_raw else 0
        except (ValueError, IndexError):
            qty = 0
        if qty == 0 and "EXPIRED" not in action:
            continue
        dp = ds.split("/")
        dt = f"{dp[2]}-{dp[0].zfill(2)}-{dp[1].zfill(2)}"

        eq_ticker = _plain_equity_ticker(sym_raw)
        if eq_ticker and "OPENING TRANSACTION" not in action and "CLOSING TRANSACTION" not in action:
            side = None
            if "SOLD SHORT" in action or ("SOLD" in action and "SHORT SALE" in action):
                side = "short_open"
            elif "BOUGHT SHORT COVER" in action or ("BOUGHT" in action and "SHORT COVER" in action):
                side = "short_close"
            elif "BOUGHT" in action and "SHORT" not in action:
                side = "long_open"
            elif "SOLD" in action and "SHORT" not in action:
                side = "long_close"
            if side:
                equity_txns.setdefault(eq_ticker, []).append(
                    {"date": dt, "side": side, "qty": qty, "price": price}
                )
            continue

        trades.setdefault(sym, []).append({"date": dt, "action": action, "qty": qty, "price": price})

    closed = []
    opens = []
    for sym, txns in trades.items():
        matched, open_events, _ledger = _fifo_closed_option_trades(sym, txns)
        opens.extend(open_events)
        closed.extend(matched)
    for ticker, txns in equity_txns.items():
        closed.extend(_build_equity_closed_trades(ticker, txns))
    return closed, opens


def main():
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        r"h:\Downloads\History_for_Account_Z19850914 (16).csv"
    )
    hist = path.read_text(encoding="utf-8-sig")
    closed, opens = parse_fidelity_history(hist)

    def summarize(label, rows):
        opt = sum(t["pnl"] for t in rows if t.get("instrument") != "equity")
        eq = sum(t["pnl"] for t in rows if t.get("instrument") == "equity")
        print(f"{label}: total={sum(t['pnl'] for t in rows):,.2f}  opt={opt:,.2f}  eq={eq:,.2f}  n={len(rows)}")

    summarize("Raw FIFO closed", closed)

    _link_rolls(closed, opens)
    leg_sum = sum(t["pnl"] for t in closed)
    roll_net = sum(t.get("rollNetPnl", 0) for t in closed if t.get("isRoll"))
    print(f"After link_rolls: leg_sum={leg_sum:,.2f}  rollNetPnl_if_used={roll_net:,.2f}  rolls={sum(1 for t in closed if t.get('isRoll'))}")

    _format_roll_rows(closed)
    summarize("After format_roll_rows (current journal pnl)", closed)

    _apply_strategy_groups(closed)
    _apply_cross_day_strategy_groups(closed)
    _link_assignments_to_equity(closed)
    _rollup_assignment_pnl(closed)
    visible = _journal_aggregate_trades(closed)
    summarize("After assignment rollup (visible journal)", visible)
    suppressed = [t for t in closed if t.get("journalSuppress")]
    print(f"Suppressed equity legs: n={len(suppressed)} pnl={sum(t['pnl'] for t in suppressed):,.2f}")

    # What if rolls kept leg pnl only
    closed2, opens2 = parse_fidelity_history(hist)
    _link_rolls(closed2, opens2)
    leg_only = sum(t["pnl"] for t in closed2)
    print(f"If rolls kept leg P&L only: {leg_only:,.2f}")

    # Amount column sanity from CSV
    reader = csv.reader(io.StringIO(hist))
    rows = list(reader)
    idx = {h.strip().strip('"').lower(): i for i, h in enumerate(rows[0])}
    amt_i = idx.get("amount ($)")
    if amt_i is not None:
        total_amt = 0
        for r in rows[1:]:
            if len(r) <= amt_i:
                continue
            raw = r[amt_i].strip().strip('"').replace(",", "").replace("$", "")
            if not raw or raw.lower() in ("processing", ""):
                continue
            try:
                total_amt += float(raw)
            except ValueError:
                pass
        print(f"Sum Amount ($) column (cash flow, not P&L): {total_amt:,.2f}")


if __name__ == "__main__":
    main()
