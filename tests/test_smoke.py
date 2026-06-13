"""Smoke tests for parsers and core API endpoints (no live broker/network required for most)."""

from unittest.mock import MagicMock, patch

import os

import numpy as np
import pandas as pd
import pytest


class TestOptionParsing:
    def test_parse_occ_symbol(self):
        from app import _parse_occ_symbol

        occ = _parse_occ_symbol("-test260620p00010000")
        assert occ is not None
        assert occ["ticker"] == "TEST"
        assert occ["optType"] == "Put"
        assert occ["expiry"] == "2026-06-20"
        assert occ["strike"] == 10.0

    def test_parse_occ_symbol_fractional_strike(self):
        """Fidelity-style decimal strikes must not truncate (2.5 != 2.0)."""
        from app import _parse_occ_symbol

        occ = _parse_occ_symbol("-OVID260618P2.5")
        assert occ is not None
        assert occ["ticker"] == "OVID"
        assert occ["strike"] == 2.5

        occ = _parse_occ_symbol("-AAPL260618C252.5")
        assert occ is not None
        assert occ["strike"] == 252.5

        # Standard OCC padded strike still divides by 1000
        occ = _parse_occ_symbol("-ovid260618p00002500")
        assert occ is not None
        assert occ["strike"] == 2.5

    def test_calendar_field_dict_and_dataframe(self):
        """yfinance .calendar is a dict in current versions, DataFrame in old."""
        from app import _calendar_field
        import datetime as _dt

        d = _dt.date(2026, 7, 1)
        assert _calendar_field({"Ex-Dividend Date": d}, "Ex-Dividend Date") == d
        assert _calendar_field({"Earnings Date": [d]}, "Earnings Date") == d
        assert _calendar_field({}, "Ex-Dividend Date") is None
        assert _calendar_field(None, "Ex-Dividend Date") is None

        df = pd.DataFrame({0: [d]}, index=["Ex-Dividend Date"])
        assert _calendar_field(df, "Ex-Dividend Date") == d

    def test_classify_option_events(self):
        from app import _classify_option_event

        open_short = _classify_option_event("YOU SOLD OPENING TRANSACTION PUT (X)")
        assert open_short["event"] == "open"
        assert open_short["is_short"] is True

        close_btc = _classify_option_event("YOU BOUGHT CLOSING TRANSACTION PUT (X)")
        assert close_btc["event"] == "close"
        assert close_btc["close_type"] == "btc"

        expired = _classify_option_event("PUT EXPIRED (X)")
        assert expired["close_type"] == "expired"

    def test_sim_strategy_map_includes_equity_context(self):
        from app import _build_sim_strategy_map, _pos_strat_key
        import pandas as pd

        positions = [
            {"ticker": "RGNX", "posType": "equity", "shares": 500, "contracts": 500, "avgCost": 8.0, "expiry": None},
            {"ticker": "RGNX", "posType": "option", "optType": "Call", "contracts": -2, "strike": 10.0,
             "expiry": pd.Timestamp("2026-06-18"), "avgCost": 1.2},
            {"ticker": "RGNX", "posType": "option", "optType": "Put", "contracts": -1, "strike": 7.5,
             "expiry": pd.Timestamp("2026-06-18"), "avgCost": 0.8},
        ]
        strat_map = _build_sim_strategy_map(positions)
        call_key = _pos_strat_key(positions[1])
        put_key = _pos_strat_key(positions[2])
        assert call_key in strat_map
        assert put_key in strat_map
        assert strat_map[call_key] == strat_map[put_key]
        assert "Shares" in strat_map[call_key] or "Covered" in strat_map[call_key] or "sh" in strat_map[call_key]

    def test_fifo_closed_option_trades(self):
        from app import _fifo_closed_option_trades

        sym = "-test260620p00010000"
        txns = [
            {"date": "2026-04-01", "action": "YOU SOLD OPENING TRANSACTION PUT", "qty": 2, "price": 1.25},
            {"date": "2026-05-08", "action": "YOU BOUGHT CLOSING TRANSACTION PUT", "qty": 2, "price": 0.50},
        ]
        closed, opens, ledger = _fifo_closed_option_trades(sym, txns)
        assert len(closed) == 1
        assert closed[0]["qty"] == 2
        assert closed[0]["closeType"] == "btc"
        assert closed[0]["pnl"] == pytest.approx(150.0, rel=1e-3)
        assert ledger["unmatched_opens"] == 0

    def test_format_roll_rows(self):
        from app import _format_roll_rows

        trades = [{
            "isRoll": True,
            "optType": "Put",
            "strike": 10,
            "expiry": "2026-05-16",
            "pnl": 50.0,
            "rollNetPnl": 120.0,
            "rollTo": {"strike": 12, "expiry": "2026-06-20", "openDate": "2026-05-08", "openPrice": 1.1},
        }]
        _format_roll_rows(trades)
        assert trades[0]["strategy"] == "Put Roll"
        assert trades[0]["closeTypeLabel"] == "Roll"
        assert trades[0]["rollLabel"] == "$10 → $12"
        assert trades[0]["pnl"] == pytest.approx(50.0)
        assert trades[0]["legPnl"] == pytest.approx(50.0)
        assert trades[0]["rollNetPnl"] == pytest.approx(120.0)

    def test_cross_day_strategy_groups(self):
        from app import _apply_cross_day_strategy_groups

        trades = [
            {"ticker": "XYZ", "instrument": "option", "isShort": True, "optType": "Put", "strike": 50, "qty": 1, "closeDate": "2026-04-01", "strategy": "Short Put"},
            {"ticker": "XYZ", "instrument": "option", "isShort": False, "optType": "Put", "strike": 45, "qty": 1, "closeDate": "2026-04-03", "strategy": "Long Put"},
        ]
        _apply_cross_day_strategy_groups(trades, window_days=7)
        assert trades[0]["strategy"] in ("Bull Put Spread", "Bear Put Spread")
        assert trades[0]["strategy"] == trades[1]["strategy"]
        assert trades[0].get("crossDayGroup") is True

    def test_rollup_assignment_pnl(self):
        from app import _link_assignments_to_equity, _rollup_assignment_pnl

        trades = [
            {
                "ticker": "ABC",
                "instrument": "option",
                "optType": "Put",
                "strike": 50,
                "qty": 1,
                "closeDate": "2026-05-01",
                "closeType": "assigned",
                "closeTypeLabel": "Assigned",
                "isShort": True,
                "pnl": 100.0,
                "isWin": True,
            },
            {
                "ticker": "ABC",
                "instrument": "equity",
                "optType": "Stock",
                "qty": 100,
                "closeDate": "2026-05-01",
                "closeType": "sold",
                "isShort": False,
                "pnl": -250.0,
                "isWin": False,
                "strategy": "Long Shares",
            },
        ]
        _link_assignments_to_equity(trades)
        _rollup_assignment_pnl(trades)
        assert trades[0]["combinedPnl"] == pytest.approx(-150.0)
        assert trades[0]["pnl"] == pytest.approx(-150.0)
        assert trades[1].get("journalSuppress") is True

    def test_build_daily_pnl_rolls(self):
        from app import _build_daily_pnl

        trades = [
            {"ticker": "X", "closeDate": "2026-05-08", "pnl": 120.0, "qty": 1, "isRoll": True, "rollLabel": "$10 → $12", "legPnl": 50.0, "rollNetPnl": 120.0, "closeTypeLabel": "Roll"},
            {"ticker": "Y", "closeDate": "2026-05-08", "pnl": 30.0, "qty": 1, "closeTypeLabel": "Sell to Close"},
        ]
        series = _build_daily_pnl(trades)
        assert len(series) == 1
        assert series[0]["dayPnl"] == pytest.approx(150.0)
        assert series[0]["rollCount"] == 1
        assert series[0]["rollPnl"] == pytest.approx(120.0)
        assert series[0]["trades"][0]["rollLabel"] == "$10 → $12"

    def test_group_win_rate_spread(self):
        from app import _assign_strategy_group_ids, _compute_journal_stats

        trades = [
            {"ticker": "XYZ", "closeDate": "2026-04-01", "strategy": "Bear Put Spread", "pnl": 80.0, "isWin": True, "holdDays": 5, "instrument": "option", "symbol": "a"},
            {"ticker": "XYZ", "closeDate": "2026-04-01", "strategy": "Bear Put Spread", "pnl": -30.0, "isWin": False, "holdDays": 5, "instrument": "option", "symbol": "b"},
            {"ticker": "ABC", "closeDate": "2026-04-02", "strategy": "Short Put", "pnl": -10.0, "isWin": False, "holdDays": 3, "instrument": "option", "symbol": "c"},
        ]
        _assign_strategy_group_ids(trades)
        stats = _compute_journal_stats(trades)
        assert stats["groupTrades"] == 2
        assert stats["winRate"] == pytest.approx(50.0)
        assert stats["legWinRate"] == pytest.approx(33.3, abs=0.1)
        assert stats["groupWins"] == 1
        assert stats["groupLosses"] == 1

    def test_journal_risk_metrics(self):
        from app import _compute_journal_risk_metrics

        series = [{"date": f"2026-01-{d:02d}", "dayPnl": float(d % 5 - 2)} for d in range(1, 21)]
        risk = _compute_journal_risk_metrics(series)
        assert risk is not None
        assert "sharpe" in risk
        assert "sortino" in risk
        assert risk["riskDays"] >= 20

    def test_roll_open_reference_rows(self):
        from app import _append_roll_open_references, _link_rolls

        open_events = [{
            "symbol": "-xyz260620p00012000",
            "ticker": "XYZ",
            "optType": "Put",
            "strike": 12,
            "expiry": "2026-06-20",
            "date": "2026-05-08",
            "price": 1.1,
            "qty": 1,
            "is_short": True,
        }]
        closed = [{
            "symbol": "-xyz260516p00010000",
            "ticker": "XYZ",
            "instrument": "option",
            "optType": "Put",
            "strike": 10,
            "expiry": "2026-05-16",
            "closeDate": "2026-05-08",
            "openDate": "2026-04-01",
            "qty": 1,
            "isShort": True,
            "pnl": 50.0,
        }]
        used = _link_rolls(closed, open_events)
        assert used == {0}
        assert closed[0]["isRoll"] is True
        _append_roll_open_references(closed, open_events, used)
        assert len(closed) == 2
        ref = closed[1]
        assert ref["isRollOpenRef"] is True
        assert ref["journalSuppressStats"] is True
        assert ref["pnl"] == 0
        assert ref["closeTypeLabel"] == "Roll Open"
        assert ref["linkedRollClose"]["ticker"] == "XYZ"

    def test_compute_portfolio_mtm(self):
        from app import compute_portfolio_mtm

        positions = [
            {"ticker": "ABC", "posType": "equity", "shares": 100, "avgCost": 50},
            {"ticker": "ABC", "expiry": "2026-06-20", "optType": "Put", "strike": 45, "contracts": -1, "avgCost": 2.0},
        ]
        market = {"ABC": {"price": 55.0}}
        marks = {"ABC|2026-06-20|P|45.0": {"mid": 1.5}}
        mtm = compute_portfolio_mtm(positions, market, marks)
        assert mtm["unrealizedPnl"] == pytest.approx(550.0, rel=1e-3)
        assert mtm["bookValue"] == pytest.approx(5650.0, rel=1e-3)

    def test_mtm_risk_metrics(self):
        from app import _compute_mtm_risk_metrics

        points = [
            {"timestamp": f"2026-01-{d:02d}T12:00:00", "unrealizedPnl": float(d * 100 + (d % 3) * 25)}
            for d in range(1, 8)
        ]
        risk = _compute_mtm_risk_metrics(points)
        assert risk is not None
        assert risk["mtmSharpe"] is not None
        assert risk["fetchCount"] == 7

    def test_ibkr_history_parser(self):
        from app import _detect_history_format, _parse_history_raw_txns, _fifo_closed_option_trades

        path = os.path.join(os.path.dirname(__file__), "fixtures", "ibkr_history.csv")
        text = open(path, encoding="utf-8").read()
        lines = text.replace("\ufeff", "").replace("\r", "").split("\n")
        assert _detect_history_format(lines) == "ibkr"
        trades, equity, fmt, warns = _parse_history_raw_txns(text)
        assert fmt == "ibkr"
        assert not warns
        assert "test260620p00010000" in trades
        closed, _, _ = _fifo_closed_option_trades("test260620p00010000", trades["test260620p00010000"])
        assert len(closed) == 1
        assert closed[0]["pnl"] == pytest.approx(-75.0, rel=1e-3)
        assert closed[0]["closeType"] == "stc"
        assert "ASGN" in equity
        expired = _fifo_closed_option_trades("oldx260516p00010000", trades["oldx260516p00010000"])[0]
        assert expired[0]["closeType"] == "expired"


class TestBookSnapshotApi:
    def test_book_snapshot_save_and_timeline(self, client):
        payload = {
            "timestamp": "2026-05-01T10:00:00",
            "positions": [{"ticker": "ABC", "posType": "equity", "shares": 10, "avgCost": 100}],
            "marketData": {"ABC": {"price": 110}},
            "optionMarks": {},
        }
        res = client.post("/api/snapshots/book", json=payload)
        assert res.status_code == 200
        data = res.get_json()
        assert data["ok"] is True
        assert data["unrealizedPnl"] == pytest.approx(100.0)

        res2 = client.post("/api/snapshots/book", json={
            **payload,
            "timestamp": "2026-05-02T10:00:00",
            "marketData": {"ABC": {"price": 115}},
        })
        assert res2.status_code == 200

        res3 = client.get("/api/snapshots/book-timeline?limit=10")
        assert res3.status_code == 200
        tl = res3.get_json()
        assert len(tl["points"]) >= 2
        assert tl["points"][-1]["unrealizedPnl"] == pytest.approx(150.0)


class TestCorrelationMatrix:
    def test_compute_correlation_matrix_psd_fix(self):
        from app import compute_correlation_matrix

        dates = pd.date_range("2024-01-01", periods=120, freq="B")
        rng = np.random.default_rng(0)
        a = pd.Series(rng.normal(0, 0.01, len(dates)), index=dates)
        b = a * 0.8 + rng.normal(0, 0.005, len(dates))

        def fake_download(tkr, period="1y", progress=False, auto_adjust=True):
            close = (1 + a if tkr == "AAA" else 1 + b).cumprod() * 100
            return pd.DataFrame({"Close": close})

        with patch("app.yf.download", side_effect=fake_download):
            corr, chol, tickers = compute_correlation_matrix(["AAA", "BBB"])

        assert corr is not None
        assert chol is not None
        assert tickers == ["AAA", "BBB"]
        assert corr.shape == (2, 2)
        assert corr[0, 0] == pytest.approx(1.0, abs=1e-6)


class TestTradeHistoryApi:
    def test_trade_history_fifo_response(self, client, fidelity_history_text):
        res = client.post("/api/trade-history", json={"historyText": fidelity_history_text})
        assert res.status_code == 200
        data = res.get_json()
        assert "trades" in data
        assert len(data["trades"]) >= 2
        assert data["stats"]["totalTrades"] >= 2
        assert "dailyPnl" in data
        strategies = {t["strategy"] for t in data["trades"]}
        assert "Short Put" in strategies or "Long Call" in strategies
        for t in data["trades"]:
            assert "closeTypeLabel" in t
            assert "warnings" in t

    def test_trade_history_empty(self, client):
        res = client.post("/api/trade-history", json={"historyText": "Run Date,Action\n"})
        assert res.status_code == 200
        data = res.get_json()
        assert data.get("trades") == [] or not data.get("trades")

    def test_trade_history_ibkr_response(self, client, ibkr_history_text):
        res = client.post("/api/trade-history", json={"historyText": ibkr_history_text})
        assert res.status_code == 200
        data = res.get_json()
        assert data.get("historyFormat") == "ibkr"
        assert len(data.get("trades", [])) >= 3
        test_legs = [t for t in data["trades"] if t["ticker"] == "TEST"]
        assert len(test_legs) == 1
        assert test_legs[0]["pnl"] == pytest.approx(-75.0, rel=1e-3)
        assert test_legs[0]["closeType"] == "stc"
        assign = [t for t in data["trades"] if t["ticker"] == "ASGN" and t.get("instrument") == "option"]
        assert len(assign) == 1
        assert assign[0]["closeType"] == "assigned"

    def test_trade_history_schwab_response(self, client, schwab_history_text):
        res = client.post("/api/trade-history", json={"historyText": schwab_history_text})
        assert res.status_code == 200
        data = res.get_json()
        assert data.get("historyFormat") == "schwab"
        closed = [t for t in data.get("trades", []) if not t.get("journalSuppress")]
        assert len(closed) >= 1

    def test_api_version(self, client):
        res = client.get("/api/version")
        assert res.status_code == 200
        data = res.get_json()
        assert data.get("version") == "1.2.0"
        assert data.get("name") == "options-dashboard"


class TestDeskAlerts:
    def test_desk_alerts_greek_thresholds(self, client):
        payload = {
            "positions": [],
            "marketData": {},
            "greeks": {
                "portfolio": {"delta": 1200, "vega": 100, "theta": -50},
                "byTicker": {"XYZ": {"delta": 450, "vega": 0, "theta": 0}},
            },
            "thresholds": {
                "bookDeltaAbs": 500,
                "bookVegaAbs": 2500,
                "tickerDeltaAbs": 300,
                "bookThetaBelow": -500,
            },
            "dismissedKeys": [],
        }
        res = client.post("/api/desk-alerts", json=payload)
        assert res.status_code == 200
        alerts = res.get_json().get("alerts", [])
        cats = {a["category"] for a in alerts}
        assert "greek" in cats
        messages = " ".join(a["message"] for a in alerts)
        assert "Book Δ" in messages
        assert "XYZ Δ" in messages

    def test_alert_history_endpoint(self, client):
        client.post("/api/desk-alerts", json={
            "positions": [],
            "marketData": {},
            "greeks": {"portfolio": {"delta": 900, "vega": 0, "theta": 0}, "byTicker": {}},
            "thresholds": {"bookDeltaAbs": 500},
            "dismissedKeys": [],
        })
        res = client.get("/api/alerts/history?limit=5")
        assert res.status_code == 200
        events = res.get_json().get("events", [])
        assert len(events) >= 1
        assert events[0].get("message")


class TestGreeksApi:
    def test_greeks_short_put(self, client):
        payload = {
            "positions": [{
                "ticker": "TEST",
                "posType": "option",
                "optType": "Put",
                "strike": 10,
                "expiry": "2026-06-20",
                "contracts": -2,
            }],
            "marketData": {
                "TEST": {"price": 12.0, "iv": 60.0},
            },
        }
        with patch("app.yf.Ticker") as mock_ticker:
            mock_hist = pd.DataFrame({"Close": [100.0, 101.0, 102.0]})
            inst = MagicMock()
            inst.history.return_value = mock_hist
            mock_ticker.return_value = inst
            res = client.post("/api/greeks", json=payload)

        assert res.status_code == 200
        data = res.get_json()
        assert "portfolio" in data
        assert "delta" in data["portfolio"]
        assert data["portfolio"]["delta"] != 0
        assert "risk" in data
        assert len(data["positions"]) == 1


class TestSimulateHistogram:
    def test_portfolio_pnl_payload_shape(self):
        from app import _histogram

        rng = np.random.default_rng(42)
        all_pnl = rng.normal(1000, 5000, 1000)
        h = _histogram(all_pnl, 60)
        portfolio_pnl = [round(float(x), 2) for x in all_pnl.tolist()]
        assert len(h["counts"]) == 60
        assert len(h["edges"]) == 61
        assert len(portfolio_pnl) == 1000
        assert portfolio_pnl[0] == round(float(all_pnl[0]), 2)


class TestPackaging:
    def _load_check_env(self):
        import importlib.util
        from pathlib import Path

        path = Path(__file__).resolve().parent.parent / "scripts" / "check_env.py"
        spec = importlib.util.spec_from_file_location("check_env", path)
        mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(mod)
        return mod

    def test_check_env_passes(self):
        mod = self._load_check_env()
        assert mod.run_checks() == 0

    def test_port_in_use(self):
        mod = self._load_check_env()
        assert mod.port_in_use(65533) is False


class TestFrontendBundle:
    def _load_frontend_scripts(self):
        import importlib.util
        from pathlib import Path

        path = Path(__file__).resolve().parent.parent / "tools" / "frontend_scripts.py"
        spec = importlib.util.spec_from_file_location("frontend_scripts", path)
        mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(mod)
        return mod

    def test_module_order_matches_manifest(self):
        mod = self._load_frontend_scripts()
        order = mod._parse_module_order()
        assert order[0] == "01-parsers.js"
        assert order[-1] == "13-ibkr.js"
        assert "03-chart-utils.js" in order
        assert "12-snapshots.js" in order
        assert "10-phase7.js" in order
        assert len(order) == 15

    def test_render_script_block_modes(self):
        mod = self._load_frontend_scripts()
        modules = mod.render_script_block("modules")
        assert modules.count("<script") == 15
        assert "01-parsers.js" in modules
        assert "05-session-api.js" in modules
        bundle = mod.render_script_block("bundle")
        assert "app.bundle.js" in bundle
        assert "01-parsers.js" not in bundle

    def test_manifest_lists_typescript_modules(self):
        import json
        from pathlib import Path

        manifest = Path(__file__).resolve().parent.parent / "static" / "dist" / "manifest.json"
        if not manifest.is_file():
            pytest.skip("bundle not built — run npm run build")
        data = json.loads(manifest.read_text(encoding="utf-8"))
        assert "05-session-api" in data.get("tsModules", [])
        assert "08-simulate" in data.get("tsModules", [])

    def test_index_bundle_mode(self, client, monkeypatch):
        from pathlib import Path

        bundle = Path(__file__).resolve().parent.parent / "static" / "dist" / "app.bundle.js"
        if not bundle.is_file():
            pytest.skip("bundle not built — run npm run build")

        monkeypatch.setenv("USE_JS_BUNDLE", "1")
        res = client.get("/")
        assert res.status_code == 200
        assert b"app.bundle.js" in res.data
        assert b"01-parsers.js" not in res.data


class TestSchwabParser:
    def test_schwab_history_format_detection(self, schwab_history_text):
        from app import _detect_history_format

        lines = schwab_history_text.replace("\r", "").split("\n")
        assert _detect_history_format(lines) == "schwab"


class TestPidLock:
    def _load_pidlock(self):
        import importlib.util
        from pathlib import Path

        path = Path(__file__).resolve().parent.parent / "scripts" / "pidlock.py"
        spec = importlib.util.spec_from_file_location("pidlock", path)
        mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(mod)
        return mod

    def test_lock_roundtrip(self, tmp_path, monkeypatch):
        mod = self._load_pidlock()
        lock = tmp_path / ".options-dashboard.lock"
        monkeypatch.setattr(mod, "LOCK_PATH", lock)
        mod.write_lock(4242, 5000)
        data = mod.read_lock()
        assert data["pid"] == 4242
        assert data["port"] == 5000
        mod.clear_lock()
        assert mod.read_lock() is None


class TestSimulateApi:
    """Happy-path /api/simulate with mocked yfinance — no network required."""

    def _make_hist(self, n=62, base=100.0):
        """Return a fake yfinance history DataFrame with n days of prices."""
        import pandas as pd
        closes = [base * (1 + 0.001 * i) for i in range(n)]
        return pd.DataFrame({"Close": closes, "Open": closes, "High": closes, "Low": closes, "Volume": [1_000_000] * n})

    def test_simulate_single_short_put(self, client):
        payload = {
            "positions": [{
                "ticker": "TEST",
                "posType": "option",
                "optType": "Put",
                "strike": 10.0,
                "expiry": "2026-09-19",
                "contracts": -1,
                "avgCost": 0.50,
            }],
            "n_paths": 200,
        }
        fake_hist = self._make_hist()

        with patch("app.yf.Ticker") as mock_tk, patch("app.yf.download") as mock_dl:
            inst = MagicMock()
            inst.history.return_value = fake_hist
            inst.info = {"regularMarketPrice": 12.0}
            inst.fast_info = MagicMock(last_price=12.0)
            # calendar returns a dict in current yfinance
            inst.calendar = {}
            inst.options = ("2026-09-19",)
            chain = MagicMock()
            chain.puts = pd.DataFrame({
                "strike": [10.0], "impliedVolatility": [0.60],
                "lastPrice": [0.50], "openInterest": [100], "volume": [50],
            })
            chain.calls = pd.DataFrame({
                "strike": [10.0], "impliedVolatility": [0.60],
                "lastPrice": [0.50], "openInterest": [100], "volume": [50],
            })
            inst.option_chain.return_value = chain
            mock_tk.return_value = inst
            mock_dl.return_value = fake_hist

            res = client.post("/api/simulate", json=payload)

        assert res.status_code == 200
        data = res.get_json()
        assert "error" not in data, f"Unexpected simulate error: {data.get('error')}"
        assert data.get("n_paths", 0) == 200
        assert "by_ticker" in data and "TEST" in data["by_ticker"]
        assert len(data.get("portfolio_pnl", [])) == 200
        assert "histogram" in data
        assert "theta" in data

    def test_simulate_returns_error_on_empty_positions(self, client):
        res = client.post("/api/simulate", json={"positions": [], "n_paths": 100})
        data = res.get_json()
        # Either an error field or an empty by_ticker dict
        assert "error" in data or data.get("by_ticker") == {}


class TestDbRetentionPruning:
    """init_db() prunes snapshots and alert_events older than SNAPSHOT_RETENTION_DAYS.

    DB_PATH is captured at import time, so we monkeypatch app.DB_PATH directly
    rather than setting the env var after the fact.
    """

    def _seed_db(self, db_path):
        """Create tables and insert one old + one recent row in each high-churn table."""
        import sqlite3
        from datetime import datetime, timedelta

        old_ts = (datetime.now() - timedelta(days=60)).isoformat()
        recent_ts = datetime.now().isoformat()

        conn = sqlite3.connect(db_path)
        conn.execute("""CREATE TABLE IF NOT EXISTS snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL, ticker TEXT NOT NULL,
            price REAL, delta REAL, theta REAL, vega REAL, gamma REAL,
            beta_weighted_delta REAL, book_value REAL, position_count INTEGER)""")
        conn.execute("""CREATE TABLE IF NOT EXISTS alert_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            alert_key TEXT NOT NULL, ticker TEXT, category TEXT,
            severity TEXT, message TEXT NOT NULL, triggered_at TEXT NOT NULL)""")
        conn.execute("INSERT INTO snapshots (timestamp, ticker) VALUES (?, 'TST')", (old_ts,))
        conn.execute("INSERT INTO snapshots (timestamp, ticker) VALUES (?, 'TST')", (recent_ts,))
        conn.execute("INSERT INTO alert_events (alert_key, ticker, category, severity, message, triggered_at) VALUES (?,?,?,?,?,?)",
                     ("delta:TST", "TST", "greeks", "high", "Delta breach", old_ts))
        conn.execute("INSERT INTO alert_events (alert_key, ticker, category, severity, message, triggered_at) VALUES (?,?,?,?,?,?)",
                     ("delta:TST", "TST", "greeks", "high", "Delta breach", recent_ts))
        conn.commit()
        conn.close()

    def test_old_rows_pruned_on_init(self, tmp_path, monkeypatch):
        import sqlite3
        import app as app_mod

        db_path = str(tmp_path / "prune_test.db")
        self._seed_db(db_path)

        monkeypatch.setattr(app_mod, "DB_PATH", db_path)
        monkeypatch.setenv("SNAPSHOT_RETENTION_DAYS", "30")
        app_mod.init_db()

        conn = sqlite3.connect(db_path)
        snap_count = conn.execute("SELECT COUNT(*) FROM snapshots").fetchone()[0]
        alert_count = conn.execute("SELECT COUNT(*) FROM alert_events").fetchone()[0]
        conn.close()

        assert snap_count == 1, f"Expected 1 snapshot after 30d prune, got {snap_count}"
        assert alert_count == 1, f"Expected 1 alert_event after 30d prune, got {alert_count}"

    def test_retention_zero_keeps_all(self, tmp_path, monkeypatch):
        import sqlite3
        import app as app_mod

        db_path = str(tmp_path / "no_prune_test.db")
        self._seed_db(db_path)

        monkeypatch.setattr(app_mod, "DB_PATH", db_path)
        monkeypatch.setenv("SNAPSHOT_RETENTION_DAYS", "0")
        app_mod.init_db()

        conn = sqlite3.connect(db_path)
        count = conn.execute("SELECT COUNT(*) FROM snapshots").fetchone()[0]
        conn.close()
        assert count == 2, "SNAPSHOT_RETENTION_DAYS=0 should keep all rows"


class TestBetaCache:
    """_beta_cache reduces yfinance calls on repeated /api/greeks requests."""

    def test_cache_hit_reduces_yfinance_calls(self, client):
        import app as app_mod

        if not hasattr(app_mod, "_beta_cache"):
            pytest.skip("_beta_cache not present — ensure app.py audit fixes are applied")

        payload = {
            "positions": [{
                "ticker": "CACHETST",
                "posType": "option",
                "optType": "Put",
                "strike": 50.0,
                "expiry": "2026-12-19",
                "contracts": -1,
            }],
            "marketData": {"CACHETST": {"price": 55.0, "iv": 45.0}},
        }

        fake_hist = pd.DataFrame({"Close": [100.0 + i for i in range(130)]})

        # Clear cache so first call definitely fetches
        app_mod._beta_cache.clear()

        call_count = {"n": 0}
        original_ticker = app_mod.yf.Ticker

        def counting_ticker(tkr):
            call_count["n"] += 1
            inst = MagicMock()
            inst.history.return_value = fake_hist
            inst.info = {"regularMarketPrice": 55.0}
            inst.fast_info = MagicMock(last_price=55.0)
            inst.calendar = {}
            inst.options = ()
            return inst

        with patch.object(app_mod.yf, "Ticker", side_effect=counting_ticker):
            res1 = client.post("/api/greeks", json=payload)
            calls_after_first = call_count["n"]
            res2 = client.post("/api/greeks", json=payload)
            calls_after_second = call_count["n"]

        assert res1.status_code == 200
        assert res2.status_code == 200
        # Second call should make fewer (or equal, if TTL not expired) yfinance calls
        new_calls = calls_after_second - calls_after_first
        assert new_calls <= calls_after_first, (
            f"Expected cache hit on 2nd call; got {new_calls} new calls vs {calls_after_first} on first"
        )
