// CommentHide — pure helpers for the Graph client.
//
// Split out of graph.ts to keep both files under the 400-line ceiling. Nothing
// here does I/O, so every branch is directly unit-testable. The public surface
// the contract names (normalizePostInput, isRetryable) is re-exported from
// graph.ts, which stays the only import site for the rest of the app.

import type { ConnectionTest, GraphErr } from "../types";

const RETRYABLE_HTTP: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
/** Graph transient / rate-limit codes. */
const RETRYABLE_CODES: ReadonlySet<number> = new Set([1, 2, 4, 17, 32, 341, 613]);
/** Codes that invalidate every later call too, so there is no point continuing. */
const FATAL_AUTH_CODES: ReadonlySet<number> = new Set([10, 102, 190, 200, 458, 459, 463, 467]);

/** URL path segments immediately followed by the post id. */
const POST_PATH_KEYS: ReadonlySet<string> = new Set([
  "posts", "videos", "photos", "reel", "reels", "permalink", "activity",
]);

/** Strips a facebook.com URL down to a usable post id. Pure. */
export function normalizePostInput(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "") return "";
  const looksLikeUrl =
    /^https?:\/\//i.test(trimmed) || /\b(?:facebook|fb)\.(?:com|watch|me)\b/i.test(trimmed);
  if (!looksLikeUrl) return trimmed.replace(/^\/+|\/+$/g, "");

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return trimmed; // Unparseable — hand it back and let Graph reject it.
  }

  const owner = url.searchParams.get("id");
  const story = url.searchParams.get("story_fbid") ?? url.searchParams.get("fbid");
  if (story !== null && story !== "") {
    return owner !== null && owner !== "" ? `${owner}_${story}` : story;
  }
  const video = url.searchParams.get("v");
  if (video !== null && video !== "") return video;

  const parts = url.pathname.split("/").filter((p) => p !== "");
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const seg = parts[i];
    if (seg === undefined || !POST_PATH_KEYS.has(seg.toLowerCase())) continue;
    const id = parts[i + 1];
    if (id === undefined || id === "") continue;
    const ownerSeg = i > 0 ? parts[i - 1] : undefined;
    // /<numeric page id>/posts/<id> is the only shape that hands us both halves.
    return ownerSeg !== undefined && /^\d+$/.test(ownerSeg) && !id.includes("_")
      ? `${ownerSeg}_${id}`
      : id;
  }
  return parts[parts.length - 1] ?? trimmed;
}

/** Graph rate-limit and transient codes: 1, 2, 4, 17, 32, 341, 613; HTTP 429/500/502/503/504. */
export function isRetryable(status: number, code?: number | string): boolean {
  const n = toCode(code);
  if (n !== undefined && RETRYABLE_CODES.has(n)) return true;
  return RETRYABLE_HTTP.has(status);
}

/** Graph reports codes as numbers, but some edges hand them back as strings. */
export function toCode(code: number | string | undefined): number | undefined {
  if (typeof code === "number") return Number.isFinite(code) ? code : undefined;
  if (typeof code !== "string") return undefined;
  const n = Number.parseInt(code, 10);
  return Number.isFinite(n) ? n : undefined;
}

export function isFatalAuth(code: number | string | undefined): boolean {
  const n = toCode(code);
  return n !== undefined && FATAL_AUTH_CODES.has(n);
}

/** 250ms * 2^attempt with ±25% CSPRNG jitter, so concurrent Workers desynchronise. */
export function backoffMs(attempt: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  const unit = (buf[0] ?? 0) / 0x1_0000_0000;
  return Math.round(250 * 2 ** attempt * (0.75 + unit * 0.5));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function describeThrown(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : "unknown error";
}

/**
 * Turns a raw Graph message into something the operator can act on. 190 and
 * 200/10 are the two failures essentially every user hits, so they get explicit
 * instructions rather than Meta's wording.
 */
export function explain(status: number, code: number | string | undefined, message: string): string {
  const base = message.trim() === "" ? `The Graph API returned HTTP ${status}.` : message.trim();
  switch (toCode(code)) {
    case 190:
      return `${base} — the Page Access Token is invalid or has expired. Generate a fresh token (Meta Business Suite, or the Graph API Explorer with your Page selected) and save it again under Settings.`;
    case 200:
    case 10:
      return `${base} — the token is missing a permission. Re-create it with pages_read_engagement and pages_manage_engagement granted for this Page, then save it again.`;
    case 100:
      return `${base} — Graph did not recognise that id or field. Check the post still exists and that its id is in PAGEID_POSTID form.`;
    case 4:
    case 17:
    case 32:
    case 613:
      return `${base} — a Graph rate limit was hit. CommentHide backs off and retries automatically.`;
    case 803:
      return `${base} — that object is not visible to this token. It may belong to a different Page.`;
    default:
      return base;
  }
}

export type TestStage = "resolve" | "post_lookup" | "comment_read";

const STAGE_PREFIX: Readonly<Record<TestStage, string>> = {
  resolve: "Could not resolve the post",
  post_lookup: "Could not read the post",
  comment_read: "Could not read the post's comments",
};

/** Builds the failure half of a ConnectionTest, naming the stage that broke. */
export function failedTest(
  err: GraphErr,
  stage: TestStage,
  context: { postId?: string; pageId?: string },
): ConnectionTest {
  return {
    ok: false,
    ...context,
    error: `${STAGE_PREFIX[stage]}: ${err.message}`,
    errorType: err.type ?? stage,
    ...(err.code !== undefined ? { errorCode: err.code } : {}),
  };
}
