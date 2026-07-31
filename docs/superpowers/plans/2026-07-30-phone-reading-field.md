# Phone Reading Field Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every ordinary word fit a phone screen at the reader's chosen size, by moving the reading axis left of centre instead of shrinking the type.

**Architecture:** A new pure module `js/field.js` holds the geometry decisions (does this fit, at what scale, how many words). `js/app.js` keeps all DOM work and calls into it. A new CSS token `--axis-x` is the single source of truth for where the still point sits horizontally, exactly as the existing `--axis` is for vertically. The per-word measuring fallback (`fitRibbon`/`centerRibbon`) is deleted; placement stays pure arithmetic over the cached window geometry.

**Tech Stack:** Native ES modules, no build step. `node:test` + `node:assert/strict` for units. Raw-CDP headless Chrome for e2e (`test/e2e/smoke.mjs`). Plain CSS with custom properties.

## Global Constraints

- **No build step.** Native ES modules served over HTTP. No bundler, no transpile.
- **No new dependencies.** Runtime has zero. Dev deps are only what `package.json` already lists.
- **Commit trailers are forbidden in this repo.** Never add `Co-Authored-By` or any Claude/Anthropic attribution to a commit message. This overrides the harness default.
- **Copy voice:** no em dashes, no rule-of-three lists in any user-facing string or any doc written for this repo. En dashes only in numeric ranges.
- **The focal word is instant.** Never add a transition or animation to `.rw`, to the ribbon transform, or to the reading font size. Word swaps and scale steps are both instant.
- **Never animate `filter` on `.toast`** (it carries `backdrop-filter`; Safari compositing breaks).
- **New JS modules must be added to `SHELL` in `sw.js`** or the service worker will not precache them.
- **After any change to a `SHELL` file, run `npm run sw:bump`** to re-derive `CACHE_VERSION` from content hashes. `npm run sw:check` fails on drift and CI runs it.
- **`fp_prefs` keys and backup format do not change.** `S.chunk` keeps its name and meaning as the stored preference.
- **Cascade order matters in `styles.css`.** Equal-specificity rules later in the file win. The `(hover:none)` and `max-width:680px` blocks come after the base rules, so base declarations they must beat need either two classes or a restatement. This has bitten this repo three times.
- **Any `position:fixed` inside `.dock` or `.reader-top` is a containing-block trap** (they carry `backdrop-filter`). Do not add fixed children to them.
- **Reduced motion** is handled by a global `prefers-reduced-motion` block. Do not add per-rule handling.

## File Structure

**Created:**
- `js/field.js` — pure reading-field geometry. No DOM, no app state. Exports `axisFraction`, `halvesFor`, `fitsAxis`, `windowScale`, `chunkFit`, and the tuning constants. Mirrors how `js/gestures.js` and `js/streak.js` keep their maths testable.
- `test/field.test.mjs` — units for every export of `js/field.js`.

**Modified:**
- `styles.css` — introduces `--axis-x`; the halo, guides, baseline, countdown and mask read it. Phone mask pulled back off the focal word.
- `js/app.js` — `measureRibbon` caches ink extents and `G.scale`; `placeRibbon` places against the axis and scales; `fitRibbon`/`centerRibbon` deleted; `S.chunkNow` threaded through `render` and `step`; `setMode` publishes `data-mode`.
- `index.html` — chunk control label and About copy follow the "up to N words" semantics.
- `sw.js` — `js/field.js` added to `SHELL`; `CACHE_VERSION` re-derived.
- `test/e2e/smoke.mjs` — phone-viewport flow asserting no ink escapes the field and the pivot sits on the axis.
- `README.md` — file tree gains `js/field.js`.

**Task order rationale:** Tasks 1 and 2 build and prove the pure geometry with zero app risk. Task 3 lands the CSS token so the axis exists before anything reads it. Task 4 rewires placement (the core fix). Task 5 deletes the old fallback once nothing needs it. Task 6 is the chunk change, deliberately last of the functional work so it can be reverted alone. Tasks 7 and 8 are verification and polish.

---

### Task 1: Pure field geometry, part one (fit and scale)

**Files:**
- Create: `js/field.js`
- Test: `test/field.test.mjs`
- Modify: `package.json:scripts.test`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `AXIS_DEFAULT = 0.5`
  - `SCALE_FLOOR_PX = 22`
  - `FIELD_INSET_PX = 8`
  - `axisFraction(raw, fallback = AXIS_DEFAULT) -> number` — parses a CSS custom property string like `"33%"` or `"0.33"` into a fraction clamped to `0.1..0.9`; returns `fallback` for anything unparseable.
  - `fitsAxis(halves, axisFrac, field) -> boolean` where `halves` is `{ left, right }` in px.
  - `windowScale(halvesList, axisFrac, field, basePx) -> number` — largest scale in `0..1` at which every entry of `halvesList` satisfies `fitsAxis`, floored so `scale * basePx >= SCALE_FLOOR_PX`, and never above 1.

- [ ] **Step 1: Write the failing test**

Create `test/field.test.mjs`:

```javascript
// Reading-field geometry — pure, no DOM.
//   node test/field.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { axisFraction, fitsAxis, windowScale, AXIS_DEFAULT, SCALE_FLOOR_PX } from "../js/field.js";

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
  assert.equal(fitsAxis(halves, 0.5, 390), false);   // needs 400px centred
  assert.equal(fitsAxis(halves, 0.33, 390), true);   // 100<=128.7 and 200<=261.3
});

test("fitsAxis fails when either side overruns", () => {
  assert.equal(fitsAxis({ left: 200, right: 10 }, 0.33, 390), false);  // left side blows out
  assert.equal(fitsAxis({ left: 10, right: 300 }, 0.33, 390), false);  // right side blows out
});

test("windowScale returns 1 when everything already fits", () => {
  const list = [{ left: 40, right: 80 }, { left: 20, right: 30 }];
  assert.equal(windowScale(list, 0.33, 390, 62), 1);
});

test("windowScale shrinks to the widest word in the window", () => {
  const list = [{ left: 20, right: 30 }, { left: 100, right: 400 }];
  const s = windowScale(list, 0.33, 390, 62);
  assert.ok(s < 1, `expected a shrink, got ${s}`);
  // the binding side is the right one: 400*s <= 0.67*390
  assert.ok(Math.abs(400 * s - 0.67 * 390) < 0.5, `scale ${s} should bind on the right half`);
});

test("windowScale never goes below the floor", () => {
  const list = [{ left: 10, right: 4000 }];   // a pathological token
  const s = windowScale(list, 0.33, 390, 62);
  assert.equal(s, SCALE_FLOOR_PX / 62);
});

test("windowScale is 1 for an empty window", () => {
  assert.equal(windowScale([], 0.33, 390, 62), 1);
});
```

Register the file so `npm test` runs it. In `package.json`, append to the `test` script, after `node test/rewind.test.mjs`:

```
 && node test/field.test.mjs
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/field.test.mjs`
Expected: FAIL with `Cannot find module .../js/field.js`

- [ ] **Step 3: Write minimal implementation**

Create `js/field.js`:

```javascript
/* ---------------- reading-field geometry ----------------
   Pure maths for the question "does this fit, and at what size". No DOM, no app
   state, so it is testable in node.

   The field is short for one reason: ORP pins the PIVOT LETTER to the axis, and
   words are lopsided around their pivot (it sits about a third in). A centred
   pivot therefore spends only ~40% of the screen on the side the word actually
   grows into, so a word needs roughly 1.45x its own width in screen space.
   Moving the axis left buys that width back instead of shrinking the type. */

export const AXIS_DEFAULT  = 0.5;
export const SCALE_FLOOR_PX = 22;   // below this the type stops yielding; see windowScale
export const FIELD_INSET_PX = 8;    // breathing room at each edge of the field

/* Read a CSS custom property into a fraction. Authored as a plain percentage so
   it always resolves; anything else (a calc(), an empty string on a browser that
   dropped the property) falls back rather than throwing the placement off. */
export function axisFraction(raw, fallback = AXIS_DEFAULT){
  if(typeof raw !== "string") return fallback;
  const s = raw.trim();
  if(!s) return fallback;
  const m = /^(-?\d*\.?\d+)\s*(%?)$/.exec(s);
  if(!m) return fallback;
  const n = parseFloat(m[1]);
  if(!isFinite(n)) return fallback;
  const frac = m[2] === "%" ? n/100 : n;
  return Math.min(0.9, Math.max(0.1, frac));
}

/* Both sides measured from the axis outward. The axis gets axisFrac of the field
   on its left and the rest on its right, so each side is checked against its own
   allowance. Checking total width instead is the bug this replaces. */
export function fitsAxis(halves, axisFrac, field){
  return halves.left  <= axisFrac * field + 0.01 &&
         halves.right  <= (1 - axisFrac) * field + 0.01;
}

/* One scale for a whole ribbon window, set by its widest SINGLE word. A word
   cannot be split, so it is the only thing allowed to force the type down;
   phrases yield words instead (see chunkFit). Halves are measured at basePx, and
   scale linearly with the font size. */
export function windowScale(halvesList, axisFrac, field, basePx){
  let scale = 1;
  for(const h of halvesList){
    const leftCap  = axisFrac * field;
    const rightCap = (1 - axisFrac) * field;
    const need = Math.min(
      h.left  > 0 ? leftCap  / h.left  : Infinity,
      h.right > 0 ? rightCap / h.right : Infinity
    );
    if(need < scale) scale = need;
  }
  if(scale > 1) scale = 1;
  const floor = basePx > 0 ? SCALE_FLOOR_PX / basePx : 1;
  // a single unfittable token stops the shrink here and is allowed to overhang,
  // where the edge dissolve softens it. The only case where ink leaves the field.
  return Math.max(scale, Math.min(1, floor));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test/field.test.mjs`
Expected: PASS, 9 tests.

Run: `npm test`
Expected: every file passes, including the new one.

- [ ] **Step 5: Commit**

```bash
git add js/field.js test/field.test.mjs package.json
git commit -m "feat(field): pure geometry for the pivot-relative fit"
```

---

### Task 2: Pure field geometry, part two (halves and chunk packing)

**Files:**
- Modify: `js/field.js`
- Modify: `test/field.test.mjs`

**Interfaces:**
- Consumes: `fitsAxis` from Task 1.
- Produces:
  - `halvesFor(m, i) -> { left, right }` — ORP halves for word `i` from a metrics object `m`, measured from the bold pivot letter's centre. `m` has parallel arrays `inkL`, `inkR`, `preL`, `wPre`, `wPiv`, `wPivB` (all px at base size, relative to a common origin).
  - `blockHalves(m, i, count, hybrid) -> { left, right }` — halves for a `count`-word phrase starting at `i`, centred on the axis as an optical block. `hybrid` true adds every word's bold-pivot growth, because Hybrid ambers each anchor.
  - `chunkFit(m, start, maxChunk, axisFrac, field, hybrid) -> number` — the largest count in `1..maxChunk` whose block satisfies `fitsAxis`, always at least 1.

- [ ] **Step 1: Write the failing test**

Append to `test/field.test.mjs`:

```javascript
import { halvesFor, blockHalves, chunkFit } from "../js/field.js";

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
  assert.equal(chunkFit(M, 0, 3, 0.5, 400, false), 3);
});

test("chunkFit drops words rather than shrinking the type", () => {
  // a 240px field centred holds 120px a side: 2 words need 100 a side, 3 need 150
  assert.equal(chunkFit(M, 0, 3, 0.5, 240, false), 2);
});

test("chunkFit never returns zero, even when one word cannot fit", () => {
  assert.equal(chunkFit(M, 0, 3, 0.5, 40, false), 1);
});

test("chunkFit respects the maximum it is given", () => {
  assert.equal(chunkFit(M, 0, 1, 0.5, 4000, false), 1);
});

test("chunkFit clamps at the end of the window", () => {
  assert.equal(chunkFit(M, 2, 4, 0.5, 4000, false), 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/field.test.mjs`
Expected: FAIL with `halvesFor is not a function` (or an import error naming it).

- [ ] **Step 3: Write minimal implementation**

Append to `js/field.js`:

```javascript
/* ORP halves: measured from the BOLD pivot letter's centre, because bold is the
   state the focal word is actually painted in. Bolding the pivot is the one thing
   that changes a word's metrics, so the extra width lands on the right side. */
export function halvesFor(m, i){
  const grow  = m.wPivB[i] - m.wPiv[i];
  const pivC  = m.preL[i] + m.wPre[i] + m.wPivB[i]/2;
  return { left: pivC - m.inkL[i], right: (m.inkR[i] + grow) - pivC };
}

/* A phrase has no single pivot, so it centres on the axis as an optical block.
   Hybrid ambers every word's pivot, so every word in the phrase widens. */
export function blockHalves(m, i, count, hybrid){
  const last = i + count - 1;
  let grow = 0;
  if(hybrid) for(let k=i;k<=last;k++) grow += m.wPivB[k] - m.wPiv[k];
  const width = (m.inkR[last] + grow) - m.inkL[i];
  return { left: width/2, right: width/2 };
}

/* The phrase yields before the type does: take as many words as fit at the
   current size, down to one. One word that still does not fit is the only thing
   that reaches windowScale. */
export function chunkFit(m, start, maxChunk, axisFrac, field, hybrid){
  const room = m.inkL.length - start;
  const cap = Math.max(1, Math.min(maxChunk, room));
  let best = 1;
  for(let n=1;n<=cap;n++){
    if(fitsAxis(blockHalves(m, start, n, hybrid), axisFrac, field)) best = n;
    else break;
  }
  return best;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test/field.test.mjs`
Expected: PASS, 19 tests.

- [ ] **Step 5: Commit**

```bash
git add js/field.js test/field.test.mjs
git commit -m "feat(field): pivot halves, block halves, and chunk packing"
```

---

### Task 3: The `--axis-x` token

**Files:**
- Modify: `styles.css:467` (halo), `:493` (guides), `:496` (baseline), `:505-510` (countdown word), `:806` (phone baseline), `:811` (phone ribbon), `:817-819` (phone mask)
- Modify: `js/app.js:1600-1611` (`setMode` publishes `data-mode`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `--axis-x` resolvable via `getComputedStyle(stage).getPropertyValue("--axis-x")`, and `stage.dataset.mode` set to `"orp" | "rsvp" | "hybrid"`. Task 4 reads both.

This task is CSS and one line of JS. It moves the ornaments onto the token and leaves placement alone, so after it the guides sit at 33% on a phone while the word still centres at 50%. That mismatch is expected and Task 4 closes it. Do not try to fix it here.

- [ ] **Step 1: Add the token and move the ornaments onto it**

In `styles.css`, in the `:root` block near `--stage-scale` (around line 36), add:

```css
    --axis-x:50%;      /* where the still point sits across the field; the phone shifts it left */
```

Change the halo (line 467) from `left:50%` to the token:

```css
  .stage::before{
    content:"";position:absolute;left:var(--axis-x,50%);top:var(--axis,50%);transform:translate(-50%,-50%);
```

Change the guides (line 493):

```css
  .stage .guide{position:absolute;left:var(--axis-x,50%);transform:translateX(-50%);width:1.5px;opacity:.7;box-shadow:0 0 8px rgba(255,206,92,0.4);}
```

Change the baseline (line 496) so it centres on the axis instead of spanning a fixed inset:

```css
  .stage .baseline{position:absolute;left:calc(var(--axis-x,50%) - 40%);width:80%;top:var(--axis,50%);height:1px;opacity:.7;background:linear-gradient(90deg,transparent,var(--hair-strong) 50%,transparent);}
```

The countdown digit is flex-centred by the stage, so it needs taking out of the flow onto the axis. Replace the `.word` rule (lines 505-510):

```css
  .word{
    font-family:"Atkinson Hyperlegible",system-ui,sans-serif;font-weight:400;
    font-size:min(calc(var(--read-size,62px) * var(--stage-scale,1)), 13vw);line-height:1;
    display:grid;grid-template-columns:1fr auto 1fr;align-items:baseline;
    letter-spacing:.5px;
    position:absolute;left:var(--axis-x,50%);top:var(--axis,50%);transform:translate(-50%,-50%);
    justify-items:center;
  }
```

- [ ] **Step 2: Shift the axis where the field is narrow**

In the `@media (max-width:680px)` block, inside the `.stage{...}` rule (around line 789-799, which already sets `--axis:44%`), add the horizontal twin:

```css
      --axis-x:33%;
```

Then, immediately after that `.stage` rule, restate it for chunk modes, which are symmetric and waste nothing:

```css
    /* A phrase centres on its own middle, so it needs no offset. Only ORP pays
       the lopsided-pivot cost that the shifted axis buys back. */
    .stage[data-mode="rsvp"], .stage[data-mode="hybrid"]{ --axis-x:50%; }
```

Delete the now-superseded phone baseline override at line 806 (`.stage .baseline{left:24%;right:24%;opacity:.4;}`) and replace it with an opacity-only rule, since the base rule now handles the geometry:

```css
    .stage .baseline{opacity:.4;}
```

Leave the landscape block alone. A sideways phone is 844px wide, fails this width query, and has room to spare, so it keeps the axis at 50%.

- [ ] **Step 3: Publish the mode to CSS**

In `js/app.js`, in `setMode` (line 1600), after `S.mode=m;` add:

```javascript
  { const st=$("stage"); if(st) st.dataset.mode=m; }   // CSS switches --axis-x per mode
```

- [ ] **Step 4: Verify by eye and by measurement**

Run: `npm run test:e2e`
Expected: 19/19 pass. The existing pivot-lock assertion still passes because desktop keeps `--axis-x:50%` and the e2e window is 1280 wide.

Then confirm the token resolves on a phone. Run this one-off check:

```bash
node -e '
const s = require("fs").readFileSync("styles.css","utf8");
for (const pat of ["--axis-x:50%", "--axis-x:33%", "left:var(--axis-x,50%)", "data-mode=\"rsvp\""]) {
  if (!s.includes(pat)) { console.error("MISSING:", pat); process.exit(1); }
}
console.log("token wiring present");
'
```

Expected: `token wiring present`

- [ ] **Step 5: Commit**

```bash
git add styles.css js/app.js
git commit -m "feat(stage): --axis-x, the horizontal twin of the focal line"
```

---

### Task 4: Place the ribbon against the axis, at one scale per window

**Files:**
- Modify: `js/app.js:110-188` (`G`, `invalidateRibbon`, `measureRibbon`, `placeRibbon`)
- Modify: `js/app.js:1600-1611` (`setMode` invalidates)
- Modify: `sw.js:11-33` (`SHELL`)
- Modify: `README.md` (file tree)

**Interfaces:**
- Consumes: `axisFraction`, `halvesFor`, `windowScale`, `FIELD_INSET_PX` from Tasks 1-2; `--axis-x` and `stage.dataset.mode` from Task 3.
- Produces: `G` gains `inkL`, `inkR`, `wPost`, `axisFrac`, `field`, `axisX`, `scale`. `placeRibbon` no longer calls `fitRibbon`. Task 5 deletes the dead fallback; Task 6 adds `chunkFit` on top of this cache.

- [ ] **Step 1: Import the module and add it to the shell**

At the top of `js/app.js`, alongside the existing `js/text.js` import, add:

```javascript
import { axisFraction, halvesFor, windowScale, FIELD_INSET_PX } from "./field.js";
```

In `sw.js`, add to `SHELL` after `"js/library.js",`:

```javascript
  "js/field.js",
```

In `README.md`, add `js/field.js` to the file tree next to `js/gestures.js`, described as the reading-field geometry.

- [ ] **Step 2: Cache ink extents, the axis, and one scale per window**

Replace `measureRibbon` (js/app.js:137-158) entirely:

```javascript
// Two measurement passes per rebuild: plain, then with every pivot letter bold
// (the `mb` class). Bold width per word is position-independent, so the two
// passes are enough to place ANY marking state exactly, without ever measuring
// again inside the hot loop.
//
// Ink, not boxes. The `.rw` padding is whitespace and may hang off the field;
// a letter may not. Measuring the padded box is what let words run off a phone.
function measureRibbon(){
  const rb=$("ribbon"), stage=$("stage");
  rb.style.fontSize="";                                  // measure at the base size
  rb.style.transform="translate(0px, -50%)";              // a known frame for the maths
  ribbonOffset = 0;
  const els=[...rb.children];
  const rbRect = rb.getBoundingClientRect();             // pass 1 (plain)
  const left=[], w=[], preL=[], wPre=[], wPiv=[], wPost=[], inkL=[], inkR=[];
  for(const el of els){
    const r=el.getBoundingClientRect();
    left.push(r.left-rbRect.left); w.push(r.width);
    const pre=el.firstChild.getBoundingClientRect();
    const piv=el.children[1].getBoundingClientRect();
    const post=el.children[2].getBoundingClientRect();
    preL.push(pre.left-rbRect.left); wPre.push(pre.width);
    wPiv.push(piv.width); wPost.push(post.width);
    // a zero-width prefix still starts where the pivot does, so derive the ink
    // span from the three spans rather than trusting the padded element box
    const l = pre.width ? pre.left-rbRect.left : piv.left-rbRect.left;
    inkL.push(l);
    inkR.push(l + pre.width + piv.width + post.width);
  }
  rb.classList.add("mb");
  const wPivB = els.map(el=>el.children[1].getBoundingClientRect().width);  // pass 2 (bold)
  rb.classList.remove("mb");

  const sr = stage.getBoundingClientRect();
  const axisFrac = axisFraction(getComputedStyle(stage).getPropertyValue("--axis-x"));
  const field = Math.max(1, stage.clientWidth - 2*FIELD_INSET_PX);
  const basePx = parseFloat(getComputedStyle(rb).fontSize) || 40;

  G = { els, left, w, preL, wPre, wPiv, wPivB, wPost, inkL, inkR, marked:[],
        l0: rbRect.left, axisFrac, field, basePx,
        axisX: sr.left + sr.width*axisFrac, scale: 1 };

  // One scale for the window, set by its widest SINGLE word. A word cannot be
  // split, so it is the only thing allowed to force the type down.
  const halves = els.map((_,i)=>halvesFor(G, i));
  G.scale = windowScale(halves, axisFrac, field, basePx);
  rb.style.fontSize = G.scale < 1 ? (basePx*G.scale)+"px" : "";
}
```

- [ ] **Step 3: Place against the axis, scaling the cached numbers**

Replace `placeRibbon` (js/app.js:162-188) entirely:

```javascript
// Pure placement from the cache. ORP: the current word's bold pivot centre on
// the axis. RSVP/Hybrid: the chunk as an optical block (Hybrid's bold pivots
// widen it, and the widths are known, so the edges are computed, not read).
// Every cached number was measured at the base size, so one multiply by G.scale
// converts it. No measuring, no forced reflow.
function placeRibbon(){
  if(!G) return;
  const rb=$("ribbon");
  const i0 = S.index - ribbonStart;
  if(i0<0 || i0>=G.left.length) return;
  const k = G.scale;
  let anchorRel;
  if(S.mode==="orp"){
    anchorRel = G.preL[i0] + G.wPre[i0] + G.wPivB[i0]/2;
  } else {
    const last = Math.min(S.index+chunkNow(), S.tokens.length) - ribbonStart - 1;
    const lastC = Math.min(last, G.left.length-1);
    let grow = 0;
    if(S.mode==="hybrid") for(let x=i0;x<=lastC;x++) grow += G.wPivB[x]-G.wPiv[x];
    anchorRel = (G.inkL[i0] + G.inkR[lastC] + grow)/2;
  }
  const target = Math.round((G.axisX - G.l0 - anchorRel*k)*100)/100;
  rb.style.transform = `translate(${target}px, -50%)`;
  ribbonOffset = target;
}
```

Add a `chunkNow` helper directly above `placeRibbon`. In this task it simply returns the preference; Task 6 gives it the fitting behaviour:

```javascript
// How many words this beat actually shows. Task 6 makes this fit-aware; until
// then it is the stored preference.
function chunkNow(){ return S.chunk; }
```

- [ ] **Step 4: Invalidate when the axis moves**

`setMode` changes `--axis-x` on phones, which moves `G.axisX` and `G.field`. In `js/app.js`'s `setMode`, change the final line from:

```javascript
  if(!$("ribbon").classList.contains("hidden")) render();   // re-centre if currently showing
```

to:

```javascript
  invalidateRibbon();   // --axis-x moves with the mode, so cached geometry is stale
  if(!$("ribbon").classList.contains("hidden")) render();   // re-place if currently showing
```

Also remove the now-stale `ribbonScaled` bookkeeping from `invalidateRibbon`'s neighbourhood: delete the `let ribbonScaled = false;` declaration at js/app.js:118 and its comment. Task 5 removes its last readers.

- [ ] **Step 5: Verify**

Run: `npm test`
Expected: all files pass.

Run: `npm run test:e2e`
Expected: 19/19. The pivot-lock assertion still measures against the stage centre and desktop keeps `--axis-x:50%`, so it holds.

- [ ] **Step 6: Bump the service worker and commit**

```bash
npm run sw:bump
git add js/app.js js/field.js sw.js README.md
git commit -m "feat(field): the ribbon places against the axis, one size per window"
```

---

### Task 5: Delete the per-word measuring fallback

**Files:**
- Modify: `js/app.js` (delete `fitRibbon` and `centerRibbon`)

**Interfaces:**
- Consumes: Task 4's `placeRibbon`, which no longer calls either function.
- Produces: nothing new. Removes `fitRibbon` and `centerRibbon` from the module.

Task 4 stopped calling these. They were the only measuring code left in the hot path, costing two forced synchronous reflows per tick for long words, which the 2026-07-17 perf pass had removed everywhere else. `windowScale` now covers their job at rebuild time.

- [ ] **Step 1: Confirm nothing calls them**

Run: `grep -n "fitRibbon\|centerRibbon\|ribbonScaled" js/*.js test/*.mjs test/e2e/*.mjs`
Expected: only the two function definitions themselves in `js/app.js`. If any caller remains, stop and fix Task 4 instead of deleting.

- [ ] **Step 2: Delete both functions**

Remove `centerRibbon` (the whole function and its leading comment block, js/app.js around lines 210-240) and `fitRibbon` (the whole function and its leading comment block, around lines 241-263).

Keep the comment above `markChunk`, but correct its last sentence, which now names a deleted function. Change:

```javascript
// eye's hops); RSVP stays unaccented. Classes go on before fitRibbon measures,
// so the bold anchors are part of the measured width.
```

to:

```javascript
// eye's hops); RSVP stays unaccented. The bold-pivot widths are cached, so the
// anchors are part of the computed width without measuring.
```

- [ ] **Step 3: Verify the hot path no longer measures**

Run: `grep -c "getBoundingClientRect" js/app.js`

Then confirm none of the remaining calls sit inside `placeRibbon`, `markChunk` or `render`:

```bash
node -e '
const src = require("fs").readFileSync("js/app.js","utf8");
for (const fn of ["placeRibbon","markChunk","render"]) {
  const i = src.indexOf("function "+fn+"(");
  if (i < 0) { console.error("missing "+fn); process.exit(1); }
  // read to the next top-level function declaration
  const j = src.indexOf("\nfunction ", i+1);
  const body = src.slice(i, j < 0 ? undefined : j);
  if (body.includes("getBoundingClientRect")) { console.error(fn+" still measures"); process.exit(1); }
}
console.log("hot path is measurement-free");
'
```

Expected: `hot path is measurement-free`

- [ ] **Step 4: Run the suites**

Run: `npm test && npm run test:e2e`
Expected: all units pass, 19/19 e2e.

- [ ] **Step 5: Commit**

```bash
npm run sw:bump
git add js/app.js sw.js
git commit -m "refactor(field): drop the per-word measuring fallback"
```

---

### Task 6: The phrase yields before the type does

**Files:**
- Modify: `js/app.js` (`chunkNow`, `render`, `markChunk`, `step`)
- Modify: `index.html:511-518` (chunk label), `:614` (About copy)

**Interfaces:**
- Consumes: `chunkFit` from Task 2; `G` and `chunkNow` from Task 4.
- Produces: `S.chunkNow`, the word count for the current beat. `S.chunk` keeps its meaning as the stored maximum, so `fp_prefs` and backups are untouched.

- [ ] **Step 1: Make `chunkNow` fit-aware**

Import `chunkFit` by extending the `./field.js` import line in `js/app.js`:

```javascript
import { axisFraction, halvesFor, windowScale, chunkFit, FIELD_INSET_PX } from "./field.js";
```

Replace the placeholder `chunkNow` from Task 4:

```javascript
// How many words this beat actually shows. The reader's chunk is a MAXIMUM: the
// phrase yields words before the type yields size, so the chosen reading size
// stays the invariant and the beat length adapts to the screen. ORP is one word
// by definition and never asks.
function chunkNow(){
  if(S.mode==="orp") return 1;
  if(!G) return S.chunk;
  const i0 = S.index - ribbonStart;
  if(i0<0 || i0>=G.inkL.length) return S.chunk;
  // the cache is measured at base size; the field shrinks by the window scale
  const field = G.field / (G.scale || 1);
  return chunkFit(G, i0, S.chunk, G.axisFrac, field, S.mode==="hybrid");
}
```

- [ ] **Step 2: Resolve it once per beat**

`chunkNow()` must be computed once and reused, so `markChunk`, `placeRibbon` and `step` all agree within a beat. In `render` (js/app.js around line 265), set it before marking:

```javascript
function render(){
  if(!S.tokens.length || S.index>=S.tokens.length) return;
  $("resting").classList.add("hidden");
  $("word").classList.add("hidden");
  const rb=$("ribbon"); rb.classList.remove("hidden");
  rb.classList.toggle("no-ctx", !settings.context);
  rb.classList.toggle("playing", S.playing);
  if(ribbonLast<0 || S.index<ribbonStart || (S.index+S.chunk-1) > ribbonLast-2) buildRibbon();
  S.chunkNow = chunkNow();          // one answer per beat: marking, placing and pacing must agree
  markChunk();
  placeRibbon();
}
```

In `markChunk`, change the end of the chunk from the preference to the resolved count:

```javascript
  const endChunk = Math.min(S.index+(S.chunkNow||S.chunk), S.tokens.length);
```

In `placeRibbon`, replace the `chunkNow()` call added in Task 4 with the resolved value:

```javascript
    const last = Math.min(S.index+(S.chunkNow||S.chunk), S.tokens.length) - ribbonStart - 1;
```

- [ ] **Step 3: Pace and advance by the resolved count**

In `step` (js/app.js:278-318), `render()` runs first and has already set `S.chunkNow`. Replace the four uses of `S.chunk`:

```javascript
function step(){
  if(S.index>=S.tokens.length){ finish(); return; }   // reached the end
  render();
  const n = S.chunkNow || S.chunk;    // render resolved how many words this beat shows
  const chunkTokens = S.tokens.slice(S.index, S.index+n);
```

then, further down:

```javascript
  if(sp && isUnitEnd(S.index + n)) delay += perWord*1.1;

  const prev = S.index;
  S.index += n;
```

Everything else in `step` is unchanged, including the `blocksToHandle(S.sortedBlocks, prev, S.index, ...)` drain, which already works from `prev` to the new `S.index` and so follows the resolved count for free.

- [ ] **Step 4: Initialise the field on state**

In the `S` state object literal near the top of `js/app.js`, next to `chunk`, add:

```javascript
  chunkNow:1,
```

- [ ] **Step 5: Follow the semantics in copy**

In `index.html`, change the chunk control label (line 512) from `Chunk` to say what it now means:

```html
            <label>Words at once</label>
```

and add the maximum semantics to the segment's accessible name (line 513):

```html
            <div class="seg" id="chunkSeg" aria-label="Words at once, at most">
```

In the About modal (line 614), the RSVP line currently says "A few words at once, for a faster, more natural rhythm." Make it honest about the screen:

```html
      <div class="about-item"><span class="ai-k">In small phrases</span><span class="ai-v">A few words at once, for a faster, more natural rhythm. As many as the screen can hold at your reading size. <em>RSVP</em></span></div>
```

Line 615's Hybrid copy already says "Short phrases", which stays true. Leave it.

- [ ] **Step 6: Verify**

Run: `npm test`
Expected: all pass.

Run: `npm run test:e2e`
Expected: 19/19. The RSVP and Hybrid block-centring assertions still hold, because on the 1280-wide e2e window `chunkFit` returns the full requested chunk.

- [ ] **Step 7: Commit**

```bash
npm run sw:bump
git add js/app.js index.html sw.js
git commit -m "feat(field): the phrase yields words before the type yields size"
```

---

### Task 7: The fade stops eating the word, and the e2e proves it

**Files:**
- Modify: `styles.css:817-819` (phone mask), the landscape mask around `:1001`
- Modify: `test/e2e/smoke.mjs` (new phone flow)

**Interfaces:**
- Consumes: everything from Tasks 3-6.
- Produces: a phone e2e flow named "flow C" asserting the field invariants.

- [ ] **Step 1: Pull the mask back off the focal word**

The phone mask reaches full opacity only between 34% and 66%, a 132px band on a 390px screen, so any focal word wider than that has its own ink dissolved. Neighbour dimming is already opacity's job (.14 playing, .34 paused); the mask only needs to stop a hard cut at the screen edge.

Replace the phone `.ribbon-clip` rule (styles.css:817-819) and its comment:

```css
    /* The mask's only job is to stop a hard cut at the screen edge. It must never
       touch the focal word, which on a phone can span nearly the whole field, so
       the clear band covers the field and only the last few percent dissolves.
       Neighbour context is dimmed by opacity, not by this mask. The stops are
       asymmetric because the axis is: words grow rightward from the pivot. */
    .stage .ribbon-clip{
      -webkit-mask-image:linear-gradient(90deg,transparent 0,#000 4%,#000 96%,transparent 100%);
              mask-image:linear-gradient(90deg,transparent 0,#000 4%,#000 96%,transparent 100%);
    }
```

Apply the same treatment to the landscape mask (the `.stage .ribbon-clip` rule inside the `@media (max-height:600px)` block around line 1001), where neighbours are currently sliced mid-letter. Read the existing rule first and keep its structure, changing only the stops to `transparent 0,#000 4%,#000 96%,transparent 100%`.

- [ ] **Step 2: Write the failing e2e flow**

In `test/e2e/smoke.mjs`, after flow B's last assertion and before the `} finally {`, add a phone flow. It uses the existing `openPage` helper plus two CDP calls for device emulation.

```javascript
    /* ----- flow C: the phone reading field ----- */
    console.log("\nflow C — phone field: no ink escapes, the pivot rides the axis");
    const C = await openPage(cdp);
    const setViewport = (w, h) => cdp.send("Emulation.setDeviceMetricsOverride",
      { width: w, height: h, deviceScaleFactor: 2, mobile: true }, C.sessionId);
    // ordinary English, not exotic: these are the words that break today
    const LONG = "The development of understanding between different people takes "
      + "time and particularly careful information about responsibilities. ";
    for (const [w, h] of [[320, 720], [390, 844], [430, 932], [844, 390]]) {
      await setViewport(w, h);
      await C.goto(BASE);
      await C.waitFor(`document.getElementById("dropzone") !== null`);
      await C.evalIn(`document.fonts.ready.then(()=>true)`);
      await C.evalIn(`document.getElementById("paste").value = ${JSON.stringify(LONG.repeat(4))}; document.getElementById("pasteGo").click();`);
      await C.waitFor(`document.getElementById("reader").classList.contains("show")`);
      await C.evalIn(`document.getElementById("playBtn").click();`);
      await C.waitFor(`!!document.querySelector(".rw.on")`);
      await C.evalIn(`document.getElementById("playBtn").click(); true`);
      await C.waitFor(`document.getElementById("playBtn").getAttribute("aria-label")==="Play"`);

      for (const mode of ["orp", "rsvp", "hybrid"]) {
        // sweep the whole size ladder and every word in a long window
        const r = await C.evalIn(`(async()=>{
          document.querySelector('#modeSeg button[data-mode="${mode}"]').click();
          const out = { worstOverflow: 0, worstAxis: 0, sizes: {}, monotonic: true };
          for(const s of [44,62,82,104]){
            document.querySelector('#sizeSeg button[data-s="'+s+'"]').click();
            await new Promise(r=>setTimeout(r,90));
            let seen = 0;
            for(let step=0; step<10; step++){
              const stage=document.getElementById("stage");
              const sr=stage.getBoundingClientRect();
              const marked=[...document.querySelectorAll(".rw.on")];
              if(!marked.length) break;
              // ink extents of the marked chunk, from the letter spans only
              let lo=Infinity, hi=-Infinity;
              for(const el of marked){
                for(const sp of el.children){
                  const b=sp.getBoundingClientRect();
                  if(!b.width) continue;
                  if(b.left<lo) lo=b.left;
                  if(b.right>hi) hi=b.right;
                }
              }
              if(hi>lo){
                out.worstOverflow = Math.max(out.worstOverflow, sr.left-lo, hi-(sr.right));
                seen = parseFloat(getComputedStyle(document.getElementById("ribbon")).fontSize);
              }
              if("${mode}"==="orp"){
                const p=document.querySelector(".rw.pivot .rpiv");
                if(p){
                  const b=p.getBoundingClientRect();
                  const frac=parseFloat(getComputedStyle(stage).getPropertyValue("--axis-x"))/100;
                  const axis=sr.left + sr.width*(isFinite(frac)?frac:0.5);
                  out.worstAxis = Math.max(out.worstAxis, Math.abs((b.left+b.width/2)-axis));
                }
              }
              document.getElementById("fwdBtn").click();
              await new Promise(r=>setTimeout(r,60));
            }
            out.sizes[s]=seen;
          }
          const ladder=[44,62,82,104].map(s=>out.sizes[s]);
          for(let i=1;i<ladder.length;i++) if(ladder[i] < ladder[i-1]-0.01) out.monotonic=false;
          return out;})()`);
        ok(r.worstOverflow <= 1.0, `${w}x${h} ${mode}: focal ink stays in the field`,
          `overflow ${r.worstOverflow.toFixed(1)}px`);
        if (mode === "orp")
          ok(r.worstAxis < 0.6, `${w}x${h} orp: pivot rides the axis`, `drift ${r.worstAxis.toFixed(2)}px`);
        ok(r.monotonic, `${w}x${h} ${mode}: the size ladder never goes backwards`,
          JSON.stringify(r.sizes));
      }
    }
    ok(C.consoleErrors.length === 0, "no console errors in flow C", C.consoleErrors.join(" | ").slice(0, 300));
```

`openPage` must expose `sessionId` for `setViewport`. In `openPage`'s return object (test/e2e/smoke.mjs around line 126), add `sessionId` to the returned properties:

```javascript
  return { goto, evalIn, waitFor, consoleErrors, exceptions, sessionId };
```

Check the transport button's real id before running: the plan assumes `fwdBtn`. Run `grep -n 'id="fwd\|id="back\|forwardBtn' index.html` and use the actual id.

- [ ] **Step 3: Run the flow and watch it fail on the unfixed parts**

Run: `npm run test:e2e`
Expected: flow C runs. Any failure here is a real defect to fix, most likely the largest sizes on the narrowest screen. Read the reported overflow, adjust the `--axis-x` fraction and `FIELD_INSET_PX` if the miss is small (a few px), or fix the placement maths if it is large.

- [ ] **Step 4: Tune the axis fraction against the results**

The spec set 33% as a starting value. With flow C green, sweep the fraction to pick the final value: set `--axis-x` in the phone block to 30%, 33% and 36% in turn, run `npm run test:e2e` for each, and keep the largest value that stays green at every breakpoint (a larger fraction is closer to centred, so it looks less deliberate only when it has to). Record the chosen value in the spec's §1 where it says it will be recorded when settled.

- [ ] **Step 5: Commit**

```bash
npm run sw:bump
git add styles.css test/e2e/smoke.mjs docs/superpowers/specs/2026-07-30-phone-reading-field-design.md sw.js
git commit -m "fix(field): the edge dissolve stops eating the focal word"
```

---

### Task 8: Visual pass and the approved polish

**Files:**
- Modify: `styles.css` (aids segment, `hero-demo` axis)
- Modify: `docs/superpowers/specs/2026-07-30-phone-reading-field-design.md` (record what shipped)

**Interfaces:**
- Consumes: the finished field from Tasks 3-7.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Screenshot every breakpoint and look at them**

Use the probe harness pattern already proven this session. Write `test/e2e/shots.mjs` only if you want it kept; otherwise a scratch script is fine. Capture 320, 390, 430 portrait and 844x390 landscape, in ORP/RSVP/Hybrid, at sizes S and XL, with a long word on the focal point. Look at every image before continuing. You are checking three things: the word reads whole, the axis looks deliberate rather than accidental, and the guides/halo/baseline still form one crosshair.

- [ ] **Step 2: The aids segment**

The aids control is five chips, four of them filled amethyst by default, which reads as a wall of purple, and `Chapter rest` is orphaned on its own full-width row by the `flex:1 1 40%` two-up rule.

In the phone block's `.controls.more .seg.multi button{flex:1 1 40%;}` rule (styles.css around line 900), the comment says "four switches settle 2x2". There are five now. Change the basis so five chips settle without an orphan:

```css
    /* five switches, so a 2-2-1 grid would orphan the last one. A third basis
       settles them 2-2-1 with the last chip full width by intent, not by accident. */
    .controls.more .seg.multi button{flex:1 1 40%;}
    .controls.more .seg.multi button:last-child{flex-basis:100%;}
```

For the purple weight: the active state currently fills. Keep the fill (it is the established active language elsewhere in the app) but verify against the screenshots whether five filled chips at once is too heavy. If it is, reduce only the aids segment's active fill opacity, leaving `.seg` elsewhere untouched, and note the decision in the spec.

- [ ] **Step 3: The landing's mini stage**

`.hero-demo` (styles.css:219-227) previews the reader with its own centred guide at `left:50%`. On a phone the reader's axis is no longer centred, so the preview misrepresents it. Make the mini stage's guide and focal word read the same token, scoped to the phone block so desktop is untouched:

```css
    .hero-demo{--axis-x:33%;}
    .hero-demo .hd-guide{left:var(--axis-x,50%);}
```

Check the hero word markup first with `grep -n 'hero-demo' -A 8 index.html` and move whatever carries the focal word onto the token the same way. If the hero demo shows a phrase rather than a single ORP word, leave it centred and record that in the spec instead.

- [ ] **Step 4: Record what shipped**

Update the spec's §1 with the axis fraction chosen in Task 7 Step 4, and add a short "What shipped" section noting anything decided differently during implementation. Keep the copy rules: no em dashes.

- [ ] **Step 5: Full verification**

Run: `npm test`
Expected: all files pass.

Run: `npm run test:e2e`
Expected: every flow green, including flow C at all four viewports.

Run: `npm run sw:check`
Expected: no drift. If it reports drift, run `npm run sw:bump` and include it in the commit.

- [ ] **Step 6: Commit**

```bash
git add styles.css docs/superpowers/specs/2026-07-30-phone-reading-field-design.md sw.js
git commit -m "polish(field): the visual pass and the aids segment"
```

---

### Task 9: Open the pull request

**Files:** none.

**Interfaces:**
- Consumes: Tasks 1-8, all committed on `feat/phone-reading-field`.

- [ ] **Step 1: Confirm the branch is clean and trailer-free**

```bash
git status --short
git log --format='%s' origin/main..HEAD
git log origin/main..HEAD --format='%B' | grep -ci "co-authored" || echo "trailers clean"
```

Expected: no uncommitted changes, one commit per concern, and `trailers clean`. If any commit carries a trailer, rewrite the branch before pushing.

- [ ] **Step 2: Verify against the live site's baseline one more time**

```bash
npm test && npm run test:e2e && npm run sw:check
```

Expected: all green.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/phone-reading-field
```

Then open a PR whose body states the measured before and after (`developme` at a shrunk 55px, against the whole word at 62px), lists the four defects fixed, and notes that the chunk change in Task 6 is independently revertable. End the body with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

Do not add a `Co-Authored-By` trailer to any commit.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1 The reading axis becomes a token | 3 (CSS + `data-mode`), 4 (`axisX` in placement) |
| §1 landscape keeps 50% | 3 Step 2 (width query only), 7 Step 2 (844x390 asserted) |
| §1 countdown rides the axis | 3 Step 1 (`.word` absolute on the token) |
| §1 `invalidateRibbon` on mode change | 4 Step 4 |
| §2 `fitsAxis`, pivot-relative | 1 |
| §2 measured on ink, post-span cached | 4 Step 2 (`inkL`/`inkR`/`wPost`) |
| §2 field less a safe inset | 1 (`FIELD_INSET_PX`), 4 Step 2 |
| §3 `G.scale`, one per window | 4 Step 2 |
| §3 single words never phrases | 1 (`windowScale` doc), 4 Step 2 (`halvesFor` per word) |
| §3 scale floor at 22px | 1 (`SCALE_FLOOR_PX`) |
| §3 `fitRibbon`/`centerRibbon` deleted | 5 |
| §3 scale change is instant | Global Constraints (no transition on reading font size) |
| §4 mask pulled back, asymmetric | 7 Step 1 |
| §4 landscape neighbours | 7 Step 1 |
| §5 `chunkFit`, phrase yields first | 2 (pure), 6 (threaded) |
| §5 `S.chunkNow` through step/render/markChunk/placeRibbon/isUnitEnd/blocksToHandle | 6 Steps 2-3 |
| §5 `S.chunk` keeps its stored meaning | 6 Step 1 + Global Constraints |
| §5 copy says "up to N words" | 6 Step 5 |
| §6 aids chip wall | 8 Step 2 |
| §6 `hero-demo` mirrors the axis | 8 Step 3 |
| §6 motion doctrine | Global Constraints |
| §7 unit tests for pure functions | 1, 2 |
| §7 e2e sweep, no ink outside field | 7 Step 2 |
| §7 no ink under a faded mask stop | 7 Step 1 makes the field fully opaque, so §7's overflow check covers it |
| §7 pivot on axis, sub-pixel | 7 Step 2 |
| §7 size ladder monotonic | 7 Step 2 |
| §7 screenshots | 8 Step 1 |

**Placeholder scan:** No TBD or TODO. Two steps deliberately require the implementer to read the existing code before editing (Task 7 Step 1 landscape mask, Task 8 Step 3 hero markup) and both state what to do in each outcome, rather than leaving it open.

**Type consistency checked:** `halvesFor(m,i)` reads `preL`, `wPre`, `wPivB`, `wPiv`, `inkL`, `inkR`, and `G` in Task 4 provides all six under those exact names. `blockHalves(m,i,count,hybrid)` and `chunkFit(m,start,maxChunk,axisFrac,field,hybrid)` are called with that argument order in Task 6. `windowScale(halvesList,axisFrac,field,basePx)` is called with `basePx` from `getComputedStyle`, matching Task 1's floor arithmetic. `S.chunkNow` is written in `render` and read in `markChunk`, `placeRibbon` and `step`, all guarded with `|| S.chunk`. Task 4's placeholder `chunkNow()` is replaced, not duplicated, in Task 6.

**One risk called out for the executor:** Task 6 changes reading rhythm on phones and touches the playback loop. It is the last functional task precisely so it can be reverted alone without disturbing Tasks 3-5.
