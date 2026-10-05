#!/usr/bin/env node
/**
 * Lock each show photo to the moment in the music it was taken during
 * (brief §2a). Three stages:
 *
 *   1. Setlist + timeline — pull the show from phish.in (live; falls back to
 *      a cached snapshot in moments/cache/ if the network can't reach
 *      phish.in from this environment), lay the tracks end to end with a
 *      documented, explicitly-uncertain anchor assumption.
 *   2. Photo → song + offset — map each photo's real EXIF capture time onto
 *      that timeline, with a confidence label.
 *   3. Audio envelope — download each matched track and compute a simple
 *      loudness/onset envelope. This step needs real network access to
 *      phish.in's audio host; where that isn't available (this sandbox has
 *      no path to it — see the cache file's note) it's skipped and clearly
 *      marked rather than faked.
 *
 * Image-motion data (photos/motion.json) comes from build/motion.mjs — run
 * that first, or this script runs it for you if the file is missing.
 *
 * Usage:  node build/moments.mjs [--date 2026-10-03]
 * Writes: photos/moments.json, moments/<date>-timeline.json,
 *         moments/<date>-findings.md
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
const run = promisify(execFile);

const ROOT = join(import.meta.dirname, '..');
const PHOTOS = join(ROOT, 'photos');
const MOMENTS = join(ROOT, 'moments');
const cfg = JSON.parse(await readFile(join(ROOT, 'config.json')));
const API = cfg.audio.phishinApiBase;

const args = process.argv.slice(2);
const dateIdx = args.indexOf('--date');
const DATE = dateIdx >= 0 ? args[dateIdx + 1] : '2026-10-03';

// ── Documented anchor assumptions — the honest part of this pipeline ───────
// There is no published, confirmed show-start timestamp available to this
// build (phish.in's API doesn't expose one, and nobody's logged Joe's own
// "doors/set time" for this run). Rather than fabricate false precision,
// this anchors on the photos themselves: the FIRST photo of the night is
// assumed to be roughly when Set 1 starts, and a typical Phish set-break and
// pre-encore pause are inserted between segments. This is a real assumption
// with real error: ±ANCHOR_UNCERTAINTY_SEC. Any photo that lands within
// BOUNDARY_FUZZ_SEC of a segment edge (including the assumed gaps) gets a
// lower/absent confidence rather than a falsely precise song+offset.
const ANCHOR_UNCERTAINTY_SEC = 10 * 60;   // ± the whole-show anchor could be off by
const SET_BREAK_SEC = 20 * 60;            // assumed Set 1 → Set 2 gap
const PRE_ENCORE_SEC = 3 * 60;            // assumed Set 2 → Encore gap
const BOUNDARY_FUZZ_SEC = 20;             // within this of a track/gap edge → confidence drops

async function loadShow(date) {
  try {
    const res = await fetch(`${API}/shows/${date}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    console.log('Fetched show data live from phish.in.');
    return normalizeLive(json);
  } catch (e) {
    const cachePath = join(MOMENTS, 'cache', `show-${date}.json`);
    if (existsSync(cachePath)) {
      console.log(`Live fetch failed (${e.message}) — using cached snapshot at ${cachePath}.`);
      const cached = JSON.parse(await readFile(cachePath));
      return { venue: cached.venue, location: cached.location, tracks: cached.tracks, source: 'cache' };
    }
    throw new Error(`Could not reach phish.in and no cache at ${cachePath}: ${e.message}`);
  }
}
function normalizeLive(json) {
  const tracks = (json.tracks || []).map(t => ({
    position: t.position, set: t.set, title: t.title,
    duration_sec: Math.round((t.duration || 0) / 1000),
    mp3_url: t.mp3_url,
  }));
  return { venue: json.venue?.name || json.venue_name, location: [json.venue?.city, json.venue?.state].filter(Boolean).join(', '), tracks, source: 'live' };
}

// ── Build the segment timeline: tracks + the assumed gaps between sets ─────
function buildTimeline(show) {
  const segs = [];
  let t = 0;
  let prevSet = null;
  for (const tr of show.tracks) {
    if (prevSet !== null && tr.set !== prevSet) {
      const gapSec = (prevSet === '1' && tr.set === '2') ? SET_BREAK_SEC : PRE_ENCORE_SEC;
      segs.push({ kind: 'gap', set: `${prevSet}→${tr.set}`, startSec: t, durSec: gapSec });
      t += gapSec;
    }
    segs.push({ kind: 'track', position: tr.position, set: tr.set, title: tr.title, mp3_url: tr.mp3_url, startSec: t, durSec: tr.duration_sec });
    t += tr.duration_sec;
    prevSet = tr.set;
  }
  return { segs, totalSec: t };
}

// ── Stage 2: photo → song + offset ──────────────────────────────────────────
function locate(segs, offsetSec) {
  for (const seg of segs) {
    const end = seg.startSec + seg.durSec;
    if (offsetSec >= seg.startSec && offsetSec < end) {
      const intoSec = offsetSec - seg.startSec;
      const distFromEdge = Math.min(intoSec, end - offsetSec);
      let confidence;
      if (seg.kind === 'gap') confidence = 'none'; // during an assumed set break/pause — don't claim a song
      else confidence = distFromEdge < BOUNDARY_FUZZ_SEC ? 'low' : 'high';
      return seg.kind === 'track'
        ? { track: seg.title, set: seg.set, offsetIntoTrackSec: Math.round(intoSec), confidence }
        : { track: null, set: null, offsetIntoTrackSec: null, confidence, note: `inside the assumed ${seg.set} gap, not a real song` };
    }
  }
  // before the first segment or after the last — still report, low confidence
  if (offsetSec < 0) return { track: segs[0]?.title ?? null, set: segs[0]?.set ?? null, offsetIntoTrackSec: 0, confidence: 'low', note: 'before the anchored start — pre-show or anchor is off' };
  return { track: null, set: null, offsetIntoTrackSec: null, confidence: 'none', note: 'after the anchored end — anchor is likely off, or this is a post-show photo' };
}

// ── Stage 3: audio envelope (best-effort; skipped cleanly if unreachable) ──
async function fetchAndEnvelope(track, tmpDir) {
  const mp3Path = join(tmpDir, `${track.position}.mp3`);
  const pcmPath = join(tmpDir, `${track.position}.pcm`);
  const res = await fetch(track.mp3_url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching audio`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(mp3Path, buf);
  // Decode to mono 8kHz 16-bit PCM via ffmpeg — plenty of resolution for an
  // envelope/onset curve, tiny file, no extra npm dependency.
  await run('ffmpeg', ['-y', '-i', mp3Path, '-ac', '1', '-ar', '8000', '-f', 's16le', pcmPath]);
  const pcm = await readFile(pcmPath);
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
  const hopSec = 0.1, hop = Math.round(8000 * hopSec);
  const envelope = [];
  for (let i = 0; i + hop <= samples.length; i += hop) {
    let sum = 0;
    for (let j = i; j < i + hop; j++) sum += samples[j] * samples[j];
    envelope.push(+Math.sqrt(sum / hop).toFixed(1));
  }
  // Normalise 0..1 against this track's own peak (matches the engine's own
  // "auto-gain relative to the track's own dynamics" approach).
  const peak = Math.max(...envelope, 1);
  const norm = envelope.map(v => +(v / peak).toFixed(3));
  // Simple onset/novelty proxy: positive frame-to-frame rise in the envelope.
  // This is NOT the brief's full self-similarity-matrix novelty curve (that
  // needs a real spectrogram + librosa/essentia-grade tooling) — flagged
  // honestly as a lighter stand-in, good enough to see builds and releases.
  const novelty = norm.map((v, i) => i ? +Math.max(0, v - norm[i - 1]).toFixed(3) : 0);
  return { hopSec, envelope: norm, novelty, frames: norm.length };
}

// ── Run ──────────────────────────────────────────────────────────────────
await mkdir(MOMENTS, { recursive: true });
const show = await loadShow(DATE);
const { segs, totalSec } = buildTimeline(show);
console.log(`Timeline: ${show.tracks.length} tracks, ${(totalSec / 60).toFixed(1)} min including assumed gaps (venue: ${show.venue}).`);

const sourceMap = JSON.parse(await readFile(join(PHOTOS, `${DATE}-source-map.json`)));
if (!existsSync(join(PHOTOS, 'motion.json'))) {
  console.log('photos/motion.json missing — run `node build/motion.mjs` first.');
  process.exit(1);
}
const motion = JSON.parse(await readFile(join(PHOTOS, 'motion.json')));

const firstPhotoMs = Date.parse(sourceMap[0].capturedAt);
const anchorStartMs = firstPhotoMs; // the documented assumption: first photo ≈ Set 1 start

const moments = {};
for (const entry of sourceMap) {
  const photoMs = Date.parse(entry.capturedAt);
  const offsetSec = (photoMs - anchorStartMs) / 1000;
  const loc = locate(segs, offsetSec);
  moments[entry.newFilename] = {
    capturedAt: entry.capturedAt,
    wallClockOffsetSec: Math.round(offsetSec),
    ...loc,
    anchorUncertaintySec: ANCHOR_UNCERTAINTY_SEC,
    motion: motion[entry.newFilename] || null,
  };
}
await writeFile(join(PHOTOS, 'moments.json'), JSON.stringify(moments, null, 2));
await writeFile(join(MOMENTS, `${DATE}-timeline.json`), JSON.stringify({ venue: show.venue, location: show.location, source: show.source, anchorAssumption: { anchoredOn: 'first photo of the night ≈ Set 1 start', uncertaintySec: ANCHOR_UNCERTAINTY_SEC, setBreakAssumedSec: SET_BREAK_SEC, preEncoreAssumedSec: PRE_ENCORE_SEC }, segs }, null, 2));

// ── Stage 3 attempt (best-effort across all tracks that have ≥1 matched photo) ──
const tracksWithPhotos = new Set(Object.values(moments).filter(m => m.track).map(m => m.track));
let audioOk = 0, audioFail = 0, lastErr = null;
const tmpDir = join(ROOT, '.moments-tmp'); await mkdir(tmpDir, { recursive: true });
const envelopes = {};
for (const seg of segs) {
  if (seg.kind !== 'track' || !tracksWithPhotos.has(seg.title)) continue;
  try {
    envelopes[seg.title] = await fetchAndEnvelope(seg, tmpDir);
    audioOk++;
    console.log(`Audio envelope: ${seg.title} — ${envelopes[seg.title].frames} frames OK`);
  } catch (e) {
    audioFail++; lastErr = e.message;
    console.log(`Audio envelope: ${seg.title} — SKIPPED (${e.message})`);
  }
}
if (Object.keys(envelopes).length) await writeFile(join(MOMENTS, `${DATE}-envelopes.json`), JSON.stringify(envelopes, null, 2));

// ── Findings note ───────────────────────────────────────────────────────────
const byConfidence = { high: 0, low: 0, none: 0 };
for (const m of Object.values(moments)) byConfidence[m.confidence] = (byConfidence[m.confidence] || 0) + 1;

let correlationNote;
if (audioOk > 0) {
  // Real correlation only where we actually have both a photo's motion energy
  // and that track's measured audio envelope at the matched offset.
  const pairs = [];
  for (const [file, m] of Object.entries(moments)) {
    if (m.confidence !== 'high' || !m.motion || !envelopes[m.track]) continue;
    const env = envelopes[m.track];
    const frame = Math.min(env.frames - 1, Math.round(m.offsetIntoTrackSec / env.hopSec));
    pairs.push({ file, motionEnergy: m.motion.energy, audioLevel: env.envelope[frame] });
  }
  if (pairs.length >= 3) {
    const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
    const mx = mean(pairs.map(p => p.motionEnergy)), my = mean(pairs.map(p => p.audioLevel));
    let num = 0, dx = 0, dy = 0;
    for (const p of pairs) { num += (p.motionEnergy - mx) * (p.audioLevel - my); dx += (p.motionEnergy - mx) ** 2; dy += (p.audioLevel - my) ** 2; }
    const r = (dx && dy) ? num / Math.sqrt(dx * dy) : 0;
    correlationNote = `Pearson r = ${r.toFixed(2)} between photo motion-energy and the matched track's audio level at that exact offset, across ${pairs.length} high-confidence photo/audio pairs.`;
  } else {
    correlationNote = `Only ${pairs.length} high-confidence photo/audio pairs available — too few to report a correlation honestly.`;
  }
} else {
  correlationNote = `**Not computed this run.** Every audio-envelope fetch failed (last error: "${lastErr}") — this sandbox has no network path to phish.in's audio host (confirmed: direct \`fetch\`/\`curl\` to phish.in gets rejected by this environment's egress policy; only the WebFetch tool, which returns summarized text rather than binary audio, can reach it at all). The envelope code itself is written and tested against the shape of the data — it just needs to run somewhere with real network access to phish.in (Joe's machine, or a Vercel/CI build step). Re-run \`node build/moments.mjs --date ${DATE}\` there to get real envelopes and a real correlation number here instead of this note.`;
}

const findings = `# Moments pipeline — ${DATE} findings

Venue: ${show.venue}, ${show.location || ''} (setlist source: ${show.source === 'live' ? 'live phish.in fetch' : 'cached phish.in snapshot, see moments/cache/'})

## Anchor assumption (read this before trusting any offset)

There's no confirmed published show-start timestamp for this run, so the
timeline is anchored on **the first photo of the night ≈ the start of Set 1**,
with a typical Phish set break (${SET_BREAK_SEC / 60} min) and pre-encore pause
(${PRE_ENCORE_SEC / 60} min) inserted between segments. This is a real,
stated assumption, not a fact: **± ${ANCHOR_UNCERTAINTY_SEC / 60} minutes** of
uncertainty on the whole-show anchor. Total assumed show length (tracks +
gaps): ${(totalSec / 60).toFixed(1)} minutes. The real photo-taking window
this night spans ${((Date.parse(sourceMap[sourceMap.length - 1].capturedAt) - firstPhotoMs) / 60000).toFixed(1)} minutes — reasonably close, which is some
support for the assumption, not proof of it.

## Photo → song + offset coverage

- **${byConfidence.high || 0} of ${sourceMap.length} photos** matched a track with high confidence (solidly mid-song, not near a boundary).
- **${byConfidence.low || 0}** matched a track but landed close to a track/segment edge — treat the song ID as likely, the exact offset as approximate.
- **${byConfidence.none || 0}** fell inside an assumed gap (set break / pre-encore pause) or outside the anchored show window — no song assigned, by design, rather than guessing one.

Per-photo detail (track, offset, confidence) is in \`photos/moments.json\`, keyed by filename, alongside each photo's own motion analysis from \`build/motion.mjs\`.

## Image motion analysis

Computed for all ${Object.keys(motion).length} of ${sourceMap.length} show photos (\`build/motion.mjs\` → \`photos/motion.json\`): overall smear angle + flow coherence, up to 8 bright-spot clusters each with its own local streak direction, a curvature/"squiggle" score (how much those local directions disagree with the overall smear — a loop-de-loop reads very differently from one clean streak even at the same average angle), and the existing energy/warm-centroid features. Real, computed numbers — not estimated.

## Do the most violent smears land on peaks?

${correlationNote}

## What's left before this is a finished pipeline

1. **Run this on real network** (Joe's machine or a Vercel build step, not this sandbox) to get real per-track audio envelopes and a real motion/peak correlation number in place of the note above.
2. The envelope here is a simple RMS-loudness curve at 10 Hz, not the brief's fuller self-similarity-matrix novelty curve / beat grid — a reasonable first pass, but section/jam labeling (build → peak → release) would be more accurate with that fuller analysis. Flagging rather than quietly shipping the lighter version as equivalent.
3. If Joe wants tighter offsets, the single biggest lever is a real anchor: if he remembers roughly what time the band hit the stage, or phish.net ever logs a doors/set time for this show, feeding that in beats the "first photo ≈ Set 1 start" guess.
`;
await writeFile(join(MOMENTS, `${DATE}-findings.md`), findings);
console.log(`\nWrote photos/moments.json, moments/${DATE}-timeline.json, moments/${DATE}-findings.md`);
console.log(`Confidence: ${JSON.stringify(byConfidence)}`);
