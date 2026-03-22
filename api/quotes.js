import { getQuotesResponse } from "./lib/quotes-service.js";

function send(res, status, payload) {
  res.status(status).json(payload);
}

export default async function handler(req, res) {
  if (req.method !== "GET") return send(res, 405, { error: "method_not_allowed" });
  const { status, payload } = await getQuotesResponse({
    symbolsRaw: req.query.symbols,
    finnhubKey: process.env.FINNHUB_API_KEY,
    fmpKey: process.env.FMP_API_KEY,
  });
  return send(res, status, payload);
}
