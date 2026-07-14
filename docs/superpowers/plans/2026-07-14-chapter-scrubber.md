# Chapter-Scoped Scrubber Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The dock scrubber (bar + flank times) and the top-right meta line describe the current chapter, Audible-style; structure-less documents keep today's whole-book behavior.

**Architecture:** A pure `chapterGrid()` helper in `js/text.js` turns (kind, nav, units, total) into `[{title, start, end}]` segments once per document open; `updateProgress()`, drag scrub, and keyboard scrub become grid-driven with zero special cases (book-scope = a single segment). Spec: `docs/superpowers/specs/2026-07-14-chapter-scrubber-design.md`.

**Tech Stack:** Vanilla ES modules, no build step. Unit tests: `node:test` (`test/toc.test.mjs`). E2E: raw-CDP headless Chrome (Node 24 built-in WebSocket) against `python3 -m http.server`.

## Global Constraints

- No Co-Authored-By trailers on commits in this repo (standing user rule, 2026-07-13).
- No em dashes or rule-of-three lists in any user-facing copy.
- Commit style: `type(scope): lowercase evocative-but-precise description`.
- Library rows, done card, streak, resume: untouched.
- `sw.js` CACHE_VERSION bumps v44 → v45 exactly once, in the final task.

---

### Task 1: `chapterGrid` + `chapterAt` (pure helpers)

**Files:**
- Modify: `js/text.js` (after `chapterItems`, ~line 40)
- Test: `test/toc.test.mjs` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces: `chapterGrid(kind, nav, units, total) -> [{title:string|null, start:int, end:int}]` (end exclusive, ≥1 segment always, segments cover [0,total) exactly) and `chapterAt(grid, index) -> int` (segment index, clamped). Task 2 imports both from `./text.js`.

- [ ] **Step 1: Write the failing tests**

Append to `test/toc.test.mjs`:

```js
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
    { start: 600, title: "B2" },   // zero-length after sort: dropped
    { start: 5000, title: "Ghost" }, // beyond total: dropped
  ];
  const g = chapterGrid("epub", messy, [], 1000);
  assert.deepEqual(g.map(s => s.title), [null, "A", "B"]);
  assert.deepEqual(g.map(s => s.end), [100, 600, 1000]);
  // everything degenerate → whole book
  assert.deepEqual(chapterGrid("epub", [{ start: 0, title: "X" }, { start: 0, title: "Y" }], [], 100),
    [{ title: null, start: 0, end: 100 }]);
});

test("chapterAt clamps and lands on boundaries correctly", () => {
  const g = chapterGrid("epub", nav, [], 1500);
  assert.equal(chapterAt(g, -5), 0);
  assert.equal(chapterAt(g, 0), 0);
  assert.equal(chapterAt(g, 199), 0);
  assert.equal(chapterAt(g, 200), 1);   // boundary belongs to the next chapter
  assert.equal(chapterAt(g, 899), 1);
  assert.equal(chapterAt(g, 1499), 2);
  assert.equal(chapterAt(g, 99999), 2); // past the end: last segment
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node test/toc.test.mjs`
Expected: FAIL — `SyntaxError` / `does not provide an export named 'chapterGrid'`.

- [ ] **Step 3: Implement in `js/text.js`**

Insert after the `chapterItems` function:

```js
/* ---------------- chapter grid (scrubber scope) ---------------- */
// Segments the token stream into chapters for the dock scrubber. The declared
// ToC (nav) is the real chapter list — Calibre-split spines are size-based, so
// spine units are only trusted for EPUBs, and PDF page-units never (a per-page
// bar would reset every ~250 words). No usable structure → one whole-book
// segment, which keeps today's behavior with zero special cases downstream.
export function chapterGrid(kind, nav, units, total){
  const book = [{ title: null, start: 0, end: total }];
  const fromEntries = (entries)=>{
    const sorted = entries
      .map(e => ({ title: e.title, start: Math.max(0, Math.min(total, e.start)) }))
      .sort((a,b) => a.start - b.start);
    if(!sorted.length || sorted[0].start > 0) sorted.unshift({ title: null, start: 0 });
    const segs = [];
    for(let k = 0; k < sorted.length; k++){
      const end = k + 1 < sorted.length ? sorted[k+1].start : total;
      if(end > sorted[k].start) segs.push({ title: sorted[k].title, start: sorted[k].start, end });
    }
    return segs;
  };
  if(Array.isArray(nav) && nav.length >= 2){
    const segs = fromEntries(nav);
    if(segs.length >= 2) return segs;
  }
  if(kind === "epub" && Array.isArray(units) && units.length >= 2){
    const segs = fromEntries(units);
    if(segs.length >= 2) return segs;
  }
  return book;
}

// Segment index for a token position; clamps below 0 and past the last end.
export function chapterAt(grid, index){
  let k = 0;
  for(let i = 0; i < grid.length; i++){ if(grid[i].start <= index) k = i; else break; }
  return k;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test/toc.test.mjs`
Expected: all tests pass (4 existing + 7 new). Then `npm test` — everything green.

- [ ] **Step 5: Commit**

```bash
git add js/text.js test/toc.test.mjs
git commit -m "feat(chapters): a pure grid that knows where chapters begin and end"
```

---

### Task 2: Grid-driven scrubber, meta line, and scrub inputs in `js/app.js`

**Files:**
- Modify: `js/app.js` — import line (2), `S` literal (~16), `updateProgress` (~675), `openReader` (~842) + its 8 callsites (922, 929, 932, 1002, 1007, 1399, 1408), `scrubTo` + track keydown (~1609-1631)

**Interfaces:**
- Consumes: `chapterGrid(kind, nav, units, total)`, `chapterAt(grid, index)` from Task 1.
- Produces: `S.chapters` (grid array) and `S.curCh` (int, -1 = unset) for anyone reading reader state. `openReader` signature becomes `openReader(tokens, units, title, meta, key, blocks, nav, kind)` with `kind ∈ "pdf"|"epub"|"text"`.

- [ ] **Step 1: Import the helpers**

Line 2 of `js/app.js` becomes:

```js
import { tokenize, orpIndex, esc, DEMO, HERO, sentenceFactors, sentenceStart, sentenceEnd, chapterItems, chapterGrid, chapterAt } from "./text.js";
```

- [ ] **Step 2: Add reader state**

In the `S` literal, after the `units:` line, add:

```js
  chapters: [{ title: null, start: 0, end: 1 }], // chapterGrid() — scrubber scope
  curCh: -1,           // current chapter segment (-1 = force meta refresh)
```

- [ ] **Step 3: Compute the grid at open + reset the cache**

In `openReader`, the signature line becomes:

```js
function openReader(tokens, units, title, meta, key, blocks, nav, kind){
```

Directly after the `S.nav = ...` line, add:

```js
  S.chapters = chapterGrid(kind, S.nav, S.units, tokens.length);
  S.curCh = -1;   // first updateProgress sets the meta line
```

- [ ] **Step 4: Pass `kind` at all 8 callsites**

Each `openReader(...)` call gains trailing arguments so `kind` lands in position 8. Text callers currently stop at `key`; they pass empty blocks and null nav explicitly:

- line 922: `openReader(toks,[{title:"Pasted text",start:0}],item.title,`TEXT · ${toks.length.toLocaleString()} words`,item.key,[],null,"text");`
- line 929: append `,"pdf"` after `nav`
- line 932: append `,"epub"` after `nav`
- line 1002: append `,"pdf"` after `nav`
- line 1007: append `,"epub"` after `nav`
- line 1399: `...,key,[],null,"text");`
- line 1408: `...,key,[],null,"text");`

- [ ] **Step 5: Make `updateProgress` grid-driven**

The first eight lines of `updateProgress` (through the `tLeft` assignment) become:

```js
function updateProgress(){
  const total = S.tokens.length||1;
  const grid = (S.chapters && S.chapters.length) ? S.chapters : [{title:null,start:0,end:total}];
  const k = chapterAt(grid, S.index);
  const seg = grid[k];
  const span = Math.max(1, seg.end - seg.start);
  const pct = Math.min(100, ((S.index - seg.start)/span)*100);
  $("trackFill").style.width = pct+"%";
  $("trackKnob").style.left = pct+"%";
  const tk=$("track"); tk.setAttribute("aria-valuenow", Math.round(pct));
  tk.setAttribute("aria-valuetext", Math.round(pct) + (seg.title ? "% of "+seg.title : "% read"));
  $("tElapsed").textContent = fmt((S.index - seg.start)/S.wpm*60);
  $("tLeft").textContent = "-"+fmt((seg.end - S.index)/S.wpm*60);
  // the top-right meta line names the chapter the bar describes (book-scope
  // documents keep the static parse meta: "EPUB · 12 chapters · 84,120 words")
  if(k !== S.curCh){ S.curCh = k; $("docMeta").textContent = seg.title || S.meta; }
```

Everything from `if(S.units.length>1){` down is untouched (units still drive the ToC current-row + chapter-appendix toast).

- [ ] **Step 6: Chapter-scope the drag scrub**

`scrubTo` becomes:

```js
  const scrubTo=(clientX)=>{ const r=track.getBoundingClientRect(); const p=Math.max(0,Math.min(1,(clientX-r.left)/r.width));
    const seg=S.chapters[chapterAt(S.chapters,S.index)];
    jumpTo(seg.start + Math.round(p*(seg.end-seg.start))); };
```

(Releasing at the far right lands on `seg.end`, the next chapter's first word — the bar then shows 0% of the next chapter. `jumpTo` already clamps to the last token.)

- [ ] **Step 7: Chapter-scope the keyboard scrub**

The track keydown handler's body down to `handled=false` becomes:

```js
  track.addEventListener("keydown",e=>{
    if(S.tokens.length<2) return;
    const seg=S.chapters[chapterAt(S.chapters,S.index)];
    const step=Math.max(1, Math.round((seg.end-seg.start)*0.02));
    let handled=true;
    if(e.code==="ArrowLeft"||e.code==="ArrowDown") jumpTo(S.index-step);
    else if(e.code==="ArrowRight"||e.code==="ArrowUp") jumpTo(S.index+step);
    else if(e.code==="Home") jumpTo(seg.start);
    else if(e.code==="End") jumpTo(seg.end-1);
    else handled=false;   // Space etc. falls through to play/pause
    if(handled){ e.preventDefault(); e.stopPropagation(); }
  });
```

(The comment above the handler becomes: `// keyboard scrubbing when the progress bar has focus (arrows step ~2% of the chapter, Home/End jump to its edges)`.)

- [ ] **Step 8: Full unit suite**

Run: `npm test`
Expected: all green (app.js has no node tests; this guards text.js and friends).

- [ ] **Step 9: Commit**

```bash
git add js/app.js
git commit -m "feat(scrub): the bar, the times and the meta line describe this chapter"
```

---

### Task 3: E2E verification, cache bump, ship

**Files:**
- Modify: `sw.js:6` (CACHE_VERSION v44 → v45)
- Create (scratchpad, not committed): `cdp-scrub.mjs` E2E script

**Interfaces:**
- Consumes: the running app (Tasks 1-2), `musashi-test.epub` fixture (zip of `~/Desktop/Musashi.epub`, rebuilt if missing), local server on :8111, headless Chrome CDP on :9223.
- Produces: a green E2E run, then the deployed site.

- [ ] **Step 1: Bump the service worker cache**

`sw.js` line 6 becomes:

```js
const CACHE_VERSION = "stillpoint-v45";
```

- [ ] **Step 2: Write the E2E script (scratchpad)**

Checks, against `http://127.0.0.1:8111` with the Musashi fixture loaded via `DOM.setFileInputFiles` on the drop-zone file input:

1. after parse, `#docMeta` text is a nav chapter title (not the static "EPUB · … words" string);
2. `#tLeft` reads a small chapter remainder (minutes at 400wpm, not `-1044:30`);
3. `Runtime.evaluate`: jump near a chapter boundary (`S` is module-scoped, so drive via the exposed DOM: focus `#track`, dispatch `End` keydown, then `ArrowRight`) — bar resets toward 0% and `#docMeta` swaps to the next chapter title;
4. `#track` `aria-valuetext` contains `% of `;
5. demo path (`#heroTry` click): `#docMeta` shows `TEXT · … words`, `aria-valuetext` ends `% read`, `#tLeft` equals the whole-passage time (book scope preserved);
6. zero console errors.

- [ ] **Step 3: Run the E2E**

Serve repo on :8111, launch headless Chrome on :9223, run the script.
Expected: all checks green, 0 console errors.

- [ ] **Step 4: Commit and deploy**

```bash
git add sw.js
git commit -m "chore(sw): v45 carries the chapter scrubber"
git push
```

Then poll `https://stillpointreader.com/sw.js` until it serves `stillpoint-v45` and spot-check `js/app.js` on the live origin contains `chapterAt`.
