// CommentHide — history retention.
//
// Runs from the same cron tick as the poll, so it is as reluctant to throw as
// the poll itself: a failed prune is never a reason to lose a run.

import type { Env } from "../types";
import { logEvent, pruneHistory } from "./storage";

const DAY_MS = 24 * 60 * 60 * 1000;

interface PruneCounts {
  events: number;
  comments: number;
}

function nothingPruned(): PruneCounts {
  return { events: 0, comments: 0 };
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

export async function runRetention(env: Env, now: number): Promise<PruneCounts> {
  const days = parseRetentionDays(env.RETENTION_DAYS);
  if (days === null) return nothingPruned();

  const cutoff = now - days * DAY_MS;
  try {
    const pruned = await pruneHistory(env.DB, cutoff);
    // The cron fires every minute; logging a no-op prune would bury the audit
    // log under noise that the retention job then has to prune itself.
    if (pruned.events > 0 || pruned.comments > 0) {
      await logEvent(env.DB, {
        level: "info",
        action: "retention",
        detail: `days=${days} events=${pruned.events} comments=${pruned.comments}`,
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
