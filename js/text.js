// Text utilities: tokenizing, ORP focus point, HTML escaping, and the demo passage.

// Split text into word tokens, flagging sentence ends + clause pauses for natural pacing.
export function tokenize(text){
  const raw = text.replace(/\s+/g," ").trim();
  if(!raw) return [];
  return raw.split(" ").map(w => ({
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

// Short looping passage for the auto-playing hero preview — phrased so the demo also carries the message.
export const HERO = `Every word arrives at one still point. No scanning. No hunting across the line. Your eyes rest while the reading moves. This is what focus feels like.`;

export const DEMO = `Reading is a curious act of magic. We take small marks arranged on a surface and, almost instantly, they bloom into meaning inside the mind. The eye does not glide smoothly across a line; it leaps, pauses, and leaps again, landing on a single point within each word before the brain assembles the rest. Stillpoint borrows that natural anchor. Instead of asking your eyes to chase the text, it brings each word to you and holds it at the very spot your attention already wants to rest. The result feels less like reading and more like remembering — as though the words were already there, waiting to be recognised. Try sliding the speed upward. You will be surprised how much faster you can read when your eyes are allowed to stay perfectly still.`;
