// CommentHide — the moderation rule engine.
//
// Pure by construction: no I/O, no database, no network, no clock. The same
// comment, rule set and mode always produce the same decision. That is what
// makes moderation explainable to a Page owner ("hidden because …") and what
// makes this module testable without a single mock.

import { MAX_REGEX_SOURCE } from "./rules-safety";

// Re-exported so callers have one import path for "everything about rules".
export { regexSafetyProblem } from "./rules-safety";
export { DEFAULT_RULES } from "./rules-defaults";

/**
 * Characters of a comment a user-supplied regex is ever run against.
 *
 * Second line of defence. Deciding whether an arbitrary pattern backtracks is
 * undecidable in general, so the creation-time guard is best-effort; bounding
 * the input bounds what a pattern that slipped through can cost.
 */
const REGEX_INPUT_MAX = 400;

import type {
  Decision,
  EvaluableComment,
  PostMode,
  RuleAction,
  RuleKind,
  RuleRow,
} from "../types";

// --- tunables --------------------------------------------------------------

const DEFAULT_EMOJI_THRESHOLD = 5;
const DEFAULT_MIN_LENGTH = 3;
/** Reasons reach the audit log and the screen, so quoted evidence stays short. */
const MAX_FRAGMENT = 60;
const MAX_PATTERN_SHOWN = 72;
const MATCHER_CACHE_LIMIT = 256;

// --- text normalisation ----------------------------------------------------

/** The combining marks NFD produces for Latin, Greek and Cyrillic. Deliberately
 *  not \p{M}, which would also strip the vowel signs that carry meaning in
 *  Indic and Arabic scripts, silently rewriting legitimate comments. */
const COMBINING = /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20f0\ufe20-\ufe2f]/g;
/** Zero-width characters are the cheapest way to smuggle a banned word past a
 *  keyword filter, so they never survive normalisation. */
const ZERO_WIDTH = /[\u200b-\u200f\u2060\ufeff]/g;

/** Lowercase, accent-stripped, whitespace-collapsed. "PERCHÈ" -> "perche". */
export function normalizeText(input: string): string {
  return input
    .normalize("NFD")
    .replace(COMBINING, "")
    .replace(ZERO_WIDTH, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Graph omits `message` on sticker- and photo-only comments, so the declared
 *  type is not trustworthy at this boundary. */
function messageOf(comment: EvaluableComment): string {
  return typeof comment.message === "string" ? comment.message : "";
}

/** `-` is absent on purpose: outside a character class `\-` is an invalid
 *  escape under the `u` flag. */
const REGEX_META = /[.*+?^${}()|[\]\\/]/g;

function escapeRegex(value: string): string {
  return value.replace(REGEX_META, "\\$&");
}

function splitTerms(pattern: string): string[] {
  const seen = new Set<string>();
  for (const raw of pattern.split(",")) {
    const term = normalizeText(raw);
    if (term.length > 0) seen.add(term);
  }
  return [...seen];
}

/** Whole-word alternation over normalised text. Unicode lookarounds rather than
 *  `\b`, which is ASCII-only and would never fire on Greek or Cyrillic. */
function buildTermRegex(terms: readonly string[]): RegExp | null {
  if (terms.length === 0) return null;
  // A term containing a space matches as a phrase; `\s+` keeps it tolerant.
  const alts = terms.map((t) => escapeRegex(t).replace(/ /g, "\\s+"));
  const body = `(?<![\\p{L}\\p{N}_])(?:${alts.join("|")})(?![\\p{L}\\p{N}_])`;
  return new RegExp(body, "iu");
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function parseThreshold(pattern: string, fallback: number): number {
  const parsed = Number.parseInt(pattern.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// --- links and contact details ---------------------------------------------

/** "example(dot)com", "example [dot] com". */
const BRACKETED_DOT = /\s*[([{]\s*(?:dot|punto|punkt)\s*[)\]}]\s*/g;
/** "example dot com". Bare "punto" is excluded: it is an ordinary Italian noun
 *  and would turn "un punto importante" into a domain. */
const SPACED_DOT = /([a-z0-9])\s+dot\s+([a-z0-9])/g;
/** Only the bracketed form of "at" — the bare word is far too common. */
const BRACKETED_AT = /\s*[([{]\s*(?:at|chiocciola)\s*[)\]}]\s*/g;

function deobfuscate(text: string): string {
  return text
    .replace(BRACKETED_DOT, ".")
    .replace(SPACED_DOT, "$1.$2")
    .replace(BRACKETED_AT, "@");
}

const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"']{2,}/i;

/** Popular gTLDs plus the ccTLDs that actually turn up in Page comments. */
const TLDS = [
  "com net org io co me info biz xyz top shop online site store live app dev",
  "link click vip pro club fun life world today news blog cloud page space",
  "website tech digital agency icu cyou best win bid loan",
  "it uk de fr es nl be ch at pt pl ro ru ua cn in br us ca au nz jp kr tr gr",
  "se no dk fi cz sk hu ie il za mx ar cl eu tv cc ly gl id ai to sh st ml ga",
].join(" ").split(/\s+/).join("|");

/** Label repetition is capped, not open-ended: `(?:\.label)*` backtracks once
 *  per label on "a.a.a.a…", turning a long comment into a quadratic scan. */
const DOMAIN_BODY = "[a-z0-9][a-z0-9-]{0,61}(?:\\.[a-z0-9-]{1,63}){0,5}";
/** A bare domain only counts with a recognised TLD. Accepting any `word.word`
 *  would hide "Bellissimo.Complimenti" — a missing space is not spam. */
const KNOWN_DOMAIN_RE = new RegExp(`(?<![\\w@.-])${DOMAIN_BODY}\\.(?:${TLDS})(?![a-z0-9-])`, "i");
/** Any suffix is accepted once a path follows: "unknown.tld/promo" reads as a
 *  link in every context, recognised TLD or not. */
const PATHED_DOMAIN_RE = new RegExp(`(?<![\\w@.-])${DOMAIN_BODY}\\.[a-z]{2,24}\\/\\S*`, "i");

const EMAIL_RE = /[a-z0-9._%+-]{1,64}@[a-z0-9][a-z0-9-]{0,61}(?:\.[a-z0-9-]{1,63}){0,5}\.[a-z]{2,24}/i;
/** Not preceded by a word character, so an email's own "@" is not counted twice. */
const HANDLE_RE = /(?<![\w@])@[a-z0-9._]{2,30}/i;
/** Bounded repetition keeps this linear on long digit runs. */
const PHONE_RE = /\+?\d[\d\s().-]{5,28}\d/g;

function findPhone(text: string): string | null {
  // matchAll clones the regex, so the shared PHONE_RE.lastIndex stays at 0.
  for (const match of text.matchAll(PHONE_RE)) {
    const candidate = match[0] ?? "";
    if (candidate.replace(/\D/g, "").length >= 7) return candidate.trim();
  }
  return null;
}

/** A ZWJ sequence (a family, a flag) counts as several pictographs. Close
 *  enough: this rule catches floods, it is not a grapheme counter. */
function countEmoji(text: string): number {
  return (text.match(/\p{Extended_Pictographic}/gu) ?? []).length;
}

// --- matchers --------------------------------------------------------------

/** Returns the matched fragment ("" when there is nothing worth quoting), or
 *  null when the rule does not match. Never throws. */
type Matcher = (comment: EvaluableComment) => string | null;

function firstMatch(re: RegExp, text: string): string | null {
  const match = re.exec(text);
  return match ? (match[0] ?? "") : null;
}

function compileUserRegex(source: string): RegExp | null {
  const trimmed = source.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_REGEX_SOURCE) return null;
  try {
    return new RegExp(trimmed, "iu");
  } catch {
    // One malformed rule must never break a poll run: it is simply ignored.
    return null;
  }
}

const linkMatcher: Matcher = (comment) => {
  const text = deobfuscate(normalizeText(messageOf(comment)));
  return (
    firstMatch(URL_RE, text) ??
    firstMatch(KNOWN_DOMAIN_RE, text) ??
    firstMatch(PATHED_DOMAIN_RE, text)
  );
};

const contactMatcher: Matcher = (comment) => {
  const text = deobfuscate(normalizeText(messageOf(comment)));
  return firstMatch(EMAIL_RE, text) ?? firstMatch(HANDLE_RE, text) ?? findPhone(text);
};

function keywordMatcher(pattern: string): Matcher | null {
  const re = buildTermRegex(splitTerms(pattern));
  if (!re) return null;
  return (comment) => firstMatch(re, normalizeText(messageOf(comment)));
}

/** Matched against the raw message: whoever writes a regex expects to control
 *  case and accents themselves, unlike the keyword shorthand. */
function regexMatcher(pattern: string): Matcher | null {
  const re = compileUserRegex(pattern);
  if (!re) return null;
  // Truncated on purpose: a pattern that slipped past the creation-time guard
  // costs exponentially more on a longer comment, and no honest moderation rule
  // needs to look past the first few hundred characters.
  return (comment) => firstMatch(re, messageOf(comment).slice(0, REGEX_INPUT_MAX));
}

function emojiMatcher(threshold: number): Matcher {
  return (comment) => (countEmoji(messageOf(comment)) >= threshold ? "" : null);
}

function minLengthMatcher(threshold: number): Matcher {
  return (comment) => (messageOf(comment).trim().length < threshold ? "" : null);
}

function authorMatcher(pattern: string): Matcher | null {
  const terms = splitTerms(pattern);
  const re = buildTermRegex(terms);
  if (!re) return null;
  const ids = new Set(terms);
  return (comment) => {
    const id = normalizeText(comment.authorId ?? "");
    if (id.length > 0 && ids.has(id)) return id;
    const name = normalizeText(comment.authorName ?? "");
    return name.length > 0 ? firstMatch(re, name) : null;
  };
}

function buildMatcher(kind: RuleKind, pattern: string): Matcher | null {
  switch (kind) {
    case "keyword": return keywordMatcher(pattern);
    case "regex": return regexMatcher(pattern);
    case "link": return linkMatcher;
    case "contact": return contactMatcher;
    case "emoji_spam": return emojiMatcher(parseThreshold(pattern, DEFAULT_EMOJI_THRESHOLD));
    case "min_length": return minLengthMatcher(parseThreshold(pattern, DEFAULT_MIN_LENGTH));
    case "author_allow": return authorMatcher(pattern);
    default: return null; // a kind from a newer schema than this build knows
  }
}

/** A matcher depends on nothing but kind and pattern, so the cache key is its
 *  whole input domain and can never go stale. evaluate() runs once per comment
 *  and a poll run holds up to a hundred of them. */
const matcherCache = new Map<string, Matcher | null>();

function getMatcher(rule: RuleRow): Matcher | null {
  const key = `${rule.kind} ${rule.pattern}`;
  if (matcherCache.has(key)) return matcherCache.get(key) ?? null;
  const matcher = buildMatcher(rule.kind, rule.pattern);
  // Bounded, and cheap to rebuild — no LRU bookkeeping worth its complexity.
  if (matcherCache.size >= MATCHER_CACHE_LIMIT) matcherCache.clear();
  matcherCache.set(key, matcher);
  return matcher;
}

// --- public API ------------------------------------------------------------

export interface CompiledRule {
  rule: RuleRow;
  test: (c: EvaluableComment) => boolean;
}

/** Returns null when the rule is disabled or its pattern is invalid. */
export function compileRule(rule: RuleRow): CompiledRule | null {
  if (rule.enabled !== 1) return null;
  const matcher = getMatcher(rule);
  if (!matcher) return null;
  return { rule, test: (c) => matcher(c) !== null };
}

function runRule(rule: RuleRow, comment: EvaluableComment): string | null {
  if (rule.enabled !== 1) return null;
  const matcher = getMatcher(rule);
  return matcher ? matcher(comment) : null;
}

/** Copy — the caller's array is never sorted in place. */
function sortRules(rules: readonly RuleRow[]): RuleRow[] {
  return [...rules].sort((a, b) => a.priority - b.priority || a.id - b.id);
}

function verb(action: RuleAction): string {
  if (action === "flag") return "Flags";
  if (action === "allow") return "Allows";
  return "Blocks";
}

/**
 * A short human sentence naming the mechanism, e.g. `Keyword: "spam, scam"` or
 * "Blocks comments containing links". The rule's own label is deliberately left
 * out: the dashboard shows that already, and the audit log needs the mechanism.
 */
export function describeRule(rule: RuleRow): string {
  switch (rule.kind) {
    case "keyword": {
      const terms = splitTerms(rule.pattern);
      if (terms.length === 0) return "Keyword: no terms — rule ignored";
      return `Keyword: "${truncate(terms.join(", "), MAX_PATTERN_SHOWN)}"`;
    }
    case "regex": {
      const src = rule.pattern.trim();
      if (src.length === 0) return "Regex: no pattern — rule ignored";
      if (src.length > MAX_REGEX_SOURCE) {
        return `Regex: source longer than ${MAX_REGEX_SOURCE} characters — rule ignored`;
      }
      const shown = `/${truncate(src, MAX_PATTERN_SHOWN)}/iu`;
      return compileUserRegex(src)
        ? `Regex: ${shown}`
        : `Regex: ${shown} — invalid pattern, rule ignored`;
    }
    case "link":
      return `${verb(rule.action)} comments containing links`;
    case "contact":
      return `${verb(rule.action)} comments containing a phone number, email or @handle`;
    case "emoji_spam":
      return `${verb(rule.action)} comments with ${parseThreshold(rule.pattern, DEFAULT_EMOJI_THRESHOLD)} or more emoji`;
    case "min_length":
      return `${verb(rule.action)} comments shorter than ${parseThreshold(rule.pattern, DEFAULT_MIN_LENGTH)} characters`;
    case "author_allow": {
      const terms = splitTerms(rule.pattern);
      const head = rule.action === "allow" ? "Author allowlist" : `${verb(rule.action)} comments from`;
      if (terms.length === 0) return `${head}: no names — rule ignored`;
      return `${head}: "${truncate(terms.join(", "), MAX_PATTERN_SHOWN)}"`;
    }
    default:
      return "Unknown rule kind — rule ignored";
  }
}

/** Only keyword and regex quote evidence; the other kinds describe themselves. */
function reasonFor(rule: RuleRow, fragment: string): string {
  const base = describeRule(rule);
  const quotes = rule.kind === "keyword" || rule.kind === "regex";
  const evidence = truncate(fragment.replace(/\s+/g, " ").trim(), MAX_FRAGMENT);
  return quotes && evidence.length > 0 ? `${base} — matched "${evidence}"` : base;
}

/**
 * Evaluates in priority order, first match wins.
 * mode "hide_all" returns {verdict:"hide"} for anything no `allow` rule saves.
 * An `allow` match short-circuits to {verdict:"keep"}.
 * No match in "rules" mode returns {verdict:"keep", ruleId:null}.
 */
export function evaluate(comment: EvaluableComment, rules: RuleRow[], mode: PostMode): Decision {
  const ordered = sortRules(rules);

  // Allowlists run first and out of priority order on purpose: an allow rule
  // must never be outranked by a hide rule that happens to sort earlier.
  // Hiding a real person by mistake is the expensive failure here.
  for (const rule of ordered) {
    if (rule.action !== "allow") continue;
    const hit = runRule(rule, comment);
    if (hit === null) continue;
    return { verdict: "keep", ruleId: rule.id, reason: `Allowed — ${reasonFor(rule, hit)}` };
  }

  if (mode === "hide_all") {
    return { verdict: "hide", ruleId: null, reason: "hide_all mode" };
  }

  for (const rule of ordered) {
    if (rule.action === "allow") continue;
    const hit = runRule(rule, comment);
    if (hit === null) continue;
    const verdict = rule.action === "flag" ? "flag" : "hide";
    return { verdict, ruleId: rule.id, reason: reasonFor(rule, hit) };
  }

  return { verdict: "keep", ruleId: null, reason: "no rule matched" };
}

// --- starter rule set ------------------------------------------------------

export interface DefaultRuleSeed {
  kind: RuleKind;
  pattern: string;
  action: RuleAction;
  label: string;
  priority: number;
}
