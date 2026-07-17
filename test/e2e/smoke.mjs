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
  return { goto, evalIn, waitFor, consoleErrors, exceptions };
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
    await A.evalIn(`setTimeout(()=>{ throw new Error("e2e-probe"); }, 0); true`);
    ok(await A.waitFor(`[...document.querySelectorAll(".toast.err")].some(t=>t.textContent.includes("Something went wrong"))`),
      "an uncaught error surfaces the last-resort toast");
    ok(await A.waitFor(`navigator.serviceWorker.getRegistration().then(r=>!!r)`, 12000), "service worker registered");
    await A.goto(BASE);
    ok(await A.waitFor(`document.querySelectorAll("#recentList .recent-item").length >= 1`), "library remembers the session after reload");
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
  } finally {
    cdp.close(); proc.kill();
    if (server) server.close();
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }
  console.log(`\nE2E smoke: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

const watchdog = setTimeout(() => { console.error("E2E watchdog: run exceeded 120s"); process.exit(1); }, 120000);
watchdog.unref();
main().catch((err) => { console.error(err); process.exit(1); });
