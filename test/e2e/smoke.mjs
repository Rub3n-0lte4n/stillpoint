#!/usr/bin/env node
// End-to-end smoke: drives the real app in headless Chrome over raw CDP.
// No test framework, no dependencies — Node 22+'s built-in WebSocket only.
//
//   npm run test:e2e                          serve the working tree and test it
//   BASE=https://stillpointreader.com npm run test:e2e     test the live site
//   CHROME=/path/to/chrome npm run test:e2e   pick a specific browser binary
//
// Covers what the unit suite can't: boot without console errors, the paste →
// reader → play flow, ORP pivot lock on the stage centre, the storage-full
// path (playback must survive a throwing localStorage), the durable-storage
// request, the global error toast, SW registration, and library resume.
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..");
const MIME = { ".html":"text/html", ".css":"text/css", ".js":"text/javascript", ".mjs":"text/javascript",
  ".json":"application/json", ".webmanifest":"application/manifest+json", ".png":"image/png",
  ".jpg":"image/jpeg", ".svg":"image/svg+xml", ".ico":"image/x-icon", ".txt":"text/plain", ".xml":"application/xml" };

let pass = 0, fail = 0;
const ok = (cond, name, detail = "") => {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗ FAIL:", name, detail ? `(${detail})` : ""); }
};

/* ---------- static server for the working tree (skipped when BASE is set) ---------- */
function serveTree() {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
      const file = join(ROOT, path === "/" ? "index.html" : path.slice(1));
      try {
        const body = readFileSync(file);
        res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
        res.end(body);
      } catch { res.writeHead(404); res.end("not found"); }
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

/* ---------- chrome ---------- */
function chromeBinary() {
  if (process.env.CHROME) return process.env.CHROME;
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(mac)) return mac;
  return "google-chrome"; // CI / linux
}
function launchChrome(profileDir) {
  const args = ["--headless=new", "--disable-gpu", "--window-size=1280,900", "--no-first-run",
    "--no-default-browser-check", `--user-data-dir=${profileDir}`, "--remote-debugging-port=0", "about:blank"];
  if (process.env.CI) args.unshift("--no-sandbox");
  const proc = spawn(chromeBinary(), args, { stdio: ["ignore", "ignore", "pipe"] });
  return new Promise((resolve, reject) => {
    let buf = "";
    proc.stderr.on("data", (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) resolve({ proc, wsUrl: m[1] });
    });
    proc.on("exit", () => reject(new Error("chrome exited before DevTools was ready:\n" + buf)));
    setTimeout(() => reject(new Error("timed out waiting for DevTools:\n" + buf)), 15000);
  });
}

/* ---------- minimal CDP client ---------- */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else for (const f of listeners) f(m);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({ send, on: (f) => listeners.push(f), close: () => ws.close() });
    ws.onerror = () => reject(new Error("could not connect to " + wsUrl));
  });
}

/* One attached page with console/error capture and eval helpers. */
async function openPage(cdp, injectSource) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const s = (method, params) => cdp.send(method, params, sessionId);
  await s("Page.enable"); await s("Runtime.enable"); await s("Log.enable");
  const consoleErrors = [], exceptions = [];
  const NOISE = /gc\.zgo\.at|goatcounter|fonts\.googleapis|fonts\.gstatic|vibrate/i;
  cdp.on((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      const text = m.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
      if (!NOISE.test(text)) consoleErrors.push(text);
    }
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error" && !NOISE.test(m.params.entry.text + (m.params.entry.url || "")))
      consoleErrors.push(m.params.entry.text);
    if (m.method === "Runtime.exceptionThrown")
      exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  if (injectSource) await s("Page.addScriptToEvaluateOnNewDocument", { source: injectSource });
  const evalIn = async (expression) => {
    const r = await s("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("eval failed: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };
  // In-page polling keeps waits tied to app state instead of guessed sleeps.
  const waitFor = (cond, ms = 10000) => evalIn(
    `(async()=>{const t0=Date.now();while(Date.now()-t0<${ms}){try{if(${cond})return true;}catch(e){}await new Promise(r=>setTimeout(r,80));}return false;})()`);
  const goto = async (url) => {
    const loaded = new Promise((res) => cdp.on((m) => { if (m.sessionId === sessionId && m.method === "Page.loadEventFired") res(); }));
    await s("Page.navigate", { url });
    await loaded;
  };
  return { goto, evalIn, waitFor, consoleErrors, exceptions, sessionId };
}

const PASSAGE = Array.from({ length: 20 }, (_, i) =>
  `Sentence ${i + 1} carries a handful of ordinary words toward a quiet full stop.`).join(" ");

/* ---------- the suite ---------- */
async function main() {
  const server = process.env.BASE ? null : await serveTree();
  const BASE = process.env.BASE || `http://127.0.0.1:${server.address().port}/`;
  console.log("target:", BASE);
  const profile = mkdtempSync(join(tmpdir(), "sp-e2e-"));
  const { proc, wsUrl } = await launchChrome(profile);
  const cdp = await connect(wsUrl);
  try {
    /* ----- flow A: clean profile ----- */
    console.log("\nflow A — boot, read, resume");
    const A = await openPage(cdp,
      // spy: record that the app asked for durable storage without touching real quota state
      `try{ navigator.storage.persist = () => { window.__persistCalled = true; return Promise.resolve(true); }; }catch(e){}`);
    await A.goto(BASE);
    ok(await A.waitFor(`document.getElementById("dropzone") !== null`), "landing renders");
    await A.evalIn(`document.getElementById("paste").value = ${JSON.stringify(PASSAGE)}; document.getElementById("pasteGo").click();`);
    ok(await A.waitFor(`document.getElementById("reader").classList.contains("show")`), "paste opens the reader");
    ok(await A.waitFor(`window.__persistCalled === true`), "durable storage requested on first kept book");
    await A.evalIn(`document.getElementById("playBtn").click();`);
    ok(await A.waitFor(`!document.getElementById("ribbon").classList.contains("hidden") && !!document.querySelector(".rw.on")`),
      "play streams words (after the countdown)");
    const drift = await A.evalIn(`(async()=>{
      const stage=document.getElementById("stage");
      let worst=0,got=0;
      for(let i=0;i<14 && got<4;i++){
        const p=document.querySelector(".rw.pivot .rpiv");
        if(p){const r=p.getBoundingClientRect();
          if(r.width){const s=stage.getBoundingClientRect();
            worst=Math.max(worst,Math.abs((r.left+r.width/2)-(s.left+s.width/2))); got++;}}
        await new Promise(r=>setTimeout(r,160));
      }
      return got>=3?worst:-1;})()`);
    ok(drift >= 0 && drift < 0.5, "ORP pivot locked to stage centre", `drift ${drift}px`);
    const i1 = await A.evalIn(`+((document.querySelector(".rw.on")||{}).dataset||{}).i || 0`);
    await new Promise((r) => setTimeout(r, 700));
    const i2 = await A.evalIn(`+((document.querySelector(".rw.on")||{}).dataset||{}).i || 0`);
    ok(i2 > i1, "the stream advances", `${i1} -> ${i2}`);
    await A.evalIn(`document.getElementById("playBtn").click();`);
    ok(await A.waitFor(`document.getElementById("playBtn").getAttribute("aria-label")==="Play"`), "pause returns the transport to Play");
    // chunk modes centre the phrase as an optical block; measure it paused, per mode
    const blockDrift = (mode, chunk) => A.evalIn(`(async()=>{
      document.querySelector('#modeSeg button[data-mode="${mode}"]').click();
      const cb=document.querySelector('#chunkSeg button[data-c="${chunk}"]'); if(cb) cb.click();
      await new Promise(r=>setTimeout(r,150));
      const els=[...document.querySelectorAll(".rw.on")];
      if(!els.length) return -1;
      const lo=Math.min(...els.map(e=>e.getBoundingClientRect().left));
      const hi=Math.max(...els.map(e=>e.getBoundingClientRect().right));
      const s=document.getElementById("stage").getBoundingClientRect();
      return Math.abs((lo+hi)/2-(s.left+s.width/2));})()`);
    const dRsvp = await blockDrift("rsvp", 3);
    ok(dRsvp >= 0 && dRsvp < 0.6, "RSVP phrase centred as a block", `drift ${dRsvp}px`);
    const dHyb = await blockDrift("hybrid", 3);
    ok(dHyb >= 0 && dHyb < 0.6, "Hybrid phrase centred with its bold anchors", `drift ${dHyb}px`);
    await A.evalIn(`document.querySelector('#modeSeg button[data-mode="orp"]').click(); true`);
    await A.evalIn(`setTimeout(()=>{ throw new Error("e2e-probe"); }, 0); true`);
    ok(await A.waitFor(`[...document.querySelectorAll(".toast.err")].some(t=>t.textContent.includes("Something went wrong"))`),
      "an uncaught error surfaces the last-resort toast");
    ok(await A.waitFor(`navigator.serviceWorker.getRegistration().then(r=>!!r)`, 12000), "service worker registered");
    await A.goto(BASE);
    ok(await A.waitFor(`document.querySelectorAll("#recentList .recent-item").length >= 1`), "library remembers the session after reload");
    // this reloaded page is SW-controlled, so a controller change means "newer
    // version took over" — simulate it and expect the reload offer
    await A.waitFor(`!!navigator.serviceWorker.controller`, 12000);
    await A.evalIn(`navigator.serviceWorker.dispatchEvent(new Event("controllerchange")); true`);
    ok(await A.waitFor(`[...document.querySelectorAll(".toast")].some(t=>t.textContent.includes("newer Stillpoint"))`),
      "a new service worker taking over offers a reload");
    ok(A.consoleErrors.length === 0, "no console errors in flow A", A.consoleErrors.join(" | ").slice(0, 300));

    /* ----- flow B: localStorage full on the hot path ----- */
    console.log("\nflow B — playback survives a full localStorage");
    const B = await openPage(cdp,
      `(()=>{ const orig = Storage.prototype.setItem;
         Storage.prototype.setItem = function(k){ if(k==="fp_library_v1"){ const e=new Error("quota (e2e)"); e.name="QuotaExceededError"; throw e; } return orig.apply(this, arguments); }; })();`);
    await B.goto(BASE);
    await B.waitFor(`document.getElementById("dropzone") !== null`);
    await B.evalIn(`document.getElementById("paste").value = ${JSON.stringify(PASSAGE)}; document.getElementById("pasteGo").click();`);
    ok(await B.waitFor(`document.getElementById("reader").classList.contains("show")`), "reader still opens");
    ok(await B.waitFor(`[...document.querySelectorAll(".toast.err")].some(t=>t.textContent.includes("can't be saved"))`),
      "storage failure is said out loud, once");
    await B.evalIn(`document.getElementById("playBtn").click();`);
    ok(await B.waitFor(`!!document.querySelector(".rw.on")`), "play still streams");
    const b1 = await B.evalIn(`+((document.querySelector(".rw.on")||{}).dataset||{}).i || 0`);
    await new Promise((r) => setTimeout(r, 900));
    const b2 = await B.evalIn(`+((document.querySelector(".rw.on")||{}).dataset||{}).i || 0`);
    ok(b2 > b1, "the stream keeps advancing past the throwing save", `${b1} -> ${b2}`);
    ok(B.exceptions.length === 0, "no uncaught exceptions with storage full", B.exceptions.join(" | ").slice(0, 300));

    /* ----- flow C: the phone reading field -----
       A centred pivot spends only ~40% of a narrow screen on the side a word
       actually grows into, so ordinary words used to run off the edge and get
       eaten by the fade. These are the invariants that must hold instead: no
       focal letter leaves the field, the pivot sits on --axis-x, picking a larger
       size never renders smaller type, and the type NEVER changes size while you
       read — the size belongs to the document, not to the ribbon window that
       happens to be on screen. */
    console.log("\nflow C — phone field: no ink escapes, the pivot rides the axis");
    const C = await openPage(cdp);
    const setViewport = (w, h) => cdp.send("Emulation.setDeviceMetricsOverride",
      { width: w, height: h, deviceScaleFactor: 2, mobile: true }, C.sessionId);
    // Ordinary English, and DELIBERATELY VARIED: one sentence on repeat gives every
    // ribbon window the same words, so a per-window size looks perfectly stable and
    // the defect hides. Real prose mixes long words with short ones.
    const LONG = "The development of an extraordinary idea rarely announces itself. "
      + "It arrives sideways, disguised as an inconvenience, and the responsibilities "
      + "that follow are unquestionably heavier than anyone anticipated. Between the "
      + "intention and the implementation there is a distance that no amount of "
      + "enthusiasm can shorten. Comprehension is not acceleration. A reader who "
      + "understands nothing quickly has merely wasted time faster. ";
    for (const [w, h] of [[320, 720], [390, 844], [430, 932], [844, 390]]) {
      await setViewport(w, h);
      await C.goto(BASE);
      ok(await C.waitFor(`document.getElementById("dropzone") !== null`), `${w}x${h} landing renders`);
      await C.evalIn(`document.fonts.ready.then(()=>true)`);
      await C.evalIn(`document.getElementById("paste").value = ${JSON.stringify(LONG.repeat(4))}; document.getElementById("pasteGo").click();`);
      await C.waitFor(`document.getElementById("reader").classList.contains("show")`);
      await C.evalIn(`document.getElementById("playBtn").click();`);
      await C.waitFor(`!!document.querySelector(".rw.on")`);
      await C.evalIn(`document.getElementById("playBtn").click(); true`);
      await C.waitFor(`document.getElementById("playBtn").getAttribute("aria-label")==="Play"`);

      for (const mode of ["orp", "rsvp", "hybrid"]) {
        const r = await C.evalIn(`(async()=>{
          document.querySelector('#modeSeg button[data-mode="${mode}"]').click();
          const out = { worstOverflow: -1e9, worstAxis: 0, sizes: {}, monotonic: true, sizeSteps: 0 };
          for(const s of [44,62,82,104]){
            document.querySelector('#sizeSeg button[data-s="'+s+'"]').click();
            await new Promise(r=>setTimeout(r,90));
            let seen = 0;
            // far enough to cross several ribbon rebuilds (the window is 19 words),
            // which is the only way a per-window size change can be observed
            for(let step=0; step<48; step++){
              const stage=document.getElementById("stage");
              const sr=stage.getBoundingClientRect();
              const marked=[...document.querySelectorAll(".rw.on")];
              if(!marked.length) break;
              // ink extents of the marked chunk, from the letter spans only —
              // the .rw padding is whitespace and may hang off the field
              let lo=Infinity, hi=-Infinity;
              for(const el of marked){
                for(const sp of el.children){
                  const b=sp.getBoundingClientRect();
                  if(!b.width) continue;
                  if(b.left<lo) lo=b.left;
                  if(b.right>hi) hi=b.right;
                }
              }
              if(hi>lo){
                out.worstOverflow = Math.max(out.worstOverflow, sr.left-lo, hi-sr.right);
                const px = parseFloat(getComputedStyle(document.getElementById("ribbon")).fontSize);
                // the type must not change size mid-document
                if(seen && Math.abs(px-seen) > 0.01) out.sizeSteps++;
                seen = px;
              }
              if("${mode}"==="orp"){
                const p=document.querySelector(".rw.pivot .rpiv");
                if(p){
                  const b=p.getBoundingClientRect();
                  const frac=parseFloat(getComputedStyle(stage).getPropertyValue("--axis-x"))/100;
                  const axis=sr.left + sr.width*(isFinite(frac)?frac:0.5);
                  out.worstAxis = Math.max(out.worstAxis, Math.abs((b.left+b.width/2)-axis));
                }
              }
              document.getElementById("fwdBtn").click();
              await new Promise(r=>setTimeout(r,60));
            }
            out.sizes[s]=seen;
          }
          const ladder=[44,62,82,104].map(s=>out.sizes[s]);
          for(let i=1;i<ladder.length;i++) if(ladder[i] < ladder[i-1]-0.01) out.monotonic=false;
          return out;})()`);
        ok(r.worstOverflow <= 1.0, `${w}x${h} ${mode}: focal ink stays in the field`,
          `worst overflow ${r.worstOverflow.toFixed(1)}px`);
        if (mode === "orp")
          ok(r.worstAxis < 0.6, `${w}x${h} orp: the pivot rides the axis`, `drift ${r.worstAxis.toFixed(2)}px`);
        ok(r.monotonic, `${w}x${h} ${mode}: a larger size never renders smaller`, JSON.stringify(r.sizes));
        ok(r.sizeSteps === 0, `${w}x${h} ${mode}: the type never resizes mid-document`,
          `${r.sizeSteps} size change(s) while reading`);
      }
    }
    ok(C.consoleErrors.length === 0, "no console errors in flow C", C.consoleErrors.join(" | ").slice(0, 300));
  } finally {
    cdp.close(); proc.kill();
    if (server) server.close();
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }
  console.log(`\nE2E smoke: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

const watchdog = setTimeout(() => { console.error("E2E watchdog: run exceeded 300s"); process.exit(1); }, 300000);
watchdog.unref();
main().catch((err) => { console.error(err); process.exit(1); });
