# Dash + Ellipsis Token Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Em-dash-joined pairs split into two readable tokens; spaced/lone ellipses collapse into one "…" on the preceding word.

**Architecture:** A post-pass inside `tokenize()` (`js/text.js`) between the space-split and the flag computation: `splitDashes()` then `collapseEllipses()`, both module-local. Every consumer (EPUB/PDF/paste/demo, pacing, blocks) is downstream. Spec: `docs/superpowers/specs/2026-07-15-dash-ellipsis-tokens-design.md`.

**Tech Stack:** Vanilla ES modules; `node:test`; the session's linkedom Musashi harness + raw-CDP Chrome for verification.

## Global Constraints

- No Co-Authored-By trailers; commit style `type(scope): lowercase description`.
- Plain prose without dashes/ellipses must tokenize byte-identically.
- Hyphen `-` and en dash `–` never split; leading/trailing dashes never split.
- `sw.js` CACHE_VERSION v46 → v47 exactly once, final task.

---

### Task 1: tokenize() post-pass (TDD)

**Files:**
- Create: `test/tokenize.test.mjs`
- Modify: `package.json` (append to the `test` script chain)
- Modify: `js/text.js` (`tokenize`, ~line 4)

**Interfaces:**
- Produces: unchanged `tokenize(text) -> [{w, end, pause}]` signature; new splitting/collapsing behavior. Helpers stay private — tests go through `tokenize()`.

- [ ] **Step 1: Write the failing tests**

`test/tokenize.test.mjs`:

```js
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
```

- [ ] **Step 2: Add to the npm test chain and verify failure**

In `package.json`, the `test` script gains ` && node test/tokenize.test.mjs` at the end.
Run: `node test/tokenize.test.mjs`
Expected: FAIL (splits/merges not implemented; plain-prose test passes).

- [ ] **Step 3: Implement the post-pass in `js/text.js`**

`tokenize` and two private helpers become:

```js
// Split text into word tokens, flagging sentence ends + clause pauses for natural pacing.
// Two readability post-passes before flagging (see 2026-07-15 dash-ellipsis spec):
// em-dash-joined pairs split (the dash trails the first word, whose pause flag
// gives it a clause beat), and spaced/lone ellipses gather into one "…" on the
// preceding word so ". . ." is one fixation, not three sentence-end pauses.
const WORDISH = "A-Za-z0-9À-ž";
// built once — this runs for every word of every book
const DASH_SPLIT = new RegExp(`[${WORDISH}"'”’)\\]][—―](?=["'“‘(\\[]?[${WORDISH}])`);
function splitDashes(w){
  const parts = [];
  let rest = w;
  for(;;){
    const m = rest.match(DASH_SPLIT);
    if(!m){ parts.push(rest); return parts; }
    const cut = m.index + 2;   // the char before the dash, plus the dash itself
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
}
function collapseEllipses(words){
  const out = [];
  for(const w of words){
    if(/^[.…]+$/.test(w)){
      const prev = out[out.length - 1];
      if(prev === undefined){ out.push("…"); }
      else if(!/^[.…]+$/.test(prev)){ out[out.length-1] = (prev + "…").replace(/[.…]+…$/, "…"); }
      // a beat after a kept lone "…" is absorbed silently
      continue;
    }
    out.push(w);
  }
  return out;
}
export function tokenize(text){
  const raw = text.replace(/\s+/g," ").trim();
  if(!raw) return [];
  let words = [];
  for(const w of raw.split(" ")) for(const p of splitDashes(w)) words.push(p);
  words = collapseEllipses(words);
  return words.map(w => ({
    w,
    end: /[.!?…]["')\]]?$/.test(w),
    pause: /[,;:—–)\]]["']?$/.test(w),
  }));
}
```

(The regex in `splitDashes` is built once per call from the shared `WORDISH`
class; À-ž covers the romanized-Japanese accents in this library — Ō, ū.)

- [ ] **Step 4: Verify green, then the whole suite**

Run: `node test/tokenize.test.mjs` → all pass. `npm test` → green
(existing suites guard sentence pacing, blocks, toc against regressions).

- [ ] **Step 5: Musashi harness re-run**

Run the session's `repro-punct.mjs` (scratchpad). Expected: `emDashJoin: 0`,
`loneDot: 0`, `loneEllip: 0`, `loneDotRuns: 0`; total tokens ~418.4k
(was 418,031; splits add, merges subtract).

- [ ] **Step 6: Commit**

```bash
git add js/text.js test/tokenize.test.mjs package.json
git commit -m "feat(tokens): dashes split for the eye, ellipses gather into one beat"
```

---

### Task 2: Browser smoke + ship

**Files:**
- Modify: `sw.js:6` → `"stillpoint-v47"`

**Interfaces:**
- Consumes: the session's `cdp-epub.mjs` harness (serves repo on :8111, Chrome CDP, `musashi-test.epub` fixture; temp-copy the fixture into the repo root for same-origin fetch, delete after).

- [ ] **Step 1: Bump `sw.js` to v47**

- [ ] **Step 2: Browser smoke on a FRESH Chrome profile** (the SW serves stale
  shells to reused profiles — 2026-07-15 gotcha)

Run `cdp-epub.mjs` against the served repo. Expected: parse succeeds, token
total in [418k, 419k], glued suspects ≤ 5 (the verbatim-source set), zero
exceptions.

- [ ] **Step 3: Commit, deploy, verify live**

```bash
git add sw.js
git commit -m "chore(sw): v47 reads the long sentences kindly"
git push
```

Poll live `sw.js` for v47; confirm live `js/text.js` contains `collapseEllipses`.
