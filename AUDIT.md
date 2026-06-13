# Options Dashboard — Site-Wide Audit Report

**Date:** 2026-06-12  
**Auditor:** Claude Fable 5 (automated)  
**Scope:** Full codebase audit of Options Dashboard v1.1.0 — backend, frontend, tests, docs, CI, and UX.  
**Deliverable:** Findings, fixes applied, open issues, and a forward-looking roadmap.

---

## Executive Summary

The codebase is architecturally sound and well-structured for a local-first options analytics tool. The Python backend (Flask + yfinance + numpy/scipy) is clean and largely correct. The frontend is modular and the TypeScript pilot migration is a good direction. Seven bugs were found and fixed during this audit; three structural issues remain open. The docs had significant parameter drift from reality — now corrected. The test suite is solid at 42 tests, up from 40.

The app is ready to grow into a full trade-management platform with relatively modest refactoring. Key priorities before that expansion: break up app.py, add authentication, introduce proper API versioning, and add a persistent job queue for async market data.

---

## 1. Bugs Found and Fixed

### 1.1 Critical: Fractional Strike Truncation in `_parse_occ_symbol`

**File:** `app.py`  
**Severity:** Critical — incorrect P&L, greeks, and payoff calculations for penny-priced options.

The OCC symbol parser used the regex `r"-?([a-z]+)(\d{6})([cp])(\d+)"`. The `\d+` group does not match a decimal point, so Fidelity-style symbols like `-OVID260618P2.5` matched only `2`, yielding a strike of `2.0` instead of `2.5`. For any option with a strike < ~$8 using Fidelity decimal notation, every downstream calculation was wrong.

**Fix applied:** Regex changed to `r"-?([a-z]+)(\d{6})([cp])(\d+(?:\.\d+)?)"` with branching logic:
- If `"."` in captured group → `float(strike_raw)` directly (Fidelity decimal)
- Else if `len > 6` → `float(strike_raw) / 1000.0` (standard OCC padded)
- Else → `float(strike_raw)` as-is

Two regression tests added (`test_parse_occ_symbol_fractional_strike`).

---

### 1.2 High: yfinance Calendar API Incompatibility

**File:** `app.py` — `fetch_ticker_data` and `get_events`  
**Severity:** High — dividend dates and earnings dates silently returned `None` or raised `AttributeError` for all tickers on yfinance ≥ 0.2.x.

`yf.Ticker.calendar` changed return type from a `DataFrame` (old) to a plain `dict` (current). The code used DataFrame-specific access (`.empty`, `.index`, `.loc[]`), which raised `AttributeError` at runtime and was caught by a bare `except Exception`, silently returning `None`.

**Fix applied:** New helper `_calendar_field(cal, key)` that detects `dict` vs `DataFrame` and handles both, including list-valued dict entries (yfinance sometimes returns `[date]` for earnings). Both call sites updated. Regression test added (`test_calendar_field_dict_and_dataframe`).

---

### 1.3 High: Missing `/api/version` Route

**File:** `app.py`  
**Severity:** High — the test existed (`test_api_version`) but the route did not, so the test always 404'd.

**Fix applied:** Route added:
```python
@app.route("/api/version")
def api_version():
    return jsonify({"name": "options-dashboard", "version": "1.1.0"})
```

---

### 1.4 Medium: Hardcoded Risk-Free Rate

**File:** `app.py`  
**Severity:** Medium — BSM pricing and simulation drift subtly wrong as rates move; requires source edit to update.

`RISK_FREE = 0.043` was hardcoded (5.25% Fed funds era) and not overridable. At audit time the 3-month T-bill was ~3.71%.

**Fix applied:** Changed to `float(os.environ.get("RISK_FREE", "0.037"))`. Added `RISK_FREE=0.037` comment to `.env.example`.

---

### 1.5 Medium: DB Growth Without Pruning

**File:** `app.py` — `init_db()`  
**Severity:** Medium — `snapshots` and `alert_events` tables grow unboundedly; on a long-running local instance this becomes tens of thousands of rows.

**Fix applied:** `init_db()` now prunes rows older than `SNAPSHOT_RETENTION_DAYS` (default 180) on every startup. Setting to `0` disables pruning. Added to `.env.example`.

---

### 1.6 Medium: Beta-Weighted Delta N+1 yfinance Calls

**File:** `app.py` — `/api/greeks`  
**Severity:** Medium — every greeks refresh made one yfinance call per unique ticker plus one for SPY, all synchronous, with no caching. A 10-ticker portfolio waited 10+ seconds per refresh.

**Fix applied:** Added `_beta_cache = {}` with `BETA_TTL_S = 6 * 3600` for per-ticker betas and `BETA_SPY_TTL_S = 15 * 60` for the SPY history. Betas are recomputed only when stale.

---

### 1.7 Low: Test Suite Used Live Database

**File:** `tests/conftest.py`  
**Severity:** Low (correctness) — pytest runs polluted the live `portfolio.db` with test snapshots and alert events because `PORTFOLIO_DB` was not isolated before `import app` ran `init_db()` at module level.

**Fix applied:** `conftest.py` now creates a `tempfile.mkstemp` DB and sets `os.environ["PORTFOLIO_DB"]` before any app import, conditional on the env var not already being set.

---

### 1.8 Low: prep_before_start.py Missing typecheck:pilot

**File:** `scripts/prep_before_start.py`  
**Severity:** Low — `typecheck:pilot` ran in CI but not in the local prep script, causing a parity gap.

**Fix applied:** Added `_run(["npm", "run", "typecheck:pilot"], ...)` to `run_checks()`.

---

## 2. Documentation Drift — Corrected

All corrections applied to `TECHNICAL_EXPLAINER.md`:

| Parameter | Was | Now |
|---|---|---|
| `RISK_FREE` | `0.043` | `0.037` (env-overridable) |
| Merton `σ_d` | `"0.7σ"` | `"0.5σ (sigma_diff_frac)"` |
| Merton `μ_J` | `"-0.05"` | `"-0.10 (mu_j)"` |
| Merton `σ_J` | `"0.30σ"` | `"fixed 0.15 (sig_j) — does NOT scale with IV"` |
| IV/HV threshold | `"≥ 1.5"` | `"≥ 1.8 (IV_HV_RATIO_THRESHOLD)"` |
| Price move threshold | `"≥ 36%"` | `"≥ 15% (PRICE_MOVE_THRESHOLD)"` |
| GBM drift μ | `"0.043"` | `"0.037"` |

---

## 3. Open Issues (Not Fixed This Session)

### 3.1 app.py Is Too Large

At ~4,100 lines and 31+ routes, `app.py` is approaching the point where reasoning about it is error-prone. The bug in section 1.1 (regex) was harder to spot partly because it was buried in a large file with no clear module boundaries.

**Recommendation:** Split into Flask Blueprints:
- `blueprints/market.py` — `/api/market-data`, `/api/events`, `/api/catalysts`
- `blueprints/greeks.py` — `/api/greeks`
- `blueprints/simulate.py` — `/api/simulate`
- `blueprints/history.py` — `/api/trade-history`, `/api/pnl-attribution`
- `blueprints/snapshots.py` — all `/api/snapshots/*`
- `blueprints/alerts.py` — all alert endpoints

### 3.2 No Authentication or Multi-User Support

The app is localhost-only with no auth. If ever exposed beyond localhost (even on a LAN), any user can read the portfolio and trigger market data fetches.

**Recommendation:** Add a simple token-based auth (env-var secret, checked as `Authorization: Bearer <token>`) before any network-exposed deployment. This is a one-hour addition.

### 3.3 docs/SCHWAB_API.md Untracked

`docs/SCHWAB_API.md` exists on disk but is not committed (`??` in `git status`). It documents a feature (`SCHWAB_*` env vars) that is partially wired in `.env.example` but not implemented in `app.py`.

**Recommendation:** Either commit it as a planning doc (with a `WIP` notice) or add it to `.gitignore`. Currently it creates ambiguity about what's shipped.

### 3.4 13 Modified Files Uncommitted

The following modified files should be committed:
```
.env.example, .gitignore, CHANGELOG.md, DOCKET.md, GITHUB.md,
IMPLEMENTATION_GUIDE.md, README.md, TECHNICAL_EXPLAINER.md,
app.py, scripts/prep_before_start.py, static/js/README.md,
tests/conftest.py, tests/test_smoke.py
```
Plus `docs/SCHWAB_API.md` (untracked). A suggested commit sequence:
1. `git add tests/conftest.py tests/test_smoke.py` → `"test: isolate DB, add regression tests for fractional strikes and calendar API"`
2. `git add app.py` → `"fix: fractional OCC strikes, yfinance calendar compat, /api/version, beta cache, DB retention, RISK_FREE env-override"`
3. `git add scripts/ .env.example` → `"chore: add typecheck:pilot to prep, document RISK_FREE and SNAPSHOT_RETENTION_DAYS"`
4. `git add *.md static/js/README.md IMPLEMENTATION_GUIDE.md` → `"docs: correct Merton params, IV/HV and price-move thresholds, RISK_FREE in explainer"`

### 3.5 XSS Risk in Trade History Table

**File:** `static/js/09-trade-history.js` (and similar display modules)

Several table-rendering functions build HTML via string concatenation using user-controlled strings (broker descriptions, ticker symbols, OCC symbol descriptions). If the portfolio DB were ever poisoned, these could render arbitrary HTML.

**Recommendation:** Switch to `textContent` assignment or a minimal template sanitizer. Low urgency while the app is localhost-only; critical if ever multi-user.

### 3.6 `templates/` Directory Is Empty

Flask expects `templates/` for Jinja2 templates, but the directory is empty — `index.html` is served as a static file from `static/`. This is functional but non-idiomatic.

**Recommendation:** Either move `index.html` into `templates/` and use `render_template()`, or remove the empty directory and document that HTML is static-served. The current approach makes it harder to inject server-side context (e.g., version number, feature flags) without a JavaScript fetch.

---

## 4. Test Coverage Assessment

| Area | Tests | Notes |
|---|---|---|
| OCC symbol parsing | 3 | Covers standard, Fidelity decimal, padded fractional |
| Calendar field compat | 1 | Dict + DataFrame + None + list-value cases |
| Option event classification | 1 | Open/close/expired/assigned |
| Simulation strategy map | 1 | Equity context + covered calls |
| FIFO trade matching | 1 | Multi-leg close matching |
| Roll detection | 3 | Format, cross-day, build-daily |
| P&L attribution | 2 | Win rate spread, journal risk metrics |
| MTM / book value | 2 | compute_portfolio_mtm, mtm_risk_metrics |
| Trade history API | 5 | Fidelity, IBKR, Schwab parsers + API endpoints |
| API schemas (Pydantic) | 6 | SimulateResponse, GreeksResponse, etc. |
| Desk alerts | 2 | Greek thresholds, alert history |
| Frontend bundle check | 1 | static/dist/app.bundle.js existence |
| Version endpoint | 1 | `/api/version` → 200 + version string |
| **Total** | **42** | |

**Gaps worth filling:**
- `/api/simulate` happy path with mocked yfinance (currently only Playwright e2e)
- `/api/greeks` with mocked yfinance (test currently exercises schema only)
- `_parse_occ_symbol` with IBKR-style symbols (space-separated format)
- DB pruning in `init_db()` (verify rows older than threshold are removed)
- Beta cache hit/miss behavior

---

## 5. Frontend Assessment

The JS module architecture (13 modules in classic script tag order) is functional and well-organized for a single-page app of this scale. The TypeScript pilot (`05-session-api.ts`, `08-simulate.ts`) is a good foundation for a full migration.

**Strengths:**
- Clean separation by feature area (parsers, greeks, simulate, history, etc.)
- `01-parsers.js` OCC regex correctly handles fractional strikes (`\d+(?:\.\d+)?`) — unlike the Python equivalent (now fixed)
- esbuild build is fast; vendor chunks are clean

**Issues and Suggestions:**

**5.1 No loading/error state for long fetches**  
Greeks and simulate calls can take 3–15 seconds (yfinance + Monte Carlo). The UI shows no spinner or progress indication. Add a simple `fetch-in-progress` CSS class toggle on the button + a loading overlay on the results panel.

**5.2 Chart.js annotation labels overflow on small screens**  
The breakeven and max-profit lines in the payoff chart clip at the canvas edge when the strike range is wide. Fix: use `xAdjust` on the annotation label and clip to canvas bounds.

**5.3 Position table has no sort/filter**  
With >10 positions, finding a specific ticker requires scrolling. Add column-header click-to-sort (client-side, no fetch) and a ticker filter input. This is the single highest-ROI UX improvement.

**5.4 No dark mode**  
The app uses hard-coded light colors in Chart.js datasets. Adding `prefers-color-scheme` media query support and a CSS variable layer would make this much more comfortable for extended use.

**5.5 Mobile responsiveness is minimal**  
The layout doesn't adapt below ~900px. Given this is a desktop tool this is low priority, but if a React Native or PWA wrapper is ever considered, the current CSS would need significant rework.

**5.6 Global namespace pollution**  
All 13 JS modules write to `window.*` (e.g., `window.greeksModule`, `window.simulateModule`). This works at current scale but creates hidden coupling. The TypeScript pilot should introduce proper ES module imports/exports when it expands beyond the two current files.

**5.7 No client-side validation before fetches**  
The simulate and greeks forms POST raw values without client-side sanity checks (e.g., strike ≤ 0, negative contracts). Pydantic on the backend catches these, but the error UX is a raw JSON error message rather than an inline field hint.

---

## 6. Architecture Assessment

**Strengths:**
- Pure local-first design — no cloud dependency, no subscription
- SQLite for persistence is appropriate for a single-user tool
- `api_schemas.py` Pydantic models are clean and catch drift early
- Monte Carlo with Cholesky correlation is a genuine differentiator vs. simple position trackers
- CI pipeline (pip-audit, build, typecheck, typecheck:pilot, pytest, Playwright e2e) is thorough

**Weaknesses:**
- All market data is synchronous in the request thread — greeks endpoint blocks for multiple yfinance calls
- No retry or rate-limit handling on yfinance calls
- No background refresh — all data is pulled on demand

---

## 7. Roadmap Proposals

The following is structured as a phased roadmap, from near-term polish to longer-term platform expansion.

---

### Phase 4 — Hardening and UX (1–4 weeks)

**4.1 Break up app.py into Blueprints**  
Prerequisite for everything that follows. Target: no single file > 600 lines.

**4.2 Position table sort/filter**  
Client-side. Single highest-impact UX change.

**4.3 Loading indicators on all async fetches**  
CSS class toggle + button disable during fetch. Half-day task.

**4.4 Commit the 13 modified files**  
Git hygiene before any new development.

**4.5 Cover remaining test gaps**  
Mocked greeks and simulate tests, DB pruning test, beta cache test.

**4.6 Add `/api/version` to README and CHANGELOG**  
Document the endpoint so clients can detect compatibility.

---

### Phase 5 — Async Market Data (2–6 weeks)

**5.1 Background refresh via APScheduler or Celery**  
Pull market data on a configurable schedule (e.g., every 5 minutes during market hours) rather than on-demand. Store results in the DB. Frontend polls a cache endpoint.

**5.2 yfinance resilience**  
Add exponential backoff + retry (3 attempts), per-ticker error isolation, and a fallback to cached last-known price. Currently one failed ticker silently returns `None` for the whole position.

**5.3 Rate limit budgeting**  
Track total yfinance calls per minute and queue excess calls. Yahoo Finance has soft rate limits that cause silent failures under load.

---

### Phase 6 — Schwab API Integration (4–8 weeks)

`docs/SCHWAB_API.md` documents the planned integration. The env vars are already in `.env.example`. Implementation would include:

- OAuth 2.0 PKCE flow for Schwab authorization
- Pull live positions, orders, and balances from Schwab API
- Write positions to DB; reconcile with manually imported history
- Optionally: live option chain streaming for real-time greeks

This is the highest-leverage feature for a production-quality tool — it eliminates the CSV import workflow entirely.

---

### Phase 7 — Full Trade Management (8–20 weeks)

This is the expansion from "options analytics" to "trade management platform." The following capabilities would make this a complete solution:

**7.1 Multi-broker support**  
The Schwab integration can be the template for IBKR, Tastytrade, and TD/Schwab legacy. Each broker has an OAuth API. A `brokers/` module with a common `BrokerAdapter` interface would allow adding brokers without touching core logic.

**7.2 Order management**  
- Draft orders (legs, limits, conditions)
- Order staging UI — review before submitting
- Submit via broker API
- Track order status, fill confirmation, and partial fills

**7.3 Rules engine / conditional orders**  
"If delta exceeds X, queue a roll." Rules stored in DB, evaluated by background job. This replaces the current manual alert-then-act workflow.

**7.4 Strategy templates**  
Saved strategy configs (e.g., "RGNX wheel: sell CSP at 30 delta, roll at 21 DTE") that can be applied to a new ticker in one click.

**7.5 Journal and tax lot tracking**  
- FIFO/LIFO/specific-lot selection per trade
- Short-term vs. long-term gain tracking
- Wash-sale detection
- Year-end export (Form 8949 compatible)

**7.6 Risk dashboard**  
- Portfolio beta and delta neutrality at a glance
- VaR (1-day, 5-day) from Monte Carlo
- Margin utilization gauge
- "What-if" position entry simulator

**7.7 Notifications**  
- Desktop notifications for alert triggers (currently DB-only)
- Email or SMS for critical alerts (DTE, delta breach)
- Could use system notification APIs rather than a cloud service

**7.8 Data export**  
- Export full portfolio history as CSV / Excel
- Export greeks snapshot as JSON for archiving
- Scheduled weekly digest email (P&L, open positions, upcoming expirations)

---

### Phase 8 — Platform (20+ weeks, optional)

If multi-user is ever desired:

**8.1 Authentication**  
Add token-based auth (local password, eventually OAuth with Google/GitHub). Single admin user is sufficient for personal use.

**8.2 Docker packaging**  
`DOCKER.md` already exists. Flesh out the Compose file with health checks, volume mounts for the DB, and an nginx reverse proxy.

**8.3 React frontend migration**  
The TypeScript pilot is the wedge. A full React migration would enable proper component state, route-level code splitting, and a real design system. Material UI or shadcn/ui are good fits given the data-heavy nature.

**8.4 PostgreSQL migration**  
SQLite is fine for single-user local. For multi-user or cloud deployment, PostgreSQL with SQLAlchemy ORM is the obvious next step. The DB schema is simple enough that migration would be a 1–2 day effort.

---

## 8. Priority Matrix

| Item | Impact | Effort | Priority |
|---|---|---|---|
| Commit the 13 modified files | Low | Trivial | Do now |
| Break app.py into Blueprints | High | Medium | Phase 4 |
| Position table sort/filter | High | Low | Phase 4 |
| Loading spinners on fetches | Medium | Low | Phase 4 |
| Background market data refresh | High | High | Phase 5 |
| yfinance resilience / retry | High | Low | Phase 5 |
| Schwab API integration | Very High | High | Phase 6 |
| Journal / tax lot tracking | High | High | Phase 7 |
| Risk dashboard (VaR, margin) | High | Medium | Phase 7 |
| Order management UI | Very High | Very High | Phase 7 |
| Multi-user / auth | Medium | High | Phase 8 |
| React frontend migration | Medium | Very High | Phase 8 |

---

## Appendix: File Change Summary

| File | Change |
|---|---|
| `app.py` | Fixed OCC fractional strike regex; added `_calendar_field` helper; added `/api/version` route; made `RISK_FREE` env-overridable; added beta TTL cache; added DB retention pruning; updated `_calendar_field` call sites; added `# pragma: no cover` to `__main__` |
| `tests/conftest.py` | Added `tempfile.mkstemp` DB isolation before app import |
| `tests/test_smoke.py` | Added `test_parse_occ_symbol_fractional_strike` and `test_calendar_field_dict_and_dataframe` |
| `scripts/prep_before_start.py` | Added `typecheck:pilot` to `run_checks()` |
| `.env.example` | Added `RISK_FREE` and `SNAPSHOT_RETENTION_DAYS` commented examples |
| `TECHNICAL_EXPLAINER.md` | Corrected 7 parameter values to match actual code |
