// Phase 3 verification — pacing factors, sentence boundaries, highlight logic.
//   node test/phase3.test.mjs
import { sentenceFactors, sentenceStart, sentenceEnd, tokenize } from "../js/text.js";
import { toggleRange, serializeHighlights, deserializeHighlights, rangeText, exportMarkdown } from "../js/highlights.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log("  ✗ FAIL:", msg); } };

/* ---------- sentence boundaries ---------- */
// two sentences: "a b c." then "d e f g."
const toks = tokenize("a b c. d e f g.");
// indices: 0 a,1 b,2 c.(end),3 d,4 e,5 f,6 g.(end)
ok(toks[2].end === true && toks[6].end === true, "tokenizer flags sentence ends");
ok(sentenceStart(toks, 5) === 3, "sentenceStart from mid-2nd-sentence → 3");
ok(sentenceStart(toks, 1) === 0, "sentenceStart in 1st sentence → 0");
ok(sentenceEnd(toks, 4) === 6, "sentenceEnd from mid-2nd-sentence → 6");
ok(sentenceEnd(toks, 0) === 2, "sentenceEnd in 1st sentence → 2");

/* ---------- pacing factors ---------- */
const shortS = "The cat sat on a mat.";
const longS  = "Notwithstanding considerable institutional resistance, the committee's extraordinarily convoluted deliberations ultimately produced recommendations whose practical implications remained stubbornly ambiguous despite exhaustive subsequent clarification attempts throughout several painstaking additional review sessions.";
const combined = tokenize(shortS + " " + longS);
const f = sentenceFactors(combined, 0.35);
const shortIdx = 1;                       // inside the short sentence
const longIdx = combined.length - 2;      // inside the long sentence
ok(Math.abs(f[shortIdx] - 1.0) < 0.001, "plain short sentence factor ≈ 1.0 (no regression): " + f[shortIdx].toFixed(3));
ok(f[longIdx] > f[shortIdx], "complex sentence dwells longer than short one: " + f[longIdx].toFixed(3));
ok(f[longIdx] <= 1.5 + 1e-6, "factor clamped to ≤ 1.5: " + f[longIdx].toFixed(3));

/* ---------- highlight toggle / merge ---------- */
let r = [];
r = toggleRange(r, 412, 437, 6, 1);
ok(r.length === 1 && r[0].start === 412 && r[0].end === 437, "first mark inserted");
r = toggleRange(r, 412, 437, 6, 2);
ok(r.length === 0, "exact re-mark toggles off");
r = toggleRange([], 10, 20, 0, 1);
r = toggleRange(r, 15, 25, 0, 2);
ok(r.length === 1 && r[0].start === 10 && r[0].end === 25, "overlapping ranges merge → [10,25]");
r = toggleRange(r, 40, 45, 0, 3);
ok(r.length === 2, "non-overlapping range stays separate");

/* ---------- serialize round-trip ---------- */
const ser = serializeHighlights([{start:5,end:9,unit:0,ts:1},{start:1,end:2,unit:0,ts:2}]);
ok(ser.v === 1 && ser.ranges[0].start === 1, "serialize sorts by start and stamps version");
ok(deserializeHighlights(ser).length === 2, "deserialize returns ranges");
ok(deserializeHighlights(null).length === 0, "deserialize tolerates missing record");

/* ---------- rangeText + markdown export ---------- */
const proseToks = tokenize("Reading is a curious act of magic. The eye does not glide smoothly across a line.");
// sentence 2 starts at index 7 ("The"); take words 7..? "The eye does not" = 7..10
ok(rangeText(proseToks, {start:7,end:10}) === "The eye does not", "rangeText joins token words: " + rangeText(proseToks,{start:7,end:10}));

const units = [{title:"II. Attention", start:0}];
const md = exportMarkdown(proseToks, units, [{start:7,end:10,unit:0,ts:1}], "On Stillness");
ok(md.startsWith("# Highlights — On Stillness"), "md has title header");
ok(md.includes("## II. Attention"), "md has unit heading");
ok(md.includes("> The eye does not"), "md has blockquote passage");
ok(md.includes("— On Stillness · II. Attention · words 7–10"), "md has source attribution line");

console.log(`\nPhase 3 tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
