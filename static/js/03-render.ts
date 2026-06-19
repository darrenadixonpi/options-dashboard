// ═══════════════════════════════════════════════════════════════════════════
// Rendering
// ═══════════════════════════════════════════════════════════════════════════
// Rendering
// ═══════════════════════════════════════════════════════════════════════════

const SEV_CLASS={ok:"badge-ok",warn:"badge-warn",danger:"badge-danger",deep:"badge-deep",atm:"badge-atm"};

// Realized P&L per ticker from the backend FIFO closed-trades (state.tradeHistory.trades).
// This is the source of truth: shares matched at cost basis, options signed for short/long,
// assigned/expired counted as closed. Cached on the tradeHistory object.
function realizedPnlByTicker() {
  const th = state.tradeHistory;
  if (!th || !Array.isArray(th.trades)) return {};
  if (th._realizedMap) return th._realizedMap;
  const m = {};
  for (const t of th.trades) {
    const tk = (t.ticker || "").toUpperCase();
    if (!tk) continue;
    const pnl = t.pnl || 0;
    const o = m[tk] || (m[tk] = { total: 0, shares: 0, options: 0 });
    o.total += pnl;
    if (t.instrument === "option") o.options += pnl; else o.shares += pnl;
  }
  th._realizedMap = m;
  return m;
}

// Compact signed dollars, e.g. +$1,234 / −$987.
function fmtSignedUsd(v) {
  const n = Math.round(v || 0);
  return `${n >= 0 ? "+" : "−"}$${Math.abs(n).toLocaleString()}`;
}

// Strategy name compression utility
function compressStrategy(strategy) {
  if (!strategy) return "";
  const parts = strategy.split(" + ");
  const uniqueParts = [...new Set(parts)];
  if (uniqueParts.length <= 2 && parts.length <= 3) return strategy;
  const counts = {};
  parts.forEach(p => { counts[p] = (counts[p] || 0) + 1; });
  const entries = Object.entries(counts);
  const shown = entries.slice(0, 3).map(([k, v]) => (v as number) > 1 ? `${k} ×${v}` : k).join(" + ");
  return entries.length > 3 ? shown + ` +${entries.length - 3}` : shown;
}

const rollPosMap = {};

// ─── Position sort helpers ────────────────────────────────────────────────

function _tickerMinDTE(tickerMap, tkr) {
  let minDte = Infinity;
  for (const sec of tickerMap[tkr].sections) {
    if (!sec.expiry) continue;
    const exp = sec.expiry instanceof Date ? sec.expiry : new Date(sec.expiry);
    const dte = Math.ceil(((exp as any) - (new Date() as any)) / 86400000);
    if (dte > 0 && dte < minDte) minDte = dte;
  }
  return minDte === Infinity ? 9999 : minDte;
}

function sortTickerKeys(keys, tickerMap) {
  const by = state.posSortBy || "alpha";
  const sorted = [...keys];
  if (by === "alpha") {
    sorted.sort();
  } else if (by === "dte") {
    sorted.sort((a, b) => _tickerMinDTE(tickerMap, a) - _tickerMinDTE(tickerMap, b));
  } else if (by === "delta") {
    sorted.sort((a, b) => {
      const da = Math.abs(state.greeks?.byTicker?.[a]?.delta || 0);
      const db = Math.abs(state.greeks?.byTicker?.[b]?.delta || 0);
      return db - da; // descending
    });
  } else if (by === "iv") {
    sorted.sort((a, b) => {
      const ia = state.marketData?.[a]?.iv || 0;
      const ib = state.marketData?.[b]?.iv || 0;
      return (ib as number) - (ia as number); // descending
    });
  }
  return sorted;
}

function renderPortfolio(portfolio, hasMarket) {
  const viewMode = state.viewMode || "ticker";
  document.getElementById("notice-bar").hidden = hasMarket;
  const histNotice = document.getElementById("history-notice-bar");
  if (histNotice) {
    const noHist = !state.rawHistTexts?.length;
    histNotice.hidden = !noHist;
    if (noHist) {
      document.getElementById("history-notice-text").textContent =
        "Portfolio-only: showing avg cost from positions export. Per-fill dates, adjusted basis, true breakevens, and equity P&L vs premium require History CSV.";
    }
  }
  document.getElementById("summary").innerHTML = `
    <div class="stat"><div class="stat-label">Positions</div><div class="stat-val">${portfolio.totalPositions}</div></div>
    <div class="stat"><div class="stat-label">Strategies</div><div class="stat-val">${portfolio.uniqueStrategies}</div></div>
    <div class="stat"><div class="stat-label">Expiries</div><div class="stat-val">${portfolio.totalExpiries}</div></div>
    <div class="stat"><div class="stat-label">Tickers</div><div class="stat-val">${portfolio.uniqueTickers}</div></div>`;

  // Greeks summary — full portfolio strip
  if (state.greeks && state.greeks.portfolio) {
    const g: any = state.greeks.portfolio;
    const el = document.getElementById("greeks-dashboard-summary");
    el.hidden = false;
    let html = `
      <div class="stat" style="border-left:3px solid #90caf9"><div class="stat-label">Portfolio Δ</div><div class="stat-val" style="font-size:18px;color:#90caf9">${g.delta.toFixed(0)}</div></div>
      <div class="stat" style="border-left:3px solid #f5c518"><div class="stat-label">Portfolio Θ</div><div class="stat-val" style="font-size:18px;color:#f5c518">$${g.theta.toFixed(0)}</div></div>
      <div class="stat" style="border-left:3px solid #a5d6a7"><div class="stat-label">Portfolio V</div><div class="stat-val" style="font-size:18px;color:#a5d6a7">$${g.vega.toFixed(0)}</div></div>
      <div class="stat" style="border-left:3px solid #ce93d8"><div class="stat-label">Portfolio Γ</div><div class="stat-val" style="font-size:18px;color:#ce93d8">${g.gamma.toFixed(2)}</div></div>`;
    if (state.greeks.risk) {
      html += `<div class="stat" style="border-left:3px solid var(--err-tx)"><div class="stat-label">Max Loss (est)</div><div class="stat-val" style="font-size:16px;color:var(--err-tx)">$${(state.greeks.risk as any).totalMaxLoss.toLocaleString()}</div></div>`;
    }
    if (state.greeks.betaWeighted) {
      const bw: any = state.greeks.betaWeighted;
      html += `<div class="stat" style="border-left:3px solid #ffcc02"><div class="stat-label">β-Weighted Δ</div><div class="stat-val" style="font-size:16px;color:#ffcc02">${bw.delta.toFixed(0)}</div></div>`;
    }
    el.innerHTML = html;
  }

  let bodyHtml = "";
  if (viewMode === "ticker") {
    const tickerMap = {};
    for (const eg of portfolio.groups) {
      for (const tg of eg.tickers) {
        if (!tickerMap[tg.ticker]) tickerMap[tg.ticker] = { info: tg, sections: [] };
        tickerMap[tg.ticker].info = { ...tickerMap[tg.ticker].info, ...tg };
        tickerMap[tg.ticker].sections.push({ expLabel: eg.label, expiry: eg.expiry, strikes: tg.strikes, posType: tg.posType, strategy: tg.strategy });
      }
    }
    const sortedTickers = sortTickerKeys(Object.keys(tickerMap), tickerMap);
    for (const tkr of sortedTickers) {
      const tm = tickerMap[tkr];
      const tg = tm.info;
      bodyHtml += renderTickerHeader(tg);
      for (const sec of tm.sections) {
        if (tm.sections.length > 1 || sec.expLabel !== "Shares") {
          bodyHtml += `<div style="padding:4px 18px 2px;font-size:11px;color:var(--tx3);font-weight:500;border-top:0.5px dashed var(--bd2)">${esc(sec.expLabel)}${sec.strategy ? ` · <span style="color:var(--accent)" title="${esc(sec.strategy)}">${esc(compressStrategy(sec.strategy))}</span>` : ""}</div>`;
        }
        for (const sg of sec.strikes) bodyHtml += renderStrike({...sg, expiry: sg.expiry || sec.expiry}, tg.posType || sec.posType, tg);
      }
      bodyHtml += `</div></div></div>`;
    }
  } else {
    for (const eg of portfolio.groups) {
      bodyHtml += `<div class="exp-hdr">${esc(eg.label)}</div>`;
      for (const tg of eg.tickers) {
        bodyHtml += renderTickerHeader(tg);
        for (const sg of tg.strikes) bodyHtml += renderStrike({...sg, expiry: sg.expiry || eg.expiry}, tg.posType, tg);
        bodyHtml += `</div></div></div>`;
      }
    }
  }

  document.getElementById("portfolio-body").innerHTML = bodyHtml;
  document.getElementById("footer").textContent = `Generated ${new Date().toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}${hasMarket?" · live data":""} · ${portfolio.totalPositions} positions`;

  // Show filter bar and re-apply active filter/sort state
  const filterBar = document.getElementById("pos-filter-bar");
  if (filterBar) {
    filterBar.hidden = false;
    // Re-apply sort button active state
    filterBar.querySelectorAll(".pos-sort-btn").forEach(btn => {
      btn.classList.toggle("active", (btn as HTMLElement).dataset.sort === (state.posSortBy || "alpha"));
    });
    // Re-apply ticker filter text
    const filterInput = document.getElementById("pos-ticker-filter") as HTMLInputElement | null;
    if (filterInput && filterInput.value.trim()) applyTickerFilter(filterInput.value);
  }

  renderPositionsRail();
  if (hasMarket) {
    loadMiniRiskMatrix();
    refreshDeskAlerts();
  }

  // Wire up clickable ticker rows → simulation fan chart when available
  document.querySelectorAll(".tk-block.clickable").forEach(el => {
    el.addEventListener("click", () => jumpToTickerFromPositions((el as HTMLElement).dataset.ticker));
  });

  // Wire up roll buttons (#11)
  document.querySelectorAll(".btn-roll").forEach(el => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const pos = rollPosMap[(el as HTMLElement).dataset.rollKey];
      if (pos) openRollModal(pos);
    });
  });
}

function renderTickerHeader(tg) {
  const ivClass = tg.iv>=150?"iv-hi":tg.iv>=100?"iv-mid":"iv-lo";
  const ivRankClass = tg.ivRank!=null ? (tg.ivRank>=70?"iv-hi":tg.ivRank>=40?"iv-mid":"iv-lo") : "";
  let ivLine = "";
  if (tg.iv != null) {
    const md0 = state.marketData?.[tg.ticker];
    const isHvEstimate = md0?.iv_source === "hv_estimate";
    ivLine = `<span class="tk-iv ${ivClass}">IV ${tg.iv}%${isHvEstimate ? " (est. from HV)" : ""}`;
    if (tg.hv20 != null) ivLine += ` · HV ${tg.hv20}%`;
    if (tg.ivHvRatio != null) ivLine += ` · ${tg.ivHvRatio}x`;
    ivLine += `</span>`;
    if (tg.ivRank != null) ivLine += `<span class="tk-iv ${ivRankClass}">IVR ${tg.ivRank}% · IVP ${tg.ivPct||0}%</span>`;
  } else {
    ivLine = `<span class="tk-iv" style="color:var(--tx3)">No IV data (no option chain)</span>`;
  }
  // Expected move (#4)
  const md = state.marketData?.[tg.ticker];
  let emLine = "";
  if (md?.em_1m) {
    emLine = `<span class="tk-iv" style="color:var(--tx3);font-size:10px">EM ±$${md.em_1m} (±${md.em_1m_pct}%) 30d</span>`;
  }
  // Dividend ex-date warning (#7)
  let divLine = "";
  if (md?.exDivDate) {
    const exDiv = new Date(md.exDivDate as string);
    const daysToExDiv = Math.ceil(((exDiv as any) - (new Date() as any)) / 86400000);
    if (daysToExDiv > 0 && daysToExDiv <= 30) {
      const hasShortCalls = state.positions.some(p => p.ticker === tg.ticker && p.optType === "Call" && p.contracts < 0);
      if (hasShortCalls) {
        divLine = `<span class="tk-iv" style="color:var(--warn-tx)">⚠ Ex-div $${md.lastDividend || "?"} in ${daysToExDiv}d</span>`;
      }
    }
  }
  // Per-ticker delta from greeks (#1)
  let greekLine = "";
  if (state.greeks?.byTicker?.[tg.ticker]) {
    const tkg = state.greeks.byTicker[tg.ticker];
    greekLine = `<span class="tk-iv" style="color:#90caf9;font-size:10px">Δ${tkg.delta.toFixed(0)} Γ${tkg.gamma.toFixed(1)} Θ$${tkg.theta.toFixed(0)} V$${tkg.vega.toFixed(0)}</span>`;
  }

  const stratDisplay = compressStrategy(tg.strategy);

  return `<div class="tk-block${state.simDone?' clickable':''}" data-ticker="${esc(tg.ticker)}"><div class="tk-row"><div class="tk-label">
    <span class="tk-name">${esc(tg.ticker)}</span>
    ${tg.price>0?`<span class="tk-price">$${tg.price}</span>`:""}
    ${ivLine}${emLine}${divLine}${greekLine}
    ${stratDisplay?`<span class="tk-strategy" title="${esc(tg.strategy)}">${esc(stratDisplay)}</span>`:""}
  </div><div class="tk-body">`;
}

function renderStrike(sg, posType, tg) {
  const statusClass = SEV_CLASS[sg.severity]||"badge-ok";
  let html = "";
  const isEquity = posType === "equity" || sg.strike == null || sg.shares != null;

  // DTE badge (#6)
  let dteBadge = "";
  if (!isEquity && sg.expiry) {
    const exp = sg.expiry instanceof Date ? sg.expiry : new Date(sg.expiry);
    const dte = Math.ceil(((exp as any) - (new Date() as any)) / 86400000);
    if (dte <= 7) dteBadge = `<span class="badge badge-danger" style="font-size:9px;margin-left:4px">${dte}d ⚡</span>`;
    else if (dte <= 21) dteBadge = `<span class="badge badge-warn" style="font-size:9px;margin-left:4px">${dte}d</span>`;
  }

  if (isEquity) {
    const dir = sg.contracts > 0 ? "Long" : "Short";
    // Cost basis = broker-reported avg cost. Premium is NOT blended in.
    const rawBasis = sg.avgCost || 0;
    const pnl = sg.contracts && tg.price && rawBasis ? Math.round((tg.price - rawBasis) * sg.contracts) : 0;
    // Realized P&L from the FIFO closed-trades (closed shares + closed/assigned/expired options).
    const realized = realizedPnlByTicker()[tg.ticker] || null;
    const eqPnlNote = !state.rawHistTexts?.length
      ? `<span style="font-size:10px;color:var(--warn-tx)">Unrealized vs avg cost (upload History for realized P&L)</span>` : "";
    html += `<div class="strike-section" data-leg-id="${esc(tg.ticker)}|equity"><div class="strike-info">
      <div class="strike-top"><span class="strike-val">${dir} ${Math.abs(sg.contracts)} sh</span></div>
      <span class="cts-val">Avg $${rawBasis ? rawBasis.toFixed(2) : "?"}</span>
    </div>
    <div style="font-family:var(--mono);font-size:13px;color:var(--tx2);display:flex;flex-direction:column;gap:2px">
      <span>Share P&L: <span style="color:${pnl>=0?"var(--ok-tx)":"var(--err-tx)"}">${pnl>=0?"+":""}$${pnl.toLocaleString()}</span> <span style="font-size:10px;color:var(--tx3)">unrealized</span></span>
      ${realized ? `<span style="font-size:11px">Realized P&L: <span style="color:${realized.total>=0?"var(--ok-tx)":"var(--err-tx)"}">${fmtSignedUsd(realized.total)}</span> <span style="font-size:10px;color:var(--tx3)">(shares ${fmtSignedUsd(realized.shares)} · options ${fmtSignedUsd(realized.options)})</span></span>` : ""}
      ${eqPnlNote}
    </div>
    <div class="status-col"><span class="badge ${statusClass}">${esc(sg.status)}</span></div></div>`;
  } else {
    const strike = sg.strike || 0;
    const optType = sg.optType || "Put";
    const typeClass = optType==="Put"?"type-put":"type-call";
    // Roll button for short options (#11)
    let rollBtn = "";
    if (sg.contracts < 0) {
      const exp = sg.expiry instanceof Date ? sg.expiry : (sg.expiry ? new Date(sg.expiry) : null);
      const rollKey = `${tg.ticker}|${exp ? dateKey(exp) : "na"}|${sg.strike}|${sg.optType}`;
      rollPosMap[rollKey] = {
        ticker: tg.ticker,
        expiry: exp ? dateKey(exp) : null,
        strike: sg.strike,
        optType: sg.optType,
        contracts: sg.contracts,
        avgCost: sg.avgCost || 0,
      };
      rollBtn = `<button class="btn btn-sm btn-ghost btn-roll" style="font-size:9px;padding:2px 6px;margin-left:4px" data-roll-key="${rollKey}">Roll</button>`;
    }
    let premBadge = "";
    if (sg.contracts < 0 && (sg.lots?.length || sg.avgCost > 0)) {
      const avgFill = sg.lots?.length
        ? sg.lots.reduce((s,l) => s + l.price * l.quantity, 0) / sg.lots.reduce((s,l) => s + l.quantity, 0)
        : sg.avgCost;
      const totalPrem = avgFill * Math.abs(sg.contracts) * 100;
      const exp = sg.expiry instanceof Date ? sg.expiry : new Date(sg.expiry);
      const mk = state.optionMarks?.[optionMarkKey(tg.ticker, exp, optType, strike)];
      if ((mk as any)?.mid > 0 && avgFill > 0) {
        const pctMax = Math.min(100, Math.max(0, ((avgFill - (mk as any).mid) / avgFill) * 100));
        const pctColor = pctMax >= 50 ? "var(--ok-tx)" : "var(--tx2)";
        let dte50 = "";
        if (!isEquity && sg.expiry && pctMax < 50 && pctMax > 0) {
          const exp = sg.expiry instanceof Date ? sg.expiry : new Date(sg.expiry);
          const dte = Math.ceil(((exp as any) - (new Date() as any)) / 86400000);
          const estDte50 = Math.max(1, Math.round(dte * (1 - pctMax / 50)));
          dte50 = ` · ~${estDte50}d→50%`;
        } else if (pctMax >= 50) {
          dte50 = " · past 50%";
        }
        premBadge = `<span style="font-size:10px;font-family:var(--mono);color:${pctColor}">${pctMax.toFixed(0)}% max · mid $${(mk as any).mid.toFixed(2)}${dte50}</span>`;
      } else {
        premBadge = `<span style="font-size:10px;color:var(--tx3);font-family:var(--mono)" title="No live mark — premium at open">$${totalPrem.toFixed(0)} prem (no mark)</span>`;
      }
    }

    const expForLeg = sg.expiry instanceof Date ? sg.expiry : (sg.expiry ? new Date(sg.expiry) : null);
    const legId = legKeyFromPos(tg.ticker, expForLeg || "na", strike, optType);
    html += `<div class="strike-section" data-leg-id="${legId}"><div class="strike-info">
      <div class="strike-top"><span class="strike-val">$${strike%1===0?strike.toFixed(0):strike}</span><span class="badge ${typeClass}">${optType}</span>${dteBadge}${rollBtn}</div>
      <span class="cts-val">${sg.contracts>0?"+":""}${sg.contracts} cts</span>${premBadge}</div>`;
    if (sg.lots && sg.lots.length) {
      const srcNote = sg.lotsSource === "portfolio"
        ? `<span style="font-size:9px;color:var(--warn-tx);grid-column:1/-1;margin-bottom:4px">Avg cost from portfolio CSV — upload History for fill dates</span>` : "";
      html += `<div class="lot-grid">${srcNote}<span class="lot-hd">date</span><span class="lot-hd r">qty</span><span class="lot-hd r">DTE</span><span class="lot-hd r">cost</span><span class="lot-hd r">prem</span>`;
      for (const l of sg.lots) {
        const dLabel = l.date ? shortDate(l.date instanceof Date ? l.date : new Date(l.date)) : "—";
        html += `<span class="lg-d">${dLabel}</span><span class="lg-q">${l.quantity}</span><span class="lg-t">${l.dte}d</span><span class="lg-c">$${l.price.toFixed(2)}</span><span class="lg-p">${l.premPct.toFixed(1)}%</span>`;
      }
      html += `</div>`;
    } else {
      const msg = !state.rawHistTexts?.length
        ? "No fill history — upload History CSV for opens/closes"
        : "No matching fills in History for this leg";
      html += `<div style="font-size:12px;color:var(--tx3);font-style:italic">${msg}</div>`;
    }
    html += `<div class="status-col"><span class="badge ${statusClass}">${esc(sg.status)}</span></div></div>`;
  }
  return html;
}

