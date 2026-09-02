// CommentHide — HTTP layer integration tests.
//
// Every request goes through the real Worker via SELF.fetch, so securityHeaders,
// requireAuth and requireCsrf run in the order index.ts mounts them rather than
// being re-assembled here. The Graph API is stubbed inside the harness and no
// test may reach the network; see ./support/routes-harness for why the seam is
// globalThis.fetch rather than vi.mock.

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bodyOf,
  call,
  clientHeaders,
  connected,
  COMMENTS,
  cookieHeader,
  fx,
  graphError,
  graphState,
  installGraph,
  loginAs,
  PASSWORD,
  query,
  resetDatabase,
  script,
  send,
  session,
  setCookieLines,
} from "./support/routes-harness";

beforeEach(async () => {
  await resetDatabase();
  installGraph();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("public surface", () => {
  it("serves /health without a session", async () => {
    const res = await call("/health");
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({ ok: true, version: expect.any(String) });
  });

  it("serves the dashboard as HTML behind the security headers", async () => {
    const res = await call("/");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(html).toMatch(/^<!DOCTYPE html>/i);

    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("permissions-policy")).toContain("camera=()");
  });

  it("answers an unknown path with JSON, not the dashboard", async () => {
    const anonymous = await call("/no-such-page");
    expect(anonymous.status).toBe(404);
    expect(anonymous.headers.get("content-type")).toMatch(/application\/json/);
    expect(await bodyOf(anonymous)).toEqual({ error: "not found" });

    const api = await send(await session("notfound"), "GET", "/api/no-such-route");
    const text = await api.text();
    expect(api.status).toBe(404);
    expect(text).not.toContain("<");
    expect(JSON.parse(text)).toEqual({ error: "not found" });
  });
});

describe("authentication", () => {
  // Every route the API exposes, so an endpoint mounted outside the middleware
  // would have to be added here to stay green.
  const GUARDED = [
    "DELETE /api/session", "GET /api/status", "PUT /api/page/token",
    "DELETE /api/page/token", "GET /api/page/posts", "GET /api/posts", "POST /api/posts",
    `PATCH /api/posts/${fx.POST_ID}`, `DELETE /api/posts/${fx.POST_ID}`,
    `GET /api/posts/${fx.POST_ID}/comments`, `POST /api/posts/${fx.POST_ID}/test`,
    `POST /api/posts/${fx.POST_ID}/restore`, "GET /api/rules", "POST /api/rules",
    "PATCH /api/rules/1", "DELETE /api/rules/1", "POST /api/rules/seed", "POST /api/run",
    "POST /api/comments/1234/hide", "POST /api/comments/1234/show", "GET /api/events",
  ] as const;

  it.each(GUARDED)("rejects %s without a session", async (route) => {
    const [method = "GET", path = "/"] = route.split(" ");
    const body = method === "GET" || method === "DELETE" ? {} : { body: "{}" };
    const res = await call(path, {
      method,
      headers: { "content-type": "application/json" },
      ...body,
    });
    expect(res.status).toBe(401);
    expect(await bodyOf(res)).toEqual({ error: "unauthorized" });
    // Hardening survives the rejection, and nothing reached Graph.
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(graphState().calls).toEqual([]);

    // The 401 above would also be produced by a path that is not mounted at
    // all, since the middleware covers the whole /api tree. Authenticated, a
    // real endpoint answers something of its own; only a routing miss says
    // "not found".
    const mounted = await send(await session(`mounted-${path}`), method, path, body.body);
    expect(await bodyOf(mounted)).not.toEqual({ error: "not found" });
  });

  it("refuses a wrong password without minting a session", async () => {
    expect(PASSWORD.length).toBeGreaterThan(0);
    const res = await loginAs("wrong-password", `${PASSWORD}-wrong`);
    expect(res.status).toBe(401);
    expect((await bodyOf(res)).error).toBe("Incorrect password.");
    expect(setCookieLines(res)).toEqual([]);

    const missing = await call("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json", ...clientHeaders("nopass") },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);
    expect((await bodyOf(missing)).error).toBe("password is required and must be a string");
  });

  it("mints a session cookie and a csrf token for the right password", async () => {
    const res = await loginAs("right-password");
    const body = await bodyOf(res);
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.csrfToken).toMatch(/^[A-Za-z0-9_-]{16,}$/);

    const lines = setCookieLines(res);
    expect(lines.some((line) => line.startsWith("__Host-ch_session="))).toBe(true);
    expect(lines.some((line) => line.startsWith("__Host-ch_csrf="))).toBe(true);

    const after = await call("/api/status", { headers: { cookie: cookieHeader(res) } });
    expect(after.status).toBe(200);
  });
});

describe("csrf", () => {
  it("rejects a state-changing POST that carries no x-csrf-token header", async () => {
    const s = await session("csrf-missing");
    const res = await call("/api/rules/seed", {
      method: "POST",
      headers: { cookie: s.cookie, "content-type": "application/json" },
    });
    expect(res.status).toBe(403);
    expect(await bodyOf(res)).toEqual({ error: "csrf" });
    expect(await query("SELECT id FROM rules")).toHaveLength(0);
  });

  it("accepts the same request once the header matches the cookie", async () => {
    const res = await send(await session("csrf-present"), "POST", "/api/rules/seed");
    const body = await bodyOf(res);
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(Number(body.created)).toBeGreaterThan(0);
    expect((await query("SELECT id FROM rules")).length).toBe(Number(body.created));
  });
});

describe("request validation", () => {
  it("rejects a malformed JSON body", async () => {
    const res = await send(await session("badjson"), "POST", "/api/rules", "{not json");
    expect(res.status).toBe(400);
    expect((await bodyOf(res)).error).toBe("invalid json");
  });

  it("names the field when a post mode is not one of the two modes", async () => {
    const res = await send(await session("badmode"), "POST", "/api/posts", {
      postId: fx.POST_ID,
      mode: "hide_everything",
    });
    expect(res.status).toBe(400);
    expect((await bodyOf(res)).error).toBe("mode must be one of: rules, hide_all");
    expect(await query("SELECT post_id FROM posts")).toHaveLength(0);
  });

  it("names the field when a rule kind is unknown", async () => {
    const res = await send(await session("badkind"), "POST", "/api/rules", {
      kind: "vibes",
      pattern: "anything",
    });
    expect(res.status).toBe(400);
    expect((await bodyOf(res)).error).toBe(
      "kind must be one of: keyword, regex, link, contact, emoji_spam, min_length, author_allow",
    );
    expect(await query("SELECT id FROM rules")).toHaveLength(0);
  });
});

describe("PUT /api/page/token", () => {
  it("stores nothing when the token fails identity()", async () => {
    script({ identity: graphError(401, "Invalid OAuth access token", 190) });
    const res = await send(await session("bad-token"), "PUT", "/api/page/token", {
      token: fx.TOKEN,
    });
    expect(res.status).toBe(400);
    expect((await bodyOf(res)).error).toContain("invalid or has expired");
    expect(graphState().calls).toEqual(["GET me"]);
    expect(await query("SELECT key FROM settings")).toHaveLength(0);

    const events = await query<{ action: string }>("SELECT action FROM events");
    expect(events.map((row) => row.action)).toEqual(["page_token_rejected"]);
  });

  it("never echoes the token back on success", async () => {
    const s = await session("good-token");
    const res = await send(s, "PUT", "/api/page/token", { token: fx.TOKEN });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain(fx.TOKEN);
    expect(JSON.parse(text)).toEqual({ ok: true, page: { id: fx.PAGE_ID, name: fx.PAGE_NAME } });

    // Stored only as ciphertext, and still absent from the status payload.
    const stored = await query<{ key: string; value: string }>("SELECT key, value FROM settings");
    const token = stored.find((row) => row.key === "page_token");
    expect(token?.value).toBeDefined();
    expect(token?.value).not.toContain(fx.TOKEN);

    const statusText = await (await send(s, "GET", "/api/status")).text();
    expect(statusText).not.toContain(fx.TOKEN);
    expect(JSON.parse(statusText).hasToken).toBe(true);
  });
});

describe("watched posts", () => {
  it("baselines the comments already on a post before activating it", async () => {
    script({ comments: COMMENTS });
    const s = await connected("baseline-on");
    const res = await send(s, "POST", "/api/posts", { postId: fx.POST_ID });
    expect(res.status).toBe(200);
    expect((await bodyOf(res)).baseline).toEqual({ requested: true, applied: true, recorded: 2 });

    const rows = await query<{ comment_id: string; status: string; matched_reason: string }>(
      "SELECT comment_id, status, matched_reason FROM comments ORDER BY comment_id",
    );
    expect(rows.map((row) => row.comment_id)).toEqual(["c_existing_1", "c_existing_2"]);
    expect(rows.every((row) => row.status === "seen")).toBe(true);
    expect(rows[0]?.matched_reason).toContain("before CommentHide started watching");
    expect(await query("SELECT post_id, active FROM posts")).toEqual([
      { post_id: fx.POST_ID, active: 1 },
    ]);
    // Baselining must never write to Facebook.
    expect(graphState().hides).toEqual([]);
  });

  it("records nothing when the baseline is explicitly declined", async () => {
    script({ comments: COMMENTS });
    const s = await connected("baseline-off");
    const res = await send(s, "POST", "/api/posts", { postId: fx.POST_ID, baseline: false });
    expect(res.status).toBe(200);
    expect((await bodyOf(res)).baseline).toEqual({
      requested: false,
      applied: false,
      recorded: 0,
    });
    expect(await query("SELECT comment_id FROM comments")).toHaveLength(0);
  });

  it("returns the verdict the current rules would reach for each comment", async () => {
    const s = await connected("would-be");
    await send(s, "POST", "/api/posts", { postId: fx.POST_ID, baseline: false });
    const rule = await send(s, "POST", "/api/rules", {
      kind: "keyword",
      pattern: "promocode",
      action: "hide",
    });
    expect(rule.status).toBe(200);

    script({ comments: COMMENTS });
    const res = await send(s, "GET", `/api/posts/${fx.POST_ID}/comments`);
    const body = await bodyOf(res);
    const comments = body.comments as { id: string; wouldBe: string; status: string | null }[];
    expect(res.status).toBe(200);
    expect(comments.map((view) => [view.id, view.wouldBe])).toEqual([
      ["c_existing_1", "keep"],
      ["c_existing_2", "hide"],
    ]);
    expect(comments.every((view) => view.status === null)).toBe(true);
    expect(body.stats).toMatchObject({ total: 2, wouldHide: 1, wouldKeep: 1, untracked: 2 });
    // Reading a post must never hide anything by itself.
    expect(graphState().hides).toEqual([]);
  });

  it("deletes a watched post and refuses to delete one it never watched", async () => {
    const s = await connected("delete");
    await send(s, "POST", "/api/posts", { postId: fx.POST_ID, baseline: false });
    expect(await query("SELECT post_id FROM posts")).toHaveLength(1);

    const removed = await send(s, "DELETE", `/api/posts/${fx.POST_ID}`);
    expect(removed.status).toBe(200);
    expect(await bodyOf(removed)).toEqual({ ok: true });
    expect(await query("SELECT post_id FROM posts")).toHaveLength(0);
    expect(await bodyOf(await send(s, "GET", "/api/posts"))).toEqual({ posts: [] });

    const again = await send(s, "DELETE", `/api/posts/${fx.POST_ID}`);
    expect(again.status).toBe(404);
    expect((await bodyOf(again)).error).toBe("that post is not being watched");
  });
});

describe("error boundary", () => {
  it("reports an unexpected throw as a generic internal error", async () => {
    const noise = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const s = await session("throwing");
    // Dropping the table makes listPosts fail in a way no handler anticipates.
    await env.DB.prepare("DROP TABLE posts").run();

    const res = await send(s, "GET", "/api/posts");
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: "internal error" });
    expect(text).not.toContain("no such table");
    expect(text).not.toContain("posts");
    // The operator still gets the detail — on the server side only.
    expect(noise).toHaveBeenCalled();
  });
});
