# Stage Gestures — Design

**Date:** 2026-07-11
**Status:** Approved (items 1–3 of the mobile-first gesture assessment)
**Feature:** The reading stage becomes a multi-gesture surface: vertical drag =
speed, horizontal swipe = sentence navigation, pinch = text size.

## Decisions (locked with user)

1. **Vertical drag on the stage adjusts wpm.** Up = faster. Live: one 25 wpm step
   per ~12px of travel, clamped 150–800. A ghost readout (gold Archivo number +
   "wpm" label) fades in near the top of the stage while dragging, haptic tick
   per step, fades out shortly after release. Works while playing, paused, and
   in the resting state (set your pace before starting).
2. **Horizontal swipe steps a sentence.** Swipe right = back, left = forward —
   the same actions as the edge tap zones, reusing the `#zoneFlash` chevrons.
   Armed only once reading has started (same rule as tap zones).
3. **Pinch changes text size** through the existing S/M/L/XL steps
   (44/62/82/104px): each ×1.25 of finger spread is one step, clamped to the
   scale, haptic per step, segment UI stays in sync via `setSize()`.

## Recognizer (js/gestures.js)

One pointer-events recognizer owns the stage; no competing listeners.

- **Pure math, exported for node tests:** `axisLock(dx,dy,slop=10)` (null until
  movement passes the slop, then "h"/"v" by dominant axis), `dragWpm(startWpm,
  dy)`, `pinchIndex(startIndex, ratio)`, `swipeDir(dx,dy,dist=48)` (requires
  |dx| ≥ dist and |dx| ≥ 1.5·|dy|).
- **`stageGestures(el, callbacks)`** wires pointerdown/move/up/cancel with
  pointer capture. Second pointer down → pinch mode (ends any live speed drag).
  After a pinch, the surviving pointer is dead until lifted (no accidental
  swipe). `pointercancel` ends cleanly.
- **Tap preservation:** the existing stage `click` handler (tap zones, play/
  pause, card resume) stays; the recognizer exposes `consumed()` and any
  drag/swipe/pinch suppresses the click that follows. Movement under the 10px
  slop remains a plain tap — zero added latency.
- `.stage` gets `touch-action:none` (it owns all gestures; the reader layout
  never scrolls). Page pinch-zoom still works outside the stage.

## Plumbing

- New `js/gestures.js` (pure core + recognizer) → SW `SHELL`, cache v33.
- `index.html`: `#speedGhost` inside `.stage`, `aria-hidden` (the dock's
  aria-live wpm readout already announces changes).
- `js/app.js`: wire recognizer in init; gate the click handler on `consumed()`.
- `test/gestures.test.mjs`: axis lock slop/dominance, dragWpm direction/clamp/
  step size, pinchIndex ratio mapping/clamp, swipeDir threshold + angle guard.

## Out of scope

Sheet drag-anywhere dismissal, swipe-to-delete library rows, long-press mark
(items 4–6 — a later cycle). Double-tap and pull-to-dismiss: rejected outright.
