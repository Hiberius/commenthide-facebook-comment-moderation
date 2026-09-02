// events: append-only audit log, pruned by the retention job.

import type { EventLevel, EventRow } from "../../types";
import {
  asInt,
  asNullableText,
  asText,
  clampLimit,
  EVENT_LEVELS,
  nowMs,
  oneOf,
  truncate,
  type RawRow,
} from "./internal";

export interface EventInput {
  level: EventLevel;
  action: string;
  post_id?: string | null;
  comment_id?: string | null;
  detail?: string | null;
  error_message?: string | null;
}

const EVENT_COLUMNS = "id, ts, level, action, post_id, comment_id, detail, error_message";

const DEFAULT_EVENT_LIMIT = 50;
const MAX_EVENT_LIMIT = 500;
const DETAIL_MAX = 2000;
const ERROR_MAX = 500;

function toEventRow(raw: RawRow): EventRow {
  return {
    id: asInt(raw.id),
    ts: asInt(raw.ts),
    level: oneOf(raw.level, EVENT_LEVELS, "info"),
    action: asText(raw.action),
    post_id: asNullableText(raw.post_id),
    comment_id: asNullableText(raw.comment_id),
    detail: asNullableText(raw.detail),
    error_message: asNullableText(raw.error_message),
  };
}

export async function logEvent(db: D1Database, input: EventInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO events (ts, level, action, post_id, comment_id, detail, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      nowMs(),
      input.level,
      input.action,
      input.post_id ?? null,
      input.comment_id ?? null,
      truncate(input.detail, DETAIL_MAX),
      truncate(input.error_message, ERROR_MAX),
    )
    .run();
}

export async function recentEvents(db: D1Database, limit?: number): Promise<EventRow[]> {
  const result = await db
    .prepare(`SELECT ${EVENT_COLUMNS} FROM events ORDER BY ts DESC, id DESC LIMIT ?`)
    .bind(clampLimit(limit, DEFAULT_EVENT_LIMIT, MAX_EVENT_LIMIT))
    .all<RawRow>();
  return result.results.map(toEventRow);
}
