// D1 storage-layer tests, part 2: comments, events, retention, auth throttle.
// Settings, posts and rules live in storage.test.ts; see the header there for
// why these suites talk to the real D1 binding rather than a mock.

import { beforeEach, describe, expect, it } from "vitest";

import * as store from "../src/lib/storage";
import {
  db,
  insertComment,
  insertEvent,
  resetDatabase,
  seedComments,
  T0,
} from "./storage-fixtures";

beforeEach(async () => {
  await resetDatabase();
});

describe("comments", () => {
  it("upserts by comment_id without rewriting first_seen_at or learned fields", async () => {
    await insertComment("c-1", "p-1", "seen", T0, "Ada Lovelace", "hello there");

    await store.recordComment(db, {
      comment_id: "c-1",
      post_id: "p-1",
      status: "hidden",
      matched_rule_id: 42,
      matched_reason: "Links",
      dry_run: true,
      actioned_at: T0 + 900,
    });

    const row = await store.getComment(db, "c-1");
    expect(row?.status).toBe("hidden");
    expect(row?.matched_rule_id).toBe(42);
    expect(row?.matched_reason).toBe("Links");
    expect(row?.dry_run).toBe(1);
    expect(row?.actioned_at).toBe(T0 + 900);
    expect(row?.first_seen_at).toBe(T0); // "new since" must never move
    expect(row?.author_name).toBe("Ada Lovelace");
    expect(row?.message_preview).toBe("hello there");
    expect((await store.listComments(db, "p-1")).length).toBe(1);
  });

  it("inserts a comment it has never seen before", async () => {
    await store.recordComment(db, {
      comment_id: "c-new",
      post_id: "p-1",
      status: "flagged",
      author_name: "Grace Hopper",
      matched_reason: "Contact details",
    });

    const row = await store.getComment(db, "c-new");
    expect(row?.status).toBe("flagged");
    expect(row?.author_name).toBe("Grace Hopper");
    expect(row?.dry_run).toBe(0);
    expect(row?.first_seen_at).toBeGreaterThan(0);
    expect(row?.actioned_at).toBeNull();
  });

  it("truncates an oversized preview instead of storing it whole", async () => {
    await store.recordComment(db, {
      comment_id: "c-long",
      post_id: "p-1",
      status: "seen",
      message_preview: "x".repeat(500),
    });

    const preview = (await store.getComment(db, "c-long"))?.message_preview ?? "";
    expect(preview.length).toBe(240);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("returns null for a comment id nobody has recorded", async () => {
    expect(await store.getComment(db, "nope")).toBeNull();
  });

  it("returns a map covering more ids than a single IN clause holds", async () => {
    const ids = await seedComments("p-bulk", 250);
    const probed = [...ids, "missing-1", "missing-2", ...ids.slice(0, 5), ""];

    const found = await store.getComments(db, probed);

    expect(found.size).toBe(250);
    // One id from each 100-id chunk, so a dropped batch cannot hide.
    for (const id of ["c-1", "c-100", "c-101", "c-200", "c-201", "c-250"]) {
      expect(found.get(id)?.comment_id).toBe(id);
    }
    expect(found.has("missing-1")).toBe(false);
    expect(found.has("")).toBe(false);
    expect(found.get("c-7")?.post_id).toBe("p-bulk");
    expect(await store.getComments(db, [])).toEqual(new Map());
  });

  it("lists a post's comments newest first and filters by status", async () => {
    await insertComment("a-1", "p-1", "hidden", T0 + 3);
    await insertComment("a-2", "p-1", "seen", T0 + 2);
    await insertComment("a-3", "p-1", "hidden", T0 + 1);
    await insertComment("b-1", "p-2", "hidden", T0 + 4);

    expect((await store.listComments(db, "p-1")).map((row) => row.comment_id)).toEqual([
      "a-1",
      "a-2",
      "a-3",
    ]);
    expect((await store.listComments(db, "p-1", 2)).map((row) => row.comment_id)).toEqual([
      "a-1",
      "a-2",
    ]);
    expect(
      (await store.listCommentsByStatus(db, "p-1", "hidden")).map((row) => row.comment_id),
    ).toEqual(["a-1", "a-3"]);
    expect(await store.listCommentsByStatus(db, "p-1", "error")).toEqual([]);
  });

  it("flips a hidden comment to restored and drops its stored failure", async () => {
    await store.recordComment(db, {
      comment_id: "c-r",
      post_id: "p-1",
      status: "hidden",
      error_message: "graph write failed",
    });
    expect((await store.getComment(db, "c-r"))?.error_message).toBe("graph write failed");

    await store.markRestored(db, "c-r");

    const row = await store.getComment(db, "c-r");
    expect(row?.status).toBe("restored");
    expect(row?.error_message).toBeNull();
    expect(row?.actioned_at).not.toBeNull();
  });

  it("counts every status key, zeros included, scoped to one post", async () => {
    expect(await store.countByStatus(db, "p-empty")).toEqual({
      seen: 0,
      hidden: 0,
      flagged: 0,
      skipped: 0,
      error: 0,
      restored: 0,
    });

    await insertComment("s-1", "p-1", "hidden", T0);
    await insertComment("s-2", "p-1", "hidden", T0);
    await insertComment("s-3", "p-1", "flagged", T0);
    await insertComment("s-4", "p-2", "hidden", T0);

    expect(await store.countByStatus(db, "p-1")).toEqual({
      seen: 0,
      hidden: 2,
      flagged: 1,
      skipped: 0,
      error: 0,
      restored: 0,
    });
  });
});

describe("events and retention", () => {
  it("appends events and reads them newest first", async () => {
    await store.logEvent(db, { level: "warn", action: "poll", post_id: "p-1", detail: "one" });
    await store.logEvent(db, { level: "error", action: "hide", error_message: "boom" });

    const events = await store.recentEvents(db);
    expect(events.map((event) => event.action)).toEqual(["hide", "poll"]);
    expect(events.at(0)?.level).toBe("error");
    expect(events.at(0)?.error_message).toBe("boom");
    expect(events.at(1)?.post_id).toBe("p-1");
    expect(events.at(1)?.detail).toBe("one");
    expect((await store.recentEvents(db, 1)).map((event) => event.action)).toEqual(["hide"]);
  });

  it("prunes old events and old non-hidden comments, sparing the audit trail", async () => {
    const cutoff = T0;

    await insertEvent(cutoff - 2, "old-a");
    await insertEvent(cutoff - 1, "old-b");
    await insertEvent(cutoff, "at-cutoff"); // strictly older only
    await insertEvent(cutoff + 1, "fresh");

    await insertComment("old-seen", "p-1", "seen", cutoff - 1);
    await insertComment("old-hidden", "p-1", "hidden", cutoff - 1);
    await insertComment("fresh-seen", "p-1", "seen", cutoff + 1);

    const pruned = await store.pruneHistory(db, cutoff);

    expect(pruned).toEqual({ events: 2, comments: 1 });
    expect((await store.recentEvents(db)).map((event) => event.action)).toEqual([
      "fresh",
      "at-cutoff",
    ]);
    expect(await store.getComment(db, "old-seen")).toBeNull();
    // Hidden rows are what makes "show this comment again" possible.
    expect(await store.getComment(db, "old-hidden")).not.toBeNull();
    expect(await store.getComment(db, "fresh-seen")).not.toBeNull();
  });

  it("deletes nothing when there is nothing old enough", async () => {
    await insertEvent(T0 + 10, "fresh");
    await insertComment("fresh-only", "p-1", "seen", T0 + 10);

    expect(await store.pruneHistory(db, T0)).toEqual({ events: 0, comments: 0 });
    expect((await store.recentEvents(db)).length).toBe(1);
  });
});

describe("auth throttle", () => {
  const fp = "fingerprint-a";

  it("matches the throttle policy the contract pins down", () => {
    // Asserted as literals on purpose: the numbers are policy, and a silent
    // loosening of them would otherwise slip past every test below.
    expect(store.AUTH_MAX_FAILURES).toBe(8);
    expect(store.AUTH_WINDOW_MS).toBe(15 * 60 * 1000);
    expect(store.AUTH_LOCK_MS).toBe(15 * 60 * 1000);
  });

  it("counts failures and locks on the configured threshold", async () => {
    expect(await store.getAuthLock(db, fp, T0)).toEqual({ failures: 0, lockedUntil: null });

    for (let attempt = 1; attempt < store.AUTH_MAX_FAILURES; attempt += 1) {
      expect(await store.recordAuthFailure(db, fp, T0)).toEqual({
        failures: attempt,
        lockedUntil: null,
      });
    }

    const locked = await store.recordAuthFailure(db, fp, T0);
    expect(locked).toEqual({
      failures: store.AUTH_MAX_FAILURES,
      lockedUntil: T0 + store.AUTH_LOCK_MS,
    });
    expect(await store.getAuthLock(db, fp, T0 + 1)).toEqual(locked);
  });

  it("does not let extra attempts push an active lock further out", async () => {
    for (let attempt = 0; attempt < store.AUTH_MAX_FAILURES; attempt += 1) {
      await store.recordAuthFailure(db, fp, T0);
    }

    const again = await store.recordAuthFailure(db, fp, T0 + 60_000);
    expect(again.lockedUntil).toBe(T0 + store.AUTH_LOCK_MS);
    expect(again.failures).toBe(store.AUTH_MAX_FAILURES);
  });

  it("treats an expired lock as a clean slate", async () => {
    for (let attempt = 0; attempt < store.AUTH_MAX_FAILURES; attempt += 1) {
      await store.recordAuthFailure(db, fp, T0);
    }

    expect(await store.getAuthLock(db, fp, T0 + store.AUTH_LOCK_MS)).toEqual({
      failures: 0,
      lockedUntil: null,
    });
    expect(await store.recordAuthFailure(db, fp, T0 + store.AUTH_LOCK_MS)).toEqual({
      failures: 1,
      lockedUntil: null,
    });
  });

  it("restarts the count once the window has run out", async () => {
    await store.recordAuthFailure(db, fp, T0);
    await store.recordAuthFailure(db, fp, T0 + 1_000);
    expect((await store.getAuthLock(db, fp, T0 + 2_000)).failures).toBe(2);

    expect(await store.recordAuthFailure(db, fp, T0 + store.AUTH_WINDOW_MS)).toEqual({
      failures: 1,
      lockedUntil: null,
    });
  });

  it("clears one fingerprint on success without touching the others", async () => {
    await store.recordAuthFailure(db, fp, T0);
    await store.recordAuthFailure(db, "fingerprint-b", T0);

    await store.clearAuthFailures(db, fp);

    expect(await store.getAuthLock(db, fp, T0)).toEqual({ failures: 0, lockedUntil: null });
    expect((await store.getAuthLock(db, "fingerprint-b", T0)).failures).toBe(1);
  });
});
