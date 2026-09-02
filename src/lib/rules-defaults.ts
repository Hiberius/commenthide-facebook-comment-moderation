// CommentHide — the starter rule set.
//
// Data, not logic, so it lives apart from the engine. Kept deliberately narrow:
// every term here is spam in essentially any context. Nothing in this list
// resembles an unhappy customer, because a moderation tool that buries honest
// criticism is the thing this project exists not to be.

import type { DefaultRuleSeed } from "./rules";

/**
 * Commercial bait only — scam funnels, spam and flooding.
 *
 * Nothing here fires on criticism, sarcasm or an angry-but-honest customer.
 * Hiding those is exactly what this project refuses to be for, and the list is
 * reviewed against that rule every time a term is added.
 */
const SPAM_KEYWORDS = [
  "whatsapp me, click my profile, check my profile, link in my bio, dm me for",
  "make money fast, double your money, guaranteed profit, guaranteed returns",
  "earn from home, binary options, forex signals, crypto investment",
  "bitcoin investment, recovery expert, free followers, buy followers",
  "claim your prize, congratulations you won",
  "investimento garantito, guadagno garantito, rendimento garantito",
  "guadagna da casa, soldi facili, prestito garantito",
  "contattami su whatsapp, scrivimi su whatsapp, clicca sul mio profilo",
  "guarda il mio profilo, hai vinto un premio",
].join(", ");

export const DEFAULT_RULES: readonly DefaultRuleSeed[] = [
  { kind: "link", pattern: "", action: "hide", label: "Links", priority: 10 },
  { kind: "contact", pattern: "", action: "hide", label: "Contact details", priority: 20 },
  { kind: "keyword", pattern: SPAM_KEYWORDS, action: "hide", label: "Known spam and scam phrases", priority: 30 },
  { kind: "emoji_spam", pattern: "6", action: "hide", label: "Emoji flooding", priority: 40 },
  { kind: "min_length", pattern: "2", action: "hide", label: "Empty or single-character comments", priority: 50 },
];
