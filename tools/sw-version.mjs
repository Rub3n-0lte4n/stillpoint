#!/usr/bin/env node
// CACHE_VERSION in sw.js is derived from the CONTENT of the SHELL files, so a
// shipped shell change can never forget its cache bump again.
//   node tools/sw-version.mjs --check   fail (exit 1) if sw.js is stale — CI runs this
//   node tools/sw-version.mjs --write   rewrite CACHE_VERSION from the current shell
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const swPath = join(root, "sw.js");
const sw = readFileSync(swPath, "utf8");

const shellMatch = sw.match(/const SHELL = \[([\s\S]*?)\];/);
if (!shellMatch) die("sw.js: SHELL array not found");
const entries = [...shellMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

// "./" is index.html by another name; sort + dedupe so list order can't
// spuriously change the version. A missing SHELL file throws loudly — that is
// a real bug (the SW install would fail silently), not something to paper over.
const h = createHash("sha256");
for (const e of [...new Set(entries.map((e) => (e === "./" ? "index.html" : e)))].sort()) {
  h.update(e); h.update("\0");
  h.update(readFileSync(join(root, e))); h.update("\0");
}
const version = "stillpoint-" + h.digest("hex").slice(0, 10);

const cur = (sw.match(/const CACHE_VERSION = "([^"]+)"/) || [])[1];
if (!cur) die("sw.js: CACHE_VERSION not found");

const mode = process.argv[2];
if (mode === "--check") {
  if (cur === version) console.log("sw cache version matches the shell:", version);
  else die(`sw.js CACHE_VERSION is "${cur}" but the shell content hashes to "${version}".\nShell files changed without a bump. Run: npm run sw:bump`);
} else if (mode === "--write") {
  if (cur === version) console.log("already current:", version);
  else {
    writeFileSync(swPath, sw.replace(/const CACHE_VERSION = "[^"]+"/, `const CACHE_VERSION = "${version}"`));
    console.log(`CACHE_VERSION: ${cur} -> ${version}`);
  }
} else die("usage: node tools/sw-version.mjs --check | --write");

function die(msg) { console.error(msg); process.exit(1); }
