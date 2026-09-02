-- CommentHide — ledger integrity.
--
-- Two problems this fixes.
--
-- 1. Retention used to delete rows from `comments`. That table is not only an
--    audit log, it is the idempotency ledger: the `seen` rows written when a
--    post is activated are the ONLY thing keeping pre-existing comments out of
--    scope. Pruning them meant that after RETENTION_DAYS the poller re-decided
--    conversation that pre-dated CommentHide and hid it. `comments` is now
--    never pruned; only `events` and stale `auth_attempts` are.
--
-- 2. A comment whose hide permanently fails was retried every single minute,
--    forever. `attempts` bounds that.

-- Records that the pre-existing comments on a post were successfully marked as
-- seen. A post with no baseline must never be polled: doing so would hide
-- comments that were there before the operator arrived.
ALTER TABLE posts ADD COLUMN baselined_at INTEGER;

-- Existing installs completed their baseline at creation time under the old
-- flow, so they are grandfathered in rather than being paused on upgrade.
UPDATE posts SET baselined_at = created_at WHERE baselined_at IS NULL;

-- How many times a hide has been attempted and failed for this comment.
ALTER TABLE comments ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;

-- The poll loop looks comments up by id in bulk; the primary key covers that.
-- This one serves the dashboard's per-post error listing.
CREATE INDEX IF NOT EXISTS idx_comments_attempts ON comments(post_id, status, attempts);
