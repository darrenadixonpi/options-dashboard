import { esc, normalizeStrategyLabel } from "./02-portfolio";
import { chartInteractionDefaults, deepMergeChartOpts } from "./03-chart-utils";
import { chartInstances, destroyChart, findOpenLegKey, getFilteredJournalTrades, getJournalStatsForView, getJournalTradesForChart, getJournalTradesForStrategyFilter, journalTradePnl, jumpToLeg, loadBookRiskMetrics, state } from "./04-state";
import { drawCumulativePnlChart } from "./07-tabs";
import { fmtDollar } from "./08-simulate";

// ═══════════════════════════════════════════════════════════════════════════
// Trade History (#12)
// ═══════════════════════════════════════════════════════════════════════════

/** Canonical strategy names — filter shows only labels present in closed trades (count > 0). */
export const JOURNAL_STRATEGY_CATALOG = {
  "Single-leg": ["Long Call", "Long Put", "Short Call", "Short Put", "Call Roll", "Put Roll"],
  "Spreads": ["Bull Call Spread", "Bear Call Spread", "Bull Put Spread", "Bear Put Spread"],
  "Volatility": ["Short Straddle", "Long Straddle", "Short Strangle", "Long Strangle", "Iron Condor", "Iron Butterfly"],
  "Multi-leg": ["Jade Lizard", "Twisted Sister", "Call Butterfly", "Put Butterfly", "Short Call Butterfly", "Short Put Butterfly", "Call Ladder", "Put Ladder", "Collar", "Risk Reversal", "Collar w/ Shares"],
  "Equity + options": [
    "Covered Call", "Covered Put", "Covered Straddle", "Covered Strangle",
    "Protective Put", "Long Shares + Short Put", "Overwritten Call", "Overwritten Put",
  ],
  "Shares": ["Long Shares", "Short Shares"],
};

export function buildJournalStrategyFilterOptions(trades, selected) {
  const counts = {};
  for (const t of trades) {
    const s = normalizeStrategyLabel(t.strategy || "Unknown");
    counts[s] = (counts[s] || 0) + 1;
  }
  let html = '<option value="">All strategies</option>';
  const used = new Set();
  for (const [group, labels] of Object.entries(JOURNAL_STRATEGY_CATALOG)) {
    const present = labels.filter(s => counts[s] > 0);
    if (!present.length) continue;
    html += `<optgroup label="${esc(group)}">`;
    for (const s of present) {
      html += `<option value="${esc(s)}"${s === selected ? " selected" : ""}>${esc(s)} (${counts[s]})</option>`;
      used.add(s);
    }
    html += "</optgroup>";
  }
  const other = Object.keys(counts).filter(s => !used.has(s)).sort();
  if (other.length) {
    html += '<optgroup label="Other">';
    for (const s of other) {
      html += `<option value="${esc(s)}"${s === selected ? " selected" : ""}>${esc(s)} (${counts[s]})</option>`;
    }
    html += "</optgroup>";
  }
  return html;
}

export function renderJournalSummary(stats) {
  if (!stats) return;
  const filteredTag = stats.filtered ? ' <span style="font-size:10px;color:var(--tx3)">filtered</span>' : "";
  const winTitle = "Win rate by strategy close (spreads/multi-leg = 1 trade). Leg rate: " + (stats.legWinRate ?? "—") + "%";
  const risk = stats.risk;
  const riskTitle = risk
    ? "Calendar-day realized P&L (zeros on non-close days), annualized ×√252. Not MTM book Sharpe."
    : "";
  const book = state.bookRisk;
  const bookTitle = book
    ? `MTM Sharpe on fetch-to-fetch Δ unrealized P&L (${book.fetchCount ?? 0} fetches, ~${book.avgFetchGapDays ?? "?"}d avg gap).`
    : "";
  let riskHtml = "";
  if (risk?.sortino != null || risk?.sharpe != null) {
    riskHtml += `
    <div class="stat"><div class="stat-label" title="${esc(riskTitle)}">Sortino</div><div class="stat-val" style="font-size:18px">${risk.sortino ?? "—"}</div><div class="stat-sub">Realized · Sharpe ${risk.sharpe ?? "—"}</div></div>`;
  }
  if (book?.mtmSortino != null || book?.mtmSharpe != null) {
    riskHtml += `
    <div class="stat"><div class="stat-label" title="${esc(bookTitle)}">MTM Sortino</div><div class="stat-val" style="font-size:18px">${book.mtmSortino ?? "—"}</div><div class="stat-sub">Desk · Sharpe ${book.mtmSharpe ?? "—"}</div></div>`;
  }
  document.getElementById("history-summary").innerHTML = `
    <div class="stat"><div class="stat-label">Strategy Closes${filteredTag}</div><div class="stat-val">${stats.groupTrades ?? stats.totalTrades}</div><div class="stat-sub">${stats.groupLegs ?? stats.totalTrades} legs</div></div>
    <div class="stat"><div class="stat-label" title="${esc(winTitle)}">Win Rate</div><div class="stat-val" style="color:${stats.winRate >= 50 ? "var(--ok-tx)" : "var(--err-tx)"}">${stats.winRate}%</div><div class="stat-sub">${stats.groupWins ?? stats.wins}W · ${stats.groupLosses ?? stats.losses}L</div></div>
    <div class="stat"><div class="stat-label">Total P&L</div><div class="stat-val" style="color:${stats.totalPnl >= 0 ? "var(--ok-tx)" : "var(--err-tx)"}">${fmtDollar(stats.totalPnl)}</div></div>
    <div class="stat"><div class="stat-label">Profit Factor</div><div class="stat-val">${stats.profitFactor >= 999 ? "∞" : stats.profitFactor}</div></div>
    <div class="stat"><div class="stat-label" title="Avg P&L per strategy close">Expectancy</div><div class="stat-val">${fmtDollar(stats.expectancy)}</div></div>
    ${riskHtml}
    <div class="stat"><div class="stat-label">Avg Hold</div><div class="stat-val">${stats.avgHoldDays}d</div></div>`;
}

export function renderTradeHistory(data) {
  if (!data.trades?.length && !data.stats) {
    document.getElementById("history-empty").hidden = false;
    document.getElementById("history-content").hidden = true;
    document.getElementById("history-empty").innerHTML = `<h2>No closed trades found</h2><p>The history parser looks for OPENING/CLOSING transaction pairs. Make sure your history CSV covers the full date range of your trades.</p>`;
    return;
  }
  if (!data.trades?.length) return;
  document.getElementById("history-empty").hidden = true;
  document.getElementById("history-content").hidden = false;

  if (state.journalDateFilter) {
    const ft = state.journalFilter.trim().toUpperCase();
    const onDay = data.trades.filter(t => {
      if (t.closeDate !== state.journalDateFilter) return false;
      return !ft || t.ticker.includes(ft);
    });
    if (!onDay.length) state.journalDateFilter = "";
  }

  const stratSel = document.getElementById("hist-filter-strategy") as HTMLSelectElement | null;
  if (stratSel) {
    const cur = state.journalStrategyFilter;
    const stratPool = getJournalTradesForStrategyFilter();
    stratSel.innerHTML = buildJournalStrategyFilterOptions(stratPool, cur);
    if (cur && !Array.from(stratSel.options).some(o => o.value === cur)) state.journalStrategyFilter = "";
  }
  const assignToggle = document.getElementById("hist-show-assignment-legs") as HTMLInputElement | null;
  if (assignToggle) assignToggle.checked = !!state.journalShowAssignmentLegs;

  // Stats summary (recalculates when ticker/strategy/day filters active)
  loadBookRiskMetrics().then(() => {
    const viewStats = getJournalStatsForView();
    if (viewStats) renderJournalSummary(viewStats);
  });
  const viewStats = getJournalStatsForView();
  if (viewStats) {
    renderJournalSummary(viewStats);
    const s = state.tradeHistory?.stats || viewStats;
    const note = document.getElementById("history-mix-note");
    if (note) {
      note.hidden = false;
      const rollTxt = s.rollTrades ? ` · ${s.rollTrades} rolls tagged` : "";
      const assignTxt = s.assignmentRollups ? ` · ${s.assignmentRollups} assignment rollups` : "";
      const flagTxt = s.flaggedTrades ? ` · ${s.flaggedTrades} flagged` : "";
      const openTxt = s.openLotsRemaining ? ` · ${s.openLotsRemaining} open lots not in closed set (still held or outside CSV window)` : "";
      note.textContent = `${viewStats.optionTrades ?? s.optionTrades ?? 0} option closes · ${viewStats.equityTrades ?? s.equityTrades ?? 0} share round-trips · win rate groups spreads · click chart to drill down${rollTxt}${assignTxt}${flagTxt}${openTxt}`;
    }
    const warnEl = document.getElementById("history-data-warnings");
    if (warnEl && s.dataWarnings) {
      if (s.dataWarnings?.length) {
        warnEl.hidden = false;
        warnEl.innerHTML = `<strong>History parse warnings</strong> — closes with no matching open in your CSV (extend date range or check export)<br>${s.dataWarnings.map(w => esc(w)).join("<br>")}`;
      } else warnEl.hidden = true;
    }
  }

  const dateChip = document.getElementById("hist-date-filter-chip");
  const dateLabel = document.getElementById("hist-date-filter-label");
  if (dateChip && dateLabel) {
    if (state.journalDateFilter) {
      dateChip.hidden = false;
      const dayTrades = getFilteredJournalTrades();
      const dayPnl = dayTrades.reduce((s, t) => s + journalTradePnl(t), 0);
      dateLabel.textContent = `Close date: ${state.journalDateFilter} (${fmtDollar(dayPnl)})`;
    } else dateChip.hidden = true;
  }

  const drillEl = document.getElementById("history-drill-summary");
  if (drillEl) {
    if (state.journalDateFilter) {
      const dayTrades = getFilteredJournalTrades();
      if (dayTrades.length) {
        drillEl.hidden = false;
        const dayPnl = dayTrades.reduce((s, t) => s + journalTradePnl(t), 0);
        const rollRows = dayTrades.filter(t => t.isRoll);
        const rollNote = rollRows.length
          ? ` · ${rollRows.length} roll${rollRows.length === 1 ? "" : "s"} leg ${fmtDollar(rollRows.reduce((s, t) => s + journalTradePnl(t), 0))}`
          : "";
        let html = `<div style="font-weight:500;margin-bottom:6px">${state.journalDateFilter} · ${dayTrades.length} trade${dayTrades.length === 1 ? "" : "s"} · day P&L ${fmtDollar(dayPnl)}${rollNote}</div>`;
        for (const t of dayTrades.slice(0, 12)) {
          const col = journalTradePnl(t) >= 0 ? "var(--ok-tx)" : "var(--err-tx)";
          const rollTag = t.isRoll && t.rollLabel ? ` ↻ ${t.rollLabel}` : (t.isRoll ? " ↻" : "");
          const assignTag = t.assignmentRollup ? " ⇄" : "";
          const pnlLabel = t.assignmentRollup && t.optionLegPnl != null
            ? `${fmtDollar(journalTradePnl(t))} <span style="color:var(--tx3);font-size:10px">(opt ${fmtDollar(t.optionLegPnl)} + stk ${fmtDollar(t.equityLegPnl ?? 0)})</span>`
            : (t.isRoll && t.rollNetPnl != null
              ? `${fmtDollar(journalTradePnl(t))} <span style="color:var(--tx3);font-size:10px">(roll net ${fmtDollar(t.rollNetPnl)})</span>`
              : fmtDollar(journalTradePnl(t)));
          html += `<div style="display:flex;justify-content:space-between;gap:12px;padding:2px 0;color:var(--tx2)"><span>${t.ticker} · ${esc(normalizeStrategyLabel(t.strategy as string))}${rollTag}${assignTag}</span><span style="color:${col}">${pnlLabel}</span></div>`;
        }
        if (dayTrades.length > 12) html += `<div style="color:var(--tx3);margin-top:4px">+ ${dayTrades.length - 12} more in table below</div>`;
        drillEl.innerHTML = html;
      } else drillEl.hidden = true;
    } else drillEl.hidden = true;
  }

  const trades = getFilteredJournalTrades();
  const sortCols = [
    { key: "ticker", label: "Ticker" },
    { key: "optType", label: "Type" },
    { key: "strategy", label: "Strategy" },
    { key: "closeTypeLabel", label: "Close" },
    { key: "openDate", label: "Open" },
    { key: "closeDate", label: "Close" },
    { key: "holdDays", label: "Days" },
    { key: "qty", label: "Qty" },
    { key: "pnl", label: "P&L" },
  ];
  let html = '<table class="hist-tbl"><thead><tr>';
  for (const col of sortCols) {
    const active = state.journalSort.col === col.key;
    const arrow = active ? (state.journalSort.dir === "asc" ? " ↑" : " ↓") : "";
    html += `<th class="sortable${active ? " sort-active" : ""}" data-sort-col="${col.key}">${col.label}${arrow}</th>`;
  }
  html += '<th></th></tr></thead><tbody>';

  const groups = _buildJournalGroups(trades);
  // Track which group IDs are expanded (persisted across re-renders in state)
  if (!state._journalGroupExpanded) state._journalGroupExpanded = {};

  for (const g of groups) {
    if (g.isSolo) {
      // Solo trade — render exactly as before
      html += _renderLegRow(g.trades[0]);
    } else {
      // Multi-leg strategy group — render collapsible header + leg rows
      const gid = g.id;
      const expanded = !!state._journalGroupExpanded[gid];
      const pnlColor = g.totalPnl >= 0 ? "var(--ok-tx)" : "var(--err-tx)";
      const legCount = g.trades.length;
      const dateRange = g.crossDay
        ? `${g.closeDates[0]} – ${g.closeDates[g.closeDates.length - 1]}`
        : g.closeDate;
      const crossDayBadge = g.crossDay
        ? `<span style="font-size:9px;padding:1px 5px;border-radius:8px;background:rgba(32,199,199,0.15);color:var(--accent);margin-left:5px" title="Legs closed on different dates">multi-day</span>`
        : "";
      const outlierBadge = g.outlier
        ? `<span class="hist-tip-wrap"><span style="font-size:9px;padding:1px 5px;border-radius:8px;background:rgba(255,193,7,0.18);color:var(--warn-tx);cursor:help" tabindex="0">outlier</span><span class="hist-tip">P&L is &gt;2σ from mean for this strategy type</span></span>`
        : "";
      const expandIcon = expanded ? "▾" : "▸";
      html += `<tr class="hist-group-hdr${expanded ? " expanded" : ""}" data-group-toggle="${gid}" style="cursor:pointer;background:var(--bg2)" title="Click to ${expanded ? "collapse" : "expand"} ${legCount} legs">
        <td colspan="8" style="padding:6px 8px">
          <span style="font-size:11px;color:var(--tx3);margin-right:6px">${expandIcon}</span>
          <span style="font-weight:500">${esc(g.ticker)}</span>
          <span style="color:var(--tx3);font-size:11px;margin:0 6px">·</span>
          <span style="font-size:11px;color:var(--tx2)">${esc(normalizeStrategyLabel(g.strategy))}</span>
          ${crossDayBadge}${outlierBadge}
          <span style="color:var(--tx3);font-size:11px;margin-left:8px">${dateRange} · ${legCount} legs</span>
        </td>
        <td style="color:${pnlColor};font-weight:600;white-space:nowrap">${fmtDollar(g.totalPnl)}</td>
        <td></td>
      </tr>`;
      for (const t of g.trades) {
        html += _renderLegRow(t, { indent: true, suppressedStyle: expanded ? "" : "display:none" });
      }
    }
  }
  html += '</tbody></table>';
  document.getElementById("history-table-container").innerHTML =
    `<div class="journal-table-scroll">${html}</div>`;

  // Group expand/collapse
  document.querySelectorAll("#history-table-container [data-group-toggle]").forEach(row => {
    row.addEventListener("click", () => {
      const gid = (row as HTMLElement).dataset.groupToggle;
      state._journalGroupExpanded[gid] = !state._journalGroupExpanded[gid];
      // Toggle sibling leg rows (immediately follow this header row)
      let next = row.nextElementSibling;
      const expanded = state._journalGroupExpanded[gid];
      while (next && next.classList.contains("hist-row-leg")) {
        (next as HTMLElement).style.display = expanded ? "" : "none";
        next = next.nextElementSibling;
      }
      const icon = row.querySelector("span");
      if (icon) icon.textContent = expanded ? "▾" : "▸";
      row.classList.toggle("expanded", expanded);
    });
  });

  document.querySelectorAll("#history-table-container [data-sort-col]").forEach(th => {
    th.addEventListener("click", () => {
      const col = (th as HTMLElement).dataset.sortCol;
      if (state.journalSort.col === col) state.journalSort.dir = state.journalSort.dir === "asc" ? "desc" : "asc";
      else { state.journalSort.col = col; state.journalSort.dir = col === "pnl" ? "desc" : "asc"; }
      renderTradeHistory(data);
    });
  });
  document.querySelectorAll("#history-table-container .hist-row-click").forEach(row => {
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".hist-tip-wrap, .hist-flag")) return;
      if ((row as HTMLElement).dataset.histAssign === "1") {
        state.journalDateFilter = (row as HTMLElement).dataset.histClose || "";
        state.journalFilter = (row as HTMLElement).dataset.histTicker || "";
        if (state.tradeHistory) renderTradeHistory(state.tradeHistory);
        const drill = document.getElementById("history-drill-summary");
        drill?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        return;
      }
      const leg = (row as HTMLElement).dataset.histLeg;
      if (leg) jumpToLeg(leg);
      else jumpToLeg(null, (row as HTMLElement).dataset.histTicker);
    });
  });

  // Drawdown + cohorts always reflect the full loaded history (server stats),
  // independent of the ticker/strategy filter applied to the table above.
  renderDrawdownPanel((data.stats as any)?.drawdown);
  renderCohorts((data.stats as any)?.cohorts);

  if (data.trades.length >= 1) {
    document.getElementById("history-chart-container").hidden = false;
    const histTab = document.getElementById("tab-history");
    if (histTab && !histTab.hidden) drawCumulativePnlChart(getJournalTradesForChart());
  }
}

// ─── Drawdown panel (realized equity curve) ──────────────────────────────────

export function renderDrawdownPanel(dd: any) {
  const section = document.getElementById("drawdown-section");
  const statsEl = document.getElementById("drawdown-stats");
  if (!section || !statsEl) return;
  if (!dd) {
    section.hidden = true;
    destroyChart("chart-drawdown");
    return;
  }
  section.hidden = false;
  const pct = dd.maxDrawdownPct != null ? `${dd.maxDrawdownPct}% vs peak` : "vs peak n/a";
  const recov = dd.stillUnderwater
    ? `<span style="color:var(--warn-tx)">underwater</span>`
    : (dd.daysToRecover != null ? `${dd.daysToRecover}d` : "—");
  const rf = dd.recoveryFactor != null ? dd.recoveryFactor : "—";
  const curSub = dd.currentDrawdownPct != null ? `${dd.currentDrawdownPct}%` : "";
  statsEl.innerHTML = `
    <div class="stat"><div class="stat-label" title="Largest peak-to-trough drop in cumulative realized P&L">Max Drawdown</div><div class="stat-val" style="color:var(--err-tx)">${fmtDollar(dd.maxDrawdown)}</div><div class="stat-sub">${esc(pct)}</div></div>
    <div class="stat"><div class="stat-label" title="Net realized P&L ÷ max drawdown (unitless)">Recovery Factor</div><div class="stat-val">${rf}</div></div>
    <div class="stat"><div class="stat-label" title="Drawdown from the current running peak">Current DD</div><div class="stat-val" style="color:${dd.currentDrawdown < 0 ? "var(--err-tx)" : "var(--ok-tx)"}">${fmtDollar(dd.currentDrawdown)}</div><div class="stat-sub">${esc(curSub)}</div></div>
    <div class="stat"><div class="stat-label" title="Longest stretch below a prior peak (calendar days)">Longest Underwater</div><div class="stat-val">${dd.longestUnderwaterDays}d</div></div>
    <div class="stat"><div class="stat-label" title="Calendar days from the pre-drawdown peak to full recovery">Time to Recover</div><div class="stat-val" style="font-size:16px">${recov}</div></div>`;

  const canvas = document.getElementById("chart-drawdown");
  destroyChart("chart-drawdown");
  const uw = dd.underwater || [];
  if (!canvas || !uw.length) return;
  chartInstances["chart-drawdown"] = new Chart(canvas, {
    type: "line",
    data: {
      labels: uw.map((u: any) => u.date),
      datasets: [{
        label: "Drawdown",
        data: uw.map((u: any) => u.drawdown),
        borderColor: "#ef5350",
        backgroundColor: "rgba(239,83,80,0.15)",
        fill: true,
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.1,
      }],
    },
    options: deepMergeChartOpts(chartInteractionDefaults(), {
      responsive: true,
      maintainAspectRatio: true,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx: any) => `Drawdown: ${fmtDollar(uw[ctx.dataIndex].drawdown)}` } },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 10, color: "#9b9b96", font: { size: 9 } }, grid: { display: false } },
        y: { ticks: { callback: (v: any) => fmtDollar(v), color: "#9b9b96", font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.05)" } },
      },
    }),
  });
}

// ─── Performance cohorts ─────────────────────────────────────────────────────

let cohortDim = "byUnderlying";
const COHORT_DIM_LABELS: Record<string, string> = {
  byUnderlying: "Underlying",
  byStrategy: "Strategy",
  byHoldBucket: "Hold period",
  byDteAtEntry: "DTE at entry",
  byMonth: "Month",
  byWeekday: "Weekday",
};

export function renderCohorts(cohorts: any) {
  const section = document.getElementById("cohorts-section");
  const container = document.getElementById("cohorts-table-container");
  if (!section || !container) return;
  if (!cohorts) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  if (!cohorts[cohortDim]?.length) {
    const firstWith = Object.keys(COHORT_DIM_LABELS).find(d => cohorts[d]?.length);
    if (firstWith) cohortDim = firstWith;
  }
  document.querySelectorAll("#cohort-dim-toggle .cohort-dim-btn").forEach(b => {
    const dim = (b as HTMLElement).dataset.cohortDim || "";
    const has = !!cohorts[dim]?.length;
    const isActive = dim === cohortDim && has;
    b.classList.toggle("btn-ghost", !isActive);
    (b as HTMLButtonElement).disabled = !has;
    (b as HTMLElement).style.opacity = has ? "" : "0.4";
  });
  container.innerHTML = _cohortTable(cohorts[cohortDim] || [], cohortDim);
}

function _cohortTable(rows: any[], dim: string): string {
  if (!rows.length) return '<span style="color:var(--tx3);font-size:11px">No data for this dimension.</span>';
  const keyHdr = COHORT_DIM_LABELS[dim] || "Group";
  let html = '<table class="hist-tbl"><thead><tr>'
    + `<th>${esc(keyHdr)}</th><th>Trades</th><th>Win%</th><th>Total P&L</th><th>Avg</th><th>PF</th><th>Avg Hold</th></tr></thead><tbody>`;
  for (const r of rows) {
    const pnlCol = r.totalPnl >= 0 ? "var(--ok-tx)" : "var(--err-tx)";
    const winCol = r.winRate >= 50 ? "var(--ok-tx)" : "var(--err-tx)";
    const pf = r.profitFactor >= 999 ? "∞" : r.profitFactor;
    const hold = r.avgHoldDays != null ? `${r.avgHoldDays}d` : "—";
    html += `<tr><td>${esc(String(r.key))}</td><td>${r.trades}</td><td style="color:${winCol}">${r.winRate}%</td><td style="color:${pnlCol};font-weight:500">${fmtDollar(r.totalPnl)}</td><td>${fmtDollar(r.avgPnl)}</td><td>${pf}</td><td>${hold}</td></tr>`;
  }
  html += "</tbody></table>";
  return html;
}

document.getElementById("cohort-dim-toggle")?.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest("[data-cohort-dim]") as HTMLElement | null;
  if (!btn || (btn as HTMLButtonElement).disabled) return;
  cohortDim = btn.dataset.cohortDim || "byUnderlying";
  renderCohorts((state.tradeHistory as any)?.stats?.cohorts);
});

// ─── Journal v2: group helpers ───────────────────────────────────────────────

/**
 * Build strategy groups from a flat sorted trade list.
 * Returns [{isSolo, id, trades, ticker, strategy, totalPnl, openDate, closeDate,
 *           closeDates, crossDay, outlier, sortVal}]
 */
export function _buildJournalGroups(trades) {
  const byId = new Map();
  for (const t of trades) {
    const gid = t.strategyGroupId || `solo|${t.ticker}|${t.closeDate}|${t.symbol || ""}`;
    if (!byId.has(gid)) byId.set(gid, []);
    byId.get(gid).push(t);
  }

  const groups = [];
  for (const [id, legs] of byId) {
    const isSolo = id.startsWith("solo|") || legs.length === 1;
    const totalPnl = legs.reduce((s, t) => s + journalTradePnl(t), 0);
    const closeDates = [...new Set(legs.map(t => t.closeDate).filter(Boolean))].sort();
    const openDates = legs.map(t => t.openDate).filter(Boolean).sort();
    const crossDay = closeDates.length > 1;
    const col = state.journalSort.col;
    const dir = state.journalSort.dir === "asc" ? 1 : -1;
    // Sort representative value for the group (used when reordering groups themselves)
    let sortVal;
    if (col === "pnl") sortVal = totalPnl * dir;
    else if (col === "closeDate") sortVal = (closeDates[closeDates.length - 1] || "") + (dir < 0 ? "" : "");
    else if (col === "openDate") sortVal = (openDates[0] || "");
    else if (col === "ticker") sortVal = legs[0].ticker;
    else if (col === "strategy") sortVal = legs[0].strategy || "";
    else sortVal = closeDates[closeDates.length - 1] || "";

    groups.push({
      id, isSolo, trades: legs,
      ticker: legs[0].ticker,
      strategy: legs[0].strategy || "",
      totalPnl,
      openDate: openDates[0] || "",
      closeDate: closeDates[closeDates.length - 1] || "",
      closeDates,
      crossDay,
      outlier: false, // filled below
      sortVal,
    });
  }

  // Outlier detection — flag groups ≥2σ from mean per strategy (min 5 samples)
  const byStrat = new Map();
  for (const g of groups) {
    const s = g.strategy || "Unknown";
    if (!byStrat.has(s)) byStrat.set(s, []);
    byStrat.get(s).push(g.totalPnl);
  }
  for (const g of groups) {
    const vals = byStrat.get(g.strategy || "Unknown") || [];
    if (vals.length < 5) continue;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
    const sigma = Math.sqrt(variance);
    if (sigma > 0 && Math.abs(g.totalPnl - mean) > 2 * sigma) g.outlier = true;
  }

  // Preserve the original (sorted) order trades arrived in, grouped
  return groups;
}

/** Render one leg row (td cells) — used both for solo rows and multi-leg sub-rows */
export function _renderLegRow(t: any, opts: { indent?: boolean; suppressedStyle?: string } = {}) {
  const { indent = false, suppressedStyle = "" } = opts;
  const isRollOpen = !!t.isRollOpenRef;
  const pnlColor = isRollOpen ? "var(--tx3)" : (journalTradePnl(t) >= 0 ? "var(--ok-tx)" : "var(--err-tx)");
  const openLeg = findOpenLegKey(t);
  const rollDetail = t.isRoll && (t.rollLabel || t.rollTo)
    ? (t.rollLabel || `$${t.strike ?? "?"} → $${t.rollTo?.strike ?? "?"}`)
    : "";
  const rollTip = t.isRoll && t.rollTo
    ? `Roll ${rollDetail} · net ${fmtDollar(t.rollNetPnl ?? t.pnl)}${t.legPnl != null ? ` · leg ${fmtDollar(t.legPnl)}` : ""} · opened ${t.rollTo.openDate || ""} @ $${t.rollTo.openPrice ?? ""}`
    : "";
  const assignTip = t.linkedEquity
    ? `Stock: ${t.linkedEquity.qty} sh @ $${t.linkedEquity.price ?? "?"} on ${t.linkedEquity.date}`
    : t.linkedOption
      ? `Option: ${t.linkedOption.optType} $${t.linkedOption.strike ?? ""} ${t.linkedOption.closeTypeLabel || t.linkedOption.closeType || ""} (${t.linkedOption.qty}c)`
      : "";
  const assignRollTip = t.assignmentRollup
    ? `Assignment rollup: opt ${fmtDollar(t.optionLegPnl ?? 0)} + stock ${fmtDollar(t.equityLegPnl ?? 0)} = ${fmtDollar(t.combinedPnl ?? t.pnl)}`
    : assignTip;
  const warnTip = (t.warnings || []).map(w => w.msg).join(" · ");
  const flags = [];
  if (t.isRoll && rollDetail) {
    flags.push(`<span class="hist-roll-inline">${esc(rollDetail)}</span>`);
  } else if (t.isRoll) {
    flags.push(`<span class="hist-tip-wrap"><span class="hist-flag hist-flag-roll" tabindex="0">↻</span><span class="hist-tip">${esc(rollTip)}</span></span>`);
  }
  if (t.linkedEquity || t.linkedOption) {
    flags.push(`<span class="hist-tip-wrap"><span class="hist-flag hist-flag-link" tabindex="0">⇄</span><span class="hist-tip">${esc(assignRollTip)}</span></span>`);
  }
  if (t.warnings?.length) flags.push(`<span class="hist-tip-wrap"><span class="hist-flag hist-flag-warn" tabindex="0">!</span><span class="hist-tip">${esc(warnTip)}</span></span>`);
  if (isRollOpen) flags.push(`<span class="hist-flag hist-flag-roll-open" title="Roll open reference">↗</span>`);
  const closeLbl = isRollOpen
    ? `<span class="hist-roll-inline">Roll Open</span>`
    : t.isRoll && rollDetail
    ? `<span class="hist-roll-inline">Roll · ${esc(rollDetail)}</span>`
    : esc(t.closeTypeLabel || t.closeType || "—");
  const pnlShown = isRollOpen
    ? `<span style="color:var(--tx3)">—</span>`
    : t.assignmentRollup
    ? `<span class="hist-tip-wrap"><span>${fmtDollar(journalTradePnl(t))}</span><span class="hist-tip">${esc(assignRollTip)}</span></span>`
    : t.isRoll && t.rollNetPnl != null
    ? `<span class="hist-tip-wrap"><span>${fmtDollar(journalTradePnl(t))}</span><span class="hist-tip">Roll net ${fmtDollar(t.rollNetPnl)} · leg close ${fmtDollar(t.legPnl ?? journalTradePnl(t))}</span></span>`
    : fmtDollar(journalTradePnl(t));
  const rollOpenTip = isRollOpen && t.linkedRollClose
    ? `Roll open leg · linked close ${t.linkedRollClose.ticker} ${t.linkedRollClose.closeDate || ""}${t.linkedRollClose.rollLabel ? " · " + t.linkedRollClose.rollLabel : ""}`
    : "";
  const rowTip = rollOpenTip || warnTip || rollTip || assignRollTip || (openLeg ? "Jump to open leg" : "Jump to ticker");
  const rowClass = `hist-row-click${t.warnings?.length ? " hist-row-warn" : ""}${t.journalSuppress ? " hist-row-suppressed" : ""}${isRollOpen ? " hist-row-roll-open" : ""}${indent ? " hist-row-leg" : ""}`;
  const rowPrefix = indent ? "  ↳ " : ((t.journalSuppress || isRollOpen) ? "↳ " : "");
  return `<tr class="${rowClass}" style="${suppressedStyle}" data-hist-ticker="${t.ticker}" data-hist-leg="${openLeg || ""}" data-hist-assign="${t.assignmentRollup ? "1" : ""}" data-hist-close="${t.closeDate || ""}" title="${esc(rowTip)}"><td>${rowPrefix}${t.ticker}</td><td>${t.instrument === "equity" ? "Stock" : t.optType}</td><td>${esc(normalizeStrategyLabel(t.strategy as string))}</td><td>${closeLbl}</td><td>${t.openDate}</td><td>${t.closeDate}</td><td>${t.holdDays}</td><td>${t.qty}</td><td style="color:${pnlColor};font-weight:500">${pnlShown}</td><td style="white-space:nowrap">${flags.join(" ")}${openLeg ? '<span style="font-size:10px;color:var(--tx3);margin-left:4px">●</span>' : ""}</td></tr>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Roll Analyzer Modal (#11)
// ═══════════════════════════════════════════════════════════════════════════

