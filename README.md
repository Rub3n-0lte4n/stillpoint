# Stillpoint · Couture Reader

A focal-point speed reader that streams **PDFs, EPUBs, and pasted text** through a single still point — no eye movement, no scanning. Everything runs **entirely in your browser**; files never leave your device.

**[→ Open the live app](https://stillpointreader.com/)**

## Features

- **Load PDF & EPUB** by drag-drop or file picker — parsed locally with vendored [pdf.js](https://mozilla.github.io/pdf.js/) and [JSZip](https://stuk.github.io/jszip/) (EPUBs are read straight from the OPF/spine). Also accepts pasted text.
- **Three reading modes**
  - **ORP** — one word at a time with the optimal-recognition letter highlighted
  - **RSVP** — classic 1–4 word chunks flashed in place
  - **Hybrid** — word clusters with the focal letter on the middle word
- **Speed** 150–800 WPM with Comfortable / Focus / Fast / Skim presets, plus natural micro-pauses at sentence and clause breaks.
- **Contents** — the book's own table of contents (EPUB nav/NCX, PDF outline) in a top-bar panel, plus a draggable progress scrubber.
- **Structure-aware reading** — tables and figures aren't flattened: pause-and-show cards, a page view, and a per-document figures index.
- **Highlights** — mark sentences or words as you read; review and export as Markdown or Anki.
- **Reading streak** — a configurable daily goal with a quiet progress ring and per-day ledger, stored locally.
- **Gestures** — drag the stage vertically for speed, swipe for sentences, pinch for text size; Kindle-style tap zones.
- **Keyboard**: `Space` play/pause · `←`/`→` skip a sentence · `↑`/`↓` speed · `M` mark · `R` replay · `Esc` library.
- **Library & resume** — books are cached in IndexedDB and reopen at your position; one-file backup export/import moves everything to another device, no account.
- **Installable PWA** — fully offline after the first load, with wake lock and an immersive zen mode while reading.

## Run locally

No build step. The app is `index.html` + `styles.css` + ES modules in `js/`. Because it uses native ES modules, serve it over HTTP (opening `index.html` via `file://` won't load the modules):

```bash
python3 -m http.server 8765
# then visit http://localhost:8765
```

```
index.html        markup (all libraries are vendored, same-origin)
styles.css        all styling
sw.js             service worker: offline shell + share target
js/app.js         entry: state, reader engine, UI wiring
js/text.js        tokenizing, ORP focus point, contents rows, escaping
js/parsers.js     PDF (pdf.js) and EPUB (JSZip) extraction + declared ToC
js/blockmode.js   table/figure presentation modes
js/highlights.js  marks, review, Markdown/Anki export
js/store.js       IndexedDB persistence
js/streak.js      daily goal + streak ledger
js/gestures.js    stage gesture recognizer
js/haptics.js     vendored web-haptics (Vibration API + iOS switch trick)
js/patron.js      patron unlock + reading themes
js/vendor/        pdf.js and JSZip, vendored (no CDN)
```

Tests (dev-only tooling; the shipped app stays no-build):

```bash
npm install && npm test
```

## Privacy

No accounts, no servers, no tracking. Your documents are read and parsed locally and never uploaded.

## Security notes

- **No third-party code at runtime** — pdf.js and JSZip are vendored into the repo and served same-origin, so there is no CDN to compromise. (They were previously loaded from a CDN with Subresource Integrity; vendoring replaced that.)
- **CVE-2024-4367** — `pdf.js` is invoked with `isEvalSupported:false`, the official mitigation against arbitrary JS execution from a crafted PDF.
- **Content-Security-Policy** — a `<meta>` CSP restricts scripts and connections to `self` (plus the Google Fonts hosts for styles/fonts). All JavaScript is in external ES modules, so `script-src` does **not** allow `'unsafe-inline'`. (`style-src` still allows it for inline style attributes.)
- **Untrusted document text** is HTML-escaped before rendering; EPUB content is parsed for text only (no script execution).
- **Not settable on GitHub Pages**: HTTP response headers such as `Strict-Transport-Security` (github.io is HSTS-preloaded anyway) and `X-Frame-Options` / CSP `frame-ancestors` (ignored in `<meta>`) require a server. The app performs no sensitive actions, so clickjacking impact is negligible.
