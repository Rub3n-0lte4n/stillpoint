// Library-list rules — pure logic (no DOM).
//   node test/library.test.mjs
import { mergeLibrary, LIB_MAX } from "../js/library.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log("  ✗ FAIL:", msg); } };

const A  = { key:"a", index:10, ts:100 };
const A2 = { key:"a", index:50, ts:200 };
const B  = { key:"b", index:5,  ts:150 };
const C  = { key:"c", index:1,  ts:50 };

let m = mergeLibrary([A], [A2]);
ok(m.length===1 && m[0].index===50, "newer imported entry wins the position");
m = mergeLibrary([A2], [A]);
ok(m.length===1 && m[0].index===50, "older imported entry never regresses progress");
m = mergeLibrary([A], [B]);
ok(m.length===2 && m[0].key==="b", "new books join, newest ts first");
m = mergeLibrary([A2, C], [B]);
ok(m.map(x=>x.key).join(",")==="a,b,c", "merged shelf sorts by ts desc");
ok(mergeLibrary([A], null).length===1 && mergeLibrary(null, [A]).length===1, "null sides are safe");
const noTs = mergeLibrary([{ key:"x" }], [{ key:"x", index:9, ts:1 }]);
ok(noTs[0].index===9, "a missing ts counts as 0 and loses to any real ts");
ok(LIB_MAX===8, "shelf cap is 8");

console.log(`\nLibrary tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
