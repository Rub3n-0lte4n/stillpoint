# Streak, Apple-grade

2026-07-23. Approved in conversation before writing.

## Goal

Make the reading streak feel as seamless as Apple Books' Reading Goals without
breaking any Stillpoint rule: no server, no accounts, nothing over the word
stream. The ledger and its semantics do not change. Every improvement is
presentation, timing, or copy.

Decisions locked with the user:

1. In-reader presence is a pause-only whisper. The stream stays streak-free.
2. The goal-crossing celebration is a gold toast plus one success haptic,
   still delivered at the next pause.
3. The landing strip gains a quiet-dots week row, not bars, not a chart.

## Current state (for reference)

`js/streak.js` keeps `fp_streak_v1 = { goalMin, best, days: {local-date: seconds} }`.
`settleReading()` in app.js is the single accrual choke point and detects the
below-to-above goal crossing. `renderStreak()` paints the landing strip: ring
(today's progress), count, best, goal stepper. The finish card carries a
per-day line. The crossing fires a plain text toast.

## 1. Week row

A second line in `#streakStrip` under the existing ring row.

- Seven columns, the last seven local days, oldest left, today rightmost.
- Above each column a single day initial (S M T W T F S picked by local
  weekday), 10px, ink-mute.
- Marker states:
  - goal met: filled gold dot
  - read but under goal: hollow dot (hairline ring, no fill)
  - no reading: faint ink-mute dot at low opacity
  - today: gold outline dot regardless of state (the big ring already shows
    today's progress; the outline just anchors the row to it)
- Data: new pure `Streak.week(d = new Date())` returning
  `[{ key, sec, met }]` for the seven local days ending on `d`, computed the
  same way `computeStreak` walks keys. Unit-tested in `test/streak.test.mjs`.
- Accessibility: the row is one element with
  `aria-label="Last 7 days: goal met on N"` and `aria-hidden` dots inside.
- The row renders whenever the strip renders. No gating beyond the strip's own.

## 2. Ring arrival animation

When the strip becomes visible after being away (first landing paint, or
returning from the reader), the ring fills from empty to today's value using
the existing `stroke-dashoffset` transition (`--t-slow`).

- Mechanism: set offset to full circumference, force one reflow, set target.
- A module-level flag arms the animation in `showLibrary()` and on boot, and
  disarms after one play, so goal-stepper clicks and accrual re-renders never
  re-trigger it.
- Reduced motion: covered by the existing global block (transitions flatten
  to 0.001ms). No extra handling needed.

## 3. The crossing moment

Timing unchanged: `settleReading()` at a pause, once per day by construction
(`crossed` is true only on the below-to-above transition).

- The toast renders in the gold treatment hint toasts use (gold ✦ prefix and
  gold border) WITHOUT the Guide action. Implementation: `toast(msg, {gold:true})`
  which applies the `.hint`-style class but no action button.
- One `Haptics.trigger("success")` alongside it (respects the existing
  haptics-sparingly rule: at most once per day).
- `S.justCrossed = true` at the crossing. The next `renderStreak()` that runs
  with the strip visible consumes the flag and plays a one-shot scale pulse on
  the ring (CSS keyframe, about 600ms, gentle, max scale 1.06). Covered by
  reduced motion via the global block plus `animation: none` there for safety.
- Copy unchanged.

## 4. Pause whisper

`#goalWhisper`, a one-line element inside the dock above the scrub row.

- Text: `✦ N min to today's goal` where N is `ceil((goalSec - todaySec)/60)`.
- 11px, ink-mute, gold ✦, centred, no border, no background. It is a line of
  fine print, not a component.
- Visible only when ALL of: the reader is paused, today's goal is not met,
  and `todaySec > 0`. Hidden on play. After the goal is met it never appears
  again that day. It does not exist during streaming, so zen and the stream
  are untouched.
- Refresh points: `pause()` and `settleReading()` (both already run at every
  stop), plus `openReader()` so a stale line never survives a book switch.
- Accessibility: plain text in DOM order, no aria-live (it must not interrupt
  a screen reader mid-session; it is discoverable at the pause).

## 5. Warm zero state

When `current === 0`, the big number and "day streak" label do not render.
In their place, one line in the same slot:

- `todaySec > 0`: "N min to day one"
- `todaySec === 0`: "Read G min to start a streak" (G = goal)

When `current >= 1` the strip renders exactly as today. The goal stepper and
best marker are unaffected.

## Not doing

- No notifications, no reminders (no server, and the brand does not nag).
- No streak freezes or grace tokens. A missed day quietly resets; `best`
  already preserves the achievement.
- No count-up number animation. One animated element (the ring) is the budget.
- No week row in the reader. The reader gets the whisper and nothing else.

## Testing

- Unit: `Streak.week()` shapes (7 entries, local dates, met flags, empty
  ledger, partial days), zero-state copy helper if extracted pure.
- CDP: week row renders with expected marker classes on a seeded ledger;
  whisper appears at pause before goal and is absent after goal met; crossing
  toast carries the gold class and no action button; ring plays the arrival
  animation once and not on goal-step clicks; ring pulse class appears after
  a crossing. Reduced-motion spot check via emulated media.
- Suite: existing 19-check e2e must stay green; `npm run sw:check` clean after
  the bump.

## Files

- `js/streak.js`: add `week()` (pure) only. No storage change.
- `js/app.js`: whisper element wiring, `justCrossed`, ring arm/disarm flags,
  zero-state strip branch, gold toast option, haptic.
- `index.html`: week row + whisper markup.
- `styles.css`: week row, whisper, ring pulse keyframe.
- `test/streak.test.mjs`: week() cases.
- `sw.js`: cache bump via `npm run sw:bump`.
