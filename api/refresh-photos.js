/**
 * Vercel Serverless Function — fires the "refresh-photos" GitHub Action.
 *
 * POST /api/refresh-photos
 *   → repository_dispatch on whos2say/art-experiment (event_type: refresh-photos)
 *   → .github/workflows/refresh-photos.yml re-scrapes the album and commits
 *   → the commit triggers a Vercel redeploy
 *
 * Returns 202 as soon as GitHub accepts the dispatch. It does NOT wait for
 * the scrape, so a 202 means "started", not "finished".
 *
 * Env:
 *   GITHUB_DISPATCH_TOKEN  (required) fine-grained PAT, Contents: read/write
 *   REFRESH_SECRET         (optional) if set, callers must send x-refresh-key
 */
const OWNER = 'whos2say';
const REPO  = 'art-experiment';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-refresh-key');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  const secret = process.env.REFRESH_SECRET;
  if (secret && req.headers['x-refresh-key'] !== secret) {
    return res.status(401).json({ error: 'bad key' });
  }

  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) return res.status(500).json({ error: 'server not configured' });

  try {
    const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'resonant-spectra-refresh',
      },
      body: JSON.stringify({ event_type: 'refresh-photos' }),
    });
    if (r.status === 204) return res.status(202).json({ ok: true, status: 'scan started' });
    return res.status(502).json({ ok: false, github: r.status, detail: (await r.text()).slice(0, 300) });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e) });
  }
}
