import { esc } from "./02-portfolio";
import { chartInteractionDefaults, deepMergeChartOpts } from "./03-chart-utils";
import { chartInstances, destroyChart, state } from "./04-state";
import { fmtDollar } from "./08-simulate";

// ═══════════════════════════════════════════════════════════════════════════
// Greeks Lab (#21) — per-leg interactive Black-Scholes: watch value + Greeks
// evolve toward expiry and across underlying price. Client-side BSM mirrors the
// server's bs_greeks/bs_option_value (per-share; vega per vol-point; theta/day).
// Higher-order/cross Greeks (vanna, charm, vomma, speed) are finite-differenced
// off the same BSM. An optional spot↔vol link models a realistic joint move.
// ═══════════════════════════════════════════════════════════════════════════

// Mirrors the server RISK_FREE default (env-overridable server-side). r has a
// small effect on Greeks; the lab is a theoretical what-if, validated numerically
// against /api/greeks.
const RISK_FREE = 0.037;

function _normPdf(x: number): number {
  return 0.3989422804014327 * Math.exp(-0.5 * x * x);
}

// Abramowitz & Stegun 7.1.26 normal CDF (|err| < 7.5e-8).
function _normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-0.5 * x * x);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

export interface BsmResult {
  value: number; delta: number; gamma: number; theta: number; vega: number;
  intrinsic: number; extrinsic: number;
}

/** Per-share Black-Scholes value + Greeks. iv is decimal (0.40), T in years.
 *  theta is per calendar day, vega is per 1 vol point — matching the backend. */
export function bsm(S: number, K: number, iv: number, Tyears: number, optType: string, r = RISK_FREE): BsmResult {
  const isCall = String(optType || "").toLowerCase().startsWith("c");
  const intrinsic = isCall ? Math.max(S - K, 0) : Math.max(K - S, 0);
  if (!(Tyears > 1e-6) || !(iv > 0) || !(S > 0) || !(K > 0)) {
    return {
      value: intrinsic,
      delta: isCall ? (S > K ? 1 : 0) : (S < K ? -1 : 0),
      gamma: 0, theta: 0, vega: 0, intrinsic, extrinsic: 0,
    };
  }
  const sqrtT = Math.sqrt(Tyears);
  const d1 = (Math.log(S / K) + (r + 0.5 * iv * iv) * Tyears) / (iv * sqrtT);
  const d2 = d1 - iv * sqrtT;
  const pdf = _normPdf(d1);
  let delta: number, thetaAnnual: number, value: number;
  if (isCall) {
    delta = _normCdf(d1);
    thetaAnnual = -(S * pdf * iv) / (2 * sqrtT) - r * K * Math.exp(-r * Tyears) * _normCdf(d2);
    value = S * _normCdf(d1) - K * Math.exp(-r * Tyears) * _normCdf(d2);
  } else {
    delta = _normCdf(d1) - 1;
    thetaAnnual = -(S * pdf * iv) / (2 * sqrtT) + r * K * Math.exp(-r * Tyears) * _normCdf(-d2);
    value = K * Math.exp(-r * Tyears) * _normCdf(-d2) - S * _normCdf(-d1);
  }
  const gamma = pdf / (S * iv * sqrtT);
  const vega = (S * pdf * sqrtT) / 100;
  const theta = thetaAnnual / 365;
  return { value, delta, gamma, theta, vega, intrinsic, extrinsic: value - intrinsic };
}

/** Higher-order / cross Greeks by central finite-difference on bsm() (per share):
 *   vanna = ∂Δ per +1 vol pt   charm = ∂Δ per day toward expiry
 *   vomma = ∂vega per +1 vol pt  speed = ∂Γ per +$1 in spot
 *  ivFn lets the spot-bump respect the spot↔vol link (so speed/vanna reflect skew). */
export function bsmHigherOrder(S: number, K: number, Tyears: number, optType: string, ivFn: (s: number) => number) {
  const dS = Math.max(S * 0.005, 0.01);
  const dIv = 0.005;          // half of a 1-vol-point span
  const dT = 0.5 / 365;       // half a day
  const ivHere = ivFn(S);
  const sUp = bsm(S + dS, K, ivFn(S + dS), Tyears, optType);
  const sDn = bsm(S - dS, K, ivFn(S - dS), Tyears, optType);
  const ivUp = bsm(S, K, ivHere + dIv, Tyears, optType);
  const ivDn = bsm(S, K, ivHere - dIv, Tyears, optType);
  const tNear = bsm(S, K, ivHere, Math.max(1e-6, Tyears - dT), optType); // closer to expiry
  const tFar = bsm(S, K, ivHere, Tyears + dT, optType);
  return {
    vanna: ivUp.delta - ivDn.delta,          // Δ change per 1 vol point
    vomma: ivUp.vega - ivDn.vega,            // vega change per 1 vol point
    speed: (sUp.gamma - sDn.gamma) / (2 * dS), // Γ change per $1
    charm: tNear.delta - tFar.delta,         // Δ change per 1 day toward expiry
  };
}

const METRICS: Record<string, { label: string; color: string }> = {
  value: { label: "Option value ($/sh)", color: "#e8e8e4" },
  delta: { label: "Delta (per share)", color: "#90caf9" },
  gamma: { label: "Gamma (per share)", color: "#ce93d8" },
  theta: { label: "Theta ($/day, per share)", color: "#f5c518" },
  vega: { label: "Vega ($/vol pt, per share)", color: "#4dd0e1" },
};

let GL: any = null;

function _spotStep(s: number): number {
  if (s < 5) return 0.01;
  if (s < 50) return 0.05;
  return 0.25;
}

// Effective IV (decimal) at spot S. With the spot↔vol link on, IV rises as spot
// falls below the reference by `skew` vol points per −1% move (a skew/leverage proxy).
function _effIv(S: number): number {
  let ivPct = GL.iv;
  if (GL.linked && GL.spot0 > 0) {
    const pctMove = ((GL.spot0 - S) / GL.spot0) * 100; // >0 when S below reference
    ivPct = GL.iv + GL.skew * pctMove;
  }
  return Math.max(0.01, ivPct) / 100;
}

export function openGreeksLab(pos: any) {
  const modal = document.getElementById("greeks-modal");
  const body = document.getElementById("greeks-modal-body");
  if (!modal || !body) return;
  const md: any = (state.marketData as any)?.[pos.ticker] || {};
  const spot0 = Number(md.price) > 0 ? Number(md.price) : (pos.strike || 1);
  const iv0 = Number(md.iv) > 0 ? Number(md.iv) : 30; // percent
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const exp = pos.expiry ? new Date(pos.expiry) : null;
  const dte0 = exp && !Number.isNaN(exp.getTime())
    ? Math.max(0, Math.ceil((exp.getTime() - today.getTime()) / 86400000)) : 30;
  GL = {
    pos, spot0, iv0, dte0,
    spot: spot0, iv: iv0, dte: dte0,
    metric: "theta", xaxis: "dte",
    linked: false, skew: 1.0,
    K: pos.strike || 0, optType: pos.optType || "Put",
    contracts: pos.contracts || 0, avg: pos.avgCost || 0,
  };
  modal.hidden = false;
  const expLabel = pos.expiry || "(no expiry)";
  const step = _spotStep(spot0);
  const ivMax = Math.max(20, Math.ceil(iv0 * 2));
  body.innerHTML = `
    <div style="font-size:12px;color:var(--tx2);margin-bottom:8px">${esc(pos.ticker)} · ${esc(GL.optType)} $${GL.K} · exp ${esc(expLabel)} (${dte0}d) · ${GL.contracts} cts · avg $${GL.avg.toFixed(2)}</div>
    <div style="font-size:10px;color:var(--tx3);margin-bottom:12px;line-height:1.4">Theoretical Black-Scholes (r=${(RISK_FREE * 100).toFixed(1)}%). Position Greeks = per-share × 100 × contracts. Higher-order Greeks are finite-differenced.</div>
    <div style="display:flex;gap:18px;flex-wrap:wrap;margin-bottom:10px;font-family:var(--mono);font-size:11px">
      <label style="flex:1;min-width:160px">Days to expiry: <b id="gl-dte-val" style="color:var(--accent)"></b><br><input type="range" id="gl-dte" min="0" max="${dte0}" value="${dte0}" step="1" style="width:100%"></label>
      <label style="flex:1;min-width:160px">Spot: <b id="gl-spot-val" style="color:var(--accent)"></b><br><input type="range" id="gl-spot" min="${(spot0 * 0.5).toFixed(2)}" max="${(spot0 * 1.5).toFixed(2)}" value="${spot0}" step="${step}" style="width:100%"></label>
      <label style="flex:1;min-width:160px">IV: <b id="gl-iv-val" style="color:var(--accent)"></b><br><input type="range" id="gl-iv" min="1" max="${ivMax}" value="${Math.round(iv0)}" step="1" style="width:100%"></label>
    </div>
    <div style="display:flex;gap:10px;align-items:center;margin-bottom:14px;font-family:var(--mono);font-size:11px;color:var(--tx2)">
      <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer" title="Couple IV to spot: a spot drop raises IV by the skew below, simulating a realistic joint spot↔vol move (vanna/charm P&L) instead of a flat-vol shift."><input type="checkbox" id="gl-link"> Link IV → spot (skew)</label>
      <label>skew <input type="number" id="gl-skew" value="1" step="0.25" style="width:50px;padding:3px;border-radius:4px;border:1px solid var(--bd);background:var(--bg2);color:var(--tx);font-family:var(--mono);font-size:11px"> vol pts / −1% spot</label>
    </div>
    <div class="summary" id="gl-readout" style="margin-bottom:14px"></div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;align-items:center;font-size:10px">
      <span style="color:var(--tx3)">Plot</span>
      <button class="btn btn-sm btn-ghost gl-metric" data-m="value" type="button">Value</button>
      <button class="btn btn-sm btn-ghost gl-metric" data-m="delta" type="button">Δ</button>
      <button class="btn btn-sm btn-ghost gl-metric" data-m="gamma" type="button">Γ</button>
      <button class="btn btn-sm gl-metric" data-m="theta" type="button">Θ</button>
      <button class="btn btn-sm btn-ghost gl-metric" data-m="vega" type="button">Vega</button>
      <span style="margin-left:auto;color:var(--tx3)">x-axis</span>
      <button class="btn btn-sm gl-xaxis" data-x="dte" type="button">Time → expiry</button>
      <button class="btn btn-sm btn-ghost gl-xaxis" data-x="price" type="button">Underlying price</button>
    </div>
    <canvas id="gl-chart" height="150"></canvas>`;

  const dte = document.getElementById("gl-dte") as HTMLInputElement;
  const spot = document.getElementById("gl-spot") as HTMLInputElement;
  const iv = document.getElementById("gl-iv") as HTMLInputElement;
  const link = document.getElementById("gl-link") as HTMLInputElement;
  const skew = document.getElementById("gl-skew") as HTMLInputElement;
  dte.addEventListener("input", () => { GL.dte = +dte.value; _glRender(); });
  spot.addEventListener("input", () => { GL.spot = +spot.value; _glRender(); });
  iv.addEventListener("input", () => { GL.iv = +iv.value; _glRender(); });
  link.addEventListener("change", () => { GL.linked = link.checked; _glRender(); });
  skew.addEventListener("input", () => { GL.skew = parseFloat(skew.value) || 0; _glRender(); });
  body.querySelectorAll(".gl-metric").forEach(b => b.addEventListener("click", () => {
    GL.metric = (b as HTMLElement).dataset.m; _glRender();
  }));
  body.querySelectorAll(".gl-xaxis").forEach(b => b.addEventListener("click", () => {
    GL.xaxis = (b as HTMLElement).dataset.x; _glRender();
  }));
  _glRender();
}

function _glRender() {
  if (!GL) return;
  const { K, optType, contracts, avg } = GL;
  const mult = 100 * contracts; // signed (short = negative)
  const ivNow = _effIv(GL.spot);
  const g = bsm(GL.spot, K, ivNow, GL.dte / 365, optType);
  const ho = bsmHigherOrder(GL.spot, K, GL.dte / 365, optType, _effIv);
  const pnl = (g.value - avg) * 100 * contracts;
  const col = (v: number) => (v >= 0 ? "var(--ok-tx)" : "var(--err-tx)");
  const ro = document.getElementById("gl-readout");
  if (ro) ro.innerHTML = `
    <div class="stat"><div class="stat-label">Value /ct</div><div class="stat-val" style="font-size:16px">$${(g.value * 100).toFixed(0)}</div><div class="stat-sub">$${g.value.toFixed(2)}/sh · ext $${g.extrinsic.toFixed(2)}</div></div>
    <div class="stat"><div class="stat-label">Pos Δ</div><div class="stat-val" style="font-size:16px;color:#90caf9">${(g.delta * mult).toFixed(0)}</div></div>
    <div class="stat"><div class="stat-label">Pos Γ</div><div class="stat-val" style="font-size:16px;color:#ce93d8">${(g.gamma * mult).toFixed(1)}</div></div>
    <div class="stat"><div class="stat-label">Pos Θ /day</div><div class="stat-val" style="font-size:16px;color:#f5c518">${fmtDollar(g.theta * mult)}</div></div>
    <div class="stat"><div class="stat-label">Pos Vega</div><div class="stat-val" style="font-size:16px;color:#4dd0e1">${fmtDollar(g.vega * mult)}</div></div>
    <div class="stat"><div class="stat-label">P&L vs fill</div><div class="stat-val" style="font-size:16px;color:${col(pnl)}">${fmtDollar(pnl)}</div></div>
    <div class="stat" title="Vanna: Δ change per +1 vol point"><div class="stat-label">Vanna</div><div class="stat-val" style="font-size:14px;color:var(--tx2)">${(ho.vanna * mult).toFixed(1)}</div><div class="stat-sub">Δ / vol pt</div></div>
    <div class="stat" title="Charm: Δ change per day toward expiry (delta decay)"><div class="stat-label">Charm</div><div class="stat-val" style="font-size:14px;color:var(--tx2)">${(ho.charm * mult).toFixed(1)}</div><div class="stat-sub">Δ / day</div></div>
    <div class="stat" title="Vomma: vega change per +1 vol point"><div class="stat-label">Vomma</div><div class="stat-val" style="font-size:14px;color:var(--tx2)">${fmtDollar(ho.vomma * mult)}</div><div class="stat-sub">Vega / vol pt</div></div>
    <div class="stat" title="Speed: gamma change per +$1 in spot (3rd order)"><div class="stat-label">Speed</div><div class="stat-val" style="font-size:14px;color:var(--tx2)">${(ho.speed * mult).toFixed(3)}</div><div class="stat-sub">Γ / $1</div></div>`;

  document.querySelectorAll(".gl-metric").forEach(b => b.classList.toggle("btn-ghost", (b as HTMLElement).dataset.m !== GL.metric));
  document.querySelectorAll(".gl-xaxis").forEach(b => b.classList.toggle("btn-ghost", (b as HTMLElement).dataset.x !== GL.xaxis));

  const m = GL.metric as keyof BsmResult;
  const labels: string[] = [];
  const ys: number[] = [];
  let markerIdx = 0;
  if (GL.xaxis === "dte") {
    // spot fixed → IV fixed at the linked value for the current spot
    const ivT = _effIv(GL.spot);
    const n = Math.min(GL.dte0, 121);
    const stepN = GL.dte0 > 0 ? GL.dte0 / Math.max(1, n) : 1;
    let best = 1e9;
    for (let i = 0; i <= n; i++) {
      const dd = Math.max(0, GL.dte0 - i * stepN);
      labels.push(dd.toFixed(0));
      ys.push((bsm(GL.spot, K, ivT, dd / 365, optType) as any)[m]);
      const diff = Math.abs(dd - GL.dte);
      if (diff < best) { best = diff; markerIdx = i; }
    }
  } else {
    const lo = GL.spot0 * 0.5, hi = GL.spot0 * 1.5, n = 60;
    let best = 1e9;
    for (let i = 0; i <= n; i++) {
      const s = lo + (hi - lo) * (i / n);
      labels.push(s >= 100 ? s.toFixed(0) : s.toFixed(2));
      ys.push((bsm(s, K, _effIv(s), GL.dte / 365, optType) as any)[m]); // IV varies with spot when linked
      const diff = Math.abs(s - GL.spot);
      if (diff < best) { best = diff; markerIdx = i; }
    }
  }

  const dteLab = document.getElementById("gl-dte-val");
  const spotLab = document.getElementById("gl-spot-val");
  const ivLab = document.getElementById("gl-iv-val");
  if (dteLab) dteLab.textContent = `${GL.dte}d`;
  if (spotLab) spotLab.textContent = `$${GL.spot.toFixed(2)}`;
  if (ivLab) ivLab.textContent = GL.linked ? `${GL.iv}% → ${(ivNow * 100).toFixed(0)}% eff` : `${GL.iv}%`;

  const meta = METRICS[GL.metric] || METRICS.theta;
  const canvas = document.getElementById("gl-chart");
  destroyChart("gl-chart");
  if (!canvas) return;
  chartInstances["gl-chart"] = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: meta.label,
        data: ys,
        borderColor: meta.color,
        backgroundColor: "transparent",
        borderWidth: 2,
        tension: 0.2,
        pointRadius: ys.map((_, i) => (i === markerIdx ? 5 : 0)),
        pointBackgroundColor: meta.color,
        pointBorderColor: "#fff",
      }],
    },
    options: deepMergeChartOpts(chartInteractionDefaults(), {
      responsive: true,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { title: (it: any) => `${GL.xaxis === "dte" ? "DTE " : "$"}${it[0]?.label}`, label: (ctx: any) => `${meta.label}: ${ctx.parsed.y?.toFixed(GL.metric === "gamma" ? 4 : 2)}` } },
      },
      scales: {
        x: { title: { display: true, text: GL.xaxis === "dte" ? "Days to expiry →" : "Underlying price", color: "#9b9b96" }, ticks: { maxTicksLimit: 10, color: "#9b9b96", font: { size: 9 } }, grid: { display: false } },
        y: { title: { display: true, text: meta.label, color: "#9b9b96" }, ticks: { color: "#9b9b96", font: { size: 9 } }, grid: { color: "rgba(255,255,255,0.05)" } },
      },
    }),
  });
}

// Open from the per-leg "Greeks" button (event delegation — no import into render).
document.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest(".btn-greeks") as HTMLElement | null;
  if (!btn) return;
  e.stopPropagation();
  openGreeksLab({
    ticker: btn.dataset.gTicker,
    strike: parseFloat(btn.dataset.gStrike || "0"),
    expiry: btn.dataset.gExpiry || null,
    optType: btn.dataset.gType || "Put",
    contracts: parseInt(btn.dataset.gCts || "0", 10),
    avgCost: parseFloat(btn.dataset.gAvg || "0"),
  });
});

document.getElementById("greeks-modal-close")?.addEventListener("click", () => {
  const m = document.getElementById("greeks-modal"); if (m) m.hidden = true;
});
document.getElementById("greeks-modal")?.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).id === "greeks-modal") {
    const m = document.getElementById("greeks-modal"); if (m) m.hidden = true;
  }
});
