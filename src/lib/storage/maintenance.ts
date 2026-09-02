// Retention and roll-up queries.

import { asInt } from "./internal";

/** Failed-login rows older than this are of no further use. */
const AUTH_ATTEMPT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Drops history older than the cutoff.
 *
 * `comments` is deliberately NOT pruned. That table is the idempotency ledger
 * as well as the audit trail: every row carries a standing decision, and the
 * `seen` rows written when a post is activated are the only thing keeping
 * pre-existing conversation out of scope. Deleting any of them makes the poller
 * re-decide a comment it has already settled — which, for a baseline row, means
 * hiding a comment that pre-dates CommentHide, and for a `restored` row means
 * silently re-hiding something the operator deliberately un-hid.
 *
 * The ledger is bounded by real comment volume rather than by time, which at a
 * few hundred bytes a row is not a problem D1 needs help with.
 */
export async function pruneHistory(
  db: D1Database,
  cutoffMs: number,
): Promise<{ events: number; authAttempts: number }> {
  const [eventsResult, attemptsResult] = await db.batch([
    db.prepare("DELETE FROM events WHERE ts < ?").bind(cutoffMs),
    // Unauthenticated requests can create these, so they are pruned on their
    // own short clock rather than the operator's retention setting.
    db
      .prepare("DELETE FROM auth_attempts WHERE first_fail_at < ? AND (locked_until IS NULL OR locked_until < ?)")
      .bind(Date.now() - AUTH_ATTEMPT_TTL_MS, Date.now()),
  ]);

  return {
    events: eventsResult === undefined ? 0 : asInt(eventsResult.meta.changes),
    authAttempts: attemptsResult === undefined ? 0 : asInt(attemptsResult.meta.changes),
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
