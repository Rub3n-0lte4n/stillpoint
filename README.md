# Stillpoint · Couture Reader

A focal-point speed reader that streams **PDFs, EPUBs, and pasted text** through a single still point — no eye movement, no scanning. Everything runs **entirely in your browser**; files never leave your device.

**[→ Open the live app](https://rub3n-0lte4n.github.io/stillpoint/)**

## Features

- **Load PDF & EPUB** by drag-drop or file picker — parsed locally with [pdf.js](https://mozilla.github.io/pdf.js/) and [JSZip](https://stuk.github.io/jszip/) (EPUBs are read straight from the OPF/spine). Also accepts pasted text.
- **Three reading modes**
  - **ORP** — one word at a time with the optimal-recognition letter highlighted
  - **RSVP** — classic 1–4 word chunks flashed in place
  - **Hybrid** — word clusters with the focal letter on the middle word
- **Speed** 150–800 WPM with Comfortable / Focus / Fast / Skim presets, plus natural micro-pauses at sentence and clause breaks.
- **Navigate** to EPUB chapters / PDF pages, with a draggable progress scrubber.
- **Keyboard**: `Space` play/pause · `←`/`→` skip a sentence · `↑`/`↓` speed · `Esc` library.
- **Resume** — reading position, recent files, and preferences persist in `localStorage`.
- **Mobile-optimized** and fully offline-capable after first load.

## Run locally

It's a single static file — just open `index.html`, or serve it:

```bash
python3 -m http.server 8765
# then visit http://localhost:8765
```

## Privacy

No accounts, no servers, no tracking. Your documents are read and parsed locally and never uploaded.

## Security notes

- **Subresource Integrity** — all CDN libraries are pinned with `integrity` (SHA-384) + `crossorigin`, so a tampered CDN response is rejected.
- **CVE-2024-4367** — `pdf.js` is invoked with `isEvalSupported:false`, the official mitigation against arbitrary JS execution from a crafted PDF.
- **Content-Security-Policy** — a `<meta>` CSP restricts scripts/styles/connections to `self`, the pinned CDN, and the Google Fonts hosts. Because the app ships as a single self-contained file, the inline script/styles require `'unsafe-inline'`; moving the JS to an external `app.js` would allow dropping it for stronger XSS protection.
- **Untrusted document text** is HTML-escaped before rendering; EPUB content is parsed for text only (no script execution).
- **Not settable on GitHub Pages**: HTTP response headers such as `Strict-Transport-Security` (github.io is HSTS-preloaded anyway) and `X-Frame-Options` / CSP `frame-ancestors` (ignored in `<meta>`) require a server. The app performs no sensitive actions, so clickjacking impact is negligible.
