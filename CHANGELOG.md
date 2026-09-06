# Resonant Spectra — CHANGELOG

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
