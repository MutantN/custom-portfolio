import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { getQuotesResponse } from './api/lib/quotes-service.js'

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
              const { status, payload } = await getQuotesResponse({
                symbolsRaw: url.searchParams.get("symbols"),
                finnhubKey,
                fmpKey
              });
              res.statusCode = status;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(payload));
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
