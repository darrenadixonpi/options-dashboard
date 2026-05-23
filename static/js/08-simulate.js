// ═══════════════════════════════════════════════════════════════════════════
// Simulation
// ═══════════════════════════════════════════════════════════════════════════

function enableSimButton() {
  document.getElementById("btn-simulate").disabled = !state.positions.length;
  const inlineSection = document.getElementById("dashboard-sim-section");
  if (inlineSection && state.marketData && state.positions.length) inlineSection.hidden = false;
}

async function runSimulation(btn, logEl) {
  if (!state.positions.length) return;
  btn.disabled = true;
  btn.innerHTML = "<span>⏳</span> <span>Simulating...</span>";
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

function renderSimResults(data) {
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
  document.getElementById("sim-summary").innerHTML = `
    <div class="stat"><div class="stat-label">P(Profit)</div><div class="stat-val">${p.prob_profit}%</div></div>
    <div class="stat"><div class="stat-label">Mean P&L</div><div class="stat-val">${fmtDollar(p.mean)}</div></div>
    <div class="stat"><div class="stat-label">Median P&L</div><div class="stat-val">${fmtDollar(p.median)}</div></div>
    <div class="stat"><div class="stat-label">5th / 95th</div><div class="stat-val" style="font-size:16px">${fmtDollar(p.p5)} / ${fmtDollar(p.p95)}</div></div>`;

  // Portfolio histogram
  const h = data.histogram;
  const hMids = h.edges.slice(0,-1).map((e,i) => (e+h.edges[i+1])/2);
  const hLabels = hMids.map(m => fmtDollar(m));
  const hColors = hMids.map(m => m>=0 ? "rgba(76,175,80,0.7)" : "rgba(239,83,80,0.7)");
  function closestIdx(val) { let best=0, bestD=Infinity; for(let i=0;i<hMids.length;i++){const d=Math.abs(hMids[i]-val);if(d<bestD){bestD=d;best=i;}} return best; }
  const statLines = [
    {id:"p5_line",val:p.p5,color:"#ef5350",label:`P5: ${fmtDollar(p.p5)}`,pos:"end"},
    {id:"mean_line",val:p.mean,color:"#f5c518",label:`Mean: ${fmtDollar(p.mean)}`,pos:"start"},
    {id:"med_line",val:p.median,color:"#ffffff",label:`Median: ${fmtDollar(p.median)}`,pos:"end"},
    {id:"p95_line",val:p.p95,color:"#66bb6a",label:`P95: ${fmtDollar(p.p95)}`,pos:"start"},
  ];
  const annotations = {};
  for(const s of statLines) annotations[s.id]={type:"line",xMin:closestIdx(s.val),xMax:closestIdx(s.val),borderColor:s.color,borderWidth:1.5,borderDash:[4,3],label:{display:true,content:s.label,position:s.pos,yAdjust:0,backgroundColor:"rgba(30,30,28,0.85)",color:s.color,font:{size:9,family:"JetBrains Mono"},padding:3}};

  chartInstances["chart-portfolio"] = new Chart(document.getElementById("chart-portfolio"), {
    type:"bar", data:{labels:hLabels,datasets:[{data:h.counts,backgroundColor:hColors,borderWidth:0}]},
    options:{responsive:true,animation:false,plugins:{legend:{display:false},annotation:{annotations}},scales:{x:{ticks:{maxTicksLimit:10,color:"#9b9b96",font:{size:10}},grid:{display:false}},y:{ticks:{color:"#9b9b96",font:{size:10}},grid:{color:"rgba(255,255,255,0.05)"}}}}
  });
  document.getElementById("portfolio-stats").innerHTML = `Mean: ${fmtDollar(p.mean)} · Median: ${fmtDollar(p.median)} · P5: ${fmtDollar(p.p5)} · P95: ${fmtDollar(p.p95)} · P(profit): ${p.prob_profit}% · ${data.n_paths?.toLocaleString()} paths${data.correlation ? " · correlated" : ""} · intrinsic at expiry, flat IV per ticker`;

  // Per-ticker chart
  destroyChart("chart-tickers");
  const tickers = Object.keys(data.by_ticker).sort((a,b) => data.by_ticker[a].median - data.by_ticker[b].median);
  chartInstances["chart-tickers"] = new Chart(document.getElementById("chart-tickers"), {
    type:"bar", data:{labels:tickers.map(t => `${t} (${data.by_ticker[t].model==="merton"?"JD":"GBM"})`),datasets:[{data:tickers.map(t=>data.by_ticker[t].median),backgroundColor:tickers.map(t=>data.by_ticker[t].median>=0?"rgba(76,175,80,0.7)":"rgba(239,83,80,0.7)"),borderWidth:0}]},
    options:{indexAxis:"y",responsive:true,plugins:{legend:{display:false}},scales:{x:{ticks:{callback:v=>fmtDollar(v),color:"#9b9b96",font:{size:10}},grid:{color:"rgba(255,255,255,0.05)"}},y:{ticks:{color:"#e8e8e4",font:{size:11,family:"'JetBrains Mono'"}},grid:{display:false}}}}
  });

  // Strategy chart
  destroyChart("chart-strategies");
  const strats = Object.keys(data.by_strategy).sort((a,b) => data.by_strategy[a].prob_profit - data.by_strategy[b].prob_profit);
  chartInstances["chart-strategies"] = new Chart(document.getElementById("chart-strategies"), {
    type:"bar", data:{labels:strats,datasets:[{data:strats.map(s=>data.by_strategy[s].prob_profit),backgroundColor:strats.map(s=>data.by_strategy[s].prob_profit>=50?"rgba(76,175,80,0.7)":"rgba(239,83,80,0.7)"),borderWidth:0}]},
    options:{indexAxis:"y",responsive:true,plugins:{legend:{display:false}},scales:{x:{min:0,max:100,ticks:{callback:v=>v+"%",color:"#9b9b96",font:{size:10}},grid:{color:"rgba(255,255,255,0.05)"}},y:{ticks:{color:"#e8e8e4",font:{size:10,family:"'JetBrains Mono'"}},grid:{display:false}}}}
  });

  // Correlation heatmap (#10)
  if (data.correlation) renderCorrelationHeatmap(data.correlation);

  // Theta charts
  if (data.theta) renderThetaCharts(data.theta);

  // Ticker path charts
  renderTickerPathCharts(data.ticker_paths, data.by_ticker);
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
// Theta Charts (unchanged from original)
// ═══════════════════════════════════════════════════════════════════════════

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
  const datasets = theta.groups.map(g => ({ label: g.label, data: g.daily.map(v => Math.max(v, 0)), backgroundColor: g.color + "DD", borderWidth: 0, fill: true }));
  chartInstances["chart-theta-daily"] = new Chart(document.getElementById("chart-theta-daily"), {
    type: "bar", data: { labels: theta.dates, datasets },
    options: { responsive: true, animation: false, plugins: { legend: { display: true, position: "top", labels: { color: "#e8e8e4", font: { size: 10 }, boxWidth: 12, padding: 8 } } },
      scales: { x: { stacked: true, ticks: { maxTicksLimit: 12, color: "#9b9b96", font: { size: 9 } }, grid: { display: false } }, y: { stacked: true, ticks: { callback: v => "$" + v.toFixed(0), color: "#9b9b96", font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.05)" } } } }
  });

  destroyChart("chart-theta-cumul");
  const msAnnotations = {};
  const totalMs = (theta.milestones || []).length;
  (theta.milestones || []).forEach((m, i) => {
    // Alternate above/below for consecutive labels
    const above = i % 2 === 0;
    // For closely-spaced early milestones, shift them apart
    let xAdj = 0;
    if (i > 0 && totalMs > 2) {
      const prevIdx = theta.milestones[i-1].index;
      const gap = m.index - prevIdx;
      if (gap < 20) xAdj = above ? 15 : -15; // nudge apart when close
    }
    msAnnotations[`ms_${i}`] = { type: "point", xValue: m.index, yValue: m.value, backgroundColor: "#ffffff", borderColor: "#20c7c7", borderWidth: 2, radius: 4 };
    msAnnotations[`ms_label_${i}`] = {
      type: "label", xValue: m.index, yValue: m.value,
      content: `${m.date}: $${m.value.toLocaleString()}`,
      position: "center",
      backgroundColor: "rgba(30,30,28,0.92)", color: "#ffffff",
      font: { size: 9, family: "JetBrains Mono" }, padding: { x: 4, y: 2 },
      xAdjust: xAdj, yAdjust: above ? -20 : 20,
    };
  });
  chartInstances["chart-theta-cumul"] = new Chart(document.getElementById("chart-theta-cumul"), {
    type: "line", data: { labels: theta.dates, datasets: [
      { label: "Earned (short options)", data: theta.cumulative, borderColor: "#20c7c7", borderWidth: 2, backgroundColor: "rgba(32,199,199,0.1)", fill: true, pointRadius: 0, tension: 0.2 },
      { label: "Net (incl. long option cost)", data: theta.cumulativeNet, borderColor: "rgba(150,150,150,0.6)", borderWidth: 1.5, borderDash: [5, 3], fill: false, pointRadius: 0, tension: 0.2 },
    ] },
    options: { responsive: true, animation: false,
      layout: { padding: { left: 5, right: 15, top: 10, bottom: 5 } },
      plugins: { legend: { display: true, position: "top", labels: { color: "#e8e8e4", font: { size: 10 }, boxWidth: 12, padding: 8 } }, annotation: { annotations: msAnnotations, clip: false } },
      scales: { x: { ticks: { maxTicksLimit: 12, color: "#9b9b96", font: { size: 9 } }, grid: { display: false } }, y: { ticks: { callback: v => "$" + v.toLocaleString(), color: "#9b9b96", font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.05)" }, min: 0 } } }
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
      const nav = document.getElementById("sim-ticker-nav");
      nav?.querySelectorAll("[data-sim-nav]").forEach(b => {
        b.classList.toggle("active", b.dataset.simNav === tkr);
      });
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

    const annotations = {};
    (pd.strikes || []).forEach((s, i) => {
      const isEquity = s.isEquity || s.lineType === "basis";
      annotations[`strike_${i}`] = { type: "line", yMin: s.strike, yMax: s.strike, borderColor: isEquity ? "rgba(255,255,255,0.5)" : "rgba(255,221,87,0.8)", borderWidth: 1, borderDash: isEquity ? [2, 4] : [4, 4], label: { display: true, content: s.label, position: "start", backgroundColor: "rgba(30,30,28,0.8)", color: isEquity ? "#aaaaaa" : "#ffdd57", font: { size: 10, family: "JetBrains Mono" }, padding: 3 } };
    });
    const bePositions = ["start", "end", "start", "end", "start"];
    (pd.breakevens || []).forEach((b, i) => {
      const colors = { expire: { border: "rgba(100,200,255,0.9)", text: "#64c8ff" }, scenario: { border: "rgba(255,183,77,0.85)", text: "#ffb74d" }, standard: { border: "rgba(136,232,138,0.8)", text: "#88e88a" } };
      const c = colors[b.beType] || colors.standard;
      annotations[`be_${i}`] = { type: "line", yMin: b.value, yMax: b.value, borderColor: c.border, borderWidth: b.beType === "expire" ? 2 : 1.5, borderDash: b.beType === "expire" ? [8, 4] : [5, 3], label: { display: true, content: b.label, position: bePositions[i % bePositions.length], backgroundColor: "rgba(30,30,28,0.85)", color: c.text, font: { size: 9, family: "JetBrains Mono" }, padding: 3 } };
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
      options: { responsive: true, interaction: { mode: "index", intersect: false }, plugins: { legend: { display: false }, annotation: { annotations } },
        scales: { x: { ticks: { maxTicksLimit: 8, color: "#9b9b96", font: { size: 9 } }, grid: { color: "rgba(255,255,255,0.03)" } }, y: { ticks: { callback: v => "$" + v.toFixed(2), color: "#9b9b96", font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.05)" } } } }
    });
  }

  if (nav) {
    nav.querySelectorAll("[data-sim-nav]").forEach(btn => {
      btn.addEventListener("click", () => {
        nav.querySelectorAll("[data-sim-nav]").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        const wrap = document.getElementById(`path-wrap-${btn.dataset.simNav}`);
        if (wrap) {
          wrap.classList.remove("collapsed");
          setSimChartCollapsed(btn.dataset.simNav, false);
          wrap.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      });
    });
    setupSimNavScrollSpy();
  }

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
  const nav = document.getElementById("sim-jump-nav");
  if (!nav) return;
  nav.hidden = false;
  nav.querySelectorAll("[data-sim-jump]").forEach(btn => {
    const target = document.getElementById(btn.dataset.simJump);
    btn.hidden = !!(target && target.hidden);
  });
  if (nav.dataset.wired) return;
  nav.dataset.wired = "1";
  nav.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-sim-jump]");
    if (!btn) return;
    scrollSimSection(btn.dataset.simJump);
  });
}

