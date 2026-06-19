# Frontend modules

Classic scripts loaded in order (shared global scope). Edit the module that matches the feature area.

| File | Contents |
|------|----------|
| `01-parsers.ts` | CSV/OCC parsing, history filters **(TS — source)** |
| `02-portfolio.ts` | Share reconstruction, strategy detection, `buildPortfolio` **(TS — source)** |
| `03-render.ts` | `renderPortfolio`, strike/ticker HTML **(TS — source)** |
| `04-state.ts` | `state`, charts registry, rail, export (PNG + CSV), chart export helpers, keyboard, wide layout **(TS — source)** |
| `05-session-api.ts` | Session save/restore, fetch helpers, attribution, what-if, import drop zones **(TS pilot — source)** |
| `06-fetch.ts` | Fetch pipeline click handler **(TS — source)** |
| `07-tabs.ts` | Tab switching, what-if form handlers, journal cumulative P&L chart **(TS — source)** |
| `03-chart-utils.ts` | Chart.js crosshair plugin, pan/zoom helpers, fan-chart label layout **(TS — source)** |
| `08-simulate.ts` | Monte Carlo results, path charts, histogram range UX **(TS pilot — source)** |
| `09-risk.ts` | Risk matrix, vol surface, unusual activity **(TS — source)** |
| `10-journal.ts` | Closed trade table **(TS — source)** |
| `11-roll-catalysts-init.ts` | Roll modal, catalysts, app boot **(TS — source)** |
| `12-snapshots.ts` | Desk snapshot history UI **(TS — source)** |
| `10-phase7.ts` | Phase 7 UI — orders, rules, tax lots, VaR, export **(TS — source)** |
| `13-ibkr.ts` | IBKR Flex panel (status / save / sync / disconnect) **(TS — source)** |
| `types.ts` | Shared TypeScript interfaces (not loaded at runtime) |
| `main.ts` | Positions sort + ticker filter + background-refresh badge; also the bundler entry. Loaded **last**. **(TS — source)** |

**TypeScript modules:** **all 16 runtime modules are now TypeScript source** (typechecked via `tsconfig.pilot.json`, which now covers the whole frontend). `state` is annotated `AppState` in `04-state.ts`; `types.ts` holds the shared interfaces. The architecture is still global-script scope (the build concatenates each transpiled `.js`); moving to real ES module imports is the remaining backlog item. `npm run build` emits the sibling `.js` for dev script tags (gitignored). CI and `start.bat` run the build automatically. To convert another module: rename `X.js` → `X.ts`, add it to `tsconfig.pilot.json` `include` + `.gitignore`, fix DOM casts (`getElementById(...) as HTMLInputElement`), and run `npm run typecheck:pilot`. Cross-module globals resolve if they're declared in `types.ts` (`declare global`) or defined in another included `.ts`.

**Phase 3 remainder** (convert all modules, drop `@ts-nocheck`, etc.): see [DOCKET.md](../../DOCKET.md).

Styles: `../css/app.css`

Module order is defined once in `tools/frontend-manifest.mjs` (used by the bundler and Flask bundle mode).

## Dev (default)

`index.html` loads each file via `<script src="/static/js/…">`. After editing `.ts` pilot files, run **`npm run build`** (or use `start.bat`, which runs prep including build).

Chart.js loads from **`static/vendor/`** (vendored locally — not CDN).

## Production bundle (#7)

```bash
npm install
npm run build          # transpile TS + minified static/dist/app.bundle.js + manifest.json
npm run build:watch    # rebuild on save (dev: sourcemaps, no minify)
npm run build:prod     # minified build + patch index.html to bundle mode
```

| Command | Purpose |
|---------|---------|
| `npm run typecheck` | Check shared types in `types.ts` |
| `npm run typecheck:pilot` | Check TS pilot modules |
| `npm run test:e2e` | Playwright chart smoke tests |
| `npm run vendor:charts` | Re-download vendored Chart.js + annotation plugin |
| `npm run index:bundle` | Point index.html at the bundle (after `npm run build`) |
| `npm run index:modules` | Restore individual script tags |
| `USE_JS_BUNDLE=1` | Flask serves bundle **without** editing index.html (Docker uses this) |

To re-split from a monolithic inline script: `python tools/split_frontend.py`  
To rebuild `index.html` script tags: `python tools/rebuild_index.py`
