// ═══════════════════════════════════════════════════════════════════════════
// Share Position Reconstruction
// ═══════════════════════════════════════════════════════════════════════════

function reconstructSharePositions(positions, histText) {
  if (!histText || !histText.trim()) return positions;
  const lines = histText.replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n");

  // Per-ticker accumulators
  const tkData = {}; // ticker → {buyCost, buyQty, sellProceeds, sellQty, putPrem, callPrem, netShares}

  function getTk(ticker) {
    if (!tkData[ticker]) tkData[ticker] = { buyCost: 0, buyQty: 0, sellProceeds: 0, sellQty: 0, putPrem: 0, callPrem: 0, netShares: 0 };
    return tkData[ticker];
  }

  for (const line of lines) {
    const r = parseCSVLine(line);
    if (r.length < 7) continue;
    const ds = r[0]?.trim();
    if (!ds || !/^\d/.test(ds)) continue;
    const action = (r[1] || "").trim().toUpperCase();
    const sym = (r[2] || "").trim();
    const price = Math.abs(parseFloat((r[5] || "").replace(/[$,+]/g, "")) || 0);
    const qty = Math.abs(parseInt(parseFloat(r[6] || "0"))) || 0;
    if (qty === 0 && !action.includes("EXPIRED") && !action.includes("ASSIGNED")) continue;

    const occ = parseOCC(sym);

    if (occ) {
      // Option transaction — track premium per underlying ticker
      if (action.includes("OPENING TRANSACTION") && action.includes("SOLD")) {
        const d = getTk(occ.ticker);
        const prem = price * qty * 100;
        if (occ.optType === "Put") d.putPrem += prem;
        else d.callPrem += prem;
      }
    } else {
      // Share transaction
      const ticker = sym.replace(/[*\s]/g, "").toUpperCase();
      if (!ticker || /\d{6}/.test(ticker) || ticker.length > 6 || ticker.includes(",")) continue;
      const d = getTk(ticker);

      if (action.includes("SOLD SHORT") || (action.includes("SOLD") && action.includes("SHORT SALE"))) {
        // Short selling — not counted as long position cost
        d.netShares -= qty;
      } else if (action.includes("BOUGHT SHORT COVER")) {
        // Covering short — this is a cost
        d.buyCost += price * qty;
        d.buyQty += qty;
        d.netShares += qty;
      } else if (action.includes("BOUGHT") && action.includes("ASSIGNED")) {
        // Assignment — shares acquired at strike price
        d.buyCost += price * qty;
        d.buyQty += qty;
        d.netShares += qty;
      } else if (action.includes("BOUGHT") && !action.includes("SHORT")) {
        // Regular buy
        d.buyCost += price * qty;
        d.buyQty += qty;
        d.netShares += qty;
      } else if (action.includes("SOLD") && !action.includes("SHORT") && !action.includes("OPENING")) {
        // Regular sell
        d.sellProceeds += price * qty;
        d.sellQty += qty;
        d.netShares -= qty;
      }
    }
  }

  // Process equity positions
  const result = [];
  for (const pos of positions) {
    if (pos.posType !== "equity") { result.push(pos); continue; }

    const ticker = pos.ticker;
    const d = tkData[ticker];

    // If history shows net 0 → fully closed, remove
    if (d && d.netShares === 0) continue;

    // Compute all-in adjusted basis
    if (d && d.buyQty > 0) {
      const netShares = Math.abs(d.netShares) || Math.abs(pos.shares || pos.contracts || 0);
      if (netShares > 0) {
        const netInvestment = d.buyCost - d.sellProceeds;
        const totalPremium = d.putPrem + d.callPrem;
        const rawBasis = Math.round(netInvestment / netShares * 100) / 100;
        const adjBasis = Math.round((netInvestment - totalPremium) / netShares * 100) / 100;

        result.push({
          ...pos,
          avgCost: rawBasis,
          adjCost: adjBasis,
          totalPremium: Math.round(totalPremium),
          putPremium: Math.round(d.putPrem),
          callPremium: Math.round(d.callPrem),
          costBasisComputed: true,
        });
        continue;
      }
    }

    result.push(pos);
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// Status + Strategy
// ═══════════════════════════════════════════════════════════════════════════

function computeStatus(optType, strike, underlying) {
  if(!underlying||underlying<=0) return {status:"—",severity:"ok"};
  const ratio = optType==="Put" ? (strike-underlying)/underlying : (underlying-strike)/underlying;
  if(Math.abs(ratio)<=0.02) return {status:"~ATM",severity:"atm"};
  if(ratio<=0) return {status:"OTM",severity:"ok"};
  if(ratio>0.25) return {status:"Deep ITM",severity:"deep"};
  if(ratio>0.10) return {status:"ITM",severity:"danger"};
  return {status:"ITM",severity:"warn"};
}

function classifyLegs(legs) {
  legs = aggregateLegsForClassify(legs);
  const equities = legs.filter(l => l.posType === "equity");
  const options = legs.filter(l => l.posType !== "equity");
  const shortCalls = options.filter(l => l.optType === "Call" && l.contracts < 0).sort((a, b) => a.strike - b.strike);
  const longCalls = options.filter(l => l.optType === "Call" && l.contracts > 0).sort((a, b) => a.strike - b.strike);
  const shortPuts = options.filter(l => l.optType === "Put" && l.contracts < 0).sort((a, b) => a.strike - b.strike);
  const longPuts = options.filter(l => l.optType === "Put" && l.contracts > 0).sort((a, b) => a.strike - b.strike);
  const calls = [...shortCalls, ...longCalls].sort((a, b) => a.strike - b.strike);
  const puts = [...shortPuts, ...longPuts].sort((a, b) => a.strike - b.strike);
  const nc = calls.length, np = puts.length, nOpts = nc + np;
  const hasShares = equities.length > 0;
  const shareQty = equities.reduce((s, e) => s + (e.shares || e.contracts || 0), 0);

  // ── PURE EQUITY ──
  if (nOpts === 0 && hasShares) return shareQty > 0 ? "Long Shares" : "Short Shares";

  // ── EQUITY + OPTIONS (compound) ──
  if (hasShares && nOpts > 0) {
    const coveredLots = Math.floor(Math.abs(shareQty) / 100);
    const isLong = shareQty > 0;

    // Count short calls and short puts
    const totalShortCallCts = shortCalls.reduce((s, c) => s + Math.abs(c.contracts), 0);
    const totalShortPutCts = shortPuts.reduce((s, p) => s + Math.abs(p.contracts), 0);

    // How many calls are covered by shares?
    const coveredCallCts = isLong ? Math.min(totalShortCallCts, coveredLots) : 0;
    const coveredPutCts = !isLong ? Math.min(totalShortPutCts, coveredLots) : 0;

    // If long shares + short calls + short puts:
    if (isLong && shortCalls.length > 0 && shortPuts.length > 0 && coveredCallCts > 0) {
      // Match short calls with short puts to form straddles/strangles
      const parts = [];
      let remainCalls = shortCalls.map(c => ({ ...c, rem: Math.abs(c.contracts) }));
      let remainPuts = shortPuts.map(p => ({ ...p, rem: Math.abs(p.contracts) }));

      // First pass: match same-strike pairs → covered straddles
      for (const rc of remainCalls) {
        for (const rp of remainPuts) {
          if (rp.rem > 0 && rc.rem > 0 && Math.abs(rc.strike - rp.strike) < 0.01) {
            const paired = Math.min(rc.rem, rp.rem, coveredLots);
            if (paired > 0) {
              parts.push(paired === 1 ? "Covered Straddle" : "Covered Straddles");
              rc.rem -= paired; rp.rem -= paired;
            }
          }
        }
      }
      // Second pass: match different-strike pairs → covered strangles
      for (const rc of remainCalls) {
        for (const rp of remainPuts) {
          if (rp.rem > 0 && rc.rem > 0) {
            const paired = Math.min(rc.rem, rp.rem, coveredLots);
            if (paired > 0) {
              parts.push(paired === 1 ? "Covered Strangle" : "Covered Strangles");
              rc.rem -= paired; rp.rem -= paired;
            }
          }
        }
      }
      // Remaining unpaired short calls with shares → covered calls
      const remCallCts = remainCalls.reduce((s, c) => s + c.rem, 0);
      if (remCallCts > 0) parts.push(remCallCts === 1 ? "Covered Call" : "Covered Calls");
      // Remaining unpaired short puts → short puts
      const remPutCts = remainPuts.reduce((s, p) => s + p.rem, 0);
      if (remPutCts > 0) parts.push(remPutCts === 1 ? "Short Put" : "Short Puts");
      // Long puts/calls
      if (longPuts.length > 0) parts.push(longPuts.length === 1 ? "Protective Put" : "Protective Puts");
      if (longCalls.length > 0) parts.push(longCalls.length === 1 ? "Long Call" : "Long Calls");

      return parts.length > 0 ? parts.join(" + ") : "Long Shares";
    }

    // Long shares + short calls only → covered calls
    if (isLong && shortCalls.length > 0 && shortPuts.length === 0 && longPuts.length === 0) {
      if (coveredCallCts >= totalShortCallCts) return totalShortCallCts === 1 ? "Covered Call" : "Covered Calls";
      return "Overwritten Calls";
    }
    // Long shares + short puts only
    if (isLong && shortCalls.length === 0 && shortPuts.length > 0) {
      return shortPuts.length === 1 ? "Long Shares + Short Put" : "Long Shares + Short Puts";
    }
    // Long shares + long puts → protective puts
    if (isLong && shortCalls.length === 0 && shortPuts.length === 0 && longPuts.length > 0) {
      return longPuts.length === 1 ? "Protective Put" : "Protective Puts";
    }
    // Long shares + long put + short call → collar
    if (isLong && shortCalls.length === 1 && longPuts.length === 1 && shortPuts.length === 0) {
      return "Collar w/ Shares";
    }
    // Short shares + short puts → covered puts
    if (!isLong && shortPuts.length > 0 && shortCalls.length === 0) {
      if (coveredPutCts >= totalShortPutCts) return totalShortPutCts === 1 ? "Covered Put" : "Covered Puts";
      return "Overwritten Puts";
    }
    // Generic fallback
    const fp = [];
    fp.push(shareQty > 0 ? `+${shareQty}sh` : `${shareQty}sh`);
    if (shortCalls.length) fp.push(`${totalShortCallCts}SC`);
    if (shortPuts.length) fp.push(`${totalShortPutCts}SP`);
    if (longCalls.length) fp.push(`${longCalls.reduce((s,c)=>s+c.contracts,0)}LC`);
    if (longPuts.length) fp.push(`${longPuts.reduce((s,p)=>s+p.contracts,0)}LP`);
    return fp.join("/");
  }

  // ── PURE OPTIONS ──
  if (nOpts === 1) { const p = options[0]; return `${p.contracts > 0 ? "Long" : "Short"} ${p.optType}`; }
  if (nc === 0 && np >= 2) { if (puts.every(l => l.contracts < 0)) return "Short Put"; if (puts.every(l => l.contracts > 0)) return "Long Put"; }
  if (np === 0 && nc >= 2) { if (calls.every(l => l.contracts < 0)) return "Short Call"; if (calls.every(l => l.contracts > 0)) return "Long Call"; }
  if (nOpts === 2 && nc === 2) {
    const q = calls.map(l => l.contracts), s = calls.map(l => l.strike);
    if (q[0] * q[1] < 0) return (q[0] > 0 ? s[0] : s[1]) < (q[0] < 0 ? s[0] : s[1]) ? "Bull Call Spread" : "Bear Call Spread";
  }
  if (nOpts === 2 && np === 2) {
    const q = puts.map(l => l.contracts), s = puts.map(l => l.strike);
    if (q[0] * q[1] < 0) return (q[0] > 0 ? s[0] : s[1]) > (q[0] < 0 ? s[0] : s[1]) ? "Bear Put Spread" : "Bull Put Spread";
  }
  if (nOpts === 2 && nc === 1 && np === 1) { const cq = calls[0].contracts, pq = puts[0].contracts, same = Math.abs(calls[0].strike - puts[0].strike) < 0.01;
    if (cq < 0 && pq < 0) return same ? "Short Straddle" : "Short Strangle"; if (cq > 0 && pq > 0) return same ? "Long Straddle" : "Long Strangle"; if (cq < 0 && pq > 0) return "Collar"; if (cq > 0 && pq < 0) return "Risk Reversal"; }
  if (nOpts === 3) {
    if (nc === 3) { const bf = detectButterfly(calls, "Call"); if (bf) return bf; return "Call Ladder"; }
    if (np === 3) { const bf = detectButterfly(puts, "Put"); if (bf) return bf; return "Put Ladder"; }
    if (nc === 2 && np === 1) {
      if (calls.every(l => l.contracts < 0) && puts[0].contracts < 0) return "Jade Lizard";
      const d = decomposeOptionStrategies(options); if (d) return d;
      return "3-Leg 2C/1P";
    }
    if (nc === 1 && np === 2) {
      if (puts.every(l => l.contracts < 0) && calls[0].contracts < 0) return "Twisted Sister";
      const d = decomposeOptionStrategies(options); if (d) return d;
      return "3-Leg 1C/2P";
    }
  }
  if (nOpts === 4 && nc === 2 && np === 2 && calls.some(l => l.contracts > 0) && calls.some(l => l.contracts < 0) && puts.some(l => l.contracts > 0) && puts.some(l => l.contracts < 0))
    return Math.abs(Math.max(...puts.map(l => l.strike)) - Math.min(...calls.map(l => l.strike))) < 0.01 ? "Iron Butterfly" : "Iron Condor";
  const decomposed = decomposeOptionStrategies(options);
  if (decomposed) return decomposed;
  const p = []; if (nc) p.push(nc + "C"); if (np) p.push(np + "P"); return `${nOpts}-Leg ${p.join("/")}`;
}

function aggregateLegsForClassify(legs) {
  let shareQty = 0;
  const optMap = new Map();
  for (const leg of legs) {
    if (leg.posType === "equity") shareQty += leg.shares || leg.contracts || 0;
    else {
      const key = `${leg.optType}|${Number(leg.strike || 0).toFixed(4)}`;
      optMap.set(key, (optMap.get(key) || 0) + (leg.contracts || 0));
    }
  }
  const out = [];
  if (shareQty) out.push({ posType: "equity", shares: shareQty, contracts: shareQty });
  for (const [key, cts] of [...optMap.entries()].sort()) {
    if (!cts) continue;
    const [optType, strike] = key.split("|");
    out.push({ posType: "option", optType, strike: parseFloat(strike), contracts: cts });
  }
  return out;
}

function joinStrategyLabels(labels) {
  const counts = {};
  for (const l of labels) counts[l] = (counts[l] || 0) + 1;
  return Object.entries(counts).map(([name, n]) => n > 1 ? `${name} (${n})` : name).join(" + ");
}

function pairVerticalSpreads(optionLegs, optType) {
  const buckets = new Map();
  for (const leg of optionLegs) {
    const strike = Number((leg.strike || 0).toFixed(4));
    buckets.set(strike, (buckets.get(strike) || 0) + (leg.contracts || 0));
  }
  const work = [];
  for (const [strike, cts] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    if (cts > 0) work.push({ strike, rem: cts, sign: 1 });
    else if (cts < 0) work.push({ strike, rem: -cts, sign: -1 });
  }
  const labels = [];
  const longs = work.filter(l => l.sign > 0);
  const shorts = work.filter(l => l.sign < 0);
  for (const lg of [...longs].sort((a, b) => a.strike - b.strike)) {
    while (lg.rem > 0) {
      const candidates = shorts.filter(s => s.rem > 0 && s.strike > lg.strike);
      if (!candidates.length) break;
      const partner = candidates.reduce((a, b) => a.strike < b.strike ? a : b);
      const matched = Math.min(lg.rem, partner.rem);
      labels.push(optType === "Call" ? "Bull Call Spread" : "Bull Put Spread");
      lg.rem -= matched; partner.rem -= matched;
    }
  }
  for (const lg of [...longs].sort((a, b) => b.strike - a.strike)) {
    while (lg.rem > 0) {
      const candidates = shorts.filter(s => s.rem > 0 && s.strike < lg.strike);
      if (!candidates.length) break;
      const partner = candidates.reduce((a, b) => a.strike > b.strike ? a : b);
      const matched = Math.min(lg.rem, partner.rem);
      labels.push(optType === "Call" ? "Bear Call Spread" : "Bear Put Spread");
      lg.rem -= matched; partner.rem -= matched;
    }
  }
  const unpaired = [];
  for (const leg of work) {
    if (leg.rem > 0) unpaired.push({ posType: "option", optType, strike: leg.strike, contracts: leg.sign > 0 ? leg.rem : -leg.rem });
  }
  return { labels, unpaired };
}

function detectButterfly(optionLegs, optType) {
  if (optionLegs.length !== 3) return null;
  const byStrike = new Map();
  for (const leg of optionLegs) {
    const strike = Number((leg.strike || 0).toFixed(4));
    byStrike.set(strike, (byStrike.get(strike) || 0) + (leg.contracts || 0));
  }
  if (byStrike.size !== 3) return null;
  const strikes = [...byStrike.keys()].sort((a, b) => a - b);
  const [low, mid, high] = strikes;
  const wing = byStrike.get(low), body = byStrike.get(mid), wing2 = byStrike.get(high);
  if (wing > 0 && wing2 > 0 && body < 0 && Math.abs(wing + wing2) === Math.abs(body))
    return optType === "Call" ? "Call Butterfly" : "Put Butterfly";
  if (wing < 0 && wing2 < 0 && body > 0 && Math.abs(wing + wing2) === Math.abs(body))
    return optType === "Call" ? "Short Call Butterfly" : "Short Put Butterfly";
  return null;
}

function labelUnpairedOptions(legs) {
  const labels = [];
  for (const optType of ["Call", "Put"]) {
    const typed = legs.filter(l => l.optType === optType);
    if (!typed.length) continue;
    const longCt = typed.filter(l => l.contracts > 0).reduce((s, l) => s + l.contracts, 0);
    const shortCt = typed.filter(l => l.contracts < 0).reduce((s, l) => s - l.contracts, 0);
    if (longCt && !shortCt) labels.push(optType === "Call" ? "Long Call" : "Long Put");
    else if (shortCt && !longCt) labels.push(optType === "Call" ? "Short Call" : "Short Put");
    else typed.forEach(l => labels.push(`${l.contracts > 0 ? "Long" : "Short"} ${optType}`));
  }
  return labels;
}

function decomposeOptionStrategies(options) {
  const callOpts = options.filter(o => o.optType === "Call");
  const putOpts = options.filter(o => o.optType === "Put");
  if (callOpts.length && !putOpts.length) { const bf = detectButterfly(callOpts, "Call"); if (bf) return bf; }
  if (putOpts.length && !callOpts.length) { const bf = detectButterfly(putOpts, "Put"); if (bf) return bf; }
  const labels = [];
  const callPair = pairVerticalSpreads(callOpts, "Call");
  const putPair = pairVerticalSpreads(putOpts, "Put");
  labels.push(...callPair.labels, ...putPair.labels, ...labelUnpairedOptions([...callPair.unpaired, ...putPair.unpaired]));
  return labels.length ? joinStrategyLabels(labels) : null;
}

/** Canonical singular strategy label (matches backend _normalize_strategy_label). */
function normalizeStrategyLabel(label) {
  if (!label) return "Unknown";
  const map = {
    "Covered Calls": "Covered Call",
    "Covered Puts": "Covered Put",
    "Covered Straddles": "Covered Straddle",
    "Covered Strangles": "Covered Strangle",
    "Protective Puts": "Protective Put",
    "Long Calls": "Long Call",
    "Short Calls": "Short Call",
    "Long Puts": "Long Put",
    "Short Puts": "Short Put",
    "Long Shares + Short Puts": "Long Shares + Short Put",
    "Overwritten Calls": "Overwritten Call",
    "Overwritten Puts": "Overwritten Put",
  };
  return String(label).split(" + ").map(p => map[p.trim()] || p.trim()).join(" + ");
}

function detectStrategies(positions) {
  // Group by ticker — equity has no expiry, so group all equity + options per ticker
  const tickerGroups = {};
  for (const pos of positions) {
    (tickerGroups[pos.ticker] ||= []).push(pos);
  }

  // For each ticker, subgroup by expiry for options, combine with equity
  const map = {};
  for (const [ticker, allLegs] of Object.entries(tickerGroups)) {
    const equityLegs = allLegs.filter(l => l.posType === "equity");
    const optionLegs = allLegs.filter(l => l.posType !== "equity");

    // Group options by expiry
    const byExpiry = {};
    for (const ol of optionLegs) {
      const ek = dateKey(ol.expiry);
      (byExpiry[ek] ||= []).push(ol);
    }

    if (Object.keys(byExpiry).length === 0 && equityLegs.length > 0) {
      // Pure equity
      const label = classifyLegs(equityLegs);
      for (const pos of equityLegs) map[`${pos.ticker}|equity|${pos.shares}`] = label;
    } else {
      // For each expiry group, combine with equity for classification
      for (const [ek, expLegs] of Object.entries(byExpiry)) {
        const combined = [...equityLegs, ...expLegs];
        const label = classifyLegs(combined);
        for (const pos of expLegs) {
          map[`${pos.ticker}|${ek}|${pos.strike}|${pos.optType}`] = label;
        }
        // Also tag equity legs with the strategy if combined
        if (equityLegs.length > 0) {
          for (const pos of equityLegs) map[`${pos.ticker}|equity|${pos.shares}`] = label;
        }
      }
    }
  }
  return map;
}

// ═══════════════════════════════════════════════════════════════════════════
// Portfolio Engine
// ═══════════════════════════════════════════════════════════════════════════

function dateKey(d){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;}
function shortDate(d){return `${d.getMonth()+1}/${String(d.getDate()).padStart(2,"0")}`;}
function expiryLabel(d){const mo=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];return d.getFullYear()>new Date().getFullYear()?`${mo[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`:`${mo[d.getMonth()]} ${d.getDate()}`;}
function esc(s){return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}

function buildPortfolio(positions, fills, marketData) {
  const stratMap = detectStrategies(positions);
  const ivData={}, priceData={}, fullMarket={};
  if(marketData){for(const[tk,d]of Object.entries(marketData)){if(d?.price)priceData[tk]=d.price;if(d?.iv!=null)ivData[tk]=d.iv;fullMarket[tk]=d;}}

  // Enrich positions with market data
  for(const pos of positions){
    const up=priceData[pos.ticker];
    if(up) pos.price=up;
    if(pos.posType==="equity"){
      // Equity status: use adjusted basis (includes premium) if available
      const basis = pos.adjCost || pos.avgCost;
      if(up && basis){
        const pnlPct = pos.shares > 0 ? (up - basis)/basis : (basis - up)/basis;
        if(pnlPct >= 0.05) { pos.status = "Profit"; pos.severity = "ok"; }
        else if(pnlPct >= -0.05) { pos.status = "Flat"; pos.severity = "atm"; }
        else if(pnlPct >= -0.15) { pos.status = "Down"; pos.severity = "warn"; }
        else { pos.status = "Deep Loss"; pos.severity = "danger"; }
      }
    } else if(up && pos.optType && pos.strike) {
      const s=computeStatus(pos.optType,pos.strike,up);pos.status=s.status;pos.severity=s.severity;
    }
  }

  // Separate equity and option positions
  const equityPositions = positions.filter(p => p.posType === "equity");
  const optionPositions = positions.filter(p => p.posType !== "equity");

  // Lot matching (options only)
  const lotMap={};
  for(const pos of optionPositions){
    if(!pos.expiry) continue;
    const key=`${pos.ticker}|${dateKey(pos.expiry)}|${pos.strike}|${pos.optType}`;const matched=[];
    for(const fill of fills){if(`${fill.ticker}|${dateKey(fill.expiry)}|${fill.strike}|${fill.optType}`===key)
      matched.push({date:fill.date,quantity:fill.quantity,price:fill.price,dte:Math.round((pos.expiry-fill.date)/864e5),premPct:pos.strike?Math.round(fill.price/pos.strike*1000)/10:0});}
    matched.sort((a,b)=>a.date-b.date||a.price-b.price);
    const merged=[];for(const l of matched){const last=merged[merged.length-1];if(last&&dateKey(last.date)===dateKey(l.date)&&last.price===l.price)last.quantity+=l.quantity;else merged.push({...l});}
    lotMap[key]=merged;
  }

  // Build expiry groups (options)
  const expiryOrder=[];const seen=new Set();
  for(const pos of optionPositions){if(!pos.expiry)continue;const ek=dateKey(pos.expiry);if(!seen.has(ek)){expiryOrder.push(pos.expiry);seen.add(ek);}}
  expiryOrder.sort((a,b)=>a-b);

  const groups=expiryOrder.map(expiry=>{
    const ek=dateKey(expiry),tkOrd=[],tkSeen=new Set(),tkMap={};
    for(const pos of optionPositions){if(!pos.expiry||dateKey(pos.expiry)!==ek)continue;if(!tkSeen.has(pos.ticker)){tkOrd.push(pos.ticker);tkSeen.add(pos.ticker);tkMap[pos.ticker]=[];}tkMap[pos.ticker].push(pos);}
    tkOrd.sort();
    const tickers=tkOrd.map(ticker=>{
      const tPos=tkMap[ticker];tPos.sort((a,b)=>a.strike-b.strike);
      const strikes=tPos.map(pos=>{
        const key=`${pos.ticker}|${ek}|${pos.strike}|${pos.optType}`;
        const lots=lotMap[key]||[];
        const portfolioLots=!lots.length && pos.avgCost>0 ? [{
          date:null, quantity:Math.abs(pos.contracts), price:pos.avgCost,
          dte:Math.max(0,Math.round((pos.expiry-new Date())/864e5)),
          premPct:pos.strike?Math.round(pos.avgCost/pos.strike*1000)/10:0,
          fromPortfolio:true,
        }] : lots;
        return{
          strike:pos.strike, optType:pos.optType, contracts:pos.contracts,
          expiry:pos.expiry, avgCost:pos.avgCost||0,
          status:pos.status, severity:pos.severity,
          lots:portfolioLots, lotsSource: lots.length ? "history" : (pos.avgCost>0 ? "portfolio" : "none"),
        };
      });
      const fk=`${ticker}|${ek}|${tPos[0].strike}|${tPos[0].optType}`;
      const md = marketData?.[ticker] || {};
      return{ticker,price:tPos[0].price,iv:ivData[ticker]??null,
        ivRank:md.iv_rank??null, ivPct:md.iv_pct??null, hv20:md.hv20??null, ivHvRatio:md.iv_hv_ratio??null,
        strategy:stratMap[fk]||null,strikes,posType:"option"};
    });
    return{expiry,label:expiryLabel(expiry),tickers};
  });

  // Add equity group if there are share positions
  if (equityPositions.length > 0) {
    const eqTkOrd = []; const eqTkSeen = new Set(); const eqTkMap = {};
    for (const pos of equityPositions) {
      if (!eqTkSeen.has(pos.ticker)) { eqTkOrd.push(pos.ticker); eqTkSeen.add(pos.ticker); eqTkMap[pos.ticker] = []; }
      eqTkMap[pos.ticker].push(pos);
    }
    eqTkOrd.sort();
    const eqTickers = eqTkOrd.map(ticker => {
      const tPos = eqTkMap[ticker];
      const totalShares = tPos.reduce((s, p) => s + (p.shares || p.contracts || 0), 0);
      const md = marketData?.[ticker] || {};
      const stratKey = `${ticker}|equity|${totalShares}`;
      return {
        ticker, price: tPos[0].price, iv: ivData[ticker] ?? null,
        ivRank: md.iv_rank ?? null, ivPct: md.iv_pct ?? null, hv20: md.hv20 ?? null, ivHvRatio: md.iv_hv_ratio ?? null,
        strategy: stratMap[stratKey] || (totalShares > 0 ? "Long Shares" : "Short Shares"),
        posType: "equity",
        strikes: [{
          strike: null, optType: null, contracts: totalShares,
          status: tPos[0].status, severity: tPos[0].severity,
          avgCost: tPos[0].avgCost, adjCost: tPos[0].adjCost || null,
          totalPremium: tPos[0].totalPremium || 0,
          costBasisComputed: tPos[0].costBasisComputed || false,
          shares: totalShares, lots: []
        }]
      };
    });
    // Insert equity group at the beginning
    groups.unshift({ expiry: null, label: "Shares", tickers: eqTickers });
  }

  const allTk=new Set(positions.map(p=>p.ticker));
  const allStrat=new Set();for(const g of groups)for(const t of g.tickers)if(t.strategy)allStrat.add(`${t.ticker}|${t.strategy}`);
  return{groups,totalPositions:positions.length,totalExpiries:groups.length,uniqueTickers:allTk.size,uniqueStrategies:allStrat.size};
}

