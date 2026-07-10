// Stage gesture math (js/gestures.js pure core).
import test from "node:test";
import assert from "node:assert/strict";
import { axisLock, dragWpm, pinchIndex, swipeDir } from "../js/gestures.js";

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
