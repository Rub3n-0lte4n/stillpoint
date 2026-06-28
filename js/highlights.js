// Pure highlight logic — index ranges only, no DOM, no text copies.
// A highlight: { start, end, unit, ts } with inclusive token indices.

// Toggle/insert a [start,end] mark into a sorted, non-overlapping ranges array.
// Re-marking an exact existing range removes it; otherwise the new range is
// inserted and any overlapping/adjacent ranges are merged.
export function toggleRange(ranges, start, end, unit, ts){
  if(start > end){ const t=start; start=end; end=t; }
  const list = (ranges||[]).map(r=>({...r}));
  const exact = list.findIndex(r=> r.start===start && r.end===end);
  if(exact >= 0){ list.splice(exact, 1); return list; }
  list.push({ start, end, unit, ts });
  list.sort((a,b)=> a.start - b.start);
  const out = [];
  for(const r of list){
    const last = out[out.length-1];
    if(last && r.start <= last.end + 1){ if(r.end > last.end) last.end = r.end; }
    else out.push({...r});
  }
  return out;
}

export function serializeHighlights(ranges){ return { v:1, ranges:(ranges||[]).slice().sort((a,b)=>a.start-b.start) }; }
export function deserializeHighlights(rec){ return (rec && Array.isArray(rec.ranges)) ? rec.ranges.slice() : []; }

// Render the words of a range from the token stream (derived, never stored).
export function rangeText(tokens, r){ return tokens.slice(r.start, r.end+1).map(t=>t.w).join(" "); }

// Markdown export — paste-able into notes and importable into Anki. No SRS.
export function exportMarkdown(tokens, units, ranges, title){
  const sorted = (ranges||[]).slice().sort((a,b)=> a.start - b.start);
  let md = `# Highlights — ${title}\n`;
  let curUnit = null;
  for(const r of sorted){
    const ut = (units[r.unit] && units[r.unit].title) || "Section";
    if(ut !== curUnit){ md += `\n## ${ut}\n`; curUnit = ut; }
    md += `\n> ${rangeText(tokens, r)}\n\n— ${title} · ${ut} · words ${r.start}–${r.end}\n`;
  }
  return md;
}
