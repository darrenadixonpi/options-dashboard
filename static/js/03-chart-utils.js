// Shared Chart.js interaction helpers — crosshair + label layout.

(function initOdChartUtils() {
  if (typeof Chart === "undefined") return;

  const crosshairPlugin = {
    id: "odCrosshair",
    afterDraw(chart, _args, opts) {
      if (opts === false || opts?.enabled === false) return;
      const active = chart.tooltip?.getActiveElements?.() || chart.tooltip?._active || [];
      if (!active.length) return;
      const el = active[0].element;
      const axis = opts?.axis || "x";
      if (!chart.chartArea) return;
      const { top, bottom, left, right } = chart.chartArea;
      const ctx = chart.ctx;
      ctx.save();
      ctx.strokeStyle = opts?.color || "rgba(255,255,255,0.28)";
      ctx.lineWidth = opts?.width || 1;
      ctx.setLineDash(opts?.dash || [4, 4]);
      ctx.beginPath();
      if (axis === "y") {
        const y = el?.y;
        if (y == null || y < top || y > bottom) { ctx.restore(); return; }
        ctx.moveTo(left, y);
        ctx.lineTo(right, y);
      } else {
        const x = el?.x;
        if (x == null || x < left || x > right) { ctx.restore(); return; }
        ctx.moveTo(x, top);
        ctx.lineTo(x, bottom);
      }
      ctx.stroke();
      ctx.restore();
    },
  };

  if (!Chart.registry.plugins.get("odCrosshair")) {
    Chart.register(crosshairPlugin);
  }
})();

/** Default index tooltip + vertical crosshair (axis: 'x' | 'y'). */
function chartInteractionDefaults(opts = {}) {
  const axis = opts.axis || "x";
  const base = {
    interaction: { mode: "index", intersect: false, axis },
    plugins: {
      tooltip: { mode: "index", intersect: false },
      odCrosshair: { enabled: opts.crosshair !== false, axis: opts.axis || "x" },
    },
  };
  if (!opts.extra) return base;
  return deepMergeChartOpts(base, opts.extra);
}

function deepMergeChartOpts(a, b) {
  const out = { ...a, plugins: { ...(a.plugins || {}) }, scales: { ...(a.scales || {}) } };
  for (const [k, v] of Object.entries(b)) {
    if (k === "plugins" && v && typeof v === "object") {
      out.plugins = { ...out.plugins };
      for (const [pk, pv] of Object.entries(v)) {
        out.plugins[pk] = pv && typeof pv === "object" && !Array.isArray(pv)
          ? { ...(out.plugins[pk] || {}), ...pv }
          : pv;
      }
    } else if (k === "scales" && v && typeof v === "object") {
      out.scales = { ...out.scales };
      for (const [sk, sv] of Object.entries(v)) {
        out.scales[sk] = sv && typeof sv === "object" ? { ...(out.scales[sk] || {}), ...sv } : sv;
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Spread horizontal line labels (strikes, BE, etc.) to reduce overlap.
 * Returns items with position + yAdjust for Chart.js annotation labels.
 */
function layoutHorizontalLineLabels(lines, yMin, yMax) {
  if (!lines.length) return [];
  const span = Math.max(yMax - yMin, 0.01);
  const minGap = span * 0.04;
  const sorted = [...lines].sort((a, b) => b.y - a.y);
  const placed = [];

  for (let i = 0; i < sorted.length; i++) {
    const item = { ...sorted[i] };
    let position = "start";
    let yAdjust = 0;
    let lane = 0;

    for (const p of placed) {
      if (Math.abs(p.y - item.y) < minGap) {
        position = p.position === "start" ? "end" : "start";
        lane = Math.max(lane, (p.lane || 0) + 1);
      }
    }
    yAdjust = (lane % 2 === 0 ? -1 : 1) * Math.ceil(lane / 2) * 12;
    item.position = position;
    item.yAdjust = yAdjust;
    item.lane = lane;
    placed.push(item);
  }
  return placed;
}

function buildHorizontalLineAnnotations(lines, yMin, yMax, styleFor) {
  const laid = layoutHorizontalLineLabels(lines, yMin, yMax);
  const annotations = {};
  laid.forEach((item, i) => {
    const style = styleFor(item);
    annotations[item.key || `hline_${i}`] = {
      type: "line",
      yMin: item.y,
      yMax: item.y,
      borderColor: style.borderColor,
      borderWidth: style.borderWidth ?? 1,
      borderDash: style.borderDash,
      label: {
        display: true,
        content: item.content,
        position: item.position,
        yAdjust: item.yAdjust,
        backgroundColor: style.bg || "rgba(30,30,28,0.85)",
        color: style.color || "#e8e8e4",
        font: { size: style.fontSize || 9, family: "JetBrains Mono" },
        padding: 3,
      },
    };
  });
  return annotations;
}

function estimatePathChartYRange(pd) {
  const vals = [];
  for (const key of ["p5", "p95", "p50"]) {
    (pd[key] || []).forEach(v => { if (Number.isFinite(v)) vals.push(v); });
  }
  (pd.strikes || []).forEach(s => { if (Number.isFinite(s.strike)) vals.push(s.strike); });
  (pd.breakevens || []).forEach(b => { if (Number.isFinite(b.value)) vals.push(b.value); });
  if (!vals.length) return { yMin: 0, yMax: 1 };
  let yMin = Math.min(...vals);
  let yMax = Math.max(...vals);
  const pad = (yMax - yMin) * 0.08 || 1;
  return { yMin: yMin - pad, yMax: yMax + pad };
}
