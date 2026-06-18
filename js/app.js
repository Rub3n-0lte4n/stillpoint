// Stillpoint — app entry. Wires the reader UI, playback engine, and document loading.
import { tokenize, orpIndex, esc, DEMO } from "./text.js";
import { Haptics } from "./haptics.js";
import { parsePDF, parseEPUB } from "./parsers.js";
import { Store } from "./store.js";

/* ---------------- state ---------------- */
const S = {
  tokens: [],          // [{w, end, pause}]
  units: [],           // [{title, start}]  (chapters/pages)
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
};
const $ = (id) => document.getElementById(id);
const PRESETS = [[250,"Comfortable"],[400,"Focus"],[550,"Fast"],[700,"Skim"]];
const REWIND_WORDS = 5;   // back up on resume for re-orientation
const RAMP_WORDS = 15;    // ease speed up over the first N words of a run
const RAMP_MIN = 0.6;     // start each run at 60% of target WPM

/* ---------------- context line ----------------
   Shows the sentence the current word belongs to, dimmed beneath the focal word,
   with the current word(s) brightened — so fast reading keeps its bearings. */
let ctxRange = null;
function sentenceRange(i){
  let s=i; while(s>0 && !S.tokens[s-1].end) s--;
  let e=i; while(e<S.tokens.length-1 && !S.tokens[e].end) e++;
  return {s,e};
}
function updateContext(){
  const ctx=$("context");
  if(!ctx) return;
  if(S.index>=S.tokens.length){ ctx.classList.add("hidden"); return; }
  const r=sentenceRange(S.index);
  if(!ctxRange || r.s!==ctxRange.s || r.e!==ctxRange.e){   // rebuild only when the sentence changes
    let html="";
    for(let k=r.s;k<=r.e;k++) html+=`<span class="cw" data-i="${k}">${esc(S.tokens[k].w)}</span> `;
    ctx.innerHTML=html;
    ctxRange=r;
  }
  ctx.querySelectorAll(".cw.on").forEach(el=>el.classList.remove("on"));
  const last=Math.min(S.index+S.chunk-1, r.e);
  for(let k=S.index;k<=last;k++){ const el=ctx.querySelector(`.cw[data-i="${k}"]`); if(el) el.classList.add("on"); }
  ctx.classList.remove("hidden");
}

/* ---------------- rendering a frame ----------------
   Every mode anchors on a single pivot letter held dead-centre (grid: 1fr auto 1fr),
   so the word never shifts horizontally as its length changes. ORP/Hybrid colour the
   pivot; RSVP keeps it uncoloured but still position-locked. */
function renderFrame(){
  const wordEl = $("word"), rest = $("resting");
  if(S.index>=S.tokens.length){ return; }
  rest.classList.add("hidden");
  wordEl.classList.remove("hidden");

  const chunkTokens = S.tokens.slice(S.index, S.index+S.chunk);
  if(chunkTokens.length===0) return;
  const highlight = (S.mode==="orp" || S.mode==="hybrid");

  const pivotPos = (S.mode==="orp") ? 0 : Math.floor((chunkTokens.length-1)/2);
  const before = chunkTokens.slice(0,pivotPos).map(t=>t.w).join(" ");
  const after  = chunkTokens.slice(pivotPos+1).map(t=>t.w).join(" ");
  const pw = chunkTokens[pivotPos].w;
  const oi = orpIndex(pw);
  const preText  = (before?before+" ":"") + pw.slice(0,oi);
  const pivChar  = pw[oi] || "";
  const postText = pw.slice(oi+1) + (after?" "+after:"");

  wordEl.className = "word";
  wordEl.innerHTML =
    `<span class="pre">${esc(preText)}</span>`+
    `<span class="piv${highlight?"":" off"}">${esc(pivChar)}</span>`+
    `<span class="post">${esc(postText)}</span>`;
  updateContext();
}

/* ---------------- playback loop ---------------- */
function step(){
  if(S.index>=S.tokens.length){ finish(); return; }   // reached the end
  renderFrame();
  const chunkTokens = S.tokens.slice(S.index, S.index+S.chunk);

  // gentle speed ramp: ease from RAMP_MIN up to full WPM over the first words of a run
  const since = S.index - S.rampStart;
  const ramp = Math.min(1, RAMP_MIN + (1-RAMP_MIN)*(since/RAMP_WORDS));
  const perWord = 60000 / (S.wpm * ramp);

  let delay = perWord * chunkTokens.length;
  const last = chunkTokens[chunkTokens.length-1];
  if(last.end) delay += perWord*0.9;
  else if(last.pause) delay += perWord*0.45;
  const longest = Math.max(...chunkTokens.map(t=>t.w.length));
  if(longest>8) delay += perWord*0.25;

  S.index += S.chunk;
  updateProgress();
  saveProgress();
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
  countdownThenStep();
}
// 3·2·1 countdown before streaming, so you can settle into the focal point.
function countdownThenStep(){
  const wordEl = $("word");
  $("resting").classList.add("hidden"); wordEl.classList.remove("hidden");
  updateContext();   // preview the sentence you're about to read
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
function pause(){
  S.playing=false;
  clearTimeout(S.timer);
  if(S.playStart){ S.readMs += Date.now()-S.playStart; S.playStart=null; }
  $("playIcon").innerHTML = '<path d="M8 5v14l11-7z"/>';
  $("playBtn").setAttribute("aria-label","Play");
  saveProgress();
}
function toggle(){ S.playing ? pause() : play(); }
// Reached the end — show the session summary.
function finish(){
  pause();
  const words = S.tokens.length;
  const mins = S.readMs/60000;
  const avg = mins>0.05 ? Math.round(words/mins) : S.wpm;
  $("stWords").textContent = words.toLocaleString();
  $("stTime").textContent = fmt(S.readMs/1000);
  $("stWpm").textContent = avg.toLocaleString();
  $("doneSub").textContent = `You finished “${S.title}”.`;
  $("done").classList.add("show");
}

/* ---------------- navigation ---------------- */
function jumpTo(i){
  S.index = Math.max(0, Math.min(i, S.tokens.length-1));
  renderFrame(); updateProgress(); saveProgress();
}
function backSentence(){
  let i = S.index-1;
  while(i>0 && !S.tokens[i-1].end) i--;
  if(i>=S.index-1){ i=S.index-2; while(i>0 && !S.tokens[i-1].end) i--; }
  jumpTo(Math.max(0,i));
}
function fwdSentence(){
  let i = S.index;
  while(i<S.tokens.length && !S.tokens[i].end) i++;
  jumpTo(Math.min(S.tokens.length-1, i+1));
}

/* ---------------- progress + scrubber ---------------- */
function fmt(sec){ sec=Math.max(0,Math.round(sec)); const m=Math.floor(sec/60); const s=sec%60; return m+":"+String(s).padStart(2,"0"); }
function updateProgress(){
  const total = S.tokens.length||1;
  const pct = Math.min(100, (S.index/total)*100);
  $("trackFill").style.width = pct+"%";
  $("trackKnob").style.left = pct+"%";
  const tk=$("track"); tk.setAttribute("aria-valuenow", Math.round(pct)); tk.setAttribute("aria-valuetext", Math.round(pct)+"% read");
  $("tElapsed").textContent = fmt(S.index/S.wpm*60);
  $("tLeft").textContent = "-"+fmt((total-S.index)/S.wpm*60);
  if(S.units.length>1){
    let u=0; for(let k=0;k<S.units.length;k++){ if(S.units[k].start<=S.index) u=k; }
    if($("navSel").selectedIndex!==u) $("navSel").selectedIndex=u;
  }
}

/* ---------------- toasts (non-blocking, on-brand feedback) ---------------- */
function toast(msg, {action, onAction, duration=4500, error=false}={}){
  const wrap=$("toasts");
  const el=document.createElement("div");
  el.className="toast"+(error?" err":"");
  el.setAttribute("role","status");
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

/* ---------------- resume / library (localStorage) ---------------- */
const LIB_KEY="fp_library_v1";
function loadLib(){ try{return JSON.parse(localStorage.getItem(LIB_KEY))||[];}catch(e){return [];} }
function saveLib(lib){ localStorage.setItem(LIB_KEY, JSON.stringify(lib.slice(0,8))); }
function saveProgress(){
  if(!S.key) return;
  const lib = loadLib().filter(x=>x.key!==S.key);
  lib.unshift({key:S.key,title:S.title,type:S.meta.split(" ")[0]||"TEXT",index:S.index,total:S.tokens.length,ts:Date.now()});
  saveLib(lib);
}
function renderLibrary(){
  const lib = loadLib();
  const box=$("recent"), list=$("recentList");
  if(lib.length===0){ box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  list.innerHTML="";
  lib.forEach(item=>{
    const pct = item.total ? Math.round(item.index/item.total*100) : 0;
    const el=document.createElement("div"); el.className="recent-item";
    el.innerHTML=`<span class="ri-type">${esc(item.type||"TEXT")}</span>
      <span class="ri-name">${esc(item.title)}</span>
      <span class="ri-prog">${pct}%</span>
      <span class="ri-x" title="Remove">✕</span>`;
    el.querySelector(".ri-name").onclick=el.querySelector(".ri-type").onclick=el.querySelector(".ri-prog").onclick=()=>openFromStore(item);
    el.querySelector(".ri-x").onclick=(e)=>{ e.stopPropagation(); removeItem(item); };
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
function openReader(tokens, units, title, meta, key){
  S.tokens=tokens; S.units=units&&units.length?units:[{title:"Start",start:0}];
  S.title=title; S.meta=meta; S.key=key; S.index=0;
  S.readMs=0; S.playStart=null; S.rampStart=0; $("done").classList.remove("show");
  const prior = loadLib().find(x=>x.key===key);
  if(prior && prior.index>0 && prior.index<tokens.length) S.index=prior.index;

  $("docTitle").textContent=title;
  $("docMeta").textContent=meta;
  const sel=$("navSel"); sel.innerHTML="";
  S.units.forEach(u=>{ const o=document.createElement("option"); o.value=u.start; o.textContent=u.title; sel.appendChild(o); });
  sel.onchange=()=>jumpTo(parseInt(sel.value,10));

  $("landing").style.display="none";
  $("reader").classList.add("show");
  renderFrame(); updateProgress();
  $("resting").classList.remove("hidden"); $("word").classList.add("hidden");
  ctxRange=null; $("context").classList.add("hidden");
  saveProgress(); // record the entry immediately so the recent library reflects it
}

/* ---------------- local file cache (IndexedDB) ---------------- */
// Persist a file/text so it can be reopened later without re-uploading; keep IDB in sync with the library.
async function persist(key, rec){
  try{ await Store.put(key, rec); await pruneStore(); }
  catch(e){ /* storage unavailable or over quota — non-fatal, file just won't be remembered */ }
}
async function pruneStore(){
  try{
    const keep = new Set(loadLib().map(x=>x.key));
    for(const k of await Store.keys()){ if(!keep.has(k)) await Store.del(k); }
  }catch(e){}
}
// Reopen a recent item straight from the device.
async function openFromStore(item){
  let rec;
  try{ rec = await Store.get(item.key); }catch(e){}
  if(!rec){ toast(`“${item.title}” isn't on this device anymore — open it once to remember it.`); return; }
  if(rec.kind==="text"){
    const toks=tokenize(rec.text);
    openReader(toks,[{title:"Pasted text",start:0}],item.title,`TEXT · ${toks.length.toLocaleString()} words`,item.key);
    return;
  }
  showParse("Opening "+item.title+"…","Reading from this device");
  try{
    if(rec.kind==="pdf"){
      const {tokens,units,pages}=await parsePDF(rec.blob, setParse);
      hideParse(); openReader(tokens,units,item.title,`PDF · ${pages} pages · ${tokens.length.toLocaleString()} words`,item.key);
    } else {
      const {tokens,units,chapters}=await parseEPUB(rec.blob, setParse);
      hideParse(); openReader(tokens,units,item.title,`EPUB · ${chapters} chapters · ${tokens.length.toLocaleString()} words`,item.key);
    }
  }catch(err){ hideParse(); toast("Couldn't reopen that file — "+(err&&err.message?err.message:err), {error:true}); }
}
function goHome(){
  pause();
  $("done").classList.remove("show");
  $("reader").classList.remove("show");
  $("landing").style.display="";
  renderLibrary();
}

async function handleFile(file){
  if(!file) return;
  const name=file.name.replace(/\.(pdf|epub)$/i,"");
  const ext=(file.name.split(".").pop()||"").toLowerCase();
  const key = file.name+"::"+file.size;
  showParse("Opening "+name+"…", "Extracting text locally");
  try{
    if(ext==="pdf"){
      const {tokens,units,pages}=await parsePDF(file, setParse);
      hideParse();
      openReader(tokens,units,name,`PDF · ${pages} pages · ${tokens.length.toLocaleString()} words`,key);
      persist(key,{kind:"pdf",blob:file,name:file.name});
    } else if(ext==="epub"){
      const {tokens,units,chapters}=await parseEPUB(file, setParse);
      hideParse();
      openReader(tokens,units,name,`EPUB · ${chapters} chapters · ${tokens.length.toLocaleString()} words`,key);
      persist(key,{kind:"epub",blob:file,name:file.name});
    } else {
      hideParse(); toast("Please choose a PDF or EPUB file.");
    }
  }catch(err){
    console.error(err); hideParse();
    toast("Couldn't read that file — "+(err&&err.message?err.message:err), {error:true});
  }
}
function showParse(t,s){ $("parseTitle").textContent=t; $("parseSub").textContent=s; $("parseFill").style.width="0%"; $("parsing").classList.add("show"); }
function setParse(p){ $("parseFill").style.width=Math.round(p*100)+"%"; }
function hideParse(){ $("parsing").classList.remove("show"); }

/* ---------------- controls ---------------- */
function setMode(m){
  S.mode=m;
  document.querySelectorAll("#modeSeg button").forEach(b=>b.classList.toggle("active",b.dataset.mode===m));
  const chunkCtrl=$("chunkCtrl");
  if(m==="orp"){ S.chunk=1; chunkCtrl.style.opacity=.4; chunkCtrl.style.pointerEvents="none"; setChunkUI(1); }
  else if(m==="hybrid"){ if(S.chunk<2) S.chunk=3; chunkCtrl.style.opacity=1; chunkCtrl.style.pointerEvents="auto"; setChunkUI(S.chunk);
    document.querySelector('#chunkSeg button[data-c="1"]').style.display="none"; }
  else { chunkCtrl.style.opacity=1; chunkCtrl.style.pointerEvents="auto"; document.querySelector('#chunkSeg button[data-c="1"]').style.display=""; setChunkUI(S.chunk); }
  renderFrame();
}
function setChunkUI(c){ document.querySelectorAll("#chunkSeg button").forEach(b=>b.classList.toggle("active",+b.dataset.c===c)); }
function setWpm(v){
  S.wpm=v; $("wpmVal").textContent=v; $("wpm").value=v;
  let label="Custom", best=1e9;
  PRESETS.forEach(([w,n])=>{ const d=Math.abs(w-v); if(d<best && d<=40){best=d;label=n;} });
  $("presetLabel").textContent=label;
  updateProgress();
}
function setSize(s){ S.size=s; document.documentElement.style.setProperty("--read-size",s+"px");
  document.querySelectorAll("#sizeSeg button").forEach(b=>b.classList.toggle("active",+b.dataset.s===s)); }

/* ---------------- wiring ---------------- */
function init(){
  const dz=$("dropzone"), fi=$("fileInput");
  dz.onclick=()=>fi.click();
  dz.addEventListener("keydown",e=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); fi.click(); }});
  fi.onchange=e=>handleFile(e.target.files[0]);
  ["dragenter","dragover"].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.add("drag");}));
  ["dragleave","drop"].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.remove("drag");}));
  dz.addEventListener("drop",e=>handleFile(e.dataTransfer.files[0]));

  $("pasteGo").onclick=()=>{
    const txt=$("paste").value.trim();
    if(!txt){ $("paste").focus(); return; }
    const toks=tokenize(txt);
    const key="paste::"+txt.length;
    openReader(toks,[{title:"Pasted text",start:0}],"Pasted text",`TEXT · ${toks.length.toLocaleString()} words`,key);
    persist(key,{kind:"text",text:txt});
  };
  $("demoBtn").onclick=()=>{ $("paste").value=DEMO; };
  $("aboutLink").onclick=(e)=>{e.preventDefault();$("paste").value=DEMO;$("paste").scrollIntoView({behavior:"smooth"});};

  $("playBtn").onclick=toggle;
  $("backBtn").onclick=backSentence;
  $("fwdBtn").onclick=fwdSentence;
  $("homeBtn").onclick=goHome;
  $("homeBtn").addEventListener("keydown",e=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); goHome(); }});
  // tap the reading area to play/pause (large, mobile-friendly target)
  $("stage").addEventListener("click",()=>{ toggle(); Haptics.trigger("light"); });

  // session-complete screen
  $("doneAgain").onclick=()=>{ $("done").classList.remove("show"); S.index=0; S.readMs=0; play(); };
  $("doneLib").onclick=goHome;

  // auto-pause when the tab/window is hidden so you don't lose your place
  document.addEventListener("visibilitychange",()=>{ if(document.hidden && S.playing) pause(); });

  document.querySelectorAll("#modeSeg button").forEach(b=>b.onclick=()=>setMode(b.dataset.mode));
  document.querySelectorAll("#chunkSeg button").forEach(b=>b.onclick=()=>{S.chunk=+b.dataset.c;setChunkUI(S.chunk);renderFrame();});
  document.querySelectorAll("#sizeSeg button").forEach(b=>b.onclick=()=>setSize(+b.dataset.s));
  $("wpm").oninput=e=>setWpm(+e.target.value);

  // haptics: subtle tap on controls, richer cue on a donation tap
  document.querySelectorAll("#modeSeg button,#chunkSeg button,#sizeSeg button,#backBtn,#fwdBtn,#playBtn")
    .forEach(b=>b.addEventListener("click",()=>Haptics.trigger("light")));
  document.querySelectorAll(".tier,.support-pill,.footer-support")
    .forEach(a=>a.addEventListener("click",()=>Haptics.trigger("success")));

  // scrubber
  const track=$("track");
  const scrubTo=(clientX)=>{ const r=track.getBoundingClientRect(); const p=Math.max(0,Math.min(1,(clientX-r.left)/r.width)); jumpTo(Math.round(p*(S.tokens.length-1))); };
  let dragging=false;
  track.addEventListener("mousedown",e=>{dragging=true;scrubTo(e.clientX);});
  window.addEventListener("mousemove",e=>{if(dragging)scrubTo(e.clientX);});
  window.addEventListener("mouseup",()=>dragging=false);
  track.addEventListener("touchstart",e=>scrubTo(e.touches[0].clientX),{passive:true});
  track.addEventListener("touchmove",e=>scrubTo(e.touches[0].clientX),{passive:true});

  // keyboard
  document.addEventListener("keydown",e=>{
    if(!$("reader").classList.contains("show")) return;
    const tag=e.target.tagName;
    if(tag==="TEXTAREA"||tag==="SELECT"||tag==="INPUT"||tag==="BUTTON"||e.target.getAttribute("role")==="button") return;
    if(e.code==="Space"){e.preventDefault();toggle();}
    else if(e.code==="ArrowLeft"){e.preventDefault();backSentence();}
    else if(e.code==="ArrowRight"){e.preventDefault();fwdSentence();}
    else if(e.code==="ArrowUp"){e.preventDefault();setWpm(Math.min(800,S.wpm+25));}
    else if(e.code==="ArrowDown"){e.preventDefault();setWpm(Math.max(150,S.wpm-25));}
    else if(e.code==="Escape"){goHome();}
  });

  // restore persisted prefs
  try{
    const prefs=JSON.parse(localStorage.getItem("fp_prefs")||"{}");
    if(prefs.wpm) setWpm(prefs.wpm); if(prefs.size) setSize(prefs.size);
    if(prefs.mode) setMode(prefs.mode);
  }catch(e){}
  setSize(S.size); setWpm(S.wpm);

  renderLibrary();
  window.addEventListener("beforeunload",()=>{
    localStorage.setItem("fp_prefs",JSON.stringify({wpm:S.wpm,size:S.size,mode:S.mode}));
  });
}

if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", init);
else init();
