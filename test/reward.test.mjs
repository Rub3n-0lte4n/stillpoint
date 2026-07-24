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

const { spineBands, spineHeight, shelfEntries, milestoneLine } = await import("../js/reward.js");

test("spineBands classifies done, current, and unread segments", () => {
  const rec = { ...freshRec("x"), chapters:[0], bounds:[0,100,200], total:300 };
  const bands = spineBands(rec, 150);         // read into segment 1 (100..200), segment 2 unread
  assert.equal(bands.length, 3);
  assert.equal(bands[0].state, "done");
  assert.equal(bands[1].state, "current");
  assert.equal(bands[1].fill, 0.5);           // (150-100)/(200-100)
  assert.equal(bands[2].state, "unread");
});

test("spineBands treats a no-ToC book as one whole-book segment", () => {
  const rec = { ...freshRec("x"), chapters:[], bounds:[0], total:500 };
  const bands = spineBands(rec, 250);
  assert.equal(bands.length, 1);
  assert.equal(bands[0].state, "current");
  assert.equal(bands[0].fill, 0.5);
});

test("spineHeight is clamped and grows with length", () => {
  assert.equal(spineHeight(9000), 52);        // floor
  assert.equal(spineHeight(150000), 118);     // ceiling
  assert.ok(spineHeight(50000) > 52 && spineHeight(50000) < 118);
  assert.ok(spineHeight(80000) > spineHeight(30000));
});

test("shelfEntries returns finished books, most recent first", () => {
  const recs = [
    { ...freshRec("a"), title:"A", total:20000, finishedAt:1000 },
    { ...freshRec("b"), title:"B", total:90000, finishedAt:3000 },
    { ...freshRec("c"), title:"C", total:40000, finishedAt:null },   // unfinished, excluded
  ];
  const s = shelfEntries(recs);
  assert.equal(s.length, 2);
  assert.equal(s[0].key, "b");                // 3000 > 1000
  assert.equal(s[0].height, spineHeight(90000));
});

test("milestoneLine adds only clean milestone clauses", () => {
  assert.equal(milestoneLine(4, 12), "Chapter 4 of 12.");
  assert.equal(milestoneLine(7, 12), "Chapter 7 of 12. Halfway.");   // 6 done of 12
  assert.equal(milestoneLine(12, 12), "Chapter 12 of 12. Almost there.");
});

const { Reward } = await import("../js/reward.js");

test("Reward.credit persists and reports newlyEarned exactly once", async () => {
  await Reward.hydrate();
  assert.equal(Reward.credit("bookA", 0).newlyEarned, true);
  assert.equal(Reward.credit("bookA", 0).newlyEarned, false);   // idempotent
  assert.deepEqual(Reward.forDoc("bookA").chapters, [0]);
});

test("Reward.finish + shelf surface finished books, most recent first", async () => {
  await Reward.hydrate();
  Reward.note("b1", { bounds:[0,10], total:20000, title:"One", kind:"epub" });
  Reward.note("b2", { bounds:[0,10], total:90000, title:"Two", kind:"epub" });
  Reward.finish("b1", 1, 1000);
  Reward.finish("b2", 1, 2000);
  const s = Reward.shelf();
  assert.equal(s.length, 2);
  assert.equal(s[0].key, "b2");                 // most recent first
});

test("hydrate reloads persisted records from IndexedDB", async () => {
  Reward.note("keep", { bounds:[0,5], total:10, title:"K", kind:"pdf" });
  Reward.credit("keep", 0);                     // read chapter 0 during the session
  Reward.finish("keep", 1, 500);                // finished on the last chapter
  await Reward.hydrate();                        // drops the cache, reloads from store
  const r = Reward.forDoc("keep");
  assert.equal(r.finishedAt, 500);
  assert.deepEqual(r.chapters, [0, 1]);
});

test("exportAll / importMerge round-trips and unions", async () => {
  await Reward.hydrate();
  Reward.credit("mix", 0);
  const dump = Reward.exportAll().filter(e => e.key === "mix");
  await Reward.hydrate();                        // fresh cache
  Reward.credit("mix", 1);
  Reward.importMerge(dump);
  assert.deepEqual(Reward.forDoc("mix").chapters, [0, 1]);
});
