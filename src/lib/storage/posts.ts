// posts: every Facebook Page post CommentHide watches.

import type { PostMode, PostRow } from "../../types";
import {
  asBit,
  asInt,
  asNullableInt,
  asNullableText,
  asText,
  collectAssignments,
  nowMs,
  oneOf,
  optionalBit,
  optionalValue,
  POST_MODES,
  type RawRow,
} from "./internal";

export interface UpsertPostInput {
  post_id: string;
  page_id?: string | null;
  label?: string | null;
  permalink_url?: string | null;
  active?: boolean;
  mode?: PostMode;
  dry_run?: boolean;
  include_replies?: boolean;
}

const POST_COLUMNS = `id, post_id, page_id, label, permalink_url, active, mode, dry_run,
  include_replies, total_hidden, total_flagged, last_checked_at, last_hidden_at,
  created_at, updated_at`;

/** The only column names updatePost may ever write. Never derived from input. */
const POST_PATCH_COLUMNS = [
  "page_id",
  "label",
  "permalink_url",
  "active",
  "mode",
  "dry_run",
  "include_replies",
] as const;

type PostPatchColumn = (typeof POST_PATCH_COLUMNS)[number];

function toPostRow(raw: RawRow): PostRow {
  return {
    id: asInt(raw.id),
    post_id: asText(raw.post_id),
    page_id: asNullableText(raw.page_id),
    label: asNullableText(raw.label),
    permalink_url: asNullableText(raw.permalink_url),
    active: asBit(raw.active),
    mode: oneOf(raw.mode, POST_MODES, "rules"),
    dry_run: asBit(raw.dry_run),
    include_replies: asBit(raw.include_replies),
    total_hidden: asInt(raw.total_hidden),
    total_flagged: asInt(raw.total_flagged),
    last_checked_at: asNullableInt(raw.last_checked_at),
    last_hidden_at: asNullableInt(raw.last_hidden_at),
    created_at: asInt(raw.created_at),
    updated_at: asInt(raw.updated_at),
  };
}

export async function listPosts(db: D1Database): Promise<PostRow[]> {
  const result = await db
    .prepare(`SELECT ${POST_COLUMNS} FROM posts ORDER BY created_at DESC, id DESC`)
    .all<RawRow>();
  return result.results.map(toPostRow);
}

export async function listActivePosts(db: D1Database): Promise<PostRow[]> {
  const result = await db
    .prepare(`SELECT ${POST_COLUMNS} FROM posts WHERE active = 1 ORDER BY id ASC`)
    .all<RawRow>();
  return result.results.map(toPostRow);
}

export async function getPost(db: D1Database, postId: string): Promise<PostRow | null> {
  const row = await db
    .prepare(`SELECT ${POST_COLUMNS} FROM posts WHERE post_id = ?`)
    .bind(postId)
    .first<RawRow>();
  return row === null ? null : toPostRow(row);
}

/**
 * Insert or merge. Unspecified flags keep whatever the stored row already has,
 * and label / permalink_url / page_id are never clobbered with NULL — a later
 * upsert that only knows the post id must not erase what the first one learned.
 */
export async function upsertPost(db: D1Database, input: UpsertPostInput): Promise<PostRow> {
  const ts = nowMs();
  const pageId = optionalValue(input.page_id);
  const label = optionalValue(input.label);
  const permalink = optionalValue(input.permalink_url);
  const active = optionalBit(input.active);
  const mode = optionalValue(input.mode);
  const dryRun = optionalBit(input.dry_run);
  const includeReplies = optionalBit(input.include_replies);

  await db
    .prepare(
      `INSERT INTO posts
         (post_id, page_id, label, permalink_url, active, mode, dry_run,
          include_replies, created_at, updated_at)
       VALUES
         (?, ?, ?, ?, COALESCE(?, 0), COALESCE(?, 'rules'), COALESCE(?, 0),
          COALESCE(?, 0), ?, ?)
       ON CONFLICT(post_id) DO UPDATE SET
         page_id         = COALESCE(excluded.page_id, posts.page_id),
         label           = COALESCE(excluded.label, posts.label),
         permalink_url   = COALESCE(excluded.permalink_url, posts.permalink_url),
         active          = COALESCE(?, posts.active),
         mode            = COALESCE(?, posts.mode),
         dry_run         = COALESCE(?, posts.dry_run),
         include_replies = COALESCE(?, posts.include_replies),
         updated_at      = ?`,
    )
    .bind(
      input.post_id,
      pageId,
      label,
      permalink,
      active,
      mode,
      dryRun,
      includeReplies,
      ts,
      ts,
      active,
      mode,
      dryRun,
      includeReplies,
      ts,
    )
    .run();

  const stored = await getPost(db, input.post_id);
  if (stored === null) {
    throw new Error(`upsertPost: post ${input.post_id} was not readable after the write`);
  }
  return stored;
}

function postPatchValue(column: PostPatchColumn, patch: Partial<UpsertPostInput>): unknown {
  switch (column) {
    case "active":
      return patch.active === undefined ? undefined : patch.active ? 1 : 0;
    case "dry_run":
      return patch.dry_run === undefined ? undefined : patch.dry_run ? 1 : 0;
    case "include_replies":
      return patch.include_replies === undefined ? undefined : patch.include_replies ? 1 : 0;
    case "mode":
      return patch.mode;
    default:
      return patch[column];
  }
}

export async function updatePost(
  db: D1Database,
  postId: string,
  patch: Partial<UpsertPostInput>,
): Promise<void> {
  const assignments = collectAssignments(POST_PATCH_COLUMNS, (column) =>
    postPatchValue(column, patch),
  );
  // An empty patch must not bump updated_at — callers use that as "last edited".
  if (assignments.length === 0) return;

  const sql = `UPDATE posts SET ${assignments
    .map((assignment) => `${assignment.column} = ?`)
    .join(", ")}, updated_at = ? WHERE post_id = ?`;

  await db
    .prepare(sql)
    .bind(...assignments.map((assignment) => assignment.value), nowMs(), postId)
    .run();
}

/**
 * Drops the post and any rule scoped to it. Comment rows survive on purpose:
 * they are the hidden-comment audit trail, and they keep a re-added post from
 * re-deciding history.
 */
export async function deletePost(db: D1Database, postId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM rules WHERE post_id = ?").bind(postId),
    db.prepare("DELETE FROM posts WHERE post_id = ?").bind(postId),
  ]);
}

export async function bumpPostCounters(
  db: D1Database,
  postId: string,
  delta: { hidden?: number; flagged?: number },
  when: number,
): Promise<void> {
  const hidden = Math.trunc(delta.hidden ?? 0);
  const flagged = Math.trunc(delta.flagged ?? 0);

  await db
    .prepare(
      `UPDATE posts SET
         total_hidden   = MAX(total_hidden + ?, 0),
         total_flagged  = MAX(total_flagged + ?, 0),
         last_hidden_at = CASE WHEN ? > 0 THEN ? ELSE last_hidden_at END,
         updated_at     = ?
       WHERE post_id = ?`,
    )
    .bind(hidden, flagged, hidden, when, when, postId)
    .run();
}

export async function touchPostChecked(
  db: D1Database,
  postId: string,
  when: number,
): Promise<void> {
  await db
    .prepare("UPDATE posts SET last_checked_at = ?, updated_at = ? WHERE post_id = ?")
    .bind(when, when, postId)
    .run();
}
