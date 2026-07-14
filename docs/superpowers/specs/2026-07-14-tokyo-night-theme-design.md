# Tokyo Night Theme + Themed Stage — Design

**Date:** 2026-07-14
**Status:** Approved
**Feature:** Fourth patron theme "Tokyo Night" (neon-sign Tokyo, not the VS Code
palette), and the reading stage finally follows the active theme — its gradients
were the last hardcoded-midnight surface (user-reported: "the word box stays the
default purple").

## Decisions (locked with user)

1. **Neon direction:** neon pink leads, neon red is the hot edge of the same
   family, electric blue is the companion. Ground near-black with a blue-violet
   cast, inks calm near-whites — neon lives in chrome and glows, never under
   long-form reading.
2. **Stage theming:** the stage joins the token system in ALL themes (this
   supersedes the 2026-07-04 "stage stays midnight by design" decision).
   Midnight's stage must remain pixel-identical.
3. **Focal amber, guide lines, halo:** unchanged in every theme — the one warm
   constant and the tested ORP anchor.
4. **Hex tuning:** user judges the real app from headless screenshots after
   build; values below are the starting point.

## Stage tokens (styles.css)

`.stage` (styles.css ~399) currently hardcodes its gradients and inset vignette.
Four new tokens, defaulted in `:root` to the exact current values:

```css
--stage-sheen: rgba(197,163,255,0.07);  /* top sheen tint */
--stage-core:  rgba(36,23,54,0.78);     /* center gradient inner */
--stage-edge:  rgba(11,7,19,0.62);      /* center gradient outer */
--stage-vign:  rgba(7,4,14,0.55);       /* inset vignette (90px) */
```

`.stage`'s `background` and the `inset 0 0 90px` term of its `box-shadow`
consume the tokens; the amber `::before` halo, guides, and baseline stay as-is.
Existing patron themes override them with their own ground:

- **ember:** sheen `rgba(255,184,148,0.06)`, core `rgba(54,28,16,0.78)`,
  edge `rgba(16,8,5,0.62)`, vign `rgba(12,6,3,0.55)`
- **garden:** sheen `rgba(159,232,192,0.06)`, core `rgba(16,44,30,0.78)`,
  edge `rgba(6,16,11,0.62)`, vign `rgba(4,12,8,0.55)`
- **abyss:** sheen `rgba(156,195,255,0.06)`, core `rgba(20,32,58,0.78)`,
  edge `rgba(6,10,19,0.62)`, vign `rgba(4,7,14,0.55)`

## Tokyo Night token block (styles.css)

```css
html[data-theme="tokyo"]{
  --bg-deep:#07070d; --bg-0:#0a0a12; --bg-1:#10101c; --bg-2:#171728;
  --surface:rgba(32,26,48,0.55); --surface-2:rgba(46,34,66,0.45); --surface-inset:rgba(10,8,18,0.5);
  --hair:rgba(255,120,170,0.13); --hair-strong:rgba(255,120,170,0.24); --hair-soft:rgba(255,120,170,0.06);
  --ink-bright:#fff5fa; --ink:#f0e7f2; --ink-soft:#cdbcd4; --ink-mute:#a693b0;
  --amethyst:#ff6b9d; --amethyst-deep:#ff2d55; --rose:#5bc8ff; --focus-dim:#c4b3c8;
  --glow-a:rgba(255,45,120,0.14); --glow-b:rgba(60,180,255,0.10);
  --glow-amethyst:0 22px 60px -24px rgba(255,45,85,0.5);
  --stage-sheen:rgba(255,92,150,0.06); --stage-core:rgba(26,18,38,0.78);
  --stage-edge:rgba(8,7,15,0.62); --stage-vign:rgba(6,5,12,0.55);
}
```

`--ink-mute` on `--bg-0` must hold ≥5:1 (match the other themes' verified AA);
adjust lightness, not the direction, if it falls short.

## Plumbing (mostly automatic)

- `js/patron.js` THEMES gains `{ id:"tokyo", name:"Tokyo Night" }` — patron
  gating (`≠ midnight`), the dock Theme seg, `applyTheme`'s PWA status-bar sync
  (reads `--bg-0`), and `fp_prefs` backup persistence all follow from it.
- Theme seg now holds five options; mobile already wraps (`.seg{flex-wrap}` in
  the ≤680px block). Measure the desktop more-panel at 1280px via CDP — if the
  seg clips, apply the same wrap treatment outside the media query for
  `#themeSeg` only.
- Any user-facing copy that enumerates the patron themes (patron card, pitch
  modal, FAQ, README) gains Tokyo Night — factual enumeration, allowed under
  the copy voice rule.

## Testing / verification

- `test/patron.test.mjs`: update any assertion pinning the THEMES list/length;
  add `tokyo` to the gating cases (patron-only, midnight stays free).
- CDP E2E: apply each of the five themes on the live reader; assert
  (a) `.stage` computed background changes per theme (and is byte-identical to
  pre-change on midnight), (b) `html[data-theme]` + theme-color meta sync,
  (c) locked behavior for non-patrons unchanged. Screenshot each theme
  (landing + reader) for the user's hex review.
- Full `npm test` green.

## Ship notes

- `sw.js` CACHE_VERSION → v46 (styles.css, patron.js, app.js in SHELL).
- No storage changes; `fp_prefs.theme:"tokyo"` round-trips through existing
  backup import validation (unknown themes already fall back to midnight for
  non-patrons via the boot guard).

## Amendment (2026-07-15, shipped)

During verification two more hardcoded-midnight surfaces surfaced on the landing
(the same bug class as the stage): `.hero-demo` (the stage's landing twin) and
`.dz-icon` (the dropzone chip). Both now derive from tokens — the hero card
reuses the stage tokens with color-mix percentages that re-derive its original
softer alphas (midnight visually unchanged), the chip mixes
`--amethyst-deep`/`--rose`. Remaining low-alpha amethyst glow tints (play
shadow, seg active, knob halo, ::selection) are deliberately untouched — they
have shipped under three patron themes since 2026-07-04 without complaint.
Final tokyo `--ink-mute` contrast on `--bg-0`: 6.97:1. Verification gotcha for
the record: the app's own service worker serves the precached shell to local
CDP runs — same CACHE_VERSION means stale CSS even with the HTTP cache
disabled; test on a fresh browser profile after any mid-session CSS edit.
