# brokers/ — multi-broker adapter layer (Phase 7.1)

One uniform interface over every supported broker. Core code (`app.py`,
simulation, greeks, journal) never special-cases a broker — it asks the registry
for an adapter and works against the `BrokerAdapter` contract. Whether positions
come from an OAuth API (Schwab) or an exported CSV (Fidelity, IBKR), every
adapter emits the **same canonical leg**.

## Canonical leg

```python
{
    "ticker":    "AAPL",          # uppercased
    "posType":   "option" | "equity",
    "optType":   "Put" | "Call" | None,
    "strike":    150.0 | None,
    "expiry":    "2026-06-20" | None,   # ISO date string
    "contracts": -1,              # signed; negative = short. 0 for equity.
    "shares":     0,              # signed; negative = short. 0 for options.
    "avgCost":    2.50,           # broker-native per-share/contract avg cost
    "source":    "schwab_api",    # provenance tag
}
```

Always build legs through `normalize_leg(raw, source=...)` (in `base.py`). It
coerces types, formats the expiry, enforces signed quantities, and returns
`None` for flat / incomplete rows so callers can just filter `None`.

## Files

| File | Role |
|------|------|
| `base.py` | `BrokerAdapter` ABC, `normalize_leg()`, `coerce_expiry()`, errors |
| `csvutil.py` | Stdlib-only ports of `static/js/01-parsers.js` (OCC + Schwab/IBKR symbol parsing, CSV helpers) |
| `schwab.py` | `SchwabAdapter` — source `api`; delegates to `schwab_client.py`; also parses Schwab CSV |
| `fidelity.py` | `FidelityAdapter` — source `csv`; positions + opening-fill history |
| `ibkr.py` | `IBKRAdapter` — source `csv`; IBKR Flex / Activity Statement |
| `__init__.py` | Registry: `get_adapter(key)`, `list_adapters()` |

## Usage

```python
from brokers import get_adapter, list_adapters

list_adapters()                                   # [{key,label,source,positions,history,oauth}, ...]
get_adapter("fidelity").get_positions(csv_text)   # parse CSV  -> canonical legs
get_adapter("ibkr").get_positions(csv_text)       # parse CSV  -> canonical legs
get_adapter("schwab").get_positions()             # live OAuth -> canonical legs
```

HTTP surface (in `app.py`):

| Route | Purpose |
|-------|---------|
| `GET /api/brokers` | List brokers + capabilities |
| `GET /api/brokers/<key>/status` | Connection status (CSV = ready; Schwab = OAuth state) |
| `POST /api/brokers/<key>/positions` | Body `{ "csv": "..." }` for CSV brokers, or empty for a Schwab live pull → `{ positions, position_count, ... }` |

The legacy `/api/schwab/*` routes are unchanged; `SchwabAdapter` wraps the same
`schwab_client` singleton, so there is one source of truth for tokens.

## Adding a broker

1. Create `brokers/<name>.py` with a `BrokerAdapter` subclass.
2. Set `key`, `label`, `source` (`"csv"` or `"api"`), and the `supports_*` flags.
3. Implement the methods for your source:
   - **CSV** → `parse_positions(text)` (and optionally `parse_history(text)`).
   - **API** → `sync_positions()` plus the OAuth methods (`status`, `get_auth_url`, `handle_callback`, `disconnect`).
   Build every leg with `normalize_leg(...)`.
4. Register it in `__init__.py` (`_ADAPTER_CLASSES`).
5. Add a fixture under `tests/fixtures/` and a case to `tests/test_brokers.py`.

No changes to `app.py` routes are required — `GET /api/brokers` and
`POST /api/brokers/<key>/positions` pick the new adapter up automatically.

## Scope

This layer unifies **position ingestion** (the Phase 7.1 goal) and adds
best-effort opening-fill history for the CSV brokers. Round-trip trade
analytics remain on the existing `POST /api/trade-history` endpoint.
