// CommentHide — the per-comment step of a poll run.
//
// Split out of poller.ts to keep both files well under the 400-line cap:
// poller.ts owns the run and the post loop, this file owns the decision and
// the single Graph write that can follow it.

import type {
  Env,
  EvaluableComment,
  GraphComment,
  PostRow,
  ResolvedTarget,
  RuleRow,
} from "../types";
import { redact } from "./crypto";
import type { GraphClient } from "./graph";
import { evaluate } from "./rules";
import { logEvent, recordComment } from "./storage";

/** Longest message excerpt kept on a comment row. */
export const PREVIEW_MAX = 140;

/** Derived from storage so nothing here re-declares the event shape. */
export type LogInput = Parameters<typeof logEvent>[1];

// ---------------------------------------------------------------------------
// Tallies — plain counters, always folded into a new object.
// ---------------------------------------------------------------------------

export interface Tally {
  readonly fetched: number;
  /** Hide decisions, including the ones a dry run only previewed. */
  readonly hidden: number;
  /** Graph writes that actually landed — the only ones that touch post totals. */
  readonly hiddenReal: number;
  readonly flagged: number;
  readonly skipped: number;
  readonly errors: number;
}

export const ZERO_TALLY: Tally = {
  fetched: 0,
  hidden: 0,
  hiddenReal: 0,
  flagged: 0,
  skipped: 0,
  errors: 0,
};

export function addTally(base: Tally, delta: Partial<Tally>): Tally {
  return {
    fetched: base.fetched + (delta.fetched ?? 0),
    hidden: base.hidden + (delta.hidden ?? 0),
    hiddenReal: base.hiddenReal + (delta.hiddenReal ?? 0),
    flagged: base.flagged + (delta.flagged ?? 0),
    skipped: base.skipped + (delta.skipped ?? 0),
    errors: base.errors + (delta.errors ?? 0),
  };
}

/** Everything the per-comment step needs, assembled once per post. */
export interface PostContext {
  readonly env: Env;
  readonly client: GraphClient;
  readonly target: ResolvedTarget;
  readonly post: PostRow;
  readonly rules: RuleRow[];
  readonly dryRun: boolean;
  readonly token: string;
  readonly now: number;
}

export interface CommentResult {
  readonly delta: Partial<Tally>;
  readonly ruleId: number | null;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function toEvaluable(comment: GraphComment): EvaluableComment {
  return {
    id: comment.id,
    message: comment.message ?? "",
    authorId: comment.from?.id,
    authorName: comment.from?.name,
  };
}

/** Collapses whitespace so a preview stays one readable line in the dashboard. */
export function previewOf(message: string | undefined): string | null {
  if (message === undefined) return null;
  const flat = message.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return null;
  return flat.length > PREVIEW_MAX ? flat.slice(0, PREVIEW_MAX) : flat;
}

/** Facebook can refuse a hide before we ever ask. Null means we may proceed. */
export function hideBlockReason(comment: GraphComment): string | null {
  if (comment.is_hidden === true) return "already hidden on Facebook";
  if (comment.can_hide === false) return "Facebook reports this comment cannot be hidden";
  return null;
}

/** The audit log must never be the thing that takes a run down. */
export async function safeLog(env: Env, input: LogInput): Promise<void> {
  try {
    await logEvent(env.DB, input);
  } catch (err) {
    console.error("commenthide: event log write failed:", errorMessage(err));
  }
}

// ---------------------------------------------------------------------------
// Decide, then act
// ---------------------------------------------------------------------------

export async function processComment(
  ctx: PostContext,
  comment: GraphComment,
): Promise<CommentResult> {
  const { env, post, dryRun, now } = ctx;
  const decision = evaluate(toEvaluable(comment), ctx.rules, post.mode);
  const base = {
    comment_id: comment.id,
    post_id: post.post_id,
    matched_rule_id: decision.ruleId,
    matched_reason: decision.reason,
    author_name: comment.from?.name ?? null,
    message_preview: previewOf(comment.message),
    dry_run: dryRun,
  };

  if (decision.verdict === "flag") {
    // Flagging is bookkeeping only — it never calls the Graph API, dry run or not.
    await recordComment(env.DB, { ...base, status: "flagged", actioned_at: now });
    return { delta: { flagged: 1 }, ruleId: decision.ruleId };
  }

  if (decision.verdict === "keep") {
    await recordComment(env.DB, { ...base, status: "seen" });
    return { delta: {}, ruleId: decision.ruleId };
  }

  // Checked before the dry-run branch so a preview never promises a hide that
  // Facebook would have refused anyway.
  const blocked = hideBlockReason(comment);
  if (blocked !== null) {
    await recordComment(env.DB, {
      ...base,
      status: "skipped",
      matched_reason: `${decision.reason} — ${blocked}`,
    });
    return { delta: { skipped: 1 }, ruleId: decision.ruleId };
  }

  if (dryRun) {
    await recordComment(env.DB, { ...base, status: "seen" });
    return { delta: { hidden: 1 }, ruleId: decision.ruleId };
  }

  const hide = await ctx.client.setHidden(ctx.target, comment.id, true);
  // Graph can answer 200 with {"success": false}; that is a refusal, not a hide.
  if (!hide.ok || hide.data.success !== true) {
    const message = hide.ok
      ? "Facebook accepted the request but did not hide the comment"
      : redact(hide.message, ctx.token);
    await recordComment(env.DB, { ...base, status: "error", error_message: message });
    await safeLog(env, {
      level: "error",
      action: "hide_failed",
      post_id: post.post_id,
      comment_id: comment.id,
      error_message: message,
    });
    return { delta: { errors: 1 }, ruleId: decision.ruleId };
  }

  await recordComment(env.DB, { ...base, status: "hidden", actioned_at: now });
  return { delta: { hidden: 1, hiddenReal: 1 }, ruleId: decision.ruleId };
}
