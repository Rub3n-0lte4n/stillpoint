/* Stage gestures — the reading surface understands more than taps.
   Vertical drag = speed, horizontal swipe = sentence step, pinch = text size.
   Pure math is exported for tests; stageGestures() wires the pointer events.
   Spec: docs/superpowers/specs/2026-07-11-stage-gestures-design.md */

// Axis lock: null until movement passes the slop, then the dominant axis.
// Anything under the slop stays a tap — no added tap latency.
export function axisLock(dx, dy, slop = 10){
  if(Math.abs(dx) < slop && Math.abs(dy) < slop) return null;
  return Math.abs(dx) >= Math.abs(dy) ? "h" : "v";
}

// Vertical drag → wpm. Up = faster; one `step` per `px` of travel, clamped.
export function dragWpm(startWpm, dy, { px = 12, step = 25, min = 150, max = 800 } = {}){
  const v = startWpm + Math.round(-dy / px) * step;
  return Math.min(max, Math.max(min, v));
}

// Pinch → size index. Each ×1.25 of finger spread is one step through the sizes.
export function pinchIndex(startIndex, ratio, count = 4){
  const shift = Math.round(Math.log(Math.max(0.01, ratio)) / Math.log(1.25));
  return Math.min(count - 1, Math.max(0, startIndex + shift));
}

// Horizontal swipe on release: far enough, and clearly more horizontal than not.
export function swipeDir(dx, dy, dist = 48){
  if(Math.abs(dx) < dist || Math.abs(dx) < Math.abs(dy) * 1.5) return 0;
  return dx > 0 ? 1 : -1;   // 1 = rightward
}

/* Recognizer. callbacks:
   getWpm()            → current wpm (sampled when a vertical drag locks)
   onSpeed(v, phase)   → live value during "move", final on "end"
   getSizeIndex()      → current index into the size steps
   setSizeIndex(i)     → apply a size step
   onSwipe(dir)        → 1 = rightward, -1 = leftward
   Returns { consumed() } — true once if a gesture happened; the caller uses it
   to swallow the click that follows a drag/swipe/pinch. */
export function stageGestures(el, cb){
  const pts = new Map();          // pointerId → {x, y}
  let mode = null;                // null | "h" | "v" | "pinch" | "dead"
  let sx = 0, sy = 0;
  let startWpm = 0, startDist = 1, startIdx = 0;
  let consumed = false;

  const dist2 = ()=>{ const [a,b] = [...pts.values()]; return Math.hypot(a.x-b.x, a.y-b.y) || 1; };

  el.addEventListener("pointerdown", (e)=>{
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try{ el.setPointerCapture(e.pointerId); }catch(err){}
    if(pts.size === 1){
      mode = null; consumed = false;
      sx = e.clientX; sy = e.clientY;
    }else if(pts.size === 2){
      if(mode === "v") cb.onSpeed(cb.getWpm(), "end");   // drag hands off to pinch
      mode = "pinch"; consumed = true;
      startDist = dist2();
      startIdx = cb.getSizeIndex();
    }
  });

  el.addEventListener("pointermove", (e)=>{
    if(!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if(mode === "pinch"){
      if(pts.size === 2) cb.setSizeIndex(pinchIndex(startIdx, dist2() / startDist));
      return;
    }
    if(mode === "dead" || pts.size !== 1) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if(!mode){
      mode = axisLock(dx, dy);
      if(mode){ consumed = true; if(mode === "v") startWpm = cb.getWpm(); }
    }
    if(mode === "v") cb.onSpeed(dragWpm(startWpm, dy), "move");
  });

  const finish = (e, cancelled)=>{
    if(!pts.has(e.pointerId)) return;
    const wasPinch = mode === "pinch";
    pts.delete(e.pointerId);
    if(wasPinch){ mode = pts.size ? "dead" : null; return; }
    if(mode === "dead"){ if(pts.size === 0) mode = null; return; }
    if(mode === "v") cb.onSpeed(dragWpm(startWpm, e.clientY - sy), "end");
    else if(mode === "h" && !cancelled){
      const dir = swipeDir(e.clientX - sx, e.clientY - sy);
      if(dir) cb.onSwipe(dir);
    }
    mode = null;
  };
  el.addEventListener("pointerup", (e)=>finish(e, false));
  el.addEventListener("pointercancel", (e)=>{ consumed = true; finish(e, true); });

  return { consumed: ()=>{ const c = consumed; consumed = false; return c; } };
}
