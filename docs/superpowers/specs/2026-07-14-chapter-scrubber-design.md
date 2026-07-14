# Chapter-Scoped Scrubber — Design

**Date:** 2026-07-14
**Status:** Approved
**Feature:** Audible-style chapter-scoped progress in the reader dock: the bar,
elapsed and time-left describe the current chapter; the top-right meta line
names it. User-reported: a 418k-word book shows `-1044:30` of book-remaining,
which is demoralizing and useless mid-read.

## Summary

The dock scrubber currently spans the whole document. It becomes chapter-scoped:
fill, `tElapsed` and `tLeft` are computed within the current chapter, drag and
keyboard scrub within it, and the `docMeta` line in the reader top bar shows the
live chapter title. Documents without chapter structure (pasted text, PDFs with
no outline) keep the whole-book bar exactly as today. Library rows and the
finish card stay whole-book (Audible does the same in its library).

## Decisions (locked with user)

1. **Shape:** full Audible scrubber (bar + both flank times chapter-scoped),
   not a label-only or meta-only variant.
2. **Grid source:** the declared ToC (`nav`) when it has ≥2 entries — for
   Calibre-split books like Musashi that is the 50 real chapters, not the 123
   size-based spine files. EPUBs without a usable nav fall back to spine
   `units`; PDFs never use page-units as chapters (no outline → whole book);
   pasted text/demo → whole book.
3. **Cross-chapter movement:** the Contents panel (already one tap away, and
   already `nav`-first, so panel and bar always agree). No chapter-skip
   transport buttons — the 5-button symmetry around the focal axis is
   deliberate (see 2026-07-12 focal-axis fix).
4. **Library rows / done card / streak / resume:** untouched.

## Chapter grid (pure, `js/text.js`)

```js
chapterGrid(kind, nav, units, total) -> [{ title, start, end }]   // end exclusive
chapterAt(grid, index)               -> segment index k
```

- `nav` entries (`{title, start, depth}`) become segments regardless of depth
  (declared sub-chapters are real stops). Defensive sort by `start`; drop
  zero-length segments (same-start entries are already deduped by the parser).
- If `nav[0].start > 0`, prepend a synthetic `{title:null, start:0}` segment so
  front matter is covered.
- Fallback order: `nav` (≥2 entries, any kind) → `units` (≥2, EPUB only) →
  single whole-book segment `[{title:null, start:0, end:total}]`.
- `chapterAt` clamps: `index < 0` → 0, `index >= last.end` → last segment.
- Computed once at open into `S.chapters` (+ `S.curCh` cache). `openReader`
  gains a `kind` argument ("pdf" | "epub" | "text"); every callsite already
  has it in hand.

## Scrubber & meta behavior (`updateProgress`)

Always grid-driven — with a single book segment the math degenerates to today's
behavior, so there are no special-case branches.

- `pct = (index - seg.start) / (seg.end - seg.start)`; bar fill + knob as now.
- `tElapsed = fmt((index - seg.start) / wpm * 60)`,
  `tLeft = "-" + fmt((seg.end - index) / wpm * 60)` (seconds, as today).
  `setWpm` already calls `updateProgress`, so times track speed changes.
- `docMeta` shows `seg.title`, falling back to the static parse meta
  ("EPUB · 12 chapters · 84,120 words") when `title` is null (book-scope docs
  and the synthetic front-matter segment). Updated only when the segment
  changes; `document.title` and `docTitle` untouched.
- Crossing a boundary while streaming naturally resets the bar to 0% and swaps
  the meta title — the "new chapter" moment.
- Track a11y: `aria-valuenow` = chapter pct, `aria-valuetext` =
  `"37% of The Old Cryptomeria Tree"` (or `"37% read"` book-scope).
- Drag (`scrubTo`): pointer fraction maps to `seg.start + p*(seg.end-seg.start)`,
  clamped to the segment. Releasing hard-right lands on `seg.end` = the next
  chapter's first word (bar shows 0% of the next chapter); hard-left is chapter
  start. Big jumps belong to the Contents panel.
- Keyboard on the focused track: arrows step 2% of the chapter, Home/End jump
  to chapter start/end.
- `S.curUnit` (units-based; feeds the chapter-appendix toast and ToC re-render)
  stays as is — `S.curCh` is a parallel cache over the grid.

## Edge cases

- Last chapter: `seg.end === total`; scrub clamp keeps `index ≤ total-1`
  (existing `jumpTo` clamp), so scrubbing never triggers finish.
- Resume mid-book: `updateProgress()` at open derives everything from `S.index`.
- Non-monotonic or degenerate nav data: sorted, zero-length dropped; if fewer
  than 2 segments survive, fall back as if nav were absent.
- Book-scope docs are byte-for-byte today's behavior (single segment).

## Testing

- Unit (`test/toc.test.mjs`, same module as `chapterItems`): nav-first for EPUB
  and PDF-with-outline; EPUB-no-nav → units; PDF-no-outline → book; text → book;
  synthetic front-matter segment; ends exclusive + monotonic; zero-length
  dropped; `chapterAt` at boundaries and out-of-range.
- CDP E2E (live app, Musashi fixture): bar resets at a chapter boundary with
  meta title swap; flank times match chapter words at known wpm; drag clamps to
  chapter and lands on next-chapter start at hard-right; Home/End are
  chapter-scoped; pasted text identical to pre-change behavior; aria-valuetext.

## Ship notes

- `sw.js` CACHE_VERSION → v45 (app.js/text.js/index.html are in SHELL).
- No storage/schema changes; nothing new in backup export.
