// Stillpoint — app entry. Wires the reader UI, playback engine, and document loading.
import { tokenize, orpIndex, esc, DEMO, HERO, sentenceFactors, sentenceStart, sentenceEnd, chapterItems, chapterGrid, chapterAt } from "./text.js";
import { Haptics } from "./haptics.js";
import { parsePDF, parseEPUB } from "./parsers.js";
import { Store } from "./store.js";
import { modeForKind as resolveMode, defaultBlockMode, indexBlocks, blocksToHandle, isAutoDetected } from "./blockmode.js";
import { toggleRange, serializeHighlights, deserializeHighlights, rangeText, exportMarkdown } from "./highlights.js";
import { THEMES, verifyPatronCode, isPatronTheme, themeById } from "./patron.js";
import { Streak, GOAL_MIN, GOAL_MAX, GOAL_STEP } from "./streak.js";
import { stageGestures, sheetDrag, rowSwipe } from "./gestures.js";
import { Hints } from "./hints.js";
import { mergeLibrary, LIB_MAX } from "./library.js";

const BASE_TITLE = document.title;   // restored when leaving the reader

/* ---------------- state ---------------- */
const S = {
  tokens: [],          // [{w, end, pause}]
  units: [],           // [{title, start}]  (chapters/pages)
  chapters: [{ title: null, start: 0, end: 1 }], // chapterGrid() — scrubber scope
  curCh: -1,           // current chapter segment (-1 = force meta refresh)
  index: 0,
  playing: false,
  mode: "orp",
  chunk: 1,
  wpm: 400,
  size: 62,
  title: "Untitled",
  meta: "",
  key: null,           // localStorage key for resume
  timer: null,
  readMs: 0,           // accumulated active reading time (excludes pauses)
  playStart: null,     // wall-clock when the current run started streaming
  rampStart: 0,        // token index where the current run began (for speed ramp)
  // --- Phase 2: non-linear blocks ---
  blocks: [],          // sidecar from the parser: [{id, after, kind, payload, unit}]
  sortedBlocks: [],    // indexBlocks(blocks) — sorted by `after` for hot-loop lookup
  blockMode: null,     // per-document preference {default, <kind> overrides, dismissed[]}
  shownBlocks: null,   // Set of block ids already presented/collected this session
  collected: [],       // skip+collect entries (in document order)
  cardOpen: false,     // a still card / page view is currently raised
  pendingRange: null,  // [lo,hi) token window still holding un-presented blocks
  // --- Phase 3: retention aids ---
  sentenceFactor: null,// Float32Array — per-token smart-pacing slowdown factor
  highlights: [],      // [{start,end,unit,ts}] marked ranges for this document
  hlUnitShown: null,   // Set of units whose end-of-chapter review toast was offered
};
const KIND_LABEL = { table:"Table", image:"Image", figure:"Figure", equation:"Equation", code:"Code", quote:"Quote" };
function modeForKind(kind){ return resolveMode(S.blockMode, kind); }
const $ = (id) => document.getElementById(id);
const PRESETS = [[250,"Comfortable"],[400,"Focus"],[550,"Fast"],[700,"Skim"]];
const REWIND_WORDS = 5;   // back up on resume for re-orientation
const RAMP_WORDS = 15;    // ease speed up over the first N words of a run
const RAMP_MIN = 0.6;     // start each run at 60% of target WPM
const settings = { countdown:true, context:true, smartPacing:true, zen:true, moreOpen:false };  // reading aids + dock state (persisted)

/* keep the screen awake while streaming — phones otherwise dim and lock mid-chapter,
   because reading here never touches the screen */
let wakeLock = null;
async function acquireWakeLock(){
  try{
    if(!("wakeLock" in navigator)) return;
    const lock = await navigator.wakeLock.request("screen");
    if(!S.playing){ lock.release(); return; }   // paused while the request was in flight
    wakeLock = lock;
    // the OS may reclaim the lock on its own (backgrounding, battery saver);
    // if the reader is still visibly streaming when it does, quietly take it back
    lock.addEventListener("release", ()=>{
      if(wakeLock===lock) wakeLock=null;
      if(S.playing && !document.hidden) acquireWakeLock();
    });
  }catch(e){}
}
function releaseWakeLock(){ try{ if(wakeLock) wakeLock.release(); }catch(e){} wakeLock = null; }

/* immersive reading: once the stream settles, fade the chrome so only the word remains.
   pause() (any tap, Space, finishing) brings it back. */
let zenTimer = null;
function armZen(){ clearTimeout(zenTimer); if(!settings.zen) return; zenTimer = setTimeout(()=>{ if(S.playing && settings.zen) $("reader").classList.add("zen"); }, 1800); }
function disarmZen(){ clearTimeout(zenTimer); zenTimer = null; $("reader").classList.remove("zen"); }

/* one-time home-screen nudge, offered only after the first finished book */
let deferredInstall = null;
window.addEventListener("beforeinstallprompt", (e)=>{ e.preventDefault(); deferredInstall = e; });
function isStandalone(){ return matchMedia("(display-mode: standalone)").matches || navigator.standalone === true; }
function maybeNudgeInstall(){
  try{
    if(isStandalone() || localStorage.getItem("fp_install_nudged_v1")) return;
    localStorage.setItem("fp_install_nudged_v1","1");
    setTimeout(()=>{
      toast("Read like this often? Put Stillpoint on your home screen.", { duration:9000, action:"Add", onAction:()=>{
        if(deferredInstall){ deferredInstall.prompt(); deferredInstall = null; }
        else toast("Open your browser's share or menu button and choose Add to Home Screen.", { duration:9000 });
      }});
    }, 1200);
  }catch(e){}
}

/* ---------------- centred ribbon ----------------
   One centred line of words. The current word's pivot letter is snapped onto the
   focal point and held STILL for its whole dwell (no sliding) so it stays readable
   at speed; dim neighbours sit on either side for context, refreshing in place. */
let ribbonStart = 0, ribbonLast = -1, ribbonOffset = 0;
// Geometry cache, filled once per rebuilt window (and again after resize or a
// size change): per word, at the base font size, the left edge, full width,
// prefix left/width, and the pivot letter's width both plain and BOLD (bolding
// the pivot is the one thing that changes metrics). Every tick then places the
// ribbon with arithmetic and a transform write — the old path forced a
// synchronous reflow per word (fontSize reset + getBoundingClientRect).
let G = null;
let ribbonScaled = false;   // fontSize currently shrunk by the legacy fit path
function invalidateRibbon(){ G = null; ribbonLast = -1; }

function buildRibbon(){
  const start = Math.max(0, S.index - 4);
  const end = Math.min(S.tokens.length-1, S.index + 14);
  let html="";
  for(let k=start;k<=end;k++){
    const w = S.tokens[k].w, oi = orpIndex(w);
    html += `<span class="rw" data-i="${k}"><span class="rpre">${esc(w.slice(0,oi))}</span>`+
            `<span class="rpiv">${esc(w[oi]||"")}</span><span class="rpost">${esc(w.slice(oi+1))}</span></span>`;
  }
  const rb=$("ribbon"); rb.innerHTML=html; ribbonStart=start; ribbonLast=end;
  measureRibbon();
}
// Two measurement passes per rebuild: plain, then with every pivot letter bold
// (the `mb` class). Bold width per word is position-independent, so the two
// passes are enough to place ANY marking state exactly, without ever measuring
// again inside the hot loop.
function measureRibbon(){
  const rb=$("ribbon"), stage=$("stage");
  rb.style.fontSize="";                                  // measure at the base size
  rb.style.transform="translate(0px, -50%)";             // a known frame for the maths
  ribbonOffset = 0; ribbonScaled = false;
  const els=[...rb.children];
  const rbRect = rb.getBoundingClientRect();             // pass 1 (plain)
  const left=[], w=[], preL=[], wPre=[], wPiv=[];
  for(const el of els){
    const r=el.getBoundingClientRect();
    left.push(r.left-rbRect.left); w.push(r.width);
    const pr=el.firstChild.getBoundingClientRect();
    preL.push(pr.left-rbRect.left); wPre.push(pr.width);
    wPiv.push(el.children[1].getBoundingClientRect().width);
  }
  rb.classList.add("mb");
  const wPivB = els.map(el=>el.children[1].getBoundingClientRect().width);  // pass 2 (bold)
  rb.classList.remove("mb");
  const sr = stage.getBoundingClientRect();
  G = { els, left, w, preL, wPre, wPiv, wPivB, marked:[],
        l0: rbRect.left, stageC: sr.left + sr.width/2, avail: stage.clientWidth*0.9 };
}
// Pure placement from the cache. ORP: the current word's bold pivot centre on
// the stage centre. RSVP/Hybrid: the chunk as an optical block (Hybrid's bold
// pivots widen it — the widths are known, so the edges are computed, not read).
function placeRibbon(){
  if(!G) return;
  const rb=$("ribbon");
  const i0 = S.index - ribbonStart;
  if(i0<0 || i0>=G.left.length) return;
  let anchorRel, width;
  if(S.mode==="orp"){
    anchorRel = G.preL[i0] + G.wPre[i0] + G.wPivB[i0]/2;
    width = G.w[i0] + (G.wPivB[i0]-G.wPiv[i0]);
  } else {
    const last = Math.min(S.index+S.chunk, S.tokens.length) - ribbonStart - 1;
    const lastC = Math.min(last, G.left.length-1);
    let shift = 0;
    if(S.mode==="hybrid") for(let k=i0;k<lastC;k++) shift += G.wPivB[k]-G.wPiv[k];
    const lastW = S.mode==="hybrid" ? G.w[lastC] + (G.wPivB[lastC]-G.wPiv[lastC]) : G.w[lastC];
    const lo = G.left[i0], hi = G.left[lastC] + shift + lastW;
    anchorRel = (lo+hi)/2;
    width = hi-lo;
  }
  // rare overflow (a long word on a narrow phone): the legacy measured path
  // still handles the shrink, exactly as before
  if(width > G.avail){ fitRibbon(); centerRibbon(); ribbonScaled = !!rb.style.fontSize; return; }
  if(ribbonScaled){ rb.style.fontSize=""; ribbonScaled=false; }
  const target = Math.round((G.stageC - G.l0 - anchorRel)*100)/100;
  rb.style.transform = `translate(${target}px, -50%)`;
  ribbonOffset = target;
}
// Mark the current chunk. ORP anchors the focal word's pivot letter; Hybrid
// gives EVERY word in the phrase its own amber anchor (landing points for the
// eye's hops); RSVP stays unaccented. Classes go on before fitRibbon measures,
// so the bold anchors are part of the measured width.
function markChunk(){
  if(!G) return;
  for(const el of G.marked) el.classList.remove("on","pivot");
  G.marked.length = 0;
  const endChunk = Math.min(S.index+S.chunk, S.tokens.length);
  for(let k=S.index;k<endChunk;k++){
    const el=G.els[k-ribbonStart];
    if(!el) continue;
    el.classList.add("on");
    if(S.mode==="hybrid") el.classList.add("pivot");
    G.marked.push(el);
  }
  if(S.mode==="orp"){
    const pw=G.els[S.index-ribbonStart];
    if(pw && !pw.classList.contains("pivot")){ pw.classList.add("pivot"); if(!G.marked.includes(pw)) G.marked.push(pw); }
  }
}
// Snap the ribbon into place — INSTANT (no slide), so the text is stationary
// for its whole dwell and stays readable at speed. ORP puts the focal letter
// exactly on the stage centre (the word hangs around it; the eye never moves).
// RSVP and Hybrid show a phrase, so the phrase itself centres as a block —
// its optical middle on the centre line, never lopsided by word lengths.
function centerRibbon(){
  const rb=$("ribbon"), stage=$("stage");
  const sr = stage.getBoundingClientRect();
  let anchor;
  if(S.mode==="orp"){
    const piv = rb.querySelector(`.rw[data-i="${S.index}"] .rpiv`);
    if(!piv) return;
    const pr = piv.getBoundingClientRect();
    anchor = pr.left + pr.width/2;
  } else {
    const endChunk = Math.min(S.index+S.chunk, S.tokens.length);
    let left=Infinity, right=-Infinity;
    for(let k=S.index;k<endChunk;k++){
      const el=rb.querySelector(`.rw[data-i="${k}"]`);
      if(!el) continue;
      const r=el.getBoundingClientRect();
      if(r.left<left) left=r.left;
      if(r.right>right) right=r.right;
    }
    if(right<=left) return;
    anchor = (left+right)/2;
  }
  const target = Math.round((ribbonOffset + (sr.left+sr.width/2) - anchor)*100)/100;
  rb.style.transform = `translate(${target}px, -50%)`;
  ribbonOffset = target;
}
// Shrink the focal word only when it would overflow the stage (e.g. long words on a
// narrow phone) — short words keep the chosen size; long words scale down to stay readable
// instead of running off the edges into the fade mask.
function fitRibbon(){
  const rb=$("ribbon"), stage=$("stage");
  rb.style.fontSize="";   // back to the CSS-chosen base each step
  const endChunk = Math.min(S.index+S.chunk, S.tokens.length);
  let left=Infinity, right=-Infinity;
  for(let k=S.index;k<endChunk;k++){
    const el=rb.querySelector(`.rw[data-i="${k}"]`);
    if(!el) continue;
    const r=el.getBoundingClientRect();
    if(r.left<left) left=r.left;
    if(r.right>right) right=r.right;
  }
  if(right<=left) return;
  const avail = stage.clientWidth * 0.9;       // leave a little breathing room from the edges
  const wordW = right-left;
  if(wordW > avail){
    const base = parseFloat(getComputedStyle(rb).fontSize) || 40;
    rb.style.fontSize = Math.max(16, base*(avail/wordW)) + "px";
  }
}
// Show the current position: focal word centred & still, neighbours dim alongside for context.
function render(){
  if(!S.tokens.length || S.index>=S.tokens.length) return;
  $("resting").classList.add("hidden");
  $("word").classList.add("hidden");
  const rb=$("ribbon"); rb.classList.remove("hidden");
  rb.classList.toggle("no-ctx", !settings.context);
  rb.classList.toggle("playing", S.playing);
  if(ribbonLast<0 || S.index<ribbonStart || (S.index+S.chunk-1) > ribbonLast-2) buildRibbon();
  markChunk();
  placeRibbon();
}

/* ---------------- playback loop ---------------- */
function step(){
  if(S.index>=S.tokens.length){ finish(); return; }   // reached the end
  render();
  const chunkTokens = S.tokens.slice(S.index, S.index+S.chunk);

  // gentle speed ramp: ease from RAMP_MIN up to full WPM over the first words of a run
  const since = S.index - S.rampStart;
  const ramp = Math.min(1, RAMP_MIN + (1-RAMP_MIN)*(since/RAMP_WORDS));
  // Phase 3 smart pacing: per-sentence complexity factor (1.0 for plain prose).
  const sp = settings.smartPacing;
  const f = (sp && S.sentenceFactor && S.sentenceFactor[S.index]) ? S.sentenceFactor[S.index] : 1;
  const perWord = (60000 / (S.wpm * ramp)) * f;

  let delay = perWord * chunkTokens.length;
  const last = chunkTokens[chunkTokens.length-1];
  if(last.end) delay += perWord*(sp ? 1.3 : 0.9);
  else if(last.pause) delay += perWord*(sp ? 0.6 : 0.45);
  const longest = Math.max(...chunkTokens.map(t=>t.w.length));
  if(longest>8) delay += perWord*0.25;
  // extra breath at a structural (paragraph/page/chapter) boundary
  if(sp && isUnitEnd(S.index + S.chunk)) delay += perWord*1.1;

  const prev = S.index;
  S.index += S.chunk;
  updateProgress(true);
  saveProgress();

  // Phase 2: did the chunk we just consumed cross blocks? Cheap no-op for prose.
  // A single chunk can cross several blocks (consecutive figures share an `after`),
  // so drain the whole window: collect every skip block, halt on the first pause one.
  if(S.sortedBlocks.length){
    const { collect, present } = blocksToHandle(S.sortedBlocks, prev, S.index, S.blockMode, dismissedSet(), S.shownBlocks);
    for(const b of collect) collectBlock(b);   // route to appendix/index — do NOT halt
    if(present){
      S.pendingRange = [prev, S.index];        // the window may still hold more blocks
      presentBlock(present, modeForKind(present.kind));  // pause/hybrid — halt, return
      return;
    }
  }
  S.timer = setTimeout(()=>{ if(S.playing) step(); }, delay);
}
function play(){
  if(S.tokens.length===0) return;
  if(S.index>=S.tokens.length) S.index=0;
  if(S.index>0) S.index = Math.max(0, S.index - REWIND_WORDS);  // rewind for re-orientation
  S.playing = true;
  $("playIcon").innerHTML = '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>'; // pause icon
  $("playBtn").setAttribute("aria-label","Pause");
  updateProgress();
  acquireWakeLock();
  armZen();
  if(settings.countdown){
    countdownThenStep();
  } else {
    $("resting").classList.add("hidden"); $("word").classList.remove("hidden");
    S.rampStart = S.index; S.playStart = Date.now();
    step();
  }
}
// 3·2·1 countdown before streaming, so you can settle into the focal point.
function countdownThenStep(){
  const wordEl = $("word");
  $("resting").classList.add("hidden"); wordEl.classList.remove("hidden");
  $("ribbon").classList.add("hidden");
  let n = 3;
  const tick = ()=>{
    if(!S.playing) return;            // cancelled (user paused)
    if(n===0){ S.rampStart = S.index; S.playStart = Date.now(); step(); return; }
    wordEl.className = "word countdown";
    wordEl.innerHTML = `<span class="cd">${n}</span>`;
    n--;
    S.timer = setTimeout(tick, 300);
  };
  tick();
}
// Settle the running play segment into readMs AND the daily streak ledger.
// The one choke point for reading-time accrual. Crossing the daily goal is
// detected here — at a pause — which is exactly when the celebration may
// appear without ever interrupting the word stream.
function settleReading(){
  if(!S.playStart) return;
  const ms = Date.now()-S.playStart;
  S.readMs += ms; S.playStart = null;
  const { crossed, current } = Streak.addSeconds(ms/1000);
  if(crossed && !document.hidden)
    toast(current > 1 ? `Goal met. ${current} days in a row.` : "Goal met. Your streak starts today.");
  renderStreak();
}
function pause(){
  S.playing=false;
  clearTimeout(S.timer);
  releaseWakeLock();
  disarmZen();
  settleReading();
  $("ribbon").classList.remove("playing");   // brighten neighbours for orientation while paused
  $("playIcon").innerHTML = '<path d="M8 5v14l11-7z"/>';
  $("playBtn").setAttribute("aria-label","Play");
  saveProgress(true);
  maybeUpdateToast();   // an update that arrived mid-stream waited for this pause
}
function toggle(){
  if(S.cardOpen){ resumeFromCard(); return; }
  if(S.playing){ pause(); maybeHint("reader"); }   // a deliberate pause is the calm teaching moment
  else play();
}
// Progressive hints, the way games teach: one mechanic at a time, at a pause,
// never once the reader already performs it (see js/hints.js for the gating).
function maybeHint(where){
  if(document.hidden) return;
  const h = Hints.next({ where, libSize: loadLib().length });
  if(!h) return;
  Hints.markShown(h.id);
  // a hint speaks the reader's input language: no "swipe" at a mouse
  const touch = matchMedia("(hover:none)").matches;
  toast((touch ? h.text : h.pointerText) || h.text, { duration:7000, hint:true, action:"Guide", onAction:openGuide });
}
// Reached the end — show the session summary.
function finish(){
  pause();
  // Belief 5: value has now been given — the header Support pill may appear from here on.
  try{ localStorage.setItem("fp_finished_v1","1"); }catch(e){}
  $("supportPill").classList.remove("hidden");
  const words = S.tokens.length;
  const mins = S.readMs/60000;
  const avg = mins>0.05 ? Math.round(words/mins) : S.wpm;
  $("stWords").textContent = words.toLocaleString();
  $("stTime").textContent = fmt(S.readMs/1000);
  $("stWpm").textContent = avg.toLocaleString();
  $("doneSub").textContent = `You finished “${S.title}”.`;
  // quiet streak line — met: affirm the day; unmet: an honest, concrete nudge
  const sk = Streak.getState();
  if(sk.metToday) $("doneStreak").textContent = `Day ${sk.current} of your reading streak.`;
  else{
    const left = Math.max(1, Math.ceil((sk.goalMin*60 - sk.todaySec)/60));
    $("doneStreak").textContent = `${left} more minute${left===1?"":"s"} today ${sk.current>0 ? "keeps the streak" : "starts a streak"}.`;
  }
  // the review door only appears when something waits behind it
  const hl = S.highlights.length, rv = $("doneReview");
  if(rv){ rv.classList.toggle("hidden", hl===0); if(hl) rv.textContent = `Review ${hl} highlight${hl===1?"":"s"}`; }
  $("done").classList.add("show");
  $("doneLib").focus({preventScroll:true});   // move focus into the dialog
  maybeNudgeInstall();
}

// Keep Tab focus inside an open dialog (basic focus trap for the modals).
function trapTab(container, e){
  const sel='a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])';
  const list=[...container.querySelectorAll(sel)].filter(el=>el.offsetParent!==null && !el.closest(".hidden"));
  if(!list.length) return;
  const first=list[0], last=list[list.length-1], a=document.activeElement;
  if(e.shiftKey){ if(a===first || !container.contains(a)){ e.preventDefault(); last.focus(); } }
  else { if(a===last || !container.contains(a)){ e.preventDefault(); first.focus(); } }
}

/* ---------------- navigation ---------------- */
/* A change answers where your eyes are — the focal point — whatever the input.
   The dock readouts still update, but they may be zen-faded or simply outside
   the fovea, so the stage carries its own transient HUD: chevrons for steps,
   the gold number for speed. */
function zoneFlash(dir, big){
  const el=$("zoneFlash"); if(!el) return;
  el.textContent = dir<0 ? (big?"‹‹":"‹") : (big?"››":"›");
  el.classList.remove("l","r","on"); void el.offsetWidth;   // restart the animation
  el.classList.add(dir<0?"l":"r","on");
}
let ghostTimer=null;
function showSpeedGhost(v, holdMs=700){
  const g=$("speedGhost"); if(!g) return;
  $("sgVal").textContent=v;
  g.classList.add("on");
  clearTimeout(ghostTimer);
  if(holdMs) ghostTimer=setTimeout(()=>g.classList.remove("on"), holdMs);
}
// every interactive speed change routes here; setWpm alone stays silent for
// boot/prefs/import, which are not answers to a person's keypress
function nudgeWpm(v){ setWpm(Math.min(800, Math.max(150, v))); showSpeedGhost(S.wpm); }

function jumpTo(i){
  S.index = Math.max(0, Math.min(i, S.tokens.length-1));
  render(); updateProgress(); saveProgress(true);
}
// The chevron only ghosts in when the position truly moved — at the first or
// last sentence nothing happens, and the stage honestly shows nothing.
function backSentence(){
  const was=S.index;
  let i = S.index-1;
  while(i>0 && !S.tokens[i-1].end) i--;
  if(i>=S.index-1){ i=S.index-2; while(i>0 && !S.tokens[i-1].end) i--; }
  jumpTo(Math.max(0,i));
  if(S.index!==was) zoneFlash(-1);
}
function fwdSentence(){
  const was=S.index;
  let i = S.index;
  while(i<S.tokens.length && !S.tokens[i].end) i++;
  jumpTo(Math.min(S.tokens.length-1, i+1));
  if(S.index!==was) zoneFlash(1);
}

/* ---------------- Phase 2: non-linear blocks ----------------
   When the stream crosses a captured block (table/image/figure/quote/code), the
   reader either halts and shows it (pause/hybrid) or collects it into an appendix
   + a document index (skip), per the per-document blockMode. */
function dismissedSet(){ return S.dismissed || (S.dismissed = new Set()); }
function normalizeBlockMode(v){
  const bm = Object.assign(defaultBlockMode(), v||{});
  if(!Array.isArray(bm.dismissed)) bm.dismissed = [];
  return bm;
}
function unitTitle(i){ return (S.units[i] && S.units[i].title) || "Section"; }
function presentKinds(){ return [...new Set(S.blocks.map(b=>b.kind))]; }

// Render a block's payload into an element. Image → <img>; sanitized html → innerHTML
// (Phase 1 stripped script/style/on*/javascript:, so it is trusted by construction).
function renderBlockInto(el, block){
  el.innerHTML = "";
  const p = block && block.payload;
  if(p && p.type==="image"){
    const img=document.createElement("img");
    img.src = p.dataUrl || p.blobUrl || ""; img.alt = p.alt || KIND_LABEL[block.kind] || "";
    el.appendChild(img);
  } else if(p && p.type==="html" && typeof p.html==="string"){
    el.innerHTML = p.html;
  } else {
    el.innerHTML = `<p class="bc-empty">Couldn’t render this ${esc((block&&block.kind)||"block")}.</p>`;
  }
}

// pause/hybrid — halt the stream and raise the still card.
function presentBlock(block, mode){
  clearTimeout(S.timer);
  disarmZen();   // a raised card needs its chrome
  // Time spent studying a figure isn't streaming time — pause the reading clock
  // so the finish-screen average WPM stays honest.
  settleReading();
  S.cardOpen = true; S.previewing = false; S.currentBlock = block;
  $("ribbon").classList.remove("playing");
  $("bcKind").textContent = KIND_LABEL[block.kind] || "Block";
  $("bcUnit").textContent = unitTitle(block.unit);
  renderBlockInto($("bcBody"), block);
  $("bcViewPage").classList.toggle("hidden", mode!=="hybrid");
  $("bcDismiss").classList.toggle("hidden", !isAutoDetected(block));
  $("bcResume").textContent = "Resume reading →";
  $("blockCard").classList.remove("hidden");
  Haptics.trigger("light");
  $("bcResume").focus({preventScroll:true});
}

// Resume button / Space / stage-tap while a card is up.
function resumeFromCard(){
  if(!S.cardOpen) return;
  const b = S.currentBlock;
  const wasPreview = S.previewing;
  if(b && !wasPreview) S.shownBlocks.add(b.id);
  hideBlockUI();
  if(wasPreview) return;            // previewing a collected block doesn't move the stream
  continueStream();
}

// After a card closes: surface whatever else the crossed window still holds
// (consecutive figures/tables), then pick the stream back up.
function continueStream(){
  if(S.pendingRange && S.sortedBlocks.length){
    const [lo, hi] = S.pendingRange;
    const { collect, present } = blocksToHandle(S.sortedBlocks, lo, hi, S.blockMode, dismissedSet(), S.shownBlocks);
    for(const b of collect) collectBlock(b);
    if(present){ presentBlock(present, modeForKind(present.kind)); return; }
  }
  S.pendingRange = null;
  S.rampStart = S.index;
  if(S.playing){ S.playStart = Date.now(); armZen(); step(); }
}

// skip — never interrupt; collect into the appendix + document index.
function collectBlock(block){
  if(S.shownBlocks.has(block.id)) return;
  S.shownBlocks.add(block.id);
  S.collected.push(block);
  $("tocFigs").classList.remove("hidden");
  $("tocToggle").classList.remove("hidden");
  renderFigIndex();
}

// Suppress an auto-detected false positive for this document (persisted).
function dismissBlock(block){
  const id = block.id;
  S.shownBlocks.add(id);
  if(!S.blockMode.dismissed.includes(id)) S.blockMode.dismissed.push(id);
  dismissedSet().add(id);
  S.collected = S.collected.filter(b=>b.id!==id);
  renderFigIndex();
  persistBlockMode();
  hideBlockUI();
  toast("Dismissed. It won’t show again in this document", { action:"Undo", onAction:()=>{
    S.blockMode.dismissed = S.blockMode.dismissed.filter(x=>x!==id);
    dismissedSet().delete(id); S.shownBlocks.delete(id);
    persistBlockMode();
  }});
  continueStream();
}

// Preview a collected block from the index (does not move the reading position).
function previewBlock(block){
  if(S.playing) pause();
  S.cardOpen = true; S.previewing = true; S.currentBlock = block;
  $("bcKind").textContent = KIND_LABEL[block.kind] || "Block";
  $("bcUnit").textContent = unitTitle(block.unit);
  renderBlockInto($("bcBody"), block);
  $("bcViewPage").classList.add("hidden");
  $("bcDismiss").classList.toggle("hidden", !isAutoDetected(block));
  $("bcResume").textContent = "Close";
  $("blockCard").classList.remove("hidden");
  $("bcResume").focus({preventScroll:true});
}

function openPageView(){
  const b = S.currentBlock; if(!b) return;
  $("pvTitle").textContent = unitTitle(b.unit);
  renderBlockInto($("pvScroll"), b);
  $("pageView").classList.remove("hidden");
  $("pvBack").focus({preventScroll:true});
}
function closePageView(){ $("pageView").classList.add("hidden"); if(S.cardOpen) $("bcResume").focus({preventScroll:true}); }
function hideBlockUI(){ $("blockCard").classList.add("hidden"); $("pageView").classList.add("hidden"); $("figIndex").classList.add("hidden"); S.cardOpen=false; S.previewing=false; }

/* document-level Figures & Tables index */
function renderFigIndex(){
  const list=$("fiList"); if(!list) return;
  list.innerHTML="";
  if(!S.collected.length){ list.innerHTML = `<p class="fi-empty">Nothing collected yet.</p>`; return; }
  const byUnit=new Map();
  for(const b of S.collected){ if(!byUnit.has(b.unit)) byUnit.set(b.unit, []); byUnit.get(b.unit).push(b); }
  for(const [unit, items] of byUnit){
    const h=document.createElement("div"); h.className="fi-group"; h.textContent=unitTitle(unit); list.appendChild(h);
    items.forEach((b,i)=>{
      const row=document.createElement("button"); row.type="button"; row.className="fi-item";
      row.innerHTML = `<span class="fi-glyph">${esc(KIND_LABEL[b.kind]||"Block")}</span>`+
                      `<span class="fi-cap">${esc(KIND_LABEL[b.kind]||"Block")} ${i+1}</span>`;
      row.onclick=()=>{ closeFigIndex(); previewBlock(b); };
      list.appendChild(row);
    });
  }
}
function openFigIndex(){ renderFigIndex(); $("figIndex").classList.remove("hidden"); $("fiClose").focus({preventScroll:true}); }
function closeFigIndex(){ $("figIndex").classList.add("hidden"); }

/* ---------------- contents panel (top-bar navigation) ---------------- */
// One element, two presentations: bottom sheet on phones, anchored popover on
// desktop (CSS decides). Opening while playing pauses — an overlay covering the
// word stream is a deliberate interruption.
function renderToc(){
  const list=$("tocList"); list.innerHTML="";
  chapterItems(S.nav || S.units, S.index).forEach(it=>{
    const b=document.createElement("button");
    b.type="button"; b.className="toc-item"+(it.depth?" d"+Math.min(it.depth,2):"")+(it.current?" current":"");
    b.textContent=it.title;
    if(it.current) b.setAttribute("aria-current","true");
    b.onclick=()=>{ jumpTo(it.start); closeToc(); };
    list.appendChild(b);
  });
}
function tocOpen(){ return !$("toc").hasAttribute("inert"); }
function openToc(){
  if(S.playing) pause();
  renderToc();
  $("tocScrim").hidden=false;
  const t=$("toc"); t.removeAttribute("inert"); t.classList.add("show");
  $("tocToggle").setAttribute("aria-expanded","true");
  const cur=t.querySelector(".toc-item.current");
  if(cur) cur.scrollIntoView({block:"center"});
  (cur || t.querySelector(".toc-item") || $("tocClose")).focus({preventScroll:true});
}
function closeToc(){
  const t=$("toc"); t.classList.remove("show"); t.setAttribute("inert","");
  $("tocScrim").hidden=true;
  $("tocToggle").setAttribute("aria-expanded","false");
  if(t.contains(document.activeElement) || document.activeElement===document.body)
    $("tocToggle").focus({preventScroll:true});
}
// Press-and-hold on a stepper repeats after a beat — one tap, one step; a hold
// ramps. Replaces click wiring entirely (no double-fire); Enter/Space step once
// per press, and holding Enter repeats via native key auto-repeat.
function holdRepeat(btn, fn){
  let t=null, iv=null;
  const stop=()=>{ clearTimeout(t); clearInterval(iv); t=iv=null; };
  btn.addEventListener("pointerdown",()=>{
    fn();
    t=setTimeout(()=>{ iv=setInterval(()=>{ if(btn.disabled){ stop(); return; } fn(); },110); },450);
  });
  ["pointerup","pointerleave","pointercancel"].forEach(ev=>btn.addEventListener(ev,stop));
  window.addEventListener("blur",stop);
  btn.addEventListener("keydown",(e)=>{ if(e.code==="Enter"||e.code==="Space"){ e.preventDefault(); fn(); } });
}

// A bottom sheet is a physical surface: drag it from anywhere (the internal
// list still scrolls when it isn't at its top), the scrim lightens as it goes,
// and release position + velocity decide dismiss vs settle (js/gestures.js).
function wireSheet(sheet, scrim, onClose){
  sheetDrag(sheet, {
    enabled: isSheet,
    onClose,
    onProgress:(p)=>{
      if(p==null){ scrim.style.transition=""; scrim.style.opacity=""; }
      else { scrim.style.transition="none"; scrim.style.opacity=String(1-p); }
    },
  });
}

/* settings: global mode + per-kind overrides */
function syncBlockModeUI(){
  const def = (S.blockMode && S.blockMode.default) || "pause";
  document.querySelectorAll("#blockModeSeg button").forEach(b=>b.classList.toggle("active", b.dataset.bm===def));
  renderBlockModeGrid();
}
function setBlockModeDefault(m){ S.blockMode.default = m; syncBlockModeUI(); persistBlockMode(); }
function setKindMode(kind, m){ if(m==="default") delete S.blockMode[kind]; else S.blockMode[kind]=m; syncBlockModeUI(); persistBlockMode(); }
function renderBlockModeGrid(){
  const grid=$("blockModeGrid"); if(!grid) return;
  grid.innerHTML="";
  for(const kind of presentKinds()){
    const cur = S.blockMode[kind] || "default";
    const row=document.createElement("div"); row.className="bmg-row";
    row.innerHTML = `<span class="bmg-kind">${esc(KIND_LABEL[kind]||kind)}</span>`;
    const seg=document.createElement("div"); seg.className="seg bmg-seg";
    [["default","Default"],["pause","Pause"],["hybrid","Page"],["skip","Collect"]].forEach(([v,label])=>{
      const btn=document.createElement("button"); btn.type="button"; btn.textContent=label;
      btn.className = (cur===v)?"active":""; btn.onclick=()=>setKindMode(kind, v);
      seg.appendChild(btn);
    });
    row.appendChild(seg); grid.appendChild(row);
  }
}
function persistBlockMode(){ if(S.key) Store.putBlockMode(S.key, S.blockMode).catch(()=>{}); }

/* ---------------- Phase 3: retention aids ---------------- */
// True when token index i begins a new unit (so i-1 is a structural boundary).
function isUnitEnd(i){ if(S.units.length<2) return false; for(let k=1;k<S.units.length;k++) if(S.units[k].start===i) return true; return false; }
function currentUnit(i){ let u=0; for(let k=0;k<S.units.length;k++){ if(S.units[k].start<=i) u=k; } return u; }

/* rewind / regression — pure index moves */
function back10(){ const was=S.index; jumpTo(S.index - 10); if(S.index!==was) zoneFlash(-1, true); }
function replaySentence(){ const s=sentenceStart(S.tokens, S.index); jumpTo(s); if(!S.playing) play(); }

/* highlights */
function markCurrent(wordOnly){
  if(!S.tokens.length) return;
  const start = wordOnly ? S.index : sentenceStart(S.tokens, S.index);
  const end   = wordOnly ? S.index : sentenceEnd(S.tokens, S.index);
  S.highlights = toggleRange(S.highlights, start, end, currentUnit(start), Date.now());
  persistHighlights(); updateMarkBtn(); Haptics.trigger("success");
  const on = S.highlights.some(r=>r.start<=S.index && S.index<=r.end);
  toast(on ? "Highlighted" : "Highlight removed", { duration:1600 });
}
function highlightAt(i){ return S.highlights.some(r=> r.start<=i && i<=r.end); }
function updateMarkBtn(){
  const b=$("markBtn"); if(!b) return;
  const on = highlightAt(S.index);
  if(b.classList.contains("on")===on) return;   // no-op writes still dirty style — skip them
  b.classList.toggle("on", on);
  b.setAttribute("aria-pressed", on?"true":"false");
}
function persistHighlights(){ if(S.key) Store.putHighlights(S.key, serializeHighlights(S.highlights)).catch(()=>{}); }

/* review panel */
function renderReview(){
  const list=$("rvList"); if(!list) return;
  list.innerHTML="";
  if(!S.highlights.length){ list.innerHTML = `<p class="rv-empty">No highlights yet. Tap Mark while reading.</p>`; return; }
  const sorted = S.highlights.slice().sort((a,b)=>a.start-b.start);
  let curUnit=null;
  for(const r of sorted){
    const ut = unitTitle(r.unit);
    if(ut!==curUnit){ const h=document.createElement("div"); h.className="rv-group"; h.textContent=ut; list.appendChild(h); curUnit=ut; }
    const row=document.createElement("div"); row.className="rv-item";
    const q=document.createElement("blockquote"); q.className="rv-quote"; q.textContent=rangeText(S.tokens, r); row.appendChild(q);
    const acts=document.createElement("div"); acts.className="rv-acts";
    const mk=(label,fn)=>{ const b=document.createElement("button"); b.type="button"; b.className="rv-act"; b.textContent=label; b.onclick=fn; return b; };
    acts.appendChild(mk("Jump", ()=>{ closeReview(); jumpTo(r.start); }));
    acts.appendChild(mk("Copy", ()=>{ navigator.clipboard && navigator.clipboard.writeText(rangeText(S.tokens, r)).then(()=>toast("Copied",{duration:1400})).catch(()=>{}); }));
    acts.appendChild(mk("Remove", ()=>{ S.highlights = toggleRange(S.highlights, r.start, r.end, r.unit, r.ts); persistHighlights(); updateMarkBtn(); renderReview(); }));
    row.appendChild(acts); list.appendChild(row);
  }
}
function openReview(){ renderReview(); $("review").classList.add("show"); $("rvClose").focus({preventScroll:true}); }
function closeReview(){ $("review").classList.remove("show"); }
function exportHighlights(){
  if(!S.highlights.length){ toast("No highlights to export yet."); return; }
  const md = exportMarkdown(S.tokens, S.units, S.highlights, S.title);
  triggerDownload(new Blob([md], {type:"text/markdown"}), `${(S.title||"highlights").replace(/[^\w.-]+/g,"-").slice(0,40)}-highlights.md`);
  toast(`Exported ${S.highlights.length} highlight${S.highlights.length===1?"":"s"} as Markdown.`);
}

/* ---------------- progress + scrubber ---------------- */
function fmt(sec){ sec=Math.max(0,Math.round(sec)); const m=Math.floor(sec/60); const s=sec%60; return m+":"+String(s).padStart(2,"0"); }
let progressPaintAt=0;
// `throttled` comes only from the streaming loop: the scrubber repaint is a
// real layout per write, and a hairline moving 5x a second reads identically
// to one moving per word. Everything else (scrub drags, jumps, pause paths)
// paints immediately. Chapter crossings and their side effects run every call.
function updateProgress(throttled){
  const total = S.tokens.length||1;
  const grid = (S.chapters && S.chapters.length) ? S.chapters : [{title:null,start:0,end:total}];
  const k = chapterAt(grid, S.index);
  const seg = grid[k];
  const span = Math.max(1, seg.end - seg.start);
  const pct = Math.min(100, ((S.index - seg.start)/span)*100);
  const now = Date.now();
  if(!throttled || now-progressPaintAt>200 || k!==S.curCh){
    progressPaintAt = now;
    $("trackFill").style.width = pct+"%";
    $("trackKnob").style.left = pct+"%";
    const tk=$("track"); tk.setAttribute("aria-valuenow", Math.round(pct));
    tk.setAttribute("aria-valuetext", Math.round(pct) + (seg.title ? "% of "+seg.title : "% read"));
    $("tElapsed").textContent = fmt((S.index - seg.start)/S.wpm*60);
    $("tLeft").textContent = "-"+fmt((seg.end - S.index)/S.wpm*60);
  }
  // the top-right meta line names the chapter the bar describes (book-scope
  // documents keep the static parse meta: "EPUB · 12 chapters · 84,120 words")
  if(k !== S.curCh){ S.curCh = k; $("docMeta").textContent = seg.title || S.meta; }
  if(S.units.length>1){
    let u=0; for(let k=0;k<S.units.length;k++){ if(S.units[k].start<=S.index) u=k; }
    if(u!==S.curUnit && !$("toc").hasAttribute("inert")) renderToc();
    S.curUnit=u;
    // Phase 2: crossing into a new unit surfaces the just-finished chapter's appendix
    // (collected figures/tables) as a non-blocking, dismissible affordance.
    if(u !== S.lastUnit){
      const finished = S.lastUnit;
      // collected figures/tables in the just-finished chapter
      if(S.collected && S.collected.length){
        const inUnit = S.collected.filter(b=>b.unit===finished);
        const seen = S.apxShown || (S.apxShown = new Set());
        if(inUnit.length && !seen.has(finished)){
          seen.add(finished);
          toast(`${inUnit.length} ${inUnit.length===1?"figure/table":"figures & tables"} in “${unitTitle(finished)}”`,
                { action:"View", onAction:openFigIndex });
        }
      }
      // Phase 3: highlights in the just-finished chapter → opt-in review
      if(S.highlights && S.highlights.length && S.hlUnitShown && !S.hlUnitShown.has(finished)){
        const n = S.highlights.filter(r=>r.unit===finished).length;
        if(n){ S.hlUnitShown.add(finished); toast(`Review ${n} highlight${n===1?"":"s"} from “${unitTitle(finished)}”`, { action:"Review", onAction:openReview }); }
      }
    }
    S.lastUnit = u;
  }
  updateMarkBtn();
}

/* ---------------- toasts (non-blocking, on-brand feedback) ---------------- */
function toast(msg, {action, onAction, duration=4500, error=false, hint=false}={}){
  const wrap=$("toasts");
  const el=document.createElement("div");
  el.className="toast"+(error?" err":"")+(hint?" hint":"");
  el.setAttribute("role", error?"alert":"status");   // errors interrupt; status messages wait politely
  const m=document.createElement("span"); m.className="tmsg"; m.textContent=msg; el.appendChild(m);
  let timer;
  const dismiss=()=>{ clearTimeout(timer); if(!el.isConnected) return; el.classList.add("hide"); setTimeout(()=>el.remove(),240); };
  if(action){
    const b=document.createElement("button"); b.type="button"; b.className="taction"; b.textContent=action;
    b.onclick=()=>{ try{ onAction&&onAction(); } finally{ dismiss(); } };
    el.appendChild(b);
  }
  wrap.appendChild(el);
  timer=setTimeout(dismiss, duration);
  return dismiss;
}

/* ---------------- last-resort error net ----------------
   There is no server and no telemetry, so a crash on a reader's device is
   otherwise invisible — the stream just freezes in silence. Surface one honest
   toast (at most once a minute) and leave the details in the console, which is
   what makes a bug report actionable. */
let errNotedAt = 0;
function noteFatal(){
  const now = Date.now();
  if(now - errNotedAt < 60000) return;
  errNotedAt = now;
  try{ toast("Something went wrong. If reading stops, reload the page.", {error:true, duration:8000}); }catch(e){}
}
window.addEventListener("error",(e)=>{
  // cross-origin scripts surface as a bare "Script error." with nothing to act on
  if(!e.message || (e.message==="Script error." && !e.filename)) return;
  noteFatal();
});
window.addEventListener("unhandledrejection",()=>noteFatal());

/* The service worker activates new versions immediately (skipWaiting), but a
   running page keeps its old code until a reload — installed-PWA readers could
   sit on a stale version forever without ever knowing. Offer the reload once,
   and never over the stream: a mid-word toast would break the one promise the
   stage makes. */
let updatePending = false, updateNoted = false;
function maybeUpdateToast(){
  if(!updatePending || updateNoted || S.playing) return;
  updateNoted = true;
  toast("A newer Stillpoint is ready.", { action:"Reload", duration:10000, onAction:()=>location.reload() });
}
function noteUpdate(){ updatePending = true; maybeUpdateToast(); }

/* ---------------- reading streak (landing strip) ---------------- */
// Hidden until there's anything to show (any ledger data or a non-empty library),
// same gating spirit as #backup. Ring = today's minutes toward the daily goal.
const RING_C = 2*Math.PI*15.5;   // circumference of the progress ring circle
function renderStreak(){
  const el=$("streakStrip"); if(!el) return;
  const st=Streak.getState();
  const show = Streak.hasData() || loadLib().length>0;
  el.classList.toggle("hidden", !show);
  if(!show) return;
  $("streakCount").textContent = st.current;
  const best=$("streakBest");
  best.classList.toggle("hidden", !(st.best>st.current));
  best.textContent = "best "+st.best;
  $("goalVal").textContent = st.goalMin+" min a day";
  $("goalDown").disabled = st.goalMin<=GOAL_MIN; $("goalUp").disabled = st.goalMin>=GOAL_MAX;
  const fill=$("streakRingFill");
  fill.style.strokeDasharray = RING_C;
  fill.style.strokeDashoffset = RING_C * (1 - Math.min(1, st.todaySec/(st.goalMin*60)));
  const mins = Math.floor(st.todaySec/60);
  $("streakRing").setAttribute("aria-label",
    st.metToday ? `Daily goal met. ${mins} minute${mins===1?"":"s"} read today`
    : st.todaySec>0 ? `${mins} of ${st.goalMin} minutes read today` : "No reading yet today");
}

/* ---------------- resume / library (localStorage) ---------------- */
const LIB_KEY="fp_library_v1";
function loadLib(){ try{return JSON.parse(localStorage.getItem(LIB_KEY))||[];}catch(e){return [];} }
let libSaveFailed=false;   // full storage would otherwise toast on every save
function saveLib(lib){
  try{ localStorage.setItem(LIB_KEY, JSON.stringify(lib.slice(0,LIB_MAX))); libSaveFailed=false; }
  catch(e){
    if(!libSaveFailed){ libSaveFailed=true; toast("Storage on this device is full, so your reading position can't be saved.", {error:true}); }
  }
}
// The stream calls this every chunk; a full library serialize per word is waste,
// so streaming saves are paced. Anything that ends or moves a session (pause,
// jumps, opening a book, leaving the page) forces a write so resume stays exact.
let progressSavedAt=0;
function saveProgress(force){
  if(!S.key) return;
  if(!force && Date.now()-progressSavedAt<2000) return;
  progressSavedAt=Date.now();
  const lib = loadLib().filter(x=>x.key!==S.key);
  lib.unshift({key:S.key,title:S.title,type:S.meta.split(" ")[0]||"TEXT",index:S.index,total:S.tokens.length,ts:Date.now()});
  saveLib(lib);
}
let openLibRow=null;   // at most one row rests open on its Remove action
// The landing leads with whatever the visitor came for. A returning reader
// came for their book, so a non-empty shelf (and the streak beside it) moves
// above the hero; the pitch keeps its place for first-timers. Moving the nodes
// preserves their listeners, same trick as placeModeCtrl.
function placeShelf(hasBooks){
  const hero=document.querySelector("#landing .hero");
  const recent=$("recent"), streak=$("streakStrip");
  if(!hero || !recent || !streak) return;
  if(hasBooks){
    if(recent.nextElementSibling!==streak || streak.nextElementSibling!==hero){
      hero.parentNode.insertBefore(recent, hero);
      hero.parentNode.insertBefore(streak, hero);
    }
  } else {
    const paste=document.querySelector("#landing .paste-shell");
    if(paste && paste.nextElementSibling!==recent){ paste.after(recent); recent.after(streak); }
  }
}
function renderLibrary(){
  const lib = loadLib();
  const box=$("recent"), list=$("recentList");
  placeShelf(lib.length>0);
  // the backup panel only makes sense once there's a library to move
  $("backup").classList.toggle("hidden", lib.length===0);
  openLibRow=null;
  list.innerHTML="";
  if(lib.length===0){ box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  lib.forEach(item=>{
    const pct = item.total ? Math.min(100, Math.round(item.index/item.total*100)) : 0;
    const finished = item.total && item.index>=item.total;
    // honest finishing nudge: time left at the reader's own pace
    let prog = pct+"%";
    if(finished) prog = "Finished";
    else if(item.total){
      const m = Math.max(1, Math.ceil((item.total-item.index)/S.wpm));
      prog = `${pct}% · ~${m>=120 ? Math.round(m/60)+"h" : m+"m"} left`;
    }
    const el=document.createElement("div"); el.className="recent-item";
    el.innerHTML=`<button type="button" class="ri-del" tabindex="-1" aria-hidden="true">Remove</button>
      <div class="ri-face">
        <button type="button" class="ri-open">
          <span class="ri-type">${esc(item.type||"TEXT")}</span>
          <span class="ri-name">${esc(item.title)}</span>
          <span class="ri-prog">${prog}</span>
        </button>
        <button type="button" class="ri-x" title="Remove" aria-label="Remove &ldquo;${esc(item.title)}&rdquo;">✕</button>
        <i class="ri-bar${finished?" full":""}" style="width:${finished?100:pct}%" aria-hidden="true"></i>
      </div>`;
    const face=el.querySelector(".ri-face");
    // deletion choreography: the face slides off, the row folds shut, then the
    // library updates — same Undo toast and deferred file delete as always
    let committed=false;
    const commit=()=>{
      if(committed) return;
      committed=true;
      if(openLibRow===sw) openLibRow=null;
      face.style.transition=""; face.style.transform="translateX(-105%)";
      el.style.height=el.offsetHeight+"px";
      requestAnimationFrame(()=>{ el.classList.add("collapse"); el.style.height="0px"; });
      setTimeout(()=>removeItem(item), 230);
    };
    const sw=rowSwipe(el, face, {
      onCommit:()=>{ Hints.used("rowswipe"); commit(); },
      onZoneTick:()=>Haptics.trigger("light"),   // the finger learns: release here deletes
      onOpenChange:(open)=>{
        if(open){ Hints.used("rowswipe"); if(openLibRow && openLibRow!==sw) openLibRow.close(); openLibRow=sw; }
        else if(openLibRow===sw) openLibRow=null;
      },
    });
    el.querySelector(".ri-open").onclick=()=>{
      if(sw.consumed()) return;                  // the swipe owns this interaction
      if(sw.isOpen()){ sw.close(); return; }     // tap outside the action closes first
      openFromStore(item);
    };
    el.querySelector(".ri-del").onclick=()=>{ if(!sw.consumed()) commit(); };
    el.querySelector(".ri-x").onclick=(e)=>{ e.stopPropagation(); if(!sw.consumed()) commit(); };
    list.appendChild(el);
  });
}
// Remove a library item, but defer deleting the cached file so "Undo" can restore it.
function removeItem(item){
  saveLib(loadLib().filter(x=>x.key!==item.key));
  renderLibrary();
  let undone=false;
  const del=setTimeout(()=>{ if(!undone) Store.del(item.key).catch(()=>{}); }, 5200);
  toast(`Removed “${item.title}”`, { action:"Undo", duration:5000, onAction:()=>{
    undone=true; clearTimeout(del);
    const lib=loadLib(); if(!lib.some(x=>x.key===item.key)){ lib.unshift(item); saveLib(lib); }
    renderLibrary();
  }});
}

/* ---------------- loading a document ---------------- */
function openReader(tokens, units, title, meta, key, blocks, nav, kind){
  S.tokens=tokens; S.units=units&&units.length?units:[{title:"Start",start:0}];
  // The declared ToC (EPUB nav/NCX, PDF outline) when the book has one — this is
  // what the Contents panel lists, like Apple Books. Units remain the reading grid.
  S.nav = (Array.isArray(nav) && nav.length>1) ? nav : null;
  S.chapters = chapterGrid(kind, S.nav, S.units, tokens.length);
  S.curCh = -1;   // first updateProgress sets the meta line
  S.title=title; S.meta=meta; S.key=key; S.index=0;
  S.readMs=0; S.playStart=null; S.rampStart=0; $("done").classList.remove("show");
  const prior = loadLib().find(x=>x.key===key);
  if(prior && prior.index>0 && prior.index<tokens.length) S.index=prior.index;

  // Phase 2: block sidecar + per-document presentation mode.
  S.blocks = Array.isArray(blocks) ? blocks : [];
  S.sortedBlocks = indexBlocks(S.blocks);
  S.shownBlocks = new Set();
  S.collected = [];
  S.cardOpen = false; S.lastUnit = 0; S.pendingRange = null;
  hideBlockUI();
  S.blockMode = defaultBlockMode();
  S.dismissed = new Set(S.blockMode.dismissed);
  $("tocFigs").classList.toggle("hidden", S.blocks.length===0);
  $("blockModeCtrl").classList.toggle("hidden", S.blocks.length===0);
  if(S.blocks.length){
    Store.getBlockMode(key).then(v=>{
      if(v && S.key===key){ S.blockMode = normalizeBlockMode(v); S.dismissed = new Set(S.blockMode.dismissed); }
      syncBlockModeUI();
    }).catch(()=>syncBlockModeUI());
  }
  syncBlockModeUI();
  renderFigIndex();

  // Phase 3: per-sentence pacing factors (once) + per-document highlights (async load).
  S.sentenceFactor = sentenceFactors(tokens);
  S.highlights = []; S.hlUnitShown = new Set();
  Store.getHighlights(key).then(rec=>{ if(S.key===key){ S.highlights = deserializeHighlights(rec); updateMarkBtn(); } }).catch(()=>{});
  updateMarkBtn();

  $("docTitle").textContent=title;
  $("docTitle").title=title;             // full name on hover — the display ellipsizes
  $("docMeta").textContent=meta;
  document.title = title + " · Stillpoint";
  S.curUnit=0;
  $("tocToggle").classList.toggle("hidden", (S.nav||S.units).length<2 && S.blocks.length===0);

  $("landing").style.display="none";
  $("reader").classList.add("show");
  if(!(history.state && history.state.sp==="reader")) history.pushState({sp:"reader"}, "");  // so Back returns to the library
  ribbonStart=0; ribbonOffset=0; invalidateRibbon();   // reset the ribbon for the new document
  updateProgress();
  $("resting").classList.remove("hidden"); $("word").classList.add("hidden"); $("ribbon").classList.add("hidden");
  $("playBtn").focus({preventScroll:true});   // move focus into the reader (route-change focus)
  saveProgress(true); // record the entry immediately so the recent library reflects it
  Hints.readerOpened();
}

/* ---------------- local file cache (IndexedDB) ---------------- */
// The library lives ONLY on this device — that's the whole promise — so ask the
// browser to treat the origin's storage as durable the first time a book is
// kept. Without this it may silently evict the IndexedDB under storage pressure
// and empty the shelf. Best effort: refusal is fine and changes nothing visible.
let durableAsked = false;
function requestDurableStorage(){
  if(durableAsked) return;
  durableAsked = true;
  try{ navigator.storage && navigator.storage.persist && navigator.storage.persist().catch(()=>{}); }catch(e){}
}
// Persist a file/text so it can be reopened later without re-uploading; keep IDB in sync with the library.
async function persist(key, rec){
  try{ await Store.put(key, rec); requestDurableStorage(); await pruneStore(); }
  catch(e){ /* storage unavailable or over quota — non-fatal, file just won't be remembered */ }
}
async function pruneStore(){
  try{
    const keep = new Set(loadLib().map(x=>x.key));
    for(const k of await Store.keys()){
      // retain a cached file for a live library entry, or a blockmode:: pref whose
      // document is still in the library (tiny, book-scoped).
      if(keep.has(k)) continue;
      if(typeof k==="string" && k.startsWith("blockmode::") && keep.has(k.slice("blockmode::".length))) continue;
      if(typeof k==="string" && k.startsWith("hl::") && keep.has(k.slice("hl::".length))) continue;
      await Store.del(k);
    }
  }catch(e){}
}
// Reopen a recent item straight from the device.
async function openFromStore(item){
  let rec;
  try{ rec = await Store.get(item.key); }catch(e){}
  if(!rec){ toast(`“${item.title}” isn't on this device anymore. Open it once to remember it.`); return; }
  if(rec.kind==="text"){
    const toks=tokenize(rec.text);
    openReader(toks,[{title:"Pasted text",start:0}],item.title,`TEXT · ${toks.length.toLocaleString()} words`,item.key,[],null,"text");
    return;
  }
  showParse("Opening "+item.title+"…","Reading from this device",{kind:rec.kind,name:rec.name||item.title,size:rec.blob?rec.blob.size:0});
  try{
    if(rec.kind==="pdf"){
      const {tokens,units,pages,blocks,nav}=await parsePDF(rec.blob, setParse);
      hideParse(); openReader(tokens,units,item.title,`PDF · ${pages} pages · ${tokens.length.toLocaleString()} words`,item.key,blocks,nav,"pdf");
    } else {
      const {tokens,units,chapters,blocks,nav}=await parseEPUB(rec.blob, setParse);
      hideParse(); openReader(tokens,units,item.title,`EPUB · ${chapters} chapters · ${tokens.length.toLocaleString()} words`,item.key,blocks,nav,"epub");
    }
  }catch(err){ hideParse(); toast("Couldn't reopen that file: "+(err&&err.message?err.message:err), {error:true, duration:9000, action:"Retry", onAction:()=>openFromStore(item)}); }
}
// DOM transition back to the library. Moves focus to a sensible landing control
// so keyboard / screen-reader users aren't stranded on the now-hidden reader.
function showLibrary(){
  pause();
  // no surface survives the route change — a sheet left open here would greet
  // the next book already raised
  hideBlockUI();
  if(tocOpen()) closeToc();
  if(isSheet() && $("moreWrap").classList.contains("open")) setSettingsOpen(false);
  closeReview();
  $("done").classList.remove("show");
  $("reader").classList.remove("show");
  $("landing").style.display="";
  document.title = BASE_TITLE;
  renderLibrary(); renderStreak();
  $("dropzone").focus({preventScroll:true});
  maybeHint("landing");
}
// Back dismisses the topmost surface first — the platform promise on Android —
// and only a bare reader exits to the library. Order mirrors the visual stack.
function closeTopOverlay(){
  if(tocOpen()){ closeToc(); return true; }
  if(isSheet() && $("moreWrap").classList.contains("open")){ setSettingsOpen(false); return true; }
  if(!$("figIndex").classList.contains("hidden")){ closeFigIndex(); return true; }
  if(!$("pageView").classList.contains("hidden")){ closePageView(); return true; }
  if(S.cardOpen){ resumeFromCard(); return true; }
  if($("review").classList.contains("show")){ closeReview(); return true; }
  return false;
}
// Route user-initiated exits through history so the browser/hardware Back button
// returns to the library instead of leaving the site (popstate → showLibrary).
// An explicit "home" tap means leave now — it skips the overlay-first rule.
let homeIntent=false;
function requestHome(){
  if(history.state && history.state.sp==="reader"){ homeIntent=true; history.back(); }
  else showLibrary();
}

// Decide PDF vs EPUB by sniffing the file's magic bytes first (most reliable — works for
// files with no/odd extension or a generic name), then fall back to extension, then MIME type.
async function detectKind(file){
  try{
    const head = new Uint8Array(await file.slice(0,4).arrayBuffer());
    if(head[0]===0x25&&head[1]===0x50&&head[2]===0x44&&head[3]===0x46) return "pdf";   // %PDF
    if(head[0]===0x50&&head[1]===0x4B&&head[2]===0x03&&head[3]===0x04) return "epub";  // PK.. (zip → EPUB; parseEPUB validates)
  }catch(e){ /* fall through to name/MIME */ }
  const ext=(file.name.split(".").pop()||"").toLowerCase();
  if(ext==="pdf") return "pdf";
  if(ext==="epub"||ext==="kepub") return "epub";
  const type=(file.type||"").toLowerCase();
  if(type.includes("pdf")) return "pdf";
  if(type.includes("epub")||type.includes("zip")) return "epub";
  return null;
}

async function handleFile(file){
  if(!file) return;
  const name=file.name.replace(/\.[^.]+$/,"") || file.name;   // strip any trailing extension for display
  const key = file.name+"::"+file.size;
  const kind = await detectKind(file);
  if(kind!=="pdf" && kind!=="epub"){ toast("That doesn't look like a PDF or EPUB. Try another file."); return; }
  showParse("Opening "+name+"…", "Extracting text locally", {kind, name:file.name, size:file.size});
  try{
    if(kind==="pdf"){
      const {tokens,units,pages,blocks,nav}=await parsePDF(file, setParse);
      hideParse();
      openReader(tokens,units,name,`PDF · ${pages} pages · ${tokens.length.toLocaleString()} words`,key,blocks,nav,"pdf");
      persist(key,{kind:"pdf",blob:file,name:file.name});
    } else {
      const {tokens,units,chapters,blocks,nav}=await parseEPUB(file, setParse);
      hideParse();
      openReader(tokens,units,name,`EPUB · ${chapters} chapters · ${tokens.length.toLocaleString()} words`,key,blocks,nav,"epub");
      persist(key,{kind:"epub",blob:file,name:file.name});
    }
  }catch(err){
    console.error(err); hideParse();
    // inline retry — the file is still in hand, so one tap resumes without re-picking it
    toast("Couldn't read that file: "+(err&&err.message?err.message:err), {error:true, duration:9000, action:"Retry", onAction:()=>handleFile(file)});
  }
}
let parseStart=0;
function formatBytes(n){
  if(!n) return "";
  if(n<1024) return n+" B";
  if(n<1024*1024) return Math.round(n/1024)+" KB";
  return (n/1048576).toFixed(1)+" MB";
}
// fileMeta {kind,name,size} shows a proof-of-file chip; omit it for non-file work (export/import).
function showParse(t,s,fileMeta){
  $("parseTitle").textContent=t; $("parseSub").textContent=s;
  $("parseFill").style.width="0%"; $("parsePct").textContent="0%"; $("parseEta").textContent="";
  parseStart=Date.now();
  const chip=$("fileChip");
  if(fileMeta){
    $("fcBadge").textContent=(fileMeta.kind||"DOC").toUpperCase();
    $("fcName").textContent=fileMeta.name||"";
    $("fcSize").textContent=formatBytes(fileMeta.size);
    chip.classList.remove("hidden");
  } else chip.classList.add("hidden");
  $("parsing").classList.add("show");
}
function setParse(p){
  const pct=Math.max(0,Math.min(1,p));
  $("parseFill").style.width=Math.round(pct*100)+"%";
  $("parsePct").textContent=Math.round(pct*100)+"%";
  // honest time-left: extrapolate from elapsed once there's enough signal to be truthful
  if(parseStart && pct>0.06){
    const elapsed=(Date.now()-parseStart)/1000;
    const remaining=elapsed*(1-pct)/pct;
    $("parseEta").textContent = (remaining>0.6 && remaining<600) ? `~${Math.ceil(remaining)}s left` : (pct>0.85 ? "almost done" : "");
  }
}
function hideParse(){ $("parsing").classList.remove("show"); }

/* ---------------- library backup (export / import) ----------------
   Move a whole library between devices with no server: export bundles the
   library list, reading positions, settings and the cached book files into one
   JSON file; import merges it back in (keeping the most-recently-read position
   per book). Files are base64-encoded inline so the backup is fully self-contained. */
const BACKUP_FORMAT = "stillpoint-backup";
const PREFS_KEY = "fp_prefs";

function blobToDataURL(blob){
  return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=()=>rej(r.error); r.readAsDataURL(blob); });
}
function dataURLToBlob(durl){
  const [head,b64] = String(durl).split(",");
  const mime = (head.match(/data:([^;]+)/)||[])[1] || "application/octet-stream";
  const bin = atob(b64), len = bin.length, bytes = new Uint8Array(len);
  for(let i=0;i<len;i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type:mime });
}

function backupFilename(){ return `stillpoint-library-${new Date().toISOString().slice(0,10)}.json`; }

// Save a Blob to disk via a temporary link (works in every browser).
function triggerDownload(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 5000);
}

// Bundle everything stored locally (library list + positions + prefs + the cached
// book files, base64-encoded inline) into one self-contained Blob. Returns {blob,count}
// or null if there's nothing to back up.
async function buildBackup(){
  const lib = loadLib();
  if(lib.length===0){ toast("Nothing to back up yet. Open a book first."); return null; }
  let prefs=null; try{ prefs = JSON.parse(localStorage.getItem(PREFS_KEY)||"null"); }catch(e){}
  const files=[];
  for(const item of lib){
    let rec; try{ rec = await Store.get(item.key); }catch(e){}
    if(!rec) continue;  // metadata-only entry (file no longer on this device)
    if(rec.kind==="text") files.push({ key:item.key, kind:"text", name:rec.name||item.title, text:rec.text });
    else if(rec.blob)     files.push({ key:item.key, kind:rec.kind, name:rec.name||item.title, data:await blobToDataURL(rec.blob) });
  }
  const blockModes = {}, highlights = {};
  for(const item of lib){
    try{ const bm = await Store.getBlockMode(item.key); if(bm) blockModes[item.key]=bm; }catch(e){}
    try{ const hl = await Store.getHighlights(item.key); if(hl) highlights[item.key]=hl; }catch(e){}
  }
  const backup = { format:BACKUP_FORMAT, version:1, exportedAt:new Date().toISOString(), prefs, library:lib, files, blockModes, highlights, streak:Streak.raw()||undefined };
  return { blob:new Blob([JSON.stringify(backup)], { type:"application/json" }), count:files.length };
}

// Download the backup as a file (works everywhere).
async function exportLibrary(){
  showParse("Packaging your library…","Bundling books, positions and settings");
  let res; try{ res = await buildBackup(); }
  catch(err){ hideParse(); toast("Couldn't export: "+(err&&err.message?err.message:err), {error:true}); return; }
  if(!res){ hideParse(); return; }
  triggerDownload(res.blob, backupFilename());
  hideParse();
  toast(`Exported ${res.count} book${res.count===1?"":"s"}. Import this file on another device to sync.`);
}

// True only when the browser can share actual files (iOS/iPadOS Safari, Android Chrome…).
function canShareFiles(){
  try{ return !!(navigator.canShare && navigator.canShare({ files:[new File(["{}"], backupFilename(), { type:"application/json" })] })); }
  catch(e){ return false; }
}
// Hand the backup file to the OS share sheet — AirDrop, Messages, Mail, etc.
async function shareBackup(){
  if(!navigator.share){ return exportLibrary(); }   // no Web Share at all → just download
  showParse("Preparing your library…","Bundling books, positions and settings");
  let res; try{ res = await buildBackup(); }
  catch(err){ hideParse(); toast("Couldn't prepare the backup: "+(err&&err.message?err.message:err), {error:true}); return; }
  if(!res){ hideParse(); return; }
  hideParse();
  const file = new File([res.blob], backupFilename(), { type:"application/json" });
  // Reuse the backup we just built for the download fallback — no rebuild, one clear message.
  const saveInstead = ()=>{ triggerDownload(res.blob, backupFilename()); toast(`Saved your library as a file instead. Import it on another device to sync.`); };
  if(navigator.canShare && !navigator.canShare({ files:[file] })){ return saveInstead(); }  // files unsupported here
  try{
    await navigator.share({ files:[file], title:"Stillpoint library",
      text:"My Stillpoint library. Open Stillpoint on the other device and tap “Import backup”." });
  }catch(err){
    if(err && err.name==="AbortError") return;   // user dismissed the sheet — not an error, stay quiet
    saveInstead();                               // share genuinely failed (common on desktop) → download once
  }
}

async function importBackup(file){
  if(!file) return;
  let data;
  try{ data = JSON.parse(await file.text()); }
  catch(e){ toast("That file isn't a valid Stillpoint backup.", {error:true}); return; }
  if(!data || data.format!==BACKUP_FORMAT || !Array.isArray(data.library)){
    toast("That doesn't look like a Stillpoint backup.", {error:true}); return;
  }
  showParse("Importing your library…","Restoring books and positions");
  try{
    requestDurableStorage();   // a restored shelf deserves the same eviction protection
    let restored=0;
    for(const f of (data.files||[])){
      try{
        if(f.kind==="text") await Store.put(f.key, { kind:"text", text:f.text, name:f.name });
        else if(f.data)     await Store.put(f.key, { kind:f.kind, blob:dataURLToBlob(f.data), name:f.name });
        restored++;
      }catch(e){ /* skip one unreadable entry, keep the rest */ }
    }
    // Merge the library, keeping the most-recently-read entry per book (syncs progress).
    saveLib(mergeLibrary(loadLib(), data.library));
    // Restore per-document block-presentation modes + highlights alongside the books.
    if(data.blockModes){ for(const [k,v] of Object.entries(data.blockModes)){ try{ await Store.putBlockMode(k, v); }catch(e){} } }
    if(data.highlights){ for(const [k,v] of Object.entries(data.highlights)){ try{ await Store.putHighlights(k, v); }catch(e){} } }
    await pruneStore();
    // Restore settings if the backup carried them.
    if(data.prefs){
      try{
        localStorage.setItem(PREFS_KEY, JSON.stringify(data.prefs));
        if(data.prefs.wpm)  setWpm(data.prefs.wpm);
        if(data.prefs.size) setSize(data.prefs.size);
        if(data.prefs.mode) setMode(data.prefs.mode);
        if(typeof data.prefs.countdown==="boolean") settings.countdown = data.prefs.countdown;
        if(typeof data.prefs.context==="boolean")   settings.context   = data.prefs.context;
        if(typeof data.prefs.smartPacing==="boolean") settings.smartPacing = data.prefs.smartPacing;
        if(typeof data.prefs.zen==="boolean") settings.zen = data.prefs.zen;
        applyAids();
      }catch(e){}
    }
    if(data.streak) Streak.importMerge(data.streak);
    hideParse(); renderLibrary(); renderStreak();
    toast(`Imported ${restored} book${restored===1?"":"s"} into your library.`);
  }catch(err){ hideParse(); toast("Couldn't import that backup: "+(err&&err.message?err.message:err), {error:true}); }
}

/* ---------------- controls ---------------- */
function setMode(m){
  S.mode=m;
  document.querySelectorAll("#modeSeg button").forEach(b=>b.classList.toggle("active",b.dataset.mode===m));
  // ORP reads one word by definition, so the chunk control leaves the panel
  // entirely — dimmed-but-selected was the most ambiguous state in the sheet
  const chunkCtrl=$("chunkCtrl");
  if(m==="orp"){ S.chunk=1; chunkCtrl.classList.add("hidden"); setChunkUI(1); }
  else if(m==="hybrid"){ if(S.chunk<2) S.chunk=3; chunkCtrl.classList.remove("hidden"); setChunkUI(S.chunk);
    document.querySelector('#chunkSeg button[data-c="1"]').style.display="none"; }
  else { chunkCtrl.classList.remove("hidden"); document.querySelector('#chunkSeg button[data-c="1"]').style.display=""; setChunkUI(S.chunk); }
  if(!$("ribbon").classList.contains("hidden")) render();   // re-centre if currently showing
}
function setChunkUI(c){ document.querySelectorAll("#chunkSeg button").forEach(b=>b.classList.toggle("active",+b.dataset.c===c)); }
function setWpm(v){
  S.wpm=v; $("wpmVal").textContent=v; $("wpm").value=v;
  $("wpmDown").disabled = v<=150; $("wpmUp").disabled = v>=800;
  let label="Custom", best=1e9;
  PRESETS.forEach(([w,n])=>{ const d=Math.abs(w-v); if(d<best && d<=40){best=d;label=n;} });
  $("presetLabel").textContent=label;
  updateProgress();
}
function setSize(s){ S.size=s; document.documentElement.style.setProperty("--read-size",s+"px");
  document.querySelectorAll("#sizeSeg button").forEach(b=>b.classList.toggle("active",+b.dataset.s===s));
  invalidateRibbon();   // cached metrics were taken at the old size
  if(!$("ribbon").classList.contains("hidden")) render();   // re-centre at the new size
}
function applyAids(){
  document.querySelectorAll("#aidSeg button").forEach(b=>{
    const on=!!settings[b.dataset.aid];
    b.classList.toggle("active",on); b.setAttribute("aria-pressed", on?"true":"false");
  });
}
// Progressive disclosure: secondary controls collapse behind "Reading settings".
// inert keeps the hidden controls out of the tab order while collapsed.
// Under 680px the same panel presents as a modal bottom sheet (CSS), so it also
// gets a scrim, pause-on-open, and focus handling.
const sheetMq = window.matchMedia("(max-width:680px)");
const isSheet = ()=> sheetMq.matches;
function setSettingsOpen(open){
  const wrap=$("moreWrap"), tg=$("settingsToggle");
  wrap.classList.toggle("open", open);
  tg.setAttribute("aria-expanded", open?"true":"false");
  if(open) wrap.removeAttribute("inert"); else wrap.setAttribute("inert","");
  settings.moreOpen = open;
  $("sheetScrim").hidden = !(open && isSheet());
  if(isSheet()){
    if(open){ if(S.playing) pause(); $("sheetDone").focus({preventScroll:true}); }
    else if(wrap.contains(document.activeElement) || document.activeElement===document.body)
      tg.focus({preventScroll:true});
  }
}
// Mode belongs in the sheet on phones but in the dock row on desktop. The panel
// is one DOM node, so the control is relocated across the breakpoint — moving a
// node preserves its listeners, and state never duplicates.
function placeModeCtrl(){
  const mode=$("modeCtrl"), wrap=$("moreWrap");
  if(isSheet()){
    $("moreControls").querySelector(".sheet-head").after(mode);
    wrap.setAttribute("role","dialog"); wrap.setAttribute("aria-modal","true"); wrap.setAttribute("aria-label","Reading settings");
  }else{
    document.querySelector(".controls.primary").insertBefore(mode, document.querySelector(".ctrl.slider-ctrl"));
    wrap.removeAttribute("role"); wrap.removeAttribute("aria-modal"); wrap.removeAttribute("aria-label");
  }
}
sheetMq.addEventListener("change",()=>{
  // crossing into phone width with the panel expanded would flash a surprise
  // modal — start closed instead
  if(isSheet() && $("moreWrap").classList.contains("open")) setSettingsOpen(false);
  $("sheetScrim").hidden = !(isSheet() && $("moreWrap").classList.contains("open"));
  placeModeCtrl();
});

/* ---------------- patron + reading themes ----------------
   Patronage is an honor system: the Stripe receipt carries an unlock code
   (verified against a hash — see js/patron.js). Patron themes are cosmetic
   token-swaps; the reader itself stays identical and free. */
const PATRON_KEY = "fp_patron_v1";
function isPatron(){ try{ return !!JSON.parse(localStorage.getItem(PATRON_KEY)||"null"); }catch(e){ return false; } }
function setPatron(){
  try{ localStorage.setItem(PATRON_KEY, JSON.stringify({ since:Date.now() })); }catch(e){}
  $("patronChip").classList.remove("hidden");
  buildThemeSeg();
}
let theme = "midnight";
function applyTheme(id){
  theme = themeById(id).id;
  if(theme==="midnight") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  // keep the browser/PWA chrome (status bar, task switcher) on the theme's ground colour
  const mc = document.querySelector('meta[name="theme-color"]');
  if(mc){
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg-0").trim();
    mc.setAttribute("content", bg || "#080510");
  }
  buildThemeSeg();
}
function requestTheme(id){
  if(isPatronTheme(id) && !isPatron()){ openPatron(); return; }   // locked → pitch, don't switch
  applyTheme(id); Haptics.trigger("light");
}
function buildThemeSeg(){
  const seg=$("themeSeg"); if(!seg) return;
  seg.innerHTML="";
  const patron=isPatron();
  for(const t of THEMES){
    const b=document.createElement("button"); b.type="button"; b.textContent=t.name;
    if(isPatronTheme(t.id) && !patron){
      const l=document.createElement("span"); l.className="lock"; l.textContent="✦";
      b.appendChild(l); b.title="Patron theme. Tap to learn more";
    }
    b.classList.toggle("active", theme===t.id);
    b.onclick=()=>requestTheme(t.id);
    seg.appendChild(b);
  }
}
let guideReturn=null;
function openGuide(){
  // opening from the phone settings sheet: lower the sheet first, one surface at a time
  if(isSheet() && $("moreWrap").classList.contains("open")) setSettingsOpen(false);
  guideReturn=document.activeElement;
  $("guide").classList.add("show");
  $("guideClose").focus({preventScroll:true});
}
function closeGuide(){
  $("guide").classList.remove("show");
  if(guideReturn && guideReturn.focus) guideReturn.focus({preventScroll:true});
}
let patronReturn=null;
function openPatron(){ patronReturn=document.activeElement; $("patron").classList.add("show"); $("patronCode").focus({preventScroll:true}); }
function closePatron(){ $("patron").classList.remove("show"); if(patronReturn && patronReturn.focus) patronReturn.focus({preventScroll:true}); }
async function tryUnlock(){
  const input=$("patronCode"), hint=$("patronHint");
  if(!input.value.trim()){ input.focus(); return; }
  const ok = await verifyPatronCode(input.value).catch(()=>false);
  if(ok){
    setPatron();
    hint.textContent="Welcome, patron. The themes are yours. Thank you for keeping Stillpoint free.";
    hint.className="patron-hint ok";
    Haptics.trigger("success");
    toast("✦ Welcome, patron ♥", { duration:6000 });
    setTimeout(closePatron, 1400);
  } else {
    hint.textContent="That code doesn't match. It's on the Stripe confirmation page from your receipt.";
    hint.className="patron-hint err";
  }
}

/* ---------------- hero demo / how-it-works / share ----------------
   An auto-playing focal stream in the hero so the product demonstrates itself
   above the fold — the strongest conversion lever. Pauses when off-screen or the
   tab is hidden, and shows a single still word for reduced-motion users. */
function heroDemo(){
  const box=$("heroDemo"), wEl=$("hdWord"); if(!box||!wEl) return;
  const pre=wEl.querySelector(".pre"), piv=wEl.querySelector(".piv"), post=wEl.querySelector(".post");
  const show=(w)=>{ const oi=orpIndex(w); pre.textContent=w.slice(0,oi); piv.textContent=w[oi]||""; post.textContent=w.slice(oi+1); };
  if(matchMedia("(prefers-reduced-motion: reduce)").matches){ show("thought."); return; }  // no streaming motion
  const toks=HERO.split(" ");
  let i=0, timer=null, visible=true;
  const tick=()=>{
    const w=toks[i]; show(w);
    let d=60000/360;                          // ~360 wpm, an unhurried preview pace
    if(/[.!?]$/.test(w)) d+=440;              // breathe at sentence ends
    i=(i+1)%toks.length;
    timer=setTimeout(()=>{ if(visible && !document.hidden) tick(); }, d);
  };
  const start=()=>{ if(!timer && visible && !document.hidden) tick(); };
  const stop=()=>{ clearTimeout(timer); timer=null; };
  new IntersectionObserver(es=>{ visible=es[0].isIntersecting; visible?start():stop(); }).observe(box);
  document.addEventListener("visibilitychange",()=>{ document.hidden?stop():start(); });
  start();
}
let aboutReturn=null;   // element focus returns to when the explainer closes
function closeAbout(){ const a=$("about"); if(!a||!a.classList.contains("show")) return; a.classList.remove("show"); if(aboutReturn && aboutReturn.focus) aboutReturn.focus({preventScroll:true}); }

// Turn a finished session into a shareable line — a natural completion → acquisition loop.
async function shareResult(){
  const url="https://stillpointreader.com/";
  const text=`I just finished “${S.title}” on Stillpoint: ${$("stWords").textContent} words in ${$("stTime").textContent}, at ${$("stWpm").textContent} wpm. A calm, private speed-reader that runs entirely in your browser.`;
  // Fold the link into the text and DON'T pass a separate `url` — when both are given,
  // most share targets keep only the url and drop the stats. One text block keeps both.
  const message=`${text} ${url}`;
  if(navigator.share){
    try{ await navigator.share({ title:"Stillpoint", text:message }); }
    catch(err){ if(!(err && err.name==="AbortError")){ try{ await navigator.clipboard.writeText(message); toast("Result copied. Paste it anywhere to share."); }catch(e){} } }
    return;
  }
  try{ await navigator.clipboard.writeText(message); toast("Result copied. Paste it anywhere to share."); }
  catch(e){ toast("Couldn't copy automatically. Long-press to copy your result."); }
}

/* ---------------- wiring ---------------- */
function init(){
  const dz=$("dropzone"), fi=$("fileInput");
  dz.onclick=()=>fi.click();
  dz.addEventListener("keydown",e=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); fi.click(); }});
  fi.onchange=e=>handleFile(e.target.files[0]);
  ["dragenter","dragover"].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.add("drag");}));
  ["dragleave","drop"].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.remove("drag");}));
  dz.addEventListener("drop",e=>handleFile(e.dataTransfer.files[0]));

  // library backup: share (AirDrop/etc.), export to a file, or import on another device
  if(canShareFiles()){ const sb=$("shareBtn"); sb.classList.remove("hidden"); sb.onclick=shareBackup; }
  $("exportBtn").onclick = exportLibrary;
  $("importBtn").onclick = ()=>$("importInput").click();
  $("importInput").onchange = e=>{ const f=e.target.files[0]; importBackup(f); e.target.value=""; };

  $("pasteGo").onclick=()=>{
    const txt=$("paste").value.trim();
    if(!txt){ $("paste").focus(); return; }
    const toks=tokenize(txt);
    const key="paste::"+txt.length;
    openReader(toks,[{title:"Pasted text",start:0}],"Pasted text",`TEXT · ${toks.length.toLocaleString()} words`,key,[],null,"text");
    persist(key,{kind:"text",text:txt});
  };
  // "Try it" starts reading immediately — the sample is the first-run experience,
  // not a textarea to be filled and then submitted.
  const startDemo=()=>{
    closeAbout();
    const toks=tokenize(DEMO);
    const key="paste::"+DEMO.length;
    openReader(toks,[{title:"Sample passage",start:0}],"Sample passage",`TEXT · ${toks.length.toLocaleString()} words`,key,[],null,"text");
    persist(key,{kind:"text",text:DEMO});
  };
  $("demoBtn").onclick=()=>{ $("paste").value=DEMO; $("paste").focus(); };
  $("heroTry").onclick=startDemo;
  $("aboutTry").onclick=startDemo;

  // "How it works" — opens the explainer modal (was a dead # link)
  const about=$("about");
  const openAbout=()=>{ aboutReturn=document.activeElement; about.classList.add("show"); $("aboutClose").focus(); };
  $("aboutLink").onclick=(e)=>{ e.preventDefault(); openAbout(); };
  $("aboutClose").onclick=closeAbout;
  about.addEventListener("click",e=>{ if(e.target===about) closeAbout(); });

  // modal keyboard: Escape dismisses, Tab stays trapped inside the open dialog
  document.addEventListener("keydown",e=>{
    const aboutOpen=about.classList.contains("show"), doneOpen=$("done").classList.contains("show"), reviewOpen=$("review").classList.contains("show"), patronOpen=$("patron").classList.contains("show"), guideOpen=$("guide").classList.contains("show");
    if(!aboutOpen && !doneOpen && !reviewOpen && !patronOpen && !guideOpen) return;
    if(e.key==="Escape"){ e.preventDefault(); guideOpen ? closeGuide() : patronOpen ? closePatron() : reviewOpen ? closeReview() : (aboutOpen ? closeAbout() : requestHome()); }
    else if(e.key==="Tab"){ trapTab(guideOpen ? $("guide") : patronOpen ? $("patron") : reviewOpen ? $("review") : (aboutOpen ? about : $("done")), e); }
  });

  // the guide: complete manual, reachable from everywhere the eye might ask
  $("guideLink").onclick=(e)=>{ e.preventDefault(); openGuide(); };
  $("settingsGuide").onclick=openGuide;
  $("guideClose").onclick=closeGuide;
  $("guide").addEventListener("click",e=>{ if(e.target===$("guide")) closeGuide(); });

  // patron: modal, unlock code, badge, themes
  $("patronCodeLink").onclick=openPatron;
  $("patronClose").onclick=closePatron;
  $("patron").addEventListener("click",e=>{ if(e.target===$("patron")) closePatron(); });
  $("patronUnlock").onclick=tryUnlock;
  $("patronCode").addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); tryUnlock(); }});
  if(isPatron()) $("patronChip").classList.remove("hidden");
  // the header Support pill earns its place: shown only after a finished book (or to patrons)
  let finished=false; try{ finished = !!localStorage.getItem("fp_finished_v1"); }catch(e){}
  if(finished || isPatron()) $("supportPill").classList.remove("hidden");

  $("doneShare").onclick=shareResult;
  heroDemo();
  window.addEventListener("popstate",()=>{
    if(!$("reader").classList.contains("show")) return;
    const explicit=homeIntent; homeIntent=false;
    if(!explicit && closeTopOverlay()){ history.pushState({sp:"reader"}, ""); return; }
    showLibrary();
  });

  $("playBtn").onclick=toggle;
  $("backBtn").onclick=backSentence;
  $("fwdBtn").onclick=fwdSentence;
  $("homeBtn").onclick=requestHome;
  $("homeBtn").addEventListener("keydown",e=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); requestHome(); }});
  // the stage is a multi-gesture surface: vertical drag = speed (with a ghost
  // readout), horizontal swipe = sentence step, pinch = text size. Movement
  // under the slop stays a plain tap, handled by the click listener below.
  const SIZES=[44,62,82,104];
  const speedGhost=(v,phase)=>{
    // haptics stay sparing: one tick when the drag engages, one on hitting a
    // range wall — never per step (battery, and the readout is the feedback)
    if(phase==="move" && !$("speedGhost").classList.contains("on")) Haptics.trigger("light");
    if(phase==="move") Hints.used("speeddrag");
    if(v!==S.wpm){
      setWpm(v);
      if(v===150 || v===800) Haptics.trigger("light");
    }
    showSpeedGhost(v, phase==="move" ? 0 : 400);   // held open while the finger drags
  };
  const gest = stageGestures($("stage"), {
    getWpm:()=>S.wpm,
    onSpeed:speedGhost,
    getSizeIndex:()=>Math.max(0, SIZES.indexOf(S.size)),
    setSizeIndex:(i)=>{ Hints.used("pinch"); if(SIZES[i]!==S.size){ setSize(SIZES[i]); Haptics.trigger("light"); } },
    onSwipe:(dir)=>{
      if(S.cardOpen) return;
      if(!$("resting").classList.contains("hidden") || !S.tokens.length) return;
      dir>0 ? backSentence() : fwdSentence();   // the step flashes its own chevron
      Hints.used("zones");
      Haptics.trigger("light");
    },
    // hold the word you're hearing to mark its sentence — the stream never stops
    onHold:()=>{
      if(S.cardOpen || !S.tokens.length) return;
      if($("resting").classList.contains("hidden")){ markCurrent(false); Hints.used("holdmark"); }
    },
  });
  $("stage").addEventListener("click",(e)=>{
    if(gest.consumed()) return;   // a drag/swipe/pinch owns this interaction
    if(S.cardOpen){ resumeFromCard(); return; }
    Haptics.trigger("light");
    const started = $("resting").classList.contains("hidden");
    if(started && S.tokens.length){
      const r=$("stage").getBoundingClientRect();
      const x=(e.clientX-r.left)/r.width;
      if(x<0.2){ backSentence(); Hints.used("zones"); return; }
      if(x>0.8){ fwdSentence(); Hints.used("zones"); return; }
    }
    toggle();
  });

  // Cmd/Ctrl+Enter begins reading straight from the paste box (lower friction than reaching for the button)
  $("paste").addEventListener("keydown",e=>{ if(e.key==="Enter" && (e.metaKey||e.ctrlKey)){ e.preventDefault(); $("pasteGo").click(); }});

  // session-complete screen
  $("doneAgain").onclick=()=>{ $("done").classList.remove("show"); S.index=0; S.readMs=0; play(); };
  $("doneLib").onclick=requestHome;

  // auto-pause when the tab/window is hidden so you don't lose your place;
  // returning to a still-playing reader re-arms the wake lock (the API drops
  // it whenever the page hides, without telling the play/pause pair)
  document.addEventListener("visibilitychange",()=>{
    if(document.hidden){ if(S.playing) pause(); }
    else if(S.playing && !wakeLock) acquireWakeLock();
  });

  // Re-centre the ribbon when the viewport changes (rotation, split-screen, browser
  // chrome collapsing): its pixel offset comes from stage geometry, so a resize while
  // paused would otherwise leave the focal word sitting off-centre.
  let rzTimer=null;
  const onViewportChange=()=>{
    clearTimeout(rzTimer);
    rzTimer=setTimeout(()=>{
      invalidateRibbon();   // stage geometry moved under the cached measurements
      if($("reader").classList.contains("show") && !$("ribbon").classList.contains("hidden")) render();
    },120);
  };
  window.addEventListener("resize",onViewportChange);
  if(window.visualViewport) window.visualViewport.addEventListener("resize",onViewportChange);

  document.querySelectorAll("#modeSeg button").forEach(b=>b.onclick=()=>setMode(b.dataset.mode));
  document.querySelectorAll("#chunkSeg button").forEach(b=>b.onclick=()=>{S.chunk=+b.dataset.c;setChunkUI(S.chunk); if(!$("ribbon").classList.contains("hidden")) render();});
  document.querySelectorAll("#sizeSeg button").forEach(b=>b.onclick=()=>setSize(+b.dataset.s));
  $("wpm").oninput=e=>nudgeWpm(+e.target.value);
  // one tick per press (pointerdown), silent during the hold-repeat ramp
  const stepWpm=(d)=>()=>nudgeWpm(S.wpm+d);
  holdRepeat($("wpmDown"), stepWpm(-25));
  holdRepeat($("wpmUp"),  stepWpm(25));
  $("wpmDown").addEventListener("pointerdown",()=>Haptics.trigger("light"));
  $("wpmUp").addEventListener("pointerdown",()=>Haptics.trigger("light"));

  // "Reading settings" disclosure for the secondary controls
  $("settingsToggle").onclick=()=>{ setSettingsOpen(!$("moreWrap").classList.contains("open")); Haptics.trigger("light"); };

  // Phase 2: block still-card / page view / figures index wiring
  $("bcResume").onclick=resumeFromCard;
  $("bcViewPage").onclick=openPageView;
  $("bcDismiss").onclick=()=>{ if(S.currentBlock) dismissBlock(S.currentBlock); };
  $("pvBack").onclick=closePageView;
  $("fiClose").onclick=closeFigIndex;

  // contents panel + settings sheet chrome
  $("tocToggle").onclick=()=>{ tocOpen() ? closeToc() : openToc(); Haptics.trigger("light"); };
  $("tocClose").onclick=closeToc;
  $("tocScrim").onclick=closeToc;
  $("tocFigs").onclick=()=>{ closeToc(); openFigIndex(); };
  $("sheetDone").onclick=()=>{ setSettingsOpen(false); Haptics.trigger("light"); };
  $("sheetScrim").onclick=()=>setSettingsOpen(false);
  wireSheet($("toc"), $("tocScrim"), closeToc);
  wireSheet($("moreWrap"), $("sheetScrim"), ()=>setSettingsOpen(false));
  placeModeCtrl();

  // daily goal stepper on the streak strip
  const stepGoal=(d)=>()=>{ Streak.setGoal(Streak.getState().goalMin+d); renderStreak(); };
  holdRepeat($("goalDown"), stepGoal(-GOAL_STEP));
  holdRepeat($("goalUp"),  stepGoal(GOAL_STEP));
  $("goalDown").addEventListener("pointerdown",()=>Haptics.trigger("light"));
  $("goalUp").addEventListener("pointerdown",()=>Haptics.trigger("light"));
  // tap the card chrome (not its body/buttons) to resume
  $("blockCard").addEventListener("click",e=>{ if(e.target.id==="blockCard" || (e.target.classList&&e.target.classList.contains("bc-head"))) resumeFromCard(); });
  // block presentation mode: global segment + per-type overrides
  document.querySelectorAll("#blockModeSeg button").forEach(b=>b.onclick=()=>{ setBlockModeDefault(b.dataset.bm); Haptics.trigger("light"); });
  $("blockModeAdvanced").onclick=()=>{ $("blockModeGrid").classList.toggle("hidden"); };

  // Phase 3: highlights + rewind wiring
  const markBtn=$("markBtn");
  if(markBtn){
    let lp=null, longFired=false;
    const startLP=()=>{ longFired=false; lp=setTimeout(()=>{ longFired=true; markCurrent(true); }, 450); };
    const endLP=()=>{ clearTimeout(lp); };
    markBtn.addEventListener("pointerdown",startLP);
    markBtn.addEventListener("pointerup",endLP);
    markBtn.addEventListener("pointerleave",endLP);
    markBtn.addEventListener("pointercancel",endLP);   // scroll/gesture steals the pointer — don't fire a phantom mark
    markBtn.onclick=()=>{ if(longFired){ longFired=false; return; } markCurrent(false); };  // tap = sentence
  }
  $("replayBtn") && ($("replayBtn").onclick=replaySentence);
  $("back10Btn") && ($("back10Btn").onclick=back10);
  $("rvClose").onclick=closeReview;
  $("rvExport").onclick=exportHighlights;
  $("review").addEventListener("click",e=>{ if(e.target===$("review")) closeReview(); });
  $("doneReview").onclick=()=>{ $("done").classList.remove("show"); openReview(); };

  // reading-aid toggles (countdown / context line)
  document.querySelectorAll("#aidSeg button").forEach(b=>b.onclick=()=>{
    const k=b.dataset.aid; settings[k]=!settings[k]; applyAids();
    if(k==="context") $("ribbon").classList.toggle("no-ctx", !settings.context);
    if(k==="zen"){ settings.zen ? (S.playing && armZen()) : disarmZen(); }
    Haptics.trigger("light");
  });

  // haptics: subtle tap on controls, richer cue on a donation tap
  document.querySelectorAll("#modeSeg button,#chunkSeg button,#sizeSeg button,#replayBtn,#backBtn,#fwdBtn,#playBtn")
    .forEach(b=>b.addEventListener("click",()=>Haptics.trigger("light")));
  document.querySelectorAll(".tier,.support-pill,.footer-support")
    .forEach(a=>a.addEventListener("click",()=>Haptics.trigger("success")));

  // scrubber
  const track=$("track");
  const scrubTo=(clientX)=>{ const r=track.getBoundingClientRect(); const p=Math.max(0,Math.min(1,(clientX-r.left)/r.width));
    const seg=S.chapters[chapterAt(S.chapters,S.index)];
    jumpTo(seg.start + Math.round(p*(seg.end-seg.start))); };
  let dragging=false;
  track.addEventListener("mousedown",e=>{dragging=true;scrubTo(e.clientX);});
  window.addEventListener("mousemove",e=>{if(dragging)scrubTo(e.clientX);});
  window.addEventListener("mouseup",()=>dragging=false);
  track.addEventListener("touchstart",e=>scrubTo(e.touches[0].clientX),{passive:true});
  track.addEventListener("touchmove",e=>scrubTo(e.touches[0].clientX),{passive:true});
  // keyboard scrubbing when the progress bar has focus (arrows step ~2% of the chapter, Home/End jump to its edges)
  track.addEventListener("keydown",e=>{
    if(S.tokens.length<2) return;
    const seg=S.chapters[chapterAt(S.chapters,S.index)];
    const step=Math.max(1, Math.round((seg.end-seg.start)*0.02));
    let handled=true;
    if(e.code==="ArrowLeft"||e.code==="ArrowDown") jumpTo(S.index-step);
    else if(e.code==="ArrowRight"||e.code==="ArrowUp") jumpTo(S.index+step);
    else if(e.code==="Home") jumpTo(seg.start);
    else if(e.code==="End") jumpTo(seg.end-1);
    else handled=false;   // Space etc. falls through to play/pause
    if(handled){ e.preventDefault(); e.stopPropagation(); }
  });

  // keyboard
  document.addEventListener("keydown",e=>{
    if(!$("reader").classList.contains("show")) return;
    if($("done").classList.contains("show")||$("about").classList.contains("show")||$("review").classList.contains("show")||$("patron").classList.contains("show")||$("guide").classList.contains("show")) return;  // a modal owns the keyboard
    // contents panel / mobile settings sheet owns the keyboard while open
    const sheetOpen = isSheet() && $("moreWrap").classList.contains("open");
    if(tocOpen() || sheetOpen){
      if(e.code==="Escape"){ e.preventDefault(); tocOpen() ? closeToc() : setSettingsOpen(false); return; }
      if(e.code==="Tab"){ trapTab(tocOpen()?$("toc"):$("moreWrap"), e); return; }
      return;
    }
    // Phase 2: an open block card / page view / figures index owns the keyboard
    const fiOpen=!$("figIndex").classList.contains("hidden");
    if(S.cardOpen || fiOpen){
      const pvOpen=!$("pageView").classList.contains("hidden");
      if(e.code==="Escape"){ e.preventDefault(); if(fiOpen) closeFigIndex(); else if(pvOpen) closePageView(); else resumeFromCard(); return; }
      if(e.code==="Tab"){ trapTab(fiOpen?$("figIndex"):(pvOpen?$("pageView"):$("blockCard")), e); return; }
      if(e.code==="Space" && !fiOpen && !pvOpen){ if(e.target.tagName==="BUTTON") return; e.preventDefault(); resumeFromCard(); return; }
      return;
    }
    const tag=e.target.tagName;
    if(tag==="TEXTAREA"||tag==="SELECT"||tag==="INPUT") return;   // don't hijack typing
    if(e.code==="Space"){
      if(tag==="BUTTON"||e.target.getAttribute("role")==="button") return;  // let a focused control activate itself
      e.preventDefault();toggle();
    }
    else if(e.code==="ArrowLeft"){e.preventDefault(); e.shiftKey ? back10() : backSentence();}
    else if(e.code==="ArrowRight"){e.preventDefault();fwdSentence();}
    else if(e.code==="ArrowUp"){e.preventDefault();nudgeWpm(S.wpm+25);}
    else if(e.code==="ArrowDown"){e.preventDefault();nudgeWpm(S.wpm-25);}
    else if(e.code==="KeyM"){e.preventDefault(); markCurrent(e.shiftKey);}   // M sentence, Shift+M word
    else if(e.code==="KeyR"){e.preventDefault(); replaySentence();}
    else if(e.key==="?"){e.preventDefault(); openGuide();}
    else if(e.code==="Escape"){requestHome();}
  });

  // restore persisted prefs
  try{
    const prefs=JSON.parse(localStorage.getItem("fp_prefs")||"{}");
    if(prefs.wpm) setWpm(prefs.wpm); if(prefs.size) setSize(prefs.size);
    if(prefs.mode) setMode(prefs.mode);
    if(typeof prefs.countdown==="boolean") settings.countdown=prefs.countdown;
    if(typeof prefs.context==="boolean") settings.context=prefs.context;
    if(typeof prefs.smartPacing==="boolean") settings.smartPacing=prefs.smartPacing;
    if(typeof prefs.zen==="boolean") settings.zen=prefs.zen;
    if(typeof prefs.moreOpen==="boolean") settings.moreOpen=prefs.moreOpen;
    // patron themes survive restarts, but never boot a locked theme into the pitch modal
    if(prefs.theme) applyTheme((isPatron() || !isPatronTheme(prefs.theme)) ? prefs.theme : "midnight");
  }catch(e){}
  // a persisted-open panel is fine inline on desktop, but a surprise modal on a phone
  setSize(S.size); setWpm(S.wpm); applyAids(); setSettingsOpen(isSheet() ? false : settings.moreOpen);
  buildThemeSeg();

  renderLibrary(); renderStreak();

  // a display font arriving after first measure would poison the ribbon cache
  if(document.fonts && document.fonts.ready) document.fonts.ready.then(()=>invalidateRibbon()).catch(()=>{});

  // A file shared into the PWA (Web Share Target) is stashed by the service worker
  // under shared::pending; pick it up, clean the URL, and open it like any upload.
  if(new URLSearchParams(location.search).get("shared")){
    history.replaceState(null,"",location.pathname);
    Store.get("shared::pending").then(rec=>{
      if(rec && rec.file){ Store.del("shared::pending").catch(()=>{}); handleFile(rec.file); }
    }).catch(()=>{});
  }

  // Persist prefs on every "might be leaving" signal — beforeunload alone never
  // fires on iOS Safari / standalone PWA, which would silently drop settings there.
  const savePrefs=()=>{ try{ localStorage.setItem("fp_prefs",JSON.stringify({wpm:S.wpm,size:S.size,mode:S.mode,countdown:settings.countdown,context:settings.context,smartPacing:settings.smartPacing,zen:settings.zen,moreOpen:settings.moreOpen,theme})); }catch(e){} };
  window.addEventListener("beforeunload",savePrefs);
  // a killed tab mid-play still credits the segment to the streak ledger
  // (and gets its exact position written past the streaming-save pacing)
  window.addEventListener("pagehide",()=>{ settleReading(); saveProgress(true); savePrefs(); });
  document.addEventListener("visibilitychange",()=>{ if(document.hidden) savePrefs(); });
}

if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", init);
else init();

// Register the service worker so the app (and your already-opened library) works offline.
if("serviceWorker" in navigator){
  window.addEventListener("load", ()=>{
    navigator.serviceWorker.register("sw.js").catch(()=>{ /* offline mode unavailable; app still works online */ });
    // A controller change while this page is already controlled means a newer
    // version took over; the very first install claiming the page is not news.
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", ()=>{
      if(!hadController){ hadController = true; return; }
      noteUpdate();
    });
  });
}
