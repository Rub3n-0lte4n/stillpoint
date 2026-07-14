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

/* ---------------- chapter grid (scrubber scope) ---------------- */
import { chapterGrid, chapterAt } from "../js/text.js";

const nav = [
  { start: 0,   title: "Cover",     depth: 0 },
  { start: 200, title: "Chapter 1", depth: 0 },
  { start: 900, title: "Chapter 2", depth: 0 },
];

test("nav wins for any kind, ends are exclusive and cover the book", () => {
  for (const kind of ["epub", "pdf"]) {
    const g = chapterGrid(kind, nav, [{ start: 0, title: "Page 1" }, { start: 250, title: "Page 2" }], 1500);
    assert.deepEqual(g, [
      { title: "Cover",     start: 0,   end: 200 },
      { title: "Chapter 1", start: 200, end: 900 },
      { title: "Chapter 2", start: 900, end: 1500 },
    ]);
  }
});

test("epub without nav falls back to spine units", () => {
  const units = [{ start: 0, title: "One" }, { start: 700, title: "Two" }];
  assert.deepEqual(chapterGrid("epub", null, units, 1000), [
    { title: "One", start: 0,   end: 700 },
    { title: "Two", start: 700, end: 1000 },
  ]);
});

test("pdf without outline never uses page units: whole book", () => {
  const pages = [{ start: 0, title: "Page 1" }, { start: 240, title: "Page 2" }, { start: 480, title: "Page 3" }];
  assert.deepEqual(chapterGrid("pdf", null, pages, 720), [{ title: null, start: 0, end: 720 }]);
});

test("text and single-unit docs are whole book", () => {
  assert.deepEqual(chapterGrid("text", null, [{ start: 0, title: "Pasted text" }], 500),
    [{ title: null, start: 0, end: 500 }]);
  assert.deepEqual(chapterGrid("epub", null, [{ start: 0, title: "Only" }], 500),
    [{ title: null, start: 0, end: 500 }]);
});

test("front matter before the first nav entry gets a synthetic untitled segment", () => {
  const late = [{ start: 300, title: "Ch 1" }, { start: 600, title: "Ch 2" }];
  const g = chapterGrid("epub", late, [], 900);
  assert.deepEqual(g[0], { title: null, start: 0, end: 300 });
  assert.equal(g.length, 3);
});

test("degenerate nav (unsorted, duplicate, out-of-range) is repaired or rejected", () => {
  const messy = [
    { start: 600, title: "B" },
    { start: 100, title: "A" },
    { start: 600, title: "B2" },
    { start: 5000, title: "Ghost" },
  ];
  const g = chapterGrid("epub", messy, [], 1000);
  assert.deepEqual(g.map(s => s.title), [null, "A", "B"]);
  assert.deepEqual(g.map(s => s.end), [100, 600, 1000]);
  assert.deepEqual(chapterGrid("epub", [{ start: 0, title: "X" }, { start: 0, title: "Y" }], [], 100),
    [{ title: null, start: 0, end: 100 }]);
});

test("chapterAt clamps and lands on boundaries correctly", () => {
  const g = chapterGrid("epub", nav, [], 1500);
  assert.equal(chapterAt(g, -5), 0);
  assert.equal(chapterAt(g, 0), 0);
  assert.equal(chapterAt(g, 199), 0);
  assert.equal(chapterAt(g, 200), 1);
  assert.equal(chapterAt(g, 899), 1);
  assert.equal(chapterAt(g, 1499), 2);
  assert.equal(chapterAt(g, 99999), 2);
});
