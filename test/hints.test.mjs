// Progressive-hint gating (js/hints.js pure core).
import test from "node:test";
import assert from "node:assert/strict";
import { nextHint, HINTS } from "../js/hints.js";

const fresh = (over = {}) => ({ shown:{}, used:{}, dayCount:1, lastDay:"2026-07-12", ...over });
const ctx = (over = {}) => ({ touch:true, where:"reader", today:"2026-07-12", libSize:0, ...over });

test("day one teaches the zones, and only the zones", () => {
  assert.equal(nextHint(fresh(), ctx()).id, "zones");
  assert.equal(nextHint(fresh(), ctx({ touch:false })).id, "zones");   // works for a mouse too
});

test("one hint per day, across every surface", () => {
  const st = fresh({ lastShownDay:"2026-07-12" });
  assert.equal(nextHint(st, ctx()), null);
  assert.equal(nextHint(st, ctx({ where:"landing", libSize:5 })), null);
  // a new day reopens the tap
  assert.equal(nextHint(st, ctx({ today:"2026-07-13" })).id, "zones");
});

test("touch-only gestures are never hinted at a mouse", () => {
  const st = fresh({ shown:{ zones:1 }, dayCount:9 });
  assert.equal(nextHint(st, ctx({ touch:false })), null);
  assert.equal(nextHint(st, ctx({ touch:true })).id, "speeddrag");
});

test("doing the mechanic graduates it — used is never shown", () => {
  const st = fresh({ shown:{ zones:1 }, used:{ speeddrag:1, holdmark:1 }, dayCount:9 });
  assert.equal(nextHint(st, ctx()).id, "pinch");
});

test("the drip respects days of use, not visits", () => {
  const st = fresh({ shown:{ zones:1 }, dayCount:1 });
  assert.equal(nextHint(st, ctx()), null);                    // speeddrag waits for day 2
  assert.equal(nextHint(fresh({ shown:{ zones:1 }, dayCount:2 }), ctx()).id, "speeddrag");
});

test("the library hint waits for a library worth managing", () => {
  const st = fresh({ dayCount:5 });
  assert.equal(nextHint(st, ctx({ where:"landing", libSize:1 })), null);
  assert.equal(nextHint(st, ctx({ where:"landing", libSize:2 })).id, "rowswipe");
});

test("an exhausted queue stays silent forever", () => {
  const all = Object.fromEntries(HINTS.map(h => [h.id, 1]));
  assert.equal(nextHint(fresh({ shown:all, dayCount:99 }), ctx()), null);
});
