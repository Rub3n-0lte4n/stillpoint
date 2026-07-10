# Mobile Reader Redesign — Design

**Date:** 2026-07-10
**Status:** Approved
**Feature:** Apple Books-style reader chrome — chapter navigation in the top bar,
Reading settings as a mobile bottom sheet, slimmed mobile dock.

## Problem

On phones, Reading settings expands an accordion inside the bottom dock. The dock
then scrolls internally (`max-height:calc(100dvh - 150px)`), the segmented buttons
are small, and chapter navigation (a `<select>`) sits at the very bottom of that
scroll. Navigation is wayfinding, not a setting, and it is buried.

## Decisions (locked with user)

1. Chapter navigation moves to the reader top bar on **all screen sizes**;
   the buried `Navigate` select is removed from Reading settings.
2. Reading settings present as a **bottom sheet** under 680px; desktop keeps the
   inline expansion unchanged.
3. The always-visible mobile dock holds **scrub + transport + speed** only.
4. Architecture: **one DOM, two presentations** — no duplicated controls.

## Components

### Top bar (`.reader-top`)

- New 44px icon button `#tocToggle` ("Contents", list glyph) at the right edge,
  after `.doc-title`. `aria-expanded` + `aria-controls="toc"`.
- Under 680px the brand slims to the orb only (wordmark hidden) so the row holds
  orb-home · title (ellipsis) · contents without crowding at 320px.
- The button fades with the chrome in zen mode, like everything in `.reader-top`.

### Contents panel (`#toc`)

One element, two presentations:

- **≤680px:** bottom sheet — fixed, full-width, rounded top, grabber, scrim,
  slide-up transform, max-height ~70dvh with internal scroll.
- **>680px:** anchored popover under the contents button, right-aligned,
  ~320px wide, max-height ~60vh.

Contents:

- Chapter/page rows (48px+ touch targets) built from the same data that populates
  `#navSel` today, rendered by a pure `chapterItems(navPoints, currentIndex)`
  function (testable without DOM). Current position highlighted in gold.
  Tap → jump + close.
- When the document has figures, a final "Figures & tables" row opens the existing
  `#figIndex`; the dock's `#figIndexToggle` button is removed.

`role="dialog"`, `aria-modal="true"`, focus moves in on open, returns to
`#tocToggle` on close. Esc, scrim tap, and close button dismiss; swipe-down on the
grabber dismisses on touch. Opening while playing calls `pause()` (all viewports).

### Settings sheet (`.more-wrap` under 680px)

Same `#moreControls` DOM and bindings. CSS re-presents `.more-wrap` as a fixed
bottom sheet: scrim, grabber, uppercase "Reading settings" header with a Done
button, one control per row, full-width segments with 48px+ targets, safe-area
bottom padding, internal scroll only on overflow. Dismiss via scrim tap, Done,
Esc, or swipe-down on the grabber. Opening while playing calls `pause()`.

Sheet chrome (grabber/header/Done/scrim) is hidden ≥680px; desktop expansion is
unchanged, including no pause on open.

`prefers-reduced-motion`: slide + scrim fade replaced by simple fade.

### Mode relocation

Mode (ORP/RSVP/Hybrid) belongs in the mobile sheet but must stay in the desktop
dock row. Since the panel is one DOM node, the `#modeSeg` control node is
**relocated by JS** on the 680px breakpoint (`matchMedia` change listener +
initial placement): into `#moreControls` (first row) on mobile, back into
`.controls.primary` on desktop. Moving a node preserves its listeners; state
never duplicates.

### Slimmed mobile dock

Scrub, transport (back/play/forward/mark), speed row (− / slider / +), and the
Reading settings trigger. The dock's internal `max-height`/`overflow-y` hack is
removed — nothing tall lives in the dock anymore.

## Accessibility

- Both overlays: `role="dialog"`, `aria-modal`, focus in on open, focus returns
  to trigger on close, Esc closes.
- Collapsed/closed states keep `inert` (as `#moreWrap` does today).
- Grabber is `aria-hidden`; Done and Close are real buttons.
- Focus-visible rings per existing patterns; 44px+ targets throughout.

## Plumbing

- No new files: `index.html`, `styles.css`, `js/app.js`.
- `chapterItems()` lives where node tests can import it without DOM side effects.
- `CACHE_VERSION` → `stillpoint-v29` (this ships before the streak; the streak
  spec's v29 note becomes v30 when it ships).
- New test file `test/toc.test.mjs`: `chapterItems` — empty nav, chapter list with
  current highlighted, figures row presence flag. Joins `npm test`.

## Out of scope

- Desktop dock layout changes beyond removing `figIndexToggle` and `Navigate`.
- Landing page. Streak feature (separate approved spec, on hold).
- Search within the book.
