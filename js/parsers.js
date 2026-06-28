// In-browser document parsers for PDF and EPUB. Both return {tokens, units, blocks, ...}.
// pdf.js and JSZip are loaded as global libraries (window.pdfjsLib / window.JSZip).
//
// `blocks` is a sidecar array of non-linear content (tables, images, figures,
// quotes, code) captured in place so the reader (Phase 2) can present it instead
// of streaming it as loose prose. Each block:
//   { id, after, kind, payload, unit }
// `after` = the token index the block follows (monotonic non-decreasing).
// Plain prose documents yield blocks === [] and a tokens/units stream identical
// to the pre-block build. Image/HTML payloads are session-memory only — never
// persisted (Phase 2+ references blocks by id/after, not by carrying pixels).
import { tokenize } from "./text.js";

const pdfjsLib = window.pdfjsLib;
const JSZip = window.JSZip;
// Vendored worker (same version) — keeps PDF parsing working offline.
pdfjsLib.GlobalWorkerOptions.workerSrc = "js/vendor/pdf.worker.min.js";

// EPUB tag → block kind. Only these elements are captured as blocks; everything
// else descends normally and its text becomes tokens as before.
const EPUB_BLOCK_KIND = { table:"table", img:"image", figure:"figure", blockquote:"quote", pre:"code" };

/* ---------------- shared helpers ---------------- */

// Strip script/style, on* handlers, and javascript: URLs from captured EPUB markup
// before it is ever stored. Operates on a clone so the live DOM is untouched.
// Exported for tests.
export function sanitizeHTML(el){
  const clone = el.cloneNode(true);
  if(clone.querySelectorAll) clone.querySelectorAll("script,style").forEach(n=>n.remove());
  const nodes = clone.querySelectorAll ? [clone, ...clone.querySelectorAll("*")] : [clone];
  for(const node of nodes){
    if(!node.attributes) continue;
    for(const attr of Array.from(node.attributes)){
      const name = attr.name.toLowerCase();
      const val = (attr.value||"").trim().toLowerCase();
      if(name.startsWith("on")) node.removeAttribute(attr.name);
      else if((name==="href"||name==="src"||name==="xlink:href") && val.startsWith("javascript:")) node.removeAttribute(attr.name);
    }
  }
  return clone.outerHTML;
}

/* ---------------- PDF ---------------- */
export async function parsePDF(file, onProgress = ()=>{}){
  const buf = await file.arrayBuffer();
  // isEvalSupported:false mitigates CVE-2024-4367 (arbitrary JS via crafted PDF font handling)
  const pdf = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
  const tokens = []; const units = []; const blocks = [];
  for(let p=1; p<=pdf.numPages; p++){
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    let pageText = "", lastY = null;
    for(const it of content.items){
      if(lastY!==null && it.transform && Math.abs(it.transform[5]-lastY) > 2) pageText += " ";
      pageText += it.str + (it.hasEOL ? " " : "");
      if(it.transform) lastY = it.transform[5];
    }
    const unitIndex = units.length;
    units.push({ title:`Page ${p}`, start: tokens.length });
    for(const t of tokenize(pageText)) tokens.push(t);
    // Non-linear content: image XObjects + heuristic table regions, rendered to
    // snapshots. Wrapped so any rendering/transform failure never breaks reading.
    try{
      const pageBlocks = await extractPdfBlocks(page, content);
      for(const b of pageBlocks){
        blocks.push({ id:`blk-${blocks.length}`, after: tokens.length, kind: b.kind, payload: b.payload, unit: unitIndex });
      }
    }catch(e){ /* snapshot extraction failed — prose tokens already captured, read on */ }
    onProgress(p / pdf.numPages);
    if(p % 5 === 0) await new Promise(r=>setTimeout(r)); // yield to keep UI responsive
  }
  if(tokens.length===0) throw new Error("This PDF has no extractable text (it may be scanned images).");
  return { tokens, units, blocks, pages: pdf.numPages };
}

// Multiply two 6-element affine matrices [a,b,c,d,e,f] (pdf.js Util order).
function matMul(m1, m2){
  return [
    m1[0]*m2[0] + m1[2]*m2[1],
    m1[1]*m2[0] + m1[3]*m2[1],
    m1[0]*m2[2] + m1[2]*m2[3],
    m1[1]*m2[2] + m1[3]*m2[3],
    m1[0]*m2[4] + m1[2]*m2[5] + m1[4],
    m1[1]*m2[4] + m1[3]*m2[5] + m1[5],
  ];
}

// Render a PDF-user-space bbox {x0,y0,x1,y1} to a cropped PNG snapshot.
// Renders the page once at `scale`, then crops the region — robust against the
// transform fiddliness of per-image clipping.
async function snapshotRegion(page, bbox, scale, pageCanvasCache){
  let pc = pageCanvasCache.canvas;
  if(!pc){
    const vp = page.getViewport({ scale });
    pc = document.createElement("canvas");
    pc.width = Math.ceil(vp.width); pc.height = Math.ceil(vp.height);
    await page.render({ canvasContext: pc.getContext("2d"), viewport: vp }).promise;
    pageCanvasCache.canvas = pc; pageCanvasCache.viewport = vp;
  }
  const vp = pageCanvasCache.viewport;
  // Map PDF-space corners to viewport (device) pixels.
  const [vx0, vy0] = vp.convertToViewportPoint(bbox.x0, bbox.y0);
  const [vx1, vy1] = vp.convertToViewportPoint(bbox.x1, bbox.y1);
  const dx = Math.max(0, Math.min(vx0, vx1)), dy = Math.max(0, Math.min(vy0, vy1));
  const dw = Math.min(pc.width - dx, Math.abs(vx1 - vx0)), dh = Math.min(pc.height - dy, Math.abs(vy1 - vy0));
  if(dw < 4 || dh < 4) return null; // too small to be meaningful
  const crop = document.createElement("canvas");
  crop.width = Math.ceil(dw); crop.height = Math.ceil(dh);
  crop.getContext("2d").drawImage(pc, dx, dy, dw, dh, 0, 0, crop.width, crop.height);
  return { type:"image", dataUrl: crop.toDataURL("image/png"), width: crop.width, height: crop.height, alt:"" };
}

// Detect image XObjects (via operator list) and table-like text regions on a page,
// returning [{kind, payload}] snapshots. Precision-favoured for tables.
async function extractPdfBlocks(page, content){
  const out = [];
  const scale = 2;
  const cache = {};
  const OPS = pdfjsLib.OPS;

  // --- image XObjects: walk ops tracking the current transform matrix ---
  try{
    const opList = await page.getOperatorList();
    let ctm = [1,0,0,1,0,0];
    const stack = [];
    for(let i=0;i<opList.fnArray.length;i++){
      const fn = opList.fnArray[i], args = opList.argsArray[i];
      if(fn === OPS.save) stack.push(ctm.slice());
      else if(fn === OPS.restore){ if(stack.length) ctm = stack.pop(); }
      else if(fn === OPS.transform) ctm = matMul(ctm, args);
      else if(fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject){
        // The image occupies the unit square under the current matrix.
        const xs = [ctm[4], ctm[2]+ctm[4]];           // x of (0,0) and (0,1)/(1,0) combos
        const ys = [ctm[5], ctm[3]+ctm[5]];
        const cx = [ctm[4], ctm[0]+ctm[4], ctm[2]+ctm[4], ctm[0]+ctm[2]+ctm[4]];
        const cy = [ctm[5], ctm[1]+ctm[5], ctm[3]+ctm[5], ctm[1]+ctm[3]+ctm[5]];
        const bbox = { x0: Math.min(...cx), y0: Math.min(...cy), x1: Math.max(...cx), y1: Math.max(...cy) };
        if((bbox.x1-bbox.x0) > 24 && (bbox.y1-bbox.y0) > 24){
          const payload = await snapshotRegion(page, bbox, scale, cache);
          if(payload) out.push({ kind:"image", payload });
        }
      }
    }
  }catch(e){ /* operator list unavailable — skip images, keep table detection */ }

  // --- table-like regions: group text items into rows, look for aligned columns ---
  try{
    const region = detectTableRegion(content.items);
    if(region){
      const payload = await snapshotRegion(page, region, scale, cache);
      if(payload) out.push({ kind:"table", payload });
    }
  }catch(e){ /* detection failed — table text remains in tokens as fallback */ }

  return out;
}

// Heuristic: find a band of >=3 consecutive rows whose short items share >=2
// column x-positions. Returns a PDF-space bbox or null. Precision-favoured.
// Exported for tests.
export function detectTableRegion(items){
  const rows = new Map(); // quantized baseline Y → items
  for(const it of items){
    if(!it.transform || !it.str || !it.str.trim()) continue;
    const y = Math.round(it.transform[5] / 3) * 3;
    if(!rows.has(y)) rows.set(y, []);
    rows.get(y).push(it);
  }
  const ys = [...rows.keys()].sort((a,b)=>b-a); // top→bottom (PDF y descends downward)
  let best = null, run = [];
  const colKey = it => Math.round(it.transform[4] / 12) * 12;
  for(const y of ys){
    const its = rows.get(y);
    const shortMulti = its.length >= 2 && its.every(i => i.str.trim().length <= 24);
    if(shortMulti){ run.push(y); }
    else { if(run.length >= 3 && (!best || run.length > best.length)) best = run; run = []; }
  }
  if(run.length >= 3 && (!best || run.length > best.length)) best = run;
  if(!best) return null;
  // Require >=2 shared columns across the run.
  const cols = new Map();
  let members = [];
  for(const y of best){ for(const it of rows.get(y)){ members.push(it); cols.set(colKey(it), (cols.get(colKey(it))||0)+1); } }
  const sharedCols = [...cols.values()].filter(c => c >= best.length - 1).length;
  if(sharedCols < 2) return null;
  // bbox from member item boxes (item box ~ transform[4..5] + width/height).
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for(const it of members){
    const ix = it.transform[4], iy = it.transform[5];
    const iw = it.width || 0, ih = it.height || (Math.abs(it.transform[3]) || 10);
    x0 = Math.min(x0, ix); y0 = Math.min(y0, iy - ih); x1 = Math.max(x1, ix + iw); y1 = Math.max(y1, iy + ih);
  }
  if(!isFinite(x0)) return null;
  return { x0, y0, x1, y1 };
}

/* ---------------- EPUB ---------------- */
// Resolve a manifest href (relative to the OPF's folder) to a zip path, handling ../ and %20.
function resolveZipPath(baseDir, href){
  href = decodeURIComponent(href.split("#")[0]);
  if(href.startsWith("/")) return href.slice(1);
  const stack = baseDir ? baseDir.split("/").filter(Boolean) : [];
  for(const part of href.split("/")){
    if(part==="..") stack.pop();
    else if(part==="."||part==="") {}
    else stack.push(part);
  }
  return stack.join("/");
}
// Look up a zip entry, tolerant of case / odd path encodings.
function zipEntry(zip, p){
  let f = zip.file(p); if(f) return f;
  const names = Object.keys(zip.files);
  const want = p.toLowerCase();
  let hit = names.find(n=>n.toLowerCase()===want); if(hit) return zip.file(hit);
  const base = p.split("/").pop().toLowerCase();
  hit = names.find(n=>n.toLowerCase().endsWith("/"+base)); return hit ? zip.file(hit) : null;
}

// Decode an EPUB image href (relative to a section's directory) to an object URL.
async function resolveEpubImage(zip, sectionDir, src){
  if(!src) return null;
  const entry = zipEntry(zip, resolveZipPath(sectionDir, src));
  if(!entry) return null;
  const blob = await entry.async("blob");
  return URL.createObjectURL(blob);
}

// In-order DOM walk of an EPUB section body. Accumulates prose into a buffer
// (flushed at block boundaries) so plain prose tokenizes identically to the old
// body.textContent path; captured block elements become block descriptors.
// Exported for tests.
export async function walkSection(body, ctx){
  const sTokens = [];          // section-local tokens
  const sBlocks = [];          // section-local { kind, payload, after }
  let buffer = "";
  const flush = ()=>{ if(buffer.trim()){ for(const t of tokenize(buffer)) sTokens.push(t); } buffer=""; };

  async function walk(node){
    for(const child of node.childNodes){
      if(child.nodeType === 3){ buffer += child.textContent; continue; }
      if(child.nodeType !== 1) continue;
      const tag = (child.tagName||"").toLowerCase();
      if(tag === "script" || tag === "style") continue;
      const kind = EPUB_BLOCK_KIND[tag];
      if(kind){
        flush();
        const payload = await buildEpubPayload(tag, child, ctx);
        if(payload) sBlocks.push({ kind, payload, after: sTokens.length });
        continue; // captured element — do not descend
      }
      await walk(child);
    }
  }
  await walk(body);
  flush();
  return { sTokens, sBlocks };
}

// Build a block payload for an EPUB element. Images → blobUrl; html blocks →
// sanitized markup with inline images resolved so figures render offline.
async function buildEpubPayload(tag, el, ctx){
  if(tag === "img"){
    const src = el.getAttribute("src") || el.getAttributeNS && el.getAttributeNS("http://www.w3.org/1999/xlink","href") || el.getAttribute("xlink:href");
    const blobUrl = await resolveEpubImage(ctx.zip, ctx.sectionDir, src);
    if(!blobUrl) return null;
    return { type:"image", blobUrl, alt: el.getAttribute("alt") || "" };
  }
  // table | figure | blockquote | pre — resolve inline images, then sanitize.
  const clone = el.cloneNode(true);
  if(clone.querySelectorAll){
    for(const img of clone.querySelectorAll("img")){
      const blobUrl = await resolveEpubImage(ctx.zip, ctx.sectionDir, img.getAttribute("src"));
      if(blobUrl) img.setAttribute("src", blobUrl);
    }
  }
  return { type:"html", html: sanitizeHTML(clone) };
}

// Parse the EPUB directly: container.xml -> OPF -> manifest + spine -> blocks+text per section.
// (Direct parsing handles varied folder layouts more reliably than epub.js section loading.)
export async function parseEPUB(file, onProgress = ()=>{}){
  const buf = await file.arrayBuffer();
  let zip;
  try{ zip = await JSZip.loadAsync(buf); }
  catch(e){ throw new Error("This file isn't a valid EPUB archive (it may be corrupted)."); }
  const xml = new DOMParser();

  const containerEntry = zipEntry(zip, "META-INF/container.xml");
  if(!containerEntry) throw new Error("Not a valid EPUB — missing META-INF/container.xml.");
  const containerDoc = xml.parseFromString(await containerEntry.async("string"), "application/xml");
  const rootfile = containerDoc.getElementsByTagNameNS("*","rootfile")[0];
  const opfPath = rootfile && rootfile.getAttribute("full-path");
  if(!opfPath) throw new Error("Couldn't locate the EPUB package file.");

  const opfEntry = zipEntry(zip, decodeURIComponent(opfPath));
  if(!opfEntry) throw new Error("The EPUB package file is missing.");
  const opfDoc = xml.parseFromString(await opfEntry.async("string"), "application/xml");
  const opfDir = opfPath.includes("/") ? opfPath.replace(/\/[^/]*$/, "/") : "";

  const manifest = {};
  Array.from(opfDoc.getElementsByTagNameNS("*","item")).forEach(it=>{
    const id=it.getAttribute("id"), href=it.getAttribute("href");
    if(id && href) manifest[id]=href;
  });
  const itemrefs = Array.from(opfDoc.getElementsByTagNameNS("*","itemref"));

  const tokens=[]; const units=[]; const blocks=[]; let chapters=0;
  for(let i=0;i<itemrefs.length;i++){
    const href = manifest[itemrefs[i].getAttribute("idref")];
    if(href){
      try{
        const sectionPath = resolveZipPath(opfDir, href);
        const entry = zipEntry(zip, sectionPath);
        if(entry){
          const doc = xml.parseFromString(await entry.async("string"), "text/html");
          const body = doc.body || doc.documentElement;
          if(body && body.querySelectorAll) body.querySelectorAll("script,style").forEach(el=>el.remove());
          const sectionDir = sectionPath.includes("/") ? sectionPath.replace(/\/[^/]*$/, "") : "";
          const { sTokens, sBlocks } = body
            ? await walkSection(body, { zip, sectionDir })
            : { sTokens:[], sBlocks:[] };
          if(sTokens.length>3){
            chapters++;
            let title = `Chapter ${chapters}`;
            const h = body.querySelector && body.querySelector("h1,h2,h3,title");
            if(h && h.textContent.trim()) title = h.textContent.trim().replace(/\s+/g," ").slice(0,70);
            const unitIndex = units.length;
            const offset = tokens.length;
            units.push({ title, start: offset });
            for(const t of sTokens) tokens.push(t);
            for(const b of sBlocks){
              blocks.push({ id:`blk-${blocks.length}`, after: offset + b.after, kind: b.kind, payload: b.payload, unit: unitIndex });
            }
          }
        }
      }catch(e){ /* skip unreadable section */ }
    }
    onProgress((i+1) / Math.max(1, itemrefs.length));
    if(i % 4 === 0) await new Promise(r=>setTimeout(r));
  }
  if(tokens.length===0) throw new Error("Couldn't extract readable text from this EPUB. It may be image-only (scanned) or DRM-protected.");
  return { tokens, units, blocks, chapters };
}
