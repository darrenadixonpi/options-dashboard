/**
 * Bundler entry marker (#7).
 * Dev: index.html loads MODULE_ORDER files individually (shared global scope).
 * Prod: esbuild concatenates these files in order → static/dist/app.bundle.js
 */
// @bundle-entry
