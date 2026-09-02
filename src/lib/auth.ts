// CommentHide — dashboard authentication.
//
// One shared admin password, a stateless signed session cookie and a
// double-submit CSRF token. Nothing is stored server-side except the
// failed-login counters that throttle brute force attempts.

import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../types";
import { clearAuthFailures, getAuthLock, recordAuthFailure } from "./storage";
import { constantTimeEqual, randomToken, sha256Hex } from "./crypto";

/** Sessions and CSRF tokens both live for a week. */
const SESSION_TTL_SEC = 7 * 24 * 60 * 60;

/** Tolerance for a cookie minted a moment "in the future" by clock skew. */
const CLOCK_SKEW_SEC = 60;

const SESSION_COOKIE = "ch_session";
const CSRF_COOKIE = "ch_csrf";

/** Methods that cannot change state, so they carry no CSRF requirement. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const encoder = new TextEncoder();

interface CookieNames {
  session: string;
  csrf: string;
  secure: boolean;
}

/**
 * `__Host-` cookies are rejected by browsers unless they are Secure, and
 * `wrangler dev` serves plain HTTP. Falling back to unprefixed, non-Secure
 * names on http keeps local development working; production is always https
 * and therefore always gets the hardened names.
 */
function cookieNames(c: Context<AppEnv>): CookieNames {
  let secure = true;
  try {
    secure = new URL(c.req.url).protocol === "https:";
  } catch {
    // A malformed URL should never reach us; assume the hardened variant.
    secure = true;
  }
  return secure
    ? { session: `__Host-${SESSION_COOKIE}`, csrf: `__Host-${CSRF_COOKIE}`, secure: true }
    : { session: SESSION_COOKIE, csrf: CSRF_COOKIE, secure: false };
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i] ?? 0);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signIssuedAt(issuedAt: number, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(String(issuedAt)));
  return bytesToBase64Url(new Uint8Array(signature));
}

/** Identifies the caller for throttling without storing an IP address. */
async function clientFingerprint(c: Context<AppEnv>): Promise<string> {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown-ip";
  const ua = c.req.header("user-agent") ?? "unknown-ua";
  return sha256Hex(`${ip}\n${ua}`);
}

function secondsUntil(target: number | null, now: number): number | undefined {
  if (target === null || target <= now) return undefined;
  return Math.max(1, Math.ceil((target - now) / 1000));
}

async function issueSession(c: Context<AppEnv>, secret: string): Promise<void> {
  const names = cookieNames(c);
  const issuedAt = Math.floor(Date.now() / 1000);
  const signature = await signIssuedAt(issuedAt, secret);
  setCookie(c, names.session, `${issuedAt}.${signature}`, {
    httpOnly: true,
    secure: names.secure,
    sameSite: "Strict",
    path: "/",
    maxAge: SESSION_TTL_SEC,
  });
}

export async function login(
  c: Context<AppEnv>,
  password: string,
): Promise<{ ok: true } | { ok: false; error: string; retryAfterSec?: number }> {
  const secret = c.env.SESSION_SECRET;
  const expected = c.env.ADMIN_PASSWORD;
  if (typeof secret !== "string" || secret.length === 0) {
    return { ok: false, error: "SESSION_SECRET is not configured on this Worker." };
  }
  if (typeof expected !== "string" || expected.length === 0) {
    return { ok: false, error: "ADMIN_PASSWORD is not configured on this Worker." };
  }

  const now = Date.now();
  const fingerprint = await clientFingerprint(c);
  const lock = await getAuthLock(c.env.DB, fingerprint, now);
  const lockedFor = secondsUntil(lock.lockedUntil, now);
  if (lockedFor !== undefined) {
    // Locked out: never touch the password, so a lockout cannot be used as an
    // oracle for whether a guess was close.
    return {
      ok: false,
      error: "Too many failed attempts. Try again shortly.",
      retryAfterSec: lockedFor,
    };
  }

  if (!constantTimeEqual(password, expected)) {
    const after = await recordAuthFailure(c.env.DB, fingerprint, now);
    const retryAfterSec = secondsUntil(after.lockedUntil, now);
    const error =
      retryAfterSec === undefined
        ? "Incorrect password."
        : "Too many failed attempts. Try again shortly.";
    return retryAfterSec === undefined ? { ok: false, error } : { ok: false, error, retryAfterSec };
  }

  await clearAuthFailures(c.env.DB, fingerprint);
  await issueSession(c, secret);
  return { ok: true };
}

export function logout(c: Context<AppEnv>): void {
  const names = cookieNames(c);
  const opts = { path: "/", secure: names.secure, sameSite: "Strict" } as const;
  deleteCookie(c, names.session, { ...opts, httpOnly: true });
  deleteCookie(c, names.csrf, opts);
}

export async function isAuthed(c: Context<AppEnv>): Promise<boolean> {
  const secret = c.env.SESSION_SECRET;
  // Without the signing key nothing can be verified, so nothing is trusted.
  if (typeof secret !== "string" || secret.length === 0) return false;

  const raw = getCookie(c, cookieNames(c).session);
  if (raw === undefined || raw.length === 0) return false;

  const dot = raw.indexOf(".");
  if (dot <= 0 || dot === raw.length - 1) return false;
  const issuedRaw = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  if (!/^\d{1,15}$/.test(issuedRaw)) return false;

  const issuedAt = Number(issuedRaw);
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) return false;

  let expected: string;
  try {
    expected = await signIssuedAt(issuedAt, secret);
  } catch {
    // An unusable SESSION_SECRET must fail closed, not throw a 500 at a visitor.
    return false;
  }
  if (!constantTimeEqual(signature, expected)) return false;

  const ageSec = Math.floor(Date.now() / 1000) - issuedAt;
  if (ageSec > SESSION_TTL_SEC) return false;
  if (ageSec < -CLOCK_SKEW_SEC) return false;
  return true;
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!(await isAuthed(c))) return c.json({ error: "unauthorized" }, 401);
  await next();
  return;
};

/** Mints (or reuses) the double-submit CSRF token and returns it. */
export async function csrfToken(c: Context<AppEnv>): Promise<string> {
  const names = cookieNames(c);
  const existing = getCookie(c, names.csrf);
  if (existing !== undefined && /^[A-Za-z0-9_-]{16,}$/.test(existing)) return existing;

  const token = randomToken(32);
  // Deliberately not HttpOnly: the dashboard script has to echo it back in the
  // x-csrf-token header, which is what makes the double-submit check work.
  setCookie(c, names.csrf, token, {
    httpOnly: false,
    secure: names.secure,
    sameSite: "Strict",
    path: "/",
    maxAge: SESSION_TTL_SEC,
  });
  return token;
}

/** Rejects non-GET requests whose x-csrf-token header does not match the cookie. */
export const requireCsrf: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method.toUpperCase())) {
    await next();
    return;
  }
  const cookie = getCookie(c, cookieNames(c).csrf);
  const header = c.req.header("x-csrf-token");
  if (
    cookie === undefined ||
    cookie.length === 0 ||
    header === undefined ||
    header.length === 0 ||
    !constantTimeEqual(cookie, header)
  ) {
    return c.json({ error: "csrf" }, 403);
  }
  await next();
  return;
};
