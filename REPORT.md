# Overnight report — Resonant Spectra gallery push

Status: **partial**. Two hard blockers stopped the core of the brief (the 10/3 show
pipeline, the full gallery/storefront, `/tap`). Everything that didn't depend on
them is done and verified below. This is an honest accounting, not a victory lap —
see "What's blocked" first, then "What shipped."

---

## 0. What's blocked (needs Joe)

**1. GitHub push is refused.** This session's git proxy returned:

```
remote: access denied by the git proxy: whos2say/art-experiment is not in this
session's authorized repository set, so the proxy will not inject a credential
for it.
```

I branched `overnight/gallery` off `v3` and committed locally (two commits, see
below), but I cannot push the branch or open the PR until `whos2say/art-experiment`
is added to this session's authorized repos. **Nothing in this report has reached
GitHub or Vercel.** There is no preview URL yet — that's the single biggest gap
between this report and "done by morning."

**2. `incoming/Photos-1-001.zip` doesn't exist anywhere I can reach.** Not in the
repo, not in this session's uploads, no computer linked to pull it from. Per the
brief I'm not guessing at its contents. This blocks: photo triage (public vs.
`_private`), the entire `moments.mjs` pipeline (setlist timing, audio DSP, image
motion analysis, the smear/peak correlation finding), Moment mode, Show replay
mode, and the curated 8–12 piece gallery (there's nothing to curate from yet).

Everything below is what was still possible without those two.

---

## 1. What shipped

### 1a. Branch + commits (local only — not pushed)

- Branched `overnight/gallery` from `v3` (confirmed `v3` is the newest, unmerged
  work per the brief's ground truth — did not touch `main` or `migrate`).
- Commit 1 — mobile layout: the stage (canvas + HUD + topbar + filmstrip) now
  lives in `#stageArea`, capped to **60vh** on phones (≤760px) instead of the full
  viewport. The control panel and filmstrip became true off-canvas drawers scoped
  to the stage; the panel now **defaults closed** on mobile (it used to cover the
  whole screen). A new `#shopGallery` section sits in normal page flow directly
  below the stage — tap a photo to view it above, or "Buy print." This was a live
  correction from Joe mid-session (original brief didn't specify this layout);
  edited `index.html` in place, no new file.
- Commit 2 — `?tune` panel: pulled the never-tuned feel constants (attack/decay,
  release gate + drop, max-hold, beam ignition) out of inline magic numbers into
  a `TUNE` object, and added a hidden panel (open with `index.html?tune`, not
  linked from the normal UI) with a slider per constant, live-editing the running
  show, plus "Copy settings JSON" and "Reset to defaults." No behavior change
  without `?tune` — defaults match what already shipped.

### 1b. Verification

Both features were checked with Playwright at 390×844 (iPhone-ish) and
1440×900 (desktop), screenshots in `docs/report-assets/` and attached to this
message:

- `mobile-390x844.png` — stage measures ~60% of viewport height, gallery section
  renders immediately below it, panel starts closed.
- `desktop-1440x900.png` — unchanged immersive full-screen canvas; gallery
  section confirmed `display:none` (desktop experience untouched, per guardrail
  to keep old modes working).
- `tune-panel.png` — all 9 constants render as sliders with live values.

**Caveat, stated plainly:** this sandbox's egress policy blocks
`cdnjs.cloudflare.com`, which is where `p5.js` loads from. That means **p5 never
initialized in my test environment**, so I could not visually verify the actual
canvas animation, audio reactivity, or the Looks (1–4) rendering correctly — only
the surrounding DOM/CSS/layout, which doesn't depend on p5. The real Vercel
preview has normal internet access and should load p5 fine, but **this needs a
human (or a differently-sandboxed check) to confirm the animation itself still
performs correctly** before calling it done. I did confirm old behavior is
structurally intact: Looks 1–4 markup, keyboard shortcut bindings, the rescan
button, and the filmstrip are all unchanged in the diff.

### 1c. Supabase project

Created project **`art-experiment`** (ref `tsdtbjbazdfnxvjmffyo`, org
`whos2say's Org`, region `us-east-1`) since none existed. Applied two migrations:

- **Schema** (`pieces`, `editions`, `orders`, `uploads`) — RLS **enabled on every
  table** from the start. Public can read `live`-status pieces and their edition
  stock (no PII there). `orders` and `uploads` are owner-read-only for signed-in
  users; nothing is client-writable except a user inserting/updating their own
  `uploads` row — `orders` writes are meant to come only from a service-role
  Stripe webhook, which doesn't exist yet (see §4).
- **Storage buckets** — `originals` (private, owner-only) and `derivatives`
  (public-read, owner-write), per the zip-drop flow in the brief.

`get_advisors` (security) came back with **zero lints** after both migrations.

Project URL: `https://tsdtbjbazdfnxvjmffyo.supabase.co`
Anon/publishable key (safe client-side, not a secret):
`sb_publishable_IJzzIUnTPMQAZx1_-YEpqA_zUwJq4m6`

**Not done yet:** Supabase Auth (magic link + passkeys) isn't configured, and
nothing in `index.html`/`/tap` talks to this project yet — `/tap` itself doesn't
exist. Both are straightforward once the zip/photo pipeline exists to give the
gallery something real to show, and once I can push code to wire it up.

---

## 2. Vendor comparison + hosting (research only — nothing purchased)

### Fulfilment: Prodigi vs. Gelato vs. Printful vs. Luma Prints

I could not get clean, current pricing pages to load via fetch tonight (several
vendor pricing pages either redirected in loops or returned only marketing
copy, not line-item prices) — the comparison below is from general knowledge of
these vendors as of my training, **not freshly verified tonight, and must be
confirmed before anyone commits to one.**

| | Prodigi | Gelato | Printful | Luma Prints |
|---|---|---|---|---|
| Fine-art focus | Strong — giclée is a core product, not an add-on | Print network, broad catalog, giclée available | Broad POD catalog; art prints are one of many categories | Photography/fine-art specific, smaller/boutique |
| Cotton rag paper | Yes (Hahnemühle-equivalent lines) | Depends on local print partner | Limited — mostly standard poster/matte stocks | Yes — markets itself on museum-grade papers |
| Framing options | Yes, several frame styles | Yes | Limited | Yes |
| API quality | Mature, well-documented REST API | Mature API, broad platform integrations | Mature API but optimized for apparel/POD, not fine art | Smaller, less documented API — may need more manual work |
| Monthly fee | No (per-order) | No (per-order); Gelato+ sub is optional, not required | No (per-order) | Varies — confirm, some boutique vendors charge a plan fee |
| US base cost, 12×16 (rough) | Likely mid-range | Likely mid-range to low (network pricing) | Lower, but not true giclée/cotton-rag | Likely higher (boutique positioning) |
| US base cost, 18×24 (rough) | Likely mid-range | Likely mid-range to low | Lower-tier paper only | Likely higher |

**Recommendation: Prodigi**, tentatively — best fit for "archival giclée,
numbered editions, museum-quality paper" with a real API and no monthly fee.
Gelato is the credible second choice if Prodigi's actual per-print cost (once
quoted) is too high, since its print-network model can undercut on price.
**This needs real quotes before anyone decides** — I'd pull current catalog/API
pricing for a 12×16 and 18×24 in cotton rag from each vendor's actual developer
docs/pricing calculator once I can spend time against live sites, and confirm
paper options directly rather than from memory.

**For launch:** have the (not-yet-built) Stripe webhook email Joe the order +
print file for manual submission to whichever vendor is chosen, rather than
wiring API auto-fulfilment first. That's unchanged from the brief and still the
right call.

### Hosting cost

Confirmed live tonight via Vercel's own pricing page:

- **Hobby: $0/mo**, but explicitly scoped to "personal, non-commercial use" —
  selling prints on it is out of scope for the plan's terms.
- **Pro: $20/mo per seat** (the brief's estimate was right).

I could not get a clean read on Cloudflare Pages/Workers' current free-tier
terms tonight (fetch returned only a plan-overview page, not the terms detail) —
my understanding from training is that the Workers/Pages free tier does permit
commercial use, with usage-based limits past a generous free allotment, but
**this specific claim needs a fresh check** before it's the basis for a
decision, since the brief flagged it as something to verify and I haven't fully
verified it.

**Recommendation, with a flag:** if Vercel Pro's $20/mo is acceptable, stay on
Vercel — it's already the deployed home for this project, `art.whostosay.org`
is already pointed at it, and avoiding a migration is worth $20/mo on its own.
Cloudflare is the fallback if Joe wants to keep fixed costs nearer to zero and
is willing to migrate DNS + the two serverless functions (`phishin-proxy`,
`refresh-photos`) to Workers.

**Estimated monthly fixed cost once selling:** Vercel Pro $20 + Supabase (free
tier, likely sufficient at launch volume) $0 + Stripe (no monthly fee, ~2.9%+30¢
per transaction) $0 + print vendor (no monthly fee, per-order) $0 = **~$20/mo**,
matching the brief's $0–20/mo target at the high end.

---

## 3. Privacy.com purchases awaiting Joe's approval

**Nothing has been purchased.** Prepared, not executed:

| Vendor | What | Est. amount | Why |
|---|---|---|---|
| Vercel | Pro plan upgrade | $20/mo | Required for commercial use per Hobby's non-commercial terms (see §2) |
| Print vendor (Prodigi, pending confirmation) | 1–2 sample prints, smallest size | ~$20–40 + shipping | Quality-check paper/color before offering editions for sale |
| Domain/DNS | n/a this round | $0 | `whostosay.org` and `art.whostosay.org` already exist; the `/tap` redirect is a DNS/rewrite rule, not a purchase |

Recommend **one merchant-locked Privacy.com card per vendor, with a spend limit**
(e.g., $25/mo for Vercel, a one-time $75 limit for sample prints). Some print
vendors decline virtual/prepaid cards at checkout — worth confirming with
Prodigi support before relying on the card for that purchase. Separately:
**Stripe payouts go to a bank account, not a Privacy.com card** — Joe needs a
real business bank account (ideally Who's to Say?'s own) connected to Stripe
before any real money can be collected, even in test mode this doesn't matter,
but it's a blocker for going live later.

---

## 4. Rights and risk memo

**This is not legal advice** — flagging for an actual lawyer where noted.

- **Trademark:** don't use "Phish," its logos, or its fonts in product names,
  branding, or ads. Factual, descriptive captions ("Boardwalk Hall, Atlantic
  City, 10.03.26") are lower-risk but still worth a lawyer's sign-off before
  commercial use, especially at volume.
- **Audio:** no audio is sold or bundled, by design — the living version links
  out to phish.in playback rather than re-hosting. This matches phish.in's
  non-commercial-listening terms and should stay that way.
- **Venue/performance rights:** Boardwalk Hall's and the band's specific
  photography policies (what's allowed to shoot, what's allowed to sell) weren't
  checked tonight — that's a real gap, not an oversight to wave away. Concert
  photography is commonly sold as fine art, but "commonly done" isn't the same
  as "verified permitted here." Flag for Joe to check before any piece goes
  live for sale.
- **People:** no identifiable person in any for-sale piece without a release,
  and never minors — full stop. This is exactly why the photo triage in §1 (zip
  pipeline) matters and why I didn't improvise around the missing zip: the
  brief's own exclusion list (daytime youth football event, selfies/friends in
  the concert set) has to be applied by someone who's actually looked at the
  photos, which wasn't possible tonight.
- **Nonprofit tax questions:** Who's to Say? is a nonprofit — selling prints may
  raise unrelated-business-income and sales-tax questions. Flag for Joe's
  accountant; Stripe Tax is a reasonable technical option once that's sorted.

---

## 5. Tuning worksheet

The `?tune` panel (shipped, see §1b) covers this directly — open
`index.html?tune` (once it's deployed), play real audio, and adjust until
releases feel right:

| Constant | Shipped default | What it controls |
|---|---|---|
| `attackTau` | 0.28s | How fast tension rises toward a louder moment |
| `decayTau` | 0.9s | How fast tension relaxes toward a quieter one |
| `releaseGateRecentMax` | 0.8 | Tension must have peaked above this recently... |
| `releaseGateSlope` | -0.22 | ...then dropped by at least this much to fire a release |
| `releaseWindowMs` | 1800ms | How far back "recently" looks |
| `releaseCooldownSec` | 4.5s | Minimum gap between releases |
| `maxHoldSec` | 60s | Force a release if none has fired in this long |
| `beamIgniteBase` | 0.20 | Build level where the first beam ignites |
| `beamIgniteStep` | 0.14 | Extra build needed per subsequent beam |

"Copy settings JSON" in the panel gives back exactly these keys/values — paste
into a message back to me (or directly into `config.json` if Joe's comfortable
editing it) once a by-ear pass is done, and I'll fold it into a proper commit.

---

## 6. Five things Joe should decide first

1. **Add `whos2say/art-experiment` to this session's authorized repos** (or tell
   me another way to get `overnight/gallery` pushed and a PR opened) — without
   this, nothing here reaches GitHub or gets a preview URL.
2. **Get `Photos-1-001.zip` to me** — attach it to this conversation, or connect
   a computer/folder that has it. Nothing in §§1–2 of the original brief
   (triage, `moments.mjs`, Moment mode, the real curated gallery) can start
   without it.
3. **Vercel Hobby → Pro ($20/mo)** — approve or reject before I "sell" anything
   even in test mode, since Hobby's terms don't cover commercial use.
4. **Pick a print vendor** (tentatively Prodigi — see §2) once real quotes are
   in hand, or tell me to get those quotes as the next step.
5. **Who's to Say?'s business bank account for Stripe payouts** — not urgent
   tonight (everything's test-mode), but it's the thing that turns "working
   checkout" into "money actually arrives," so it shouldn't be a surprise later.

---

## What I did NOT touch, per the guardrails

No money spent, no emails sent to anyone but this conversation, nothing posted
publicly, no production deploy, no merge into `main`, no changes to the Google
Photos album scrape or the existing `photos/` directory. I also noticed two
*other* Supabase projects in the account ("Challenger Family DB" and
"papas-vault-prod") while listing projects to check for an existing
`art-experiment` — I did not open, query, or touch either; they're unrelated to
this brief and one name alone (echoing the youth-football "Challengers" jerseys
mentioned in §1) was reason enough to leave it alone without being asked.
