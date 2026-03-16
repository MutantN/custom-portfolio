const quoteCache = new Map();
const analystCache = new Map();
const QUOTE_TTL_MS = 60 * 1000;
const ANALYST_TTL_MS = 6 * 60 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function send(res, status, payload) {
  res.status(status).json(payload);
}

function parseSymbols(raw) {
  return Array.from(
    new Set(
      String(raw || "")
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
    )
  ).slice(0, 50);
}

function providerSymbolForQuote(symbol) {
  if (symbol === "SQ") return "XYZ";
  if (symbol === "BRK-B") return "BRK.B";
  return symbol;
}

function normalizeRating(value) {
  if (!value) return "N/A";
  const v = String(value).toLowerCase();
  if (v.includes("strong buy")) return "Strong Buy";
  if (v.includes("buy")) return "Buy";
  if (v.includes("hold") || v.includes("neutral")) return "Hold";
  if (v.includes("strong sell")) return "Strong Sell";
  if (v.includes("sell")) return "Sell";
  return "N/A";
}

function pickFirstNumber(obj, keys) {
  for (const k of keys) {
    const n = Number(obj?.[k]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function pickFirstString(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return "";
}

async function fetchFmpJson(url) {
  const r = await fetch(url);
  if (!r.ok) return null;
  const json = await r.json();
  if (json && typeof json === "object" && !Array.isArray(json) && (json["Error Message"] || json.error)) {
    return null;
  }
  return json;
}

function deriveConsensusRating(row) {
  const strongBuy = pickFirstNumber(row, ["strongBuy", "strongBuyCount", "strongBuyRatings"]);
  const buy = pickFirstNumber(row, ["buy", "buyCount", "buyRatings"]);
  const hold = pickFirstNumber(row, ["hold", "holdCount", "holdRatings"]);
  const sell = pickFirstNumber(row, ["sell", "sellCount", "sellRatings"]);
  const strongSell = pickFirstNumber(row, ["strongSell", "strongSellCount", "strongSellRatings"]);
  const total = strongBuy + buy + hold + sell + strongSell;
  if (total <= 0) return { rating: "N/A", analystCount: 0 };

  const score = (2 * strongBuy + 1 * buy + 0 * hold - 1 * sell - 2 * strongSell) / total;
  let rating = "Hold";
  if (score >= 1.25) rating = "Strong Buy";
  else if (score >= 0.5) rating = "Buy";
  else if (score <= -1.25) rating = "Strong Sell";
  else if (score <= -0.5) rating = "Sell";

  return { rating, analystCount: total };
}

async function fetchFmpAnalystData(symbol, fmpKey) {
  if (!fmpKey) {
    return { targetPrice: 0, analystCount: 0, targetDate: "", rating: "N/A", ratingDate: "" };
  }

  const targetCandidates = [
    `https://financialmodelingprep.com/stable/price-target-consensus?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(fmpKey)}`,
    `https://financialmodelingprep.com/stable/price-target-summary?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(fmpKey)}`,
  ];

  let targetRaw = null;
  for (const u of targetCandidates) {
    const json = await fetchFmpJson(u);
    if (!json) continue;
    targetRaw = Array.isArray(json) ? json[0] : json;
    if (targetRaw) break;
  }

  const ratingCandidates = [
    `https://financialmodelingprep.com/stable/grades-consensus?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(fmpKey)}`,
    `https://financialmodelingprep.com/stable/ratings-snapshot?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(fmpKey)}`,
  ];

  let ratingRaw = null;
  for (const u of ratingCandidates) {
    const json = await fetchFmpJson(u);
    if (!json) continue;
    ratingRaw = Array.isArray(json) ? json[0] : json;
    if (ratingRaw) break;
  }

  const targetPrice = pickFirstNumber(targetRaw, ["targetConsensus", "targetPrice", "priceTarget", "targetMean", "targetMedian"]);
  const targetAnalystCount = pickFirstNumber(targetRaw, ["analystCount", "numberAnalystOpinions", "numAnalysts", "numberOfAnalysts"]);
  const targetDate = pickFirstString(targetRaw, ["date", "updatedAt", "publishedDate", "lastUpdated"]);

  const mappedRating = normalizeRating(pickFirstString(ratingRaw, ["ratingRecommendation", "rating", "recommendation", "newGrade"]));
  const derived = deriveConsensusRating(ratingRaw || {});
  const rating = mappedRating !== "N/A" ? mappedRating : derived.rating;
  const analystCount = Math.max(targetAnalystCount, derived.analystCount);
  const ratingDate = pickFirstString(ratingRaw, ["date", "publishedDate", "gradingCompany", "lastUpdated"]);

  return { targetPrice, analystCount, targetDate, rating, ratingDate };
}

export default async function handler(req, res) {
  if (req.method !== "GET") return send(res, 405, { error: "method_not_allowed" });

  const finnhubKey = process.env.FINNHUB_API_KEY;
  const fmpKey = process.env.FMP_API_KEY;
  if (!finnhubKey) {
    return send(res, 500, { error: "missing_finnhub_api_key", message: "Set FINNHUB_API_KEY in Vercel environment variables." });
  }

  const symbols = parseSymbols(req.query.symbols);
  if (!symbols.length) return send(res, 400, { error: "missing_symbols" });

  const quotes = {};
  const missing = [];

  for (const symbol of symbols) {
    const providerSymbol = providerSymbolForQuote(symbol);
    const now = Date.now();
    const quoteCached = quoteCache.get(symbol);
    const analystCached = analystCache.get(symbol);
    const quoteFresh = quoteCached && now - quoteCached.ts < QUOTE_TTL_MS;
    const analystFresh = analystCached && now - analystCached.ts < ANALYST_TTL_MS;

    if (quoteFresh) {
      const merged = { ...quoteCached.data };
      if (analystFresh) Object.assign(merged, analystCached.data);
      quotes[symbol] = merged;
      continue;
    }

    const quoteUrl = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(providerSymbol)}&token=${encodeURIComponent(finnhubKey)}`;
    const quoteResp = await fetch(quoteUrl);
    if (quoteResp.status === 429) {
      return send(res, 429, { error: "provider_rate_limited", source: "Finnhub", quotes, missing: symbols.filter((s) => !quotes[s]) });
    }
    if (!quoteResp.ok) {
      missing.push(symbol);
      continue;
    }

    const q = await quoteResp.json();
    const price = Number(q?.c);
    if (!Number.isFinite(price) || price <= 0) {
      missing.push(symbol);
      continue;
    }

    const base = {
      price,
      prev: Number(q?.pc) || 0,
      name: symbol,
      exchange: "US",
      time: Number(q?.t) || Math.floor(now / 1000),
      targetPrice: 0,
      targetDate: "",
      analystCount: 0,
      rating: "N/A",
      ratingDate: "",
    };

    let analystData = analystFresh ? analystCached.data : null;
    if (!analystData && fmpKey) {
      try {
        analystData = await fetchFmpAnalystData(providerSymbol, fmpKey);
        analystCache.set(symbol, { ts: now, data: analystData });
        await sleep(80);
      } catch {
        analystData = null;
      }
    }

    const merged = analystData ? { ...base, ...analystData } : base;
    quotes[symbol] = merged;
    quoteCache.set(symbol, { ts: now, data: base });

    await sleep(140);
  }

  return send(res, 200, { source: fmpKey ? "Finnhub+FMP" : "Finnhub", quotes, missing });
}
