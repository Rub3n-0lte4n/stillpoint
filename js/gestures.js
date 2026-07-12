/* Gestures — the surfaces obey the finger.
   Stage: vertical drag = speed, horizontal swipe = sentence step, pinch = text
   size, hold = mark. Sheets: drag-anywhere with velocity dismissal. Library
   rows: swipe to delete. Pure math is exported for tests; the recognizers wire
   the events. Specs: docs/superpowers/specs/2026-07-11-stage-gestures-design.md
   and docs/superpowers/specs/2026-07-12-seamless-surfaces-design.md */

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

/* ---- shared physics ---- */

// Release velocity (px/ms) from a trail of {t, v} samples, read over a short
// trailing window so a pause mid-drag doesn't inherit the approach speed.
export function velocityFrom(samples, windowMs = 100){
  if(!samples || samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  let first = samples[0];
  for(let i = samples.length - 2; i >= 0; i--){
    if(last.t - samples[i].t <= windowMs) first = samples[i];
    else break;
  }
  const dt = last.t - first.t;
  return dt > 0 ? (last.v - first.v) / dt : 0;
}

/* ---- sheet physics ---- */

// Downward follows the finger 1:1; upward compresses smoothly toward a small
// cap — the sheet is already at rest, it only hints that it heard you.
export function sheetOffset(dy, cap = 24, k = 72){
  return dy >= 0 ? dy : -cap * (1 - Math.exp(dy / k));
}

// Release: dismiss on a real downward fling, or past 40% of the sheet's height
// without meaningful upward motion; anything else settles back open.
export function sheetRelease(offset, vy, height){
  if(offset <= 0) return "settle";
  if(vy > 0.5) return "dismiss";
  if(offset > height * 0.4 && vy > -0.15) return "dismiss";
  return "settle";
}

/* ---- library row swipe ---- */

// offset ≤ 0 is the leftward reveal. A rightward fling always closes; past 55%
// of the row (or a hard leftward fling that cleared the action) deletes; past
// half the reveal (or a slower leftward fling with real travel) rests open on
// the action; otherwise the row closes.
export function rowRelease(offset, vx, width, reveal = 88){
  if(vx > 0.25) return "closed";
  if(-offset > width * 0.55 || (vx < -0.8 && -offset > reveal)) return "delete";
  if(-offset > reveal * 0.5 || (vx < -0.2 && -offset > 20)) return "open";
  return "closed";
}

/* Recognizer. callbacks:
   getWpm()            → current wpm (sampled when a vertical drag locks)
   onSpeed(v, phase)   → live value during "move", final on "end"
   getSizeIndex()      → current index into the size steps
   setSizeIndex(i)     → apply a size step
   onSwipe(dir)        → 1 = rightward, -1 = leftward
   onHold()            → a single pointer held still for the hold beat
   Returns { consumed() } — true once if a gesture happened; the caller uses it
   to swallow the click that follows a drag/swipe/pinch/hold. */
export function stageGestures(el, cb){
  const HOLD_MS = 450;            // the app's shared hold beat (steppers, mark)
  const pts = new Map();          // pointerId → {x, y}
  let mode = null;                // null | "h" | "v" | "pinch" | "dead"
  let sx = 0, sy = 0;
  let startWpm = 0, startDist = 1, startIdx = 0;
  let consumed = false;
  let holdTimer = null;

  const dist2 = ()=>{ const [a,b] = [...pts.values()]; return Math.hypot(a.x-b.x, a.y-b.y) || 1; };
  const clearHold = ()=>{ clearTimeout(holdTimer); holdTimer = null; };

  el.addEventListener("pointerdown", (e)=>{
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try{ el.setPointerCapture(e.pointerId); }catch(err){}
    if(pts.size === 1){
      mode = null; consumed = false;
      sx = e.clientX; sy = e.clientY;
      // still inside the slop when the beat lands → a hold, not a tap
      if(cb.onHold){
        clearHold();
        holdTimer = setTimeout(()=>{
          holdTimer = null;
          if(mode === null && pts.size === 1){ mode = "dead"; consumed = true; cb.onHold(); }
        }, HOLD_MS);
      }
    }else if(pts.size === 2){
      clearHold();
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
      if(mode){ clearHold(); consumed = true; if(mode === "v") startWpm = cb.getWpm(); }
    }
    if(mode === "v") cb.onSpeed(dragWpm(startWpm, dy), "move");
  });

  const finish = (e, cancelled)=>{
    if(!pts.has(e.pointerId)) return;
    clearHold();
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

/* Sheet drag — the whole sheet is the handle, not just the grabber.
   Non-passive TOUCH events (not pointer events) so an undecided gesture can be
   handed back to native scrolling with its momentum intact: the first move past
   6px decides — downward with every scroller under the finger at rest → the
   sheet owns the gesture (preventDefault); anything else → native scroll.
   A touch during any sheet animation freezes it in place and drags from there.
   callbacks: enabled() → sheets exist at this viewport; onClose() → commit the
   dismissal (class flip); onProgress(p|null) → scrim tracking, null = release. */
export function sheetDrag(sheet, { enabled, onClose, onProgress }){
  let y0 = 0, startOff = 0, dragging = false, dead = false, moved = false;
  let samples = [];
  const height = ()=> sheet.getBoundingClientRect().height || 1;

  // live translateY, so a drag can catch a sheet mid-animation
  const currentOffset = ()=>{
    const t = getComputedStyle(sheet).transform;
    if(!t || t === "none") return 0;
    const nums = (t.match(/\(([^)]+)\)/) || [,""])[1].split(",");
    return parseFloat(nums.length > 6 ? nums[13] : nums[5]) || 0;
  };
  // any scrollable ancestor between the finger and the sheet not at its top?
  const scrolledAbove = (from)=>{
    for(let el = from; el; el = el.parentElement){
      if(el.scrollTop > 0 && el.scrollHeight > el.clientHeight) return true;
      if(el === sheet) break;
    }
    return false;
  };
  const setOffset = (off)=>{
    sheet.style.transform = `translateY(${off}px)`;
    if(onProgress) onProgress(Math.min(1, Math.max(0, off / height())));
  };
  const release = ()=>{
    sheet.style.transition = ""; sheet.style.transform = "";
    if(onProgress) onProgress(null);
  };

  sheet.addEventListener("touchstart", (e)=>{
    dead = !enabled() || e.touches.length !== 1;
    dragging = false; moved = false;
    if(dead) return;
    y0 = e.touches[0].clientY;
    startOff = currentOffset();
    samples = [{ t: e.timeStamp, v: y0 }];
    if(startOff > 0.5){                    // catch mid-animation and freeze
      dragging = true;
      sheet.style.transition = "none";
      setOffset(startOff);
    }
  }, { passive: true });

  sheet.addEventListener("touchmove", (e)=>{
    if(dead || e.touches.length !== 1) return;
    const y = e.touches[0].clientY;
    const dy = y - y0;
    if(!dragging){
      if(Math.abs(dy) < 6) return;
      if(dy < 0 || scrolledAbove(e.target)){ dead = true; return; }  // native scroll's gesture
      dragging = true;
      sheet.style.transition = "none";
    }
    moved = true;
    e.preventDefault();                    // the sheet owns this gesture
    samples.push({ t: e.timeStamp, v: y });
    if(samples.length > 8) samples.shift();
    setOffset(sheetOffset(startOff + dy));
  }, { passive: false });

  sheet.addEventListener("touchend", (e)=>{
    if(dead || !dragging){ dead = false; return; }
    dragging = false;
    const off = sheetOffset(startOff + (e.changedTouches[0].clientY - y0));
    const h = height();
    // a touch that never moved (caught an animation, or just rested) settles
    const act = moved ? sheetRelease(off, velocityFrom(samples), h) : "settle";
    if(act === "dismiss"){
      const d = Math.round(Math.max(140, Math.min(320, (h - off) / Math.max(velocityFrom(samples), 1.4))));
      sheet.style.transition = `transform ${d}ms var(--ease-out), visibility ${d}ms`;
      sheet.style.transform = "translateY(103%)";
      onClose();
      setTimeout(release, d + 60);         // hand the sheet back to its class styles
    } else release();
  });
  sheet.addEventListener("touchcancel", ()=>{
    if(dragging){ dragging = false; release(); }
    dead = false;
  });
}

/* Library row swipe — leftward reveal of a pinned action, list style.
   Pointer events on a pan-y row: vertical movement stays the page's scroll
   (arriving as pointercancel), horizontal movement past the slop owns the row.
   callbacks: onCommit() → delete choreography; onOpenChange(open) → let the
   caller keep a single row open; onZoneTick() → entering the will-delete zone. */
export function rowSwipe(row, face, { reveal = 88, onCommit, onOpenChange, onZoneTick }){
  let x0 = 0, y0 = 0, mode = null, off = 0, open = false, consumed = false, will = false;
  let samples = [];
  const width = ()=> row.getBoundingClientRect().width || 1;
  const setX = (x, animate)=>{
    face.style.transition = animate ? "" : "none";
    face.style.transform = x ? `translateX(${x}px)` : "";
  };
  const setOpen = (o)=>{ if(open !== o){ open = o; if(onOpenChange) onOpenChange(o); } };
  const close = ()=>{ setOpen(false); setX(0, true); };

  row.addEventListener("pointerdown", (e)=>{
    mode = null; consumed = false; will = false;
    x0 = e.clientX; y0 = e.clientY;
    off = open ? -reveal : 0;
    samples = [{ t: e.timeStamp, v: e.clientX }];
  });
  row.addEventListener("pointermove", (e)=>{
    if(mode === "dead" || !e.buttons) return;   // buttons: ignore hover moves
    const dx = e.clientX - x0, dy = e.clientY - y0;
    if(!mode){
      const a = axisLock(dx, dy);
      if(!a) return;
      if(a === "v"){ mode = "dead"; return; }   // the page scroll owns vertical
      mode = "h"; consumed = true;
      try{ row.setPointerCapture(e.pointerId); }catch(err){}
    }
    samples.push({ t: e.timeStamp, v: e.clientX });
    if(samples.length > 8) samples.shift();
    const eff = (open ? -reveal : 0) + dx;
    off = eff > 0 ? Math.min(10, eff * 0.2) : Math.max(eff, -width());  // right of rest: a nudge
    setX(off, false);
    const w = -off > width() * 0.55;
    if(w !== will){
      will = w;
      row.classList.toggle("will-delete", w);
      if(w && onZoneTick) onZoneTick();          // one tick per crossing in
    }
  });
  const finish = (e, cancelled)=>{
    if(mode !== "h"){ mode = null; return; }
    mode = null;
    row.classList.remove("will-delete"); will = false;
    const act = cancelled ? "closed" : rowRelease(off, velocityFrom(samples), width(), reveal);
    if(act === "delete"){ setOpen(false); onCommit(); }
    else if(act === "open"){ setOpen(true); setX(-reveal, true); }
    else close();
  };
  row.addEventListener("pointerup", (e)=>finish(e, false));
  row.addEventListener("pointercancel", (e)=>finish(e, true));

  return {
    close,
    isOpen: ()=> open,
    consumed: ()=>{ const c = consumed; consumed = false; return c; },
  };
}
