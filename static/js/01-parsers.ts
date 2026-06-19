export function parseCSVLine(line) {
  const r = []; let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) { const c = line[i]; if (c === '"') inQ = !inQ; else if (c === "," && !inQ) { r.push(cur); cur = ""; } else cur += c; }
  r.push(cur); return r;
}
export function parseMoney(s) { return s ? parseFloat(s.replace(/[$,\s]/g, "")) || 0 : 0; }

export const OCC_RE = /^-?\s*([A-Z]+)(\d{6})([CP])(\d+(?:\.\d+)?)$/i;
export function parseOCC(sym) {
  const m = sym.trim().replace(/^[\s-]+/, "").match(OCC_RE);
  if (!m) return null;
  const ds = m[2];
  const raw = m[4];
  let strike;
  if (raw.includes(".")) strike = parseFloat(raw);            // literal decimal strike (broker CSV)
  else if (raw.length > 6) strike = parseFloat(raw) / 1000;   // standard padded 8-digit OCC strike
  else strike = parseFloat(raw);
  return { ticker: m[1].toUpperCase(), expiry: new Date(2000+parseInt(ds.slice(0,2)), parseInt(ds.slice(2,4))-1, parseInt(ds.slice(4,6))), optType: m[3].toUpperCase()==="P"?"Put":"Call", strike: strike };
}

export function findCsvHeaderRow(lines, required) {
  for (let i = 0; i < Math.min(lines.length, 20); i++) {
    const lo = (lines[i] || "").toLowerCase();
    if (!lo.includes(",")) continue;
    if (required.every(k => lo.includes(k))) return i;
  }
  return -1;
}

export function headerColIndex(headers, ...names) {
  for (const name of names) {
    const n = name.toLowerCase();
    const idx = headers.findIndex(h => h === n || h.includes(n));
    if (idx >= 0) return idx;
  }
  return -1;
}

export function parseOptionFromSchwab(sym, desc) {
  const normSym = (sym || "").replace(/\s+/g, "");
  let p = parseOCC(normSym);
  if (p) return p;
  // Schwab native symbol format: "TICKER MM/DD/YYYY STRIKE P/C" (e.g. "OVID 06/18/2026 2.50 P")
  const sm = (sym || "").trim().match(/^([A-Za-z.]+)\s+(\d{2})\/(\d{2})\/(\d{4})\s+([\d.]+)\s+([PC])$/i);
  if (sm) {
    return {
      ticker: sm[1].toUpperCase(),
      expiry: new Date(parseInt(sm[4]), parseInt(sm[2]) - 1, parseInt(sm[3])),
      optType: sm[6].toUpperCase() === "P" ? "Put" : "Call",
      strike: parseFloat(sm[5]),
    };
  }
  const m = (desc || "").match(/(PUT|CALL|P|C)\s+([A-Z]+)\s+(\d{2})\/(\d{2})\/(\d{4})\s+([\d.]+)/i);
  if (m) {
    const ot = /^p/i.test(m[1]) ? "Put" : "Call";
    return { ticker: m[2], expiry: new Date(parseInt(m[5]), parseInt(m[3]) - 1, parseInt(m[4])), optType: ot, strike: parseFloat(m[6]) };
  }
  return null;
}

export function parseOptionFromIBKR(sym, desc, expiryStr, strikeStr, rightStr) {
  if (sym) {
    const norm = sym.replace(/\s+/g, "");
    const p = parseOCC(norm);
    if (p) return p;
  }
  if (expiryStr && strikeStr && rightStr) {
    let exp = null;
    const d = (expiryStr || "").trim();
    if (/^\d{8}$/.test(d)) exp = new Date(parseInt(d.slice(0, 4)), parseInt(d.slice(4, 6)) - 1, parseInt(d.slice(6, 8)));
    else if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      const pts = d.split("-");
      exp = new Date(parseInt(pts[0]), parseInt(pts[1]) - 1, parseInt(pts[2]));
    }
    const ot = /^p/i.test(rightStr) ? "Put" : "Call";
    if (exp) return { ticker: (sym || "").split(" ")[0].toUpperCase(), expiry: exp, optType: ot, strike: parseFloat(strikeStr) };
  }
  const m = (desc || "").match(/([A-Z]{1,6})\s+([A-Z]{3}\d{2}'?\d{2})\s+([\d.]+)\s+([PC])/i);
  if (m) {
    const mo = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
    const mp = m[2].replace("'", "").match(/^([A-Z]{3})(\d{2})(\d{2})$/);
    if (mp) {
      const yr = 2000 + parseInt(mp[3]);
      return { ticker: m[1], expiry: new Date(yr, mo[mp[1]], 1), optType: m[4].toUpperCase() === "P" ? "Put" : "Call", strike: parseFloat(m[3]) };
    }
  }
  return null;
}

export function detectFormat(text) {
  const lines = text.replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n");
  for (const line of lines.slice(0, 12)) {
    const lo = (line || "").toLowerCase();
    if (lo.includes("account number") || lo.includes("average cost basis")) return "fidelity_raw";
    if (lo.includes("expiry") && lo.includes("ticker")) return "preprocessed";
    if (lo.includes("conid") && lo.includes("symbol")) return "ibkr_positions";
    if (lo.includes("sectype") && lo.includes("symbol")) return "ibkr_positions";
    if (lo.includes("symbol") && (lo.includes("market value") || lo.includes("quantity") || lo.includes("cost basis"))) return "schwab_positions";
  }
  return "unknown";
}

export function detectHistoryFormat(text) {
  const lines = text.replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n");
  for (const line of lines.slice(0, 15)) {
    const lo = (line || "").toLowerCase();
    if (lo.includes("run date") && lo.includes("action")) return "fidelity";
    if (lo.includes("tradedate") && lo.includes("symbol") && (lo.includes("code") || lo.includes("buy/sell"))) return "ibkr";
    if (lo.includes("date/time") && lo.includes("symbol") && (lo.includes("code") || lo.includes("quantity"))) return "ibkr";
    if (lo.includes("asset category") && lo.includes("symbol") && lo.includes("quantity")) return "ibkr";
    if (lo.includes("date") && lo.includes("action") && lo.includes("fees") && !lo.includes("run date")) return "schwab";
  }
  return "unknown";
}

export function ibkrExpiryToYymmdd(expiryStr) {
  const d = (expiryStr || "").trim().split(" ")[0].replace(/\//g, "-");
  if (/^\d{8}$/.test(d)) return d.slice(2);
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1].slice(2)}${m[2]}${m[3]}` : null;
}

export function ibkrBuildOccKey(sym, desc, expiry, strike, right) {
  const norm = (sym || "").replace(/\s+/g, "").toLowerCase();
  const occNorm = norm.startsWith("-") ? norm : (/\d{6}[pc]\d/i.test(norm) ? `-${norm}` : norm);
  if (parseOCC(occNorm)) return occNorm.replace(/^-/, "");
  let ticker = (sym || "").split(/\s+/)[0].replace(/[^A-Z0-9.]/gi, "").toUpperCase();
  let yymmdd = ibkrExpiryToYymmdd(expiry);
  let strikeVal = strike;
  let rightVal = right;
  const dm = (desc || "").match(/([A-Z]{1,6})\s+([A-Z]{3}\d{2}'?\d{2})\s+([\d.]+)\s+([PC])/i);
  if (dm) {
    const mo = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
    const mp = dm[2].replace("'", "").toUpperCase().match(/^([A-Z]{3})(\d{2})(\d{2})$/);
    if (mp) {
      ticker = dm[1];
      yymmdd = `${mp[3]}${mo[mp[1]] || "01"}${mp[2]}`;
      strikeVal = dm[3];
      rightVal = dm[4];
    }
  }
  if (!ticker || !yymmdd || strikeVal == null || !rightVal) return null;
  const pc = String(rightVal).toLowerCase().startsWith("p") ? "p" : "c";
  const strikeRaw = Math.round(parseFloat(strikeVal) * 1000);
  return `${ticker.toLowerCase()}${yymmdd}${pc}${String(strikeRaw).padStart(8, "0")}`;
}

export function ibkrCodeIsOpen(code) {
  const c = (code || "").toUpperCase();
  const parts = c.split(/[;,|/]/);
  return parts.some(p => p === "O" || p.startsWith("OPEN")) || c === "O";
}

export function ibkrCodeIsClose(code) {
  const c = (code || "").toUpperCase();
  if (ibkrCodeIsOpen(c) && !c.includes("C")) return false;
  const parts = c.split(/[;,|/]/);
  return parts.some(p => p === "C" || p.startsWith("CLOSE") || p.startsWith("EP") || p === "A" || p.startsWith("EX"))
    || /EXPIR|ASSIGN/.test(c);
}

export function parseIBKRHistoryRow(r, headers) {
  const dateIdx = headerColIndex(headers, "tradedate", "date/time", "date", "trade date");
  const symIdx = headerColIndex(headers, "symbol");
  const qtyIdx = headerColIndex(headers, "quantity", "qty");
  const priceIdx = headerColIndex(headers, "t. price", "tradeprice", "trade price", "price");
  const codeIdx = headerColIndex(headers, "code");
  const sideIdx = headerColIndex(headers, "buy/sell", "buy/sell indicator");
  const secIdx = headerColIndex(headers, "asset category", "sectype", "assetclass");
  const expIdx = headerColIndex(headers, "expiry", "expiration", "exp");
  const strikeIdx = headerColIndex(headers, "strike");
  const rightIdx = headerColIndex(headers, "put/call", "right");
  const descIdx = headerColIndex(headers, "description", "financial instrument");
  if (dateIdx < 0 || symIdx < 0 || qtyIdx < 0) return null;
  const symRaw = (r[symIdx] || "").trim();
  if (!symRaw || symRaw.toLowerCase() === "total" || symRaw.startsWith("---")) return null;
  const ds = (r[dateIdx] || "").trim();
  if (!ds || !/\d/.test(ds)) return null;
  const code = codeIdx >= 0 ? (r[codeIdx] || "").toUpperCase() : "";
  const side = sideIdx >= 0 ? (r[sideIdx] || "").toUpperCase() : "";
  if (!ibkrCodeIsOpen(code) && !/OPEN/.test(side)) return null;
  const sec = secIdx >= 0 ? (r[secIdx] || "").trim().toUpperCase() : "";
  const desc = descIdx >= 0 ? (r[descIdx] || "").trim() : symRaw;
  const expiry = expIdx >= 0 ? r[expIdx] : "";
  const strike = strikeIdx >= 0 ? r[strikeIdx] : "";
  const right = rightIdx >= 0 ? r[rightIdx] : "";
  const p = parseOCC(symRaw.replace(/\s+/g, ""))
    || parseOptionFromIBKR(symRaw, desc, expiry, strike, right)
    || parseOptionFromSchwab(symRaw, desc);
  if (!p && sec !== "OPT" && sec !== "OPTION") return null;
  if (!p) return null;
  let dt;
  const dsMain = ds.split(";")[0].split(" ")[0];
  if (/^\d{8}$/.test(dsMain)) dt = new Date(parseInt(dsMain.slice(0, 4)), parseInt(dsMain.slice(4, 6)) - 1, parseInt(dsMain.slice(6, 8)));
  else if (/^\d{4}-\d{2}-\d{2}/.test(dsMain)) {
    const pts = dsMain.split("-");
    dt = new Date(parseInt(pts[0]), parseInt(pts[1]) - 1, parseInt(pts[2]));
  } else {
    const dp = dsMain.split(/[\/\-]/);
    dt = new Date(parseInt(dp[2] || dp[0]), parseInt(dp[0]) - 1, parseInt(dp[1]));
  }
  const qtySigned = Math.trunc(parseFloat((r[qtyIdx] || "0").replace(/,/g, ""))) || 0;
  const qty = Math.abs(qtySigned);
  const price = priceIdx >= 0 ? parseMoney(r[priceIdx]) : 0;
  return { date: dt, ticker: p.ticker, expiry: p.expiry, strike: p.strike, optType: p.optType, quantity: qty, price };
}

export function parseSchwabPositions(text) {
  const lines = text.replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n");
  const hdrIdx = findCsvHeaderRow(lines, ["symbol", "quantity"]);
  if (hdrIdx < 0) return [];
  const headers = parseCSVLine(lines[hdrIdx]).map(h => h.trim().toLowerCase().replace(/"/g, ""));
  const symIdx = headerColIndex(headers, "symbol");
  const qtyIdx = headerColIndex(headers, "quantity");
  const descIdx = headerColIndex(headers, "description");
  const priceIdx = headerColIndex(headers, "price");
  const costIdx = headerColIndex(headers, "cost basis");
  const pos = [];
  for (let i = hdrIdx + 1; i < lines.length; i++) {
    const r = parseCSVLine(lines[i]);
    if (r.length <= Math.max(symIdx, qtyIdx)) continue;
    const sym = (r[symIdx] || "").trim();
    if (!sym || sym.toLowerCase().includes("cash") || sym.toLowerCase().includes("total")) continue;
    const qty = Math.trunc(parseFloat((r[qtyIdx] || "0").replace(/,/g, ""))) || 0;
    if (!qty) continue;
    const desc = descIdx >= 0 ? (r[descIdx] || "").trim() : "";
    const p = parseOptionFromSchwab(sym, desc);
    const lastPrice = priceIdx >= 0 ? parseMoney(r[priceIdx]) : 0;
    const costBasis = costIdx >= 0 ? parseMoney(r[costIdx]) : 0;
    if (p) {
      pos.push({ posType: "option", ticker: p.ticker, expiry: p.expiry, strike: p.strike, optType: p.optType, contracts: qty, price: 0, avgCost: costBasis ? Math.abs(costBasis / (qty * 100)) : 0, status: "—", severity: "ok" });
    } else {
      const ticker = sym.replace(/[*\s]/g, "").toUpperCase();
      if (!ticker || /\d{6}/.test(ticker)) continue;
      pos.push({ posType: "equity", ticker, expiry: null, strike: null, optType: null, contracts: qty, shares: qty, price: lastPrice, avgCost: costBasis ? Math.abs(costBasis / qty) : 0, costBasisTotal: costBasis, status: "—", severity: "ok" });
    }
  }
  return pos;
}

export function parseIBKRPositions(text) {
  const lines = text.replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n");
  const hdrIdx = findCsvHeaderRow(lines, ["symbol", "quantity"]);
  if (hdrIdx < 0) return [];
  const headers = parseCSVLine(lines[hdrIdx]).map(h => h.trim().toLowerCase().replace(/"/g, ""));
  const symIdx = headerColIndex(headers, "symbol");
  const qtyIdx = headerColIndex(headers, "quantity");
  const secIdx = headerColIndex(headers, "sectype", "asset category");
  const expIdx = headerColIndex(headers, "expiry", "expiration");
  const strikeIdx = headerColIndex(headers, "strike");
  const rightIdx = headerColIndex(headers, "put/call", "right");
  const descIdx = headerColIndex(headers, "description", "financial instrument");
  const markIdx = headerColIndex(headers, "mark price", "mark");
  const costIdx = headerColIndex(headers, "cost basis price", "cost basis", "avg cost");
  const pos = [];
  for (let i = hdrIdx + 1; i < lines.length; i++) {
    const r = parseCSVLine(lines[i]);
    if (r.length <= Math.max(symIdx, qtyIdx)) continue;
    const sym = (r[symIdx] || "").trim();
    if (!sym || sym.toLowerCase() === "total" || sym.startsWith("---")) continue;
    const qty = Math.trunc(parseFloat((r[qtyIdx] || "0").replace(/,/g, ""))) || 0;
    if (!qty) continue;
    const sec = secIdx >= 0 ? (r[secIdx] || "").trim().toUpperCase() : "";
    const desc = descIdx >= 0 ? (r[descIdx] || "").trim() : sym;
    const mark = markIdx >= 0 ? parseMoney(r[markIdx]) : 0;
    const cost = costIdx >= 0 ? parseMoney(r[costIdx]) : 0;
    const isOpt = sec === "OPT" || sec === "OPTION" || /[PC]\d/.test(sym.replace(/\s/g, ""));
    if (isOpt) {
      const p = parseOptionFromIBKR(sym, desc, expIdx >= 0 ? r[expIdx] : "", strikeIdx >= 0 ? r[strikeIdx] : "", rightIdx >= 0 ? r[rightIdx] : "");
      if (!p) continue;
      pos.push({ posType: "option", ticker: p.ticker, expiry: p.expiry, strike: p.strike, optType: p.optType, contracts: qty, price: 0, avgCost: cost || 0, status: "—", severity: "ok" });
    } else {
      const ticker = sym.split(" ")[0].replace(/[^A-Z0-9.]/gi, "").toUpperCase();
      if (!ticker) continue;
      pos.push({ posType: "equity", ticker, expiry: null, strike: null, optType: null, contracts: qty, shares: qty, price: mark, avgCost: cost || 0, costBasisTotal: cost * qty, status: "—", severity: "ok" });
    }
  }
  return pos;
}

export function parseFidelityRaw(text) {
  const lines = text.replace(/^\uFEFF/,"").replace(/\r/g,"").split("\n"), pos = [];
  for (let i=1;i<lines.length;i++) {
    const r=parseCSVLine(lines[i]); if(r.length<=2) continue;
    const sym=(r[2]||"").trim();
    if(!sym||sym.includes("MONEY MARKET")||sym.includes("Pending")||sym.toLowerCase().includes("account")) continue;
    const qty=Math.trunc(parseFloat(r[4]||"0"))||0; if(!qty) continue;
    const acb=parseFloat((r[14]||"").replace(/[$,]/g,""))||0;
    const lastPrice=parseFloat((r[5]||"").replace(/[+$,]/g,""))||0;
    const p=parseOCC(sym);
    if(p) {
      pos.push({posType:"option",ticker:p.ticker,expiry:p.expiry,strike:p.strike,optType:p.optType,contracts:qty,price:0,avgCost:acb,status:"\u2014",severity:"ok"});
    } else {
      // Equity position (shares)
      const ticker = sym.replace(/[*\s]/g,"").toUpperCase();
      if (!ticker || /\d{6}/.test(ticker)) continue;
      const costBasisTotal = parseFloat((r[13]||"").replace(/[$,]/g,""))||0;
      pos.push({posType:"equity",ticker:ticker,expiry:null,strike:null,optType:null,contracts:qty,shares:qty,price:lastPrice,avgCost:acb,costBasisTotal:costBasisTotal,status:"\u2014",severity:"ok"});
    }
  }
  return pos;
}

export function parsePreprocessed(text) {
  const lines=text.replace(/^\uFEFF/,"").replace(/\r/g,"").split("\n"), pos=[]; let curExp="",hdr=false;
  const MO={Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
  for(const line of lines){const r=parseCSVLine(line);if(r.length<11)continue;
    if(!hdr){if(r[0]?.toLowerCase().includes("expiry")||r[1]?.toLowerCase().includes("ticker")){hdr=true;continue;}continue;}
    if(r[0]?.trim())curExp=r[0].trim();const tk=r[1]?.trim();if(!tk||tk==="FZFXX")continue;
    const cts=parseInt((r[2]?.trim().replace(/[\u2018\u2019']/g,"")||"0"),10)||0;
    const pts=curExp.trim().split(" ");if(pts.length<2)continue;const mo=MO[pts[0]];if(mo===undefined)continue;
    const dy=pts[1].split("/"),day=parseInt(dy[0]),yr=dy.length===2?2000+parseInt(dy[1]):2026;
    pos.push({ticker:tk,expiry:new Date(yr,mo,day),strike:parseMoney(r[6]),optType:r[3]?.trim(),contracts:cts,price:parseMoney(r[9]),avgCost:parseMoney(r[7]),status:"—",severity:"ok"});
  }
  return pos;
}

export function parseFidelityHistory(text) {
  const lines=text.replace(/^\uFEFF/,"").replace(/\r/g,"").split("\n"), fills=[];
  for(const line of lines){const r=parseCSVLine(line);if(r.length<8)continue;
    const ds=r[0]?.trim();if(!ds||!/^\d/.test(ds))continue;
    if(!(r[1]?.trim()||"").includes("OPENING TRANSACTION"))continue;
    const p=parseOCC(r[2]?.trim()||"");if(!p)continue;const dp=ds.split("/");
    fills.push({date:new Date(parseInt(dp[2]),parseInt(dp[0])-1,parseInt(dp[1])),ticker:p.ticker,expiry:p.expiry,strike:p.strike,optType:p.optType,quantity:Math.abs(Math.trunc(parseFloat(r[6])))||0,price:parseFloat(r[5])||0});
  }
  return fills;
}

export function parseSchwabHistory(text) {
  // Schwab format: Date,Action,Symbol,Description,Quantity,Price,Fees & Comm,Amount
  // Options appear as "Sell to Open" or "Buy to Open" in Action
  // Symbol might be like "CCCC  260515P00003000" (OCC format with spaces/padding) or plain ticker
  const lines=text.replace(/^\uFEFF/,"").replace(/\r/g,"").split("\n"), fills=[];
  for(const line of lines){
    const r=parseCSVLine(line);if(r.length<6)continue;
    const ds=r[0]?.trim();if(!ds||!/^\d/.test(ds))continue;
    const action=(r[1]||"").trim().toLowerCase();
    if(!action.includes("sell to open")&&!action.includes("buy to open"))continue;
    // Try to parse OCC symbol from Description or Symbol
    const sym=(r[2]||"").trim();
    const desc=(r[3]||"").trim();
    // Schwab uses space-padded OCC: "CCCC  260515P00003000" → normalize
    let p = parseOptionFromSchwab(sym, desc);
    if(!p)continue;
    const dp=ds.split("/");
    const price=parseFloat((r[5]||"").replace(/[$,]/g,""))||0;
    const qty=Math.abs(Math.trunc(parseFloat(r[4]||"0")))||0;
    fills.push({date:new Date(parseInt(dp[2]),parseInt(dp[0])-1,parseInt(dp[1])),ticker:p.ticker,expiry:p.expiry,strike:p.strike,optType:p.optType,quantity:qty,price:price});
  }
  return fills;
}

export function parseIBKRHistory(text) {
  const lines = text.replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n");
  const hdrIdx = findCsvHeaderRow(lines, ["symbol", "quantity"]);
  if (hdrIdx < 0) return [];
  const headers = parseCSVLine(lines[hdrIdx]).map(h => h.trim().toLowerCase().replace(/"/g, ""));
  const fills = [];
  for (let i = hdrIdx + 1; i < lines.length; i++) {
    const r = parseCSVLine(lines[i]);
    const row = parseIBKRHistoryRow(r, headers);
    if (row) fills.push(row);
  }
  return fills;
}

export function parseHistory(text) {
  const fmt = detectHistoryFormat(text);
  if (fmt === "schwab") return parseSchwabHistory(text);
  if (fmt === "ibkr") return parseIBKRHistory(text);
  if (fmt === "fidelity") return parseFidelityHistory(text);
  const fid = parseFidelityHistory(text);
  if (fid.length) return fid;
  const sch = parseSchwabHistory(text);
  if (sch.length) return sch;
  return parseIBKRHistory(text);
}

export function parsePositions(text) {
  const fmt = detectFormat(text);
  if (fmt === "fidelity_raw") return { positions: parseFidelityRaw(text), format: "fidelity_raw" };
  if (fmt === "preprocessed") return { positions: parsePreprocessed(text), format: "preprocessed" };
  if (fmt === "schwab_positions") return { positions: parseSchwabPositions(text), format: "schwab_positions" };
  if (fmt === "ibkr_positions") return { positions: parseIBKRPositions(text), format: "ibkr_positions" };
  const attempts = [
    ["fidelity_raw", parseFidelityRaw(text)],
    ["schwab_positions", parseSchwabPositions(text)],
    ["ibkr_positions", parseIBKRPositions(text)],
    ["preprocessed", parsePreprocessed(text)],
  ];
  for (const [name, positions] of attempts) {
    if (positions.length) return { positions, format: name };
  }
  return { positions: [], format: fmt, hint: formatParseHint(fmt) };
}

export function formatParseHint(format, broker?) {
  const hints = {
    fidelity_raw: "Expected Fidelity Positions CSV (Account Number / Average Cost Basis header).",
    preprocessed: "Expected preprocessed CSV with Expiry + Ticker columns.",
    schwab_positions: "Expected Schwab Positions export (Symbol + Quantity + Market Value header).",
    ibkr_positions: "Expected IBKR Flex Open Positions or Activity Statement (Symbol + Quantity + SecType or Conid).",
    unknown: "Could not detect CSV format from the header row.",
  };
  const b = broker ? ` Broker selected: ${broker.toUpperCase()}.` : "";
  return (hints[format] || hints.unknown) + b;
}

export function occKeyFromOption(p) {
  // Canonical key matching filterClosedPositions: -tickeryymmdd{p|c}strike
  const exp = p.expiry;
  const yy = String(exp.getFullYear()).slice(2).padStart(2, "0");
  const mm = String(exp.getMonth() + 1).padStart(2, "0");
  const dd = String(exp.getDate()).padStart(2, "0");
  const pc = p.optType === "Put" ? "p" : "c";
  const strike = String(p.strike); // minimal form (130→"130", 2.5→"2.5"); matches broker OCC symbols
  return `-${p.ticker.toLowerCase()}${yy}${mm}${dd}${pc}${strike}`;
}

export function buildHistoryNetQty(histText) {
  const netQty = {};
  if (!histText?.trim()) return netQty;
  const fmt = detectHistoryFormat(histText);
  const lines = histText.replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n");

  if (fmt === "schwab") {
    for (const line of lines) {
      const r = parseCSVLine(line);
      if (r.length < 6) continue;
      const ds = r[0]?.trim();
      if (!ds || !/^\d/.test(ds)) continue;
      const action = (r[1] || "").trim().toLowerCase();
      const p = parseOptionFromSchwab((r[2] || "").trim(), (r[3] || "").trim());
      if (!p) continue; // only options matter for the closed-position filter
      const key = occKeyFromOption(p);
      const qty = Math.abs(Math.trunc(parseFloat(r[4] || "0"))) || 0;
      if (!key || !qty) continue;
      if (action.includes("to open")) netQty[key] = (netQty[key] || 0) + qty;
      else if (action.includes("to close") || action.includes("expired") || action.includes("assigned")) netQty[key] = (netQty[key] || 0) - qty;
    }
    return netQty;
  }

  if (fmt === "ibkr") {
    const hdrIdx = findCsvHeaderRow(lines, ["symbol", "quantity"]);
    if (hdrIdx < 0) return netQty;
    const headers = parseCSVLine(lines[hdrIdx]).map(h => h.trim().toLowerCase());
    const symIdx = headerColIndex(headers, "symbol");
    const qtyIdx = headerColIndex(headers, "quantity", "qty");
    const codeIdx = headerColIndex(headers, "code");
    const descIdx = headerColIndex(headers, "description", "financial instrument");
    const expIdx = headerColIndex(headers, "expiry", "expiration");
    const strikeIdx = headerColIndex(headers, "strike");
    const rightIdx = headerColIndex(headers, "put/call", "right");
    for (let i = hdrIdx + 1; i < lines.length; i++) {
      const r = parseCSVLine(lines[i]);
      if (r.length <= symIdx) continue;
      const symRaw = (r[symIdx] || "").trim();
      const desc = descIdx >= 0 ? (r[descIdx] || "").trim() : symRaw;
      const occKey = ibkrBuildOccKey(symRaw, desc, expIdx >= 0 ? r[expIdx] : "", strikeIdx >= 0 ? r[strikeIdx] : "", rightIdx >= 0 ? r[rightIdx] : "")
        || symRaw.toLowerCase().replace(/\s+/g, "");
      const qty = Math.abs(Math.trunc(parseFloat((r[qtyIdx] || "0").replace(/,/g, "")))) || 0;
      const code = codeIdx >= 0 ? (r[codeIdx] || "").toUpperCase() : "";
      if (!occKey || !qty) continue;
      if (ibkrCodeIsOpen(code)) netQty[occKey] = (netQty[occKey] || 0) + qty;
      else if (ibkrCodeIsClose(code)) netQty[occKey] = (netQty[occKey] || 0) - qty;
    }
    return netQty;
  }

  for (const line of lines) {
    const r = parseCSVLine(line);
    if (r.length < 7) continue;
    const ds = r[0]?.trim();
    if (!ds || !/^\d/.test(ds)) continue;
    const action = (r[1] || "").trim().toUpperCase();
    const sym = (r[2] || "").trim().toLowerCase().replace(/\s+/g, "");
    const qty = Math.abs(Math.trunc(parseFloat(r[6] || "0"))) || 0;
    if (!sym || !qty) continue;
    if (action.includes("OPENING TRANSACTION")) netQty[sym] = (netQty[sym] || 0) + qty;
    else if (action.includes("CLOSING TRANSACTION") || action.includes("ASSIGNED") || action.includes("EXPIRED") || action.includes("EXERCISED")) netQty[sym] = (netQty[sym] || 0) - qty;
  }
  return netQty;
}

export function filterClosedPositions(positions, histText) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // A short/long option is a live exposure until the broker actually settles it
  // (assignment or OTM expiration), which posts a few days after expiry — typically
  // over the weekend following a Friday expiry. So we DON'T drop options the moment
  // they pass their expiry date; the transaction-history filter below removes them
  // once Schwab reports the close/assignment/expiration. This grace is only a cleanup
  // floor for very old options imported without a confirming history.
  const SETTLE_GRACE_DAYS = 7;
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - SETTLE_GRACE_DAYS);

  const unexpired = positions.filter(pos => {
    if (pos.posType === "equity" || !pos.expiry) return true;
    return pos.expiry >= cutoff;
  });

  // `histText` may be an array of per-broker history files (preferred) or a single
  // string. Each file is parsed by its own format, then net qty is merged across them
  // so a contract opened at one broker and closed at another resolves correctly.
  const texts = Array.isArray(histText) ? histText : (histText ? [histText] : []);
  if (!texts.some(t => t && t.trim())) return unexpired;

  const netQty = {};
  for (const t of texts) {
    const nq = buildHistoryNetQty(t);
    for (const k in nq) netQty[k] = (netQty[k] || 0) + nq[k];
  }

  return unexpired.filter(pos => {
    if (pos.posType === "equity" || !pos.expiry || !pos.optType) return true;
    const exp = pos.expiry;
    const yy = String(exp.getFullYear()).slice(2).padStart(2, "0");
    const mm = String(exp.getMonth() + 1).padStart(2, "0");
    const dd = String(exp.getDate()).padStart(2, "0");
    const pc = pos.optType === "Put" ? "p" : "c";
    const strike = String(pos.strike); // minimal form; matches both Fidelity OCC and Schwab→OCC keys
    const occKey = `-${pos.ticker.toLowerCase()}${yy}${mm}${dd}${pc}${strike}`;

    const net = netQty[occKey];
    if (net === undefined) return true; // not in history → keep
    if (net <= 0) return false; // fully closed → remove
    return true;
  });
}

