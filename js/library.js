// Pure library-list logic — no DOM, no storage, unit-testable. The list itself
// lives in localStorage under fp_library_v1 (see app.js); what's here is the
// part with rules worth pinning down.
export const LIB_MAX = 8;   // the shelf keeps the eight most recent books

// Merge an imported library into the current one, keeping the most recently
// read entry per book — this is what makes reading progress sync across
// devices through backup export/import. Newest-first, like the shelf renders.
export function mergeLibrary(current, imported){
  const byKey = new Map();
  for(const it of current||[]) byKey.set(it.key, it);
  for(const it of imported||[]){
    const ex = byKey.get(it.key);
    if(!ex || (it.ts||0) > (ex.ts||0)) byKey.set(it.key, it);
  }
  return [...byKey.values()].sort((a,b)=>(b.ts||0)-(a.ts||0));
}
