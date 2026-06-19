// ═══════════════════════════════════════════════════════════════════════════
// Risk Tab (#14, #16, #17)
// ═══════════════════════════════════════════════════════════════════════════

const RISK_MAX_DAYS_FWD = 730;

function formatRiskDaysLabel(days) {
  const d = parseInt(days, 10) || 0;
  if (d === 0) return "0 (today)";
  if (d >= 365) return `${d} (~${(d / 365).toFixed(1)}y)`;
  return `${d}d`;
}

function getPositionExpiryCheckpoints(maxDays = RISK_MAX_DAYS_FWD) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const byDate = new Map();
  for (const p of getMergedPositions()) {
    if (!p.expiry || p.posType === "equity") continue;
    const exp: Date = (p.expiry as any) instanceof Date ? (p.expiry as any) : new Date(p.expiry as any);
    if (Number.isNaN(exp.getTime())) continue;
    const key = dateKey(exp);
    const days = Math.ceil((exp.getTime() - today.getTime()) / 86400000);
    if (days < 0 || days > maxDays) continue;
    if (!byDate.has(key)) {
      byDate.set(key, { date: key, days, tickers: new Set(), legs: 0 });
    }
    const row = byDate.get(key);
    row.tickers.add(p.ticker);
    row.legs += Math.abs(p.contracts || 0);
  }
  return [...byDate.values()].sort((a, b) => a.days - b.days);
}

function setRiskDaysForward(days, reload = false) {
  const slider = document.getElementById("risk-days-slider") as HTMLInputElement | null;
  const label = document.getElementById("risk-days-label");
  const d = Math.max(0, Math.min(RISK_MAX_DAYS_FWD, parseInt(days, 10) || 0));
  if (slider) slider.value = String(d);
  if (label) label.textContent = formatRiskDaysLabel(d);
  document.querySelectorAll(".risk-expiry-chip").forEach(btn => {
    btn.classList.toggle("active", parseInt((btn as HTMLElement).dataset.days, 10) === d);
  });
  const spot = document.querySelector('.risk-expiry-chip[data-days="0"]');
  if (spot) spot.classList.toggle("active", d === 0);
  if (reload) {
    state.riskMatrixLoaded = false;
    loadRiskMatrix();
  }
}

function renderRiskExpiryCheckpoints() {
  const el = document.getElementById("risk-expiry-checkpoints");
  if (!el) return;
  const points = getPositionExpiryCheckpoints();
  if (!points.length) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.hidden = false;
  let html = `<button type="button" class="risk-expiry-chip" data-days="0" title="Today">Today</button>`;
  for (const pt of points) {
    const tickers = [...pt.tickers].sort().slice(0, 3).join(", ");
    const more = pt.tickers.size > 3 ? ` +${pt.tickers.size - 3}` : "";
    const shortDate = pt.date.slice(5);
    html += `<button type="button" class="risk-expiry-chip" data-days="${pt.days}" title="${pt.date} · ${pt.legs} leg(s) · ${[...pt.tickers].sort().join(", ")}">${shortDate} · ${pt.days}d · ${tickers}${more}</button>`;
  }
  el.innerHTML = html;
  el.querySelectorAll(".risk-expiry-chip").forEach(btn => {
    btn.addEventListener("click", () => setRiskDaysForward((btn as HTMLElement).dataset.days, true));
  });
  const cur = parseInt((document.getElementById("risk-days-slider") as HTMLInputElement | null)?.value, 10) || 0;
  setRiskDaysForward(cur, false);
}

function enableRiskTab() {
  if (!state.marketData || !state.positions.length) return;
  document.getElementById("risk-empty").hidden = true;
  document.getElementById("risk-content").hidden = false;
  renderWhatIfList();
  if (state.hypothetical.length) applyWhatIfGreeks();

  const tickers = [...new Set(state.positions.map(p => p.ticker))].sort();
  const wiT = document.getElementById("wi-ticker") as HTMLInputElement | null;
  if (wiT && !wiT.value && tickers.length) wiT.placeholder = tickers[0];
  const sel = document.getElementById("vol-surface-ticker");
  sel.innerHTML = tickers.map(t => `<option value="${t}">${t}</option>`).join("");

  renderRiskExpiryCheckpoints();

  // Risk summary
  if (state.greeks?.risk) {
    const r: any = state.greeks.risk;
    document.getElementById("risk-summary").innerHTML = `
      <div class="stat" style="border-left:3px solid var(--err-tx)"><div class="stat-label">Total Max Loss</div><div class="stat-val" style="font-size:18px;color:var(--err-tx)">$${r.totalMaxLoss.toLocaleString()}</div></div>
      <div class="stat" style="border-left:3px solid var(--warn-tx)"><div class="stat-label" title="Reg-T margin estimate: Short puts use min(naked formula, cash-secured). Covered calls need no extra margin. See hover for details.">Est. Margin</div><div class="stat-val" style="font-size:18px;color:var(--warn-tx)">$${r.totalMargin.toLocaleString()}</div><div style="font-size:9px;color:var(--tx3);margin-top:2px">Reg-T estimate</div></div>`;
  }
}

async function loadRiskMatrix() {
  if (!state.marketData || !state.positions.length) return;
  const btn = document.getElementById("btn-risk-matrix") as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; btn.textContent = "Loading..."; }
  const daysFwd = parseInt((document.getElementById("risk-days-slider") as HTMLInputElement | null)?.value) || 0;
  document.getElementById("risk-matrix-body").innerHTML = '<div style="color:var(--tx3);font-size:12px">Computing scenario grid...</div>';
  try {
    const hypoNote = state.hypothetical.length ? ` (incl. ${state.hypothetical.length} what-if leg(s))` : "";
    const fwdNote = daysFwd > 0 ? ` +${daysFwd}d forward (${formatRiskDaysLabel(daysFwd).replace(/ \(.*\)/, "")}).` : "";
    document.getElementById("risk-matrix-caption").textContent =
      `Theoretical BS P&L vs entry cost (avg fill), not broker MTM. IV shocks are absolute vol points.${fwdNote}${hypoNote}`;

    const { ok, data } = await fetchJson("/api/risk-matrix", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        positions: getMergedPositions(),
        hypothetical: [],
        marketData: state.marketData, daysForward: daysFwd,
      })
    });
    if (!ok || data.error) {
      document.getElementById("risk-matrix-body").innerHTML = `<div class="error-box">${esc(data.error || "Risk matrix failed")}</div>`;
    } else {
      renderRiskMatrix(data);
      state.lastRiskMatrix = data;
      state.riskMatrixLoaded = true;
      renderPositionsRail();
    }

    const tickers = [...new Set(state.positions.map(p => p.ticker))].sort();
    try {
      const uaRes = await fetch("/api/unusual-activity", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({tickers}) });
      renderUnusualActivity(await uaRes.json());
    } catch (e) {}

    const firstTicker = (document.getElementById("vol-surface-ticker") as HTMLSelectElement | null)?.value;
    if (firstTicker) loadVolSurface(firstTicker);
  } catch (e) {
    document.getElementById("risk-matrix-body").innerHTML = `<div class="error-box">${e.message}</div>`;
  }
  if (btn) { btn.disabled = false; btn.textContent = "Reload"; }
}

document.getElementById("btn-risk-matrix")?.addEventListener("click", () => { state.riskMatrixLoaded = false; loadRiskMatrix(); });

document.getElementById("risk-days-slider")?.addEventListener("change", () => {
  setRiskDaysForward((document.getElementById("risk-days-slider") as HTMLInputElement | null)?.value, true);
});
document.getElementById("risk-days-slider")?.addEventListener("input", (e) => {
  setRiskDaysForward((e.target as HTMLInputElement).value, false);
});

document.getElementById("vol-surface-ticker")?.addEventListener("change", (e) => { loadVolSurface((e.target as HTMLSelectElement).value); });

function renderRiskMatrix(data) {
  const { priceSteps, ivSteps, grid } = data;
  if (!grid || !grid.length) {
    document.getElementById("risk-matrix-body").innerHTML = '<div style="color:var(--tx3);font-size:12px">No risk matrix data available.</div>';
    return;
  }
  const allVals = grid.flat();
  const maxAbs = Math.max(Math.abs(Math.min(...allVals)), Math.abs(Math.max(...allVals))) || 1;

  let html = '<table class="risk-tbl"><tr><th>IV \\ Price</th>';
  for (const ps of priceSteps) {
    const isSpot = ps === 0;
    html += isSpot
      ? `<th style="background:var(--accent-bg);color:var(--accent);font-weight:600">Current</th>`
      : `<th>${ps > 0 ? "+" : ""}${ps}%</th>`;
  }
  html += '</tr>';
  for (let i = 0; i < ivSteps.length; i++) {
    const isSpotRow = ivSteps[i] === 0;
    html += isSpotRow
      ? `<tr><th style="background:var(--accent-bg);color:var(--accent);font-weight:600">Current</th>`
      : `<tr><th>${ivSteps[i] > 0 ? "+" : ""}${ivSteps[i]}pt</th>`;
    for (let j = 0; j < priceSteps.length; j++) {
      const val = grid[i][j];
      const intensity = val / maxAbs;
      const bg = val >= 0 ? `rgba(76,175,80,${Math.min(Math.abs(intensity) * 0.8, 0.8)})` : `rgba(239,83,80,${Math.min(Math.abs(intensity) * 0.8, 0.8)})`;
      const isCenter = priceSteps[j] === 0 && ivSteps[i] === 0;
      const isSpotAxis = priceSteps[j] === 0 || ivSteps[i] === 0;
      const outline = isCenter ? "outline:2px solid #fff;outline-offset:-2px;font-weight:600;" : "";
      const axisBg = isSpotAxis && !isCenter ? "box-shadow:inset 0 0 0 1px rgba(32,199,199,0.25);" : "";
      html += `<td style="background:${bg};${outline}${axisBg}" title="${isCenter ? "Current spot & IV" : ""}">${fmtDollar(val)}</td>`;
    }
    html += '</tr>';
  }
  html += '</table>';
  document.getElementById("risk-matrix-body").innerHTML = html;
}

function renderUnusualActivity(data) {
  if (!data.alerts?.length) {
    document.getElementById("unusual-section").hidden = false;
    document.getElementById("unusual-body").innerHTML = '<div style="color:var(--tx3);font-size:12px">No unusual activity detected in your tickers (volume/OI ratio < 2×).</div>';
    return;
  }
  document.getElementById("unusual-section").hidden = false;
  // Sort by ratio descending (should already be sorted from backend, but ensure)
  const sorted = [...data.alerts].sort((a, b) => b.ratio - a.ratio);
  let html = '<div style="font-size:11px;color:var(--tx3);margin-bottom:10px">Options contracts where today\'s volume exceeds 2× open interest — may signal large directional bets, hedging, or informed trading. Sorted by Vol/OI ratio.</div>';
  html += '<div style="max-height:350px;overflow-y:auto"><table class="hist-tbl"><thead style="position:sticky;top:0;background:var(--bg);z-index:1"><tr><th>Ticker</th><th>Expiry</th><th>Strike</th><th>Type</th><th>Volume</th><th>OI</th><th>Vol/OI</th></tr></thead><tbody>';
  for (const a of sorted) {
    const ratioColor = a.ratio >= 5 ? "var(--err-tx)" : a.ratio >= 3 ? "var(--warn-tx)" : "var(--tx2)";
    html += `<tr><td>${a.ticker}</td><td>${a.expiry}</td><td>$${a.strike}</td><td>${a.optType}</td><td style="color:var(--warn-tx)">${a.volume.toLocaleString()}</td><td>${a.openInterest.toLocaleString()}</td><td style="color:${ratioColor};font-weight:500">${a.ratio}x</td></tr>`;
  }
  html += '</tbody></table></div>';
  html += `<div style="font-size:10px;color:var(--tx3);margin-top:6px">${sorted.length} contracts flagged</div>`;
  document.getElementById("unusual-body").innerHTML = html;
}

async function loadVolSurface(ticker) {
  const container = document.getElementById("vol-surface-container");
  const scrollY = window.scrollY;
  container.hidden = false;
  const canvas = document.getElementById("chart-vol-surface");
  const existingMsg = document.getElementById("vol-surface-msg");
  if (existingMsg) existingMsg.remove();
  try {
    const res = await fetch(`/api/vol-surface/${ticker}`);
    const data = await res.json();
    if (data.error) {
      canvas.style.display = "none";
      canvas.insertAdjacentHTML("afterend", `<div id="vol-surface-msg" style="color:var(--tx3);font-size:12px;padding:20px;text-align:center">Error loading vol surface: ${data.error}</div>`);
      window.scrollTo(0, scrollY);
      return;
    }
    renderVolSurface(data);
    window.scrollTo(0, scrollY);
  } catch(e) {
    canvas.style.display = "none";
    canvas.insertAdjacentHTML("afterend", `<div id="vol-surface-msg" style="color:var(--tx3);font-size:12px;padding:20px;text-align:center">Could not load vol surface for ${ticker}. The ticker may not have listed options.</div>`);
    window.scrollTo(0, scrollY);
  }
}

function renderVolSurface(data) {
  destroyChart("chart-vol-surface");
  const canvas = document.getElementById("chart-vol-surface");
  const existing = document.getElementById("vol-surface-msg");
  if (existing) existing.remove();
  canvas.style.display = "";

  if (!data.expiries?.length) {
    canvas.style.display = "none";
    const note = data.note || "No option chain data available. Try a different ticker.";
    canvas.insertAdjacentHTML("afterend", `<div id="vol-surface-msg" style="color:var(--tx3);font-size:12px;padding:20px;text-align:center">${data.ticker}: ${note}</div>`);
    return;
  }

  // Store data for re-rendering on toggle
  state._volSurfaceData = data;
  _renderVolSurfaceChart();
}

function _renderVolSurfaceChart() {
  const data = state._volSurfaceData;
  if (!data?.expiries?.length) return;
  destroyChart("chart-vol-surface");

  const activeBtn = document.querySelector("#vol-type-selector .broker-btn.active");
  const volType = (activeBtn as HTMLElement | null)?.dataset.voltype || "puts";

  const colors = ["#ef5350","#ff9800","#ffeb3b","#66bb6a","#42a5f5","#ab47bc","#ec407a","#26a69a"];
  const datasets = [];
  data.expiries.forEach((exp, i) => {
    const color = colors[i % colors.length];
    if (volType === "puts" || volType === "both") {
      const pts = exp.data.filter(d => d.optType === "Put").sort((a,b) => a.strike - b.strike);
      if (pts.length) datasets.push({ label: `${exp.expiry} P`, data: pts.map(p => ({ x: p.strike, y: p.impliedVolatility * 100 })), borderColor: color, borderWidth: 1.5, pointRadius: 2, tension: 0.3, fill: false, borderDash: [] });
    }
    if (volType === "calls" || volType === "both") {
      const cts = exp.data.filter(d => d.optType === "Call").sort((a,b) => a.strike - b.strike);
      if (cts.length) datasets.push({ label: `${exp.expiry} C`, data: cts.map(p => ({ x: p.strike, y: p.impliedVolatility * 100 })), borderColor: color, borderWidth: 1.5, pointRadius: 2, tension: 0.3, fill: false, borderDash: volType === "both" ? [4,3] : [] });
    }
  });

  if (!datasets.length) return;

  chartInstances["chart-vol-surface"] = new Chart(document.getElementById("chart-vol-surface"), {
    type: "line", data: { datasets },
    options: deepMergeChartOpts(chartInteractionDefaults(), { responsive: true, animation: false, plugins: { legend: { display: true, position: "top", labels: { color: "#e8e8e4", font: { size: 9 }, boxWidth: 12, padding: 6 } } },
      scales: { x: { type: "linear", title: { display: true, text: "Strike", color: "#9b9b96" }, ticks: { color: "#9b9b96", font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.05)" } },
        y: { title: { display: true, text: "IV %", color: "#9b9b96" }, ticks: { callback: v => v + "%", color: "#9b9b96", font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.05)" } } } }),
  });
}

// Vol type toggle
document.querySelectorAll("#vol-type-selector .broker-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#vol-type-selector .broker-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    if (state._volSurfaceData) _renderVolSurfaceChart();
  });
});

