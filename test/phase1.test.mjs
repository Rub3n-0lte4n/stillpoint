// Phase 1 verification — EPUB block walk + sanitization + PDF table heuristic.
// Dev-only (linkedom + jszip). The shipped app stays no-build.
//   node test/phase1.test.mjs
import { DOMParser } from "linkedom";

// Stub the browser globals parsers.js touches at import time / runtime.
globalThis.window = { pdfjsLib: { GlobalWorkerOptions: {} }, JSZip: {} };
globalThis.DOMParser = DOMParser;
globalThis.URL = globalThis.URL || {};
globalThis.URL.createObjectURL = () => "blob:fake/" + Math.random().toString(36).slice(2);

const { walkSection, sanitizeHTML, detectTableRegion } = await import("../js/parsers.js");

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log("  ✗ FAIL:", msg); } };

/* ---------- EPUB in-order walk ---------- */
const html = `<!doctype html><html><body>
  <h1>Chapter One</h1>
  <p>Hello brave new world of reading.</p>
  <table><tr><th>Region</th><th>Q1</th></tr><tr><td>EMEA</td><td>12</td></tr></table>
  <p>After the table we continue reading onward.</p>
  <figure><img src="img/fig1.png" alt="A figure"/><figcaption>Figure one caption</figcaption></figure>
  <p>Final paragraph here with several words indeed.</p>
  <img src="img/standalone.png" alt="standalone"/>
  <blockquote onclick="alert(1)">Quoted wisdom <script>steal()</script> here.</blockquote>
  <pre>code block text</pre>
</body></html>`;
const doc = new DOMParser().parseFromString(html, "text/html");
const body = doc.body || doc.documentElement;
const zip = { file: () => ({ async: async () => ({}) }), files: {} };
const { sTokens, sBlocks } = await walkSection(body, { zip, sectionDir: "OEBPS" });

const words = sTokens.map(t => t.w);
// Prose preserved, in order; block-only content excluded.
ok(words.includes("Chapter") && words.includes("world") && words.includes("indeed."), "prose tokens present");
ok(words.indexOf("Chapter") < words.indexOf("onward.") && words.indexOf("onward.") < words.indexOf("indeed."), "prose tokens in document order");
ok(!words.includes("Region") && !words.includes("EMEA"), "table cell text not streamed as prose");
ok(!words.includes("Quoted") && !words.includes("here."), "blockquote text not streamed as prose");
ok(!words.includes("caption") && !words.some(w => w.includes("caption")), "figcaption text not streamed as prose");

const kinds = sBlocks.map(b => b.kind);
ok(JSON.stringify(kinds) === JSON.stringify(["table", "figure", "image", "quote", "code"]),
   "block kinds in order: " + JSON.stringify(kinds));

const table = sBlocks.find(b => b.kind === "table");
ok(table && table.payload.type === "html", "table payload is html");
ok(table && !/<script/i.test(table.payload.html), "table html sanitized: no <script>");

const quote = sBlocks.find(b => b.kind === "quote");
ok(quote && !/onclick/i.test(quote.payload.html) && !/<script/i.test(quote.payload.html),
   "blockquote sanitized: no onclick / no <script>");

const img = sBlocks.find(b => b.kind === "image");
ok(img && img.payload.type === "image" && typeof img.payload.blobUrl === "string" && img.payload.blobUrl.length > 0,
   "image payload has blobUrl");
ok(img && img.payload.alt === "standalone", "image alt carried through");

// after monotonic non-decreasing and within token range
let mono = true; for (let i = 1; i < sBlocks.length; i++) if (sBlocks[i].after < sBlocks[i-1].after) mono = false;
ok(mono, "block.after monotonic non-decreasing");
ok(sBlocks.every(b => b.after >= 0 && b.after <= sTokens.length), "block.after within [0, tokens.length]");

/* ---------- minified EPUB: block boundaries must separate words ---------- */
// Calibre-style sources put no whitespace between tags; block-level boundaries
// must read as a space, while inline tags must never split a word.
const packed = `<!doctype html><html><body><div><h2>The Old Tree</h2><br/><p>Although late.</p><p>It rang.</p><ul><li>first</li><li>second</li></ul><p>Mu<span>sa</span>shi <i>wal</i>ks on.</p></div></body></html>`;
const pbody = new DOMParser().parseFromString(packed, "text/html").body;
const packedWalk = await walkSection(pbody, { zip, sectionDir: "OEBPS" });
const pw = packedWalk.sTokens.map(t => t.w);
ok(pw.includes("Tree") && pw.includes("Although"), "h2/br/p boundary splits words: " + JSON.stringify(pw));
ok(pw.includes("late.") && pw.includes("It"), "p/p boundary splits words");
ok(pw.includes("first") && pw.includes("second"), "li/li boundary splits words");
ok(pw.includes("Musashi") && pw.includes("walks"), "inline span/i do NOT split words: " + JSON.stringify(pw.slice(-4)));

/* ---------- sanitizeHTML direct ---------- */
const dirty = new DOMParser().parseFromString(
  `<!doctype html><html><body><div id="d"><a href="javascript:evil()">x</a><b onmouseover="hack()">y</b><style>i{}</style></div></body></html>`, "text/html");
const clean = sanitizeHTML(dirty.querySelector("#d"));
ok(!/javascript:/i.test(clean), "sanitize strips javascript: URLs");
ok(!/onmouseover/i.test(clean), "sanitize strips on* handlers");
ok(!/<style/i.test(clean), "sanitize strips <style>");

/* ---------- PDF table heuristic ---------- */
const grid = [];
for (const y of [300, 288, 276]) for (const x of [50, 150]) grid.push({ str: "ab", transform: [1,0,0,1,x,y], width: 20, height: 10 });
ok(detectTableRegion(grid) !== null, "detectTableRegion fires on a 3x2 aligned grid");

const prose = [];
for (let i = 0; i < 6; i++) prose.push({ str: "this is a long prose line with many words", transform: [1,0,0,1,40,300 - i*14], width: 300, height: 10 });
ok(detectTableRegion(prose) === null, "detectTableRegion ignores prose (precision-favoured)");

/* ---------- summary ---------- */
console.log(`\nPhase 1 tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
