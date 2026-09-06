#!/usr/bin/env node
/**
 * Extract dominant colour palette + hotspot positions from each photo in
 * photos/manifest.json, then write the augmented manifest back.
 *
 * Uses sharp to sample raw pixel data, then a simple median-cut colour
 * quantiser (no extra dependencies beyond sharp).
 *
 * Usage:  node build/palette.mjs
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import sharp from 'sharp';

const cfgPath  = new URL('../config.json', import.meta.url);
const cfg      = JSON.parse(await readFile(cfgPath));
const { clusters, hotspotThreshold } = cfg.palette;
const OUT      = join(import.meta.dirname, '..', 'photos');
const manifest = JSON.parse(await readFile(join(OUT, 'manifest.json')));

// ── Colour quantisation (median cut, k iterations) ──────────────────────────
function componentToHex(c) { return Math.round(c).toString(16).padStart(2, '0'); }
function rgbToHex(r, g, b) { return '#' + componentToHex(r) + componentToHex(g) + componentToHex(b); }

function medianCut(pixels, depth) {
  if (depth === 0 || pixels.length === 0) {
    // Return centroid of this bucket
    const n = pixels.length;
    if (n === 0) return [[128, 128, 128]];
    let r = 0, g = 0, b = 0;
    for (const p of pixels) { r += p[0]; g += p[1]; b += p[2]; }
    return [[r / n, g / n, b / n]];
  }

  // Find the channel with the greatest range
  let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
  for (const [r, g, b] of pixels) {
    if (r < minR) minR = r; if (r > maxR) maxR = r;
    if (g < minG) minG = g; if (g > maxG) maxG = g;
    if (b < minB) minB = b; if (b > maxB) maxB = b;
  }
  const rangeR = maxR - minR, rangeG = maxG - minG, rangeB = maxB - minB;
  const ch = rangeR >= rangeG && rangeR >= rangeB ? 0 : rangeG >= rangeB ? 1 : 2;
  pixels.sort((a, b) => a[ch] - b[ch]);
  const mid = Math.floor(pixels.length / 2);
  return [
    ...medianCut(pixels.slice(0, mid), depth - 1),
    ...medianCut(pixels.slice(mid),    depth - 1),
  ];
}

// ── Find bright hotspot centres (used to seed beam emitters) ─────────────────
function findHotspots(rawPixels, width, height, threshold) {
  const hotspots = [];
  const stride = width; // rawPixels is [r,g,b,r,g,b,...] flattened
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const off = (y * stride + x) * 3;
      const r = rawPixels[off], g = rawPixels[off + 1], b = rawPixels[off + 2];
      const brightness = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      if (brightness > 1 - threshold) {
        hotspots.push({ x: x / width, y: y / height });
      }
    }
  }
  // Cluster hotspots into at most 4 centres via simple grid bucketing
  if (hotspots.length === 0) return [{ x: 0.2, y: 0.25 }, { x: 0.35, y: 0.22 }];
  const grid = {};
  for (const h of hotspots) {
    const key = `${Math.floor(h.x * 6)}_${Math.floor(h.y * 4)}`;
    if (!grid[key]) grid[key] = { x: 0, y: 0, n: 0 };
    grid[key].x += h.x; grid[key].y += h.y; grid[key].n++;
  }
  return Object.values(grid)
    .sort((a, b) => b.n - a.n)
    .slice(0, 4)
    .map(c => ({ x: c.x / c.n, y: c.y / c.n }));
}

// ── Process each photo ────────────────────────────────────────────────────────
const depth = Math.ceil(Math.log2(clusters)); // 2^depth ≥ clusters

for (const photo of manifest.photos) {
  const src = join(OUT, photo.filename);
  process.stdout.write(`Palette: ${photo.filename} … `);

  const { data, info } = await sharp(src)
    .resize(80, 80, { fit: 'fill' })  // tiny thumbnail for speed
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = [];
  for (let i = 0; i < data.length; i += 3) pixels.push([data[i], data[i+1], data[i+2]]);

  const palette = medianCut([...pixels], depth)
    .slice(0, clusters)
    .map(([r, g, b]) => rgbToHex(r, g, b));

  // Identify roles by hue/brightness
  const sorted = palette.slice().sort((a, b) => {
    const lumaA = parseInt(a.slice(1,3),16) * 0.299 + parseInt(a.slice(3,5),16) * 0.587 + parseInt(a.slice(5,7),16) * 0.114;
    const lumaB = parseInt(b.slice(1,3),16) * 0.299 + parseInt(b.slice(3,5),16) * 0.587 + parseInt(b.slice(5,7),16) * 0.114;
    return lumaB - lumaA;
  });

  photo.palette = {
    raw: palette,
    colTop:  sorted[0] || palette[0],
    colBase: sorted[1] || palette[1] || palette[0],
    colDeep: sorted[sorted.length - 1] || palette[palette.length - 1],
    colPlume: palette[2] || palette[0],
    colBeam:  palette[1] || palette[0],
  };

  photo.hotspots = findHotspots(data, info.width, info.height, hotspotThreshold);
  console.log(`${palette.length} colours, ${photo.hotspots.length} hotspots`);
}

await writeFile(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log('\nManifest updated with palettes and hotspots.');
