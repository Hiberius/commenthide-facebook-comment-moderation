// CommentHide — is this regex safe to run against attacker-supplied text?
//
// Split out of rules.ts so both files stay inside the 400-line budget. Pure and
// dependency-free, so the HTTP boundary and the engine enforce the same answer:
// accepting a pattern the engine will then silently refuse is its own kind of bug.

/** Longest regex source a rule may carry. */
export const MAX_REGEX_SOURCE = 200;

/**
 * Wall-clock one probe may take before the pattern is refused.
 *
 * The probes are deliberately short. A JS regex cannot be interrupted once it
 * starts, so the measurement only lands after the match has finished — probing
 * with a long string would mean waiting out the very blow-up being detected. At
 * this length a catastrophic pattern costs tens of milliseconds and a
 * well-behaved one costs microseconds, which separates them cleanly while
 * bounding the worst case well under a second.
 */
const REDOS_BUDGET_MS = 12;
const PROBE_LENGTH = 24;

/**
 * Strings that blow up a catastrophically backtracking pattern while staying
 * trivial for a well-behaved one. The trailing character forces the failed
 * match that triggers the backtracking in the first place.
 */
const REDOS_PROBES: readonly string[] = [
  `${"a".repeat(PROBE_LENGTH)}!`,
  `${"a ".repeat(PROBE_LENGTH / 2)}!`,
  `${"ab".repeat(PROBE_LENGTH / 2)}!`,
  `${"0".repeat(PROBE_LENGTH)}!`,
];

const REDOS_MESSAGE =
  "pattern backtracks too heavily to run safely — a single comment could stall " +
  "moderation. Avoid a quantifier applied to a group that already contains one, " +
  "such as (a+)+ or (\\w+\\s?)+.";

/**
 * A quantifier applied to a group that already contains one — (a+)+, (a*)* and
 * the open-ended {n,} spellings. This is the shape behind essentially every
 * catastrophic pattern, and matching it statically means never running the
 * blow-up at all. Alternation is deliberately not part of this test: a group
 * like (?:cat|dog)+ is perfectly well behaved, and the probes below catch the
 * pathological alternations that are not.
 */
const NESTED_QUANTIFIER =
  /\((?![?]:?[=!<])[^()]*(?:[*+]|\{\d+,\d*\})[^()]*\)\s*(?:[*+]|\{\d+,\d*\})/;

/**
 * Returns null when the pattern is safe to store, or the reason it is not.
 *
 * Compiling is not a sufficient check. `^(\w+\s?)+$` is eleven characters,
 * compiles fine, and takes hours on a forty-character comment — so a commenter,
 * not the operator, could stall moderation for that post permanently.
 *
 * Deciding this in general is undecidable, so this is best-effort by
 * construction; the engine also bounds how much text a user regex ever sees.
 */
export function regexSafetyProblem(source: string): string | null {
  const trimmed = source.trim();
  if (trimmed.length === 0) return "a regex rule needs a pattern";
  if (trimmed.length > MAX_REGEX_SOURCE) {
    return `a regex pattern must be at most ${MAX_REGEX_SOURCE} characters`;
  }

  let compiled: RegExp;
  try {
    compiled = new RegExp(trimmed, "iu");
  } catch {
    return "pattern is not a valid regular expression";
  }

  // Static first: the shape is recognisable without executing anything, which
  // is the only way to reject the worst patterns without paying for them.
  if (NESTED_QUANTIFIER.test(trimmed)) return REDOS_MESSAGE;

  for (const probe of REDOS_PROBES) {
    const started = Date.now();
    try {
      compiled.test(probe);
    } catch {
      return "pattern could not be evaluated";
    }
    if (Date.now() - started > REDOS_BUDGET_MS) return REDOS_MESSAGE;
  }
  return null;
}
