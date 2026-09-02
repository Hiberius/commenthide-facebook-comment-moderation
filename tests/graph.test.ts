// CommentHide — Graph API client tests.
//
// Every test injects a fake fetch and a no-op sleep, so the suite never touches
// the network and never waits out a backoff. Each case declares the exact
// sequence of Graph replies it expects: an unplanned extra call runs off the end
// of that queue and surfaces as a call-count failure rather than passing quietly.

import { describe, expect, it } from "vitest";

import { GraphClient, isRetryable, normalizePostInput } from "../src/lib/graph";
import type { GraphComment, GraphErr, GraphResult, ResolvedTarget } from "../src/types";

const TOKEN = "EAAtest-page-access-token-not-a-real-secret";
const PAGE_TOKEN = "EAApage-token-for-the-managed-page";
const OTHER_TOKEN = "EAAsome-other-page-token";
const PAGE_ID = "1000000000001";
const STORY_ID = "2000000000002";
const POST_ID = `${PAGE_ID}_${STORY_ID}`;
const USER_ID = "5550000000005";
const OTHER_PAGE_ID = "7770000000007";

// Frozen: nothing in the client may write back into a caller's target.
const TARGET: ResolvedTarget = Object.freeze({
  input: POST_ID,
  postId: POST_ID,
  pageId: PAGE_ID,
  accessToken: TOKEN,
});

/** Paging cursors exactly as Graph hands them back — token baked into the query. */
const NEXT_2 = `https://graph.facebook.com/v25.0/${POST_ID}/comments?access_token=${TOKEN}&after=CURSOR_1`;
const NEXT_3 = `https://graph.facebook.com/v25.0/${POST_ID}/comments?access_token=${TOKEN}&after=CURSOR_2`;

// --- Test doubles ----------------------------------------------------------

interface Reply {
  status?: number;
  body?: unknown;
  /** Simulates a transport-level failure (DNS, dropped socket). */
  error?: Error;
}

/** What the fake fetch recorded about one outgoing request. */
interface GraphCall {
  url: string;
  method: string;
  authorization: string | null;
  body: string;
}

function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  const candidate = typeof input === "object" && input !== null ? (input as { url?: unknown }).url : null;
  if (typeof candidate === "string") return candidate;
  throw new Error("Fake fetch received an input it does not understand.");
}

function stringField(source: unknown, key: string): string {
  if (typeof source !== "object" || source === null) return "";
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function authOf(init: unknown): string | null {
  if (typeof init !== "object" || init === null) return null;
  const value = stringField((init as { headers?: unknown }).headers, "authorization");
  return value === "" ? null : value;
}

/**
 * Retries default to 0 so a stray call cannot hide inside a backoff loop; the
 * retry suite opts back in explicitly.
 */
function makeClient(replies: readonly Reply[], opts: { maxRetries?: number } = {}) {
  const calls: GraphCall[] = [];
  const delays: number[] = [];
  const fetchImpl = (async (input: unknown, init?: unknown): Promise<Response> => {
    const url = urlOf(input);
    const index = calls.length;
    calls.push({
      url,
      method: stringField(init, "method"),
      authorization: authOf(init),
      body: stringField(init, "body"),
    });
    const reply = replies[index];
    if (reply === undefined) throw new Error(`Unexpected Graph call #${index + 1}: ${url}`);
    if (reply.error !== undefined) throw reply.error;
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const client = new GraphClient(TOKEN, {
    fetchImpl,
    maxRetries: opts.maxRetries ?? 0,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  });
  return { client, calls, delays };
}

// Reply factories — one Graph shape each, so the tests read as scenarios.
const identity = (id: string): Reply => ({ body: { id, name: "Demo Page" } });
const accounts = (...pages: readonly Record<string, string>[]): Reply => ({ body: { data: pages } });
const graphError = (status: number, error: Record<string, unknown>): Reply => ({ status, body: { error } });
const page = (comments: readonly GraphComment[], next?: string): Reply => ({
  body: { data: comments, ...(next === undefined ? {} : { paging: { next } }) },
});

function comment(id: string, extra: Partial<GraphComment> = {}): GraphComment {
  return { id, message: `message from ${id}`, ...extra };
}

/** Indexed access under noUncheckedIndexedAccess, failing loudly instead of undefined. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`No element at index ${index} (length ${items.length}).`);
  return item;
}

function expectOk<T>(result: GraphResult<T>): T {
  if (!result.ok) throw new Error(`Expected success, got Graph error: ${result.message}`);
  return result.data;
}

function expectErr<T>(result: GraphResult<T>): GraphErr {
  if (result.ok) throw new Error(`Expected a Graph error, got: ${JSON.stringify(result.data)}`);
  return result;
}

const ids = (comments: readonly GraphComment[]): string[] => comments.map((c) => c.id);

const PFBID_URL = "https://facebook.com/CommentHideDemo/posts/pfbid0FakeOpaqueValue";

const NORMALIZE_CASES: ReadonlyArray<readonly [string, string, string]> = [
  ["a bare numeric id, trimmed", `  ${STORY_ID}  `, STORY_ID],
  ["a PAGEID_POSTID pair", POST_ID, POST_ID],
  ["story_fbid joined to its owner", `https://facebook.com/permalink.php?story_fbid=${STORY_ID}&id=${PAGE_ID}`, POST_ID],
  ["a bare fbid when no owner is named", "https://facebook.com/photo/?fbid=987654321", "987654321"],
  ["a numeric /posts/ path", `https://facebook.com/${PAGE_ID}/posts/${STORY_ID}/`, POST_ID],
  ["a vanity /posts/ path", `https://facebook.com/CommentHideDemo/posts/${STORY_ID}`, STORY_ID],
  ["an opaque pfbid link, left for the caller to reject", PFBID_URL, "pfbid0FakeOpaqueValue"],
];

describe("normalizePostInput", () => {
  it.each(NORMALIZE_CASES)("normalises %s", (_label, input, expected) => {
    expect(normalizePostInput(input)).toBe(expected);
  });
});

describe("GraphClient.resolveTarget", () => {
  it("resolves once and serves the memoised answer afterwards", async () => {
    const { client, calls } = makeClient([identity(PAGE_ID)]);

    const first = await client.resolveTarget(POST_ID);
    const second = await client.resolveTarget(POST_ID);

    // Identity is memoised too, so a call count alone cannot tell a cache hit
    // from a re-resolution. Reference identity can: only the memo hands back the
    // very object the first resolution produced.
    expect(second).toBe(first);
    const target = expectOk(first);
    expect(target.postId).toBe(POST_ID);
    expect(target.pageId).toBe(PAGE_ID);
    expect(target.accessToken).toBe(TOKEN);
    expect(calls).toHaveLength(1);
    expect(at(calls, 0).url).toContain("/v25.0/me?");
  });

  it("completes a bare post id with the page the token represents", async () => {
    const { client } = makeClient([identity(PAGE_ID)]);
    expect(expectOk(await client.resolveTarget(STORY_ID)).postId).toBe(POST_ID);
  });

  it("looks the page token up via /me/accounts when /me is not the owning page", async () => {
    const { client, calls } = makeClient([
      identity(USER_ID),
      accounts(
        { id: OTHER_PAGE_ID, access_token: OTHER_TOKEN },
        { id: PAGE_ID, access_token: PAGE_TOKEN },
      ),
    ]);

    const target = expectOk(await client.resolveTarget(POST_ID));

    expect(target.accessToken).toBe(PAGE_TOKEN);
    expect(target.pageId).toBe(PAGE_ID);
    expect(calls).toHaveLength(2);
    expect(at(calls, 1).url).toContain("/me/accounts?");
  });

  it("says the token does not manage the page when /me/accounts omits it", async () => {
    const { client, calls } = makeClient([
      identity(USER_ID),
      accounts({ id: OTHER_PAGE_ID, access_token: OTHER_TOKEN }),
    ]);

    const err = expectErr(await client.resolveTarget(POST_ID));

    expect(err.status).toBe(403);
    expect(err.code).toBe("page_not_managed");
    expect(err.message).toContain(PAGE_ID);
    expect(calls).toHaveLength(2);
  });

  it("refuses a pfbid link without touching the network", async () => {
    const { client, calls } = makeClient([]);

    const err = expectErr(await client.resolveTarget(PFBID_URL));

    expect(err.code).toBe("opaque_post_id");
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/Recent Posts/);
    expect(calls).toHaveLength(0);
  });

  it("rejects an empty post id without touching the network", async () => {
    const { client, calls } = makeClient([]);
    expect(expectErr(await client.resolveTarget("   ")).code).toBe("empty_post_id");
    expect(calls).toHaveLength(0);
  });
});

describe("GraphClient.fetchComments", () => {
  it("follows paging.next and stops at maxPages", async () => {
    const { client, calls } = makeClient([
      page([comment("c1"), comment("c2")], NEXT_2),
      page([comment("c3")], NEXT_3),
    ]);

    const comments = expectOk(await client.fetchComments(TARGET, { maxPages: 2 }));

    expect(ids(comments)).toEqual(["c1", "c2", "c3"]);
    expect(calls).toHaveLength(2);
    expect(at(calls, 0).url).toContain("filter=stream");
    expect(at(calls, 1).url).toContain("after=CURSOR_1");
  });

  it("stops as soon as a page carries no paging.next", async () => {
    const { client, calls } = makeClient([page([comment("c1")])]);
    expect(expectOk(await client.fetchComments(TARGET, { maxPages: 3 }))).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("keeps a single copy of a comment repeated across pages", async () => {
    const { client } = makeClient([
      page([comment("c1"), comment("c2")], NEXT_2),
      page([comment("c2"), comment("c3")]),
    ]);

    const comments = expectOk(await client.fetchComments(TARGET, { maxPages: 3 }));

    expect(ids(comments)).toEqual(["c1", "c2", "c3"]);
  });

  it("fetches replies only for comments that report a reply count", async () => {
    const { client, calls } = makeClient([
      page([comment("c1", { comment_count: 2 }), comment("c2", { comment_count: 0 }), comment("c3")]),
      page([comment("c1_r1"), comment("c1_r2")]),
    ]);

    const comments = expectOk(await client.fetchComments(TARGET, { includeReplies: true }));

    expect(ids(comments)).toEqual(["c1", "c2", "c3", "c1_r1", "c1_r2"]);
    expect(calls).toHaveLength(2);
    expect(at(calls, 1).url).toContain("/c1/comments?");
    expect(calls.some((c) => c.url.includes("/c2/comments"))).toBe(false);
    expect(calls.some((c) => c.url.includes("/c3/comments"))).toBe(false);
  });

  it("leaves replies alone when includeReplies is off", async () => {
    const { client, calls } = makeClient([page([comment("c1", { comment_count: 4 })])]);
    expect(expectOk(await client.fetchComments(TARGET))).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("surfaces a page failure instead of returning a partial list", async () => {
    const { client } = makeClient([
      page([comment("c1")], NEXT_2),
      graphError(400, { message: "Unsupported get request.", code: 100 }),
    ]);
    expect(expectErr(await client.fetchComments(TARGET, { maxPages: 3 })).code).toBe(100);
  });
});

describe("GraphClient retry behaviour", () => {
  it("retries a 429 and returns the success that follows", async () => {
    const { client, calls, delays } = makeClient(
      [graphError(429, { message: "Application request limit reached." }), identity(PAGE_ID)],
      { maxRetries: 3 },
    );

    expect(expectOk(await client.identity()).id).toBe(PAGE_ID);
    expect(calls).toHaveLength(2);
    expect(delays).toHaveLength(1);
    expect(at(delays, 0)).toBeGreaterThan(0);
  });

  it("retries a dropped connection", async () => {
    const { client, calls, delays } = makeClient(
      [{ error: new TypeError("Network connection lost") }, identity(PAGE_ID)],
      { maxRetries: 3 },
    );

    expect(expectOk(await client.identity()).id).toBe(PAGE_ID);
    expect(calls).toHaveLength(2);
    expect(delays).toHaveLength(1);
  });

  it("returns a non-retryable 400 immediately, after exactly one call", async () => {
    const body = { message: "Unsupported get request.", code: 100, type: "GraphMethodException" };
    const { client, calls, delays } = makeClient([graphError(400, body)], { maxRetries: 3 });

    const err = expectErr(await client.identity());

    expect(err.status).toBe(400);
    expect(err.code).toBe(100);
    expect(err.retryable).toBe(false);
    expect(calls).toHaveLength(1);
    expect(delays).toHaveLength(0);
  });

  it("gives up once maxRetries is spent and reports the last failure", async () => {
    const down: Reply = { status: 503 };
    const { client, calls, delays } = makeClient([down, down, down], { maxRetries: 2 });

    expect(expectErr(await client.identity()).retryable).toBe(true);
    expect(calls).toHaveLength(3);
    expect(delays).toHaveLength(2);
  });
});

describe("GraphClient token handling", () => {
  it("never puts the token in a request URL, not even one Graph handed back", async () => {
    const { client, calls } = makeClient([
      identity(PAGE_ID),
      page([comment("c1")], NEXT_2),
      page([comment("c2")]),
      { body: { success: true } },
    ]);

    const target = expectOk(await client.resolveTarget(POST_ID));
    expectOk(await client.fetchComments(target));
    expect(expectOk(await client.setHidden(target, "c1", true)).success).toBe(true);

    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.url).not.toContain(TOKEN);
      expect(new URL(call.url).searchParams.has("access_token")).toBe(false);
    }
    // Reads authenticate with a header; the write carries the token in the body.
    expect(at(calls, 1).authorization).toBe(`Bearer ${TOKEN}`);
    expect(at(calls, 3).method).toBe("POST");
    const form = new URLSearchParams(at(calls, 3).body);
    expect(form.get("access_token")).toBe(TOKEN);
    expect(form.get("is_hidden")).toBe("true");
  });

  it("redacts the token out of a message Graph echoed back", async () => {
    const echoed = { message: `Invalid OAuth access token "${TOKEN}".`, code: 2500 };
    const { client } = makeClient([graphError(400, echoed)]);

    const err = expectErr(await client.identity());

    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain("[redacted]");
  });

  it("turns error 190 into an actionable instruction", async () => {
    const expired = { message: "Error validating access token: Session has expired.", code: 190 };
    const { client } = makeClient([graphError(400, expired)]);

    const err = expectErr(await client.identity());

    expect(err.code).toBe(190);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("Error validating access token");
    expect(err.message).toContain("invalid or has expired");
    expect(err.message).toContain("Generate a fresh token");
  });
});

describe("isRetryable", () => {
  it("accepts the documented transient codes and HTTP statuses", () => {
    expect(isRetryable(429)).toBe(true);
    expect(isRetryable(503)).toBe(true);
    expect(isRetryable(400, 4)).toBe(true);
    expect(isRetryable(400, "17")).toBe(true);
    expect(isRetryable(200, 613)).toBe(true);
  });
  it("rejects permanent failures", () => {
    expect(isRetryable(400, 100)).toBe(false);
    expect(isRetryable(403, 190)).toBe(false);
    expect(isRetryable(404)).toBe(false);
  });
});
