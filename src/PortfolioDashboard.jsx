import React, { lazy, Suspense, useState, useCallback, useMemo, useRef } from "react";
import { solveDeterministicPortfolioSet } from "./lib/qpOptimizer.js";

const EfficientFrontierChart = lazy(() => import("./EfficientFrontierChart.jsx"));

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

const YAHOO_TICKER_ALIASES = {
  SQ: "XYZ",
};

/* ═══════════════════════════════════════════════════════════════════════════
   LIVE DATA FETCHING (Finnhub + FMP via /api/quotes)
   ═══════════════════════════════════════════════════════════════════════════ */

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const PRICE_CACHE_KEY = 'portfolio_dashboard_finnhub_cache_v1';
const PROVIDER_COOLDOWN_MS = 5 * 60 * 1000;
let providerBlockedUntil = 0;
let providerBlockReason = '';

function apiPath(path) {
  const base = import.meta.env.BASE_URL || "/";
  const cleanBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const cleanPath = String(path || "").replace(/^\/+/, "");
  return `${cleanBase}/api/${cleanPath}`;
}

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(id);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function retryAfterMs(headerVal) {
  if (!headerVal) return null;
  const n = Number(headerVal);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const abs = Date.parse(headerVal);
  if (!Number.isNaN(abs)) return Math.max(0, abs - Date.now());
  return null;
}

function isProviderBlocked() {
  return Date.now() < providerBlockedUntil;
}

function noteProviderBlocked(reason, retryAfter) {
  const wait = Number.isFinite(retryAfter) ? Math.max(30 * 1000, retryAfter) : PROVIDER_COOLDOWN_MS;
  providerBlockedUntil = Date.now() + wait;
  providerBlockReason = reason || 'Provider returned HTTP 429';
}

function loadPriceCache() {
  try {
    const raw = localStorage.getItem(PRICE_CACHE_KEY);
    const data = raw ? JSON.parse(raw) : {};
    return (data && typeof data === 'object') ? data : {};
  } catch {
    return {};
  }
}

function savePriceCache(dataByTicker) {
  try {
    const existing = loadPriceCache();
    const merged = { ...existing, ...dataByTicker };
    localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(merged));
  } catch {
    // ignore storage failures
  }
}

function buildAnalysisDataFromRaw(raw, ticker, sourceLabel = 'Finnhub') {
  const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const marketDate = raw.time
    ? new Date(raw.time * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : dateStr;
  const prev = Number(raw.prev) || 0;
  const price = Number(raw.price) || 0;
  const change = prev > 0 ? ((price / prev - 1) * 100).toFixed(2) : 0;
  const targetPrice = Number(raw.targetPrice) || 0;
  const upside = price > 0 && targetPrice > 0 ? ((targetPrice / price - 1) * 100) : 0;
  const rating = raw.rating || 'N/A';
  const analystCount = Number(raw.analystCount) || 0;
  const name = raw.name || ticker;
  return {
    latestPrice: price,
    priceSource: `${sourceLabel} (${raw.exchange || 'LIVE'})`,
    priceDate: marketDate,
    targetPrice,
    targetSource: targetPrice > 0 ? 'FMP Consensus' : 'N/A',
    targetDate: raw.targetDate || marketDate,
    entryPrice: +(price * 0.95).toFixed(2),
    entrySource: 'Calculated: 5% below current',
    entryDate: marketDate,
    rating,
    ratingSource: rating !== 'N/A' ? 'FMP' : 'N/A',
    ratingDate: raw.ratingDate || marketDate,
    analystCount,
    upside,
    upsideSource: targetPrice > 0 ? 'Derived from FMP target' : 'N/A',
    upsideDate: targetPrice > 0 ? (raw.targetDate || marketDate) : 'N/A',
    reasoning: `${name}: $${price.toFixed(2)} (${change >= 0 ? '+' : ''}${change}% vs prev $${prev.toFixed(2)})${targetPrice > 0 ? `, target $${targetPrice.toFixed(2)}` : ''}`,
    reasoningSource: 'Finnhub',
    reasoningDate: marketDate,
    sentiment: rating === 'Strong Buy' || rating === 'Buy' ? 'Bullish' : rating === 'Sell' || rating === 'Strong Sell' ? 'Bearish' : 'Neutral',
    catalysts: [name, `Prev $${prev.toFixed(2)}`, ...(targetPrice > 0 ? [`Target $${targetPrice.toFixed(2)}`] : [])]
  };
}

async function fetchWithRetry(url, signal, { attempts = 4, baseDelayMs = 450 } = {}) {
  if (isProviderBlocked()) {
    throw new Error(`PROVIDER_BLOCKED:${providerBlockReason}`);
  }
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      const res = await fetch(url, { signal });
      if (res.ok) return res;
      if (res.status === 429) {
        noteProviderBlocked('Finnhub rate limited (429)', retryAfterMs(res.headers.get('retry-after')));
        throw new Error('429');
      }
      if (!RETRYABLE.has(res.status) || i === attempts - 1) {
        let details = '';
        try {
          const body = await res.text();
          details = body ? ` ${body.slice(0, 220)}` : '';
        } catch {
          // ignore body parse errors
        }
        throw new Error(`HTTP ${res.status}.${details}`.trim());
      }
      const retryMs = retryAfterMs(res.headers.get('retry-after'));
      const backoff = retryMs ?? Math.min(5000, baseDelayMs * (2 ** i)) + Math.floor(Math.random() * 200);
      await sleep(backoff, signal);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastErr = e;
      if (i === attempts - 1) throw e;
      await sleep(Math.min(5000, baseDelayMs * (2 ** i)) + Math.floor(Math.random() * 200), signal);
    }
  }
  throw lastErr || new Error('fetch failed');
}

async function fetchFinnhubBatchQuotes(tickers, signal) {
  if (!tickers.length) return {};
  const symbols = tickers.map((t) => t.trim().toUpperCase()).filter(Boolean).join(',');
  const res = await fetchWithRetry(`${apiPath("quotes")}?symbols=${encodeURIComponent(symbols)}`, signal, { attempts: 3, baseDelayMs: 500 });
  const json = await res.json();
  const out = {};
  for (const [ticker, q] of Object.entries(json.quotes || {})) {
    if (!q?.price || q.price <= 0) continue;
    out[ticker] = {
      price: Number(q.price),
      prev: Number(q.prev) || 0,
      name: q.name || ticker,
      exchange: q.exchange || '',
      time: Number(q.time) || Math.floor(Date.now() / 1000),
      targetPrice: Number(q.targetPrice) || 0,
      targetDate: q.targetDate || '',
      analystCount: Number(q.analystCount) || 0,
      rating: q.rating || 'N/A',
      ratingDate: q.ratingDate || '',
    };
  }
  return out;
}

async function fetchAllLiveData(tickers, signal, onEach) {
  const results = {};
  const BATCH_SIZE = 25;
  const PAUSE_MS = 300;
  const priceCache = loadPriceCache();
  const cacheUpdates = {};

  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    if (signal?.aborted) break;
    const batch = tickers.slice(i, i + BATCH_SIZE);

    let batchQuotes = {};
    try {
      batchQuotes = await fetchFinnhubBatchQuotes(batch, signal);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      console.warn('[Finnhub] batch quote failed:', e.message);
      if (String(e?.message || '').startsWith('PROVIDER_BLOCKED:')) {
        break;
      }
    }

    for (const t of batch) {
      const raw = batchQuotes[t];
      if (!raw) continue;
      const finalData = buildAnalysisDataFromRaw(raw, t, 'Finnhub');
      results[t] = finalData;
      cacheUpdates[t] = finalData;
      if (onEach) onEach(t, finalData, Object.keys(results).length, tickers.length);
    }
    if (i + BATCH_SIZE < tickers.length) await sleep(PAUSE_MS, signal);
  }

  if (Object.keys(cacheUpdates).length) {
    savePriceCache(cacheUpdates);
  }

  if (isProviderBlocked() || Object.keys(results).length < tickers.length) {
    for (const t of tickers) {
      if (results[t]) continue;
      const cached = priceCache[t];
      if (!cached) continue;
      const stale = {
        ...cached,
        priceSource: `${cached.priceSource || 'Cached'} - Cached`,
        reasoningSource: 'Local Cache',
        sentiment: cached.sentiment || 'Neutral',
      };
      results[t] = stale;
      if (onEach) onEach(t, stale, Object.keys(results).length, tickers.length);
    }
  }

  return results;
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
   HISTORICAL STATS — downloads prices from Yahoo Finance, computes locally
   ═══════════════════════════════════════════════════════════════════════════ */

async function fetchYahooPrices(ticker, years, signal) {
  const now = Math.floor(Date.now() / 1000);
  const period1 = Math.floor(now - years * 365.25 * 86400);
  const yahooTicker = YAHOO_TICKER_ALIASES[ticker] || ticker;
  const url = `${apiPath("yahoo-chart")}?ticker=${encodeURIComponent(yahooTicker)}&period1=${period1}&period2=${now}`;

  const res = await fetch(url, { signal });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Yahoo proxy HTTP ${res.status} for ${ticker}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  return parseYahooChart(data, ticker);
}

function parseYahooChart(data, ticker) {
  const chart = data.chart;
  if (chart && chart.error) {
    throw new Error(`Yahoo Finance error for ${ticker}: ${chart.error.description || chart.error.code || 'Unknown'}`);
  }

  const result = chart?.result?.[0];
  if (!result || !result.timestamp) throw new Error(`No chart data returned for ${ticker}`);

  // Prefer adjusted close (accounts for dividends & splits), fall back to close
  const adjClose = result.indicators?.adjclose?.[0]?.adjclose;
  const rawClose = result.indicators?.quote?.[0]?.close;
  const closes = adjClose || rawClose;
  if (!closes) throw new Error(`No price data in response for ${ticker}`);

  const timestamps = result.timestamp;
  const monthly = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] != null && closes[i] > 0) {
      const d = new Date(timestamps[i] * 1000);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      monthly.push({ key, price: closes[i] });
    }
  }

  if (monthly.length < 3) throw new Error(`Only ${monthly.length} monthly data points for ${ticker}. Need at least 3.`);
  console.log(`[HistPrices] ${ticker}: ${monthly.length} months (${monthly[0].key} → ${monthly[monthly.length - 1].key})`);
  return monthly;
}

function computeStatsFromPrices(priceData, tickers, years) {
  const n = tickers.length;

  // Find common months across all tickers
  const monthSets = tickers.map(t => new Set(priceData[t].map(p => p.key)));
  const commonMonths = [...monthSets[0]].filter(m => monthSets.every(s => s.has(m))).sort();

  if (commonMonths.length < 4) {
    throw new Error(`Only ${commonMonths.length} common months across all tickers. Need at least 4 for meaningful statistics.`);
  }

  // Build aligned price series using common months
  const priceMaps = tickers.map(t =>
    Object.fromEntries(priceData[t].map(p => [p.key, p.price]))
  );
  const aligned = tickers.map((t, idx) =>
    commonMonths.map(m => priceMaps[idx][m])
  );

  // Compute monthly log returns
  const returns = aligned.map(prices => {
    const r = [];
    for (let i = 1; i < prices.length; i++) {
      if (prices[i] > 0 && prices[i - 1] > 0) {
        r.push(Math.log(prices[i] / prices[i - 1]));
      } else {
        r.push(0);
      }
    }
    return r;
  });

  const T = returns[0].length;
  if (T < 3) throw new Error(`Only ${T} return observations. Need at least 3.`);

  // Annualized mean returns and volatilities (monthly → annual)
  const means = returns.map(r => r.reduce((s, v) => s + v, 0) / T);
  const mu = means.map(m => m * 12);
  const vols = returns.map((r, idx) => {
    const m = means[idx];
    const variance = r.reduce((s, v) => s + (v - m) ** 2, 0) / (T - 1);
    return Math.sqrt(Math.max(variance * 12, 1e-8));
  });

  // Pairwise correlation matrix
  const corr = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => {
      if (i === j) return 1.0;
      const mi = means[i], mj = means[j];
      let covSum = 0, vi = 0, vj = 0;
      for (let k = 0; k < T; k++) {
        const di = returns[i][k] - mi;
        const dj = returns[j][k] - mj;
        covSum += di * dj;
        vi += di * di;
        vj += dj * dj;
      }
      return (vi > 0 && vj > 0) ? covSum / Math.sqrt(vi * vj) : 0;
    })
  );

  // Covariance matrix from correlation and volatilities
  const cov = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => corr[i][j] * vols[i] * vols[j])
  );

  const firstMonth = commonMonths[0];
  const lastMonth = commonMonths[commonMonths.length - 1];

  return {
    mu, cov, vols, corr, assetReturns: returns,
    years,
    months: T,
    note: `Computed from ${T} monthly returns (${firstMonth} to ${lastMonth}), Yahoo Finance adj. close`
  };
}

async function fetchHistoricalStats(tickers, years, _apiKey, signal) {
  const n = tickers.length;
  const priceData = {};

  console.log(`[HistStats] Downloading ${years}yr monthly prices for ${n} tickers from Yahoo Finance...`);

  // Fetch all tickers in parallel
  const results = await Promise.allSettled(
    tickers.map(t => fetchYahooPrices(t, years, signal))
  );

  const failed = [];
  for (let i = 0; i < n; i++) {
    if (results[i].status === 'fulfilled') {
      priceData[tickers[i]] = results[i].value;
    } else {
      failed.push({ ticker: tickers[i], reason: results[i].reason?.message || 'Unknown error' });
      console.error(`[HistStats] Failed ${tickers[i]}:`, results[i].reason);
    }
  }

  if (failed.length > 0) {
    const details = failed.map(f => `${f.ticker} (${f.reason})`).join('; ');
    throw new Error(`Failed to download prices for: ${details}`);
  }

  return computeStatsFromPrices(priceData, tickers, years);
}

/* ═══════════════════════════════════════════════════════════════════════════
   MONTE CARLO — uses historical mu/cov only (no synthetic fallback)
   ═══════════════════════════════════════════════════════════════════════════ */

class RNG{constructor(s){this.s=s;}next(){this.s=(this.s*1103515245+12345)&0x7fffffff;return this.s/0x7fffffff;}}
function portStats(w,mu,cov,rf){const ret=w.reduce((s,wi,i)=>s+wi*mu[i],0);let v=0;for(let i=0;i<w.length;i++)for(let j=0;j<w.length;j++)v+=w[i]*w[j]*cov[i][j];const vol=Math.sqrt(Math.max(v,1e-6));return{ret,vol,sharpe:(ret-rf)/vol};}
function randWeights(n,g){const w=Array.from({length:n},()=>g.next());const s=w.reduce((a,b)=>a+b,0);return w.map(v=>v/s);}

function optimizeWithData(mu, cov, rf, iter=8000, minVarVolCap = 0.2) {
  const n = mu.length;
  const seed = mu.reduce((s,v,i) => s + Math.abs(v) * 1000 * (i+1), 42);
  const g = new RNG(seed + 1);
  let trueMV = { vol: Infinity }, bMS = { sharpe: -Infinity };
  const allPorts = [];
  const fr = [], allSh = [], allMVR = [], allMSR = [];
  for (let i = 0; i < iter; i++) {
    const w = randWeights(n, g);
    const s = portStats(w, mu, cov, rf);
    const p = { simNumber: i + 1, weights: [...w], ...s };
    allPorts.push(p);

    if (s.vol < trueMV.vol) trueMV = p;
    if (s.sharpe > bMS.sharpe) bMS = p;

    allMVR.push(s.ret);
    allMSR.push(s.ret);
    allSh.push(s.sharpe);

    if (i % 10 === 0) fr.push({ x: +(s.vol * 100).toFixed(3), y: +(s.ret * 100).toFixed(3) });
  }

  const cappedPorts = allPorts.filter((p) => p.vol <= minVarVolCap);
  const bMV = cappedPorts.reduce((best, p) => (p.sharpe > best.sharpe ? p : best), cappedPorts[0] || trueMV);

  const avg = a => a.reduce((s, v) => s + v, 0) / a.length;
  return {
    minVar: bMV,
    trueMinVar: trueMV,
    maxSharpe: bMS,
    frontier: fr,
    avgMSR: avg(allMSR),
    avgMVR: avg(allMVR),
    avgSh: avg(allSh),
    minVarCap: minVarVolCap,
    minVarEligibleCount: cappedPorts.length
  };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function deterministicOptimize(mu, cov, rf, minVarVolCap = 0.2) {
  return solveDeterministicPortfolioSet(mu, cov, minVarVolCap, rf);
}

async function buildModeledExpectedReturns(tickers, histMu, signal) {
  const quotes = await fetchFinnhubBatchQuotes(tickers, signal);
  let targetBased = 0;
  let fallbackHistorical = 0;
  const modeledMu = tickers.map((t, i) => {
    const hist = Number(histMu[i]) || 0;
    const q = quotes[t];
    const price = Number(q?.price);
    const target = Number(q?.targetPrice);
    const analysts = Number(q?.analystCount) || 0;
    if (price > 0 && target > 0) {
      const impliedLog = clamp(Math.log(target / price), -0.9, 0.9);
      const confidence = clamp(analysts / 25, 0, 1);
      const blend = 0.25 + 0.75 * confidence;
      targetBased += 1;
      return (blend * impliedLog) + ((1 - blend) * hist);
    }
    fallbackHistorical += 1;
    return hist;
  });
  return { modeledMu, targetBased, fallbackHistorical };
}

function computeOneInNYearWorstLoss(assetLogReturns, weights) {
  if (!assetLogReturns || !assetLogReturns.length || !weights || !weights.length) return null;
  const months = assetLogReturns[0]?.length || 0;
  if (months < 1) return null;

  const portMonthlyLog = Array.from({ length: months }, (_, k) =>
    assetLogReturns.reduce((sum, series, i) => sum + (weights[i] || 0) * (series[k] || 0), 0)
  );

  const annualWindow = 12;
  const rollingReturns = [];
  if (months >= annualWindow) {
    for (let end = annualWindow - 1; end < months; end++) {
      let logSum = 0;
      for (let i = end - annualWindow + 1; i <= end; i++) logSum += portMonthlyLog[i];
      rollingReturns.push(Math.exp(logSum) - 1);
    }
  } else {
    for (const r of portMonthlyLog) rollingReturns.push(Math.exp(r) - 1);
  }

  if (!rollingReturns.length) return null;
  return {
    worstLoss: Math.min(...rollingReturns),
    years: months / 12,
    samples: rollingReturns.length,
    windowMonths: months >= annualWindow ? annualWindow : 1
  };
}

function normalInv(p) {
  const a = [-39.6968302866538,220.946098424521,-275.928510446969,138.357751867269,-30.6647980661472,2.50662827745924];
  const b = [-54.4760987982241,161.585836858041,-155.698979859887,66.8013118877197,-13.2806815528857];
  const c = [-0.00778489400243029,-0.322396458041136,-2.40075827716184,-2.54973253934373,4.37466414146497,2.93816398269878];
  const d = [0.00778469570904146,0.32246712907004,2.445134137143,3.75440866190742];
  const plow = 0.02425;
  const phigh = 1 - plow;
  if (p <= 0 || p >= 1) return NaN;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  if (p > phigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5]) * q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
}

function computeParametricVaR(assetLogReturns, weights, oneInYears) {
  if (!assetLogReturns || !assetLogReturns.length || !weights || !weights.length) return null;
  const months = assetLogReturns[0]?.length || 0;
  if (months < 1) return null;
  const portMonthlyLog = Array.from({ length: months }, (_, k) =>
    assetLogReturns.reduce((sum, series, i) => sum + (weights[i] || 0) * (series[k] || 0), 0)
  );
  const meanM = portMonthlyLog.reduce((s, v) => s + v, 0) / months;
  const varM = months > 1 ? portMonthlyLog.reduce((s, v) => s + (v - meanM) ** 2, 0) / (months - 1) : 0;
  const sigmaM = Math.sqrt(Math.max(varM, 0));
  const muA = meanM * 12;
  const sigmaA = sigmaM * Math.sqrt(12);
  const years = Math.max(1, Number(oneInYears) || 1);
  const tailP = clamp(1 / years, 0.001, 0.5);
  const z = normalInv(tailP);
  const annualLogQuantile = muA + z * sigmaA;
  return {
    worstLoss: Math.exp(annualLogQuantile) - 1,
    years,
    samples: months,
    windowMonths: 12
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   STYLES
   ═══════════════════════════════════════════════════════════════════════════ */

const SEC_CLR={Tech:'#6366f1',Semis:'#8b5cf6',Finance:'#0ea5e9',Retail:'#f59e0b',Health:'#10b981',Staples:'#84cc16',Energy:'#ef4444',Industrials:'#94a3b8',Materials:'#78716c',REIT:'#c084fc',Utilities:'#06b6d4',Telecom:'#e879f9',Autos:'#fb923c',Cannabis:'#22c55e',Crypto:'#fbbf24',Other:'#64748b'};
const F="'Instrument Sans','DM Sans',system-ui,sans-serif";
const MO="'DM Mono','JetBrains Mono',monospace";
const TH={padding:"10px 12px",textAlign:"right",borderBottom:"2px solid #e2e8f0",fontSize:14,fontWeight:700,color:"#475569",textTransform:"uppercase",letterSpacing:.5,whiteSpace:"nowrap"};

const recColors = {"Strong Buy":"#059669","Buy":"#10b981","Hold":"#eab308","Sell":"#f87171","Strong Sell":"#ef4444"};

const RatingBadge = ({ rating }) => {
  const col = recColors[rating] || "#94a3b8";
  return <span style={{padding:"3px 8px",borderRadius:10,fontSize:14,fontWeight:700,background:col+"20",color:col}}>{rating}</span>;
};

/* ═══════════════════════════════════════════════════════════════════════════
   VARIANCE-COVARIANCE MATRIX DISPLAY
   ═══════════════════════════════════════════════════════════════════════════ */

function CorrelationMatrixTable({ tickers, corr, title }) {
  if (!corr || !tickers || tickers.length === 0) return null;
  const n = tickers.length;
  const offDiag = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i !== j) offDiag.push(Number(corr[i]?.[j] ?? 0));
    }
  }
  const avgCorr = offDiag.length ? offDiag.reduce((s, v) => s + v, 0) / offDiag.length : 0;
  const minCorr = offDiag.length ? Math.min(...offDiag) : 0;
  const maxCorr = offDiag.length ? Math.max(...offDiag) : 0;
  const avgAbsCorr = offDiag.length ? offDiag.reduce((s, v) => s + Math.abs(v), 0) / offDiag.length : 0;

  return (
    <div style={{background:"#fff",borderRadius:16,border:"1px solid #e2e8f0",boxShadow:"0 8px 20px rgba(15,23,42,.05)",overflow:"hidden",marginBottom:16}}>
      <div style={{padding:16,display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap",borderBottom:"1px solid #f1f5f9"}}>
        <div>
          <h3 style={{fontSize:14,fontWeight:700,color:"#0f172a",margin:0}}>{title || "Correlation Matrix"}</h3>
          <div style={{fontSize:13,color:"#64748b",marginTop:2}}>{n}x{n} pairwise correlation matrix</div>
        </div>
        <div style={{fontSize:13,color:"#64748b",textAlign:"right"}}>
          <div>Range: {minCorr.toFixed(2)} to {maxCorr.toFixed(2)}</div>
          <div>Avg |corr|: {avgAbsCorr.toFixed(2)}</div>
        </div>
      </div>

      <div style={{padding:16}}>
        <div style={{overflowX:"auto",overflowY:"auto",maxHeight:500,border:"1px solid #e2e8f0",borderRadius:10}}>
          <table style={{borderCollapse:"collapse",fontSize:13,minWidth:`${(n + 1) * 72}px`}}>
            <thead style={{position:"sticky",top:0,zIndex:5}}>
              <tr>
                <th style={{padding:"8px 10px",background:"#f1f5f9",borderBottom:"1px solid #e2e8f0",borderRight:"1px solid #e2e8f0",textAlign:"left",color:"#475569",fontWeight:700}}>Corr</th>
                {tickers.map((t) => (
                  <th key={t} style={{padding:"8px 10px",background:"#f1f5f9",borderBottom:"1px solid #e2e8f0",textAlign:"center",color:"#475569",fontWeight:700,fontFamily:MO}}>{t}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tickers.map((t, i) => (
                <tr key={t}>
                  <td style={{padding:"7px 10px",background:"#f8fafc",borderRight:"1px solid #e2e8f0",color:"#475569",fontWeight:700,fontFamily:MO}}>{t}</td>
                  {tickers.map((_, j) => {
                    const v = Number(corr[i]?.[j] ?? 0);
                    const abs = Math.abs(v);
                    const bg = i === j ? "#e2e8f0" : v >= 0 ? `rgba(16,185,129,${Math.max(0.06, abs * 0.35)})` : `rgba(239,68,68,${Math.max(0.06, abs * 0.35)})`;
                    return (
                      <td key={`${i}-${j}`} style={{padding:"7px 10px",textAlign:"center",fontFamily:MO,borderBottom:"1px solid #f1f5f9",background:bg,fontWeight:i===j?700:500,color:"#334155"}}>
                        {v.toFixed(2)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{marginTop:12,display:"grid",gridTemplateColumns:"repeat(4,minmax(0,1fr))",gap:10}}>
          <div style={{background:"#f8fafc",borderRadius:8,padding:"8px 10px",textAlign:"center"}}><div style={{fontSize:12,color:"#64748b"}}>Avg Corr</div><div style={{fontSize:14,fontFamily:MO,fontWeight:700,color:"#334155"}}>{avgCorr.toFixed(2)}</div></div>
          <div style={{background:"#f8fafc",borderRadius:8,padding:"8px 10px",textAlign:"center"}}><div style={{fontSize:12,color:"#64748b"}}>Max Corr</div><div style={{fontSize:14,fontFamily:MO,fontWeight:700,color:"#059669"}}>{maxCorr.toFixed(2)}</div></div>
          <div style={{background:"#f8fafc",borderRadius:8,padding:"8px 10px",textAlign:"center"}}><div style={{fontSize:12,color:"#64748b"}}>Min Corr</div><div style={{fontSize:14,fontFamily:MO,fontWeight:700,color:"#ef4444"}}>{minCorr.toFixed(2)}</div></div>
          <div style={{background:"#f8fafc",borderRadius:8,padding:"8px 10px",textAlign:"center"}}><div style={{fontSize:12,color:"#64748b"}}>Avg |Corr|</div><div style={{fontSize:14,fontFamily:MO,fontWeight:700,color:"#1d4ed8"}}>{avgAbsCorr.toFixed(2)}</div></div>
        </div>
      </div>
    </div>
  );
}

function CovarianceMatrixTable({ tickers, cov, weights, title, activeLabel }) {
  if (!cov || !tickers || tickers.length === 0) return null;
  const n = tickers.length;
  const allVals = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) allVals.push(Number(cov[i]?.[j] ?? 0));
  const minCov = Math.min(...allVals);
  const maxCov = Math.max(...allVals);
  const diag = tickers.map((_, i) => Number(cov[i]?.[i] ?? 0));
  const avgVar = diag.length ? diag.reduce((s, v) => s + v, 0) / diag.length : 0;
  const range = maxCov - minCov || 1;
  const covCellBg = (v) => {
    const t = (v - minCov) / range;
    const r = Math.round(t < 0.5 ? 220 + (255 - 220) * (t / 0.5) : 255 - (255 - 239) * ((t - 0.5) / 0.5));
    const g = Math.round(t < 0.5 ? 230 + (255 - 230) * (t / 0.5) : 255 - (255 - 200) * ((t - 0.5) / 0.5));
    const b = Math.round(t < 0.5 ? 255 : 255 - (255 - 200) * ((t - 0.5) / 0.5));
    return `rgb(${r},${g},${b})`;
  };

  let portfolioVariance = 0;
  const contributions = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const c = (weights[i] || 0) * (weights[j] || 0) * (cov[i]?.[j] || 0);
      contributions[i][j] = c;
      portfolioVariance += c;
    }
  }
  const portfolioVol = Math.sqrt(Math.max(portfolioVariance, 0));

  return (
    <div style={{background:"#fff",borderRadius:16,border:"1px solid #e2e8f0",boxShadow:"0 8px 20px rgba(15,23,42,.05)",overflow:"hidden",marginBottom:16}}>
      <div style={{padding:16,display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap",borderBottom:"1px solid #f1f5f9"}}>
        <div>
          <h3 style={{fontSize:14,fontWeight:700,color:"#0f172a",margin:0}}>{title || "Variance-Covariance Matrix"}</h3>
          <div style={{fontSize:13,color:"#64748b",marginTop:2}}>{n}x{n} annualized covariance matrix</div>
        </div>
        <div style={{fontSize:13,color:"#64748b",textAlign:"right"}}>
          <div>Range: {(minCov * 100).toFixed(2)}% to {(maxCov * 100).toFixed(2)}%</div>
          <div>Avg var: {(avgVar * 100).toFixed(2)}%</div>
        </div>
      </div>

      <div style={{padding:16}}>
        <div style={{overflowX:"auto",overflowY:"auto",maxHeight:500,border:"1px solid #e2e8f0",borderRadius:10}}>
          <table style={{borderCollapse:"collapse",fontSize:13,minWidth:`${(n + 1) * 72}px`}}>
            <thead style={{position:"sticky",top:0,zIndex:5}}>
              <tr>
                <th style={{padding:"8px 10px",background:"#f1f5f9",borderBottom:"1px solid #e2e8f0",borderRight:"1px solid #e2e8f0",textAlign:"left",color:"#475569",fontWeight:700}}>Cov</th>
                {tickers.map((t) => (
                  <th key={t} style={{padding:"8px 10px",background:"#f1f5f9",borderBottom:"1px solid #e2e8f0",textAlign:"center",color:"#475569",fontWeight:700,fontFamily:MO}}>{t}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tickers.map((t, i) => (
                <tr key={t}>
                  <td style={{padding:"7px 10px",background:"#f8fafc",borderRight:"1px solid #e2e8f0",color:"#475569",fontWeight:700,fontFamily:MO}}>{t}</td>
                  {tickers.map((_, j) => {
                    const v = Number(cov[i]?.[j] ?? 0);
                    return (
                      <td key={`${i}-${j}`} style={{padding:"7px 10px",textAlign:"center",fontFamily:MO,borderBottom:"1px solid #f1f5f9",background:covCellBg(v),fontWeight:i===j?700:500,color:"#334155"}}>
                        {(v * 100).toFixed(2)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{marginTop:12,display:"grid",gridTemplateColumns:"repeat(4,minmax(0,1fr))",gap:10}}>
          <div style={{background:"#f8fafc",borderRadius:8,padding:"8px 10px",textAlign:"center"}}><div style={{fontSize:12,color:"#64748b"}}>Min Cov</div><div style={{fontSize:14,fontFamily:MO,fontWeight:700,color:"#1d4ed8"}}>{(minCov * 100).toFixed(4)}%</div></div>
          <div style={{background:"#f8fafc",borderRadius:8,padding:"8px 10px",textAlign:"center"}}><div style={{fontSize:12,color:"#64748b"}}>Max Cov</div><div style={{fontSize:14,fontFamily:MO,fontWeight:700,color:"#dc2626"}}>{(maxCov * 100).toFixed(4)}%</div></div>
          <div style={{background:"#f8fafc",borderRadius:8,padding:"8px 10px",textAlign:"center"}}><div style={{fontSize:12,color:"#64748b"}}>Avg Var</div><div style={{fontSize:14,fontFamily:MO,fontWeight:700,color:"#334155"}}>{(avgVar * 100).toFixed(4)}%</div></div>
          <div style={{background:"#f8fafc",borderRadius:8,padding:"8px 10px",textAlign:"center"}}><div style={{fontSize:12,color:"#64748b"}}>Port Vol</div><div style={{fontSize:14,fontFamily:MO,fontWeight:700,color:"#6366f1"}}>{(portfolioVol * 100).toFixed(2)}%</div></div>
        </div>
      </div>

      {weights && (
        <div style={{padding:"0 16px 16px"}}>
          <div style={{fontSize:14,fontWeight:700,color:"#334155",marginBottom:8}}>
            Weighted Contribution to Portfolio Variance (w_i x w_j x sigma_ij)
          </div>
          <div style={{overflowX:"auto",overflowY:"auto",maxHeight:420,border:"1px solid #e2e8f0",borderRadius:10}}>
            <table style={{borderCollapse:"collapse",fontSize:13,minWidth:`${(n + 2) * 72}px`}}>
              <thead style={{position:"sticky",top:0,zIndex:5}}>
                <tr>
                  <th style={{padding:"8px 10px",background:"#f1f5f9",borderBottom:"1px solid #e2e8f0",borderRight:"1px solid #e2e8f0",textAlign:"left",color:"#475569",fontWeight:700}}>w·Cov</th>
                  {tickers.map((t) => (
                    <th key={t} style={{padding:"8px 10px",background:"#f1f5f9",borderBottom:"1px solid #e2e8f0",textAlign:"center",color:"#475569",fontWeight:700,fontFamily:MO}}>{t}</th>
                  ))}
                  <th style={{padding:"8px 10px",background:"#f1f5f9",borderBottom:"1px solid #e2e8f0",textAlign:"center",color:"#4f46e5",fontWeight:700}}>Row Σ</th>
                </tr>
              </thead>
              <tbody>
                {tickers.map((t, i) => {
                  const rowSum = contributions[i].reduce((s, v) => s + v, 0);
                  const rowPct = portfolioVariance > 0 ? (rowSum / portfolioVariance * 100) : 0;
                  return (
                    <tr key={t}>
                      <td style={{padding:"7px 10px",background:"#f8fafc",borderRight:"1px solid #e2e8f0",color:"#475569",fontWeight:700,fontFamily:MO}}>{t}</td>
                      {tickers.map((_, j) => {
                        const v = contributions[i][j];
                        const pct = portfolioVariance > 0 ? (v / portfolioVariance * 100) : 0;
                        const bg = v > 0 ? `rgba(16,185,129,${Math.min(Math.abs(pct)/30, 0.35)})` : v < 0 ? `rgba(239,68,68,${Math.min(Math.abs(pct)/30, 0.35)})` : "transparent";
                        return (
                          <td key={`${i}-${j}`} style={{padding:"7px 10px",textAlign:"center",fontFamily:MO,borderBottom:"1px solid #f1f5f9",background:bg,color:"#334155"}}>
                            {(v * 10000).toFixed(2)}
                          </td>
                        );
                      })}
                      <td style={{padding:"7px 10px",textAlign:"center",fontFamily:MO,fontWeight:700,color:rowSum>=0?"#059669":"#dc2626",background:"#f8fafc",borderLeft:"1px solid #e2e8f0"}}>
                        {rowPct.toFixed(1)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{borderTop:"1px solid #e2e8f0"}}>
                  <td style={{padding:"8px 10px",fontFamily:MO,fontWeight:700,color:"#0f172a"}} colSpan={n + 1}>Total Portfolio Variance</td>
                  <td style={{padding:"8px 10px",textAlign:"center",fontFamily:MO,fontWeight:800,color:"#4f46e5"}}>{(portfolioVariance * 10000).toFixed(2)} bps²</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <div style={{fontSize:12,color:"#64748b",marginTop:6}}>Uses current selected portfolio weights ({activeLabel || "active criterion"}). Values shown in basis points squared (bps²).</div>
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
    <div style={{background:"#fff",borderRadius:16,border:"1px solid #e2e8f0",boxShadow:"0 8px 20px rgba(15,23,42,.05)",overflow:"hidden"}}>
      <div style={{padding:"14px 16px",borderBottom:"1px solid #f1f5f9",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <div style={{width:4,height:18,borderRadius:2,background:accentColor}}/>
          <h3 style={{fontSize:14,fontWeight:700,color:"#1e293b",margin:0}}>{title}</h3>
        </div>
        <div style={{fontSize:12,fontWeight:600,padding:"3px 8px",borderRadius:999,background:loading?"#dbeafe":hasData?"#dcfce7":"#f1f5f9",color:loading?"#1d4ed8":hasData?"#166534":"#64748b"}}>
          {loading ? "Fetching..." : hasData ? "Live" : "Awaiting"}
        </div>
      </div>
      <div style={{overflowX:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:14}}>
          <thead>
            <tr style={{background:"#f8fafc"}}>
              <th style={{...TH,textAlign:"left"}}>Stock</th>
              <th style={TH}>Weight</th>
              <th style={TH}>Price</th>
              <th style={{...TH,color:"#059669"}}>Entry</th>
              <th style={{...TH,color:"#3b82f6"}}>Target</th>
              <th style={{...TH,textAlign:"center"}}>Rating</th>
              <th style={TH}>Upside</th>
              <th style={{...TH,color:"#6366f1"}}>R/R</th>
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
                    <td style={{padding:"8px 10px",fontWeight:700,color:"#334155"}}>
                      <div style={{display:"flex",alignItems:"center",gap:7}}>
                        <div style={{width:3,height:22,borderRadius:2,background:SEC_CLR[s.sector]||"#94a3b8"}}/>
                        <div>
                          <div style={{fontFamily:MO,fontSize:13}}>{t}</div>
                          <div style={{display:"flex",alignItems:"center",gap:6}}>
                            <span style={{fontSize:11,color:"#94a3b8",fontWeight:400,maxWidth:150,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{displayName}</span>
                            <span style={{fontSize:10,padding:"1px 7px",borderRadius:999,fontWeight:600,background:(SEC_CLR[s.sector]||"#64748b")+"18",color:SEC_CLR[s.sector]||"#64748b"}}>{s.sector}</span>
                          </div>
                        </div>
                      </div>
                    </td>
                    <td style={{padding:"8px 10px",textAlign:"right",fontFamily:MO,fontWeight:700,color:"#0f172a"}}>{(w*100).toFixed(1)}%</td>
                    <td style={{padding:"8px 10px",textAlign:"right"}}>
                      {pending
                        ? <div><div style={{fontFamily:MO,fontWeight:700,color:"#059669",fontSize:13}}>${s.price?.toFixed(2)}</div><div style={{fontSize:11,color:"#94a3b8"}}>{s.date}</div></div>
                        : <div><div style={{fontFamily:MO,fontWeight:700,color:"#334155"}}>${a.latestPrice.toFixed(2)}</div><div style={{fontSize:11,color:"#94a3b8"}}>{a.priceDate}</div></div>}
                    </td>
                    <td style={{padding:"8px 10px",textAlign:"right"}}>
                      {pending ? <span style={{color:"#cbd5e1",fontSize:12}}>{dot}</span>
                        : <div><div style={{fontFamily:MO,fontWeight:700,color:"#059669"}}>${a.entryPrice.toFixed(2)}</div><div style={{fontSize:11,color:"#6ee7b7"}}>{a.entryDate}</div></div>}
                    </td>
                    <td style={{padding:"8px 10px",textAlign:"right"}}>
                      {pending ? <span style={{color:"#cbd5e1",fontSize:12}}>{dot}</span>
                        : <div><div style={{fontFamily:MO,fontWeight:700,color:"#3b82f6"}}>${a.targetPrice.toFixed(2)}</div><div style={{fontSize:11,color:"#93c5fd"}}>{a.targetDate}</div></div>}
                    </td>
                    <td style={{padding:"8px 10px",textAlign:"center"}}>
                      {pending ? <span style={{color:"#cbd5e1",fontSize:12}}>{dot}</span>
                        : <div><RatingBadge rating={a.rating}/><div style={{fontSize:10,color:"#94a3b8",marginTop:2}}>{a.ratingDate}</div></div>}
                    </td>
                    <td style={{padding:"8px 10px",textAlign:"right",color:!pending&&a.upside>=0?"#059669":!pending?"#ef4444":"#94a3b8"}}>
                      {pending ? <span style={{fontSize:12}}>{dot}</span>
                        : <div><div style={{fontWeight:700}}>{a.upside>=0?"+":""}{a.upside.toFixed(1)}%</div><div style={{fontSize:10,opacity:.6}}>{a.upsideDate}</div></div>}
                    </td>
                    <td style={{padding:"8px 10px",textAlign:"right",fontFamily:MO,fontWeight:700,color:rrColor}}>{rrDisplay}</td>
                  </tr>
                  {isExp && !pending && (
                    <tr style={{background:"linear-gradient(135deg,#eff6ff,#eef2ff)"}}>
                      <td colSpan={8} style={{padding:"12px 14px"}}>
                        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
                          <span style={{fontSize:12,fontWeight:600,color:(a.sentiment||'').includes('Bull')?'#059669':(a.sentiment||'').includes('Bear')?'#ef4444':'#64748b'}}>{a.sentiment}</span>
                          <span style={{fontSize:12,color:"#64748b"}}>{a.analystCount} analysts</span>
                        </div>
                        {a.reasoning && a.reasoning !== 'N/A' && (
                          <div style={{background:"rgba(255,255,255,.7)",borderRadius:8,padding:"10px 12px",border:"1px solid #dbeafe",marginBottom:10}}>
                            <div style={{fontSize:12,color:"#334155",lineHeight:1.5}}>{a.reasoning}</div>
                            <div style={{fontSize:11,color:"#94a3b8",marginTop:4}}>Source: {a.reasoningSource} | {a.reasoningDate}</div>
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
                              <div style={{fontSize:11,color:"#64748b",fontWeight:600,textTransform:"uppercase",marginBottom:3}}>{card.l}</div>
                              <div style={{fontFamily:MO,fontSize:16,fontWeight:800,color:card.c}}>{card.v}{card.u}</div>
                            </div>
                          ))}
                        </div>
                        <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:6,marginBottom:10}}>
                          {[['Price',a.priceSource,a.priceDate],['Target',a.targetSource,a.targetDate],['Rating',a.ratingSource,a.ratingDate],['Entry',a.entrySource,a.entryDate]].map(([l,v,d],j)=>(
                            <div key={j} style={{background:"rgba(255,255,255,.6)",borderRadius:6,padding:"6px 8px",border:"1px solid #e2e8f0"}}>
                              <div style={{fontSize:11,fontWeight:600,color:"#64748b"}}>{l}</div>
                              <div style={{fontSize:12,color:"#334155"}}>{v}</div>
                              <div style={{fontSize:11,color:"#94a3b8"}}>{d}</div>
                            </div>
                          ))}
                        </div>
                        {a.catalysts && a.catalysts.length > 0 && a.catalysts[0] !== 'Market' && (
                          <div style={{display:"flex",flexWrap:"wrap",gap:4,alignItems:"center"}}>
                            <span style={{fontSize:12,color:"#64748b",fontWeight:600}}>Catalysts:</span>
                            {a.catalysts.map((c, ci) => (
                              <span key={ci} style={{fontSize:11,padding:"2px 7px",borderRadius:999,background:"rgba(99,102,241,.08)",color:"#6366f1",fontWeight:600,border:"1px solid rgba(99,102,241,.15)"}}>{c}</span>
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
        <div style={{borderTop:"1px solid #e2e8f0",background:"#f8fafc",padding:"12px 16px",display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,textAlign:"center"}}>
          <div><div style={{fontSize:11,color:"#94a3b8",fontWeight:700,textTransform:"uppercase",letterSpacing:.8}}>Avg Entry Disc.</div><div style={{fontFamily:MO,fontSize:14,fontWeight:800,color:"#059669"}}>{avgEntryDisc.toFixed(1)}%</div></div>
          <div><div style={{fontSize:11,color:"#94a3b8",fontWeight:700,textTransform:"uppercase",letterSpacing:.8}}>Wtd Upside</div><div style={{fontFamily:MO,fontSize:14,fontWeight:800,color:"#3b82f6"}}>{wtdUpside.toFixed(1)}%</div></div>
          <div><div style={{fontSize:11,color:"#94a3b8",fontWeight:700,textTransform:"uppercase",letterSpacing:.8}}>Strong Buy %</div><div style={{fontFamily:MO,fontSize:14,fontWeight:800,color:"#818cf8"}}>{strongBuyWt.toFixed(0)}%</div></div>
          <div><div style={{fontSize:11,color:"#94a3b8",fontWeight:700,textTransform:"uppercase",letterSpacing:.8}}>Avg R/R</div><div style={{fontFamily:MO,fontSize:14,fontWeight:800,color:"#6366f1"}}>{avgRR !== null ? avgRR.toFixed(1)+':1' : '\u2014'}</div></div>
        </div>
      )}
    </div>
  );
}

function GlossaryPanel({ histYrs, varHorizonText, returnModel, varMethod, minVarVolCap, rfRate, engineMode }) {
  const items = [
    { term: "Monthly Log Return (Asset i)", formula: <>r<sub>i,t</sub> = ln(P<sub>i,t</sub> / P<sub>i,t-1</sub>)</>, meaning: "Computed from aligned monthly adjusted-close prices." },
    { term: "Annualized Expected Return (Asset i)", formula: <>μ<sub>i</sub> = 12 · mean(r<sub>i,t</sub>)</>, meaning: "Historical monthly mean log-return annualized by 12." },
    { term: "Modeled Expected Return (optional)", formula: <>μ<sub>i,model</sub> = b<sub>i</sub>ln(Target/Price) + (1-b<sub>i</sub>)μ<sub>i,hist</sub></>, meaning: "When Return Model = Modeled, blend target-implied log return with historical mean by analyst-count confidence b_i." },
    { term: "Annualized Volatility (Asset i)", formula: <>σ<sub>i</sub> = √(12 · Var(r<sub>i,t</sub>))</>, meaning: "Historical monthly variance annualized and square-rooted." },
    { term: "Covariance Matrix", formula: <>Σ<sub>ij</sub> = ρ<sub>ij</sub> · σ<sub>i</sub> · σ<sub>j</sub></>, meaning: "Built from pairwise correlations and annualized vols." },
    { term: "Correlation Matrix", formula: <>ρ<sub>ij</sub> = Cov(r<sub>i</sub>, r<sub>j</sub>) / (σ<sub>i</sub> · σ<sub>j</sub>)</>, meaning: "Normalized co-movement between assets, in [-1, 1]." },
    { term: "Portfolio Expected Return", formula: <>R<sub>p</sub> = w<sup>T</sup>μ = Σ w<sub>i</sub>μ<sub>i</sub></>, meaning: "Weight vector times annualized expected return vector." },
    { term: "Portfolio Volatility", formula: <>σ<sub>p</sub> = √(w<sup>T</sup>Σw)</>, meaning: "Quadratic form of weights and covariance matrix." },
    { term: "Sharpe Ratio", formula: <>Sharpe = (R<sub>p</sub> - R<sub>f</sub>) / σ<sub>p</sub></>, meaning: `Risk-adjusted expected return; dashboard currently uses R_f = ${(rfRate * 100).toFixed(1)}%.` },
    { term: "Best Min Variance (by Sharpe)", formula: <>w* = argmax<sub>w: σ<sub>p</sub> ≤ σ<sub>cap</sub></sub> Sharpe</>, meaning: `Highest Sharpe portfolio subject to a hard volatility cap of ${(minVarVolCap * 100).toFixed(1)}%. Monte Carlo approximates it with random weights; deterministic mode selects it from a QP-built frontier on the user tickers.` },
    { term: "True Min Variance Portfolio", formula: <>w* = argmin<sub>w</sub> σ<sub>p</sub></>, meaning: "Absolute lowest-volatility long-only portfolio. Monte Carlo approximates it over random weights; deterministic mode solves it directly with quadratic programming." },
    { term: "Max Sharpe Portfolio", formula: <>w* = argmax<sub>w</sub> Sharpe</>, meaning: "Highest Sharpe long-only portfolio on the entered tickers. Monte Carlo approximates it with random weights; deterministic mode selects it from the efficient frontier." },
    { term: "Deterministic Search Engine", formula: <>w* = QP(μ, Σ, R<sub>f</sub>)</>, meaning: `Current deterministic mode solves a long-only quadratic program directly on the user-entered ticker set, with covariance regularization and efficient-frontier selection. Active engine: ${engineMode}.` },
    { term: `Historical VaR (${varHorizonText})`, formula: <>min<sub>s</sub> [exp(Σ<sub>k=s</sub><sup>s+11</sup> r<sub>p,k</sub>) - 1]</>, meaning: "Worst realized rolling 12-month return from historical portfolio returns r_p,k." },
    { term: `Parametric VaR (${varHorizonText})`, formula: <>VaR = exp(μ<sub>annual</sub> + z<sub>p</sub>σ<sub>annual</sub>) - 1, p=1/N</>, meaning: "Normal-approx annual left-tail quantile from portfolio log-return mean and volatility." },
    { term: "Upside %", formula: <>((Target / Price) - 1) × 100</>, meaning: "Implied move from live price to analyst target." },
    { term: "Risk/Reward (R/R)", formula: <>(Target - Entry) / (Price - Entry)</>, meaning: "Expected reward per unit of current downside-to-entry risk." },
  ];

  return (
    <div style={{background:"#fff",borderRadius:16,overflow:"hidden",border:"1px solid #e2e8f0",marginBottom:20}}>
      <div style={{padding:"14px 16px",borderBottom:"1px solid #f1f5f9",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,flexWrap:"wrap"}}>
        <h3 style={{fontSize:14,fontWeight:700,color:"#0f172a",margin:0}}>Glossary of Key Calculations</h3>
        <span style={{fontSize:14,color:"#64748b"}}>{histYrs}yr lookback · return: {returnModel} · VaR: {varMethod}</span>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(260px,1fr))",gap:10,padding:14}}>
        {items.map((x) => (
          <div key={x.term} style={{background:"#f8fafc",border:"1px solid #e2e8f0",borderRadius:10,padding:"10px 12px"}}>
            <div style={{fontSize:13,fontWeight:700,color:"#0f172a",marginBottom:5}}>{x.term}</div>
            <div style={{fontFamily:MO,fontSize:13,color:"#6366f1",marginBottom:4}}>{x.formula}</div>
            <div style={{fontSize:13,color:"#475569",lineHeight:1.45}}>{x.meaning}</div>
          </div>
        ))}
      </div>
      <div style={{padding:"0 14px 14px",fontSize:14,color:"#64748b"}}>
        Notation: P_i,t = price of asset i at month t, w = portfolio weights (sum to 1), mu = expected return vector, Sigma = covariance matrix, r_p,k = portfolio monthly log return.
      </div>
    </div>
  );
}

function ImplementationNotesPanel({ histYrs, numSims, returnModel, varMethod, minVarVolCap, rfRate, engineMode }) {
  const notes = [
    { title: "Data Source Split", body: "Optimization uses Yahoo historical prices; live analysis table uses Finnhub + FMP. These are separate pipelines." },
    { title: "History Window", body: `Requested lookback is ${histYrs} year${histYrs > 1 ? "s" : ""}, then reduced to overlapping months common to all tickers before stats are computed.` },
    { title: "Return Construction", body: `Return model is selectable (current: ${returnModel}). Historical uses annualized mean monthly log returns. Modeled uses Finnhub/FMP target-implied log return blended with historical means by analyst-count confidence. Covariance always remains historical.` },
    { title: "Engine Mode", body: `Current engine selection is ${engineMode}. Monte Carlo uses ${numSims.toLocaleString()} random long-only portfolios on the fixed user ticker list. Deterministic mode solves the same fixed user ticker list directly with quadratic programming, without subset sampling.` },
    { title: "Volatility Cap", body: `Best Min Variance (by Sharpe) uses a hard volatility cap of ${(minVarVolCap * 100).toFixed(1)}%. Monte Carlo keeps the highest-Sharpe eligible simulation; deterministic mode keeps the highest-Sharpe eligible efficient-frontier point.` },
    { title: "Deterministic Search", body: "The deterministic engine is a quadratic-programming and efficient-frontier solver with covariance regularization. It is not a projected-gradient search anymore." },
    { title: "Portfolio Variants", body: "Both engines surface Best Min Variance (by Sharpe), True Min Variance, and Best Max Sharpe on the same user-specified ticker set." },
    { title: "VaR Method", body: `VaR method is selectable (current: ${varMethod}). Historical VaR uses worst realized rolling 12-month outcomes. Parametric VaR uses a normal annual left-tail quantile with p = 1/N-year.` },
    { title: "Sharpe Inputs", body: `Sharpe uses a user-specified risk-free rate (current: ${(rfRate * 100).toFixed(1)}%). Changing it can change rankings even if mu/cov are unchanged.` },
    { title: "Model Limits", body: "No shorting, no leverage, no transaction costs, no rebalance schedule, and no regime-switching model." },
  ];

  return (
    <div style={{background:"#fff",borderRadius:16,overflow:"hidden",border:"1px solid #e2e8f0",marginBottom:20}}>
      <div style={{padding:"14px 16px",borderBottom:"1px solid #f1f5f9",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,flexWrap:"wrap"}}>
        <h3 style={{fontSize:14,fontWeight:700,color:"#0f172a",margin:0}}>Implementation Notes</h3>
        <span style={{fontSize:14,color:"#64748b"}}>{histYrs}yr lookback · {numSims.toLocaleString()} sims</span>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))",gap:10,padding:14}}>
        {notes.map((n) => (
          <div key={n.title} style={{background:"#f8fafc",border:"1px solid #e2e8f0",borderRadius:10,padding:"10px 12px"}}>
            <div style={{fontSize:13,fontWeight:700,color:"#0f172a",marginBottom:4}}>{n.title}</div>
            <div style={{fontSize:13,color:"#475569",lineHeight:1.45}}>{n.body}</div>
          </div>
        ))}
      </div>
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
  const [infoTab, setInfoTab] = useState("glossary");
  const [numSims, setNumSims] = useState(3000);
  const [histYrs, setHistYrs] = useState(3);
  const [returnModel, setReturnModel] = useState("historical");
  const [varMethod, setVarMethod] = useState("historical");
  const [minVarVolCap, setMinVarVolCap] = useState(0.2);
  const [rfRate, setRfRate] = useState(0.04);
  const [engineMode, setEngineMode] = useState("monteCarlo");

  const [liveData, setLiveData] = useState({});
  const [fetching, setFetching] = useState(false);
  const [fetchMsg, setFetchMsg] = useState('');
  const [fetchStatus, setFetchStatus] = useState(null);
  const [fetchError, setFetchError] = useState(null);
  const abortRef = useRef(null);
  const liveDataRef = useRef({});

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
    setLiveData(prev => {
      const n = { ...prev };
      delete n[t];
      liveDataRef.current = n;
      return n;
    });
  }, []);

  const doFetch = useCallback(async (tickerList) => {
    const ac = new AbortController(); abortRef.current = ac;
    setFetching(true); setFetchStatus('loading'); setFetchError(null); setFetchMsg('');
    try {
      const result = await fetchAllLiveData(tickerList, ac.signal, (ticker, data, loaded, total) => {
        setLiveData(prev => {
          const next = { ...prev, [ticker]: data };
          liveDataRef.current = next;
          return next;
        });
        setStocks(prev => {
          if (!prev[ticker]) return prev;
          return {
            ...prev,
            [ticker]: {
              ...prev[ticker],
              price: data.latestPrice,
              source: data.priceSource || 'Finnhub',
              date: data.priceDate || new Date().toLocaleDateString(),
              name: (prev[ticker].name === ticker && TICKER_NAMES[ticker]) ? TICKER_NAMES[ticker] : prev[ticker].name,
            }
          };
        });
        setFetchMsg(`Loaded ${loaded}/${total}: ${ticker} @ $${Number(data.latestPrice || 0).toFixed(2)}`);
      });

      if (ac.signal.aborted) return;

      const loaded = Object.keys(result).length;
      const missing = tickerList.filter(t => !result[t]);
      if (missing.length === 0) {
        setFetchStatus('success');
        setFetchMsg(`All ${loaded} tickers loaded`);
      } else if (loaded > 0) {
        setFetchStatus('partial');
        setFetchError(`${loaded}/${tickerList.length} loaded. Missing: ${missing.join(', ')}`);
      } else {
        setFetchStatus('error');
        setFetchError('No live data returned. Check /api/quotes and server API keys.');
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        setFetchStatus(Object.keys(liveDataRef.current).length > 0 ? 'partial' : 'skipped');
      } else {
        setFetchStatus('error');
        setFetchError(err?.message || 'Failed to fetch live data.');
      }
    } finally {
      setFetching(false);
    }
  }, []);

  const skip = useCallback(() => {
    abortRef.current?.abort();
    setFetching(false);
    setFetchStatus(Object.keys(liveDataRef.current).length > 0 ? 'partial' : 'skipped');
  }, []);

  const runOptimize = useCallback(async () => {
    if (tickers.length < 2) return;
    setBusy(true); setOptMsg(''); setRes(null); setHistStats(null);

    try {
      setOptMsg(`Downloading ${histYrs}yr monthly prices from Yahoo Finance...`);
      const stats = await fetchHistoricalStats(tickers, histYrs);
      setHistStats(stats);
      let expectedMu = stats.mu;
      let modelCoverage = null;
      if (returnModel === "modeled") {
      setOptMsg(`Historical data loaded (${stats.months} months). Building modeled expected returns...`);
        try {
          const modeled = await buildModeledExpectedReturns(tickers, stats.mu);
          expectedMu = modeled.modeledMu;
          modelCoverage = { targetBased: modeled.targetBased, fallbackHistorical: modeled.fallbackHistorical };
        } catch (e) {
          modelCoverage = { targetBased: 0, fallbackHistorical: tickers.length, error: e?.message || "modeled return fetch failed" };
          expectedMu = stats.mu;
        }
      }
      setOptMsg(engineMode === "monteCarlo"
        ? `Inputs ready. Running ${numSims.toLocaleString()} Monte Carlo simulations...`
        : "Inputs ready. Solving deterministic QP portfolios on the selected tickers...");

      await new Promise(r => setTimeout(r, 30));

      const varFn = varMethod === "parametric" ? computeParametricVaR : computeOneInNYearWorstLoss;
      let result;

      if (engineMode === "monteCarlo") {
        result = optimizeWithData(expectedMu, stats.cov, rfRate, numSims, minVarVolCap);
        result.varAnalysis = {
          minVar: varFn(stats.assetReturns, result.minVar.weights, histYrs),
          trueMinVar: varFn(stats.assetReturns, result.trueMinVar.weights, histYrs),
          maxSharpe: varFn(stats.assetReturns, result.maxSharpe.weights, histYrs),
        };
      } else {
        const deterministic = deterministicOptimize(expectedMu, stats.cov, rfRate, minVarVolCap);
        result = {
          minVar: deterministic.minVarSharpeCap,
          detTrueMinVar: deterministic.minVar,
          maxSharpe: deterministic.maxSharpe,
          deterministic,
          frontier: deterministic.frontier,
          varAnalysis: {
            minVar: varFn(stats.assetReturns, deterministic.minVarSharpeCap.weights, histYrs),
            detTrueMinVar: varFn(stats.assetReturns, deterministic.minVar.weights, histYrs),
            maxSharpe: varFn(stats.assetReturns, deterministic.maxSharpe.weights, histYrs),
          },
        };
      }

      result.dataSource = 'historical';
      result.histYrs = histYrs;
      result.returnModel = returnModel;
      result.varMethod = varMethod;
      result.minVarVolCap = minVarVolCap;
      result.rfRate = rfRate;
      result.modelCoverage = modelCoverage;
      result.engineMode = engineMode;

      setRes(result);
      setBusy(false);
      setTab(engineMode === "deterministic" ? "maxSharpe" : "maxSharpe");
      setOptMsg(`Optimized using ${histYrs}yr historical prices (${stats.months} months), engine=${engineMode}, return=${returnModel}, VaR=${varMethod}, RF=${(rfRate * 100).toFixed(1)}%, min-var cap=${(minVarVolCap * 100).toFixed(1)}%`);
    } catch (err) {
      console.error('Historical fetch failed:', err);
      setBusy(false);
      const msg = `Historical data fetch failed: ${err.message}`;
      setOptMsg(msg);
      setHistStats(null);
    }
  }, [tickers, numSims, histYrs, returnModel, varMethod, minVarVolCap, rfRate, engineMode]);

  const isDeterministicMode = res?.engineMode === "deterministic";
  const portfolioTab = isDeterministicMode
    ? (tab === "minVar" || tab === "trueMinVar" ? tab : "maxSharpe")
    : (tab === "minVar" || tab === "trueMinVar" ? tab : "maxSharpe");
  const port = res ? (portfolioTab === "maxSharpe" ? res.maxSharpe : portfolioTab === "trueMinVar" ? (isDeterministicMode ? res.detTrueMinVar : res.trueMinVar) : res.minVar) : null;
  const fmt = v => (v == null || isNaN(v)) ? "\u2014" : (v * 100).toFixed(2) + "%";
  const fN = v => (v == null || isNaN(v)) ? "\u2014" : v.toFixed(3);
  const minVarVaR = res?.varAnalysis?.minVar || null;
  const detTrueMinVarVaR = res?.varAnalysis?.detTrueMinVar || null;
  const trueMinVarVaR = res?.varAnalysis?.trueMinVar || null;
  const maxSharpeVaR = res?.varAnalysis?.maxSharpe || null;
  const varYearsRaw = minVarVaR?.years ?? trueMinVarVaR?.years ?? maxSharpeVaR?.years ?? (histStats?.months ? histStats.months / 12 : null);
  const varYears = varYearsRaw != null ? Math.max(varYearsRaw, 1 / 12) : null;
  const varYearsLabel = varYears == null ? "N" : (Math.abs(varYears - Math.round(varYears)) < 0.05 ? String(Math.round(varYears)) : varYears.toFixed(1));
  const varHorizonText = `1-in-${varYearsLabel}-year`;
  const minVarPoint = res ? { x: +(res.minVar.vol * 100).toFixed(3), y: +(res.minVar.ret * 100).toFixed(3) } : null;
  const maxSharpePoint = res ? { x: +(res.maxSharpe.vol * 100).toFixed(3), y: +(res.maxSharpe.ret * 100).toFixed(3) } : null;
  const trueMinVarBase = isDeterministicMode ? res?.detTrueMinVar : res?.trueMinVar;
  const trueMinVarPoint = trueMinVarBase ? { x: +(trueMinVarBase.vol * 100).toFixed(3), y: +(trueMinVarBase.ret * 100).toFixed(3) } : null;
  const minVarOverlapsMaxSharpe = !!(minVarPoint && maxSharpePoint && minVarPoint.x === maxSharpePoint.x && minVarPoint.y === maxSharpePoint.y);
  const minVarChartPoint = minVarOverlapsMaxSharpe ? { x: +(minVarPoint.x - 0.08).toFixed(3), y: +(minVarPoint.y + 0.08).toFixed(3) } : minVarPoint;
  const maxSharpeChartPoint = minVarOverlapsMaxSharpe ? { x: +(maxSharpePoint.x + 0.08).toFixed(3), y: +(maxSharpePoint.y - 0.08).toFixed(3) } : maxSharpePoint;
  const portfolioLabel = portfolioTab === "maxSharpe" ? "Best Max Sharpe" : portfolioTab === "trueMinVar" ? "True Min Variance" : "Best Min Variance (by Sharpe)";
  return (
    <div style={{fontFamily:F,minHeight:"100vh",background:"linear-gradient(170deg,#080f1a 0%,#0f1a2e 40%,#0a1020 100%)",color:"#e2e8f0",padding:"28px 16px"}}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600;700&family=Instrument+Sans:wght@400;500;600;700&display=swap" rel="stylesheet"/>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{maxWidth:1200,margin:"0 auto"}}>

        <div style={{marginBottom:28,display:"flex",alignItems:"flex-end",justifyContent:"space-between",flexWrap:"wrap",gap:12}}>
          <div>
            <div style={{fontSize:14,fontWeight:700,color:"#f59e0b",letterSpacing:3.5,textTransform:"uppercase",marginBottom:3}}>Portfolio Lab</div>
            <h1 style={{fontSize:26,fontWeight:800,margin:0,background:"linear-gradient(135deg,#f8fafc,#94a3b8)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>Portfolio Optimizer</h1>
            <p style={{color:"#475569",fontSize:14,margin:"4px 0 0"}}>Live analyst data via API &middot; Historical prices from Yahoo Finance &middot; Local return/vol/correlation computation</p>
          </div>
          <div style={{fontFamily:MO,fontSize:13,color:"#475569",textAlign:"right"}}>
            <div style={{fontWeight:600,color:"#f59e0b"}}>Author: Amadea Schaum</div>
            <div>{engineMode === "monteCarlo" ? "Engine: Monte Carlo" : "Engine: Deterministic"}</div>
            <div>RF: {(rfRate*100).toFixed(1)}%</div>
          </div>
        </div>

        <div style={{background:"rgba(255,255,255,.03)",border:"1px solid rgba(255,255,255,.08)",borderRadius:16,padding:22,marginBottom:22}}>
          <h2 style={{fontSize:15,fontWeight:700,margin:"0 0 4px",color:"#f1f5f9"}}>Add Stocks</h2>
          <p style={{fontSize:13,color:"#64748b",margin:"0 0 14px"}}>Add tickers below. Click <strong style={{color:"#818cf8"}}>Optimize</strong> to download historical prices from Yahoo Finance and run the selected search engine on your ticker list. Click <strong style={{color:"#818cf8"}}>Fetch Live Data</strong> for Finnhub prices + FMP target, rating, upside and R/R fields.</p>

          <div style={{display:"flex",gap:8,marginBottom:14}}>
            <input type="text" placeholder="Any ticker: AAPL, NVDA, TTD, SHEL.L, 7203.T..." value={input}
              onChange={e=>setInput(e.target.value.toUpperCase())} onKeyDown={e=>{if(e.key==="Enter")addTicker();}}
              style={{flex:1,padding:"11px 14px",fontFamily:MO,fontSize:14,fontWeight:600,background:"rgba(255,255,255,.06)",border:"1px solid rgba(255,255,255,.14)",borderRadius:10,color:"#f1f5f9",outline:"none",letterSpacing:1}}/>
            <button onClick={addTicker} disabled={!input.trim()}
              style={{padding:"11px 24px",borderRadius:10,border:"none",fontWeight:700,fontSize:13,fontFamily:F,cursor:!input.trim()?"not-allowed":"pointer",background:"linear-gradient(135deg,#f59e0b,#d97706)",color:"#fff",boxShadow:"0 3px 16px rgba(245,158,11,.25)"}}>
              + Add Stock</button>
          </div>

          {error && <div style={{fontSize:14,color:"#f87171",marginBottom:10,padding:"6px 12px",background:"rgba(239,68,68,.08)",borderRadius:8}}>{error}</div>}

          {tickers.length > 0 ? (
            <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:16}}>
              {tickers.map(t=>{const s=stocks[t]; const live=!!liveData[t]; const displayName = TICKER_NAMES[t] || s.name || t; return(
                <div key={t} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 8px 6px 12px",borderRadius:10,border:`1px solid ${live?"rgba(16,185,129,.3)":"rgba(255,255,255,.12)"}`,background:live?"rgba(16,185,129,.06)":"rgba(255,255,255,.04)"}}>
                  <div style={{width:3,height:22,borderRadius:2,background:SEC_CLR[s.sector]||"#64748b"}}/>
                  <div><div style={{fontFamily:MO,fontWeight:700,fontSize:13,color:"#f1f5f9"}}>{t}</div><div style={{fontSize:13,color:"#64748b"}}>{displayName !== t ? displayName : s.sector}</div></div>
                  <div style={{textAlign:"right",marginLeft:6}}>
                    {s.price > 0
                      ? <><div style={{fontFamily:MO,fontWeight:700,fontSize:13,color:"#10b981"}}>${s.price.toFixed(2)}</div><div style={{fontSize:14,color:"#475569"}}>{s.date}</div></>
                      : <div style={{fontSize:14,color:"#64748b"}}>Pending</div>}
                  </div>
                  {live && <div style={{fontSize:14,color:"#10b981",fontWeight:700}}>LIVE</div>}
                  <button onClick={()=>removeTicker(t)} style={{width:18,height:18,borderRadius:9,border:"none",marginLeft:4,background:"rgba(239,68,68,.15)",color:"#f87171",fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700,padding:0}}>&times;</button>
                </div>);})}
            </div>
          ) : <div style={{padding:"20px 0",textAlign:"center",color:"#334155",fontSize:13}}>No stocks added yet.</div>}

          {fetchStatus && (
            <div style={{marginBottom:14,padding:"10px 14px",borderRadius:10,fontSize:14,
              background:fetchStatus==='loading'?"rgba(59,130,246,.08)":fetchStatus==='success'?"rgba(16,185,129,.08)":fetchStatus==='partial'?"rgba(234,179,8,.08)":fetchStatus==='skipped'?"rgba(100,116,139,.12)":"rgba(239,68,68,.08)",
              border:`1px solid ${fetchStatus==='loading'?"rgba(59,130,246,.2)":fetchStatus==='success'?"rgba(16,185,129,.2)":fetchStatus==='partial'?"rgba(234,179,8,.2)":fetchStatus==='skipped'?"rgba(100,116,139,.25)":"rgba(239,68,68,.2)"}`,
              color:fetchStatus==='loading'?"#93c5fd":fetchStatus==='success'?"#6ee7b7":fetchStatus==='partial'?"#fcd34d":fetchStatus==='skipped'?"#cbd5e1":"#fca5a5"}}>
              {fetchStatus==='loading'&&<span>{fetchMsg}</span>}
              {fetchStatus==='success'&&<span>{fetchMsg||`Live data loaded for ${Object.keys(liveData).length} tickers`}</span>}
              {fetchStatus==='partial'&&<span>Warning: {fetchError}</span>}
              {fetchStatus==='skipped'&&<span>Skipped live data fetch.</span>}
              {fetchStatus==='error'&&<span>Error: {fetchError}</span>}
              {(fetchStatus==='error'||fetchStatus==='partial'||fetchStatus==='skipped')&&(
                <button onClick={()=>{const m=tickers.filter(t=>!liveData[t]);if(m.length)doFetch(m);}} style={{marginLeft:10,padding:"3px 10px",borderRadius:6,border:"1px solid rgba(255,255,255,.15)",fontSize:14,fontWeight:600,cursor:"pointer",background:"transparent",color:"inherit"}}>Retry</button>)}
            </div>
          )}

          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:16,marginTop:16}}>
            <div>
              <label style={{display:"flex",alignItems:"center",justifyContent:"space-between",fontSize:13,color:"#94a3b8",marginBottom:6,fontWeight:600}}>
                <span>Historical Lookback</span>
                <span style={{fontFamily:MO,color:"#818cf8",fontSize:13,fontWeight:700}}>{histYrs} yr{histYrs>1?'s':''}</span>
              </label>
              <input type="range" min={1} max={10} step={1} value={histYrs}
                onChange={e=>setHistYrs(parseInt(e.target.value))}
                style={{width:"100%",accentColor:"#818cf8"}} disabled={busy}/>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:13,color:"#475569",marginTop:2}}><span>1yr</span><span>5yr</span><span>10yr</span></div>
            </div>
            <div>
              <label style={{display:"flex",alignItems:"center",justifyContent:"space-between",fontSize:13,color:"#94a3b8",marginBottom:6,fontWeight:600}}>
                <span>Simulations</span>
                <span style={{fontFamily:MO,color:"#818cf8",fontSize:13,fontWeight:700}}>{numSims.toLocaleString()}</span>
              </label>
              <input type="range" min={100} max={5000} step={100} value={numSims}
                onChange={e=>setNumSims(parseInt(e.target.value))}
                style={{width:"100%",accentColor:"#818cf8"}} disabled={busy || engineMode === "deterministic"}/>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:13,color:"#475569",marginTop:2}}><span>100</span><span>2500</span><span>5000</span></div>
              <div style={{fontSize:12,color:"#64748b",marginTop:5}}>{engineMode === "monteCarlo" ? "Random long-only portfolios tested on the user ticker set." : "Monte Carlo only. Deterministic mode solves the entered tickers directly without simulation sampling."}</div>
            </div>
          </div>

          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:16}}>
            <div>
              <label style={{display:"flex",alignItems:"center",justifyContent:"space-between",fontSize:13,color:"#94a3b8",marginBottom:6,fontWeight:600}}>
                <span>Min Variance Sharpe Vol Cap</span>
                <span style={{fontFamily:MO,color:"#10b981",fontSize:13,fontWeight:700}}>{(minVarVolCap * 100).toFixed(1)}%</span>
              </label>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <input
                  type="number"
                  min={5}
                  max={40}
                  step={0.5}
                  value={(minVarVolCap * 100).toFixed(1)}
                  onChange={e => {
                    const next = Number(e.target.value);
                    if (Number.isFinite(next)) setMinVarVolCap(Math.max(0.05, Math.min(0.4, next / 100)));
                  }}
                  style={{flex:1,padding:"11px 14px",fontFamily:MO,fontSize:14,fontWeight:600,background:"rgba(255,255,255,.06)",border:"1px solid rgba(16,185,129,.25)",borderRadius:10,color:"#f1f5f9",outline:"none"}}
                  disabled={busy}
                />
                <span style={{fontSize:13,color:"#94a3b8",fontWeight:700}}>%</span>
              </div>
              <div style={{fontSize:12,color:"#64748b",marginTop:5}}>Hard cap used by both engines for Best Min Variance (by Sharpe). Range 5.0% to 40.0%.</div>
            </div>
            <div>
              <label style={{display:"flex",alignItems:"center",justifyContent:"space-between",fontSize:13,color:"#94a3b8",marginBottom:6,fontWeight:600}}>
                <span>Risk-Free Rate</span>
                <span style={{fontFamily:MO,color:"#f59e0b",fontSize:13,fontWeight:700}}>{(rfRate * 100).toFixed(1)}%</span>
              </label>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <input
                  type="number"
                  min={0}
                  max={10}
                  step={0.1}
                  value={(rfRate * 100).toFixed(1)}
                  onChange={e => {
                    const next = Number(e.target.value);
                    if (Number.isFinite(next)) setRfRate(Math.max(0, Math.min(0.1, next / 100)));
                  }}
                  style={{flex:1,padding:"11px 14px",fontFamily:MO,fontSize:14,fontWeight:600,background:"rgba(255,255,255,.06)",border:"1px solid rgba(245,158,11,.25)",borderRadius:10,color:"#f1f5f9",outline:"none"}}
                  disabled={busy}
                />
                <span style={{fontSize:13,color:"#94a3b8",fontWeight:700}}>%</span>
              </div>
              <div style={{fontSize:12,color:"#64748b",marginTop:5}}>Used in all Sharpe calculations for both Monte Carlo and deterministic engines. Range 0.0% to 10.0%.</div>
            </div>
          </div>

          <div style={{marginBottom:16}}>
            <label style={{display:"block",fontSize:13,color:"#94a3b8",marginBottom:6,fontWeight:600}}>Search Engine</label>
            <div style={{display:"inline-flex",gap:6,padding:4,borderRadius:10,background:"rgba(255,255,255,.05)",border:"1px solid rgba(255,255,255,.12)"}}>
              <button onClick={()=>setEngineMode("monteCarlo")} disabled={busy} style={{padding:"7px 10px",borderRadius:8,border:"none",fontSize:13,fontWeight:700,cursor:busy?"not-allowed":"pointer",background:engineMode==="monteCarlo"?"#14b8a6":"transparent",color:engineMode==="monteCarlo"?"#fff":"#94a3b8"}}>Monte Carlo</button>
              <button onClick={()=>setEngineMode("deterministic")} disabled={busy} style={{padding:"7px 10px",borderRadius:8,border:"none",fontSize:13,fontWeight:700,cursor:busy?"not-allowed":"pointer",background:engineMode==="deterministic"?"#2563eb":"transparent",color:engineMode==="deterministic"?"#fff":"#94a3b8"}}>Deterministic</button>
            </div>
            <div style={{fontSize:12,color:"#64748b",marginTop:5}}>
              {engineMode === "monteCarlo"
                ? "Uses random long-only portfolio search and supports the efficient frontier chart."
                : "Uses direct long-only quadratic programming on the fixed user ticker set, with efficient-frontier selection and covariance regularization."}
            </div>
          </div>

          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:16}}>
            <div>
              <label style={{display:"block",fontSize:13,color:"#94a3b8",marginBottom:6,fontWeight:600}}>Return Model</label>
              <div style={{display:"inline-flex",gap:6,padding:4,borderRadius:10,background:"rgba(255,255,255,.05)",border:"1px solid rgba(255,255,255,.12)"}}>
                <button onClick={()=>setReturnModel("historical")} disabled={busy} style={{padding:"7px 10px",borderRadius:8,border:"none",fontSize:13,fontWeight:700,cursor:busy?"not-allowed":"pointer",background:returnModel==="historical"?"#818cf8":"transparent",color:returnModel==="historical"?"#fff":"#94a3b8"}}>Historical</button>
                <button onClick={()=>setReturnModel("modeled")} disabled={busy} style={{padding:"7px 10px",borderRadius:8,border:"none",fontSize:13,fontWeight:700,cursor:busy?"not-allowed":"pointer",background:returnModel==="modeled"?"#818cf8":"transparent",color:returnModel==="modeled"?"#fff":"#94a3b8"}}>Modeled</button>
              </div>
              <div style={{fontSize:12,color:"#64748b",marginTop:5}}>{returnModel==="historical" ? "Use historical monthly log-return means." : "Blend target-implied return with historical means."}</div>
            </div>
            <div>
              <label style={{display:"block",fontSize:13,color:"#94a3b8",marginBottom:6,fontWeight:600}}>VaR Method</label>
              <div style={{display:"inline-flex",gap:6,padding:4,borderRadius:10,background:"rgba(255,255,255,.05)",border:"1px solid rgba(255,255,255,.12)"}}>
                <button onClick={()=>setVarMethod("historical")} disabled={busy} style={{padding:"7px 10px",borderRadius:8,border:"none",fontSize:13,fontWeight:700,cursor:busy?"not-allowed":"pointer",background:varMethod==="historical"?"#818cf8":"transparent",color:varMethod==="historical"?"#fff":"#94a3b8"}}>Historical</button>
                <button onClick={()=>setVarMethod("parametric")} disabled={busy} style={{padding:"7px 10px",borderRadius:8,border:"none",fontSize:13,fontWeight:700,cursor:busy?"not-allowed":"pointer",background:varMethod==="parametric"?"#818cf8":"transparent",color:varMethod==="parametric"?"#fff":"#94a3b8"}}>Parametric</button>
              </div>
              <div style={{fontSize:12,color:"#64748b",marginTop:5}}>{varMethod==="historical" ? "Worst realized rolling 12-month loss." : `Normal annual VaR with p = 1/${histYrs}.`}</div>
            </div>
          </div>

          {optMsg && (
            <div style={{marginBottom:12,padding:"8px 12px",borderRadius:8,fontSize:13,
              background:optMsg.includes('\u2713')?"rgba(16,185,129,.08)":optMsg.includes('failed')||optMsg.includes('blocked')?"rgba(239,68,68,.08)":"rgba(99,102,241,.08)",
              border:`1px solid ${optMsg.includes('\u2713')?"rgba(16,185,129,.2)":optMsg.includes('failed')||optMsg.includes('blocked')?"rgba(239,68,68,.2)":"rgba(99,102,241,.2)"}`,
              color:optMsg.includes('\u2713')?"#6ee7b7":optMsg.includes('failed')||optMsg.includes('blocked')?"#fca5a5":"#a5b4fc"}}>
              {busy && <span style={{display:"inline-block",width:10,height:10,border:"2px solid rgba(255,255,255,.2)",borderTopColor:"currentColor",borderRadius:"50%",animation:"spin 1s linear infinite",marginRight:6,verticalAlign:"middle"}}/>}
              {optMsg}
            </div>
          )}

          <button onClick={runOptimize} disabled={busy||tickers.length<2}
            style={{padding:"12px 30px",borderRadius:12,border:"none",fontWeight:700,fontSize:14,fontFamily:F,cursor:(busy||tickers.length<2)?"not-allowed":"pointer",background:busy?"#334155":tickers.length<2?"#1e293b":"linear-gradient(135deg,#818cf8,#6366f1)",color:tickers.length<2?"#475569":"#fff",boxShadow:(busy||tickers.length<2)?"none":"0 4px 20px rgba(99,102,241,.3)"}}>
            {busy?"Downloading Prices & Optimizing...":tickers.length<2?"Need 2+ stocks (have "+tickers.length+")":`Optimize ${tickers.length} Stocks (${histYrs}yr, return=${returnModel}, VaR=${varMethod})`}</button>

          {tickers.length > 0 && (
            <div style={{marginTop:16,padding:"14px 16px",background:"rgba(99,102,241,.04)",border:"1px solid rgba(99,102,241,.15)",borderRadius:12}}>
              <div style={{fontSize:13,fontWeight:600,color:"#94a3b8",marginBottom:8}}>{'\uD83D\uDCE1'} Live Market + Analyst Data</div>
              <div style={{display:"flex",gap:8,alignItems:"end",flexWrap:"wrap",marginBottom:10}}>
                <button onClick={() => {
                  liveDataRef.current = {};
                  setLiveData({});
                  doFetch(tickers);
                }} disabled={fetching||tickers.length===0}
                  style={{padding:"10px 20px",borderRadius:10,border:"none",fontWeight:700,fontSize:14,fontFamily:F,cursor:(fetching||tickers.length===0)?"not-allowed":"pointer",background:(fetching||tickers.length===0)?"#334155":"linear-gradient(135deg,#818cf8,#6366f1)",color:(fetching||tickers.length===0)?"#64748b":"#fff",boxShadow:(fetching||tickers.length===0)?"none":"0 3px 16px rgba(99,102,241,.3)",whiteSpace:"nowrap"}}>
                  {fetching ? <span style={{display:"flex",alignItems:"center",gap:6}}><span style={{display:"inline-block",width:12,height:12,border:"2px solid rgba(255,255,255,.3)",borderTopColor:"#fff",borderRadius:"50%",animation:"spin 1s linear infinite"}}/> Fetching...</span> : "\uD83D\uDCE1 Fetch Live Data"}</button>
                {fetching && <button onClick={skip} style={{padding:"10px 16px",borderRadius:10,border:"1px solid rgba(255,255,255,.15)",fontWeight:600,fontSize:14,fontFamily:F,cursor:"pointer",background:"transparent",color:"#94a3b8"}}>Skip</button>}
              </div>
              <div style={{fontSize:14,color:"#64748b"}}>Source: Finnhub live quote + FMP consensus target/rating via `/api/quotes`.</div>
            </div>
          )}
        </div>

        {res&&(<>
          {/* Data source badge */}
          <div style={{marginBottom:12,display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
            <div style={{padding:"6px 14px",borderRadius:8,fontSize:13,fontWeight:700,
              background:"rgba(16,185,129,.1)",
              border:"1px solid rgba(16,185,129,.25)",
              color:"#6ee7b7"}}>
              {`\u2713 ${res.histYrs}yr Real Historical Prices (Yahoo Finance)`}
            </div>
            {histStats && histStats.note && <span style={{fontSize:14,color:"#64748b"}}>{histStats.note}</span>}
            <span style={{fontSize:13,color:"#64748b"}}>{`Engine: ${res.engineMode || engineMode} · Return model: ${res.returnModel || "historical"} · VaR: ${res.varMethod || "historical"} · RF: ${((res.rfRate ?? rfRate) * 100).toFixed(1)}% · min-var cap: ${((res.minVarVolCap ?? minVarVolCap) * 100).toFixed(1)}%`}</span>
            {res.deterministic && <span style={{fontSize:13,color:"#64748b"}}>{`Deterministic method: ${res.deterministic.minVar.method}`}</span>}
            {res.modelCoverage && (
              <span style={{fontSize:13,color:"#64748b"}}>{`Modeled coverage: ${res.modelCoverage.targetBased} target-based, ${res.modelCoverage.fallbackHistorical} historical fallback${res.modelCoverage.error ? " (fallback used)" : ""}`}</span>
            )}
          </div>

          {/* Historical stats panel */}
          {histStats && (
            <div style={{background:"#fff",borderRadius:14,padding:"16px 18px",border:"1px solid #e2e8f0",marginBottom:16}}>
              <h3 style={{fontSize:14,fontWeight:700,color:"#0f172a",margin:"0 0 10px",display:"flex",alignItems:"center",gap:6}}>
                <span style={{width:4,height:16,borderRadius:2,background:"#818cf8",display:"inline-block"}}/>
                Historical Return &amp; Volatility ({histStats.years || histYrs}yr, {histStats.months} months)
              </h3>
              <div style={{overflowX:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
                  <thead><tr style={{background:"#f8fafc"}}>
                    <th style={{padding:"6px 10px",textAlign:"left",fontWeight:700,color:"#475569",fontSize:13,textTransform:"uppercase",borderBottom:"2px solid #e2e8f0"}}>Ticker</th>
                    <th style={{padding:"6px 10px",textAlign:"right",fontWeight:700,color:"#059669",fontSize:13,textTransform:"uppercase",borderBottom:"2px solid #e2e8f0"}}>Ann. Return</th>
                    <th style={{padding:"6px 10px",textAlign:"right",fontWeight:700,color:"#ef4444",fontSize:13,textTransform:"uppercase",borderBottom:"2px solid #e2e8f0"}}>Ann. Vol</th>
                    <th style={{padding:"6px 10px",textAlign:"right",fontWeight:700,color:"#6366f1",fontSize:13,textTransform:"uppercase",borderBottom:"2px solid #e2e8f0"}}>Return/Vol</th>
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

            </div>
          )}

          {histStats && histStats.corr && (
            <CorrelationMatrixTable
              tickers={tickers}
              corr={histStats.corr}
              title={`Correlation Matrix (${histStats.years || histYrs}yr)`}
            />
          )}

          {/* Portfolio criterion tabs for weighted contribution matrix */}
          {histStats && histStats.cov && !isDeterministicMode && (
            <div style={{background:"#fff",borderRadius:14,padding:12,border:"1px solid #e2e8f0",marginBottom:10}}>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                <button onClick={()=>setTab("minVar")} style={{padding:"8px 12px",borderRadius:8,border:"none",fontSize:13,fontWeight:700,cursor:"pointer",background:tab==="minVar"?"#10b981":"#f1f5f9",color:tab==="minVar"?"#fff":"#475569"}}>Best Min Variance (by Sharpe)</button>
                <button onClick={()=>setTab("trueMinVar")} style={{padding:"8px 12px",borderRadius:8,border:"none",fontSize:13,fontWeight:700,cursor:"pointer",background:tab==="trueMinVar"?"#3b82f6":"#f1f5f9",color:tab==="trueMinVar"?"#fff":"#475569"}}>True Min Variance</button>
                <button onClick={()=>setTab("maxSharpe")} style={{padding:"8px 12px",borderRadius:8,border:"none",fontSize:13,fontWeight:700,cursor:"pointer",background:tab==="maxSharpe"?"#f59e0b":"#f1f5f9",color:tab==="maxSharpe"?"#fff":"#475569"}}>Best Max Sharpe</button>
              </div>
            </div>
          )}

          {histStats && histStats.cov && isDeterministicMode && (
            <div style={{background:"#fff",borderRadius:14,padding:12,border:"1px solid #e2e8f0",marginBottom:10}}>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                <button onClick={()=>setTab("minVar")} style={{padding:"8px 12px",borderRadius:8,border:"none",fontSize:13,fontWeight:700,cursor:"pointer",background:tab==="minVar"?"#10b981":"#f1f5f9",color:tab==="minVar"?"#fff":"#475569"}}>Deterministic Min Variance (by Sharpe)</button>
                <button onClick={()=>setTab("trueMinVar")} style={{padding:"8px 12px",borderRadius:8,border:"none",fontSize:13,fontWeight:700,cursor:"pointer",background:tab==="trueMinVar"?"#2563eb":"#f1f5f9",color:tab==="trueMinVar"?"#fff":"#475569"}}>Deterministic True Min Variance</button>
                <button onClick={()=>setTab("maxSharpe")} style={{padding:"8px 12px",borderRadius:8,border:"none",fontSize:13,fontWeight:700,cursor:"pointer",background:tab==="maxSharpe"?"#ca8a04":"#f1f5f9",color:tab==="maxSharpe"?"#fff":"#475569"}}>Deterministic Max Sharpe</button>
              </div>
            </div>
          )}

          {/* Variance-Covariance + weighted contribution matrix for selected tab */}
          {histStats && histStats.cov && port && (
            <CovarianceMatrixTable
              tickers={tickers}
              cov={histStats.cov}
              weights={port.weights}
              title={`Variance-Covariance Matrix (${histStats.years || histYrs}yr)`}
              activeLabel={portfolioLabel}
            />
          )}

          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(320px,1fr))",gap:14,marginBottom:10}}>
            {[
              ...(isDeterministicMode
                ? [
                    { title:"Deterministic Min Variance (by Sharpe)", bg:"linear-gradient(135deg,#ecfdf5,#ccfbf1)", border:"#a7f3d0", metricColor:"#047857", p:res.minVar, varData:minVarVaR, note:`Highest Sharpe frontier portfolio with vol <= ${((res.minVarVolCap ?? minVarVolCap) * 100).toFixed(1)}%` },
                    { title:"Deterministic True Min Variance", bg:"linear-gradient(135deg,#eff6ff,#dbeafe)", border:"#bfdbfe", metricColor:"#2563eb", p:res.detTrueMinVar, varData:detTrueMinVarVaR },
                    { title:"Deterministic Max Sharpe", bg:"linear-gradient(135deg,#fefce8,#fde68a)", border:"#fcd34d", metricColor:"#ca8a04", p:res.maxSharpe, varData:maxSharpeVaR }
                  ]
                : [
                    { title:"Best Min Variance (by Sharpe)", bg:"linear-gradient(135deg,#ecfdf5,#ccfbf1)", border:"#a7f3d0", metricColor:"#047857", p:res.minVar, varData:minVarVaR, note:`Top Sharpe with vol <= ${((res.minVarVolCap ?? minVarVolCap) * 100).toFixed(1)}% (${res.minVarEligibleCount} eligible sims)` },
                    { title:"True Min Variance", bg:"linear-gradient(135deg,#eff6ff,#dbeafe)", border:"#bfdbfe", metricColor:"#1d4ed8", p:res.trueMinVar, varData:trueMinVarVaR },
                    { title:"Best Max Sharpe", bg:"linear-gradient(135deg,#fffbeb,#fed7aa)", border:"#fdba74", metricColor:"#b45309", p:res.maxSharpe, varData:maxSharpeVaR }
                  ])
            ].map((card) => (
              <div key={card.title} style={{background:card.bg,borderRadius:16,padding:18,border:`1px solid ${card.border}`}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
                  <div style={{width:10,height:10,borderRadius:999,background:card.metricColor}}/>
                  <h3 style={{fontSize:14,fontWeight:700,color:"#0f172a",margin:0}}>{card.title}</h3>
                  <span style={{fontSize:11,fontWeight:700,color:card.metricColor,background:"#fff",padding:"2px 8px",borderRadius:999,marginLeft:"auto"}}>
                    {Number.isFinite(card.p.simNumber) ? `#${card.p.simNumber.toLocaleString()}` : "deterministic"}
                  </span>
                </div>
                {card.note && <div style={{fontSize:11,color:"#64748b",marginBottom:10}}>{card.note}</div>}
                <div style={{display:"grid",gridTemplateColumns:"repeat(2,minmax(0,1fr))",gap:10,textAlign:"center"}}>
                  <div style={{background:"rgba(255,255,255,.7)",border:"1px solid rgba(226,232,240,.9)",borderRadius:10,padding:"10px 8px"}}>
                    <div style={{fontSize:18,fontWeight:800,color:card.metricColor,fontFamily:MO}}>{fmt(card.p.ret)}</div>
                    <div style={{fontSize:11,color:"#64748b"}}>Return</div>
                  </div>
                  <div style={{background:"rgba(255,255,255,.7)",border:"1px solid rgba(226,232,240,.9)",borderRadius:10,padding:"10px 8px"}}>
                    <div style={{fontSize:18,fontWeight:800,color:"#334155",fontFamily:MO}}>{fmt(card.p.vol)}</div>
                    <div style={{fontSize:11,color:"#64748b"}}>Vol</div>
                  </div>
                  <div style={{background:"rgba(255,255,255,.7)",border:"1px solid rgba(226,232,240,.9)",borderRadius:10,padding:"10px 8px"}}>
                    <div style={{fontSize:18,fontWeight:800,color:card.metricColor,fontFamily:MO}}>{fN(card.p.sharpe)}</div>
                    <div style={{fontSize:11,color:"#64748b"}}>Sharpe</div>
                  </div>
                  <div style={{background:"rgba(255,255,255,.7)",border:"1px solid rgba(226,232,240,.9)",borderRadius:10,padding:"10px 8px"}}>
                    <div style={{fontSize:18,fontWeight:800,color:"#be123c",fontFamily:MO}}>{fmt(card.varData?.worstLoss)}</div>
                    <div style={{fontSize:11,color:"#64748b"}}>{`VaR ${res.varMethod === "parametric" ? "(Parametric)" : "(Historical)"} ${varHorizonText}`}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div style={{fontSize:11,color:"#64748b",marginBottom:20}}>
            {isDeterministicMode
              ? "Deterministic mode uses direct long-only quadratic programming on the fixed user ticker set. Best Min Variance (by Sharpe) is selected from efficient-frontier points that satisfy the volatility cap."
              : "Note: \"Best Min Variance (by Sharpe)\" is the highest-Sharpe portfolio that satisfies the volatility cap. \"True Min Variance\" is the absolute lowest-volatility portfolio."}
          </div>

          {res.deterministic && !isDeterministicMode && (
            <div style={{background:"#fff",borderRadius:16,padding:20,marginBottom:20,border:"1px solid #e2e8f0",boxShadow:"0 10px 24px rgba(15,23,42,.06)"}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap",marginBottom:14}}>
                <div>
                  <h3 style={{fontSize:14,fontWeight:700,color:"#0f172a",margin:"0 0 4px"}}>Engine Comparison</h3>
                  <div style={{fontSize:12,color:"#64748b"}}>Monte Carlo remains active. Deterministic portfolios are computed in parallel and shown separately below.</div>
                </div>
                <div style={{fontSize:12,fontWeight:700,color:"#475569",background:"#f8fafc",border:"1px solid #e2e8f0",borderRadius:999,padding:"5px 10px"}}>
                  {res.deterministic.minVar.method}
                </div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(240px,1fr))",gap:12}}>
                <div style={{background:"linear-gradient(135deg,#ecfdf5,#dcfce7)",border:"1px solid #a7f3d0",borderRadius:14,padding:"14px 16px"}}>
                  <div style={{fontSize:12,fontWeight:700,color:"#166534",marginBottom:6}}>Monte Carlo Min Var by Sharpe</div>
                  <div style={{fontFamily:MO,fontSize:13,color:"#166534"}}>{fmt(res.minVar.ret)} return</div>
                  <div style={{fontFamily:MO,fontSize:13,color:"#166534"}}>{fmt(res.minVar.vol)} vol</div>
                  <div style={{fontFamily:MO,fontSize:13,color:"#166534"}}>{fN(res.minVar.sharpe)} Sharpe</div>
                </div>
                <div style={{background:"linear-gradient(135deg,#eff6ff,#dbeafe)",border:"1px solid #bfdbfe",borderRadius:14,padding:"14px 16px"}}>
                  <div style={{fontSize:12,fontWeight:700,color:"#1d4ed8",marginBottom:6}}>Deterministic True Min Variance</div>
                  <div style={{fontFamily:MO,fontSize:13,color:"#1d4ed8"}}>{fmt(res.deterministic.minVar.ret)} return</div>
                  <div style={{fontFamily:MO,fontSize:13,color:"#1d4ed8"}}>{fmt(res.deterministic.minVar.vol)} vol</div>
                  <div style={{fontFamily:MO,fontSize:13,color:"#1d4ed8"}}>{fN(res.deterministic.minVar.sharpe)} Sharpe</div>
                </div>
                <div style={{background:"linear-gradient(135deg,#fff7ed,#ffedd5)",border:"1px solid #fdba74",borderRadius:14,padding:"14px 16px"}}>
                  <div style={{fontSize:12,fontWeight:700,color:"#c2410c",marginBottom:6}}>Monte Carlo Max Sharpe</div>
                  <div style={{fontFamily:MO,fontSize:13,color:"#c2410c"}}>{fmt(res.maxSharpe.ret)} return</div>
                  <div style={{fontFamily:MO,fontSize:13,color:"#c2410c"}}>{fmt(res.maxSharpe.vol)} vol</div>
                  <div style={{fontFamily:MO,fontSize:13,color:"#c2410c"}}>{fN(res.maxSharpe.sharpe)} Sharpe</div>
                </div>
                <div style={{background:"linear-gradient(135deg,#fefce8,#fde68a)",border:"1px solid #fcd34d",borderRadius:14,padding:"14px 16px"}}>
                  <div style={{fontSize:12,fontWeight:700,color:"#a16207",marginBottom:6}}>Deterministic Max Sharpe</div>
                  <div style={{fontFamily:MO,fontSize:13,color:"#a16207"}}>{fmt(res.deterministic.maxSharpe.ret)} return</div>
                  <div style={{fontFamily:MO,fontSize:13,color:"#a16207"}}>{fmt(res.deterministic.maxSharpe.vol)} vol</div>
                  <div style={{fontFamily:MO,fontSize:13,color:"#a16207"}}>{fN(res.deterministic.maxSharpe.sharpe)} Sharpe</div>
                </div>
              </div>
            </div>
          )}

          {!isDeterministicMode && (
          <div style={{background:"#fff",borderRadius:16,padding:20,marginBottom:20,border:"1px solid #e2e8f0",boxShadow:"0 10px 24px rgba(15,23,42,.06)"}}>
            <h3 style={{fontSize:14,fontWeight:700,color:"#0f172a",margin:"0 0 14px"}}>Efficient Frontier</h3>
            <Suspense fallback={<div style={{height:310,display:"grid",placeItems:"center",color:"#64748b",fontSize:14}}>Loading frontier chart...</div>}>
              <EfficientFrontierChart
                frontier={res.frontier}
                minVarChartPoint={minVarChartPoint}
                maxSharpeChartPoint={maxSharpeChartPoint}
                trueMinVarPoint={trueMinVarPoint}
              />
            </Suspense>
          </div>
          )}

          <div style={{display:"grid",gridTemplateColumns:"1fr",gap:16,marginBottom:20}}>
            {isDeterministicMode ? (
              <>
                <LiveAnalysisTable title="Deterministic Min Variance (by Sharpe) Live Analysis" tickers={tickers} weights={res.minVar.weights} stocks={stocks} liveData={liveData} accentColor="#10b981" loading={fetching}/>
                <LiveAnalysisTable title="Deterministic True Min Variance Live Analysis" tickers={tickers} weights={res.detTrueMinVar.weights} stocks={stocks} liveData={liveData} accentColor="#2563eb" loading={fetching}/>
                <LiveAnalysisTable title="Deterministic Max Sharpe Live Analysis" tickers={tickers} weights={res.maxSharpe.weights} stocks={stocks} liveData={liveData} accentColor="#ca8a04" loading={fetching}/>
              </>
            ) : (
              <>
                <LiveAnalysisTable title="Best Min Variance (by Sharpe) Live Analysis" tickers={tickers} weights={res.minVar.weights} stocks={stocks} liveData={liveData} accentColor="#10b981" loading={fetching}/>
                <LiveAnalysisTable title="True Min Variance Live Analysis" tickers={tickers} weights={res.trueMinVar.weights} stocks={stocks} liveData={liveData} accentColor="#22c55e" loading={fetching}/>
                <LiveAnalysisTable title="Best Max Sharpe Live Analysis" tickers={tickers} weights={res.maxSharpe.weights} stocks={stocks} liveData={liveData} accentColor="#f59e0b" loading={fetching}/>
              </>
            )}
          </div>

          <div style={{background:"#fff",borderRadius:16,padding:12,border:"1px solid #e2e8f0",marginBottom:12}}>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              <button onClick={()=>setInfoTab("glossary")} style={{padding:"8px 12px",borderRadius:8,border:"none",fontSize:14,fontWeight:700,cursor:"pointer",background:infoTab==="glossary"?"#4f46e5":"#f1f5f9",color:infoTab==="glossary"?"#fff":"#475569"}}>Glossary</button>
              <button onClick={()=>setInfoTab("implNotes")} style={{padding:"8px 12px",borderRadius:8,border:"none",fontSize:14,fontWeight:700,cursor:"pointer",background:infoTab==="implNotes"?"#4f46e5":"#f1f5f9",color:infoTab==="implNotes"?"#fff":"#475569"}}>Implementation Notes</button>
            </div>
          </div>

          {infoTab === "glossary" ? (
            <GlossaryPanel histYrs={histYrs} varHorizonText={varHorizonText} returnModel={res?.returnModel || returnModel} varMethod={res?.varMethod || varMethod} minVarVolCap={res?.minVarVolCap ?? minVarVolCap} rfRate={res?.rfRate ?? rfRate} engineMode={res?.engineMode || engineMode} />
          ) : (
            <ImplementationNotesPanel histYrs={histYrs} numSims={numSims} returnModel={res?.returnModel || returnModel} varMethod={res?.varMethod || varMethod} minVarVolCap={res?.minVarVolCap ?? minVarVolCap} rfRate={res?.rfRate ?? rfRate} engineMode={res?.engineMode || engineMode} />
          )}

          <div style={{background:"rgba(234,179,8,.06)",border:"1px solid rgba(234,179,8,.15)",borderRadius:12,padding:"10px 14px",marginBottom:20}}>
            <div style={{fontSize:13,color:"#a16207",lineHeight:1.6}}><strong>Disclaimer:</strong> Historical prices from Yahoo Finance (adjusted close). Covariance/volatility are historical. Expected returns can be historical or modeled using analyst targets. VaR can be historical or parametric. <b>Verify before trading.</b> Not financial advice.</div>
          </div>
        </>)}

        {!res&&tickers.length>=2&&!busy&&(
          <div style={{background:"rgba(255,255,255,.03)",border:"1px solid rgba(255,255,255,.06)",borderRadius:16,padding:"36px 24px",textAlign:"center"}}>
            <div style={{fontSize:36,marginBottom:10,opacity:.3}}>\uD83D\uDCCA</div>
            <h3 style={{fontSize:16,fontWeight:700,color:"#94a3b8",margin:"0 0 4px"}}>{tickers.length} stocks ready</h3>
            <p style={{fontSize:14,color:"#475569",margin:0}}>Click Optimize to download {histYrs}yr price history from Yahoo Finance and run the selected engine on your tickers. No API key needed for optimization.</p>
          </div>)}
      </div>
    </div>
  );
}
