// CommentHide — shared contract.
//
// Every module in src/ codes against the types declared here. This file has no
// imports of its own so it can never introduce a dependency cycle.

// ---------------------------------------------------------------------------
// Worker environment
// ---------------------------------------------------------------------------

export interface Env {
  DB: D1Database;
  /** Dashboard login password (Cloudflare secret). */
  ADMIN_PASSWORD: string;
  /** base64 of exactly 32 random bytes — AES-256-GCM key (Cloudflare secret). */
  ENCRYPTION_KEY: string;
  /** HMAC-SHA256 key for session cookie signatures (Cloudflare secret). */
  SESSION_SECRET: string;
  /** Graph API version segment, e.g. "v25.0". */
  GRAPH_API_VERSION?: string;
  /** Days of history to keep. "0" or unset disables pruning. */
  RETENTION_DAYS?: string;
  /**
   * Overrides the Graph API origin (default https://graph.facebook.com).
   * Development and testing only — never point this at an untrusted host.
   */
  GRAPH_API_BASE?: string;
}

export type AppEnv = { Bindings: Env };

// ---------------------------------------------------------------------------
// Domain rows (mirror migrations/0001_init.sql exactly)
// ---------------------------------------------------------------------------

export type PostMode = "rules" | "hide_all";

export interface PostRow {
  id: number;
  post_id: string;
  page_id: string | null;
  label: string | null;
  permalink_url: string | null;
  active: 0 | 1;
  mode: PostMode;
  dry_run: 0 | 1;
  include_replies: 0 | 1;
  total_hidden: number;
  total_flagged: number;
  last_checked_at: number | null;
  last_hidden_at: number | null;
  /**
   * When the pre-existing comments on this post were successfully recorded as
   * seen. Null means the baseline never completed, and the post must not be
   * polled: doing so would hide conversation that pre-dates CommentHide.
   */
  baselined_at: number | null;
  created_at: number;
  updated_at: number;
}

export type RuleKind =
  | "keyword"
  | "regex"
  | "link"
  | "contact"
  | "emoji_spam"
  | "min_length"
  | "author_allow";

export type RuleAction = "hide" | "flag" | "allow";

export interface RuleRow {
  id: number;
  /** null = applies to every watched post. */
  post_id: string | null;
  kind: RuleKind;
  pattern: string;
  action: RuleAction;
  label: string | null;
  enabled: 0 | 1;
  priority: number;
  hit_count: number;
  created_at: number;
  updated_at: number;
}

export type CommentStatus =
  | "seen"
  | "hidden"
  | "flagged"
  | "skipped"
  | "error"
  | "restored";

export interface CommentRow {
  comment_id: string;
  post_id: string;
  status: CommentStatus;
  matched_rule_id: number | null;
  matched_reason: string | null;
  author_name: string | null;
  message_preview: string | null;
  dry_run: 0 | 1;
  first_seen_at: number;
  actioned_at: number | null;
  error_message: string | null;
  /** Failed hide attempts. Bounded so a permanent failure is not retried forever. */
  attempts: number;
}

export type EventLevel = "info" | "warn" | "error";

export interface EventRow {
  id: number;
  ts: number;
  level: EventLevel;
  action: string;
  post_id: string | null;
  comment_id: string | null;
  detail: string | null;
  error_message: string | null;
}

// ---------------------------------------------------------------------------
// Meta Graph API
// ---------------------------------------------------------------------------

export interface GraphOk<T> {
  ok: true;
  data: T;
}

export interface GraphErr {
  ok: false;
  /** HTTP status, or 0 for a network-level failure. */
  status: number;
  /** Graph error code (e.g. 190 invalid token, 4/17/32/613 rate limits). */
  code?: number | string;
  subcode?: number | string;
  type?: string;
  /** Human-readable message. Always passes through redact() first. */
  message: string;
  /** True when a retry with backoff could plausibly succeed. */
  retryable?: boolean;
}

export type GraphResult<T> = GraphOk<T> | GraphErr;

/** A comment exactly as the Graph API returns it. */
export interface GraphComment {
  id: string;
  message?: string;
  created_time?: string;
  from?: { id?: string; name?: string };
  can_hide?: boolean;
  is_hidden?: boolean;
  comment_count?: number;
}

export interface GraphCommentsPage {
  data: GraphComment[];
  paging?: { cursors?: { before?: string; after?: string }; next?: string };
}

export interface GraphPost {
  id: string;
  message?: string;
  created_time?: string;
  permalink_url?: string;
}

export interface GraphPageIdentity {
  id: string;
  name?: string;
}

/** A post id resolved to its canonical PAGEID_POSTID form plus a usable token. */
export interface ResolvedTarget {
  input: string;
  postId: string;
  pageId?: string;
  accessToken: string;
}

export interface ConnectionTest {
  ok: boolean;
  postId?: string;
  pageId?: string;
  permalinkUrl?: string;
  sampleComments?: number;
  error?: string;
  errorType?: string;
  errorCode?: string | number;
}

// ---------------------------------------------------------------------------
// Rule engine (pure — no I/O, no Graph, no D1)
// ---------------------------------------------------------------------------

/** A comment normalised into just what the rule engine needs to decide. */
export interface EvaluableComment {
  id: string;
  message: string;
  authorId?: string;
  authorName?: string;
}

export type Verdict = "hide" | "flag" | "keep";

export interface Decision {
  verdict: Verdict;
  /** id of the rule that decided this, or null when nothing matched. */
  ruleId: number | null;
  /** Short, human-readable explanation shown in the dashboard and audit log. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

export interface PollSummary {
  fetched: number;
  hidden: number;
  flagged: number;
  skipped: number;
  errors: number;
  /** True when decisions were recorded but no Graph write was performed. */
  dryRun: boolean;
}

export interface PollOptions {
  /** Triggered from the dashboard rather than the cron schedule. */
  manual?: boolean;
  /** Limit the run to a single post id. */
  onlyPostId?: string;
  /** Force dry-run regardless of the post's stored setting. */
  forceDryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Dashboard API payloads
// ---------------------------------------------------------------------------

export interface StatusPayload {
  active: boolean;
  hasToken: boolean;
  pageName: string | null;
  totals: { hidden: number; flagged: number; watched: number };
  posts: PostRow[];
  lastCheckedAt: number | null;
}

/** A comment enriched with what CommentHide already knows about it. */
export interface CommentView {
  id: string;
  message: string;
  createdTime?: string;
  authorName?: string;
  isHidden: boolean;
  canHide: boolean;
  status: CommentStatus | null;
  reason: string | null;
  /**
   * What a real poll would do to this comment right now — not the raw rule
   * verdict. "settled" means the comment already carries a decision the poller
   * will not revisit, so no rule outcome can apply to it any more.
   */
  wouldBe: Verdict | "settled";
}
