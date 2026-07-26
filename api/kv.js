// Tiny proxy to Upstash Redis's REST API.
// Vercel's "Storage" tab (Marketplace -> Upstash) injects one of these env var pairs
// automatically when you connect a database to this project:
//   KV_REST_API_URL / KV_REST_API_TOKEN            (older Vercel KV naming)
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (native Upstash naming)
// This function checks for either so it works regardless of which one you set up.

function getCreds() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return { url, token };
}

export default async function handler(req, res) {
  const { url, token } = getCreds();
  if (!url || !token) {
    res.status(500).json({ error: 'No KV database is connected to this project yet. Add one from the Storage tab in Vercel, then redeploy.' });
    return;
  }

  try {
    if (req.method === 'GET') {
      const key = req.query.key;
      if (!key) { res.status(400).json({ error: 'key is required' }); return; }
      const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await r.json();
      res.status(200).json({ value: data.result ?? null });
      return;
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { key, value } = body || {};
      if (!key) { res.status(400).json({ error: 'key is required' }); return; }
      const r = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: String(value)
      });
      const data = await r.json();
      res.status(200).json({ ok: data.result === 'OK' });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
}
