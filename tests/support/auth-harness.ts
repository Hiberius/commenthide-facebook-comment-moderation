// Shared harness for tests/auth.test.ts.
//
// Extracted so the suite itself stays inside the 400-line budget. Nothing here
// re-implements production logic except signIssuedAt, which exists so a test
// can forge a *validly signed* cookie with an arbitrary timestamp.

import { env } from "cloudflare:test";
import { Hono } from "hono";
import type { AppEnv, Env } from "../../src/types";
import { csrfToken, login, logout, requireAuth, requireCsrf } from "../../src/lib/auth";

export const HTTPS = "https://commenthide.test";
export const HTTP = "http://localhost:8787";
export const SESSION_TTL_SEC = 7 * 24 * 60 * 60;
export const PASSWORD = env.ADMIN_PASSWORD;

export interface Client {
  ip: string;
  ua: string;
}

/** The union of every JSON shape the harness routes can answer with. */
export interface Body {
  ok?: boolean;
  error?: string;
  retryAfterSec?: number;
  csrfToken?: string;
  token?: string;
}

export interface CallInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** Mounts the real middleware on throwaway routes, one app per test. */
export function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/session", async (c) => {
    const body = await c.req
      .json<{ password?: string }>()
      .catch(() => ({}) as { password?: string });
    const result = await login(c, body.password ?? "");
    if (!result.ok) return c.json(result, 401);
    return c.json({ ok: true, csrfToken: await csrfToken(c) });
  });

  app.delete("/session", (c) => {
    logout(c);
    return c.json({ ok: true });
  });

  app.get("/csrf", async (c) => c.json({ token: await csrfToken(c) }));

  // requireAuth in isolation.
  app.use("/private/*", requireAuth);
  app.get("/private/ping", (c) => c.json({ ok: true }));

  // requireCsrf in isolation, so a 403 can never be confused with a 401.
  app.use("/guarded/*", requireCsrf);
  app.get("/guarded/ping", (c) => c.json({ ok: true }));
  app.post("/guarded/ping", (c) => c.json({ ok: true }));

  return app;
}

export function withEnv(patch: Partial<Env>): Env {
  return { ...env, ...patch };
}

export function headersFor(
  client: Client,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { "cf-connecting-ip": client.ip, "user-agent": client.ua, ...extra };
}

export async function call(
  app: Hono<AppEnv>,
  url: string,
  init: CallInit = {},
  bindings: Env = env,
): Promise<Response> {
  return app.request(
    url,
    { method: init.method ?? "GET", headers: init.headers, body: init.body },
    bindings,
  );
}

export async function json(res: Response): Promise<Body> {
  return (await res.json()) as Body;
}

function setCookieLines(res: Response): readonly string[] {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  const getAll = headers.getSetCookie;
  if (typeof getAll === "function") return getAll.call(headers);
  const single = res.headers.get("set-cookie");
  return single === null ? [] : [single];
}

export function cookieLine(res: Response, name: string): string | undefined {
  return setCookieLines(res).find((line) => line.startsWith(`${name}=`));
}

export function cookieJar(res: Response): ReadonlyMap<string, string> {
  const jar = new Map<string, string>();
  for (const line of setCookieLines(res)) {
    const pair = line.split(";")[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return jar;
}

export function cookieHeader(jar: ReadonlyMap<string, string>): string {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

export function loginRequest(
  app: Hono<AppEnv>,
  client: Client,
  password: string,
  base = HTTPS,
  bindings: Env = env,
): Promise<Response> {
  return call(
    app,
    `${base}/session`,
    {
      method: "POST",
      headers: headersFor(client, { "content-type": "application/json" }),
      body: JSON.stringify({ password }),
    },
    bindings,
  );
}

/** Independent re-implementation of the cookie signature, to forge test cookies. */
async function signIssuedAt(issuedAt: number, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(String(issuedAt))));
  let binary = "";
  for (let i = 0; i < sig.length; i += 1) binary += String.fromCharCode(sig[i] ?? 0);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A `__Host-` session cookie header value signed for an arbitrary issuedAt. */
export async function sessionCookie(issuedAt: number): Promise<string> {
  return `__Host-ch_session=${issuedAt}.${await signIssuedAt(issuedAt, env.SESSION_SECRET)}`;
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export async function authAttemptRows(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_attempts").first<{ n: number }>();
  return row === null ? -1 : Number(row.n);
}
