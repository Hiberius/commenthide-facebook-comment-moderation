// Shared fixtures for the rule-engine suites.
//
// The engine is pure, so a fixture only ever has to build plain data. Keeping
// the builders here lets tests/rules.test.ts and tests/rules-matchers.test.ts
// state a case in one line each instead of restating a whole RuleRow.

import { expect, it } from "vitest";
import { evaluate } from "../../src/lib/rules";
import type { Decision, EvaluableComment, PostMode, RuleRow } from "../../src/types";

/** Fixed timestamps: the engine never reads a clock, so the value is arbitrary. */
export const TS = 1_700_000_000_000;

/** The decision every "nothing applies" case must produce in rules mode. */
export const KEEP: Decision = { verdict: "keep", ruleId: null, reason: "no rule matched" };

/** Builds a RuleRow from a partial so each case shows only what it varies. */
export function makeRule(patch: Partial<RuleRow> = {}): RuleRow {
  return {
    id: 1,
    post_id: null,
    kind: "keyword",
    pattern: "",
    action: "hide",
    label: null,
    enabled: 1,
    priority: 100,
    hit_count: 0,
    created_at: TS,
    updated_at: TS,
    ...patch,
  };
}

export function comment(
  message: string,
  patch: Partial<EvaluableComment> = {},
): EvaluableComment {
  return { id: "comment-1", message, ...patch };
}

/** True when this exact rule is the one that decided the comment. */
export function fires(rule: RuleRow, c: EvaluableComment): boolean {
  return evaluate(c, [rule], "rules").ruleId === rule.id;
}

export function decide(rule: RuleRow, message: string, mode: PostMode = "rules"): Decision {
  return evaluate(comment(message), [rule], mode);
}

/**
 * Registers one `it` per row, so a regression names the exact message that
 * broke rather than collapsing a table into a single opaque failure.
 */
export function matchTable(
  rule: RuleRow,
  rows: ReadonlyArray<readonly [message: string, expected: boolean]>,
): void {
  for (const [message, expected] of rows) {
    it(`${expected ? "matches" : "ignores"} ${JSON.stringify(message)}`, () => {
      expect(fires(rule, comment(message))).toBe(expected);
    });
  }
}
