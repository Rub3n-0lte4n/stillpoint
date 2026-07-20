// Optional passphrase encryption for the library backup.
//
// The backup carries the books themselves, so a file that leaves the device (a
// cloud drive, a mail attachment) carries the reading life with it. Encrypting
// it keeps the no-server promise intact in transit: the passphrase never leaves
// the browser and there is nothing to ask a server for, which is also why a
// forgotten passphrase cannot be reset by anyone, including me.
//
// PBKDF2-SHA256 into AES-GCM. WebCrypto exposes no memory-hard KDF, so the
// iteration count carries the work. Salt and nonce are fresh per export and ride
// in the envelope in the clear; only the passphrase is secret. `subtle` is
// injectable so this is testable outside a browser, matching patron.js.

export const ENC_FORMAT  = "stillpoint-backup-encrypted";
export const ENC_VERSION = 1;

const KDF        = "PBKDF2";
const KDF_HASH   = "SHA-256";
const ITERATIONS = 310000;      // OWASP guidance for PBKDF2-SHA256
const CIPHER     = "AES-GCM";
const KEY_BITS   = 256;
const SALT_BYTES = 16;
const IV_BYTES   = 12;          // 96-bit nonce, the length AES-GCM is specified for
// An envelope is attacker-supplied, so its iteration count is clamped: without
// this, a crafted file could pin the tab at a billion rounds before it fails.
const ITER_MAX   = 2_000_000;
const B64_CHUNK  = 0x8000;      // chunked so multi-MB books don't blow the call stack

export function toBase64(buf){
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for(let i=0;i<bytes.length;i+=B64_CHUNK) s += String.fromCharCode.apply(null, bytes.subarray(i, i+B64_CHUNK));
  return btoa(s);
}

export function fromBase64(s){
  const bin = atob(String(s ?? ""));
  const out = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function isEncryptedBackup(data){
  return !!(data && data.format === ENC_FORMAT && typeof data.data === "string");
}

function pickSubtle(subtle){
  const s = subtle ?? globalThis.crypto?.subtle;
  if(!s) throw new Error("This browser can't encrypt here. Encryption needs a secure (https) page.");
  return s;
}

function randomBytes(n){
  const c = globalThis.crypto;
  if(typeof c?.getRandomValues !== "function") throw new Error("This browser can't generate the randomness encryption needs.");
  return c.getRandomValues(new Uint8Array(n));
}

async function deriveKey(passphrase, salt, iterations, subtle){
  const material = await subtle.importKey("raw", new TextEncoder().encode(passphrase), KDF, false, ["deriveKey"]);
  return subtle.deriveKey(
    { name:KDF, salt, iterations, hash:KDF_HASH },
    material,
    { name:CIPHER, length:KEY_BITS },
    false,
    ["encrypt","decrypt"],
  );
}

// Wrap a JSON string into a self-describing encrypted envelope.
export async function encryptBackup(plaintext, passphrase, subtle){
  if(!passphrase) throw new Error("A passphrase is needed to encrypt this backup.");
  const s = pickSubtle(subtle);
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveKey(passphrase, salt, ITERATIONS, s);
  const body = await s.encrypt({ name:CIPHER, iv }, key, new TextEncoder().encode(plaintext));
  return {
    format: ENC_FORMAT,
    version: ENC_VERSION,
    kdf: { name:KDF, hash:KDF_HASH, iterations:ITERATIONS, salt:toBase64(salt) },
    cipher: { name:CIPHER, iv:toBase64(iv) },
    data: toBase64(body),
  };
}

// Unwrap an envelope back to the JSON string, or throw with something a reader
// can act on. Algorithm names are checked rather than trusted, so a file cannot
// talk us into a weaker cipher than the one we wrote.
export async function decryptBackup(envelope, passphrase, subtle){
  if(!isEncryptedBackup(envelope)) throw new Error("That file isn't an encrypted Stillpoint backup.");
  const s = pickSubtle(subtle);
  const kdf = envelope.kdf ?? {};
  const cipher = envelope.cipher ?? {};
  if((kdf.name ?? KDF) !== KDF || (kdf.hash ?? KDF_HASH) !== KDF_HASH || (cipher.name ?? CIPHER) !== CIPHER){
    throw new Error("That backup was written with settings this version can't open.");
  }
  const salt = fromBase64(kdf.salt);
  const iv = fromBase64(cipher.iv);
  if(!salt.length || !iv.length) throw new Error("That backup is missing the values needed to open it.");
  const iterations = Math.min(ITER_MAX, Math.max(1, Math.trunc(kdf.iterations) || ITERATIONS));
  const key = await deriveKey(passphrase, salt, iterations, s);
  try{
    const plain = await s.decrypt({ name:CIPHER, iv }, key, fromBase64(envelope.data));
    return new TextDecoder().decode(plain);
  }catch(e){
    // AES-GCM authentication failed. A wrong passphrase and a tampered file are
    // indistinguishable here, and that is the right amount to say.
    throw new Error("Wrong passphrase, or that file has been altered.");
  }
}
