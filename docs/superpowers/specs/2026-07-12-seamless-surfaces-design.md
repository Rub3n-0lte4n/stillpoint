# Seamless Surfaces — Design

**Date:** 2026-07-12
**Status:** Approved (items 4–6 of the mobile-first gesture assessment, plus the
paper cuts found on the way)
**Feature:** The app's surfaces obey the finger the way iOS surfaces do: bottom
sheets drag from anywhere and dismiss on velocity, library rows swipe to delete,
and holding the reading stage marks the sentence. Plus route transitions and a
set of correctness paper cuts.

## 1 · Sheets with physics (item 4)

Both bottom sheets (`#toc`, `#moreWrap` under 680px) become draggable surfaces,
not grabber-only:

- **Drag from anywhere on the sheet.** A downward drag engages when every
  scrollable ancestor under the finger is at its top; otherwise the native
  internal scroll wins. Upward drags and mid-list drags scroll as before.
- **Implementation: non-passive touch events** (not pointer events) so an
  undecided gesture can be released to native scrolling with momentum intact.
  The decision happens on the first move past 6px: down + at-top → the sheet
  owns the gesture (`preventDefault`), anything else → dead, native scroll.
- **1:1 tracking, rubber-band above rest.** `sheetOffset(dy)` = identity for
  `dy ≥ 0`; upward it compresses smoothly toward a 24px cap
  (`-24·(1-e^(dy/72))`).
- **Velocity dismissal.** A ~100ms sample window feeds `velocityFrom(samples)`;
  on release `sheetRelease(offset, vy, height)` returns `dismiss` when
  `vy > 0.5 px/ms`, or `offset > 40%` of the sheet height without meaningful
  upward velocity — otherwise `settle`. Dismiss animates out from the release
  point with a duration derived from the remaining distance over the release
  velocity (clamped 140–320ms); settle springs back on the sheet's own
  transition.
- **Interruptible.** A touch during any sheet animation freezes it at its
  computed transform and the drag continues from there.
- **The scrim follows the finger** — its opacity tracks 1 − offset/height, so
  the room lightens as the sheet leaves.
- The old grabber-only `sheetSwipe` is deleted; the grabber remains as the
  visual affordance. Reduced motion: dragging still tracks 1:1 (direct
  manipulation), the settle/dismiss transitions collapse to instant via the
  global reduced-motion rule.

## 2 · Swipe-to-delete library rows (item 5)

Rows restructure from click-wired `<span>`s into real controls — which also
fixes the standing a11y gap (rows were unreachable by keyboard):

```
.recent-item                 shell: radius, border, overflow:hidden, position:relative
  ├ .ri-del  (button)        pinned under the right edge — "Remove", rose
  └ .ri-face                 slides; carries the surface background
      ├ .ri-open (button)    type badge · title · progress (opens the book)
      ├ .ri-x    (button)    the existing ✕, now a real button
      └ .ri-bar              2px progress hairline along the bottom, gold
```

- **Gesture:** pointer events with the existing `axisLock` slop; rows are
  `touch-action:pan-y`, so vertical scrolling never fights the swipe
  (a scroll takeover arrives as `pointercancel` → the row settles closed).
- **Release decision:** pure `rowRelease(offset, vx, width)` — rightward fling
  closes; past 55% of the row width or a fast leftward fling (< −0.8 px/ms)
  deletes; past half the 88px reveal (or a slower leftward fling) rests open
  on the Remove button; otherwise closes. One row open at a time.
- **Commit choreography:** the face slides off, the row collapses (height +
  opacity), then the existing `removeItem` runs — same Undo toast, same
  deferred IndexedDB delete. The ✕ button routes through the same collapse.
- **The "will delete" moment:** crossing the 55% commit line brightens the
  under-layer and ticks once (light) — the finger learns "release here
  deletes". One tick per crossing, never per pixel (haptics budget).

## 3 · Hold the stage to mark (item 6)

- `stageGestures` gains a hold: a single pointer that stays inside the 10px
  slop for 450ms (the app's shared hold beat) fires `onHold`, consumes the
  gesture (the following click is swallowed), and goes dead until release.
- app.js: hold → `markCurrent(false)` — the sentence you're hearing is
  highlighted without pausing the stream (same as pressing M). Existing
  success haptic + toast. Inert while the resting screen shows.
- A pinch or an axis-locked drag cancels the pending hold. `.stage` gets
  `-webkit-touch-callout:none` beside its existing `user-select:none`.

## 4 · Paper cuts

1. **Back closes the top surface first.** `popstate` while the reader shows:
   if any overlay is up (contents, mobile settings sheet, figures index, page
   view, block card, review) it closes and the reader state is re-pushed;
   only a bare reader exits to the library. Android Back now behaves like the
   platform promises. `showLibrary` also force-closes overlays so no stale
   sheet survives into the next book.
2. **Patron modal owns the keyboard.** The reader-level keydown handler now
   also stands down while `#patron` is open (Space was still driving playback
   behind it).
3. **Scroll containment.** `overscroll-behavior:contain` on every internal
   scroller (toc list, settings sheet, block card body, page view, figures,
   review) — reaching an edge never chains to the surface behind.
4. **Route transitions.** `#landing` and `.reader.show` enter with a 300ms
   fade-and-rise (`viewIn`). Display-toggled elements restart CSS animations,
   so both directions get the same calm entrance; reduced motion collapses it.
5. **Library rows show their progress** as a 2px gold hairline (width = % read,
   full and bright when finished) under the row — the numbers stay, the shape
   becomes scannable.

## Plumbing

- `js/gestures.js`: pure `sheetOffset`, `sheetRelease`, `velocityFrom`,
  `rowRelease` (+ hold support in `stageGestures`), recognizers `sheetDrag`,
  `rowSwipe`. All pure math joins `test/gestures.test.mjs`.
- `js/app.js`: renderLibrary restructure, recognizer wiring, popstate logic,
  patron guard, overlay cleanup. `styles.css`: row anatomy, viewIn,
  containment. No new files beyond this spec; no HTML changes.
- `CACHE_VERSION` → `stillpoint-v37`.

## Out of scope

Drag-to-reorder the library, sheet snap points (content-height sheets don't
need them), swipe actions beyond Remove. Double-tap and pull-to-dismiss stay
rejected (earlier decision).
