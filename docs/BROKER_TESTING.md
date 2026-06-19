# Broker Sync — Testing & Verification Guide

How to verify the Schwab (OAuth API) and IBKR (Flex Web Service) live-sync paths end to end. Both also have a CSV fallback that works today with no setup.

See also: [SCHWAB_API.md](SCHWAB_API.md) · [IBKR_API.md](IBKR_API.md) · [../brokers/README.md](../brokers/README.md)

---

## 0. Pre-flight (no broker account needed)

The code paths are covered by mocked tests, so you can confirm everything *works* before any live credentials:

```powershell
python -m pytest tests\ -q          # incl. test_schwab_api.py + test_ibkr_flex.py (mocked)
npm run build                       # bundles the Schwab + IBKR panels
start.bat                           # launches http://localhost:5000
```

Green pytest + a successful build = the sync logic, normalization, and routes are correct. The live steps below only add real credentials on top.

Quick endpoint smoke-check (server running, no creds needed):

```
GET  http://localhost:5000/api/brokers              → lists fidelity, schwab, ibkr (+ capabilities)
GET  http://localhost:5000/api/schwab/status        → {"configured": false, ...} until .env is set
GET  http://localhost:5000/api/ibkr/status          → {"configured": false, ...} until you Save in the UI
```

---

## 1. Schwab (OAuth API)

**Secrets live in `.env`** — the Schwab panel only appears once `SCHWAB_CLIENT_ID` is set; otherwise you'll see CSV instructions.

### Prerequisites
- Active Schwab brokerage account with **thinkorswim** enabled.
- Developer account at [developer.schwab.com](https://developer.schwab.com).

### Step 1 — Register the developer app
At [developer.schwab.com/dashboard/apps](https://developer.schwab.com/dashboard/apps):
- **Callback URL:** `https://127.0.0.1:8182` (exact — `https`, host `127.0.0.1`, port `8182`, no trailing slash).
- **OAuth scope:** `api`
- **API product:** Accounts and Trading Production
- Wait until status is **Ready for Use** (not "Approved – Pending"). Re-approval after changes takes ~1–3 business days.
- Copy the **App Key** and **App Secret**.

### Step 2 — Add your App Key + Secret
**Easiest (in-app, no `.env`):** open the import drawer → **Schwab** tab → paste the **App Key** + **App Secret** into the setup form → **Save**. Stored locally in `schwab_config.json` (gitignored); picked up immediately, no restart.

**Or via `.env`** (then restart the server):
```env
SCHWAB_CLIENT_ID=your_app_key
SCHWAB_CLIENT_SECRET=your_app_secret
SCHWAB_CALLBACK_URL=https://127.0.0.1:8182
```

### Step 3 — Connect in the UI
1. With credentials saved, the **Schwab API** panel shows a "Not connected" badge and a **Connect Schwab Account** button.
2. Click **Connect Schwab Account** → a Schwab login link appears and opens in a new tab.
3. Log in and approve. Schwab redirects to `https://127.0.0.1:8182?code=…` — **the page may show a browser error; that's normal.**
4. Copy the **full URL** from the address bar, paste it into the panel, click **Submit**.
5. Badge flips to **Connected**.

### Step 4 — Sync & verify
- Click **↻ Sync positions from Schwab** → status shows `✓ N positions synced…` and the Positions drop-zone shows "N positions from Schwab API".
- Click **Fetch** → live marks, greeks, and simulation run on the synced book.

### Token lifetimes
- Access token ~30 min (auto-refreshed). **Refresh token hard-expires after 7 days** — you'll re-run Step 3 weekly (Schwab policy). The badge will say "reconnect" when it lapses.

### Troubleshooting
| Symptom | Fix |
|--------|-----|
| Panel shows the setup form, not Connect | Credentials not saved yet — paste App Key + Secret and click Save (or set them in `.env`) |
| "security error" at login | Callback URL mismatch — must be exactly `https://127.0.0.1:8182` |
| Sync returns 401 / "needs reauth" | Refresh token expired (7-day limit) — reconnect |
| Connect button error about auth URL | `SCHWAB_CLIENT_ID`/`SCHWAB_CLIENT_SECRET` missing or wrong |

---

## 2. IBKR (Flex Web Service)

**No `.env` editing needed** — you paste the token + query id into the panel and it's saved locally to `ibkr_flex.json` (gitignored). The IBKR panel always shows.

### Prerequisites
- Active IBKR account with Client Portal access.

### Step 1 — Create an Activity Flex Query
Client Portal → **Performance & Reports → Flex Queries** → new **Activity** query:
- Include the **Open Positions** section (add the fields: symbol, underlyingSymbol, assetCategory, putCall, strike, expiry, position, costBasisPrice). Optionally add **Trades** for history.
- **Format: XML.** Period: e.g. "Last Business Day".
- Save and note the **Query ID** (a number).

### Step 2 — Create a Flex Web Service token
Client Portal → **Settings → Account Settings → Flex Web Service** → enable, then **generate a token** (pick a long validity, 6 months–1 year). Copy it — shown once.

### Step 3 — Configure in the UI
1. Import drawer → **IBKR** broker tab → the **IBKR Flex Web Service** panel.
2. Paste the **token** and **query ID** into the form, click **Save**.
3. Badge flips to **Connected** (shows "Query <id>").

### Step 4 — Sync & verify
- Click **↻ Sync positions from IBKR** → `✓ N positions synced…`, drop-zone shows "N positions from IBKR".
- Click **Fetch** for live marks/greeks/sim.

### Notes
- Flex data is **end-of-day / delayed** (that's fine — live pricing comes from Yahoo). Positions are what you held as of the statement.
- Rate-limited to ~1 request/sec — don't spam Sync.
- The first Sync after Save can take a few seconds (two-step generate-then-fetch with polling).

### Troubleshooting
| Symptom | Fix |
|--------|-----|
| Save says "both required" | Token and query id must both be filled |
| Sync error mentioning a code (e.g. 1020) | Token wrong/expired, or query id doesn't match an Activity query |
| Sync error "in progress" then fails | Statement still generating — wait a few seconds and Sync again |
| No positions returned | The Flex Query has no Open Positions section, or the account is flat |
| Want to reset | **Disconnect** deletes the saved token (`ibkr_flex.json`) |

---

## 3. After a sync (both brokers)

1. **Positions tab** — confirm the synced legs (tickers, strikes, expiries, signed quantity) look right vs. your broker.
2. **Fetch** — pulls marks, IV, greeks; Risk/Simulation/Journal then work exactly as with a CSV import (the synced book is identical in shape).
3. **CSV fallback** — both panels keep a "Use CSV export instead" path, so nothing is lost if the API is down or unconfigured.

If the synced positions match your broker and Fetch produces greeks/sim, the integration is verified end to end.
