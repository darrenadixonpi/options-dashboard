/// <reference path="./types.ts" />
// ═══════════════════════════════════════════════════════════════════════════
// Simulation
// ═══════════════════════════════════════════════════════════════════════════

let pnlHistPanZoomCleanup = null;
/** @type {{ startX: number, startLo: number, startHi: number, span: number } | null} */
let pnlHistPanSession = null;
/** @type {{ chart: Chart, view: object, stats: object } | null} */
let pnlHistPanContext = null;
let pnlHistPanGlobalWired = false;

function enableSimButton() {
  document.getElementById("btn-simulate").disabled = !state.positions.length;
  const inlineSection = document.getElementById("dashboard-sim-section");
  if (inlineSection && state.marketData && state.positions.length) inlineSection.hidden = false;
}

async function runSimulation(btn, logEl) {
  if (!state.positions.length) return;
  btn.disabled = true;
  btn.innerHTML = "<span class='od-spinner'></span> <span>Simulating...</span>";
  logEl.textContent = "Running Monte Carlo simulation on server...";
  const allBtns = [document.getElementById("btn-simulate"), document.getElementById("btn-simulate-inline")].filter(Boolean);
  allBtns.forEach(b => b.disabled = true);

  try {
    const payload = state.positions.map(p => ({
      ticker: p.ticker, expiry: p.expiry ? dateKey(p.expiry) : null, strike: p.strike,
      optType: p.optType, contracts: p.contracts, avgCost: p.avgCost || 0,
      adjCost: p.adjCost || null, totalPremium: p.totalPremium || 0,
      posType: p.posType || "option", shares: p.shares || 0,
    }));
    const { ok, data } = await fetchJson("/api/simulate", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ positions: payload, n_paths: 10000 }),
    });
    if (!ok || data.error) { logEl.textContent = `Error: ${data.error || "Simulation failed"}`; allBtns.forEach(b => { b.innerHTML = "<span>🎲</span> <span>Retry simulation</span>"; b.disabled = false; }); return; }
    const logMsg = `Done — ${data.n_paths.toLocaleString()} paths simulated`;
    document.getElementById("sim-log").textContent = logMsg;
    const inlineLog = document.getElementById("sim-log-inline");
    if (inlineLog) inlineLog.textContent = logMsg;
    allBtns.forEach(b => { b.innerHTML = "<span>🎲</span> <span>Re-run simulation</span>"; b.disabled = false; });
    state.simDone = true;
    state.simResult = data;
    state.pnlHistRange = pnlHistNeedsFocus(data.portfolio) ? "focus" : "full";
    state.pnlHistCustom = null;
    renderSimResults(data);
    refreshDeskAlerts();
    saveSession();
    if (state.portfolio) renderPortfolio(state.portfolio, !!state.marketData);
    switchToTab("simulate", { scrollTop: true });
  } catch(e) {
    logEl.textContent = `Error: ${e.message}`;
    allBtns.forEach(b => { b.innerHTML = "<span>🎲</span> <span>Retry</span>"; b.disabled = false; });
  }
}

document.getElementById("btn-simulate").addEventListener("click", function() { runSimulation(this, document.getElementById("sim-log")); });
document.getElementById("btn-simulate-inline")?.addEventListener("click", function() { runSimulation(this, document.getElementById("sim-log-inline")); });

function fmtDollar(x) {
  return Math.abs(x) >= 1000 ? `$${x.toLocaleString("en-US", {maximumFractionDigits: 0})}` : `$${x.toFixed(2)}`;
}

/** True when min/max tails compress the P5–P95 core into a sliver of the chart. */
function pnlHistNeedsFocus(stats) {
  const coreSpan = stats.p95 - stats.p5;
  if (!(coreSpan > 0) || stats.min == null || stats.max == null) return false;
  const upperTail = stats.max - stats.p95;
  const lowerTail = stats.p5 - stats.min;
  return upperTail > coreSpan * 0.35 || lowerTail > coreSpan * 0.35;
}

function defaultFocusRange(stats) {
  const coreSpan = stats.p95 - stats.p5;
  const pad = Math.max(coreSpan * 0.06, 1);
  return { lo: stats.p5 - pad, hi: stats.p95 + pad };
}

function pnlHistStep(stats) {
  return Math.max(Math.round((stats.max - stats.min) / 400), 1);
}

function resolvePnlHistWindow(stats, rangeMode) {
  const step = pnlHistStep(stats);
  if (rangeMode === "full") {
    return { lo: stats.min, hi: stats.max, mode: "full", viewLo: stats.min, viewHi: stats.max };
  }
  if (rangeMode === "custom" && state.pnlHistCustom) {
    let lo = Math.min(state.pnlHistCustom.lo, state.pnlHistCustom.hi - step);
    let hi = Math.max(state.pnlHistCustom.hi, lo + step);
    lo = Math.max(stats.min, lo);
    hi = Math.min(stats.max, hi);
    return { lo, hi, mode: "custom", viewLo: lo, viewHi: hi };
  }
  const { lo, hi } = defaultFocusRange(stats);
  const viewLo = Math.max(stats.min, lo);
  const viewHi = Math.min(stats.max, hi);
  return { lo: viewLo, hi: viewHi, mode: "focus", viewLo, viewHi };
}

function pnlHistBinCount(stats, viewLo, viewHi, mode) {
  const fullSpan = stats.max - stats.min;
  const viewSpan = viewHi - viewLo;
  if (!(viewSpan > 0)) return 60;
  if (mode === "full" || viewSpan >= fullSpan * 0.995) return 60;
  const ratio = fullSpan / viewSpan;
  return Math.min(80, Math.max(24, Math.round(32 * ratio)));
}

/** Re-bin raw path P&L for [viewLo, viewHi] — finer buckets when zoomed in. */
function rebinPortfolioPnl(pnl, stats, viewLo, viewHi, mode) {
  const nBins = pnlHistBinCount(stats, viewLo, viewHi, mode);
  const width = (viewHi - viewLo) / nBins;
  if (!(width > 0)) return null;

  let belowCount = 0;
  let aboveCount = 0;
  const counts = new Array(nBins).fill(0);

  for (let i = 0; i < pnl.length; i++) {
    const v = pnl[i];
    if (v < viewLo) { belowCount++; continue; }
    if (v > viewHi) { aboveCount++; continue; }
    let idx = Math.floor((v - viewLo) / width);
    if (idx >= nBins) idx = nBins - 1;
    counts[idx]++;
  }

  const labels = [];
  const outCounts = [];
  const colors = [];
  const mids = [];

  if (mode !== "full" && belowCount > 0) {
    labels.push(`≤${fmtDollar(viewLo)}`);
    outCounts.push(belowCount);
    colors.push("rgba(239,83,80,0.45)");
    mids.push(viewLo);
  }
  for (let i = 0; i < nBins; i++) {
    if (counts[i] === 0) continue;
    const lo = viewLo + i * width;
    const hi = lo + width;
    const mid = (lo + hi) / 2;
    labels.push(fmtDollar(mid));
    outCounts.push(counts[i]);
    colors.push(mid >= 0 ? "rgba(76,175,80,0.7)" : "rgba(239,83,80,0.7)");
    mids.push(mid);
  }
  if (mode !== "full" && aboveCount > 0) {
    labels.push(`≥${fmtDollar(viewHi)}`);
    outCounts.push(aboveCount);
    colors.push("rgba(76,175,80,0.45)");
    mids.push(viewHi);
  }

  return { labels, counts: outCounts, colors, mids, belowCount, aboveCount, nBins, binWidth: width };
}

function buildPnlHistogramBins(h, stats, rangeMode, portfolioPnl) {
  const win = resolvePnlHistWindow(stats, rangeMode);
  const { viewLo, viewHi, mode } = win;

  if (portfolioPnl?.length) {
    const rebinned = rebinPortfolioPnl(portfolioPnl, stats, viewLo, viewHi, mode);
    if (rebinned) {
      const tailPaths = rebinned.belowCount + rebinned.aboveCount;
      const tailNote = mode !== "full" && tailPaths > 0
        ? `Range ${fmtDollar(viewLo)} … ${fmtDollar(viewHi)}: ${tailPaths.toLocaleString()} paths outside (full ${fmtDollar(stats.min)} … ${fmtDollar(stats.max)})`
        : null;
      const binNote = `${rebinned.nBins} bins · ~${fmtDollar(rebinned.binWidth)} wide`;
      return {
        labels: rebinned.labels,
        counts: rebinned.counts,
        colors: rebinned.colors,
        mids: rebinned.mids,
        xMin: viewLo,
        xMax: viewHi,
        viewLo,
        viewHi,
        mode,
        tailNote,
        binNote,
        belowCount: rebinned.belowCount,
        aboveCount: rebinned.aboveCount,
      };
    }
  }

  const edges = h.edges;
  const counts = h.counts;
  const bins = [];
  let belowCount = 0;
  let aboveCount = 0;

  for (let i = 0; i < counts.length; i++) {
    const blo = edges[i];
    const bhi = edges[i + 1];
    const mid = (blo + bhi) / 2;
    if (mode !== "full" && mid < viewLo) { belowCount += counts[i]; continue; }
    if (mode !== "full" && mid > viewHi) { aboveCount += counts[i]; continue; }
    const clipLo = mode === "full" ? blo : Math.max(blo, viewLo);
    const clipHi = mode === "full" ? bhi : Math.min(bhi, viewHi);
    if (clipHi <= clipLo) continue;
    const midClip = (clipLo + clipHi) / 2;
    bins.push({
      lo: clipLo,
      hi: clipHi,
      count: counts[i],
      color: midClip >= 0 ? "rgba(76,175,80,0.7)" : "rgba(239,83,80,0.7)",
    });
  }

  const xMin = mode === "full" ? edges[0] : viewLo;
  const xMax = mode === "full" ? edges[edges.length - 1] : viewHi;
  const tailPaths = belowCount + aboveCount;
  const tailNote = mode !== "full" && tailPaths > 0
    ? `Range ${fmtDollar(viewLo)} … ${fmtDollar(viewHi)}: ${tailPaths.toLocaleString()} paths outside (full ${fmtDollar(stats.min)} … ${fmtDollar(stats.max)})`
    : null;

  const labels = [];
  const outCounts = [];
  const colors = [];
  const mids = [];

  if (mode !== "full" && belowCount > 0) {
    labels.push(`≤${fmtDollar(viewLo)}`);
    outCounts.push(belowCount);
    colors.push("rgba(239,83,80,0.45)");
    mids.push(viewLo);
  }
  for (const b of bins) {
    const mid = (b.lo + b.hi) / 2;
    labels.push(fmtDollar(mid));
    outCounts.push(b.count);
    colors.push(b.color);
    mids.push(mid);
  }
  if (mode !== "full" && aboveCount > 0) {
    labels.push(`≥${fmtDollar(viewHi)}`);
    outCounts.push(aboveCount);
    colors.push("rgba(76,175,80,0.45)");
    mids.push(viewHi);
  }

  return { labels, counts: outCounts, colors, mids, xMin, xMax, viewLo, viewHi, mode, tailNote, binNote: null, belowCount, aboveCount };
}

/** Y-axis from in-range bins only; end overflow bars are fixed-height stubs (count in label/tooltip). */
function pnlHistChartDisplay(view) {
  const actualCounts = view.counts;
  const labels = view.labels.slice();
  const displayCounts = actualCounts.slice();

  let coreStart = 0;
  let coreEnd = displayCounts.length;
  const hasLowTail = view.mode !== "full" && view.belowCount > 0;
  const hasHighTail = view.mode !== "full" && view.aboveCount > 0;
  if (hasLowTail) coreStart = 1;
  if (hasHighTail) coreEnd = displayCounts.length - 1;

  const coreCounts = displayCounts.slice(coreStart, coreEnd);
  const coreMax = coreCounts.length ? Math.max(...coreCounts) : 0;
  const yMax = coreMax > 0 ? Math.ceil(coreMax * 1.1) : undefined;
  // Short overflow stubs — never scale with tail path count (avoids misleading the core shape).
  const tailStub = yMax ? Math.max(Math.round(yMax * 0.1), 2) : 2;

  if (hasLowTail && displayCounts.length) {
    displayCounts[0] = tailStub;
    labels[0] = `≤${fmtDollar(view.viewLo)} · ${view.belowCount.toLocaleString()} out`;
  }
  if (hasHighTail && displayCounts.length) {
    const ti = displayCounts.length - 1;
    displayCounts[ti] = tailStub;
    labels[ti] = `≥${fmtDollar(view.viewHi)} · ${view.aboveCount.toLocaleString()} out`;
  }

  return { labels, displayCounts, actualCounts, yMax, hasLowTail, hasHighTail };
}

function syncPnlHistSliderUi(stats, view, opts = {}) {
  const wrap = document.getElementById("pnl-hist-slider-wrap");
  const loEl = document.getElementById("pnl-hist-lo");
  const hiEl = document.getElementById("pnl-hist-hi");
  const lbl = document.getElementById("pnl-hist-range-label");
  if (!wrap || !loEl || !hiEl || !lbl) return;

  wrap.hidden = false;
  const step = pnlHistStep(stats);
  for (const el of [loEl, hiEl]) {
    el.min = stats.min;
    el.max = stats.max;
    el.step = step;
  }

  if (!opts.fromSlider) {
    loEl.value = view.viewLo;
    hiEl.value = view.viewHi;
  }

  lbl.textContent = `${fmtDollar(+loEl.value)} … ${fmtDollar(+hiEl.value)}`;
  wrap.classList.toggle("is-disabled", view.mode === "full");
  loEl.disabled = hiEl.disabled = view.mode === "full";
}

function wirePnlHistRangeControls() {
  const toggle = document.getElementById("pnl-hist-range-toggle");
  if (toggle && !toggle.dataset.wired) {
    toggle.dataset.wired = "1";
    toggle.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-pnl-range]");
      if (!btn || !state.simResult) return;
      state.pnlHistRange = btn.dataset.pnlRange;
      state.pnlHistCustom = null;
      renderPortfolioPnlChart(state.simResult, state.pnlHistRange);
    });
  }

  const wrap = document.getElementById("pnl-hist-slider-wrap");
  if (!wrap || wrap.dataset.wired) return;
  wrap.dataset.wired = "1";

  const onSlider = () => {
    if (!state.simResult) return;
    const loEl = document.getElementById("pnl-hist-lo");
    const hiEl = document.getElementById("pnl-hist-hi");
    const stats = state.simResult.portfolio;
    const step = pnlHistStep(stats);
    let lo = +loEl.value;
    let hi = +hiEl.value;
    if (lo > hi - step) {
      if (document.activeElement === loEl) hi = lo + step;
      else lo = hi - step;
    }
    lo = Math.max(stats.min, Math.min(lo, stats.max - step));
    hi = Math.min(stats.max, Math.max(hi, lo + step));
    loEl.value = lo;
    hiEl.value = hi;
    state.pnlHistRange = "custom";
    state.pnlHistCustom = { lo, hi };
    renderPortfolioPnlChart(state.simResult, "custom", { fromSlider: true });
  };

  document.getElementById("pnl-hist-lo")?.addEventListener("input", onSlider);
  document.getElementById("pnl-hist-hi")?.addEventListener("input", onSlider);

  document.getElementById("pnl-hist-preset-p5")?.addEventListener("click", () => {
    if (!state.simResult) return;
    state.pnlHistRange = "focus";
    state.pnlHistCustom = null;
    renderPortfolioPnlChart(state.simResult, "focus");
  });

  document.getElementById("pnl-hist-preset-full")?.addEventListener("click", () => {
    if (!state.simResult) return;
    state.pnlHistRange = "full";
    state.pnlHistCustom = null;
    renderPortfolioPnlChart(state.simResult, "full");
  });
}

function pnlHistActiveRange(stats, view) {
  if (state.pnlHistCustom) return { lo: state.pnlHistCustom.lo, hi: state.pnlHistCustom.hi };
  if (view) return { lo: view.viewLo, hi: view.viewHi };
  const win = resolvePnlHistWindow(stats, state.pnlHistRange || "full");
  return { lo: win.viewLo, hi: win.viewHi };
}

function clampPnlHistRange(stats, lo, hi) {
  const step = pnlHistStep(stats);
  const fullSpan = stats.max - stats.min;
  const coreSpan = Math.max(stats.p95 - stats.p5, step * 4);
  const minSpan = Math.min(fullSpan, Math.max(step * 8, coreSpan * 0.08, 250));
  let span = Math.max(minSpan, hi - lo);
  span = Math.min(fullSpan, span);
  lo = Math.max(stats.min, lo);
  hi = Math.min(stats.max, hi);
  if (hi - lo < span) {
    const mid = (lo + hi) / 2;
    lo = mid - span / 2;
    hi = mid + span / 2;
  }
  if (lo < stats.min) { lo = stats.min; hi = Math.min(stats.max, lo + span); }
  if (hi > stats.max) { hi = stats.max; lo = Math.max(stats.min, hi - span); }
  return { lo, hi };
}

function applyPnlHistCustomRange(lo, hi, opts = {}) {
  if (!state.simResult) return;
  const stats = state.simResult.portfolio;
  const r = clampPnlHistRange(stats, lo, hi);
  state.pnlHistRange = "custom";
  state.pnlHistCustom = r;
  renderPortfolioPnlChart(state.simResult, "custom", opts);
}

function pnlHistDollarAtPixel(chart, view, stats, pixelX) {
  const xScale = chart.scales.x;
  const area = chart.chartArea;
  if (!xScale || !area || area.right <= area.left) return null;
  const range = pnlHistActiveRange(stats, view);
  const idx = xScale.getValueForPixel(pixelX);
  if (idx != null && Number.isFinite(idx) && view.mids?.length) {
    const i = Math.round(Math.max(0, Math.min(view.mids.length - 1, idx)));
    if (view.mids[i] != null) return view.mids[i];
  }
  const frac = Math.max(0, Math.min(1, (pixelX - area.left) / (area.right - area.left)));
  return range.lo + frac * (range.hi - range.lo);
}

function ensurePnlHistPanGlobalHandlers() {
  if (pnlHistPanGlobalWired) return;
  pnlHistPanGlobalWired = true;

  window.addEventListener("mousemove", (e) => {
    if (!pnlHistPanSession || !pnlHistPanContext || !state.simResult) return;
    const { chart, stats } = pnlHistPanContext;
    const area = chart.chartArea;
    if (!area || area.right <= area.left) return;
    const dx = e.clientX - pnlHistPanSession.startX;
    const shift = -(dx / (area.right - area.left)) * pnlHistPanSession.span;
    applyPnlHistCustomRange(
      pnlHistPanSession.startLo + shift,
      pnlHistPanSession.startHi + shift,
      { duringPan: true },
    );
  });

  window.addEventListener("mouseup", () => {
    if (!pnlHistPanSession) return;
    pnlHistPanSession = null;
    document.getElementById("chart-portfolio")?.classList.remove("od-panzoom-grabbing");
  });
}

function wirePnlHistChartPanZoom(chart, view, stats) {
  pnlHistPanZoomCleanup?.();
  pnlHistPanZoomCleanup = null;
  if (!state.simResult?.portfolio_pnl?.length) return;

  const canvas = chart.canvas;
  if (!canvas) return;
  pnlHistPanContext = { chart, view, stats };
  ensurePnlHistPanGlobalHandlers();
  const step = pnlHistStep(stats);

  function onWheel(e) {
    e.preventDefault();
    const range = pnlHistActiveRange(stats, view);
    const span = range.hi - range.lo;
    const rect = canvas.getBoundingClientRect();
    let focal = pnlHistDollarAtPixel(chart, view, stats, e.clientX - rect.left);
    if (focal == null) focal = (range.lo + range.hi) / 2;
    const zoomOut = e.deltaY > 0;
    const factor = zoomOut ? 1.14 : 0.86;
    let newSpan = span * factor;
    if (state.pnlHistRange === "full" && !state.pnlHistCustom && !zoomOut) {
      newSpan = Math.min(span * 0.75, Math.max(stats.p95 - stats.p5, step * 8) * 1.25);
    }
    const ratio = span > 0 ? (focal - range.lo) / span : 0.5;
    let newLo = focal - ratio * newSpan;
    let newHi = newLo + newSpan;
    applyPnlHistCustomRange(newLo, newHi);
  }

  function onDown(e) {
    if (e.button !== 0) return;
    const range = pnlHistActiveRange(stats, view);
    if (range.hi - range.lo >= stats.max - stats.min - step * 2) return;
    pnlHistPanSession = { startX: e.clientX, startLo: range.lo, startHi: range.hi, span: range.hi - range.lo };
    canvas.classList.add("od-panzoom-grabbing");
    e.preventDefault();
  }

  function onDblClick() {
    pnlHistPanSession = null;
    state.pnlHistCustom = null;
    state.pnlHistRange = pnlHistNeedsFocus(stats) ? "focus" : "full";
    renderPortfolioPnlChart(state.simResult, state.pnlHistRange);
  }

  canvas.classList.add("od-panzoom");
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("mousedown", onDown);
  canvas.addEventListener("dblclick", onDblClick);

  pnlHistPanZoomCleanup = () => {
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("mousedown", onDown);
    canvas.removeEventListener("dblclick", onDblClick);
    canvas.classList.remove("od-panzoom", "od-panzoom-grabbing");
    if (!pnlHistPanSession) pnlHistPanContext = null;
  };
}

function renderPortfolioPnlChart(data: SimulateResult, rangeMode?: string, opts: { fromSlider?: boolean; duringPan?: boolean } = {}) {
  const p = data.portfolio;
  const h = data.histogram;
  const needsFocus = pnlHistNeedsFocus(p);
  const mode = rangeMode || state.pnlHistRange || (needsFocus ? "focus" : "full");
  const view = buildPnlHistogramBins(h, p, mode, data.portfolio_pnl);

  const toggle = document.getElementById("pnl-hist-range-toggle");
  if (toggle) {
    toggle.hidden = !needsFocus;
    toggle.querySelectorAll("[data-pnl-range]").forEach(btn => {
      const isActive = view.mode === "custom"
        ? false
        : view.mode === "full"
          ? btn.dataset.pnlRange === "full"
          : view.mode === "focus"
            ? btn.dataset.pnlRange === "focus"
            : false;
      btn.classList.toggle("active", isActive);
      btn.classList.toggle("btn-ghost", !isActive);
    });
  }

  syncPnlHistSliderUi(p, view, opts);
  const chartDisp = pnlHistChartDisplay(view);

  function closestIdx(val) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < view.mids.length; i++) {
      const d = Math.abs(view.mids[i] - val);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  const statLines = [
    { id: "p5_line", val: p.p5, color: "#ef5350", label: `P5: ${fmtDollar(p.p5)}`, pos: "end" },
    { id: "mean_line", val: p.mean, color: "#f5c518", label: `Mean: ${fmtDollar(p.mean)}`, pos: "start" },
    { id: "med_line", val: p.median, color: "#ffffff", label: `Median: ${fmtDollar(p.median)}`, pos: "end" },
    { id: "p95_line", val: p.p95, color: "#66bb6a", label: `P95: ${fmtDollar(p.p95)}`, pos: "start" },
  ];
  const annotations = {};
  for (const s of statLines) {
    if (view.mode !== "full" && (s.val < view.viewLo || s.val > view.viewHi)) continue;
    annotations[s.id] = {
      type: "line", xMin: closestIdx(s.val), xMax: closestIdx(s.val),
      borderColor: s.color, borderWidth: 1.5, borderDash: [4, 3],
      label: { display: true, content: s.label, position: s.pos, yAdjust: 0, backgroundColor: "rgba(30,30,28,0.85)", color: s.color, font: { size: 9, family: "JetBrains Mono" }, padding: 3 },
    };
  }

  destroyChart("chart-portfolio");
  if (!opts.duringPan) pnlHistPanZoomCleanup?.();

  const panZoomEnabled = !!(data.portfolio_pnl?.length);
  const hint = document.getElementById("pnl-hist-panzoom-hint");
  if (hint) {
    hint.hidden = !panZoomEnabled;
    hint.textContent = panZoomEnabled
      ? "Scroll to zoom the dollar range (re-bins paths) · drag to pan · double-click to reset"
      : "Re-run simulation to enable scroll/drag range zoom (needs path-level P&L data)";
  }

  chartInstances["chart-portfolio"] = new Chart(document.getElementById("chart-portfolio"), {
    type: "bar",
    data: {
      labels: chartDisp.labels,
      datasets: [{ data: chartDisp.displayCounts, backgroundColor: view.colors, borderWidth: 0 }],
    },
    options: deepMergeChartOpts(chartInteractionDefaults(), {
      responsive: true,
      animation: false,
      plugins: {
        legend: { display: false },
        annotation: { annotations },
        tooltip: {
          callbacks: {
            title(items) {
              const i = items[0]?.dataIndex;
              if (i == null) return "";
              return chartDisp.labels[i] || "";
            },
            label(ctx) {
              const i = ctx.dataIndex;
              const n = chartDisp.actualCounts[i];
              if (n == null) return "";
              const isTail = (i === 0 && chartDisp.hasLowTail) || (i === chartDisp.actualCounts.length - 1 && chartDisp.hasHighTail);
              return isTail ? `${n.toLocaleString()} paths outside range` : `${n.toLocaleString()} paths`;
            },
          },
        },
      },
      datasets: { bar: { barPercentage: 1, categoryPercentage: 1 } },
      scales: {
        x: {
          ticks: { maxTicksLimit: view.mode === "full" ? 10 : 14, color: "#9b9b96", font: { size: 10 } },
          grid: { display: false },
        },
        y: {
          beginAtZero: true,
          max: chartDisp.yMax,
          ticks: { color: "#9b9b96", font: { size: 10 } },
          grid: { color: "rgba(255,255,255,0.05)" },
        },
      },
    }),
  });

  if (panZoomEnabled) {
    pnlHistPanContext = { chart: chartInstances["chart-portfolio"], view, stats: p };
    wirePnlHistChartPanZoom(chartInstances["chart-portfolio"], view, p);
  }

  const binSuffix = view.binNote ? ` · ${view.binNote}` : (!data.portfolio_pnl?.length && view.mode !== "full" ? " · re-run sim for fine zoom" : "");
  const tailSuffix = view.tailNote ? ` · ${view.tailNote}` : "";
  document.getElementById("portfolio-stats").innerHTML =
    `Mean: ${fmtDollar(p.mean)} · Median: ${fmtDollar(p.median)} · P5: ${fmtDollar(p.p5)} · P95: ${fmtDollar(p.p95)} · P(profit): ${p.prob_profit}% · ${data.n_paths?.toLocaleString()} paths${data.correlation ? " · correlated" : ""} · intrinsic at expiry, flat IV per ticker${binSuffix}${tailSuffix}`;
}

function renderStrategyProfitChart(data: SimulateResult, view: string = "book") {
  destroyChart("chart-strategies");
  const canvas = document.getElementById("chart-strategies");
  if (!canvas) return;

  let labels: string[];
  let values: number[];
  if (view === "slices") {
    labels = Object.keys(data.by_strategy).sort((a, b) => data.by_strategy[a].prob_profit - data.by_strategy[b].prob_profit);
    values = labels.map(s => data.by_strategy[s].prob_profit);
    const title = document.getElementById("strategy-chart-title");
    const note = document.getElementById("strategy-chart-note");
    if (title) title.textContent = "P(profit) by Expiry Slice";
    if (note) note.textContent = "Options-only per expiry — labels include share context; equity P&L is in combined book view";
  } else {
    labels = Object.keys(data.by_ticker).sort((a, b) => data.by_ticker[a].prob_profit - data.by_ticker[b].prob_profit);
    values = labels.map(t => data.by_ticker[t].prob_profit);
    const title = document.getElementById("strategy-chart-title");
    const note = document.getElementById("strategy-chart-note");
    if (title) title.textContent = "P(profit) by Ticker (Combined Book)";
    if (note) note.textContent = "All legs per ticker — shares + every option expiry summed on each Monte Carlo path";
  }

  chartInstances["chart-strategies"] = new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: values.map(v => v >= 50 ? "rgba(76,175,80,0.7)" : "rgba(239,83,80,0.7)"),
        borderWidth: 0,
      }],
    },
    options: deepMergeChartOpts(chartInteractionDefaults({ axis: "y" }), {
      indexAxis: "y",
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(ctx) {
              const v = ctx.raw as number;
              const key = labels[ctx.dataIndex];
              if (view === "book" && data.by_ticker[key]) {
                const st = data.by_ticker[key];
                return [`P(profit): ${v}%`, `Median P&L: ${fmtDollar(st.median)}`, `Mean: ${fmtDollar(st.mean)}`];
              }
              return `P(profit): ${v}%`;
            },
          },
        },
      },
      scales: {
        x: { min: 0, max: 100, ticks: { callback: v => v + "%", color: "#9b9b96", font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.05)" } },
        y: { ticks: { color: "#e8e8e4", font: { size: 10, family: "'JetBrains Mono'" } }, grid: { display: false } },
      },
    }),
  });
}

function wirePProfitViewControls(data: SimulateResult) {
  const wrap = document.getElementById("pprofit-view-toggle");
  if (!wrap) return;
  const view = state.simPProfitView || "book";
  wrap.querySelectorAll("[data-pprofit-view]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.pprofitView === view);
  });
  if (wrap.dataset.wired) return;
  wrap.dataset.wired = "1";
  wrap.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("[data-pprofit-view]");
    if (!btn) return;
    const next = btn.dataset.pprofitView || "book";
    state.simPProfitView = next;
    saveSession();
    wrap.querySelectorAll("[data-pprofit-view]").forEach(b => b.classList.toggle("active", b === btn));
    renderStrategyProfitChart(data, next);
  });
}

function renderSimStickyBar(data) {
  const p = data.portfolio;
  const topEl = document.getElementById("sim-results-top");
  if (!topEl) return;
  topEl.innerHTML = `
    <div class="sim-sticky-inner">
      <nav class="sim-jump-nav" id="sim-jump-nav" aria-label="Simulation sections">
        <button type="button" class="btn btn-sm btn-ghost" data-sim-jump="sim-results-top">Summary</button>
        <button type="button" class="btn btn-sm btn-ghost" data-sim-jump="sim-block-portfolio">Portfolio</button>
        <button type="button" class="btn btn-sm btn-ghost" data-sim-jump="corr-section">Correlation</button>
        <button type="button" class="btn btn-sm btn-ghost" data-sim-jump="sim-path-layout">Fan charts</button>
      </nav>
      <div class="summary">
        <div class="stat"><div class="stat-label">P(Profit)</div><div class="stat-val">${p.prob_profit}%</div></div>
        <div class="stat"><div class="stat-label">Mean P&L</div><div class="stat-val">${fmtDollar(p.mean)}</div></div>
        <div class="stat"><div class="stat-label">Median P&L</div><div class="stat-val">${fmtDollar(p.median)}</div></div>
        <div class="stat"><div class="stat-label">5th / 95th</div><div class="stat-val" style="font-size:15px">${fmtDollar(p.p5)} / ${fmtDollar(p.p95)}</div></div>
      </div>
    </div>`;
  wireSimJumpNav();
  syncSimChromeOffset();
}

function syncSimChromeOffset() {
  const topEl = document.getElementById("sim-results-top");
  requestAnimationFrame(() => {
    const summaryH = topEl?.offsetHeight || 88;
    document.documentElement.style.setProperty("--sim-chrome-offset", `${56 + summaryH}px`);
  });
}

function setSimTickerNavActive(tkr) {
  const nav = document.getElementById("sim-ticker-nav");
  if (!nav) return;
  nav.querySelectorAll("[data-sim-nav]").forEach(b => {
    const on = b.dataset.simNav === tkr;
    b.classList.toggle("active", on);
    if (on) b.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
}

function wireSimTickerNav() {
  const nav = document.getElementById("sim-ticker-nav");
  if (!nav || nav.dataset.wired) return;
  nav.dataset.wired = "1";
  nav.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-sim-nav]");
    if (!btn) return;
    const tkr = btn.dataset.simNav;
    setSimTickerNavActive(tkr);
    const wrap = document.getElementById(`path-wrap-${tkr}`);
    if (!wrap) return;
    wrap.classList.remove("collapsed");
    setSimChartCollapsed(tkr, false);
    wrap.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function renderSimResults(data: SimulateResult) {
  for (const id of Object.keys(chartInstances)) destroyChart(id);
  document.getElementById("sim-results").hidden = false;
  document.getElementById("sim-empty").hidden = true;

  state.simMeta = {
    n_paths: data.n_paths,
    correlated: !!data.correlation,
    fetchedAt: new Date().toISOString(),
  };
  updateProvenanceBar();
  saveSession();

  const p = data.portfolio;
  renderSimStickyBar(data);

  if (!state.pnlHistRange) state.pnlHistRange = pnlHistNeedsFocus(p) ? "focus" : "full";
  wirePnlHistRangeControls();
  renderPortfolioPnlChart(data, state.pnlHistRange);

  // Per-ticker chart
  destroyChart("chart-tickers");
  const tickers = Object.keys(data.by_ticker).sort((a,b) => data.by_ticker[a].median - data.by_ticker[b].median);
  chartInstances["chart-tickers"] = new Chart(document.getElementById("chart-tickers"), {
    type:"bar", data:{labels:tickers.map(t => `${t} (${data.by_ticker[t].model==="merton"?"JD":"GBM"})`),datasets:[{data:tickers.map(t=>data.by_ticker[t].median),backgroundColor:tickers.map(t=>data.by_ticker[t].median>=0?"rgba(76,175,80,0.7)":"rgba(239,83,80,0.7)"),borderWidth:0}]},
    options: deepMergeChartOpts(chartInteractionDefaults({ axis: "y" }), { indexAxis:"y", responsive:true, plugins:{ legend:{ display:false } }, scales:{ x:{ ticks:{ callback:v=>fmtDollar(v), color:"#9b9b96", font:{ size:10 } }, grid:{ color:"rgba(255,255,255,0.05)" } }, y:{ ticks:{ color:"#e8e8e4", font:{ size:11, family:"'JetBrains Mono'" } }, grid:{ display:false } } } }),
  });

  // Strategy / combined-book P(profit) chart
  renderStrategyProfitChart(data, state.simPProfitView || "book");
  wirePProfitViewControls(data);

  // Correlation heatmap (#10)
  if (data.correlation) renderCorrelationHeatmap(data.correlation);

  // Theta charts
  if (data.theta) renderThetaCharts(data.theta);

  // Ticker path charts
  renderTickerPathCharts(data.ticker_paths, data.by_ticker);
  wireSimJumpNav();
}

// ═══════════════════════════════════════════════════════════════════════════
// Correlation Heatmap (#10)
// ═══════════════════════════════════════════════════════════════════════════

function renderCorrelationHeatmap(corrData) {
  if (!corrData) return;
  document.getElementById("corr-section").hidden = false;
  const { tickers, matrix } = corrData;
  const n = tickers.length;
  let html = '<table style="border-collapse:collapse;width:100%;font-family:var(--mono);font-size:11px"><tr><td></td>';
  for (const t of tickers) html += `<td style="padding:6px;text-align:center;color:var(--tx2)">${t}</td>`;
  html += '</tr>';
  for (let i = 0; i < n; i++) {
    html += `<tr><td style="padding:6px;color:var(--tx2);text-align:right">${tickers[i]}</td>`;
    for (let j = 0; j < n; j++) {
      const v = matrix[i][j];
      const absV = Math.abs(v);
      let bg;
      if (i === j) bg = "var(--bg3)";
      else if (absV >= 0.7) bg = `rgba(239,83,80,${0.3 + absV * 0.5})`;
      else if (absV >= 0.4) bg = `rgba(255,183,77,${0.2 + absV * 0.4})`;
      else bg = `rgba(76,175,80,${0.1 + absV * 0.3})`;
      html += `<td style="padding:6px;text-align:center;background:${bg};border-radius:2px">${v.toFixed(2)}</td>`;
    }
    html += '</tr>';
  }
  html += '</table>';
  document.getElementById("corr-heatmap").innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════════
// Theta Charts — diverging daily stack (short θ up, long θ down)
// ═══════════════════════════════════════════════════════════════════════════

function thetaDailySymmetricScale(groups, nDays) {
  let maxUp = 0;
  let maxDn = 0;
  for (let i = 0; i < nDays; i++) {
    let up = 0;
    let dn = 0;
    for (const g of groups) {
      const v = g.daily[i] || 0;
      if (v >= 0) up += v;
      else dn += Math.abs(v);
    }
    maxUp = Math.max(maxUp, up);
    maxDn = Math.max(maxDn, dn);
  }
  const sym = Math.max(maxUp, maxDn, 1) * 1.08;
  return { min: -sym, max: sym };
}

function buildThetaDailyDatasets(groups) {
  return groups.map(g => ({
    label: g.label,
    data: g.daily,
    backgroundColor: (ctx) => {
      const v = ctx.raw;
      if (v == null || v === 0) return "transparent";
      return v >= 0 ? g.color + "DD" : g.color + "44";
    },
    borderColor: (ctx) => {
      const v = ctx.raw;
      if (v == null || v >= 0) return "transparent";
      return g.color;
    },
    borderWidth: (ctx) => (ctx.raw < 0 ? 1 : 0),
    borderDash: (ctx) => (ctx.raw < 0 ? [4, 3] : undefined),
    borderSkipped: false,
  }));
}

/**
 * @param {ThetaData} theta
 */
function renderThetaCharts(theta) {
  document.getElementById("theta-section").hidden = false;
  const dashTheta = document.getElementById("theta-dashboard-summary");
  if (dashTheta) {
    dashTheta.hidden = false;
    dashTheta.innerHTML = `
      <div class="stat" style="border-left:3px solid #f5c518"><div class="stat-label">Daily θ (net)</div><div class="stat-val" style="color:#f5c518">$${theta.todayTheta}</div>
        ${theta.todayCost ? `<div style="font-size:10px;color:var(--tx3);margin-top:2px">+$${theta.todayEarned} earned, $${theta.todayCost} cost</div>` : ""}
      </div>
      <div class="stat" style="border-left:3px solid #20c7c7"><div class="stat-label">θ to Last Expiry</div><div class="stat-val" style="color:#20c7c7">$${theta.totalCumulative.toLocaleString()}</div>
        ${theta.totalCumulativeNet !== theta.totalCumulative ? `<div style="font-size:10px;color:var(--tx3);margin-top:2px">Net: $${theta.totalCumulativeNet.toLocaleString()}</div>` : ""}
      </div>`;
  }
  const sub = document.getElementById("theta-subtitle");
  if (sub) sub.textContent = theta.nextExpiry ? `$${theta.todayTheta}/day → $${theta.postNextTheta}/day after ${theta.nextExpiry}` : `$${theta.todayTheta}/day`;
  const cumulTotal = document.getElementById("theta-cumul-total");
  if (cumulTotal) cumulTotal.textContent = `$${theta.totalCumulative.toLocaleString()} total`;

  destroyChart("chart-theta-daily");
  const yScale = thetaDailySymmetricScale(theta.groups, theta.dates.length);
  const datasets = buildThetaDailyDatasets(theta.groups);
  chartInstances["chart-theta-daily"] = new Chart(document.getElementById("chart-theta-daily"), {
    type: "bar",
    data: { labels: theta.dates, datasets },
    options: deepMergeChartOpts(chartInteractionDefaults(), {
      responsive: true,
      animation: false,
      plugins: {
        legend: { display: true, position: "top", labels: { color: "#e8e8e4", font: { size: 10 }, boxWidth: 12, padding: 8 } },
        annotation: {
          annotations: {
            zeroLine: {
              type: "line",
              yMin: 0,
              yMax: 0,
              borderColor: "rgba(255,255,255,0.35)",
              borderWidth: 1.5,
            },
          },
        },
        tooltip: {
          filter: (item) => item.raw != null && item.raw !== 0,
          callbacks: {
            label(ctx) {
              const v = ctx.raw;
              const kind = v >= 0 ? "earned" : "cost";
              return `${ctx.dataset.label}: ${v >= 0 ? "+" : ""}$${Number(v).toFixed(2)}/day (${kind})`;
            },
            footer(items) {
              const sum = items.reduce((s, it) => s + (it.raw || 0), 0);
              return `Net: ${sum >= 0 ? "+" : ""}$${sum.toFixed(2)}/day`;
            },
          },
        },
      },
      scales: {
        x: { stacked: true, ticks: { maxTicksLimit: 12, color: "#9b9b96", font: { size: 9 } }, grid: { display: false } },
        y: {
          stacked: true,
          min: yScale.min,
          max: yScale.max,
          ticks: { callback: v => (v >= 0 ? "+$" : "−$") + Math.abs(v).toFixed(0), color: "#9b9b96", font: { size: 10 } },
          grid: { color: "rgba(255,255,255,0.05)" },
        },
      },
    }),
  });

  destroyChart("chart-theta-cumul");
  const milestoneByIndex = {};
  (theta.milestones || []).forEach((m) => { milestoneByIndex[m.index] = m; });
  chartInstances["chart-theta-cumul"] = new Chart(document.getElementById("chart-theta-cumul"), {
    type: "line", data: { labels: theta.dates, datasets: [
      { label: "Earned (short options)", data: theta.cumulative, borderColor: "#20c7c7", borderWidth: 2, backgroundColor: "rgba(32,199,199,0.1)", fill: true, pointRadius: 0, pointHitRadius: 12, tension: 0.2 },
      { label: "Net (incl. long option cost)", data: theta.cumulativeNet, borderColor: "rgba(150,150,150,0.6)", borderWidth: 1.5, borderDash: [5, 3], fill: false, pointRadius: 0, pointHitRadius: 12, tension: 0.2 },
    ] },
    options: deepMergeChartOpts(chartInteractionDefaults(), {
      responsive: true,
      animation: false,
      layout: { padding: { left: 5, right: 15, top: 10, bottom: 5 } },
      plugins: {
        legend: { display: true, position: "top", labels: { color: "#e8e8e4", font: { size: 10 }, boxWidth: 12, padding: 8 } },
        tooltip: {
          callbacks: {
            title(items) {
              return items[0]?.label || "";
            },
            label(ctx) {
              return `${ctx.dataset.label}: $${Number(ctx.raw).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
            },
            afterBody(items) {
              const idx = items[0]?.dataIndex;
              const ms = idx != null ? milestoneByIndex[idx] : null;
              if (!ms) return [];
              return [`Expiry milestone (${ms.date}): $${ms.value.toLocaleString()}`];
            },
          },
        },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 12, color: "#9b9b96", font: { size: 9 } }, grid: { display: false } },
        y: { ticks: { callback: v => "$" + v.toLocaleString(), color: "#9b9b96", font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.05)" }, min: 0 },
      },
    }),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Ticker Path Fan Charts (unchanged core, + event overlays)
// ═══════════════════════════════════════════════════════════════════════════

function jumpToSimTicker(tkr) {
  if (!tkr) return;
  switchToTab("simulate");
  requestAnimationFrame(() => {
    setTimeout(() => {
      const wrap = document.getElementById(`path-wrap-${tkr}`);
      if (!wrap) return;
      wrap.classList.remove("collapsed");
      setSimChartCollapsed(tkr, false);
      setSimTickerNavActive(tkr);
      if (state.simFocusTicker) {
        state.simFocusTicker = null;
        const sel = document.getElementById("sim-focus-select");
        if (sel) sel.value = "";
        applySimFocusMode();
        saveSession();
      }
      wrap.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
  });
}

function isSimChartCollapsed(tkr) {
  if (state.simCollapseState && Object.prototype.hasOwnProperty.call(state.simCollapseState, tkr)) {
    return !!state.simCollapseState[tkr];
  }
  return true;
}

function setSimChartCollapsed(tkr, collapsed) {
  if (!state.simCollapseState) state.simCollapseState = {};
  state.simCollapseState[tkr] = collapsed;
  saveSession();
}

function applySimFocusMode() {
  const layout = document.getElementById("sim-path-layout");
  const focus = state.simFocusTicker || "";
  if (layout) layout.classList.toggle("sim-focus-mode", !!focus);
  document.querySelectorAll(".path-chart-wrap").forEach(w => {
    const tkr = w.id.replace("path-wrap-", "");
    w.classList.toggle("sim-focused", focus === tkr);
  });
}

function populateSimFocusSelect(tickers) {
  const sel = document.getElementById("sim-focus-select");
  if (!sel) return;
  const cur = state.simFocusTicker || "";
  sel.innerHTML = '<option value="">All tickers</option>' + tickers.map(t =>
    `<option value="${t}"${t === cur ? " selected" : ""}>${t}</option>`
  ).join("");
}

function wireSimPathToolbar(tickers) {
  const expandBtn = document.getElementById("btn-sim-expand-all");
  const collapseBtn = document.getElementById("btn-sim-collapse-all");
  if (expandBtn && !expandBtn.dataset.wired) {
    expandBtn.dataset.wired = "1";
    expandBtn.addEventListener("click", () => {
      document.querySelectorAll(".path-chart-wrap").forEach(w => {
        const t = w.id.replace("path-wrap-", "");
        w.classList.remove("collapsed");
        setSimChartCollapsed(t, false);
      });
    });
  }
  if (collapseBtn && !collapseBtn.dataset.wired) {
    collapseBtn.dataset.wired = "1";
    collapseBtn.addEventListener("click", () => {
      document.querySelectorAll(".path-chart-wrap").forEach(w => {
        const t = w.id.replace("path-wrap-", "");
        w.classList.add("collapsed");
        setSimChartCollapsed(t, true);
      });
    });
  }
  const sel = document.getElementById("sim-focus-select");
  if (sel && !sel.dataset.wired) {
    sel.dataset.wired = "1";
    sel.addEventListener("change", () => {
      state.simFocusTicker = sel.value || null;
      applySimFocusMode();
      saveSession();
      if (state.simFocusTicker) {
        const wrap = document.getElementById(`path-wrap-${state.simFocusTicker}`);
        wrap?.classList.remove("collapsed");
        setSimChartCollapsed(state.simFocusTicker, false);
        wrap?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  }
}

function renderTickerPathCharts(paths, tickerStats) {
  const container = document.getElementById("ticker-path-charts");
  const layout = document.getElementById("sim-path-layout");
  const nav = document.getElementById("sim-ticker-nav");
  container.innerHTML = "";
  if (nav) nav.innerHTML = "";
  if (!paths) {
    if (layout) layout.hidden = true;
    return;
  }
  if (layout) layout.hidden = false;

  const entries = Object.entries(paths).sort((a, b) => a[0].localeCompare(b[0]));
  if (nav) {
    nav.innerHTML = entries.map(([tkr], i) =>
      `<button type="button" data-sim-nav="${tkr}" class="${i === 0 ? "active" : ""}">${tkr}</button>`
    ).join("");
  }

  for (const [tkr, pd] of entries) {
    const stats = tickerStats[tkr] || {};
    const canvasId = `path-${tkr}`;
    const model = pd.model === "merton" ? "Merton JD" : "GBM";
    const modelColor = pd.model === "merton" ? "#ffb74d" : "#81c784";
    const probProfit = stats.prob_profit != null ? ` · P(profit): ${stats.prob_profit}%` : "";
    const wrapper = document.createElement("div");
    wrapper.className = "outer path-chart-wrap";
    wrapper.id = `path-wrap-${tkr}`;
    if (isSimChartCollapsed(tkr)) wrapper.classList.add("collapsed");
    const shares = pd.shares || 0;
    const adjBasis = pd.adjCost ? ` (adj $${pd.adjCost.toFixed(2)})` : "";
    const sharesInfo = shares ? ` · ${shares > 0 ? "+" : ""}${shares}sh${adjBasis}` : "";

    wrapper.innerHTML = `<div class="path-chart-hdr" data-toggle-path="${tkr}">
        <div style="font-weight:500;font-size:14px;font-family:var(--mono)">
          <span class="sim-ticker-link" data-ticker="${tkr}" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:3px">${tkr}</span>
          <span style="color:${modelColor};font-size:11px;font-weight:400"> [${model}]</span>
          <span style="color:var(--tx3);font-size:11px;font-weight:400"> · $${stats.price || "?"} · IV ${stats.iv || "?"}%${sharesInfo}${probProfit}</span>
        </div>
        <span style="display:flex;align-items:center;gap:8px">
          ${chartExportBtn(canvasId, `sim-path-${tkr}`)}
          <span style="font-size:11px;color:var(--tx3)">${stats.reason || ""} ▾</span>
        </span>
      </div>
      <div class="path-chart-body"><canvas id="${canvasId}" height="220"></canvas></div>`;
    container.appendChild(wrapper);
    destroyChart(canvasId);

    wrapper.querySelector(`[data-toggle-path="${tkr}"]`)?.addEventListener("click", (e) => {
      if (e.target.closest(".sim-ticker-link")) return;
      wrapper.classList.toggle("collapsed");
      setSimChartCollapsed(tkr, wrapper.classList.contains("collapsed"));
    });

    const { yMin, yMax } = estimatePathChartYRange(pd);
    const lineItems = [];
    (pd.strikes || []).forEach((s, i) => {
      const isEquity = s.isEquity || s.lineType === "basis";
      lineItems.push({
        key: `strike_${i}`,
        y: s.strike,
        content: s.label,
        kind: isEquity ? "equity" : "strike",
      });
    });
    (pd.breakevens || []).forEach((b, i) => {
      lineItems.push({
        key: `be_${i}`,
        y: b.value,
        content: b.label,
        kind: b.beType || "standard",
      });
    });
    const annotations = buildHorizontalLineAnnotations(lineItems, yMin, yMax, (item) => {
      if (item.kind === "equity") return { borderColor: "rgba(255,255,255,0.5)", borderDash: [2, 4], color: "#aaaaaa" };
      if (item.kind === "strike") return { borderColor: "rgba(255,221,87,0.8)", borderDash: [4, 4], color: "#ffdd57" };
      if (item.kind === "expire") return { borderColor: "rgba(100,200,255,0.9)", borderDash: [8, 4], color: "#64c8ff", borderWidth: 2 };
      if (item.kind === "scenario") return { borderColor: "rgba(255,183,77,0.85)", borderDash: [5, 3], color: "#ffb74d" };
      return { borderColor: "rgba(136,232,138,0.8)", borderDash: [5, 3], color: "#88e88a" };
    });
    // Event overlays (#8)
    const tkrEvents = state.events?.[tkr] || [];
    tkrEvents.forEach((ev, i) => {
      const evDate = new Date(ev.date);
      const today = new Date();
      const dayOffset = Math.ceil((evDate - today) / 86400000);
      const totalDays = pd.dates.length;
      if (dayOffset > 0 && dayOffset < totalDays) {
        const chartIdx = Math.min(Math.round(dayOffset / totalDays * pd.dates.length), pd.dates.length - 1);
        annotations[`event_${i}`] = { type: "line", xMin: chartIdx, xMax: chartIdx, borderColor: ev.type === "earnings" ? "rgba(255,255,100,0.6)" : "rgba(100,200,255,0.6)", borderWidth: 1.5, borderDash: [2, 2], label: { display: true, content: `📅 ${ev.label}`, position: "start", backgroundColor: "rgba(30,30,28,0.85)", color: "#ffff64", font: { size: 9, family: "JetBrains Mono" }, padding: 3 } };
      }
    });

    const bandColor = pd.model === "merton" ? "255,183,77" : "76,175,80";
    chartInstances[canvasId] = new Chart(document.getElementById(canvasId), {
      type: "line", data: { labels: pd.dates, datasets: [
        { label: "P95", data: pd.p95, fill: false, borderColor: `rgba(${bandColor},0.3)`, borderWidth: 1, borderDash: [3,3], pointRadius: 0, tension: 0.3 },
        { label: "P5", data: pd.p5, fill: "-1", backgroundColor: `rgba(${bandColor},0.08)`, borderColor: `rgba(${bandColor},0.3)`, borderWidth: 1, borderDash: [3,3], pointRadius: 0, tension: 0.3 },
        { label: "P75", data: pd.p75, fill: false, borderColor: `rgba(${bandColor},0.5)`, borderWidth: 1, pointRadius: 0, tension: 0.3 },
        { label: "P25", data: pd.p25, fill: "-1", backgroundColor: `rgba(${bandColor},0.15)`, borderColor: `rgba(${bandColor},0.5)`, borderWidth: 1, pointRadius: 0, tension: 0.3 },
        { label: "Median", data: pd.p50, fill: false, borderColor: "#ffffff", borderWidth: 2, pointRadius: 0, tension: 0.3 },
        { label: "Mean", data: pd.mean, fill: false, borderColor: "#f5c518", borderWidth: 1.5, borderDash: [5,3], pointRadius: 0, tension: 0.3 },
      ] },
      options: deepMergeChartOpts(chartInteractionDefaults(), {
        responsive: true,
        plugins: { legend: { display: false }, annotation: { annotations } },
        scales: {
          x: { ticks: { maxTicksLimit: 8, color: "#9b9b96", font: { size: 9 } }, grid: { color: "rgba(255,255,255,0.03)" } },
          y: { ticks: { callback: v => "$" + v.toFixed(2), color: "#9b9b96", font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.05)" } },
        },
      }),
    });
    // Ensure chart has layout dimensions even when section starts collapsed
    if (wrapper.classList.contains("collapsed")) {
      wrapper.classList.remove("collapsed");
      chartInstances[canvasId]?.resize?.();
      wrapper.classList.add("collapsed");
    }
  }

  wireSimTickerNav();
  setupSimNavScrollSpy();

  const tickers = entries.map(([tkr]) => tkr);
  populateSimFocusSelect(tickers);
  wireSimPathToolbar(tickers);
  applySimFocusMode();

  container.querySelectorAll(".sim-ticker-link").forEach(el => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const tkr = el.dataset.ticker;
      switchToTab("positions");
      setTimeout(() => {
        const target = document.querySelector(`.tk-block[data-ticker="${tkr}"]`);
        if (target) {
          const stickyEl = document.getElementById("dashboard-sticky");
          const stickyH = stickyEl ? stickyEl.offsetHeight : 0;
          const offset = 56 + stickyH + 10;
          const y = target.getBoundingClientRect().top + window.scrollY - offset;
          window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
          target.style.outline = "2px solid var(--accent)";
          target.style.outlineOffset = "-2px";
          setTimeout(() => { target.style.outline = ""; target.style.outlineOffset = ""; }, 2500);
        }
      }, 250);
    });
  });

  wireSimJumpNav();
}

function scrollSimSection(id) {
  const el = document.getElementById(id);
  if (!el || el.hidden) return;
  const topBar = document.querySelector(".top-bar");
  const offset = (topBar?.offsetHeight || 56) + 12;
  const y = el.getBoundingClientRect().top + window.scrollY - offset;
  window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
}

function wireSimJumpNav() {
  const top = document.getElementById("sim-results-top");
  const nav = document.getElementById("sim-jump-nav");
  if (!top || !nav) return;
  nav.hidden = false;
  nav.querySelectorAll("[data-sim-jump]").forEach(btn => {
    const target = document.getElementById(btn.dataset.simJump);
    btn.hidden = !!(target && target.hidden);
  });
  if (top.dataset.jumpWired) return;
  top.dataset.jumpWired = "1";
  top.addEventListener("click", (e) => {
    const btn = (e.target as Element).closest("[data-sim-jump]") as HTMLElement | null;
    if (!btn) return;
    scrollSimSection(btn.dataset.simJump!);
  });
}

