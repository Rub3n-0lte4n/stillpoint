---
title: Structure-aware reading for analytical documents
date: 2026-06-28
status: approved (design)
---

# Stillpoint — Structure-Aware Reading for Analytical Documents

## Problem

Stillpoint is a pure RSVP/ORP speed reader. Both parsers flatten every document
into a single flat `tokens` array:

- `parsePDF` keeps only `page.getTextContent()` — spatial layout is lost, images
  are ignored, scanned/table-heavy pages degrade to jumbled word order.
- `parseEPUB` calls `body.textContent` — every `<table>`, `<img>`, `<figure>`,
  `<blockquote>`, and `<pre>` collapses into an undifferentiated word stream.

RSVP is a *linear, temporal* presentation. Tables, images, and equations are
*non-linear, spatial*. Streaming them one word at a time is meaningless. This
spec makes stillpoint preserve and present that non-linear content without
abandoning its "every word at one still point" identity, and adds offline
retention aids.

## Goals

1. Preserve non-linear content (tables, images, figures, equations, code,
   quotes) through parsing instead of discarding it.
2. Present that content well, with the behaviour **chosen by the reader** —
   globally or per content kind.
3. Improve retention with offline-only aids: smart pacing, rewind/regression,
   and highlights & review.
4. Stay 100% offline, single-file ethos, **no new vendored libraries**.

## Non-Goals (YAGNI)

- AI-generated comprehension quizzes / flashcards (needs an LLM + user API key;
  breaks the offline identity). Explicitly out of scope.
- PDF table text reconstruction (row/column rebuilding from x/y positions).
  Tables in PDFs are **snapshotted to an image**, not re-parsed to text.
- OCR of scanned PDFs.
- Cloud sync of highlights.

## Core Decisions (from brainstorm)

| Decision | Choice |
|----------|--------|
| Direction | Block-aware parser + **all three presentation modes** behind a setting |
| Mode granularity | Global default, overridable **per content kind** |
| PDF tables | **Snapshot** (render region to image) — no text reconstruction |
| PDF images | Render region to canvas → image block |
| EPUB blocks | Walk DOM, preserve native `<table>/<img>/<figure>/<blockquote>/<pre>` |
| Retention | Smart pacing + rewind/regression + highlights & review (no AI) |

## Architecture

### 1. Data model

Existing `tokens` and `units` are unchanged so all RSVP/ORP/speed/`end`/`pause`
logic stays intact. Parsers gain a **sidecar `blocks` array**:

```js
// parser return shape:
{
  tokens,   // unchanged: [{ w, end, pause }]
  units,    // unchanged: [{ title, start }]   page/chapter markers
  blocks: [ // NEW
    {
      id,       // stable id, e.g. "blk-12"
      after,    // token index this block follows (placement in the flow)
      kind,     // "table" | "image" | "figure" | "equation" | "code" | "quote"
      payload,  // see below
      unit      // index into `units` the block belongs to (for the Appendix)
    }
  ]
}
```

`payload` by source:
- **PDF table / PDF image** → `{ type: "image", dataUrl|canvas, width, height, alt }`
  (rendered snapshot; held in memory for the session).
- **EPUB table / figure / quote / code** → `{ type: "html", html }` (sanitized).
- **EPUB image** → `{ type: "image", blobUrl, alt }` (decoded from the zip entry).

**Rationale:** the reader loop already walks a token index. A sidecar keyed by
`after` turns block handling into a cheap "is there a block after index *i*?"
lookup, leaving the hot word-rendering path untouched. All three modes are then
just different consumers of the same `blocks` array.

### 2. Parsing changes

**`parseEPUB`** — replace `body.textContent` with an in-order DOM walk:
- Text nodes → `tokenize()` → push to `tokens`.
- Block elements (`table`, `img`, `figure`, `blockquote`, `pre`) → push a block
  with `after = tokens.length` and a **sanitized** payload (strip
  `script`/`style`/event handlers; reuse the existing escaping discipline).
- Images resolved from the zip via the existing `zipEntry`/`resolveZipPath`
  helpers → object URL.

**`parsePDF`** — extend the per-page loop:
- **Images**: `page.getOperatorList()` → locate image XObjects + bounding boxes →
  render that region to an offscreen canvas → image block (`after` = current
  `tokens.length`).
- **Tables**: detect candidate regions (clusters of many short, x/y-aligned text
  items spanning multiple rows/columns), then **render the region to an image**
  (snapshot). Text still flows into `tokens` as a fallback so no content is lost
  if detection misfires.

**Risk:** PDF table *detection* is heuristic — it may miss real tables or
over-trigger. Mitigations: keep detection conservative (favour precision), make
every auto-detected block dismissible in the reader, and always keep the
fallback text in the stream.

### 3. Reader / presentation modes

New setting `blockMode`, with a global default and per-kind overrides
(e.g. `{ default: "pause", image: "skip", table: "pause" }`):

- **Pause & show** — RSVP halts at the block; it renders full-width as a "still
  card"; Space/tap resumes. Coming out, pacing ramps gently back to speed.
- **Hybrid** — the still card plus a "view page" toggle into a scrollable full
  render of the page/section, then a jump back to the exact word.
- **Skip + collect** — block does not interrupt the stream; it is appended to a
  per-chapter **Appendix** shown at unit end, plus a document-level
  "Figures & Tables" index.

### 4. Retention features

- **Smart pacing** — extend the existing `end`/`pause` flags: longer dwell at
  sentence ends, extra dwell at paragraph/unit ends, and auto-slowdown on long /
  complex sentences (word-count + average-word-length heuristic). Gentle speed
  ramp after a block card.
- **Rewind / regression** — "back a sentence" and "back 10 words" controls plus a
  sentence-replay. Implemented purely by moving the token index backward.
  Restores the glance-back RSVP removes.
- **Highlights & review** — tap to mark the current word/sentence (stored as
  token-index ranges); end-of-chapter and end-of-session review panel; export
  marked passages as markdown / Anki-importable text.

### 5. Persistence & footprint

- `blockMode` prefs, pacing settings, and highlight ranges extend the existing
  `store.js` localStorage model, keyed per document.
- **Snapshot/image payloads are session-memory only** — never written to
  localStorage (quota). On resume, blocks are re-rendered from the re-opened
  file; highlights and positions persist because they are index-based.
- No new vendored libraries: pdf.js already provides canvas rendering and
  operator lists; JSZip already extracts EPUB image entries.

## Affected modules

| File | Change |
|------|--------|
| `js/parsers.js` | Emit `blocks`; DOM-walk EPUB; PDF image/table snapshotting |
| `js/text.js` | Pacing heuristics helper (sentence complexity); unchanged token shape |
| `js/app.js` | Reader loop block handling, three modes, rewind, highlight capture, review/appendix UI, settings UI |
| `js/store.js` | Persist `blockMode`, pacing prefs, highlight ranges per document |
| `index.html` / `styles.css` | Block "still card", page view, appendix, review panel, settings, rewind controls |

## Testing strategy

- **Parser unit tests** with fixture documents: an EPUB containing a table + an
  inline image + a figure with caption; a PDF containing a figure and a
  table-like region. Assert `blocks` entries appear with correct `kind`,
  monotonic `after` indices, and that `tokens` still contains the surrounding
  prose.
- **Pacing**: assert dwell time increases at sentence/paragraph ends and for a
  long complex sentence vs. a short simple one.
- **Rewind**: assert "back a sentence" lands on the previous sentence-start token.
- **Highlights**: assert a marked range round-trips through `store.js` and that
  export produces the expected markdown.
- **Mode behaviour**: assert pause halts the stream at a block, skip routes the
  block to the appendix and does not halt, hybrid exposes the page-view toggle.
- **Graceful degradation**: a PDF with no detectable tables/images still reads
  exactly as today; a malformed block payload is skipped, not fatal.

## Rollout

Foundation (data model + parser blocks) lands first and is independently
testable. Modes, retention features, and settings UI build on top. Each is
additive and behind defaults that preserve today's behaviour for plain prose.
