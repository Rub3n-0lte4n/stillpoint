// In-browser document parsers for PDF and EPUB. Both return {tokens, units, ...}.
// pdf.js and JSZip are loaded as global libraries (window.pdfjsLib / window.JSZip).
import { tokenize } from "./text.js";

const pdfjsLib = window.pdfjsLib;
const JSZip = window.JSZip;
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

/* ---------------- PDF ---------------- */
export async function parsePDF(file, onProgress = ()=>{}){
  const buf = await file.arrayBuffer();
  // isEvalSupported:false mitigates CVE-2024-4367 (arbitrary JS via crafted PDF font handling)
  const pdf = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
  const tokens = []; const units = [];
  for(let p=1; p<=pdf.numPages; p++){
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    let pageText = "", lastY = null;
    for(const it of content.items){
      if(lastY!==null && it.transform && Math.abs(it.transform[5]-lastY) > 2) pageText += " ";
      pageText += it.str + (it.hasEOL ? " " : "");
      if(it.transform) lastY = it.transform[5];
    }
    units.push({ title:`Page ${p}`, start: tokens.length });
    for(const t of tokenize(pageText)) tokens.push(t);
    onProgress(p / pdf.numPages);
    if(p % 5 === 0) await new Promise(r=>setTimeout(r)); // yield to keep UI responsive
  }
  if(tokens.length===0) throw new Error("This PDF has no extractable text (it may be scanned images).");
  return { tokens, units, pages: pdf.numPages };
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
// Parse the EPUB directly: container.xml -> OPF -> manifest + spine -> text per section.
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

  const tokens=[]; const units=[]; let chapters=0;
  for(let i=0;i<itemrefs.length;i++){
    const href = manifest[itemrefs[i].getAttribute("idref")];
    if(href){
      try{
        const entry = zipEntry(zip, resolveZipPath(opfDir, href));
        if(entry){
          const doc = xml.parseFromString(await entry.async("string"), "text/html");
          const body = doc.body || doc.documentElement;
          if(body && body.querySelectorAll) body.querySelectorAll("script,style").forEach(el=>el.remove());
          const toks = tokenize(body ? (body.textContent||"") : "");
          if(toks.length>3){
            chapters++;
            let title = `Chapter ${chapters}`;
            const h = body.querySelector && body.querySelector("h1,h2,h3,title");
            if(h && h.textContent.trim()) title = h.textContent.trim().replace(/\s+/g," ").slice(0,70);
            units.push({ title, start: tokens.length });
            for(const t of toks) tokens.push(t);
          }
        }
      }catch(e){ /* skip unreadable section */ }
    }
    onProgress((i+1) / Math.max(1, itemrefs.length));
    if(i % 4 === 0) await new Promise(r=>setTimeout(r));
  }
  if(tokens.length===0) throw new Error("Couldn't extract readable text from this EPUB. It may be image-only (scanned) or DRM-protected.");
  return { tokens, units, chapters };
}
