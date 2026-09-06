# phish.in MCP Integration

## What is the phish.in MCP?

Phish.in exposes a **Model Context Protocol (MCP) server** alongside its REST JSON API v2.
The MCP endpoints are:

| Endpoint | Protocol | Purpose |
|---|---|---|
| `https://phish.in/mcp` | Streamable HTTP (MCP) | Default — Claude + compatible clients |
| `https://phish.in/mcp/anthropic` | Streamable HTTP (MCP) | Claude-specific connector |
| `https://phish.in/mcp/openai` | Streamable HTTP (MCP) | ChatGPT connector |
| `https://phish.in/api/v2` | REST JSON | Plain API (used in this project) |

## Decision: plain API vs. MCP proxy

Run `npm run verify:phishin` to check live CORS headers.

### If CORS is open (exit 0)
The REST API is usable directly from the browser without any server-side code.
`index.html` uses `fetch()` against `https://phish.in/api/v2/*` directly:

```js
// Song search
const r = await fetch('https://phish.in/api/v2/tracks?song_slug=tweezer&per_page=20');
const { tracks } = await r.json();
// tracks[i].mp3_url → direct <audio src>
```

### If CORS is blocked (exit 1)
Add the Vercel function at `api/phishin-proxy.js` and point `index.html` at
`/api/phishin-proxy?path=tracks?song_slug=tweezer`.  The function forwards the
request to phish.in and adds permissive CORS headers.

The MCP endpoint (`/mcp`) is **not** used for the browser audio player — it is a
server-to-server (Claude ↔ phish.in) protocol.  The plain REST API covers all
show/track/MP3 lookups the player needs.

## Vercel proxy function (for CORS-blocked scenario)

File: `api/phishin-proxy.js` (already present in this repo).  Routes:

```
GET /api/phishin-proxy?path=tracks%3Fsong_slug%3Dtweezer&per_page=10
```

Internally calls `https://phish.in/api/v2/{path}` and streams the response
with `Access-Control-Allow-Origin: *`.

## Connecting phish.in MCP to Claude Code (optional)

To query phish.in from Claude Code directly, add to `.claude/settings.json`:

```json
{
  "mcpServers": {
    "phishin": {
      "url": "https://phish.in/mcp/anthropic",
      "type": "http"
    }
  }
}
```

This is unrelated to the browser audio player — it's for agentic use.
