// CommentHide — manual moderation of a single comment.
//
// The dashboard needs a way to overrule the rules in both directions. Both
// endpoints go through the same Graph write the poller uses and leave the same
// audit trail, so a manual hide is indistinguishable from an automatic one
// afterwards — except for the reason recorded against it.

import { Hono } from "hono";
import type { AppEnv, PostRow, ResolvedTarget } from "../types";
import {
  bumpPostCounters,
  getComment,
  getPost,
  logEvent,
  markRestored,
  recordComment,
} from "../lib/storage";
import type { GraphClient } from "../lib/graph";
import {
  graphErrorStatus,
  loadPageToken,
  newGraphClient,
  postIdField,
  commentIdParam,
  readJson,
  type ApiErrorStatus,
} from "./shared";

const HIDE_REASON = "hidden by hand from the dashboard";
const SHOW_REASON = "unhidden by hand from the dashboard";

const moderation = new Hono<AppEnv>();

type Prepared =
  | { ok: true; post: PostRow; client: GraphClient; target: ResolvedTarget; commentId: string }
  | { ok: false; error: string; status: ApiErrorStatus };

/**
 * Both endpoints need the same five things. Resolving here means a bad comment
 * id, an unwatched post and an unusable token all fail before any Graph write.
 */
async function prepare(
  env: AppEnv["Bindings"],
  rawCommentId: string,
  body: Record<string, unknown>,
): Promise<Prepared> {
  const commentId = commentIdParam(rawCommentId);
  if (!commentId.ok) return { ok: false, error: commentId.error, status: 400 };

  const postId = postIdField(body);
  if (!postId.ok) return { ok: false, error: postId.error, status: 400 };

  const post = await getPost(env.DB, postId.value);
  if (post === null) return { ok: false, error: "that post is not being watched", status: 404 };

  const token = await loadPageToken(env);
  if (!token.ok) return { ok: false, error: token.error, status: token.status };

  const client = newGraphClient(env, token.token);
  const target = await client.resolveTarget(post.post_id);
  if (!target.ok) {
    return { ok: false, error: target.message, status: graphErrorStatus(target) };
  }

  return { ok: true, post, client, target: target.data, commentId: commentId.value };
}

moderation.post("/comments/:commentId/hide", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);

  const ready = await prepare(c.env, c.req.param("commentId"), body.value);
  if (!ready.ok) return c.json({ error: ready.error }, ready.status);

  const result = await ready.client.setHidden(ready.target, ready.commentId, true);
  // Graph can answer 200 with success:false; that is a refusal, not a hide.
  if (!result.ok || result.data.success !== true) {
    const message = result.ok
      ? "Facebook accepted the request but did not hide the comment"
      : result.message;
    await logEvent(c.env.DB, {
      level: "error",
      action: "manual_hide_failed",
      post_id: ready.post.post_id,
      comment_id: ready.commentId,
      error_message: message,
    });
    return c.json({ error: message }, result.ok ? 502 : graphErrorStatus(result));
  }

  const now = Date.now();
  const existing = await getComment(c.env.DB, ready.commentId);
  await recordComment(c.env.DB, {
    comment_id: ready.commentId,
    post_id: ready.post.post_id,
    status: "hidden",
    matched_reason: HIDE_REASON,
    author_name: existing?.author_name ?? null,
    message_preview: existing?.message_preview ?? null,
    dry_run: false,
    actioned_at: now,
  });
  // Only count a comment that was not already counted as hidden.
  if (existing === null || existing.status !== "hidden") {
    await bumpPostCounters(c.env.DB, ready.post.post_id, { hidden: 1 }, now);
  }
  await logEvent(c.env.DB, {
    level: "info",
    action: "manual_hide",
    post_id: ready.post.post_id,
    comment_id: ready.commentId,
  });

  return c.json({ ok: true });
});

moderation.post("/comments/:commentId/show", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);

  const ready = await prepare(c.env, c.req.param("commentId"), body.value);
  if (!ready.ok) return c.json({ error: ready.error }, ready.status);

  const result = await ready.client.setHidden(ready.target, ready.commentId, false);
  if (!result.ok || result.data.success !== true) {
    const message = result.ok
      ? "Facebook accepted the request but did not unhide the comment"
      : result.message;
    await logEvent(c.env.DB, {
      level: "error",
      action: "manual_show_failed",
      post_id: ready.post.post_id,
      comment_id: ready.commentId,
      error_message: message,
    });
    return c.json({ error: message }, result.ok ? 502 : graphErrorStatus(result));
  }

  const existing = await getComment(c.env.DB, ready.commentId);
  if (existing === null) {
    // Never recorded — most likely hidden on Facebook itself. Record the undo so
    // the poller does not immediately hide it again.
    await recordComment(c.env.DB, {
      comment_id: ready.commentId,
      post_id: ready.post.post_id,
      status: "restored",
      matched_reason: SHOW_REASON,
      actioned_at: Date.now(),
    });
  } else {
    await markRestored(c.env.DB, ready.commentId);
    // A dry-run row never really hid anything, so its total was never bumped.
    if (existing.status === "hidden" && existing.dry_run === 0) {
      await bumpPostCounters(c.env.DB, ready.post.post_id, { hidden: -1 }, Date.now());
    }
  }

  await logEvent(c.env.DB, {
    level: "info",
    action: "manual_show",
    post_id: ready.post.post_id,
    comment_id: ready.commentId,
  });

  return c.json({ ok: true });
});

export default moderation;
