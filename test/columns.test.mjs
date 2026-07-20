// Multi-column reading order — orderPageItems() over synthetic pdf.js text items.
//   node test/columns.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { orderPageItems } from "../js/parsers.js";

// pdf.js item shape: transform is [a,b,c,d,x,y]; only x (=[4]) and y (=[5]) and
// width matter here. Helper builds one at a given position.
const it = (str, x, y, width = str.length * 6) => ({ str, transform: [1, 0, 0, 1, x, y], width });
const read = items => orderPageItems(items).map(t => t.str);

// A two-column page: left column at x=50, right column at x=350, y descending
// down the page. In the content stream we INTERLEAVE the rows (the failure mode
// Arturo described) and expect them read left-column-first, top to bottom.
function twoColPage(){
  const items = [];
  for(let r = 0; r < 8; r++){
    const y = 700 - r * 20;
    items.push(it(`L${r}`, 50, y));   // left
    items.push(it(`R${r}`, 350, y));  // right, emitted right after its left neighbour
  }
  return items;
}

test("interleaved two-column stream reads each column top to bottom", () => {
  const out = read(twoColPage());
  assert.deepEqual(out, [
    "L0","L1","L2","L3","L4","L5","L6","L7",
    "R0","R1","R2","R3","R4","R5","R6","R7",
  ]);
});

test("a single-column page is returned untouched (identity)", () => {
  const items = [];
  for(let r = 0; r < 20; r++) items.push(it(`line${r}`, 60, 700 - r * 18, 300));
  const input = items.map(t => t.str);
  assert.deepEqual(read(items), input);
});

test("too few items to judge: returned untouched", () => {
  const items = [it("a", 50, 700), it("b", 350, 700), it("c", 50, 680)];
  assert.deepEqual(read(items), ["a", "b", "c"]);
});

test("a full-width heading stays above the columns it introduces", () => {
  const items = [];
  items.push(it("TITLE-SPANNING-THE-WHOLE-PAGE-WIDTH", 50, 740, 650)); // crosses the gutter
  for(let r = 0; r < 8; r++){
    const y = 700 - r * 20;
    items.push(it(`L${r}`, 50, y));
    items.push(it(`R${r}`, 350, y));
  }
  const out = read(items);
  assert.equal(out[0], "TITLE-SPANNING-THE-WHOLE-PAGE-WIDTH");
  assert.deepEqual(out.slice(1, 9), ["L0","L1","L2","L3","L4","L5","L6","L7"]);
  assert.deepEqual(out.slice(9), ["R0","R1","R2","R3","R4","R5","R6","R7"]);
});

test("a mid-page full-width band separates the columns above from below", () => {
  const items = [];
  // top band: two columns, rows 0..3
  for(let r = 0; r < 4; r++){ const y = 700 - r * 20; items.push(it(`TL${r}`, 50, y)); items.push(it(`TR${r}`, 350, y)); }
  // a full-width figure caption cutting across
  items.push(it("FULL-WIDTH-BAND-ACROSS-THE-PAGE-MIDDLE", 50, 600, 650));
  // bottom band: two columns, rows 0..3
  for(let r = 0; r < 4; r++){ const y = 560 - r * 20; items.push(it(`BL${r}`, 50, y)); items.push(it(`BR${r}`, 350, y)); }
  const out = read(items);
  assert.deepEqual(out, [
    "TL0","TL1","TL2","TL3","TR0","TR1","TR2","TR3",
    "FULL-WIDTH-BAND-ACROSS-THE-PAGE-MIDDLE",
    "BL0","BL1","BL2","BL3","BR0","BR1","BR2","BR3",
  ]);
});

test("a right-aligned page number does not fake a second column", () => {
  // Body text on the left plus a lone folio at far right on the last line.
  const items = [];
  for(let r = 0; r < 18; r++) items.push(it(`prose${r}`, 60, 700 - r * 18, 300));
  items.push(it("42", 520, 700 - 18 * 18, 12)); // folio, far right, single item
  const input = items.map(t => t.str);
  // No central gutter → identity. The folio stays where it was in the stream.
  assert.deepEqual(read(items), input);
});

test("items without transforms are returned untouched, never dropped", () => {
  const items = [it("a", 50, 700), { str: "b" }, it("c", 350, 700)];
  for(let r = 0; r < 14; r++) items.push(it(`x${r}`, 50, 680 - r * 18));
  const out = orderPageItems(items);
  assert.equal(out.length, items.length);            // nothing lost
  assert.deepEqual(out.map(t => t.str), items.map(t => t.str)); // unpositioned item → bail to identity
});

test("output is always a permutation of the input (no loss, no duplication)", () => {
  const page = twoColPage();
  const out = orderPageItems(page);
  assert.equal(out.length, page.length);
  assert.deepEqual(new Set(out), new Set(page));
});

test("empty and tiny inputs are safe", () => {
  assert.deepEqual(orderPageItems([]), []);
  assert.deepEqual(orderPageItems(null), null);
  assert.deepEqual(read([it("solo", 50, 700)]), ["solo"]);
});

test("three columns read left, middle, right", () => {
  const items = [];
  for(let r = 0; r < 7; r++){
    const y = 700 - r * 20;
    items.push(it(`A${r}`, 40, y, 80));
    items.push(it(`B${r}`, 240, y, 80));
    items.push(it(`C${r}`, 440, y, 80));
  }
  const out = read(items);
  assert.deepEqual(out.slice(0, 7), ["A0","A1","A2","A3","A4","A5","A6"]);
  assert.deepEqual(out.slice(7, 14), ["B0","B1","B2","B3","B4","B5","B6"]);
  assert.deepEqual(out.slice(14), ["C0","C1","C2","C3","C4","C5","C6"]);
});
