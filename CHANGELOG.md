# Resonant Spectra — CHANGELOG

## 2026-09-06 — v3: the photograph as a first-class layer

The photo is no longer just the score — it is on stage. The render pipeline is
now two layers composited by a chosen **Look**:

- `renderLightLayer()` — washes, plumes, beams (the v2 engine, additive, → `lightG`)
- `renderPhotoLayer()` — the stylised photograph with Ken Burns drift along its
  own smear angle, breathing with the music, plus transitions (→ `photoG`)
- `composite()` — **Reveal** (light × photo: the picture exists only where light
  lands), **Bloom** (photo full-frame, light blooming over it — the default),
  **Prism** (RGB channels split along the smear angle, pulsing with bass),
  **Spectra** (the v2 abstract mode).

Transitions are part of the show: timed switches dissolve with a colour cast
handed from the outgoing photo; musical releases and manual next/prev *wipe*
along the outgoing photo's light direction.

Colour is one global transform — hue rotation × saturation as a 3×3 matrix —
applied to the light colours and to a cached, stylised copy of the photo
(Natural / Duotone / Mono / Negative), so picture and light always agree.
Duotone endpoints derive from the photo's own dominant colour and its complement.

`Home` starts over: back to the first photograph, shown untouched for one
second with colour reset, then the performance begins again.

Controls: drag on the canvas (x → hue, y → intensity), wheel → zoom, `[` `]`
hue, `-` `=` intensity, `C` colour mode, `0` reset, `1`–`4`/`L` looks, `←` `→`
photos, `space` pause, `R` release, `M` audio, `F`/double-click fullscreen,
`P` panel, `S` save, `?`/`H` help, `esc`.

Layout: the canvas fills the window at a capped internal resolution
(≈1.6 MP); controls live in a right-hand glass drawer, all photos in a bottom
filmstrip, every control on a `?` overlay. Fullscreen hides UI + cursor on idle.

Fixed: `hex()` collided with p5's global `hex()` (p5 binds its globals after
the page script), so every palette swatch in v2 rendered empty. Renamed to
`toHex()`.

Unchanged: photo analysis (`buildStudy`), the conductor (`computeConductor`),
audio setup (`crossOrigin` before `.src`), phish.in proxy usage, rescan.


## 2026-06-29 — Music-driven conductor build (staged, pending by-ear tuning + deploy)

Replaced `art-experiment/index.html` with the music-driven "conductor" build
(saturation-weighted in-browser analysis + FFT → normalized `tension`; compose →
build → tension-release lifecycle). `photos/`, `manifest.json`, `api/`, and
`vercel.json` were left untouched.

Fixes applied on top of the provided build during code review:

- **Safety-cap bug:** the 60s `MAXHOLD` cap measured time from `studyStart`, which is
  set at page load and was never reset when audio began. If a track was started >60s
  after the page loaded, a spurious release (flash + photo jump) fired on the first
  audio frame. Now the hold timer + slope history reset the moment audio starts
  (`wasAudioOn` edge), with a 1s cooldown grace.
- **Anti-runaway:** `tHist` (the ~1.8s tension history used for release slope) is now
  cleared whenever a release fires, so the just-passed peak can't immediately
  re-trigger after the cooldown.

Nice-to-haves added (self-contained, reversible):

- **Manual release key `r`** — forces a release flash + advance for demos/tuning.
- **Subtle Jamchart caption** — if the phish.in result carries a jam note
  (`jamchart_description` / `jam_notes`), it shows faintly under "Now playing".
- Keyboard shortcuts (`d`, `r`) now ignore keystrokes while the search box is focused.

Feature-feel constants (feature blend, attack/decay, release gate/drop, beam
ignition, etc.) were **left at the author's documented defaults** — tuning those
correctly requires listening to live audio, which is the human-ear step. See the
tuning worksheet handed back with this build.
