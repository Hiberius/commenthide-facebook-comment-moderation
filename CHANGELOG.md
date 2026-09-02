# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-09-02

### Fixed

- **Retention no longer deletes the comment ledger.** `pruneHistory` used to remove any
  comment row that was not `hidden`, including the `seen` rows written when a post is
  activated. Those rows are the only thing keeping pre-existing comments out of scope, so
  after `RETENTION_DAYS` the poller re-decided conversation that predated CommentHide and
  hid whatever matched. It also erased `restored` rows, silently re-hiding comments the
  operator had deliberately un-hidden. Only events and stale login attempts are pruned now.
- **A dry run no longer settles the ledger.** Previewing a comment wrote a terminal row
  for it, so switching dry run off never hid anything the preview had promised. Dry-run
  rows are now re-decided by the first real run.
- **A post whose baseline did not complete is refused by every poll path.** "Run now" and
  the Active toggle both used to walk past the pause that protects such a post.
- **Overlapping runs can no longer both act on one comment.** The ledger row is claimed
  before the Graph write, so the loser of a race skips the comment instead of sending a
  duplicate hide and doubling the counters.
- **A permanently failing hide is retried three times, not forever.** It previously
  re-attempted every sixty seconds indefinitely, which is the fastest way to get an app
  rate-limited by Meta.
- **The Graph client will not send the access token to another origin.** A `paging.next`
  cursor naming a foreign host was followed with the `Authorization` header attached.
- **Pagination stops on the cursor, not on an empty page**, and warns instead of silently
  truncating. The activation baseline now pages to the end.
- **`/me/accounts` is paged**, so an account administering more than 100 Pages is no
  longer told it does not manage a Page it owns.
- **Replies cost no extra requests.** `filter=stream` already returns them flattened; the
  client used to walk each parent's reply edge as well, spending up to 25 subrequests per
  poll re-fetching comments it already had.
- **Login throttling is keyed on the IP alone.** Including the User-Agent let an attacker
  reset the counter on every request simply by varying a header they control.
- **Rotating `ADMIN_PASSWORD` invalidates existing sessions.**
- **A misconfigured Worker answers like a wrong password**, instead of naming the secret
  that is missing.
- **`__Host-` cookies are only relaxed on a local development host**, not on any request
  that happens to arrive over plain HTTP.
- **Regex rules are checked for catastrophic backtracking** before they are stored, and
  are only ever run against the first 400 characters of a comment.
- **Retention self-throttles to once an hour** instead of depending on the cron tick at
  UTC minute zero being delivered.
- The comment inspector reports **"Already decided"** instead of promising a verdict for a
  comment the next check will not revisit.

### Added

- `posts.baselined_at` and `comments.attempts` (migration `0002_ledger_integrity.sql`).
- A per-run read budget so a poll stays inside Cloudflare's subrequest cap.
- A circuit breaker that stops making requests once Meta is rate limiting the token.

## [1.0.0] - 2026-09-02

First public release.

### Added

- Rule engine with seven rule kinds — `keyword`, `regex`, `link`, `contact`,
  `emoji_spam`, `min_length` and `author_allow` — evaluated in priority order,
  first match wins, with an `allow` match short-circuiting to keep. Keyword
  matching is whole-word, case- and accent-insensitive. Rules can be global or
  scoped to a single post, and each carries a `hide`, `flag` or `allow` action.
- Dry-run preview: evaluate and record every decision without calling the Graph
  API, per post or forced for a single run, so a rule set can be proven against
  live comments before anything is hidden.
- Multi-post watching: any number of Page posts, each with its own mode
  (`rules` or `hide_all`), dry-run flag and reply setting. Activating a post
  records the comments already on it as seen, so switching the tool on only
  ever affects comments posted from that moment.
- Reply traversal: optionally fetch and evaluate replies to comments that have
  them.
- Comment pagination: follows the Graph API `paging.next` cursor across
  multiple pages per run instead of stopping at the first hundred comments.
- AES-256-GCM token storage: the Page Access Token is encrypted at rest with a
  fresh random IV, never returned to the browser, never logged, and never sent
  in a URL. Every string that could contain it is redacted first.
- Rate-limited login: 8 failed attempts from one client fingerprint within 15
  minutes lock that fingerprint for 15 minutes.
- CSRF protection: double-submit token required on every state-changing
  request, alongside HMAC-signed `__Host-` session cookies and a strict
  Content Security Policy.
- Audit log with undo: every decision is recorded with the rule that made it
  and the reason, and any hidden comment can be unhidden again from the
  dashboard, individually or in bulk per post.
- Automatic retention: a configurable `RETENTION_DAYS` window prunes old audit
  events and processed-comment rows.
- Cloudflare D1 storage: all state lives in the operator's own Cloudflare
  account — no third-party service and no telemetry.
- Cron polling every minute, with a manual "Run now" for local development,
  where cron triggers do not fire.
