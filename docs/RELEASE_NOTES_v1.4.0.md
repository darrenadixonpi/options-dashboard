# Options Dashboard v1.4.0 — Greeks Lab: surfaces & relationships

Released 2026-06-20. Builds on v1.3.0 (analytics & risk, premium-adjusted cost basis, the first interactive Greeks Lab).

## Highlights

### Greeks Lab v2 — relationships & 3D surfaces
The per-leg Black-Scholes lab gains a **view switcher** with four modes beyond the original curves, all computed on the existing client-side BSM (no added server load):

- **Θ–Γ gamma-rent** — theta overlaid on its −½σ²S²Γ identity (they track), plus the gamma breakeven daily move √(−2·Θ/Γ) versus the 1σ implied daily move, and a rich / cheap / fair read on whether theta is fair pay for your gamma.
- **Surface** — value or any Greek over two of {spot, DTE, IV}, rendered as a **drag-to-rotate 3D wireframe** or a **2D heatmap** with contour bands. Hand-rolled canvas — no new dependencies. Default Γ-over-spot×DTE shows the gamma ridge sharpening into the strike near expiry.
- **Taylor P&L** — decomposes a what-if move (dS, dσ, dt) into Δ·dS, ½Γ·dS², Θ·dt, vega·dσ, vanna, ½vomma, charm and speed contributions, plus the residual versus an exact reprice (with % explained).
- **Greek×Greek** — any Greek plotted parametrically against another as spot or DTE sweeps (e.g. Θ as a function of Γ).

### In-popup leg switcher
A **Leg** dropdown lists every option leg in the book; choosing one re-loads the lab for that leg while preserving your current view, 3D orientation, and link/skew settings — no need to close the popup and find another leg's button.

### UX
- The per-leg **Roll** and **Greeks** buttons are now bordered chips (Greeks accent-outlined) instead of faint ghost text; the shared `.btn-ghost` style is brighter platform-wide so secondary buttons are easier to spot.
- **Fix:** clicking Roll or Greeks no longer jumps you to the Simulation tab — the popup opens over Positions.
- **Fix:** the Portfolio P&L histogram's pan/zoom now survives a session reload.

## Upgrade

Local desk app — no data migration. After updating the code, rebuild the frontend bundle:

```
npm run build      # or just launch start.bat, which builds in its prep step
```

On Windows use **Command Prompt** for `npm` (PowerShell blocks `npm.ps1` by default), or run `start.bat`.

## Verification

`tsc` and `esbuild` clean (17-module bundle). All five Greeks Lab views were verified live against a real book; the Taylor decomposition matched the exact Black-Scholes reprice to within ~$0.40 on a combined −8% spot + 5 vol-point move, and the Θ–Γ breakeven/implied-move ratio read 0.98× at the money as expected.
