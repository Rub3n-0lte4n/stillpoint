# Dash + Ellipsis Token Handling — Design

**Date:** 2026-07-15
**Status:** Approved
**Feature:** Em-dash-joined word pairs split into readable tokens; spaced and
lone ellipses collapse into one fixation. User-reported from Musashi: "word—word
is very hard to read at higher speeds" and ". . . displays each . separately."

## Evidence (Musashi.epub, 418,031 tokens, via the real walkSection)

- 752 tokens join two words with an em dash ("commoners—the", "commanders—Ukita,")
- 87 runs of lone "." tokens (the spaced ellipsis ". . ."), 239 lone dots total,
  each carrying its own sentence-end pause
- 168 lone "…" / "..." tokens
- 0 en-dash joins, 0 double-hyphen joins → out of scope (YAGNI)

## Decisions (locked with user)

1. **Split at the em dash, dash trails the first word:** "commoners—the" →
   "commoners—" + "the". The existing pause regex (`[,;:—–)\]]["']?$`) already
   gives the trailing dash a clause pause. Rejected: dash as its own beat token
   (752 extra fixations in this one book).
2. **Ellipses merge into the preceding word as a single "…":**
   "Gone . . ." → "Gone…" — one fixation, ONE end flag instead of three.
3. **Accepted drift:** token indexes shift (+~450 net on Musashi), so saved
   resume positions land ~half a page earlier mid-book and existing mark ranges
   drift a few lines. No migration machinery (would require keeping the old
   tokenizer forever).

## Rules (post-pass inside `tokenize()`, `js/text.js`, before flags)

Operating on the space-split word list:

- **Dash split:** while a word matches `letter-ish [—―] letter-ish`, split
  after the dash. Letter-ish includes closing/opening quotes and brackets
  around the dash (`right—"Next` splits to `right—` + `"Next`). Leading or
  trailing dashes alone never split ("—but", `and—"`). Hyphen `-` and en dash
  `–` never split.
- **Ellipsis collapse:** a token consisting only of dots/ellipsis characters
  (`/^[.…]+$/`) is an ellipsis beat. Consecutive ellipsis beats collapse to
  one. The collapsed "…" appends to the previous word when one exists in the
  same tokenize() call; otherwise it stays as a single "…" token. After any
  append, a trailing mix of two-or-more dots/ellipses normalizes to one "…"
  (never "word..…"); a single trailing "." stays a period.
- Flags (`end`, `pause`) are computed after the post-pass, unchanged in form.
  "word…" matches the end regex once; "commoners—" matches the pause regex.

Order: dash split first, then ellipsis collapse (a split never produces
dot-only tokens, so the order only matters for determinism).

## Consumers (no changes needed, verified by tests)

- `walkSection`'s `here()` anchor approximation counts whitespace-split words;
  the post-pass changes counts by design — anchors stay approximate (their
  documented contract).
- Sentence pacing (`sentenceFactors`), replay-sentence, ribbon, blocks
  `after` offsets: all consume tokenize() output downstream of the pass.

## Testing

- New `test/tokenize.test.mjs`, appended to the `npm test` chain in
  `package.json`: dash splits (single, multi-dash chain, quote-adjacent),
  non-splits (hyphen, en dash, leading/trailing dash), ellipsis forms
  (". . .", ". . . .", lone "…", lone "...", paragraph-start ellipsis,
  no-double-dot normalization), flag placement (pause on "left—", single end
  on "word…"), and byte-identical output for plain prose.
- Musashi harness re-run: em-dash-join count 0, lone-dot count 0.
- CDP E2E smoke: EPUB parses, token total in the expected range, reader streams.

## Ship notes

- `sw.js` CACHE_VERSION → v47 (text.js in SHELL).
- Library books re-parse on open, so cached books pick the rules up
  automatically; positions/marks drift once as accepted above.
