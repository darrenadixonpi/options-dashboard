# IBKR API — Flex Web Service integration plan

Plan for syncing Interactive Brokers positions and transactions into Options Dashboard **without** a manual CSV export, by fetching the same data over IBKR's **Flex Web Service**. Companion to [SCHWAB_API.md](SCHWAB_API.md); both plug into the unified `brokers/` adapter layer (see [../brokers/README.md](../brokers/README.md)).

**Status:** Implemented — `ibkr_flex_client.py` + `IBKRAdapter.sync_positions` + an in-app panel (`static/js/13-ibkr.js`). Activate by saving a Flex token + Activity query id in the IBKR import panel (or via `.env`).

For roadmap status, see [../DOCKET.md](../DOCKET.md).

---

## Why Flex Web Service (and not the other IBKR APIs)

IBKR exposes three integration paths. For a **local, single-user position tracker that already pulls live marks from Yahoo**, the Flex Web Service is the clear fit.

| Path | How it works | Fit for this app |
|------|--------------|------------------|
| **Flex Web Service** ✅ | Token + Query-ID REST fetch of a saved Flex statement (positions + trades). Two HTTP calls, no local gateway. | **Recommended.** No extra process to run; token lasts up to a year; returns exactly the data `IBKRAdapter` already understands. |
| Client Portal Web API | REST, but requires the **Client Portal Gateway** (Java) running locally + browser SSO that expires every few hours + a keepalive "tickle". Default gateway port is **5000 — collides with the dashboard**. | Real-time, but fragile and high-maintenance for a desk tool. |
| TWS API (`ib_async`/`ibapi`) | Socket API to a running **TWS or IB Gateway** session. | Most powerful (live quotes, order placement) but needs the desktop app logged in at all times. Overkill for tracking. |

The Flex data is **end-of-day / delayed** (15–30 min for trade confirmations, EOD for full activity). That's fine here: positions don't change intraday for a tracker, and all live pricing/IV/greeks already come from Yahoo. If real-time positions or order placement ever become requirements, revisit the Client Portal or TWS API as a separate epic.

---

## Current state (v1.2.0)

| Capability | IBKR today | After Flex Web Service (v1.3 target) |
|------------|-----------|--------------------------------------|
| Positions import | Manual Flex/Activity CSV → `IBKRAdapter.parse_positions` | Token fetch → same canonical legs, no manual export |
| Transaction history | Manual CSV → `parse_history` | Optional fetch from the same statement |
| Live marks / greeks / sim | Yahoo Finance | Unchanged |
| Auth | None | Flex token (no OAuth, no gateway) |

Existing code: `brokers/ibkr.py` (`IBKRAdapter`), `brokers/csvutil.py` (`parse_option_from_ibkr`), fixtures `tests/fixtures/ibkr_*.csv`, tests in `tests/test_brokers.py`.

---

## Part 1 — User setup (one-time, in Client Portal)

### A. Create an Activity Flex Query

1. Client Portal → **Performance & Reports → Flex Queries**.
2. Create a new **Activity Flex Query**.
3. Include at least these sections (the normalizer reads them):
   - **Open Positions** — fields: `symbol`, `assetCategory`, `putCall`, `strike`, `expiry`, `position`, `costBasisPrice`, `multiplier`, `conid`, `underlyingSymbol`.
   - **Trades** (optional, for history) — fields: `symbol`, `assetCategory`, `putCall`, `strike`, `expiry`, `tradeDate`, `quantity`, `tradePrice`, `buySell`, `openCloseIndicator`.
4. Set **Format = XML**, period = e.g. "Last Business Day" or "Year to Date".
5. Save and note the **Query ID** (a number).

### B. Create a Flex Web Service token

1. Client Portal → **Settings → Account Settings → Flex Web Service** (or **Reporting → Flex Web Service**).
2. Enable it and generate a **Current Token**. Choose a validity window (6 hours – 1 year; pick something long for a personal tool and rotate it).
3. Copy the token — it is shown once.

### C. Local credentials

Copy `.env.example` → `.env` and set:

```env
IBKR_FLEX_TOKEN=your_flex_token_here
IBKR_FLEX_QUERY_ID=your_activity_query_id
# optional overrides:
# IBKR_FLEX_VERSION=3
# IBKR_FLEX_BASE_URL=https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService
```

Do **not** paste the token in chat, issues, or git (add nothing new — `.env` is already gitignored).

---

## Part 2 — API behavior (the two-step flow)

The Flex Web Service is asynchronous: you request a statement, then poll for it.

```
Step 1  GET  {base}/SendRequest?t={TOKEN}&q={QUERY_ID}&v=3
        → XML: <FlexStatementResponse><Status>Success</Status>
                 <ReferenceCode>1234567890</ReferenceCode>
                 <Url>https://.../FlexStatementService.GetStatement</Url>

Step 2  GET  {Url}?t={TOKEN}&q={REFERENCE_CODE}&v=3
        → if still generating: <Status>Warn</Status> + "Statement generation in progress" → wait & retry
        → when ready: the full <FlexQueryResponse> ... </FlexQueryResponse> XML
```

| Topic | Detail |
|-------|--------|
| Endpoints | `SendRequest` then `GetStatement` (URL returned in step 1). Newer host `ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService`; legacy `gdcdyn…/Universal/servlet/FlexStatementService` also works |
| Auth | The token is the credential (query param `t`). No OAuth, no session |
| Rate limit | ~**1 request/second**, **10/minute** per token — fetch on demand, not on every render |
| Latency | Statement generation takes a few seconds; poll `GetStatement` 2–5× with a short backoff |
| Data freshness | EOD / delayed (15–30 min for trade confirms). Acceptable — marks come from Yahoo |
| Token expiry | 6 h to 1 yr; on `Status=Fail` with an auth message, surface "regenerate token" to the user |
| Security | Token grants read access to statements — keep in `.env`, local disk only |

Error handling: parse `<Status>`; `Fail` → raise with the `<ErrorCode>`/`<ErrorMessage>`; `Warn` (in progress) → retry up to N times; network error → fall back to the most recent cached/imported positions.

---

## Part 3 — Implementation plan (v1.3)

### Scope

**In scope**
- Fetch the Activity statement via token → normalize Open Positions to canonical legs
- Optional: normalize Trades to opening fills (parity with `parse_history`)
- Wire into the existing `brokers/` layer and `/api/brokers/<key>/positions`
- Mocked tests (no live token in CI)

**Out of scope (v1.3)**
- Real-time positions / streaming (would need Client Portal or TWS API)
- Order placement
- Multi-account selection UI (normalize all accounts in the statement, like Schwab)

### Proposed files

```
ibkr_flex_client.py        # new: IBKRFlexClient — token fetch + two-step poll + XML→leg normalize
brokers/ibkr.py            # add sync_positions() (source becomes csv+api capable); advertise api in capabilities()
brokers/__init__.py        # unchanged (IBKRAdapter already registered)
api_schemas.py             # optional: IBKRSyncResponse
.env.example               # IBKR_FLEX_* placeholders
tests/test_ibkr_flex.py    # mocked SendRequest/GetStatement + XML fixture → legs
tests/fixtures/ibkr_flex_statement.xml   # sample Open Positions + Trades
```

### Adapter shape (mirrors Schwab)

`ibkr_flex_client.py` parallels `schwab_client.py`:

```python
class IBKRFlexClient:
    @classmethod
    def from_env(cls) -> "IBKRFlexClient": ...
    def is_configured(self) -> bool: ...          # token + query id set
    def status(self) -> dict: ...                 # {configured, query_id, ...}
    def fetch_statement(self) -> str: ...         # two-step + poll → XML string
    def get_positions(self) -> list[dict]: ...    # XML → canonical legs (via normalize_leg)
```

Then `IBKRAdapter` gains:

```python
supports_api_sync = True   # advertised in capabilities() when IBKR_FLEX_TOKEN is configured

def sync_positions(self) -> list[dict]:
    from ibkr_flex_client import get_ibkr_flex_client
    return get_ibkr_flex_client().get_positions()
```

`BrokerAdapter.get_positions(csv_text=None)` already dispatches: CSV text → `parse_positions`; no text → `sync_positions`. So `POST /api/brokers/ibkr/positions` with an empty body triggers a live Flex pull once the token is configured — **no new routes needed**. `GET /api/brokers/ibkr/status` returns the Flex config/connection state. (Optionally add thin `/api/ibkr/*` aliases to mirror `/api/schwab/*`.)

### Normalizer — Flex XML → canonical leg

Parse with stdlib `xml.etree.ElementTree` (keeps `brokers/` dependency-free; the `ibflex` PyPI library is a heavier alternative if full schema typing is wanted). Map each `<OpenPosition>`:

| Flex XML attribute | Canonical leg field | Notes |
|--------------------|--------------------|-------|
| `assetCategory` | `posType` | `OPT`→`option`, `STK`→`equity` |
| `underlyingSymbol` / `symbol` | `ticker` | underlying for options; symbol for equity |
| `putCall` | `optType` | `P`→`Put`, `C`→`Call` |
| `strike` | `strike` | float |
| `expiry` | `expiry` | `YYYYMMDD` → `YYYY-MM-DD` (reuse `coerce_expiry`) |
| `position` | `contracts` / `shares` | signed; option→`contracts`, equity→`shares` |
| `costBasisPrice` | `avgCost` | per share/contract |
| — | `source` | `"ibkr_flex"` |

Every leg goes through `brokers.base.normalize_leg(...)` so the output is identical to CSV and Schwab. Exact attribute names depend on the fields selected in the Flex Query — **validate against one real export** before locking the parser (capture it as `tests/fixtures/ibkr_flex_statement.xml`).

### Tests (mocked)

- `SendRequest` mock → `<ReferenceCode>`; `GetStatement` mock → fixture XML; assert normalized legs (short option + equity + signed quantities).
- `Status=Warn` (in progress) then `Success` → poll loop works.
- `Status=Fail` / bad token → raises with the error message.
- `is_configured()` false when token/query missing → adapter reports api unavailable.

### Dependencies

None new — `requests` and `xml.etree` are already available. (`pip-audit` stays green.)

---

## Part 4 — Fallback

The manual CSV path (`IBKRAdapter.parse_positions`) remains the default and the fallback if the token is unset, expired, or the service is unreachable. The API is strictly additive.

---

## Status log

| Date | Event |
|------|-------|
| 2026-06-13 | IBKR CSV adapter shipped in v1.2.0 (`brokers/ibkr.py`) |
| 2026-06-13 | Flex Web Service integration plan documented (this file) |
| 2026-06-13 | Implemented: `ibkr_flex_client.py`, `IBKRAdapter.sync_positions`, `/api/ibkr/*` routes, in-app panel, mocked tests |
| _TBD_ | Validate the normalizer against a real Flex XML export; activate with a live token + query id |

Update this table as implementation lands or the token is tested.
