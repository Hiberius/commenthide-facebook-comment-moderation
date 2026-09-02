// Semantics tests for src/lib/rules.ts: evaluate(), describeRule() and the
// starter rule set.
//
// These are the decisions a Page owner actually feels — which rule won, why it
// won, and what the audit log will say about it. The per-kind matcher tests
// live in tests/rules-matchers.test.ts.

import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, compileRule, describeRule, evaluate } from "../src/lib/rules";
import type { RuleKind, RuleRow } from "../src/types";
import { KEEP, comment, decide, makeRule } from "./support/rules-fixtures";

// --- evaluate --------------------------------------------------------------

describe("evaluate", () => {
  const spamAt20 = makeRule({ id: 10, kind: "keyword", pattern: "spam", priority: 20 });
  const spamAt5 = makeRule({ id: 11, kind: "keyword", pattern: "spam", priority: 5 });
  const allowMario = makeRule({
    id: 12,
    kind: "author_allow",
    pattern: "mario rossi",
    action: "allow",
    priority: 99,
  });

  it("lets the lowest priority number decide between two matching hide rules", () => {
    expect(evaluate(comment("spam here"), [spamAt20, spamAt5], "rules").ruleId).toBe(11);
    expect(evaluate(comment("spam here"), [spamAt5, spamAt20], "rules").ruleId).toBe(11);
  });

  it("breaks a priority tie with the lower rule id", () => {
    const later = makeRule({ id: 30, kind: "keyword", pattern: "spam", priority: 7 });
    const earlier = makeRule({ id: 20, kind: "keyword", pattern: "spam", priority: 7 });
    expect(evaluate(comment("spam here"), [later, earlier], "rules").ruleId).toBe(20);
  });

  it("lets an allow rule beat a higher-priority hide rule", () => {
    const hideFirst = makeRule({ id: 13, kind: "keyword", pattern: "spam", priority: 1 });
    const c = comment("spam", { authorName: "Mario Rossi" });
    expect(evaluate(c, [hideFirst, allowMario], "rules")).toEqual({
      verdict: "keep",
      ruleId: 12,
      reason: 'Allowed — Author allowlist: "mario rossi"',
    });
  });

  it("honours an allow rule of any kind, not just author_allow", () => {
    const hideSpam = makeRule({ id: 14, kind: "keyword", pattern: "spam", priority: 1 });
    const allowLinks = makeRule({ id: 15, kind: "link", action: "allow", priority: 90 });
    expect(evaluate(comment("spam https://example.com"), [hideSpam, allowLinks], "rules")).toEqual({
      verdict: "keep",
      ruleId: 15,
      reason: "Allowed — Allows comments containing links",
    });
  });

  it("ignores a disabled hide rule", () => {
    const disabled = makeRule({ id: 16, kind: "keyword", pattern: "spam", enabled: 0 });
    expect(evaluate(comment("spam"), [disabled], "rules")).toEqual(KEEP);
  });

  it("ignores a disabled allow rule, so the hide rule wins again", () => {
    const hideFirst = makeRule({ id: 17, kind: "keyword", pattern: "spam", priority: 1 });
    const c = comment("spam", { authorName: "Mario Rossi" });
    const decision = evaluate(c, [hideFirst, { ...allowMario, enabled: 0 }], "rules");
    expect(decision.verdict).toBe("hide");
    expect(decision.ruleId).toBe(17);
  });

  it("returns flag rather than hide for a flag rule", () => {
    const flagged = makeRule({ id: 18, kind: "keyword", pattern: "spam", action: "flag" });
    expect(decide(flagged, "spam").verdict).toBe("flag");
  });

  it("keeps with a null ruleId when nothing matches in rules mode", () => {
    expect(evaluate(comment("lovely post"), [spamAt5], "rules")).toEqual(KEEP);
    expect(evaluate(comment("lovely post"), [], "rules")).toEqual(KEEP);
  });

  it("hides an innocuous comment in hide_all mode", () => {
    expect(evaluate(comment("lovely post"), [], "hide_all")).toEqual({
      verdict: "hide",
      ruleId: null,
      reason: "hide_all mode",
    });
  });

  it("still respects an allow rule in hide_all mode", () => {
    const c = comment("lovely post", { authorName: "Mario Rossi" });
    expect(evaluate(c, [allowMario], "hide_all")).toEqual({
      verdict: "keep",
      ruleId: 12,
      reason: 'Allowed — Author allowlist: "mario rossi"',
    });
  });

  it("credits no rule in hide_all mode even when a hide rule also matched", () => {
    expect(evaluate(comment("spam"), [spamAt5], "hide_all")).toEqual({
      verdict: "hide",
      ruleId: null,
      reason: "hide_all mode",
    });
  });

  it("does not reorder or otherwise mutate the caller's rule array", () => {
    const rules = [spamAt20, spamAt5];
    evaluate(comment("spam"), rules, "rules");
    expect(rules).toEqual([spamAt20, spamAt5]);
    expect(rules[0]).toBe(spamAt20);
  });

  it("does not mutate the comment it is given", () => {
    const frozen = Object.freeze(comment("spam"));
    expect(() => evaluate(frozen, [spamAt5], "rules")).not.toThrow();
    expect(frozen).toEqual({ id: "comment-1", message: "spam" });
  });

  it("ignores a rule kind this build does not know", () => {
    const alien = makeRule({ kind: "telepathy" as RuleKind, pattern: "anything" });
    expect(evaluate(comment("anything"), [alien], "rules")).toEqual(KEEP);
  });

  // Every verdict has to survive a screenshot in a support thread, so the
  // reason names the mechanism and, where it can, quotes the evidence.
  const reasonCases: ReadonlyArray<readonly [RuleRow, string, string]> = [
    [makeRule({ id: 1, kind: "keyword", pattern: "scam" }), "what a SCAM", 'Keyword: "scam" — matched "scam"'],
    [makeRule({ id: 1, kind: "regex", pattern: "\\d{5}" }), "order 12345", 'Regex: /\\d{5}/iu — matched "12345"'],
    [makeRule({ id: 1, kind: "link" }), "see www.example.org", "Blocks comments containing links"],
    [
      makeRule({ id: 1, kind: "contact", action: "flag" }),
      "call +39 333 123 4567",
      "Flags comments containing a phone number, email or @handle",
    ],
    [makeRule({ id: 1, kind: "emoji_spam", pattern: "2" }), "🔥⭐", "Blocks comments with 2 or more emoji"],
    [makeRule({ id: 1, kind: "min_length", pattern: "4" }), "hi", "Blocks comments shorter than 4 characters"],
  ];

  for (const [rule, message, expected] of reasonCases) {
    it(`explains a ${rule.kind} match in the decision reason`, () => {
      const decision = decide(rule, message);
      expect(decision.ruleId).toBe(1);
      expect(decision.reason).toBe(expected);
      expect(decision.reason.length).toBeGreaterThan(0);
    });
  }
});

// --- describeRule ----------------------------------------------------------

describe("describeRule", () => {
  const cases: ReadonlyArray<readonly [name: string, rule: RuleRow, expected: string]> = [
    [
      "keyword: normalises and de-duplicates terms",
      makeRule({ kind: "keyword", pattern: "spam, SPAM , spam" }),
      'Keyword: "spam"',
    ],
    ["keyword: no terms", makeRule({ kind: "keyword", pattern: " , " }), "Keyword: no terms — rule ignored"],
    ["regex: valid", makeRule({ kind: "regex", pattern: "\\d{5}" }), "Regex: /\\d{5}/iu"],
    ["regex: empty", makeRule({ kind: "regex", pattern: "  " }), "Regex: no pattern — rule ignored"],
    [
      "regex: invalid",
      makeRule({ kind: "regex", pattern: "([a-z" }),
      "Regex: /([a-z/iu — invalid pattern, rule ignored",
    ],
    [
      "regex: over the length limit",
      makeRule({ kind: "regex", pattern: "a".repeat(201) }),
      "Regex: source longer than 200 characters — rule ignored",
    ],
    ["link: hide", makeRule({ kind: "link", action: "hide" }), "Blocks comments containing links"],
    ["link: flag", makeRule({ kind: "link", action: "flag" }), "Flags comments containing links"],
    ["link: allow", makeRule({ kind: "link", action: "allow" }), "Allows comments containing links"],
    [
      "contact",
      makeRule({ kind: "contact" }),
      "Blocks comments containing a phone number, email or @handle",
    ],
    ["emoji_spam", makeRule({ kind: "emoji_spam", pattern: "6" }), "Blocks comments with 6 or more emoji"],
    [
      "emoji_spam: a non-positive threshold falls back to 5",
      makeRule({ kind: "emoji_spam", pattern: "-1" }),
      "Blocks comments with 5 or more emoji",
    ],
    ["min_length", makeRule({ kind: "min_length", pattern: "2" }), "Blocks comments shorter than 2 characters"],
    [
      "author_allow: allow",
      makeRule({ kind: "author_allow", pattern: "Mario Rossi", action: "allow" }),
      'Author allowlist: "mario rossi"',
    ],
    [
      "author_allow: used as a hide rule",
      makeRule({ kind: "author_allow", pattern: "Mario Rossi", action: "hide" }),
      'Blocks comments from: "mario rossi"',
    ],
    [
      "author_allow: empty",
      makeRule({ kind: "author_allow", pattern: "", action: "allow" }),
      "Author allowlist: no names — rule ignored",
    ],
    ["unknown kind", makeRule({ kind: "telepathy" as RuleKind }), "Unknown rule kind — rule ignored"],
  ];

  for (const [name, rule, expected] of cases) {
    it(name, () => {
      expect(describeRule(rule)).toBe(expected);
    });
  }

  it("shows a term list of exactly 72 characters in full", () => {
    const pattern = "a".repeat(72);
    expect(describeRule(makeRule({ kind: "keyword", pattern }))).toBe(`Keyword: "${pattern}"`);
  });

  it("truncates a term list of 73 characters to 71 plus an ellipsis", () => {
    const pattern = "a".repeat(73);
    expect(describeRule(makeRule({ kind: "keyword", pattern }))).toBe(`Keyword: "${"a".repeat(71)}…"`);
  });
});

// --- DEFAULT_RULES ---------------------------------------------------------

describe("DEFAULT_RULES", () => {
  const seeded: RuleRow[] = DEFAULT_RULES.map((seed, index) => makeRule({ id: index + 1, ...seed }));

  it("ships link, contact, keyword, emoji and length rules and nothing else", () => {
    expect(DEFAULT_RULES.map((r) => r.kind)).toEqual([
      "link",
      "contact",
      "keyword",
      "emoji_spam",
      "min_length",
    ]);
  });

  it("contains no author_allow placeholder, which would be dead configuration", () => {
    expect(DEFAULT_RULES.some((r) => r.kind === "author_allow")).toBe(false);
  });

  it("hides rather than flags, in strictly ascending priority order", () => {
    expect(DEFAULT_RULES.every((r) => r.action === "hide")).toBe(true);
    expect(DEFAULT_RULES.map((r) => r.priority)).toEqual([10, 20, 30, 40, 50]);
  });

  it("gives every seed a non-empty label", () => {
    expect(DEFAULT_RULES.every((r) => r.label.trim().length > 0)).toBe(true);
  });

  it("compiles every seed", () => {
    expect(seeded.map((r) => compileRule(r) !== null)).toEqual([true, true, true, true, true]);
  });

  it("hides commercial bait in English and Italian", () => {
    expect(evaluate(comment("Whatsapp me for guaranteed profit"), seeded, "rules").verdict).toBe("hide");
    expect(evaluate(comment("Investimento garantito, scrivimi su whatsapp"), seeded, "rules").verdict).toBe("hide");
  });

  it("keeps honest criticism, which this project refuses to automate away", () => {
    const angry = "Questo prodotto non mi è piaciuto per niente, servizio pessimo e spedizione lentissima.";
    expect(evaluate(comment(angry), seeded, "rules")).toEqual(KEEP);
    expect(evaluate(comment("Worst customer service I have ever dealt with."), seeded, "rules")).toEqual(KEEP);
  });

  it("keeps a two-character comment but hides a one-character one", () => {
    expect(evaluate(comment("ok"), seeded, "rules")).toEqual(KEEP);
    expect(evaluate(comment("."), seeded, "rules").verdict).toBe("hide");
  });
});
