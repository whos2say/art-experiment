# Resonant Spectra — art-experiment

A generative light show that reads photographs as musical scores. Each photo in
the **PHishy Art** album is analysed into a palette and a set of gestures, then
performed as a movement on canvas. When audio is playing, the visuals react to
it in real time — bass drives the plumes, mids the washes, highs the beams.

Live at **https://art.whostosay.org** (previously `whostosay.org/art-experiment`).

## How it works

Three things happen on load:

1. **`photos/manifest.json`** is fetched. Each entry carries a pre-computed
   palette (extracted at build time by `build/palette.mjs`), so the page never
   has to do colour clustering in the browser.
2. **Each photo becomes a "study"** — `buildStudy()` turns the image into a
   score: 48 colour regions, its five brightest lights with their streak
   direction, a warm centre, and the frame's overall smear angle.
   `computeConductor()` turns the music into a single normalised *tension*.
3. **Two layers are grown and composited every frame.** The *light* layer is
   the show — washes, plumes and beams — and the *photo* layer is the picture
   itself, drifting along its own light direction. A **Look** decides how they
   combine.

If the manifest can't be reached, the page falls back to a single built-in
photo so the engine still runs.

## Looks

| Key | Look | What you see |
| --- | --- | --- |
| `2` | **Bloom** (default) | The photograph full-frame, with the light show blooming over it. |
| `1` | **Reveal** | Darkness until the light lands on the photo — the picture exists only where it's lit. Trails smear it into the dark. |
| `3` | **Prism** | Red, green and blue pulled apart along the photo's smear angle, pulsing with the bass. |
| `4` | **Spectra** | Pure light grown from the photo — the original abstract mode. |

`L` cycles them.

## Controls

**Mouse** — drag on the picture: left/right shifts hue, up/down changes
intensity. Scroll to zoom the photograph. Double-click for fullscreen. Click
any thumbnail in the filmstrip to jump to that photo.

**Keyboard** — `[` `]` hue · `-` `=` intensity · `C` colour mode (Natural →
Duotone → Mono → Negative) · `0` reset colour · `←` `→` photos · `space`
pause · `R` release · `Home` start over from photo 1 · `M` play/pause track · `F` fullscreen · `P` panel ·
`S` save still · `?` help · `esc` close.

Colour is a single global transform applied to the photo *and* to every wash,
plume and beam grown from it, so the two never disagree.

In fullscreen the controls and cursor fade after a few seconds idle; move the
mouse to bring them back.

## Layout

```
index.html                        the whole engine — no build step, no bundler
api/phishin-proxy.js              same-origin proxy for phish.in/api/v2
api/refresh-photos.js             POST endpoint that fires the refresh Action
photos/                           ~55 album images
photos/manifest.json              per-photo dimensions + extracted palette
build/fetch-album.mjs             scrapes the Google Photos album
build/palette.mjs                 extracts palettes, writes the manifest
build/check-phishin.mjs           sanity-checks the phish.in API
config.json                       album URL, audio bands, palette settings
vercel.json                       the /api/phishin rewrite
.github/workflows/refresh-photos.yml
```

The app is served from the **repository root** — no subdirectory, no build step.
`ASSET_BASE` in `index.html` is `'/'` for exactly this reason; if the app is ever
moved back under a path prefix, that constant has to change with it.

## The phish.in proxy

`vercel.json` rewrites `/api/phishin/:path*` → `/api/phishin-proxy`, with **no
query string**. The proxy reads the original request path from `req.url`, strips
the `/api/phishin` prefix, and forwards the remainder to
`https://phish.in/api/v2`:

```
/api/phishin/search/Tweezer           → phish.in/api/v2/search/Tweezer
/api/phishin/tracks?song_slug=tweezer → phish.in/api/v2/tracks?song_slug=tweezer
```

> Don't "fix" the rewrite to `/api/phishin-proxy?path=:path*`. That form belongs
> to an older edge-function proxy that read a `path` query parameter. Pairing it
> with this proxy produces upstream URLs like `phish.in/api/v2-proxy?path=…` and
> every lookup fails.

No API key is required — phish.in's v2 API is open.

## Refreshing the album

The photos are committed to the repo, not fetched at runtime. To pull in new
album images:

- **From the site** — the *Rescan album* button under Actions POSTs to
  `/api/refresh-photos`, which fires a `repository_dispatch`. A 202 means the
  Action started, not that it finished.
- **From GitHub** — run the *Refresh photos* workflow manually from the Actions
  tab.

Either way the workflow runs `npm run build:photos`, commits anything that
changed under `photos/`, and that commit triggers a redeploy.

## Environment variables

Set on the Vercel project for **Production and Preview**:

| Variable | Required | Purpose |
| --- | --- | --- |
| `GITHUB_DISPATCH_TOKEN` | yes, for refresh | Fine-grained PAT on this repo, Contents: read/write. Without it `/api/refresh-photos` returns 500. |
| `REFRESH_SECRET` | optional | If set, callers must send a matching `x-refresh-key` header. The in-page button does not send one, so setting this disables the button. |

There is deliberately no `PHISHIN_API_KEY` — nothing in this repo reads one.

## Local development

`index.html` is plain HTML/JS and opens directly in a browser, but the phish.in
search and the rescan button need the `/api` functions:

```bash
npm install
npx vercel dev
```

To re-scrape the album locally:

```bash
npm run build:photos     # fetch-album.mjs, then palette.mjs
npm run verify:phishin   # check the phish.in API is reachable
```

> There is intentionally no `build` script. Vercel runs `npm run build`
> automatically when one exists, which would fire the album scrape on every
> deploy. The workflow calls `build:photos` by name instead.

## See also

- [`PHILOSOPHY.md`](PHILOSOPHY.md) — what this piece is trying to be
- [`CHANGELOG.md`](CHANGELOG.md)
- [`docs/MCP.md`](docs/MCP.md)
