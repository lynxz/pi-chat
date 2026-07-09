// Outbound auto-mention resolution + silent-drop diagnostic.
//
// Extracted from `sendOutbound` in `index.ts` so the resolution + silent-drop
// diagnostic logic can be unit-tested in isolation from the chat-server.
// Behaviour is identical to the original inline implementation.

import type { RecentBuffer } from "./state.ts";

export interface AutoMentionResolution {
  /** The text to actually send, with `@<sender>` prepended when applicable. */
  resolvedText: string;
  /** The sender that was resolved (via `replyTo` lookup or recency fallback). */
  originalFrom?: string;
  /**
   * True iff `meta.replyTo` was set but neither the recent-buffer lookup
   * nor the recency fallback resolved a sender. Caller should emit a
   * warning notify so the recipient's `mentions`-mode auto-reply silent
   * miss is surfaced (otherwise the message would go out with no
   * `@mention` and bob/carol/etc would never see it).
   */
  unresolvedReplyTo: boolean;
}

/**
 * Resolve the auto-mention for an outbound message.
 *
 * Two priority levels:
 *   1. **Explicit reply chain** — `meta.replyTo` set and resolvable in
 *      `recent`. Use the original message's `from` as the mention target.
 *   2. **Recency fallback** — most recent non-self message in `recent`
 *      whose `ts` is within `replyChainMs` of `now`. Covers the case
 *      where the LLM forgot to set `replyTo` but is clearly replying to a
 *      recent inbound.
 *
 * Skip conditions:
 *   - the resolved sender is `self` (don't @mention ourselves),
 *   - the resolved sender's `@<name>` token is already present in the
 *     text (don't double-up).
 *
 * The `unresolvedReplyTo` flag is set only when `meta.replyTo` was
 * provided but no sender could be resolved. The caller surfaces a
 * warning notify in that case so silent drops are visible.
 */
export function resolveAutoMention(
  text: string,
  meta: Record<string, unknown> | undefined,
  recent: RecentBuffer,
  selfAgent: string,
  replyChainMs: number,
  now: number = Date.now(),
): AutoMentionResolution {
  let resolvedText = text;
  let originalFrom: string | undefined;
  const replyTo = meta?.replyTo;

  // Priority 1: explicit reply chain.
  if (typeof replyTo === "string" && replyTo.length > 0) {
    const original = recent.find(replyTo);
    if (original && original.from !== selfAgent) {
      originalFrom = original.from;
    }
  }
  // Priority 2: recency fallback (only when no replyTo or it didn't resolve).
  if (originalFrom === undefined) {
    const cutoff = now - replyChainMs;
    const items = recent.recent();
    for (let i = items.length - 1; i >= 0; i--) {
      const m = items[i];
      if (m.from !== selfAgent && m.ts >= cutoff) {
        originalFrom = m.from;
        break;
      }
    }
  }
  // Apply the resolved mention (if any).
  if (originalFrom !== undefined) {
    const token = `@${originalFrom}`;
    if (!resolvedText.includes(token)) {
      resolvedText = `${token} ${resolvedText}`;
    }
  }
  return {
    resolvedText,
    originalFrom,
    unresolvedReplyTo:
      typeof replyTo === "string" &&
      replyTo.length > 0 &&
      originalFrom === undefined,
  };
}