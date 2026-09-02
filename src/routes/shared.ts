// CommentHide — helpers shared by the HTTP route modules.
//
// Boundary validation lives here rather than inside each handler so every
// endpoint rejects malformed input identically, and always names the field that
// was wrong instead of answering a generic "bad request".

import type { Context } from "hono";
import type { AppEnv, Env, GraphErr, PostMode, RuleAction, RuleKind } from "../types";
import { decryptToken } from "../lib/crypto";
import { GraphClient } from "../lib/graph";
import { getSetting } from "../lib/storage";

/** settings keys owned by the connection screen. */
export const SETTING_TOKEN = "page_token";
export const SETTING_PAGE_ID = "page_id";
export const SETTING_PAGE_NAME = "page_name";

/** The only statuses this API ever answers an error with. */
export type ApiErrorStatus = 400 | 401 | 403 | 404 | 429 | 500 | 502;

export type JsonObject = Record<string, unknown>;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

// Runtime mirrors of the unions in types.ts. `satisfies` turns any drift between
// the two into a compile error rather than a validation hole.
export const POST_MODES = ["rules", "hide_all"] as const satisfies readonly PostMode[];

export const RULE_KINDS = [
  "keyword",
  "regex",
  "link",
  "contact",
  "emoji_spam",
  "min_length",
  "author_allow",
] as const satisfies readonly RuleKind[];

export const RULE_ACTIONS = ["hide", "flag", "allow"] as const satisfies readonly RuleAction[];

function valid<T>(value: T): Parsed<T> {
  return { ok: true, value };
}

function invalid<T>(error: string): Parsed<T> {
  return { ok: false, error };
}

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------

function asObject(raw: unknown): Parsed<JsonObject> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return invalid("request body must be a JSON object");
  }
  return valid(raw as JsonObject);
}

/** For endpoints that require a body. A missing or malformed one is an error. */
export async function readJson(c: Context<AppEnv>): Promise<Parsed<JsonObject>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return invalid("invalid json");
  }
  return asObject(raw);
}

/**
 * For endpoints whose body is entirely optional. An absent body reads as `{}`,
 * so a plain `fetch(url, {method:"POST"})` works, but a malformed body is still
 * refused rather than silently ignored.
 */
export async function readOptionalJson(c: Context<AppEnv>): Promise<Parsed<JsonObject>> {
  let text: string;
  try {
    text = await c.req.text();
  } catch {
    return invalid("invalid json");
  }
  if (text.trim() === "") return valid({});
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return invalid("invalid json");
  }
  return asObject(raw);
}

// ---------------------------------------------------------------------------
// Field validation
// ---------------------------------------------------------------------------

const MAX_TEXT = 500;

export function requiredString(body: JsonObject, field: string, max = MAX_TEXT): Parsed<string> {
  const value = body[field];
  if (typeof value !== "string") return invalid(`${field} is required and must be a string`);
  const trimmed = value.trim();
  if (trimmed === "") return invalid(`${field} must not be empty`);
  if (trimmed.length > max) return invalid(`${field} must be at most ${max} characters`);
  return valid(trimmed);
}

export function optionalBoolean(body: JsonObject, field: string): Parsed<boolean | undefined> {
  const value = body[field];
  if (value === undefined) return valid(undefined);
  if (typeof value !== "boolean") return invalid(`${field} must be true or false`);
  return valid(value);
}

/** An empty string collapses to null so the dashboard can clear a label. */
export function optionalText(
  body: JsonObject,
  field: string,
  max = MAX_TEXT,
): Parsed<string | null | undefined> {
  const value = body[field];
  if (value === undefined) return valid(undefined);
  if (value === null) return valid(null);
  if (typeof value !== "string") return invalid(`${field} must be a string or null`);
  const trimmed = value.trim();
  if (trimmed.length > max) return invalid(`${field} must be at most ${max} characters`);
  return valid(trimmed === "" ? null : trimmed);
}

export function optionalInteger(
  body: JsonObject,
  field: string,
  min: number,
  max: number,
): Parsed<number | undefined> {
  const value = body[field];
  if (value === undefined) return valid(undefined);
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    return invalid(`${field} must be a whole number`);
  }
  if (value < min || value > max) return invalid(`${field} must be between ${min} and ${max}`);
  return valid(value);
}

function isMember<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

export function optionalMember<T extends string>(
  body: JsonObject,
  field: string,
  allowed: readonly T[],
): Parsed<T | undefined> {
  const value = body[field];
  if (value === undefined) return valid(undefined);
  if (!isMember(value, allowed)) return invalid(`${field} must be one of: ${allowed.join(", ")}`);
  return valid(value);
}

export function requiredMember<T extends string>(
  body: JsonObject,
  field: string,
  allowed: readonly T[],
): Parsed<T> {
  const value = body[field];
  if (!isMember(value, allowed)) return invalid(`${field} must be one of: ${allowed.join(", ")}`);
  return valid(value);
}

// ---------------------------------------------------------------------------
// Identifier shapes
// ---------------------------------------------------------------------------

// A numeric id, a PAGEID_POSTID pair, or a facebook.com URL. Whitespace and
// control characters are the giveaway that something else was pasted.
const POST_INPUT_RE = /^[A-Za-z0-9_.:/?=&%#@~+-]{1,300}$/;

// Graph comment ids are digits, sometimes joined by an underscore. These never
// come from a human, so the shape can stay tight.
const COMMENT_ID_RE = /^[A-Za-z0-9_]{1,120}$/;

export function postIdField(body: JsonObject, field = "postId"): Parsed<string> {
  const parsed = requiredString(body, field, 300);
  if (!parsed.ok) return parsed;
  if (!POST_INPUT_RE.test(parsed.value)) {
    return invalid(`${field} does not look like a post id or a Facebook post URL`);
  }
  return parsed;
}

export function postIdParam(raw: string | undefined): Parsed<string> {
  if (raw === undefined || raw.trim() === "") return invalid("a post id is required");
  const trimmed = raw.trim();
  if (!POST_INPUT_RE.test(trimmed)) return invalid("that post id is not a valid id");
  return valid(trimmed);
}

export function commentIdParam(raw: string | undefined): Parsed<string> {
  if (raw === undefined || raw.trim() === "") return invalid("a comment id is required");
  const trimmed = raw.trim();
  if (!COMMENT_ID_RE.test(trimmed)) return invalid("that comment id is not a valid id");
  return valid(trimmed);
}

export function ruleIdParam(raw: string | undefined): Parsed<number> {
  if (raw === undefined || !/^\d{1,15}$/.test(raw)) return invalid("that rule id is not a valid id");
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) return invalid("that rule id is not a valid id");
  return valid(id);
}

// ---------------------------------------------------------------------------
// Graph access
// ---------------------------------------------------------------------------

export type TokenResult =
  | { ok: true; token: string }
  | { ok: false; error: string; status: ApiErrorStatus };

/**
 * Decrypts the stored Page Access Token. The plaintext never leaves the request
 * that asked for it, and a decryption failure is reported as a configuration
 * problem rather than as an exception.
 */
export async function loadPageToken(env: Env): Promise<TokenResult> {
  const ciphertext = await getSetting(env.DB, SETTING_TOKEN);
  if (ciphertext === null || ciphertext === "") {
    return {
      ok: false,
      status: 400,
      error: "No Page Access Token is configured. Connect a Page first.",
    };
  }
  try {
    return { ok: true, token: await decryptToken(ciphertext, env.ENCRYPTION_KEY) };
  } catch {
    return {
      ok: false,
      status: 500,
      error:
        "The stored Page Access Token could not be decrypted. " +
        "Check ENCRYPTION_KEY, then enter the token again.",
    };
  }
}

export function newGraphClient(env: Env, token: string): GraphClient {
  return new GraphClient(token, {
    version: env.GRAPH_API_VERSION,
    apiBase: env.GRAPH_API_BASE,
  });
}

/**
 * Maps a Graph failure onto our own status. A 401/403 from Facebook is about the
 * operator's token, never about the dashboard session, so it must not become a
 * 401 that would log the operator out.
 */
export function graphErrorStatus(err: GraphErr): ApiErrorStatus {
  if (err.status === 429) return 429;
  if (err.status === 0 || err.status >= 500) return 502;
  return 400;
}

export function logInternal(scope: string, err: unknown): void {
  console.error(`commenthide: ${scope}:`, err instanceof Error ? err.message : String(err));
}
