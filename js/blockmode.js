// Pure block-presentation logic — no DOM, unit-testable.
// `blockMode` shape: { default:"pause"|"hybrid"|"skip", <kind>:override…, dismissed:[ids] }

// Per-kind defaults (used only if neither an override nor a global default is set).
export const KIND_DEFAULTS = {
  table:"pause", equation:"pause", image:"skip", figure:"pause", code:"pause", quote:"pause",
};

// Seeded per-document preference: global pause, images collected.
export function defaultBlockMode(){ return { default:"pause", image:"skip", dismissed:[] }; }

// Resolve the mode for a kind: explicit override → global default → per-kind default → "pause".
export function modeForKind(blockMode, kind){
  const bm = blockMode || {};
  if(bm[kind] === "pause" || bm[kind] === "hybrid" || bm[kind] === "skip") return bm[kind];
  if(bm.default) return bm.default;
  return KIND_DEFAULTS[kind] || "pause";
}

// Stable sorted-by-`after` view of the sidecar, for range lookups in the hot loop.
export function indexBlocks(blocks){
  return (blocks || []).slice().sort((a,b)=> a.after - b.after);
}

// First block whose `after` falls in [lo, hi), skipping dismissed/already-shown ids.
// `dismissed` and `shown` are Sets of block ids (either may be null).
export function firstBlockInRange(sortedBlocks, lo, hi, dismissed, shown){
  for(const b of sortedBlocks){
    if(b.after < lo) continue;
    if(b.after >= hi) break;
    if(dismissed && dismissed.has(b.id)) continue;
    if(shown && shown.has(b.id)) continue;
    return b;
  }
  return null;
}

export function isDismissed(blockMode, id){
  return !!(blockMode && Array.isArray(blockMode.dismissed) && blockMode.dismissed.includes(id));
}

// A PDF-origin (auto-detected, possibly false-positive) block carries a rendered
// snapshot dataUrl; EPUB blocks are explicit native elements. Used to decide
// whether to show the "dismiss" affordance.
export function isAutoDetected(block){
  const p = block && block.payload;
  return !!(p && p.type === "image" && p.dataUrl);
}
