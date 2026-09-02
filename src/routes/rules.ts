// CommentHide — the moderation rule set.
//
// `pattern` means something different for every rule kind, so the boundary
// check is per kind: an unusable regex or a non-numeric threshold is rejected
// here rather than being silently ignored by the engine at poll time.

import { Hono } from "hono";
import type { AppEnv, RuleAction, RuleKind } from "../types";
import { regexSafetyProblem } from "../lib/rules";
import {
  createRule,
  deleteRule,
  getRule,
  listAllRules,
  logEvent,
  seedDefaultRules,
  updateRule,
} from "../lib/storage";
import {
  optionalBoolean,
  optionalInteger,
  optionalMember,
  optionalText,
  postIdField,
  readJson,
  requiredMember,
  ruleIdParam,
  RULE_ACTIONS,
  RULE_KINDS,
  type JsonObject,
  type Parsed,
} from "./shared";

const MAX_PATTERN = 1000;
const MAX_LABEL = 120;
const PRIORITY_MIN = -10000;
const PRIORITY_MAX = 10000;

/** Guards against a pathological pattern being compiled by the engine later. */
const MAX_THRESHOLD = 10000;

const rules = new Hono<AppEnv>();

function optionalPattern(body: JsonObject): Parsed<string | undefined> {
  const value = body.pattern;
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string") return { ok: false, error: "pattern must be a string" };
  if (value.length > MAX_PATTERN) {
    return { ok: false, error: `pattern must be at most ${MAX_PATTERN} characters` };
  }
  return { ok: true, value: value.trim() };
}

/** Returns an error message, or null when the pattern suits the kind. */
function patternProblem(kind: RuleKind, pattern: string): string | null {
  switch (kind) {
    case "regex":
      // Delegated to the engine so the boundary enforces exactly what the
      // engine will run — including the backtracking budget. Accepting a
      // pattern the engine then silently refuses is its own kind of bug.
      return regexSafetyProblem(pattern);
    case "keyword":
      return pattern === "" ? "a keyword rule needs at least one term" : null;
    case "author_allow":
      return pattern === "" ? "an author_allow rule needs at least one name or id" : null;
    case "emoji_spam":
    case "min_length": {
      if (pattern === "") return null; // The engine applies its own default.
      if (!/^\d{1,5}$/.test(pattern)) return `a ${kind} rule needs a whole number threshold`;
      const threshold = Number(pattern);
      if (threshold < 1 || threshold > MAX_THRESHOLD) {
        return `a ${kind} threshold must be between 1 and ${MAX_THRESHOLD}`;
      }
      return null;
    }
    case "link":
    case "contact":
      return null; // These kinds carry no pattern at all.
  }
}

/**
 * A rule may be global (null) or scoped to one post. `postId` is accepted as an
 * alias so the dashboard can use either spelling of the same field.
 */
function scopeField(body: JsonObject): Parsed<string | null | undefined> {
  const raw = body.post_id !== undefined ? body.post_id : body.postId;
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null || raw === "") return { ok: true, value: null };
  const parsed = postIdField({ post_id: raw }, "post_id");
  return parsed.ok ? { ok: true, value: parsed.value } : parsed;
}

rules.get("/rules", async (c) => c.json({ rules: await listAllRules(c.env.DB) }));

rules.post("/rules", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);

  const kind = requiredMember<RuleKind>(body.value, "kind", RULE_KINDS);
  if (!kind.ok) return c.json({ error: kind.error }, 400);
  const action = optionalMember<RuleAction>(body.value, "action", RULE_ACTIONS);
  if (!action.ok) return c.json({ error: action.error }, 400);
  const pattern = optionalPattern(body.value);
  if (!pattern.ok) return c.json({ error: pattern.error }, 400);
  const label = optionalText(body.value, "label", MAX_LABEL);
  if (!label.ok) return c.json({ error: label.error }, 400);
  const enabled = optionalBoolean(body.value, "enabled");
  if (!enabled.ok) return c.json({ error: enabled.error }, 400);
  const priority = optionalInteger(body.value, "priority", PRIORITY_MIN, PRIORITY_MAX);
  if (!priority.ok) return c.json({ error: priority.error }, 400);
  const scope = scopeField(body.value);
  if (!scope.ok) return c.json({ error: scope.error }, 400);

  const problem = patternProblem(kind.value, pattern.value ?? "");
  if (problem !== null) return c.json({ error: problem }, 400);

  const rule = await createRule(c.env.DB, {
    post_id: scope.value ?? null,
    kind: kind.value,
    pattern: pattern.value,
    action: action.value,
    label: label.value,
    enabled: enabled.value,
    priority: priority.value,
  });

  await logEvent(c.env.DB, {
    level: "info",
    action: "rule_created",
    post_id: rule.post_id,
    detail: `id=${rule.id} kind=${rule.kind} action=${rule.action}`,
  });

  return c.json({ ok: true, rule });
});

rules.patch("/rules/:id", async (c) => {
  const id = ruleIdParam(c.req.param("id"));
  if (!id.ok) return c.json({ error: id.error }, 400);

  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);

  const kind = optionalMember<RuleKind>(body.value, "kind", RULE_KINDS);
  if (!kind.ok) return c.json({ error: kind.error }, 400);
  const action = optionalMember<RuleAction>(body.value, "action", RULE_ACTIONS);
  if (!action.ok) return c.json({ error: action.error }, 400);
  const pattern = optionalPattern(body.value);
  if (!pattern.ok) return c.json({ error: pattern.error }, 400);
  const label = optionalText(body.value, "label", MAX_LABEL);
  if (!label.ok) return c.json({ error: label.error }, 400);
  const enabled = optionalBoolean(body.value, "enabled");
  if (!enabled.ok) return c.json({ error: enabled.error }, 400);
  const priority = optionalInteger(body.value, "priority", PRIORITY_MIN, PRIORITY_MAX);
  if (!priority.ok) return c.json({ error: priority.error }, 400);
  const scope = scopeField(body.value);
  if (!scope.ok) return c.json({ error: scope.error }, 400);

  const existing = await getRule(c.env.DB, id.value);
  if (existing === null) return c.json({ error: "that rule does not exist" }, 404);

  // The pattern has to be judged against the kind the rule will end up with,
  // not the one it happens to have now.
  const effectiveKind = kind.value ?? existing.kind;
  const effectivePattern = pattern.value ?? existing.pattern;
  const problem = patternProblem(effectiveKind, effectivePattern);
  if (problem !== null) return c.json({ error: problem }, 400);

  await updateRule(c.env.DB, id.value, {
    post_id: scope.value,
    kind: kind.value,
    pattern: pattern.value,
    action: action.value,
    label: label.value,
    enabled: enabled.value,
    priority: priority.value,
  });

  await logEvent(c.env.DB, {
    level: "info",
    action: "rule_updated",
    post_id: existing.post_id,
    detail: `id=${id.value}`,
  });

  return c.json({ ok: true });
});

rules.delete("/rules/:id", async (c) => {
  const id = ruleIdParam(c.req.param("id"));
  if (!id.ok) return c.json({ error: id.error }, 400);

  const existing = await getRule(c.env.DB, id.value);
  if (existing === null) return c.json({ error: "that rule does not exist" }, 404);

  await deleteRule(c.env.DB, id.value);
  await logEvent(c.env.DB, {
    level: "info",
    action: "rule_deleted",
    post_id: existing.post_id,
    detail: `id=${id.value}`,
  });

  return c.json({ ok: true });
});

rules.post("/rules/seed", async (c) => {
  // Storage only seeds an empty table, so this is safe to press twice.
  const created = await seedDefaultRules(c.env.DB);
  if (created > 0) {
    await logEvent(c.env.DB, {
      level: "info",
      action: "rules_seeded",
      detail: `created=${created}`,
    });
  }
  return c.json({ ok: true, created });
});

export default rules;
