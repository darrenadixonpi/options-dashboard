import { esc } from "./02-portfolio";
import { chartInteractionDefaults, deepMergeChartOpts } from "./03-chart-utils";
import { chartInstances, destroyChart, state } from "./04-state";
import { fmtDollar } from "./08-simulate";

// ═══════════════════════════════════════════════════════════════════════════
// Greeks Lab (#21) — interactive Black-Scholes for a single leg OR a whole
// underlying (all of a ticker's legs netted). Five views: Curves, Θ–Γ rent,
// Surface (3D/heatmap), Taylor P&L, Greek×Greek. All views read net POSITION
// greeks (×100×contracts, summed over the scope's legs) through _scope*(). For
// an aggregate, each leg keeps its own strike/expiry and the time axis advances
// the whole book together (days-forward). Client BSM mirrors the server.
// ═══════════════════════════════════════════════════════════════════════════

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
 *   color = ∂Γ per day toward expiry (gamma decay)
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
    color: tNear.gamma - tFar.gamma,         // Γ change per 1 day toward expiry
  };
}

// Metric metadata for the curves view (core 5). Values are POSITION-level.
const METRICS: Record<string, { label: string; color: string }> = {
  value: { label: "Position value ($)", color: "#e8e8e4" },
  delta: { label: "Position Δ (shares-eq)", color: "#90caf9" },
  gamma: { label: "Position Γ", color: "#ce93d8" },
  theta: { label: "Position Θ ($/day)", color: "#f5c518" },
  vega: { label: "Position vega ($/pt)", color: "#4dd0e1" },
};

// Superset incl. higher-order, for surface Z and Greek×Greek axes (position).
const GMETA: Record<string, { label: string; color: string; prec: number }> = {
  value: { label: "Value ($)", color: "#e8e8e4", prec: 0 },
  delta: { label: "Delta (shares-eq)", color: "#90caf9", prec: 1 },
  gamma: { label: "Gamma", color: "#ce93d8", prec: 2 },
  theta: { label: "Theta ($/day)", color: "#f5c518", prec: 1 },
  vega: { label: "Vega ($/pt)", color: "#4dd0e1", prec: 1 },
  vanna: { label: "Vanna (Δ/pt)", color: "#b0bec5", prec: 1 },
  charm: { label: "Charm (Δ/day)", color: "#a5d6a7", prec: 2 },
  vomma: { label: "Vomma ($/pt)", color: "#ffab91", prec: 1 },
  speed: { label: "Speed (Γ/$)", color: "#c5cae9", prec: 3 },
  color: { label: "Color (Γ/day)", color: "#80cbc4", prec: 3 },
};

const DIMS: Record<string, string> = { spot: "Spot", dte: "Time (days fwd)", iv: "IV (%)" };

let GL: any = null;
let _glPrefs: any = {};           // view/mode/orientation preferences, persisted across opens
let _glDragWired = false;
let _glDrag = false, _glLastX = 0, _glLastY = 0;

function _spotStep(s: number): number {
  if (s < 5) return 0.01;
  if (s < 50) return 0.05;
  return 0.25;
}

function _dteFromExpiry(expiry: string | null): number {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const exp = expiry ? new Date(expiry) : null;
  return exp && !Number.isNaN(exp.getTime())
    ? Math.max(0, Math.ceil((exp.getTime() - today.getTime()) / 86400000)) : 30;
}

// Effective IV (decimal) at spot S. With the spot↔vol link on, IV rises as spot
// falls below the reference by `skew` vol points per −1% move (a skew proxy).
function _effIv(S: number): number {
  let ivPct = GL.iv;
  if (GL.linked && GL.spot0 > 0) {
    const pctMove = ((GL.spot0 - S) / GL.spot0) * 100; // >0 when S below reference
    ivPct = GL.iv + GL.skew * pctMove;
  }
  return Math.max(0.01, ivPct) / 100;
}

// Net POSITION greeks for the active scope (one leg, or all of a ticker's legs
// when aggregated) at a hypothetical (spot, iv-decimal, dte-slider in days). The
// slider is the reference clock; each leg's remaining life = its own dte0 minus
// the days-forward the slider implies, so a single axis advances the whole book.
function _scopeBundle(S: number, ivDec: number, sliderDte: number) {
  const daysFwd = GL.dte0 - sliderDte;
  const R: any = { value: 0, delta: 0, gamma: 0, theta: 0, vega: 0, vanna: 0, charm: 0, vomma: 0, speed: 0, color: 0, cost: 0, intrinsic: 0, extrinsic: 0 };
  for (const L of GL.legsForScope) {
    const Trem = Math.max(0, L.dte0 - daysFwd) / 365;
    const mult = 100 * L.contracts;
    const g = bsm(S, L.K, ivDec, Trem, L.optType);
    const ho = bsmHigherOrder(S, L.K, Trem, L.optType, () => ivDec);
    R.value += g.value * mult; R.delta += g.delta * mult; R.gamma += g.gamma * mult;
    R.theta += g.theta * mult; R.vega += g.vega * mult; R.intrinsic += g.intrinsic * mult;
    R.vanna += ho.vanna * mult; R.charm += ho.charm * mult; R.vomma += ho.vomma * mult;
    R.speed += ho.speed * mult; R.color += (ho.color || 0) * mult;
    R.cost += (L.avg || 0) * mult;
  }
  R.extrinsic = R.value - R.intrinsic;
  return R;
}

// One net metric (position $); skips the finite-diff unless a higher-order metric.
function _scopeM(S: number, ivDec: number, sliderDte: number, m: string): number {
  const daysFwd = GL.dte0 - sliderDte;
  const higher = (m === "vanna" || m === "charm" || m === "vomma" || m === "speed" || m === "color");
  let acc = 0;
  for (const L of GL.legsForScope) {
    const Trem = Math.max(0, L.dte0 - daysFwd) / 365;
    const mult = 100 * L.contracts;
    if (higher) { const h: any = bsmHigherOrder(S, L.K, Trem, L.optType, () => ivDec); acc += (h[m] || 0) * mult; }
    else { const g: any = bsm(S, L.K, ivDec, Trem, L.optType); acc += g[m] * mult; }
  }
  return acc;
}

function _dimCur(d: string): number { return d === "spot" ? GL.spot : d === "dte" ? GL.dte : GL.iv; }
function _dimRange(d: string): [number, number] {
  if (d === "spot") return [GL.spot0 * 0.6, GL.spot0 * 1.4];
  if (d === "dte") return [0, Math.max(1, GL.dte0)];
  return [Math.max(1, GL.iv0 * 0.4), Math.max(GL.iv0 * 2, GL.iv0 + 5)];
}

function _glSyncPrefs() {
  _glPrefs = {
    view: GL.view, metric: GL.metric, xaxis: GL.xaxis,
    surfZ: GL.surfZ, surfAxisA: GL.surfAxisA, surfAxisB: GL.surfAxisB, surfMode: GL.surfMode,
    surfYaw: GL.surfYaw, surfPitch: GL.surfPitch,
    scatterX: GL.scatterX, scatterY: GL.scatterY, sweepVar: GL.sweepVar,
    linked: GL.linked, skew: GL.skew,
  };
}

// ── linear interpolation + colormaps ───────────────────────────────────────
function _lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
function _cmap(t: number, diverging: boolean): string {
  t = Math.max(0, Math.min(1, t));
  if (diverging) {
    if (t < 0.5) { const u = t / 0.5; return `rgb(${Math.round(_lerp(46, 224, u))},${Math.round(_lerp(115, 224, u))},${Math.round(_lerp(217, 226, u))})`; }
    const u = (t - 0.5) / 0.5; return `rgb(${Math.round(_lerp(224, 222, u))},${Math.round(_lerp(224, 74, u))},${Math.round(_lerp(226, 66, u))})`;
  }
  const stops = [[34, 36, 74], [30, 110, 142], [38, 168, 124], [124, 200, 80], [246, 220, 72]];
  const seg = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(seg)), u = seg - i;
  const a = stops[i], b = stops[i + 1];
  return `rgb(${Math.round(_lerp(a[0], b[0], u))},${Math.round(_lerp(a[1], b[1], u))},${Math.round(_lerp(a[2], b[2], u))})`;
}

function _selHtml(id: string, opts: [string, string][], cur: string): string {
  const st = "padding:3px;border-radius:4px;border:1px solid var(--bd);background:var(--bg2);color:var(--tx);font-family:var(--mono);font-size:11px";
  return `<select id="${id}" style="${st}">${opts.map(o => `<option value="${o[0]}"${o[0] === cur ? " selected" : ""}>${esc(o[1])}</option>`).join("")}</select>`;
}

// Build the dropdown option list: per-ticker aggregate entries (≥2 legs) + each leg.
function _legOptionsHtml(): string {
  const byTicker: Record<string, number> = {};
  for (const L of GL.legs) byTicker[L.ticker] = (byTicker[L.ticker] || 0) + 1;
  let html = "";
  const seenAgg: Record<string, boolean> = {};
  for (const t of Object.keys(byTicker)) {
    if (byTicker[t] >= 2) {
      const sel = GL.agg && GL.aggTicker === t ? " selected" : "";
      html += `<option value="agg:${esc(t)}"${sel}>▣ ${esc(t)} — all ${byTicker[t]} legs (net)</option>`;
      seenAgg[t] = true;
    }
  }
  GL.legs.forEach((L: any, i: number) => {
    const sel = (!GL.agg && L.ticker === GL.refTicker && L.strike === GL.refStrike && (L.expiry || "") === (GL.refExpiry || "") && L.optType === GL.optType) ? " selected" : "";
    html += `<option value="${i}"${sel}>${esc(L.ticker)} ${esc(L.optType)} $${L.strike} · ${esc(L.expiry || "")} (${L.contracts})</option>`;
  });
  return html;
}

export function openGreeksLab(pos: any, keep?: any) {
  const modal = document.getElementById("greeks-modal");
  const body = document.getElementById("greeks-modal-body");
  if (!modal || !body) return;
  const isAgg = !!pos.agg;
  const ticker = pos.ticker;
  const md: any = (state.marketData as any)?.[ticker] || {};
  const spot0 = Number(md.price) > 0 ? Number(md.price) : (pos.strike || 1);
  const iv0 = Number(md.iv) > 0 ? Number(md.iv) : 30; // percent

  // every option leg on the page (with its own dte0) so the user can switch scope
  const allLegs = Array.from(document.querySelectorAll(".btn-greeks")).map((b: any) => ({
    ticker: b.dataset.gTicker, strike: parseFloat(b.dataset.gStrike || "0"),
    expiry: b.dataset.gExpiry || null, optType: b.dataset.gType || "Put",
    contracts: parseInt(b.dataset.gCts || "0", 10), avgCost: parseFloat(b.dataset.gAvg || "0"),
    dte0: _dteFromExpiry(b.dataset.gExpiry || null),
  }));

  let legsForScope: any[], dte0: number, K: number, optType: string, contracts: number, avg: number, scopeLabel: string;
  if (isAgg) {
    const tl = allLegs.filter((L: any) => L.ticker === ticker);
    legsForScope = tl.map((L: any) => ({ K: L.strike, optType: L.optType, contracts: L.contracts, dte0: L.dte0, avg: L.avgCost }));
    dte0 = Math.max(1, ...tl.map((L: any) => L.dte0));
    K = 0; optType = "mix"; contracts = tl.reduce((a: number, L: any) => a + L.contracts, 0); avg = 0;
    scopeLabel = `${esc(ticker)} · net of ${tl.length} legs · ${contracts} cts`;
  } else {
    dte0 = _dteFromExpiry(pos.expiry);
    K = pos.strike || 0; optType = pos.optType || "Put"; contracts = pos.contracts || 0; avg = pos.avgCost || 0;
    legsForScope = [{ K, optType, contracts, dte0, avg }];
    scopeLabel = `${esc(ticker)} · ${esc(optType)} $${K} · exp ${esc(pos.expiry || "(no expiry)")} (${dte0}d) · ${contracts} cts · avg $${avg.toFixed(2)}`;
  }

  GL = {
    pos, agg: isAgg, aggTicker: isAgg ? ticker : null,
    refTicker: ticker, refStrike: pos.strike || 0, refExpiry: pos.expiry || null,
    spot0, iv0, dte0, spot: spot0, iv: iv0, dte: dte0,
    legs: allLegs, legsForScope,
    view: "curves", metric: "theta", xaxis: "dte",
    surfZ: "gamma", surfAxisA: "spot", surfAxisB: "dte", surfMode: "3d",
    surfYaw: -0.6, surfPitch: 0.95,
    scatterX: "gamma", scatterY: "theta", sweepVar: "spot",
    linked: false, skew: 1.0,
    K, optType, contracts, avg,
  };
  Object.assign(GL, _glPrefs);       // restore last view/orientation across opens
  if (keep) Object.assign(GL, keep); // explicit overrides (leg switch)
  modal.hidden = false;
  const step = _spotStep(spot0);
  const ivMax = Math.max(20, Math.ceil(iv0 * 2));
  const dteLabelTxt = isAgg ? "Days forward" : "Days to expiry";
  body.innerHTML = `
    <div style="margin-bottom:8px;font-family:var(--mono);font-size:11px"><span style="color:var(--tx3)">Scope</span> <select id="gl-leg" style="padding:3px 6px;border-radius:4px;border:1px solid var(--bd);background:var(--bg2);color:var(--tx);font-family:var(--mono);font-size:11px;max-width:100%">${_legOptionsHtml()}</select></div>
    <div style="font-size:12px;color:var(--tx2);margin-bottom:8px">${scopeLabel}</div>
    <div style="font-size:10px;color:var(--tx3);margin-bottom:12px;line-height:1.4">Theoretical Black-Scholes (r=${(RISK_FREE * 100).toFixed(1)}%). All readouts are <b>net position</b> greeks (per-share × 100 × contracts, summed over the scope). ${isAgg ? "Aggregate: one IV and one time axis advance every leg of the underlying together." : ""} Higher-order greeks are finite-differenced.</div>
    <div style="display:flex;gap:18px;flex-wrap:wrap;margin-bottom:10px;font-family:var(--mono);font-size:11px">
      <label style="flex:1;min-width:160px">${dteLabelTxt}: <b id="gl-dte-val" style="color:var(--accent)"></b><br><input type="range" id="gl-dte" min="0" max="${dte0}" value="${dte0}" step="1" style="width:100%"></label>
      <label style="flex:1;min-width:160px">Spot: <b id="gl-spot-val" style="color:var(--accent)"></b><br><input type="range" id="gl-spot" min="${(spot0 * 0.5).toFixed(2)}" max="${(spot0 * 1.5).toFixed(2)}" value="${spot0}" step="${step}" style="width:100%"></label>
      <label style="flex:1;min-width:160px">IV: <b id="gl-iv-val" style="color:var(--accent)"></b><br><input type="range" id="gl-iv" min="1" max="${ivMax}" value="${Math.round(iv0)}" step="1" style="width:100%"></label>
    </div>
    <div style="display:flex;gap:10px;align-items:center;margin-bottom:14px;font-family:var(--mono);font-size:11px;color:var(--tx2)">
      <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer" title="Couple IV to spot: a spot drop raises IV by the skew below, simulating a realistic joint spot↔vol move (vanna/charm P&L) instead of a flat-vol shift. Applies to Curves and Θ–Γ."><input type="checkbox" id="gl-link"> Link IV → spot (skew)</label>
      <label>skew <input type="number" id="gl-skew" value="1" step="0.25" style="width:50px;padding:3px;border-radius:4px;border:1px solid var(--bd);background:var(--bg2);color:var(--tx);font-family:var(--mono);font-size:11px"> vol pts / −1% spot</label>
    </div>
    <div class="summary" id="gl-readout" style="margin-bottom:14px"></div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;align-items:center;font-size:10px">
      <span style="color:var(--tx3)">View</span>
      <button class="btn btn-sm gl-view" data-v="curves" type="button">Curves</button>
      <button class="btn btn-sm btn-ghost gl-view" data-v="rent" type="button">Θ–Γ rent</button>
      <button class="btn btn-sm btn-ghost gl-view" data-v="surface" type="button">Surface</button>
      <button class="btn btn-sm btn-ghost gl-view" data-v="taylor" type="button">Taylor P&L</button>
      <button class="btn btn-sm btn-ghost gl-view" data-v="scatter" type="button">Greek×Greek</button>
    </div>
    <div id="gl-view-controls" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;align-items:center;font-size:10px"></div>
    <canvas id="gl-chart" height="150"></canvas>
    <div id="gl-surface-wrap" style="display:none">
      <canvas id="gl-surface" width="624" height="372" style="width:100%;cursor:grab;touch-action:none;border-radius:6px"></canvas>
    </div>
    <div id="gl-note" style="font-family:var(--mono);font-size:10.5px;color:var(--tx2);margin-top:10px;line-height:1.5"></div>`;

  const dte = document.getElementById("gl-dte") as HTMLInputElement;
  const spot = document.getElementById("gl-spot") as HTMLInputElement;
  const iv = document.getElementById("gl-iv") as HTMLInputElement;
  const link = document.getElementById("gl-link") as HTMLInputElement;
  const skew = document.getElementById("gl-skew") as HTMLInputElement;
  if (link) link.checked = !!GL.linked;
  if (skew) skew.value = String(GL.skew);
  dte.addEventListener("input", () => { GL.dte = +dte.value; _glRender(); });
  spot.addEventListener("input", () => { GL.spot = +spot.value; _glRender(); });
  iv.addEventListener("input", () => { GL.iv = +iv.value; _glRender(); });
  link.addEventListener("change", () => { GL.linked = link.checked; _glRender(); });
  skew.addEventListener("input", () => { GL.skew = parseFloat(skew.value) || 0; _glRender(); });
  body.querySelectorAll(".gl-view").forEach(b => b.addEventListener("click", () => {
    _glSetView((b as HTMLElement).dataset.v as string);
  }));
  const legSel = document.getElementById("gl-leg") as HTMLSelectElement | null;
  if (legSel) legSel.addEventListener("change", () => {
    _glSyncPrefs();
    const v = legSel.value;
    if (v.startsWith("agg:")) { openGreeksLab({ agg: true, ticker: v.slice(4) }); return; }
    const L = GL.legs[parseInt(v, 10)];
    if (L) openGreeksLab(L);
  });

  // drag-to-rotate for the 3D surface (window listeners wired once, globally)
  const surf = document.getElementById("gl-surface");
  if (surf) surf.addEventListener("mousedown", (e: any) => { _glDrag = true; _glLastX = e.clientX; _glLastY = e.clientY; surf.style.cursor = "grabbing"; });
  if (!_glDragWired) {
    _glDragWired = true;
    window.addEventListener("mousemove", (e: any) => {
      if (!_glDrag || !GL || GL.view !== "surface" || GL.surfMode !== "3d") return;
      const dx = e.clientX - _glLastX, dy = e.clientY - _glLastY;
      _glLastX = e.clientX; _glLastY = e.clientY;
      GL.surfYaw += dx * 0.01;
      GL.surfPitch = Math.max(0.12, Math.min(1.45, GL.surfPitch + dy * 0.01));
      _glSyncPrefs();
      _glDrawSurface();
    });
    window.addEventListener("mouseup", () => { _glDrag = false; const s = document.getElementById("gl-surface"); if (s) s.style.cursor = "grab"; });
  }

  _glSetView(GL.view);
}

// Build the per-view control row, toggle canvas visibility, then render.
function _glSetView(v: string) {
  if (!GL) return;
  GL.view = v;
  document.querySelectorAll(".gl-view").forEach(b => b.classList.toggle("btn-ghost", (b as HTMLElement).dataset.v !== v));
  const vc = document.getElementById("gl-view-controls");
  const metricOpts = Object.keys(GMETA).map(k => [k, GMETA[k].label]) as [string, string][];
  const dimOpts: [string, string][] = [["spot", "Spot"], ["dte", "Time"], ["iv", "IV"]];
  if (vc) {
    if (v === "curves") {
      vc.innerHTML = `<span style="color:var(--tx3)">Plot</span>
        <button class="btn btn-sm gl-metric" data-m="value" type="button">Value</button>
        <button class="btn btn-sm gl-metric" data-m="delta" type="button">Δ</button>
        <button class="btn btn-sm gl-metric" data-m="gamma" type="button">Γ</button>
        <button class="btn btn-sm gl-metric" data-m="theta" type="button">Θ</button>
        <button class="btn btn-sm gl-metric" data-m="vega" type="button">Vega</button>
        <span style="margin-left:auto;color:var(--tx3)">x-axis</span>
        <button class="btn btn-sm gl-xaxis" data-x="dte" type="button">Time</button>
        <button class="btn btn-sm gl-xaxis" data-x="price" type="button">Underlying price</button>`;
      vc.querySelectorAll(".gl-metric").forEach(b => b.addEventListener("click", () => { GL.metric = (b as HTMLElement).dataset.m; _glRender(); }));
      vc.querySelectorAll(".gl-xaxis").forEach(b => b.addEventListener("click", () => { GL.xaxis = (b as HTMLElement).dataset.x; _glRender(); }));
    } else if (v === "surface") {
      vc.innerHTML = `<span style="color:var(--tx3)">Z</span> ${_selHtml("gl-surfz", metricOpts, GL.surfZ)}
        <span style="color:var(--tx3)">x</span> ${_selHtml("gl-axisA", dimOpts, GL.surfAxisA)}
        <span style="color:var(--tx3)">y</span> ${_selHtml("gl-axisB", dimOpts, GL.surfAxisB)}
        <span style="margin-left:auto"></span>
        <button class="btn btn-sm gl-surfmode" data-sm="3d" type="button">3D</button>
        <button class="btn btn-sm gl-surfmode" data-sm="heat" type="button">Heatmap</button>`;
      (document.getElementById("gl-surfz") as HTMLSelectElement)?.addEventListener("change", e => { GL.surfZ = (e.target as HTMLSelectElement).value; _glRender(); });
      (document.getElementById("gl-axisA") as HTMLSelectElement)?.addEventListener("change", e => { GL.surfAxisA = (e.target as HTMLSelectElement).value; if (GL.surfAxisA === GL.surfAxisB) GL.surfAxisB = dimOpts.find(o => o[0] !== GL.surfAxisA)![0]; _glSetView("surface"); });
      (document.getElementById("gl-axisB") as HTMLSelectElement)?.addEventListener("change", e => { GL.surfAxisB = (e.target as HTMLSelectElement).value; if (GL.surfAxisB === GL.surfAxisA) GL.surfAxisA = dimOpts.find(o => o[0] !== GL.surfAxisB)![0]; _glSetView("surface"); });
      vc.querySelectorAll(".gl-surfmode").forEach(b => b.addEventListener("click", () => { GL.surfMode = (b as HTMLElement).dataset.sm; _glRender(); }));
    } else if (v === "scatter") {
      vc.innerHTML = `<span style="color:var(--tx3)">Y</span> ${_selHtml("gl-sy", metricOpts, GL.scatterY)}
        <span style="color:var(--tx3)">vs X</span> ${_selHtml("gl-sx", metricOpts, GL.scatterX)}
        <span style="color:var(--tx3);margin-left:8px">sweeping</span> ${_selHtml("gl-sweep", [["spot", "Spot"], ["dte", "Time"]], GL.sweepVar)}`;
      (document.getElementById("gl-sx") as HTMLSelectElement)?.addEventListener("change", e => { GL.scatterX = (e.target as HTMLSelectElement).value; _glRender(); });
      (document.getElementById("gl-sy") as HTMLSelectElement)?.addEventListener("change", e => { GL.scatterY = (e.target as HTMLSelectElement).value; _glRender(); });
      (document.getElementById("gl-sweep") as HTMLSelectElement)?.addEventListener("change", e => { GL.sweepVar = (e.target as HTMLSelectElement).value; _glRender(); });
    } else if (v === "taylor") {
      vc.innerHTML = `<span style="color:var(--tx3)">Drag the spot / IV / time sliders to set the move; bars show each Greek's net P&L contribution.</span>
        <button class="btn btn-sm btn-ghost gl-reset" type="button" style="margin-left:auto">Reset to start</button>`;
      vc.querySelector(".gl-reset")?.addEventListener("click", () => {
        GL.spot = GL.spot0; GL.iv = GL.iv0; GL.dte = GL.dte0;
        const ds = document.getElementById("gl-dte") as HTMLInputElement; if (ds) ds.value = String(GL.dte0);
        const ss = document.getElementById("gl-spot") as HTMLInputElement; if (ss) ss.value = String(GL.spot0);
        const is = document.getElementById("gl-iv") as HTMLInputElement; if (is) is.value = String(Math.round(GL.iv0));
        _glRender();
      });
    } else { // rent
      vc.innerHTML = `<span style="color:var(--tx3)">Net Θ vs its gamma-explained part −½σ²S²Γ across spot. Move the spot slider to read the breakeven below.</span>`;
    }
  }
  const chart = document.getElementById("gl-chart");
  const swrap = document.getElementById("gl-surface-wrap");
  if (v === "surface") destroyChart("gl-chart"); // destroy first — Chart.js restores canvas display on destroy
  if (chart) chart.style.display = v === "surface" ? "none" : "block";
  if (swrap) swrap.style.display = v === "surface" ? "block" : "none";
  const note = document.getElementById("gl-note"); if (note) note.innerHTML = "";
  _glRender();
}

function _glReadout() {
  const ivNow = _effIv(GL.spot);
  const r = _scopeBundle(GL.spot, ivNow, GL.dte);
  const pnl = r.value - r.cost;
  const col = (v: number) => (v >= 0 ? "var(--ok-tx)" : "var(--err-tx)");
  const ro = document.getElementById("gl-readout");
  if (ro) ro.innerHTML = `
    <div class="stat"><div class="stat-label">Net value</div><div class="stat-val" style="font-size:16px">${fmtDollar(r.value)}</div><div class="stat-sub">ext ${fmtDollar(r.extrinsic)}</div></div>
    <div class="stat"><div class="stat-label">Net Δ</div><div class="stat-val" style="font-size:16px;color:#90caf9">${r.delta.toFixed(0)}</div></div>
    <div class="stat"><div class="stat-label">Net Γ</div><div class="stat-val" style="font-size:16px;color:#ce93d8">${r.gamma.toFixed(1)}</div></div>
    <div class="stat"><div class="stat-label">Net Θ /day</div><div class="stat-val" style="font-size:16px;color:#f5c518">${fmtDollar(r.theta)}</div></div>
    <div class="stat"><div class="stat-label">Net Vega</div><div class="stat-val" style="font-size:16px;color:#4dd0e1">${fmtDollar(r.vega)}</div></div>
    <div class="stat"><div class="stat-label">P&L vs fill</div><div class="stat-val" style="font-size:16px;color:${col(pnl)}">${fmtDollar(pnl)}</div></div>
    <div class="stat" title="Vanna: Δ change per +1 vol point"><div class="stat-label">Vanna</div><div class="stat-val" style="font-size:14px;color:var(--tx2)">${r.vanna.toFixed(1)}</div><div class="stat-sub">Δ / vol pt</div></div>
    <div class="stat" title="Charm: Δ change per day toward expiry"><div class="stat-label">Charm</div><div class="stat-val" style="font-size:14px;color:var(--tx2)">${r.charm.toFixed(1)}</div><div class="stat-sub">Δ / day</div></div>
    <div class="stat" title="Vomma: vega change per +1 vol point"><div class="stat-label">Vomma</div><div class="stat-val" style="font-size:14px;color:var(--tx2)">${fmtDollar(r.vomma)}</div><div class="stat-sub">Vega / vol pt</div></div>
    <div class="stat" title="Color: gamma change per day toward expiry"><div class="stat-label">Color</div><div class="stat-val" style="font-size:14px;color:var(--tx2)">${r.color.toFixed(3)}</div><div class="stat-sub">Γ / day</div></div>`;
}

function _glRender() {
  if (!GL) return;
  _glSyncPrefs();
  const ivNow = _effIv(GL.spot);
  _glReadout();
  const dteLab = document.getElementById("gl-dte-val");
  const spotLab = document.getElementById("gl-spot-val");
  const ivLab = document.getElementById("gl-iv-val");
  if (dteLab) dteLab.textContent = GL.agg ? `+${GL.dte0 - GL.dte}d` : `${GL.dte}d`;
  if (spotLab) spotLab.textContent = `$${GL.spot.toFixed(2)}`;
  if (ivLab) ivLab.textContent = GL.linked ? `${GL.iv}% → ${(ivNow * 100).toFixed(0)}% eff` : `${GL.iv}%`;

  if (GL.view === "curves") _glDrawCurves();
  else if (GL.view === "rent") _glDrawRent();
  else if (GL.view === "surface") _glDrawSurface();
  else if (GL.view === "taylor") _glDrawTaylor();
  else if (GL.view === "scatter") _glDrawScatter();
}

// ── Curves: one net greek vs time or price ─────────────────────────────────
function _glDrawCurves() {
  document.querySelectorAll(".gl-metric").forEach(b => b.classList.toggle("btn-ghost", (b as HTMLElement).dataset.m !== GL.metric));
  document.querySelectorAll(".gl-xaxis").forEach(b => b.classList.toggle("btn-ghost", (b as HTMLElement).dataset.x !== GL.xaxis));
  const m = GL.metric;
  const labels: string[] = []; const ys: number[] = []; let markerIdx = 0;
  if (GL.xaxis === "dte") {
    const ivT = _effIv(GL.spot);
    const n = Math.min(GL.dte0, 121);
    const stepN = GL.dte0 > 0 ? GL.dte0 / Math.max(1, n) : 1;
    let best = 1e9;
    for (let i = 0; i <= n; i++) {
      const dd = Math.max(0, GL.dte0 - i * stepN);
      labels.push((GL.agg ? (GL.dte0 - dd) : dd).toFixed(0));
      ys.push(_scopeM(GL.spot, ivT, dd, m));
      const diff = Math.abs(dd - GL.dte); if (diff < best) { best = diff; markerIdx = i; }
    }
  } else {
    const lo = GL.spot0 * 0.5, hi = GL.spot0 * 1.5, n = 60; let best = 1e9;
    for (let i = 0; i <= n; i++) {
      const s = lo + (hi - lo) * (i / n);
      labels.push(s >= 100 ? s.toFixed(0) : s.toFixed(2));
      ys.push(_scopeM(s, _effIv(s), GL.dte, m));
      const diff = Math.abs(s - GL.spot); if (diff < best) { best = diff; markerIdx = i; }
    }
  }
  const meta = METRICS[GL.metric] || METRICS.theta;
  const canvas = document.getElementById("gl-chart");
  destroyChart("gl-chart");
  if (!canvas) return;
  chartInstances["gl-chart"] = new Chart(canvas, {
    type: "line",
    data: { labels, datasets: [{ label: meta.label, data: ys, borderColor: meta.color, backgroundColor: "transparent", borderWidth: 2, tension: 0.2, pointRadius: ys.map((_, i) => (i === markerIdx ? 5 : 0)), pointBackgroundColor: meta.color, pointBorderColor: "#fff" }] },
    options: deepMergeChartOpts(chartInteractionDefaults(), {
      responsive: true, animation: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { title: (it: any) => `${GL.xaxis === "dte" ? (GL.agg ? "fwd " : "DTE ") : "$"}${it[0]?.label}`, label: (ctx: any) => `${meta.label}: ${ctx.parsed.y?.toFixed(2)}` } } },
      scales: {
        x: { title: { display: true, text: GL.xaxis === "dte" ? (GL.agg ? "Days forward →" : "Days to expiry →") : "Underlying price", color: "#9b9b96" }, ticks: { maxTicksLimit: 10, color: "#9b9b96", font: { size: 9 } }, grid: { display: false } },
        y: { title: { display: true, text: meta.label, color: "#9b9b96" }, ticks: { color: "#9b9b96", font: { size: 9 } }, grid: { color: "rgba(255,255,255,0.05)" } },
      },
    }),
  });
}

// ── Θ–Γ gamma rent: net theta vs −½σ²S²Γ, plus breakeven vs implied move ────
function _glDrawRent() {
  const lo = GL.spot0 * 0.5, hi = GL.spot0 * 1.5, n = 80;
  const labels: string[] = [], thetaArr: number[] = [], rentArr: number[] = [];
  let markerIdx = 0, best = 1e9;
  for (let i = 0; i <= n; i++) {
    const s = lo + (hi - lo) * (i / n);
    const iv = _effIv(s);
    const r = _scopeBundle(s, iv, GL.dte);
    const rent = -0.5 * iv * iv * s * s * r.gamma / 365; // gamma-explained theta, $/day net
    labels.push(s >= 100 ? s.toFixed(0) : s.toFixed(2));
    thetaArr.push(r.theta); rentArr.push(rent);
    const d = Math.abs(s - GL.spot); if (d < best) { best = d; markerIdx = i; }
  }
  const ivc = _effIv(GL.spot);
  const rc = _scopeBundle(GL.spot, ivc, GL.dte);
  const beReal = (rc.gamma !== 0 && (rc.theta / rc.gamma) < 0);
  const beMove = beReal ? Math.sqrt(-2 * rc.theta / rc.gamma) : NaN; // mult cancels in the ratio
  const impMove = GL.spot * ivc / Math.sqrt(365);
  const ratio = (beReal && impMove > 0) ? beMove / impMove : NaN;

  const canvas = document.getElementById("gl-chart");
  destroyChart("gl-chart");
  if (canvas) chartInstances["gl-chart"] = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Net Θ ($/day)", data: thetaArr, borderColor: "#f5c518", backgroundColor: "transparent", borderWidth: 2, tension: 0.2, pointRadius: thetaArr.map((_, i) => (i === markerIdx ? 5 : 0)), pointBackgroundColor: "#f5c518", pointBorderColor: "#fff" },
        { label: "−½σ²S²Γ ($/day)", data: rentArr, borderColor: "#ce93d8", backgroundColor: "transparent", borderWidth: 2, borderDash: [5, 4], tension: 0.2, pointRadius: 0 },
      ],
    },
    options: deepMergeChartOpts(chartInteractionDefaults(), {
      responsive: true, animation: false,
      plugins: { legend: { display: true, labels: { color: "#cfcfca", font: { size: 10 }, boxWidth: 18 } }, tooltip: { callbacks: { title: (it: any) => `Spot $${it[0]?.label}`, label: (ctx: any) => `${ctx.dataset.label}: ${ctx.parsed.y?.toFixed(2)}` } } },
      scales: {
        x: { title: { display: true, text: "Underlying price", color: "#9b9b96" }, ticks: { maxTicksLimit: 10, color: "#9b9b96", font: { size: 9 } }, grid: { display: false } },
        y: { title: { display: true, text: "$/day (net)", color: "#9b9b96" }, ticks: { color: "#9b9b96", font: { size: 9 } }, grid: { color: "rgba(255,255,255,0.05)" } },
      },
    }),
  });
  const note = document.getElementById("gl-note");
  if (note) {
    if (beReal) {
      const verdict = ratio > 1.04 ? "theta is <b>more</b> than fair pay for your gamma (rich)" : ratio < 0.96 ? "theta is <b>less</b> than fair pay for your gamma (cheap)" : "theta fairly compensates your gamma";
      note.innerHTML = `At spot $${GL.spot.toFixed(2)}: <b style="color:var(--accent)">gamma breakeven move ±$${beMove.toFixed(2)}</b> (${(beMove / GL.spot * 100).toFixed(2)}%) vs <b style="color:var(--accent)">1σ implied move ±$${impMove.toFixed(2)}</b> (${(impMove / GL.spot * 100).toFixed(2)}%) — ratio <b>${ratio.toFixed(2)}×</b>. Net Θ tracks −½σ²S²Γ because the identity sums across legs; ratio≈1 ⇒ ${verdict}.`;
    } else {
      note.innerHTML = `Breakeven undefined here (net Θ and Γ share a sign — e.g. deep ITM/expired or offsetting legs). Move the spot or time slider.`;
    }
  }
}

// ── Taylor-expansion net P&L attribution ───────────────────────────────────
function _glDrawTaylor() {
  const { spot0, iv0, dte0 } = GL;
  const dS = GL.spot - spot0;
  const dVol = GL.iv - iv0;          // vol points
  const dDays = dte0 - GL.dte;       // days forward (>0 as time passes)
  const ivRef = iv0 / 100;
  // net base greeks at the reference (today): scope bundle with slider at dte0
  const b0 = _scopeBundle(spot0, ivRef, dte0);
  const parts: [string, number][] = [
    ["Δ·dS", b0.delta * dS],
    ["½Γ·dS²", 0.5 * b0.gamma * dS * dS],
    ["Θ·dt", b0.theta * dDays],
    ["Vega·dσ", b0.vega * dVol],
    ["Vanna·dS·dσ", b0.vanna * dS * dVol],
    ["½Vomma·dσ²", 0.5 * b0.vomma * dVol * dVol],
    ["Charm·dS·dt", b0.charm * dS * dDays],
    ["⅙Speed·dS³", (1 / 6) * b0.speed * dS * dS * dS],
  ];
  const taylor = parts.reduce((a, p) => a + p[1], 0);
  const exact = _scopeBundle(GL.spot, GL.iv / 100, GL.dte).value - b0.value;
  const residual = exact - taylor;
  const rows = parts.concat([["Residual", residual]]);
  const labels = rows.map(r => r[0]);
  const vals = rows.map(r => r[1]);
  const colors = rows.map(r => (r[0] === "Residual" ? "#9b9b96" : (r[1] >= 0 ? "#66bb6a" : "#ef5350")));

  const canvas = document.getElementById("gl-chart");
  destroyChart("gl-chart");
  if (canvas) chartInstances["gl-chart"] = new Chart(canvas, {
    type: "bar",
    data: { labels, datasets: [{ label: "P&L contribution ($)", data: vals, backgroundColor: colors, borderWidth: 0 }] },
    options: deepMergeChartOpts(chartInteractionDefaults(), {
      indexAxis: "y", responsive: true, animation: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx: any) => `${fmtDollar(ctx.parsed.x)}` } } },
      scales: {
        x: { title: { display: true, text: "P&L contribution ($, net position)", color: "#9b9b96" }, ticks: { color: "#9b9b96", font: { size: 9 } }, grid: { color: "rgba(255,255,255,0.05)" } },
        y: { ticks: { color: "#cfcfca", font: { size: 10 } }, grid: { display: false } },
      },
    }),
  });
  const note = document.getElementById("gl-note");
  if (note) {
    const pct = spot0 > 0 ? (dS / spot0 * 100) : 0;
    const acc = exact !== 0 ? (taylor / exact * 100) : (taylor === 0 ? 100 : 0);
    note.innerHTML = `Move: dS <b>${dS >= 0 ? "+" : ""}$${dS.toFixed(2)}</b> (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%) · dσ <b>${dVol >= 0 ? "+" : ""}${dVol.toFixed(0)}</b> vol pts · dt <b>${dDays}</b> days fwd. Taylor ΔV <b style="color:var(--accent)">${fmtDollar(taylor)}</b> vs exact reprice <b style="color:var(--accent)">${fmtDollar(exact)}</b> · residual ${fmtDollar(residual)} (${acc.toFixed(0)}% explained). Greeks evaluated at the start; residual grows with the move size.`;
  }
}

// ── Greek×Greek parametric scatter (net) ───────────────────────────────────
function _glDrawScatter() {
  const xK = GL.scatterX, yK = GL.scatterY, sweep = GL.sweepVar;
  const ivDec = GL.iv / 100;
  const pts: { x: number; y: number }[] = [];
  const n = 90;
  let cur = { x: 0, y: 0 };
  if (sweep === "spot") {
    const lo = GL.spot0 * 0.5, hi = GL.spot0 * 1.5;
    for (let i = 0; i <= n; i++) {
      const s = lo + (hi - lo) * (i / n);
      pts.push({ x: _scopeM(s, ivDec, GL.dte, xK), y: _scopeM(s, ivDec, GL.dte, yK) });
    }
    cur = { x: _scopeM(GL.spot, ivDec, GL.dte, xK), y: _scopeM(GL.spot, ivDec, GL.dte, yK) };
  } else {
    for (let i = 0; i <= n; i++) {
      const dd = GL.dte0 * (1 - i / n);
      pts.push({ x: _scopeM(GL.spot, ivDec, dd, xK), y: _scopeM(GL.spot, ivDec, dd, yK) });
    }
    cur = { x: _scopeM(GL.spot, ivDec, GL.dte, xK), y: _scopeM(GL.spot, ivDec, GL.dte, yK) };
  }
  const xm = GMETA[xK], ym = GMETA[yK];
  const canvas = document.getElementById("gl-chart");
  destroyChart("gl-chart");
  if (canvas) chartInstances["gl-chart"] = new Chart(canvas, {
    type: "scatter",
    data: {
      datasets: [
        { label: `${ym.label} vs ${xm.label}`, data: pts, showLine: true, borderColor: ym.color, backgroundColor: "transparent", borderWidth: 2, pointRadius: 0, tension: 0.1 },
        { label: "current", data: [cur], showLine: false, pointRadius: 6, pointBackgroundColor: "#fff", pointBorderColor: ym.color, pointBorderWidth: 2 },
      ],
    },
    options: deepMergeChartOpts(chartInteractionDefaults(), {
      responsive: true, animation: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx: any) => `${xm.label} ${ctx.parsed.x?.toFixed(xm.prec)}, ${ym.label} ${ctx.parsed.y?.toFixed(ym.prec)}` } } },
      scales: {
        x: { type: "linear", title: { display: true, text: xm.label, color: "#9b9b96" }, ticks: { color: "#9b9b96", font: { size: 9 } }, grid: { color: "rgba(255,255,255,0.05)" } },
        y: { title: { display: true, text: ym.label, color: "#9b9b96" }, ticks: { color: "#9b9b96", font: { size: 9 } }, grid: { color: "rgba(255,255,255,0.05)" } },
      },
    }),
  });
  const note = document.getElementById("gl-note");
  if (note) note.innerHTML = `Tracing net <b>${ym.label}</b> against <b>${xm.label}</b> as <b>${sweep === "spot" ? "Spot" : "Time"}</b> sweeps; the dot is your current point. A near-straight Θ-vs-Γ locus is the BSM identity Θ ≈ −½σ²S²Γ.`;
}

// ── Surface: compute the Z grid over two dims (net position) ────────────────
function _glComputeGrid() {
  const N = GL.surfMode === "heat" ? 52 : 30;
  const A = GL.surfAxisA, B = GL.surfAxisB;
  const [aLo, aHi] = _dimRange(A), [bLo, bHi] = _dimRange(B);
  const aVals: number[] = [], bVals: number[] = [], Z: number[][] = [];
  let zmin = 1e18, zmax = -1e18;
  for (let j = 0; j < N; j++) {
    const bv = bLo + (bHi - bLo) * j / (N - 1); bVals.push(bv);
    const row: number[] = [];
    for (let i = 0; i < N; i++) {
      const av = aLo + (aHi - aLo) * i / (N - 1); if (j === 0) aVals.push(av);
      let S = GL.spot, dte = GL.dte, ivPct = GL.iv;
      if (A === "spot") S = av; else if (A === "dte") dte = av; else ivPct = av;
      if (B === "spot") S = bv; else if (B === "dte") dte = bv; else ivPct = bv;
      const z = _scopeM(S, ivPct / 100, dte, GL.surfZ);
      row.push(z); if (z < zmin) zmin = z; if (z > zmax) zmax = z;
    }
    Z.push(row);
  }
  const meta = GMETA[GL.surfZ];
  return {
    N, Z, aVals, bVals, zmin, zmax,
    aLo, aHi, bLo, bHi, A, B,
    aLabel: DIMS[A], bLabel: DIMS[B], zlabel: meta.label, prec: meta.prec,
    diverging: zmin < -1e-9 && zmax > 1e-9,
  };
}

function _glDrawSurface() {
  const cv = document.getElementById("gl-surface") as HTMLCanvasElement | null;
  if (!cv) return;
  document.querySelectorAll(".gl-surfmode").forEach(b => b.classList.toggle("btn-ghost", (b as HTMLElement).dataset.sm !== GL.surfMode));
  const grid = _glComputeGrid();
  if (GL.surfMode === "heat") _glPaintHeat(cv, grid); else _glPaintWire(cv, grid);
  const note = document.getElementById("gl-note");
  if (note) note.innerHTML = `<b style="color:var(--accent)">${grid.zlabel}</b> (net position) over <b>${grid.aLabel}</b> × <b>${grid.bLabel}</b> · range ${grid.zmin.toFixed(grid.prec)} … ${grid.zmax.toFixed(grid.prec)}. Other inputs held at the sliders. ${GL.surfMode === "3d" ? "Drag the surface to rotate." : "Brighter = higher; bands act as contours."}`;
}

function _glColorbar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, grid: any) {
  const steps = 40;
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    ctx.fillStyle = _cmap(t, grid.diverging);
    ctx.fillRect(x, y + h - (i + 1) / steps * h, w, h / steps + 1);
  }
  ctx.fillStyle = "#9b9b96"; ctx.font = "9px monospace"; ctx.textAlign = "left";
  ctx.fillText(grid.zmax.toFixed(grid.prec), x + w + 3, y + 8);
  ctx.fillText(grid.zmin.toFixed(grid.prec), x + w + 3, y + h);
}

function _glPaintHeat(cv: HTMLCanvasElement, grid: any) {
  const ctx = cv.getContext("2d"); if (!ctx) return;
  const W = cv.width, H = cv.height; ctx.clearRect(0, 0, W, H);
  const padL = 48, padR = 70, padT = 12, padB = 36;
  const pw = W - padL - padR, ph = H - padT - padB;
  const N = grid.N, range = (grid.zmax - grid.zmin) || 1, nb = 14;
  const cw = pw / (N - 1) + 1, chh = ph / (N - 1) + 1;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const z01 = (grid.Z[j][i] - grid.zmin) / range;
      const band = Math.round(z01 * nb) / nb;
      ctx.fillStyle = _cmap(band, grid.diverging);
      const x = padL + pw * (i / (N - 1)) - cw / 2;
      const y = padT + ph * (1 - j / (N - 1)) - chh / 2;
      ctx.fillRect(x, y, cw, chh);
    }
  }
  ctx.strokeStyle = "rgba(255,255,255,0.18)"; ctx.lineWidth = 1; ctx.strokeRect(padL, padT, pw, ph);
  ctx.fillStyle = "#9b9b96"; ctx.font = "9px monospace";
  ctx.textAlign = "center";
  for (let k = 0; k <= 4; k++) {
    const av = grid.aLo + (grid.aHi - grid.aLo) * k / 4;
    ctx.fillText(grid.A === "spot" ? av.toFixed(av >= 100 ? 0 : 1) : av.toFixed(0), padL + pw * k / 4, H - padB + 14);
  }
  ctx.textAlign = "right";
  for (let k = 0; k <= 4; k++) {
    const bv = grid.bLo + (grid.bHi - grid.bLo) * k / 4;
    ctx.fillText(grid.B === "spot" ? bv.toFixed(bv >= 100 ? 0 : 1) : bv.toFixed(0), padL - 5, padT + ph * (1 - k / 4) + 3);
  }
  ctx.fillStyle = "#cfcfca"; ctx.textAlign = "center";
  ctx.fillText(grid.aLabel + " →", padL + pw / 2, H - 6);
  ctx.save(); ctx.translate(12, padT + ph / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(grid.bLabel + " →", 0, 0); ctx.restore();
  const ta = (_dimCur(grid.A) - grid.aLo) / (grid.aHi - grid.aLo);
  const tb = (_dimCur(grid.B) - grid.bLo) / (grid.bHi - grid.bLo);
  if (ta >= 0 && ta <= 1 && tb >= 0 && tb <= 1) {
    const mx = padL + pw * ta, my = padT + ph * (1 - tb);
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(mx, my, 5, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(mx - 8, my); ctx.lineTo(mx + 8, my); ctx.moveTo(mx, my - 8); ctx.lineTo(mx, my + 8); ctx.stroke();
  }
  _glColorbar(ctx, W - padR + 16, padT, 12, ph, grid);
}

function _glPaintWire(cv: HTMLCanvasElement, grid: any) {
  const ctx = cv.getContext("2d"); if (!ctx) return;
  const W = cv.width, H = cv.height; ctx.clearRect(0, 0, W, H);
  const cx = (W - 60) * 0.5, cy = H * 0.60, scale = Math.min(W - 60, H) * 0.36;
  const cosY = Math.cos(GL.surfYaw), sinY = Math.sin(GL.surfYaw);
  const cosP = Math.cos(GL.surfPitch), sinP = Math.sin(GL.surfPitch);
  const N = grid.N, range = (grid.zmax - grid.zmin) || 1;
  const proj = (ix: number, iy: number, zVal: number) => {
    const x = (ix / (N - 1)) * 2 - 1;
    const y = (iy / (N - 1)) * 2 - 1;
    const z = ((zVal - grid.zmin) / range) * 1.15 - 0.05;
    const xr = x * cosY - y * sinY, yr = x * sinY + y * cosY;
    const yr2 = yr * cosP - z * sinP, zr2 = yr * sinP + z * cosP;
    return { sx: cx + xr * scale, sy: cy - zr2 * scale, depth: yr2 };
  };
  const c0 = proj(0, 0, grid.zmin), c1 = proj(N - 1, 0, grid.zmin), c2 = proj(N - 1, N - 1, grid.zmin), c3 = proj(0, N - 1, grid.zmin);
  ctx.strokeStyle = "rgba(255,255,255,0.10)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(c0.sx, c0.sy); ctx.lineTo(c1.sx, c1.sy); ctx.lineTo(c2.sx, c2.sy); ctx.lineTo(c3.sx, c3.sy); ctx.closePath(); ctx.stroke();
  const quads: { p: any[]; t: number; depth: number }[] = [];
  for (let j = 0; j < N - 1; j++) {
    for (let i = 0; i < N - 1; i++) {
      const p00 = proj(i, j, grid.Z[j][i]), p10 = proj(i + 1, j, grid.Z[j][i + 1]);
      const p11 = proj(i + 1, j + 1, grid.Z[j + 1][i + 1]), p01 = proj(i, j + 1, grid.Z[j + 1][i]);
      const zavg = (grid.Z[j][i] + grid.Z[j][i + 1] + grid.Z[j + 1][i + 1] + grid.Z[j + 1][i]) / 4;
      const depth = (p00.depth + p10.depth + p11.depth + p01.depth) / 4;
      quads.push({ p: [p00, p10, p11, p01], t: (zavg - grid.zmin) / range, depth });
    }
  }
  quads.sort((a, b) => a.depth - b.depth);
  for (const q of quads) {
    ctx.beginPath(); ctx.moveTo(q.p[0].sx, q.p[0].sy);
    for (let k = 1; k < 4; k++) ctx.lineTo(q.p[k].sx, q.p[k].sy);
    ctx.closePath();
    ctx.fillStyle = _cmap(q.t, grid.diverging); ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.20)"; ctx.lineWidth = 0.5; ctx.stroke();
  }
  const taF = (_dimCur(grid.A) - grid.aLo) / (grid.aHi - grid.aLo) * (N - 1);
  const tbF = (_dimCur(grid.B) - grid.bLo) / (grid.bHi - grid.bLo) * (N - 1);
  if (taF >= 0 && taF <= N - 1 && tbF >= 0 && tbF <= N - 1) {
    const zc = _scopeM(GL.spot, GL.iv / 100, GL.dte, GL.surfZ);
    const top = proj(taF, tbF, zc), bot = proj(taF, tbF, grid.zmin);
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(bot.sx, bot.sy); ctx.lineTo(top.sx, top.sy); ctx.stroke();
    ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(top.sx, top.sy, 4, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = "#cfcfca"; ctx.font = "10px monospace"; ctx.textAlign = "center";
  const am = proj((N - 1) / 2, 0, grid.zmin); ctx.fillText(grid.aLabel, am.sx, am.sy + 14);
  const bm = proj(0, (N - 1) / 2, grid.zmin); ctx.fillText(grid.bLabel, bm.sx - 10, bm.sy);
  _glColorbar(ctx, W - 40, 16, 12, H - 60, grid);
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

// Open the lab from elsewhere (e.g. the Simulation tab) for a ticker — aggregate
// if it has multiple legs, else its single leg.
document.addEventListener("click", (e) => {
  const sb = (e.target as HTMLElement).closest("#btn-sim-greeks") as HTMLElement | null;
  if (!sb) return;
  e.preventDefault();
  const foc = (document.getElementById("sim-focus-select") as HTMLSelectElement)?.value || "";
  const all = Array.from(document.querySelectorAll(".btn-greeks")) as HTMLElement[];
  if (!all.length) return;
  const mine = foc ? all.filter(b => b.dataset.gTicker === foc) : [];
  if (mine.length >= 2) { openGreeksLab({ agg: true, ticker: foc }); return; }
  (mine[0] || all[0]).click();
});

document.getElementById("greeks-modal-close")?.addEventListener("click", () => {
  const m = document.getElementById("greeks-modal"); if (m) m.hidden = true;
});
document.getElementById("greeks-modal")?.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).id === "greeks-modal") {
    const m = document.getElementById("greeks-modal"); if (m) m.hidden = true;
  }
});
