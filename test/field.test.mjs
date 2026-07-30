// Reading-field geometry — pure, no DOM.
//   node test/field.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { axisFraction, fitsAxis, windowScale, halvesFor, blockHalves, chunkFit,
         AXIS_DEFAULT, SCALE_FLOOR_PX } from "../js/field.js";

test("axisFraction parses a percentage token", () => {
  assert.equal(axisFraction("33%"), 0.33);
  assert.equal(axisFraction(" 50% "), 0.5);
});

test("axisFraction parses a bare fraction", () => {
  assert.equal(axisFraction("0.33"), 0.33);
});

test("axisFraction falls back on junk, and on an empty property", () => {
  assert.equal(axisFraction(""), AXIS_DEFAULT);
  assert.equal(axisFraction("calc(50% - 3px)"), AXIS_DEFAULT);
  assert.equal(axisFraction(undefined), AXIS_DEFAULT);
  assert.equal(axisFraction("nonsense", 0.4), 0.4);
});

test("axisFraction clamps to a sane range", () => {
  assert.equal(axisFraction("0%"), 0.1);
  assert.equal(axisFraction("140%"), 0.9);
});

test("fitsAxis is pivot-relative, not width-relative", () => {
  // a 300px-wide word on a 390px field, pivot one third in: fits centred? no.
  const halves = { left: 100, right: 200 };
  assert.equal(fitsAxis(halves, 0.5, 390), false);   // needs 400px centred
  assert.equal(fitsAxis(halves, 0.33, 390), true);   // 100<=128.7 and 200<=261.3
});

test("fitsAxis fails when either side overruns", () => {
  assert.equal(fitsAxis({ left: 200, right: 10 }, 0.33, 390), false);  // left side blows out
  assert.equal(fitsAxis({ left: 10, right: 300 }, 0.33, 390), false);  // right side blows out
});

test("windowScale returns 1 when everything already fits", () => {
  const list = [{ left: 40, right: 80 }, { left: 20, right: 30 }];
  assert.equal(windowScale(list, 0.33, 390, 62), 1);
});

test("windowScale shrinks to the widest word in the window", () => {
  const list = [{ left: 20, right: 30 }, { left: 100, right: 400 }];
  const s = windowScale(list, 0.33, 390, 62);
  assert.ok(s < 1, `expected a shrink, got ${s}`);
  // the binding side is the right one: 400*s <= 0.67*390
  assert.ok(Math.abs(400 * s - 0.67 * 390) < 0.5, `scale ${s} should bind on the right half`);
});

test("windowScale never goes below the floor", () => {
  const list = [{ left: 10, right: 4000 }];   // a pathological token
  const s = windowScale(list, 0.33, 390, 62);
  assert.equal(s, SCALE_FLOOR_PX / 62);
});

test("windowScale is 1 for an empty window", () => {
  assert.equal(windowScale([], 0.33, 390, 62), 1);
});

// Three words of 100px ink each, laid out left to right with no gaps, pivot
// 30px into each word and 10px wide (12px when bold).
const M = {
  inkL:  [  0, 100, 200],
  inkR:  [100, 200, 300],
  preL:  [  0, 100, 200],
  wPre:  [ 30,  30,  30],
  wPiv:  [ 10,  10,  10],
  wPivB: [ 12,  12,  12],
};

test("halvesFor measures from the bold pivot centre, not the box centre", () => {
  // word 0: pivot centre at 30 + 12/2 = 36. ink runs 0..100, widened by the bold
  // pivot to 0..102. so left half 36, right half 66.
  assert.deepEqual(halvesFor(M, 0), { left: 36, right: 66 });
});

test("halvesFor is relative to the word, wherever it sits in the window", () => {
  // word 2 sits at 200 but its halves are identical to word 0's
  assert.deepEqual(halvesFor(M, 2), { left: 36, right: 66 });
});

test("blockHalves centres one word as a symmetric block", () => {
  assert.deepEqual(blockHalves(M, 0, 1, false), { left: 50, right: 50 });
});

test("blockHalves splits a phrase evenly about its optical middle", () => {
  // words 0..1 span ink 0..200, so 100 a side
  assert.deepEqual(blockHalves(M, 0, 2, false), { left: 100, right: 100 });
});

test("blockHalves widens for hybrid's bold anchors", () => {
  // each of the 2 words gains 2px from bolding its pivot: 204 total, 102 a side
  assert.deepEqual(blockHalves(M, 0, 2, true), { left: 102, right: 102 });
});

test("chunkFit takes every word when they all fit", () => {
  assert.equal(chunkFit(M, 0, 3, 0.5, 400, false), 3);
});

test("chunkFit drops words rather than shrinking the type", () => {
  // a 240px field centred holds 120px a side: 2 words need 100 a side, 3 need 150
  assert.equal(chunkFit(M, 0, 3, 0.5, 240, false), 2);
});

test("chunkFit never returns zero, even when one word cannot fit", () => {
  assert.equal(chunkFit(M, 0, 3, 0.5, 40, false), 1);
});

test("chunkFit respects the maximum it is given", () => {
  assert.equal(chunkFit(M, 0, 1, 0.5, 4000, false), 1);
});

test("chunkFit clamps at the end of the window", () => {
  assert.equal(chunkFit(M, 2, 4, 0.5, 4000, false), 1);
});
