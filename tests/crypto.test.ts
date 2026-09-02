// Tests for src/lib/crypto.ts.
//
// This module holds the only long-lived secret in the app (the Page Access
// Token), so the tests here are deliberately structural: they assert the shape
// of the sealed payload, not just that a round-trip happens to work.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  constantTimeEqual,
  decryptToken,
  encryptToken,
  randomToken,
  redact,
  sha256Hex,
} from "../src/lib/crypto";

/** AES-GCM nonce length, as prepended by encryptToken. */
const IV_BYTES = 12;
/** GCM authentication tag, appended by Web Crypto. */
const TAG_BYTES = 16;

// --- helpers ---------------------------------------------------------------

/** base64 of `len` bytes all equal to `byte`. Deterministic, test-only. */
function keyOf(byte: number, len = 32): string {
  let binary = "";
  for (let i = 0; i < len; i += 1) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i] ?? 0);
  return btoa(binary);
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) out += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  return out;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** The key the test Worker is configured with: 32 bytes of 0x01. */
const KEY_A = env.ENCRYPTION_KEY;
/** A second, equally valid key — used to prove decryption is key-bound. */
const KEY_B = keyOf(0x2b);

describe("encryptToken / decryptToken", () => {
  it("round-trips an ASCII token", async () => {
    const token = "fake-page-access-token-for-tests-only";
    const sealed = await encryptToken(token, KEY_A);

    expect(sealed).not.toContain(token);
    await expect(decryptToken(sealed, KEY_A)).resolves.toBe(token);
  });

  it("round-trips unicode and long values", async () => {
    const token = `tökén-😀-${"x".repeat(500)}`;
    const sealed = await encryptToken(token, KEY_A);

    await expect(decryptToken(sealed, KEY_A)).resolves.toBe(token);
  });

  it("round-trips the empty string", async () => {
    const sealed = await encryptToken("", KEY_A);

    await expect(decryptToken(sealed, KEY_A)).resolves.toBe("");
  });

  it("prepends a 12-byte IV and appends the 16-byte GCM tag", async () => {
    const token = "short-token";
    const payload = b64ToBytes(await encryptToken(token, KEY_A));

    expect(payload.length).toBe(IV_BYTES + utf8Length(token) + TAG_BYTES);
  });

  it("uses a fresh IV, so the same plaintext never encrypts to the same bytes", async () => {
    const token = "identical-plaintext";
    const first = await encryptToken(token, KEY_A);
    const second = await encryptToken(token, KEY_A);

    expect(first).not.toBe(second);

    const ivA = hex(b64ToBytes(first).subarray(0, IV_BYTES));
    const ivB = hex(b64ToBytes(second).subarray(0, IV_BYTES));
    expect(ivA).not.toBe(ivB);

    await expect(decryptToken(first, KEY_A)).resolves.toBe(token);
    await expect(decryptToken(second, KEY_A)).resolves.toBe(token);
  });

  it("accepts a base64url-encoded key and a standard base64 key interchangeably", async () => {
    // 0xFB bytes encode to "+/v7", which becomes "-_v7" in base64url.
    const standard = keyOf(0xfb);
    const urlSafe = standard.replace(/\+/g, "-").replace(/\//g, "_");
    expect(urlSafe).not.toBe(standard);

    const sealed = await encryptToken("cross-alphabet", urlSafe);
    await expect(decryptToken(sealed, standard)).resolves.toBe("cross-alphabet");
  });

  it("rejects a ciphertext decrypted with a different valid key", async () => {
    const sealed = await encryptToken("wrong-key-please", KEY_A);

    expect(KEY_B).not.toBe(KEY_A);
    await expect(decryptToken(sealed, KEY_B)).rejects.toThrow(
      /ENCRYPTION_KEY has most likely changed/,
    );
  });

  it("rejects a tampered ciphertext", async () => {
    const payload = b64ToBytes(await encryptToken("authenticate-me", KEY_A));
    const tampered = new Uint8Array(payload);
    const last = tampered.length - 1;
    tampered[last] = (payload[last] ?? 0) ^ 0xff;

    await expect(decryptToken(bytesToB64(tampered), KEY_A)).rejects.toThrow(/Unable to decrypt/);
  });

  it("rejects a payload too short to hold an IV and a tag", async () => {
    const stub = bytesToB64(new Uint8Array(IV_BYTES + TAG_BYTES - 1));

    await expect(decryptToken(stub, KEY_A)).rejects.toThrow(/truncated or corrupt/);
  });

  it("rejects a key that does not decode to exactly 32 bytes, with guidance", async () => {
    for (const length of [16, 31, 33, 64]) {
      const key = keyOf(0x07, length);
      await expect(encryptToken("nope", key)).rejects.toThrow(
        new RegExp(`decoded ${length} bytes, expected 32`),
      );
      await expect(encryptToken("nope", key)).rejects.toThrow(/openssl rand -base64 32/);
      await expect(decryptToken("AAAA", key)).rejects.toThrow(/expected 32/);
    }
  });

  it("rejects a key that is not base64 at all", async () => {
    await expect(encryptToken("nope", "this is not base64!!")).rejects.toThrow(
      /ENCRYPTION_KEY is not valid base64/,
    );
  });

  it("rejects stored ciphertext that is not base64", async () => {
    await expect(decryptToken("not base64 either!!", KEY_A)).rejects.toThrow(/not valid base64/);
  });
});

describe("redact", () => {
  const TOKEN = "fake-token-for-redaction-tests";
  const OTHER = "second-secret-value";

  it("replaces every occurrence of every listed secret", () => {
    const text = `GET ?access_token=${TOKEN} failed for ${TOKEN}; retried with ${OTHER}`;
    const out = redact(text, TOKEN, OTHER);

    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(OTHER);
    expect(out.split("[redacted]").length - 1).toBe(3);
    expect(out).toBe("GET ?access_token=[redacted] failed for [redacted]; retried with [redacted]");
  });

  it("also redacts the percent-encoded form a token takes in a query string", () => {
    const secret = "a b/c+d";
    const encoded = encodeURIComponent(secret);
    expect(encoded).not.toBe(secret);

    const out = redact(`https://graph.example/x?access_token=${encoded}&limit=100`, secret);

    expect(out).not.toContain(encoded);
    expect(out).toContain("[redacted]");
    expect(out).toContain("&limit=100");
  });

  it("ignores null, undefined and empty secrets", () => {
    const text = `keep ${TOKEN} for now`;

    expect(redact(text, null, undefined, "")).toBe(text);
    expect(redact(text, null, TOKEN, undefined, "")).toBe("keep [redacted] for now");
  });

  it("returns the input unchanged when nothing matches", () => {
    expect(redact("nothing to hide here")).toBe("nothing to hide here");
    expect(redact("nothing to hide here", "absent")).toBe("nothing to hide here");
    expect(redact("", TOKEN)).toBe("");
  });

  it("never throws on a secret containing a lone surrogate", () => {
    // encodeURIComponent throws on lone surrogates; redact runs on error paths.
    const secret = "\ud800broken";
    const out = redact(`value ${secret} tail`, secret);

    expect(out).toBe("value [redacted] tail");
  });
});

describe("constantTimeEqual", () => {
  it("is true for identical strings", () => {
    expect(constantTimeEqual("hunter2", "hunter2")).toBe(true);
    expect(constantTimeEqual("", "")).toBe(true);
    expect(constantTimeEqual("pässwörd-😀", "pässwörd-😀")).toBe(true);
  });

  it("is false for equal-length strings with different content", () => {
    expect(constantTimeEqual("abcd", "abce")).toBe(false);
    expect(constantTimeEqual("hunter2", "hunter3")).toBe(false);
  });

  it("is false for strings of different length", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "x")).toBe(false);
    expect(constantTimeEqual("a".repeat(64), "a".repeat(65))).toBe(false);
  });
});

describe("randomToken", () => {
  it("produces distinct base64url values", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) seen.add(randomToken());

    expect(seen.size).toBe(200);
    for (const value of seen) expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("encodes the requested number of bytes, unpadded", () => {
    for (const bytes of [8, 16, 24, 32, 48]) {
      expect(randomToken(bytes)).toHaveLength(Math.ceil((bytes * 4) / 3));
    }
  });

  it("falls back to 32 bytes for a nonsensical length", () => {
    const expected = Math.ceil((32 * 4) / 3);

    expect(randomToken(0)).toHaveLength(expected);
    expect(randomToken(-8)).toHaveLength(expected);
    expect(randomToken(2.5)).toHaveLength(expected);
  });
});

describe("sha256Hex", () => {
  it("matches the published SHA-256 vectors", async () => {
    await expect(sha256Hex("")).resolves.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    await expect(sha256Hex("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    await expect(sha256Hex("The quick brown fox jumps over the lazy dog")).resolves.toBe(
      "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592",
    );
  });

  it("is stable for one input and differs across inputs", async () => {
    const a1 = await sha256Hex("1.2.3.4\nMozilla/5.0");
    const a2 = await sha256Hex("1.2.3.4\nMozilla/5.0");
    const b = await sha256Hex("1.2.3.5\nMozilla/5.0");

    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).toMatch(/^[0-9a-f]{64}$/);
  });
});
