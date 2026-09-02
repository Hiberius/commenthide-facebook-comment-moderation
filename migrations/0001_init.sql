-- CommentHide — initial schema.
-- One Cloudflare D1 database holds every watched post, moderation rule,
-- processed-comment record and audit event.

-- ---------------------------------------------------------------------------
-- settings: singleton key/value store for global configuration.
-- Known keys: "page_token" (AES-GCM ciphertext), "page_id", "page_name".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- posts: every Facebook Page post CommentHide watches.
-- mode: 'rules' evaluates the rule set, 'hide_all' hides every new comment.
-- dry_run: evaluate and record decisions without calling the Graph API.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS posts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id          TEXT NOT NULL UNIQUE,
  page_id          TEXT,
  label            TEXT,
  permalink_url    TEXT,
  active           INTEGER NOT NULL DEFAULT 0,
  mode             TEXT NOT NULL DEFAULT 'rules',
  dry_run          INTEGER NOT NULL DEFAULT 0,
  include_replies  INTEGER NOT NULL DEFAULT 0,
  total_hidden     INTEGER NOT NULL DEFAULT 0,
  total_flagged    INTEGER NOT NULL DEFAULT 0,
  last_checked_at  INTEGER,
  last_hidden_at   INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  CHECK (mode IN ('rules', 'hide_all')),
  CHECK (active IN (0, 1)),
  CHECK (dry_run IN (0, 1)),
  CHECK (include_replies IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_posts_active ON posts(active);

-- ---------------------------------------------------------------------------
-- rules: the moderation rule set.
-- post_id NULL means the rule applies to every watched post.
-- Lower priority numbers are evaluated first; the first match wins.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    TEXT,
  kind       TEXT NOT NULL,
  pattern    TEXT NOT NULL DEFAULT '',
  action     TEXT NOT NULL DEFAULT 'hide',
  label      TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1,
  priority   INTEGER NOT NULL DEFAULT 100,
  hit_count  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (kind IN ('keyword', 'regex', 'link', 'contact', 'emoji_spam', 'min_length', 'author_allow')),
  CHECK (action IN ('hide', 'flag', 'allow')),
  CHECK (enabled IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_rules_scope ON rules(post_id, enabled, priority);

-- ---------------------------------------------------------------------------
-- comments: one row per comment CommentHide has already decided on.
-- Doubles as the idempotency ledger and the audit trail for undo.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS comments (
  comment_id      TEXT PRIMARY KEY,
  post_id         TEXT NOT NULL,
  status          TEXT NOT NULL,
  matched_rule_id INTEGER,
  matched_reason  TEXT,
  author_name     TEXT,
  message_preview TEXT,
  dry_run         INTEGER NOT NULL DEFAULT 0,
  first_seen_at   INTEGER NOT NULL,
  actioned_at     INTEGER,
  error_message   TEXT,
  CHECK (status IN ('seen', 'hidden', 'flagged', 'skipped', 'error', 'restored')),
  CHECK (dry_run IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(post_id, status);

-- ---------------------------------------------------------------------------
-- events: append-only audit log. Pruned by the retention job.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  level         TEXT NOT NULL,
  action        TEXT NOT NULL,
  post_id       TEXT,
  comment_id    TEXT,
  detail        TEXT,
  error_message TEXT,
  CHECK (level IN ('info', 'warn', 'error'))
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);

-- ---------------------------------------------------------------------------
-- auth_attempts: failed-login throttling, keyed by client fingerprint.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth_attempts (
  fingerprint  TEXT PRIMARY KEY,
  failures     INTEGER NOT NULL DEFAULT 0,
  first_fail_at INTEGER NOT NULL,
  locked_until INTEGER
);
