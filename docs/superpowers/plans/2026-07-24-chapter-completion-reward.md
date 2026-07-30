# Chapter Completion Reward Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reward finishing a chapter (and a book) with a quiet in-flow beat and an accumulating artifact — a chapter-segmented spine per book and a shelf of finished books — all local and buildless.

**Architecture:** A new pure ES module `js/reward.js` owns a per-document "earned chapters" ledger (stored as one namespaced `read::<docKey>` IndexedDB record, like `hl::`/`blockmode::`) plus the pure functions that derive the spine bands, the shelf, and the beat copy. `js/app.js` credits a chapter only on a genuine playback crossing, plays the beat, and renders the spine and shelf. No new dependencies; the app still ships as plain files.

**Tech Stack:** Vanilla ES modules, IndexedDB (via `js/store.js`), `node:test` + `fake-indexeddb` for unit tests. No framework, no build step.

**Spec:** `docs/superpowers/specs/2026-07-24-chapter-completion-reward-design.md`

## Global Constraints

- Buildless: the shipped app is `index.html` + `styles.css` + ES modules in `js/`. Tests are dev-only. No runtime dependencies.
- No accounts, no server. All state is local (`localStorage` + IndexedDB). Nothing leaves the device.
- Reward data keys off the same `docKey` (`S.key`) that `hl::` and `blockmode::` already use.
- A chapter is credited only on a genuine playback crossing (`updateProgress` called with `throttled === true`), once each. The last chapter is credited in `finish()`.
- Never gate reading and never touch patron themes. Reading is identical for everyone.
- Copy voice (`.agents/product-marketing.md`): plain sentences, no em dashes, no rule-of-three lists.
- CSP: all JavaScript lives in external ES modules (no inline `<script>`). Inline `style` attributes are allowed.
- Respect `prefers-reduced-motion` in every animation.
- The service-worker `CACHE_VERSION` is content-derived. After all shell files are final, run `npm run sw:bump` (CI's `sw:check` fails otherwise).

---

## File Structure

- **Create `js/reward.js`** — pure core (`freshRec`, `creditChapter`, `markFinished`, `mergeRead`, `spineBands`, `spineHeight`, `shelfEntries`, `milestoneLine`) and the storage-backed `Reward` object (`hydrate`, `note`, `credit`, `finish`, `forDoc`, `shelf`, `exportAll`, `importMerge`). One responsibility: the chapter-completion ledger and its derived views.
- **Create `test/reward.test.mjs`** — unit tests, joining the suite in `npm test`.
- **Modify `js/store.js`** — add `getAllByPrefix(prefix)`.
- **Modify `js/app.js`** — boot hydrate, `Reward.note()` on load, credit on crossing + in `finish()`, the beat, the spine render, the shelf render, the settings toggle, the backup field.
- **Modify `index.html`** — `#chapterBeat` overlay in the stage, the `#shelf` section, a Pause-at-chapter-breaks aid toggle, a spine mount on the finish card.
- **Modify `styles.css`** — beat, spine, and shelf styles.
- **Modify `sw.js`** — add `js/reward.js` to `SHELL` (then bump).
- **Modify `package.json`** — add `test/reward.test.mjs` to the `test` script.

---

### Task 1: `Store.getAllByPrefix` helper

**Files:**
- Modify: `js/store.js` (add one method to the `Store` object, ~line 30)
- Test: `test/store.test.mjs` (append cases)

**Interfaces:**
- Produces: `Store.getAllByPrefix(prefix)` → `Promise<Array<{ key: string, val: any }>>`, where `key` is the stored key **with the prefix stripped**.

- [ ] **Step 1: Write the failing test** — append to `test/store.test.mjs` before the final `console.log`:

```js
await Store.put("read::doc-1", { chapters:[0,1] });
await Store.put("read::doc-2", { chapters:[0] });
await Store.put("hl::doc-1", [{ start:0, end:1 }]);
const rows = await Store.getAllByPrefix("read::");
ok(rows.length === 2, "getAllByPrefix returns only matching keys");
ok(rows.every(r => r.key === "doc-1" || r.key === "doc-2"), "getAllByPrefix strips the prefix");
ok(rows.find(r => r.key === "doc-1").val.chapters.length === 2, "getAllByPrefix returns the stored value");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/store.test.mjs`
Expected: FAIL — `Store.getAllByPrefix is not a function` (throws) or a failed `ok`.

- [ ] **Step 3: Write minimal implementation** — add to the `Store` object in `js/store.js` (after the `keys:` line):

```js
  // All records whose key starts with `prefix`, prefix stripped from the returned key.
  getAllByPrefix: (prefix)=> db().then(d => new Promise((resolve, reject)=>{
    const out = [];
    const req = d.transaction(STORE, "readonly").objectStore(STORE).openCursor();
    req.onsuccess = ()=>{ const c = req.result; if(!c){ resolve(out); return; }
      const k = String(c.key); if(k.startsWith(prefix)) out.push({ key: k.slice(prefix.length), val: c.value });
      c.continue(); };
    req.onerror = ()=> reject(req.error);
  })),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/store.test.mjs`
Expected: PASS — the final line reads `Store tests: N passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add js/store.js test/store.test.mjs
git commit -m "feat(store): getAllByPrefix for namespaced record scans"
```

---

### Task 2: reward.js pure core — ledger records

**Files:**
- Create: `js/reward.js`
- Create: `test/reward.test.mjs`
- Modify: `package.json` (add the test to the `test` script)

**Interfaces:**
- Produces:
  - `freshRec(key?) → { key, chapters:number[], bounds:number[]|null, total:number, title:string, kind:string, finishedAt:number|null }`
  - `creditChapter(rec, k:number) → rec` (immutable; `chapters` unioned + sorted; idempotent)
  - `markFinished(rec, lastK:number, when:number) → rec` (credits `lastK`; sets `finishedAt` only if not already set)
  - `mergeRead(local, imported) → rec` (chapters unioned; earliest non-null `finishedAt`; metadata from whichever side has it)

- [ ] **Step 1: Write the failing test** — create `test/reward.test.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/reward.test.mjs`
Expected: FAIL — `Cannot find module '../js/reward.js'`.

- [ ] **Step 3: Write minimal implementation** — create `js/reward.js`:

```js
/* Chapter completion reward — a per-document ledger of earned chapters.
   read::<docKey> = { chapters:[...], bounds:[...], total, title, kind, finishedAt }
   A chapter is earned only by reading across its end (see js/app.js updateProgress).
   Pure core is tested in test/reward.test.mjs. Spec:
   docs/superpowers/specs/2026-07-24-chapter-completion-reward-design.md */

import { Store } from "./store.js";

const PFX = "read::";

export function freshRec(key){
  return { key: key || "", chapters: [], bounds: null, total: 0, title: "", kind: "", finishedAt: null };
}

export function creditChapter(rec, k){
  const r = rec || freshRec();
  const chapters = r.chapters || [];
  if(chapters.includes(k)) return { ...r, chapters: [...chapters] };
  return { ...r, chapters: [...chapters, k].sort((a, b) => a - b) };
}

export function markFinished(rec, lastK, when){
  const r = creditChapter(rec, lastK);
  return { ...r, finishedAt: r.finishedAt != null ? r.finishedAt : when };
}

export function mergeRead(local, imported){
  const a = local || freshRec(), b = imported || freshRec();
  const chapters = [...new Set([...(a.chapters || []), ...(b.chapters || [])])].sort((x, y) => x - y);
  const fins = [a.finishedAt, b.finishedAt].filter(v => v != null);
  return {
    key: a.key || b.key || "",
    chapters,
    bounds: (a.bounds && a.bounds.length) ? a.bounds.slice() : (b.bounds ? b.bounds.slice() : null),
    total: a.total || b.total || 0,
    title: a.title || b.title || "",
    kind: a.kind || b.kind || "",
    finishedAt: fins.length ? Math.min(...fins) : null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/reward.test.mjs`
Expected: PASS — `# pass 3`, `# fail 0`.

- [ ] **Step 5: Register the test in the suite** — in `package.json`, change the `test` script by inserting `&& node test/reward.test.mjs` immediately after `node test/streak.test.mjs`:

```json
"test": "node test/phase1.test.mjs && node test/phase2.test.mjs && node test/phase3.test.mjs && node test/patron.test.mjs && node test/toc.test.mjs && node test/streak.test.mjs && node test/reward.test.mjs && node test/nav.test.mjs && node test/gestures.test.mjs && node test/hints.test.mjs && node test/tokenize.test.mjs && node test/library.test.mjs && node test/store.test.mjs && node test/columns.test.mjs && node test/crypto.test.mjs && node test/rewind.test.mjs",
```

- [ ] **Step 6: Commit**

```bash
git add js/reward.js test/reward.test.mjs package.json
git commit -m "feat(reward): chapter-ledger pure core (credit, finish, merge)"
```

---

### Task 3: reward.js pure core — spine, shelf, and beat copy

**Files:**
- Modify: `js/reward.js`
- Modify: `test/reward.test.mjs`

**Interfaces:**
- Consumes: `freshRec` (Task 2).
- Produces:
  - `spineBands(rec, index:number) → Array<{ start, end, state:"done"|"current"|"unread", fill:number }>` — one entry per chapter segment (from `bounds`/`total`).
  - `spineHeight(total:number) → number` — pixel height, sqrt-scaled and clamped (52–118).
  - `shelfEntries(records:rec[]) → Array<{ key, title, kind, total, finishedAt, height }>` — finished only, most recent first.
  - `milestoneLine(entering:number, total:number) → string` — 1-based "Chapter N of M." with an optional milestone clause.

- [ ] **Step 1: Write the failing test** — append to `test/reward.test.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/reward.test.mjs`
Expected: FAIL — `spineBands is not a function`.

- [ ] **Step 3: Write minimal implementation** — append to `js/reward.js` (before the `Reward` object, after `mergeRead`):

```js
// Chapter segments from bounds (start indices) + total. Always yields >= 1 segment,
// always starts at 0, so a no-ToC book is one whole-book segment.
function segmentsOf(rec){
  const total = Math.max(0, rec.total || 0);
  let starts = (Array.isArray(rec.bounds) && rec.bounds.length) ? rec.bounds.slice() : [0];
  starts = [...new Set(starts.map(s => Math.max(0, Math.min(total, s | 0))))].sort((a, b) => a - b);
  if(starts[0] !== 0) starts.unshift(0);
  const segs = [];
  for(let i = 0; i < starts.length; i++){
    segs.push({ start: starts[i], end: i + 1 < starts.length ? starts[i + 1] : total });
  }
  return segs;
}

export function spineBands(rec, index){
  const r = rec || freshRec();
  const total = Math.max(0, r.total || 0);
  const idx = Math.max(0, Math.min(index | 0, total));
  const done = new Set(r.chapters || []);
  const segs = segmentsOf(r);
  const last = segs.length - 1;
  return segs.map((s, i) => {
    if(done.has(i)) return { start: s.start, end: s.end, state: "done", fill: 1 };
    const inSeg = (idx >= s.start && idx < s.end) || (i === last && idx >= s.start);
    if(inSeg){
      const span = Math.max(1, s.end - s.start);
      return { start: s.start, end: s.end, state: "current", fill: Math.max(0, Math.min(1, (idx - s.start) / span)) };
    }
    return { start: s.start, end: s.end, state: "unread", fill: 0 };
  });
}

// Shelf spine height in px: sqrt-scaled between a short and long book, clamped.
export function spineHeight(total, opts){
  const { min = 52, max = 118, wlo = 9000, whi = 150000 } = opts || {};
  const s = Math.sqrt(Math.max(1, total || 0));
  const lo = Math.sqrt(wlo), hi = Math.sqrt(whi);
  const t = Math.max(0, Math.min(1, (s - lo) / (hi - lo)));
  return Math.round(min + t * (max - min));
}

export function shelfEntries(records){
  return (records || [])
    .filter(r => r && r.finishedAt != null)
    .map(r => ({ key: r.key, title: r.title, kind: r.kind, total: r.total, finishedAt: r.finishedAt, height: spineHeight(r.total) }))
    .sort((a, b) => b.finishedAt - a.finishedAt);
}

// The one calm orienting line at the seam. `entering` is 1-based (the chapter now
// beginning); the chapter just finished is entering-1. No generated fractions.
export function milestoneLine(entering, total){
  const base = `Chapter ${entering} of ${total}.`;
  const done = entering - 1;
  if(total >= 4 && done === Math.floor(total / 2)) return base + " Halfway.";
  if(entering === total) return base + " Almost there.";
  return base;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/reward.test.mjs`
Expected: PASS — `# pass 8`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add js/reward.js test/reward.test.mjs
git commit -m "feat(reward): spine bands, shelf entries, and seam copy"
```

---

### Task 4: reward.js storage API — the `Reward` object

**Files:**
- Modify: `js/reward.js`
- Modify: `test/reward.test.mjs`

**Interfaces:**
- Consumes: `Store.getAllByPrefix` (Task 1); `creditChapter`, `markFinished`, `mergeRead`, `shelfEntries`, `freshRec` (Tasks 2–3).
- Produces the `Reward` object:
  - `Reward.hydrate() → Promise<void>` — load all `read::*` into an in-memory cache.
  - `Reward.note(key, { bounds, total, title, kind })` — record parse metadata.
  - `Reward.credit(key, k) → { newlyEarned:boolean }`
  - `Reward.finish(key, lastK, when=Date.now())`
  - `Reward.forDoc(key) → rec | null`
  - `Reward.shelf() → shelfEntries`
  - `Reward.exportAll() → Array<{ key, rec }>`
  - `Reward.importMerge(list)`

- [ ] **Step 1: Write the failing test** — append to `test/reward.test.mjs`:

```js
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
  Reward.credit("mix", 1);                       // local has [1]
  Reward.importMerge(dump);                      // imported has [0]
  assert.deepEqual(Reward.forDoc("mix").chapters, [0, 1]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/reward.test.mjs`
Expected: FAIL — `Cannot read properties of undefined (reading 'hydrate')`.

- [ ] **Step 3: Write minimal implementation** — append to `js/reward.js`:

```js
/* ---- storage-backed API (in-memory cache + IndexedDB write-through) ---- */

const cache = new Map();   // docKey -> rec

function normalize(v, key){
  const r = freshRec(key);
  if(v && typeof v === "object"){
    if(Array.isArray(v.chapters)) r.chapters = v.chapters.filter(Number.isInteger).sort((a, b) => a - b);
    if(Array.isArray(v.bounds)) r.bounds = v.bounds.slice();
    if(typeof v.total === "number") r.total = v.total;
    if(typeof v.title === "string") r.title = v.title;
    if(typeof v.kind === "string") r.kind = v.kind;
    if(typeof v.finishedAt === "number") r.finishedAt = v.finishedAt;
  }
  return r;
}
function stripKey(rec){ const { key, ...rest } = rec; return rest; }   // key is redundant on disk
function persist(key, rec){ try{ Store.put(PFX + key, stripKey(rec)); }catch(e){} }

export const Reward = {
  async hydrate(){
    cache.clear();
    try{
      const rows = await Store.getAllByPrefix(PFX);
      for(const { key, val } of rows) cache.set(key, normalize(val, key));
    }catch(e){}
  },
  forDoc(key){ return cache.get(key) || null; },
  note(key, meta){
    const rec = cache.get(key) || freshRec(key);
    if(meta && meta.bounds) rec.bounds = meta.bounds.slice();
    if(meta && meta.total) rec.total = meta.total;
    if(meta && meta.title) rec.title = meta.title;
    if(meta && meta.kind) rec.kind = meta.kind;
    rec.key = key;
    cache.set(key, rec); persist(key, rec);
  },
  credit(key, k){
    const before = cache.get(key) || freshRec(key);
    const had = before.chapters.includes(k);
    const rec = creditChapter(before, k); rec.key = key;
    cache.set(key, rec); persist(key, rec);
    return { newlyEarned: !had };
  },
  finish(key, lastK, when = Date.now()){
    const before = cache.get(key) || freshRec(key);
    const rec = markFinished(before, lastK, when); rec.key = key;
    cache.set(key, rec); persist(key, rec);
  },
  shelf(){ return shelfEntries([...cache.values()]); },
  exportAll(){ return [...cache.entries()].map(([key, rec]) => ({ key, rec: stripKey(rec) })); },
  importMerge(list){
    if(!Array.isArray(list)) return;
    for(const item of list){
      if(!item || !item.key) continue;
      const merged = mergeRead(cache.get(item.key), normalize(item.rec, item.key));
      merged.key = item.key;
      cache.set(item.key, merged); persist(item.key, merged);
    }
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/reward.test.mjs`
Expected: PASS — `# pass 12`, `# fail 0`.

- [ ] **Step 5: Run the full suite to confirm nothing else broke**

Run: `npm test`
Expected: every listed test file runs; the process exits 0.

- [ ] **Step 6: Commit**

```bash
git add js/reward.js test/reward.test.mjs
git commit -m "feat(reward): storage-backed Reward cache with IndexedDB write-through"
```

---

### Task 5: Boot hydrate + record parse metadata on load

**Files:**
- Modify: `js/app.js` (import ~line 3; `init()` ~1717; load path after ~1091)

**Interfaces:**
- Consumes: `Reward.hydrate`, `Reward.note` (Task 4).
- Produces: a populated reward cache after boot, and a `read::<S.key>` record noted for every opened book.

- [ ] **Step 1: Import the module** — in `js/app.js`, directly below the existing `import { Haptics } from "./haptics.js";` (line 3), add:

```js
import { Reward, spineBands, milestoneLine } from "./reward.js";
```

- [ ] **Step 2: Hydrate on boot, then repaint the library** — in `init()` (line 1717), add near the top of the function body:

```js
  Reward.hydrate().then(()=>{ renderLibrary(); });
```

(Once Task 10 adds `renderShelf()` to the end of `renderLibrary`, this same call paints the shelf too.)

- [ ] **Step 3: Note metadata when a document loads** — in the load path, immediately after line 1091 (`S.title=title; S.meta=meta; S.key=key; S.index=0;`), add:

```js
  Reward.note(S.key, { bounds: S.chapters.map(c => c.start), total: S.tokens.length, title: S.title, kind });
```

(`kind` and `S.tokens` are already in scope here; `S.chapters` was set on line 1089.)

- [ ] **Step 4: Verify in the browser** — serve and open the app:

```bash
python3 -m http.server 8765 --directory . &
```

Open `http://localhost:8765`, load any EPUB with a table of contents, then in DevTools console run:

```js
(await import('/js/reward.js')).Reward.forDoc(window.__stKey || null)
```

If `__stKey` is not exposed, instead open Application → IndexedDB → `stillpoint` → `files` and confirm a `read::…` key exists with `bounds`, `total`, `title`, `kind`.
Expected: a record whose `bounds` length equals the book's chapter count.

- [ ] **Step 5: Commit**

```bash
git add js/app.js
git commit -m "feat(reward): hydrate on boot and note chapter bounds on load"
```

---

### Task 6: Credit chapters on a genuine crossing, and on finish

**Files:**
- Modify: `js/app.js` (`updateProgress` crossing branch ~808; `finish()` ~405)

**Interfaces:**
- Consumes: `Reward.credit`, `Reward.finish` (Task 4).
- Produces: `window.__lastBeat` is set to `{ finishedIdx, entering, title }` on a newly-earned crossing (a seam the beat hooks in Task 8; a stand-in now so this task is verifiable without UI).

- [ ] **Step 1: Credit on the forward playback crossing** — in `updateProgress`, replace the chapter-crossing line 808:

```js
  if(k !== S.curCh){ S.curCh = k; $("docMeta").textContent = seg.title || S.meta; }
```

with:

```js
  if(k !== S.curCh){
    // curCh starts at -1 (pre-first chapter), so require >= 0 before crediting.
    if(throttled && k > S.curCh && S.curCh >= 0){
      let earned = false;
      for(let c = S.curCh; c < k; c++){ if(Reward.credit(S.key, c).newlyEarned) earned = true; }
      if(earned) onChapterEarned(k, grid);   // beat hooks here (Task 8)
    }
    S.curCh = k; $("docMeta").textContent = seg.title || S.meta;
  }
```

- [ ] **Step 2: Add a temporary `onChapterEarned` stand-in** — add this function just above `updateProgress` (before line 784). Task 8 replaces its body with the real beat:

```js
// A chapter was just finished by reading (entering segment k of `grid`).
function onChapterEarned(k, grid){
  const total = grid.length;
  const entering = k + 1;                       // 1-based chapter now beginning
  window.__lastBeat = { finishedIdx: k - 1, entering, title: (grid[k] && grid[k].title) || null };
}
```

- [ ] **Step 3: Credit the last chapter on finish** — in `finish()` (line 405), immediately after `pause();` (line 406), add:

```js
  Reward.finish(S.key, S.curCh, Date.now());
```

- [ ] **Step 4: Verify in the browser** — reload `http://localhost:8765`, open an EPUB with chapters, and let it play (or drag speed up) across a chapter boundary. In the console after a boundary passes:

```js
window.__lastBeat
```

Expected: an object like `{ finishedIdx: 0, entering: 2, title: "…" }`. Then read to the very end and confirm the finish card appears and `(await import('/js/reward.js')).Reward.shelf().length` is `≥ 1`.

- [ ] **Step 5: Commit**

```bash
git add js/app.js
git commit -m "feat(reward): credit chapters on genuine crossings and on finish"
```

---

### Task 7: Settings — "Pause at chapter breaks" toggle

**Files:**
- Modify: `js/app.js` (`settings` object ~58; aid-toggle handler ~1949; `savePrefs` ~2055; prefs load ~2025; backup import ~1490)
- Modify: `index.html` (the Aids toggle row near line 521)

**Interfaces:**
- Produces: `settings.pauseChapters` (boolean, default `false`), persisted in `fp_prefs` and carried in backups.

- [ ] **Step 1: Add the setting field** — in `js/app.js` line 58, add `pauseChapters:false` to the `settings` object:

```js
const settings = { countdown:true, context:true, smartPacing:true, zen:true, moreOpen:false, pauseChapters:false };
```

- [ ] **Step 2: Add the toggle button** — in `index.html`, next to the existing aid buttons (after the `data-aid="smartPacing"` button, ~line 523), add:

```html
              <button type="button" data-aid="pauseChapters" aria-pressed="false" title="Pause for a beat at the end of each chapter">Chapter rest</button>
```

(Note: no `class="active"`, because the default is off.)

- [ ] **Step 3: Persist and restore the field** — in `savePrefs` (line 2055), add `pauseChapters:settings.pauseChapters` to the serialized object; in the prefs-load block (after line 2027) add:

```js
    if(typeof prefs.pauseChapters==="boolean") settings.pauseChapters=prefs.pauseChapters;
```

and in the backup-import prefs block (after line 1491) add:

```js
        if(typeof data.prefs.pauseChapters==="boolean") settings.pauseChapters = data.prefs.pauseChapters;
```

- [ ] **Step 4: Verify the toggle reflects and persists** — reload the app, open the Aids panel, click "Chapter rest" so it becomes pressed, reload, reopen Aids.
Expected: the button is still pressed (`aria-pressed="true"`), and `JSON.parse(localStorage.fp_prefs).pauseChapters === true` in the console.

- [ ] **Step 5: Commit**

```bash
git add js/app.js index.html
git commit -m "feat(reward): Pause at chapter breaks aid toggle"
```

---

### Task 8: The seam beat

**Files:**
- Modify: `index.html` (add `#chapterBeat` beside `#zoneFlash` in the stage)
- Modify: `styles.css` (beat styles)
- Modify: `js/app.js` (replace `onChapterEarned` body ~from Task 6; uses `milestoneLine`, `Haptics`, `settings.pauseChapters`)

**Interfaces:**
- Consumes: `milestoneLine` (Task 3); `settings.pauseChapters` (Task 7); the `onChapterEarned(k, grid)` call site (Task 6).

- [ ] **Step 1: Add the overlay element** — in `index.html`, as a sibling of `#zoneFlash` inside the reading stage, add:

```html
      <div id="chapterBeat" class="cbeat" aria-live="polite" aria-hidden="true"></div>
```

- [ ] **Step 2: Add the styles** — append to `styles.css`:

```css
/* Chapter completion beat — a quiet breath at the seam, over the still point. */
.cbeat{position:absolute;left:0;right:0;bottom:22%;display:flex;flex-direction:column;
  align-items:center;gap:8px;pointer-events:none;opacity:0;transform:translateY(6px);
  transition:opacity var(--t) var(--ease-out), transform var(--t) var(--ease-out);}
.cbeat.on{opacity:1;transform:none;}
.cbeat .cb-line{display:flex;align-items:center;gap:9px;font-size:var(--fs-sm);color:var(--ink-soft);}
.cbeat .cb-check{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:50%;
  color:var(--amethyst);font-size:11px;background:color-mix(in srgb,var(--amethyst) 20%,transparent);
  border:1px solid color-mix(in srgb,var(--amethyst) 40%,transparent);}
.cbeat .cb-next{color:var(--ink-mute);font-style:italic;}
@media (prefers-reduced-motion:reduce){ .cbeat{transition:opacity var(--t) linear;transform:none;} }
```

- [ ] **Step 3: Replace the `onChapterEarned` stand-in** — in `js/app.js`, replace the whole `onChapterEarned` function (added in Task 6) with:

```js
let beatTimer = null;
// A chapter was just finished by reading. Take one designed breath at the seam.
function onChapterEarned(k, grid){
  const total = grid.length;
  const entering = k + 1;                        // 1-based chapter now beginning
  const title = (grid[k] && grid[k].title) || "";
  Haptics.trigger("success");
  if(document.hidden || $("done").classList.contains("show")) return;   // no visible beat if the tab is away or the finish card is up
  const el = $("chapterBeat"); if(!el) return;
  el.innerHTML = `<div class="cb-line"><span class="cb-check">✓</span>`
    + `<span>${esc(milestoneLine(entering, total))}</span>`
    + (title ? `<span class="cb-next">Entering “${esc(title)}”</span>` : ``)
    + `</div>`;
  el.setAttribute("aria-hidden", "false");
  el.classList.add("on");
  clearTimeout(beatTimer);
  if(settings.pauseChapters){ pause(); }         // rest here until the reader resumes
  else beatTimer = setTimeout(()=>{ el.classList.remove("on"); el.setAttribute("aria-hidden","true"); }, 1600);
}
```

- [ ] **Step 4: Dismiss the resting beat on resume** — clear the beat when reading resumes. In `play()` (line 318), add as its first line inside the body:

```js
  { const b = $("chapterBeat"); if(b){ b.classList.remove("on"); b.setAttribute("aria-hidden","true"); } }
```

- [ ] **Step 5: Verify in the browser** — reload, open a chaptered EPUB, read across a boundary with "Chapter rest" **off**.
Expected: a one-second line "Chapter N of M." with a check and the incoming title fades in and out over the still point, playback continues. Turn "Chapter rest" **on**, cross another boundary: playback pauses with the line held; pressing Space resumes and clears it. Toggle OS reduce-motion and confirm the beat only fades (no slide).

- [ ] **Step 6: Commit**

```bash
git add index.html styles.css js/app.js
git commit -m "feat(reward): the chapter seam beat"
```

---

### Task 9: The per-book spine (library rows + finish card)

**Files:**
- Modify: `js/app.js` (`renderLibrary` item markup ~1037; `finish()` ~405 to mount a spine)
- Modify: `index.html` (a spine mount on the finish card, near `#doneStreak` ~566)
- Modify: `styles.css` (spine styles)

**Interfaces:**
- Consumes: `Reward.forDoc`, `spineBands` (Tasks 3–4).
- Produces: `spineHTML(rec, index, total) → string` — the segmented measure markup (reused by the library row and the finish card). `total` is the library record's token count, used for the continuous-bar fallback when a book has no reward record yet.

- [ ] **Step 1: Add the spine styles** — append to `styles.css`:

```css
/* Chapter-segmented spine — earned chapters as ink, one band each. */
.spine{display:flex;gap:3px;height:8px;padding:3px;border-radius:6px;
  background:var(--surface-inset);box-shadow:inset 0 1px 3px rgba(0,0,0,.4);}
.spine .sg{flex:1;border-radius:2px;background:color-mix(in srgb,var(--ink) 9%,transparent);}
.spine .sg.done{background:linear-gradient(90deg,var(--amethyst-deep),var(--amethyst));
  box-shadow:0 0 8px -2px color-mix(in srgb,var(--amethyst) 55%,transparent);}
.spine .sg.cur{position:relative;overflow:hidden;}
.spine .sg.cur i{position:absolute;inset:0;border-radius:2px;
  background:linear-gradient(90deg,var(--amethyst-deep),var(--amethyst));}
```

- [ ] **Step 2: Add the `spineHTML` helper** — in `js/app.js`, add above `renderLibrary` (before line 1008):

```js
// Segmented chapter spine for a library row / the finish card. Falls back to a
// single continuous fill when a book has no real chapters (one whole-book segment)
// or has not been opened under this feature yet (no reward record).
function spineHTML(rec, index, total){
  const bands = rec ? spineBands(rec, index) : null;
  if(!bands || bands.length < 2){
    const t = (rec && rec.total) || total || 0;
    const pct = t ? Math.min(100, Math.round((index / t) * 100)) : 0;
    return `<div class="spine"><div class="sg cur"><i style="width:${pct}%"></i></div></div>`;
  }
  const segs = bands.map(b =>
    b.state === "done" ? `<div class="sg done"></div>`
    : b.state === "current" ? `<div class="sg cur"><i style="width:${Math.round(b.fill * 100)}%"></i></div>`
    : `<div class="sg"></div>`).join("");
  return `<div class="spine">${segs}</div>`;
}
```

- [ ] **Step 3: Swap the flat bar for the spine on library rows** — in `renderLibrary`, replace the `ri-bar` line (1037):

```js
        <i class="ri-bar${finished?" full":""}" style="width:${finished?100:pct}%" aria-hidden="true"></i>
```

with:

```js
        ${spineHTML(Reward.forDoc(item.key), item.index, item.total)}
```

If `.ri-bar` was absolutely positioned within `.ri-face` (a bottom hairline bar), give `.spine` the same seat so the card layout is unchanged; confirm visually in Step 6.

- [ ] **Step 4: Mount a spine on the finish card** — in `index.html`, immediately after the `#doneStreak` paragraph (line 566), add:

```html
    <div class="done-spine" id="doneSpine" aria-hidden="true"></div>
```

and in `finish()` (after line 427 `$("done").classList.add("show");`), add:

```js
  $("doneSpine").innerHTML = spineHTML(Reward.forDoc(S.key), S.index, S.tokens.length);
```

- [ ] **Step 5: Style the finish-card spine width** — append to `styles.css`:

```css
.done-spine{max-width:280px;margin:14px auto 0;}
```

- [ ] **Step 6: Verify in the browser** — reload, open a chaptered EPUB, read a couple of chapters, press Esc to the library.
Expected: the book's row shows solid bands for read chapters, a partial current band, faint unread bands. Read to the end and confirm the finish card shows a nearly-full spine.

- [ ] **Step 7: Commit**

```bash
git add js/app.js index.html styles.css
git commit -m "feat(reward): chapter-segmented spine on library rows and finish card"
```

---

### Task 10: The Finished shelf

**Files:**
- Modify: `index.html` (add `#shelf` section after `#streakStrip` ~234)
- Modify: `js/app.js` (add `renderShelf`; call it from `renderLibrary` and after `finish`; hydrate hook from Task 5)
- Modify: `styles.css` (shelf styles)

**Interfaces:**
- Consumes: `Reward.shelf` (Task 4); the `openByKey` reopen path already used by library rows.
- Produces: `renderShelf()` — paints `#shelf` from `Reward.shelf()`.

- [ ] **Step 1: Add the shelf section** — in `index.html`, directly after the `#streakStrip` section (closes ~line 234's block), add:

```html
    <section class="shelf hidden" id="shelf" aria-label="Finished books">
      <div class="shelf-eyebrow">FINISHED</div>
      <div class="shelf-row" id="shelfRow"></div>
    </section>
```

- [ ] **Step 2: Add the shelf styles** — append to `styles.css`:

```css
/* Finished shelf — a row of length-scaled book spines standing together. */
.shelf{margin:18px 0 0;}
.shelf-eyebrow{font-family:var(--font-display);font-stretch:120%;font-size:var(--fs-2xs);
  letter-spacing:.2em;text-transform:uppercase;color:var(--ink-mute);margin:0 0 12px;}
.shelf-row{display:flex;align-items:flex-end;gap:12px;min-height:130px;padding:0 4px 2px;
  border-bottom:1px solid var(--hair);box-shadow:0 1px 0 var(--hair-soft);overflow-x:auto;}
.shelf-spine{width:17px;flex:0 0 auto;border-radius:3px 3px 2px 2px;position:relative;cursor:pointer;
  background:linear-gradient(180deg,var(--amethyst),var(--amethyst-deep));
  box-shadow:inset 0 1px 0 color-mix(in srgb,#fff 20%,transparent),
    inset 0 0 0 1px color-mix(in srgb,var(--amethyst) 20%,transparent),0 6px 14px -8px rgba(0,0,0,.7);}
.shelf-spine.recent{box-shadow:inset 0 1px 0 color-mix(in srgb,var(--gold) 50%,transparent),
    inset 0 0 0 1px color-mix(in srgb,var(--gold) 28%,transparent),
    0 0 16px -6px color-mix(in srgb,var(--gold) 55%,transparent),0 6px 14px -8px rgba(0,0,0,.7);}
.shelf-spine:focus-visible{outline:2px solid var(--focus);outline-offset:2px;}
```

- [ ] **Step 3: Add `renderShelf`** — in `js/app.js`, add just below `renderLibrary` (after its closing brace):

```js
function renderShelf(){
  const sec = $("shelf"), row = $("shelfRow"); if(!sec || !row) return;
  const items = Reward.shelf();
  sec.classList.toggle("hidden", items.length === 0);
  row.innerHTML = items.map((b, i) => {
    const bands = Math.max(3, Math.min(14, Math.round((b.total || 0) / 9000)));
    const bp = (b.height / bands).toFixed(2);
    const grain = `repeating-linear-gradient(to bottom, rgba(5,3,8,.4) 0px, rgba(5,3,8,.4) 1px, transparent 1px, transparent ${bp}px)`;
    return `<button type="button" class="shelf-spine${i === 0 ? " recent" : ""}" data-key="${esc(b.key)}"`
      + ` style="height:${b.height}px;background-image:${grain},linear-gradient(180deg,var(--amethyst),var(--amethyst-deep))"`
      + ` title="${esc(b.title)}, finished" aria-label="${esc(b.title)}, finished"></button>`;
  }).join("");
  row.querySelectorAll(".shelf-spine").forEach(el => el.onclick = () => openByKey(el.dataset.key));
}
```

- [ ] **Step 4: Add `openByKey`** — library rows reopen a book via `openFromStore(item)`, an async loader that already toasts gracefully when the file is gone (`js/app.js:1175`). Add this helper just below `renderShelf`:

```js
// Reopen a finished book from the shelf. Uses the live library record when the
// book is still listed, otherwise a minimal item so openFromStore reports the
// memento case ("isn't on this device anymore").
function openByKey(key){
  const rec = Reward.forDoc(key);
  const item = loadLib().find(x => x.key === key) || { key, title: (rec && rec.title) || "This book" };
  openFromStore(item);
}
```

- [ ] **Step 5: Paint the shelf whenever the library paints** — at the very end of `renderLibrary` (just before its closing `}` at line 1069), add:

```js
  renderShelf();
```

This covers boot (the hydrate callback from Task 5 calls `renderLibrary`) and the return to the library after finishing a book.

- [ ] **Step 6: Verify in the browser** — with an empty library the shelf is hidden. In the console, seed two finished books and repaint:

```js
const { Reward } = await import('/js/reward.js');
Reward.note('demo1',{bounds:[0,1000,3000],total:9000,title:'Bluets',kind:'epub'});
Reward.note('demo2',{bounds:[0,5000],total:150000,title:'The Overstory',kind:'epub'});
Reward.finish('demo1',2,Date.now()-1000); Reward.finish('demo2',1,Date.now());
renderShelf();
```

Expected: the FINISHED shelf appears with two spines standing together, the taller one (The Overstory) and the most recent one gold-capped. Clicking a spine attempts to open that book.

- [ ] **Step 7: Commit**

```bash
git add index.html styles.css js/app.js
git commit -m "feat(reward): the Finished shelf"
```

---

### Task 11: Backup export / import

**Files:**
- Modify: `js/app.js` (backup object ~1357; restore ~1495)

**Interfaces:**
- Consumes: `Reward.exportAll`, `Reward.importMerge` (Task 4).

- [ ] **Step 1: Add the `reward` field to the backup** — in `buildBackup` (line 1357), add `reward:Reward.exportAll()` to the `backup` object:

```js
  const backup = { format:BACKUP_FORMAT, version:1, exportedAt:new Date().toISOString(), prefs, library:lib, files, blockModes, highlights, streak:Streak.raw()||undefined, reward:Reward.exportAll() };
```

- [ ] **Step 2: Merge on restore** — in `restoreBackup` (right after line 1495 `if(data.streak) Streak.importMerge(data.streak);`), add:

```js
    if(data.reward) Reward.importMerge(data.reward);
```

- [ ] **Step 3: Verify round-trip in the browser** — with at least one finished book (seed as in Task 10 Step 6, or finish a real one), export a backup from the Support/Backup panel, then reload and import it.
Expected: after import, `(await import('/js/reward.js')).Reward.shelf().length` is unchanged, and old backups (no `reward` field) still import without error.

- [ ] **Step 4: Commit**

```bash
git add js/app.js
git commit -m "feat(reward): carry the chapter ledger in library backups"
```

---

### Task 12: Service worker shell + final verification

**Files:**
- Modify: `sw.js` (`SHELL` list ~line 25)

- [ ] **Step 1: Add the module to the offline shell** — in `sw.js`, add `"js/reward.js",` to the `SHELL` array, directly after `"js/streak.js",`.

- [ ] **Step 2: Bump the content-derived cache version**

Run: `npm run sw:bump`
Expected: `sw.js`'s `CACHE_VERSION` string changes; the command exits 0.

- [ ] **Step 3: Confirm the shell hash is consistent**

Run: `npm run sw:check`
Expected: exits 0 (no drift).

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: all test files pass; the process exits 0.

- [ ] **Step 5: Full manual smoke** — reload the app fresh (DevTools → Application → Service Workers → Update, or hard reload). Open a chaptered EPUB, read across two boundaries (beat plays), read to the end (finish card with a full spine), return to the library (row spine + FINISHED shelf with the new book, gold-capped). Reopen the finished book from the shelf.
Expected: every surface behaves as described, no console errors.

- [ ] **Step 6: Commit**

```bash
git add sw.js
git commit -m "chore(sw): cache js/reward.js and bump the shell version"
```

---

## Notes for the implementer

- **Do not commit the local server or any scratch mock.** The `python3 -m http.server` line is a dev convenience only.
- **`openByKey` (Task 10 Step 4):** the shelf reopens a book by the same key the library rows use. If a finished book's file was removed, opening should fail gracefully (the spine stays as a memento); do not crash. If the existing open path already toasts "file missing," reuse it.
- **Order matters for the SW bump (Task 12):** run `npm run sw:bump` only after every shell file (`index.html`, `styles.css`, `js/*.js`, `sw.js`) is in its final state, or `sw:check` will flag drift.
- **Copy stays plain:** "Chapter rest", "Entering …", "Chapter N of M.", "FINISHED". No em dashes, no rule-of-three lists.
