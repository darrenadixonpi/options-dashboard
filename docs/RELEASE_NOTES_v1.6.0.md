# Options Dashboard v1.6.0 — Spread builder & deeper market-shock

Released 2026-06-21. Builds on v1.5.0 (whole-book Greeks & portfolio market-shock).

## Highlights

### Greeks Lab — hypothetical legs / spread builder
Add custom legs (type / strike / DTE / contracts) to the lab scope to preview a spread's **net** greeks, curves, surface, and Taylor P&L before you trade it — remove each with a click. It works on a single leg or layered on top of a whole-underlying aggregate, so you can stress a proposed adjustment against your existing book on that name.

### Portfolio market-shock — depth
The Risk-tab shock card gains:

- a **per-underlying P&L contribution breakdown** (ranked bars) at the current move, so you can see which names drive the gain or loss;
- a **vol-response** slider — implied vol rises N points per 10% down-move (and eases on up-moves), applied to the shocked reprice only, so a crash scenario steepens your short-vol downside instead of assuming flat vol.

## Upgrade

Local desk app — no data migration. Rebuild the frontend bundle:

```
npm run build      # or just launch start.bat, which builds in its prep step
```

On Windows use **Command Prompt** for `npm` (PowerShell blocks `npm.ps1` by default). No server restart needed — this release is frontend-only.

## Verification

`tsc` and `esbuild` clean (17-module bundle). Live-checked: a hypothetical leg equal-and-opposite to a held leg nets the Greeks Lab to zero (Δ +53 → 0, Γ −0.6 → 0) and restores on removal; the shock breakdown's top names sum to the net move, and the vol-response steepens the worst case (−$21.2k → −$22.9k at +10 IV per 10%).
