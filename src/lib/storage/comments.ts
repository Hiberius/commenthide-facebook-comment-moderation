// comments: one row per comment CommentHide has already decided on. This table
// is both the idempotency ledger for the poller and the audit trail for undo.

import type { CommentRow, CommentStatus } from "../../types";
import {
  asBit,
  asInt,
  asNullableInt,
  asNullableText,
  asText,
  chunk,
  clampLimit,
  COMMENT_STATUSES,
  nowMs,
  oneOf,
  oneOfOrNull,
  placeholders,
  truncate,
  type RawRow,
} from "./internal";

export interface RecordCommentInput {
  comment_id: string;
  post_id: string;
  status: CommentStatus;
  matched_rule_id?: number | null;
  matched_reason?: string | null;
  author_name?: string | null;
  message_preview?: string | null;
  dry_run?: boolean;
  actioned_at?: number | null;
  error_message?: string | null;
}

const COMMENT_COLUMNS = `comment_id, post_id, status, matched_rule_id, matched_reason,
  author_name, message_preview, dry_run, first_seen_at, actioned_at, error_message`;

/** D1 caps bound parameters per statement; 100 ids per IN clause stays well under. */
const ID_CHUNK_SIZE = 100;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
const PREVIEW_MAX = 240;
const REASON_MAX = 240;
const ERROR_MAX = 500;

const EMPTY_COUNTS: Readonly<Record<CommentStatus, number>> = Object.freeze({
  seen: 0,
  hidden: 0,
  flagged: 0,
  skipped: 0,
  error: 0,
  restored: 0,
});

function toCommentRow(raw: RawRow): CommentRow {
  return {
    comment_id: asText(raw.comment_id),
    post_id: asText(raw.post_id),
    status: oneOf(raw.status, COMMENT_STATUSES, "seen"),
    matched_rule_id: asNullableInt(raw.matched_rule_id),
    matched_reason: asNullableText(raw.matched_reason),
    author_name: asNullableText(raw.author_name),
    message_preview: asNullableText(raw.message_preview),
    dry_run: asBit(raw.dry_run),
    first_seen_at: asInt(raw.first_seen_at),
    actioned_at: asNullableInt(raw.actioned_at),
    error_message: asNullableText(raw.error_message),
  };
}

export async function getComment(
  db: D1Database,
  commentId: string,
): Promise<CommentRow | null> {
  const row = await db
    .prepare(`SELECT ${COMMENT_COLUMNS} FROM comments WHERE comment_id = ?`)
    .bind(commentId)
    .first<RawRow>();
  return row === null ? null : toCommentRow(row);
}

/**
 * Loads every known comment in one IN-clause query (batched into a single round
 * trip past 100 ids). The poller depends on this: one query per run, never one
 * query per comment.
 */
export async function getComments(
  db: D1Database,
  commentIds: string[],
): Promise<Map<string, CommentRow>> {
  const unique = [...new Set(commentIds)].filter((id) => id.length > 0);
  if (unique.length === 0) return new Map();

  const statements = chunk(unique, ID_CHUNK_SIZE).map((ids) =>
    db
      .prepare(
        `SELECT ${COMMENT_COLUMNS} FROM comments WHERE comment_id IN (${placeholders(ids.length)})`,
      )
      .bind(...ids),
  );

  const batches = await db.batch<RawRow>(statements);
  return new Map(
    batches
      .flatMap((batch) => batch.results)
      .map(toCommentRow)
      .map((row) => [row.comment_id, row] as const),
  );
}

/**
 * Insert, or refresh a row the poller is allowed to re-decide (an `error` row).
 * first_seen_at is never rewritten — it is what "new since" means everywhere
 * else in the app.
 */
export async function recordComment(db: D1Database, input: RecordCommentInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO comments
         (comment_id, post_id, status, matched_rule_id, matched_reason, author_name,
          message_preview, dry_run, first_seen_at, actioned_at, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, 0), ?, ?, ?)
       ON CONFLICT(comment_id) DO UPDATE SET
         post_id         = excluded.post_id,
         status          = excluded.status,
         matched_rule_id = excluded.matched_rule_id,
         matched_reason  = excluded.matched_reason,
         author_name     = COALESCE(excluded.author_name, comments.author_name),
         message_preview = COALESCE(excluded.message_preview, comments.message_preview),
         dry_run         = excluded.dry_run,
         actioned_at     = COALESCE(excluded.actioned_at, comments.actioned_at),
         error_message   = excluded.error_message`,
    )
    .bind(
      input.comment_id,
      input.post_id,
      input.status,
      input.matched_rule_id ?? null,
      truncate(input.matched_reason, REASON_MAX),
      input.author_name ?? null,
      truncate(input.message_preview, PREVIEW_MAX),
      input.dry_run === undefined ? null : input.dry_run ? 1 : 0,
      nowMs(),
      input.actioned_at ?? null,
      truncate(input.error_message, ERROR_MAX),
    )
    .run();
}

export async function listComments(
  db: D1Database,
  postId: string,
  limit?: number,
): Promise<CommentRow[]> {
  const result = await db
    .prepare(
      `SELECT ${COMMENT_COLUMNS} FROM comments
       WHERE post_id = ?
       ORDER BY first_seen_at DESC, comment_id DESC
       LIMIT ?`,
    )
    .bind(postId, clampLimit(limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT))
    .all<RawRow>();
  return result.results.map(toCommentRow);
}

export async function listCommentsByStatus(
  db: D1Database,
  postId: string,
  status: CommentStatus,
  limit?: number,
): Promise<CommentRow[]> {
  const result = await db
    .prepare(
      `SELECT ${COMMENT_COLUMNS} FROM comments
       WHERE post_id = ? AND status = ?
       ORDER BY first_seen_at DESC, comment_id DESC
       LIMIT ?`,
    )
    .bind(postId, status, clampLimit(limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT))
    .all<RawRow>();
  return result.results.map(toCommentRow);
}

/** Undo: the comment is visible again, so the stored failure no longer applies. */
export async function markRestored(db: D1Database, commentId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE comments
         SET status = 'restored', actioned_at = ?, error_message = NULL
       WHERE comment_id = ?`,
    )
    .bind(nowMs(), commentId)
    .run();
}

/** Always returns every status key, so the dashboard never reads undefined. */
export async function countByStatus(
  db: D1Database,
  postId: string,
): Promise<Record<CommentStatus, number>> {
  const result = await db
    .prepare("SELECT status, COUNT(*) AS total FROM comments WHERE post_id = ? GROUP BY status")
    .bind(postId)
    .all<RawRow>();

  return result.results.reduce<Record<CommentStatus, number>>((counts, raw) => {
    const status = oneOfOrNull(raw.status, COMMENT_STATUSES);
    // An unrecognised status means the schema moved on; ignore it rather than
    // failing the whole dashboard request.
    return status === null ? counts : { ...counts, [status]: asInt(raw.total) };
  }, EMPTY_COUNTS);
}
