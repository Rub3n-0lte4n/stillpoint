// Stillpoint — app entry. Wires the reader UI, playback engine, and document loading.
import { tokenize, orpIndex, esc, DEMO, HERO } from "./text.js";
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
const settings = { countdown:true, context:true, moreOpen:false };  // reading aids + dock state (persisted)

/* ---------------- centred ribbon ----------------
   One centred line of words. The current word's pivot letter is snapped onto the
   focal point and held STILL for its whole dwell (no sliding) so it stays readable
   at speed; dim neighbours sit on either side for context, refreshing in place. */
let ribbonStart = 0, ribbonLast = -1, ribbonOffset = 0;

function pivotWordIndex(){
  const n = Math.min(S.chunk, S.tokens.length - S.index);
  const pos = (S.mode==="orp") ? 0 : Math.floor((Math.max(1,n)-1)/2);
  return S.index + pos;
}
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
}
// Snap the ribbon so the pivot word's focal letter sits exactly on the stage centre.
// Positioning is INSTANT (no slide): the focal word is stationary during its dwell, so
// it stays readable at speed — your eye locks on the centre instead of tracking motion.
function centerRibbon(){
  const rb=$("ribbon"), stage=$("stage");
  rb.querySelectorAll(".rw.on, .rw.pivot").forEach(e=>e.classList.remove("on","pivot"));
  const highlight = (S.mode==="orp" || S.mode==="hybrid");
  const endChunk = Math.min(S.index+S.chunk, S.tokens.length);
  for(let k=S.index;k<endChunk;k++){ const el=rb.querySelector(`.rw[data-i="${k}"]`); if(el) el.classList.add("on"); }
  const pwEl = rb.querySelector(`.rw[data-i="${pivotWordIndex()}"]`);
  if(!pwEl) return;
  if(highlight) pwEl.classList.add("pivot");
  const pr = pwEl.querySelector(".rpiv").getBoundingClientRect();
  const sr = stage.getBoundingClientRect();
  const target = Math.round((ribbonOffset + (sr.left+sr.width/2) - (pr.left+pr.width/2))*100)/100;
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
  fitRibbon();
  centerRibbon();
}

/* ---------------- playback loop ---------------- */
function step(){
  if(S.index>=S.tokens.length){ finish(); return; }   // reached the end
  render();
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
function pause(){
  S.playing=false;
  clearTimeout(S.timer);
  if(S.playStart){ S.readMs += Date.now()-S.playStart; S.playStart=null; }
  $("ribbon").classList.remove("playing");   // brighten neighbours for orientation while paused
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
  $("doneLib").focus({preventScroll:true});   // move focus into the dialog
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
function jumpTo(i){
  S.index = Math.max(0, Math.min(i, S.tokens.length-1));
  render(); updateProgress(); saveProgress();
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
  if(!(history.state && history.state.sp==="reader")) history.pushState({sp:"reader"}, "");  // so Back returns to the library
  ribbonStart=0; ribbonLast=-1; ribbonOffset=0;   // reset the ribbon for the new document
  updateProgress();
  $("resting").classList.remove("hidden"); $("word").classList.add("hidden"); $("ribbon").classList.add("hidden");
  $("playBtn").focus({preventScroll:true});   // move focus into the reader (route-change focus)
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
  showParse("Opening "+item.title+"…","Reading from this device",{kind:rec.kind,name:rec.name||item.title,size:rec.blob?rec.blob.size:0});
  try{
    if(rec.kind==="pdf"){
      const {tokens,units,pages}=await parsePDF(rec.blob, setParse);
      hideParse(); openReader(tokens,units,item.title,`PDF · ${pages} pages · ${tokens.length.toLocaleString()} words`,item.key);
    } else {
      const {tokens,units,chapters}=await parseEPUB(rec.blob, setParse);
      hideParse(); openReader(tokens,units,item.title,`EPUB · ${chapters} chapters · ${tokens.length.toLocaleString()} words`,item.key);
    }
  }catch(err){ hideParse(); toast("Couldn't reopen that file — "+(err&&err.message?err.message:err), {error:true, duration:9000, action:"Retry", onAction:()=>openFromStore(item)}); }
}
// DOM transition back to the library. Moves focus to a sensible landing control
// so keyboard / screen-reader users aren't stranded on the now-hidden reader.
function showLibrary(){
  pause();
  $("done").classList.remove("show");
  $("reader").classList.remove("show");
  $("landing").style.display="";
  renderLibrary();
  $("dropzone").focus({preventScroll:true});
}
// Route user-initiated exits through history so the browser/hardware Back button
// returns to the library instead of leaving the site (popstate → showLibrary).
function requestHome(){
  if(history.state && history.state.sp==="reader") history.back();
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
      const {tokens,units,pages}=await parsePDF(file, setParse);
      hideParse();
      openReader(tokens,units,name,`PDF · ${pages} pages · ${tokens.length.toLocaleString()} words`,key);
      persist(key,{kind:"pdf",blob:file,name:file.name});
    } else {
      const {tokens,units,chapters}=await parseEPUB(file, setParse);
      hideParse();
      openReader(tokens,units,name,`EPUB · ${chapters} chapters · ${tokens.length.toLocaleString()} words`,key);
      persist(key,{kind:"epub",blob:file,name:file.name});
    }
  }catch(err){
    console.error(err); hideParse();
    // inline retry — the file is still in hand, so one tap resumes without re-picking it
    toast("Couldn't read that file — "+(err&&err.message?err.message:err), {error:true, duration:9000, action:"Retry", onAction:()=>handleFile(file)});
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
  if(lib.length===0){ toast("Nothing to back up yet — open a book first."); return null; }
  let prefs=null; try{ prefs = JSON.parse(localStorage.getItem(PREFS_KEY)||"null"); }catch(e){}
  const files=[];
  for(const item of lib){
    let rec; try{ rec = await Store.get(item.key); }catch(e){}
    if(!rec) continue;  // metadata-only entry (file no longer on this device)
    if(rec.kind==="text") files.push({ key:item.key, kind:"text", name:rec.name||item.title, text:rec.text });
    else if(rec.blob)     files.push({ key:item.key, kind:rec.kind, name:rec.name||item.title, data:await blobToDataURL(rec.blob) });
  }
  const backup = { format:BACKUP_FORMAT, version:1, exportedAt:new Date().toISOString(), prefs, library:lib, files };
  return { blob:new Blob([JSON.stringify(backup)], { type:"application/json" }), count:files.length };
}

// Download the backup as a file (works everywhere).
async function exportLibrary(){
  showParse("Packaging your library…","Bundling books, positions and settings");
  let res; try{ res = await buildBackup(); }
  catch(err){ hideParse(); toast("Couldn't export — "+(err&&err.message?err.message:err), {error:true}); return; }
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
  catch(err){ hideParse(); toast("Couldn't prepare the backup — "+(err&&err.message?err.message:err), {error:true}); return; }
  if(!res){ hideParse(); return; }
  hideParse();
  const file = new File([res.blob], backupFilename(), { type:"application/json" });
  // Reuse the backup we just built for the download fallback — no rebuild, one clear message.
  const saveInstead = ()=>{ triggerDownload(res.blob, backupFilename()); toast(`Saved your library as a file instead — import it on another device to sync.`); };
  if(navigator.canShare && !navigator.canShare({ files:[file] })){ return saveInstead(); }  // files unsupported here
  try{
    await navigator.share({ files:[file], title:"Stillpoint library",
      text:"My Stillpoint library — open Stillpoint on the other device and tap “Import backup”." });
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
    let restored=0;
    for(const f of (data.files||[])){
      try{
        if(f.kind==="text") await Store.put(f.key, { kind:"text", text:f.text, name:f.name });
        else if(f.data)     await Store.put(f.key, { kind:f.kind, blob:dataURLToBlob(f.data), name:f.name });
        restored++;
      }catch(e){ /* skip one unreadable entry, keep the rest */ }
    }
    // Merge the library, keeping the most-recently-read entry per book (syncs progress).
    const byKey = new Map();
    for(const it of loadLib()) byKey.set(it.key, it);
    for(const it of data.library){
      const ex = byKey.get(it.key);
      if(!ex || (it.ts||0) > (ex.ts||0)) byKey.set(it.key, it);
    }
    saveLib([...byKey.values()].sort((a,b)=>(b.ts||0)-(a.ts||0)));
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
        applyAids();
      }catch(e){}
    }
    hideParse(); renderLibrary();
    toast(`Imported ${restored} book${restored===1?"":"s"} into your library.`);
  }catch(err){ hideParse(); toast("Couldn't import that backup — "+(err&&err.message?err.message:err), {error:true}); }
}

/* ---------------- controls ---------------- */
function setMode(m){
  S.mode=m;
  document.querySelectorAll("#modeSeg button").forEach(b=>b.classList.toggle("active",b.dataset.mode===m));
  const chunkCtrl=$("chunkCtrl");
  if(m==="orp"){ S.chunk=1; chunkCtrl.style.opacity=.4; chunkCtrl.style.pointerEvents="none"; setChunkUI(1); }
  else if(m==="hybrid"){ if(S.chunk<2) S.chunk=3; chunkCtrl.style.opacity=1; chunkCtrl.style.pointerEvents="auto"; setChunkUI(S.chunk);
    document.querySelector('#chunkSeg button[data-c="1"]').style.display="none"; }
  else { chunkCtrl.style.opacity=1; chunkCtrl.style.pointerEvents="auto"; document.querySelector('#chunkSeg button[data-c="1"]').style.display=""; setChunkUI(S.chunk); }
  if(!$("ribbon").classList.contains("hidden")) render();   // re-centre if currently showing
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
  document.querySelectorAll("#sizeSeg button").forEach(b=>b.classList.toggle("active",+b.dataset.s===s));
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
function setSettingsOpen(open){
  const wrap=$("moreWrap"), tg=$("settingsToggle");
  wrap.classList.toggle("open", open);
  tg.setAttribute("aria-expanded", open?"true":"false");
  if(open) wrap.removeAttribute("inert"); else wrap.setAttribute("inert","");
  settings.moreOpen = open;
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
  const url="https://rub3n-0lte4n.github.io/stillpoint/";
  const text=`I just finished “${S.title}” on Stillpoint — ${$("stWords").textContent} words in ${$("stTime").textContent}, at ${$("stWpm").textContent} wpm. A calm, private speed-reader that runs entirely in your browser.`;
  // Fold the link into the text and DON'T pass a separate `url` — when both are given,
  // most share targets keep only the url and drop the stats. One text block keeps both.
  const message=`${text} ${url}`;
  if(navigator.share){
    try{ await navigator.share({ title:"Stillpoint", text:message }); }
    catch(err){ if(!(err && err.name==="AbortError")){ try{ await navigator.clipboard.writeText(message); toast("Result copied — paste it anywhere to share."); }catch(e){} } }
    return;
  }
  try{ await navigator.clipboard.writeText(message); toast("Result copied — paste it anywhere to share."); }
  catch(e){ toast("Couldn't copy automatically — long-press to copy your result."); }
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
    openReader(toks,[{title:"Pasted text",start:0}],"Pasted text",`TEXT · ${toks.length.toLocaleString()} words`,key);
    persist(key,{kind:"text",text:txt});
  };
  const loadSample=()=>{ $("paste").value=DEMO; closeAbout(); $("paste").scrollIntoView({behavior:"smooth"}); $("paste").focus(); };
  $("demoBtn").onclick=()=>{ $("paste").value=DEMO; $("paste").focus(); };
  $("heroTry").onclick=loadSample;
  $("aboutTry").onclick=loadSample;

  // "How it works" — opens the explainer modal (was a dead # link)
  const about=$("about");
  const openAbout=()=>{ aboutReturn=document.activeElement; about.classList.add("show"); $("aboutClose").focus(); };
  $("aboutLink").onclick=(e)=>{ e.preventDefault(); openAbout(); };
  $("aboutClose").onclick=closeAbout;
  about.addEventListener("click",e=>{ if(e.target===about) closeAbout(); });

  // modal keyboard: Escape dismisses, Tab stays trapped inside the open dialog
  document.addEventListener("keydown",e=>{
    const aboutOpen=about.classList.contains("show"), doneOpen=$("done").classList.contains("show");
    if(!aboutOpen && !doneOpen) return;
    if(e.key==="Escape"){ e.preventDefault(); aboutOpen ? closeAbout() : requestHome(); }
    else if(e.key==="Tab"){ trapTab(aboutOpen ? about : $("done"), e); }
  });

  $("doneShare").onclick=shareResult;
  heroDemo();
  window.addEventListener("popstate",()=>{ if($("reader").classList.contains("show")) showLibrary(); });

  $("playBtn").onclick=toggle;
  $("backBtn").onclick=backSentence;
  $("fwdBtn").onclick=fwdSentence;
  $("homeBtn").onclick=requestHome;
  $("homeBtn").addEventListener("keydown",e=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); requestHome(); }});
  // tap the reading area to play/pause (large, mobile-friendly target)
  $("stage").addEventListener("click",()=>{ toggle(); Haptics.trigger("light"); });

  // Cmd/Ctrl+Enter begins reading straight from the paste box (lower friction than reaching for the button)
  $("paste").addEventListener("keydown",e=>{ if(e.key==="Enter" && (e.metaKey||e.ctrlKey)){ e.preventDefault(); $("pasteGo").click(); }});

  // session-complete screen
  $("doneAgain").onclick=()=>{ $("done").classList.remove("show"); S.index=0; S.readMs=0; play(); };
  $("doneLib").onclick=requestHome;

  // auto-pause when the tab/window is hidden so you don't lose your place
  document.addEventListener("visibilitychange",()=>{ if(document.hidden && S.playing) pause(); });

  document.querySelectorAll("#modeSeg button").forEach(b=>b.onclick=()=>setMode(b.dataset.mode));
  document.querySelectorAll("#chunkSeg button").forEach(b=>b.onclick=()=>{S.chunk=+b.dataset.c;setChunkUI(S.chunk); if(!$("ribbon").classList.contains("hidden")) render();});
  document.querySelectorAll("#sizeSeg button").forEach(b=>b.onclick=()=>setSize(+b.dataset.s));
  $("wpm").oninput=e=>setWpm(+e.target.value);

  // "Reading settings" disclosure for the secondary controls
  $("settingsToggle").onclick=()=>{ setSettingsOpen(!$("moreWrap").classList.contains("open")); Haptics.trigger("light"); };

  // reading-aid toggles (countdown / context line)
  document.querySelectorAll("#aidSeg button").forEach(b=>b.onclick=()=>{
    const k=b.dataset.aid; settings[k]=!settings[k]; applyAids();
    if(k==="context") $("ribbon").classList.toggle("no-ctx", !settings.context);
    Haptics.trigger("light");
  });

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
  // keyboard scrubbing when the progress bar has focus (arrows step ~2%, Home/End jump)
  track.addEventListener("keydown",e=>{
    const total=S.tokens.length-1; if(total<1) return;
    const step=Math.max(1, Math.round(total*0.02));
    let handled=true;
    if(e.code==="ArrowLeft"||e.code==="ArrowDown") jumpTo(S.index-step);
    else if(e.code==="ArrowRight"||e.code==="ArrowUp") jumpTo(S.index+step);
    else if(e.code==="Home") jumpTo(0);
    else if(e.code==="End") jumpTo(total);
    else handled=false;   // Space etc. falls through to play/pause
    if(handled){ e.preventDefault(); e.stopPropagation(); }
  });

  // keyboard
  document.addEventListener("keydown",e=>{
    if(!$("reader").classList.contains("show")) return;
    if($("done").classList.contains("show")||$("about").classList.contains("show")) return;  // a modal owns the keyboard
    const tag=e.target.tagName;
    if(tag==="TEXTAREA"||tag==="SELECT"||tag==="INPUT") return;   // don't hijack typing
    if(e.code==="Space"){
      if(tag==="BUTTON"||e.target.getAttribute("role")==="button") return;  // let a focused control activate itself
      e.preventDefault();toggle();
    }
    else if(e.code==="ArrowLeft"){e.preventDefault();backSentence();}
    else if(e.code==="ArrowRight"){e.preventDefault();fwdSentence();}
    else if(e.code==="ArrowUp"){e.preventDefault();setWpm(Math.min(800,S.wpm+25));}
    else if(e.code==="ArrowDown"){e.preventDefault();setWpm(Math.max(150,S.wpm-25));}
    else if(e.code==="Escape"){requestHome();}
  });

  // restore persisted prefs
  try{
    const prefs=JSON.parse(localStorage.getItem("fp_prefs")||"{}");
    if(prefs.wpm) setWpm(prefs.wpm); if(prefs.size) setSize(prefs.size);
    if(prefs.mode) setMode(prefs.mode);
    if(typeof prefs.countdown==="boolean") settings.countdown=prefs.countdown;
    if(typeof prefs.context==="boolean") settings.context=prefs.context;
    if(typeof prefs.moreOpen==="boolean") settings.moreOpen=prefs.moreOpen;
  }catch(e){}
  setSize(S.size); setWpm(S.wpm); applyAids(); setSettingsOpen(settings.moreOpen);

  renderLibrary();
  window.addEventListener("beforeunload",()=>{
    localStorage.setItem("fp_prefs",JSON.stringify({wpm:S.wpm,size:S.size,mode:S.mode,countdown:settings.countdown,context:settings.context,moreOpen:settings.moreOpen}));
  });
}

if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", init);
else init();

// Register the service worker so the app (and your already-opened library) works offline.
if("serviceWorker" in navigator){
  window.addEventListener("load", ()=>{
    navigator.serviceWorker.register("sw.js").catch(()=>{ /* offline mode unavailable; app still works online */ });
  });
}
