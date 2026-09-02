// Shared D1 fixtures for the storage suites.
//
// Not a `.test.ts` file on purpose: vitest only collects `*.test.ts`, so this
// module is imported, never run as a suite. It exists because the storage tests
// outgrew one 400-line file and both halves need the same clean-database seam.

import { env } from "cloudflare:test";

import type { CommentStatus } from "../src/types";

export const db = env.DB;

/** Fixed wall clock for every timestamp a caller supplies explicitly. */
export const T0 = 1_700_000_000_000;

/**
 * The pool's setup file applies the migration once per *file*; a suite that
 * counts rows and asserts on AUTOINCREMENT ids needs a clean slate per *test*.
 * The statements come from the migration the pool already parsed for us, so
 * this can never drift from migrations/0001_init.sql and needs no disk access.
 */
const SCHEMA_QUERIES: readonly string[] = env.TEST_MIGRATIONS.flatMap(
  (migration: { queries: string[] }) => migration.queries,
);

if (SCHEMA_QUERIES.length === 0) {
  throw new Error(
    "TEST_MIGRATIONS is empty — vitest.config.ts must readD1Migrations('migrations')",
  );
}

const INSERT_COMMENT_SQL = `INSERT INTO comments
  (comment_id, post_id, status, author_name, message_preview, dry_run, first_seen_at)
  VALUES (?, ?, ?, ?, ?, 0, ?)`;

export async function resetDatabase(): Promise<void> {
  // Dropping rather than DELETEing also resets sqlite_sequence, which is what
  // makes this suite's id-ordering assertions deterministic. D1's authorizer
  // rejects any statement touching its own sqlite_* / _cf_* tables, so those
  // are filtered out here rather than being caught and ignored later.
  const tables = await db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
         AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'`,
    )
    .all<{ name: string }>();

  if (tables.results.length > 0) {
    await db.batch(
      tables.results.map((row: { name: string }) =>
        db.prepare(`DROP TABLE IF EXISTS "${row.name}"`),
      ),
    );
  }
  await db.batch(SCHEMA_QUERIES.map((query) => db.prepare(query)));
}

function chunkIds(ids: readonly string[], size: number): string[][] {
  return Array.from({ length: Math.ceil(ids.length / size) }, (_unused, index) =>
    ids.slice(index * size, index * size + size),
  );
}

/**
 * Comment fixtures go in through raw SQL rather than recordComment because the
 * storage layer stamps first_seen_at with Date.now(), and retention, ordering
 * and "first_seen_at never moves" are all assertions about a controlled age.
 */
export async function insertComment(
  commentId: string,
  postId: string,
  status: CommentStatus,
  firstSeenAt: number,
  authorName: string | null = null,
  preview: string | null = null,
): Promise<void> {
  await db
    .prepare(INSERT_COMMENT_SQL)
    .bind(commentId, postId, status, authorName, preview, firstSeenAt)
    .run();
}

/** Seeds `c-1`…`c-<count>` on one post. Used to push getComments past a chunk. */
export async function seedComments(postId: string, count: number): Promise<string[]> {
  const ids = Array.from({ length: count }, (_unused, index) => `c-${index + 1}`);
  for (const group of chunkIds(ids, 50)) {
    await db.batch(
      group.map((id) => db.prepare(INSERT_COMMENT_SQL).bind(id, postId, "seen", null, null, T0)),
    );
  }
  return ids;
}

export async function insertEvent(ts: number, action: string): Promise<void> {
  await db
    .prepare("INSERT INTO events (ts, level, action) VALUES (?, 'info', ?)")
    .bind(ts, action)
    .run();
}
