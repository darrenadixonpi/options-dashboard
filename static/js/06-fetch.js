// ═══════════════════════════════════════════════════════════════════════════
// Fetch Button — full pipeline + greeks + events
// ═══════════════════════════════════════════════════════════════════════════

document.getElementById("btn-clear-session")?.addEventListener("click", () => {
  localStorage.removeItem(SESSION_KEY);
  document.getElementById("session-restore-banner").hidden = true;
});

document.getElementById("btn-open-import")?.addEventListener("click", openImportDrawer);
document.getElementById("btn-close-import")?.addEventListener("click", closeImportDrawer);
document.getElementById("import-drawer")?.addEventListener("click", (e) => {
  if (e.target.id === "import-drawer") closeImportDrawer();
});
document.getElementById("btn-refresh-marks")?.addEventListener("click", refreshOptionMarks);

document.getElementById("btn-fetch").addEventListener("click", async function() {
  const btn = this;
  if (!state.rawPosTexts?.length || btn.classList.contains("fetch-busy")) return;
  const prevSnapForAttr = state.prevSnapshot;
  setFetchButtonLoading(true);
  btn.innerHTML = "<span>⏳</span> <span>Processing...</span>";
  const log = document.getElementById("fetch-log");

  try {
    log.textContent = "Merging CSV files...";
    const mode = getMergeMode();
    state.posText = mergeCSVTexts(state.rawPosTexts, mode);
    state.histText = state.rawHistTexts?.length ? mergeCSVTexts(state.rawHistTexts, mode) : "";

    log.textContent = "Parsing positions...";
    const parsed = parsePositions(state.posText);
    const {positions: rawPositions, format} = parsed;
    state.format = format;
    state.fills = state.histText ? parseHistory(state.histText) : [];

    log.textContent = state.histText ? "Filtering closed positions..." : "Skipping history (positions-only mode)...";
    const filteredPositions = filterClosedPositions(rawPositions, state.histText);
    const filtered = rawPositions.length - filteredPositions.length;

    log.textContent = "Reconstructing share positions...";
    const positions = reconstructSharePositions(filteredPositions, state.histText);
    state.positions = positions;
    populateWhatIfTickers();

    if (!positions.length) {
      const broker = document.querySelector(".broker-btn.active")?.dataset.broker;
      const hint = parsed.hint || formatParseHint(format, broker);
      log.textContent = `No positions found (detected: ${format}). ${hint}`;
      document.getElementById("error-box").hidden = false;
      document.getElementById("error-box").textContent = hint;
      btn.innerHTML = "<span>✗</span> <span>Retry</span>"; setFetchButtonLoading(false); return;
    }

    const tickers = [...new Set(positions.map(p => p.ticker))].sort();
    log.textContent = `Fetching live data for ${tickers.length} tickers...`;
    btn.innerHTML = "<span>⏳</span> <span>Fetching prices + IV...</span>";

    const res = await fetch("/api/market-data", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({tickers})
    });
    const data = await res.json();
    state.marketData = data;
    state.fetchedAt = new Date().toISOString();
    const found = Object.values(data).filter(v => v?.price).length;

    log.textContent = `Fetching option marks for short legs...`;
    state.optionMarks = null;
    try {
      const shortLegs = state.positions.filter(p => p.posType !== "equity" && p.contracts < 0 && p.expiry);
      if (shortLegs.length) {
        const marksRes = await fetch("/api/option-marks", {
          method: "POST", headers: {"Content-Type": "application/json"},
          body: JSON.stringify({ positions: shortLegs.map(p => ({
            ticker: p.ticker, expiry: dateKey(p.expiry), strike: p.strike, optType: p.optType, posType: "option",
          }))}),
        });
        const marksData = await marksRes.json();
        state.optionMarks = marksData.marks || {};
        state.marksNote = marksData.note;
        state.marksFetchedAt = marksData.fetchedAt || new Date().toISOString();
        if (marksData.fetchedAt) state.fetchedAt = marksData.fetchedAt;
      }
    } catch (e) { console.error("Option marks error:", e); }

    log.textContent = `Building dashboard... (${found}/${tickers.length} tickers with prices)`;
    state.portfolio = buildPortfolio([...positions.map(p=>({...p}))], state.fills, state.marketData);

    // Fetch greeks (#1, #2, #3)
    log.textContent = "Computing Greeks + Beta-weighted delta...";
    try {
      const greeksRes = await fetch("/api/greeks", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          positions: state.positions.map(p => ({
            ticker: p.ticker, expiry: p.expiry ? dateKey(p.expiry) : null,
            strike: p.strike, optType: p.optType,
            contracts: p.contracts, shares: p.shares || 0,
            posType: p.posType || "option", avgCost: p.avgCost || 0, adjCost: p.adjCost || null,
          })),
          marketData: state.marketData,
        })
      });
      state.greeks = await greeksRes.json();
    } catch(e) { console.error("Greeks error:", e); }

    if (prevSnapForAttr) {
      log.textContent = "Computing P&L attribution vs last fetch...";
      await fetchPnlAttribution(prevSnapForAttr);
    } else {
      document.getElementById("attribution-section").hidden = true;
      state.attribution = null;
    }
    state.prevSnapshot = buildMarketSnapshot(state.marketData, state.greeks);

    // Fetch events (#8)
    log.textContent = "Fetching earnings & events...";
    try {
      const evRes = await fetch("/api/events", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({tickers})
      });
      state.events = await evRes.json();
    } catch(e) { console.error("Events error:", e); }

    // Analyze trade history (#12)
    if (state.histText) {
      log.textContent = "Analyzing trade history...";
      try {
        const histRes = await fetch("/api/trade-history", {
          method: "POST", headers: {"Content-Type": "application/json"},
          body: JSON.stringify({historyText: state.histText})
        });
        state.tradeHistory = await histRes.json();
        renderTradeHistory(state.tradeHistory);
      } catch(e) { console.error("Trade history error:", e); }
    }

    document.getElementById("debug-box").hidden = false;
    document.getElementById("debug-box").textContent = `${format} | ${positions.length} positions${filtered ? ` (${filtered} closed filtered out)` : ""} | ${state.fills.length} fills | live data for ${Object.keys(data).length} tickers (${mode} merge)`;
    document.getElementById("error-box").hidden = true;
    document.getElementById("ready-banner").hidden = false;
    document.getElementById("ready-text").textContent = "Dashboard ready with live data";
    document.getElementById("ready-sub").textContent = `${state.portfolio.totalPositions} positions · ${state.portfolio.totalExpiries} expiries · ${state.portfolio.uniqueTickers} tickers`;

    state.deskAlertFromFetch = true;
    renderPortfolio(state.portfolio, true);
    updateProvenanceBar();
    updateMarksStaleLabel();
    enableSimButton();
    enableRiskTab();
    saveSession();
    persistFetchSession();
    state.riskMatrixLoaded = false;
    state.lastRiskMatrix = null;
    state.simDone = false;
    state.simResult = null;
    closeImportDrawer();
    switchToTab("positions");

    log.textContent = `Done — ${found}/${tickers.length} tickers with prices · ${state.fills.length} fills matched${state.histText ? "" : " · history skipped"}`;
    btn.innerHTML = "<span>✓</span> <span>Refresh (re-fetch + rebuild)</span>";
    setFetchButtonLoading(false);
  } catch(e) {
    log.textContent = `Error: ${e.message}`;
    document.getElementById("error-box").hidden = false;
    document.getElementById("error-box").textContent = e.message;
    btn.innerHTML = "<span>✗</span> <span>Retry</span>"; setFetchButtonLoading(false);
  }
});

