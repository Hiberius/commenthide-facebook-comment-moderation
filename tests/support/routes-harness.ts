// Harness for tests/routes.test.ts.
//
// Extracted so the suite itself stays inside the 400-line budget, mirroring
// tests/support/auth-harness.ts. Nothing here re-implements production logic:
// it is a Graph API stub, a cookie-aware HTTP client and a schema reset.
//
// The Graph API is stubbed at `globalThis.fetch`. Module mocking (`vi.mock`)
// was the first choice, but a mock registered by a test file is not honoured
// inside the Worker reached through SELF — the real client ran and the suite
// talked to graph.facebook.com. Globals are the seam the pool actually
// guarantees: "this `main` worker runs in the same isolate/context as tests,
// so any global mocks will apply to it too" (cloudflare-test.d.ts, on SELF).
// It is also stricter than a module mock — an edge nothing has scripted
// answers 599 rather than leaving the isolate, so no test can reach the
// network, and the real GraphClient stays under test.

import { env, SELF } from "cloudflare:test";
import { expect, vi } from "vitest";
import type { GraphComment } from "../../src/types";

export const BASE = "https://commenthide.test";
export const PASSWORD = env.ADMIN_PASSWORD;

export const fx = {
  PAGE_ID: "examplepage",
  PAGE_NAME: "Example Page",
  POST_ID: "examplepage_examplepost",
  PERMALINK: "https://www.facebook.com/examplepage/posts/examplepost",
  TOKEN: "fake-page-access-token-for-tests",
} as const;

/** Two comments: one innocuous, one carrying a term a keyword rule can catch. */
export const COMMENTS: readonly GraphComment[] = [
  { id: "c_existing_1", message: "great post", from: { id: "u1", name: "Ada" } },
  { id: "c_existing_2", message: "check my promocode now", from: { id: "u2", name: "Mal" } },
];

// ---------------------------------------------------------------------------
// Graph stub
// ---------------------------------------------------------------------------

export interface Reply {
  readonly status: number;
  readonly body: unknown;
}

export interface GraphScript {
  /** "<METHOD> <edge>" for every call the Worker made, in order. */
  readonly calls: readonly string[];
  readonly hides: readonly { readonly commentId: string; readonly hidden: boolean }[];
  readonly identity: Reply;
  readonly post: Reply;
  readonly comments: readonly GraphComment[];
}

export const ok = (body: unknown): Reply => ({ status: 200, body });

export const graphError = (status: number, message: string, code: number): Reply => ({
  status,
  body: { error: { message, type: "OAuthException", code } },
});

const freshScript = (): GraphScript => ({
  calls: [],
  hides: [],
  identity: ok({ id: fx.PAGE_ID, name: fx.PAGE_NAME }),
  post: ok({ id: fx.POST_ID, message: "hello", permalink_url: fx.PERMALINK }),
  comments: [],
});

let graph = freshScript();

/** What the Worker has asked Graph for so far. */
export const graphState = (): GraphScript => graph;

/** Replaces the script rather than editing it, so no test mutates shared state. */
export function script(patch: Partial<GraphScript>): void {
  graph = { ...graph, ...patch };
}

function route(method: string, edge: string): Reply {
  if (method === "GET" && edge === "me") return graph.identity;
  if (method === "GET" && edge === fx.POST_ID) return graph.post;
  if (method === "GET" && edge.endsWith("/comments")) return ok({ data: [...graph.comments] });
  if (method === "POST") return ok({ success: true });
  // Deliberately loud: an unscripted edge is a test bug, never a network call.
  return { status: 599, body: { error: { message: `unstubbed ${method} ${edge}`, code: 599 } } };
}

/** Resets the script and points globalThis.fetch at it. */
export function installGraph(): void {
  graph = freshScript();
  const impl: typeof fetch = async (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const edge = new URL(href).pathname.replace(/^\/v[^/]+\//, "");
    graph = { ...graph, calls: [...graph.calls, `${method} ${edge}`] };
    if (method === "POST") {
      const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
      const hide = { commentId: edge, hidden: form.get("is_hidden") === "true" };
      graph = { ...graph, hides: [...graph.hides, hide] };
    }
    const reply = route(method, edge);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  };
  vi.stubGlobal("fetch", impl);
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

export type Json = Record<string, unknown>;

export interface Session {
  readonly cookie: string;
  readonly csrf: string;
}

export const call = (path: string, init: RequestInit = {}): Promise<Response> =>
  SELF.fetch(`${BASE}${path}`, init);

export const bodyOf = async (res: Response): Promise<Json> => (await res.json()) as Json;

export function setCookieLines(res: Response): readonly string[] {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie.call(headers);
  const single = res.headers.get("set-cookie");
  return single === null ? [] : [single];
}

export const cookieHeader = (res: Response): string =>
  setCookieLines(res)
    .map((line) => line.split(";")[0] ?? "")
    .filter((pair) => pair.includes("=") && !pair.endsWith("="))
    .join("; ");

/** A distinct fingerprint per test keeps one test's failed logins off another's. */
export const clientHeaders = (tag: string): Record<string, string> => ({
  "cf-connecting-ip": "192.0.2.10",
  "user-agent": `vitest/routes/${tag}`,
});

export const loginAs = (tag: string, password = PASSWORD): Promise<Response> =>
  call("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json", ...clientHeaders(tag) },
    body: JSON.stringify({ password }),
  });

export async function session(tag: string): Promise<Session> {
  const res = await loginAs(tag);
  if (res.status !== 200) throw new Error(`login fixture failed with ${res.status}`);
  const csrf = (await bodyOf(res)).csrfToken;
  if (typeof csrf !== "string" || csrf === "") throw new Error("login returned no csrf token");
  return { cookie: cookieHeader(res), csrf };
}

export const send = (
  s: Session,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> =>
  call(path, {
    method,
    headers: { cookie: s.cookie, "x-csrf-token": s.csrf, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });

/** Logs in and stores a Page token, which most endpoints need before they work. */
export async function connected(tag: string): Promise<Session> {
  const s = await session(tag);
  const stored = await send(s, "PUT", "/api/page/token", { token: fx.TOKEN });
  // Asserted with its body: a silent failure here would make the real
  // assertions in the suite vacuous rather than red.
  expect([stored.status, await stored.text()]).toEqual([200, expect.any(String)]);
  return s;
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

export async function query<T>(sql: string, ...binds: string[]): Promise<T[]> {
  const stmt = env.DB.prepare(sql);
  return (await (binds.length === 0 ? stmt : stmt.bind(...binds)).all<T>()).results;
}

const TABLES = ["settings", "posts", "rules", "comments", "events", "auth_attempts"] as const;

/**
 * Rebuilds the schema from the migrations themselves, then empties it, so a
 * test that drops a table on purpose cannot leave the next one without one.
 *
 * The tables are dropped first rather than replaying the migrations over a live
 * schema: `ALTER TABLE ... ADD COLUMN` is not idempotent, so a plain replay
 * fails on the second run with "duplicate column name".
 */
export async function resetDatabase(): Promise<void> {
  for (const table of [...TABLES].reverse()) {
    await env.DB.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
  for (const migration of env.TEST_MIGRATIONS) {
    for (const statement of migration.queries) await env.DB.prepare(statement).run();
  }
  await env.DB.batch(TABLES.map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
}
