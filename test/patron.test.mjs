// Patron verification — pure logic (no DOM).
//   node test/patron.test.mjs
import { readFileSync } from "node:fs";
import { normalizeCode, verifyPatronCode, themeById, isPatronTheme, THEMES, PATRON_LINK } from "../js/patron.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log("  ✗ FAIL:", msg); } };

/* ---------- normalization ---------- */
ok(normalizeCode("there-the-dance-is") === "THERETHEDANCEIS", "dashes stripped, uppercased");
ok(normalizeCode("  There The Dance Is  ") === "THERETHEDANCEIS", "spaces stripped");
ok(normalizeCode("there_the.dance!is") === "THERETHEDANCEIS", "punctuation stripped");
ok(normalizeCode("") === "" && normalizeCode(null) === "", "empty/null safe");

/* ---------- verification ---------- */
ok(await verifyPatronCode("THERE-THE-DANCE-IS") === true, "canonical code verifies");
ok(await verifyPatronCode("there the dance is") === true, "lowercase spaced code verifies");
ok(await verifyPatronCode("at-the-still-point") === false, "wrong code rejected");
ok(await verifyPatronCode("") === false, "empty rejected");
ok(await verifyPatronCode("THERE-THE-DANCE-IS ", null) === true, "trailing space verifies");

/* ---------- themes ---------- */
ok(THEMES.length === 5 && THEMES[0].id === "midnight", "5 themes, midnight first/default");
ok(themeById("ember").name === "Ember Atelier", "themeById finds ember");
ok(themeById("nope").id === "midnight", "unknown theme falls back to midnight");
ok(isPatronTheme("midnight") === false, "midnight is free");
ok(isPatronTheme("garden") === true && isPatronTheme("abyss") === true && isPatronTheme("ember") === true && isPatronTheme("tokyo") === true, "other themes are patron-only");
ok(isPatronTheme("unknown") === false, "unknown id resolves to default (free)");
ok(/^https:\/\/buy\.stripe\.com\//.test(PATRON_LINK), "patron link is a Stripe buy link");

/* ---------- link drift ----------
   index.html can't import the constant (no build step), so its two hardcoded
   patron hrefs must match PATRON_LINK verbatim — this is what keeps the export
   the source of truth instead of dead code. */
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
ok(html.split(PATRON_LINK).length - 1 === 2, "index.html carries PATRON_LINK verbatim in both patron spots");

console.log(`\nPatron tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
