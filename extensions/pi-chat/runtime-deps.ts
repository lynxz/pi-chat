// Shared dependency surface for both slash commands (`commands.ts`) and
// LLM-callable tools (`tools.ts`). Keeping a single interface avoids two
// parallel deps objects drifting (`chat_set_autoreply` and `/chat-mute`
// must hit the same flag).
//
// The runtime owns a `RoomRouter` (Map<alias, handle>) and exposes
// per-room + cross-room operations through this surface. Tools and
// commands accept an optional `room` discriminator — absent means
// "primary room".

import type { ClientStatus } from "./client.ts";
import type { AutoReplyMode } from "./env.ts";

export type NotifyLevel = "info" | "warning" | "error";

export interface ChatEnvSnapshot {
  server: string;
  room: string;
  agent: string;
  /** Stable alias this room was discovered under (e.g. `BACKEND`, `DEFAULT`). */
  alias: string;
  autoreply: boolean;
  autoreplyMode: AutoReplyMode;
  history: number;
  reconnectMs: number;
  cooldownMs: number;
  minGapMs: number;
  replyChainMs: number;
  recentBufferSize: number;
  threadContext: boolean;
  prefix: string;
}

export interface ChatStatus {
  state: ClientStatus;
  env: ChatEnvSnapshot;
  agentCount: number;
  isNameDormant: boolean;
}

/**
 * Aliases a caller can pass to tools/commands. `undefined` / `null` /
 * empty means "primary room" (first room by alias sort order).
 *
 * `primary` is a reserved alias that always resolves to the current primary.
 * `all` is a reserved alias that, on read-only operations, means
 * "every joined room".
 */
export type RoomSelector = string | "primary" | "all" | null | undefined;

/**
 * One summary line per joined room — used by `chat_whoami` and the
 * `/chat-status` command to give a single multi-room overview.
 */
export interface ChatRoomSummary {
  alias: string;
  room: string;
  agent: string;
  server: string;
  state: ClientStatus;
  agentCount: number;
  isNameDormant: boolean;
  autoreply: boolean;
  autoreplyMode: AutoReplyMode;
  isPrimary: boolean;
}

export interface ChatRuntimeDeps {
  /** List of joined rooms sorted by alias (with primary flagged). */
  listRooms(): ChatRoomSummary[];
  /** Number of joined rooms. */
  roomCount(): number;

  /** Aliases of every joined room (uppercase). */
  aliases(): string[];

  /** Resolve a selector to one room's full status. */
  getStatus(room?: RoomSelector): ChatStatus;

  /**
   * Pick a room by selector.
   * - `undefined` / `null` / `"primary"` / `""` → primary room
   * - alias (case-insensitive) → matching room
   * - returns `undefined` if the alias is unknown or selector is `"all"`
   */
  resolveRoom(room?: RoomSelector): ChatStatus | undefined;

  /** Throw a descriptive error if the selector doesn't resolve to one room. */
  requireRoom(room?: RoomSelector): ChatStatus;

  /** Read a JSON resource from a specific room's chat-server. */
  fetchJson<T = unknown>(room: RoomSelector, path: string): Promise<T>;
  /** Read from a specific room's chat-server using the given path. */
  fetchJsonForStatus<T = unknown>(status: ChatStatus, path: string): Promise<T>;

  /** Pretty-print chat history JSON to a human-readable string. */
  formatHistory(items: unknown): string;

  /**
   * Send a chat message. Throws if the room is in conflict (`name_dormant`)
   * or any other transient failure (`rate_limit`, etc.). The wiring layer:
   *   - POSTs to /messages,
   *   - records the returned `id` in the reply map,
   *   - echoes the message into the local TUI.
   *
   * `room` selects which room sends; absent = primary.
   */
  sendOutbound(
    room: RoomSelector,
    text: string,
    meta?: Record<string, unknown>,
  ): Promise<{
    id: string;
    ts: number;
    mentions: string[];
  }>;

  /**
   * Toggle the runtime auto-reply flag (and optionally the mode).
   * `room` scopes which handle's flag is changed. `"all"` fans out to
   * every joined room.
   */
  setAutoreply(room: RoomSelector, enabled: boolean, mode?: AutoReplyMode): void;

  /**
   * Force-close and reopen the SSE connection (used by `/chat-reconnect`).
   * `room` scopes which handle reconnects. `"all"` reconnects every room.
   */
  reconnect(room?: RoomSelector): Promise<void>;

  /** Push a notification (used by `/chat-*` commands). */
  notify(text: string, level?: NotifyLevel): void;

  /** Currently focused room alias (sticky via `/chat-focus <alias>`). */
  getFocusedAlias(): string;
  /** Set focused room; `null` resets to primary. */
  setFocusedAlias(alias: string | null): void;
}
