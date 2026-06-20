import { esc } from "./02-portfolio";
import { TAB_MAP, setupKeyboardShortcuts, updateWideLayoutButton } from "./04-state";
import { fetchJson, restoreSession, updateFetchButtonState } from "./05-session-api";
import { fmtDollar } from "./08-simulate";

export async function openRollModal(pos) {
  const modal = document.getElementById("roll-modal");
  modal.hidden = false;
  const expLabel = pos.expiry || "(expiry missing)";
  const body = document.getElementById("roll-modal-body");
  body.innerHTML = `
    <div style="font-size:12px;color:var(--tx2);margin-bottom:12px">${pos.ticker} · ${pos.optType} $${pos.strike} · ${expLabel} · ${pos.contracts} cts · avg $${(pos.avgCost||0).toFixed(2)}</div>
    ${!pos.expiry ? '<div class="error-box" style="margin-bottom:10px">Cannot analyze roll without a current expiry on this leg.</div>' : ""}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;align-items:flex-end">
      <div><label style="font-size:11px;color:var(--tx2)">Target Expiry<br><select id="roll-target-expiry" style="min-width:160px;padding:6px;border-radius:var(--radius);border:1px solid var(--bd);background:var(--bg2);color:var(--tx);font-family:var(--mono);font-size:12px"><option value="">Loading expiries…</option></select></label></div>
      <div><label style="font-size:11px;color:var(--tx2)">Target Strike<br><input id="roll-target-strike" type="number" step="0.5" value="${pos.strike}" style="width:80px;padding:6px;border-radius:var(--radius);border:1px solid var(--bd);background:var(--bg2);color:var(--tx);font-family:var(--mono);font-size:12px"></label></div>
      <button class="btn btn-sm" id="btn-analyze-roll">Analyze Roll</button>
    </div>
    <div id="roll-results"></div>`;

  const sel = document.getElementById("roll-target-expiry") as HTMLSelectElement | null;
  const analyzeBtn = document.getElementById("btn-analyze-roll") as HTMLButtonElement | null;
  if (!pos.expiry) analyzeBtn.disabled = true;

  try {
    const { data } = await fetchJson(`/api/option-expiries/${pos.ticker}`);
    if (data.expiries?.length) {
      sel.innerHTML = data.expiries.map(e =>
        `<option value="${e.expiry}">${e.expiry} (${e.dte}d)</option>`
      ).join("");
      if (pos.expiry) {
        const afterCurrent = data.expiries.find(e => e.expiry > pos.expiry);
        if (afterCurrent) sel.value = afterCurrent.expiry;
        else sel.value = data.expiries[0].expiry;
      }
    } else {
      sel.innerHTML = `<option value="">${data.error || "No listed expiries"}</option>`;
    }
  } catch (e) {
    sel.innerHTML = `<option value="">Failed to load chain</option>`;
  }

  analyzeBtn.addEventListener("click", async () => {
    const targetExpiry = (document.getElementById("roll-target-expiry") as HTMLSelectElement).value;
    const targetStrike = parseFloat((document.getElementById("roll-target-strike") as HTMLInputElement).value);
    if (!targetExpiry || !pos.expiry) return;
    const resultsEl = document.getElementById("roll-results");
    resultsEl.innerHTML = '<div style="color:var(--tx3)">Analyzing...</div>';
    try {
      const { ok, data } = await fetchJson("/api/roll-analysis", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({ ticker: pos.ticker, current: { expiry: pos.expiry, strike: pos.strike, optType: pos.optType, contracts: pos.contracts, avgCost: pos.avgCost }, target: { expiry: targetExpiry, strike: targetStrike } })
      });
      if (!ok || data.error) { resultsEl.innerHTML = `<div class="error-box">${esc(data.error || "Roll analysis failed")}</div>`; return; }
      const r = data.roll;
      const creditColor = r.isCredit ? "var(--ok-tx)" : "var(--err-tx)";
      resultsEl.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px">
          <div class="stat" style="border-left:3px solid ${creditColor}"><div class="stat-label">${r.isCredit ? "Net Credit" : "Net Debit"}</div><div class="stat-val" style="color:${creditColor}">${fmtDollar(Math.abs(r.totalCredit))}</div><div style="font-size:10px;color:var(--tx3)">${r.netPerContract.toFixed(4)}/ct</div></div>
          <div class="stat"><div class="stat-label">New Avg Cost</div><div class="stat-val" style="font-size:16px">$${r.newAvgCost.toFixed(4)}</div></div>
        </div>
        <div style="margin-top:12px;font-size:11px;font-family:var(--mono);color:var(--tx2)">
          <div>Current: ${data.current.dte}d DTE · Theoretical $${data.current.theoretical}</div>
          <div>Target: ${data.target.dte}d DTE · Mid $${data.target.mid} · IV ${data.target.iv}%</div>
          <div style="margin-top:6px">Greeks Δ: Δ${data.greeksDelta.delta.toFixed(1)} Γ${data.greeksDelta.gamma.toFixed(3)} Θ$${data.greeksDelta.theta.toFixed(1)} V$${data.greeksDelta.vega.toFixed(1)}</div>
        </div>`;
    } catch(e) { resultsEl.innerHTML = `<div class="error-box">${e.message}</div>`; }
  });
}

document.getElementById("roll-modal-close")?.addEventListener("click", () => { document.getElementById("roll-modal").hidden = true; });
document.getElementById("roll-modal")?.addEventListener("click", (e) => { if ((e.target as HTMLElement).id === "roll-modal") document.getElementById("roll-modal").hidden = true; });

// ═══════════════════════════════════════════════════════════════════════════
// Custom Catalysts (#8)
// ═══════════════════════════════════════════════════════════════════════════

export async function loadCatalysts() {
  try {
    const res = await fetch("/api/catalysts");
    const catalysts = await res.json();
    const list = document.getElementById("catalyst-list");
    if (!catalysts.length) { list.innerHTML = "No custom catalysts"; return; }
    list.innerHTML = catalysts.map(c => `<span style="display:inline-flex;align-items:center;gap:4px;background:var(--bg2);padding:3px 8px;border-radius:4px;margin:2px">${c.ticker} · ${c.event_date} · ${c.description || c.event_type} <button class="btn-ghost" style="font-size:10px;padding:0 4px;cursor:pointer;border:none;background:none;color:var(--err-tx)" onclick="deleteCatalyst(${c.id})">✕</button></span>`).join(" ");
  } catch(e) {}
}

document.getElementById("btn-add-catalyst")?.addEventListener("click", async () => {
  const ticker = (document.getElementById("cat-ticker") as HTMLInputElement).value.trim().toUpperCase();
  const date = (document.getElementById("cat-date") as HTMLInputElement).value;
  const label = (document.getElementById("cat-label") as HTMLInputElement).value.trim();
  if (!ticker || !date) return;
  await fetch("/api/catalysts", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({ticker, date, label}) });
  (document.getElementById("cat-ticker") as HTMLInputElement).value = "";
  (document.getElementById("cat-date") as HTMLInputElement).value = "";
  (document.getElementById("cat-label") as HTMLInputElement).value = "";
  loadCatalysts();
});

(window as any).deleteCatalyst = async function(id: number) {
  await fetch(`/api/catalysts/${id}`, { method: "DELETE" });
  loadCatalysts();
};

Object.entries(TAB_MAP).forEach(([key, elId]) => {
  const el = document.getElementById(elId);
  if (el && key !== "positions") el.hidden = true;
});
if (localStorage.getItem("od_wide") === "1") document.querySelector(".container")?.classList.add("wide");
updateWideLayoutButton();
setupKeyboardShortcuts();
updateFetchButtonState();
// Defer restore to a macrotask so it runs AFTER the whole bundle IIFE has
// finished evaluating every module. Calling it inline (mid-IIFE) could render
// the book before a later-evaluated module assigned its exports (e.g. SEV_CLASS
// in 03-render under the circular import graph), throwing mid-render and leaving
// the positions blank until a manual Fetch. The DOM is already parsed (the
// bundle loads at end of body), so a 0ms defer is safe.
setTimeout(restoreSession, 0);
loadCatalysts();

