// ═══════════════════════════════════════════════════════════════════════════
// Snapshot history UI (#2)
// ═══════════════════════════════════════════════════════════════════════════

let snapshotAttributionCache = [];

async function loadSnapshotHistoryUI() {
  const sec = document.getElementById("snapshot-history-section");
  if (!sec) return;
  sec.hidden = false;
  const attrEl = document.getElementById("snapshot-attribution-chart-wrap");
  const greekEl = document.getElementById("snapshot-greek-chart-wrap");
  const sessionsEl = document.getElementById("snapshot-sessions-list");
  if (!attrEl || !greekEl || !sessionsEl) return;

  attrEl.innerHTML = '<span style="color:var(--tx3);font-size:11px">Loading…</span>';
  greekEl.innerHTML = "";
  sessionsEl.innerHTML = "";

  try {
    const [attrRes, timelineRes, sessRes, bookRes] = await Promise.all([
      fetchJson("/api/snapshots/attribution?limit=30"),
      fetchJson("/api/snapshots/portfolio-timeline?limit=40"),
      fetchJson("/api/snapshots/sessions?limit=15"),
      fetchJson("/api/snapshots/book-timeline?limit=30"),
    ]);

    snapshotAttributionCache = attrRes.data?.snapshots || [];
    renderAttributionTimeline(snapshotAttributionCache);
    renderGreekTimeline(timelineRes.data?.points || []);
    renderFetchSessions(sessRes.data?.sessions || [], bookRes.data);
    populateSnapshotDiffSelects(snapshotAttributionCache);

    const sel = document.getElementById("snapshot-ticker-select") as HTMLSelectElement | null;
    if (sel && state.positions.length) {
      const tickers = [...new Set(state.positions.map(p => p.ticker))].sort();
      const cur = sel.value;
      sel.innerHTML = tickers.map(t => `<option value="${t}">${t}</option>`).join("");
      if (cur && tickers.includes(cur)) sel.value = cur;
      else if (tickers.length) sel.value = tickers[0];
      loadTickerSnapshotHistory(sel.value);
    }
  } catch (e) {
    attrEl.innerHTML = `<span style="color:var(--err-tx);font-size:11px">${esc(e.message)}</span>`;
  }
}

function snapshotLabel(s) {
  try {
    return new Date(s.timestamp).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return s.timestamp || `#${s.id}`;
  }
}

function populateSnapshotDiffSelects(snapshots) {
  const selA = document.getElementById("snapshot-diff-a") as HTMLSelectElement | null;
  const selB = document.getElementById("snapshot-diff-b") as HTMLSelectElement | null;
  const result = document.getElementById("snapshot-diff-result");
  if (!selA || !selB) return;
  if (!snapshots.length) {
    selA.innerHTML = selB.innerHTML = '<option value="">—</option>';
    if (result) result.innerHTML = '<span style="color:var(--tx3)">Need 2+ fetches with attribution saved.</span>';
    return;
  }
  const opts = snapshots.map(s =>
    `<option value="${s.id}">${snapshotLabel(s)} · ${fmtDollar(s.portfolioTotal ?? 0)}</option>`
  ).join("");
  selA.innerHTML = opts;
  selB.innerHTML = opts;
  if (snapshots.length > 1) {
    selA.value = String(snapshots[1].id);
    selB.value = String(snapshots[0].id);
  }
}

async function runSnapshotDiff() {
  const result = document.getElementById("snapshot-diff-result");
  const idA = parseInt((document.getElementById("snapshot-diff-a") as HTMLSelectElement | null)?.value ?? "", 10);
  const idB = parseInt((document.getElementById("snapshot-diff-b") as HTMLSelectElement | null)?.value ?? "", 10);
  if (!result || !idA || !idB) return;
  if (idA === idB) {
    result.innerHTML = '<span style="color:var(--warn-tx)">Pick two different snapshots.</span>';
    return;
  }
  result.innerHTML = '<span style="color:var(--tx3)">Computing…</span>';
  try {
    const { ok, data } = await fetchJson(`/api/snapshots/diff?id_a=${idA}&id_b=${idB}`);
    if (!ok || data.error) {
      result.innerHTML = `<span style="color:var(--err-tx)">${esc(data.error || "Diff failed")}</span>`;
      return;
    }
    renderSnapshotDiffResult(data);
  } catch (e) {
    result.innerHTML = `<span style="color:var(--err-tx)">${esc(e.message)}</span>`;
  }
}

function renderSnapshotDiffResult(data) {
  const result = document.getElementById("snapshot-diff-result");
  if (!result) return;
  const p = data.portfolioDelta || {};
  const fmt = (x) => {
    const col = x >= 0 ? "var(--ok-tx)" : "var(--err-tx)";
    return `<span style="color:${col}">${fmtDollar(x)}</span>`;
  };
  let html = `<div style="margin-bottom:8px;color:var(--tx2)">${snapshotLabel(data.snapshotA)} → ${snapshotLabel(data.snapshotB)}</div>`;
  html += `<div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:10px">`;
  for (const [k, label] of [["pricePnl", "Δ price"], ["gammaPnl", "Γ"], ["thetaPnl", "Θ"], ["vegaPnl", "V"], ["total", "Total"]]) {
    html += `<span>${label} ${fmt(p[k] ?? 0)}</span>`;
  }
  html += `</div>`;
  const rows = (data.byTicker || []).filter(r => Math.abs(r.totalDelta) >= 0.01).slice(0, 12);
  if (rows.length) {
    html += '<table class="hist-tbl"><tr><th>Ticker</th><th>Δ Total</th><th>Δ Price</th><th>Δ Θ</th><th>Δ V</th></tr>';
    for (const r of rows) {
      html += `<tr><td>${r.ticker}</td><td>${fmt(r.totalDelta)}</td><td>${fmt(r.priceDelta)}</td><td>${fmt(r.thetaDelta)}</td><td>${fmt(r.vegaDelta)}</td></tr>`;
    }
    html += "</table>";
  } else {
    html += '<span style="color:var(--tx3)">No per-ticker delta.</span>';
  }
  result.innerHTML = html;
}

function renderAttributionTimeline(snapshots) {
  const wrap = document.getElementById("snapshot-attribution-chart-wrap");
  if (!wrap) return;
  if (!snapshots.length) {
    wrap.innerHTML = '<span style="color:var(--tx3);font-size:11px">No attribution snapshots yet — re-fetch twice to build history.</span>';
    destroyChart("chart-snapshot-attribution");
    return;
  }
  const chrono = [...snapshots].reverse();
  const labels = chrono.map(snapshotLabel);
  const totals = chrono.map(s => s.portfolioTotal ?? (s.attribution?.portfolio?.total ?? 0));
  wrap.innerHTML = '<canvas id="chart-snapshot-attribution" height="140"></canvas>';
  destroyChart("chart-snapshot-attribution");
  chartInstances["chart-snapshot-attribution"] = new Chart(document.getElementById("chart-snapshot-attribution"), {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Est. Δ attribution total",
        data: totals,
        borderColor: "#ffb74d",
        backgroundColor: "rgba(255,183,77,0.12)",
        fill: true,
        tension: 0.2,
        pointRadius: 2,
      }],
    },
    options: deepMergeChartOpts(chartInteractionDefaults(), {
      responsive: true,
      animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { maxTicksLimit: 8, color: "#9b9b96", font: { size: 9 } }, grid: { display: false } },
        y: { ticks: { callback: v => fmtDollar(v), color: "#9b9b96", font: { size: 9 } }, grid: { color: "rgba(255,255,255,0.05)" } },
      },
    }),
  });
}

function renderGreekTimeline(points) {
  const wrap = document.getElementById("snapshot-greek-chart-wrap");
  if (!wrap) return;
  if (!points.length) {
    wrap.innerHTML = '<span style="color:var(--tx3);font-size:11px">No greek snapshots yet — fetch live data to record book greeks.</span>';
    destroyChart("chart-snapshot-greeks");
    return;
  }
  const labels = points.map(p => {
    try { return new Date(p.timestamp).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
    catch { return p.timestamp; }
  });
  wrap.innerHTML = '<canvas id="chart-snapshot-greeks" height="140"></canvas>';
  destroyChart("chart-snapshot-greeks");
  chartInstances["chart-snapshot-greeks"] = new Chart(document.getElementById("chart-snapshot-greeks"), {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Book Δ", data: points.map(p => p.delta), borderColor: "#90caf9", borderWidth: 1.5, pointRadius: 0, tension: 0.2 },
        { label: "Book Θ ($/d)", data: points.map(p => p.theta), borderColor: "#f5c518", borderWidth: 1.5, pointRadius: 0, tension: 0.2 },
      ],
    },
    options: deepMergeChartOpts(chartInteractionDefaults(), {
      responsive: true,
      animation: false,
      plugins: { legend: { display: true, position: "top", labels: { color: "#e8e8e4", font: { size: 9 }, boxWidth: 10 } } },
      scales: {
        x: { ticks: { maxTicksLimit: 8, color: "#9b9b96", font: { size: 9 } }, grid: { display: false } },
        y: { ticks: { color: "#9b9b96", font: { size: 9 } }, grid: { color: "rgba(255,255,255,0.05)" } },
      },
    }),
  });
}

function renderFetchSessions(sessions, bookData) {
  const el = document.getElementById("snapshot-sessions-list");
  if (!el) return;
  const risk = bookData?.risk;
  let riskHtml = "";
  if (risk?.mtmSortino != null || risk?.mtmSharpe != null) {
    riskHtml = `<div style="margin-bottom:8px;font-size:11px;color:var(--tx2)">MTM Sortino <strong>${risk.mtmSortino ?? "—"}</strong> · Sharpe <strong>${risk.mtmSharpe ?? "—"}</strong> <span style="color:var(--tx3)">(${risk.fetchCount ?? 0} book snapshots)</span></div>`;
  }
  if (!sessions.length) {
    el.innerHTML = riskHtml + '<span style="color:var(--tx3);font-size:11px">No fetch sessions recorded.</span>';
    return;
  }
  let html = riskHtml + '<table class="hist-tbl"><tr><th>When</th><th>Positions</th><th>Tickers</th><th>Notes</th></tr>';
  for (const s of sessions) {
    const when = s.timestamp ? new Date(s.timestamp).toLocaleString() : "—";
    const hist = s.meta?.hasHistory ? "history" : "pos only";
    html += `<tr><td>${when}</td><td>${s.positionCount ?? "—"}</td><td>${s.tickerCount ?? "—"}</td><td style="color:var(--tx3)">${hist}</td></tr>`;
  }
  html += "</table>";
  el.innerHTML = html;
}

async function loadTickerSnapshotHistory(ticker) {
  const wrap = document.getElementById("snapshot-ticker-chart-wrap");
  if (!wrap || !ticker) return;
  wrap.innerHTML = '<span style="color:var(--tx3);font-size:11px">Loading…</span>';
  const { data } = await fetchJson(`/api/snapshots/history?ticker=${encodeURIComponent(ticker)}&limit=60`);
  const rows = (data.snapshots || []).reverse();
  if (!rows.length) {
    wrap.innerHTML = `<span style="color:var(--tx3);font-size:11px">No snapshots for ${ticker}.</span>`;
    destroyChart("chart-snapshot-ticker");
    return;
  }
  const labels = rows.map(r => {
    try { return new Date(r.timestamp).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
    catch { return r.timestamp; }
  });
  wrap.innerHTML = '<canvas id="chart-snapshot-ticker" height="120"></canvas>';
  destroyChart("chart-snapshot-ticker");
  chartInstances["chart-snapshot-ticker"] = new Chart(document.getElementById("chart-snapshot-ticker"), {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Price", data: rows.map(r => r.price), borderColor: "#a5d6a7", borderWidth: 1.5, pointRadius: 0, yAxisID: "y" },
        { label: "IV %", data: rows.map(r => r.iv), borderColor: "#ce93d8", borderWidth: 1, pointRadius: 0, yAxisID: "y1" },
      ],
    },
    options: deepMergeChartOpts(chartInteractionDefaults(), {
      responsive: true,
      animation: false,
      plugins: { legend: { display: true, labels: { color: "#e8e8e4", font: { size: 9 }, boxWidth: 10 } } },
      scales: {
        x: { ticks: { maxTicksLimit: 6, color: "#9b9b96", font: { size: 8 } }, grid: { display: false } },
        y: { type: "linear", position: "left", ticks: { color: "#9b9b96", font: { size: 9 } }, grid: { color: "rgba(255,255,255,0.05)" } },
        y1: { type: "linear", position: "right", ticks: { color: "#9b9b96", font: { size: 9 } }, grid: { drawOnChartArea: false } },
      },
    }),
  });
}

document.getElementById("snapshot-ticker-select")?.addEventListener("change", (e) => {
  loadTickerSnapshotHistory((e.target as HTMLSelectElement).value);
});

document.getElementById("btn-refresh-snapshots")?.addEventListener("click", () => loadSnapshotHistoryUI());
document.getElementById("btn-snapshot-diff")?.addEventListener("click", () => runSnapshotDiff());
