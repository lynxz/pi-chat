// Inbound filters (auto-reply modes and loop prevention).
//
// All predicates are pure so they can be tested in isolation. The stateful
// pieces — `rememberInboundId` for dedupe and `cooldownGate` for the
// per-sender window — live in `state.ts`; this module just encodes the
// rules.

import type { AutoReplyMode, ChatEnv } from "./env.ts";

/** Inbound message shape (subset of the server's wire format). */
export interface InboundMessage {
  id: string;
  from: string;
  text: string;
  ts: number;
  mentions: string[];
  meta?: Record<string, unknown>;
}

/** Lowercase comparison of a name (mention can be `@Alice` or `alice`). */
function normalise(name: string): string {
  return name.toLowerCase();
}

/** Does `token` (with or without the leading `@`) refer to `agent`? */
export function mentionsAgent(token: string, agent: string): boolean {
  return normalise(token.replace(/^@/, "")) === normalise(agent);
}

/** True iff any entry in `mentions` refers to `agent`. Case-insensitive. */
export function hasMentionFor(mentions: readonly string[], agent: string): boolean {
  if (!Array.isArray(mentions) || !agent) return false;
  return mentions.some((m) => mentionsAgent(String(m), agent));
}

/** True iff the trimmed `text` ends in `?`. */
export function endsWithQuestion(text: string): boolean {
  // Defensive: a malformed inbound (e.g. a comment-only SSE frame that the
  // parser accidentally forwarded) may arrive with `text === undefined`.
  // Treat non-strings as "not a question" — callers can branch on the
  // explicit false return rather than catching a TypeError.
  if (typeof text !== "string") return false;
  const t = text.trimEnd();
  if (!t) return false;
  // Treat trailing punctuation other than `?` as not changing the intent.
  for (let i = t.length - 1; i >= 0; i--) {
    const c = t[i];
    if (c === "?") return true;
    if (c !== "." && c !== "!" && c !== " " && c !== "\t" && c !== "," && c !== ";" && c !== ":") return false;
  }
  return false;
}

/** Self-echo filter. */
export function isFromSelf(message: InboundMessage, agent: string): boolean {
  return message.from === agent;
}

/**
 * The `meta.replyTo` thread tracking. True iff the message replies
 * to a message previously sent by `agent`. `replyMap` should be populated by
 * the inbound pipeline: every message *we* sent gets its `id` added; every
 * inbound `meta.replyTo` lookup checks it.
 */
export function repliesToMyMessage(message: InboundMessage, replyMap: Set<string>): boolean {
  const replyTo = message.meta?.replyTo;
  return typeof replyTo === "string" && replyMap.has(replyTo);
}

/**
 * Should an inbound message trigger an auto-reply turn?
 *
 *   mentions  — only when @agent is mentioned, or `replyTo` points at our id
 *   questions — same as `mentions`, *or* the trimmed text ends in `?`
 *   all       — every inbound message
 */
export function autoReplyMatches(
  message: InboundMessage,
  agent: string,
  mode: AutoReplyMode,
  ourReplyIds: Set<string>,
): boolean {
  if (mode === "all") return true;
  if (hasMentionFor(message.mentions, agent)) return true;
  if (repliesToMyMessage(message, ourReplyIds)) return true;
  if (mode === "questions" && endsWithQuestion(message.text)) return true;
  return false;
}

/** Convenience: full pre-sendUserMessage gate. False means "do not auto-reply". */
export function shouldAutoReply(
  env: ChatEnv,
  message: InboundMessage,
  ourReplyIds: Set<string>,
): boolean {
  if (!env.autoreply) return false;
  if (isFromSelf(message, env.agent)) return false;
  return autoReplyMatches(message, env.agent, env.autoreplyMode, ourReplyIds);
}
