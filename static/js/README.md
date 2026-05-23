# Frontend modules

Classic scripts loaded in order (shared global scope). Edit the module that matches the feature area.

| File | Contents |
|------|----------|
| `01-parsers.js` | CSV/OCC parsing, history filters |
| `02-portfolio.js` | Share reconstruction, strategy detection, `buildPortfolio` |
| `03-render.js` | `renderPortfolio`, strike/ticker HTML |
| `04-state.js` | `state`, charts registry, rail, export (PNG + CSV), chart export helpers, keyboard, wide layout |
| `05-session-api.js` | Session save/restore, fetch helpers, attribution, what-if, import drop zones |
| `06-fetch.js` | Fetch pipeline click handler |
| `07-tabs.js` | Tab switching, what-if form handlers |
| `08-simulate.js` | Monte Carlo results + path charts |
| `09-risk.js` | Risk matrix, vol surface, unusual activity |
| `10-journal.js` | Closed trade table |
| `11-roll-catalysts-init.js` | Roll modal, catalysts, app boot |
| `12-snapshots.js` | Desk snapshot history UI |
| `main.js` | Bundler entry marker (not loaded in dev) |

Styles: `../css/app.css`

Module order is defined once in `tools/frontend-manifest.mjs` (used by the bundler and Flask bundle mode).

## Dev (default)

`index.html` loads each file via `<script src="/static/js/…">` — no build step, fast refresh.

## Production bundle (#7)

```bash
npm install
npm run build          # minified static/dist/app.bundle.js + manifest.json
npm run build:watch    # rebuild on save (unminified + sourcemap)
npm run build:prod     # build + patch index.html to bundle mode
```

**Use bundled JS without editing index.html:** start Flask with `USE_JS_BUNDLE=1` (Docker sets this automatically).

**Toggle index.html manually:**

```bash
npm run index:bundle    # after npm run build
npm run index:modules   # restore individual script tags
python tools/frontend_scripts.py bundle|modules
```

To re-split from a monolithic inline script: `python tools/split_frontend.py`  
To rebuild `index.html` script tags: `python tools/rebuild_index.py`
