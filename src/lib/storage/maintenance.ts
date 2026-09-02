// Retention and roll-up queries.

import { asInt } from "./internal";

/**
 * Drops history older than the cutoff. Hidden comments are exempt: they are the
 * audit trail that makes "show this comment again" possible, so pruning must
 * never take them.
 */
export async function pruneHistory(
  db: D1Database,
  cutoffMs: number,
): Promise<{ events: number; comments: number }> {
  const [eventsResult, commentsResult] = await db.batch([
    db.prepare("DELETE FROM events WHERE ts < ?").bind(cutoffMs),
    db.prepare("DELETE FROM comments WHERE first_seen_at < ? AND status != 'hidden'").bind(cutoffMs),
  ]);

  return {
    events: eventsResult === undefined ? 0 : asInt(eventsResult.meta.changes),
    comments: commentsResult === undefined ? 0 : asInt(commentsResult.meta.changes),
  };
}

/**
 * Lifetime totals across every post — pausing a post must not make its history
 * disappear from the dashboard — plus the count of posts currently watched.
 */
export async function globalTotals(
  db: D1Database,
): Promise<{ hidden: number; flagged: number; watched: number }> {
  const row = await db
    .prepare(
      `SELECT
         COALESCE(SUM(total_hidden), 0)  AS hidden,
         COALESCE(SUM(total_flagged), 0) AS flagged,
         COALESCE(SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END), 0) AS watched
       FROM posts`,
    )
    .first<Record<string, unknown>>();

  if (row === null) return { hidden: 0, flagged: 0, watched: 0 };
  return {
    hidden: asInt(row.hidden),
    flagged: asInt(row.flagged),
    watched: asInt(row.watched),
  };
}
