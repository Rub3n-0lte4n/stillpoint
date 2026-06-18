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
};
const $ = (id) => document.getElementById(id);
const PRESETS = [[250,"Comfortable"],[400,"Focus"],[550,"Fast"],[700,"Skim"]];

/* ---------------- rendering a frame ----------------
   Every mode anchors on a single pivot letter held dead-centre (grid: 1fr auto 1fr),
   so the word never shifts horizontally as its length changes. ORP/Hybrid colour the
   pivot; RSVP keeps it uncoloured but still position-locked. */
function renderFrame(){
  const wordEl = $("word"), rest = $("resting");
  if(S.index>=S.tokens.length){ stop(); return; }
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
}

/* ---------------- playback loop ---------------- */
function step(){
  renderFrame();
  const chunkTokens = S.tokens.slice(S.index, S.index+S.chunk);
  if(chunkTokens.length===0){ stop(); return; }

  const perWord = 60000 / S.wpm;
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
  S.playing = true;
  $("playIcon").innerHTML = '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>'; // pause icon
  step();
}
function pause(){
  S.playing=false;
  clearTimeout(S.timer);
  $("playIcon").innerHTML = '<path d="M8 5v14l11-7z"/>';
  saveProgress();
}
function stop(){ pause(); $("playIcon").innerHTML = '<path d="M8 5v14l11-7z"/>'; }
function toggle(){ S.playing ? pause() : play(); }

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
  $("tElapsed").textContent = fmt(S.index/S.wpm*60);
  $("tLeft").textContent = "-"+fmt((total-S.index)/S.wpm*60);
  if(S.units.length>1){
    let u=0; for(let k=0;k<S.units.length;k++){ if(S.units[k].start<=S.index) u=k; }
    if($("navSel").selectedIndex!==u) $("navSel").selectedIndex=u;
  }
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
    el.querySelector(".ri-x").onclick=(e)=>{ e.stopPropagation(); Store.del(item.key).catch(()=>{}); saveLib(loadLib().filter(x=>x.key!==item.key)); renderLibrary(); };
    list.appendChild(el);
  });
}

/* ---------------- loading a document ---------------- */
function openReader(tokens, units, title, meta, key){
  S.tokens=tokens; S.units=units&&units.length?units:[{title:"Start",start:0}];
  S.title=title; S.meta=meta; S.key=key; S.index=0;
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
  if(!rec){ alert("\""+item.title+"\" isn't stored on this device anymore. Open the file once and it'll be remembered."); return; }
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
  }catch(err){ hideParse(); alert("Couldn't reopen that file.\n"+(err&&err.message?err.message:err)); }
}
function goHome(){
  pause();
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
      hideParse(); alert("Please choose a PDF or EPUB file.");
    }
  }catch(err){
    console.error(err); hideParse();
    alert("Sorry — couldn't read that file.\n"+(err&&err.message?err.message:err));
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
    if(e.target.tagName==="TEXTAREA"||e.target.tagName==="SELECT") return;
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
