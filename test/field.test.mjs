// Reading-field geometry — pure, no DOM.
//   node test/field.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { axisFraction, fitsAxis, windowScale, halvesFor, blockHalves, chunkFit,
         axisFor, capsFor, sizingSample,
         AXIS_DEFAULT, SCALE_FLOOR_PX, OUTLIER_CHARS } from "../js/field.js";

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
  assert.equal(fitsAxis(halves, capsFor(0.5, 390)), false);   // needs 400px centred
  assert.equal(fitsAxis(halves, capsFor(0.33, 390)), true);   // 100<=128.7 and 200<=261.3
});

test("fitsAxis fails when either side overruns", () => {
  assert.equal(fitsAxis({ left: 200, right: 10 }, capsFor(0.33, 390)), false);  // left side blows out
  assert.equal(fitsAxis({ left: 10, right: 300 }, capsFor(0.33, 390)), false);  // right side blows out
});

test("windowScale returns 1 when everything already fits", () => {
  const list = [{ left: 40, right: 80 }, { left: 20, right: 30 }];
  assert.equal(windowScale(list, capsFor(0.33, 390), 62), 1);
});

test("windowScale shrinks to the widest word in the window", () => {
  const list = [{ left: 20, right: 30 }, { left: 100, right: 400 }];
  const s = windowScale(list, capsFor(0.33, 390), 62);
  assert.ok(s < 1, `expected a shrink, got ${s}`);
  // the binding side is the right one: the 400px half shrinks to exactly fill it
  assert.ok(Math.abs(400 * s - capsFor(0.33, 390).right) < 0.5,
    `scale ${s} should bind on the right half`);
});

test("windowScale never goes below the floor", () => {
  const list = [{ left: 10, right: 4000 }];   // a pathological token
  const s = windowScale(list, capsFor(0.33, 390), 62);
  assert.equal(s, SCALE_FLOOR_PX / 62);
});

test("windowScale is 1 for an empty window", () => {
  assert.equal(windowScale([], capsFor(0.33, 390), 62), 1);
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
  assert.equal(chunkFit(M, 0, 3, capsFor(0.5, 400), false), 3);
});

test("chunkFit drops words rather than shrinking the type", () => {
  // a 240px field centred holds 120px a side: 2 words need 100 a side, 3 need 150
  assert.equal(chunkFit(M, 0, 3, capsFor(0.5, 240), false), 2);
});

test("chunkFit never returns zero, even when one word cannot fit", () => {
  assert.equal(chunkFit(M, 0, 3, capsFor(0.5, 40), false), 1);
});

test("chunkFit respects the maximum it is given", () => {
  assert.equal(chunkFit(M, 0, 1, capsFor(0.5, 4000), false), 1);
});

test("chunkFit clamps at the end of the window", () => {
  assert.equal(chunkFit(M, 2, 4, capsFor(0.5, 4000), false), 1);
});

/* ---------------- axisFor: the document places its own still point ---------------- */

test("axisFor centres when every word fits centred", () => {
  // 100 a side in a 400px field: 0.5 is inside the feasible band, so take it
  assert.equal(axisFor([{ left: 100, right: 100 }], 400), 0.5);
});

test("axisFor slides left only as far as the widest word requires", () => {
  // right half 240 in a 400px stage, plus the 8px inset: the axis may sit no
  // further right than 1 - 248/400
  const f = axisFor([{ left: 60, right: 240 }], 400);
  assert.equal(f, 0.38);
  // and at that axis the word fits exactly, which is the whole point
  assert.ok(fitsAxis({ left: 60, right: 240 }, capsFor(f, 400)));
});

test("axisFor never slides further than it has to", () => {
  // a mildly lopsided word still leaves 0.5 feasible
  assert.equal(axisFor([{ left: 80, right: 190 }], 400), 0.5);
  // a very lopsided one pulls it left, but only to where that word fits
  const f = axisFor([{ left: 80, right: 260 }], 400);
  assert.ok(Math.abs(f - 0.33) < 1e-9, `expected ~0.33, got ${f}`);
  assert.ok(fitsAxis({ left: 80, right: 260 }, capsFor(f, 400)));
});

test("axisFor takes the widest of each side, not of one word", () => {
  // One word is left-heavy, another right-heavy. Both bounds have to bind: the
  // left-heavy one pushes the axis right of centre, the right-heavy one caps how
  // far right it may go. Taking either word alone would place it wrong.
  const a = { left: 220, right: 60 }, b = { left: 60, right: 150 };
  const f = axisFor([a, b], 400);
  assert.ok(f > 0.5, `the left-heavy word should push past centre, got ${f}`);
  const caps = capsFor(f, 400);
  assert.ok(fitsAxis(a, caps), "the left-heavy word fits");
  assert.ok(fitsAxis(b, caps), "the right-heavy word fits");
});

test("axisFor centres a symmetric word that cannot fit at all", () => {
  // 300 + 300 in a 400px stage fits nowhere; both sides need the same relief
  const f = axisFor([{ left: 300, right: 300 }], 400);
  assert.ok(Math.abs(f - 0.5) < 1e-9, `expected 0.5, got ${f}`);
});

test("axisFor picks the axis that costs the least type when nothing fits", () => {
  // A word far too wide: the two allowances must run out together, or one side
  // is starved and windowScale shrinks harder than it has to.
  const halves = { left: 200, right: 600 };
  const W = 400, i = 8;
  const f = axisFor([halves], W, i);
  const caps = capsFor(f, W, i);
  assert.ok(Math.abs(caps.left/halves.left - caps.right/halves.right) < 1e-9,
    `both sides should bind together, got ${caps.left/halves.left} vs ${caps.right/halves.right}`);
  // and no other axis does better
  for(const g of [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5]){
    const c = capsFor(g, W, i);
    const other = Math.min(c.left/halves.left, c.right/halves.right);
    const best  = Math.min(caps.left/halves.left, caps.right/halves.right);
    assert.ok(other <= best + 1e-9, `axis ${g} beat the chosen ${f}`);
  }
});

test("a bigger reading size never yields smaller type once the word is binding", () => {
  // Halves scale with the font size. Once the word cannot fit, the rendered size
  // must plateau, never invert — this is the XL-smaller-than-L regression.
  const W = 390;
  const render = (basePx) => {
    const k = basePx/62;                       // halves measured at 62px
    const halves = [{ left: 120*k, right: 300*k }];
    const f = axisFor(halves, W);
    return basePx * windowScale(halves, capsFor(f, W), basePx);
  };
  let prev = 0;
  for(const px of [29, 41, 54, 69]){
    const got = render(px);
    assert.ok(got >= prev - 0.01, `size ${px} rendered ${got}, smaller than the step below (${prev})`);
    prev = got;
  }
});

test("axisFor falls back on nothing to measure", () => {
  assert.equal(axisFor([], 400), AXIS_DEFAULT);
  assert.equal(axisFor(null, 400), AXIS_DEFAULT);
  assert.equal(axisFor([{ left: 1, right: 1 }], 0), AXIS_DEFAULT);
});

test("axisFor stays inside the clamp", () => {
  const f = axisFor([{ left: 999, right: 1 }], 400);
  assert.ok(f <= 0.9 && f >= 0.1);
});

/* ---------------- sizingSample: which words set a document's size ---------------- */

test("sizingSample returns the longest words, longest first", () => {
  const s = sizingSample(["a", "three", "sentence", "extraordinary"], 3);
  assert.deepEqual(s, ["extraordinary", "sentence", "three"]);
});

test("sizingSample ignores one rogue token so it cannot shrink a whole book", () => {
  const prose = ["the", "quick", "development", "understanding"];
  const rogue = "https://example.com/a/very/long/path/indeed";
  const s = sizingSample([...prose, rogue]);
  assert.ok(!s.includes(rogue), "the URL is left to shrink for its own beat");
  assert.equal(s[0], "understanding");
});

test("sizingSample lets prose of long words raise its own ceiling", () => {
  // every word is past OUTLIER_CHARS, so the 95th percentile has to carry them:
  // excluding them all would leave nothing to size from
  const long = Array.from({ length: 40 }, (_, i) => "x".repeat(OUTLIER_CHARS + 1 + (i % 4)));
  const s = sizingSample(long);
  assert.ok(s.length > 0, "a document of long words still sizes itself");
  assert.ok(s[0].length > OUTLIER_CHARS);
});

test("sizingSample dedupes case-insensitively and honours the sample size", () => {
  const s = sizingSample(["Between", "between", "BETWEEN", "idea"], 4);
  assert.deepEqual(s, ["Between", "idea"]);
  assert.equal(sizingSample(["aaaa", "bbbb", "cccc"], 2).length, 2);
});

test("sizingSample survives an empty document", () => {
  assert.deepEqual(sizingSample([]), []);
  assert.deepEqual(sizingSample(null), []);
});
