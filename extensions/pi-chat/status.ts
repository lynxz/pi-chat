// Footer status line helper. The Pi TUI supports multiple extension status
// slots; we use the key "pi-chat" so users see one line per extension. The
// `setStatus(key, text)` signature is two-arg only (no flash/level flag), so
// attention states use a visible marker (`!`) in the text instead.
//
// The footer summarises every joined room in a single line:
// `chat: backend=3, incidents=1 (you=alice)`. A short alias is shown
// per room; the focused room gets a `*` marker so users can see which
// room's perspective a `/chat-send` would broadcast from.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ClientStatus } from "./client.ts";

export const STATUS_KEY = "pi-chat";

export interface StatusSpec {
  /** Footer text. Set in every state. */
  text: string;
  /** True when the state is one the user should notice (offline / conflict / dormant). */
  alert?: boolean;
}

/**
 * Build the per-room status block (used inside the multi-room summary).
 * Six states map to:
 *   offline        → "! offline"                       (alert)
 *   connecting     → "connecting…"                     (transient)
 *   connected      → "N"                               (steady — agent count)
 *   conflict       → "! name in use"                   (alert — server 409)
 *   name-dormant   → "! name-dormant"                  (alert — local)
 */
function shortState(status: ClientStatus, isNameDormant: boolean): string | null {
  if (isNameDormant) return "!name-dormant";
  switch (status.state) {
    case "offline":
      return null; // omit offline rooms from the summary entirely
    case "connecting":
      return "connecting";
    case "conflict":
      return "!conflict";
    case "connected": {
      const agents = (status.info as { agents?: Array<unknown> } | undefined)?.agents;
      const count = Array.isArray(agents) ? agents.length : 0;
      return `${count}`;
    }
    default:
      return status.state;
  }
}

/**
 * Build the multi-room footer status.
 *
 * Examples:
 *   chat: dormant                                    (no rooms joined)
 *   chat: offline                                    (all rooms offline)
 *   chat: backend=3 (you=alice)
 *   chat: backend=3, incidents=1 (you=alice)
 *   chat: backend=3*, incidents=1 (focus=incidents)  (sticky focus)
 */
export function buildMultiRoomStatus(
  rooms: ReadonlyArray<{
    alias: string;
    agent: string;
    agentCount: number;
    state: ClientStatus;
    isNameDormant: boolean;
  }>,
  primaryAlias: string,
  focusedAlias: string,
): StatusSpec {
  if (rooms.length === 0) {
    return { text: "chat: dormant", alert: true };
  }

  const parts = rooms
    .map((r) => {
      // For `connected` rooms, prefer the pre-computed `agentCount`
      // (cached at summary-build time). Fall back to the `state.info.agents`
      // count for callers that don't populate `agentCount` (e.g. old tests).
      let s: string | null;
      if (r.isNameDormant) {
        s = "!name-dormant";
      } else if (r.state.state === "offline") {
        s = null;
      } else if (r.state.state === "connecting") {
        s = "connecting";
      } else if (r.state.state === "conflict") {
        s = "!conflict";
      } else if (r.state.state === "connected") {
        const computed = (r.state.info as { agents?: Array<unknown> } | undefined)?.agents?.length;
        const count = typeof r.agentCount === "number" ? r.agentCount : (typeof computed === "number" ? computed : 0);
        s = `${count}`;
      } else {
        s = r.state.state;
      }
      if (s === null) return null;
      const focus = r.alias === focusedAlias ? "*" : "";
      return `${r.alias.toLowerCase()}=${s}${focus}`;
    })
    .filter((x): x is string => x !== null);

  if (parts.length === 0) {
    // Every room offline but rooms exist.
    return { text: "chat: offline", alert: true };
  }

  const primaryAgent = rooms[0]?.agent ?? "";
  const youTag = primaryAgent ? ` you=${primaryAgent}` : "";
  const youLine = rooms.length > 1
    ? ` (focus=${focusedAlias.toLowerCase()})${youTag}`
    : youTag;
  return { text: `chat: ${parts.join(", ")}${youLine}` };
}

/**
 * Single-room status builder. Kept for back-compat with tests and the
 * existing /chat-status command when only one room is joined.
 */
export function buildStatus(state: ClientStatus, agent: string, room: string, isNameDormant: boolean): StatusSpec {
  if (isNameDormant) {
    return { text: `! chat: name-dormant in #${room}`, alert: true };
  }
  switch (state.state) {
    case "offline":
      return { text: `! chat: offline`, alert: true };
    case "connecting":
      return { text: `chat: connecting… (#${room})` };
    case "conflict":
      return { text: `! chat: name in use (#${room})`, alert: true };
    case "connected": {
      const agents = (state.info as { agents?: Array<unknown> } | undefined)?.agents;
      const count = Array.isArray(agents) ? agents.length : 0;
      const you = agent ? ` you=${agent}` : "";
      return { text: `chat: ${count} in #${room}${you}` };
    }
    default:
      return { text: `chat: ${state.state}` };
  }
}

/** Push the current status to Pi's TUI footer. Safe to call repeatedly. */
export function applyStatus(ctx: Pick<ExtensionContext, "ui">, spec: StatusSpec): void {
  try {
    ctx.ui.setStatus(STATUS_KEY, spec.text);
  } catch {
    // `setStatus` exists in tui + rpc modes; in others it's a no-op.
  }
}
