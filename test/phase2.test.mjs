// Phase 2 verification — pure block-presentation logic (no DOM).
//   node test/phase2.test.mjs
import { modeForKind, defaultBlockMode, indexBlocks, firstBlockInRange, isDismissed, isAutoDetected } from "../js/blockmode.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log("  ✗ FAIL:", msg); } };

/* ---------- modeForKind precedence ---------- */
const bm = { default:"pause", image:"skip", table:"skip", dismissed:[] };
ok(modeForKind(bm, "table") === "skip", "per-kind override beats global default");
ok(modeForKind(bm, "figure") === "pause", "global default applies when no override");
ok(modeForKind(bm, "image") === "skip", "image override honoured");
ok(modeForKind({}, "table") === "pause", "empty blockMode → per-kind default (pause)");
ok(modeForKind({}, "image") === "skip", "empty blockMode → per-kind default (image=skip)");
ok(modeForKind(null, "code") === "pause", "null blockMode → per-kind default");

/* ---------- defaultBlockMode seed ---------- */
const d = defaultBlockMode();
ok(d.default === "pause" && d.image === "skip" && Array.isArray(d.dismissed), "seed: pause default, image skip, dismissed[]");

/* ---------- range lookup ---------- */
const blocks = [
  { id:"blk-0", after:5,  kind:"table",  payload:{ type:"html", html:"<table></table>" } },
  { id:"blk-1", after:12, kind:"image",  payload:{ type:"image", dataUrl:"data:," } },
  { id:"blk-2", after:12, kind:"figure", payload:{ type:"image", blobUrl:"blob:x" } },
  { id:"blk-3", after:30, kind:"quote",  payload:{ type:"html", html:"<blockquote></blockquote>" } },
];
const sorted = indexBlocks(blocks);
ok(sorted[0].after <= sorted[sorted.length-1].after, "indexBlocks sorts by after");

const shown = new Set(), dismissed = new Set();
ok(firstBlockInRange(sorted, 0, 5, dismissed, shown) === null, "no block in [0,5)");
ok(firstBlockInRange(sorted, 5, 6, dismissed, shown).id === "blk-0", "finds block at after=5 in [5,6)");
ok(firstBlockInRange(sorted, 10, 13, dismissed, shown).id === "blk-1", "finds first of two blocks at after=12");

// shown suppresses
shown.add("blk-1");
ok(firstBlockInRange(sorted, 10, 13, dismissed, shown).id === "blk-2", "shown id is skipped, next returned");

// dismissed suppresses
dismissed.add("blk-2");
ok(firstBlockInRange(sorted, 10, 13, dismissed, shown) === null, "all in range shown/dismissed → null");

/* ---------- dismissed persistence helper ---------- */
ok(isDismissed({ dismissed:["blk-9"] }, "blk-9") === true, "isDismissed true for listed id");
ok(isDismissed({ dismissed:["blk-9"] }, "blk-1") === false, "isDismissed false for unlisted id");
ok(isDismissed({}, "blk-1") === false, "isDismissed false when no dismissed array");

/* ---------- auto-detected (PDF) detection ---------- */
ok(isAutoDetected({ payload:{ type:"image", dataUrl:"data:," } }) === true, "PDF snapshot (dataUrl) is auto-detected");
ok(isAutoDetected({ payload:{ type:"image", blobUrl:"blob:x" } }) === false, "EPUB image (blobUrl) not auto-detected");
ok(isAutoDetected({ payload:{ type:"html", html:"x" } }) === false, "EPUB html block not auto-detected");

console.log(`\nPhase 2 tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
