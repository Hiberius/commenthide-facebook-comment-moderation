// CommentHide — watched posts.
//
// Adding a post is the moment the tool becomes able to hide things, so it is
// deliberately the most careful endpoint in the app: the post is tested first,
// every comment that already exists is recorded as "seen" second, and only then
// does the post go active. That ordering is what guarantees switching a post on
// can never touch a conversation that was already there.

import { Hono } from "hono";
import type {
  AppEnv,
  ConnectionTest,
  GraphComment,
  PostMode,
  ResolvedTarget,
} from "../types";
import { normalizePostInput, type GraphClient } from "../lib/graph";
import {
  deletePost,
  getComments,
  getPost,
  listPosts,
  logEvent,
  recordComment,
  updatePost,
  upsertPost,
} from "../lib/storage";
import inspect from "./posts-inspect";
import {
  loadPageToken,
  newGraphClient,
  optionalBoolean,
  optionalMember,
  optionalText,
  postIdField,
  postIdParam,
  POST_MODES,
  readJson,
  type JsonObject,
  type Parsed,
} from "./shared";

/** Shown on every comment the baseline pass marks, so the audit trail explains itself. */
const BASELINE_REASON = "existed before CommentHide started watching this post";

const posts = new Hono<AppEnv>();

interface CreateInput {
  postId: string;
  label: string | null | undefined;
  mode: PostMode | undefined;
  dryRun: boolean | undefined;
  includeReplies: boolean | undefined;
  baseline: boolean;
}

function parseCreate(body: JsonObject): Parsed<CreateInput> {
  const postId = postIdField(body);
  if (!postId.ok) return postId;
  const label = optionalText(body, "label", 120);
  if (!label.ok) return label;
  const mode = optionalMember(body, "mode", POST_MODES);
  if (!mode.ok) return mode;
  const dryRun = optionalBoolean(body, "dryRun");
  if (!dryRun.ok) return dryRun;
  const includeReplies = optionalBoolean(body, "includeReplies");
  if (!includeReplies.ok) return includeReplies;
  const baseline = optionalBoolean(body, "baseline");
  if (!baseline.ok) return baseline;

  return {
    ok: true,
    value: {
      postId: postId.value,
      label: label.value,
      mode: mode.value,
      dryRun: dryRun.value,
      includeReplies: includeReplies.value,
      // Baselining is the safe default; opting out has to be explicit.
      baseline: baseline.value ?? true,
    },
  };
}

/** Collapses a comment to one line; storage applies the length cap. */
function preview(message: string | undefined): string | null {
  if (message === undefined) return null;
  const flat = message.replace(/\s+/g, " ").trim();
  return flat === "" ? null : flat;
}

/** Whether it is safe to activate, and what the baseline pass actually did. */
interface BaselineOutcome {
  /** True when nothing that pre-dates the operator can still be acted on. */
  readonly safe: boolean;
  readonly recorded: number;
  readonly error: string | null;
}

/** Records comments the tool has never decided on as already seen. */
async function applyBaseline(
  db: D1Database,
  postId: string,
  comments: readonly GraphComment[],
): Promise<number> {
  const known = await getComments(
    db,
    comments.map((comment) => comment.id),
  );
  let recorded = 0;
  for (const comment of comments) {
    // A comment we already decided on keeps its verdict — re-adding a post must
    // not rewrite its own history.
    if (known.has(comment.id)) continue;
    await recordComment(db, {
      comment_id: comment.id,
      post_id: postId,
      status: "seen",
      matched_reason: BASELINE_REASON,
      author_name: comment.from?.name ?? null,
      message_preview: preview(comment.message),
    });
    recorded += 1;
  }
  return recorded;
}

/**
 * The comments already on the post, marked as decided. Driven by the stored row
 * rather than the request body: a post that was already watching replies must
 * have its replies baselined too, even when this call did not mention them.
 */
async function runBaseline(
  db: D1Database,
  client: GraphClient,
  target: ResolvedTarget,
  postId: string,
  includeReplies: boolean,
): Promise<BaselineOutcome> {
  const existing = await client.fetchComments(target, { includeReplies });
  if (!existing.ok) return { safe: false, recorded: 0, error: existing.message };
  return {
    safe: true,
    recorded: await applyBaseline(db, postId, existing.data),
    error: null,
  };
}

function describeCreate(
  test: ConnectionTest,
  wantsBaseline: boolean,
  baseline: BaselineOutcome,
): string {
  if (!test.ok) {
    return `Post saved but left paused: ${test.error ?? "the connection test failed."}`;
  }
  if (wantsBaseline && !baseline.safe) {
    return (
      "Post saved but left paused: the comments already on this post could not be read, " +
      "so activating now could hide comments that were there before you arrived."
    );
  }
  if (!wantsBaseline) {
    return "Watching this post. Baseline was skipped, so comments already on the post are in scope.";
  }
  return (
    `Watching this post. ${baseline.recorded} existing comment(s) were marked as already ` +
    "seen and will never be touched."
  );
}

posts.get("/posts", async (c) => c.json({ posts: await listPosts(c.env.DB) }));

posts.post("/posts", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const input = parseCreate(body.value);
  if (!input.ok) return c.json({ error: input.error }, 400);

  const token = await loadPageToken(c.env);
  if (!token.ok) return c.json({ error: token.error }, token.status);

  const client = newGraphClient(c.env, token.token);
  const test = await client.testConnection(input.value.postId);
  // Memoised by the client, so this costs nothing after testConnection.
  const resolved = await client.resolveTarget(input.value.postId);
  const canonicalId = resolved.ok
    ? resolved.data.postId
    : normalizePostInput(input.value.postId) || input.value.postId;

  // Stored inactive first. Everything below can still fail, and a half-configured
  // post that is already live is exactly the failure mode this avoids.
  const stored = await upsertPost(c.env.DB, {
    post_id: canonicalId,
    page_id: resolved.ok ? (resolved.data.pageId ?? null) : null,
    label: input.value.label ?? null,
    permalink_url: test.permalinkUrl ?? null,
    active: false,
    mode: input.value.mode,
    dry_run: input.value.dryRun,
    include_replies: input.value.includeReplies,
  });

  const wantsBaseline = input.value.baseline;
  // Opting out is an explicit choice, so it counts as safe to activate.
  const baseline: BaselineOutcome = !wantsBaseline
    ? { safe: true, recorded: 0, error: null }
    : resolved.ok
      ? await runBaseline(c.env.DB, client, resolved.data, canonicalId, stored.include_replies === 1)
      : { safe: false, recorded: 0, error: resolved.message };

  // Activating without a completed baseline would put pre-existing comments in
  // scope, which is precisely what the baseline promises will never happen.
  const activate = test.ok && baseline.safe;
  if (activate) await updatePost(c.env.DB, canonicalId, { active: true });

  const post = await getPost(c.env.DB, canonicalId);
  if (post === null) {
    return c.json({ error: "the post could not be saved" }, 500);
  }

  await logEvent(c.env.DB, {
    level: activate ? "info" : "warn",
    action: "post_added",
    post_id: canonicalId,
    detail: `active=${activate ? 1 : 0} baseline=${baseline.recorded}`,
    error_message: test.ok ? baseline.error : (test.error ?? null),
  });

  return c.json({
    ok: true,
    post,
    test,
    baseline: {
      requested: wantsBaseline,
      applied: wantsBaseline && baseline.error === null,
      recorded: baseline.recorded,
    },
    message: describeCreate(test, wantsBaseline, baseline),
  });
});

posts.patch("/posts/:postId", async (c) => {
  const postId = postIdParam(c.req.param("postId"));
  if (!postId.ok) return c.json({ error: postId.error }, 400);

  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);

  const active = optionalBoolean(body.value, "active");
  if (!active.ok) return c.json({ error: active.error }, 400);
  const mode = optionalMember(body.value, "mode", POST_MODES);
  if (!mode.ok) return c.json({ error: mode.error }, 400);
  const dryRun = optionalBoolean(body.value, "dryRun");
  if (!dryRun.ok) return c.json({ error: dryRun.error }, 400);
  const label = optionalText(body.value, "label", 120);
  if (!label.ok) return c.json({ error: label.error }, 400);
  const includeReplies = optionalBoolean(body.value, "includeReplies");
  if (!includeReplies.ok) return c.json({ error: includeReplies.error }, 400);

  if (
    active.value === undefined &&
    mode.value === undefined &&
    dryRun.value === undefined &&
    label.value === undefined &&
    includeReplies.value === undefined
  ) {
    return c.json(
      { error: "nothing to update: send at least one of active, mode, dryRun, label, includeReplies" },
      400,
    );
  }

  const existing = await getPost(c.env.DB, postId.value);
  if (existing === null) return c.json({ error: "that post is not being watched" }, 404);

  await updatePost(c.env.DB, postId.value, {
    active: active.value,
    mode: mode.value,
    dry_run: dryRun.value,
    label: label.value,
    include_replies: includeReplies.value,
  });

  const post = await getPost(c.env.DB, postId.value);
  if (post === null) return c.json({ error: "the post could not be updated" }, 500);

  await logEvent(c.env.DB, {
    level: "info",
    action: "post_updated",
    post_id: post.post_id,
    detail: `active=${post.active} mode=${post.mode} dry_run=${post.dry_run}`,
  });

  return c.json({ ok: true, post });
});

posts.delete("/posts/:postId", async (c) => {
  const postId = postIdParam(c.req.param("postId"));
  if (!postId.ok) return c.json({ error: postId.error }, 400);

  const existing = await getPost(c.env.DB, postId.value);
  if (existing === null) return c.json({ error: "that post is not being watched" }, 404);

  await deletePost(c.env.DB, postId.value);
  await logEvent(c.env.DB, { level: "info", action: "post_removed", post_id: postId.value });
  return c.json({ ok: true });
});

// Read-only inspection and the undo path live next door to keep this file small.
posts.route("/", inspect);

export default posts;
