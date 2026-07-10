// Reading streak — pure core + storage API (js/streak.js).
// Node has no localStorage; a tiny shim stands in before the module loads.
import test from "node:test";
import assert from "node:assert/strict";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { todayKey, computeStreak, mergeDays, pruneDays, Streak } =
  await import("../js/streak.js");

const D = (s) => new Date(s);   // local-time construction from "YYYY-MM-DDTHH:mm"
const GOAL = 5;                 // default goal, minutes

test("todayKey uses local dates and zero-pads", () => {
  assert.equal(todayKey(D("2026-07-11T09:00")), "2026-07-11");
  assert.equal(todayKey(D("2026-01-02T00:01")), "2026-01-02");
});

test("computeStreak: empty ledger → 0", () => {
  assert.deepEqual(computeStreak({}, GOAL, "2026-07-11"),
    { current: 0, metToday: false, todaySec: 0 });
});

test("computeStreak: only the tail run past a gap counts", () => {
  const days = { "2026-07-07": 400, "2026-07-09": 400, "2026-07-10": 400, "2026-07-11": 400 };
  assert.equal(computeStreak(days, GOAL, "2026-07-11").current, 3);
});

test("computeStreak: streak stays alive today before the goal is met", () => {
  const days = { "2026-07-09": 300, "2026-07-10": 300, "2026-07-11": 120 };
  const r = computeStreak(days, GOAL, "2026-07-11");
  assert.equal(r.current, 2);          // alive, anchored at yesterday
  assert.equal(r.metToday, false);
  assert.equal(r.todaySec, 120);
});

test("computeStreak: yesterday unmet and today unmet → 0", () => {
  const days = { "2026-07-09": 300, "2026-07-10": 100 };
  assert.equal(computeStreak(days, GOAL, "2026-07-11").current, 0);
});

test("computeStreak: crosses a month boundary", () => {
  const days = { "2026-06-29": 300, "2026-06-30": 300, "2026-07-01": 300 };
  assert.equal(computeStreak(days, GOAL, "2026-07-01").current, 3);
});

test("mergeDays: per-day max, union of keys", () => {
  const merged = mergeDays({ a: 100, b: 50 }, { b: 200, c: 30 });
  assert.deepEqual(merged, { a: 100, b: 200, c: 30 });
});

test("pruneDays keeps the newest N entries", () => {
  const days = {};
  for (let i = 1; i <= 410; i++) days["2025-" + String(100 + i)] = i;  // sortable fake keys
  const pruned = pruneDays(days, 400);
  assert.equal(Object.keys(pruned).length, 400);
  assert.ok(!("2025-101" in pruned) && "2025-510" in pruned);
});

test("addSeconds: crossing fires exactly once per day", () => {
  store.clear();
  const noon = D("2026-07-11T12:00");
  assert.equal(Streak.addSeconds(100, noon).crossed, false);   // 100s < 300s goal
  const cross = Streak.addSeconds(250, noon);                  // 350s ≥ 300s
  assert.equal(cross.crossed, true);
  assert.equal(cross.current, 1);
  assert.equal(Streak.addSeconds(500, noon).crossed, false);   // already met — no refire
});

test("addSeconds: 23:59 and 00:01 credit different local days", () => {
  store.clear();
  Streak.addSeconds(400, D("2026-07-10T23:59"));
  Streak.addSeconds(400, D("2026-07-11T00:01"));
  const raw = Streak.raw();
  assert.equal(raw.days["2026-07-10"], 400);
  assert.equal(raw.days["2026-07-11"], 400);
  assert.equal(Streak.getState(D("2026-07-11T00:02")).current, 2);
});

test("best is a high-water mark that survives a broken streak", () => {
  store.clear();
  Streak.addSeconds(400, D("2026-07-08T12:00"));
  Streak.addSeconds(400, D("2026-07-09T12:00"));
  Streak.addSeconds(400, D("2026-07-11T12:00"));   // gap on the 10th broke the run
  const st = Streak.getState(D("2026-07-11T13:00"));
  assert.equal(st.current, 1);
  assert.equal(st.best, 2);
});

test("setGoal clamps and snaps to the step", () => {
  store.clear();
  assert.equal(Streak.setGoal(7), 5);              // snaps to the 5-minute step
  assert.equal(Streak.setGoal(999), 60);
  assert.equal(Streak.setGoal(-3), 5);
});

test("importMerge: per-day max, best max, local goal preserved", () => {
  store.clear();
  Streak.setGoal(10);
  Streak.addSeconds(700, D("2026-07-11T12:00"));
  Streak.importMerge({ goalMin: 5, best: 9, days: { "2026-07-11": 100, "2026-07-01": 800 } });
  const raw = Streak.raw();
  assert.equal(raw.goalMin, 10);                    // local goal wins
  assert.equal(raw.best, 9);                        // imported best kept
  assert.equal(raw.days["2026-07-11"], 700);        // per-day max
  assert.equal(raw.days["2026-07-01"], 800);
});
