# Frontend modules

TypeScript ES modules, bundled by esbuild into one IIFE. Edit the module that matches the feature area.

| File | Contents |
|------|----------|
| `01-parsers.ts` | CSV/OCC parsing, history filters |
| `02-portfolio.ts` | Share reconstruction, strategy detection, `buildPortfolio` |
| `03-render.ts` | `renderPortfolio`, strike/ticker HTML |
| `04-state.ts` | `state`, charts registry, rail, export (PNG + CSV), chart export helpers, keyboard, wide layout |
| `05-session-api.ts` | Session save/restore, fetch helpers, attribution, what-if, import drop zones |
| `06-fetch.ts` | Fetch pipeline click handler |
| `07-tabs.ts` | Tab switching, what-if form handlers, journal cumulative P&L chart |
| `03-chart-utils.ts` | Chart.js crosshair plugin, pan/zoom helpers, fan-chart label layout |
| `08-simulate.ts` | Monte Carlo results, path charts, histogram range UX |
| `09-risk.ts` | Risk matrix, vol surface, unusual activity |
| `10-journal.ts` | Closed trade table |
| `11-roll-catalysts-init.ts` | Roll modal, catalysts, app boot |
| `12-snapshots.ts` | Desk snapshot history UI |
| `10-phase7.ts` | Phase 7 UI — orders, rules, tax lots, VaR, export. Also re-exposes the inline-handler entry points on `window` |
| `13-ibkr.ts` | IBKR Flex panel (status / save / sync / disconnect) |
| `main.ts` | Positions sort + ticker filter + background-refresh badge. Imported **last** |
| `types.ts` | Shared TypeScript interfaces + the `Chart` global, in a `declare global` block (ambient — not bundled at runtime) |
| `_bundle-entry.ts` | Generated esbuild entry — imports every module in `MODULE_ORDER` for side-effect ordering |

**Architecture.** Every module uses real `import`/`export`. esbuild bundles `_bundle-entry.ts` — which imports the modules in `MODULE_ORDER` so their top-level side effects (event-listener registration, app boot) run in the right order — into a single minified IIFE at `static/dist/app.bundle.js`. `index.html` loads just that one file. All 16 runtime modules are typechecked together via `tsconfig.frontend.json`; `state` is annotated `AppState` in `04-state.ts`, and `types.ts` holds the shared interfaces (kept global via `declare global` so no module needs to import the types).

Because the bundle is closure-scoped (not the old shared global scope), the 16 functions called from inline `on*=` HTML attributes — which the browser evaluates in global scope — are re-exposed on `window` from `10-phase7.ts` (`deleteCatalyst` from `11-roll-catalysts-init.ts`). Any new inline handler needs the same treatment; prefer `addEventListener` for new wiring.

To convert/add a module: write it as a `.ts` with `import`/`export`, add it to `tsconfig.frontend.json` `include` and to `MODULE_ORDER` in `tools/frontend-manifest.mjs` (which regenerates `_bundle-entry.ts`), fix DOM casts (`getElementById(...) as HTMLInputElement`), and run `npm run typecheck:frontend`.

Styles: `../css/app.css`

## Build

```bash
npm install
npm run build          # bundle _bundle-entry.ts → minified static/dist/app.bundle.js + manifest.json, sync index.html
npm run build:watch    # rebuild on save (dev: sourcemaps, no minify)
```

`start.bat` runs the build automatically (via `prep_before_start.py`); CI runs it too. Skip prep during iteration with `set OD_SKIP_PREP=1`, then run `npm run build` after any `.ts` edit.

| Command | Purpose |
|---------|---------|
| `npm run typecheck` | Check shared types in `types.ts` |
| `npm run typecheck:frontend` | Typecheck all 16 modules under `tsconfig.frontend.json` |
| `npm run test:e2e` | Playwright chart smoke tests |
| `npm run vendor:charts` | Re-download vendored Chart.js + annotation plugin |

Chart.js loads from **`static/vendor/`** (vendored locally — not CDN), before the bundle. Module order is defined once in `tools/frontend-manifest.mjs`. `USE_JS_BUNDLE=1` lets Flask serve the bundle without editing `index.html` (now a no-op since the build already points `index.html` at the bundle; retained for Docker parity).

**Phase 3** (TypeScript + ES modules) is complete — see [DOCKET.md](../../DOCKET.md).
