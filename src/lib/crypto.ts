// CommentHide — cryptographic primitives.
//
// Everything here runs on the Web Crypto API that Cloudflare Workers expose
// globally, so there is no Node dependency and no third-party crypto library.
// The Page Access Token is the only long-lived secret the app holds: it is
// encrypted before it reaches D1 and redacted before it reaches a log line.

/** What a secret is replaced with. Fixed width, so it never hints at length. */
const REDACTED = "[redacted]";

/** AES-GCM nonce length. 12 bytes is the size GCM is specified around. */
const IV_BYTES = 12;

/** AES-256 needs exactly this many key bytes. */
const KEY_BYTES = 32;

/** GCM authentication tag, appended to the ciphertext by Web Crypto. */
const TAG_BYTES = 16;

const KEY_HELP =
  "ENCRYPTION_KEY must be the base64 encoding of exactly 32 random bytes. " +
  "Generate one with: openssl rand -base64 32";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  // btoa takes a binary string; chunk it so a long payload cannot blow the
  // argument limit of String.fromCharCode.
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(value: string, what: string): Uint8Array {
  // Accept base64url as well: operators paste keys out of all kinds of tools.
  const normalised = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalised + "=".repeat((4 - (normalised.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error(`${what} is not valid base64. ${KEY_HELP}`);
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  }
  return out;
}

function safeEncodeUri(value: string): string | null {
  try {
    return encodeURIComponent(value);
  } catch {
    // Lone surrogates make encodeURIComponent throw; redact() must never throw.
    return null;
  }
}

function replaceAll(haystack: string, needle: string): string {
  // split/join instead of RegExp: no escaping, no catastrophic patterns.
  return haystack.split(needle).join(REDACTED);
}

// ---------------------------------------------------------------------------
// Synchronous SHA-256
//
// constantTimeEqual is synchronous by contract, and crypto.subtle.digest is
// not. Comparing digests rather than raw strings is the standard way to keep a
// password comparison from leaking length through an early return, so we need
// a digest we can compute without awaiting. Verified against the NIST vectors.
// ---------------------------------------------------------------------------

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

function sha256Sync(input: Uint8Array): Uint8Array {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const blocks = Math.floor((input.length + 8) / 64) + 1;
  const buffer = new Uint8Array(blocks * 64);
  buffer.set(input);
  buffer[input.length] = 0x80;
  const view = new DataView(buffer.buffer);
  const bits = input.length * 8;
  view.setUint32(buffer.length - 8, Math.floor(bits / 0x100000000), false);
  view.setUint32(buffer.length - 4, bits >>> 0, false);

  const w = new Uint32Array(64);
  for (let offset = 0; offset < buffer.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15] ?? 0;
      const y = w[i - 2] ?? 0;
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }

    let a = h[0] ?? 0;
    let b = h[1] ?? 0;
    let c = h[2] ?? 0;
    let d = h[3] ?? 0;
    let e = h[4] ?? 0;
    let f = h[5] ?? 0;
    let g = h[6] ?? 0;
    let hh = h[7] ?? 0;

    for (let i = 0; i < 64; i += 1) {
      const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (hh + s1 + ch + (SHA256_K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    h[0] = ((h[0] ?? 0) + a) >>> 0;
    h[1] = ((h[1] ?? 0) + b) >>> 0;
    h[2] = ((h[2] ?? 0) + c) >>> 0;
    h[3] = ((h[3] ?? 0) + d) >>> 0;
    h[4] = ((h[4] ?? 0) + e) >>> 0;
    h[5] = ((h[5] ?? 0) + f) >>> 0;
    h[6] = ((h[6] ?? 0) + g) >>> 0;
    h[7] = ((h[7] ?? 0) + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, h[i] ?? 0, false);
  return out;
}

// ---------------------------------------------------------------------------
// Token encryption
// ---------------------------------------------------------------------------

/** Workers' Web Crypto types take plain strings; narrow them where we can. */
type AesKeyUsage = "encrypt" | "decrypt";

async function importAesKey(keyB64: string, usage: AesKeyUsage): Promise<CryptoKey> {
  const raw = base64ToBytes(keyB64, "ENCRYPTION_KEY");
  if (raw.length !== KEY_BYTES) {
    throw new Error(`${KEY_HELP} (decoded ${raw.length} bytes, expected ${KEY_BYTES})`);
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [usage]);
}

/** AES-256-GCM. Returns base64 of `iv || ciphertext || tag`. */
export async function encryptToken(plaintext: string, keyB64: string): Promise<string> {
  const key = await importAesKey(keyB64, "encrypt");
  // A fresh nonce per encryption: GCM is catastrophically broken if one repeats.
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext)),
  );
  const payload = new Uint8Array(iv.length + sealed.length);
  payload.set(iv, 0);
  payload.set(sealed, iv.length);
  return bytesToBase64(payload);
}

export async function decryptToken(ciphertextB64: string, keyB64: string): Promise<string> {
  const key = await importAesKey(keyB64, "decrypt");
  const payload = base64ToBytes(ciphertextB64, "The stored token");
  if (payload.length < IV_BYTES + TAG_BYTES) {
    throw new Error("The stored token is truncated or corrupt. Re-enter the Page Access Token.");
  }
  const iv = payload.subarray(0, IV_BYTES);
  const sealed = payload.subarray(IV_BYTES);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, sealed);
  } catch {
    // GCM authentication failed: wrong key, or the ciphertext was altered.
    throw new Error(
      "Unable to decrypt the stored token. ENCRYPTION_KEY has most likely changed — " +
        "re-enter the Page Access Token in the dashboard.",
    );
  }
  return decoder.decode(plain);
}

// ---------------------------------------------------------------------------
// Redaction and comparison
// ---------------------------------------------------------------------------

/**
 * Replaces every occurrence of each secret with "[redacted]". Null-safe and
 * total: it is called on error paths, so it must never throw.
 */
export function redact(text: string, ...secrets: (string | null | undefined)[]): string {
  let out = typeof text === "string" ? text : "";
  if (out.length === 0) return out;
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length === 0) continue;
    out = replaceAll(out, secret);
    // Tokens travel in query strings, where they come back percent-encoded.
    const encoded = safeEncodeUri(secret);
    if (encoded !== null && encoded !== secret) out = replaceAll(out, encoded);
  }
  return out;
}

/**
 * Timing-safe string comparison. Both inputs are digested first, so the
 * comparison loop is always 32 bytes long and an attacker learns nothing about
 * the length of the expected value from how quickly we answer.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const da = sha256Sync(encoder.encode(typeof a === "string" ? a : ""));
  const db = sha256Sync(encoder.encode(typeof b === "string" ? b : ""));
  let diff = 0;
  for (let i = 0; i < da.length; i += 1) {
    diff |= (da[i] ?? 0) ^ (db[i] ?? 0);
  }
  return diff === 0;
}

/** Cryptographically random base64url string, unpadded. */
export function randomToken(byteLength = 32): string {
  const size = Number.isInteger(byteLength) && byteLength > 0 ? byteLength : 32;
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return toHex(new Uint8Array(digest));
}
