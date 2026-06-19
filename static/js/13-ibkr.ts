import { state } from "./04-state";
import { fetchJson, saveSession, updateFetchButtonState } from "./05-session-api";

// ─── IBKR Flex Web Service connect / sync ────────────────────────────────────
// Token-based positions sync. Config is saved server-side to a local gitignored
// file (POST /api/ibkr/config), so users never edit .env. Mirrors the Schwab panel.
(function () {
  async function ibkrFetch(url: string, opts?: RequestInit): Promise<{ ok: boolean; data: any }> {
    if (typeof fetchJson === "function") return fetchJson(url, opts);
    const res = await fetch(url, opts);
    let data: any = null;
    try { data = await res.json(); } catch (e) { /* ignore */ }
    return { ok: res.ok, data };
  }

  async function checkIBKRStatus(): Promise<void> {
    const panel = document.getElementById("ibkr-api-panel");
    if (!panel) return;
    const { ok, data } = await ibkrFetch("/api/ibkr/status");
    if (!ok || !data) return;
    panel.hidden = false;

    const badge = document.getElementById("ibkr-status-badge");
    const configSection = document.getElementById("ibkr-config-section");
    const syncSection = document.getElementById("ibkr-sync-section");
    const queryEl = document.getElementById("ibkr-query-display");

    if (data.configured) {
      if (badge) { badge.textContent = "Connected"; badge.style.background = "var(--bg3)"; badge.style.color = "var(--ok-tx, var(--tx2))"; }
      if (configSection) configSection.hidden = true;
      if (syncSection) syncSection.hidden = false;
      if (queryEl) queryEl.textContent = data.query_id ? `Query ${data.query_id}` : "";
    } else {
      if (badge) { badge.textContent = "Not connected"; badge.style.background = "var(--bg3)"; badge.style.color = "var(--tx3)"; }
      if (configSection) configSection.hidden = false;
      if (syncSection) syncSection.hidden = true;
      if (queryEl) queryEl.textContent = "";
    }
  }

  async function ibkrSaveConfig(): Promise<void> {
    const tokenEl = document.getElementById("ibkr-token") as HTMLInputElement | null;
    const queryEl = document.getElementById("ibkr-query-id") as HTMLInputElement | null;
    const errEl = document.getElementById("ibkr-config-error");
    const token = tokenEl && tokenEl.value.trim();
    const queryId = queryEl && queryEl.value.trim();
    if (!token || !queryId) {
      if (errEl) { errEl.textContent = "Enter both the Flex token and the query ID."; errEl.style.display = "block"; }
      return;
    }
    if (errEl) errEl.style.display = "none";
    const btn = document.getElementById("btn-ibkr-save") as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    try {
      const { ok, data } = await ibkrFetch("/api/ibkr/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, query_id: queryId }),
      });
      if (!ok || (data && data.error)) {
        if (errEl) { errEl.textContent = (data && data.error) || "Could not save config."; errEl.style.display = "block"; }
        return;
      }
      if (tokenEl) tokenEl.value = "";
      await checkIBKRStatus();
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function ibkrSync(): Promise<void> {
    const btn = document.getElementById("btn-ibkr-sync") as HTMLButtonElement | null;
    const statusEl = document.getElementById("ibkr-sync-status");
    if (btn) { btn.disabled = true; btn.textContent = "Syncing…"; }
    if (statusEl) statusEl.textContent = "";
    try {
      const { ok, data } = await ibkrFetch("/api/ibkr/sync", { method: "POST" });
      if (!ok || (data && data.error)) {
        if (statusEl) statusEl.textContent = `Error: ${(data && data.error) || "Sync failed"}`;
        return;
      }
      const positions = (data && data.positions) || [];
      if (!positions.length) {
        if (statusEl) statusEl.textContent = "No positions returned from IBKR.";
        return;
      }
      // Load positions into state exactly as a CSV parse would.
      state.positions = positions.map((p: any) => ({ ...p, expiry: p.expiry ? new Date(p.expiry) : null }));
      state.rawPosTexts = ["__ibkr_api__"]; // sentinel so the Fetch button enables
      state.format = "ibkr_flex";
      if (typeof updateFetchButtonState === "function") updateFetchButtonState();

      const dz = document.getElementById("dz-positions");
      if (dz) {
        dz.classList.add("has-file");
        const hint = dz.querySelector(".drop-hint");
        if (hint) hint.textContent = `${positions.length} positions from IBKR`;
        const icon = dz.querySelector(".drop-icon");
        if (icon) icon.textContent = "✓";
      }
      const syncedAt = data.synced_at ? new Date(data.synced_at).toLocaleTimeString() : "";
      if (statusEl) statusEl.textContent = `✓ ${positions.length} positions synced at ${syncedAt}`;
      if (typeof saveSession === "function") saveSession();
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "↻ Sync positions from IBKR"; }
    }
  }

  async function ibkrDisconnect(): Promise<void> {
    if (!confirm("Disconnect IBKR and delete the saved Flex token?")) return;
    await ibkrFetch("/api/ibkr/disconnect", { method: "POST" });
    await checkIBKRStatus();
  }

  document.getElementById("btn-ibkr-save")?.addEventListener("click", ibkrSaveConfig);
  document.getElementById("btn-ibkr-sync")?.addEventListener("click", ibkrSync);
  document.getElementById("btn-ibkr-disconnect")?.addEventListener("click", ibkrDisconnect);

  // Refresh status when the IBKR broker tab is selected.
  document.querySelectorAll(".broker-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if ((btn as HTMLElement).dataset.broker === "ibkr") checkIBKRStatus();
    });
  });

  // Check on initial load if IBKR is already the active broker.
  if (document.querySelector(".broker-btn[data-broker='ibkr'].active")) checkIBKRStatus();
})();
