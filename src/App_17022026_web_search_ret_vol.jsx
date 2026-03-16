import React, { useState, useCallback, useMemo, useRef } from "react";
import {
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
} from "recharts";

/* ═══════════════════════════════════════════════════════════════════════════
   TICKER NAME MAP — helps API disambiguate tickers with common abbreviations
   ═══════════════════════════════════════════════════════════════════════════ */

const TICKER_NAMES = {
  TTD: "The Trade Desk",
  META: "Meta Platforms",
  GOOGL: "Alphabet Class A",
  GOOG: "Alphabet Class C",
  AMZN: "Amazon",
  TSLA: "Tesla",
  NVDA: "NVIDIA",
  AAPL: "Apple",
  MSFT: "Microsoft",
  CRM: "Salesforce",
  NFLX: "Netflix",
  AMD: "Advanced Micro Devices",
  INTC: "Intel",
  AVGO: "Broadcom",
  QCOM: "Qualcomm",
  ADBE: "Adobe",
  PLTR: "Palantir",
  SNOW: "Snowflake",
  CRWD: "CrowdStrike",
  PANW: "Palo Alto Networks",
  NET: "Cloudflare",
  DDOG: "Datadog",
  SQ: "Block Inc (Square)",
  SHOP: "Shopify",
  COIN: "Coinbase",
  UBER: "Uber Technologies",
  ABNB: "Airbnb",
  DASH: "DoorDash",
  SNAP: "Snap Inc",
  PINS: "Pinterest",
  RBLX: "Roblox",
  APP: "AppLovin",
  ARM: "Arm Holdings",
  SMCI: "Super Micro Computer",
  DELL: "Dell Technologies",
  ANET: "Arista Networks",
  NOW: "ServiceNow",
  ORCL: "Oracle",
  CSCO: "Cisco",
  WDAY: "Workday",
  ZM: "Zoom Video",
  BABA: "Alibaba",
  JD: "JD.com",
  PDD: "PDD Holdings (Pinduoduo)",
  SE: "Sea Limited",
  MELI: "MercadoLibre",
  JPM: "JPMorgan Chase",
  BAC: "Bank of America",
  GS: "Goldman Sachs",
  MS: "Morgan Stanley",
  V: "Visa",
  MA: "Mastercard",
  BLK: "BlackRock",
  BX: "Blackstone",
  KKR: "KKR & Co",
  JNJ: "Johnson & Johnson",
  UNH: "UnitedHealth",
  LLY: "Eli Lilly",
  PFE: "Pfizer",
  MRK: "Merck",
  ABBV: "AbbVie",
  TMO: "Thermo Fisher",
  MRNA: "Moderna",
  NVO: "Novo Nordisk",
  XOM: "Exxon Mobil",
  CVX: "Chevron",
  COP: "ConocoPhillips",
  SLB: "Schlumberger",
  BA: "Boeing",
  CAT: "Caterpillar",
  GE: "GE Aerospace",
  HON: "Honeywell",
  LMT: "Lockheed Martin",
  RTX: "RTX (Raytheon)",
  WMT: "Walmart",
  COST: "Costco",
  HD: "Home Depot",
  TGT: "Target",
  NKE: "Nike",
  SBUX: "Starbucks",
  MCD: "McDonald's",
  DIS: "Walt Disney",
  PG: "Procter & Gamble",
  KO: "Coca-Cola",
  PEP: "PepsiCo",
  T: "AT&T",
  VZ: "Verizon",
  TMUS: "T-Mobile US",
  NEE: "NextEra Energy",
  DUK: "Duke Energy",
  SO: "Southern Company",
  AMT: "American Tower REIT",
  PLD: "Prologis REIT",
  SPG: "Simon Property Group REIT",
  "BRK-B": "Berkshire Hathaway B",
  "BRK-A": "Berkshire Hathaway A",
};

/* ═══════════════════════════════════════════════════════════════════════════
   LIVE DATA FETCHING
   ═══════════════════════════════════════════════════════════════════════════ */

function extractJSON(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  let c = text.replace(/```(?:json)?\s*/gi, '').replace(/```\s*/g, '').trim();
  try { return JSON.parse(c); } catch {}
  let depth = 0, start = -1; const matches = [];
  for (let i = 0; i < c.length; i++) {
    if (c[i] === '{') { if (!depth) start = i; depth++; }
    else if (c[i] === '}') { depth--; if (!depth && start >= 0) { matches.push(c.slice(start, i + 1)); start = -1; } }
  }
  matches.sort((a, b) => b.length - a.length);
  for (const m of matches) { try { return JSON.parse(m); } catch {} }
  return null;
}

function validateTicker(d) {
  if (!d || typeof d !== 'object') return null;
  const o = { ...d };
  o.latestPrice = Number(o.latestPrice) || 0;
  o.targetPrice = Number(o.targetPrice) || 0;
  o.entryPrice = Number(o.entryPrice) || 0;
  o.analystCount = Number(o.analystCount) || 0;
  o.upside = Number(o.upside) || (o.latestPrice > 0 ? +((o.targetPrice / o.latestPrice - 1) * 100).toFixed(1) : 0);
  ['priceSource','priceDate','targetSource','targetDate','entrySource','entryDate',
   'rating','ratingSource','ratingDate','upsideSource','upsideDate',
   'reasoning','reasoningSource','reasoningDate','sentiment'].forEach(k => { o[k] = o[k] || 'N/A'; });
  o.catalysts = Array.isArray(o.catalysts) ? o.catalysts : ['Market'];
  return o;
}

function parseResponse(data, tickers) {
  const texts = (data.content || []).filter(b => b.type === 'text' && b.text).map(b => b.text);
  if (!texts.length) return null;
  for (let i = texts.length - 1; i >= 0; i--) {
    const parsed = extractJSON(texts[i]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const res = {};
      for (const t of tickers) {
        const key = Object.keys(parsed).find(k => k.toUpperCase() === t.toUpperCase());
        if (key && parsed[key]) { const v = validateTicker(parsed[key]); if (v) res[t] = v; }
      }
      if (Object.keys(res).length > 0) return res;
    }
  }
  const all = texts.join('\n');
  const parsed = extractJSON(all);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const res = {};
    for (const t of tickers) {
      const key = Object.keys(parsed).find(k => k.toUpperCase() === t.toUpperCase());
      if (key && parsed[key]) { const v = validateTicker(parsed[key]); if (v) res[t] = v; }
    }
    if (Object.keys(res).length > 0) return res;
  }
  return null;
}

function getApiUrl() {
  if (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
    return '/anthropic-proxy/v1/messages';
  }
  return 'https://api.anthropic.com/v1/messages';
}

/**
 * Build a ticker identification string for the API prompt.
 * Includes full company names where known to prevent misidentification
 * (e.g. TTD → "TTD (The Trade Desk)" so the API doesn't confuse it).
 */
function tickerListForPrompt(tickers) {
  return tickers.map(t => {
    const name = TICKER_NAMES[t] || TICKER_NAMES[t.replace(/\.[A-Z]{1,3}$/, '')];
    return name ? `${t} (${name})` : t;
  }).join(', ');
}

async function fetchAllTickers(tickers, apiKey, signal) {
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  }

  const tickerDesc = tickerListForPrompt(tickers);

  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 16000,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    system: 'You are a JSON API. Use web search to find CURRENT real-time stock prices and analyst data. After searching, output ONLY a raw JSON object. Never output markdown, backticks, or explanatory text. Your final text output must be a single valid JSON object starting with { and ending with }.',
    messages: [{
      role: 'user',
      content: `Today is ${today}. IMPORTANT: Use web search to look up the CURRENT live stock prices and analyst consensus data for each of these tickers: ${tickerDesc}

Search for each ticker to get the real current market price. Do NOT guess or use outdated prices. Pay special attention to getting the correct stock for each ticker symbol — use the company name in parentheses to confirm you have the right stock.

For EACH ticker provide ALL fields (use the ticker symbol as the JSON key, NOT the company name):
latestPrice (MUST be current price from web search), priceSource (where you found it), priceDate (today's date),
targetPrice (consensus 12-month analyst target from web search), targetSource, targetDate,
entryPrice (3-8% below current latestPrice), entrySource, entryDate,
rating (Strong Buy/Buy/Hold/Sell/Strong Sell from analyst consensus), ratingSource, ratingDate,
analystCount (number of analysts), upside (% from latestPrice to targetPrice), upsideSource, upsideDate,
reasoning (1-2 sentences on the bull/bear case), reasoningSource, reasoningDate,
sentiment (Very Bullish/Bullish/Neutral to Bullish/Neutral/Mixed/Bearish),
catalysts (array of 2-3 strings)

After searching, RESPOND WITH ONLY RAW JSON. No markdown. No backticks. No text before or after.
{"TICKER":{"latestPrice":100,...},...}`
    }]
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  if (signal) signal.addEventListener('abort', () => controller.abort());

  try {
    const res = await fetch(getApiUrl(), { method: 'POST', headers, signal: controller.signal, body: JSON.stringify(body) });
    clearTimeout(timeout);

    if (res.status === 429) {
      const retryAfter = res.headers.get('retry-after');
      const waitSec = retryAfter ? parseInt(retryAfter) : 65;
      throw { name: 'RateLimitError', waitSeconds: waitSec, message: `Rate limited. Wait ${waitSec}s.` };
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${errText.slice(0, 500)}`);
    }

    const data = await res.json();
    const result = parseResponse(data, tickers);
    if (!result) {
      const allTexts = (data.content || []).filter(b => b.type === 'text' && b.text).map(b => b.text);
      throw new Error(`JSON parse failed. ${allTexts.length} text blocks.`);
    }
    return result;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

function calcRiskReward(a) {
  if (!a) return null;
  const risk = a.latestPrice - a.entryPrice;
  const reward = a.targetPrice - a.entryPrice;
  if (risk === 0) return Infinity;
  return Math.abs(reward / risk);
}

/* ═══════════════════════════════════════════════════════════════════════════
   SECTOR GUESS
   ═══════════════════════════════════════════════════════════════════════════ */

function guessSector(t) {
  const base = t.replace(/\.[A-Z]{1,3}$/, '');
  const S = {
    Tech:['AAPL','MSFT','GOOGL','GOOG','META','NVDA','AMD','INTC','AVGO','QCOM','TXN','ADBE','CRM','ORCL','CSCO','NFLX','TSLA','NOW','PLTR','SNOW','DDOG','NET','CRWD','ZS','PANW','FTNT','OKTA','MDB','TEAM','WDAY','ZM','DOCU','SHOP','SQ','SNAP','PINS','TWLO','RBLX','U','UBER','LYFT','ABNB','DASH','COIN','HOOD','PATH','CFLT','GTLB','MNDY','S','HUBS','VEEV','BILL','PCOR','TTD','ZI','DKNG','APP','IOT','AI','SMCI','ARM','DELL','HPQ','HPE','ANET','GDDY','GEN','WIX','DBX','BOX','FIVN','CLSK','MARA','RIOT','BABA','JD','PDD','BIDU','NTES','TME','BILI','IQ','SE','GRAB','CPNG','GLOB','TOST','CWAN','SAMSN','SAP','ERIC','NOK','INFY','WIT','SONY','NTDOY','SPOT','SWI','RPD','ESTC','SPLK','NEWR','SUMO','DT','TENB','VRNS','SAIL','BSY','ANSS','CDNS','SNPS','KEYS','TYL','MANH','AZPN','PAYC','PAYX','ADP','INTU','FICO','FIS','FISV','GPN','FLT','WU','DXC','EPAM','CTSH','ACN','IT','LDOS','CACI','BAH','SAIC','KD','PSFE','AFRM','SOFI','UPST','MELI','ETSY','EBAY','CHWY','W','CARG','OPEN','RDFN','CVNA','CPRT','CRTO','YELP'],
    Semis:['NVDA','AMD','INTC','AVGO','QCOM','TXN','MU','AMAT','LRCX','KLAC','ASML','TSM','ADI','MRVL','NXPI','ON','SWKS','QRVO','WOLF','MPWR','MCHP','MTSI','ALGM','SMTC','RMBS','SLAB','ACLS','AMKR','CRUS','DIOD','ENTG','FORM','GFS','MKSI','ONTO','POWI','SITM','SYNA','TER','UCTT','VECO'],
    Finance:['JPM','BAC','WFC','GS','MS','C','BLK','SCHW','USB','PNC','TFC','AXP','V','MA','PYPL','SQ','COIN','BX','KKR','SPGI','MCO','BRK-B','BRK-A','ICE','CME','NDAQ','CBOE','MSCI','MKTX','FDS','VRSK','COF','DFS','SYF','AXS','ALL','PGR','TRV','CB','AIG','MET','PRU','AFL','CINF','GL','HIG','LNC','UNM','MMC','AON','WTW','AJG','BRO','RJF','TROW','BEN','IVZ','AMG','NTRS','STT','BK','FRC','SIVB','SBNY','CFG','FITB','KEY','HBAN','RF','ZION','CMA','ALLY','SOFI','LC','AFRM','UPST','HOOD','IBKR','LPLA','MARA','RIOT','MSTR','HDB','IBN','HSBC','UBS','CS','DB','BNPQY','BCS','NMR','MFG','KB','SHG','WF'],
    Health:['JNJ','UNH','PFE','ABT','TMO','MRK','DHR','LLY','ABBV','BMY','AMGN','GILD','CVS','CI','VRTX','REGN','ISRG','BIIB','ILMN','ZTS','ELV','HUM','CNC','MOH','HCA','EW','SYK','BSX','MDT','BDX','BAX','ZBH','HOLX','DXCM','ALGN','IDXX','IQV','CRL','A','MTD','WAT','TECH','TFX','RMD','PODD','INSP','NVCR','AXNX','RGEN','BIO','PKI','RVTY','MRNA','BNTX','NVAX','AZN','NVO','GSK','SNY','TAK','BAYRY','RHHBY','MRTX','SGEN','EXAS','GH','NTRA','VEEV','DOCS','HIMS','TDOC','GEHC','SOLV','LNTH','JAZZ','UTHR','ALNY','BMRN','RARE','IONS','SRPT','NBIX','ACAD','PCVX','VIR','DNLI','BPMC','RCKT','KRYS','LEGN','ARGX','IMVT'],
    Retail:['AMZN','WMT','HD','TGT','COST','LOW','NKE','SBUX','MCD','DIS','BKNG','MELI','EBAY','ETSY','ROST','TJX','BBY','DG','DLTR','FIVE','OLLI','BJ','KR','ACI','SFM','GO','WBA','ULTA','EL','LULU','GPS','ANF','URBN','AEO','RL','TPR','CPRI','DECK','CROX','ONON','BIRK','SKX','VFC','PVH','HBI','GIL','LVMUY','IDEXY','HESAY','CFRUY','ADDYY','PPRUY','KER','RMS','BURL','M','JWN','KSS','PSMT','ARCO','WFCF','CMG','DPZ','YUM','QSR','WEN','JACK','SHAK','WING','CAVA','SG','BROS','DUTCH','TXRH','DRI','DENN','CAKE','EAT','PLAY','WYNN','LVS','MGM','CZR','PENN','DKNG','ABNB','EXPE','MAR','HLT','H','WH','IHG','NCLH','RCL','CCL'],
    Energy:['XOM','CVX','COP','SLB','EOG','PXD','MPC','PSX','VLO','OXY','HAL','DVN','FANG','APA','CTRA','EQT','AR','RRC','SWN','MRO','OVV','CHRD','MTDR','PR','VNOM','TRGP','WMB','KMI','OKE','ET','EPD','MPLX','PAA','AM','DTM','CWEN','NEP','HESM','SHEL','BP','TTE','EQNR','ENB','TRP','SU','CNQ','CVE','IMO','MEG','BKR','FTI','CHX','WFRD','PTEN','HP','LBRT','PUMP','NOV','RIG','VAL','NE','DO','AROC','USAC','NEXT','RUN','NOVA','SEDG','ENPH','FSLR','CSIQ','JKS','SPWR','CWEN','PLUG','BLDP','FCEL','BE','CLNE','FLNC','STEM'],
    Industrials:['BA','CAT','GE','HON','UPS','RTX','LMT','DE','MMM','UNP','NSC','CSX','FDX','WM','EMR','GD','NOC','LHX','TDG','HWM','HEI','TXT','ERJ','ESLT','KTOS','MRCY','RKLB','LUNR','RDW','ASTS','SPCE','JOBY','ACHR','LILM','AXON','TTC','SNA','SWK','IR','PH','ROK','AME','NDSN','DOV','GGG','ITW','CMI','PCAR','PACCAR','OTIS','CARR','TT','JCI','AOS','LII','WSO','GNRC','AGCO','CNHI','ALV','LEA','BWA','APTV','GNTX','MGA','VC','MOD','GXO','XPO','JBHT','ODFL','SAIA','OLD','LSTR','ARCB','KNX','CHRW','EXPD','MATX','ZIM','ATSG','ASGN','MAN','RHI','HEES','URI','AAON','BWXT','GEV','VLTO','WAB','FAST','MSM','WCC','RS','SITE'],
    Staples:['PG','KO','PEP','CL','MDLZ','GIS','KHC','STZ','BF-B','DEO','BUD','SAM','TAP','MNST','CELH','KDP','SJM','MKC','HRL','CAG','CPB','K','POST','SMPL','LNCE','THS','TSN','HBI','CLX','CHD','SPB','EPC','COTY','EL','KVUE','HNST','WBA','USFD','SYY','PFGC','UNFI','SAM'],
    Materials:['LIN','APD','ECL','SHW','NEM','FCX','NUE','VMC','MLM','DOW','DD','CE','EMN','PPG','RPM','AXTA','CC','ASH','FUL','GCP','HUN','KWR','OLN','WLK','ALB','LTHM','SQM','LAC','MP','GOLD','NEM','AEM','FNV','WPM','RGLD','KGC','AU','BTG','AGI','PAAS','HL','CDE','SSRM','MAG','SCCO','TECK','RIO','BHP','VALE','CLF','X','STLD','RS','ATI','CRS','HAYN','CMC','AA','CENX','KALU','WOR'],
    REIT:['AMT','PLD','CCI','EQIX','PSA','O','WELL','DLR','SPG','VICI','IRM','SBAC','ARE','BXP','SLG','VNO','CBRE','JLL','CSGP','RDFN','OPEN','ZG','Z','MAA','EQR','AVB','ESS','UDR','CPT','INVH','AMH','SUI','ELS','PEAK','OHI','HR','SBRA','MPW','NNN','STOR','ADC','FCPT','SRC','STAG','TRNO','REXR','FR','LTC','KIM','REG','FRT','SKT','RPT','BRX','SITC','GLPI','RYN','PCH','PLD','CUBE','NSA','COLD','IIPR'],
    Utilities:['NEE','DUK','SO','D','AEP','EXC','SRE','ED','XEL','WEC','ES','AEE','CMS','LNT','DTE','PEG','FE','PPL','PNW','EVRG','ATO','NI','NRG','VST','CEG','PCG','EIX','AWK','WTRG','SJW','YORW','MSEX','CWT','SWX','NWE','OGE','POR','BKH','AVA','IDA','HE','OGS'],
    Telecom:['T','VZ','TMUS','LUMN','CHTR','CMCSA','FYBR','USM','SHEN','CNSL','LBRDK','CABO','ATUS','WBD','PARA','FOX','FOXA','NWSA','NWS','DIS','LYV','MSGS','MSGE','EDR','WMG','SPOT','ROKU','FUBO','IRDM','GSAT','ASTS','SATS','VSAT','GILT','GRMN','ERIC','NOK','TEL'],
    Autos:['TSLA','F','GM','STLA','TM','HMC','RACE','MBGAF','POAHY','BMWYY','VWAGY','RIVN','LCID','NIO','XPEV','LI','FSR','VFS','PSNY','GOEV','ARVL','REE','NKLA','WKHS','HYLN','PTRA','FFIE','QS','CHPT','BLNK','EVGO','DCFC','ALV','APTV','BWA','LEA','GNTX','MGA','VC','MOD','LAZR','INVZ','LIDR','OUST','AEVA','CPTN'],
    Cannabis:['TLRY','CGC','ACB','CRON','SNDL','OGI','HEXO','GRWG','IIPR','TCNNF','CRLBF','GTBIF','CURLF','TRUL','VFF','SMG'],
    Crypto:['COIN','MSTR','MARA','RIOT','CLSK','BTBT','HUT','BITF','HIVE','CORZ','SOS','BTDR','CIFR','GREE','ARBK','IREN','WULF','SMLR'],
  };
  for (const [sec, arr] of Object.entries(S)) if (arr.includes(base)) return sec;
  return "Other";
}

/* ═══════════════════════════════════════════════════════════════════════════
   HISTORICAL STATS FETCH — uses web search to get real return/vol/correlation
   ═══════════════════════════════════════════════════════════════════════════ */

async function fetchHistoricalStats(tickers, years, apiKey, signal) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  }

  const n = tickers.length;
  const tickerDesc = tickerListForPrompt(tickers);

  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 16000,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    system: `You are a financial data API. Use web search to look up real stock performance data. After all searches, you MUST output a single raw JSON object as your FINAL message. No markdown, no backticks, no explanation before or after the JSON. Just the JSON object.`,
    messages: [{
      role: 'user',
      content: `Search the web for the REAL historical performance of these ${n} stocks over the past ${years} year${years>1?'s':''}: ${tickerDesc}

For each ticker, find its annualized total return and annualized volatility (standard deviation of returns) over the past ${years} year${years>1?'s':''}. Use the company names in parentheses to confirm you have the correct stock.

Then estimate pairwise correlation coefficients between each pair based on historical co-movement.

Your FINAL output must be ONLY this JSON (no other text):
{
  "tickers": {
    "${tickers[0]}": { "annualReturn": 0.15, "annualVol": 0.25 },
    ${tickers.slice(1).map(t => `"${t}": { "annualReturn": 0.10, "annualVol": 0.30 }`).join(',\n    ')}
  },
  "correlations": [${Array(n).fill('[' + Array(n).fill('0.5').join(',') + ']').join(',')}],
  "years": ${years},
  "note": "source description"
}

Rules:
- Use ticker symbols as keys (e.g. "TTD", not "The Trade Desk")
- annualReturn/annualVol are DECIMALS (0.15 = 15%, 0.30 = 30%)
- correlations is a ${n}x${n} matrix, same ticker order as listed above
- Diagonal = 1.0, off-diagonal between -1 and 1
- Use REAL searched data, not guesses
- Your very last output must be ONLY the JSON object`
    }]
  };

  const maxRetries = 3;
  let attempt = 0;
  let lastError = null;

  while (attempt < maxRetries) {
    attempt++;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000);
    if (signal) signal.addEventListener('abort', () => controller.abort());

    try {
      const res = await fetch(getApiUrl(), { method: 'POST', headers, signal: controller.signal, body: JSON.stringify(body) });
      clearTimeout(timeout);

      if (res.status === 429) {
        const retryAfter = res.headers.get('retry-after');
        const waitSec = retryAfter ? parseInt(retryAfter) : 65;
        if (attempt < maxRetries) {
          console.log(`[HistStats] 429 rate limited, waiting ${waitSec}s before retry ${attempt+1}...`);
          await new Promise(r => setTimeout(r, waitSec * 1000));
          continue;
        }
        throw { name: 'RateLimitError', waitSeconds: waitSec, message: `Rate limited after ${maxRetries} attempts.` };
      }
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${errText.slice(0, 300)}`);
      }

      const data = await res.json();
      const texts = (data.content || []).filter(b => b.type === 'text' && b.text && b.text.trim()).map(b => b.text);
      console.log(`[HistStats] Got ${data.content?.length} content blocks, ${texts.length} text blocks`);
      texts.forEach((t, i) => console.log(`[HistStats] Text block ${i} (${t.length} chars):`, t.slice(0, 200)));

      const candidates = [...texts].reverse();
      candidates.push(texts.join('\n'));

      for (const candidate of candidates) {
        const parsed = extractJSON(candidate);
        if (!parsed) continue;

        const tickerData = parsed.tickers || parsed.stocks || parsed.data;
        const corrData = parsed.correlations || parsed.correlation_matrix || parsed.corr;

        if (tickerData && typeof tickerData === 'object') {
          const mu = [], vols = [];
          let allFound = true;

          for (const t of tickers) {
            const td = tickerData[t] || tickerData[t.toUpperCase()] || tickerData[t.toLowerCase()];
            if (!td) { allFound = false; break; }
            const ret = Number(td.annualReturn ?? td.annual_return ?? td.return ?? td.annualized_return ?? 0);
            const vol = Number(td.annualVol ?? td.annual_vol ?? td.volatility ?? td.annualized_vol ?? td.vol ?? 0.2);
            mu.push(ret);
            vols.push(Math.max(vol, 0.01));
          }

          if (!allFound) continue;

          let corr;
          if (Array.isArray(corrData) && corrData.length === n) {
            corr = corrData;
          } else {
            corr = Array.from({ length: n }, (_, i) =>
              Array.from({ length: n }, (_, j) => i === j ? 1.0 : 0.3)
            );
            console.log('[HistStats] Using default correlations (API did not return valid matrix)');
          }

          const cov = Array.from({ length: n }, () => Array(n).fill(0));
          for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
              const c = (corr[i] && corr[i][j] != null) ? Math.max(-1, Math.min(1, Number(corr[i][j]))) : (i === j ? 1 : 0.3);
              cov[i][j] = c * vols[i] * vols[j];
            }
          }

          console.log('[HistStats] Success:', tickers.map((t,i) => `${t}: ret=${(mu[i]*100).toFixed(1)}% vol=${(vols[i]*100).toFixed(1)}%`).join(', '));
          return { mu, cov, vols, corr, years: parsed.years || years, note: parsed.note || 'Web search data' };
        }
      }

      throw new Error(`Could not parse historical stats. Got ${texts.length} text blocks. Last: ${texts[texts.length-1]?.slice(0,200) || 'empty'}`);

    } catch (err) {
      clearTimeout(timeout);
      lastError = err;
      if (err.name === 'AbortError') throw err;
      if (attempt < maxRetries && (err.name === 'RateLimitError' || err.message?.includes('429'))) {
        console.log(`[HistStats] Retrying after error: ${err.message}`);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      throw err;
    }
  }
  throw lastError || new Error('Failed after retries');
}

/* ═══════════════════════════════════════════════════════════════════════════
   MONTE CARLO — uses historical mu/cov only (no synthetic fallback)
   ═══════════════════════════════════════════════════════════════════════════ */

const RF = 0.04;
class RNG{constructor(s){this.s=s;}next(){this.s=(this.s*1103515245+12345)&0x7fffffff;return this.s/0x7fffffff;}}
function portStats(w,mu,cov){const ret=w.reduce((s,wi,i)=>s+wi*mu[i],0);let v=0;for(let i=0;i<w.length;i++)for(let j=0;j<w.length;j++)v+=w[i]*w[j]*cov[i][j];const vol=Math.sqrt(Math.max(v,1e-6));return{ret,vol,sharpe:(ret-RF)/vol};}
function randWeights(n,g){const w=Array.from({length:n},()=>g.next());const s=w.reduce((a,b)=>a+b,0);return w.map(v=>v/s);}

function optimizeWithData(mu, cov, iter=8000) {
  const n = mu.length;
  const seed = mu.reduce((s,v,i) => s + Math.abs(v) * 1000 * (i+1), 42);
  const g1 = new RNG(seed+1), g2 = new RNG(seed+9999);
  let bMV = { vol: Infinity }, bMS = { sharpe: -Infinity };
  const fr = [], allSh = [], allMVR = [], allMSR = [];
  for (let i = 0; i < iter; i++) {
    const w1 = randWeights(n, g1), s1 = portStats(w1, mu, cov);
    if (s1.vol < bMV.vol) bMV = { weights: [...w1], ...s1 };
    allMVR.push(s1.ret);
    const w2 = randWeights(n, g2), s2 = portStats(w2, mu, cov);
    if (s2.sharpe > bMS.sharpe) bMS = { weights: [...w2], ...s2 };
    allMSR.push(s2.ret); allSh.push(s2.sharpe);
    if (i % 10 === 0) fr.push({ x: +(s2.vol * 100).toFixed(3), y: +(s2.ret * 100).toFixed(3) });
  }
  const avg = a => a.reduce((s, v) => s + v, 0) / a.length;
  return { minVar: bMV, maxSharpe: bMS, frontier: fr, avgMSR: avg(allMSR), avgMVR: avg(allMVR), avgSh: avg(allSh) };
}

/* ═══════════════════════════════════════════════════════════════════════════
   STYLES
   ═══════════════════════════════════════════════════════════════════════════ */

const SEC_CLR={Tech:'#6366f1',Semis:'#8b5cf6',Finance:'#0ea5e9',Retail:'#f59e0b',Health:'#10b981',Staples:'#84cc16',Energy:'#ef4444',Industrials:'#94a3b8',Materials:'#78716c',REIT:'#c084fc',Utilities:'#06b6d4',Telecom:'#e879f9',Autos:'#fb923c',Cannabis:'#22c55e',Crypto:'#fbbf24',Other:'#64748b'};
const F="'Instrument Sans','DM Sans',system-ui,sans-serif";
const MO="'DM Mono','JetBrains Mono',monospace";
const TH={padding:"10px 12px",textAlign:"right",borderBottom:"2px solid #e2e8f0",fontSize:10,fontWeight:700,color:"#475569",textTransform:"uppercase",letterSpacing:.5,whiteSpace:"nowrap"};

const recColors = {"Strong Buy":"#059669","Buy":"#10b981","Hold":"#eab308","Sell":"#f87171","Strong Sell":"#ef4444"};

const RatingBadge = ({ rating }) => {
  const col = recColors[rating] || "#94a3b8";
  return <span style={{padding:"3px 8px",borderRadius:10,fontSize:10,fontWeight:700,background:col+"20",color:col}}>{rating}</span>;
};

/* ═══════════════════════════════════════════════════════════════════════════
   VARIANCE-COVARIANCE MATRIX DISPLAY
   ═══════════════════════════════════════════════════════════════════════════ */

function CovarianceMatrixTable({ tickers, cov, weights, title }) {
  if (!cov || !tickers || tickers.length === 0) return null;
  const n = tickers.length;

  // Compute portfolio variance breakdown: w_i * w_j * cov(i,j)
  let portfolioVariance = 0;
  const contributions = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const c = (weights[i] || 0) * (weights[j] || 0) * cov[i][j];
      contributions[i][j] = c;
      portfolioVariance += c;
    }
  }
  const portfolioVol = Math.sqrt(Math.max(portfolioVariance, 0));

  // Find max absolute value for color scaling
  const maxAbsCov = Math.max(...cov.flat().map(v => Math.abs(v)), 0.001);

  return (
    <div style={{background:"#fff",borderRadius:14,padding:"16px 18px",border:"1px solid #e2e8f0",marginBottom:16}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12,flexWrap:"wrap",gap:8}}>
        <h3 style={{fontSize:12,fontWeight:700,color:"#0f172a",margin:0,display:"flex",alignItems:"center",gap:6}}>
          <span style={{width:4,height:16,borderRadius:2,background:"#f59e0b",display:"inline-block"}}/>
          {title || "Variance-Covariance Matrix"}
        </h3>
        <div style={{display:"flex",gap:12,fontSize:10,fontFamily:MO}}>
          <span style={{color:"#64748b"}}>Portfolio Var: <strong style={{color:"#0f172a"}}>{(portfolioVariance * 10000).toFixed(2)} bps²</strong></span>
          <span style={{color:"#64748b"}}>Portfolio Vol: <strong style={{color:"#6366f1"}}>{(portfolioVol * 100).toFixed(2)}%</strong></span>
        </div>
      </div>

      <div style={{overflowX:"auto"}}>
        <table style={{borderCollapse:"collapse",fontSize:9,width:"100%"}}>
          <thead>
            <tr>
              <th style={{padding:"4px 8px",fontFamily:MO,fontWeight:700,color:"#475569",textAlign:"left",borderBottom:"2px solid #e2e8f0",fontSize:9}}>Cov(i,j)</th>
              {tickers.map(t => (
                <th key={t} style={{padding:"4px 6px",fontFamily:MO,fontWeight:700,color:"#475569",whiteSpace:"nowrap",borderBottom:"2px solid #e2e8f0",textAlign:"center",fontSize:9}}>{t}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tickers.map((t, i) => (
              <tr key={t}>
                <td style={{padding:"4px 8px",fontFamily:MO,fontWeight:700,color:"#475569",borderRight:"1px solid #e2e8f0",whiteSpace:"nowrap"}}>{t}</td>
                {tickers.map((t2, j) => {
                  const v = cov[i][j];
                  const abs = Math.abs(v) / maxAbsCov;
                  const isDiag = i === j;
                  const bg = isDiag
                    ? `rgba(99,102,241,${0.08 + abs * 0.25})`
                    : v > 0
                      ? `rgba(16,185,129,${abs * 0.35})`
                      : `rgba(239,68,68,${abs * 0.35})`;
                  const fontColor = abs > 0.6 ? "#0f172a" : "#334155";
                  return (
                    <td key={j} style={{
                      padding:"4px 6px",textAlign:"center",fontFamily:MO,
                      background:bg,borderRadius:1,fontWeight:isDiag?700:400,
                      color:fontColor,whiteSpace:"nowrap",
                      border:"1px solid rgba(226,232,240,0.4)"
                    }}>
                      {v.toFixed(4)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Weighted contribution matrix */}
      {weights && (
        <div style={{marginTop:14}}>
          <div style={{fontSize:10,fontWeight:700,color:"#475569",marginBottom:6}}>
            Weighted Contribution to Portfolio Variance (w_i × w_j × σ_ij)
          </div>
          <div style={{overflowX:"auto"}}>
            <table style={{borderCollapse:"collapse",fontSize:9,width:"100%"}}>
              <thead>
                <tr>
                  <th style={{padding:"4px 8px",fontFamily:MO,fontWeight:700,color:"#475569",textAlign:"left",borderBottom:"2px solid #e2e8f0",fontSize:9}}>w·Cov</th>
                  {tickers.map(t => (
                    <th key={t} style={{padding:"4px 6px",fontFamily:MO,fontWeight:700,color:"#475569",whiteSpace:"nowrap",borderBottom:"2px solid #e2e8f0",textAlign:"center",fontSize:9}}>{t}</th>
                  ))}
                  <th style={{padding:"4px 6px",fontFamily:MO,fontWeight:700,color:"#6366f1",borderBottom:"2px solid #e2e8f0",textAlign:"center",fontSize:9}}>Row Σ</th>
                </tr>
              </thead>
              <tbody>
                {tickers.map((t, i) => {
                  const rowSum = contributions[i].reduce((s, v) => s + v, 0);
                  const rowPct = portfolioVariance > 0 ? (rowSum / portfolioVariance * 100) : 0;
                  return (
                    <tr key={t}>
                      <td style={{padding:"4px 8px",fontFamily:MO,fontWeight:700,color:"#475569",borderRight:"1px solid #e2e8f0",whiteSpace:"nowrap"}}>{t}</td>
                      {tickers.map((t2, j) => {
                        const v = contributions[i][j];
                        const pct = portfolioVariance > 0 ? (v / portfolioVariance * 100) : 0;
                        const bg = v > 0 ? `rgba(16,185,129,${Math.min(Math.abs(pct)/30, 0.35)})` : v < 0 ? `rgba(239,68,68,${Math.min(Math.abs(pct)/30, 0.35)})` : "transparent";
                        return (
                          <td key={j} style={{
                            padding:"4px 6px",textAlign:"center",fontFamily:MO,
                            background:bg,borderRadius:1,color:"#334155",
                            whiteSpace:"nowrap",border:"1px solid rgba(226,232,240,0.4)"
                          }}>
                            {(v * 10000).toFixed(2)}
                          </td>
                        );
                      })}
                      <td style={{padding:"4px 6px",textAlign:"center",fontFamily:MO,fontWeight:700,
                        color:rowSum>=0?"#059669":"#ef4444",background:"#f8fafc",borderLeft:"2px solid #e2e8f0"}}>
                        {rowPct.toFixed(1)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{borderTop:"2px solid #e2e8f0"}}>
                  <td style={{padding:"6px 8px",fontFamily:MO,fontWeight:700,color:"#0f172a",fontSize:10}} colSpan={tickers.length + 1}>
                    Total Portfolio Variance
                  </td>
                  <td style={{padding:"6px 6px",textAlign:"center",fontFamily:MO,fontWeight:800,color:"#6366f1",fontSize:11}}>
                    {(portfolioVariance * 10000).toFixed(2)} bps²
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <div style={{fontSize:9,color:"#94a3b8",marginTop:6}}>
            Values in basis points squared (bps²). Row Σ shows each asset's marginal contribution to total portfolio variance as a percentage.
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   LIVE ANALYSIS TABLE
   ═══════════════════════════════════════════════════════════════════════════ */

function LiveAnalysisTable({ title, tickers, weights, stocks, liveData, accentColor, loading }) {
  const [expanded, setExpanded] = useState(null);

  const items = useMemo(() =>
    tickers.map((t, i) => ({ t, w: weights[i] || 0, s: stocks[t], a: liveData[t] || null })).sort((a, b) => b.w - a.w),
    [tickers, weights, stocks, liveData]
  );

  const hasData = items.some(x => x.a);
  const dot = loading ? '...' : '\u2014';

  const wtdUpside = items.reduce((s, x) => x.a ? s + x.w * x.a.upside : s, 0);
  const avgEntryDisc = (() => {
    const valid = items.filter(x => x.a && x.a.latestPrice > 0);
    if (!valid.length) return 0;
    return valid.reduce((s, x) => s + (1 - x.a.entryPrice / x.a.latestPrice), 0) / valid.length * 100;
  })();
  const strongBuyWt = items.filter(x => x.a && x.a.rating === 'Strong Buy').reduce((s, x) => s + x.w, 0) * 100;
  const avgRR = (() => {
    const valid = items.filter(x => x.a).map(x => calcRiskReward(x.a)).filter(v => v !== null && isFinite(v));
    return valid.length ? valid.reduce((s, v) => s + v, 0) / valid.length : null;
  })();

  return (
    <div style={{background:"#fff",borderRadius:14,border:"1px solid #e2e8f0",overflow:"hidden"}}>
      <div style={{padding:"14px 16px",borderBottom:"1px solid #f1f5f9",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <div style={{width:4,height:20,borderRadius:2,background:accentColor}}/>
          <h3 style={{fontSize:13,fontWeight:700,color:"#0f172a",margin:0}}>{title}</h3>
        </div>
        <div style={{fontSize:10,color:"#94a3b8",fontWeight:500}}>
          {loading ? "\u23F3 Fetching..." : hasData ? "\u2713 Live data" : "Awaiting data"}
        </div>
      </div>
      <div style={{overflowX:"auto",maxHeight:600,overflowY:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
          <thead>
            <tr style={{background:"#f8fafc",position:"sticky",top:0,zIndex:5}}>
              <th style={{...TH,textAlign:"left"}}>Stock</th>
              <th style={TH}>Weight</th>
              <th style={TH}><div>Price</div>{hasData&&<div style={{fontWeight:400,color:"#94a3b8",fontSize:8}}>date</div>}</th>
              <th style={{...TH,color:"#059669"}}><div>Entry</div>{hasData&&<div style={{fontWeight:400,color:"#6ee7b7",fontSize:8}}>date</div>}</th>
              <th style={{...TH,color:"#3b82f6"}}><div>Target</div>{hasData&&<div style={{fontWeight:400,color:"#93c5fd",fontSize:8}}>date</div>}</th>
              <th style={{...TH,textAlign:"center"}}><div>Rating</div>{hasData&&<div style={{fontWeight:400,color:"#94a3b8",fontSize:8}}>date</div>}</th>
              <th style={TH}><div>Upside</div>{hasData&&<div style={{fontWeight:400,color:"#94a3b8",fontSize:8}}>date</div>}</th>
              <th style={{...TH,color:"#6366f1"}}><div>R/R</div>{hasData&&<div style={{fontWeight:400,color:"#a5b4fc",fontSize:8}}>ratio</div>}</th>
            </tr>
          </thead>
          <tbody>
            {items.map(({ t, w, s, a }, i) => {
              if (!s) return null;
              const pending = !a;
              const rr = a ? calcRiskReward(a) : null;
              const rrDisplay = rr === null ? dot : rr === Infinity ? '\u221E:1' : `${rr.toFixed(1)}:1`;
              const rrColor = rr === null ? "#94a3b8" : rr >= 3 ? "#059669" : rr >= 1.5 ? "#6366f1" : rr >= 1 ? "#eab308" : "#ef4444";
              const isExp = expanded === t;
              const displayName = TICKER_NAMES[t] || s.name || t;

              return (
                <React.Fragment key={t}>
                  <tr onClick={() => setExpanded(isExp ? null : t)}
                    style={{background:isExp?"#eff6ff":i%2===0?"#fff":"#fafbfc",borderBottom:"1px solid #f1f5f9",cursor:"pointer",transition:"background .15s"}}>
                    <td style={{padding:"9px 12px",fontWeight:700,color:"#0f172a"}}>
                      <div style={{display:"flex",alignItems:"center",gap:7}}>
                        <div style={{width:3,height:22,borderRadius:2,background:SEC_CLR[s.sector]||"#94a3b8"}}/>
                        <div>
                          <div style={{fontFamily:MO,fontSize:12}}>{t}</div>
                          <div style={{fontSize:9,color:"#94a3b8",fontWeight:400,maxWidth:100,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{displayName}</div>
                        </div>
                      </div>
                    </td>
                    <td style={{padding:"9px 12px",textAlign:"right",fontFamily:MO,fontWeight:700,color:"#0f172a"}}>{(w*100).toFixed(1)}%</td>
                    <td style={{padding:"9px 12px",textAlign:"right"}}>
                      {pending
                        ? <div><div style={{fontFamily:MO,fontWeight:700,color:"#059669",fontSize:13}}>${s.price?.toFixed(2)}</div><div style={{fontSize:8,color:"#94a3b8"}}>{s.date}</div></div>
                        : <div><div style={{fontFamily:MO,fontWeight:700,color:"#334155"}}>${a.latestPrice.toFixed(2)}</div><div style={{fontSize:8,color:"#94a3b8"}}>{a.priceDate}</div></div>}
                    </td>
                    <td style={{padding:"9px 12px",textAlign:"right"}}>
                      {pending ? <span style={{color:"#cbd5e1",fontSize:11}}>{dot}</span>
                        : <div><div style={{fontFamily:MO,fontWeight:700,color:"#059669"}}>${a.entryPrice.toFixed(2)}</div><div style={{fontSize:8,color:"#6ee7b7"}}>{a.entryDate}</div></div>}
                    </td>
                    <td style={{padding:"9px 12px",textAlign:"right"}}>
                      {pending ? <span style={{color:"#cbd5e1",fontSize:11}}>{dot}</span>
                        : <div><div style={{fontFamily:MO,fontWeight:700,color:"#3b82f6"}}>${a.targetPrice.toFixed(2)}</div><div style={{fontSize:8,color:"#93c5fd"}}>{a.targetDate}</div></div>}
                    </td>
                    <td style={{padding:"9px 12px",textAlign:"center"}}>
                      {pending ? <span style={{color:"#cbd5e1",fontSize:11}}>{dot}</span>
                        : <div><RatingBadge rating={a.rating}/><div style={{fontSize:8,color:"#94a3b8",marginTop:2}}>{a.ratingDate}</div></div>}
                    </td>
                    <td style={{padding:"9px 12px",textAlign:"right",color:!pending&&a.upside>=0?"#059669":!pending?"#ef4444":"#94a3b8"}}>
                      {pending ? <span style={{fontSize:11}}>{dot}</span>
                        : <div><div style={{fontWeight:700}}>{a.upside>=0?"+":""}{a.upside.toFixed(1)}%</div><div style={{fontSize:8,opacity:.6}}>{a.upsideDate}</div></div>}
                    </td>
                    <td style={{padding:"9px 12px",textAlign:"right",fontFamily:MO,fontWeight:700,color:rrColor}}>{rrDisplay}</td>
                  </tr>
                  {isExp && !pending && (
                    <tr style={{background:"linear-gradient(135deg,#eff6ff,#eef2ff)"}}>
                      <td colSpan={8} style={{padding:"14px 16px"}}>
                        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
                          <span style={{fontSize:11,fontWeight:600,color:(a.sentiment||'').includes('Bull')?'#059669':(a.sentiment||'').includes('Bear')?'#ef4444':'#64748b'}}>{a.sentiment}</span>
                          <span style={{fontSize:11,color:"#64748b"}}>{a.analystCount} analysts</span>
                        </div>
                        {a.reasoning && a.reasoning !== 'N/A' && (
                          <div style={{background:"rgba(255,255,255,.7)",borderRadius:8,padding:"10px 12px",border:"1px solid #dbeafe",marginBottom:10}}>
                            <div style={{fontSize:11,color:"#334155",lineHeight:1.5}}>{a.reasoning}</div>
                            <div style={{fontSize:9,color:"#94a3b8",marginTop:4}}>Source: {a.reasoningSource} | {a.reasoningDate}</div>
                          </div>
                        )}
                        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))",gap:10,marginBottom:10}}>
                          {[
                            {l:"Entry Discount",v:a.latestPrice>0?((1-a.entryPrice/a.latestPrice)*100).toFixed(1):"0",u:"%",c:a.entryPrice<a.latestPrice?"#059669":"#f59e0b"},
                            {l:"Upside from Entry",v:a.entryPrice>0?((a.targetPrice/a.entryPrice-1)*100).toFixed(1):"0",u:"%",c:"#3b82f6"},
                            {l:"Risk / Reward",v:rrDisplay,u:"",c:rrColor},
                            {l:"Sector",v:s.sector,u:"",c:SEC_CLR[s.sector]||"#64748b"},
                          ].map((card,j)=>(
                            <div key={j} style={{background:"rgba(255,255,255,.7)",borderRadius:8,padding:"10px 12px",border:"1px solid #e2e8f0",textAlign:"center"}}>
                              <div style={{fontSize:9,color:"#64748b",fontWeight:600,textTransform:"uppercase",marginBottom:3}}>{card.l}</div>
                              <div style={{fontFamily:MO,fontSize:16,fontWeight:800,color:card.c}}>{card.v}{card.u}</div>
                            </div>
                          ))}
                        </div>
                        <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:6,marginBottom:10}}>
                          {[['Price',a.priceSource,a.priceDate],['Target',a.targetSource,a.targetDate],['Rating',a.ratingSource,a.ratingDate],['Entry',a.entrySource,a.entryDate]].map(([l,v,d],j)=>(
                            <div key={j} style={{background:"rgba(255,255,255,.6)",borderRadius:6,padding:"6px 8px",border:"1px solid #e2e8f0"}}>
                              <div style={{fontSize:9,fontWeight:600,color:"#64748b"}}>{l}</div>
                              <div style={{fontSize:10,color:"#334155"}}>{v}</div>
                              <div style={{fontSize:8,color:"#94a3b8"}}>{d}</div>
                            </div>
                          ))}
                        </div>
                        {a.catalysts && a.catalysts.length > 0 && a.catalysts[0] !== 'Market' && (
                          <div style={{display:"flex",flexWrap:"wrap",gap:4,alignItems:"center"}}>
                            <span style={{fontSize:10,color:"#64748b",fontWeight:600}}>Catalysts:</span>
                            {a.catalysts.map((c, ci) => (
                              <span key={ci} style={{fontSize:9,padding:"2px 7px",borderRadius:4,background:"rgba(99,102,241,.08)",color:"#6366f1",fontWeight:600,border:"1px solid rgba(99,102,241,.15)"}}>{c}</span>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {hasData && !loading && (
        <div style={{borderTop:"2px solid #e2e8f0",background:"#f8fafc",padding:"12px 16px",display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,textAlign:"center"}}>
          <div><div style={{fontSize:9,color:"#94a3b8",fontWeight:700,textTransform:"uppercase",letterSpacing:.8}}>Avg Entry Disc.</div><div style={{fontFamily:MO,fontSize:15,fontWeight:800,color:"#059669"}}>{avgEntryDisc.toFixed(1)}%</div></div>
          <div><div style={{fontSize:9,color:"#94a3b8",fontWeight:700,textTransform:"uppercase",letterSpacing:.8}}>Wtd Upside</div><div style={{fontFamily:MO,fontSize:15,fontWeight:800,color:"#3b82f6"}}>{wtdUpside.toFixed(1)}%</div></div>
          <div><div style={{fontSize:9,color:"#94a3b8",fontWeight:700,textTransform:"uppercase",letterSpacing:.8}}>Strong Buy %</div><div style={{fontFamily:MO,fontSize:15,fontWeight:800,color:"#818cf8"}}>{strongBuyWt.toFixed(0)}%</div></div>
          <div><div style={{fontSize:9,color:"#94a3b8",fontWeight:700,textTransform:"uppercase",letterSpacing:.8}}>Avg R/R</div><div style={{fontFamily:MO,fontSize:15,fontWeight:800,color:"#6366f1"}}>{avgRR !== null ? avgRR.toFixed(1)+':1' : '\u2014'}</div></div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   MAIN DASHBOARD
   ═══════════════════════════════════════════════════════════════════════════ */
export default function PortfolioDashboard() {
  const [stocks, setStocks] = useState({});
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [optMsg, setOptMsg] = useState('');
  const [histStats, setHistStats] = useState(null);
  const [tab, setTab] = useState("maxSharpe");
  const [numSims, setNumSims] = useState(3000);
  const [histYrs, setHistYrs] = useState(3);

  const [apiKey, setApiKey] = useState('');
  const [liveData, setLiveData] = useState({});
  const [fetching, setFetching] = useState(false);
  const [fetchMsg, setFetchMsg] = useState('');
  const [fetchStatus, setFetchStatus] = useState(null);
  const [fetchError, setFetchError] = useState(null);
  const [countdown, setCountdown] = useState(0);
  const abortRef = useRef(null);
  const countdownRef = useRef(null);

  const tickers = useMemo(() => Object.keys(stocks), [stocks]);

  const addTicker = useCallback(() => {
    const t = input.toUpperCase().trim();
    if (!t) return;
    if (stocks[t]) { setError(t + " already added"); return; }
    setError(""); setInput("");
    const knownName = TICKER_NAMES[t];
    setStocks(prev => ({ ...prev, [t]: { ticker: t, name: knownName || t, price: 0, source: "Pending", date: "\u2014", sector: guessSector(t) } }));
  }, [input, stocks]);

  const removeTicker = useCallback((t) => {
    setStocks(prev => { const n = { ...prev }; delete n[t]; return n; });
    setRes(null);
    setLiveData(prev => { const n = { ...prev }; delete n[t]; return n; });
  }, []);

  const doFetch = useCallback(async (tickerList) => {
    if (!apiKey) { setFetchStatus('error'); setFetchError('API key required. Enter your Portfolio Dashboard API key above.'); return; }
    const ac = new AbortController(); abortRef.current = ac;
    setFetching(true); setFetchStatus('loading'); setFetchError(null); setFetchMsg('');
    const maxRetries = 3; let attempt = 0; let lastError = null;

    while (attempt < maxRetries && !ac.signal.aborted) {
      attempt++;
      setFetchMsg(`Requesting data for ${tickerList.length} tickers (attempt ${attempt}/${maxRetries})...`);
      try {
        const result = await fetchAllTickers(tickerList, apiKey, ac.signal);
        if (result) {
          setLiveData(prev => ({ ...prev, ...result }));
          const today = new Date().toLocaleDateString();
          setStocks(prev => {
            const next = { ...prev };
            for (const [tk, d] of Object.entries(result)) {
              if (next[tk]) {
                next[tk] = { ...next[tk], price: d.latestPrice, source: d.priceSource || 'API', date: d.priceDate || today };
                if (next[tk].name === tk && TICKER_NAMES[tk]) next[tk].name = TICKER_NAMES[tk];
              }
            }
            return next;
          });
          const loaded = Object.keys(result).length;
          const missing = tickerList.filter(t => !result[t]);
          setFetching(false); setCountdown(0);
          if (missing.length === 0) { setFetchStatus('success'); setFetchMsg(`All ${loaded} tickers loaded \u2713`); }
          else { setFetchStatus('partial'); setFetchError(`${loaded}/${tickerList.length} loaded. Missing: ${missing.join(', ')}`); }
          return;
        }
      } catch (err) {
        if (err.name === 'AbortError') { setFetching(false); return; }
        lastError = err;
        if (err.name === 'RateLimitError' && attempt < maxRetries) {
          const waitSec = err.waitSeconds || 65;
          setFetchMsg(`Rate limited. Waiting ${waitSec}s before retry ${attempt + 1}/${maxRetries}...`);
          setCountdown(waitSec);
          await new Promise((resolve) => {
            let left = waitSec;
            countdownRef.current = setInterval(() => { left--; setCountdown(left); if (left <= 0 || ac.signal.aborted) { clearInterval(countdownRef.current); resolve(); } }, 1000);
          });
          setCountdown(0); continue;
        }
        break;
      }
    }
    setFetching(false); setCountdown(0);
    if (!ac.signal.aborted) {
      const loaded = Object.keys(liveData).length;
      if (loaded > 0) { setFetchStatus('partial'); setFetchError(`${loaded} loaded before error: ${lastError?.message || 'Unknown'}`); }
      else { setFetchStatus('error'); setFetchError(lastError?.message || 'Failed to fetch data.'); }
    }
  }, [apiKey, liveData]);

  const skip = useCallback(() => {
    abortRef.current?.abort();
    if (countdownRef.current) clearInterval(countdownRef.current);
    setFetching(false); setCountdown(0);
    setFetchStatus(Object.keys(liveData).length > 0 ? 'partial' : null);
  }, [liveData]);

  const runOptimize = useCallback(async () => {
    if (tickers.length < 2) return;
    if (!apiKey) {
      setOptMsg('API key required for historical data. Enter your Portfolio Dashboard API key above.');
      return;
    }
    setBusy(true); setOptMsg(''); setRes(null); setHistStats(null);

    try {
      setOptMsg(`Fetching ${histYrs}yr historical returns & volatilities via web search...`);
      const stats = await fetchHistoricalStats(tickers, histYrs, apiKey);
      setHistStats(stats);
      setOptMsg(`Historical data loaded (${histYrs}yr). Running ${numSims.toLocaleString()} simulations...`);

      await new Promise(r => setTimeout(r, 30));

      const result = optimizeWithData(stats.mu, stats.cov, numSims);
      result.dataSource = 'historical';
      result.histYrs = histYrs;

      setRes(result);
      setBusy(false);
      setTab("maxSharpe");
      setOptMsg(`Optimized using ${histYrs}yr real historical data \u2713`);
    } catch (err) {
      console.error('Historical fetch failed:', err);
      setBusy(false);
      const msg = err.name === 'RateLimitError'
        ? `Rate limited \u2014 please wait a minute and try again.`
        : `Historical data fetch failed: ${err.message}. Please check your API key and try again.`;
      setOptMsg(msg);
      setHistStats(null);
    }
  }, [tickers, numSims, histYrs, apiKey]);

  const port = res ? (tab === "maxSharpe" ? res.maxSharpe : res.minVar) : null;
  const rows = useMemo(() => {
    if (!port) return [];
    return tickers.map((t, i) => ({ ...stocks[t], w: port.weights[i] || 0 })).sort((a, b) => b.w - a.w);
  }, [port, tickers, stocks]);

  const fmt = v => (v == null || isNaN(v)) ? "\u2014" : (v * 100).toFixed(2) + "%";
  const fN = v => (v == null || isNaN(v)) ? "\u2014" : v.toFixed(3);

  return (
    <div style={{fontFamily:F,minHeight:"100vh",background:"linear-gradient(170deg,#080f1a 0%,#0f1a2e 40%,#0a1020 100%)",color:"#e2e8f0",padding:"28px 16px"}}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600;700&family=Instrument+Sans:wght@400;500;600;700&display=swap" rel="stylesheet"/>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{maxWidth:1200,margin:"0 auto"}}>

        <div style={{marginBottom:28,display:"flex",alignItems:"flex-end",justifyContent:"space-between",flexWrap:"wrap",gap:12}}>
          <div>
            <div style={{fontSize:10,fontWeight:700,color:"#f59e0b",letterSpacing:3.5,textTransform:"uppercase",marginBottom:3}}>Portfolio Lab</div>
            <h1 style={{fontSize:26,fontWeight:800,margin:0,background:"linear-gradient(135deg,#f8fafc,#94a3b8)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>Monte Carlo Portfolio Optimizer</h1>
            <p style={{color:"#475569",fontSize:12,margin:"4px 0 0"}}>Live prices &amp; analyst data via Portfolio Dashboard API &middot; Historical data optimization</p>
          </div>
          <div style={{fontFamily:MO,fontSize:11,color:"#475569",textAlign:"right"}}>
            <div style={{fontWeight:600,color:"#f59e0b"}}>Author: Amadea Schaum</div>
            <div>RF: {(RF*100).toFixed(1)}%</div>
          </div>
        </div>

        <div style={{background:"rgba(255,255,255,.03)",border:"1px solid rgba(255,255,255,.08)",borderRadius:16,padding:22,marginBottom:22}}>
          <h2 style={{fontSize:15,fontWeight:700,margin:"0 0 4px",color:"#f1f5f9"}}>Add Stocks</h2>
          <p style={{fontSize:11,color:"#64748b",margin:"0 0 14px"}}>Add tickers below, enter your API key, then click <strong style={{color:"#818cf8"}}>Fetch Live Data</strong> to get current prices, analyst targets, ratings, entry points &amp; R/R. Click <strong style={{color:"#818cf8"}}>Optimize</strong> to run Monte Carlo using historical return data.</p>

          <div style={{display:"flex",gap:8,marginBottom:14}}>
            <input type="text" placeholder="Any ticker: AAPL, NVDA, TTD, SHEL.L, 7203.T..." value={input}
              onChange={e=>setInput(e.target.value.toUpperCase())} onKeyDown={e=>{if(e.key==="Enter")addTicker();}}
              style={{flex:1,padding:"11px 14px",fontFamily:MO,fontSize:14,fontWeight:600,background:"rgba(255,255,255,.06)",border:"1px solid rgba(255,255,255,.14)",borderRadius:10,color:"#f1f5f9",outline:"none",letterSpacing:1}}/>
            <button onClick={addTicker} disabled={!input.trim()}
              style={{padding:"11px 24px",borderRadius:10,border:"none",fontWeight:700,fontSize:13,fontFamily:F,cursor:!input.trim()?"not-allowed":"pointer",background:"linear-gradient(135deg,#f59e0b,#d97706)",color:"#fff",boxShadow:"0 3px 16px rgba(245,158,11,.25)"}}>
              + Add Stock</button>
          </div>

          {error && <div style={{fontSize:12,color:"#f87171",marginBottom:10,padding:"6px 12px",background:"rgba(239,68,68,.08)",borderRadius:8}}>{error}</div>}

          {tickers.length > 0 ? (
            <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:16}}>
              {tickers.map(t=>{const s=stocks[t]; const live=!!liveData[t]; const displayName = TICKER_NAMES[t] || s.name || t; return(
                <div key={t} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 8px 6px 12px",borderRadius:10,border:`1px solid ${live?"rgba(16,185,129,.3)":"rgba(255,255,255,.12)"}`,background:live?"rgba(16,185,129,.06)":"rgba(255,255,255,.04)"}}>
                  <div style={{width:3,height:22,borderRadius:2,background:SEC_CLR[s.sector]||"#64748b"}}/>
                  <div><div style={{fontFamily:MO,fontWeight:700,fontSize:13,color:"#f1f5f9"}}>{t}</div><div style={{fontSize:9,color:"#64748b"}}>{displayName !== t ? displayName : s.sector}</div></div>
                  <div style={{textAlign:"right",marginLeft:6}}>
                    {s.price > 0
                      ? <><div style={{fontFamily:MO,fontWeight:700,fontSize:13,color:"#10b981"}}>${s.price.toFixed(2)}</div><div style={{fontSize:8,color:"#475569"}}>{s.date}</div></>
                      : <div style={{fontSize:10,color:"#64748b"}}>Pending</div>}
                  </div>
                  {live && <div style={{fontSize:8,color:"#10b981",fontWeight:700}}>LIVE</div>}
                  <button onClick={()=>removeTicker(t)} style={{width:18,height:18,borderRadius:9,border:"none",marginLeft:4,background:"rgba(239,68,68,.15)",color:"#f87171",fontSize:12,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700,padding:0}}>&times;</button>
                </div>);})}
            </div>
          ) : <div style={{padding:"20px 0",textAlign:"center",color:"#334155",fontSize:13}}>No stocks added yet.</div>}

          {tickers.length > 0 && (
            <div style={{marginBottom:16,padding:"14px 16px",background:"rgba(99,102,241,.04)",border:"1px solid rgba(99,102,241,.15)",borderRadius:12}}>
              <div style={{fontSize:11,fontWeight:600,color:"#94a3b8",marginBottom:8}}>{'\uD83D\uDD11'} API Key (required for live data &amp; optimization)</div>
              <div style={{display:"flex",gap:8,alignItems:"end",flexWrap:"wrap",marginBottom:10}}>
                <div style={{flex:1,minWidth:200}}>
                  <label style={{display:"block",fontSize:10,color:"#64748b",marginBottom:4}}>Portfolio Dashboard API Key</label>
                  <input type="password" value={apiKey} onChange={e=>setApiKey(e.target.value.trim())} placeholder="sk-ant-api03-..."
                    style={{width:"100%",padding:"9px 12px",fontFamily:MO,fontSize:12,background:"rgba(255,255,255,.06)",border:"1px solid rgba(255,255,255,.14)",borderRadius:8,color:"#f1f5f9",outline:"none"}} disabled={fetching}/>
                </div>
                <button onClick={()=>{setLiveData({});doFetch(tickers);}} disabled={fetching||!apiKey||tickers.length===0}
                  style={{padding:"10px 20px",borderRadius:10,border:"none",fontWeight:700,fontSize:12,fontFamily:F,cursor:(fetching||!apiKey)?"not-allowed":"pointer",background:(fetching||!apiKey)?"#334155":"linear-gradient(135deg,#818cf8,#6366f1)",color:(fetching||!apiKey)?"#64748b":"#fff",boxShadow:(fetching||!apiKey)?"none":"0 3px 16px rgba(99,102,241,.3)",whiteSpace:"nowrap"}}>
                  {fetching ? <span style={{display:"flex",alignItems:"center",gap:6}}><span style={{display:"inline-block",width:12,height:12,border:"2px solid rgba(255,255,255,.3)",borderTopColor:"#fff",borderRadius:"50%",animation:"spin 1s linear infinite"}}/> Fetching...</span> : "\uD83D\uDCE1 Fetch Live Data"}</button>
                {fetching && <button onClick={skip} style={{padding:"10px 16px",borderRadius:10,border:"1px solid rgba(255,255,255,.15)",fontWeight:600,fontSize:12,fontFamily:F,cursor:"pointer",background:"transparent",color:"#94a3b8"}}>Skip</button>}
              </div>
              <div style={{fontSize:10,color:"#64748b"}}>Uses Portfolio Dashboard API with web search to find real current prices, analyst targets, ratings &amp; catalysts. Also required for historical data optimization.{countdown>0 && <span style={{fontFamily:MO,color:"#f59e0b",marginLeft:8}}>{'\u23F1'} {countdown}s</span>}</div>
            </div>
          )}

          {fetchStatus && (
            <div style={{marginBottom:14,padding:"10px 14px",borderRadius:10,fontSize:12,
              background:fetchStatus==='loading'?"rgba(59,130,246,.08)":fetchStatus==='success'?"rgba(16,185,129,.08)":fetchStatus==='partial'?"rgba(234,179,8,.08)":"rgba(239,68,68,.08)",
              border:`1px solid ${fetchStatus==='loading'?"rgba(59,130,246,.2)":fetchStatus==='success'?"rgba(16,185,129,.2)":fetchStatus==='partial'?"rgba(234,179,8,.2)":"rgba(239,68,68,.2)"}`,
              color:fetchStatus==='loading'?"#93c5fd":fetchStatus==='success'?"#6ee7b7":fetchStatus==='partial'?"#fcd34d":"#fca5a5"}}>
              {fetchStatus==='loading'&&<span>{fetchMsg}</span>}
              {fetchStatus==='success'&&<span>\u2713 {fetchMsg||`Live data loaded for ${Object.keys(liveData).length} tickers`}</span>}
              {fetchStatus==='partial'&&<span>\u26A0 {fetchError}</span>}
              {fetchStatus==='error'&&<span>\u2715 {fetchError}</span>}
              {(fetchStatus==='error'||fetchStatus==='partial')&&(
                <button onClick={()=>{const m=tickers.filter(t=>!liveData[t]);if(m.length)doFetch(m);}} style={{marginLeft:10,padding:"3px 10px",borderRadius:6,border:"1px solid rgba(255,255,255,.15)",fontSize:10,fontWeight:600,cursor:"pointer",background:"transparent",color:"inherit"}}>Retry</button>)}
            </div>
          )}

          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:16,marginTop:16}}>
            <div>
              <label style={{display:"flex",alignItems:"center",justifyContent:"space-between",fontSize:11,color:"#94a3b8",marginBottom:6,fontWeight:600}}>
                <span>Historical Lookback</span>
                <span style={{fontFamily:MO,color:"#818cf8",fontSize:13,fontWeight:700}}>{histYrs} yr{histYrs>1?'s':''}</span>
              </label>
              <input type="range" min={1} max={10} step={1} value={histYrs}
                onChange={e=>setHistYrs(parseInt(e.target.value))}
                style={{width:"100%",accentColor:"#818cf8"}} disabled={busy}/>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:"#475569",marginTop:2}}><span>1yr</span><span>5yr</span><span>10yr</span></div>
            </div>
            <div>
              <label style={{display:"flex",alignItems:"center",justifyContent:"space-between",fontSize:11,color:"#94a3b8",marginBottom:6,fontWeight:600}}>
                <span>Simulations</span>
                <span style={{fontFamily:MO,color:"#818cf8",fontSize:13,fontWeight:700}}>{numSims.toLocaleString()}</span>
              </label>
              <input type="range" min={100} max={5000} step={100} value={numSims}
                onChange={e=>setNumSims(parseInt(e.target.value))}
                style={{width:"100%",accentColor:"#818cf8"}} disabled={busy}/>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:"#475569",marginTop:2}}><span>100</span><span>2500</span><span>5000</span></div>
            </div>
          </div>

          {optMsg && (
            <div style={{marginBottom:12,padding:"8px 12px",borderRadius:8,fontSize:11,
              background:optMsg.includes('\u2713')?"rgba(16,185,129,.08)":optMsg.includes('failed')||optMsg.includes('required')?"rgba(239,68,68,.08)":"rgba(99,102,241,.08)",
              border:`1px solid ${optMsg.includes('\u2713')?"rgba(16,185,129,.2)":optMsg.includes('failed')||optMsg.includes('required')?"rgba(239,68,68,.2)":"rgba(99,102,241,.2)"}`,
              color:optMsg.includes('\u2713')?"#6ee7b7":optMsg.includes('failed')||optMsg.includes('required')?"#fca5a5":"#a5b4fc"}}>
              {busy && <span style={{display:"inline-block",width:10,height:10,border:"2px solid rgba(255,255,255,.2)",borderTopColor:"currentColor",borderRadius:"50%",animation:"spin 1s linear infinite",marginRight:6,verticalAlign:"middle"}}/>}
              {optMsg}
            </div>
          )}

          <button onClick={runOptimize} disabled={busy||tickers.length<2||!apiKey}
            style={{padding:"12px 30px",borderRadius:12,border:"none",fontWeight:700,fontSize:14,fontFamily:F,cursor:(busy||tickers.length<2||!apiKey)?"not-allowed":"pointer",background:busy?"#334155":(tickers.length<2||!apiKey)?"#1e293b":"linear-gradient(135deg,#818cf8,#6366f1)",color:(tickers.length<2||!apiKey)?"#475569":"#fff",boxShadow:(busy||tickers.length<2||!apiKey)?"none":"0 4px 20px rgba(99,102,241,.3)"}}>
            {busy?"Fetching & Optimizing...":!apiKey?"API key required to optimize":tickers.length<2?"Need 2+ stocks (have "+tickers.length+")":`Optimize ${tickers.length} Stocks (${histYrs}yr historical data)`}</button>
        </div>

        {res&&(<>
          {/* Data source badge */}
          <div style={{marginBottom:12,display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
            <div style={{padding:"6px 14px",borderRadius:8,fontSize:11,fontWeight:700,
              background:"rgba(16,185,129,.1)",
              border:"1px solid rgba(16,185,129,.25)",
              color:"#6ee7b7"}}>
              {`\u2713 ${res.histYrs}yr Real Historical Data`}
            </div>
            {histStats && histStats.note && <span style={{fontSize:10,color:"#64748b"}}>{histStats.note}</span>}
          </div>

          {/* Historical stats panel */}
          {histStats && (
            <div style={{background:"#fff",borderRadius:14,padding:"16px 18px",border:"1px solid #e2e8f0",marginBottom:16}}>
              <h3 style={{fontSize:12,fontWeight:700,color:"#0f172a",margin:"0 0 10px",display:"flex",alignItems:"center",gap:6}}>
                <span style={{width:4,height:16,borderRadius:2,background:"#818cf8",display:"inline-block"}}/>
                Historical Return &amp; Volatility ({histStats.years || histYrs}yr)
              </h3>
              <div style={{overflowX:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                  <thead><tr style={{background:"#f8fafc"}}>
                    <th style={{padding:"6px 10px",textAlign:"left",fontWeight:700,color:"#475569",fontSize:9,textTransform:"uppercase",borderBottom:"2px solid #e2e8f0"}}>Ticker</th>
                    <th style={{padding:"6px 10px",textAlign:"right",fontWeight:700,color:"#059669",fontSize:9,textTransform:"uppercase",borderBottom:"2px solid #e2e8f0"}}>Ann. Return</th>
                    <th style={{padding:"6px 10px",textAlign:"right",fontWeight:700,color:"#ef4444",fontSize:9,textTransform:"uppercase",borderBottom:"2px solid #e2e8f0"}}>Ann. Vol</th>
                    <th style={{padding:"6px 10px",textAlign:"right",fontWeight:700,color:"#6366f1",fontSize:9,textTransform:"uppercase",borderBottom:"2px solid #e2e8f0"}}>Return/Vol</th>
                  </tr></thead>
                  <tbody>{tickers.map((t,i) => (
                    <tr key={t} style={{borderBottom:"1px solid #f1f5f9",background:i%2?"#fafbfc":"#fff"}}>
                      <td style={{padding:"6px 10px",fontWeight:700,fontFamily:MO,color:"#0f172a"}}>{t}</td>
                      <td style={{padding:"6px 10px",textAlign:"right",fontFamily:MO,fontWeight:600,color:histStats.mu[i]>=0?"#059669":"#ef4444"}}>{(histStats.mu[i]*100).toFixed(1)}%</td>
                      <td style={{padding:"6px 10px",textAlign:"right",fontFamily:MO,color:"#64748b"}}>{(histStats.vols[i]*100).toFixed(1)}%</td>
                      <td style={{padding:"6px 10px",textAlign:"right",fontFamily:MO,fontWeight:600,color:"#6366f1"}}>{histStats.vols[i]>0?(histStats.mu[i]/histStats.vols[i]).toFixed(2):'\u2014'}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>

              {/* Correlation heatmap */}
              {histStats.corr && tickers.length <= 12 && (
                <div style={{marginTop:12}}>
                  <div style={{fontSize:10,fontWeight:700,color:"#475569",marginBottom:6}}>Correlation Matrix</div>
                  <div style={{overflowX:"auto"}}>
                    <table style={{borderCollapse:"collapse",fontSize:9}}>
                      <thead><tr>
                        <th style={{padding:"3px 6px"}}/>
                        {tickers.map(t=><th key={t} style={{padding:"3px 6px",fontFamily:MO,fontWeight:700,color:"#475569",whiteSpace:"nowrap"}}>{t}</th>)}
                      </tr></thead>
                      <tbody>{tickers.map((t,i)=>(
                        <tr key={t}>
                          <td style={{padding:"3px 6px",fontFamily:MO,fontWeight:700,color:"#475569"}}>{t}</td>
                          {tickers.map((t2,j)=>{
                            const v = histStats.corr[i] && histStats.corr[i][j] != null ? Number(histStats.corr[i][j]) : 0;
                            const abs = Math.abs(v);
                            const bg = i===j ? '#e2e8f0' : v > 0 ? `rgba(16,185,129,${abs*0.5})` : `rgba(239,68,68,${abs*0.5})`;
                            return <td key={j} style={{padding:"3px 6px",textAlign:"center",fontFamily:MO,background:bg,borderRadius:2,fontWeight:abs>0.5?700:400,color:abs>0.6?"#fff":"#334155"}}>{v.toFixed(2)}</td>;
                          })}
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Variance-Covariance Matrix for selected portfolio */}
          {histStats && histStats.cov && port && (
            <CovarianceMatrixTable
              tickers={tickers}
              cov={histStats.cov}
              weights={port.weights}
              title={`Variance-Covariance Matrix \u2014 ${tab === "maxSharpe" ? "Max Sharpe" : "Min Variance"} Portfolio (${histStats.years || histYrs}yr)`}
            />
          )}

          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(175px,1fr))",gap:12,marginBottom:20}}>
            {[{l:"Min Var Return",v:fmt(res.minVar.ret),s:"Vol: "+fmt(res.minVar.vol),c:"#10b981"},{l:"Min Var Sharpe",v:fN(res.minVar.sharpe),c:"#10b981"},{l:"Max Sharpe Return",v:fmt(res.maxSharpe.ret),s:"Vol: "+fmt(res.maxSharpe.vol),c:"#f59e0b"},{l:"Max Sharpe Ratio",v:fN(res.maxSharpe.sharpe),c:"#f59e0b"},{l:"Avg MSR Return",v:fmt(res.avgMSR),s:"Avg MVR: "+fmt(res.avgMVR),c:"#818cf8"},{l:"Avg Sharpe",v:fN(res.avgSh),s:numSims+" sims \u00b7 "+res.histYrs+"yr historical",c:"#818cf8"}].map((card,i)=>(
              <div key={i} style={{background:"#fff",borderRadius:14,padding:"16px 18px",border:"1px solid #e2e8f0",position:"relative",overflow:"hidden"}}>
                <div style={{position:"absolute",top:0,left:0,width:4,height:"100%",background:card.c}}/>
                <div style={{fontSize:10,color:"#94a3b8",fontWeight:700,textTransform:"uppercase",letterSpacing:1.2,marginBottom:5}}>{card.l}</div>
                <div style={{fontSize:22,fontWeight:800,color:"#0f172a",fontFamily:MO}}>{card.v}</div>
                {card.s&&<div style={{fontSize:11,color:"#64748b",marginTop:3}}>{card.s}</div>}
              </div>))}
          </div>

          <div style={{background:"#fff",borderRadius:16,padding:22,marginBottom:20,border:"1px solid #e2e8f0"}}>
            <h3 style={{fontSize:14,fontWeight:700,color:"#0f172a",margin:"0 0 12px"}}>Efficient Frontier</h3>
            <ResponsiveContainer width="100%" height={260}>
              <ScatterChart margin={{top:10,right:20,bottom:40,left:50}}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9"/>
                <XAxis dataKey="x" type="number" name="Vol" unit="%" domain={["auto","auto"]} tick={{fontSize:11,fill:"#64748b"}} label={{value:"Volatility (%)",position:"insideBottom",offset:-12,fontSize:12,fill:"#94a3b8"}}/>
                <YAxis dataKey="y" type="number" name="Ret" unit="%" domain={["auto","auto"]} tick={{fontSize:11,fill:"#64748b"}} label={{value:"Return (%)",angle:-90,position:"insideLeft",fontSize:12,fill:"#94a3b8"}}/>
                <Tooltip formatter={v=>Number(v).toFixed(2)+"%"} contentStyle={{fontSize:12,borderRadius:8,border:"1px solid #e2e8f0"}}/>
                <Legend wrapperStyle={{fontSize:12}}/>
                <Scatter name="Random" data={res.frontier} fill="#cbd5e1" fillOpacity={.3}/>
                <Scatter name="Min Var" data={[{x:+(res.minVar.vol*100).toFixed(3),y:+(res.minVar.ret*100).toFixed(3)}]} fill="#10b981" shape="star"/>
                <Scatter name="Max Sharpe" data={[{x:+(res.maxSharpe.vol*100).toFixed(3),y:+(res.maxSharpe.ret*100).toFixed(3)}]} fill="#f59e0b" shape="star"/>
              </ScatterChart>
            </ResponsiveContainer>
          </div>

          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(480px,1fr))",gap:16,marginBottom:20}}>
            <LiveAnalysisTable title="Min Variance \u2013 Live Analysis" tickers={tickers} weights={res.minVar.weights} stocks={stocks} liveData={liveData} accentColor="#10b981" loading={fetching}/>
            <LiveAnalysisTable title="Max Sharpe \u2013 Live Analysis" tickers={tickers} weights={res.maxSharpe.weights} stocks={stocks} liveData={liveData} accentColor="#f59e0b" loading={fetching}/>
          </div>

          <div style={{display:"flex",gap:4,marginBottom:4,padding:4,background:"rgba(255,255,255,.04)",borderRadius:14,width:"fit-content"}}>
            {[{id:"maxSharpe",l:"Max Sharpe",c:"#f59e0b"},{id:"minVar",l:"Min Variance",c:"#10b981"}].map(tb=>(
              <button key={tb.id} onClick={()=>setTab(tb.id)} style={{padding:"8px 18px",borderRadius:10,border:"none",fontSize:12,fontWeight:700,fontFamily:F,cursor:"pointer",background:tab===tb.id?"rgba(255,255,255,.1)":"transparent",color:tab===tb.id?tb.c:"#64748b"}}>{tb.l}</button>))}
          </div>

          <div style={{background:"#fff",borderRadius:16,overflow:"hidden",border:"1px solid #e2e8f0",marginBottom:20}}>
            <div style={{overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
                <thead><tr style={{background:"#f8fafc"}}>
                  {["Stock","Weight","Price","Sector"].map((h,i)=>(
                    <th key={i} style={{padding:"10px",textAlign:i<2?"left":"right",borderBottom:"2px solid #e2e8f0",fontSize:10,fontWeight:700,color:"#475569",textTransform:"uppercase"}}>{h}</th>))}
                </tr></thead>
                <tbody>{rows.map((r,i)=>{
                  const displayName = TICKER_NAMES[r.ticker] || r.name || r.ticker;
                  return (
                  <tr key={r.ticker} style={{background:i%2===0?"#fff":"#fafbfc",borderBottom:"1px solid #f1f5f9"}}>
                    <td style={{padding:"9px 10px",fontWeight:700,color:"#0f172a"}}><div style={{display:"flex",alignItems:"center",gap:7}}><div style={{width:3,height:24,borderRadius:2,background:SEC_CLR[r.sector]||"#94a3b8"}}/><div><div style={{fontFamily:MO,fontSize:13}}>{r.ticker}</div><div style={{fontSize:9,color:"#94a3b8"}}>{displayName}</div></div></div></td>
                    <td style={{padding:"9px 10px"}}><div style={{display:"flex",alignItems:"center",gap:7}}><div style={{width:55,height:5,borderRadius:3,background:"#f1f5f9",overflow:"hidden"}}><div style={{width:Math.min(r.w*100*3,100)+"%",height:"100%",borderRadius:3,background:tab==="maxSharpe"?"#f59e0b":"#10b981"}}/></div><span style={{fontFamily:MO,fontWeight:700,color:"#0f172a",fontSize:12}}>{(r.w*100).toFixed(1)}%</span></div></td>
                    <td style={{padding:"9px 10px",textAlign:"right"}}><span style={{fontFamily:MO,fontWeight:700,color:"#059669"}}>${r.price?.toFixed(2)}</span></td>
                    <td style={{padding:"9px 10px",textAlign:"right"}}><span style={{fontSize:10,padding:"2px 8px",borderRadius:5,fontWeight:600,background:(SEC_CLR[r.sector]||"#64748b")+"18",color:SEC_CLR[r.sector]||"#64748b"}}>{r.sector}</span></td>
                  </tr>);})}</tbody>
              </table>
            </div>
            <div style={{borderTop:"2px solid #e2e8f0",background:"#f8fafc",padding:"12px 16px"}}>
              <div style={{fontSize:10,color:"#94a3b8",fontWeight:700,textTransform:"uppercase",letterSpacing:1,marginBottom:6}}>Allocation per $10,000</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                {rows.filter(r=>r.w>.01).map(r=>(
                  <div key={r.ticker} style={{fontFamily:MO,fontSize:12,padding:"3px 8px",borderRadius:6,background:"rgba(99,102,241,.06)",color:"#334155"}}>
                    {r.ticker}: <span style={{fontWeight:700,color:"#6366f1"}}>${(r.w*10000).toFixed(0)}</span>
                    {r.price > 0 && <span style={{color:"#94a3b8",fontSize:10}}> ({Math.floor((r.w*10000)/r.price)} sh)</span>}
                  </div>))}
              </div>
            </div>
          </div>

          <div style={{background:"rgba(234,179,8,.06)",border:"1px solid rgba(234,179,8,.15)",borderRadius:12,padding:"10px 14px",marginBottom:20,display:"flex",gap:8}}>
            <span style={{fontSize:15}}>\u26A0</span>
            <div style={{fontSize:11,color:"#a16207",lineHeight:1.6}}><strong>Disclaimer:</strong> Prices may be delayed. Monte Carlo optimization uses historical returns sourced via web search. Analyst data fetched dynamically \u2014 per-field dates shown. <b>Verify before trading.</b> Not financial advice.</div>
          </div>
        </>)}

        {!res&&tickers.length>=2&&!busy&&(
          <div style={{background:"rgba(255,255,255,.03)",border:"1px solid rgba(255,255,255,.06)",borderRadius:16,padding:"36px 24px",textAlign:"center"}}>
            <div style={{fontSize:36,marginBottom:10,opacity:.3}}>\uD83D\uDCCA</div>
            <h3 style={{fontSize:16,fontWeight:700,color:"#94a3b8",margin:"0 0 4px"}}>{tickers.length} stocks ready</h3>
            <p style={{fontSize:12,color:"#475569",margin:0}}>{apiKey ? `Click Optimize to fetch ${histYrs}yr historical data & run ${numSims.toLocaleString()} simulations.` : 'Enter your API key above, then click Optimize to fetch historical data and run Monte Carlo simulations.'}</p>
          </div>)}
      </div>
    </div>
  );
}
