// Backup encryption — envelope round-trip and failure modes.
//   node test/crypto.test.mjs
// Uses Node's global WebCrypto (Node 20+); no browser, no mocks.
import test from "node:test";
import assert from "node:assert/strict";
import {
  encryptBackup, decryptBackup, isEncryptedBackup,
  toBase64, fromBase64, ENC_FORMAT,
} from "../js/crypto.js";

const sample = JSON.stringify({
  format: "stillpoint-backup",
  version: 1,
  library: [{ key: "b1", title: "War and Peace" }],
  files: [{ key: "b1", kind: "text", text: "Well, Prince, so Genoa and Lucca…" }],
});

test("encrypt → decrypt returns the original plaintext exactly", async () => {
  const env = await encryptBackup(sample, "correct horse battery staple");
  const back = await decryptBackup(env, "correct horse battery staple");
  assert.equal(back, sample);
});

test("the envelope reveals nothing about the plaintext", async () => {
  const env = await encryptBackup(sample, "hunter2hunter2");
  assert.equal(env.format, ENC_FORMAT);
  const serialized = JSON.stringify(env);
  assert.ok(!serialized.includes("War and Peace"), "title must not appear in ciphertext");
  assert.ok(!serialized.includes("Genoa"), "book text must not appear in ciphertext");
  assert.ok(!serialized.includes("stillpoint-backup\""), "inner format must not leak");
});

test("isEncryptedBackup distinguishes envelopes from plain backups", async () => {
  const env = await encryptBackup(sample, "pw-pw-pw-pw");
  assert.equal(isEncryptedBackup(env), true);
  assert.equal(isEncryptedBackup(JSON.parse(sample)), false);
  assert.equal(isEncryptedBackup(null), false);
  assert.equal(isEncryptedBackup({ format: ENC_FORMAT }), false); // no data field
});

test("wrong passphrase is rejected, not silently garbled", async () => {
  const env = await encryptBackup(sample, "the-right-one");
  await assert.rejects(
    () => decryptBackup(env, "the-wrong-one"),
    /Wrong passphrase, or that file has been altered/,
  );
});

test("a tampered ciphertext fails authentication", async () => {
  const env = await encryptBackup(sample, "passphrase-here");
  const raw = fromBase64(env.data);
  raw[raw.length - 1] ^= 0x01;          // flip one bit of the tag/body
  env.data = toBase64(raw);
  await assert.rejects(() => decryptBackup(env, "passphrase-here"), /altered/);
});

test("a tampered salt fails (key no longer derives)", async () => {
  const env = await encryptBackup(sample, "passphrase-here");
  const salt = fromBase64(env.kdf.salt);
  salt[0] ^= 0xff;
  env.kdf.salt = toBase64(salt);
  await assert.rejects(() => decryptBackup(env, "passphrase-here"));
});

test("fresh salt and IV every export (no reuse across backups)", async () => {
  const a = await encryptBackup(sample, "same-passphrase");
  const b = await encryptBackup(sample, "same-passphrase");
  assert.notEqual(a.kdf.salt, b.kdf.salt, "salt must be random per export");
  assert.notEqual(a.cipher.iv, b.cipher.iv, "IV must be random per export");
  assert.notEqual(a.data, b.data, "identical input under same passphrase must not produce identical ciphertext");
});

test("empty passphrase is refused on encrypt", async () => {
  await assert.rejects(() => encryptBackup(sample, ""), /passphrase is needed/);
});

test("decrypt rejects a non-envelope object", async () => {
  await assert.rejects(() => decryptBackup(JSON.parse(sample), "x"), /isn't an encrypted/);
});

test("a downgraded cipher name in the envelope is refused", async () => {
  const env = await encryptBackup(sample, "passphrase-here");
  env.cipher.name = "AES-CBC";           // attacker tries to force a weaker mode
  await assert.rejects(() => decryptBackup(env, "passphrase-here"), /can't open/);
});

test("an absurd iteration count can't hang the tab (clamped)", async () => {
  const env = await encryptBackup(sample, "passphrase-here");
  env.kdf.iterations = 10 ** 12;         // hostile file
  // Clamp means the wrong count now mismatches the real key → auth failure, fast.
  await assert.rejects(() => decryptBackup(env, "passphrase-here"), /Wrong passphrase|altered/);
});

test("base64 helpers round-trip binary including high bytes", () => {
  const bytes = new Uint8Array([0, 1, 2, 127, 128, 200, 254, 255]);
  assert.deepEqual([...fromBase64(toBase64(bytes))], [...bytes]);
});

test("base64 round-trips a payload larger than one chunk", () => {
  const big = new Uint8Array(0x8000 * 2 + 17).map((_, i) => i % 256);
  assert.deepEqual([...fromBase64(toBase64(big))], [...big]);
});

test("unicode plaintext survives the round-trip", async () => {
  const uni = JSON.stringify({ format: "stillpoint-backup", library: [], note: "café — 日本語 — 📖" });
  const env = await encryptBackup(uni, "unicode-pass");
  assert.equal(await decryptBackup(env, "unicode-pass"), uni);
});
