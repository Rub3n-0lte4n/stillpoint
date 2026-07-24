# Chapter Completion Reward — Design

**Date:** 2026-07-24
**Status:** Approved
**Feature:** Reward finishing a chapter, and finishing a book, with a quiet in-flow beat plus an accumulating artifact (a chapter-segmented spine per book, and a shelf of finished books). Local-first, no accounts, no numbers, no engagement mechanics.

## Summary

Reading across a chapter boundary earns that chapter. The moment it is earned, the reader takes one designed breath at the natural seam: a soft check, the incoming chapter title settling in, one calm orienting line, and a `success` haptic on mobile. What accumulates is an artifact, not a score: each book carries a **spine** divided into one band per chapter that inks in as chapters are earned, and finishing a book stands that spine on a **Finished shelf**. All state is local, per document, and rides the existing one-file backup. There are no points, levels, badges, streak pressure, reminders, or leaderboards.

This is Belief 2 (*Finishing*) productized: the enemy of reading is abandonment, not slowness, and the app already "celebrates completion, not velocity" (`.agents/product-marketing.md`). The reward makes progress-made and completion visible and satisfying without turning reading into a game.

## Decisions (locked with user)

1. **Register:** both layers — the in-flow moment and the accumulating artifact.
2. **Artifact:** a filling chapter-segmented measure per book (horizontal on library rows), standing as a vertical spine on a Finished shelf.
3. **Spine style:** tonal, drawn in the active theme's own ink. Not a skeuomorphic leather book. Restraint is the luxury (Belief 4).
4. **Shelf spines scale with book length**, so the shelf reads as an honest skyline rather than uniform bars.
5. **Pause at chapter breaks defaults off.** The beat is a breath, not a stop. An opt-in setting turns each break into a real pause for readers who want to rest between chapters.
6. **No master on/off switch.** The beat is non-intrusive and the artifact is passive, so the pause toggle is the only control.

## What counts as "completed" (earned, not scrubbed)

A chapter is earned only when playback carries the reader across its end boundary. Scrubbing or jumping past a boundary earns nothing.

The signal already exists. `updateProgress(throttled)` (app.js ~789) is called with `throttled === true` **only from the streaming loop** (see the comment at ~785); scrubs, jumps, and pause paths call it untruthed. So:

- In `updateProgress`, at the existing chapter-crossing branch (`k !== S.curCh`, ~808), when `throttled === true` and `k > S.curCh`, the reader has just finished by reading. Credit each chapter index from `S.curCh` up to `k - 1` (usually exactly one; a range only if a chapter is shorter than one playback step) before advancing `S.curCh = k`.
- Each chapter is credited once (a union set). Re-reading an earned chapter re-crosses the boundary but earns nothing new, so the beat does not re-fire.
- Books with no table of contents have exactly one whole-book segment, so they earn no chapters and reach their reward at the finish card instead. Synthetic word-count chapters are deliberately not created; they would make "chapter" meaningless.
- The **last** chapter is never crossed out of, so it is credited in `finish()` (app.js ~405), together with setting the finished timestamp. The finish card is that chapter's celebration; no separate beat fires for it.

## Data model

One new namespaced IndexedDB record per document, keyed `read::<docKey>` in the existing `stillpoint`/`files` store (same convention as `blockmode::` and `hl::`, so no DB version bump). `docKey` is the same stable per-document key `hl::` and `blockmode::` already use, so reward data reattaches when the same book is reopened:

```json
{
  "chapters": [0, 1, 2, 3],
  "bounds":   [0, 1180, 3402, 6690, 9120],
  "total":    11540,
  "title":    "Burnt Norton",
  "kind":     "EPUB",
  "finishedAt": 1721779200000
}
```

- `chapters` — earned chapter indices, unique and sorted.
- `bounds` — chapter start token indices from the parsed `chapterGrid`; `bounds` plus `total` define the segments, so the spine renders without re-parsing the book.
- `total` — token count, used for the current-band fill and for shelf spine height.
- `title` / `kind` — captured so a finished book renders on the shelf even after it falls off the capped recent library (`fp_library_v1`, `LIB_MAX`). The shelf must outlive library pruning: a finished book stays on your shelf.
- `finishedAt` — epoch ms when the book was first finished, or `null`. Earliest finish wins; never overwritten.

Written at three moments: on parse (set `bounds`, `total`, `title`, `kind`), on credit (add to `chapters`), on finish (add the last chapter, set `finishedAt`).

Records are **not** pruned with the recent-library cap. They are small; if a horizon is ever needed it prunes by oldest `finishedAt`, unfinished records last.

## Module: `js/reward.js`

ES module, pure core with no DOM, mirroring `streak.js`. Storage-backed calls go through `js/store.js`.

Pure core (unit-tested):

- `creditChapter(rec, k)` → new rec with `k` unioned into `chapters` (sorted). Idempotent.
- `markFinished(rec, lastK, when)` → unions `lastK`, sets `finishedAt = rec.finishedAt ?? when`.
- `spineBands(rec, index)` → one descriptor per segment from `bounds`/`total`: `{ start, end, state, fill }` where `state` is `"done"` (index in `chapters`), `"current"` (the segment containing `index`, `fill = (index - start) / (end - start)`), or `"unread"`. Drives both the library row and the finish card.
- `shelfEntries(records)` → finished records (`finishedAt != null`) as `{ key, title, kind, total, finishedAt, height }`, ordered by `finishedAt` descending. `height` is `total` mapped through a log/sqrt curve clamped to a tasteful min/max, so lengths differ visibly without extremes.
- `mergeRead(local, imported)` → union of `chapters`; earliest non-null `finishedAt`; `bounds`/`total`/`title`/`kind` from whichever record has them. Honest merge, same spirit as `mergeDays`.

Storage-backed API:

- In-memory `Map` keyed by `docKey`, hydrated once at init from all `read::*` keys, so the library and shelf render synchronously. Writes go through the Map and persist async (write-through).
- `Reward.hydrate()` — load all `read::*` records into the Map at startup.
- `Reward.note(docKey, { bounds, total, title, kind })` — record parse metadata.
- `Reward.credit(docKey, k)` → `{ newlyEarned }` — credit a chapter; `newlyEarned` gates the beat.
- `Reward.finish(docKey, lastK, when)` — mark finished.
- `Reward.forDoc(docKey)` → rec (for `spineBands`).
- `Reward.shelf()` → `shelfEntries` over the Map.
- `Reward.exportAll()` / `Reward.importMerge(list)` — backup.

A small prefix helper is added to `js/store.js` (`getAllByPrefix(prefix)` over `getAllKeys` + `get`) so hydrate is one pass.

## The moment (the seam beat) — app.js + a stage overlay

A dedicated stage overlay `#chapterBeat` (absolutely positioned, `pointer-events:none`, does not shift layout) sits over the still point. When a forward crossing newly earns a chapter (or several at once, in which case it fires once for the latest):

- The current word softens (a brief opacity dip) while the overlay plays, roughly one second, like an exhale. Playback continues underneath.
- The overlay shows a quiet check for the finished chapter, the incoming chapter title, and one orienting line, then fades.
- `Haptics.trigger("success")` on the crossing (already vendored in `haptics.js`).
- `prefers-reduced-motion`: no exhale or slide, a plain fade only.
- The completion line is `aria-live="polite"`; nothing steals focus.

If **Pause at chapter breaks** is on, `pause()` is called at the crossing and the overlay rests with a subtle resume affordance until the reader continues. Default off: the breath plays and reading rolls on.

The beat never fires while the document is hidden, and never over an open modal (the finish card, contents, review). Same "do not photobomb the moment" discipline already noted at app.js ~87.

## The spine (per-book artifact)

The existing library-row progress bar `ri-bar` (index.html render at app.js ~1037, currently `<i class="ri-bar" style="width:pct%">`) becomes a chapter-segmented measure driven by `spineBands`:

- Done bands: solid ink in the theme accent tokens. Current band: partially inked to its within-chapter fill. Unread bands: faint. Hairline gaps between bands, in the register of the streak ledger's hairlines.
- Books with one whole-book segment render as today's single continuous bar. No visual regression for structureless documents.
- The row keeps its existing `% · ~Xm left` utility text. The spine adds meaning, not a second number.
- The spine also renders on the finish card beside the stats, showing the book fully (or nearly) inked at the moment of completion.
- The spine is never on the reading stage. The stage stays the still point.

## The shelf (accumulation)

A new landing section `#shelf` ("Finished"), placed near `#recent` (index.html ~229) and `#streakStrip` (~234), gated like them (hidden until at least one finished book exists):

- A horizontal row of vertical spines, one per finished book, drawn from `Reward.shelf()`. Height scales with length. Tonal, theme-inked, uniform width, subtle separation.
- Each spine labels its book on hover and focus (accessible name = title); it is a real control that reopens the book.
- Ordered most-recent-first. Structureless finished books stand as a single solid spine with no internal bands.
- Removing a book from the recent library does not un-finish it. The `read::` record persists and the spine stays on the shelf. If the book's file is no longer stored, the spine remains as a memento and is not reopenable.
- The shelf shows only finished books. It never renders empty slots, abandoned books, or "unfinished" shaming. For the guilt-stacked avatar the shelf is earned pride, never a chore tracker (Belief 1: no engagement mechanics).

On finish, the finish card ends by standing the new spine up and sliding it onto the shelf, so completion has a visible place to land. This animation respects reduced motion.

## Copy (no AI tells; see `.agents/product-marketing.md`)

Plain sentences, no em dashes, no rule-of-three lists.

- Seam line, default: `Chapter 4 of 12.`
- Seam line, halfway: `Chapter 6 of 12. Halfway.`
- Seam line, near the end: `Chapter 11 of 12. Almost there.`
- Only the clean milestones get a second sentence. No generated fractions like "a third of the way," which read as robotic.
- Section eyebrow, matching existing uppercase letterspaced labels: `FINISHED`.
- Shelf spine accessible name: `<title>, finished` (for example `Burnt Norton, finished`).
- Finish card keeps its existing `You finished "<title>".` and the streak line; the spine is visual, no new sentence.

The fraction ("Chapter 4 of 12") is orientation, not a score, and reads as progress toward finishing rather than velocity.

## Backup export/import

- `buildBackup()` adds an optional `reward` field: the list of all `read::<docKey>` records with their keys.
- Import: absent field is a no-op, so old backups import unchanged. Present, each record merges through `mergeRead` (union of chapters, earliest finish). Consistent with how `streak` and library data already merge honestly across devices.

## Service worker

- Add `js/reward.js` to `SHELL` in `sw.js`.
- Run `npm run sw:bump` so the content-derived `CACHE_VERSION` updates (CI's `sw:check` fails otherwise).

## Tests: `test/reward.test.mjs`

Pure-core coverage, joining the existing suite in `npm test`:

1. `creditChapter`: adds an index, stays sorted and unique, is idempotent on re-credit.
2. `markFinished`: unions the last chapter, sets `finishedAt` once, never overwrites an earlier finish.
3. `spineBands`: done/current/unread classification; current-band `fill` fraction; a one-segment book returns a single band; `index` at a boundary lands in the right segment.
4. `shelfEntries`: only finished records; descending `finishedAt` order; height is monotonic in `total` and clamped.
5. `mergeRead`: chapter union; earliest `finishedAt` wins; metadata carried from whichever side has it.
6. Earned-not-scrubbed contract, at the integration seam: a credit is issued only on a throttled forward crossing (documented and covered where the crossing helper is unit-reachable).

## Belief alignment

- **Belief 2, Finishing.** The whole feature celebrates completion, chapter by chapter and book by book, with no speed or velocity framing.
- **Belief 1, Attention.** No notifications, no reminders, no streak pressure on chapters, no dark patterns. The beat never interrupts against the reader's will; the artifact is passive.
- **Belief 4, Stillness as craft.** Tonal, theme-native rendering; one honest measure instead of badges and confetti.
- **Belief 5, Patronage over paywalls.** The reward is free for everyone and touches nothing patron. It never gates reading and never unlocks or competes with the patron themes.

## Out of scope

- Sharing, social, or public shelves.
- Points, levels, badges, XP, or any spendable currency.
- Chapter streaks, reminders, or notifications.
- Reader-stage progress UI beyond the transient beat.
- Synthetic chapters for structureless documents.
- Cross-book meta-progression beyond the shelf (a garden, a map, a sky).
