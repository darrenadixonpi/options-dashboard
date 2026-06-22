# Options Dashboard v1.7.0 — Sortable cohorts & corrected wash-sale estimate

Released 2026-06-22. Builds on v1.6.0 (Greeks Lab spread builder, deeper market-shock).

## Highlights

### Sortable Performance Cohorts
Click any column header in the Journal's Performance Cohorts table — group name, Trades, Win%, Total P&L, Avg, PF, or Avg Hold — to sort; click again to flip direction (▲ / ▼).

### Wash-sale estimate — corrected (Tax Lot Analysis)
The wash-sale figure was structurally stuck at $0: the replacement scan only counted positions that were *never closed*, but the tax-lot engine is fed your closed round-trips, so it matched nothing. It now:

- **fires** — every acquisition within ±30 days of a loss is a candidate replacement;
- **matches replacements 1:1 and consumes them** (oldest sale first), so one purchase can't wash more than one loss;
- **pro-rates** the disallowed amount to the replaced quantity;
- **rolls the disallowed loss into a still-open replacement lot's cost basis** and carries the washed holding period.

The stat and the per-row column are now labeled **"(est.)"**. "Substantially identical" is keyed on ticker | type | strike — your trade data carries no option expiry, so different-expiry contracts on the same strike can't be told apart. Treat the figure as a planning estimate, file from your broker's 1099-B, and consult a tax professional.

## Upgrade

Local desk app — no data migration. Rebuild the frontend bundle **and restart the server** (the wash-sale change is backend):

```
npm run build      # or just launch start.bat, which builds in its prep step
```

On Windows use **Command Prompt** for `npm` (PowerShell blocks `npm.ps1` by default).

## Verification

`tsc` and `esbuild` clean (17-module bundle); 14 tax-lot / wash-sale unit tests green. Cohorts sorting verified live (Win% sort flips with the ▲/▼ indicator). The corrected wash estimate moved from a structural $0 to a defensible figure, and dropped further once 1:1 consumption removed double-counted replacements (live book: $18,093 → $15,633).
