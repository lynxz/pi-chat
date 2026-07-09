// Shared numeric bounds for the chat-history surface.
//
// Kept in its own module so `commands.ts` (slash command) and `tools.ts`
// (LLM-callable tool) agree on defaults and clamps. The chat-server's
// `CHAT_HISTORY_LIMIT` defaults to 500 (ring buffer cap), and we mirror
// that here so neither side ever asks the server for more than it can return.

/** Upper bound on `chat_history` fetches — mirrors the server's ring buffer cap. */
export const MAX_HISTORY_LIMIT = 500;

/**
 * Clamp a history-limit argument into `[1, MAX_HISTORY_LIMIT]`. Returns
 * `fallback` for absent or invalid input. Used by `/chat-history` and
 * `chat_history`.
 */
export function clampHistoryLimit(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), MAX_HISTORY_LIMIT);
}
