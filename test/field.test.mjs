// Reading-field geometry — pure, no DOM.
//   node test/field.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { axisFraction, fitsAxis, windowScale, AXIS_DEFAULT, SCALE_FLOOR_PX } from "../js/field.js";

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
