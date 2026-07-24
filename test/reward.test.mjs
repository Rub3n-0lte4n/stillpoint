// Chapter completion reward — pure core + storage API (js/reward.js).
import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";

const {
  freshRec, creditChapter, markFinished, mergeRead,
} = await import("../js/reward.js");

test("creditChapter unions and sorts, and is idempotent", () => {
  const a = creditChapter(freshRec("x"), 2);
  assert.deepEqual(a.chapters, [2]);
  const b = creditChapter(creditChapter(a, 0), 2);
  assert.deepEqual(b.chapters, [0, 2]);       // sorted, no duplicate
  assert.deepEqual(a.chapters, [2]);          // original untouched (immutable)
});

test("markFinished credits the last chapter and stamps finishedAt once", () => {
  const one = markFinished(freshRec("x"), 3, 1000);
  assert.deepEqual(one.chapters, [3]);
  assert.equal(one.finishedAt, 1000);
  const two = markFinished(one, 4, 2000);     // re-finish
  assert.deepEqual(two.chapters, [3, 4]);
  assert.equal(two.finishedAt, 1000);         // earliest finish is kept
});

test("mergeRead unions chapters and keeps the earliest finish", () => {
  const local = { key:"x", chapters:[0,1], bounds:[0,5], total:10, title:"L", kind:"epub", finishedAt:2000 };
  const remote = { key:"x", chapters:[1,2], bounds:null, total:0, title:"", kind:"", finishedAt:1000 };
  const m = mergeRead(local, remote);
  assert.deepEqual(m.chapters, [0,1,2]);
  assert.equal(m.finishedAt, 1000);
  assert.deepEqual(m.bounds, [0,5]);          // metadata from the side that has it
  assert.equal(m.title, "L");
});
