// Contents panel — pure row-building logic (js/text.js chapterItems).
import test from "node:test";
import assert from "node:assert/strict";
import { chapterItems } from "../js/text.js";

const units = [
  { start: 0,   title: "Cover" },
  { start: 120, title: "Chapter 1" },
  { start: 480, title: "Chapter 2" },
];

test("empty or single-unit nav yields no rows (nothing to navigate)", () => {
  assert.deepEqual(chapterItems([], 0), []);
  assert.deepEqual(chapterItems([{ start: 0, title: "Only" }], 50), []);
  assert.deepEqual(chapterItems(null, 0), []);
});

test("rows carry start + title in order", () => {
  const rows = chapterItems(units, 0);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => r.title), ["Cover", "Chapter 1", "Chapter 2"]);
  assert.deepEqual(rows.map(r => r.start), [0, 120, 480]);
});

test("current row is the last unit whose start has been reached", () => {
  assert.deepEqual(chapterItems(units, 0).map(r => r.current),   [true, false, false]);
  assert.deepEqual(chapterItems(units, 119).map(r => r.current), [true, false, false]);
  assert.deepEqual(chapterItems(units, 120).map(r => r.current), [false, true, false]);
  assert.deepEqual(chapterItems(units, 9999).map(r => r.current),[false, false, true]);
});

test("exactly one row is current for any index", () => {
  for (const i of [0, 60, 120, 300, 480, 100000]) {
    const n = chapterItems(units, i).filter(r => r.current).length;
    assert.equal(n, 1, `index ${i}`);
  }
});
