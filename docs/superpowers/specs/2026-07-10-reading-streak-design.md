# Reading Streak — Design

**Date:** 2026-07-10
**Status:** Approved
**Feature:** Apple Books-style daily reading goal + streak, local-first, no accounts.

## Summary

A configurable daily reading goal (minutes of active reading per day) and a streak
counting consecutive days the goal was met. Progress and streak surface on the
landing page and the session-complete card. Celebration happens at the next pause,
never mid-stream. All data lives in localStorage and rides the existing backup
export/import.

## Decisions (locked with user)

1. **Rule:** configurable daily goal in minutes (default 5, range 5–60, step 5).
   A day counts when accumulated *active* reading (pauses excluded) reaches the goal.
2. **Placement:** landing strip near the recent library + a line on the finish card.
   Nothing in the reader itself.
3. **Celebration:** at the next pause — a quiet gold toast. No mid-stream motion.
4. **Data model:** daily ledger (approach A) — per-day seconds map, streak computed,
   never stored (except a `best` high-water mark, see below).

## Data model

New localStorage key `fp_streak_v1`:

```json
{ "goalMin": 5, "best": 12, "days": { "2026-07-10": 312, "2026-07-09": 640 } }
```

- Day keys are **local** dates (`YYYY-MM-DD` from local time). Day boundary = local midnight.
- Values are seconds of active reading credited to that day.
- Ledger prunes to the newest 400 day-entries on save.
- `best` is a stored high-water mark, updated on save. It is stored (not computed)
  only because pruning would eventually erase an all-time best. Everything else —
  current streak, today's seconds, goal-met — is computed from `days` on demand.
- **Streak rule:** count consecutive goal-met days ending at today if today is met,
  otherwise ending at yesterday. A streak is *alive* (shown, not lost) all day until
  a local midnight passes without the goal being met.

## Module: `js/streak.js`

ES module, no DOM, pure core with injectable date for tests.

- `todayKey(d = new Date())` → `"YYYY-MM-DD"` local.
- `computeStreak(days, goalMin, todayStr)` → `{ current, metToday, todaySec }` — pure.
- `load()` / `save(state)` — localStorage + prune + `best` high-water update.
- `addSeconds(sec, d = new Date())` → `{ crossed, current }` — credits seconds to the
  local date of `d`; `crossed` is true only when this call moves today's total from
  below goal to at-or-above goal (first crossing of the day).
- `setGoal(min)` / `getState()` → `{ goalMin, best, current, metToday, todaySec }`.
- `mergeDays(importedDays, importedBest, importedGoalMin)` — per-day `Math.max`,
  `best = max(local, imported)`, `goalMin` keeps local unless local state is absent.

A segment that crosses midnight credits the day it settles. Rare and acceptable;
no segment splitting.

## Accrual points (app.js)

One shared helper replaces the two inline settle sites:

```js
function settleReading(){
  if(!S.playStart) return;
  const ms = Date.now() - S.playStart;
  S.readMs += ms; S.playStart = null;
  const { crossed, current } = Streak.addSeconds(ms/1000);
  if(crossed && !document.hidden) toast(streakToastCopy(current));
}
```

Call sites:

- `pause()` (app.js ~241) — the single choke point: `finish()` calls `pause()`,
  and the `visibilitychange` auto-pause (~1197) routes here too.
- `presentBlock()` (~328) — settles the clock directly when a block card raises;
  replace its inline settle with `settleReading()`.
- `pagehide` (~1349) — currently only saves prefs; add `settleReading()` so a
  killed tab mid-play still credits the segment.

If the crossing settles while the document is hidden, skip the toast — the landing
strip and finish card still reflect the new state.

The demo passage counts. Reading is reading.

## Celebration copy (no AI tells; see .agents/product-marketing.md)

- Crossing, streak ≥ 2: `Goal met. 12 days in a row.`
- Crossing, first day: `Goal met. Your streak starts today.`
- Toast is the standard gold-accent toast, aria-live, 5s, non-focus-stealing.

## Landing strip (`#streakStrip`)

Placed after `.recent`, before `#backup`. Hidden until there is any ledger data
or the library is non-empty (same gating spirit as `#backup`).

Contents, one quiet row in Midnight Couture:

- Small SVG progress ring (~28px), amber arc: today's minutes toward goal.
  `role="img"` with aria-label like `3 of 5 minutes read today`.
- Streak count in gold Archivo display (`var(--font-display)`, stretch 118%) with
  a muted "day streak" label; `best N` muted beside it when best > current.
- Inline goal stepper: real `−` / `+` buttons (5–60 min, step 5) around
  `5 min a day`. aria-labels, focus-visible rings, 24px+ touch targets.
- Section eyebrow matches existing uppercase letterspaced labels: `READING STREAK`.

Strip re-renders on landing show (same hook that calls `renderLibrary()`).

## Finish card line (`.done-streak`)

One line under `.done-stats`, fine-print register like `.done-support`:

- Goal met today: `Day 12 of your reading streak.`
- Not met, streak alive: `6 more minutes today keeps the streak.`
- Not met, no streak: `6 more minutes today starts a streak.`

Minutes remaining rounds up. No fourth stat tile.

## Backup export/import

- `buildBackup()` adds optional `streak` field = raw `fp_streak_v1` value.
- Import: absent field → no-op (old backups import unchanged). Present →
  `mergeDays` per-day max, `best = max`, local `goalMin` wins unless local absent.

## Service worker

- Add `js/streak.js` to `SHELL`.
- `CACHE_VERSION` → `stillpoint-v29`.

## Tests: `test/streak.test.mjs`

Pure-core coverage, joins the 4 existing files in `npm test`:

1. `computeStreak`: empty ledger → 0; run with gap counts only the tail;
   today unmet + yesterday met → streak alive at yesterday's count;
   today unmet + yesterday unmet → 0.
2. `addSeconds`: crossing detection fires exactly once per day; sub-goal
   accumulation never fires; date attribution uses local date of the call.
3. `mergeDays`: per-day max; best max; local goal preserved.
4. Prune: >400 entries keeps the newest 400.
5. Day boundary: 23:59 vs 00:01 credit different keys (injected dates).

## Out of scope

- Streak freezes / forgiveness days.
- Calendar / history view (ledger supports it later).
- Notifications or reminders.
- Reader-dock UI.
