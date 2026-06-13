// ═══════════════════════════════════════════════════════════════════════════
// App State + Wiring
// ═══════════════════════════════════════════════════════════════════════════

const SESSION_KEY = "optionsDashboard_session_v2";
const TAB_MAP = { positions: "tab-dashboard", risk: "tab-risk", simulate: "tab-simulate", journal: "tab-history", orders: "tab-orders" };
const DEFAULT_ALERT_THRESHOLDS = {
  dteHigh: 7, dteMedium: 21, ivRank: 75, exDivDays: 14,
  portfolioPProfit: 45, tickerPProfit: 35, marksStaleMin: 15,
  bookDeltaAbs: 500, bookVegaAbs: 2500, tickerDeltaAbs: 300, bookThetaBelow: -500,
};
/** @type {AppState} */
const state = { posText: null, histText: null, rawPosTexts: null, rawHistTexts: null, marketData: null, portfolio: null, positions: [], fills: [], format: "", simDone: false, simResult: null, multiFile: false, viewMode: "ticker", greeks: null, events: null, tradeHistory: null, prevSnapshot: null, fetchedAt: null, optionMarks: null, marksFetchedAt: null, marksNote: null, riskMatrixLoaded: false, simMeta: null, attribution: null, hypothetical: [], whatifEditIndex: null, wiChainCache: {}, lastRiskMatrix: null, deskAlerts: [], alertHistory: [], dismissedAlertKeys: [], alertThresholds: { ...DEFAULT_ALERT_THRESHOLDS }, alertNotifyOnFetch: false, lastAlertNotifyBatch: null, journalSort: { col: "closeDate", dir: "desc" }, journalFilter: "", journalStrategyFilter: "", journalDateFilter: "", journalShowAssignmentLegs: false, simCollapseState: {}, simFocusTicker: null, simScrollY: 0, simPProfitView: "book", autoRefresh: { enabled: false, intervalMin: 10 } };
let simNavObserver = null;
let autoRefreshTimer = null;
let chartInstances = {};
function destroyChart(id) { if (chartInstances[id]) { chartInstances[id].destroy(); delete chartInstances[id]; } }

function legKeyFromPos(ticker, expiry, strike, optType) {
  const exp = expiry instanceof Date ? dateKey(expiry) : (expiry || "na");
  return `${ticker}|${exp}|${strike}|${optType}`;
}

function jumpToLeg(legKey, tickerOnly) {
  switchToTab("positions");
  requestAnimationFrame(() => {
    let el = legKey ? document.querySelector(`[data-leg-id="${legKey}"]`) : null;
    if (!el && tickerOnly) el = document.querySelector(`.tk-block[data-ticker="${tickerOnly}"]`);
    if (el) {
      el.classList.add("leg-highlight");
      setTimeout(() => el.classList.remove("leg-highlight"), 2500);
      const sticky = document.getElementById("dashboard-sticky");
      const off = (sticky?.offsetHeight || 0) + 70;
      const y = el.getBoundingClientRect().top + window.scrollY - off;
      window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
    }
  });
}

function jumpToTickerContextual(tkr, legKey) {
  if (!tkr) return;
  const onSim = document.querySelector(".tab.active")?.dataset.tab === "simulate";
  if (onSim && state.simResult?.ticker_paths?.[tkr] && typeof jumpToSimTicker === "function") {
    jumpToSimTicker(tkr);
    return;
  }
  jumpToLeg(legKey || null, tkr);
}

function jumpToTickerFromPositions(tkr) {
  if (!tkr) return;
  if (state.simResult?.ticker_paths?.[tkr] && typeof jumpToSimTicker === "function") {
    jumpToSimTicker(tkr);
    return;
  }
  jumpToLeg(null, tkr);
}

function bestTickerMatch(q) {
  const tickers = [...new Set(state.positions.map(p => p.ticker))].sort();
  const qq = q.trim().toUpperCase();
  if (!qq) return tickers[0] || null;
  if (tickers.includes(qq)) return qq;
  const starts = tickers.filter(t => t.startsWith(qq));
  if (starts.length) return starts[0];
  const inc = tickers.filter(t => t.includes(qq));
  return inc[0] || null;
}

function confirmTickerSearch() {
  const inp = document.getElementById("ticker-search-input");
  const tkr = bestTickerMatch(inp?.value || "");
  if (!tkr) return;
  document.getElementById("ticker-search-overlay").hidden = true;
  jumpToTickerContextual(tkr);
}

function openTickerSearch() {
  const ov = document.getElementById("ticker-search-overlay");
  if (!ov) return;
  ov.hidden = false;
  const inp = document.getElementById("ticker-search-input");
  inp.value = "";
  inp.focus();
  renderTickerSearchResults("");
}

function renderTickerSearchResults(q) {
  const box = document.getElementById("ticker-search-results");
  if (!box) return;
  const tickers = [...new Set(state.positions.map(p => p.ticker))].sort();
  const qq = q.trim().toUpperCase();
  const matches = qq ? tickers.filter(t => t.includes(qq)) : tickers;
  const best = bestTickerMatch(q);
  if (!matches.length) { box.innerHTML = '<div style="color:var(--tx3);padding:8px">No match — try another symbol</div>'; return; }
  box.innerHTML = matches.map(t =>
    `<button type="button" class="rail-link" data-jump-ticker="${t}" style="width:100%;padding:8px;border:none;background:${t === best ? "var(--accent-bg)" : "transparent"};text-align:left;cursor:pointer;font-family:var(--mono);color:var(--tx)">${t}${t === best && qq ? " · Enter to go" : ""}</button>`
  ).join("");
  box.querySelectorAll("[data-jump-ticker]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.getElementById("ticker-search-overlay").hidden = true;
      jumpToTickerContextual(btn.dataset.jumpTicker);
    });
  });
}

function updateWideLayoutButton() {
  const btn = document.getElementById("btn-wide-layout");
  const wide = document.querySelector(".container")?.classList.contains("wide");
  if (btn) {
    btn.classList.toggle("active", !!wide);
    btn.textContent = wide ? "Wide ✓" : "Wide";
    btn.title = wide ? "Wide layout on (1380px) — click to use standard width" : "Use wide layout (1380px)";
  }
}

function refreshLayoutCharts() {
  requestAnimationFrame(() => {
    setTimeout(() => {
      const tab = document.querySelector(".tab.active")?.dataset.tab;
      if (tab === "simulate" && state.simResult) {
        renderSimResults(state.simResult);
      } else if (tab === "journal") {
        refreshCumulativePnlChart();
        if (typeof loadSnapshotHistoryUI === "function") loadSnapshotHistoryUI();
      } else if (tab === "positions" && state.attribution) {
        renderAttribution(state.attribution, state.prevSnapshot?.at);
      } else if (tab === "risk" && state._volSurfaceData) {
        _renderVolSurfaceChart();
      }
      Object.values(chartInstances).forEach(ch => {
        try { ch.resize(); } catch (e) { /* ignore */ }
      });
    }, 120);
  });
}

function goToRiskMatrix() {
  switchToTab("risk");
  const scrollToMatrix = () => {
    const el = document.getElementById("risk-matrix-container");
    if (el) {
      const y = el.getBoundingClientRect().top + window.scrollY - 64;
      window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
    }
  };
  if (state.marketData && !state.riskMatrixLoaded) {
    loadRiskMatrix().then(() => setTimeout(scrollToMatrix, 150));
  } else {
    requestAnimationFrame(() => setTimeout(scrollToMatrix, 80));
  }
}

function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime || "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function chartExportFilename(base) {
  const slug = String(base || "chart").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${slug}-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.png`;
}

function downloadBlobPng(dataUrl, filename) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  a.click();
}

function downloadCanvasPng(canvasId, filename) {
  const c = document.getElementById(canvasId);
  if (!c?.toDataURL) return false;
  if (c.width < 2 || c.height < 2) return false;
  try {
    downloadBlobPng(c.toDataURL("image/png"), filename || chartExportFilename(canvasId));
    return true;
  } catch {
    return false;
  }
}

function _pathChartWrapForCanvas(canvasId) {
  const tkr = canvasId.replace(/^path-/, "");
  return document.getElementById(`path-wrap-${tkr}`) || document.getElementById(canvasId)?.closest(".path-chart-wrap");
}

function _snapshotChartPng(canvasId, baseName) {
  const ch = chartInstances[canvasId];
  if (ch?.toBase64Image) {
    try {
      downloadBlobPng(ch.toBase64Image("image/png", 1), chartExportFilename(baseName || canvasId));
      return true;
    } catch { /* fall through */ }
  }
  return downloadCanvasPng(canvasId, chartExportFilename(baseName || canvasId));
}

function _exportChartWithLayout(canvasId, baseName) {
  const wrap = _pathChartWrapForCanvas(canvasId);
  const layout = document.getElementById("sim-path-layout");
  const wasCollapsed = wrap?.classList.contains("collapsed");
  const wasFocus = layout?.classList.contains("sim-focus-mode");
  const wasHidden = wrap && wasFocus && !wrap.classList.contains("sim-focused");
  if (wasCollapsed) wrap.classList.remove("collapsed");
  if (wasHidden && layout) {
    layout.classList.remove("sim-focus-mode");
    document.querySelectorAll(".path-chart-wrap").forEach(w => w.classList.remove("sim-focused"));
  }
  chartInstances[canvasId]?.resize?.();
  const ok = _snapshotChartPng(canvasId, baseName);
  if (wasCollapsed) wrap.classList.add("collapsed");
  if (wasHidden && layout) {
    layout.classList.add("sim-focus-mode");
    wrap?.classList.add("sim-focused");
  }
  chartInstances[canvasId]?.resize?.();
  return ok;
}

function exportChartCanvas(canvasId, baseName) {
  if (canvasId.startsWith("path-")) return _exportChartWithLayout(canvasId, baseName);
  return _snapshotChartPng(canvasId, baseName);
}

function exportAllSimPathCharts() {
  return (async () => {
    const wraps = [...document.querySelectorAll("#ticker-path-charts .path-chart-wrap")];
    const saved = wraps.map(w => ({
      el: w,
      collapsed: w.classList.contains("collapsed"),
      focused: w.classList.contains("sim-focused"),
    }));
    const layout = document.getElementById("sim-path-layout");
    const wasFocus = layout?.classList.contains("sim-focus-mode");

    wraps.forEach(w => w.classList.remove("collapsed", "sim-focused"));
    if (layout) layout.classList.remove("sim-focus-mode");

    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    const canvasIds = [...document.querySelectorAll("#ticker-path-charts canvas[id^='path-']")].map(c => c.id);
    canvasIds.forEach(id => chartInstances[id]?.resize?.());
    await new Promise(r => setTimeout(r, 80));

    let count = 0;
    for (const id of canvasIds) {
      const tkr = id.replace(/^path-/, "");
      if (_snapshotChartPng(id, `sim-path-${tkr}`)) count++;
      await new Promise(r => setTimeout(r, 350));
    }

    saved.forEach(({ el, collapsed, focused }) => {
      if (collapsed) el.classList.add("collapsed");
      if (focused) el.classList.add("sim-focused");
    });
    if (wasFocus && layout) layout.classList.add("sim-focus-mode");
    canvasIds.forEach(id => chartInstances[id]?.resize?.());

    if (count === 0) {
      alert("Could not export fan charts. Try expanding charts first, then retry.");
    }
    return count;
  })();
}

/** Inline export button for chart card headers (classic scripts — global HTML helper). */
function chartExportBtn(canvasId, baseName, label = "PNG") {
  const name = baseName || canvasId;
  return `<button type="button" class="btn btn-sm btn-ghost chart-export-btn" data-export-canvas="${canvasId}" data-export-name="${name}" title="Export PNG">${label}</button>`;
}

function exportHtmlTablePng(tableEl, baseName) {
  if (!tableEl?.rows?.length) return false;
  const canvas = document.createElement("canvas");
  const rows = tableEl.rows;
  const colCount = Math.max(...Array.from(rows, r => r.cells.length));
  const cellW = Math.min(96, Math.max(56, Math.floor(880 / Math.max(colCount, 1))));
  const w = Math.max(320, colCount * cellW + 24);
  const h = Math.max(120, rows.length * 28 + 36);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  const bg = getComputedStyle(document.body).getPropertyValue("--bg").trim() || "#161614";
  const fg = getComputedStyle(document.body).getPropertyValue("--tx").trim() || "#e8e8e4";
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  ctx.font = "11px JetBrains Mono, monospace";
  let y = 26;
  for (let r = 0; r < rows.length; r++) {
    let x = 12;
    for (let c = 0; c < rows[r].cells.length; c++) {
      const cell = rows[r].cells[c];
      const bgStyle = cell.style.background || cell.style.backgroundColor || "";
      if (bgStyle.includes("rgba") || bgStyle.includes("rgb")) {
        ctx.fillStyle = bgStyle.replace(/[\d.]+\)$/, "0.88)");
        ctx.fillRect(x - 4, y - 16, cellW - 4, 22);
        ctx.fillStyle = fg;
      }
      const text = (cell.textContent || "").trim();
      ctx.fillStyle = fg;
      ctx.fillText(text.slice(0, Math.ceil(cellW / 7)), x, y);
      x += cellW;
    }
    y += 26;
  }
  downloadBlobPng(canvas.toDataURL("image/png"), chartExportFilename(baseName || "table"));
  return true;
}

function exportElementAsTablePng(elementId, baseName) {
  const el = document.getElementById(elementId);
  if (!el) return false;
  const table = el.tagName === "TABLE" ? el : el.querySelector("table");
  if (!table) return false;
  return exportHtmlTablePng(table, baseName || elementId);
}

function initChartExportHandlers() {
  if (window.__chartExportInit) return;
  window.__chartExportInit = true;
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-export-canvas], [data-export-el], [data-export-all-paths]");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    if (btn.hasAttribute("data-export-all-paths")) {
      exportAllSimPathCharts();
      return;
    }
    const canvasId = btn.dataset.exportCanvas;
    const elId = btn.dataset.exportEl;
    const name = btn.dataset.exportName || canvasId || elId;
    if (canvasId) exportChartCanvas(canvasId, name);
    else if (elId) exportElementAsTablePng(elId, name);
  });
}

function exportRiskMatrixCsv() {
  const d = state.lastRiskMatrix;
  if (!d?.grid) return;
  let csv = "IV\\Price," + d.priceSteps.map(p => `${p}%`).join(",") + "\n";
  d.ivSteps.forEach((iv, i) => {
    csv += `${iv}pt,` + d.grid[i].join(",") + "\n";
  });
  downloadText(`risk-matrix-${new Date().toISOString().slice(0,10)}.csv`, csv, "text/csv");
}

function exportSimSummary() {
  if (!state.simResult) return;
  const s = state.simResult;
  const lines = [
    `Options Dashboard — Simulation Summary`,
    `Generated: ${new Date().toISOString()}`,
    `Paths: ${s.n_paths}`,
    `Portfolio P(profit): ${s.portfolio?.prob_profit}%`,
    `Mean P&L: ${s.portfolio?.mean}`,
    `Median P&L: ${s.portfolio?.median}`,
    ``,
    `By ticker:`,
  ];
  for (const [tkr, st] of Object.entries(s.by_ticker || {})) {
    lines.push(`  ${tkr}: P(profit) ${st.prob_profit}% · median ${st.median}`);
  }
  downloadText(`sim-summary-${new Date().toISOString().slice(0,10)}.txt`, lines.join("\n"));
}

function exportJournalCsv() {
  const trades = getFilteredJournalTrades();
  if (!trades.length) return;
  const hdr = "Ticker,Type,Strategy,Close Event,Open,Close,Days,Qty,PnL,Leg PnL,Roll Label,Assignment Combined,Linked,Warnings\n";
  const rows = trades.map(t => {
    const linked = t.linkedEquity
      ? `stock ${t.linkedEquity.qty}sh@${t.linkedEquity.date}`
      : t.linkedOption
        ? `opt ${t.linkedOption.optType} ${t.linkedOption.strike}`
        : "";
    return [
      t.ticker,
      t.instrument === "equity" ? "Stock" : t.optType,
      normalizeStrategyLabel(t.strategy),
      t.closeTypeLabel || t.closeType || "",
      t.openDate,
      t.closeDate,
      t.holdDays,
      t.qty,
      t.pnl,
      t.legPnl ?? t.optionLegPnl ?? "",
      t.rollLabel || "",
      t.combinedPnl ?? "",
      linked,
      (t.warnings || []).map(w => w.code).join(";"),
    ].map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",");
  }).join("\n");
  downloadText(`journal-${new Date().toISOString().slice(0,10)}.csv`, hdr + rows, "text/csv");
}

function journalVisibleTrades(trades) {
  return (trades || []).filter(t =>
    !t.journalSuppress && !t.journalSuppressStats && !t.isRollOpenRef
  );
}

function computeJournalRiskMetrics(dailySeries) {
  if (!dailySeries || dailySeries.length < 5) return null;
  const dayMap = Object.fromEntries(dailySeries.map(d => [d.date, d.dayPnl]));
  const dates = Object.keys(dayMap).sort();
  const start = new Date(dates[0] + "T12:00:00");
  const end = new Date(dates[dates.length - 1] + "T12:00:00");
  const pnls = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    pnls.push(dayMap[key] || 0);
  }
  if (pnls.length < 5) return null;
  const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const variance = pnls.reduce((s, x) => s + (x - mean) ** 2, 0) / (pnls.length - 1);
  const std = Math.sqrt(variance);
  const downside = pnls.filter(x => x < 0);
  const downVar = downside.length > 1
    ? downside.reduce((s, x) => s + x ** 2, 0) / (downside.length - 1)
    : 0;
  const downStd = Math.sqrt(downVar);
  const annual = Math.sqrt(252);
  return {
    sharpe: std > 1e-9 ? Math.round(mean / std * annual * 100) / 100 : null,
    sortino: downStd > 1e-9 ? Math.round(mean / downStd * annual * 100) / 100 : null,
    avgDailyPnl: Math.round(mean * 100) / 100,
    dailyPnlStd: Math.round(std * 100) / 100,
    riskDays: pnls.length,
    riskCloseDays: dailySeries.length,
  };
}

function journalTradePnl(t) {
  return t?.pnl ?? 0;
}

function journalGroupId(t) {
  return t?.strategyGroupId || `solo|${t.ticker}|${t.closeDate}|${t.symbol || ""}`;
}

/** Strategy-group stats; includes full spread P&L when any leg matches filter. */
function computeJournalStats(allTrades, matchedTrades) {
  const pool = journalVisibleTrades(allTrades);
  const matched = journalVisibleTrades(matchedTrades);
  if (!matched.length) return null;

  const activeGroups = new Set(matched.map(journalGroupId));
  const groups = new Map();
  for (const t of pool) {
    const gid = journalGroupId(t);
    if (!activeGroups.has(gid)) continue;
    if (!groups.has(gid)) groups.set(gid, { pnl: 0, legs: 0 });
    const g = groups.get(gid);
    g.pnl += journalTradePnl(t);
    g.legs += 1;
  }

  const legWins = matched.filter(t => t.isWin).length;
  const legLosses = matched.length - legWins;
  let groupWins = 0;
  let groupLosses = 0;
  let groupFlat = 0;
  const winPnls = [];
  const lossPnls = [];
  for (const g of groups.values()) {
    if (g.pnl > 0) { groupWins++; winPnls.push(g.pnl); }
    else if (g.pnl < 0) { groupLosses++; lossPnls.push(g.pnl); }
    else groupFlat++;
  }
  const groupTotal = groups.size;
  const totalPnl = [...groups.values()].reduce((s, g) => s + g.pnl, 0);
  const grossWins = winPnls.reduce((a, b) => a + b, 0);
  const grossLosses = Math.abs(lossPnls.reduce((a, b) => a + b, 0));

  return {
    totalTrades: matched.length,
    groupTrades: groupTotal,
    groupLegs: [...groups.values()].reduce((s, g) => s + g.legs, 0),
    optionTrades: matched.filter(t => t.instrument !== "equity").length,
    equityTrades: matched.filter(t => t.instrument === "equity").length,
    wins: legWins,
    losses: legLosses,
    winRate: groupTotal ? Math.round(groupWins / groupTotal * 1000) / 10 : 0,
    legWinRate: matched.length ? Math.round(legWins / matched.length * 1000) / 10 : 0,
    groupWins,
    groupLosses,
    groupBreakeven: groupFlat,
    totalPnl: Math.round(totalPnl * 100) / 100,
    avgWin: winPnls.length ? Math.round(winPnls.reduce((a, b) => a + b, 0) / winPnls.length * 100) / 100 : 0,
    avgLoss: lossPnls.length ? Math.round(lossPnls.reduce((a, b) => a + b, 0) / lossPnls.length * 100) / 100 : 0,
    profitFactor: grossLosses > 0 ? Math.round(grossWins / grossLosses * 100) / 100 : 999.99,
    expectancy: groupTotal ? Math.round(totalPnl / groupTotal * 100) / 100 : 0,
    legExpectancy: matched.length ? Math.round(matched.reduce((s, t) => s + journalTradePnl(t), 0) / matched.length * 100) / 100 : 0,
    avgHoldDays: Math.round(matched.reduce((s, t) => s + (t.holdDays || 0), 0) / matched.length * 10) / 10,
    filtered: true,
  };
}

function getJournalStatsForView() {
  const all = state.tradeHistory?.trades || [];
  const matched = getFilteredJournalTrades();
  const hasFilter = !!(state.journalFilter.trim() || state.journalStrategyFilter || state.journalDateFilter);
  if (!hasFilter && state.tradeHistory?.stats) {
    return { ...state.tradeHistory.stats, filtered: false };
  }
  const computed = computeJournalStats(all, matched);
  if (computed) {
    const activeGroups = new Set(matched.map(journalGroupId));
    const pool = journalVisibleTrades(all).filter(t => activeGroups.has(journalGroupId(t)));
    computed.risk = computeJournalRiskMetrics(buildJournalDailyPnlSeries(pool));
    return computed;
  }
  return state.tradeHistory?.stats || null;
}

function buildJournalDailyPnlSeries(trades) {
  const visible = journalVisibleTrades(trades);
  const byDate = {};
  const dayTrades = {};
  for (const t of visible) {
    const pnl = journalTradePnl(t);
    byDate[t.closeDate] = (byDate[t.closeDate] || 0) + pnl;
    (dayTrades[t.closeDate] ||= []).push(t);
  }
  let cum = 0;
  return Object.keys(byDate).sort().map(d => {
    cum += byDate[d];
    const rows = dayTrades[d] || [];
    const rollRows = rows.filter(t => t.isRoll);
    return {
      date: d,
      dayPnl: byDate[d],
      cumPnl: cum,
      tradeCount: rows.length,
      rollCount: rollRows.length,
      rollPnl: rollRows.reduce((s, t) => s + journalTradePnl(t), 0),
      rollNetPnl: rollRows.reduce((s, t) => s + (t.rollNetPnl ?? journalTradePnl(t)), 0),
      trades: rows,
    };
  });
}

/** Trades visible in strategy dropdown (ticker + optional chart day; excludes strategy filter). */
function getJournalTradesForStrategyFilter() {
  let trades = journalVisibleTrades(state.tradeHistory?.trades || []);
  const ft = state.journalFilter.trim().toUpperCase();
  const fd = state.journalDateFilter;
  if (ft) trades = trades.filter(t => t.ticker.includes(ft));
  if (fd) trades = trades.filter(t => t.closeDate === fd);
  return trades;
}

/** Trades driving cumulative P&L chart (ticker + strategy; excludes day filter). */
function getJournalTradesForChart() {
  let trades = journalVisibleTrades(state.tradeHistory?.trades || []);
  const ft = state.journalFilter.trim().toUpperCase();
  const fs = state.journalStrategyFilter;
  if (ft) trades = trades.filter(t => t.ticker.includes(ft));
  if (fs) trades = trades.filter(t => normalizeStrategyLabel(t.strategy) === fs);
  return trades;
}

function getFilteredJournalTrades() {
  let trades = state.tradeHistory?.trades || [];
  if (!state.journalShowAssignmentLegs) trades = trades.filter(t => !t.journalSuppress);
  const ft = state.journalFilter.trim().toUpperCase();
  const fs = state.journalStrategyFilter;
  const fd = state.journalDateFilter;
  if (ft) trades = trades.filter(t => t.ticker.includes(ft));
  if (fs) trades = trades.filter(t => normalizeStrategyLabel(t.strategy) === fs);
  if (fd) trades = trades.filter(t => t.closeDate === fd);
  const { col, dir } = state.journalSort;
  trades = [...trades].sort((a, b) => {
    let va = a[col], vb = b[col];
    if (col === "pnl" || col === "holdDays" || col === "qty") { va = +va; vb = +vb; }
    if (va < vb) return dir === "asc" ? -1 : 1;
    if (va > vb) return dir === "asc" ? 1 : -1;
    return 0;
  });
  return trades;
}

function findOpenLegKey(trade) {
  if (!trade.strike || !trade.expiry) return null;
  const match = state.positions.find(p =>
    p.ticker === trade.ticker && p.optType === trade.optType &&
    Math.abs((p.strike || 0) - trade.strike) < 0.01 &&
    p.expiry && dateKey(p.expiry) === trade.expiry
  );
  if (!match) return null;
  return legKeyFromPos(match.ticker, match.expiry, match.strike, match.optType);
}

async function loadMiniRiskMatrix() {
  if (state.lastRiskMatrix || !state.marketData || !state.positions.length) return;
  try {
    const { ok, data } = await fetchJson("/api/risk-matrix", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        positions: getMergedPositions(),
        marketData: state.marketData,
        priceSteps: [-10, -5, 0, 5, 10],
        ivSteps: [-10, 0, 10],
        daysForward: 0,
      }),
    });
    if (ok && data.grid) state.lastRiskMatrix = data;
  } catch (e) { /* optional */ }
  renderPositionsRail();
}

function renderMiniRiskHtml() {
  const d = state.lastRiskMatrix;
  if (!d?.grid?.length) {
    if (state.greeks?.risk) {
      const r = state.greeks.risk;
      return `<div style="font-size:11px;line-height:1.5">Max loss est. <strong style="color:var(--err-tx)">$${r.totalMaxLoss.toLocaleString()}</strong><br>Margin est. $${r.totalMargin.toLocaleString()}<br><span style="color:var(--tx3)">Load full matrix in Risk tab</span></div>`;
    }
    return '<span style="color:var(--tx3)">Fetch data for risk snapshot</span>';
  }
  const flat = [];
  d.grid.forEach((row, i) => row.forEach((v, j) => flat.push({ v, i, j, iv: d.ivSteps[i], px: d.priceSteps[j] })));
  flat.sort((a, b) => a.v - b.v);
  const worst = flat.slice(0, 3);
  const best = flat.slice(-3).reverse();
  let html = '<div style="font-size:10px;color:var(--tx3);margin-bottom:6px">Worst / best scenarios (BS est.)</div>';
  for (const x of worst) {
    html += `<div style="font-size:10px;color:var(--err-tx);font-family:var(--mono)">${x.px>0?"+":""}${x.px}% · ${x.iv>0?"+":""}${x.iv}IV → ${fmtDollar(x.v)}</div>`;
  }
  for (const x of best) {
    html += `<div style="font-size:10px;color:var(--ok-tx);font-family:var(--mono)">${x.px>0?"+":""}${x.px}% · ${x.iv>0?"+":""}${x.iv}IV → ${fmtDollar(x.v)}</div>`;
  }
  return html;
}

function renderExpiringRail() {
  const el = document.getElementById("rail-expiring-body");
  if (!el) return;
  const today = new Date();
  const legs = state.positions.filter(p => p.posType !== "equity" && p.expiry).map(p => {
    const exp = p.expiry instanceof Date ? p.expiry : new Date(p.expiry);
    const dte = Math.ceil((exp - today) / 86400000);
    return { ...p, dte, expKey: dateKey(exp) };
  }).filter(p => p.dte >= 0 && p.dte <= 7).sort((a, b) => a.dte - b.dte);
  if (!legs.length) { el.innerHTML = '<span style="color:var(--tx3)">Nothing expiring this week</span>'; return; }
  el.innerHTML = legs.map(p => {
    const lk = legKeyFromPos(p.ticker, p.expiry, p.strike, p.optType);
    return `<button type="button" class="rail-link" data-leg-jump="${lk}">${p.ticker} ${p.optType} $${p.strike} · ${p.dte}d</button>`;
  }).join("");
  el.querySelectorAll("[data-leg-jump]").forEach(btn => {
    btn.addEventListener("click", () => jumpToLeg(btn.dataset.legJump));
  });
}

function renderCatalystsRail() {
  const el = document.getElementById("rail-catalysts-body");
  if (!el) return;
  const today = new Date();
  const horizon = new Date(today.getTime() + 14 * 86400000);
  const items = [];
  for (const [tkr, evs] of Object.entries(state.events || {})) {
    for (const ev of evs) {
      const d = new Date(ev.date);
      if (d >= today && d <= horizon) items.push({ tkr, ...ev, d });
    }
  }
  items.sort((a, b) => a.d - b.d);
  if (!items.length) { el.innerHTML = '<span style="color:var(--tx3)">No earnings/catalysts in 14d</span>'; return; }
  el.innerHTML = items.slice(0, 12).map(ev =>
    `<button type="button" class="rail-link" data-jump-tkr="${ev.tkr}">${ev.d.toLocaleDateString("en-US",{month:"short",day:"numeric"})} · ${ev.tkr} · ${ev.label || ev.type}</button>`
  ).join("");
  el.querySelectorAll("[data-jump-tkr]").forEach(btn => {
    btn.addEventListener("click", () => jumpToLeg(null, btn.dataset.jumpTkr));
  });
}

function renderAlertsRail() {
  const el = document.getElementById("rail-alerts-body");
  const histEl = document.getElementById("rail-alerts-history");
  const cnt = document.getElementById("rail-alerts-count");
  if (!el) return;
  const alerts = state.deskAlerts || [];
  if (cnt) cnt.textContent = alerts.length ? `(${alerts.length})` : "";
  if (!alerts.length) {
    el.innerHTML = '<span style="color:var(--tx3)">No active alerts</span>';
  } else {
    el.innerHTML = alerts.slice(0, 10).map(a =>
      `<div class="alert-item sev-${a.severity}">
        <div class="alert-item-row">
          <span>${a.message}</span>
          <button type="button" class="alert-dismiss" data-alert-key="${esc(a.alertKey || "")}" title="Dismiss">×</button>
        </div>
        ${a.legKey ? `<button type="button" class="rail-link" data-leg-jump="${a.legKey}" style="margin-top:4px;font-size:10px">View leg →</button>` : ""}
      </div>`
    ).join("");
    el.querySelectorAll("[data-leg-jump]").forEach(btn => {
      btn.addEventListener("click", () => jumpToLeg(btn.dataset.legJump));
    });
    el.querySelectorAll(".alert-dismiss").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        dismissAlert(btn.dataset.alertKey);
      });
    });
  }
  renderAlertHistoryRail(histEl);
}

function renderAlertHistoryRail(el) {
  if (!el) return;
  const events = state.alertHistory || [];
  if (!events.length) {
    el.innerHTML = '<span style="color:var(--tx3);font-size:10px">No recent alert log</span>';
    return;
  }
  el.innerHTML = events.slice(0, 8).map(ev => {
    const when = ev.triggered_at ? new Date(ev.triggered_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
    return `<div class="alert-history-row sev-${ev.severity || "low"}"><span class="alert-history-ts">${when}</span><span>${esc(ev.message || "")}</span></div>`;
  }).join("");
}

async function loadAlertHistory() {
  try {
    const { ok, data } = await fetchJson("/api/alerts/history?limit=20");
    if (ok) state.alertHistory = data.events || [];
  } catch (e) {
    state.alertHistory = [];
  }
  renderAlertHistoryRail(document.getElementById("rail-alerts-history"));
}

async function maybeNotifyDeskAlerts(alerts, fromFetch) {
  if (!fromFetch || !state.alertNotifyOnFetch) return;
  if (!("Notification" in window)) return;
  const high = (alerts || []).filter(a => a.severity === "high");
  if (!high.length) return;
  if (Notification.permission === "default") {
    try { await Notification.requestPermission(); } catch (e) { return; }
  }
  if (Notification.permission !== "granted") return;
  const batchKey = high.map(a => a.alertKey).sort().join("|");
  if (state.lastAlertNotifyBatch === batchKey) return;
  state.lastAlertNotifyBatch = batchKey;
  try {
    new Notification(`Desk — ${high.length} high alert${high.length > 1 ? "s" : ""}`, {
      body: high.slice(0, 4).map(a => a.message).join(" · "),
      tag: "desk-alerts-high",
    });
  } catch (e) { /* optional */ }
}

function dismissAlert(alertKey) {
  if (!alertKey || state.dismissedAlertKeys.includes(alertKey)) return;
  state.dismissedAlertKeys.push(alertKey);
  state.deskAlerts = (state.deskAlerts || []).filter(a => a.alertKey !== alertKey);
  renderAlertsRail();
  saveSession();
}

function renderAlertThresholdFields() {
  const box = document.getElementById("rail-alerts-settings");
  if (!box) return;
  const t = state.alertThresholds || DEFAULT_ALERT_THRESHOLDS;
  box.innerHTML = `
    <div class="alert-threshold-grid">
      <label>DTE high ≤<input type="number" id="alert-th-dte-high" min="1" max="60" value="${t.dteHigh}"></label>
      <label>DTE med ≤<input type="number" id="alert-th-dte-med" min="1" max="90" value="${t.dteMedium}"></label>
      <label>IVR ≥<input type="number" id="alert-th-ivr" min="0" max="100" value="${t.ivRank}"></label>
      <label>Ex-div ≤d<input type="number" id="alert-th-exdiv" min="1" max="60" value="${t.exDivDays}"></label>
      <label>Book P(profit) &lt;<input type="number" id="alert-th-port-pp" min="0" max="100" value="${t.portfolioPProfit}"></label>
      <label>Ticker P(profit) &lt;<input type="number" id="alert-th-tkr-pp" min="0" max="100" value="${t.tickerPProfit}"></label>
      <label>Marks stale &gt;m<input type="number" id="alert-th-marks" min="1" max="240" value="${t.marksStaleMin}"></label>
      <label>|Book Δ| &gt;<input type="number" id="alert-th-book-delta" min="50" max="50000" step="50" value="${t.bookDeltaAbs ?? 500}"></label>
      <label>|Book V| &gt;<input type="number" id="alert-th-book-vega" min="100" max="50000" step="100" value="${t.bookVegaAbs ?? 2500}"></label>
      <label>|Ticker Δ| &gt;<input type="number" id="alert-th-tkr-delta" min="50" max="20000" step="50" value="${t.tickerDeltaAbs ?? 300}"></label>
      <label>Book Θ &lt; $/d<input type="number" id="alert-th-book-theta" min="-10000" max="0" step="50" value="${t.bookThetaBelow ?? -500}"></label>
    </div>
    <label style="display:flex;align-items:center;gap:6px;margin-top:8px;font-size:10px;color:var(--tx2);cursor:pointer">
      <input type="checkbox" id="alert-notify-fetch" ${state.alertNotifyOnFetch ? "checked" : ""}> Browser notify on fetch (high only)
    </label>
    <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
      <button type="button" class="btn btn-sm btn-ghost" id="btn-alert-th-save">Apply</button>
      <button type="button" class="btn btn-sm btn-ghost" id="btn-alert-dismiss-reset">Reset dismissals</button>
    </div>`;
  document.getElementById("btn-alert-th-save")?.addEventListener("click", saveAlertThresholds);
  document.getElementById("btn-alert-dismiss-reset")?.addEventListener("click", () => {
    state.dismissedAlertKeys = [];
    saveSession();
    refreshDeskAlerts();
  });
}

function saveAlertThresholds() {
  state.alertThresholds = {
    dteHigh: parseInt(document.getElementById("alert-th-dte-high")?.value, 10) || DEFAULT_ALERT_THRESHOLDS.dteHigh,
    dteMedium: parseInt(document.getElementById("alert-th-dte-med")?.value, 10) || DEFAULT_ALERT_THRESHOLDS.dteMedium,
    ivRank: parseFloat(document.getElementById("alert-th-ivr")?.value) || DEFAULT_ALERT_THRESHOLDS.ivRank,
    exDivDays: parseInt(document.getElementById("alert-th-exdiv")?.value, 10) || DEFAULT_ALERT_THRESHOLDS.exDivDays,
    portfolioPProfit: parseFloat(document.getElementById("alert-th-port-pp")?.value) || DEFAULT_ALERT_THRESHOLDS.portfolioPProfit,
    tickerPProfit: parseFloat(document.getElementById("alert-th-tkr-pp")?.value) || DEFAULT_ALERT_THRESHOLDS.tickerPProfit,
    marksStaleMin: parseFloat(document.getElementById("alert-th-marks")?.value) || DEFAULT_ALERT_THRESHOLDS.marksStaleMin,
    bookDeltaAbs: parseFloat(document.getElementById("alert-th-book-delta")?.value) || DEFAULT_ALERT_THRESHOLDS.bookDeltaAbs,
    bookVegaAbs: parseFloat(document.getElementById("alert-th-book-vega")?.value) || DEFAULT_ALERT_THRESHOLDS.bookVegaAbs,
    tickerDeltaAbs: parseFloat(document.getElementById("alert-th-tkr-delta")?.value) || DEFAULT_ALERT_THRESHOLDS.tickerDeltaAbs,
    bookThetaBelow: parseFloat(document.getElementById("alert-th-book-theta")?.value) || DEFAULT_ALERT_THRESHOLDS.bookThetaBelow,
  };
  state.alertNotifyOnFetch = !!document.getElementById("alert-notify-fetch")?.checked;
  saveSession();
  refreshDeskAlerts();
  document.getElementById("rail-alerts-settings").hidden = true;
}

function toggleAlertSettings() {
  const box = document.getElementById("rail-alerts-settings");
  if (!box) return;
  const show = box.hidden;
  if (show) renderAlertThresholdFields();
  box.hidden = !show;
}

function renderPositionsRail() {
  const rail = document.getElementById("positions-rail");
  if (!rail || !state.portfolio) { if (rail) rail.hidden = true; return; }
  rail.hidden = false;
  document.getElementById("rail-mini-risk-body").innerHTML = renderMiniRiskHtml();
  renderExpiringRail();
  renderCatalystsRail();
  renderAlertsRail();
}

async function refreshDeskAlerts(opts = {}) {
  if (!state.marketData || !state.positions.length) return;
  const fromFetch = opts.fromFetch || !!state.deskAlertFromFetch;
  if (state.deskAlertFromFetch) state.deskAlertFromFetch = false;
  try {
    const { data } = await fetchJson("/api/desk-alerts", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        positions: state.positions.map(positionPayload),
        marketData: state.marketData,
        greeks: state.greeks,
        simResult: state.simResult,
        marksFetchedAt: state.marksFetchedAt,
        thresholds: state.alertThresholds || DEFAULT_ALERT_THRESHOLDS,
        dismissedKeys: state.dismissedAlertKeys || [],
      }),
    });
    state.deskAlerts = data.alerts || [];
    await maybeNotifyDeskAlerts(state.deskAlerts, fromFetch);
    loadAlertHistory();
  } catch (e) { state.deskAlerts = []; }
  renderAlertsRail();
}

async function persistAttributionSnapshot() {
  if (!state.attribution) return;
  try {
    await fetch("/api/snapshots/attribution", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ timestamp: new Date().toISOString(), attribution: state.attribution }),
    });
  } catch (e) { /* optional */ }
}

async function persistBookSnapshot() {
  if (!state.positions?.length || !state.marketData) return;
  try {
    const optionLegs = state.positions.filter(p => p.posType !== "equity" && p.expiry);
    let marks = state.optionMarks || {};
    if (optionLegs.length && !Object.keys(marks).length) {
      const { data } = await fetchJson("/api/option-marks", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          positions: optionLegs.map(p => ({
            ticker: p.ticker, expiry: dateKey(p.expiry), strike: p.strike, optType: p.optType, posType: "option",
          })),
        }),
      });
      marks = data.marks || {};
    }
    const { data } = await fetchJson("/api/snapshots/book", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        timestamp: state.fetchedAt || new Date().toISOString(),
        positions: state.positions.map(p => ({
          ticker: p.ticker, expiry: p.expiry ? dateKey(p.expiry) : null, strike: p.strike,
          optType: p.optType, contracts: p.contracts, shares: p.shares || 0,
          posType: p.posType || "option", avgCost: p.avgCost || 0, adjCost: p.adjCost || null,
        })),
        marketData: state.marketData,
        optionMarks: marks,
      }),
    });
    if (data?.mtmSharpe != null || data?.unrealizedPnl != null) {
      state.lastBookMtm = data;
    }
  } catch (e) { /* optional */ }
}

async function loadBookRiskMetrics() {
  try {
    const { ok, data } = await fetchJson("/api/snapshots/book-timeline?limit=60");
    if (!ok) return null;
    state.bookRisk = data.risk || null;
    state.bookTimeline = data.points || [];
    return data.risk;
  } catch (e) {
    return null;
  }
}

async function persistFetchSession() {
  try {
    await fetch("/api/snapshots/session", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        timestamp: state.fetchedAt || new Date().toISOString(),
        positionCount: state.positions.length,
        tickerCount: state.portfolio?.uniqueTickers || 0,
        meta: { format: state.format, hasHistory: !!state.rawHistTexts?.length },
      }),
    });
    await persistBookSnapshot();
  } catch (e) { /* optional */ }
}

function setupKeyboardShortcuts() {
  initChartExportHandlers();
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea, select") && e.key !== "Escape") return;
    if (e.key === "Escape") {
      document.getElementById("ticker-search-overlay").hidden = true;
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tabs = ["positions", "risk", "simulate", "journal", "orders"];
    if (e.key >= "1" && e.key <= "5") { switchToTab(tabs[+e.key - 1]); return; }
    if (e.key === "/") { e.preventDefault(); openTickerSearch(); return; }
    if (e.key === "r" || e.key === "R") { e.preventDefault(); refreshOptionMarks(); return; }
  });
  document.getElementById("ticker-search-input")?.addEventListener("input", (e) => renderTickerSearchResults(e.target.value));
  document.getElementById("ticker-search-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); confirmTickerSearch(); }
  });
  document.getElementById("ticker-search-close")?.addEventListener("click", () => { document.getElementById("ticker-search-overlay").hidden = true; });
  document.getElementById("ticker-search-overlay")?.addEventListener("click", (e) => {
    if (e.target.id === "ticker-search-overlay") e.target.hidden = true;
  });
  document.getElementById("btn-wide-layout")?.addEventListener("click", () => {
    document.querySelector(".container")?.classList.toggle("wide");
    localStorage.setItem("od_wide", document.querySelector(".container")?.classList.contains("wide") ? "1" : "0");
    updateWideLayoutButton();
    refreshLayoutCharts();
  });
  document.getElementById("rail-goto-risk")?.addEventListener("click", goToRiskMatrix);
  document.getElementById("btn-export-risk-csv")?.addEventListener("click", exportRiskMatrixCsv);
  document.getElementById("btn-export-risk-png")?.addEventListener("click", () => {
    const tbl = document.querySelector("#risk-matrix-body table");
    if (tbl) exportHtmlTablePng(tbl, "risk-matrix");
  });
  document.getElementById("btn-export-sim-summary")?.addEventListener("click", exportSimSummary);
  document.getElementById("btn-export-journal-csv")?.addEventListener("click", exportJournalCsv);
  document.getElementById("hist-filter-ticker")?.addEventListener("input", (e) => {
    state.journalFilter = e.target.value;
    if (state.tradeHistory) renderTradeHistory(state.tradeHistory);
  });
  document.getElementById("hist-filter-strategy")?.addEventListener("change", (e) => {
    state.journalStrategyFilter = e.target.value;
    if (state.tradeHistory) renderTradeHistory(state.tradeHistory);
  });
  document.getElementById("btn-clear-journal-date")?.addEventListener("click", () => {
    state.journalDateFilter = "";
    if (state.tradeHistory) renderTradeHistory(state.tradeHistory);
  });
  document.getElementById("hist-show-assignment-legs")?.addEventListener("change", (e) => {
    state.journalShowAssignmentLegs = !!e.target.checked;
    saveSession();
    if (state.tradeHistory) renderTradeHistory(state.tradeHistory);
  });
  document.getElementById("btn-alert-settings")?.addEventListener("click", toggleAlertSettings);
}

function html2canvasExportRisk(tableEl) {
  exportHtmlTablePng(tableEl, "risk-matrix");
}

