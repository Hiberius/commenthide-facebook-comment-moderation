// CommentHide — reading a watched post, and undoing what was hidden on it.
//
// Split out of routes/posts.ts so both files stay small. These three endpoints
// share one shape: resolve the post, talk to Graph, and answer with something
// the dashboard can explain to a human.

import { Hono } from "hono";
import type { AppEnv, CommentRow, CommentView, PostRow } from "../types";
import { previewComment } from "../lib/poller";
import {
  bumpPostCounters,
  getComments,
  getPost,
  listCommentsByStatus,
  listRules,
  logEvent,
  markRestored,
} from "../lib/storage";
import {
  graphErrorStatus,
  loadPageToken,
  newGraphClient,
  postIdParam,
  type ApiErrorStatus,
} from "./shared";

/** Restoring walks the whole hidden history; this is the storage layer's cap. */
const RESTORE_LIMIT = 500;

/** Enough failure detail to diagnose a partial restore without dumping hundreds of rows. */
const MAX_REPORTED_FAILURES = 10;

const inspect = new Hono<AppEnv>();

/** Counts of every state a comment can be in, from both points of view. */
interface CommentStats {
  total: number;
  /** Comments CommentHide has already decided on. */
  tracked: number;
  /** Comments CommentHide has never seen before. */
  untracked: number;
  hiddenOnFacebook: number;
  visibleOnFacebook: number;
  hidden: number;
  flagged: number;
  skipped: number;
  errors: number;
  restored: number;
  seen: number;
  wouldHide: number;
  wouldFlag: number;
  wouldKeep: number;
}

function summarise(views: readonly CommentView[]): CommentStats {
  const count = (predicate: (view: CommentView) => boolean): number =>
    views.filter(predicate).length;

  return {
    total: views.length,
    tracked: count((v) => v.status !== null),
    untracked: count((v) => v.status === null),
    hiddenOnFacebook: count((v) => v.isHidden),
    visibleOnFacebook: count((v) => !v.isHidden),
    hidden: count((v) => v.status === "hidden"),
    flagged: count((v) => v.status === "flagged"),
    skipped: count((v) => v.status === "skipped"),
    errors: count((v) => v.status === "error"),
    restored: count((v) => v.status === "restored"),
    seen: count((v) => v.status === "seen"),
    wouldHide: count((v) => v.wouldBe === "hide"),
    wouldFlag: count((v) => v.wouldBe === "flag"),
    wouldKeep: count((v) => v.wouldBe === "keep"),
  };
}

type Loaded =
  | { ok: true; post: PostRow; token: string }
  | { ok: false; error: string; status: ApiErrorStatus };

/** Every endpoint here needs the same two things before it can do anything. */
async function loadPostAndToken(env: AppEnv["Bindings"], rawId: string): Promise<Loaded> {
  const postId = postIdParam(rawId);
  if (!postId.ok) return { ok: false, error: postId.error, status: 400 };

  const post = await getPost(env.DB, postId.value);
  if (post === null) return { ok: false, error: "that post is not being watched", status: 404 };

  const token = await loadPageToken(env);
  if (!token.ok) return { ok: false, error: token.error, status: token.status };

  return { ok: true, post, token: token.token };
}

inspect.get("/posts/:postId/comments", async (c) => {
  const loaded = await loadPostAndToken(c.env, c.req.param("postId"));
  if (!loaded.ok) return c.json({ error: loaded.error }, loaded.status);

  const client = newGraphClient(c.env, loaded.token);
  const target = await client.resolveTarget(loaded.post.post_id);
  if (!target.ok) return c.json({ error: target.message }, graphErrorStatus(target));

  const live = await client.fetchComments(target.data, {
    includeReplies: loaded.post.include_replies === 1,
  });
  if (!live.ok) return c.json({ error: live.message }, graphErrorStatus(live));

  const rules = await listRules(c.env.DB, loaded.post.post_id);
  // One query for the batch, exactly like the poller does it.
  const known = await getComments(
    c.env.DB,
    live.data.map((comment) => comment.id),
  );

  // `wouldBe` answers "what would the current rules do to this right now", which
  // is what makes dry-run mode readable before anything is ever hidden.
  const comments = live.data.map((comment) =>
    previewComment(comment, known.get(comment.id), rules, loaded.post.mode),
  );

  return c.json({ post: loaded.post, stats: summarise(comments), comments });
});

inspect.post("/posts/:postId/test", async (c) => {
  const loaded = await loadPostAndToken(c.env, c.req.param("postId"));
  if (!loaded.ok) return c.json({ error: loaded.error }, loaded.status);

  const client = newGraphClient(c.env, loaded.token);
  // A failed test is a report, not a transport error: answer 200 with ok:false
  // so the dashboard can render the reason instead of a stack of red.
  return c.json(await client.testConnection(loaded.post.post_id));
});

/** Only real hides can be undone — a dry-run row never touched Facebook. */
function restorable(rows: readonly CommentRow[]): CommentRow[] {
  return rows.filter((row) => row.dry_run === 0);
}

inspect.post("/posts/:postId/restore", async (c) => {
  const loaded = await loadPostAndToken(c.env, c.req.param("postId"));
  if (!loaded.ok) return c.json({ error: loaded.error }, loaded.status);

  const client = newGraphClient(c.env, loaded.token);
  const target = await client.resolveTarget(loaded.post.post_id);
  if (!target.ok) return c.json({ error: target.message }, graphErrorStatus(target));

  const hidden = restorable(
    await listCommentsByStatus(c.env.DB, loaded.post.post_id, "hidden", RESTORE_LIMIT),
  );

  const failures: { commentId: string; error: string }[] = [];
  let restored = 0;
  for (const row of hidden) {
    const result = await client.setHidden(target.data, row.comment_id, false);
    if (!result.ok || result.data.success !== true) {
      const message = result.ok
        ? "Facebook accepted the request but did not unhide the comment"
        : result.message;
      if (failures.length < MAX_REPORTED_FAILURES) {
        failures.push({ commentId: row.comment_id, error: message });
      }
      continue;
    }
    await markRestored(c.env.DB, row.comment_id);
    restored += 1;
  }

  // The lifetime counter must follow reality, so it drops by what actually
  // came back — not by what we set out to restore.
  if (restored > 0) {
    await bumpPostCounters(c.env.DB, loaded.post.post_id, { hidden: -restored }, Date.now());
  }

  const errors = hidden.length - restored;
  await logEvent(c.env.DB, {
    level: errors > 0 ? "warn" : "info",
    action: "restore",
    post_id: loaded.post.post_id,
    detail: `restored=${restored} errors=${errors}`,
    error_message: failures[0]?.error ?? null,
  });

  return c.json({ ok: true, restored, errors, failures });
});

export default inspect;
