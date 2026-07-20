// Away-time-scaled rewind on resume — rewindTarget() policy.
//   node test/rewind.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { tokenize } from "../js/text.js";
import {
  rewindTarget,
  REWIND_GLANCE_MS, REWIND_SENTENCE_MS,
  REWIND_MIN, REWIND_MAX, REWIND_FIXED,
} from "../js/text.js";

// Two sentences of ten words each, so token 15 sits mid-second-sentence and its
// sentence starts at token 10.
const tokens = tokenize(
  "one two three four five six seven eight nine ten. alpha beta gamma delta epsilon zeta eta theta iota kappa.",
);
const MID = 15;           // inside the second sentence, 5 words past its start
const LATE = 19;          // last word of the second sentence, 9 words past its start
const SENTENCE_START = 10; // first word of the second sentence ("alpha")

test("no measured gap (NaN) falls back to the old fixed step", () => {
  assert.equal(rewindTarget(tokens, MID, NaN), MID - REWIND_FIXED);
});

test("a short glance barely moves", () => {
  assert.equal(rewindTarget(tokens, MID, 1000), MID - REWIND_MIN);
  assert.equal(rewindTarget(tokens, MID, REWIND_GLANCE_MS), MID - REWIND_MIN);
});

test("a long interruption deep in a sentence returns to that sentence's start", () => {
  // At LATE the sentence began 9 words back, further than the MAX-word floor (8),
  // so the snap lands cleanly on the first word of the sentence.
  assert.equal(rewindTarget(tokens, LATE, REWIND_SENTENCE_MS), SENTENCE_START);
  assert.equal(rewindTarget(tokens, LATE, 60000), SENTENCE_START);
});

test("near a sentence start, a long interruption still rewinds at least MAX words", () => {
  // At MID the sentence began only 5 words back; the floor keeps a long absence
  // from under-rewinding, so it goes MAX words back rather than a mere 5.
  assert.equal(rewindTarget(tokens, MID, REWIND_SENTENCE_MS), MID - REWIND_MAX);
});

test("crossing the sentence threshold never rewinds forward (monotonic at the seam)", () => {
  const justBefore = rewindTarget(tokens, MID, REWIND_SENTENCE_MS - 1);
  const justAfter  = rewindTarget(tokens, MID, REWIND_SENTENCE_MS);
  assert.ok(justAfter <= justBefore, `seam must not move forward: ${justBefore} → ${justAfter}`);
});

test("the middle range scales monotonically between the two anchors", () => {
  let prev = Infinity;
  for(let ms = REWIND_GLANCE_MS; ms <= REWIND_SENTENCE_MS; ms += 1000){
    const target = rewindTarget(tokens, MID, ms);
    assert.ok(target <= prev, `target must not move forward as the gap grows (ms=${ms})`);
    prev = target;
  }
});

test("a mid-range gap lands between the glance and sentence extremes", () => {
  const mid = rewindTarget(tokens, MID, (REWIND_GLANCE_MS + REWIND_SENTENCE_MS) / 2);
  assert.ok(mid <= MID - REWIND_MIN, "further back than a glance");
  assert.ok(mid >= MID - REWIND_MAX, "not further than the word-based cap");
  assert.ok(mid > SENTENCE_START || mid === SENTENCE_START);
});

test("never rewinds before the document start", () => {
  assert.equal(rewindTarget(tokens, 2, 60000), 0);
  assert.equal(rewindTarget(tokens, 3, NaN), 0);
});

test("index 0 stays at 0 (nothing to rewind into)", () => {
  assert.equal(rewindTarget(tokens, 0, 60000), 0);
  assert.equal(rewindTarget(tokens, 0, NaN), 0);
});

test("a negative gap is treated as 'no measurement', not a huge rewind", () => {
  assert.equal(rewindTarget(tokens, MID, -5), MID - REWIND_FIXED);
});

test("the sentence fallback still respects the word cap on an unpunctuated run", () => {
  // 200 words with no sentence end: sentenceStart is 0, but the cap keeps the
  // rewind bounded so a resume doesn't fling you to the top of the document.
  const long = tokenize(Array.from({ length: 200 }, (_, i) => `w${i}`).join(" "));
  const target = rewindTarget(long, 180, REWIND_SENTENCE_MS);
  assert.ok(target >= 180 - 40, `capped rewind, got ${target}`);
  assert.ok(target < 180, "still moved back somewhat");
});

test("result is always a valid token index", () => {
  for(const ms of [NaN, -1, 0, 500, 4000, 12000, 25000, 999999]){
    for(const i of [0, 1, 5, MID, 19, 20]){
      const t = rewindTarget(tokens, i, ms);
      assert.ok(Number.isInteger(t) && t >= 0 && t <= i, `bad target ${t} for i=${i} ms=${ms}`);
    }
  }
});

test("REWIND_MAX is the ceiling for word-based rewind (never overshoots on glance→sentence ramp)", () => {
  // At just-under the sentence threshold, the word-based branch is at most MAX back.
  const target = rewindTarget(tokens, MID, REWIND_SENTENCE_MS - 1);
  assert.ok(target >= MID - REWIND_MAX);
});
