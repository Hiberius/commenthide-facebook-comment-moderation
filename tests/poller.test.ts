// CommentHide — poll orchestration tests.
//
// The network is stubbed at `globalThis.fetch` rather than by mocking ./graph:
// runPoll builds its own GraphClient and offers no fetch seam, so stubbing the
// global keeps the real client in the loop — URL building, auth placement,
// Graph error parsing and token redaction are exercised, not mocked away.

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encryptToken } from "../src/lib/crypto";
import { runPoll } from "../src/lib/poller";
import { runRetention } from "../src/lib/retention";
import {
  createRule, getComment, getPost, getRule, recentEvents, recordComment, setSetting,
  upsertPost, type UpsertPostInput,
} from "../src/lib/storage";
import type { CommentStatus, GraphComment, PollSummary } from "../src/types";

const PAGE_ID = "PAGE1";
const POST_ID = "PAGE1_POST1";
const TOKEN = "test-page-access-token";
const SPAM_TERM = "promocode";
const FLAG_TERM = "review";
const ALLOWED_AUTHOR = "Trusted Reviewer";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Graph stub ---------------------------------------------------------------

interface HideOutcome { readonly status: number; readonly body: unknown }

interface GraphStubOptions {
  readonly comments?: readonly GraphComment[];
  /** Canned answers for the hide POST, keyed by comment id. */
  readonly hide?: Readonly<Record<string, HideOutcome>>;
}

/** Every request the client made, and the ids it asked to hide, in order. */
interface GraphStub {
  readonly calls: { method: string; path: string }[];
  readonly hideCalls: string[];
}

function jsonResponse(body: unknown, status = 200): Response {
  const headers = { "content-type": "application/json" };
  return new Response(JSON.stringify(body), { status, headers });
}

function installGraphStub(opts: GraphStubOptions = {}): GraphStub {
  const comments = opts.comments ?? [];
  const calls: { method: string; path: string }[] = [];
  const hideCalls: string[] = [];

  const impl: typeof fetch = async (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const path = new URL(href).pathname.replace(/^\/v[^/]+\//, "");
    calls.push({ method, path });

    if (method === "GET" && path === "me") return jsonResponse({ id: PAGE_ID, name: "Test Page" });
    if (method === "GET" && path === `${POST_ID}/comments`) return jsonResponse({ data: comments });
    if (method === "POST") {
      hideCalls.push(path);
      const outcome = opts.hide?.[path];
      if (outcome === undefined) return jsonResponse({ success: true });
      return jsonResponse(outcome.body, outcome.status);
    }
    // An unexpected edge means the fixture is wrong; make it loud, not silent.
    return jsonResponse({ error: { message: `unstubbed ${method} /${path}`, code: 100 } }, 400);
  };

  vi.stubGlobal("fetch", impl);
  return { calls, hideCalls };
}

// Fixtures -----------------------------------------------------------------

const ZERO_SUMMARY: PollSummary = {
  fetched: 0, hidden: 0, flagged: 0, skipped: 0, errors: 0, dryRun: false,
};

/** Asserts the whole summary: every field not named here must still be zero. */
function expectSummary(actual: PollSummary, expected: Partial<PollSummary>): void {
  expect(actual).toEqual({ ...ZERO_SUMMARY, ...expected });
}

type CommentPatch = Partial<Omit<GraphComment, "id">>;

function comment(id: string, message: string, extra: CommentPatch = {}): GraphComment {
  const from = { id: `${id}-author`, name: "Ordinary Visitor" };
  const created_time = "2025-01-01T00:00:00+0000";
  return { id, message, created_time, from, can_hide: true, is_hidden: false, ...extra };
}

/** A comment whose text trips the keyword hide rule. */
function spam(id: string, extra: CommentPatch = {}): GraphComment {
  return comment(id, `Use ${SPAM_TERM} today`, extra);
}

const ALLOWED_BY = { from: { id: "u-allowed", name: ALLOWED_AUTHOR } };

async function storeToken(): Promise<void> {
  await setSetting(env.DB, "page_token", await encryptToken(TOKEN, env.ENCRYPTION_KEY));
}

function watchPost(overrides: Omit<Partial<UpsertPostInput>, "post_id"> = {}) {
  return upsertPost(env.DB, { post_id: POST_ID, page_id: PAGE_ID, active: true, ...overrides });
}

function hideKeywordRule() {
  const label = "Spam keyword";
  return createRule(env.DB, { kind: "keyword", pattern: SPAM_TERM, action: "hide", label });
}

function flagKeywordRule() {
  const label = "Needs a human";
  return createRule(env.DB, { kind: "keyword", pattern: FLAG_TERM, action: "flag", label });
}

function allowAuthorRule() {
  const kind = "author_allow";
  return createRule(env.DB, { kind, pattern: ALLOWED_AUTHOR, action: "allow", label: "Allowlist" });
}

async function eventActions(): Promise<string[]> {
  return (await recentEvents(env.DB, 200)).map((row) => row.action);
}

async function eventDetails(action: string): Promise<string[]> {
  const rows = await recentEvents(env.DB, 200);
  return rows.filter((row) => row.action === action).map((row) => row.detail ?? "");
}

async function seedEvent(ts: number, action: string): Promise<void> {
  const sql = "INSERT INTO events (ts, level, action) VALUES (?, 'info', ?)";
  await env.DB.prepare(sql).bind(ts, action).run();
}

async function seedComment(id: string, status: CommentStatus, firstSeenAt: number): Promise<void> {
  const sql = `INSERT INTO comments (comment_id, post_id, status, dry_run, first_seen_at)
               VALUES (?, ?, ?, 0, ?)`;
  await env.DB.prepare(sql).bind(id, POST_ID, status, firstSeenAt).run();
}

beforeEach(async () => {
  // Literal table names — never derived from anything a test controls.
  const tables = ["comments", "events", "rules", "posts", "settings"];
  await env.DB.batch(tables.map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
});

afterEach(() => vi.unstubAllGlobals());

// runPoll ------------------------------------------------------------------

describe("runPoll", () => {
  it("returns zeros and logs no_token when no token is stored", async () => {
    const stub = installGraphStub();
    await watchPost();
    const summary = await runPoll(env);

    expectSummary(summary, {});
    expect(stub.calls).toHaveLength(0);
    expect(await eventDetails("poll")).toContain("no_token");
  });

  it("hides a rule match, keeps an allowed author and keeps an unmatched comment", async () => {
    await storeToken();
    await watchPost();
    const hideRule = await hideKeywordRule();
    const allowRule = await allowAuthorRule();
    const praise = comment("c-plain", "Lovely photo, thank you");
    const stub = installGraphStub({
      comments: [spam("c-spam"), spam("c-allowed", ALLOWED_BY), praise],
    });
    const summary = await runPoll(env);

    expectSummary(summary, { fetched: 3, hidden: 1 });
    expect(stub.hideCalls).toEqual(["c-spam"]);

    const hidden = await getComment(env.DB, "c-spam");
    expect(hidden?.status).toBe("hidden");
    expect(hidden?.matched_rule_id).toBe(hideRule.id);
    expect(hidden?.actioned_at).not.toBeNull();

    const allowed = await getComment(env.DB, "c-allowed");
    expect(allowed?.status).toBe("seen");
    expect(allowed?.matched_rule_id).toBe(allowRule.id);
    expect(allowed?.matched_reason).toMatch(/^Allowed/);

    const kept = await getComment(env.DB, "c-plain");
    expect(kept?.status).toBe("seen");
    expect(kept?.matched_rule_id).toBeNull();
  });

  it("does not re-process a comment already recorded as hidden", async () => {
    await storeToken();
    await watchPost();
    await hideKeywordRule();
    const stub = installGraphStub({ comments: [spam("c-spam"), comment("c-plain", "Nice one")] });
    expectSummary(await runPoll(env), { fetched: 2, hidden: 1 });
    expect(stub.hideCalls).toHaveLength(1);
    expectSummary(await runPoll(env), { fetched: 2 });

    expect(stub.hideCalls).toHaveLength(1);
    expect((await getComment(env.DB, "c-spam"))?.status).toBe("hidden");
  });

  it("retries a comment recorded as error but leaves a settled comment alone", async () => {
    await storeToken();
    await watchPost();
    await hideKeywordRule();
    await recordComment(env.DB, {
      comment_id: "c-retry",
      post_id: POST_ID,
      status: "error",
      error_message: "Graph refused the hide last time",
    });
    await recordComment(env.DB, { comment_id: "c-settled", post_id: POST_ID, status: "seen" });
    const stub = installGraphStub({ comments: [spam("c-retry"), spam("c-settled")] });
    const summary = await runPoll(env);

    expectSummary(summary, { fetched: 2, hidden: 1 });
    expect(stub.hideCalls).toEqual(["c-retry"]);
    const retried = await getComment(env.DB, "c-retry");
    expect(retried?.status).toBe("hidden");
    expect(retried?.error_message).toBeNull();
    expect((await getComment(env.DB, "c-settled"))?.status).toBe("seen");
  });

  it("records a dry-run decision with dry_run = 1 and performs no Graph write", async () => {
    await storeToken();
    await watchPost({ dry_run: true });
    const rule = await hideKeywordRule();
    await flagKeywordRule();
    const flag = comment("c-flag", `Please ${FLAG_TERM} this`);
    const stub = installGraphStub({ comments: [spam("c-spam"), flag] });
    const summary = await runPoll(env);

    expectSummary(summary, { fetched: 2, hidden: 1, flagged: 1, dryRun: true });
    expect(stub.hideCalls).toHaveLength(0);
    const row = await getComment(env.DB, "c-spam");
    expect(row?.status).toBe("seen");
    expect(row?.dry_run).toBe(1);
    expect(row?.matched_rule_id).toBe(rule.id);

    // A preview must not move lifetime totals, flags included.
    const post = await getPost(env.DB, POST_ID);
    expect(post?.total_hidden).toBe(0);
    expect(post?.total_flagged).toBe(0);
    expect(post?.last_hidden_at).toBeNull();
  });

  it("forceDryRun suppresses the Graph write on a post configured to hide", async () => {
    await storeToken();
    await watchPost({ dry_run: false });
    await hideKeywordRule();
    const stub = installGraphStub({ comments: [spam("c-spam")] });
    const summary = await runPoll(env, { forceDryRun: true, manual: true });

    expectSummary(summary, { fetched: 1, hidden: 1, dryRun: true });
    expect(stub.hideCalls).toHaveLength(0);
    expect((await getComment(env.DB, "c-spam"))?.dry_run).toBe(1);
    expect(await eventActions()).toContain("poll_manual");
  });

  it("records a flag decision without ever calling the Graph API", async () => {
    await storeToken();
    await watchPost();
    const rule = await flagKeywordRule();
    const stub = installGraphStub({ comments: [comment("c-flag", `Please ${FLAG_TERM} this`)] });
    const summary = await runPoll(env);

    expectSummary(summary, { fetched: 1, flagged: 1 });
    expect(stub.hideCalls).toHaveLength(0);
    const row = await getComment(env.DB, "c-flag");
    expect(row?.status).toBe("flagged");
    expect(row?.matched_rule_id).toBe(rule.id);
    expect(row?.actioned_at).not.toBeNull();
    expect((await getPost(env.DB, POST_ID))?.total_flagged).toBe(1);
  });

  it("records a comment Facebook refuses to hide as skipped", async () => {
    await storeToken();
    await watchPost();
    await hideKeywordRule();
    const stub = installGraphStub({
      comments: [spam("c-nohide", { can_hide: false }), spam("c-already", { is_hidden: true })],
    });
    const summary = await runPoll(env);

    expectSummary(summary, { fetched: 2, skipped: 2 });
    expect(stub.hideCalls).toHaveLength(0);
    const refused = await getComment(env.DB, "c-nohide");
    expect(refused?.status).toBe("skipped");
    expect(refused?.matched_reason).toContain("cannot be hidden");

    const already = await getComment(env.DB, "c-already");
    expect(already?.status).toBe("skipped");
    expect(already?.matched_reason).toContain("already hidden");
  });

  it("records one failing comment as error and still processes the rest", async () => {
    await storeToken();
    await watchPost();
    await hideKeywordRule();
    // The token is echoed back, so the redaction guarantee is under test too.
    const error = { message: `Hide refused for token ${TOKEN}`, code: 100 };
    const stub = installGraphStub({
      comments: [spam("c-bad"), spam("c-ok")],
      hide: { "c-bad": { status: 400, body: { error } } },
    });
    const summary = await runPoll(env);

    expectSummary(summary, { fetched: 2, hidden: 1, errors: 1 });
    expect(stub.hideCalls).toEqual(["c-bad", "c-ok"]);

    const failed = await getComment(env.DB, "c-bad");
    expect(failed?.status).toBe("error");
    expect(failed?.error_message).toContain("[redacted]");
    expect(failed?.error_message).not.toContain(TOKEN);
    expect((await getComment(env.DB, "c-ok"))?.status).toBe("hidden");
    expect((await getPost(env.DB, POST_ID))?.total_hidden).toBe(1);
    expect(await eventActions()).toContain("hide_failed");
  });

  it("increments post counters and rule hit counts", async () => {
    await storeToken();
    await watchPost();
    const hideRule = await hideKeywordRule();
    const allowRule = await allowAuthorRule();
    const startedAt = Date.now();
    installGraphStub({
      comments: [spam("c-spam-1"), spam("c-spam-2"), spam("c-allowed", ALLOWED_BY)],
    });
    expectSummary(await runPoll(env), { fetched: 3, hidden: 2 });

    const post = await getPost(env.DB, POST_ID);
    expect(post?.total_hidden).toBe(2);
    expect(post?.total_flagged).toBe(0);
    expect(post?.last_hidden_at ?? 0).toBeGreaterThanOrEqual(startedAt);
    expect(post?.last_checked_at ?? 0).toBeGreaterThanOrEqual(startedAt);
    expect((await getRule(env.DB, hideRule.id))?.hit_count).toBe(2);
    expect((await getRule(env.DB, allowRule.id))?.hit_count).toBe(1);
  });

  it("onlyPostId polls a post that is not active", async () => {
    await storeToken();
    await watchPost({ active: false });
    await hideKeywordRule();
    const stub = installGraphStub({ comments: [spam("c-spam")] });
    expectSummary(await runPoll(env), {});
    expect(stub.calls).toHaveLength(0);
    expect(await eventDetails("poll")).toContain("no_active_posts");
    const targeted = await runPoll(env, { onlyPostId: POST_ID });

    expectSummary(targeted, { fetched: 1, hidden: 1 });
    expect(stub.hideCalls).toEqual(["c-spam"]);
  });
});

// runRetention -------------------------------------------------------------

describe("runRetention", () => {
  it("prunes nothing when RETENTION_DAYS is unset or switched off", async () => {
    const now = Date.now();
    await seedEvent(now - 30 * DAY_MS, "ancient-event");
    await seedComment("c-ancient", "seen", now - 30 * DAY_MS);

    for (const days of [undefined, "", "0", "-5", "not-a-number"]) {
      const pruned = await runRetention({ ...env, RETENTION_DAYS: days }, now);
      expect(pruned).toEqual({ events: 0, comments: 0 });
    }

    expect(await eventActions()).toContain("ancient-event");
    expect(await getComment(env.DB, "c-ancient")).not.toBeNull();
  });

  it("deletes old events and non-hidden comments while keeping hidden ones", async () => {
    const now = Date.now();
    await seedEvent(now - 30 * DAY_MS, "ancient-event");
    await seedEvent(now - HOUR_MS, "recent-event");
    await seedComment("c-old-seen", "seen", now - 30 * DAY_MS);
    await seedComment("c-old-hidden", "hidden", now - 30 * DAY_MS);
    await seedComment("c-new-seen", "seen", now - HOUR_MS);

    const result = await runRetention({ ...env, RETENTION_DAYS: "7" }, now);

    expect(result).toEqual({ events: 1, comments: 1 });
    const actions = await eventActions();
    expect(actions).not.toContain("ancient-event");
    expect(actions).toContain("recent-event");
    expect(actions).toContain("retention");

    // Hidden comments are the undo trail, so retention must never take them.
    expect(await getComment(env.DB, "c-old-hidden")).not.toBeNull();
    expect(await getComment(env.DB, "c-new-seen")).not.toBeNull();
    expect(await getComment(env.DB, "c-old-seen")).toBeNull();
  });
});
