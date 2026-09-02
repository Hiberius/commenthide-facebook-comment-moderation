# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
