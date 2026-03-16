import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

function providerSymbolForQuote(symbol) {
  if (symbol === "SQ") return "XYZ";
  if (symbol === "BRK-B") return "BRK.B";
  return symbol;
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

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) return null;
  const json = await r.json();
  if (json && typeof json === "object" && !Array.isArray(json) && (json["Error Message"] || json.error)) return null;
  return json;
}

async function fetchFmpAnalystData(symbol, fmpKey) {
  if (!fmpKey) return { targetPrice: 0, analystCount: 0, targetDate: "", rating: "N/A", ratingDate: "" };

  const targetCandidates = [
    `https://financialmodelingprep.com/stable/price-target-consensus?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(fmpKey)}`,
    `https://financialmodelingprep.com/stable/price-target-summary?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(fmpKey)}`
  ];
  let targetRaw = null;
  for (const u of targetCandidates) {
    const json = await fetchJson(u);
    if (!json) continue;
    targetRaw = Array.isArray(json) ? json[0] : json;
    if (targetRaw) break;
  }

  const ratingCandidates = [
    `https://financialmodelingprep.com/stable/grades-consensus?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(fmpKey)}`,
    `https://financialmodelingprep.com/stable/ratings-snapshot?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(fmpKey)}`
  ];
  let ratingRaw = null;
  for (const u of ratingCandidates) {
    const json = await fetchJson(u);
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
  const ratingDate = pickFirstString(ratingRaw, ["date", "publishedDate", "lastUpdated"]);
  return { targetPrice, analystCount, targetDate, rating, ratingDate };
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const finnhubKey = env.FINNHUB_API_KEY;
  const fmpKey = env.FMP_API_KEY;

  return {
    base: "/custom-portfolio/",
    plugins: [
      react(),
      {
        name: "local-api-routes",
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            try {
              if (req.url?.startsWith("/api/yahoo-chart") || req.url?.startsWith("/custom-portfolio/api/yahoo-chart")) {
                const url = new URL(req.url, "http://localhost");
                const ticker = (url.searchParams.get("ticker") || "").trim();
                const period1 = (url.searchParams.get("period1") || "").trim();
                const period2 = (url.searchParams.get("period2") || "").trim();
                if (!ticker || !period1 || !period2) {
                  res.statusCode = 400;
                  res.setHeader("Content-Type", "application/json");
                  res.end(JSON.stringify({ error: "Missing required params: ticker, period1, period2" }));
                  return;
                }
                const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${encodeURIComponent(period1)}&period2=${encodeURIComponent(period2)}&interval=1mo&includeAdjustedClose=true`;
                const upstream = await fetch(yahooUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
                const text = await upstream.text();
                res.statusCode = upstream.status;
                res.setHeader("Content-Type", "application/json");
                res.end(text);
                return;
              }

              if (!req.url?.startsWith("/api/quotes") && !req.url?.startsWith("/custom-portfolio/api/quotes")) return next();

              if (!finnhubKey) {
                res.statusCode = 500;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: "missing_finnhub_api_key", message: "Set FINNHUB_API_KEY in .env" }));
                return;
              }
              const url = new URL(req.url, "http://localhost");
              const symbols = Array.from(new Set((url.searchParams.get("symbols") || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean))).slice(0, 50);
              if (!symbols.length) {
                res.statusCode = 400;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: "missing_symbols" }));
                return;
              }

              const quotes = {};
              const missing = [];
              for (const symbol of symbols) {
                const providerSymbol = providerSymbolForQuote(symbol);
                const quoteUrl = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(providerSymbol)}&token=${encodeURIComponent(finnhubKey)}`;
                const quoteResp = await fetch(quoteUrl);
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
                  time: Number(q?.t) || Math.floor(Date.now() / 1000),
                  targetPrice: 0,
                  targetDate: "",
                  analystCount: 0,
                  rating: "N/A",
                  ratingDate: ""
                };
                const analystData = await fetchFmpAnalystData(providerSymbol, fmpKey);
                quotes[symbol] = { ...base, ...analystData };
              }

              res.statusCode = 200;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ source: fmpKey ? "Finnhub+FMP" : "Finnhub", quotes, missing }));
            } catch (err) {
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: "quotes_route_failed", message: err?.message || "unknown_error" }));
            }
          });
        }
      }
    ]
  };
});
