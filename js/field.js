/* ---------------- reading-field geometry ----------------
   Pure maths for the question "does this fit, and at what size". No DOM, no app
   state, so it is testable in node.

   The field is short for one reason: ORP pins the PIVOT LETTER to the axis, and
   words are lopsided around their pivot (it sits about a third in). A centred
   pivot therefore spends only ~40% of the screen on the side the word actually
   grows into, so a word needs roughly 1.45x its own width in screen space.
   Moving the axis left buys that width back instead of shrinking the type.

   Two things follow, and they are what the reader actually feels:

   - The axis belongs to the DOCUMENT, not to the stylesheet (axisFor). A fixed
     phone axis is one guess charged to every book; the widest word a book
     actually contains says how far the axis has to move, and for most prose the
     answer is "barely at all".
   - The size belongs to the DOCUMENT, not to the ribbon window (sizingSample).
     Sizing each window by its own widest word makes the type step mid-sentence,
     which is far more distracting than type that is simply a little smaller. */

export const AXIS_DEFAULT   = 0.5;
export const SCALE_FLOOR_PX = 22;   // below this the type stops yielding; see windowScale
export const FIELD_INSET_PX = 8;    // breathing room at each edge of the field
export const OUTLIER_CHARS  = 20;   // longer than this is a URL, not prose; see sizingSample
export const SIZING_SAMPLE  = 32;   // how many long words are enough to set a document's size

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

/* How much room a word actually has on each side of the axis.

   The axis is a fraction of the WHOLE stage, because that is what CSS places
   against it: --axis-x feeds `left:` on the guides, the halo and the countdown
   digit, and a percentage there resolves against the stage box. The fit maths
   wants the distance from that axis out to the breathing margin instead, which is
   the same span less the inset — NOT a fraction of the inset field.

   Those two readings differ by up to the inset, and holding them apart is what let
   the pivot sit as much as 4.6px off the guide ticks that are supposed to be
   marking it. One function owns the conversion so they cannot drift again. */
export function capsFor(axisFrac, width, inset = FIELD_INSET_PX){
  return { left:  Math.max(0,      axisFrac  * width - inset),
           right: Math.max(0, (1 - axisFrac) * width - inset) };
}

/* Both sides measured from the axis outward, each against its own allowance.
   Checking total width instead is the bug this replaces. */
export function fitsAxis(halves, caps){
  return halves.left <= caps.left + 0.01 && halves.right <= caps.right + 0.01;
}

/* Where the still point should sit ACROSS the field, given what this document
   actually asks for.

   A hardcoded phone axis is a guess made once for every book ever opened. 33% was
   picked for the worst case and then charged to every page: short words sat
   stranded a third of the way across a screen that was empty beside them. The
   document knows better. The widest word's halves define a feasible band — the
   axis may sit no further left than its left half needs, and no further right than
   its right half needs — and inside that band the most balanced choice is the one
   nearest centre.

   So prose of ordinary words reads dead centre, and the axis slides left only as
   far as that book's longest word actually requires. Chunk modes need no special
   case: blockHalves is symmetric, so the band always contains 0.5 and this
   returns it.

   Returns a fraction of `width`, the same reading capsFor takes. */
export function axisFor(halvesList, width, inset = FIELD_INSET_PX, fallback = AXIS_DEFAULT){
  if(!Array.isArray(halvesList) || !halvesList.length || !(width > 0)) return fallback;
  let maxL = 0, maxR = 0;
  for(const h of halvesList){
    if(h.left  > maxL) maxL = h.left;
    if(h.right > maxR) maxR = h.right;
  }
  const clamp = (f)=> Math.min(0.9, Math.max(0.1, f));
  const lo = (maxL + inset)/width, hi = 1 - (maxR + inset)/width;
  if(lo <= hi) return clamp(Math.min(Math.max(AXIS_DEFAULT, lo), hi));

  // Wider than the field at every axis. The question stops being where the word
  // looks balanced and becomes how little the type has to give up, because
  // windowScale is about to shrink it. Both sides shrink by the same factor, so
  // the smallest shrink is the axis where the two allowances run out together:
  // the width split in proportion to the halves themselves. Splitting the
  // difference instead starves the narrow side and shrinks harder than it needs
  // to — which is how asking for XL could render SMALLER type than asking for L.
  const span = maxL + maxR;
  if(!(span > 0)) return clamp(AXIS_DEFAULT);
  return clamp((maxL*width + inset*(maxR - maxL)) / (width*span));
}

/* One scale for a whole ribbon window, set by its widest SINGLE word. A word
   cannot be split, so it is the only thing allowed to force the type down;
   phrases yield words instead (see chunkFit). Halves are measured at basePx and
   scale linearly with the font size. */
export function windowScale(halvesList, caps, basePx){
  let scale = 1;
  for(const h of halvesList){
    const need = Math.min(
      h.left  > 0 ? caps.left  / h.left  : Infinity,
      h.right > 0 ? caps.right / h.right : Infinity
    );
    if(need < scale) scale = need;
  }
  if(scale > 1) scale = 1;
  const floor = basePx > 0 ? SCALE_FLOOR_PX / basePx : 1;
  // a single unfittable token stops the shrink here and is allowed to overhang,
  // where the edge dissolve softens it. The only case where ink leaves the field.
  return Math.max(scale, Math.min(1, floor));
}

/* ORP halves: measured from the BOLD pivot letter's centre, because bold is the
   state the focal word is actually painted in. Bolding the pivot is the one thing
   that changes a word's metrics, so the extra width lands on the right side. */
export function halvesFor(m, i){
  const grow = m.wPivB[i] - m.wPiv[i];
  const pivC = m.preL[i] + m.wPre[i] + m.wPivB[i]/2;
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

/* Which words get to set a whole document's type size.

   A scale computed per ribbon window steps every time the window rebuilds: the
   same passage rendered at 62px, then 57px, then 49px, because each window is
   sized by whatever its own widest word happens to be. The reader sees the type
   lurch mid-sentence. One size for the document fixes that, and the widest
   ORDINARY word is what sets it.

   "Ordinary" has to be earned, or one URL shrinks an entire book. The cap is the
   longer of OUTLIER_CHARS and twice the median length. Twice the median rather
   than a high percentile because a percentile is only meaningful once there are
   enough words to have a tail — on a short pasted passage the 95th percentile IS
   the rogue token. The median is robust at every length, so compound-heavy prose
   raises its own ceiling while a lone URL never does.

   Anything past the cap is an outlier and shrinks for its own beat — a
   once-a-chapter event, not a strobe. If the cap would exclude everything, it is
   not describing an outlier any more, so the whole document is used.

   Returns the longest distinct words under the cap, longest first. */
export function sizingSample(words, sample = SIZING_SAMPLE, minCap = OUTLIER_CHARS){
  if(!Array.isArray(words) || !words.length) return [];
  const lens = words.map(w => w.length).sort((a,b) => a-b);
  const median = lens[Math.floor(lens.length/2)];
  const cap = Math.max(minCap, median*2);
  const ranked = [...words].sort((a,b) => b.length - a.length);
  const seen = new Set(), out = [];
  for(const w of ranked){
    if(w.length > cap) continue;
    const k = w.toLowerCase();
    if(seen.has(k)) continue;
    seen.add(k); out.push(w);
    if(out.length >= sample) break;
  }
  // every word was past the cap: it is describing the document, not an outlier
  if(!out.length) for(const w of ranked.slice(0, sample)) out.push(w);
  return out;
}

/* The phrase yields before the type does: take as many words as fit at the
   current size, down to one. One word that still does not fit is the only thing
   that reaches windowScale. */
export function chunkFit(m, start, maxChunk, caps, hybrid){
  const room = m.inkL.length - start;
  const cap = Math.max(1, Math.min(maxChunk, room));
  let best = 1;
  for(let n=1;n<=cap;n++){
    if(fitsAxis(blockHalves(m, start, n, hybrid), caps)) best = n;
    else break;
  }
  return best;
}
