import { dateKey, esc, shortDate } from "./02-portfolio";
import { chartInteractionDefaults, deepMergeChartOpts } from "./03-chart-utils";
import { chartInstances, destroyChart, renderPositionsRail, state } from "./04-state";
import { applyWhatIfGreeks, fetchJson, getMergedPositions, renderWhatIfList } from "./05-session-api";
import { fmtDollar } from "./08-simulate";
import { bsm } from "./14-greeks-lab";

// ═══════════════════════════════════════════════════════════════════════════
// Risk Tab (#14, #16, #17)
// ═══════════════════════════════════════════════════════════════════════════

export const RISK_MAX_DAYS_FWD = 730;

export function formatRiskDaysLabel(days) {
  const d = parseInt(days, 10) || 0;
  if (d === 0) return "0 (today)";
  if (d >= 365) return `${d} (~${(d / 365).toFixed(1)}y)`;
  return `${d}d`;
}

export function getPositionExpiryCheckpoints(maxDays = RISK_MAX_DAYS_FWD) {
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

export function setRiskDaysForward(days, reload = false) {
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

export function renderRiskExpiryCheckpoints() {
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

export function enableRiskTab() {
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

  loadRiskExposure();
  renderPortfolioShock();
}

// ── Portfolio market-shock (whole-book reprice vs a market move) ───────────
let _shockWired = false;
let _shockBetas: Record<string, number> = {};
function _shDte(expiry: any): number {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const exp = expiry ? (expiry instanceof Date ? expiry : new Date(expiry)) : null;
  return exp && !Number.isNaN(exp.getTime()) ? Math.max(0, Math.ceil((exp.getTime() - today.getTime()) / 86400000)) : 30;
}
function _shockPnlAt(movePct: number, daysFwd: number, betaOn: boolean): number {
  let pnl = 0;
  for (const p of (state.positions as any[])) {
    const m: any = (state.marketData as any)?.[p.ticker]; const spot = m?.price; if (!spot) continue;
    const ivDec = (m.iv || 30) / 100;
    const beta = betaOn ? (_shockBetas[p.ticker] ?? 1) : 1;
    const sS = spot * (1 + beta * movePct / 100);
    if (p.posType === "equity") {
      pnl += (p.shares || p.contracts || 0) * (sS - spot);
    } else {
      const dte0 = _shDte(p.expiry);
      const v0 = bsm(spot, p.strike, ivDec, dte0 / 365, p.optType).value;
      const v1 = bsm(sS, p.strike, ivDec, Math.max(0, dte0 - daysFwd) / 365, p.optType).value;
      pnl += (v1 - v0) * 100 * (p.contracts || 0);
    }
  }
  return pnl;
}
function _shockGreeks() {
  let delta = 0, dollarDelta = 0, theta = 0, vega = 0;
  for (const p of (state.positions as any[])) {
    const m: any = (state.marketData as any)?.[p.ticker]; const spot = m?.price; if (!spot) continue;
    const ivDec = (m.iv || 30) / 100;
    if (p.posType === "equity") {
      const q = p.shares || p.contracts || 0; delta += q; dollarDelta += q * spot;
    } else {
      const g = bsm(spot, p.strike, ivDec, _shDte(p.expiry) / 365, p.optType); const mult = 100 * (p.contracts || 0);
      delta += g.delta * mult; dollarDelta += g.delta * mult * spot;
      theta += g.theta * mult; vega += g.vega * mult;
    }
  }
  return { delta, dollarDelta, theta, vega };
}
async function _shockLoadBetas() {
  const tickers = [...new Set((state.positions as any[]).map(p => p.ticker))];
  const { ok, data } = await fetchJson("/api/risk/betas", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tickers }) });
  if (ok && data && data.betas) _shockBetas = data.betas;
  _drawShock();
}
function _drawShock() {
  const betaEl = document.getElementById("shock-beta") as HTMLInputElement | null;
  const moveEl = document.getElementById("shock-move") as HTMLInputElement | null;
  const daysEl = document.getElementById("shock-days") as HTMLInputElement | null;
  if (!moveEl || !daysEl) return;
  const betaOn = !!betaEl?.checked;
  const move = +moveEl.value, days = +daysEl.value;
  const mvl = document.getElementById("shock-move-val"); if (mvl) mvl.textContent = `${move >= 0 ? "+" : ""}${move}%`;
  const dvl = document.getElementById("shock-days-val"); if (dvl) dvl.textContent = `${days}d`;
  const xs: string[] = [], ys: number[] = []; let worst = 1e18, worstAt = 0, markerIdx = 0, best = 1e9, idx = 0;
  for (let mp = -25; mp <= 25.0001; mp += 1) {
    const pnl = _shockPnlAt(mp, days, betaOn); xs.push(`${mp}`); ys.push(pnl);
    if (pnl < worst) { worst = pnl; worstAt = mp; }
    if (Math.abs(mp - move) < best) { best = Math.abs(mp - move); markerIdx = idx; }
    idx++;
  }
  const pnlNow = _shockPnlAt(move, days, betaOn);
  const gk = _shockGreeks();
  const col = (v: number) => (v >= 0 ? "var(--ok-tx)" : "var(--err-tx)");
  const ro = document.getElementById("shock-readout");
  if (ro) ro.innerHTML = `
    <div class="stat"><div class="stat-label">P&L @ ${move >= 0 ? "+" : ""}${move}%</div><div class="stat-val" style="font-size:18px;color:${col(pnlNow)}">${fmtDollar(pnlNow)}</div></div>
    <div class="stat"><div class="stat-label">Net $Δ</div><div class="stat-val" style="font-size:16px;color:#90caf9">${fmtDollar(gk.dollarDelta)}</div><div class="stat-sub">${gk.delta.toFixed(0)} sh-eq</div></div>
    <div class="stat"><div class="stat-label">Net Θ /day</div><div class="stat-val" style="font-size:16px;color:#f5c518">${fmtDollar(gk.theta)}</div></div>
    <div class="stat"><div class="stat-label">Net Vega</div><div class="stat-val" style="font-size:16px;color:#4dd0e1">${fmtDollar(gk.vega)}</div></div>
    <div class="stat"><div class="stat-label">Worst in ±25%</div><div class="stat-val" style="font-size:16px;color:var(--err-tx)">${fmtDollar(worst)}</div><div class="stat-sub">at ${worstAt >= 0 ? "+" : ""}${worstAt}%</div></div>`;
  const canvas = document.getElementById("chart-shock");
  destroyChart("chart-shock");
  if (canvas) chartInstances["chart-shock"] = new Chart(canvas, {
    type: "line",
    data: { labels: xs, datasets: [{ label: "Book P&L ($)", data: ys, borderColor: "#20c7c7", backgroundColor: "transparent", borderWidth: 2, tension: 0.2, pointRadius: ys.map((_, i) => i === markerIdx ? 5 : 0), pointBackgroundColor: "#20c7c7", pointBorderColor: "#fff" }] },
    options: deepMergeChartOpts(chartInteractionDefaults(), {
      responsive: true, animation: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { title: (it: any) => `Market ${it[0]?.label}%`, label: (ctx: any) => `Book P&L: ${fmtDollar(ctx.parsed.y)}` } } },
      scales: {
        x: { title: { display: true, text: `Market move % (${betaOn ? "β-weighted" : "parallel"})`, color: "#9b9b96" }, ticks: { maxTicksLimit: 11, color: "#9b9b96", font: { size: 9 } }, grid: { display: false } },
        y: { title: { display: true, text: "Book P&L ($)", color: "#9b9b96" }, ticks: { color: "#9b9b96", font: { size: 9 } }, grid: { color: "rgba(255,255,255,0.05)" } },
      },
    }),
  });
  const note = document.getElementById("shock-note");
  if (note) note.innerHTML = `${betaOn ? "Beta-weighted" : "Parallel"} shock of ${(state.positions as any[]).length} positions, ${days}d forward. ${betaOn ? "Each underlying moves β×move (6mo β vs SPY)." : "Every underlying moves the slider %."} The curve bends up (convex) where you're net long gamma, down where short.`;
}
export function renderPortfolioShock() {
  const sec = document.getElementById("shock-section") as HTMLElement | null;
  if (!sec) return;
  if (!(state.positions as any[])?.length || !state.marketData) { sec.hidden = true; return; }
  sec.hidden = false;
  if (!_shockWired) {
    _shockWired = true;
    document.getElementById("shock-move")?.addEventListener("input", _drawShock);
    document.getElementById("shock-days")?.addEventListener("input", _drawShock);
    document.getElementById("shock-beta")?.addEventListener("change", () => {
      const on = (document.getElementById("shock-beta") as HTMLInputElement).checked;
      if (on && Object.keys(_shockBetas).length === 0) _shockLoadBetas(); else _drawShock();
    });
  }
  _drawShock();
}

export async function loadRiskMatrix() {
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
    loadRiskExposure();
    loadRiskFactors();
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

export function renderRiskMatrix(data) {
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

export function renderUnusualActivity(data) {
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

export async function loadVolSurface(ticker) {
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

export function renderVolSurface(data) {
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

export function _renderVolSurfaceChart() {
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

// ═══════════════════════════════════════════════════════════════════════════
// Tier-2: Exposure & concentration + Expiration / pin-risk calendar
// ═══════════════════════════════════════════════════════════════════════════

export async function loadRiskExposure() {
  const section = document.getElementById("exposure-section");
  const calSection = document.getElementById("expiry-calendar-section");
  const pg = (state.greeks as any)?.positions;
  if (!pg?.length || !state.marketData) {
    if (section) section.hidden = true;
    if (calSection) calSection.hidden = true;
    return;
  }
  try {
    const { ok, data } = await fetchJson("/api/risk/exposure", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ positionGreeks: pg, marketData: state.marketData }),
    });
    if (!ok || data.error) return;
    renderExposure(data.exposure);
    renderExpiryCalendar(data.expiryCalendar);
  } catch (e) { /* exposure is best-effort */ }
}

export function renderExposure(ex: any) {
  const section = document.getElementById("exposure-section");
  const statsEl = document.getElementById("exposure-stats");
  if (!section || !statsEl) return;
  if (!ex) { section.hidden = true; return; }
  section.hidden = false;
  const p = ex.portfolio || {};
  const c = ex.concentration;
  const ddCol = (p.dollarDelta || 0) >= 0 ? "var(--ok-tx)" : "var(--err-tx)";
  statsEl.innerHTML = `
    <div class="stat"><div class="stat-label" title="Net dollar delta — directional $ exposure. P&L per +1% move ≈ $Δ × 0.01">Net $Delta</div><div class="stat-val" style="color:${ddCol}">${fmtDollar(p.dollarDelta)}</div><div class="stat-sub">~${fmtDollar((p.dollarDelta || 0) * 0.01)}/+1%</div></div>
    <div class="stat"><div class="stat-label" title="Change in $Delta for a +1% move in underlyings">$Gamma /+1%</div><div class="stat-val">${fmtDollar(p.dollarGamma1pct)}</div></div>
    <div class="stat"><div class="stat-label">$Theta /day</div><div class="stat-val" style="color:${(p.theta || 0) >= 0 ? "var(--ok-tx)" : "var(--err-tx)"}">${fmtDollar(p.theta)}</div></div>
    <div class="stat"><div class="stat-label">$Vega /vol-pt</div><div class="stat-val">${fmtDollar(p.vega)}</div></div>
    ${c ? `
    <div class="stat" style="border-left:3px solid var(--warn-tx)"><div class="stat-label" title="Herfindahl index on |$Δ|; effective independent names = 1/HHI">Concentration</div><div class="stat-val" style="font-size:16px">${c.effectiveNames ?? "—"}<span style="font-size:10px;color:var(--tx3)"> eff. names</span></div><div class="stat-sub">HHI ${c.hhi}</div></div>
    <div class="stat"><div class="stat-label">Top name</div><div class="stat-val" style="font-size:16px">${esc(c.topName || "—")}</div><div class="stat-sub">${c.topNamePct ?? "—"}% · top3 ${c.top3Pct ?? "—"}%</div></div>` : ""}`;

  const tEl = document.getElementById("exposure-ticker-table");
  if (tEl) {
    const rows = Object.entries(ex.byTicker || {}).sort((a: any, b: any) => Math.abs(b[1].dollarDelta) - Math.abs(a[1].dollarDelta));
    let html = '<table class="hist-tbl"><thead><tr><th>Ticker</th><th>$Delta</th><th>$Γ/1%</th><th>$Θ/d</th><th>$Vega</th></tr></thead><tbody>';
    for (const [tkr, v] of rows as any) {
      const col = v.dollarDelta >= 0 ? "var(--ok-tx)" : "var(--err-tx)";
      html += `<tr><td>${esc(tkr)}</td><td style="color:${col}">${fmtDollar(v.dollarDelta)}</td><td>${fmtDollar(v.dollarGamma1pct)}</td><td>${fmtDollar(v.theta)}</td><td>${fmtDollar(v.vega)}</td></tr>`;
    }
    html += "</tbody></table>";
    tEl.innerHTML = html;
  }

  const vEl = document.getElementById("vega-ladder");
  if (vEl) {
    const ladder = ex.vegaLadder || [];
    const maxAbs = Math.max(1, ...ladder.map((b: any) => Math.abs(b.vega)));
    let html = '<div style="display:flex;flex-direction:column;gap:6px;font-family:var(--mono);font-size:11px">';
    for (const b of ladder) {
      const w = Math.abs(b.vega) / maxAbs * 100;
      const col = b.vega >= 0 ? "rgba(77,208,225,0.6)" : "rgba(239,83,80,0.6)";
      html += `<div style="display:flex;align-items:center;gap:8px"><span style="width:52px;color:var(--tx3)">${b.bucket}</span><span style="flex:1;background:var(--bg2);border-radius:3px;height:14px;position:relative"><span style="position:absolute;left:0;top:0;height:100%;width:${w}%;background:${col};border-radius:3px"></span></span><span style="width:64px;text-align:right">${fmtDollar(b.vega)}</span></div>`;
    }
    html += "</div>";
    vEl.innerHTML = html;
  }
}

export function renderExpiryCalendar(cal: any) {
  const section = document.getElementById("expiry-calendar-section");
  const body = document.getElementById("expiry-calendar-body");
  if (!section || !body) return;
  if (!cal?.length) { section.hidden = true; return; }
  section.hidden = false;
  const maxGamma = Math.max(1, ...cal.map((r: any) => r.absGamma));
  let html = '<table class="hist-tbl"><thead><tr><th>Expiry</th><th>DTE</th><th>Tickers</th><th>Legs</th><th>Net Δ</th><th>|Γ|</th><th>Vega</th><th>Notional</th><th>Near strike</th><th></th></tr></thead><tbody>';
  for (const r of cal) {
    const gw = r.absGamma / maxGamma * 100;
    const pin = r.pinRisk ? `<span style="font-size:9px;padding:1px 6px;border-radius:8px;background:rgba(255,193,7,0.18);color:var(--warn-tx)" title="≤10 DTE and within 3% of a strike — gamma/assignment risk into expiry">pin risk</span>` : "";
    const ddCol = r.netDelta >= 0 ? "var(--ok-tx)" : "var(--err-tx)";
    const tickers = r.tickers.slice(0, 4).join(", ") + (r.tickers.length > 4 ? ` +${r.tickers.length - 4}` : "");
    const near = r.nearestStrikePct != null ? `${r.nearestStrikePct}%` : "—";
    const rowBg = r.pinRisk ? "background:rgba(255,193,7,0.06)" : "";
    html += `<tr style="${rowBg}"><td>${esc(r.expiry)}</td><td>${r.dte}d</td><td title="${esc(r.tickers.join(", "))}">${esc(tickers)}</td><td>${r.legs}</td><td style="color:${ddCol}">${r.netDelta}</td><td><span style="display:inline-block;min-width:46px;background:linear-gradient(90deg,rgba(171,71,188,0.5) ${gw}%,transparent ${gw}%);padding:0 4px;border-radius:2px">${r.absGamma}</span></td><td>${fmtDollar(r.vega)}</td><td>${fmtDollar(r.notional)}</td><td>${near}</td><td>${pin}</td></tr>`;
  }
  html += "</tbody></table>";
  body.innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════════
// Tier-3: Implied-vs-realized vol · Sector rollup · Benchmark vs SPY
// ═══════════════════════════════════════════════════════════════════════════

export async function loadRiskFactors() {
  const pg = (state.greeks as any)?.positions;
  if (!pg?.length || !state.marketData) return;
  try {
    const { ok, data } = await fetchJson("/api/risk/factors", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ positionGreeks: pg, marketData: state.marketData }),
    });
    if (!ok || data.error) return;
    renderVolComparison(data.volComparison);
    renderSectorRollup(data.sectors);
    renderBenchmark(data.benchmark);
  } catch (e) { /* best-effort (network) */ }
}

export function renderVolComparison(rows: any) {
  const section = document.getElementById("vol-comparison-section");
  const body = document.getElementById("vol-comparison-body");
  if (!section || !body) return;
  const valid = (rows || []).filter((r: any) => r.rv20 != null || r.iv != null);
  if (!valid.length) { section.hidden = true; return; }
  section.hidden = false;
  let html = '<table class="hist-tbl"><thead><tr><th>Ticker</th><th>IV</th><th>RV 20d</th><th>RV 60d</th><th>IV−RV</th><th>Signal</th></tr></thead><tbody>';
  for (const r of valid) {
    const sigColor = r.signal === "rich" ? "var(--ok-tx)" : (r.signal === "cheap" ? "var(--err-tx)" : "var(--tx3)");
    const spread = r.ivRvSpread != null ? `${r.ivRvSpread > 0 ? "+" : ""}${r.ivRvSpread}` : "—";
    html += `<tr><td>${esc(r.ticker)}</td><td>${r.iv != null ? r.iv + "%" : "—"}</td><td>${r.rv20 != null ? r.rv20 + "%" : "—"}</td><td>${r.rv60 != null ? r.rv60 + "%" : "—"}</td><td style="color:${sigColor}">${spread}</td><td style="color:${sigColor}">${r.signal || "—"}</td></tr>`;
  }
  html += "</tbody></table>";
  body.innerHTML = html;
}

export function renderSectorRollup(s: any) {
  const section = document.getElementById("sector-section");
  const body = document.getElementById("sector-body");
  const meta = document.getElementById("sector-meta");
  if (!section || !body) return;
  if (!s?.sectors?.length) { section.hidden = true; return; }
  section.hidden = false;
  if (meta) meta.textContent = `${s.effectiveSectors ?? "—"} eff. sectors · HHI ${s.hhi ?? "—"}`;
  const maxAbs = Math.max(1, ...s.sectors.map((r: any) => r.absDollarDelta));
  let html = '<div style="display:flex;flex-direction:column;gap:6px;font-family:var(--mono);font-size:11px">';
  for (const r of s.sectors) {
    const w = r.absDollarDelta / maxAbs * 100;
    const col = r.dollarDelta >= 0 ? "rgba(76,175,80,0.55)" : "rgba(239,83,80,0.55)";
    const ddCol = r.dollarDelta >= 0 ? "var(--ok-tx)" : "var(--err-tx)";
    html += `<div style="display:flex;align-items:center;gap:8px"><span style="width:120px;color:var(--tx2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.tickers.join(", "))}">${esc(r.sector)}</span><span style="flex:1;background:var(--bg2);border-radius:3px;height:16px;position:relative"><span style="position:absolute;left:0;top:0;height:100%;width:${w}%;background:${col};border-radius:3px"></span></span><span style="width:90px;text-align:right;color:${ddCol}">${fmtDollar(r.dollarDelta)}</span><span style="width:42px;text-align:right;color:var(--tx3)">${r.pct}%</span></div>`;
  }
  html += "</div>";
  body.innerHTML = html;
}

export function renderBenchmark(b: any) {
  const section = document.getElementById("benchmark-section");
  const statsEl = document.getElementById("benchmark-stats");
  if (!section || !statsEl) return;
  if (!b || (b.dollarBetaPer1pct == null && b.betaWeightedDollarDelta == null)) { section.hidden = true; return; }
  section.hidden = false;
  let html = "";
  if (b.betaWeightedDollarDelta != null) {
    const col = b.betaWeightedDollarDelta >= 0 ? "var(--ok-tx)" : "var(--err-tx)";
    html += `<div class="stat"><div class="stat-label" title="Beta-adjusted SPY-equivalent dollar exposure (holdings-based)">β-wtd $Delta</div><div class="stat-val" style="color:${col}">${fmtDollar(b.betaWeightedDollarDelta)}</div></div>`;
  }
  if (b.dollarBetaPer1pct != null) {
    html += `<div class="stat"><div class="stat-label" title="Book P&L per +1% SPY move (regression on tracked snapshots)">$ Beta /+1% SPY</div><div class="stat-val">${fmtDollar(b.dollarBetaPer1pct)}</div></div>`;
    html += `<div class="stat"><div class="stat-label">Correlation</div><div class="stat-val">${b.correlation ?? "—"}</div><div class="stat-sub">R² ${b.rSquared ?? "—"}</div></div>`;
    html += `<div class="stat"><div class="stat-label" title="Avg non-market P&L per tracked period">Alpha /period</div><div class="stat-val" style="color:${(b.alphaPerPeriod || 0) >= 0 ? "var(--ok-tx)" : "var(--err-tx)"}">${fmtDollar(b.alphaPerPeriod)}</div></div>`;
    html += `<div class="stat"><div class="stat-label">SPY (window)</div><div class="stat-val" style="color:${(b.spyReturnPct || 0) >= 0 ? "var(--ok-tx)" : "var(--err-tx)"}">${b.spyReturnPct != null ? b.spyReturnPct + "%" : "—"}</div><div class="stat-sub">${b.nPeriods ?? 0} periods</div></div>`;
  }
  statsEl.innerHTML = html || '<span style="font-size:11px;color:var(--tx3)">Need more book snapshots for a benchmark estimate.</span>';
}

