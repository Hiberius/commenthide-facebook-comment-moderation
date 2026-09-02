// rules: the moderation rule set. A NULL post_id means "every watched post".

import type { RuleAction, RuleKind, RuleRow } from "../../types";
import { DEFAULT_RULES } from "../rules";
import {
  asBit,
  asInt,
  asNullableText,
  asText,
  collectAssignments,
  nowMs,
  oneOf,
  RULE_ACTIONS,
  RULE_KINDS,
  type RawRow,
} from "./internal";

export interface RuleInput {
  post_id?: string | null;
  kind: RuleKind;
  pattern?: string;
  action?: RuleAction;
  label?: string | null;
  enabled?: boolean;
  priority?: number;
}

const RULE_COLUMNS = `id, post_id, kind, pattern, action, label, enabled, priority,
  hit_count, created_at, updated_at`;

const INSERT_RULE_SQL = `INSERT INTO rules
  (post_id, kind, pattern, action, label, enabled, priority, hit_count, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`;

/** The only column names updateRule may ever write. Never derived from input. */
const RULE_PATCH_COLUMNS = [
  "post_id",
  "kind",
  "pattern",
  "action",
  "label",
  "enabled",
  "priority",
] as const;

type RulePatchColumn = (typeof RULE_PATCH_COLUMNS)[number];

const DEFAULT_PRIORITY = 100;

function toRuleRow(raw: RawRow): RuleRow {
  return {
    id: asInt(raw.id),
    post_id: asNullableText(raw.post_id),
    kind: oneOf(raw.kind, RULE_KINDS, "keyword"),
    pattern: asText(raw.pattern),
    action: oneOf(raw.action, RULE_ACTIONS, "hide"),
    label: asNullableText(raw.label),
    enabled: asBit(raw.enabled),
    priority: asInt(raw.priority, DEFAULT_PRIORITY),
    hit_count: asInt(raw.hit_count),
    created_at: asInt(raw.created_at),
    updated_at: asInt(raw.updated_at),
  };
}

/**
 * Global rules plus the rules scoped to postId, enabled only, in evaluation
 * order. Binding NULL yields the global set on its own, since `post_id = NULL`
 * is never true in SQL.
 */
export async function listRules(db: D1Database, postId?: string | null): Promise<RuleRow[]> {
  const result = await db
    .prepare(
      `SELECT ${RULE_COLUMNS} FROM rules
       WHERE enabled = 1 AND (post_id IS NULL OR post_id = ?)
       ORDER BY priority ASC, id ASC`,
    )
    .bind(postId ?? null)
    .all<RawRow>();
  return result.results.map(toRuleRow);
}

/** Everything, disabled rules included — this is what the dashboard edits. */
export async function listAllRules(db: D1Database): Promise<RuleRow[]> {
  const result = await db
    .prepare(`SELECT ${RULE_COLUMNS} FROM rules ORDER BY priority ASC, id ASC`)
    .all<RawRow>();
  return result.results.map(toRuleRow);
}

export async function getRule(db: D1Database, id: number): Promise<RuleRow | null> {
  const row = await db
    .prepare(`SELECT ${RULE_COLUMNS} FROM rules WHERE id = ?`)
    .bind(id)
    .first<RawRow>();
  return row === null ? null : toRuleRow(row);
}

export async function createRule(db: D1Database, input: RuleInput): Promise<RuleRow> {
  const ts = nowMs();
  const result = await db
    .prepare(INSERT_RULE_SQL)
    .bind(
      input.post_id ?? null,
      input.kind,
      input.pattern ?? "",
      input.action ?? "hide",
      input.label ?? null,
      input.enabled === false ? 0 : 1,
      input.priority ?? DEFAULT_PRIORITY,
      ts,
      ts,
    )
    .run();

  const created = await getRule(db, asInt(result.meta.last_row_id));
  if (created === null) {
    throw new Error("createRule: the inserted rule was not readable after the write");
  }
  return created;
}

function rulePatchValue(column: RulePatchColumn, patch: Partial<RuleInput>): unknown {
  switch (column) {
    case "enabled":
      return patch.enabled === undefined ? undefined : patch.enabled ? 1 : 0;
    case "priority":
      return patch.priority === undefined ? undefined : Math.trunc(patch.priority);
    default:
      return patch[column];
  }
}

export async function updateRule(
  db: D1Database,
  id: number,
  patch: Partial<RuleInput>,
): Promise<void> {
  const assignments = collectAssignments(RULE_PATCH_COLUMNS, (column) =>
    rulePatchValue(column, patch),
  );
  if (assignments.length === 0) return;

  const sql = `UPDATE rules SET ${assignments
    .map((assignment) => `${assignment.column} = ?`)
    .join(", ")}, updated_at = ? WHERE id = ?`;

  await db
    .prepare(sql)
    .bind(...assignments.map((assignment) => assignment.value), nowMs(), id)
    .run();
}

export async function deleteRule(db: D1Database, id: number): Promise<void> {
  await db.prepare("DELETE FROM rules WHERE id = ?").bind(id).run();
}

/** Hit counting deliberately leaves updated_at alone: a hit is not an edit. */
export async function bumpRuleHits(db: D1Database, ruleId: number, by = 1): Promise<void> {
  const delta = Math.trunc(by);
  if (delta === 0) return;
  await db
    .prepare("UPDATE rules SET hit_count = MAX(hit_count + ?, 0) WHERE id = ?")
    .bind(delta, ruleId)
    .run();
}

/**
 * Seeds the starter rule set, but only into an empty table — re-seeding an
 * account that has already tuned its rules would be destructive surprise.
 */
export async function seedDefaultRules(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS total FROM rules").first<{ total: unknown }>();
  const existing = row === null ? 0 : asInt(row.total);
  if (existing > 0) return 0;
  if (DEFAULT_RULES.length === 0) return 0;

  const ts = nowMs();
  const statements = DEFAULT_RULES.map((seed) =>
    db
      .prepare(INSERT_RULE_SQL)
      .bind(null, seed.kind, seed.pattern, seed.action, seed.label, 1, seed.priority, ts, ts),
  );

  await db.batch(statements);
  return statements.length;
}
