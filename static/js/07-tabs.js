// ═══════════════════════════════════════════════════════════════════════════
// Tab switching — extended for Risk + History
// ═══════════════════════════════════════════════════════════════════════════

function switchToTab(tabKey, opts = {}) {
  const prevTab = document.querySelector(".tab.active")?.dataset.tab;
  if (prevTab === "simulate" && tabKey !== "simulate") {
    state.simScrollY = window.scrollY;
    saveSession();
  }
  document.querySelectorAll(".tab").forEach(t => {
    const isActive = t.dataset.tab === tabKey;
    t.classList.toggle("active", isActive);
    t.setAttribute("aria-selected", isActive ? "true" : "false");
    if (!isActive) t.blur();
  });
  const activeTab = document.querySelector(`.tab[data-tab="${tabKey}"]`);
  activeTab?.focus({ preventScroll: true });
  Object.entries(TAB_MAP).forEach(([key, elId]) => {
    const el = document.getElementById(elId);
    if (el) el.hidden = key !== tabKey;
  });
  if (tabKey === "risk" && state.marketData && !state.riskMatrixLoaded) loadRiskMatrix();
  if (tabKey === "journal") {
    requestAnimationFrame(() => {
      refreshCumulativePnlChart();
      loadSnapshotHistoryUI();
    });
  }
  if (tabKey === "orders") {
    requestAnimationFrame(() => {
      if (typeof loadOrders === "function") loadOrders();
    });
  }
  if (tabKey === "risk") {
    requestAnimationFrame(() => {
      if (typeof loadStrategyTemplates === "function") loadStrategyTemplates();
    });
  }
  if (tabKey === "simulate") {
    requestAnimationFrame(() => {
      setupSimNavScrollSpy();
      if (opts.scrollTop) scrollSimTabToTop();
      else if (state.simScrollY > 0) window.scrollTo({ top: state.simScrollY, behavior: "instant" });
    });
  }
}

function scrollSimTabToTop() {
  state.simScrollY = 0;
  const target = document.getElementById("sim-results-top") || document.getElementById("sim-results");
  const tab = document.getElementById("tab-simulate");
  const el = (target && !target.hidden) ? target : tab;
  if (!el || el.hidden) return;
  const scroll = () => {
    const topBar = document.querySelector(".top-bar");
    const offset = (topBar?.offsetHeight || 56) + 8;
    const y = el.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top: Math.max(0, y), behavior: "instant" });
  };
  requestAnimationFrame(() => requestAnimationFrame(scroll));
}

function refreshCumulativePnlChart() {
  const trades = getJournalTradesForChart();
  if (!state.tradeHistory?.trades?.length) return;
  const container = document.getElementById("history-chart-container");
  if (container) container.hidden = false;
  drawCumulativePnlChart(trades);
}

function drawCumulativePnlChart(trades) {
  const canvas = document.getElementById("chart-cumulative-pnl");
  if (!canvas) return;
  const series = buildJournalDailyPnlSeries(trades);
  state.journalDailyPnl = series;
  const sel = state.journalDateFilter;
  destroyChart("chart-cumulative-pnl");
  canvas.onclick = null;
  const hint = document.getElementById("history-chart-hint");
  const filt = [];
  if (state.journalFilter.trim()) filt.push("ticker");
  if (state.journalStrategyFilter) filt.push("strategy");
  const filtNote = filt.length ? ` · filtered by ${filt.join(" + ")}` : "";
  if (hint) {
    hint.textContent = series.length
      ? `Click a point to filter the table to that close date${filtNote}.`
      : (filt.length ? "No closed trades match the current filters." : "");
  }
  if (!series.length) {
    canvas.style.cursor = "default";
    return;
  }
  chartInstances["chart-cumulative-pnl"] = new Chart(canvas, {
    type: "line",
    data: {
      labels: series.map(d => d.date),
      datasets: [{
        data: series.map(d => d.cumPnl),
        borderColor: "#20c7c7",
        borderWidth: 2,
        backgroundColor: "rgba(32,199,199,0.1)",
        fill: true,
        pointRadius: series.map(d => (d.date === sel ? 6 : (series.length > 80 ? 0 : 3))),
        pointHitRadius: 24,
        pointHoverRadius: 6,
        pointBackgroundColor: series.map(d => (d.date === sel ? "#20c7c7" : "rgba(32,199,199,0.35)")),
        pointBorderColor: series.map(d => (d.date === sel ? "#fff" : "#20c7c7")),
        tension: 0.2,
      }],
    },
    options: deepMergeChartOpts(chartInteractionDefaults(), {
      responsive: true,
      maintainAspectRatio: true,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(ctx) {
              const row = series[ctx.dataIndex];
              const lines = [
                `Cumulative: ${fmtDollar(row.cumPnl)}`,
                `Day: ${fmtDollar(row.dayPnl)} · ${row.tradeCount} trade${row.tradeCount === 1 ? "" : "s"}`,
              ];
              if (row.rollCount) {
                lines.push(`Rolls: ${row.rollCount} · leg ${fmtDollar(row.rollPnl)}`);
                if (row.rollNetPnl != null && row.rollNetPnl !== row.rollPnl) {
                  lines.push(`Roll net (incl. new open): ${fmtDollar(row.rollNetPnl)}`);
                }
              }
              const assignRows = (row.trades || []).filter(t => t.assignmentRollup);
              if (assignRows.length) {
                lines.push(`Assignments: ${assignRows.length} combined`);
              }
              return lines;
            },
            afterBody(ctx) {
              const row = series[ctx[0]?.dataIndex];
              if (!row?.trades?.length) return [];
              return row.trades.slice(0, 6).map(t => {
                let label = `${t.ticker} ${fmtDollar(journalTradePnl(t))}`;
                if (t.isRoll && t.rollLabel) label += ` ↻ ${t.rollLabel}`;
                if (t.assignmentRollup) label += " ⇄";
                return label;
              }).concat(row.trades.length > 6 ? [`+ ${row.trades.length - 6} more…`] : []);
            },
          },
        },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 10, color: "#9b9b96", font: { size: 9 } }, grid: { display: false } },
        y: { ticks: { callback: v => fmtDollar(v), color: "#9b9b96", font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.05)" } },
      },
    }),
  });
  canvas.style.cursor = series.length ? "pointer" : "default";
  canvas.onclick = (evt) => {
    const chart = chartInstances["chart-cumulative-pnl"];
    if (!chart || !series.length) return;
    const hits = chart.getElementsAtEventForMode(evt, "index", { intersect: false, axis: "x" });
    if (!hits.length) return;
    const row = series[hits[0].index];
    state.journalDateFilter = state.journalDateFilter === row.date ? "" : row.date;
    if (state.tradeHistory) renderTradeHistory(state.tradeHistory);
  };
}

function setupSimNavScrollSpy() {
  if (simNavObserver) { simNavObserver.disconnect(); simNavObserver = null; }
  const nav = document.getElementById("sim-ticker-nav");
  if (!nav) return;
  const wraps = [...document.querySelectorAll(".path-chart-wrap")];
  if (!wraps.length) return;
  simNavObserver = new IntersectionObserver((entries) => {
    const visible = entries.filter(e => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio);
    if (!visible.length) return;
    const tkr = visible[0].target.id.replace("path-wrap-", "");
    nav.querySelectorAll("[data-sim-nav]").forEach(b => {
      const on = b.dataset.simNav === tkr;
      b.classList.toggle("active", on);
      if (on) b.scrollIntoView({ block: "nearest" });
    });
  }, { root: null, rootMargin: "-15% 0px -55% 0px", threshold: [0.1, 0.35, 0.6] });
  wraps.forEach(w => simNavObserver.observe(w));
}

document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => switchToTab(tab.dataset.tab));
});
document.getElementById("btn-view")?.addEventListener("click", () => { closeImportDrawer(); switchToTab("positions"); });
document.getElementById("btn-goto-fetch")?.addEventListener("click", openImportDrawer);

document.getElementById("btn-whatif-add")?.addEventListener("click", () => {
  const ticker = document.getElementById("wi-ticker").value.trim().toUpperCase();
  const expiry = document.getElementById("wi-expiry").value;
  const strike = parseFloat(document.getElementById("wi-strike").value);
  const optType = document.getElementById("wi-type").value;
  const contracts = parseInt(document.getElementById("wi-contracts").value, 10);
  const avgCost = parseFloat(document.getElementById("wi-cost").value) || 0;
  if (!ticker || !expiry || !strike || !contracts) return;
  const leg = { ticker, expiry, strike, optType, contracts, avgCost, posType: "option" };
  if (state.whatifEditIndex != null) {
    state.hypothetical[state.whatifEditIndex] = leg;
    cancelWhatIfEdit();
  } else {
    state.hypothetical.push(leg);
    cancelWhatIfEdit();
  }
  renderWhatIfList();
  applyWhatIfGreeks();
  state.riskMatrixLoaded = false;
  if (document.getElementById("tab-risk") && !document.getElementById("tab-risk").hidden) loadRiskMatrix();
  saveSession();
});
document.getElementById("btn-whatif-cancel-edit")?.addEventListener("click", cancelWhatIfEdit);
document.getElementById("btn-whatif-clear")?.addEventListener("click", () => {
  cancelWhatIfEdit();
  state.hypothetical = [];
  renderWhatIfList();
  document.getElementById("whatif-greeks-summary").hidden = true;
  state.riskMatrixLoaded = false;
  if (document.getElementById("tab-risk") && !document.getElementById("tab-risk").hidden) loadRiskMatrix();
  saveSession();
});
document.getElementById("wi-ticker")?.addEventListener("change", () => {
  const t = document.getElementById("wi-ticker").value.trim().toUpperCase();
  if (t) loadWhatIfExpiries(t);
});
document.getElementById("wi-ticker")?.addEventListener("blur", () => {
  const t = document.getElementById("wi-ticker").value.trim().toUpperCase();
  if (t) loadWhatIfExpiries(t);
});
document.getElementById("wi-expiry")?.addEventListener("change", () => {
  const t = document.getElementById("wi-ticker").value.trim().toUpperCase();
  const exp = document.getElementById("wi-expiry").value;
  const typ = document.getElementById("wi-type").value;
  if (t && exp) loadWhatIfStrikes(t, exp, typ);
});
document.getElementById("wi-strike")?.addEventListener("change", () => applyWhatIfStrikeMid());
document.getElementById("wi-type")?.addEventListener("change", () => {
  const t = document.getElementById("wi-ticker").value.trim().toUpperCase();
  const exp = document.getElementById("wi-expiry").value;
  const typ = document.getElementById("wi-type").value;
  if (t && exp) loadWhatIfStrikes(t, exp, typ);
});

