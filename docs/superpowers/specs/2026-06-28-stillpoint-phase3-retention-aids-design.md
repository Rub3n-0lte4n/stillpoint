---
title: Retention aids — smart pacing, rewind/regression, highlights & review (Phase 3)
date: 2026-06-28
status: approved (design)
parent: 2026-06-28-stillpoint-analytical-reading-overview.md
depends_on:
  - 2026-06-28-stillpoint-phase1-block-foundation-design.md   # loose — Phase 3 mostly operates on the flat token stream
  - 2026-06-28-stillpoint-phase2-presentation-modes-design.md  # only the post-block pacing ramp ties to Phase 2
---

# Stillpoint — Phase 3: Retention Aids

Three offline-only aids that help a reader *hold on to* what RSVP streams past
them. Everything here runs on the existing `tokens` array (`[{ w, end, pause }]`)
and the device — **no AI, no backend, no new vendored libraries**. See the
[epic overview](2026-06-28-stillpoint-analytical-reading-overview.md) for shared
goals, the `blocks` sidecar data model, and phase dependencies.

## Context

RSVP buys speed by removing the eye's natural glance-back: every word arrives at
one still point and is gone. That is great for flow and terrible for retention on
dense material — there is no way to dwell on a hard sentence, re-read a clause, or
mark a passage to revisit. Phase 3 restores those affordances without touching the
hot word-rendering path: **smart pacing** lengthens dwell where comprehension load
is highest, **rewind/regression** gives back the glance-back as explicit controls,
and **highlights & review** let the reader mark passages (as token-index ranges,
not text copies) and review or export them after a chapter or session.

## Scope

- **Smart pacing** — extend the existing `end`/`pause` dwell logic with longer
  sentence-end and unit-end pauses, plus an auto-slowdown on long/complex
  sentences (word-count + average-word-length heuristic). A gentle speed ramp
  coming *out of* a block card (Phase 2).
- **Rewind / regression** — "back a sentence" (extend existing), "back 10 words",
  and a one-tap **sentence replay**. Pure token-index movement.
- **Highlights & review** — tap to mark the current word or sentence, persisted as
  index ranges per document; an end-of-chapter / end-of-session review panel;
  export of marked passages as Markdown / Anki-importable text.

### Out of scope

- **AI comprehension quizzes or flashcard generation** — needs an LLM + a user API
  key; explicitly a non-goal of the epic.
- Spaced-repetition scheduling / SRS algorithms. Export is plain text the reader
  feeds into their own Anki; Stillpoint does not schedule reviews.
- Cloud sync of highlights (they live on-device, like the cached library).
- Free-text notes/annotations on a highlight (ranges only this phase).
- Cross-document search over highlights.

---

## Feature 1 — Smart pacing

Today `step()` in `js/app.js` already derives a base per-word delay and pads it for
sentence ends, clause pauses, and long words:

```js
const perWord = 60000 / (S.wpm * ramp);
let delay = perWord * chunkTokens.length;
if(last.end)        delay += perWord * 0.9;   // sentence end
else if(last.pause) delay += perWord * 0.45;  // clause pause
const longest = Math.max(...chunkTokens.map(t => t.w.length));
if(longest > 8)     delay += perWord * 0.25;  // long word
```

Smart pacing **extends this same expression** — it does not replace it. Three
additions, each gated so the current RSVP feel is byte-for-byte unchanged when the
toggle is off.

### Heuristic: per-sentence complexity

The complexity of a sentence is precomputed once when a document loads (in
`openReader`), not per frame. A new helper in `js/text.js` walks the token stream,
slicing on the existing `end` flag, and returns a parallel array the reader can
index in O(1):

```js
// js/text.js — returns Float32-like array, sentenceFactor[i] for token i
export function sentenceFactors(tokens, strength = 0.35){ … }
```

For each sentence it computes:

| Metric | Definition |
|--------|------------|
| `W` | word count (tokens from sentence start to the `end` token inclusive) |
| `A` | average word length in characters across the sentence |

and a normalised complexity score in `[0,1]`:

```
lenScore  = clamp((W - 18) / 22, 0, 1)    // 0 until ~18 words, full at ~40
charScore = clamp((A - 4.8) / 2.2, 0, 1)  // 0 at avg 4.8 chars, full at ~7.0
c         = 0.6 * lenScore + 0.4 * charScore
factor    = 1 + strength * c              // clamped to ≤ 1.5
```

Every token index in that sentence is assigned the same `factor` (the slowdown is
a property of the sentence, not the word). A short, plain sentence → `factor ≈
1.0` (no change). A 40-word, polysyllabic sentence → up to `factor = 1.5`
(50% longer dwell per word). Thresholds are deliberately set so ordinary prose
(12–18 word sentences, ~4.8 avg chars) scores ~0 and is **unaffected**.

### Timing hook in `app.js`

`step()` multiplies the base per-word figure by the current sentence's factor, then
adds the (now slightly larger) end/pause/unit pads:

```js
const f = settings.smartPacing ? S.sentenceFactor[S.index] : 1;
const perWord = (60000 / (S.wpm * ramp)) * f;
let delay = perWord * chunkTokens.length;
if(last.end)        delay += perWord * (settings.smartPacing ? 1.3 : 0.9);
else if(last.pause) delay += perWord * (settings.smartPacing ? 0.6 : 0.45);
if(longest > 8)     delay += perWord * 0.25;
// unit (paragraph / page / chapter) end — extra breath at structural boundaries
if(settings.smartPacing && isUnitEnd(S.index + S.chunk)) delay += perWord * 1.1;
```

- **Sentence ends**: existing `0.9 × perWord` pad rises to `1.3 × perWord` when
  smart pacing is on — a clearer beat between thoughts.
- **Unit ends** (paragraph / page / chapter): `isUnitEnd(i)` returns true when `i`
  equals a `units[k].start` (the next token begins a new unit), adding an extra
  `1.1 × perWord` breath. Uses the existing `S.units` array; no new structure.
- **Complex sentences**: handled entirely by `f` above, so the slowdown is smooth
  across the whole sentence rather than a jolt on one word.

### Gentle ramp after a block card (depends on Phase 2)

The per-run speed ramp already exists (`RAMP_MIN = 0.6`, `RAMP_WORDS = 15`,
`S.rampStart`): each run eases from 60% to 100% WPM over the first 15 words. Phase 3
reuses this exact machinery for re-entry after a Phase 2 block "still card": when
the reader dismisses a card and the stream resumes, set `S.rampStart = S.index` so
the next 15 words ramp back up — the eye re-acquires the still point gently instead
of being hit at full speed.

```js
// in the Phase 2 "resume after block" path:
S.rampStart = S.index;   // re-arm the existing ramp out of the card
```

**Graceful degradation:** this is a one-line hook in Phase 2's resume path. If
Phase 2 is not present (no blocks, no cards), the hook is never reached and pacing
behaves exactly as the per-run ramp does today. Phase 3 ships and is useful with
or without Phase 2.

### Defaults

| Setting | Default | Rationale |
|---------|---------|-----------|
| `smartPacing` | **on**, gentle (`strength = 0.35`, `factor ≤ 1.5`) | Extends existing dwell logic; ordinary prose scores ~0 so the feel is preserved. Toggle in the **Aids** segment beside Countdown / Context. |
| Sentence-end pad | `1.3 × perWord` (on) / `0.9 ×` (off) | Off-state is identical to today. |
| Unit-end pad | `1.1 × perWord` | Only fires at real structural boundaries (sparse). |

Turning `smartPacing` off restores every current constant exactly — no regression
for readers who want raw RSVP.

---

## Feature 2 — Rewind / regression

RSVP removes the involuntary regression (glance-back) that print reading relies on.
Phase 3 gives it back as **explicit, cheap controls** — each is a pure backward (or
re-anchoring) move of `S.index`, then `render()`. No new state, no text handling.

`backSentence` / `fwdSentence` already exist and already detect sentence boundaries
via the `end` flag. Phase 3 keeps them and adds two siblings.

### Controls

| Control | Action | Binding |
|---------|--------|---------|
| Back a sentence | `backSentence()` (existing) — land on the previous sentence start | `←` / `#backBtn` (existing) |
| Back 10 words | `jumpTo(S.index - 10)` | `Shift+←` and a long-press on `#backBtn` |
| Replay sentence | jump to the **current** sentence start and (re)play it | `R` and a tap on the focal word while paused |
| Forward a sentence | `fwdSentence()` (existing) | `→` / `#fwdBtn` (existing) |

"Back 10 words" is intentionally word-granular (not sentence) for the common case
of "wait, what was that phrase" — a smaller, predictable hop.

### Sentence-boundary detection via `end`

A sentence **starts** at index 0, or at any index whose predecessor has
`end === true`. That single rule drives every sentence move:

```js
// current sentence start: scan back to the token after the previous sentence-end
function sentenceStart(i){
  let s = i;
  while(s > 0 && !S.tokens[s - 1].end) s--;
  return s;
}
```

Index math for each control:

```js
function back10(){ jumpTo(S.index - 10); }                 // clamped in jumpTo()

function replaySentence(){
  const s = sentenceStart(S.index);   // beginning of the sentence we're in
  jumpTo(s);
  if(!S.playing) play();              // re-read it; play() already re-orients
}
```

`backSentence()` (existing) already encodes "if I'm at/near a sentence start, skip
to the *previous* sentence start" by scanning back twice over `end`; it is reused
unchanged. `jumpTo()` already clamps to `[0, tokens.length-1]`, so `back10` at the
start of a document is safe.

### Defaults / no-regression

These are additive controls; nothing fires unless the reader presses them. The
existing `REWIND_WORDS = 5` auto-rewind on resume is untouched. A reader who never
touches the new keys gets exactly today's behaviour.

---

## Feature 3 — Highlights & review

Tap to mark the current **word** or **sentence**; the mark is stored as a
token-**index range**, never a text copy. Because indices are stable for a given
parsed document, highlights survive reopen, library export/import, and never drift
or duplicate text. A review panel lists marked passages at chapter and session
boundaries, and an exporter emits Markdown / Anki-importable text.

### Capture

| Gesture | Marks |
|---------|-------|
| Tap "Mark" (`M` key, new `#markBtn` in the transport) | the **current sentence** range `[sentenceStart(i), sentenceEnd(i)]` |
| Long-press "Mark" / `Shift+M` | the **single current word** `[i, i]` |

Toggling a mark that exactly overlaps an existing one removes it (un-highlight).
Overlapping ranges are merged on insert so a highlight set stays minimal and
non-overlapping. `sentenceEnd(i)` scans forward to the next `end` token (mirror of
`sentenceStart`).

### Data shape — index ranges per document

A highlight is two integers and a timestamp; the rendered text is derived from
`S.tokens` on demand, so nothing is duplicated:

```js
// one highlight
{ start: 412, end: 437, unit: 6, ts: 1781740800000 }
// start/end : inclusive token indices (a word range = same value twice)
// unit      : index into S.units (chapter/page) for grouping in review
// ts        : when marked, for stable ordering
```

Stored per document in `js/store.js` (IndexedDB), under a key derived from the
document's existing library key:

```js
// store.js record at key  "hl::" + docKey   (docKey = file.name + "::" + size)
{ v: 1, ranges: [ { start, end, unit, ts }, … ] }   // sorted by start
```

A separate `hl::` key (rather than mutating the cached-file record) means
highlights persist even for metadata-only library entries whose blob has been
pruned, and they round-trip through the existing backup export/import (Phase 3 adds
`hl::*` keys to `buildBackup`/`importBackup` alongside the file blobs).

### Review panel

Reachable two ways, both reusing the modal/focus-trap pattern already in `app.js`:

1. **End of chapter** — when the stream crosses a `units[k].start`, if that just-
   finished unit has highlights, a non-blocking toast offers "Review N highlights"
   (dismiss to keep reading). Opt-in, never interrupts flow.
2. **End of session** — the existing `#done` completion card gains a "Review
   highlights" action listing every marked passage in the document.

Each row renders the highlighted passage by joining `S.tokens[start..end].w`,
grouped under its `units[unit].title`. Row actions: **Jump** (`jumpTo(start)` and
return to the reader), **Remove**, and **Copy**. An empty state ("No highlights
yet — tap Mark while reading") keeps the panel honest.

### Export format

One button in the review panel exports all highlights as a Markdown document
(downloaded via the existing `triggerDownload` helper). It is plain enough to paste
into notes **and** import into Anki: each `## ` passage is a card front, the source
line a back/extra field.

Given highlights in a doc titled *On Stillness*, chapter "II. Attention":

```markdown
# Highlights — On Stillness

## II. Attention

> The eye does not glide smoothly across a line; it leaps, pauses, and leaps again.

— On Stillness · II. Attention · words 412–437

> Instead of asking your eyes to chase the text, it brings each word to you.

— On Stillness · II. Attention · words 511–524
```

Anki import: choose "Lines/paragraphs", or the reader pastes the `>` quote as the
front and the `—` source as the back. No SRS scheduling is implied or generated.

---

## Persistence

| Where | Key | Holds | Scope |
|-------|-----|-------|-------|
| `localStorage` | `fp_prefs` (existing) | add `smartPacing: boolean` beside `wpm/size/mode/countdown/context` | global |
| `js/store.js` (IndexedDB) | `hl::<docKey>` (new) | `{ v, ranges:[{start,end,unit,ts}] }` | per document |
| backup JSON | `files[]` already; add `highlights[]` | exported `hl::*` records | per device |

- **Pacing prefs are global** and ride the existing `fp_prefs` object and its
  `beforeunload` save — consistent with how Countdown/Context aids already persist.
- **Highlight ranges are per document** and index-based, which is *why* they
  persist correctly: reopening the same file reparses to the same token indices, so
  ranges re-anchor exactly with no text copies to go stale.
- Backup/restore: `hl::*` keys are added to the `buildBackup` / `importBackup`
  loops so highlights move between devices with the rest of the library.

---

## Testing strategy

Pure functions (`sentenceFactors`, `sentenceStart`/`sentenceEnd`, highlight
merge/serialize) are unit-testable without the DOM; timing assertions check the
*computed* `delay`, not wall-clock.

**Smart pacing**

- Dwell **increases at a sentence end**: for a token where `end === true`, the
  padded `delay` is strictly greater than for an interior word at the same WPM.
- Dwell **increases at a unit end**: a token index equal to `units[k].start − 1`
  (last word before a new unit) gets the extra unit pad over a mid-unit word.
- A **long/complex sentence dwells longer than a short one**: feed two sentences —
  a 6-word plain one and a 38-word polysyllabic one — and assert
  `sentenceFactor[longIdx] > sentenceFactor[shortIdx]` and that the short
  sentence's factor is `≈ 1.0` (proves ordinary prose is unaffected → no
  regression). With `smartPacing` off, `delay` equals the current formula exactly.

**Rewind / regression**

- "Back a sentence" **lands on the previous sentence-start token**: build tokens
  where `end` is set on the words before indices `s1` and `s2`; from inside the
  second sentence, `backSentence()` leaves `S.index === s1`.
- `back10()` from index 4 clamps to 0; `replaySentence()` from mid-sentence sets
  `S.index === sentenceStart(i)`.

**Highlights & review**

- A marked range **round-trips through `store.js`**: mark `[412, 437]`,
  serialize → `Store.put("hl::"+key, …)` → `Store.get` → deserialize yields the
  same `{start, end}`.
- Overlapping marks merge (mark `[10,20]` then `[15,25]` → single `[10,25]`); an
  exact re-mark toggles the range off.
- **Export produces the expected Markdown**: given two ranges in one unit, the
  exporter emits the `# Highlights — <title>`, the `## <unit title>`, the `>`
  quote (joined `tokens[start..end].w`), and the `— <title> · <unit> · words
  start–end` source line, matching the example above.

---

## Acceptance criteria

- [ ] `sentenceFactors(tokens)` exists in `js/text.js`, computes per-sentence
      `factor` from word count + avg word length, clamped to `≤ 1.5`, with plain
      prose scoring `≈ 1.0`.
- [ ] `step()` multiplies the base per-word delay by the current sentence factor
      and pads sentence/unit ends **only when `smartPacing` is on**; with it off,
      `delay` is identical to the pre-Phase-3 formula.
- [ ] Post-block resume re-arms the existing ramp (`S.rampStart = S.index`); absent
      Phase 2, pacing is unchanged (graceful degradation).
- [ ] `smartPacing` toggle lives in the Aids segment, defaults on/gentle, and
      persists in `fp_prefs`.
- [ ] "Back 10 words" and "Replay sentence" controls exist (buttons + `Shift+←` /
      `R`), implemented as pure `S.index` moves; existing `←`/`→` sentence nav and
      `REWIND_WORDS` resume behaviour are unchanged.
- [ ] Tap-to-mark captures the current sentence (and word, on modifier) as a
      `{start, end, unit, ts}` index range; overlapping ranges merge; an exact
      re-mark un-highlights.
- [ ] Highlights persist per document under `hl::<docKey>` in `js/store.js`,
      re-anchor on reopen, and are included in library backup export/import.
- [ ] A review panel lists marked passages (grouped by unit) at end-of-chapter
      (opt-in toast) and end-of-session (`#done` card), with Jump / Remove / Copy.
- [ ] Markdown export downloads a file matching the documented format and is
      pasteable into Anki; **no** quiz/flashcard generation exists.
- [ ] No new vendored libraries; everything runs offline; single-file ethos intact.
