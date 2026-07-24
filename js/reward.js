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
