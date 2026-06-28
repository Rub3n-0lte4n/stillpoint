---
title: Phase 1 — Block-aware parsing foundation
date: 2026-06-28
status: approved (design)
parent: 2026-06-28-stillpoint-analytical-reading-overview.md
---

# Stillpoint — Phase 1: Block-Aware Parsing Foundation

This is the first child phase of the
[Structure-Aware Analytical Reading epic](./2026-06-28-stillpoint-analytical-reading-overview.md).
It implements **only the parsing layer**.

## Context

Today both parsers in `js/parsers.js` flatten every document to a flat `tokens`
array: `parsePDF` keeps only `page.getTextContent()`, and `parseEPUB` calls
`body.textContent`. Tables, images, figures, blockquotes, and code blocks
collapse into an undifferentiated word stream. Phase 1 makes `parsePDF` and
`parseEPUB` emit a sidecar `blocks` array alongside the existing `tokens` and
`units`, capturing non-linear content in place. The reader does **not** consume
`blocks` yet — that is Phase 2 — so for plain prose the output (and the reading
experience) must be **byte-for-byte unchanged** from today. See the
[epic overview](./2026-06-28-stillpoint-analytical-reading-overview.md) for the
shared data model and phase map.

## Scope

- `parseEPUB`: replace the `body.textContent` extraction with an **in-order DOM
  walk**. Text nodes feed `tokenize` → `tokens`. Block elements (`table`, `img`,
  `figure`, `blockquote`, `pre`) become entries in `blocks`, each with
  `after = tokens.length` at the moment it is encountered.
- `parseEPUB`: resolve `<img>` sources through the existing `resolveZipPath` /
  `zipEntry` helpers to a decoded object URL.
- `parsePDF`: in the existing per-page loop, detect **image XObjects** via
  `page.getOperatorList()`, render each image region to an offscreen canvas, and
  emit an image block.
- `parsePDF`: detect **table-like regions** heuristically and render the region
  to an image (a **snapshot** — no text reconstruction).
- Both parsers: keep emitting all prose into `tokens` exactly as before. Table
  and image text continues to flow into `tokens` as a fallback so nothing is lost
  if PDF detection misfires.
- Extend the return shape of both functions with `blocks`.

## Out of scope (Phase 2+)

- The reader loop reading/rendering blocks, "still cards", page view, appendix.
- Per-kind presentation settings and `blockMode` persistence.
- Dismissing/restoring auto-detected blocks in the UI (the data model supports it
  here; the UI is Phase 2).
- Persisting block payloads. Snapshots and blob URLs are **session-memory only**.
- PDF table text reconstruction, OCR, equation parsing from PDFs.
- New vendored libraries. pdf.js already provides canvas rendering and operator
  lists; JSZip already extracts EPUB entries.

## Data model

The return value gains a sidecar `blocks` array. `tokens` and `units` are
unchanged.

```js
{
  tokens,   // unchanged: [{ w, end, pause }]
  units,    // unchanged: [{ title, start }]
  blocks: [
    {
      id,       // stable string id, e.g. "blk-0", "blk-1", … (emission order)
      after,    // token index this block follows; blocks[i].after is monotonic non-decreasing
      kind,     // "table" | "image" | "figure" | "equation" | "code" | "quote"
      payload,  // variant by source — see below
      unit      // index into `units` the block belongs to
    }
  ]
}
```

`after` is the value of `tokens.length` at the instant the block is encountered,
so a block placed *between* two words anchors to the token it follows. A block at
the very start of a unit has `after` equal to that unit's `start`.

### Payload variants

| Source | `kind` | `payload` shape |
|--------|--------|-----------------|
| PDF table region | `table` | `{ type:"image", dataUrl, width, height, alt }` |
| PDF image XObject | `image` | `{ type:"image", dataUrl, width, height, alt }` |
| EPUB `<img>` | `image` | `{ type:"image", blobUrl, alt }` |
| EPUB `<table>` | `table` | `{ type:"html", html }` |
| EPUB `<figure>` | `figure` | `{ type:"html", html }` |
| EPUB `<blockquote>` | `quote` | `{ type:"html", html }` |
| EPUB `<pre>` | `code` | `{ type:"html", html }` |

```js
// type:"image" — a rendered snapshot or decoded bitmap. Session-memory only.
{ type:"image", dataUrl:"data:image/png;base64,…", width:Number, height:Number, alt:"" }
// PDF: dataUrl from canvas.toDataURL(). EPUB image: { type:"image", blobUrl, alt } via URL.createObjectURL(blob).

// type:"html" — sanitized markup from an EPUB section. Session-memory only.
{ type:"html", html:"<table>…</table>" }
```

**Sanitization (EPUB `type:"html"`):** before storing `html`, clone the element,
remove all `<script>` and `<style>` descendants, and strip every attribute whose
name starts with `on` (event handlers) plus any `href`/`src`/`xlink:href` whose
value starts with `javascript:`. Inline `<img>` inside a captured `<figure>` is
resolved to a `blobUrl` the same way standalone images are, so figure images
render offline.

**Memory note:** `dataUrl` and `blobUrl` payloads live only in the in-memory
parse result for the current session. They are **never** written to
`localStorage`. Persisted reading state (Phase 2+) is index-based — it references
blocks by `id`/`after`, not by carrying pixels.

## Parser changes

All names below are the real exports/helpers in `js/parsers.js`:
`parsePDF`, `parseEPUB`, `resolveZipPath`, `zipEntry`.

### EPUB — in-order DOM walk (`parseEPUB`)

Replace the current per-section extraction:

```js
const toks = tokenize(body ? (body.textContent||"") : "");
```

with an in-order recursive walk of `body`. Today's `script,style` removal is
kept. The walk visits nodes depth-first in document order:

- **Text node** → accumulate its text; on leaving an inline run, push its
  `tokenize(...)` output into `tokens` (preserving the existing
  `toks.length > 3` per-section gate for unit/title creation, applied to the
  section's total token count rather than per-node).
- **Block element** matching `table | img | figure | blockquote | pre` → emit a
  block with `after = tokens.length`, `unit =` the current unit index,
  `id = "blk-" + blocks.length`, the mapped `kind`, and the payload built per the
  table above. Do **not** descend into the captured element's children for token
  extraction beyond the fallback (see below), so a table's cell text is not also
  streamed as loose prose **unless** we intentionally keep it as fallback.
- **Other elements** (`p`, `span`, `div`, headings, …) → descend normally; their
  text becomes tokens as today.

**Image resolution:** for `<img>`, read `src` (and `xlink:href` for SVG
`<image>`), run it through `resolveZipPath(opfDir-of-the-section, src)` then
`zipEntry(zip, …)`. Decode the entry with `entry.async("blob")` and wrap with
`URL.createObjectURL(blob)` → `payload.blobUrl`. Carry `alt` from the element.
If the entry is missing, skip the block (the surrounding prose is unaffected).

**Fallback:** EPUB captures keep their textual content reachable because the
sanitized `html` payload still contains the words; tables/figures therefore do
not need separate token fallback. Token order for surrounding prose is preserved
by the in-order walk.

**Title detection** (`h1,h2,h3,title`) and the `units.push({title, start})`
contract are unchanged.

### PDF — image XObjects (`parsePDF`)

Inside the existing `for(let p=1; …)` page loop, after `getTextContent()`:

- Call `await page.getOperatorList()` and scan ops for image paints
  (`OPS.paintImageXObject` / `OPS.paintInlineImageXObject`), tracking the current
  transform matrix from the surrounding `save`/`transform`/`restore` ops to derive
  each image's bounding box in viewport space.
- For each image, render that region to an **offscreen** canvas: set a
  `pdfjsLib`-style viewport, `page.render({ canvasContext, viewport })` clipped to
  the bbox (or render the page once at a chosen scale and `drawImage`-crop the
  region), then `canvas.toDataURL("image/png")`.
- Emit `{ id, after: tokens.length, kind:"image", unit, payload:{ type:"image",
  dataUrl, width, height, alt:"" } }`.

`after` uses the page's text position; image blocks anchor at the end of the
page's tokens emitted so far, keeping `after` monotonic.

### PDF — table snapshot (`parsePDF`)

Heuristic region detection over `getTextContent().items` (each item has `str`,
`transform`, `width`, `height`):

1. Group items into rows by quantized baseline `transform[5]` (the same Y signal
   the current code uses to insert spaces).
2. Flag a **candidate region** when several consecutive rows each contain many
   **short** text items whose left edges (`transform[4]`) cluster into shared
   **columns** (x-alignment) across **≥ 3 rows** and **≥ 2 columns**.
3. Compute the region bbox from the union of member item boxes, render that bbox
   to a canvas exactly like the image path, and emit a `kind:"table"` block with a
   `type:"image"` snapshot payload.

**No text reconstruction.** The snapshot is the artifact. The table's words still
flow into `tokens` as today (the detection does not remove items from the text
stream), so if detection misfires the reader loses nothing — it just reads the
table as prose, exactly like the current build.

## Interfaces / return shape

```js
// js/parsers.js
export async function parsePDF(file, onProgress = ()=>{})
//   → { tokens, units, blocks, pages }
export async function parseEPUB(file, onProgress = ()=>{})
//   → { tokens, units, blocks, chapters }
```

- `blocks` defaults to `[]` and is always present (empty for plain prose docs).
- `onProgress` semantics, error throwing (no extractable text / invalid archive),
  and the `pages` / `chapters` fields are unchanged.
- No change to `js/text.js`. `tokenize` still returns `[{ w, end, pause }]`.

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| PDF table detection is heuristic and may false-positive on aligned prose, code, or multi-column layouts. | **Favour precision over recall.** Require ≥3 rows AND ≥2 aligned columns AND mostly-short items before flagging. Auto-detected blocks carry enough metadata to be **dismissible in Phase 2**. |
| A missed table (false negative) loses structure. | Table text **always** stays in `tokens` as fallback — a missed table reads as prose, identical to today. No regression. |
| Snapshot rendering itself failing (canvas/transform math). | Snapshot rendering via pdf.js canvas + operator lists is reliable; the *detection* is the fuzzy part, not the render. Wrap each region render in try/catch; on failure, emit no block and keep the fallback tokens. |
| EPUB DOM walk reordering prose vs. the old `textContent`. | The walk is strict document order, matching `textContent` traversal; covered by a fixture asserting identical token stream for a prose-only section. |
| Untrusted EPUB markup (XSS) reaching the DOM later. | Sanitize `type:"html"` payloads at parse time: strip `script`/`style`, `on*` attributes, and `javascript:` URLs. |
| Memory growth from many snapshots/blobs. | Payloads are session-only, never persisted; Phase 2 owns blob-URL lifecycle (revocation on document unload). |
| New dependencies. | None added — pdf.js (canvas + `getOperatorList`) and JSZip cover all needs. |

## Testing strategy

Fixtures live under the project's test assets; assertions run against the parser
return values.

**EPUB fixture** — a small valid EPUB containing one section with: a paragraph of
prose, a `<table>`, an `<img>` (with a real entry in the zip), and a `<figure>`
(with caption + inline image).

- `blocks` contains exactly one `kind:"table"` (`type:"html"`), one
  `kind:"image"` (`type:"image"` with a non-empty `blobUrl`), and one
  `kind:"figure"` (`type:"html"`).
- The table block's `html` has been sanitized (no `<script>`, no `on*` attrs).
- Prose words still appear in `tokens` in document order.
- `blocks[i].after` is **monotonic non-decreasing** and each `after` is a valid
  index into `tokens` (`0 <= after <= tokens.length`).
- Each block's `unit` is a valid index into `units`.

**PDF fixture** — a small PDF with one page carrying a figure (embedded image) and
a region of short, grid-aligned text (a table-like block).

- `blocks` contains a `kind:"image"` block and (when detection fires) a
  `kind:"table"` block, both `type:"image"` with a `dataUrl` and positive
  `width`/`height`.
- The table region's text is **still present in `tokens`** (fallback intact).
- `after` values are monotonic and within range.

**Graceful degradation** — a plain prose PDF and a plain prose EPUB (no tables,
images, figures, quotes, or code):

- `blocks` is `[]`.
- `tokens` and `units` are **identical** to the pre-Phase-1 output (snapshot
  comparison). The reading experience is unchanged.

## Acceptance criteria

- [ ] `parsePDF` and `parseEPUB` return `{ …, blocks }`, with `blocks` always an
      array (empty for plain prose).
- [ ] Every block has `id`, `after`, `kind`, `payload`, `unit`; `kind` is one of
      `table | image | figure | equation | code | quote`.
- [ ] `blocks[i].after` is monotonic non-decreasing and a valid index into
      `tokens`; `unit` is a valid index into `units`.
- [ ] EPUB parsing walks the DOM in order; `<table>/<img>/<figure>/<blockquote>/
      <pre>` produce blocks; all other prose tokenizes exactly as before.
- [ ] EPUB `<img>` payloads resolve through `resolveZipPath`/`zipEntry` to a
      working `blobUrl`; figure inline images resolve too.
- [ ] EPUB `type:"html"` payloads are sanitized (no `script`/`style`, no `on*`
      handlers, no `javascript:` URLs).
- [ ] PDF image XObjects are detected via `getOperatorList()` and snapshotted to a
      `dataUrl` image block.
- [ ] PDF table-like regions are detected heuristically (precision-favoured) and
      snapshotted; their text **remains in `tokens`** as fallback.
- [ ] A plain prose PDF and a plain prose EPUB yield `blocks === []` and a
      `tokens`/`units` stream identical to the current build.
- [ ] Snapshot/image payloads are never written to `localStorage`.
- [ ] No new vendored libraries added; `js/text.js` unchanged.
