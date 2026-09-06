/**
 * Vercel Serverless Function — proxy for phish.in API v2.
 *
 * Mounted at /api/phishin-proxy via vercel.json rewrite:
 *   /api/phishin/:path* → /api/phishin-proxy
 *
 * The full original path is preserved in req.url so we strip the
 * /api/phishin prefix and forward the rest to phish.in/api/v2.
 *
 * Routes (via rewrite):
 *   /api/phishin/search/Tweezer          → phish.in/api/v2/search/Tweezer
 *   /api/phishin/tracks?song_slug=tweezer → phish.in/api/v2/tracks?song_slug=tweezer
 */

const PHISHIN_BASE = 'https://phish.in/api/v2';
const PREFIX = '/api/phishin';

export default async function handler(req, res) {
  // CORS preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  // Parse incoming URL to get path + query after /api/phishin
  const url = new URL(req.url, 'https://whostosay.org');
  const rest = url.pathname.startsWith(PREFIX)
    ? url.pathname.slice(PREFIX.length)
    : url.pathname;
  const upstream = `${PHISHIN_BASE}${rest}${url.search}`;

  try {
    const upstream_res = await fetch(upstream, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'whostosay.org/art-experiment',
      },
    });
    const body = await upstream_res.arrayBuffer();
    res.setHeader('Content-Type', upstream_res.headers.get('Content-Type') || 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.status(upstream_res.status).send(Buffer.from(body));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}
