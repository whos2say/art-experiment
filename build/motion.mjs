#!/usr/bin/env node
/**
 * Image-motion analysis for the moments pipeline (brief §2a.4).
 *
 * Runs the *same* structure-tensor analysis index.html's buildStudy() does in
 * the browser — global blur direction + coherence ("aniso"), the 5 brightest
 * light clusters with each one's own local streak direction, a warm-colour
 * centroid, and an overall "energy" score — but at build time over the raw
 * full-resolution files via sharp, and adds one thing the runtime version
 * doesn't need: a curvature/"squiggle" score, since a loop-de-loop light
 * trail is a different gesture than a straight streak even when they share
 * the same *average* angle (brief §2a.4: "curvature... is a gesture, not
 * just an angle"). Curvature here is the circular variance between each
 * bright spot's own local streak direction and the photo's overall smear
 * angle — low when every streak points the same way, high when they fan out
 * or loop.
 *
 * Deliberately mirrors buildStudy()'s field names (smearAngle, flowCoh,
 * energy, spots[].ang/aniso, warm) so moments.mjs and the runtime stay on
 * the same vocabulary.
 *
 * Usage:  node build/motion.mjs [--date 2026-10-03]
 * Writes: photos/motion.json — one entry per photo, keyed by filename.
 */
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import sharp from 'sharp';

const args = process.argv.slice(2);
const dateIdx = args.indexOf('--date');
const date = dateIdx >= 0 ? args[dateIdx + 1] : '2026-10-03';

const ROOT = join(import.meta.dirname, '..');
const PHOTOS = join(ROOT, 'photos');
const sourceMapPath = join(PHOTOS, `${date}-source-map.json`);
const sourceMap = JSON.parse(await readFile(sourceMapPath));

const AW = 160, AH = 120; // analysis resolution — matches index.html's spirit (small, fast), not the display size

function rgb2hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  const v = mx, s = mx ? d / mx : 0;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, s, v];
}

async function analyse(file) {
  const src = join(PHOTOS, file);
  const { data, info } = await sharp(src)
    .resize(AW, AH, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  const lum = new Float32Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 3, p++) {
    lum[p] = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  }

  // Global structure tensor → overall smear angle + coherence (flowCoh), same
  // maths as buildStudy()'s Jxx/Jyy/Jxy.
  let Jxx = 0, Jyy = 0, Jxy = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const lx = lum[y * w + x + 1] - lum[y * w + x - 1];
      const ly = lum[(y + 1) * w + x] - lum[(y - 1) * w + x];
      Jxx += lx * lx; Jyy += ly * ly; Jxy += lx * ly;
    }
  }
  const smearAngle = 0.5 * Math.atan2(2 * Jxy, Jxx - Jyy);
  const flowCoh = (Jxx + Jyy) > 1e-6 ? Math.hypot(Jxx - Jyy, 2 * Jxy) / (Jxx + Jyy) : 0;

  // Local orientation at a point (same localOrient() as buildStudy()).
  function localOrient(cx, cy, rad) {
    let xx = 0, yy = 0, xy = 0;
    const x0 = Math.max(1, cx - rad), x1 = Math.min(w - 1, cx + rad);
    const y0 = Math.max(1, cy - rad), y1 = Math.min(h - 1, cy + rad);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const lx = lum[y * w + x + 1] - lum[y * w + x - 1];
        const ly = lum[(y + 1) * w + x] - lum[(y - 1) * w + x];
        xx += lx * lx; yy += ly * ly; xy += lx * ly;
      }
    }
    return { ang: 0.5 * Math.atan2(2 * xy, xx - yy), coh: (xx + yy) > 1e-6 ? Math.hypot(xx - yy, 2 * xy) / (xx + yy) : 0 };
  }

  // Bright spots (same percentile-threshold + greedy-cluster approach as buildStudy()).
  const sorted = Float32Array.from(lum).sort();
  const thr = sorted[Math.floor(sorted.length * 0.985)] || 200;
  let spotsRaw = [];
  for (let p = 0; p < lum.length; p++) {
    if (lum[p] < thr) continue;
    const x = (p % w) / w, y = Math.floor(p / w) / h;
    const near = spotsRaw.find(s => Math.hypot(s.x - x, s.y - y) < 0.16);
    if (near) { near.x = (near.x * near.n + x) / (near.n + 1); near.y = (near.y * near.n + y) / (near.n + 1); near.n++; near.l = Math.max(near.l, lum[p]); }
    else spotsRaw.push({ x, y, l: lum[p], n: 1 });
  }
  const spots = spotsRaw.sort((a, b) => b.n - a.n).slice(0, 8).map(s => {
    const o = localOrient(Math.round(s.x * w), Math.round(s.y * h), Math.round(w / 8));
    return { x: +s.x.toFixed(3), y: +s.y.toFixed(3), intensity: +Math.min(1, s.l / 255).toFixed(3), ang: +o.ang.toFixed(4), aniso: +o.coh.toFixed(3) };
  });

  // Curvature / "squiggle": circular variance between each spot's own local
  // angle and the photo's overall smear angle. 0 = every streak agrees with
  // the global direction (a clean, straight-feeling frame); closer to 1 =
  // the streaks fan out or loop independently of one another.
  let curvature = 0;
  if (spots.length) {
    let sx = 0, sy = 0;
    for (const s of spots) { const d2 = 2 * (s.ang - smearAngle); sx += Math.cos(d2); sy += Math.sin(d2); }
    const R = Math.hypot(sx, sy) / spots.length; // mean resultant length, 0..1
    curvature = +(1 - R).toFixed(3);
  }

  // Warm centroid (same rule as buildStudy()'s warm detection, on a coarse grid).
  const GX = 12, GY = 9;
  let wx = 0, wy = 0, wsum = 0;
  for (let gy = 0; gy < GY; gy++) for (let gx = 0; gx < GX; gx++) {
    const x0 = Math.floor(gx * w / GX), x1 = Math.floor((gx + 1) * w / GX);
    const y0 = Math.floor(gy * h / GY), y1 = Math.floor((gy + 1) * h / GY);
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const o = (y * w + x) * 3; r += data[o]; g += data[o + 1]; b += data[o + 2]; n++; }
    r /= n; g /= n; b /= n;
    const [hh, s, v] = rgb2hsv(r, g, b);
    let warm = (hh >= 265 && hh <= 345) ? s * v : 0;
    if (b > g && r > g) warm = Math.max(warm, ((r + b) / 2 - g) / 255 * 0.7);
    if (warm > 0) { wx += (gx + 0.5) / GX * warm; wy += (gy + 0.5) / GY * warm; wsum += warm; }
  }
  const warm = wsum > 0 ? { x: +(wx / wsum).toFixed(3), y: +(wy / wsum).toFixed(3) } : { x: 0.5, y: 0.85 };

  // Overall energy + blown-highlight fraction (same formula family as the
  // numeric scorer used for the gallery curation pass — see §0.0 hotfix note
  // on why this alone isn't a reliable "best photo" signal, but it's a fine
  // motion/intensity feature here).
  let mean = 0; for (let i = 0; i < lum.length; i++) mean += lum[i]; mean /= lum.length;
  let varr = 0; for (let i = 0; i < lum.length; i++) varr += (lum[i] - mean) * (lum[i] - mean); varr /= lum.length;
  const brightFrac = spotsRaw.reduce((a, s) => a + s.n, 0) / lum.length;
  const energy = +Math.min(1, Math.sqrt(varr) / 70 + spots.length * 0.1).toFixed(3);

  return {
    smearAngleDeg: +(smearAngle * 180 / Math.PI).toFixed(1),
    flowCoh: +flowCoh.toFixed(3),
    curvature,
    energy,
    brightFrac: +brightFrac.toFixed(4),
    warm,
    spots,
  };
}

const motion = {};
let i = 0;
for (const entry of sourceMap) {
  i++;
  process.stdout.write(`Motion: ${entry.newFilename} (${i}/${sourceMap.length}) … `);
  try {
    motion[entry.newFilename] = await analyse(entry.newFilename);
    console.log(`smear ${motion[entry.newFilename].smearAngleDeg}°, energy ${motion[entry.newFilename].energy}, curvature ${motion[entry.newFilename].curvature}`);
  } catch (e) {
    console.log(`SKIP (${e.message})`);
  }
}

await writeFile(join(PHOTOS, 'motion.json'), JSON.stringify(motion, null, 2));
console.log(`\nWrote photos/motion.json — ${Object.keys(motion).length} of ${sourceMap.length} photos analysed.`);
