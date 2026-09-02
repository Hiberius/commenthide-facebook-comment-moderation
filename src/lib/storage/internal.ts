// Shared helpers for the storage layer.
//
// D1 hands back untyped rows. Every mapper funnels column values through these
// coercions so that a NULL or an unexpected type degrades to a sane default
// instead of leaking `undefined` into code that the type system believes is
// total. Nothing here talks to D1 directly.

import type {
  CommentStatus,
  EventLevel,
  PostMode,
  RuleAction,
  RuleKind,
} from "../../types";

/** A row exactly as D1 returns it: string keys, unknown values. */
export type RawRow = Record<string, unknown>;

// Runtime mirrors of the string unions in types.ts. `satisfies` keeps them from
// drifting away from the type without redeclaring it.
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

export const COMMENT_STATUSES = [
  "seen",
  "hidden",
  "flagged",
  "skipped",
  "error",
  "restored",
] as const satisfies readonly CommentStatus[];

export const EVENT_LEVELS = ["info", "warn", "error"] as const satisfies readonly EventLevel[];

/** Wall clock in ms. Isolated here so tests can stub a single seam if needed. */
export function nowMs(): number {
  return Date.now();
}

export function asInt(value: unknown, fallback = 0): number {
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : fallback;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
  }
  return fallback;
}

export function asNullableInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return asInt(value);
}

export function asText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function asNullableText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return null;
}

/** SQLite stores booleans as 0/1; anything else is treated as false. */
export function asBit(value: unknown): 0 | 1 {
  if (value === 1 || value === true || value === "1" || value === 1n) return 1;
  return 0;
}

/** Optional booleans bind as NULL so SQL can tell "unset" from "false". */
export function optionalBit(value: boolean | undefined): 0 | 1 | null {
  if (value === undefined) return null;
  return value ? 1 : 0;
}

export function optionalValue<T>(value: T | null | undefined): T | null {
  return value === undefined ? null : value;
}

export function oneOfOrNull<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  if (typeof value !== "string") return null;
  const match = allowed.find((candidate) => candidate === value);
  return match ?? null;
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return oneOfOrNull(value, allowed) ?? fallback;
}

/** `?, ?, ?` for an IN clause. Built from a count, never from user input. */
export function placeholders(count: number): string {
  return new Array(Math.max(count, 0)).fill("?").join(", ");
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const stride = Math.max(1, Math.trunc(size));
  return Array.from({ length: Math.ceil(items.length / stride) }, (_unused, index) =>
    items.slice(index * stride, index * stride + stride),
  );
}

export function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  const rounded = Math.trunc(limit);
  if (rounded < 1) return 1;
  return rounded > max ? max : rounded;
}

/** Keeps stored previews and log details bounded; D1 rows are not a log sink. */
export function truncate(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  return value.length <= max ? value : `${value.slice(0, Math.max(max - 1, 0))}…`;
}

/** One `column = ?` assignment plus the value bound to it. */
export interface PatchAssignment {
  readonly column: string;
  readonly value: unknown;
}

/**
 * Turns an allow-listed column set into assignments. Callers iterate their own
 * literal column tuple, so a column name can never originate from user input.
 */
export function collectAssignments<C extends string>(
  columns: readonly C[],
  read: (column: C) => unknown,
): PatchAssignment[] {
  return columns
    .map((column) => ({ column, value: read(column) }))
    .filter((assignment) => assignment.value !== undefined);
}
