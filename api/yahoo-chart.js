export default async function handler(req, res) {
  const { ticker, period1, period2 } = req.query;

  if (!ticker || !period1 || !period2) {
    return res.status(400).json({ error: 'Missing required params: ticker, period1, period2' });
  }

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${period1}&period2=${period2}&interval=1mo&includeAdjustedClose=true`;

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return res.status(response.status).json({ error: `Yahoo Finance returned ${response.status}`, detail: text.slice(0, 500) });
    }

    const data = await response.json();
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json(data);
  } catch (err) {
    return res.status(502).json({ error: 'Failed to reach Yahoo Finance', detail: err.message });
  }
}
