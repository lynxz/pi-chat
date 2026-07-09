// Mention extraction.
//
// Rule (single, deterministic):
//   Pattern: `(?<![A-Za-z0-9_-])@[A-Za-z0-9_-]{1,32}`
//     - Lookbehind rejects matches inside identifiers/emails (`foo@bar.com` ⇒ no match).
//     - Allowed chars: A-Z, a-z, 0-9, _, -. Length 1–32.
//   Trailing punctuation (`. , ! ? : ; ) } ]`) is trimmed from each match.
//   Comparison is case-insensitive — `@Alice` matches agent `alice`.
//
// All matches — even those with no currently connected agent — are kept in
// `mentions`; an agent that joins later still recognises old messages.

const MENTION_RE = /(?<![A-Za-z0-9_-])@[A-Za-z0-9_-]{1,32}/g;
// Set lookup is clearer and faster than a per-character regex match.
const TRAILING_PUNCT = new Set([".", ",", "!", "?", ":", ";", ")", "}", "]"]);

/**
 * Extract @mention tokens from `text`.
 *
 * Returns the original matched token (e.g. `@Alice`) so callers can preserve
 * casing for display; for case-insensitive *comparison* use `normalize(name)`.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function extractMentions(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const out = [];
  for (const raw of text.matchAll(MENTION_RE)) {
    let token = raw[0];
    while (token.length > 1 && TRAILING_PUNCT.has(token.at(-1))) {
      token = token.slice(0, -1);
    }
    if (token.length > 1) out.push(token);
  }
  return out;
}

/** Normalise an agent name for case-insensitive comparison. */
export function normalize(name) {
  return typeof name === "string" ? name.toLowerCase() : "";
}

/**
 * True if `token` (an @mention like `@Alice` or `@alice`) refers to `agent`
 * (case-insensitive comparison).
 */
export function mentionsAgent(token, agent) {
  return normalize(token.slice(1)) === normalize(agent);
}

/**
 * True if any entry in `mentions` refers to `agent`.
 * Accepts tokens with or without a leading `@`.
 */
export function hasMentionFor(mentions, agent) {
  if (!Array.isArray(mentions) || !agent) return false;
  const needle = normalize(agent);
  return mentions.some((m) => normalize(String(m).replace(/^@/, "")) === needle);
}
