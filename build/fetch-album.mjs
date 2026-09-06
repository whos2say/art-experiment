#!/usr/bin/env node
/**
 * Fetch all images from the PHishy Art Google Photos shared album,
 * downscale each to maxWidth, and write photos/manifest.json.
 *
 * Google Photos shared albums embed image data in AF_initDataCallback
 * script blocks.  The regexes below target the lh3.googleusercontent.com
 * URL array pattern that has been stable since ~2021; update them here if
 * Google's markup shifts.
 *
 * Usage:  node build/fetch-album.mjs
 */

import { createWriteStream, mkdirSync, existsSync } from 'fs';
import { writeFile, readFile } from 'fs/promises';
import { join, extname } from 'path';
import { pipeline } from 'stream/promises';
import sharp from 'sharp';

const cfg = JSON.parse(await readFile(new URL('../config.json', import.meta.url)));
const { albumUrl, outputDir, maxWidth, quality } = cfg.googlePhotos;
const OUT = join(import.meta.dirname, '..', outputDir);
mkdirSync(OUT, { recursive: true });

// ── 1. Resolve the short URL → real album page ───────────────────────────────
async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

console.log(`Fetching album: ${albumUrl}`);
const html = await fetchPage(albumUrl);

// ── 2. Extract image URLs ─────────────────────────────────────────────────────
// Google Photos embeds image lists in multiple ways; we try in order of
// reliability and merge results.

const found = new Set();

// Google Photos 2024+ embeds images as lh3.googleusercontent.com/pw/AP1Gcz[HASH]=w...-h...-[options]
// We extract the base URL (before =) so we can append our own size.

// Pattern A: pw/ (Photo Works) path — the standard modern format
// e.g. https://lh3.googleusercontent.com/pw/AP1GczM7rq05...=w96-h72-no
const reA = /https:\/\/lh3\.googleusercontent\.com\/pw\/[A-Za-z0-9_\-]+/g;
for (const m of html.matchAll(reA)) found.add(m[0]);

// Pattern B: legacy path (no /pw/) with =w suffix — older albums
if (found.size === 0) {
  const reB = /https:\/\/lh3\.googleusercontent\.com\/[A-Za-z0-9_\-\/\.]+(?==w\d)/g;
  for (const m of html.matchAll(reB)) found.add(m[0]);
}

// Pattern C: any lh3 URL followed by =w or =s in JSON
if (found.size === 0) {
  const reC = /"(https:\/\/lh3\.googleusercontent\.com\/[^"]+?)(?:=w|=s)[^"]*"/g;
  for (const m of html.matchAll(reC)) found.add(m[1]);
}

if (found.size === 0) {
  console.error('No images found — Google markup may have shifted.  Check fetch-album.mjs regexes.');
  process.exit(1);
}

const urls = [...found];
console.log(`Found ${urls.length} image(s)`);

// ── 3. Download + downscale each image ───────────────────────────────────────
const manifest = { photos: [], generated: new Date().toISOString() };

for (let i = 0; i < urls.length; i++) {
  // =w...-h...-no → resize to fit, no crop; -k → server-side optimisation
  const srcUrl = `${urls[i]}=w${maxWidth}-h${maxWidth}-no-k`;
  const filename = `photo_${String(i + 1).padStart(3, '0')}.jpg`;
  const dest = join(OUT, filename);

  process.stdout.write(`[${i + 1}/${urls.length}] ${filename} … `);

  try {
    const res = await fetch(srcUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const meta = await sharp(buf)
      .resize({ width: maxWidth, withoutEnlargement: true })
      .jpeg({ quality })
      .toFile(dest);
    console.log(`${meta.width}×${meta.height}`);
    manifest.photos.push({ filename, width: meta.width, height: meta.height, palette: null, hotspots: null });
  } catch (err) {
    console.log(`SKIP (${err.message})`);
  }
}

// Write a minimal manifest; palette.mjs will augment it.
await writeFile(
  join(OUT, 'manifest.json'),
  JSON.stringify(manifest, null, 2)
);
console.log(`\nWrote photos/manifest.json with ${manifest.photos.length} entries`);
