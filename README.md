# FocusPoint · Couture Reader

A focal-point speed reader that streams **PDFs, EPUBs, and pasted text** through a single still point — no eye movement, no scanning. Everything runs **entirely in your browser**; files never leave your device.

**[→ Open the live app](https://rub3n-0lte4n.github.io/focuspoint-reader/)**

## Features

- **Load PDF & EPUB** by drag-drop or file picker — parsed locally with [pdf.js](https://mozilla.github.io/pdf.js/) and [epub.js](https://github.com/futurepress/epub.js). Also accepts pasted text.
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
