import { renderPortfolio } from "./03-render";
import { state } from "./04-state";

/**
 * Bundler entry marker (#7).
 * Dev: index.html loads MODULE_ORDER files individually (shared global scope).
 * Prod: esbuild concatenates these files in order → static/dist/app.bundle.js
 */
// @bundle-entry

// ─── Position filter + sort (Phase 4.2) ──────────────────────────────────

export function applyTickerFilter(query) {
  const q = (query || "").trim().toUpperCase();
  document.querySelectorAll("#portfolio-body .tk-block").forEach(block => {
    const ticker = ((block as HTMLElement).dataset.ticker || "").toUpperCase();
    block.classList.toggle("pos-filtered-out", q.length > 0 && !ticker.startsWith(q));
  });
}

document.addEventListener("DOMContentLoaded", () => {
  // Keep the header version badge in sync with the VERSION file (served at
  // /api/version) so it can't go stale like the old hard-coded "v1.2".
  const verEl = document.querySelector(".top-version") as HTMLElement | null;
  if (verEl) {
    fetch("/api/version").then(r => r.json()).then(d => {
      if (d && d.version) {
        verEl.textContent = "v" + d.version;
        verEl.title = "Release v" + d.version;
      }
    }).catch(() => {});
  }

  const filterInput = document.getElementById("pos-ticker-filter") as HTMLInputElement | null;
  if (filterInput) {
    filterInput.addEventListener("input", () => applyTickerFilter(filterInput.value));
    // Clear filter on Escape
    filterInput.addEventListener("keydown", e => {
      if (e.key === "Escape") { filterInput.value = ""; applyTickerFilter(""); filterInput.blur(); }
    });
  }

  document.getElementById("pos-filter-bar")?.addEventListener("click", e => {
    const btn = (e.target as HTMLElement).closest(".pos-sort-btn");
    if (!btn) return;
    state.posSortBy = (btn as HTMLElement).dataset.sort;
    document.querySelectorAll(".pos-sort-btn").forEach(b => b.classList.toggle("active", b === btn));
    if (state.portfolio) renderPortfolio(state.portfolio, !!state.marketData);
  });

  // Effective (premium-adjusted) basis toggle — persisted in localStorage, re-renders cards.
  const effToggle = document.getElementById("toggle-eff-basis") as HTMLInputElement | null;
  if (effToggle) {
    try { effToggle.checked = localStorage.getItem("od_effective_basis") === "1"; } catch (e) {}
    effToggle.addEventListener("change", () => {
      try { localStorage.setItem("od_effective_basis", effToggle.checked ? "1" : "0"); } catch (e) {}
      if (state.portfolio) renderPortfolio(state.portfolio, !!state.marketData);
    });
  }

  // Effective-basis premium scope: All (all-time) vs Since lot (current holding only).
  const effModeWrap = document.getElementById("effbasis-mode");
  if (effModeWrap) {
    const syncMode = () => {
      let mode = "all";
      try { mode = localStorage.getItem("od_effbasis_mode") === "lot" ? "lot" : "all"; } catch (e) {}
      effModeWrap.querySelectorAll(".effmode-btn").forEach(b =>
        b.classList.toggle("btn-ghost", (b as HTMLElement).dataset.effmode !== mode));
    };
    syncMode();
    effModeWrap.addEventListener("click", e => {
      const btn = (e.target as HTMLElement).closest(".effmode-btn") as HTMLElement | null;
      if (!btn) return;
      try { localStorage.setItem("od_effbasis_mode", btn.dataset.effmode === "lot" ? "lot" : "all"); } catch (e) {}
      syncMode();
      if (state.portfolio) renderPortfolio(state.portfolio, !!state.marketData);
    });
  }

  // ─── Background refresh badge (Phase 5.1) ───────────────────────────────
  // Poll /api/market-data/cached every 60s. When the server has fresher data
  // than the last manual fetch, show a clickable "↻ refreshed Xm ago" badge.
  const BG_POLL_MS = 60_000;

  function _bgRefreshAge(isoStr) {
    const ms = Date.now() - new Date(isoStr).getTime();
    const min = Math.round(ms / 60_000);
    return min <= 1 ? "just now" : `${min}m ago`;
  }

  function _showBgBadge(updatedAt) {
    let badge = document.getElementById("bg-refresh-badge");
    if (!badge) {
      badge = document.createElement("span");
      badge.id = "bg-refresh-badge";
      badge.title = "Server refreshed market data in background. Click to apply.";
      badge.style.cssText =
        "cursor:pointer;font-size:11px;color:var(--accent);margin-left:8px;" +
        "opacity:0.85;font-family:var(--mono);";
      badge.addEventListener("click", () => {
        // Apply cached data to state and re-render if we have a portfolio
        fetch("/api/market-data/cached")
          .then(r => r.ok ? r.json() : null)
          .then(json => {
            if (!json || !json.data) return;
            state.marketData = { ...(state.marketData || {}), ...json.data };
            if (state.portfolio) renderPortfolio(state.portfolio, true);
            badge.remove();
          })
          .catch(() => {});
      });
      const fetchBtn = document.getElementById("fetch-btn") ||
                       document.querySelector("button[data-action='fetch']");
      if (fetchBtn) fetchBtn.parentNode.insertBefore(badge, fetchBtn.nextSibling);
    }
    badge.textContent = `↻ refreshed ${_bgRefreshAge(updatedAt)}`;
    badge.dataset.updatedAt = updatedAt;
  }

  function _pollBgCache() {
    // Only show badge when we already have a portfolio loaded
    if (!state.portfolio) return;
    fetch("/api/market-data/cached")
      .then(r => r.status === 204 ? null : r.json())
      .then(json => {
        if (!json || !json.updated_at) return;
        // Only show if bg data is newer than last manual fetch
        const bgTs = new Date(json.updated_at).getTime();
        const lastFetch = state.fetchedAt ? new Date(state.fetchedAt).getTime() : 0;
        if (bgTs > lastFetch) _showBgBadge(json.updated_at);
      })
      .catch(() => {});
  }

  setInterval(_pollBgCache, BG_POLL_MS);
});
