/** Shared module load order for dev script tags and production bundle. */
export const MODULE_ORDER = [
  "01-parsers.js",
  "02-portfolio.js",
  "03-render.js",
  "04-state.js",
  "05-session-api.js",
  "06-fetch.js",
  "07-tabs.js",
  "03-chart-utils.js",
  "08-simulate.js",
  "09-risk.js",
  "10-journal.js",
  "11-roll-catalysts-init.js",
  "12-snapshots.js",
  "10-phase7.js",
  "13-ibkr.js",
  "14-greeks-lab.js",
  "main.js",
];

export const CHART_CDN = [
  "/static/vendor/chart.js/4.4.1/chart.umd.min.js",
  "/static/vendor/chartjs-plugin-annotation/3.0.1/chartjs-plugin-annotation.min.js",
];
