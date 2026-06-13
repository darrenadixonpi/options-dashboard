# Schwab API — Registration & integration plan

Plan for connecting Options Dashboard to Charles Schwab via OAuth. **Not implemented in v1.1.0** — CSV import remains the current Schwab path.

**Decision (2026-05):** Wait for API approval rather than prioritizing live CSV validation. User has an active Schwab brokerage account; developer app registration is in progress.

For roadmap status, see [DOCKET.md](../DOCKET.md).

---

## Current state (v1.1.0)

| Capability | Schwab today | After API (v1.2 target) |
|------------|--------------|-------------------------|
| Positions import | CSV export → `01-parsers.js` | OAuth sync → same portfolio pipeline |
| Transaction history | CSV export → journal | Optional API fetch for history |
| Live marks / greeks / sim | Yahoo Finance (all brokers) | Unchanged unless we add Market Data product |
| Auth | None | OAuth 2.0, local token file |

Existing parsers and fixture tests: `tests/fixtures/schwab_*.csv`, `tests/test_smoke.py` (`TestSchwabParser`).

---

## Part 1 — Register the developer app

### Prerequisites

1. Active **Schwab brokerage account**
2. **thinkorswim** enabled on that account (schwab.com → account features)
3. Developer account at [developer.schwab.com](https://developer.schwab.com)

### Registration checklist

- [ ] Create developer account at [developer.schwab.com/register](https://developer.schwab.com/register)
- [ ] Create app at [developer.schwab.com/dashboard/apps](https://developer.schwab.com/dashboard/apps)
- [ ] Set **Callback URL** exactly to: `https://127.0.0.1:8182`
- [ ] Set OAuth scope to **`api`**
- [ ] Enable **Accounts and Trading Production** (required for positions/history)
- [ ] Skip **Market Data Production** for v1.2 (Yahoo covers quotes/IV/greeks)
- [ ] Wait until app status = **Ready for Use** (not “Approved — Pending”)
- [ ] Copy **App Key** and **App Secret** into local `.env` only — never commit

### App form reference

| Portal field | Recommended value |
|--------------|-------------------|
| App name | `Options Dashboard` |
| Description | Local portfolio analytics — personal use only |
| Callback URL | `https://127.0.0.1:8182` |
| OAuth scope | `api` |
| API product | Accounts and Trading Production |

**Callback URL rules:** Must use `https://`, host `127.0.0.1`, explicit port `8182`, no trailing slash. Mismatch causes login “security error” failures. Changing callback URL or products triggers re-approval (~1–3 business days).

### Local credentials (after Ready for Use)

Copy `.env.example` to `.env` and set:

```env
SCHWAB_CLIENT_ID=your_app_key_here
SCHWAB_CLIENT_SECRET=your_app_secret_here
SCHWAB_CALLBACK_URL=https://127.0.0.1:8182
SCHWAB_TOKEN_PATH=./schwab_token.json
```

Do **not** paste secrets in chat, issues, or git.

---

## Part 2 — OAuth behavior (what to expect)

| Topic | Detail |
|-------|--------|
| Flow | Browser login → Schwab redirects to localhost with `code` → app exchanges for tokens |
| Library candidate | [`schwab-py`](https://schwab-py.readthedocs.io/en/latest/auth.html) (Python, fits Flask stack) |
| Access token | ~30 minutes; auto-refreshed while refresh token valid |
| Refresh token | **Hard 7-day expiry** — user must re-authenticate weekly (Schwab policy) |
| Browser warning | Self-signed cert on localhost during OAuth is normal |
| Security | Token file grants account access — keep in `.gitignore`, local disk only |

First login (once we build integration):

1. User clicks **Connect Schwab** (or runs one-time auth script)
2. Browser opens Schwab login → approve access
3. Local listener on `:8182` captures redirect
4. Token written to `SCHWAB_TOKEN_PATH`
5. Positions fetched and mapped into existing import/build pipeline

---

## Part 3 — Implementation plan (v1.2)

### Scope

**In scope**

- OAuth connect / disconnect / reconnect UX
- Fetch positions via Accounts API → normalize to current portfolio shape
- Token persistence (SQLite or JSON file under project root)
- Feature flag or broker tab: “Sync from Schwab” vs CSV
- Tests with mocked API responses (no live keys in CI)

**Out of scope (v1.2)**

- Schwab Market Data for quotes (keep Yahoo)
- Trading / order placement
- Multi-user or hosted deployment
- IBKR API (separate epic)

### Proposed backend surface

| Endpoint | Purpose |
|----------|---------|
| `GET /api/schwab/status` | Connected? token age? needs re-auth? |
| `GET /api/schwab/auth/start` | Redirect URL or start local OAuth flow |
| `GET /api/schwab/auth/callback` | OAuth callback (or dedicated local port via schwab-py) |
| `POST /api/schwab/sync` | Pull positions → return same shape as CSV import |
| `POST /api/schwab/disconnect` | Delete token file |

### Proposed file changes

```
app.py                    # routes + Schwab client wrapper
schwab_client.py          # new: OAuth + position fetch (schwab-py)
api_schemas.py            # optional: SchwabSyncResponse schema
static/js/05-session-api.ts  # Connect / Sync / Reconnect UI
.env.example              # SCHWAB_* placeholders (done)
.gitignore                # schwab_token.json (done)
tests/test_schwab_api.py  # mocked integration tests
```

### Mapping strategy

Schwab position payloads → same internal leg dicts that `buildPortfolio` expects after CSV parse. Reuse strategy detection in `02-portfolio.js` where possible; add server-side normalizer if API field names differ from CSV columns.

### Dependencies

Add to `requirements.txt` when implementing:

```
schwab-py>=1.0.0,<2
```

Pin upper bound; run `pip-audit` in CI as today.

---

## Part 4 — Fallback: live CSV validation

If API approval is slow or blocked, validate Schwab without API:

1. Export **Positions** and **Transaction history** from schwab.com
2. Import via existing Schwab broker button in UI
3. Fix parser gaps from real exports; add fixtures to `tests/fixtures/`

Lower effort than OAuth; good parallel path while waiting for **Ready for Use**.

---

## Status log

| Date | Event |
|------|-------|
| 2026-05-22 | v1.1.0 shipped; Schwab CSV parsers + fixtures only |
| 2026-05-22 | Decision: prioritize Schwab API over live CSV smoke |
| 2026-05-22 | Developer app registration walkthrough documented (this file) |
| 2026-06-13 | Phase 6 implemented: `schwab_client.py`, `/api/schwab/*` routes, frontend panel, 16 mocked tests |
| _TBD_ | App status → Ready for Use (activate with SCHWAB_CLIENT_ID + SCHWAB_CLIENT_SECRET in .env) |

Update this table when registration completes or live credentials are tested.
