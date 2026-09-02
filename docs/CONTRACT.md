# CommentHide — build contract

Every module is written against this file. Do not change a signature declared
here; if something is genuinely missing, add to it rather than redefining it.

Shared types live in `src/types.ts` — import from there, never redeclare.
Schema lives in `migrations/0001_init.sql` — the row types mirror it exactly.

Hard rules for every file:
- TypeScript strict, `noUncheckedIndexedAccess` is on.
- No file over 400 lines. Split before you exceed it.
- No mutation of inputs. Build and return new objects.
- Errors are handled explicitly; never swallow one silently.
- Every string that could contain a Page Access Token passes through
  `redact()` before it is logged, stored or returned.
- Comments in English, sparse, explaining *why* not *what*.

---

## src/lib/crypto.ts

```ts
export function encryptToken(plaintext: string, keyB64: string): Promise<string>
export function decryptToken(ciphertextB64: string, keyB64: string): Promise<string>
/** Replaces every occurrence of each secret with "[redacted]". Null-safe. */
export function redact(text: string, ...secrets: (string | null | undefined)[]): string
export function constantTimeEqual(a: string, b: string): boolean
/** Cryptographically random base64url string. */
export function randomToken(byteLength?: number): string
export function sha256Hex(input: string): Promise<string>
```

AES-256-GCM, 12-byte random IV prepended to the ciphertext, whole thing base64.
`encryptToken` rejects a key that is not exactly 32 bytes after base64-decoding.

---

## src/lib/storage.ts

All functions take `db: D1Database` first. No runtime `CREATE TABLE` — the
migration owns the schema.

```ts
// settings ------------------------------------------------------------------
export function getSetting(db: D1Database, key: string): Promise<string | null>
export function setSetting(db: D1Database, key: string, value: string): Promise<void>
export function deleteSetting(db: D1Database, key: string): Promise<void>

// posts ---------------------------------------------------------------------
export interface UpsertPostInput {
  post_id: string
  page_id?: string | null
  label?: string | null
  permalink_url?: string | null
  active?: boolean
  mode?: PostMode
  dry_run?: boolean
  include_replies?: boolean
}
export function listPosts(db: D1Database): Promise<PostRow[]>
export function listActivePosts(db: D1Database): Promise<PostRow[]>
export function getPost(db: D1Database, postId: string): Promise<PostRow | null>
export function upsertPost(db: D1Database, input: UpsertPostInput): Promise<PostRow>
export function updatePost(db: D1Database, postId: string, patch: Partial<UpsertPostInput>): Promise<void>
export function deletePost(db: D1Database, postId: string): Promise<void>
export function bumpPostCounters(
  db: D1Database, postId: string, delta: { hidden?: number; flagged?: number }, when: number,
): Promise<void>
export function touchPostChecked(db: D1Database, postId: string, when: number): Promise<void>

// rules ---------------------------------------------------------------------
export interface RuleInput {
  post_id?: string | null
  kind: RuleKind
  pattern?: string
  action?: RuleAction
  label?: string | null
  enabled?: boolean
  priority?: number
}
/** Global rules plus rules scoped to postId, ordered by priority then id. */
export function listRules(db: D1Database, postId?: string | null): Promise<RuleRow[]>
export function listAllRules(db: D1Database): Promise<RuleRow[]>
export function getRule(db: D1Database, id: number): Promise<RuleRow | null>
export function createRule(db: D1Database, input: RuleInput): Promise<RuleRow>
export function updateRule(db: D1Database, id: number, patch: Partial<RuleInput>): Promise<void>
export function deleteRule(db: D1Database, id: number): Promise<void>
export function bumpRuleHits(db: D1Database, ruleId: number, by?: number): Promise<void>
/** Inserts DEFAULT_RULES only if the rules table is empty. Returns rows created. */
export function seedDefaultRules(db: D1Database): Promise<number>

// comments ------------------------------------------------------------------
export interface RecordCommentInput {
  comment_id: string
  post_id: string
  status: CommentStatus
  matched_rule_id?: number | null
  matched_reason?: string | null
  author_name?: string | null
  message_preview?: string | null
  dry_run?: boolean
  actioned_at?: number | null
  error_message?: string | null
}
export function getComment(db: D1Database, commentId: string): Promise<CommentRow | null>
/** Single query. Returns a map keyed by comment_id; missing ids are absent. */
export function getComments(db: D1Database, commentIds: string[]): Promise<Map<string, CommentRow>>
export function recordComment(db: D1Database, input: RecordCommentInput): Promise<void>
export function listComments(db: D1Database, postId: string, limit?: number): Promise<CommentRow[]>
export function listCommentsByStatus(
  db: D1Database, postId: string, status: CommentStatus, limit?: number,
): Promise<CommentRow[]>
export function markRestored(db: D1Database, commentId: string): Promise<void>
export function countByStatus(db: D1Database, postId: string): Promise<Record<CommentStatus, number>>

// events --------------------------------------------------------------------
export interface EventInput {
  level: EventLevel
  action: string
  post_id?: string | null
  comment_id?: string | null
  detail?: string | null
  error_message?: string | null
}
export function logEvent(db: D1Database, input: EventInput): Promise<void>
export function recentEvents(db: D1Database, limit?: number): Promise<EventRow[]>

// login throttling ----------------------------------------------------------
export interface AuthLock { failures: number; lockedUntil: number | null }
export function getAuthLock(db: D1Database, fingerprint: string, now: number): Promise<AuthLock>
export function recordAuthFailure(db: D1Database, fingerprint: string, now: number): Promise<AuthLock>
export function clearAuthFailures(db: D1Database, fingerprint: string): Promise<void>

// maintenance ---------------------------------------------------------------
export function pruneHistory(db: D1Database, cutoffMs: number): Promise<{ events: number; authAttempts: number }>
export function globalTotals(db: D1Database): Promise<{ hidden: number; flagged: number; watched: number }>
```

Throttle policy: 8 failures inside 15 minutes locks that fingerprint for 15
minutes; the window resets after a success or once the lock expires.

---

## src/lib/graph.ts

One instance per poll run. `resolveTarget` memoises per instance — this is what
stops the old code from re-resolving the same post on every call.

```ts
export interface GraphClientOptions {
  version?: string
  /** Injected for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch
  /** Retry attempts for retryable failures. Default 3. */
  maxRetries?: number
  /** Injected for tests so retries do not really sleep. */
  sleep?: (ms: number) => Promise<void>
}

export interface FetchCommentsOptions {
  /** Page size, max 100. Default 100. */
  limit?: number
  /** Follow paging.next up to this many pages. Default 3. */
  maxPages?: number
  /** Also fetch replies for comments whose comment_count > 0. Default false. */
  includeReplies?: boolean
}

export class GraphClient {
  constructor(token: string, opts?: GraphClientOptions)
  identity(): Promise<GraphResult<GraphPageIdentity>>
  /** Accepts a numeric id, PAGEID_POSTID, or a facebook.com post URL. */
  resolveTarget(postInput: string): Promise<GraphResult<ResolvedTarget>>
  getPost(target: ResolvedTarget): Promise<GraphResult<GraphPost>>
  listRecentPosts(pageId?: string, limit?: number): Promise<GraphResult<GraphPost[]>>
  fetchComments(target: ResolvedTarget, opts?: FetchCommentsOptions): Promise<GraphResult<GraphComment[]>>
  setHidden(target: ResolvedTarget, commentId: string, hidden: boolean): Promise<GraphResult<{ success: boolean }>>
  testConnection(postInput: string): Promise<ConnectionTest>
}

/** Strips a facebook.com URL down to a usable post id. Pure. */
export function normalizePostInput(input: string): string
/** Graph rate-limit and transient codes: 1, 2, 4, 17, 32, 341, 613; HTTP 429/500/502/503/504. */
export function isRetryable(status: number, code?: number | string): boolean
```

Behaviour requirements:
- Retryable failures back off `250ms * 2^attempt` with jitter, honouring
  `sleep`. Non-retryable failures return immediately.
- `pfbid…` URLs cannot be resolved by the Graph API. Return a `GraphErr` with
  `code: "opaque_post_id"` and a message telling the user to pick the post from
  the Recent Posts list instead.
- When a post belongs to a Page the token does not directly represent, look the
  Page token up once via `/me/accounts` and cache it on the instance.
- Every error message passes through `redact(msg, token)`.

---

## src/lib/rules.ts — pure, no I/O

```ts
export interface CompiledRule { rule: RuleRow; test: (c: EvaluableComment) => boolean }
/** Returns null when the rule is disabled or its pattern is invalid. */
export function compileRule(rule: RuleRow): CompiledRule | null
/**
 * Evaluates in priority order, first match wins.
 * mode "hide_all" returns {verdict:"hide"} for anything no `allow` rule saves.
 * An `allow` match short-circuits to {verdict:"keep"}.
 * No match in "rules" mode returns {verdict:"keep", ruleId:null}.
 */
export function evaluate(comment: EvaluableComment, rules: RuleRow[], mode: PostMode): Decision
export function describeRule(rule: RuleRow): string
export interface DefaultRuleSeed { kind: RuleKind; pattern: string; action: RuleAction; label: string; priority: number }
export const DEFAULT_RULES: readonly DefaultRuleSeed[]
```

Rule-kind semantics — `pattern` is interpreted per kind:
| kind | pattern | matches when |
| --- | --- | --- |
| `keyword` | comma-separated terms | any term appears as a whole word, case- and accent-insensitive |
| `regex` | JS regex source (no delimiters) | the regex matches; invalid source compiles to null and is ignored |
| `link` | ignored | the message contains a URL or a bare domain |
| `contact` | ignored | the message contains a phone number, email or `@handle` |
| `emoji_spam` | integer threshold, default 5 | emoji count is at or above the threshold |
| `min_length` | integer, default 3 | the trimmed message is shorter than the threshold |
| `author_allow` | comma-separated author names or ids | the comment author matches — pair with `action: "allow"` |

`DEFAULT_RULES` ships a sensible starter set: an `author_allow` placeholder is
NOT included; include `link`, `contact`, `emoji_spam`, and a small
English + Italian spam keyword list. Keep it defensible — nothing that reads as
suppressing legitimate criticism.

Accent-insensitive means normalise with `String.prototype.normalize("NFD")` and
strip combining marks before comparing.

---

## src/lib/poller.ts

```ts
export function runPoll(env: Env, opts?: PollOptions): Promise<PollSummary>
```

Order of work per active post:
1. Resolve the target once via a single `GraphClient` shared across the run.
2. Fetch comments (respecting `include_replies`).
3. Load every already-seen comment in ONE `getComments` call — not one query per comment.
4. For each unseen comment: `evaluate()`, then act.
   - `hide` + not dry-run + `can_hide` → `setHidden(..., true)`, record `hidden`.
   - `hide` + dry-run → record `seen` with `dry_run: 1` and the reason. No Graph write.
   - `flag` → record `flagged`. No Graph write, ever.
   - `keep` → record `seen`.
   - `is_hidden` already true, or `can_hide` false → record `skipped` with the reason.
5. `bumpRuleHits` for whichever rule decided, `bumpPostCounters`, `touchPostChecked`.
6. One summary `logEvent` per run.

A comment already in the `comments` table is never re-processed unless its
status is `error`.

## src/lib/retention.ts

```ts
/** Reads RETENTION_DAYS. Returns {events:0,comments:0} when disabled. */
export function runRetention(env: Env, now: number): Promise<{ events: number; comments: number }>
```

---

## src/lib/auth.ts

```ts
export function login(c: Context<AppEnv>, password: string):
  Promise<{ ok: true } | { ok: false; error: string; retryAfterSec?: number }>
export function logout(c: Context<AppEnv>): void
export function isAuthed(c: Context<AppEnv>): Promise<boolean>
export const requireAuth: MiddlewareHandler<AppEnv>
/** Mints (or reuses) the double-submit CSRF token and returns it. */
export function csrfToken(c: Context<AppEnv>): Promise<string>
/** Rejects non-GET requests whose x-csrf-token header does not match the cookie. */
export const requireCsrf: MiddlewareHandler<AppEnv>
```

Session cookie: name `__Host-ch_session`, `HttpOnly`, `Secure`, `SameSite=Strict`,
`Path=/`, 7-day max age, value `<issuedAt>.<base64url HMAC-SHA256>`.
CSRF cookie: `__Host-ch_csrf`, readable by JS (not HttpOnly), same lifetime.
The login fingerprint is `sha256Hex(cf-connecting-ip + user-agent)`.

Note: `__Host-` cookies require HTTPS. `wrangler dev` serves plain HTTP on
localhost, so fall back to unprefixed cookie names when
`new URL(c.req.url).protocol !== "https:"`. Keep every other attribute.

## src/lib/security.ts

```ts
/** CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy. */
export const securityHeaders: MiddlewareHandler<AppEnv>
```

The dashboard is one self-contained HTML document with an inline `<style>` and
inline `<script>`, so the CSP must allow `'unsafe-inline'` for style and script
on `'self'` only. Everything else is `'none'`; `connect-src 'self'`.

---

## HTTP API — routes own these exactly

Mount under `/api`. Every route except `GET /`, `POST /api/session` and `GET /health`
requires auth. Every non-GET `/api` route except `POST /api/session` requires CSRF.
JSON in, JSON out. Errors: `{ error: string }` with a 4xx/5xx status.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| POST | `/api/session` | `{password}` | `{ok:true, csrfToken}` |
| DELETE | `/api/session` | — | `{ok:true}` |
| GET | `/api/status` | — | `StatusPayload & {csrfToken}` |
| PUT | `/api/page/token` | `{token}` | `{ok:true, page:{id,name}}` |
| DELETE | `/api/page/token` | — | `{ok:true}` |
| GET | `/api/page/posts` | — | `{posts: GraphPost[]}` |
| GET | `/api/posts` | — | `{posts: PostRow[]}` |
| POST | `/api/posts` | `{postId, label?, mode?, dryRun?, includeReplies?, baseline?}` | `{ok:true, post: PostRow, test: ConnectionTest}` |
| PATCH | `/api/posts/:postId` | `{active?, mode?, dryRun?, label?, includeReplies?}` | `{ok:true, post: PostRow}` |
| DELETE | `/api/posts/:postId` | — | `{ok:true}` |
| GET | `/api/posts/:postId/comments` | — | `{post, stats, comments: CommentView[]}` |
| POST | `/api/posts/:postId/test` | — | `ConnectionTest` |
| POST | `/api/posts/:postId/restore` | — | `{ok:true, restored, errors}` |
| GET | `/api/rules` | — | `{rules: RuleRow[]}` |
| POST | `/api/rules` | `RuleInput` | `{ok:true, rule: RuleRow}` |
| PATCH | `/api/rules/:id` | `Partial<RuleInput>` | `{ok:true}` |
| DELETE | `/api/rules/:id` | — | `{ok:true}` |
| POST | `/api/rules/seed` | — | `{ok:true, created:number}` |
| POST | `/api/run` | `{postId?, dryRun?}` | `{ok:true, summary: PollSummary}` |
| POST | `/api/comments/:commentId/hide` | `{postId}` | `{ok:true}` |
| POST | `/api/comments/:commentId/show` | `{postId}` | `{ok:true}` |
| GET | `/api/events` | `?limit=` | `{events: EventRow[]}` |
| GET | `/health` | — | `{ok:true, version}` |

`baseline: true` on `POST /api/posts` records every comment currently on the
post as `seen` so activation only ever affects comments posted from now on.
This is the default and it is what makes the tool safe to switch on.

---

## Design system — shared by the dashboard AND the README artwork

Liquid glass, dark-first, editorial. **No web fonts anywhere** — system stack
only, so the app has no third-party request and the README SVGs render
identically on GitHub.

```
--ink-950  #05070d      page base, bottom of the gradient
--ink-900  #090d18
--ink-800  #0e1424
--glass     rgba(255,255,255,0.055)   panel fill
--glass-hi  rgba(255,255,255,0.10)    hover / raised panel
--edge      rgba(255,255,255,0.14)    1px specular border, top-lit
--text      #e8ecf7
--text-dim  #8f9bb8
--teal      #5eead4
--indigo    #818cf8
--violet    #c084fc
--ok        #34d399
--warn      #fbbf24
--danger    #fb7185
radius: 18px panels, 12px controls, 999px pills
```

Glass recipe for a panel: `background: var(--glass)`,
`backdrop-filter: blur(28px) saturate(180%)`, a 1px border that is brighter at
the top than the bottom (inset gradient, simulating a light source above), a
soft outer shadow, and a faint SVG grain overlay at ~3% opacity.

Aurora: two or three large, heavily blurred radial gradients in teal/indigo/
violet fixed behind the glass, so the blur has something to refract.

Motion: `cubic-bezier(0.16, 1, 0.3, 1)`, 180–320ms, only `transform`, `opacity`,
`filter`, `backdrop-filter`. Everything inside
`@media (prefers-reduced-motion: reduce)` collapses to no motion.

Accessibility is not optional: visible focus rings, AA contrast on text,
semantic landmarks, labelled controls, `aria-live` on the toast region.
