// auth_attempts: failed-login throttling, keyed by a client fingerprint.
//
// Policy: AUTH_MAX_FAILURES failures inside AUTH_WINDOW_MS lock that
// fingerprint for AUTH_LOCK_MS. The window resets on success (the caller clears
// the row) and once an expired lock is observed. "now" is always a parameter so
// the behaviour is deterministic under test.

import { asInt, asNullableInt, type RawRow } from "./internal";

export interface AuthLock {
  failures: number;
  lockedUntil: number | null;
}

export const AUTH_MAX_FAILURES = 8;
export const AUTH_WINDOW_MS = 15 * 60 * 1000;
export const AUTH_LOCK_MS = 15 * 60 * 1000;

const UNLOCKED: AuthLock = { failures: 0, lockedUntil: null };

interface AttemptRow {
  failures: number;
  firstFailAt: number;
  lockedUntil: number | null;
}

async function readAttempt(db: D1Database, fingerprint: string): Promise<AttemptRow | null> {
  const row = await db
    .prepare("SELECT failures, first_fail_at, locked_until FROM auth_attempts WHERE fingerprint = ?")
    .bind(fingerprint)
    .first<RawRow>();
  if (row === null) return null;
  return {
    failures: asInt(row.failures),
    firstFailAt: asInt(row.first_fail_at),
    lockedUntil: asNullableInt(row.locked_until),
  };
}

/** The state a stored row represents at `now`, with expiry already applied. */
function effectiveLock(row: AttemptRow | null, now: number): AuthLock {
  if (row === null) return { ...UNLOCKED };
  if (row.lockedUntil !== null && row.lockedUntil > now) {
    return { failures: row.failures, lockedUntil: row.lockedUntil };
  }
  // An expired lock, or a window that has run out, is a clean slate.
  if (row.lockedUntil !== null || now - row.firstFailAt >= AUTH_WINDOW_MS) {
    return { ...UNLOCKED };
  }
  return { failures: row.failures, lockedUntil: null };
}

export async function getAuthLock(
  db: D1Database,
  fingerprint: string,
  now: number,
): Promise<AuthLock> {
  return effectiveLock(await readAttempt(db, fingerprint), now);
}

export async function recordAuthFailure(
  db: D1Database,
  fingerprint: string,
  now: number,
): Promise<AuthLock> {
  const stored = await readAttempt(db, fingerprint);
  const current = effectiveLock(stored, now);

  // Already locked: nothing to count, and the lock must not creep forward on
  // every extra attempt.
  if (current.lockedUntil !== null) return current;

  const failures = current.failures + 1;
  const lockedUntil = failures >= AUTH_MAX_FAILURES ? now + AUTH_LOCK_MS : null;
  // A fresh window starts at this failure; an ongoing one keeps its origin.
  const firstFailAt = current.failures === 0 ? now : (stored?.firstFailAt ?? now);

  await db
    .prepare(
      `INSERT INTO auth_attempts (fingerprint, failures, first_fail_at, locked_until)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(fingerprint) DO UPDATE SET
         failures      = excluded.failures,
         first_fail_at = excluded.first_fail_at,
         locked_until  = excluded.locked_until`,
    )
    .bind(fingerprint, failures, firstFailAt, lockedUntil)
    .run();

  return { failures, lockedUntil };
}

export async function clearAuthFailures(db: D1Database, fingerprint: string): Promise<void> {
  await db.prepare("DELETE FROM auth_attempts WHERE fingerprint = ?").bind(fingerprint).run();
}
