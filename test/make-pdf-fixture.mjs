// Generate a PDF fixture for the Phase 1 PDF snapshot path: prose + an embedded
// image XObject + an aligned table-like grid of short text. Run once:
//   node test/make-pdf-fixture.mjs   →  test/fixtures/sample.pdf
import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "fixtures");
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, "sample.pdf");

const doc = new PDFDocument({ size: "LETTER", margin: 54 });
doc.pipe(fs.createWriteStream(out));

doc.fontSize(13);
doc.text("This is a short prose paragraph that should read normally as a word stream before the reader reaches the figure and the table on this page.", { width: 460 });
doc.moveDown(1);

// Embedded image XObject → paintImageXObject in the operator list.
doc.image(path.join(here, "..", "icon-192.png"), 54, doc.y, { width: 120 });
doc.moveDown(9);

// Aligned table-like grid: 4 rows x 3 columns of short text at fixed x columns,
// same baseline y per row → triggers detectTableRegion (>=3 rows, >=2 columns).
const cols = [60, 230, 400];
const rows = [
  ["Region", "Q1", "Q2"],
  ["EMEA", "12", "18"],
  ["APAC", "9", "15"],
  ["AMER", "21", "24"],
];
let y = doc.y + 10;
doc.fontSize(12);
for (const row of rows) {
  row.forEach((cell, c) => doc.text(cell, cols[c], y, { lineBreak: false }));
  y += 22;
}

doc.moveDown(4);
doc.fontSize(13);
doc.text("And one more closing paragraph of ordinary prose after the table so the stream keeps flowing past the captured blocks.", 54, y + 20, { width: 460 });

doc.end();
console.log("wrote", out);
