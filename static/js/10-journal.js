// ═══════════════════════════════════════════════════════════════════════════
// Trade History (#12)
// ═══════════════════════════════════════════════════════════════════════════

/** Canonical strategy names — filter shows only labels present in closed trades (count > 0). */
const JOURNAL_STRATEGY_CATALOG = {
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

function buildJournalStrategyFilterOptions(trades, selected) {
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

function renderJournalSummary(stats) {
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

function renderTradeHistory(data) {
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

  const stratSel = document.getElementById("hist-filter-strategy");
  if (stratSel) {
    const cur = state.journalStrategyFilter;
    const stratPool = getJournalTradesForStrategyFilter();
    stratSel.innerHTML = buildJournalStrategyFilterOptions(stratPool, cur);
    if (cur && ![...stratSel.options].some(o => o.value === cur)) state.journalStrategyFilter = "";
  }
  const assignToggle = document.getElementById("hist-show-assignment-legs");
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
          html += `<div style="display:flex;justify-content:space-between;gap:12px;padding:2px 0;color:var(--tx2)"><span>${t.ticker} · ${esc(normalizeStrategyLabel(t.strategy))}${rollTag}${assignTag}</span><span style="color:${col}">${pnlLabel}</span></div>`;
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
  for (const t of trades) {
    const isRollOpen = !!t.isRollOpenRef;
    const pnlColor = isRollOpen ? "var(--tx3)" : (t.pnl >= 0 ? "var(--ok-tx)" : "var(--err-tx)");
    const openLeg = findOpenLegKey(t);
    const rollOpenTip = isRollOpen && t.linkedRollClose
      ? `Roll open leg · linked close ${t.linkedRollClose.ticker} ${t.linkedRollClose.closeDate || ""}${t.linkedRollClose.rollLabel ? " · " + t.linkedRollClose.rollLabel : ""}`
      : "";
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
      ? `<span class="hist-tip-wrap"><span>${fmtDollar(t.pnl)}</span><span class="hist-tip">${esc(assignRollTip)}</span></span>`
      : t.isRoll && t.rollNetPnl != null
      ? `<span class="hist-tip-wrap"><span>${fmtDollar(t.pnl)}</span><span class="hist-tip">Roll net ${fmtDollar(t.rollNetPnl)} · leg close ${fmtDollar(t.legPnl ?? t.pnl)}</span></span>`
      : fmtDollar(t.pnl);
    const rowTip = rollOpenTip || warnTip || rollTip || assignRollTip || (openLeg ? "Jump to open leg" : "Jump to ticker");
    const rowClass = `hist-row-click${t.warnings?.length ? " hist-row-warn" : ""}${t.journalSuppress ? " hist-row-suppressed" : ""}${isRollOpen ? " hist-row-roll-open" : ""}`;
    const rowPrefix = (t.journalSuppress || isRollOpen) ? "↳ " : "";
    html += `<tr class="${rowClass}" data-hist-ticker="${t.ticker}" data-hist-leg="${openLeg || ""}" title="${esc(rowTip)}"><td>${rowPrefix}${t.ticker}</td><td>${t.instrument === "equity" ? "Stock" : t.optType}</td><td>${esc(normalizeStrategyLabel(t.strategy))}</td><td>${closeLbl}</td><td>${t.openDate}</td><td>${t.closeDate}</td><td>${t.holdDays}</td><td>${t.qty}</td><td style="color:${pnlColor};font-weight:500">${pnlShown}</td><td style="white-space:nowrap">${flags.join(" ")}${openLeg ? '<span style="font-size:10px;color:var(--tx3);margin-left:4px">●</span>' : ""}</td></tr>`;
  }
  html += '</tbody></table>';
  document.getElementById("history-table-container").innerHTML =
    `<div class="journal-table-scroll">${html}</div>`;

  document.querySelectorAll("#history-table-container [data-sort-col]").forEach(th => {
    th.addEventListener("click", () => {
      const col = th.dataset.sortCol;
      if (state.journalSort.col === col) state.journalSort.dir = state.journalSort.dir === "asc" ? "desc" : "asc";
      else { state.journalSort.col = col; state.journalSort.dir = col === "pnl" ? "desc" : "asc"; }
      renderTradeHistory(data);
    });
  });
  document.querySelectorAll("#history-table-container .hist-row-click").forEach(row => {
    row.addEventListener("click", () => {
      const leg = row.dataset.histLeg;
      if (leg) jumpToLeg(leg);
      else jumpToLeg(null, row.dataset.histTicker);
    });
  });

  if (data.trades.length >= 1) {
    document.getElementById("history-chart-container").hidden = false;
    const histTab = document.getElementById("tab-history");
    if (histTab && !histTab.hidden) drawCumulativePnlChart(getJournalTradesForChart());
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Roll Analyzer Modal (#11)
// ═══════════════════════════════════════════════════════════════════════════

