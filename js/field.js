/* ---------------- reading-field geometry ----------------
   Pure maths for the question "does this fit, and at what size". No DOM, no app
   state, so it is testable in node.

   The field is short for one reason: ORP pins the PIVOT LETTER to the axis, and
   words are lopsided around their pivot (it sits about a third in). A centred
   pivot therefore spends only ~40% of the screen on the side the word actually
   grows into, so a word needs roughly 1.45x its own width in screen space.
   Moving the axis left buys that width back instead of shrinking the type. */

export const AXIS_DEFAULT   = 0.5;
export const SCALE_FLOOR_PX = 22;   // below this the type stops yielding; see windowScale
export const FIELD_INSET_PX = 8;    // breathing room at each edge of the field

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

/* Both sides measured from the axis outward. The axis gets axisFrac of the field
   on its left and the rest on its right, so each side is checked against its own
   allowance. Checking total width instead is the bug this replaces. */
export function fitsAxis(halves, axisFrac, field){
  return halves.left  <=      axisFrac  * field + 0.01 &&
         halves.right <= (1 - axisFrac) * field + 0.01;
}

/* One scale for a whole ribbon window, set by its widest SINGLE word. A word
   cannot be split, so it is the only thing allowed to force the type down;
   phrases yield words instead (see chunkFit). Halves are measured at basePx and
   scale linearly with the font size. */
export function windowScale(halvesList, axisFrac, field, basePx){
  const leftCap  =      axisFrac  * field;
  const rightCap = (1 - axisFrac) * field;
  let scale = 1;
  for(const h of halvesList){
    const need = Math.min(
      h.left  > 0 ? leftCap  / h.left  : Infinity,
      h.right > 0 ? rightCap / h.right : Infinity
    );
    if(need < scale) scale = need;
  }
  if(scale > 1) scale = 1;
  const floor = basePx > 0 ? SCALE_FLOOR_PX / basePx : 1;
  // a single unfittable token stops the shrink here and is allowed to overhang,
  // where the edge dissolve softens it. The only case where ink leaves the field.
  return Math.max(scale, Math.min(1, floor));
}
