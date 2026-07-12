# Progressive Hints + The Guide — Design

**Date:** 2026-07-12
**Status:** Approved
**Feature:** Teach the way games do — bare need-to-knows first, one revealed
hint at a time at calm moments, nothing re-taught once the player already does
it — plus a complete in-app manual for whoever wants the whole instrument.

## 1 · The hint engine (`js/hints.js`)

A small ordered queue. Each hint has an id, a text, an earliest **day of use**
(`minDay` — distinct local days on which the reader was opened, not visits),
a modality gate (`touch: true` hints never fire for a mouse; detected via
`(hover:none)`), and a surface (`reader` | `landing`).

| id        | day | modality | surface | teaches                                   |
|-----------|-----|----------|---------|-------------------------------------------|
| zones     | 1   | any      | reader  | swipe / tap the edges to step a sentence  |
| speeddrag | 2   | touch    | reader  | drag up or down for speed                 |
| holdmark  | 3   | touch    | reader  | hold the word to highlight the sentence   |
| rowswipe  | 3   | touch    | landing | swipe a book left to remove it (needs ≥2) |
| pinch     | 4   | touch    | reader  | pinch for text size                       |

Rules, in the game-tutorial spirit:

- **One hint per day, total,** across both surfaces (`lastShownDay` gate).
- **Calm moments only.** Reader hints fire on a *deliberate* pause (the
  `toggle()` pause branch — never on tab-hide, finishing, or opening a panel).
  Landing hints fire when the library renders on return from a book. Nothing
  ever interrupts the word stream.
- **Usage is graduation.** Performing a mechanic organically marks it `used`
  and it is never hinted: zones on any edge-tap/swipe, speeddrag on any speed
  drag, pinch on any pinch, holdmark on any stage hold, rowswipe on any row
  reveal or swipe-delete.
- Ledger `fp_hints_v1` = `{shown, used, dayCount, lastDay, lastShownDay}`.
  The legacy `fp_hint_zones_v1` flag migrates in as `shown.zones`; the old
  inline toast in `play()` is deleted. Hints are deliberately **not** in the
  cross-device backup: new device, new hands, possibly new modality.
- Pure `nextHint(state, ctx)` is exported and unit-tested
  (`test/hints.test.mjs`, joins `npm test`).

**Presentation:** the existing toast, with `hint:true` — a gold ✦ leads the
message, the border warms gold, duration 7s, and every hint carries a
**Guide** action that opens the manual. The drip always links to the codex.

## 2 · The Guide (complete manual)

A new `#guide` modal on the `.about` shell: title, one-line lead, then
scannable sections of `action → how` rows. Sections: Reading · Moving around ·
Speed and size · Marking · Tables and figures · Reading aids · Your library ·
Keys. Keyboard mentions sit in `.kb-only` spans (hidden on touch, where they
mean nothing); the Keys section is `.kb-only` wholesale. Copy follows the
house voice (no AI tells).

**Ways in:** footer link "Reader guide" · a quiet "Open the guide" row at the
bottom of Reading settings (closes the sheet first on phones) · the `?` key in
the reader (added to the kbd hint row) · the Guide action on every hint toast.

**Modal behaviour** matches about/patron: Esc, scrim tap and ✕ close; Tab is
trapped; focus returns to the opener; the reader keydown handler stands down
while it is open.

## Plumbing

- New `js/hints.js` → SW `SHELL` (a missing shell file breaks install
  silently), cache v40. New `test/hints.test.mjs` in package.json.
- `index.html`: guide modal, footer link, settings link, `?` in kbd row.
- `js/app.js`: Hints wiring (readerOpened, used×5, maybeHint on toggle-pause
  and showLibrary), guide open/close, `?` key, toast `hint` option.
- `styles.css`: `.toast.hint`, guide rows.

## Out of scope

Interactive walkthrough overlays (coach marks pointing at UI), hint settings
UI, re-showing dismissed hints, backup sync of the hint ledger.
