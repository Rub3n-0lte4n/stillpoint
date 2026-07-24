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
