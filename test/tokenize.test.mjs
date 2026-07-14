// Dash + ellipsis token handling — through the public tokenize() surface.
//   node test/tokenize.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { tokenize } from "../js/text.js";

const words = (s) => tokenize(s).map(t => t.w);

test("em dash between words splits, dash trails the first word", () => {
  assert.deepEqual(words("the commoners—the town"), ["the", "commoners—", "the", "town"]);
  assert.deepEqual(words("commanders—Ukita, arrived"), ["commanders—", "Ukita,", "arrived"]);
});

test("multi-dash chains split at every dash", () => {
  assert.deepEqual(words("a—b—c"), ["a—", "b—", "c"]);
});

test("dash adjacent to quotes still splits", () => {
  assert.deepEqual(words('right—"Next'), ["right—", '"Next']);
});

test("the split half carries the clause pause", () => {
  const t = tokenize("trouble—he said");
  assert.equal(t[0].w, "trouble—");
  assert.equal(t[0].pause, true);
  assert.equal(t[0].end, false);
});

test("hyphens, en dashes, leading/trailing dashes never split", () => {
  assert.deepEqual(words("well-known plan"), ["well-known", "plan"]);
  assert.deepEqual(words("1914–1918 war"), ["1914–1918", "war"]);
  assert.deepEqual(words("—but still"), ["—but", "still"]);
  assert.deepEqual(words('and—" she'), ['and—"', "she"]);
});

test("spaced ellipsis collapses into the preceding word", () => {
  assert.deepEqual(words("Gone . . . I couldn't"), ["Gone…", "I", "couldn't"]);
  assert.deepEqual(words("wait . . . . now"), ["wait…", "now"]);
});

test("lone … and lone ... merge the same way", () => {
  assert.deepEqual(words("he recognized … her"), ["he", "recognized…", "her"]);
  assert.deepEqual(words("he stopped ... there"), ["he", "stopped…", "there"]);
});

test("ellipsis at a paragraph start stays a single beat", () => {
  assert.deepEqual(words(". . . and then"), ["…", "and", "then"]);
  assert.deepEqual(words("… nothing"), ["…", "nothing"]);
});

test("no double dots after a merge", () => {
  assert.deepEqual(words("Gone. . . . I"), ["Gone…", "I"]);
  assert.deepEqual(words("Gone... … I"), ["Gone…", "I"]);
});

test("merged ellipsis ends the sentence exactly once", () => {
  const t = tokenize("Gone . . . I");
  assert.equal(t[0].w, "Gone…");
  assert.equal(t[0].end, true);
  assert.equal(t.filter(x => x.end).length, 1);
});

test("plain prose is untouched", () => {
  const s = "Reading is a strange skill. You take small marks, and they turn into meaning.";
  assert.deepEqual(words(s), s.split(" "));
});
