#!/usr/bin/env node
/**
 * Verify phish.in API access and CORS policy for MP3 streaming.
 *
 * Usage:
 *   node build/check-phishin.mjs
 *   SAMPLE_MP3=https://phish.in/blob/xxx.mp3 node build/check-phishin.mjs
 *
 * Exit 0 → CORS is open, stream directly from the browser.
 * Exit 1 → CORS is blocked, use the /api/phishin-proxy Vercel function.
 */

import { readFile } from 'fs/promises';

const cfg = JSON.parse(await readFile(new URL('../config.json', import.meta.url)));
const API = cfg.audio.phishinApiBase;

// ── 1. Check API reachability ────────────────────────────────────────────────
process.stdout.write(`Checking ${API}/songs/tweezer … `);
let trackUrl;
try {
  const res = await fetch(`${API}/tracks?song_slug=tweezer&per_page=1`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const track = json.tracks?.[0];
  trackUrl = track?.mp3_url;
  console.log(`OK  (${json.total_entries} Tweezer recordings)`);
} catch (err) {
  console.log(`FAIL (${err.message})`);
  process.exit(1);
}

// ── 2. Resolve a sample MP3 URL ──────────────────────────────────────────────
const mp3 = process.env.SAMPLE_MP3 || trackUrl;
if (!mp3) {
  console.log('No MP3 URL available — skipping CORS check.');
  process.exit(0);
}

// ── 3. HEAD request to inspect CORS headers ──────────────────────────────────
process.stdout.write(`CORS check: ${mp3.slice(0, 60)}… `);
try {
  const res = await fetch(mp3, {
    method: 'HEAD',
    headers: {
      Origin: 'https://whostosay.org',
      'Access-Control-Request-Method': 'GET',
    },
  });
  const acao = res.headers.get('access-control-allow-origin') || '';
  const acam = res.headers.get('access-control-allow-methods') || '';
  console.log(`ACAO: "${acao}"  ACAM: "${acam}"`);

  if (acao === '*' || acao.includes('whostosay.org')) {
    console.log('\n✅  CORS is permissive — browser can stream MP3s directly.');
    console.log('   index.html can use fetch() / <audio> without a proxy.');
    process.exit(0);
  } else {
    console.log('\n⚠️   CORS is restricted — MP3s must be proxied.');
    console.log('   Vercel function api/phishin-proxy.js is required.');
    console.log('   index.html falls back to local-file loader + tap-tempo.');
    process.exit(1);
  }
} catch (err) {
  console.log(`\n⚠️   CORS HEAD failed (${err.message}) — assuming restricted.`);
  process.exit(1);
}
