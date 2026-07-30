# The phone reading field

2026-07-30. Approved in conversation before writing.

## Goal

On a phone, ordinary words do not fit the reading field. The user reported it as
"some words are too large to fit nicely on the screen". Measured, it is worse
than that: at size M on a 390px screen the word `development` paints from 76px
to 428px, so 38px of it is off the edge and the screen reads `developme`. At
sizes L and XL, `between` does not fit. Fix the geometry so the reader's chosen
size is honoured and no letter ever leaves the field, without touching the one
rule the product is built on: the focal word is instant and still.

Decisions locked with the user:

1. The reading axis moves left of centre on phones rather than the type shrinking
   to fit a centred axis.
2. In chunk modes the phrase yields before the type does. `S.chunk` becomes a
   maximum, not a count.
3. Delivery is a branch and a PR, one commit per concern.
4. Scope is the whole app, including discretionary polish, not only the reported
   bug.

## Why the field is short

ORP pins the *pivot letter* to the axis. Words are lopsided around their pivot,
which sits about 32% into the word, so a centred pivot leaves only ~40% of the
screen on the side the word actually grows into. Measured on a 390px phone with
canvas metrics at the real font: a word needs roughly **1.45x its own width** in
screen space. `development` has a 351px ink box that fits a 390px screen with
room to spare, yet needs 515px to sit pivot-centred.

Three defects follow from that one fact.

**The overflow guard measures the wrong number.** `placeRibbon` (js/app.js:183)
compares the word's box width against 90% of the stage, and `fitRibbon`
(js/app.js:244) shrinks against the same box width. Neither knows about the pivot
anchor, so a word whose box fits can still run off the right edge.

**The size ladder is fiction.** Because the shrink is driven by that wrong
number, M, L and XL all resolve to 55px for `development`. The 2026-07-30
`feat(mobile)` commit raised the ceiling from 12vw to 22vw to give S/M/L/XL their
range back, but the new ceiling sits above what the screen can physically show,
so the shrink flattens them again.

**The fade mask eats the focal word.** The phone `.ribbon-clip` mask
(styles.css:817) is fully opaque only between 34% and 66%, a 132px band. Any
focal word wider than that has its own ink dissolved. Even at size S, where
`development` does fit on screen, its `nt` fades out.

A fourth, in chunk modes: a 3-word phrase renders at 19.6px to 23.5px on a
phone, and the value changes per phrase (19.6, then 23.5, then 44.8), so the type
strobes as the prose changes.

Per-word `fitRibbon` also reintroduces two forced synchronous reflows per tick,
which the 2026-07-17 perf pass had removed.

## Current state (for reference)

`buildRibbon` renders a 19-word window. `measureRibbon` takes two passes (plain,
then every pivot bold) and caches per-word geometry in `G` at the base font size:
`left`, `w`, `preL`, `wPre`, `wPiv`, `wPivB`, plus `l0`, `stageC` and `avail`.
Each tick then runs `markChunk` on cached element refs and `placeRibbon`, which
is pure arithmetic plus one transform write. `fitRibbon` and `centerRibbon`
survive only as the overflow fallback and are the sole measuring code left in the
hot path. On phones `.stage-shell` is `position:fixed;inset:0`, so the field is
the whole viewport and `--axis` puts the focal line at 44% of the height.

## 1. The reading axis becomes a token

New `--axis-x`, the horizontal twin of the existing `--axis`. Default 50%. Where
the field is narrow it resolves to 33% in ORP and back to 50% in chunk modes,
because a phrase is symmetric around its own middle and wastes nothing.

"Narrow" means the existing `max-width:680px` block, not "the phone layout". A
phone held sideways is 844px wide, takes the same full-bleed field through the
height query, and has room to spare, so it keeps the axis at 50%. Only the width
breakpoint sets the token.

**Settled at 33%.** It was derived from the pivot sitting about 32% into the
word, then confirmed by measurement. Sweeping the fraction on real prose at 390px
and reading back the rendered type size gives a clear peak, falling off on both
sides:

| axis | S | M | L | XL |
|---|---|---|---|---|
| 28% | 44 | 46.8 | 47.0 | 47.0 |
| 30% | 44 | 50.1 | 50.3 | 50.3 |
| **33%** | **44** | **51.8** | **52.0** | **52.1** |
| 36% | 44 | 49.4 | 49.7 | 49.7 |
| 40% | 44 | 46.3 | 46.6 | 46.6 |
| 50% | 38.3 | 38.6 | 38.8 | 38.8 |

The last row is the old centred behaviour. Moving the axis to 33% buys about 35%
more type on the same screen, which is the whole point: the width was always
there, it was being spent on the empty side of the word.

Everything currently hard-coding the stage centre reads the token instead:

- `.stage::before`, the warm halo (styles.css:467)
- `.stage .guide`, both focus ticks (styles.css:493)
- `.stage .baseline`, which currently spans a fixed 24% inset on phones and must
  instead centre on the axis
- the countdown digit, which is flex-centred by the stage today. The prototype
  caught it sitting at 50% while the guides had moved, which read as broken, so
  it has to ride the axis.

`measureRibbon`'s `stageC` (js/app.js:157) becomes the axis point:
`sr.left + sr.width * axisFrac`. `axisFrac` comes from
`getComputedStyle(stage).getPropertyValue("--axis-x")`, parsed as a percentage,
falling back to 0.5 on anything unexpected. The token is authored as a plain
percentage so it always resolves; no `calc()`.

Mode needs to reach CSS, so `setMode` sets `stage.dataset.mode = m` and the
phone block switches the token on `.stage[data-mode="orp"]`. `setMode` already
re-renders when the ribbon is showing, and `invalidateRibbon` must now also run
there because the axis moved under the cached `stageC`.

Rejected: a content-adaptive axis that slides per word. The axis is where the eye
rests. A resting point that moves is not a resting point.

## 2. An honest fit, measured on ink

New pure function, unit-tested:

```
fitsAxis({ leftHalf, rightHalf }, axisFrac, field) ->
  leftHalf <= axisFrac * field && rightHalf <= (1 - axisFrac) * field
```

For ORP the halves are measured from the pivot letter's centre with the pivot
bold, which is the state the word is actually painted in. For chunk modes the
block is centred on the axis, so both halves are `width / 2`.

Measured on ink, not on the padded box. The prototype had `development` report
-4.9 to 390.7 while its letters actually sat at 52 to 372: the `.rw` padding of
`.3em` a side is whitespace and may hang off the field, but no letter may. This
needs the post-span width added to the geometry cache, which the second
measurement pass can take for free.

`field` is the stage's client width less a safe inset, starting at 8px a side and
tuned with the axis fraction, and respects the existing `env(safe-area-inset-*)`
padding on notched phones in landscape.

## 3. One size per window, not per word

`fitRibbon` and `centerRibbon` leave the hot path and are deleted.

`measureRibbon` gains `G.scale`: the largest scale not exceeding 1 at which every
**single word** in the window satisfies `fitsAxis`. It is applied once as
`rb.style.fontSize`. All cached numbers were measured at the base size, so
`placeRibbon` multiplies by `G.scale`, which is one extra multiply and no
measurement.

Single words, never phrases, even in chunk modes. A single word is the
irreducible unit: it cannot be split, so it is the only thing allowed to force
the type down. Phrases are handled by dropping words instead, per §5. This is the
same ordering rule seen from the other end.

This removes the per-word size strobing, un-collapses M/L/XL, and takes the last
two forced reflows out of the hot path. With the axis fix, S and M stop scaling
at all for ordinary English prose.

A floor stops one pathological token, a long URL for instance, from shrinking a
whole window into unreadability. The floor starts at 22px, which is still larger
than phone body text. Below it the scale stops and that single token is allowed to
overhang, where the outer dissolve softens it. This is the graceful last resort
for genuinely unfittable tokens, and it is the only case where ink may leave the
field.

The scale change is instant, like the word swaps. It lands at a window rebuild,
which is roughly every 15 words. A transition on the type size would be a
crossfade-mush at speed, the same reason `.rw` opacity has never had one.

## 4. The fade stops eating the word

The phone mask pulls back to a short dissolve in the outer few percent, and
becomes asymmetric to match the axis: less clear room on the left, more on the
right, where the words grow.

The mask's only remaining job is to stop a hard cut at the screen edge. Neighbour
context dimming is already opacity's job, .14 while playing and .34 while paused.
The same change fixes the landscape neighbours, currently sliced mid-letter.

Invariant: no focal ink ever sits under a mask stop below full opacity.

## 5. Chunk modes: the phrase yields first

`S.chunk` becomes a maximum. Each beat takes as many words as fit at the reader's
chosen size, minimum one. Type size becomes the invariant the reader controls,
and the word count adapts to the screen.

New pure function on the cached widths, so still no measuring:

```
chunkFit(G, start, maxChunk, axisFrac, field) -> count in 1..maxChunk
```

`S.chunkNow` carries the result of one beat. It is computed in `render` before
`markChunk`, since the marks decide the painted width, and then consumed by
`step` for the token slice, the delay, the index advance, `isUnitEnd(S.index +
S.chunkNow)` and the `blocksToHandle` window, and by `markChunk` and
`placeRibbon`. `S.chunk` stays the stored preference and keeps its name in
`fp_prefs` and in backups, so nothing migrates.

Ordering rule, stated once: the phrase yields before the type does. Words drop
out first, down to one, and only a single word that still does not fit reaches
the §3 scale.

Copy follows the semantics. The chunk control and the Guide say "up to N words".
The About modal's Hybrid line already says "short phrases", which stays true.

Risk noted: on a phone the beat length now varies with the prose. Delay is
already per-token and already varies with sentence factors and clause pauses, so
the rhythm is not newly irregular, but it is more visibly so.

## 6. Whole-app passes

Impeccable and motion audits across the phone reader, the landing and desktop,
fixing genuine defects, plus the discretionary polish approved in conversation:

- The aids segment is five chips with four filled amethyst, which reads as a wall
  of purple, and `Chapter rest` is orphaned on its own full-width row.
- Landscape neighbours are cut mid-letter, covered by §4.
- The landing's `hero-demo` mini stage has its own centred guide at
  styles.css:219 and 223. It previews the reader, so on phones it should mirror
  the new axis or it will misrepresent what the reader does.

Motion doctrine holds. Word swaps stay instant, the window scale step is
instant. The axis moving on a mode change is low frequency and happens while
paused, since the settings sheet opens paused, so that one gets a transition.

## 7. Verification

Unit tests for the pure functions: `fitsAxis`, the window scale, `chunkFit`,
including the floor case and the minimum-one-word case.

The e2e suite gains phone-viewport assertions, swept across S/M/L/XL by
ORP/RSVP/Hybrid at 320, 360, 390, 430 and landscape:

- no focal ink outside the field, except a single token past the §3 floor
- no focal ink under a mask stop below full opacity
- the pivot sits on the axis, not the centre. The existing pivot-lock assertion
  becomes a pivot-on-axis assertion and keeps its sub-pixel tolerance.
- the size ladder is monotonic: L renders larger than M, which renders larger
  than S, on the same word

Screenshots at each breakpoint for the visual pass.

## What shipped

Four things were decided during implementation, three of them because building
it taught us something the design could not have known.

**Measure at the painted size, do not scale the measurements.** The design said
to cache metrics at the base size and multiply by `G.scale` in placement. That
drifted the pivot up to 7.8px off the axis, and let 2px of chunk-mode ink past
the edge, because glyph advances are not linear in font size (hinting and
rounding) and `letter-spacing` is a fixed px that does not scale at all.
`measureRibbon` now shrinks first and re-reads, so every cached number describes
the type actually on screen and placement needs no multiply. Costs two extra
measurement passes per window rebuild, only when a shrink is needed. The hot path
still never measures.

**The window scale uses the halves of the mode it is in.** Using ORP's
pivot-relative halves in a chunk mode charges a word for an asymmetry it never
has, because chunk modes centre it as a block. That alone cost chunk modes about
a third of their type size, so `measureRibbon` picks `halvesFor` or
`blockHalves` by mode.

**The landing's `hero-demo` stays centred.** The design flagged it as
misrepresenting the reader. On inspection it is morphologically a boxed card, the
same as the desktop stage, which also keeps a centred axis. The axis shift
answers a narrow *full-bleed* field where a centred pivot wastes a third of the
screen. Inside a 358px inset card showing short demo words nothing overflows
(measured: zero), so shifting it would only make the landing lopsided.

**The aids segment stays as it is.** Five chips with four filled amethyst is
heavy, but the fill is the established active language and the 2026-07-18 pass
already added the state dots that distinguish this multi-select from the radio
segments beside it. Changing it now would be churn against a recorded decision.

Two consequences worth naming, neither a defect:

- **Above size M a phone is bounded by the screen, not by the setting.** On a
  390px screen M, L and XL all resolve to about 56px for a window containing a
  13-character word, because no strategy can render one larger without either
  clipping it or strobing the type. S to M stays meaningful (44 to 56). The
  alternative is per-word scaling, which is the strobing this pass removed.
- **A chunk mode reduced to one word stays unaccented.** RSVP is unaccented by
  design. Giving a lone word its amber anchor would make the accent flicker on
  and off with word length, trading size strobing for colour strobing.

## Deliberately not doing

- Wrapping a phrase onto two lines. It would rewrite the single-line geometry
  cache and the neighbour model for the app's hot path, at real regression risk,
  to serve the least-used modes.
- Condensing glyphs with `scaleX` instead of scaling the size. Atkinson
  Hyperlegible has no condensed axis, so it would be distortion, and distortion
  is more visible than scale.
- Touching the desktop boxed stage geometry. It has a 1360px field and no fit
  problem. It inherits the corrected predicate and the token defaults only.
- Migrating saved positions. Nothing about tokenization changes, so positions,
  marks and the chapter ledger are all untouched.
