// Per-kind matcher tests for src/lib/rules.ts.
//
// One describe per rule kind, each stating both what it catches and what it
// deliberately lets through. The negative rows matter more than the positive
// ones: a false positive here silently hides a real customer, and nobody finds
// out until they complain.
//
// The evaluate()/describeRule()/DEFAULT_RULES semantics live in rules.test.ts.

import { describe, expect, it } from "vitest";
import { compileRule, normalizeText } from "../src/lib/rules";
import type { EvaluableComment, RuleKind } from "../src/types";
import {
  KEEP,
  comment,
  decide,
  fires,
  makeRule,
  matchTable,
} from "./support/rules-fixtures";

// --- normalisation ---------------------------------------------------------

describe("normalizeText", () => {
  it("lowercases and strips combining accents", () => {
    expect(normalizeText("PERCHÈ Però")).toBe("perche pero");
  });

  it("collapses runs of whitespace and trims", () => {
    expect(normalizeText("  a \n\t b  ")).toBe("a b");
  });

  it("removes zero-width characters used to smuggle words past a filter", () => {
    expect(normalizeText("s​c⁠am")).toBe("scam");
  });

  it("leaves Cyrillic and Greek letters intact", () => {
    expect(normalizeText("СПАМ Καλά")).toBe("спам καλα");
  });
});

// --- compileRule -----------------------------------------------------------

describe("compileRule", () => {
  it("returns a matcher bound to the original rule object", () => {
    const rule = makeRule({ id: 7, kind: "keyword", pattern: "scam" });
    const compiled = compileRule(rule);
    expect(compiled?.rule).toBe(rule);
    expect(compiled?.test(comment("what a scam"))).toBe(true);
    expect(compiled?.test(comment("scampi tonight"))).toBe(false);
  });

  it("returns null for a disabled rule", () => {
    expect(compileRule(makeRule({ kind: "keyword", pattern: "scam", enabled: 0 }))).toBeNull();
  });

  it("returns null for a keyword rule whose pattern holds no terms", () => {
    expect(compileRule(makeRule({ kind: "keyword", pattern: " , ,  " }))).toBeNull();
  });

  it("returns null for an invalid regex source", () => {
    expect(compileRule(makeRule({ kind: "regex", pattern: "([a-z" }))).toBeNull();
  });

  it("returns null for a rule kind this build does not know", () => {
    expect(compileRule(makeRule({ kind: "telepathy" as RuleKind }))).toBeNull();
  });

  it("compiles pattern-free kinds, which ignore the pattern column", () => {
    expect(compileRule(makeRule({ kind: "link" }))?.test(comment("www.example.org"))).toBe(true);
    expect(compileRule(makeRule({ kind: "min_length", pattern: "5" }))?.test(comment("hi"))).toBe(true);
  });

  it("still matches correctly once the internal matcher cache has been evicted", () => {
    // The cache is bounded and clears wholesale rather than evicting an LRU, so
    // the risk is a stale or missing matcher after the flush, not a slow one.
    const first = makeRule({ id: 800, kind: "keyword", pattern: "cachecanary" });
    expect(fires(first, comment("a cachecanary here"))).toBe(true);

    for (let i = 0; i < 300; i += 1) {
      const filler = makeRule({ id: 900 + i, kind: "keyword", pattern: `fillerterm${i}` });
      expect(fires(filler, comment(`x fillerterm${i} y`))).toBe(true);
    }

    expect(fires(first, comment("a cachecanary here"))).toBe(true);
    expect(fires(first, comment("cachecanaries plural"))).toBe(false);
  });
});

// --- keyword ---------------------------------------------------------------

describe("keyword rule", () => {
  describe("whole-word matching", () => {
    matchTable(makeRule({ id: 100, kind: "keyword", pattern: "scam" }), [
      ["this is a scam", true],
      ["SCAM!!!", true],
      ["(scam)", true],
      ["i love scampi", false],
      ["descam", false],
      ["nothing to see", false],
    ]);
  });

  describe("case and accent insensitivity", () => {
    matchTable(makeRule({ id: 101, kind: "keyword", pattern: "perche, TRUFFÀ" }), [
      ["PERCHÈ no", true],
      ["che truffa", true],
      ["che TRUFFÀ", true],
      ["tutto bene", false],
    ]);
  });

  describe("multi-word phrases", () => {
    matchTable(makeRule({ id: 102, kind: "keyword", pattern: "make money fast" }), [
      ["you can Make   Money\nFast here", true],
      ["make money slowly", false],
      ["fast money makes", false],
    ]);
  });

  describe("regex metacharacters are escaped, not interpreted", () => {
    matchTable(makeRule({ id: 103, kind: "keyword", pattern: "a.c" }), [
      ["say a.c ok", true],
      ["abc", false],
      ["axc", false],
    ]);

    matchTable(makeRule({ id: 104, kind: "keyword", pattern: "c++" }), [
      ["i love c++ here", true],
      ["i love c here", false],
    ]);
  });

  it("matches any one term of a comma-separated list and quotes the hit", () => {
    const rule = makeRule({ id: 105, kind: "keyword", pattern: "spam, truffa, scam" });
    expect(decide(rule, "what a truffa")).toEqual({
      verdict: "hide",
      ruleId: 105,
      reason: 'Keyword: "spam, truffa, scam" — matched "truffa"',
    });
  });

  it("matches non-Latin scripts, where an ASCII word boundary would not fire", () => {
    const rule = makeRule({ id: 106, kind: "keyword", pattern: "спам" });
    expect(fires(rule, comment("это спам тут"))).toBe(true);
    expect(fires(rule, comment("это спамер тут"))).toBe(false);
  });

  it("sees through zero-width characters spliced into a banned word", () => {
    const rule = makeRule({ id: 107, kind: "keyword", pattern: "scam" });
    expect(fires(rule, comment("s​c⁠am"))).toBe(true);
  });

  it("is skipped entirely when the pattern holds no terms", () => {
    expect(decide(makeRule({ id: 108, kind: "keyword", pattern: "  ,  " }), "anything")).toEqual(KEEP);
  });
});

// --- regex -----------------------------------------------------------------

describe("regex rule", () => {
  matchTable(makeRule({ id: 200, kind: "regex", pattern: "\\d{5}" }), [
    ["order 12345 now", true],
    ["order 1234 now", false],
  ]);

  it("is case-insensitive but runs against the raw, un-normalised message", () => {
    expect(fires(makeRule({ id: 201, kind: "regex", pattern: "perchè" }), comment("PERCHÈ no"))).toBe(true);
    // Accents survive here: a regex author controls their own pattern.
    expect(fires(makeRule({ id: 202, kind: "regex", pattern: "perche" }), comment("perchè"))).toBe(false);
  });

  it("skips an invalid source instead of throwing", () => {
    const rule = makeRule({ id: 203, kind: "regex", pattern: "([a-z" });
    expect(() => decide(rule, "([a-z")).not.toThrow();
    expect(decide(rule, "([a-z")).toEqual(KEEP);
  });

  it("accepts a source at the 200-character limit and rejects one past it", () => {
    expect(compileRule(makeRule({ kind: "regex", pattern: "a".repeat(200) }))).not.toBeNull();
    expect(compileRule(makeRule({ kind: "regex", pattern: "a".repeat(201) }))).toBeNull();
    expect(decide(makeRule({ id: 204, kind: "regex", pattern: "a".repeat(201) }), "a".repeat(201))).toEqual(KEEP);
  });

  it("skips an empty source", () => {
    expect(decide(makeRule({ id: 205, kind: "regex", pattern: "   " }), "anything")).toEqual(KEEP);
  });

  describe("quoted evidence is capped at 60 characters", () => {
    const rule = makeRule({ id: 206, kind: "regex", pattern: "x+" });
    const reasonFor = (n: number): string => decide(rule, "x".repeat(n)).reason;

    it("quotes a 60-character fragment verbatim", () => {
      expect(reasonFor(60)).toBe(`Regex: /x+/iu — matched "${"x".repeat(60)}"`);
    });

    it("truncates a 61-character fragment to 59 characters plus an ellipsis", () => {
      expect(reasonFor(61)).toBe(`Regex: /x+/iu — matched "${"x".repeat(59)}…"`);
    });

    it("truncates a much longer fragment to the same length", () => {
      expect(reasonFor(200)).toBe(`Regex: /x+/iu — matched "${"x".repeat(59)}…"`);
    });
  });
});

// --- link ------------------------------------------------------------------

describe("link rule", () => {
  matchTable(makeRule({ id: 300, kind: "link" }), [
    ["check https://example.com/deal now", true],
    ["HTTPS://EXAMPLE.COM", true],
    ["see http://x.example.org", true],
    ["visit www.example.org today", true],
    ["example.com is great", true],
    ["unknown.tld/promo here", true],
    ["visit example dot com now", true],
    ["order at example (dot) com", true],
    ["example [dot] com", true],
    // A missing space is not spam, and an unrecognised suffix with no path is not a link.
    ["Bellissimo.Complimenti", false],
    ["un punto importante", false],
    ["version 1.2.3 shipped", false],
    ["3.5 stars from me", false],
    ["e.g. this one", false],
    ["just a normal comment", false],
  ]);

  it("ignores the pattern column", () => {
    expect(fires(makeRule({ id: 301, kind: "link", pattern: "nonsense" }), comment("www.example.org"))).toBe(true);
  });
});

// --- contact ---------------------------------------------------------------

describe("contact rule", () => {
  matchTable(makeRule({ id: 400, kind: "contact" }), [
    ["write me at john.doe@example.com", true],
    ["reach john (at) example (dot) com", true],
    ["call +39 333 123 4567", true],
    ["tel (+44) 20 7946 0958", true],
    ["my number is 3331234567", true],
    ["ping @johndoe please", true],
    ["@ab", true],
    // A digit run needs seven digits, and a handle needs two characters.
    ["it happened in 2024", false],
    ["score was 12-3", false],
    ["final score 1 - 2 - 3", false],
    ["pages 10 - 20", false],
    ["hi @a", false],
    ["just five stars", false],
  ]);
});

// --- emoji_spam ------------------------------------------------------------

describe("emoji_spam rule", () => {
  describe("threshold of 3", () => {
    matchTable(makeRule({ id: 500, kind: "emoji_spam", pattern: "3" }), [
      ["🔥⭐", false],
      ["🔥⭐🎉", true],
      ["🔥⭐🎉💥", true],
      ["no emoji at all", false],
    ]);
  });

  it("falls back to 5 when the pattern is not a positive integer", () => {
    const blank = makeRule({ id: 501, kind: "emoji_spam", pattern: "" });
    const junk = makeRule({ id: 502, kind: "emoji_spam", pattern: "not-a-number" });
    expect(fires(blank, comment("🔥⭐🎉💥"))).toBe(false);
    expect(fires(blank, comment("🔥⭐🎉💥🚀"))).toBe(true);
    expect(fires(junk, comment("🔥⭐🎉💥🚀"))).toBe(true);
  });

  it("counts a ZWJ family emoji as its four component pictographs", () => {
    expect(fires(makeRule({ id: 503, kind: "emoji_spam", pattern: "4" }), comment("👨‍👩‍👧‍👦"))).toBe(true);
    expect(fires(makeRule({ id: 504, kind: "emoji_spam", pattern: "5" }), comment("👨‍👩‍👧‍👦"))).toBe(false);
  });

  it("does not count regional-indicator flags, which are not Extended_Pictographic", () => {
    expect(fires(makeRule({ id: 505, kind: "emoji_spam", pattern: "1" }), comment("🇮🇹🇫🇷🇩🇪"))).toBe(false);
  });
});

// --- min_length ------------------------------------------------------------

describe("min_length rule", () => {
  describe("threshold of 5", () => {
    matchTable(makeRule({ id: 600, kind: "min_length", pattern: "5" }), [
      ["abcd", true],
      ["abcde", false],
      ["abcdef", false],
      ["", true],
      ["   ", true],
      // Padding does not buy length: it is the trimmed message that counts.
      ["  abcde  ", false],
      ["  ab  ", true],
      ["          ", true],
    ]);
  });

  it("defaults to 3 characters", () => {
    const rule = makeRule({ id: 601, kind: "min_length", pattern: "" });
    expect(fires(rule, comment("ok"))).toBe(true);
    expect(fires(rule, comment("yes"))).toBe(false);
  });

  it("treats a comment with no message as empty", () => {
    // Graph omits `message` on sticker- and photo-only comments, whatever the
    // declared type promises at this boundary.
    const stickerOnly = { id: "sticker-1" } as unknown as EvaluableComment;
    expect(fires(makeRule({ id: 602, kind: "min_length", pattern: "3" }), stickerOnly)).toBe(true);
  });
});

// --- author_allow ----------------------------------------------------------

describe("author_allow rule", () => {
  const rule = makeRule({
    id: 700,
    kind: "author_allow",
    pattern: "mario rossi, 1234567890",
    action: "allow",
  });

  it("matches by author name, case-insensitively", () => {
    expect(fires(rule, comment("hi", { authorName: "Mario Rossi" }))).toBe(true);
  });

  it("matches by author id", () => {
    expect(fires(rule, comment("hi", { authorId: "1234567890" }))).toBe(true);
  });

  it("matches an accented name against an unaccented term", () => {
    const accented = makeRule({ id: 701, kind: "author_allow", pattern: "jose munoz", action: "allow" });
    expect(fires(accented, comment("hi", { authorName: "José Muñoz" }))).toBe(true);
  });

  it("does not match a longer name that merely starts with the term", () => {
    expect(fires(rule, comment("hi", { authorName: "Mario Rossini" }))).toBe(false);
  });

  it("does not match a different author, or a comment with no author at all", () => {
    expect(fires(rule, comment("hi", { authorName: "Luigi Verdi" }))).toBe(false);
    expect(fires(rule, comment("hi"))).toBe(false);
  });

  it("is skipped when the pattern lists no names", () => {
    expect(compileRule(makeRule({ kind: "author_allow", pattern: "", action: "allow" }))).toBeNull();
  });
});
