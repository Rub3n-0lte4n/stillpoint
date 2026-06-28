---
title: Presentation modes — block-aware reader (Phase 2)
date: 2026-06-28
status: approved (design)
parent: 2026-06-28-stillpoint-analytical-reading-overview.md
depends_on: 2026-06-28-stillpoint-phase1-block-foundation-design.md
---

# Stillpoint — Presentation Modes (Phase 2)

## Context

Phase 1 made both parsers emit a sidecar `blocks` array alongside the unchanged
`tokens` and `units`, preserving tables, images, figures, equations, code, and
quotes that RSVP would otherwise flatten into meaningless word soup. Phase 2
**consumes** that sidecar: the reader decides, per the reader's chosen
behaviour, what to do when the stream reaches a block — halt and show it, offer
a full-page view, or skip it and collect it into an end-of-chapter appendix. The
hot word path is left untouched; block handling is a cheap lookup bolted onto the
existing loop. See the [epic overview](2026-06-28-stillpoint-analytical-reading-overview.md)
for shared goals and the data model, and the
[Phase 1 block foundation spec](2026-06-28-stillpoint-phase1-block-foundation-design.md)
for how `blocks` are produced and what each `payload` contains.

## Scope

- Consume `blocks` in the playback loop via an `after === i` check.
- A new persisted `blockMode` setting: one global default plus per-kind overrides.
- Three presentation behaviours: **Pause & show**, **Hybrid (page view)**, **Skip + collect**.
- A full-width **still card** for rendering a block in-stream.
- A per-chapter **Appendix** (shown at unit end) and a document-level **Figures & Tables** index, both populated by skipped blocks.
- Sanitized rendering of `image` and `html` payloads, reusing the app's existing escape discipline.
- A **dismiss** affordance for auto-detected (possibly false-positive) PDF blocks.
- Settings UI to choose the global mode and per-kind overrides.

## Out of scope

- Producing `blocks` (Phase 1).
- The gentle **speed ramp** after resuming from a card — Phase 2 resumes cleanly; the easing curve is a Phase 3 pacing concern. (The existing `RAMP_MIN`/`RAMP_WORDS` ramp in `play()` already applies on every resume and is sufficient here.)
- Rewind/regression, highlights, review panel (Phase 3).
- Any new vendored library. Rendering uses native DOM + the existing `esc()` helper only.

## The `blockMode` setting

### Shape

A small object: a global `default` plus optional per-kind overrides keyed by the
six block kinds. Any kind not present falls back to `default`.

```js
// S.blockMode  (in-memory, mirrors persisted value)
{
  default: "pause",        // "pause" | "hybrid" | "skip"
  image:   "skip",         // optional per-kind overrides
  table:   "pause",
  // figure | equation | code | quote → omitted ⇒ use default
}
```

Resolution helper (added to `app.js`):

```js
function modeForKind(kind){ return (S.blockMode[kind]) || S.blockMode.default || "pause"; }
```

### Modes

| Value | Behaviour |
|-------|-----------|
| `"pause"` | Halt RSVP, render the block as a still card, resume on Space/tap. |
| `"hybrid"` | Still card **plus** a "View page" toggle into a scrollable full render, then jump back to the exact word. |
| `"skip"` | Do not interrupt; append the block to the chapter Appendix + the document index. |

### Defaults

Chosen to respect each kind's information density vs. interruption cost:

| Kind | Default mode | Why |
|------|--------------|-----|
| `table` | `pause` | Dense, must be read deliberately. |
| `equation` | `pause` | Cannot be streamed; needs a still look. |
| `image` | `skip` | Often decorative; collecting avoids breaking flow. |
| `figure` | `pause` | Usually load-bearing (diagrams + captions). |
| `code` | `pause` | Layout-significant; streaming is meaningless. |
| `quote` | `pause` | Short; a brief still beat reads naturally. |

Global `default` ships as `"pause"`. Concretely the seeded object is:

```js
{ default:"pause", image:"skip" }
```

### Persistence (`store.js`)

`blockMode` is a **per-document** preference (a reader may want figures inline in
a textbook but collected in a novel), so it is keyed by the document `key` rather
than living in the global `fp_prefs` blob.

- `js/store.js` gains two thin helpers on the exported `Store`, reusing the
  existing `tx()` machinery and the same `files` object store with a namespaced
  key so no schema/`VERSION` bump is needed:

  ```js
  // store.js additions — same DB, namespaced key "blockmode::<docKey>"
  getBlockMode: (docKey)=> tx("readonly",  s=>s.get("blockmode::"+docKey)),
  putBlockMode: (docKey, val)=> tx("readwrite", s=>s.put(val, "blockmode::"+docKey)),
  ```

- `pruneStore()` in `app.js` must treat `blockmode::*` keys as retained (they
  are tiny and book-scoped). The prune loop is widened to keep any key whose
  document portion is still in the library, e.g. skip keys starting with
  `blockmode::` whose suffix is a live library key.
- `openReader()` loads the saved mode (falling back to the seeded default) right
  after it resolves the resume index; the Settings UI writes it back via
  `Store.putBlockMode(S.key, S.blockMode)` whenever the reader changes it.
- The library backup bundle (`buildBackup`/`importBackup`) gains an optional
  `blockModes` map (`{ docKey: blockMode }`) so per-document choices travel with
  the library, mirroring how `prefs` already round-trips.

## Reader-loop integration

The block check slots into `step()` in `js/app.js`, immediately **after** the
index advances and **before** the next `setTimeout`. Today `step()` does:

```js
S.index += S.chunk;
updateProgress();
saveProgress();
S.timer = setTimeout(()=>{ if(S.playing) step(); }, delay);
```

Phase 2 inserts a block check on the tokens just consumed. Because a chunk can
span several token indices, we scan the consumed range `[prevIndex, S.index)`
for any block whose `after` falls inside it:

```js
const prev = S.index;            // captured before S.index += S.chunk
S.index += S.chunk;
updateProgress();
saveProgress();

const hit = blockBetween(prev, S.index);   // first block with prev <= after < S.index
if(hit){
  const m = modeForKind(hit.kind);
  if(m === "skip"){
    collectBlock(hit);                       // route to appendix/index, do NOT halt
    S.timer = setTimeout(()=>{ if(S.playing) step(); }, delay);
  } else {
    presentBlock(hit, m);                     // "pause" or "hybrid": halt the stream
    // no timer scheduled — resume is user-driven (resumeFromCard)
  }
  return;
}
S.timer = setTimeout(()=>{ if(S.playing) step(); }, delay);
```

Supporting structures, built once in `openReader()` from the incoming `blocks`:

- `S.blocks` — the raw sidecar array.
- `S.blocksByAfter` — a `Map<afterIndex, block>` (or sorted index) so
  `blockBetween()` is an O(range) or O(log n) lookup, never an O(n) scan per
  step. The word path stays hot: prose with no blocks pays one `Map.has`-class
  check per step.
- `S.shownBlocks` — a `Set` of block ids already presented/collected, so
  scrubbing back and re-crossing a block does not double-show or double-collect
  it. `collectBlock()` and `presentBlock()` both guard on this set.

`pause()` and the existing visibility-change auto-pause are unaffected; a card is
only ever raised while `S.playing` was true, and `resumeFromCard()` re-enters the
normal `step()` path (which re-applies the ramp from `S.rampStart`).

## The three modes

### Pause & show

1. `presentBlock(hit, "pause")` calls `pause()`-like teardown of the timer (but
   keeps `S.playing` conceptually "armed"): clears `S.timer`, hides the ribbon,
   and raises the **still card** over the stage.
2. The card renders the block full-width (see *Block rendering*). The transport
   play button reflects a "Resume" affordance.
3. **Space** or a **tap** on the card (or the stage) calls `resumeFromCard()`:
   dismiss the card, `S.shownBlocks.add(hit.id)`, restore the ribbon, set
   `S.rampStart = S.index` so the existing gentle ramp eases speed back up, and
   call `step()`.
4. Coming out is a clean resume only — no bespoke easing here (Phase 3 owns the
   ramp tuning; the current `RAMP_MIN`/`RAMP_WORDS` behaviour is reused as-is).

### Hybrid

Everything Pause & show does, plus the card carries a **"View page"** button:

1. "View page" swaps the compact still card for a **page view**: a scrollable,
   full render of the surrounding page/section. The content is the block's
   payload framed by its `unit` (chapter/page) heading so the reader has spatial
   context — for EPUB this is the sanitized section HTML around the block; for
   PDF it is the page snapshot image the block points to.
2. A **"Back to reading"** action collapses the page view and returns to the
   still card; **Resume** then jumps back to the **exact word** (`S.index` is
   never mutated by viewing the page, so resume lands precisely where the stream
   left off).
3. The page view traps focus like the existing `about`/`done` modals (reuse
   `trapTab`), and Escape collapses page view → card, then card → resume.

### Skip + collect

1. `collectBlock(hit)` does **not** touch the timer or `S.index`; the stream
   keeps flowing. It pushes the block into two structures:
   - **Per-chapter Appendix** — grouped by `hit.unit`. When the stream crosses a
     unit boundary (detected in `updateProgress()`, which already computes the
     current unit `u`), if the just-finished unit has collected blocks, the reader
     surfaces a dismissible **"Appendix"** affordance (a still card variant
     listing that chapter's figures/tables) before continuing. The reader can
     open it or skip past; it never hard-blocks playback.
   - **Document-level "Figures & Tables" index** — a flat, always-available list
     (opened from a dock control) of every collected block across the document,
     each item deep-linking: tapping an entry opens that block's still card and,
     on dismiss, returns to the current reading position.
2. Collected entries show a kind glyph, the unit title, and a one-line caption
   (figure/table caption text when Phase 1 captured it, else "Figure"/"Table N").

## Block rendering & sanitization

A single `renderBlockInto(el, block)` builds the card/page body from
`block.payload`, dispatching on payload type (as defined by Phase 1):

- **Image payloads** (`image`, PDF table/figure snapshots) → an `<img>` whose
  `src` is the Phase 1 blob URL or data URL. CSP already allows `img-src 'self'
  data:`. Images are constrained to the card width, `max-height` capped so a tall
  figure scrolls inside the card rather than blowing out the layout. Always set a
  meaningful `alt` (caption text if present, else the kind).
- **HTML payloads** (EPUB `table`/`figure`/`quote`/`code`) → sanitized HTML
  injected into the card. Sanitization happens at the Phase 1 boundary (allow-list
  of structural tags: `table/thead/tbody/tr/th/td/figure/figcaption/blockquote/`
  `pre/code/em/strong/sub/sup/br`, no attributes except `colspan`/`rowspan`, no
  `style`/`script`/event handlers, no external `src`). Phase 2 treats the
  sanitized string as trusted-by-construction and assigns it with `innerHTML`
  **only** for payloads explicitly marked `payload.safe === true`; any string
  payload not so marked is rendered as text via the existing `esc()` helper. This
  keeps the same escape discipline used throughout `app.js` (`esc()` in
  `buildRibbon`, `renderLibrary`, etc.) — untrusted text never reaches `innerHTML`.
- Unknown/empty payloads render a graceful "Couldn't render this block" placeholder
  with the kind label, never a broken element.

No raw document HTML is ever passed to `innerHTML` unsanitized; the only
`innerHTML` sink for block content is the allow-listed, attribute-stripped string
from Phase 1.

## Dismiss flow for false-positive PDF blocks

PDF blocks are **auto-detected** (region heuristics, per Phase 1) and can be false
positives — a paragraph mis-flagged as a table, a header rule mis-read as a figure.
Every PDF-origin block card therefore carries a **"Not a figure — dismiss"**
control (EPUB blocks come from explicit native elements and do not need it, though
the control is harmless if shown).

- Dismiss marks the block: `S.shownBlocks.add(id)` **and** records the id in a
  per-document `dismissed` set persisted alongside `blockMode`
  (`{ default, …overrides, dismissed:[ids] }`), so the false positive stays gone
  on the next open of the same document.
- On dismiss from a **pause/hybrid** card: the card closes and the stream resumes
  exactly as a normal resume (no re-show on scrub-back).
- On dismiss from the **appendix/index**: the entry is removed from both the
  chapter appendix and the document index.
- `presentBlock`/`collectBlock` skip any id in the `dismissed` set, so dismissal is
  the authoritative suppression. A brief toast ("Dismissed — won't show again in
  this document", with **Undo**) reuses the existing `toast()` helper and undo
  pattern from `removeItem()`.

## UI / markup additions

### `index.html`

Add inside the reader (siblings of the existing `.stage-shell`, layered over the
stage like `resting`/`word`/`ribbon`):

```html
<!-- Block still card: full-width presentation over the stage -->
<div class="block-card hidden" id="blockCard" role="dialog" aria-modal="true" aria-labelledby="bcKind">
  <div class="bc-head">
    <span class="bc-kind" id="bcKind">Table</span>
    <span class="bc-unit" id="bcUnit"></span>
    <button type="button" class="bc-dismiss hidden" id="bcDismiss">Not a figure — dismiss</button>
  </div>
  <div class="bc-body" id="bcBody"><!-- img or sanitized html --></div>
  <div class="bc-actions">
    <button type="button" class="btn ghost hidden" id="bcViewPage">View page</button>
    <button type="button" class="btn gold" id="bcResume">Resume reading →</button>
  </div>
</div>

<!-- Full page view (hybrid mode) -->
<div class="page-view hidden" id="pageView" role="dialog" aria-modal="true" aria-labelledby="pvTitle">
  <div class="pv-head"><span id="pvTitle">Chapter</span>
    <button type="button" class="btn ghost" id="pvBack">← Back to reading</button></div>
  <div class="pv-scroll" id="pvScroll"><!-- full section/page render --></div>
</div>

<!-- Document-level Figures & Tables index -->
<div class="figindex hidden" id="figIndex" role="dialog" aria-modal="true" aria-labelledby="fiTitle">
  <div class="fi-head"><h3 id="fiTitle">Figures &amp; Tables</h3>
    <button type="button" class="fi-x" id="fiClose" aria-label="Close">✕</button></div>
  <div class="fi-list" id="fiList"></div>
</div>
```

Add a dock control to open the index (next to `settingsToggle`), shown only when
`S.blocks.length` is non-empty:

```html
<button type="button" class="figindex-toggle hidden" id="figIndexToggle">Figures &amp; Tables</button>
```

Add a **Blocks** control group inside `#moreControls` for the settings UI:

```html
<div class="ctrl" id="blockModeCtrl">
  <label>Tables &amp; images</label>
  <div class="seg" id="blockModeSeg">
    <button data-bm="pause" class="active">Pause &amp; show</button>
    <button data-bm="hybrid">Page view</button>
    <button data-bm="skip">Collect</button>
  </div>
  <button type="button" class="linklike" id="blockModeAdvanced">Per-type…</button>
</div>
```

`Per-type…` expands a compact grid (one row per kind: table / image / figure /
equation / code / quote) each with the same three-way segment plus an "Use
default" state, writing per-kind overrides into `S.blockMode`.

### `styles.css`

Reuse the existing token vocabulary — no new primitives:

- `.block-card` / `.page-view` / `.figindex`: `--surface` background,
  `--hair-strong` border, `--r-lg` radius, `--e-3`/`--shadow` elevation, the
  `--t`/`--ease-out` transition used by other overlays; `.hidden` toggles
  visibility exactly like `resting`/`word`.
- `.bc-kind` uses `--amethyst`; the dismiss control uses `--ink-mute` text and a
  `--hair` outline so it reads as secondary.
- `.bc-body img` and `.pv-scroll img`: `max-width:100%`, capped `max-height` with
  internal scroll; tables get `--surface-inset` wells and `--hair-soft` row rules
  so they match the couture surface treatment.
- `.figindex-toggle` and `#blockModeSeg` mirror the existing `.settings-toggle`
  and `.seg` styles so the new controls are visually native to the dock.
- Respect `prefers-reduced-motion`: card raise/lower fades without translate,
  consistent with `heroDemo`'s reduced-motion handling.

## Testing strategy

Manual + scripted DOM-state checks (the app is single-file, no test runner is
added). Each case loads a fixture document carrying a known `blocks` array.

1. **Pause halts at a block.** `blockMode.default="pause"`. Play through a token
   range containing a block with `after === i`. Assert: `S.timer` is cleared,
   `S.playing` does not advance past `S.index`, `#blockCard` loses `.hidden`, and
   the card body shows the block payload. Pressing Space hides the card and the
   index resumes advancing from the same `S.index`.
2. **Skip routes to appendix and does NOT halt.** Set `image:"skip"`. Cross an
   image block. Assert: `#blockCard` stays hidden, `S.index` keeps advancing on
   schedule (a timer is still scheduled), and the block id appears in both the
   chapter appendix group (`hit.unit`) and `#figIndex` list.
3. **Hybrid exposes the page toggle.** Set `default="hybrid"`. Cross a block.
   Assert: `#bcViewPage` is visible; clicking it shows `#pageView` with the
   section/page render; "Back to reading" returns to the card; Resume restarts
   `step()` at the unchanged `S.index` (exact-word return).
4. **Per-kind override beats global.** `default="pause"`, `table:"skip"`. Cross a
   `table` block → it collects without halting; cross a `figure` block → it halts
   with a card. Confirms `modeForKind()` precedence.
5. **Dismiss removes a block.** From a PDF-origin card, click "Not a figure —
   dismiss". Assert: card closes, stream resumes, the id is in the persisted
   `dismissed` set, and re-crossing it (scrub back + replay) does **not** re-show
   it. Reload the document → still suppressed.
6. **Persistence round-trip.** Change `blockMode` in settings → reload via
   `openFromStore` → `Store.getBlockMode(key)` returns the chosen object and the
   settings UI reflects it. Export → import on a fresh library → `blockModes`
   restored.
7. **No-block regression.** A pure-prose document (`blocks: []`) streams with
   byte-identical behaviour to today (the per-step lookup is a no-op), verifying
   the hot path is untouched.

## Acceptance criteria

- [ ] `step()` performs an `after`-in-consumed-range check after advancing the
      index, using an O(1)/O(log n) lookup, with zero behavioural change for
      prose documents.
- [ ] `S.blockMode` exists with a global `default` and per-kind overrides;
      `modeForKind(kind)` resolves overrides before falling back to `default`.
- [ ] Default modes ship as specified (`table/equation/figure/code/quote → pause`,
      `image → skip`; global default `pause`).
- [ ] `blockMode` (incl. `dismissed`) persists **per document** through
      `Store.getBlockMode`/`putBlockMode`, survives reload, and is included in the
      library backup/import.
- [ ] **Pause & show** halts the stream, raises a full-width still card, and
      resumes cleanly on Space/tap without re-showing on scrub-back.
- [ ] **Hybrid** adds a "View page" toggle into a scrollable full render and
      returns to the exact word on resume.
- [ ] **Skip + collect** never interrupts the stream and appends the block to both
      the per-chapter Appendix and the document "Figures & Tables" index.
- [ ] Image payloads render as `<img>`; HTML payloads render only via the
      Phase 1 sanitized, allow-listed string; all untrusted text uses `esc()`.
- [ ] PDF-origin blocks expose a dismiss control that suppresses the block for the
      document, with an Undo toast.
- [ ] Settings UI lets the reader pick a global mode and per-kind overrides; the
      Figures & Tables index opens from the dock when blocks exist.
- [ ] No new vendored library; CSP unchanged; rendering uses native DOM + `esc()`.
- [ ] Focus is trapped in the card / page view / index modals (reusing `trapTab`),
      and Escape unwinds page view → card → resume.
