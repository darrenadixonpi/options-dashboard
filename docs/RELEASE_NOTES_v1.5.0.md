# Options Dashboard v1.5.0 — Whole-book Greeks & portfolio shock

Released 2026-06-21. Builds on v1.4.0 (Greeks Lab surfaces & relationships).

## Highlights

### Greeks Lab — whole-underlying aggregate
The Scope dropdown now offers, for any ticker with ≥2 option legs, an "▣ TICKER — all N legs (net)" view that sums Δ/Γ/Θ/vega — and value, Taylor, surface, and Greek×Greek — across the underlying's legs over one shared spot and a single days-forward axis (each leg keeps its own strike and expiry). Single-leg and aggregate share one net-position engine, so every view now reads in **net-position terms** (per-share × 100 × contracts).

- **Color greek (∂Γ/∂t)** in the readout and selectable as a surface Z / scatter axis.
- The lab **remembers your last view, 3D surface orientation, and link/skew** across opens.
- A **"Greeks Lab ▸"** button on the Simulation tab opens the lab for the focused ticker — aggregated when it has multiple legs.

### Portfolio market-shock (Risk tab)
A new card reprices the whole book — shares and every option leg — across a ±25% market move and a days-forward axis, entirely client-side. It shows the P&L curve (with the book's gamma convexity), net $Δ / Θ / vega, and the worst case in range. **Parallel** by default (every underlying moves the slider %); a **β-weight** toggle moves each name by its 6-month beta vs SPY, served by a new `/api/risk/betas` endpoint.

## Upgrade

Local desk app — no data migration. Rebuild the frontend bundle, and **restart the server** (this release adds the `/api/risk/betas` endpoint):

```
npm run build      # or just launch start.bat, which builds in its prep step
```

On Windows use **Command Prompt** for `npm` (PowerShell blocks `npm.ps1` by default), or run `start.bat`.

## Verification

`tsc` and `esbuild` clean (17-module bundle); `app.py` syntax verified. Live-checked end to end: aggregate net Δ/Γ equals the sum of the legs exactly (OVID's 3 puts: Δ 4749 / Γ −3164.3); aggregate Taylor matches the exact reprice to ~$1 on a −10% move; the market-shock P&L is 0 at 0% move and recomputes correctly under the β toggle (parallel −$8,224 → β-weighted −$9,543 at −10%).
