/**
 * Phase 7 — Tax lots, VaR, Strategy templates, Alert rules, Export, Orders
 * Loaded after all other modules. All functions write to global state / DOM.
 */

// ─── 7.5 Tax Lots ────────────────────────────────────────────────────────────

async function loadTaxLots(method, taxYear) {
  const panel = document.getElementById("tax-lots-panel");
  if (!panel) return;
  panel.innerHTML = '<span style="color:var(--tx3);font-size:12px">Loading…</span>';

  const body = { method: method || "fifo", tax_year: taxYear || null };
  try {
    const res = await fetch("/api/tax-lots/compute", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) { panel.innerHTML = `<span style="color:var(--err-tx)">${data.error}</span>`; return; }
    renderTaxLots(data, panel);
  } catch (e) {
    panel.innerHTML = `<span style="color:var(--err-tx)">Failed: ${e.message}</span>`;
  }
}

function renderTaxLots(data, panel) {
  const s = data.summary;
  const gainColor = v => v >= 0 ? "#4caf50" : "#f44336";
  const fmtD = v => (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const summaryHtml = `
    <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:14px">
      <div class="stat"><div class="stat-label">Short-term gain/loss</div><div class="stat-val" style="color:${gainColor(s.short_term_gain)}">${fmtD(s.short_term_gain)}</div></div>
      <div class="stat"><div class="stat-label">Long-term gain/loss</div><div class="stat-val" style="color:${gainColor(s.long_term_gain)}">${fmtD(s.long_term_gain)}</div></div>
      <div class="stat"><div class="stat-label">Wash-sale disallowed</div><div class="stat-val" style="color:var(--warn-tx)">$${Math.abs(s.wash_sale_disallowed).toFixed(2)}</div></div>
      <div class="stat"><div class="stat-label">Net realized</div><div class="stat-val" style="color:${gainColor(s.net_gain)};font-weight:600">${fmtD(s.net_gain)}</div></div>
    </div>`;

  let tableHtml = "";
  if (data.realized.length) {
    tableHtml = `<div style="overflow-x:auto;margin-bottom:12px">
      <table class="hist-tbl" style="font-size:11px;width:100%">
        <tr><th>Box</th><th>Description</th><th>Opened</th><th>Closed</th><th>Proceeds</th><th class="r">Cost Basis</th><th class="r">Gain/(Loss)</th><th class="r">WS Disallowed</th><th class="r">Adjusted</th></tr>
        ${data.realized.map(ev => `<tr>
          <td>${ev.box}</td>
          <td style="font-family:var(--mono)">${ev.description}</td>
          <td>${ev.open_date}</td>
          <td>${ev.close_date}</td>
          <td class="r">$${ev.proceeds.toFixed(2)}</td>
          <td class="r">$${ev.cost_basis.toFixed(2)}</td>
          <td class="r" style="color:${gainColor(ev.gain_loss)}">${fmtD(ev.gain_loss)}</td>
          <td class="r" style="color:${ev.wash_sale_disallowed > 0 ? "var(--warn-tx)" : "var(--tx3)"}">
            ${ev.wash_sale_disallowed > 0 ? "$" + ev.wash_sale_disallowed.toFixed(2) : "—"}
          </td>
          <td class="r" style="color:${gainColor(ev.adjusted_gain_loss)};font-weight:500">${fmtD(ev.adjusted_gain_loss)}</td>
        </tr>`).join("")}
      </table></div>`;
  } else {
    tableHtml = '<div style="color:var(--tx3);font-size:12px;margin-bottom:10px">No realized events for selected year.</div>';
  }

  const methodSel = (document.getElementById("tax-method") as HTMLInputElement | null)?.value || "fifo";
  const yearSel = (document.getElementById("tax-year") as HTMLInputElement | null)?.value || "";
  const exportUrl = `/api/tax-lots/export?method=${methodSel}&tax_year=${yearSel}`;

  panel.innerHTML = summaryHtml + tableHtml +
    `<a href="${exportUrl}" class="btn btn-sm" style="text-decoration:none;display:inline-block" download>⬇ Download Form 8949 CSV</a>
     <span style="font-size:10px;color:var(--tx3);margin-left:8px">Method: ${data.method.toUpperCase()} · Events: ${s.event_count}</span>`;
}

// ─── 7.6 VaR Panel ───────────────────────────────────────────────────────────

async function loadVaR() {
  const panel = document.getElementById("var-panel");
  if (!panel) return;
  if (!state.simResult?.portfolio_pnl?.length) {
    panel.innerHTML = '<span style="font-size:12px;color:var(--tx3)">Run simulation to compute VaR.</span>';
    return;
  }
  panel.innerHTML = '<span style="color:var(--tx3);font-size:12px">Computing…</span>';
  try {
    const res = await fetch("/api/risk/var", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ portfolio_pnl: state.simResult.portfolio_pnl, confidence: 0.95 }),
    });
    const data = await res.json();
    if (data.error) { panel.innerHTML = `<span style="color:var(--err-tx)">${data.error}</span>`; return; }
    panel.innerHTML = `
      <div style="display:flex;gap:14px;flex-wrap:wrap">
        <div class="stat" style="border-left:3px solid #f44336">
          <div class="stat-label">1-Day VaR (95%)</div>
          <div class="stat-val" style="color:#f44336">$${data.var_1d.toLocaleString()}</div>
        </div>
        <div class="stat" style="border-left:3px solid #ff7043">
          <div class="stat-label">5-Day VaR (95%)</div>
          <div class="stat-val" style="color:#ff7043">$${data.var_5d.toLocaleString()}</div>
        </div>
        <div class="stat" style="border-left:3px solid #b71c1c">
          <div class="stat-label">CVaR / Expected Shortfall</div>
          <div class="stat-val" style="color:#b71c1c">$${data.cvar_1d.toLocaleString()}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Paths</div>
          <div class="stat-val" style="color:var(--tx2)">${data.n_paths.toLocaleString()}</div>
        </div>
      </div>
      <div style="font-size:10px;color:var(--tx3);margin-top:6px">
        VaR uses terminal Monte Carlo P&L distribution. 5-day uses √5 scaling. CVaR = mean loss in tail beyond VaR.
      </div>`;
  } catch (e) {
    panel.innerHTML = `<span style="color:var(--err-tx)">Failed: ${e.message}</span>`;
  }
}

// ─── 7.4 Strategy Templates ───────────────────────────────────────────────────

async function loadStrategyTemplates() {
  const list = document.getElementById("strategy-template-list");
  if (!list) return;
  try {
    const res = await fetch("/api/strategy-templates");
    const templates = await res.json();
    if (!templates.length) {
      list.innerHTML = '<span style="color:var(--tx3);font-size:11px">No saved templates.</span>';
      return;
    }
    list.innerHTML = templates.map(t => `
      <div class="template-row" style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--bd)">
        <div style="flex:1">
          <div style="font-weight:500;font-size:12px">${t.name}</div>
          ${t.description ? `<div style="font-size:10px;color:var(--tx3)">${t.description}</div>` : ""}
        </div>
        <button class="btn btn-sm" onclick="applyStrategyTemplate(${t.id})" title="Load into what-if builder">Apply</button>
        <button class="btn btn-sm btn-ghost" onclick="deleteStrategyTemplate(${t.id})" title="Delete">✕</button>
      </div>`).join("");
  } catch (e) {
    list.innerHTML = `<span style="color:var(--err-tx);font-size:11px">Failed to load templates.</span>`;
  }
}

async function saveStrategyTemplate() {
  const nameEl = document.getElementById("template-name") as HTMLInputElement | null;
  const descEl = document.getElementById("template-desc") as HTMLInputElement | null;
  const name = nameEl?.value?.trim();
  if (!name) { alert("Enter a template name."); return; }
  if (!state.hypothetical?.length) { alert("Add hypothetical legs first."); return; }

  const res = await fetch("/api/strategy-templates", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, description: descEl?.value || "", legs: state.hypothetical }),
  });
  const data = await res.json();
  if (data.error) { alert(data.error); return; }
  if (nameEl) nameEl.value = "";
  if (descEl) descEl.value = "";
  loadStrategyTemplates();
}

async function applyStrategyTemplate(templateId) {
  const res = await fetch("/api/strategy-templates");
  const templates = await res.json();
  const t = templates.find(x => x.id === templateId);
  if (!t) return;
  let legs;
  try { legs = typeof t.legs_json === "string" ? JSON.parse(t.legs_json) : t.legs_json; }
  catch { return; }
  state.hypothetical = legs;
  renderWhatIfList();
  if (state.marketData) applyWhatIfGreeks();
}

async function deleteStrategyTemplate(templateId) {
  if (!confirm("Delete this template?")) return;
  await fetch(`/api/strategy-templates/${templateId}`, { method: "DELETE" });
  loadStrategyTemplates();
}

// ─── 7.3 Alert Rules ─────────────────────────────────────────────────────────

async function loadAlertRules() {
  const list = document.getElementById("alert-rules-list");
  if (!list) return;
  try {
    const res = await fetch("/api/alert-rules");
    const rules = await res.json();
    if (!rules.length) {
      list.innerHTML = '<span style="color:var(--tx3);font-size:11px">No rules defined.</span>';
      return;
    }
    list.innerHTML = rules.map(r => `
      <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--bd)">
        <input type="checkbox" ${r.enabled ? "checked" : ""}
               onchange="toggleAlertRule(${r.id}, this.checked)"
               title="Enable/disable">
        <div style="flex:1;font-size:11px">
          <span style="font-weight:500">${r.name}</span>
          <span style="color:var(--tx3);margin-left:6px">${r.condition_type}${r.ticker ? " · " + r.ticker : ""}${r.threshold != null ? " · " + r.threshold : ""}</span>
        </div>
        <button class="btn btn-sm btn-ghost" onclick="deleteAlertRule(${r.id})">✕</button>
      </div>`).join("");
  } catch (e) {
    list.innerHTML = `<span style="color:var(--err-tx);font-size:11px">Failed to load rules.</span>`;
  }
}

async function addAlertRule() {
  const ct = (document.getElementById("rule-condition-type") as HTMLInputElement | null)?.value;
  const ticker = (document.getElementById("rule-ticker") as HTMLInputElement | null)?.value?.trim().toUpperCase();
  const threshold = parseFloat((document.getElementById("rule-threshold") as HTMLInputElement | null)?.value);
  const name = (document.getElementById("rule-name") as HTMLInputElement | null)?.value?.trim() || ct;
  if (!ct) return;

  const res = await fetch("/api/alert-rules", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, ticker: ticker || null, condition_type: ct, threshold: isNaN(threshold) ? null : threshold }),
  });
  const data = await res.json();
  if (data.error) { alert(data.error); return; }
  loadAlertRules();
}

async function toggleAlertRule(ruleId, enabled) {
  await fetch(`/api/alert-rules/${ruleId}`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: enabled ? 1 : 0 }),
  });
}

async function deleteAlertRule(ruleId) {
  if (!confirm("Delete this rule?")) return;
  await fetch(`/api/alert-rules/${ruleId}`, { method: "DELETE" });
  loadAlertRules();
}

async function evaluateAlertRules() {
  if (!state.marketData) return;
  try {
    const res = await fetch("/api/alert-rules/evaluate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        marketData: state.marketData,
        greeks: state.greeks || {},
        simResult: state.simResult || {},
      }),
    });
    const data = await res.json();
    if (data.triggered?.length) {
      // Show browser notification if permitted
      if (Notification.permission === "granted") {
        data.triggered.forEach(t => {
          new Notification("Options Dashboard Alert", { body: t.message, icon: "/static/favicon.ico" });
        });
      }
      // Refresh desk alerts to pick up new events
      if (typeof refreshDeskAlerts === "function") refreshDeskAlerts();
    }
  } catch (e) { /* silent */ }
}

// ─── 7.7 Notifications ────────────────────────────────────────────────────────

function requestNotificationPermission() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    Notification.requestPermission();
  }
}

async function testEmailNotification() {
  const btn = document.getElementById("btn-test-email") as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
  try {
    const res = await fetch("/api/notify/test", { method: "POST" });
    const data = await res.json();
    alert(data.ok ? `Test email sent to ${data.to}` : `Error: ${data.error}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Send test email"; }
  }
}

// Request permission on first alert
document.addEventListener("DOMContentLoaded", () => {
  if (state.deskAlerts?.length) requestNotificationPermission();
});

// ─── 7.8 Data Export ─────────────────────────────────────────────────────────

function exportPortfolioHistory() {
  window.location.href = "/api/export/portfolio-history";
}

function exportJournal() {
  window.location.href = "/api/export/journal";
}

function exportGreeksSnapshot() {
  window.location.href = "/api/export/greeks-snapshot";
}

// ─── 7.2 Draft Orders ────────────────────────────────────────────────────────

let _orders = [];

async function loadOrders() {
  const panel = document.getElementById("orders-panel");
  if (!panel) return;
  try {
    const res = await fetch("/api/orders");
    _orders = await res.json();
    renderOrders();
  } catch (e) {
    if (panel) panel.innerHTML = `<span style="color:var(--err-tx)">Failed: ${e.message}</span>`;
  }
}

function renderOrders() {
  const panel = document.getElementById("orders-panel");
  if (!panel) return;
  if (!_orders.length) {
    panel.innerHTML = '<div style="color:var(--tx3);font-size:12px;padding:12px 0">No orders. Build a draft order below.</div>';
    return;
  }
  const statusColor = { draft: "var(--tx3)", staged: "#f5c518", submitted: "#4caf50", cancelled: "#f44336" };
  panel.innerHTML = _orders.map(o => {
    const sc = statusColor[o.status] || "var(--tx3)";
    const legs = (o.legs || []).map(l => `${l.ticker} ${l.optType || ""} ${l.strike ? "$" + l.strike : ""} ${l.contracts > 0 ? "+" : ""}${l.contracts}c`).join(" / ");
    return `<div style="padding:10px 0;border-bottom:1px solid var(--bd)">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span style="font-weight:500;font-size:13px">${o.ticker}</span>
        ${o.strategy ? `<span style="font-size:11px;color:var(--tx3)">${o.strategy}</span>` : ""}
        <span style="font-size:10px;padding:2px 7px;border-radius:10px;background:var(--bg3);color:${sc}">${o.status}</span>
        <span style="flex:1"></span>
        ${o.status === "draft" ? `<button class="btn btn-sm" onclick="stageOrder(${o.id})">Stage</button>` : ""}
        <button class="btn btn-sm btn-ghost" onclick="deleteOrder(${o.id})">✕</button>
      </div>
      ${legs ? `<div style="font-size:11px;color:var(--tx2);margin-top:3px;font-family:var(--mono)">${legs}</div>` : ""}
      ${o.notes ? `<div style="font-size:10px;color:var(--tx3);margin-top:2px">${o.notes}</div>` : ""}
    </div>`;
  }).join("");
}

async function createDraftOrder() {
  const ticker = (document.getElementById("order-ticker") as HTMLInputElement | null)?.value?.trim().toUpperCase();
  const strategy = (document.getElementById("order-strategy") as HTMLInputElement | null)?.value?.trim();
  const notes = (document.getElementById("order-notes") as HTMLInputElement | null)?.value?.trim();
  if (!ticker) { alert("Enter a ticker."); return; }

  // Use current what-if legs if any, otherwise empty
  const legs = state.hypothetical?.length ? state.hypothetical : [];

  const res = await fetch("/api/orders", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticker, strategy, legs, notes }),
  });
  const data = await res.json();
  if (data.error) { alert(data.error); return; }
  (document.getElementById("order-ticker") as HTMLInputElement).value = "";
  (document.getElementById("order-notes") as HTMLInputElement).value = "";
  loadOrders();
}

async function stageOrder(orderId) {
  const res = await fetch(`/api/orders/${orderId}/submit`, { method: "POST" });
  const data = await res.json();
  if (data._message) {
    // Show the pending-broker message
    const panel = document.getElementById("orders-status-msg");
    if (panel) { panel.textContent = data._message; panel.hidden = false; }
  }
  loadOrders();
}

async function deleteOrder(orderId) {
  if (!confirm("Delete this order?")) return;
  await fetch(`/api/orders/${orderId}`, { method: "DELETE" });
  loadOrders();
}

// ─── Evaluate rules on every fetch ────────────────────────────────────────────
// Hook into the global fetchedAt change — poll rules after market data updates.
let _lastEvaluated = null;
setInterval(() => {
  if (state.fetchedAt && state.fetchedAt !== _lastEvaluated) {
    _lastEvaluated = state.fetchedAt;
    evaluateAlertRules();
  }
}, 5000);
