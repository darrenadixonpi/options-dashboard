// @ts-nocheck — pilot: transpiled by esbuild; strict checks deferred (DOM types pass 2).
/// <reference path="./types.ts" />

function rehydratePositions(positions: PositionRow[] | null | undefined): PositionRow[] {
  return (positions || []).map(p => ({
    ...p,
    expiry: p.expiry ? new Date(p.expiry) : null,
  }));
}

function rehydratePortfolio(portfolio) {
  if (!portfolio?.groups) return portfolio;
  return {
    ...portfolio,
    groups: portfolio.groups.map(g => ({
      ...g,
      expiry: g.expiry ? new Date(g.expiry) : null,
      tickers: (g.tickers || []).map(t => ({
        ...t,
        strikes: (t.strikes || []).map(s => ({
          ...s,
          expiry: s.expiry ? new Date(s.expiry) : (g.expiry ? new Date(g.expiry) : null),
        })),
      })),
    })),
  };
}

async function fetchJson(url: string, options?: RequestInit): Promise<FetchJsonResult> {
  const res = await fetch(url, options);
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, data: JSON.parse(text) };
  } catch {
    const snippet = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
    return { ok: false, status: res.status, data: { error: `Server returned non-JSON (${res.status}): ${snippet || "empty response"}` } };
  }
}

function openImportDrawer() {
  document.getElementById("import-drawer").hidden = false;
}
function closeImportDrawer() {
  document.getElementById("import-drawer").hidden = true;
}

function positionPayload(p) {
  return {
    ticker: p.ticker, expiry: p.expiry ? dateKey(p.expiry instanceof Date ? p.expiry : new Date(p.expiry)) : null,
    strike: p.strike, optType: p.optType, contracts: p.contracts,
    shares: p.shares || 0, posType: p.posType || "option",
    avgCost: p.avgCost || 0, adjCost: p.adjCost || null,
  };
}

function getMergedPositions() {
  return [...state.positions.map(positionPayload), ...(state.hypothetical || []).map(positionPayload)];
}

function buildMarketSnapshot(marketData, greeks) {
  const prices = {}, ivs = {}, greekMap = {};
  if (marketData) {
    for (const [tkr, md] of Object.entries(marketData)) {
      if (md?.price != null) prices[tkr] = md.price;
      if (md?.iv != null) ivs[tkr] = md.iv;
    }
  }
  if (greeks?.byTicker) {
    for (const [tkr, g] of Object.entries(greeks.byTicker)) greekMap[tkr] = g;
  }
  return { prices, ivs, greeks: greekMap, at: new Date().toISOString() };
}

async function fetchPnlAttribution(prevSnap) {
  if (!prevSnap || !state.marketData) return;
  const current = buildMarketSnapshot(state.marketData, null);
  const { ok, data } = await fetchJson("/api/pnl-attribution", {
    method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      positions: state.positions.map(positionPayload),
      prev: prevSnap,
      current,
    }),
  });
  if (ok && !data.error) {
    state.attribution = data;
    renderAttribution(data, prevSnap.at);
    persistAttributionSnapshot();
  }
}

function renderAttribution(data, prevAt) {
  const sec = document.getElementById("attribution-section");
  if (!data?.portfolio || !sec) return;
  sec.hidden = false;
  document.getElementById("attribution-asof").textContent =
    prevAt ? `vs ${new Date(prevAt).toLocaleString()}` : "";
  const p = data.portfolio;
  destroyChart("chart-attribution");
  chartInstances["chart-attribution"] = new Chart(document.getElementById("chart-attribution"), {
    type: "bar",
    data: {
      labels: ["Δ (price)", "Γ", "Θ", "V (IV)", "Total est."],
      datasets: [{
        data: [p.pricePnl, p.gammaPnl, p.thetaPnl, p.vegaPnl, p.total],
        backgroundColor: ["#90caf9","#ce93d8","#f5c518","#a5d6a7","#ffb74d"],
      }],
    },
    options: deepMergeChartOpts(chartInteractionDefaults({ crosshair: false }), {
      responsive: true, animation: false, plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#9b9b96", font: { size: 9 } }, grid: { display: false } },
        y: { ticks: { callback: v => fmtDollar(v), color: "#9b9b96", font: { size: 9 } }, grid: { color: "rgba(255,255,255,0.05)" } },
      },
    }),
  });
  let rows = "";
  for (const [tkr, a] of Object.entries(data.byTicker || {}).sort((x, y) => Math.abs(y[1].total) - Math.abs(x[1].total))) {
    rows += `<tr><td>${tkr}</td><td class="r">${fmtDollar(a.pricePnl)}</td><td class="r">${fmtDollar(a.thetaPnl)}</td><td class="r">${fmtDollar(a.vegaPnl)}</td><td class="r" style="font-weight:500">${fmtDollar(a.total)}</td></tr>`;
  }
  document.getElementById("attribution-table").innerHTML = rows
    ? `<table class="hist-tbl"><tr><th>Ticker</th><th class="r">Price</th><th class="r">Θ</th><th class="r">V</th><th class="r">Total</th></tr>${rows}</table>`
    : "";
}

async function refreshOptionMarks() {
  if (!state.positions.length) return;
  const btn = document.getElementById("btn-refresh-marks");
  if (btn) { btn.disabled = true; btn.textContent = "Refreshing…"; }
  const shortLegs = state.positions.filter(p => p.posType !== "equity" && p.contracts < 0 && p.expiry);
  try {
    if (shortLegs.length) {
      const { data } = await fetchJson("/api/option-marks", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({ positions: shortLegs.map(positionPayload) }),
      });
      state.optionMarks = data.marks || {};
      state.marksNote = data.note;
      state.marksFetchedAt = data.fetchedAt || new Date().toISOString();
    }
    if (state.portfolio) renderPortfolio(state.portfolio, !!state.marketData);
    updateMarksStaleLabel();
    updateProvenanceBar();
    await fetchGreeksLight();
    if (state.portfolio) renderPositionsRail();
    saveSession();
    refreshDeskAlerts();
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Refresh option marks"; }
  }
}

async function fetchGreeksLight() {
  if (!state.positions.length || !state.marketData) return false;
  try {
    const { ok, data } = await fetchJson("/api/greeks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        positions: state.positions.map(positionPayload),
        marketData: state.marketData,
      }),
    });
    if (ok && data && !data.error) {
      state.greeks = data;
      return true;
    }
  } catch (e) {
    console.warn("Greeks refresh failed:", e);
  }
  return false;
}

/** Lightweight desk refresh: spot + IV + marks + greeks — no attribution snapshots or full fetch log. */
async function refreshLiveDesk() {
  if (!state.positions.length || !state.marketData || document.hidden) return;
  const tickers = [...new Set(state.positions.map(p => p.ticker))].sort();
  try {
    const { ok, data } = await fetchJson("/api/market-data", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ tickers }),
    });
    if (ok && data && !data.error) {
      state.marketData = data;
      state.fetchedAt = new Date().toISOString();
      state.portfolio = buildPortfolio([...state.positions.map(p => ({ ...p }))], state.fills, state.marketData);
    }
    const shortLegs = state.positions.filter(p => p.posType !== "equity" && p.contracts < 0 && p.expiry);
    if (shortLegs.length) {
      const marksRes = await fetchJson("/api/option-marks", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({ positions: shortLegs.map(positionPayload) }),
      });
      if (marksRes.ok) {
        state.optionMarks = marksRes.data.marks || {};
        state.marksNote = marksRes.data.note;
        state.marksFetchedAt = marksRes.data.fetchedAt || new Date().toISOString();
      }
    }
    await fetchGreeksLight();
    if (state.portfolio) renderPortfolio(state.portfolio, true);
    updateMarksStaleLabel();
    updateProvenanceBar();
    if (state.portfolio) renderPositionsRail();
    refreshDeskAlerts();
    saveSession();
  } catch (e) { console.warn("Auto-refresh failed:", e); }
}

function stopAutoRefresh() {
  if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
}

function startAutoRefresh() {
  stopAutoRefresh();
  if (!state.autoRefresh?.enabled) return;
  const ms = (state.autoRefresh.intervalMin || 10) * 60 * 1000;
  autoRefreshTimer = setInterval(() => refreshLiveDesk(), ms);
}

function syncAutoRefreshUI() {
  const cb = document.getElementById("auto-refresh-marks");
  const sel = document.getElementById("auto-refresh-interval");
  if (cb) cb.checked = !!state.autoRefresh?.enabled;
  if (sel && state.autoRefresh?.intervalMin) sel.value = String(state.autoRefresh.intervalMin);
  startAutoRefresh();
}

function setupAutoRefreshControls() {
  const cb = document.getElementById("auto-refresh-marks");
  const sel = document.getElementById("auto-refresh-interval");
  if (!cb || cb.dataset.wired) return;
  cb.dataset.wired = "1";
  cb.addEventListener("change", () => {
    state.autoRefresh = state.autoRefresh || { enabled: false, intervalMin: 10 };
    state.autoRefresh.enabled = cb.checked;
    saveSession();
    startAutoRefresh();
  });
  sel?.addEventListener("change", () => {
    state.autoRefresh = state.autoRefresh || { enabled: cb.checked, intervalMin: 10 };
    state.autoRefresh.intervalMin = parseInt(sel.value, 10) || 10;
    saveSession();
    if (state.autoRefresh.enabled) startAutoRefresh();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopAutoRefresh();
    else if (state.autoRefresh?.enabled) startAutoRefresh();
  });
  syncAutoRefreshUI();
}

function updateMarksStaleLabel() {
  const el = document.getElementById("marks-stale-label");
  const toolbar = document.getElementById("marks-toolbar");
  if (!el || !toolbar) return;
  toolbar.hidden = !state.marketData;
  if (!state.marksFetchedAt) { el.textContent = "Marks not loaded"; el.style.color = "var(--warn-tx)"; return; }
  const ageMin = (Date.now() - new Date(state.marksFetchedAt).getTime()) / 60000;
  el.textContent = `Marks as-of ${new Date(state.marksFetchedAt).toLocaleTimeString()} (${ageMin < 1 ? "<1" : Math.round(ageMin)}m ago)`;
  el.style.color = ageMin > 15 ? "var(--warn-tx)" : "var(--tx3)";
}

function populateWhatIfTickers() {
  const dl = document.getElementById("wi-ticker-list");
  if (!dl) return;
  const tickers = [...new Set(state.positions.map(p => p.ticker))].sort();
  dl.innerHTML = tickers.map(t => `<option value="${t}">`).join("");
}

async function loadWhatIfExpiries(ticker) {
  const sel = document.getElementById("wi-expiry");
  const strikeSel = document.getElementById("wi-strike");
  if (!sel) return;
  sel.innerHTML = '<option value="">Loading…</option>';
  if (strikeSel) strikeSel.innerHTML = '<option value="">Strike…</option>';
  if (!ticker) { sel.innerHTML = '<option value="">Expiry…</option>'; return; }
  const { data } = await fetchJson(`/api/option-expiries/${ticker}`);
  state.wiChainCache[ticker] = data.expiries || [];
  if (data.expiries?.length) {
    sel.innerHTML = '<option value="">Select expiry</option>' + data.expiries.map(e =>
      `<option value="${e.expiry}">${e.expiry} (${e.dte}d)</option>`
    ).join("");
  } else {
    sel.innerHTML = `<option value="">${data.error || "No expiries"}</option>`;
  }
}

async function loadWhatIfStrikes(ticker, expiry, optType) {
  const strikeSel = document.getElementById("wi-strike");
  if (!strikeSel || !ticker || !expiry) return;
  strikeSel.innerHTML = '<option value="">Loading…</option>';
  const { data } = await fetchJson(`/api/option-strikes/${ticker}/${expiry}`);
  const rows = (data.strikes || []).filter(s => s.optType === optType);
  state.wiStrikeRows = rows;
  if (rows.length) {
    strikeSel.innerHTML = rows.map(s =>
      `<option value="${s.strike}" data-mid="${s.mid}">${s.strike} (mid $${s.mid})</option>`
    ).join("");
    applyWhatIfStrikeMid();
  } else {
    strikeSel.innerHTML = `<option value="">${data.error || "No strikes"}</option>`;
  }
}

function applyWhatIfStrikeMid() {
  const strikeSel = document.getElementById("wi-strike");
  const costIn = document.getElementById("wi-cost");
  if (!strikeSel || !costIn) return;
  const opt = strikeSel.selectedOptions[0];
  const mid = opt?.dataset?.mid;
  if (mid != null && mid !== "") {
    costIn.value = mid;
    costIn.placeholder = `Mid $${mid}`;
  }
}

function beginEditWhatIfLeg(i) {
  const h = state.hypothetical[i];
  if (!h) return;
  state.whatifEditIndex = i;
  document.getElementById("wi-ticker").value = h.ticker;
  document.getElementById("wi-type").value = h.optType || "Put";
  document.getElementById("wi-contracts").value = h.contracts;
  document.getElementById("wi-cost").value = h.avgCost || "";
  document.getElementById("btn-whatif-add").textContent = "Update leg";
  document.getElementById("btn-whatif-cancel-edit").hidden = false;
  loadWhatIfExpiries(h.ticker).then(() => {
    document.getElementById("wi-expiry").value = h.expiry;
    return loadWhatIfStrikes(h.ticker, h.expiry, h.optType);
  }).then(() => {
    document.getElementById("wi-strike").value = String(h.strike);
  });
  renderWhatIfList();
}

function cancelWhatIfEdit() {
  state.whatifEditIndex = null;
  document.getElementById("btn-whatif-add").textContent = "Add leg";
  document.getElementById("btn-whatif-cancel-edit").hidden = true;
  ["wi-ticker", "wi-expiry", "wi-strike", "wi-cost"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  document.getElementById("wi-contracts").value = "-1";
  document.getElementById("wi-expiry").innerHTML = '<option value="">Expiry…</option>';
  document.getElementById("wi-strike").innerHTML = '<option value="">Strike…</option>';
  renderWhatIfList();
}

function renderWhatIfList() {
  const list = document.getElementById("whatif-list");
  if (!list) return;
  if (!state.hypothetical.length) {
    list.innerHTML = '<span style="color:var(--tx3);font-size:11px">No hypothetical legs — click a leg to edit</span>';
    document.getElementById("whatif-greeks-summary").hidden = true;
    return;
  }
  list.innerHTML = state.hypothetical.map((h, i) =>
    `<span class="whatif-tag${state.whatifEditIndex === i ? " editing" : ""}" data-wi-edit="${i}" title="Click to edit">${h.ticker} ${h.optType} $${h.strike} ${h.expiry} ${h.contracts > 0 ? "+" : ""}${h.contracts}c <button type="button" style="border:none;background:none;color:var(--err-tx);cursor:pointer;padding:0 4px" data-wi-rm="${i}" title="Remove">✕</button></span>`
  ).join("");
  list.querySelectorAll("[data-wi-edit]").forEach(tag => {
    tag.addEventListener("click", (e) => {
      if (e.target.closest("[data-wi-rm]")) return;
      beginEditWhatIfLeg(parseInt(tag.dataset.wiEdit, 10));
    });
  });
  list.querySelectorAll("[data-wi-rm]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.wiRm, 10);
      if (state.whatifEditIndex === idx) cancelWhatIfEdit();
      state.hypothetical.splice(idx, 1);
      renderWhatIfList();
      applyWhatIfGreeks();
      state.riskMatrixLoaded = false;
    });
  });
  if (typeof renderRiskExpiryCheckpoints === "function") renderRiskExpiryCheckpoints();
}

async function applyWhatIfGreeks() {
  if (!state.marketData) return;
  const el = document.getElementById("whatif-greeks-summary");
  if (!state.hypothetical.length) { el.hidden = true; return; }
  const { ok, data } = await fetchJson("/api/what-if-greeks", {
    method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      positions: state.positions.map(positionPayload),
      hypothetical: state.hypothetical.map(positionPayload),
      marketData: state.marketData,
    }),
  });
  if (!ok || data.error) return;
  el.hidden = false;
  const g = data.portfolio;
  const deltaCh = (g.delta - (state.greeks?.portfolio?.delta || 0)).toFixed(0);
  el.innerHTML = `
    <div class="stat" style="border-left:3px solid #90caf9"><div class="stat-label">What-if Δ (book+hypo)</div><div class="stat-val" style="font-size:16px;color:#90caf9">${g.delta.toFixed(0)} <span style="font-size:11px;color:var(--tx3)">(${deltaCh >= 0 ? "+" : ""}${deltaCh})</span></div></div>
    <div class="stat" style="border-left:3px solid #f5c518"><div class="stat-label">What-if Θ</div><div class="stat-val" style="font-size:16px;color:#f5c518">$${g.theta.toFixed(0)}</div></div>
    <div class="stat" style="border-left:3px solid #a5d6a7"><div class="stat-label">What-if V</div><div class="stat-val" style="font-size:16px;color:#a5d6a7">$${g.vega.toFixed(0)}</div></div>`;
}

function updateFetchButtonState() {
  const btn = document.getElementById("btn-fetch");
  if (!btn) return;
  const canFetch = !!(state.rawPosTexts && state.rawPosTexts.length);
  btn.disabled = !canFetch;
  btn.style.cursor = canFetch ? "pointer" : "not-allowed";
  btn.style.opacity = canFetch ? "1" : "0.55";
  if (canFetch && !state.rawHistTexts?.length) {
    btn.querySelector("span:last-child").textContent = "Fetch live prices + IV (positions only)";
  } else if (canFetch) {
    btn.querySelector("span:last-child").textContent = "Fetch live prices + IV";
  }
}

function setFetchButtonLoading(loading) {
  const btn = document.getElementById("btn-fetch");
  if (!btn) return;
  btn.classList.toggle("fetch-busy", !!loading);
  if (loading) {
    btn.setAttribute("aria-busy", "true");
  } else {
    btn.removeAttribute("aria-busy");
    updateFetchButtonState();
    if (state.marketData) btn.classList.add("btn-refetch");
  }
}

function saveSession() {
  const brokerBtn = document.querySelector(".broker-btn.active");
  let simForSave = state.simResult;
  if (simForSave?.portfolio_pnl) {
    simForSave = { ...simForSave };
    delete simForSave.portfolio_pnl;
  }
  const payload = {
    rawPosTexts: state.rawPosTexts,
    rawHistTexts: state.rawHistTexts || null,
    broker: brokerBtn?.dataset.broker || "fidelity",
    savedAt: new Date().toISOString(),
    fetchedAt: state.fetchedAt,
    marketData: state.marketData,
    positions: state.positions,
    portfolio: state.portfolio,
    greeks: state.greeks,
    events: state.events,
    tradeHistory: state.tradeHistory,
    optionMarks: state.optionMarks,
    format: state.format,
    fillsCount: state.fills?.length || 0,
    simDone: state.simDone,
    simResult: simForSave,
    simMeta: state.simMeta,
    riskMatrixLoaded: state.riskMatrixLoaded,
    prevSnapshot: state.prevSnapshot,
    attribution: state.attribution,
    hypothetical: state.hypothetical,
    marksFetchedAt: state.marksFetchedAt,
    alertThresholds: state.alertThresholds,
    dismissedAlertKeys: state.dismissedAlertKeys,
    alertNotifyOnFetch: state.alertNotifyOnFetch,
    simCollapseState: state.simCollapseState,
    simFocusTicker: state.simFocusTicker,
    simScrollY: state.simScrollY,
    simPProfitView: state.simPProfitView || "book",
    autoRefresh: state.autoRefresh,
    journalShowAssignmentLegs: state.journalShowAssignmentLegs,
  };
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn("Session save failed (retrying without sim charts):", e);
    try {
      const lite = { ...payload, simResult: null, simNeedsRerun: state.simDone };
      localStorage.setItem(SESSION_KEY, JSON.stringify(lite));
    } catch (e2) { console.warn("Session save failed:", e2); }
  }
}

function restoreSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data.rawPosTexts?.length) return;
    state.rawPosTexts = data.rawPosTexts;
    state.rawHistTexts = data.rawHistTexts || null;
    state.fetchedAt = data.fetchedAt || null;
    state.marketData = data.marketData || null;
    state.positions = rehydratePositions(data.positions);
    state.portfolio = rehydratePortfolio(data.portfolio);
    state.greeks = data.greeks || null;
    state.events = data.events || null;
    state.tradeHistory = data.tradeHistory || null;
    state.optionMarks = data.optionMarks || null;
    state.format = data.format || "";
    state.simDone = !!data.simDone;
    state.simResult = data.simResult || null;
    state.simMeta = data.simMeta || null;
    state.riskMatrixLoaded = false;
    state.prevSnapshot = data.prevSnapshot || null;
    state.attribution = data.attribution || null;
    state.hypothetical = data.hypothetical || [];
    state.marksFetchedAt = data.marksFetchedAt || null;
    state.alertThresholds = { ...(typeof DEFAULT_ALERT_THRESHOLDS !== "undefined" ? DEFAULT_ALERT_THRESHOLDS : {}), ...(data.alertThresholds || {}) };
    state.dismissedAlertKeys = data.dismissedAlertKeys || [];
    state.alertNotifyOnFetch = !!data.alertNotifyOnFetch;
    state.simCollapseState = data.simCollapseState || {};
    state.simFocusTicker = data.simFocusTicker || null;
    state.simScrollY = data.simScrollY || 0;
    state.simPProfitView = data.simPProfitView || "book";
    state.autoRefresh = data.autoRefresh || { enabled: false, intervalMin: 10 };
    state.journalShowAssignmentLegs = !!data.journalShowAssignmentLegs;
    if (data.broker) {
      document.querySelectorAll(".broker-btn").forEach(b => {
        b.classList.toggle("active", b.dataset.broker === data.broker);
      });
      document.querySelectorAll("[id^='instr-']").forEach(el => el.hidden = true);
      const instr = document.getElementById(`instr-${data.broker}`);
      if (instr) instr.hidden = false;
      updateDropZoneHints(data.broker);
    }
    const posDz = document.getElementById("dz-positions");
    posDz.classList.add("has-file");
    posDz.querySelector(".drop-hint").textContent = `${data.rawPosTexts.length} file(s) restored`;
    posDz.querySelector(".drop-icon").textContent = "✓";
    if (data.rawHistTexts?.length) {
      const histDz = document.getElementById("dz-history");
      histDz.classList.add("has-file");
      histDz.querySelector(".drop-hint").textContent = `${data.rawHistTexts.length} file(s) restored`;
      histDz.querySelector(".drop-icon").textContent = "✓";
    }
    updateFetchButtonState();
    const banner = document.getElementById("session-restore-banner");
    if (banner) {
      banner.hidden = false;
      const when = data.savedAt ? new Date(data.savedAt).toLocaleString() : "previous session";
      document.getElementById("session-restore-text").textContent =
        `Restored import from ${when}${data.fetchedAt ? " · live data cached" : ""}`;
    }
    if (state.portfolio && state.marketData) {
      renderPortfolio(state.portfolio, true);
      updateProvenanceBar();
      enableSimButton();
      enableRiskTab();
      document.getElementById("ready-banner").hidden = false;
      document.getElementById("ready-text").textContent = state.fetchedAt ? "Dashboard restored (cached data)" : "CSV restored — click Fetch to refresh prices";
      document.getElementById("ready-sub").textContent = `${state.portfolio.totalPositions} positions · ${state.portfolio.uniqueTickers} tickers`;
      if (state.tradeHistory) renderTradeHistory(state.tradeHistory);
      if (state.attribution) renderAttribution(state.attribution, state.prevSnapshot?.at);
      populateWhatIfTickers();
      renderWhatIfList();
      if (state.hypothetical.length) applyWhatIfGreeks();
      updateMarksStaleLabel();
      setupAutoRefreshControls();
      if (state.simResult && state.simDone) {
        renderSimResults(state.simResult);
      } else if (data.simNeedsRerun && state.positions.length) {
        const simBtn = document.getElementById("btn-simulate");
        const logEl = document.getElementById("sim-log") || document.getElementById("sim-log-inline");
        if (simBtn && logEl) {
          logEl.textContent = "Re-running saved simulation…";
          runSimulation(simBtn, logEl);
        }
      }
    }
  } catch (e) { console.warn("Session restore failed:", e); }
}

function updateProvenanceBar() {
  const el = document.getElementById("provenance-bar");
  if (!el) return;
  if (!state.marketData || !state.fetchedAt) { el.hidden = true; return; }
  const when = new Date(state.fetchedAt).toLocaleString();
  const ivNote = Object.values(state.marketData).some(m => m?.iv_source === "hv_estimate")
    ? "IV: front-expiry median where available; HV20 estimate when no chain"
    : "IV: median of nearest listed expiry chain (Yahoo)";
  const marksNote = state.optionMarks
    ? "Option marks: Yahoo bid/ask mid"
    : "Option marks: not loaded";
  const simNote = state.simMeta
    ? ` · Sim: ${state.simMeta.n_paths?.toLocaleString()} paths, ${state.simMeta.correlated ? "correlated" : "independent"}`
    : "";
  el.hidden = false;
  const histNote = state.rawHistTexts?.length
    ? "History: loaded"
    : "History: not loaded — P&L/BE/fills incomplete";
  el.innerHTML = `<strong>As-of</strong> ${when} · <strong>Greeks</strong> Black-Scholes, r=4.3%, per-position IV · <strong>${ivNote}</strong> · <strong>${marksNote}</strong>${simNote} · <strong>${histNote}</strong> · Risk matrix = theoretical BS vs entry cost, not broker MTM`;
}

function optionMarkKey(ticker, expiry, optType, strike) {
  const exp = typeof expiry === "string" ? expiry.split("T")[0] : dateKey(expiry instanceof Date ? expiry : new Date(expiry));
  const ot = (optType || "Put").toLowerCase().startsWith("p") ? "P" : "C";
  return `${ticker.toUpperCase()}|${exp}|${ot}|${parseFloat(strike)}`;
}

// Broker selector
document.querySelectorAll(".broker-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".broker-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const broker = btn.dataset.broker;
    document.querySelectorAll("[id^='instr-']").forEach(el => el.hidden = true);
    const instrEl = document.getElementById(`instr-${broker}`);
    if (instrEl) instrEl.hidden = false;
    updateDropZoneHints(broker);
  });
});

// View toggle (ticker vs expiry)
document.querySelectorAll(".view-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".view-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    state.viewMode = btn.dataset.view;
    if (state.portfolio) renderPortfolio(state.portfolio, !!state.marketData);
  });
});

// File drop zones
function setupDropZone(id, stateKey) {
  const dz = document.getElementById(id);
  const inp = dz.querySelector("input");
  dz.addEventListener("click", () => inp.click());
  dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("drag-over"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag-over"));
  dz.addEventListener("drop", e => { e.preventDefault(); dz.classList.remove("drag-over"); loadFiles(e.dataTransfer.files, dz, stateKey); });
  inp.addEventListener("change", () => { if (inp.files.length) loadFiles(inp.files, dz, stateKey); });
}

function loadFiles(fileList, dz, stateKey) {
  const files = [...fileList];
  const promises = files.map(f => f.text());
  Promise.all(promises).then(texts => {
    state[stateKey] = texts;
    dz.classList.add("has-file");
    const hint = dz.querySelector(".drop-hint");
    hint.textContent = files.length > 1 ? `${files.length} files loaded` : files[0].name;
    dz.querySelector(".drop-icon").textContent = "✓";
    // Show merge options if multiple files in either zone
    const totalFiles = (state.rawPosTexts?.length || 0) + (state.rawHistTexts?.length || 0);
    if (totalFiles > 2) {
      document.getElementById("merge-mode-section").hidden = false;
      state.multiFile = true;
    }
    updateFetchButtonState();
    saveSession();
  });
}

function getMergeMode() {
  const active = document.querySelector(".merge-btn.active");
  return active ? active.dataset.merge : "union";
}

function mergeCSVTexts(texts, mode) {
  if (!texts || texts.length <= 1) return texts?.[0] || "";
  if (mode === "add") return texts.join("\n");
  // Union: remove duplicate lines (keeping first occurrence), preserve header
  const allLines = [];
  let header = "";
  for (const txt of texts) {
    const lines = txt.replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n");
    if (!header && lines[0]) header = lines[0];
    for (let i = 0; i < lines.length; i++) {
      if (i === 0 && lines[i].toLowerCase().includes("account") || lines[i].toLowerCase().includes("symbol") || lines[i].toLowerCase().includes("run date") || lines[i].toLowerCase().includes("date")) continue;
      if (lines[i].trim()) allLines.push(lines[i]);
    }
  }
  const unique = [...new Set(allLines)];
  return header + "\n" + unique.join("\n");
}

// Merge button selector
document.querySelectorAll(".merge-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".merge-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
  });
});

function updateDropZoneHints(broker) {
  const hints = {
    fidelity: { pos: "Fidelity positions export", hist: "Fidelity account history" },
    schwab: { pos: "Schwab positions export", hist: "Schwab transaction history" },
    ibkr: { pos: "IBKR positions / portfolio", hist: "IBKR activity statement" },
  };
  const h = hints[broker] || hints.fidelity;
  const posDz = document.getElementById("dz-positions");
  const histDz = document.getElementById("dz-history");
  if (!posDz.classList.contains("has-file")) document.getElementById("dz-positions-hint").textContent = h.pos;
  if (!histDz.classList.contains("has-file")) document.getElementById("dz-history-hint").textContent = h.hist;
}

setupDropZone("dz-positions", "rawPosTexts");
setupDropZone("dz-history", "rawHistTexts");

// ─── Schwab API connect / sync (Phase 6) ─────────────────────────────────────

async function checkSchwabStatus() {
  const panel = document.getElementById("schwab-api-panel");
  if (!panel) return;

  const { ok, data } = await fetchJson("/api/schwab/status");
  if (!ok || !data) return;

  // Only show the API panel if the backend has credentials configured
  if (!data.configured) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  const badge = document.getElementById("schwab-status-badge");
  const connectSection = document.getElementById("schwab-connect-section");
  const syncSection = document.getElementById("schwab-sync-section");

  if (data.authenticated && !data.needs_reauth) {
    const ageStr = data.token_age_hours != null ? ` · token ${data.token_age_hours}h old` : "";
    if (badge) { badge.textContent = "Connected" + ageStr; badge.style.cssText = "font-size:10px;padding:2px 8px;border-radius:10px;background:#1a3a1a;color:#4caf50"; }
    if (connectSection) connectSection.hidden = true;
    if (syncSection) syncSection.hidden = false;
  } else if (data.needs_reauth) {
    if (badge) { badge.textContent = "Re-auth required"; badge.style.cssText = "font-size:10px;padding:2px 8px;border-radius:10px;background:#3a1a1a;color:#f44336"; }
    if (connectSection) connectSection.hidden = false;
    if (syncSection) syncSection.hidden = true;
    const statusEl = document.getElementById("schwab-sync-status");
    if (statusEl) statusEl.textContent = "Refresh token expired (7-day Schwab limit). Please reconnect.";
  } else {
    if (badge) { badge.textContent = "Not connected"; badge.style.cssText = "font-size:10px;padding:2px 8px;border-radius:10px;background:var(--bg3);color:var(--tx3)"; }
    if (connectSection) connectSection.hidden = false;
    if (syncSection) syncSection.hidden = true;
  }
}

async function schwabStartConnect() {
  const { ok, data } = await fetchJson("/api/schwab/auth/url");
  if (!ok || !data?.auth_url) {
    alert(data?.error || "Could not get auth URL. Check that SCHWAB_CLIENT_ID and SCHWAB_CLIENT_SECRET are set in .env.");
    return;
  }
  const link = document.getElementById("schwab-auth-link") as HTMLAnchorElement | null;
  if (link) link.href = data.auth_url;
  const callbackSection = document.getElementById("schwab-callback-section");
  if (callbackSection) callbackSection.hidden = false;
  // Open auth URL in new tab
  window.open(data.auth_url, "_blank");
}

async function schwabSubmitCallback() {
  const input = document.getElementById("schwab-callback-url") as HTMLInputElement | null;
  const errEl = document.getElementById("schwab-callback-error");
  const url = input?.value?.trim();
  if (!url) { if (errEl) { errEl.textContent = "Paste the full redirect URL first."; errEl.style.display = "block"; } return; }
  if (errEl) errEl.style.display = "none";

  const btn = document.getElementById("btn-schwab-submit-callback") as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  try {
    const { ok, data } = await fetchJson("/api/schwab/auth/callback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (!ok || data?.error) {
      if (errEl) { errEl.textContent = data?.error || "Authentication failed."; errEl.style.display = "block"; }
      return;
    }
    // Auth succeeded — refresh UI
    const callbackSection = document.getElementById("schwab-callback-section");
    if (callbackSection) callbackSection.hidden = true;
    if (input) input.value = "";
    await checkSchwabStatus();
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function schwabSync() {
  const btn = document.getElementById("btn-schwab-sync") as HTMLButtonElement | null;
  const statusEl = document.getElementById("schwab-sync-status");
  if (btn) { btn.disabled = true; btn.textContent = "Syncing…"; }
  if (statusEl) statusEl.textContent = "";

  try {
    const { ok, data } = await fetchJson("/api/schwab/sync", { method: "POST" });
    if (!ok || data?.error) {
      if (statusEl) statusEl.textContent = `Error: ${data?.error || "Sync failed"}`;
      if (data?.needs_reauth) await checkSchwabStatus();
      return;
    }
    const positions = data.positions || [];
    if (!positions.length) {
      if (statusEl) statusEl.textContent = "No positions returned from Schwab.";
      return;
    }

    // Load positions into state exactly as a CSV parse would
    state.positions = positions.map((p: any) => ({
      ...p,
      expiry: p.expiry ? new Date(p.expiry) : null,
    }));
    state.rawPosTexts = ["__schwab_api__"];  // sentinel so Fetch button enables
    state.format = "schwab_api";
    updateFetchButtonState();

    const dz = document.getElementById("dz-positions");
    if (dz) {
      dz.classList.add("has-file");
      const hint = dz.querySelector(".drop-hint");
      if (hint) hint.textContent = `${positions.length} positions from Schwab API`;
      const icon = dz.querySelector(".drop-icon");
      if (icon) icon.textContent = "✓";
    }

    const syncedAt = data.synced_at ? new Date(data.synced_at).toLocaleTimeString() : "";
    if (statusEl) statusEl.textContent = `✓ ${positions.length} positions synced at ${syncedAt}`;
    saveSession();
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "↻ Sync positions from Schwab"; }
  }
}

async function schwabDisconnect() {
  if (!confirm("Disconnect Schwab and delete local token?")) return;
  await fetchJson("/api/schwab/disconnect", { method: "POST" });
  await checkSchwabStatus();
}

// Wire Schwab panel buttons
document.getElementById("btn-schwab-connect")?.addEventListener("click", schwabStartConnect);
document.getElementById("btn-schwab-submit-callback")?.addEventListener("click", schwabSubmitCallback);
document.getElementById("btn-schwab-sync")?.addEventListener("click", schwabSync);
document.getElementById("btn-schwab-disconnect")?.addEventListener("click", schwabDisconnect);

// Show/hide Schwab API panel when Schwab broker is selected
document.querySelectorAll(".broker-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    if ((btn as HTMLElement).dataset.broker === "schwab") {
      checkSchwabStatus();
    }
  });
});

// Check on initial load if Schwab is already the active broker
if (document.querySelector(".broker-btn[data-broker='schwab'].active")) {
  checkSchwabStatus();
}

