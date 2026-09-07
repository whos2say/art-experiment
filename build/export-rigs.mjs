#!/usr/bin/env node
/**
 * export-rigs.mjs — turn every album photo into a virtual light rig.
 *
 * Runs the SAME analysis index.html does in the browser (buildStudy): a 96×72
 * downsample, 48 colour regions, the brightest lights with their local streak
 * direction, the warm centre, the frame's smear angle and energy. Then maps it
 * onto a stage in Unreal units (cm; X forward, Y right, Z up) and writes one
 * rig JSON per photo plus an index.
 *
 *   npm run export:rigs           → unreal/rigs/photo_NNN.json, unreal/rigs/index.json
 *
 * The stage frame (see STAGE below): the photograph is projected onto the back
 * wall; beam fixtures sit where the photo's bright lights are and point along
 * the direction the light streaks in the picture, tilted toward the audience so
 * the beams cut through the fog; washes paint the back wall in the photo's
 * region colours; plumes rise from the floor under the warm centre.
 */
import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import { join, basename } from 'path';
import sharp from 'sharp';

const ROOT = new URL('..', import.meta.url).pathname;
const PHOTOS = join(ROOT, 'photos');
const OUT = join(ROOT, 'unreal', 'rigs');
const AW = 96, AH = 72, GX = 8, GY = 6;

// ── the stage, in centimetres ────────────────────────────────────────────────
const STAGE = {
  hall: { width: 2400, depth: 1600, height: 900 },     // Y extent, X extent, Z extent
  photoPlaneX: 800,                                   // back wall (photo projected here)
  photoY: [-1100, 1100],                              // photo u∈[0,1] → Y
  photoZ: [860, 120],                                 // photo v∈[0,1] (top→bottom) → Z
  beamX: 620,                                         // fixtures hang just in front of the wall
  washX: 640,                                         // rect lights face the wall from here
  plumeX: 420,                                        // plume emitter on the floor, downstage of the wall
  cameraX: -1150, cameraZ: 260,
  trussZ: 870,
};
const lerp = (a, b, t) => a + (b - a) * t;
const uvToYZ = (u, v) => [lerp(STAGE.photoY[0], STAGE.photoY[1], u), lerp(STAGE.photoZ[0], STAGE.photoZ[1], v)];
const r1 = v => Math.round(v * 10) / 10;
const r3 = v => Math.round(v * 1000) / 1000;

// ── analysis: a faithful port of buildStudy() ────────────────────────────────
function rgb2hsv(r, g, b) { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; let h = 0;
  if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return [h, mx ? d / mx : 0, mx]; }
function hsv2rgb(h, s, v) { const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c; let r, g, b;
  if (h < 60) { r = c; g = x; b = 0; } else if (h < 120) { r = x; g = c; b = 0; } else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; } else if (h < 300) { r = x; g = 0; b = c; } else { r = c; g = 0; b = x; }
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255]; }
const toHex = (r, g, b) => '#' + [r, g, b].map(v => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')).join('');
const satv = c => { const h = rgb2hsv(c.r, c.g, c.b); return h[1] * h[2]; };

function analyse(px, name) {
  const at = (x, y) => { const i = 3 * (y * AW + x); return [px[i], px[i + 1], px[i + 2]]; };
  const regions = [];
  for (let gy = 0; gy < GY; gy++) for (let gx = 0; gx < GX; gx++) {
    const x0 = Math.floor(gx * AW / GX), x1 = Math.floor((gx + 1) * AW / GX), y0 = Math.floor(gy * AH / GY), y1 = Math.floor((gy + 1) * AH / GY);
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const c = at(x, y); r += c[0]; g += c[1]; b += c[2]; n++; }
    r /= n; g /= n; b /= n; const l = .2126 * r + .7152 * g + .0722 * b;
    regions.push({ x: (gx + .5) / GX, y: (gy + .5) / GY, r, g, b, l });
  }
  const lum = []; for (let i = 0; i < px.length; i += 3) lum.push(.2126 * px[i] + .7152 * px[i + 1] + .0722 * px[i + 2]);
  const sorted = [...lum].sort((a, b) => a - b); const thr = sorted[Math.floor(sorted.length * .985)] || 200;
  let spots = [];
  for (let p = 0; p < lum.length; p++) { if (lum[p] < thr) continue;
    const x = (p % AW) / AW, y = Math.floor(p / AW) / AH;
    const near = spots.find(s => Math.hypot(s.x - x, s.y - y) < .16);
    if (near) { near.x = (near.x * near.n + x) / (near.n + 1); near.y = (near.y * near.n + y) / (near.n + 1); near.n++; near.l = Math.max(near.l, lum[p]); }
    else spots.push({ x, y, l: lum[p], n: 1 }); }
  const localOrient = (cx, cy, rad) => { let xx = 0, yy = 0, xy = 0;
    const x0 = Math.max(1, Math.floor(cx * AW) - rad), x1 = Math.min(AW - 1, Math.floor(cx * AW) + rad), y0 = Math.max(1, Math.floor(cy * AH) - rad), y1 = Math.min(AH - 1, Math.floor(cy * AH) + rad);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const lx = lum[y * AW + x + 1] - lum[y * AW + x - 1], ly = lum[(y + 1) * AW + x] - lum[(y - 1) * AW + x]; xx += lx * lx; yy += ly * ly; xy += lx * ly; }
    return { ang: 0.5 * Math.atan2(2 * xy, (xx - yy)), coh: (xx + yy) > 1e-6 ? Math.hypot(xx - yy, 2 * xy) / (xx + yy) : 0 }; };
  spots = spots.sort((a, b) => b.n - a.n).slice(0, 5).map(s => { const o = localOrient(s.x, s.y, Math.round(AW / 8));
    const c = at(Math.min(AW - 1, Math.floor(s.x * AW)), Math.min(AH - 1, Math.floor(s.y * AH)));
    return { x: s.x, y: s.y, intensity: Math.min(1, s.l / 255), ang: o.ang, aniso: o.coh, color: c }; });
  let beamCol = [255, 200, 120]; if (spots[0]) beamCol = spots[0].color;
  let plumeCol = [255, 60, 200], best = -1, wx = 0, wy = 0, wsum = 0;
  for (const c of regions) { const hsv = rgb2hsv(c.r, c.g, c.b); const h = hsv[0], s = hsv[1], v = hsv[2];
    let warm = (h >= 265 && h <= 345) ? s * v : 0; if (c.b > c.g && c.r > c.g) warm = Math.max(warm, ((c.r + c.b) / 2 - c.g) / 255 * .7);
    if (warm > 0) { wx += c.x * warm; wy += c.y * warm; wsum += warm; }
    const score = (h >= 265 && h <= 350) ? s * v : 0; if (score > best) { best = score; plumeCol = [c.r, c.g, c.b]; } }
  const warm = wsum > 0 ? { x: wx / wsum, y: wy / wsum } : { x: .5, y: .85 };
  let Jxx = 0, Jyy = 0, Jxy = 0;
  for (let y = 1; y < AH - 1; y++) for (let x = 1; x < AW - 1; x++) { const lx = lum[y * AW + x + 1] - lum[y * AW + x - 1], ly = lum[(y + 1) * AW + x] - lum[(y - 1) * AW + x]; Jxx += lx * lx; Jyy += ly * ly; Jxy += lx * ly; }
  const smearAngle = 0.5 * Math.atan2(2 * Jxy, (Jxx - Jyy));
  const flowCoh = (Jxx + Jyy) > 1e-6 ? Math.hypot(Jxx - Jyy, 2 * Jxy) / (Jxx + Jyy) : 0;
  const mean = lum.reduce((a, b) => a + b, 0) / lum.length, varr = lum.reduce((a, b) => a + (b - mean) * (b - mean), 0) / lum.length;
  const energy = Math.min(1, Math.sqrt(varr) / 70 + spots.length * 0.12);
  const pal = [...regions].filter(c => c.l > 20).sort((a, b) => satv(b) - satv(a)).slice(0, 5).map(c => toHex(c.r, c.g, c.b));
  let duo; { const src0 = pal[0] ? pal[0].match(/\w\w/g).map(h => parseInt(h, 16)) : [regions[0].r, regions[0].g, regions[0].b]; const hs = rgb2hsv(...src0);
    duo = [hsv2rgb((hs[0] + 180) % 360, .7, .16), hsv2rgb(hs[0], Math.max(.55, hs[1]), 1)]; }
  return { name, regions, spots, beamCol, plumeCol, warm, smearAngle, flowCoh, energy, palette: pal, duo };
}

// ── map a study onto the stage ───────────────────────────────────────────────
function toRig(st, file, dims) {
  const c255 = c => c.map(v => Math.round(Math.max(0, Math.min(255, v))));
  // beams: one moving-head per bright light, pointing along its streak in the photo plane and
  // tilted toward the audience (-X) so the shaft is visible in the fog
  const beams = st.spots.map((s, i) => {
    const [Y, Z] = uvToYZ(s.x, s.y);
    const dy = Math.cos(s.ang), dz = -Math.sin(s.ang);            // image y grows downward → -Z
    const toward = -0.45;                                        // lean toward the camera
    const len = Math.hypot(toward, dy, dz);
    const tight = 0.45 + 0.55 * (s.aniso || 0.3);                // sharper streak → tighter beam
    const outer = lerp(30, 8, tight), inner = outer * 0.55;
    return { id: i, u: r3(s.x), v: r3(s.y),
      location: [STAGE.beamX, r1(Y), r1(Z)],
      direction: [r3(toward / len), r3(dy / len), r3(dz / len)],
      color: c255(s.color), intensityCd: Math.round(6000 * (0.5 + s.intensity) * (0.6 + tight)),
      outerConeDeg: r1(outer), innerConeDeg: r1(inner), attenuationRadius: 2800, volumetricScattering: 2.2,
      ignite: r1(0.20 + i * 0.14) };                             // tension at which this beam comes on (from the web conductor)
  });
  // washes: the brightest, most colourful regions become rect lights painting the back wall
  const washes = [...st.regions].filter(c => c.l > 14).sort((a, b) => (b.l / 255 + satv(b)) - (a.l / 255 + satv(a))).slice(0, 12).map((c, i) => {
    const [Y, Z] = uvToYZ(c.x, c.y);
    return { id: i, u: r3(c.x), v: r3(c.y), location: [STAGE.washX, r1(Y), r1(Z)],
      color: c255([c.r, c.g, c.b]), intensity: Math.round(60 + 340 * (c.l / 255)), size: [300, 220], attenuationRadius: 900,
      sourceLength: 0 };
  });
  const [pY] = uvToYZ(st.warm.x, 0);
  const plume = { location: [STAGE.plumeX, r1(pY), 40], color: c255(st.plumeCol), height: Math.round(380 + 300 * st.energy), rate: r1(0.5 + st.energy) };
  const albedo = st.palette[1] ? st.palette[1].match(/\w\w/g).map(h => parseInt(h, 16)) : [180, 190, 230];
  return {
    name: st.name, file, width: dims.width, height: dims.height,
    energy: r3(st.energy), smearAngleDeg: r1(st.smearAngle * 180 / Math.PI), flowCoh: r3(st.flowCoh),
    palette: st.palette, duotone: st.duo.map(c255), beamColor: c255(st.beamCol), plumeColor: c255(st.plumeCol),
    warm: { u: r3(st.warm.x), v: r3(st.warm.y) },
    fog: { density: r3(0.012 + 0.05 * st.energy), albedo: albedo.map(v => Math.round(120 + v * 0.5)), scatteringDistribution: 0.7, extinctionScale: 1.1 },
    beams, washes, plume,
  };
}

// ── run ──────────────────────────────────────────────────────────────────────
const files = (await readdir(PHOTOS)).filter(f => /\.(jpe?g|png|webp)$/i.test(f)).sort();
if (!files.length) { console.error('no photos in', PHOTOS); process.exit(1); }
await mkdir(OUT, { recursive: true });
const index = { stage: STAGE, generated: new Date().toISOString(), rigs: [] };
for (const f of files) {
  const img = sharp(join(PHOTOS, f));
  const meta = await img.metadata();
  const { data } = await img.resize(AW, AH, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const st = analyse(data, basename(f).replace(/\.[^.]+$/, ''));
  const rig = toRig(st, 'photos/' + f, { width: meta.width, height: meta.height });
  await writeFile(join(OUT, rig.name + '.json'), JSON.stringify(rig, null, 2));
  index.rigs.push({ name: rig.name, file: rig.file, beams: rig.beams.length, washes: rig.washes.length, energy: rig.energy });
  process.stdout.write(`  ${rig.name}  beams ${rig.beams.length}  washes ${rig.washes.length}  energy ${rig.energy.toFixed(2)}  smear ${rig.smearAngleDeg}°\n`);
}
await writeFile(join(OUT, 'index.json'), JSON.stringify(index, null, 2));
console.log(`\nwrote ${files.length} rigs → ${OUT}`);
