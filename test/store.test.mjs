// IndexedDB cache — the same code path the browser runs, exercised against
// fake-indexeddb (the shim registers a global indexedDB before the import).
//   node test/store.test.mjs
import "fake-indexeddb/auto";
const { Store } = await import("../js/store.js");

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log("  ✗ FAIL:", msg); } };

await Store.put("book.epub::123", { kind:"epub", name:"book.epub" });
const rec = await Store.get("book.epub::123");
ok(rec && rec.kind==="epub" && rec.name==="book.epub", "put/get roundtrips a record");
ok(await Store.get("missing::0") === undefined, "get on a missing key resolves undefined");

await Store.putBlockMode("book.epub::123", { default:"skip" });
await Store.putHighlights("book.epub::123", [{ start:1, end:2 }]);
const keys = await Store.keys();
ok(keys.includes("book.epub::123") && keys.includes("blockmode::book.epub::123") && keys.includes("hl::book.epub::123"),
   "namespaced keys share the one store (no VERSION bump)");
ok((await Store.getBlockMode("book.epub::123")).default==="skip", "block mode roundtrips");
ok((await Store.getHighlights("book.epub::123"))[0].end===2, "highlights roundtrip");

await Store.del("book.epub::123");
ok(await Store.get("book.epub::123") === undefined, "del removes its key");
ok((await Store.keys()).includes("blockmode::book.epub::123"), "sibling namespaced keys survive a file delete");

console.log(`\nStore tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
