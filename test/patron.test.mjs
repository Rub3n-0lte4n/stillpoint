// Patron verification — pure logic (no DOM).
//   node test/patron.test.mjs
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
ok(THEMES.length === 4 && THEMES[0].id === "midnight", "4 themes, midnight first/default");
ok(themeById("ember").name === "Ember Atelier", "themeById finds ember");
ok(themeById("nope").id === "midnight", "unknown theme falls back to midnight");
ok(isPatronTheme("midnight") === false, "midnight is free");
ok(isPatronTheme("garden") === true && isPatronTheme("abyss") === true && isPatronTheme("ember") === true, "other themes are patron-only");
ok(isPatronTheme("unknown") === false, "unknown id resolves to default (free)");
ok(/^https:\/\/buy\.stripe\.com\//.test(PATRON_LINK), "patron link is a Stripe buy link");

console.log(`\nPatron tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
