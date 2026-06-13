/**
 * Bundler entry marker (#7).
 * Dev: index.html loads MODULE_ORDER files individually (shared global scope).
 * Prod: esbuild concatenates these files in order → static/dist/app.bundle.js
 */
// @bundle-entry

// ─── Position filter + sort (Phase 4.2) ──────────────────────────────────

function applyTickerFilter(query) {
  const q = (query || "").trim().toUpperCase();
  document.querySelectorAll("#portfolio-body .tk-block").forEach(block => {
    const ticker = (block.dataset.ticker || "").toUpperCase();
    block.classList.toggle("pos-filtered-out", q.length > 0 && !ticker.startsWith(q));
  });
}

document.addEventListener("DOMContentLoaded", () => {
  const filterInput = document.getElementById("pos-ticker-filter");
  if (filterInput) {
    filterInput.addEventListener("input", () => applyTickerFilter(filterInput.value));
    // Clear filter on Escape
    filterInput.addEventListener("keydown", e => {
      if (e.key === "Escape") { filterInput.value = ""; applyTickerFilter(""); filterInput.blur(); }
    });
  }

  document.getElementById("pos-filter-bar")?.addEventListener("click", e => {
    const btn = e.target.closest(".pos-sort-btn");
    if (!btn) return;
    state.posSortBy = btn.dataset.sort;
    document.querySelectorAll(".pos-sort-btn").forEach(b => b.classList.toggle("active", b === btn));
    if (state.portfolio) renderPortfolio(state.portfolio, !!state.marketData);
  });
});
