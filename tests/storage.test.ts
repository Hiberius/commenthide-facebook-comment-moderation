// D1 storage-layer tests, part 1: settings, posts, rules.
//
// These run against the real D1 binding from @cloudflare/vitest-pool-workers,
// never a mock, because what is worth proving here is the SQL itself: the
// upsert merge semantics, the MAX() clamping, the scoped rule ordering. A
// hand-rolled fake would happily agree with a wrong query.
//
// Comments, events, retention and the auth throttle live in
// storage-comments.test.ts — one file could not hold both halves.

import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_RULES } from "../src/lib/rules";
// Namespace import: the alternative is a forty-line named-import block for a
// surface these two files exercise end to end.
import * as store from "../src/lib/storage";
import { db, insertComment, resetDatabase, T0 } from "./storage-fixtures";

beforeEach(async () => {
  await resetDatabase();
});

describe("settings", () => {
  it("returns null for a key that was never written", async () => {
    expect(await store.getSetting(db, "page_token")).toBeNull();
  });

  it("round-trips a value, overwrites it, then deletes it", async () => {
    await store.setSetting(db, "page_name", "First Page");
    expect(await store.getSetting(db, "page_name")).toBe("First Page");

    await store.setSetting(db, "page_name", "Renamed Page");
    expect(await store.getSetting(db, "page_name")).toBe("Renamed Page");

    await store.deleteSetting(db, "page_name");
    expect(await store.getSetting(db, "page_name")).toBeNull();
  });

  it("keeps keys independent and tolerates deleting a missing key", async () => {
    await store.setSetting(db, "page_id", "1234");
    await expect(store.deleteSetting(db, "never_written")).resolves.toBeUndefined();
    expect(await store.getSetting(db, "page_id")).toBe("1234");
  });
});

describe("posts", () => {
  it("inserts on the first upsert and merges on the second without clobbering", async () => {
    const created = await store.upsertPost(db, {
      post_id: "100_1",
      page_id: "100",
      label: "Launch post",
      permalink_url: "https://www.facebook.com/100/posts/1",
      active: true,
      mode: "hide_all",
      dry_run: true,
      include_replies: true,
    });

    expect(created.label).toBe("Launch post");
    expect(created.active).toBe(1);
    expect(created.mode).toBe("hide_all");
    expect(created.dry_run).toBe(1);
    expect(created.include_replies).toBe(1);

    // A later upsert that only knows the id must not erase what the first learned.
    const merged = await store.upsertPost(db, { post_id: "100_1" });

    expect(merged.id).toBe(created.id);
    expect(merged.label).toBe("Launch post");
    expect(merged.permalink_url).toBe("https://www.facebook.com/100/posts/1");
    expect(merged.page_id).toBe("100");
    expect(merged.active).toBe(1);
    expect(merged.mode).toBe("hide_all");
    expect(merged.include_replies).toBe(1);
    expect((await store.listPosts(db)).length).toBe(1);
  });

  it("applies the fields a second upsert does supply", async () => {
    await store.upsertPost(db, { post_id: "100_2", label: "Old label", active: true });
    const updated = await store.upsertPost(db, {
      post_id: "100_2",
      label: "New label",
      active: false,
    });

    expect(updated.label).toBe("New label");
    expect(updated.active).toBe(0);
  });

  it("lists only active posts, oldest id first", async () => {
    await store.upsertPost(db, { post_id: "p-a", active: true });
    await store.upsertPost(db, { post_id: "p-b", active: false });
    await store.upsertPost(db, { post_id: "p-c", active: true });

    expect((await store.listActivePosts(db)).map((post) => post.post_id)).toEqual(["p-a", "p-c"]);
    expect((await store.listPosts(db)).length).toBe(3);
  });

  it("patches only the supplied columns and ignores an empty patch", async () => {
    await store.upsertPost(db, { post_id: "p-x", label: "Keep me" });

    await store.updatePost(db, "p-x", { active: true, mode: "hide_all" });
    const patched = await store.getPost(db, "p-x");
    expect(patched?.active).toBe(1);
    expect(patched?.mode).toBe("hide_all");
    expect(patched?.label).toBe("Keep me");

    // An empty patch is a no-op: callers read updated_at as "last edited".
    await store.updatePost(db, "p-x", {});
    expect((await store.getPost(db, "p-x"))?.updated_at).toBe(patched?.updated_at);
  });

  it("accumulates counters, clamps at zero and stamps last_hidden_at only on a hide", async () => {
    await store.upsertPost(db, { post_id: "p-count" });

    await store.bumpPostCounters(db, "p-count", { hidden: 3, flagged: 1 }, T0);
    const first = await store.getPost(db, "p-count");
    expect(first?.total_hidden).toBe(3);
    expect(first?.total_flagged).toBe(1);
    expect(first?.last_hidden_at).toBe(T0);

    await store.bumpPostCounters(db, "p-count", { flagged: 2 }, T0 + 1_000);
    const second = await store.getPost(db, "p-count");
    expect(second?.total_hidden).toBe(3);
    expect(second?.total_flagged).toBe(3);
    expect(second?.last_hidden_at).toBe(T0); // no hide happened, so no new stamp
    expect(second?.updated_at).toBe(T0 + 1_000);

    await store.bumpPostCounters(db, "p-count", { hidden: -99, flagged: -99 }, T0 + 2_000);
    const clamped = await store.getPost(db, "p-count");
    expect(clamped?.total_hidden).toBe(0);
    expect(clamped?.total_flagged).toBe(0);
    expect(clamped?.last_hidden_at).toBe(T0);
  });

  it("writes the checked timestamp", async () => {
    await store.upsertPost(db, { post_id: "p-touch" });
    expect((await store.getPost(db, "p-touch"))?.last_checked_at).toBeNull();

    await store.touchPostChecked(db, "p-touch", T0 + 5_000);
    const touched = await store.getPost(db, "p-touch");
    expect(touched?.last_checked_at).toBe(T0 + 5_000);
    expect(touched?.updated_at).toBe(T0 + 5_000);
  });

  it("deletes the post and its scoped rules but keeps the comment audit trail", async () => {
    await store.upsertPost(db, { post_id: "p-del" });
    await store.createRule(db, { post_id: "p-del", kind: "link" });
    await store.createRule(db, { kind: "contact" });
    await insertComment("c-keep", "p-del", "hidden", T0);

    await store.deletePost(db, "p-del");

    expect(await store.getPost(db, "p-del")).toBeNull();
    expect((await store.listAllRules(db)).map((rule) => rule.kind)).toEqual(["contact"]);
    expect(await store.getComment(db, "c-keep")).not.toBeNull();
  });

  it("rolls lifetime totals up across posts and counts only active ones as watched", async () => {
    await store.upsertPost(db, { post_id: "g-1", active: true });
    await store.upsertPost(db, { post_id: "g-2", active: false });
    await store.bumpPostCounters(db, "g-1", { hidden: 4, flagged: 1 }, T0);
    await store.bumpPostCounters(db, "g-2", { hidden: 2 }, T0);

    expect(await store.globalTotals(db)).toEqual({ hidden: 6, flagged: 1, watched: 1 });
  });
});

describe("rules", () => {
  it("creates with contract defaults, reads, patches and deletes", async () => {
    const created = await store.createRule(db, { kind: "keyword" });
    expect(created.pattern).toBe("");
    expect(created.action).toBe("hide");
    expect(created.enabled).toBe(1);
    expect(created.priority).toBe(100);
    expect(created.hit_count).toBe(0);
    expect(created.post_id).toBeNull();
    expect(await store.getRule(db, created.id)).toEqual(created);

    await store.updateRule(db, created.id, {
      pattern: "free,gratis",
      action: "flag",
      enabled: false,
      priority: 5,
    });
    const patched = await store.getRule(db, created.id);
    expect(patched?.pattern).toBe("free,gratis");
    expect(patched?.action).toBe("flag");
    expect(patched?.enabled).toBe(0);
    expect(patched?.priority).toBe(5);

    // Empty patch: nothing to write, so updated_at must not move.
    await store.updateRule(db, created.id, {});
    expect((await store.getRule(db, created.id))?.updated_at).toBe(patched?.updated_at);

    await store.deleteRule(db, created.id);
    expect(await store.getRule(db, created.id)).toBeNull();
  });

  it("accumulates hits, ignores a zero delta and clamps at zero", async () => {
    const rule = await store.createRule(db, { kind: "link" });

    await store.bumpRuleHits(db, rule.id);
    await store.bumpRuleHits(db, rule.id, 4);
    expect((await store.getRule(db, rule.id))?.hit_count).toBe(5);

    await store.bumpRuleHits(db, rule.id, 0);
    expect((await store.getRule(db, rule.id))?.hit_count).toBe(5);

    await store.bumpRuleHits(db, rule.id, -50);
    const clamped = await store.getRule(db, rule.id);
    expect(clamped?.hit_count).toBe(0);
    expect(clamped?.updated_at).toBe(rule.updated_at); // a hit is not an edit
  });

  it("scopes and orders listRules, and only listAllRules shows disabled ones", async () => {
    const globalLate = await store.createRule(db, { kind: "keyword", priority: 20 });
    const globalTie = await store.createRule(db, { kind: "contact", priority: 20 });
    const scopedA = await store.createRule(db, { kind: "link", post_id: "p-A", priority: 5 });
    const scopedB = await store.createRule(db, { kind: "link", post_id: "p-B", priority: 5 });
    const disabled = await store.createRule(db, { kind: "regex", priority: 1, enabled: false });

    // Global rules plus p-A's own, priority first and id as the tiebreak.
    expect((await store.listRules(db, "p-A")).map((rule) => rule.id)).toEqual([
      scopedA.id,
      globalLate.id,
      globalTie.id,
    ]);
    expect((await store.listRules(db, "p-A")).map((rule) => rule.id)).not.toContain(scopedB.id);

    // No post id means the global set on its own — `post_id = NULL` is never true.
    expect((await store.listRules(db)).map((rule) => rule.id)).toEqual([
      globalLate.id,
      globalTie.id,
    ]);

    expect((await store.listAllRules(db)).map((rule) => rule.id)).toEqual([
      disabled.id,
      scopedA.id,
      scopedB.id,
      globalLate.id,
      globalTie.id,
    ]);
  });

  it("seeds the starter rules once and is a no-op afterwards", async () => {
    const created = await store.seedDefaultRules(db);
    const seeded = await store.listAllRules(db);

    expect(created).toBeGreaterThan(0);
    expect(created).toBe(seeded.length);
    expect(seeded.every((rule) => rule.post_id === null && rule.enabled === 1)).toBe(true);
    expect(seeded.map((rule) => rule.kind)).toEqual(
      [...DEFAULT_RULES].sort((a, b) => a.priority - b.priority).map((seed) => seed.kind),
    );

    // Re-seeding an account that has already tuned its rules would be destructive.
    expect(await store.seedDefaultRules(db)).toBe(0);
    expect((await store.listAllRules(db)).length).toBe(seeded.length);
  });

  it("refuses to seed a table that already holds a rule", async () => {
    await store.createRule(db, { kind: "keyword", pattern: "mine" });
    expect(await store.seedDefaultRules(db)).toBe(0);
    expect((await store.listAllRules(db)).length).toBe(1);
  });
});
