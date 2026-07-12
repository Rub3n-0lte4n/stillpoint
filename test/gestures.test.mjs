// Stage gesture math (js/gestures.js pure core).
import test from "node:test";
import assert from "node:assert/strict";
import { axisLock, dragWpm, pinchIndex, swipeDir, velocityFrom, sheetOffset, sheetRelease, rowRelease } from "../js/gestures.js";

test("axisLock: under the slop stays a tap (null)", () => {
  assert.equal(axisLock(4, 4), null);
  assert.equal(axisLock(-9, 3), null);
  assert.equal(axisLock(0, 0), null);
});

test("axisLock: dominant axis wins once past the slop", () => {
  assert.equal(axisLock(24, 6), "h");
  assert.equal(axisLock(-24, 6), "h");
  assert.equal(axisLock(6, 24), "v");
  assert.equal(axisLock(6, -24), "v");
});

test("dragWpm: up is faster, down is slower, in 25wpm steps", () => {
  assert.equal(dragWpm(400, -12), 425);    // 12px up = one step
  assert.equal(dragWpm(400, -60), 525);    // 60px up = five steps
  assert.equal(dragWpm(400, 24), 350);     // 24px down = two steps back
  assert.equal(dragWpm(400, 0), 400);
});

test("dragWpm clamps to the 150–800 range", () => {
  assert.equal(dragWpm(750, -600), 800);
  assert.equal(dragWpm(200, 600), 150);
});

test("pinchIndex: each ×1.25 spread is one size step, clamped", () => {
  assert.equal(pinchIndex(1, 1.0), 1);     // no spread change
  assert.equal(pinchIndex(1, 1.3), 2);     // out one step
  assert.equal(pinchIndex(1, 1.6), 3);     // out two steps
  assert.equal(pinchIndex(1, 0.8), 0);     // in one step
  assert.equal(pinchIndex(3, 4.0), 3);     // clamped at XL
  assert.equal(pinchIndex(0, 0.2), 0);     // clamped at S
});

test("swipeDir: needs distance and a clearly horizontal angle", () => {
  assert.equal(swipeDir(60, 5), 1);
  assert.equal(swipeDir(-60, 5), -1);
  assert.equal(swipeDir(30, 5), 0);        // too short
  assert.equal(swipeDir(60, 50), 0);       // too diagonal
});

/* ---- seamless surfaces: sheet + row physics ---- */

test("velocityFrom: slope over the trailing window, px/ms", () => {
  // 100px over 100ms = 1 px/ms
  assert.equal(velocityFrom([{t:0,v:0},{t:50,v:50},{t:100,v:100}]), 1);
  // a pause before release: only the trailing window counts, not the approach
  const paused = [{t:0,v:0},{t:40,v:200},{t:400,v:200},{t:480,v:200}];
  assert.equal(velocityFrom(paused), 0);
  // too little signal → 0
  assert.equal(velocityFrom([]), 0);
  assert.equal(velocityFrom([{t:0,v:10}]), 0);
});

test("sheetOffset: downward is 1:1, upward compresses toward the cap", () => {
  assert.equal(sheetOffset(0), 0);
  assert.equal(sheetOffset(120), 120);
  const up = sheetOffset(-72);
  assert.ok(up < 0 && up > -24, `resisted, got ${up}`);
  assert.ok(sheetOffset(-500) > -24.001, "never past the cap");
  assert.ok(sheetOffset(-30) > sheetOffset(-60), "monotonic resistance");
});

test("sheetRelease: fling or deep travel dismisses, anything else settles", () => {
  assert.equal(sheetRelease(40, 0.9, 500), "dismiss");     // fast downward fling
  assert.equal(sheetRelease(240, 0, 500), "dismiss");      // past 40% of the sheet
  assert.equal(sheetRelease(240, -0.4, 500), "settle");    // deep but moving back up
  assert.equal(sheetRelease(60, 0.1, 500), "settle");      // shallow and slow
  assert.equal(sheetRelease(-10, 0.9, 500), "settle");     // rubber-band zone
});

test("rowRelease: fling right closes, deep travel or hard fling deletes", () => {
  assert.equal(rowRelease(-70, 0.5, 360), "closed");       // rightward fling from open
  assert.equal(rowRelease(-220, 0, 360), "delete");        // past 55% of the row
  assert.equal(rowRelease(-120, -1.2, 360), "delete");     // hard fling past the action
  assert.equal(rowRelease(-30, -1.2, 360), "open");        // hard flick shy of the action reveals, never deletes
  assert.equal(rowRelease(-60, 0, 360), "open");           // past half the reveal
  assert.equal(rowRelease(-30, -0.4, 360), "open");        // slower fling with travel
  assert.equal(rowRelease(-20, 0, 360), "closed");         // not enough of anything
});
