// Text utilities: tokenizing, ORP focus point, HTML escaping, and the demo passage.

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

// ORP (optimal recognition point) index for a word, ignoring leading punctuation.
export function orpIndex(word){
  const letters = word.replace(/[^A-Za-z0-9]/g,"");
  const L = letters.length || word.length;
  let i;
  if(L<=1) i=0; else if(L<=5) i=1; else if(L<=9) i=2; else if(L<=13) i=3; else i=4;
  let seen=0;
  for(let k=0;k<word.length;k++){
    if(/[A-Za-z0-9]/.test(word[k])){ if(seen===i) return k; seen++; }
  }
  return Math.min(i, word.length-1);
}

export function esc(s){
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

/* ---------------- contents (top-bar navigation) ---------------- */
// Rows for the Contents panel. `units` come from the parser ({start, title});
// `index` is the current token position. Exactly one row is current: the last
// unit whose start we have reached (mirrors the old select's sync rule).
export function chapterItems(units, index){
  if(!Array.isArray(units) || units.length < 2) return [];
  let cur = 0;
  for(let k=0;k<units.length;k++){ if(units[k].start <= index) cur = k; }
  return units.map((u,k)=>({ start:u.start, title:u.title, depth:u.depth||0, current:k===cur }));
}

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
    // same-start duplicates keep the first entry, like the parser's nav dedupe
    const dedup = [];
    for(const s of sorted){ if(!dedup.length || s.start > dedup[dedup.length-1].start) dedup.push(s); }
    const segs = [];
    for(let k = 0; k < dedup.length; k++){
      const end = k + 1 < dedup.length ? dedup[k+1].start : total;
      if(end > dedup[k].start) segs.push({ title: dedup[k].title, start: dedup[k].start, end });
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

/* ---------------- sentence boundaries + pacing (Phase 3) ---------------- */
// A sentence starts at index 0 or after any token whose `end` flag is set.
export function sentenceStart(tokens, i){ let s=Math.min(i, tokens.length-1); while(s>0 && !tokens[s-1].end) s--; return Math.max(0,s); }
export function sentenceEnd(tokens, i){ let e=Math.max(0,i); while(e<tokens.length-1 && !tokens[e].end) e++; return e; }

const clamp = (x,lo,hi)=> Math.max(lo, Math.min(hi, x));
// Per-token slowdown factor (>=1) reflecting its sentence's reading load. Plain
// prose (~12-18 words, ~4.8 avg chars) scores ~0 → factor 1.0 (no change); long,
// polysyllabic sentences slow up to factor 1.5. Computed once per document load.
export function sentenceFactors(tokens, strength = 0.35){
  const n = tokens.length;
  const out = new Float32Array(n);
  let i = 0;
  while(i < n){
    let e = i; while(e < n-1 && !tokens[e].end) e++;          // inclusive sentence end
    const W = e - i + 1;                                       // word count
    let chars = 0;
    for(let k=i;k<=e;k++){ const a = tokens[k].w.replace(/[^A-Za-z0-9]/g,""); chars += a.length || tokens[k].w.length; }
    const A = chars / Math.max(1, W);                          // avg word length
    const lenScore  = clamp((W - 18) / 22, 0, 1);
    const charScore = clamp((A - 4.8) / 2.2, 0, 1);
    const c = 0.6*lenScore + 0.4*charScore;
    const factor = Math.min(1.5, 1 + strength * c);
    for(let k=i;k<=e;k++) out[k] = factor;
    i = e + 1;
  }
  return out;
}

/* ---------------- rewind on resume ----------------
   How far to back up when the reader comes back depends on how long they were
   gone. A glance away needs a word or two to re-orient. A real interruption has
   taken the sentence with it, so past the threshold we return to where the
   sentence began rather than counting words backwards, because a word count does
   not know where the meaning starts.

   A caller with no measured gap (resuming a document from a previous session)
   gets the old fixed step, so that path behaves exactly as before. */
export const REWIND_GLANCE_MS   = 4000;   // at or under this, barely move
export const REWIND_SENTENCE_MS = 25000;  // at or over this, return to the sentence
export const REWIND_MIN   = 2;
export const REWIND_MAX   = 8;
export const REWIND_FIXED = 5;            // the pre-2026-07 behaviour, still the fallback
export const REWIND_CAP   = 40;           // guards against unpunctuated "sentences"

export function rewindTarget(tokens, index, awayMs){
  const n = Array.isArray(tokens) ? tokens.length : 0;
  const i = Math.max(0, Math.min(Math.trunc(index) || 0, n));
  if(i <= 0) return 0;
  const back = w => Math.max(0, i - w);
  if(!Number.isFinite(awayMs) || awayMs < 0) return back(REWIND_FIXED);
  if(awayMs >= REWIND_SENTENCE_MS){
    // Snap to the start of the sentence, but floor at MAX words so a long absence
    // never rewinds less than a medium one (near a sentence start, its beginning
    // is only a word or two back), and ceiling at CAP words so an unpunctuated
    // run can't fling the reader to the top of the document.
    const s = sentenceStart(tokens, i - 1);
    return Math.max(back(REWIND_CAP), Math.min(back(REWIND_MAX), s));
  }
  if(awayMs <= REWIND_GLANCE_MS) return back(REWIND_MIN);
  const t = (awayMs - REWIND_GLANCE_MS) / (REWIND_SENTENCE_MS - REWIND_GLANCE_MS);
  return back(Math.round(REWIND_MIN + t * (REWIND_MAX - REWIND_MIN)));
}

// Short looping passage for the auto-playing hero preview — phrased so the demo also carries the message.
export const HERO = `Every word arrives at one still point. No scanning. No hunting across the line. Your eyes rest while the reading moves. This is what focus feels like.`;

export const DEMO = `Reading is a strange skill. You take small marks on a surface and, almost instantly, they turn into meaning inside your head. Your eye never glides smoothly across a line. It leaps from word to word, landing on a single point in each one before the brain fills in the rest. Stillpoint borrows that natural anchor. Instead of asking your eyes to chase the text, it brings each word to you and holds it exactly where your attention already wants to rest. After a minute it feels less like reading and more like listening. Try sliding the speed upward. You will be surprised how much faster you can read when your eyes are allowed to stay perfectly still.`;
