// CommentHide — history retention.
//
// Runs from the same cron tick as the poll, so it is as reluctant to throw as
// the poll itself: a failed prune is never a reason to lose a run.
//
// It self-throttles through a stored timestamp rather than firing on a
// particular minute. Cloudflare does not guarantee that any specific tick is
// delivered, and a job that only ran at UTC minute 0 would simply never run on
// a Worker that missed it.

import type { Env } from "../types";
import { getSetting, logEvent, pruneHistory, setSetting } from "./storage";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const LAST_RUN_KEY = "retention_last_run";

interface PruneCounts {
  events: number;
  authAttempts: number;
}

function nothingPruned(): PruneCounts {
  return { events: 0, authAttempts: 0 };
}

/** Days of history to keep, or null when retention is switched off. */
function parseRetentionDays(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const days = Number(trimmed);
  // Rejects "", "abc", "0", negatives and Infinity in one check.
  if (!Number.isFinite(days) || days <= 0) return null;
  return days;
}

/** True when at least an hour has passed since the last successful prune. */
async function isDue(env: Env, now: number): Promise<boolean> {
  const raw = await getSetting(env.DB, LAST_RUN_KEY);
  if (raw === null) return true;
  const last = Number(raw);
  if (!Number.isFinite(last)) return true;
  // A clock that jumped backwards must not lock retention out forever.
  return now - last >= HOUR_MS || now < last;
}

export async function runRetention(env: Env, now: number): Promise<PruneCounts> {
  const days = parseRetentionDays(env.RETENTION_DAYS);
  if (days === null) return nothingPruned();
  if (!Number.isFinite(now)) return nothingPruned();

  try {
    if (!(await isDue(env, now))) return nothingPruned();

    const cutoff = now - days * DAY_MS;
    const pruned = await pruneHistory(env.DB, cutoff);
    await setSetting(env.DB, LAST_RUN_KEY, String(now));

    // Logging a no-op prune every hour would bury the audit log under noise
    // that retention then has to prune itself.
    if (pruned.events > 0 || pruned.authAttempts > 0) {
      await logEvent(env.DB, {
        level: "info",
        action: "retention",
        detail: `days=${days} events=${pruned.events} auth_attempts=${pruned.authAttempts}`,
      });
    }
    return pruned;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await logEvent(env.DB, {
        level: "error",
        action: "retention",
        detail: "prune_failed",
        error_message: message,
      });
    } catch (logErr) {
      const logMessage = logErr instanceof Error ? logErr.message : String(logErr);
      console.error("commenthide: retention log write failed:", logMessage);
    }
    return nothingPruned();
  }
}
