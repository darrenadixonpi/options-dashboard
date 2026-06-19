"""Tax-lot computation tests — lock in the realized-P&L fixes.

Covers the bugs fixed in compute_tax_lots:
  1. Shares must use a 1x multiplier (options-only ×100).
  2. Short options are signed (open - close), not (close - open).
  3. The journal's per-trade pnl is trusted when present (assignments/expiries/orphans).
  4. Assignments are presented as STOCK sales with premium-adjusted basis.

Each input trade is a pre-matched round-trip (both open_date and close_date set),
mirroring how the app feeds DB closed_trades into compute_tax_lots.
"""

from tax_lots import compute_tax_lots


def _only(trades):
    res = compute_tax_lots(trades, method="fifo", tax_year=None)
    assert len(res["realized"]) == 1, res["realized"]
    return res["realized"][0], res["summary"]


def test_stock_uses_unit_multiplier_not_100():
    # 100 shares, +$1/share => +$100, NOT +$10,000.
    trade = {
        "ticker": "AAA", "opt_type": "Stock", "strike": 0,
        "open_date": "2026-01-02", "close_date": "2026-01-05",
        "open_price": 10.0, "close_price": 11.0, "quantity": 100,
        "close_type": "sold",
    }
    ev, summary = _only([trade])
    assert ev["multiplier"] == 1
    assert ev["proceeds"] == 1100.0
    assert ev["cost_basis"] == 1000.0
    assert ev["gain_loss"] == 100.0
    assert summary["net_gain"] == 100.0


def test_short_option_sign_is_open_minus_close():
    # Short put sold for $2.00, bought to close for $0.50 => +$150 (not -$150).
    trade = {
        "ticker": "BBB", "opt_type": "Put", "strike": 5,
        "open_date": "2026-01-02", "close_date": "2026-02-02",
        "open_price": 2.0, "close_price": 0.5, "quantity": 1,
        "close_type": "btc",  # buy-to-close => was short
    }
    ev, _ = _only([trade])
    assert ev["multiplier"] == 100
    assert ev["proceeds"] == 200.0      # premium received at open
    assert ev["cost_basis"] == 50.0     # paid to close
    assert ev["gain_loss"] == 150.0


def test_long_option_sign_is_close_minus_open():
    # Long call bought $1.00, sold $3.00 => +$200.
    trade = {
        "ticker": "CCC", "opt_type": "Call", "strike": 10,
        "open_date": "2026-01-02", "close_date": "2026-01-20",
        "open_price": 1.0, "close_price": 3.0, "quantity": 1,
        "close_type": "stc",  # sell-to-close => was long
    }
    ev, _ = _only([trade])
    assert ev["cost_basis"] == 100.0
    assert ev["proceeds"] == 300.0
    assert ev["gain_loss"] == 200.0


def test_short_option_closed_at_loss_stays_a_loss():
    # Short put sold $1.00, bought back $4.00 => -$300 (regression guard for the flip).
    trade = {
        "ticker": "DDD", "opt_type": "Put", "strike": 8,
        "open_date": "2026-01-02", "close_date": "2026-01-15",
        "open_price": 1.0, "close_price": 4.0, "quantity": 1,
        "close_type": "btc",
    }
    ev, _ = _only([trade])
    assert ev["gain_loss"] == -300.0


def test_assignment_trusts_journal_pnl():
    # Assigned short put whose combined (option+equity) pnl is supplied by the journal.
    # The tax module must honor that pnl rather than recompute from open/close.
    trade = {
        "ticker": "EEE", "opt_type": "Put", "strike": 130,
        "open_date": "2026-03-01", "close_date": "2026-04-01",
        "open_price": 40.8, "close_price": 0.0, "quantity": 1,
        "close_type": "assigned", "pnl": 1500.0,
    }
    ev, _ = _only([trade])
    assert ev["gain_loss"] == 1500.0
    # Proceeds/cost reconcile to the gain: proceeds - cost == gain.
    assert round(ev["proceeds"] - ev["cost_basis"], 2) == 1500.0


def test_expired_short_keeps_premium_as_gain():
    # Expired short call (price 0 at close): is_short inferred from pnl >= 0; +premium.
    trade = {
        "ticker": "FFF", "opt_type": "Call", "strike": 550,
        "open_date": "2026-01-02", "close_date": "2026-03-27",
        "open_price": 9.36, "close_price": 0.0, "quantity": 1,
        "close_type": "expired", "pnl": 936.0,
    }
    ev, _ = _only([trade])
    assert ev["gain_loss"] == 936.0
    assert ev["proceeds"] == 936.0
    assert ev["cost_basis"] == 0.0


def test_assignment_presented_as_stock_sale():
    # An assigned short put (strike 130, $40.80 premium) -> 100 shares bought at 130,
    # later sold at 100. Persisted as a Stock row with premium-adjusted basis (89.20).
    # Combined pnl = equity (-3000) + premium (4080) = 1080.
    trade = {
        "ticker": "GGG", "opt_type": "Stock", "strike": 0,
        "open_date": "2026-03-01", "close_date": "2026-04-01",
        "open_price": 89.20, "close_price": 100.0, "quantity": 100,
        "close_type": "sold", "pnl": 1080.0,
    }
    ev, _ = _only([trade])
    assert ev["multiplier"] == 1                 # stock, not x100 option
    assert ev["description"] == "GGG"            # labeled as the underlying, not an option
    assert ev["proceeds"] == 10000.0             # 100 sh x $100
    assert ev["cost_basis"] == 8920.0            # premium-adjusted basis (89.20 x 100)
    assert ev["gain_loss"] == 1080.0


def test_mixed_book_net_matches_sum_of_pnl():
    # When every row carries pnl, the realized net equals the sum of pnl regardless
    # of direction — the property that makes the tax-lot reconcile to the journal.
    trades = [
        {"ticker": "S", "opt_type": "Put", "strike": 5, "open_date": "2026-01-02",
         "close_date": "2026-01-10", "open_price": 2.0, "close_price": 0.5,
         "quantity": 1, "close_type": "btc", "pnl": 150.0},
        {"ticker": "L", "opt_type": "Call", "strike": 10, "open_date": "2026-01-02",
         "close_date": "2026-01-10", "open_price": 1.0, "close_price": 3.0,
         "quantity": 1, "close_type": "stc", "pnl": 200.0},
        {"ticker": "X", "opt_type": "Stock", "strike": 0, "open_date": "2026-01-02",
         "close_date": "2026-01-10", "open_price": 10.0, "close_price": 9.0,
         "quantity": 50, "close_type": "sold", "pnl": -50.0},
    ]
    res = compute_tax_lots(trades, method="fifo", tax_year=None)
    assert res["summary"]["net_gain"] == 300.0  # 150 + 200 - 50
