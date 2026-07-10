// Declared table of contents — EPUB nav.xhtml / NCX extraction (parseEPUB.nav).
// Dev-only (linkedom + jszip). The shipped app stays no-build.
import test from "node:test";
import assert from "node:assert/strict";
import { DOMParser } from "linkedom";
import JSZip from "jszip";

globalThis.window = { pdfjsLib: { GlobalWorkerOptions: {} }, JSZip };
globalThis.DOMParser = DOMParser;
globalThis.URL = globalThis.URL || {};
globalThis.URL.createObjectURL = globalThis.URL.createObjectURL || (() => "blob:fake");

const { parseEPUB } = await import("../js/parsers.js");

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const chapter = (title, extra = "") => `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head>
<body><h1>${title}</h1>
<p>Some ordinary prose fills this ${title.toLowerCase()} with enough words to register as a unit.</p>
${extra}
</body></html>`;

function opf({ withNav, withNcx }){
  return `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Fixture</dc:title></metadata>
  <manifest>
    ${withNav ? '<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>' : ""}
    ${withNcx ? '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>' : ""}
    <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="c3" href="text/ch3.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine ${withNcx ? 'toc="ncx"' : ""}><itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/></spine>
</package>`;
}

const NAV = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<body><nav epub:type="toc"><h1>Contents</h1><ol>
  <li><a href="text/ch1.xhtml">The Beginning</a></li>
  <li><a href="text/ch2.xhtml">The Middle</a>
    <ol><li><a href="text/ch2.xhtml#s21">A Turn Within</a></li></ol>
  </li>
  <li><a href="text/ch3.xhtml">The End</a></li>
</ol></nav></body></html>`;

const NCX = `<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<navMap>
  <navPoint id="n1" playOrder="1"><navLabel><text>Part One</text></navLabel><content src="text/ch1.xhtml"/></navPoint>
  <navPoint id="n2" playOrder="2"><navLabel><text>Part Two</text></navLabel><content src="text/ch2.xhtml"/>
    <navPoint id="n21" playOrder="3"><navLabel><text>Two point one</text></navLabel><content src="text/ch2.xhtml#s21"/></navPoint>
  </navPoint>
</navMap></ncx>`;

async function buildEpub({ withNav, withNcx }){
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file("META-INF/container.xml", CONTAINER);
  zip.file("OEBPS/content.opf", opf({ withNav, withNcx }));
  if(withNav) zip.file("OEBPS/nav.xhtml", NAV);
  if(withNcx) zip.file("OEBPS/toc.ncx", NCX);
  zip.file("OEBPS/text/ch1.xhtml", chapter("Chapter One"));
  zip.file("OEBPS/text/ch2.xhtml", chapter("Chapter Two",
    `<h2 id="s21">A Turn Within</h2><p>Deeper words continue the chapter after the anchored heading here.</p>`));
  zip.file("OEBPS/text/ch3.xhtml", chapter("Chapter Three"));
  const buf = await zip.generateAsync({ type: "arraybuffer" });
  return { arrayBuffer: async () => buf };
}

test("EPUB3 nav document becomes the declared ToC, fragments included", async () => {
  const { nav, units } = await parseEPUB(await buildEpub({ withNav: true }));
  assert.ok(nav, "nav extracted");
  assert.deepEqual(nav.map(e => e.title), ["The Beginning", "The Middle", "A Turn Within", "The End"]);
  assert.deepEqual(nav.map(e => e.depth), [0, 0, 1, 0]);
  assert.equal(nav[0].start, 0);
  assert.equal(nav[1].start, units[1].start);              // file-level entry = section start
  assert.ok(nav[2].start > units[1].start, "fragment lands past the section start");
  assert.ok(nav[2].start < units[2].start, "fragment stays inside its section");
  assert.equal(nav[3].start, units[2].start);
});

test("EPUB2 NCX is the fallback when no nav document exists", async () => {
  const { nav } = await parseEPUB(await buildEpub({ withNcx: true }));
  assert.ok(nav, "ncx extracted");
  assert.deepEqual(nav.map(e => e.title), ["Part One", "Part Two", "Two point one"]);
  assert.deepEqual(nav.map(e => e.depth), [0, 0, 1]);
});

test("no declared ToC → nav is null and units carry the panel", async () => {
  const { nav, units } = await parseEPUB(await buildEpub({}));
  assert.equal(nav, null);
  assert.equal(units.length, 3);
});
