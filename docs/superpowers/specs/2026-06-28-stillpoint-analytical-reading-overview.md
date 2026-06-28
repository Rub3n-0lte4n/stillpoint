---
title: Structure-aware analytical reading — overview / epic
date: 2026-06-28
status: approved (design)
phases:
  - 2026-06-28-stillpoint-phase1-block-foundation-design.md
  - 2026-06-28-stillpoint-phase2-presentation-modes-design.md
  - 2026-06-28-stillpoint-phase3-retention-aids-design.md
---

# Stillpoint — Structure-Aware Analytical Reading (Overview)

This is the epic. The work is split into three independently shippable phases,
each with its own design spec, plan, and implementation cycle. This document
holds the context shared by all three: the problem, goals, non-goals, the core
decisions made during brainstorming, and the data model every phase builds on.

## Problem

Stillpoint is a pure RSVP/ORP speed reader. Both parsers flatten every document
into a single flat `tokens` array:

- `parsePDF` keeps only `page.getTextContent()` — spatial layout is lost, images
  are ignored, table-heavy pages degrade to jumbled word order.
- `parseEPUB` calls `body.textContent` — every `<table>`, `<img>`, `<figure>`,
  `<blockquote>`, and `<pre>` collapses into an undifferentiated word stream.

RSVP is a *linear, temporal* presentation. Tables, images, and equations are
*non-linear, spatial*. Streaming them one word at a time is meaningless. This
epic makes stillpoint preserve and present non-linear content without abandoning
its "every word at one still point" identity, and adds offline retention aids.

## Goals

1. Preserve non-linear content (tables, images, figures, equations, code,
   quotes) through parsing instead of discarding it. **(Phase 1)**
2. Present that content with the behaviour **chosen by the reader** — globally or
   per content kind. **(Phase 2)**
3. Improve retention with offline-only aids: smart pacing, rewind/regression,
   highlights & review. **(Phase 3)**
4. Stay 100% offline, single-file ethos, **no new vendored libraries**. (All)

## Non-Goals (YAGNI)

- AI-generated comprehension quizzes / flashcards (needs an LLM + user API key).
- PDF table text reconstruction. Tables in PDFs are **snapshotted to an image**.
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

## Shared data model

Existing `tokens` and `units` are unchanged so all RSVP/ORP/speed/`end`/`pause`
logic stays intact. Parsers gain a **sidecar `blocks` array** (introduced in
Phase 1, consumed in Phase 2):

```js
{
  tokens,   // unchanged: [{ w, end, pause }]
  units,    // unchanged: [{ title, start }]   page/chapter markers
  blocks: [ // NEW in Phase 1
    {
      id,       // stable id, e.g. "blk-12"
      after,    // token index this block follows (placement in the flow)
      kind,     // "table" | "image" | "figure" | "equation" | "code" | "quote"
      payload,  // image snapshot, sanitized html, or blob url — see Phase 1
      unit      // index into `units` the block belongs to (for the Appendix)
    }
  ]
}
```

**Rationale:** the reader loop already walks a token index. A sidecar keyed by
`after` turns block handling into a cheap "is there a block after index *i*?"
lookup, leaving the hot word-rendering path untouched.

## Phase map & dependencies

| Phase | Spec | Depends on | Independently shippable? |
|-------|------|-----------|--------------------------|
| 1 — Block-aware foundation | `…phase1-block-foundation-design.md` | — | Yes (parsers emit blocks; default behaviour unchanged for prose) |
| 2 — Presentation modes | `…phase2-presentation-modes-design.md` | Phase 1 | Yes (reader consumes blocks; settings) |
| 3 — Retention aids | `…phase3-retention-aids-design.md` | Phase 1 (loosely); pacing ramp ties to Phase 2 | Mostly — pacing/rewind/highlights operate on the token stream |

Recommended build order: 1 → 2 → 3. Phase 3 can begin in parallel with Phase 2
for the parts that touch only the token stream (rewind, highlights), deferring
the "gentle ramp after a block card" until Phase 2 lands.

## Affected modules (across the epic)

| File | Phases | Change |
|------|--------|--------|
| `js/parsers.js` | 1 | Emit `blocks`; DOM-walk EPUB; PDF image/table snapshotting |
| `js/text.js` | 3 | Pacing heuristics helper; token shape unchanged |
| `js/app.js` | 2, 3 | Reader loop block handling, modes, rewind, highlight capture, review/appendix/settings UI |
| `js/store.js` | 2, 3 | Persist `blockMode`, pacing prefs, highlight ranges per document |
| `index.html` / `styles.css` | 2, 3 | Block "still card", page view, appendix, review panel, settings, rewind controls |
