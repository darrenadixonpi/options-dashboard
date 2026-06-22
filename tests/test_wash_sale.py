"""Wash-sale estimate tests for compute_tax_lots.

Inputs mirror DB closed_trades (round-trips with both open_date and close_date),
except open replacement lots, which intentionally omit close_date.
"""

from tax_lots import compute_tax_lots


def _losses(res):
    return [e for e in res["all_realized"] if e["gain_loss"] < 0]


def test_full_wash_when_replacement_matches_quantity():
    trades = [
        {"ticker": "AAA", "opt_type": "Stock", "strike": 0, "open_date": "2026-01-02",
         "close_date": "2026-02-02", "open_price": 10.0, "close_price": 8.0,
         "quantity": 100, "close_type": "sold", "pnl": -200.0},
        {"ticker": "AAA", "opt_type": "Stock", "strike": 0, "open_date": "2026-02-10",
         "close_date": "2026-03-20", "open_price": 8.5, "close_price": 9.0,
         "quantity": 100, "close_type": "sold", "pnl": 50.0},
    ]
    res = compute_tax_lots(trades, method="fifo")
    loss = _losses(res)[0]
    assert abs(loss["wash_sale_disallowed"] - 200.0) < 0.5
    assert abs(loss["adjusted_gain_loss"]) < 0.5
    assert res["summary"]["wash_sale_disallowed"] > 0


def test_partial_wash_prorates_to_replaced_quantity():
    trades = [
        {"ticker": "BBB", "opt_type": "Stock", "strike": 0, "open_date": "2026-01-02",
         "close_date": "2026-02-02", "open_price": 10.0, "close_price": 8.0,
         "quantity": 100, "close_type": "sold", "pnl": -200.0},
        {"ticker": "BBB", "opt_type": "Stock", "strike": 0, "open_date": "2026-02-10",
         "close_date": "2026-03-20", "open_price": 8.5, "close_price": 9.0,
         "quantity": 40, "close_type": "sold", "pnl": 20.0},
    ]
    res = compute_tax_lots(trades, method="fifo")
    loss = _losses(res)[0]
    assert abs(loss["wash_sale_disallowed"] - 80.0) < 0.5   # 40% of 200
    assert abs(loss["adjusted_gain_loss"] - (-120.0)) < 0.5


def test_no_wash_without_replacement():
    trades = [
        {"ticker": "CCC", "opt_type": "Stock", "strike": 0, "open_date": "2026-01-02",
         "close_date": "2026-02-02", "open_price": 10.0, "close_price": 8.0,
         "quantity": 100, "close_type": "sold", "pnl": -200.0},
    ]
    res = compute_tax_lots(trades, method="fifo")
    loss = _losses(res)[0]
    assert loss["wash_sale_disallowed"] == 0.0
    assert abs(loss["adjusted_gain_loss"] - (-200.0)) < 0.5


def test_outside_window_is_not_a_wash():
    # Replacement opened 45 days after the loss close -> outside the 61-day window.
    trades = [
        {"ticker": "EEE", "opt_type": "Stock", "strike": 0, "open_date": "2026-01-02",
         "close_date": "2026-02-02", "open_price": 10.0, "close_price": 8.0,
         "quantity": 100, "close_type": "sold", "pnl": -200.0},
        {"ticker": "EEE", "opt_type": "Stock", "strike": 0, "open_date": "2026-03-19",
         "close_date": "2026-04-20", "open_price": 8.5, "close_price": 9.0,
         "quantity": 100, "close_type": "sold", "pnl": 50.0},
    ]
    res = compute_tax_lots(trades, method="fifo")
    assert _losses(res)[0]["wash_sale_disallowed"] == 0.0


def test_disallowed_loss_rolls_into_open_replacement_basis():
    trades = [
        {"ticker": "DDD", "opt_type": "Stock", "strike": 0, "open_date": "2026-01-02",
         "close_date": "2026-02-02", "open_price": 10.0, "close_price": 8.0,
         "quantity": 100, "close_type": "sold", "pnl": -200.0},
        # replacement still open (no close_date)
        {"ticker": "DDD", "opt_type": "Stock", "strike": 0, "open_date": "2026-02-10",
         "open_price": 8.5, "quantity": 100},
    ]
    res = compute_tax_lots(trades, method="fifo")
    assert abs(_losses(res)[0]["wash_sale_disallowed"] - 200.0) < 0.5
    ddd = [l for l in res["open_lots"] if l["ticker"] == "DDD"]
    assert ddd, "expected an open replacement lot"
    assert abs(ddd[0]["wash_basis_added"] - 200.0) < 0.5
    assert ddd[0]["wash_hold_from"] == "2026-01-02"   # holding period carried back


def test_one_replacement_washes_only_one_of_two_losses():
    # Two FFF losses; a single 100-share replacement sits in both windows. With
    # 1:1 consumption only one loss is washed (~$200), not both ($400). The loss
    # openings are long ago so they aren't replacements for each other.
    trades = [
        {"ticker": "FFF", "opt_type": "Stock", "strike": 0, "open_date": "2025-06-01",
         "close_date": "2026-02-02", "open_price": 10.0, "close_price": 8.0,
         "quantity": 100, "close_type": "sold", "pnl": -200.0},
        {"ticker": "FFF", "opt_type": "Stock", "strike": 0, "open_date": "2025-06-02",
         "close_date": "2026-02-05", "open_price": 10.0, "close_price": 8.0,
         "quantity": 100, "close_type": "sold", "pnl": -200.0},
        {"ticker": "FFF", "opt_type": "Stock", "strike": 0, "open_date": "2026-02-10",
         "close_date": "2026-03-20", "open_price": 8.5, "close_price": 9.0,
         "quantity": 100, "close_type": "sold", "pnl": 50.0},
    ]
    res = compute_tax_lots(trades, method="fifo")
    total = sum(e["wash_sale_disallowed"] for e in _losses(res))
    assert abs(total - 200.0) < 0.5
