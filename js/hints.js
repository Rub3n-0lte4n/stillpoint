/* Progressive hints — teach the way games do. One mechanic at a time, at a
   calm moment, gated by days of use and by modality, and never re-taught once
   the reader already does it. The pure core is exported for tests; the Hints
   wrapper owns the fp_hints_v1 ledger.
   Spec: docs/superpowers/specs/2026-07-12-progressive-hints-and-guide-design.md */

import { todayKey } from "./streak.js";

// Ordered: earlier entries teach first. minDay counts distinct local days the
// reader has been opened, so the drip spreads across days of use, not visits.
export const HINTS = [
  { id:"zones",     minDay:1, touch:false, where:"reader",
    text:"Swipe the reading area, or tap its edges, to step a sentence.",
    pointerText:"Click the edges of the reading area to step a sentence." },
  { id:"speeddrag", minDay:2, touch:true,  where:"reader",
    text:"Drag up or down on the reading area to change speed." },
  { id:"holdmark",  minDay:3, touch:true,  where:"reader",
    text:"Hold the word while it streams to highlight that sentence." },
  { id:"rowswipe",  minDay:3, touch:true,  where:"landing",
    text:"Swipe a book to the left to remove it." },
  { id:"pinch",     minDay:4, touch:true,  where:"reader",
    text:"Pinch the reading area to change the text size." },
];

/* ---- pure core (tested in test/hints.test.mjs) ---- */
// One hint a day, everywhere; touch-only gestures never hinted at a mouse;
// anything already shown, or already performed organically, stays quiet.
export function nextHint(st, { touch, where, today, libSize = 0 }){
  if(st.lastShownDay === today) return null;
  for(const h of HINTS){
    if(h.where !== where) continue;
    if(h.touch && !touch) continue;
    if((st.shown && st.shown[h.id]) || (st.used && st.used[h.id])) continue;
    if((st.dayCount || 0) < h.minDay) continue;
    if(h.id === "rowswipe" && libSize < 2) continue;
    return h;
  }
  return null;
}

/* ---- ledger ---- */
const KEY = "fp_hints_v1";
function load(){
  let st = null;
  try{ st = JSON.parse(localStorage.getItem(KEY) || "null"); }catch(e){}
  if(!st || typeof st !== "object") st = {};
  st.shown = st.shown || {}; st.used = st.used || {};
  st.dayCount = st.dayCount || 0; st.lastDay = st.lastDay || null;
  // the pre-engine zones toast (fp_hint_zones_v1) counts as already taught
  try{ if(localStorage.getItem("fp_hint_zones_v1") && !st.shown.zones) st.shown.zones = Date.now(); }catch(e){}
  return st;
}
function save(st){ try{ localStorage.setItem(KEY, JSON.stringify(st)); }catch(e){} }

export const Hints = {
  // a reading day: bump once per distinct local day the reader opens
  readerOpened(){
    const st = load(), day = todayKey();
    if(st.lastDay !== day){ st.lastDay = day; st.dayCount = (st.dayCount || 0) + 1; save(st); }
  },
  // performing the mechanic is graduation — it will never be hinted
  used(id){
    const st = load();
    if(st.used[id]) return;
    st.used[id] = Date.now(); save(st);
  },
  // the next due hint for this surface, or null; recording is a separate step
  next({ where, libSize }){
    const touch = typeof matchMedia === "function" && matchMedia("(hover:none)").matches;
    return nextHint(load(), { touch, where, today: todayKey(), libSize });
  },
  markShown(id){
    const st = load();
    st.shown[id] = Date.now(); st.lastShownDay = todayKey(); save(st);
  },
};
