// CommentHide — poll orchestration.
//
// One GraphClient is built per run and shared by every post: target resolution
// and the /me/accounts page-token lookup are memoised on the instance, so
// sharing it is what keeps a multi-post poll down to a handful of Graph calls.
//
// runPoll never throws. It is driven by the cron handler, and a Worker that
// crashes on a schedule stops moderating entirely.

import type {
  CommentRow,
  CommentView,
  Env,
  GraphComment,
  PollOptions,
  PollSummary,
  PostMode,
  PostRow,
  RuleRow,
} from "../types";
import { decryptToken, redact } from "./crypto";
import { GraphClient } from "./graph";
import {
  addTally,
  errorMessage,
  processComment,
  safeLog,
  toEvaluable,
  ZERO_TALLY,
} from "./poll-comment";
import type { PostContext, Tally } from "./poll-comment";
import { evaluate } from "./rules";
import {
  bumpPostCounters,
  bumpRuleHits,
  getComments,
  getPost,
  getSetting,
  listActivePosts,
  listRules,
  touchPostChecked,
} from "./storage";

/** Settings key holding the AES-GCM ciphertext of the Page Access Token. */
const TOKEN_KEY = "page_token";

/** Enough Graph warnings to diagnose a run without flooding the audit log. */
const MAX_LOGGED_WARNINGS = 5;

interface PostResult {
  readonly tally: Tally;
  readonly dryRun: boolean;
  /** False when the post never got as far as evaluating comments. */
  readonly processed: boolean;
}

function emptySummary(): PollSummary {
  return { fetched: 0, hidden: 0, flagged: 0, skipped: 0, errors: 0, dryRun: false };
}

function summarise(postCount: number, summary: PollSummary): string {
  const parts = [
    `posts=${postCount}`,
    `fetched=${summary.fetched}`,
    `hidden=${summary.hidden}`,
    `flagged=${summary.flagged}`,
    `skipped=${summary.skipped}`,
    `errors=${summary.errors}`,
  ];
  if (summary.dryRun) parts.push("dry_run=1");
  return parts.join(" ");
}

/**
 * Maps a Graph comment plus whatever we already recorded into the dashboard
 * shape, with `wouldBe` answering "what would the current rules do right now".
 * Pure — the routes layer reuses it to render a post without polling.
 */
export function previewComment(
  comment: GraphComment,
  existing: CommentRow | undefined,
  rules: RuleRow[],
  mode: PostMode,
): CommentView {
  const decision = evaluate(toEvaluable(comment), rules, mode);
  return {
    id: comment.id,
    message: comment.message ?? "",
    createdTime: comment.created_time,
    authorName: comment.from?.name,
    isHidden: comment.is_hidden === true,
    // Absent means the Page did not tell us otherwise; only an explicit false blocks.
    canHide: comment.can_hide !== false,
    status: existing?.status ?? null,
    reason: existing?.matched_reason ?? null,
    wouldBe: decision.verdict,
  };
}

// ---------------------------------------------------------------------------
// Per-post work
// ---------------------------------------------------------------------------

async function finalisePost(
  ctx: PostContext,
  tally: Tally,
  hits: ReadonlyMap<number, number>,
): Promise<void> {
  const { env, post, now } = ctx;
  try {
    for (const [ruleId, count] of hits) {
      await bumpRuleHits(env.DB, ruleId, count);
    }
    // A dry run must leave lifetime totals untouched; nothing really happened.
    const flagged = ctx.dryRun ? 0 : tally.flagged;
    if (tally.hiddenReal > 0 || flagged > 0) {
      await bumpPostCounters(env.DB, post.post_id, { hidden: tally.hiddenReal, flagged }, now);
    }
    // Only a run that actually read comments counts as a check.
    await touchPostChecked(env.DB, post.post_id, now);
  } catch (err) {
    await safeLog(env, {
      level: "warn",
      action: "poll_bookkeeping",
      post_id: post.post_id,
      detail: "counters_not_updated",
      error_message: errorMessage(err),
    });
  }
}

async function pollPost(
  env: Env,
  client: GraphClient,
  token: string,
  post: PostRow,
  opts: PollOptions,
  now: number,
): Promise<PostResult> {
  const dryRun = post.dry_run === 1 || opts.forceDryRun === true;
  const aborted: PostResult = {
    tally: addTally(ZERO_TALLY, { errors: 1 }),
    dryRun,
    processed: false,
  };

  try {
    const resolved = await client.resolveTarget(post.post_id);
    if (!resolved.ok) {
      await safeLog(env, {
        level: "error",
        action: "poll_post",
        post_id: post.post_id,
        detail: "resolve_failed",
        error_message: redact(resolved.message, token),
      });
      return aborted;
    }

    const target = resolved.data;
    const page = await client.fetchComments(target, {
      includeReplies: post.include_replies === 1,
    });
    if (!page.ok) {
      await safeLog(env, {
        level: "error",
        action: "poll_post",
        post_id: post.post_id,
        detail: "fetch_failed",
        error_message: redact(page.message, token),
      });
      return aborted;
    }

    const comments = page.data;
    const rules = await listRules(env.DB, post.post_id);
    // One lookup for the whole batch — never one query per comment.
    const known = await getComments(env.DB, comments.map((c) => c.id));
    const ctx: PostContext = { env, client, target, post, rules, dryRun, token, now };

    let tally = addTally(ZERO_TALLY, { fetched: comments.length });
    const hits = new Map<number, number>();

    for (const comment of comments) {
      const existing = known.get(comment.id);
      // Decided comments are never revisited. An "error" row is the one
      // exception, so a transient Graph failure gets another chance next run.
      if (existing !== undefined && existing.status !== "error") continue;
      try {
        const result = await processComment(ctx, comment);
        tally = addTally(tally, result.delta);
        if (result.ruleId !== null) {
          hits.set(result.ruleId, (hits.get(result.ruleId) ?? 0) + 1);
        }
      } catch (err) {
        // One bad comment must never abandon the run.
        tally = addTally(tally, { errors: 1 });
        await safeLog(env, {
          level: "error",
          action: "comment_failed",
          post_id: post.post_id,
          comment_id: comment.id,
          error_message: redact(errorMessage(err), token),
        });
      }
    }

    await finalisePost(ctx, tally, hits);
    return { tally, dryRun, processed: true };
  } catch (err) {
    await safeLog(env, {
      level: "error",
      action: "poll_post",
      post_id: post.post_id,
      detail: "post_failed",
      error_message: redact(errorMessage(err), token),
    });
    return aborted;
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function selectPosts(env: Env, opts: PollOptions): Promise<PostRow[]> {
  if (opts.onlyPostId === undefined) return listActivePosts(env.DB);
  // "Run now" has to work on a paused post, so `active` is deliberately ignored.
  const post = await getPost(env.DB, opts.onlyPostId);
  return post === null ? [] : [post];
}

export async function runPoll(env: Env, opts: PollOptions = {}): Promise<PollSummary> {
  const now = Date.now();
  const action = opts.manual === true ? "poll_manual" : "poll";
  // Held outside the try so the catch can still redact a leaked token.
  let token: string | null = null;

  try {
    const ciphertext = await getSetting(env.DB, TOKEN_KEY);
    if (ciphertext === null || ciphertext === "") {
      await safeLog(env, { level: "info", action: "poll", detail: "no_token" });
      return emptySummary();
    }
    token = await decryptToken(ciphertext, env.ENCRYPTION_KEY);

    const posts = await selectPosts(env, opts);
    if (posts.length === 0) {
      const detail = opts.onlyPostId === undefined ? "no_active_posts" : "post_not_found";
      await safeLog(env, { level: "info", action, detail });
      return emptySummary();
    }

    // The client reports non-fatal problems (an unreadable reply thread, say)
    // through this sink; collected here so they reach the log awaited, not
    // through a floating promise the runtime may cancel.
    const warnings: string[] = [];
    const client = new GraphClient(token, {
      version: env.GRAPH_API_VERSION,
      apiBase: env.GRAPH_API_BASE,
      onWarning: (message) => {
        warnings.push(message);
      },
    });

    let total = ZERO_TALLY;
    let processed = 0;
    let dryPosts = 0;
    for (const post of posts) {
      const result = await pollPost(env, client, token, post, opts, now);
      total = addTally(total, result.tally);
      if (result.processed) {
        processed += 1;
        if (result.dryRun) dryPosts += 1;
      }
    }

    const summary: PollSummary = {
      fetched: total.fetched,
      hidden: total.hidden,
      flagged: total.flagged,
      skipped: total.skipped,
      errors: total.errors,
      // Only a run where nothing could have been written counts as a dry run.
      dryRun: processed > 0 && dryPosts === processed,
    };
    if (warnings.length > 0) {
      await safeLog(env, {
        level: "warn",
        action,
        detail: `graph_warnings=${warnings.length}`,
        error_message: redact(warnings.slice(0, MAX_LOGGED_WARNINGS).join(" | "), token),
      });
    }
    await safeLog(env, {
      level: total.errors > 0 ? "warn" : "info",
      action,
      detail: summarise(posts.length, summary),
    });
    return summary;
  } catch (err) {
    await safeLog(env, {
      level: "error",
      action,
      detail: "poll_failed",
      error_message: redact(errorMessage(err), token),
    });
    return { ...emptySummary(), errors: 1 };
  }
}
