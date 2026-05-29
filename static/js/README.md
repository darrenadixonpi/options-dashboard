# Frontend modules

Classic scripts loaded in order (shared global scope). Edit the module that matches the feature area.

| File | Contents |
|------|----------|
| `01-parsers.js` | CSV/OCC parsing, history filters |
| `02-portfolio.js` | Share reconstruction, strategy detection, `buildPortfolio` |
| `03-render.js` | `renderPortfolio`, strike/ticker HTML |
| `04-state.js` | `state`, charts registry, rail, export (PNG + CSV), chart export helpers, keyboard, wide layout |
| `05-session-api.ts` | Session save/restore, fetch helpers, attribution, what-if, import drop zones **(TS pilot — source)** |
| `06-fetch.js` | Fetch pipeline click handler |
| `07-tabs.js` | Tab switching, what-if form handlers, journal cumulative P&L chart |
| `03-chart-utils.js` | Chart.js crosshair plugin, pan/zoom helpers, fan-chart label layout |
| `08-simulate.ts` | Monte Carlo results, path charts, histogram range UX **(TS pilot — source)** |
| `09-risk.js` | Risk matrix, vol surface, unusual activity |
| `10-journal.js` | Closed trade table |
| `11-roll-catalysts-init.js` | Roll modal, catalysts, app boot |
| `12-snapshots.js` | Desk snapshot history UI |
| `types.ts` | Shared TypeScript interfaces (not loaded at runtime) |
| `main.js` | Bundler entry marker (not loaded in dev) |

**TypeScript pilot:** `05-session-api.ts` and `08-simulate.ts` are the source of truth. `npm run build` emits `05-session-api.js` and `08-simulate.js` for dev script tags (gitignored). CI and `start.bat` run the build automatically.

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
