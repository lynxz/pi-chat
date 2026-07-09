// Slash commands.
//
// Every command accepts an optional leading `[room]` argument (alias).
// Multi-room commands:
//   - /chat-rooms          — list joined rooms
//   - /chat-focus <alias>  — set the sticky focused room
//   - /chat-reconnect [room|all]
//   - /chat-mute [room|all] / /chat-unmute [room|all]
//
// All commands delegate to a `ChatRuntimeDeps` object provided by
// `runtime.ts` so this module stays free of network and Pi-handle
// globals — pure wiring.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ChatRuntimeDeps, RoomSelector } from "./runtime-deps.ts";
import { MAX_HISTORY_LIMIT, clampHistoryLimit } from "./limits.ts";

/**
 * Parse a leading `[alias]` from a raw args string. The `[alias]`
 * argument is optional in every command; absent → primary room. Returns
 * `{ selector, rest }` where `rest` is the args string with the leading
 * alias removed (and any leading whitespace stripped).
 *
 * Square-bracket syntax (`[backend] rest`) always wins. The bare alias
 * shortcut is only honoured for the reserved tokens `"all"` and
 * `"primary"` — bare-word room aliases are intentionally NOT short-formed
 * so user text like `/chat-send hello world` doesn't get misparsed as
 * `room=hello, text=world`. Use `[alias]` for a non-primary shortcut.
 */
function parseRoomPrefix(args: string): { selector: RoomSelector; rest: string } {
  const trimmed = args.trim();
  if (trimmed.length === 0) return { selector: undefined, rest: "" };
  // Square-bracket syntax: `[backend] rest`
  const bracketMatch = trimmed.match(/^\[([^\]]+)\]\s*([\s\S]*)$/);
  if (bracketMatch) {
    return { selector: bracketMatch[1], rest: (bracketMatch[2] ?? "").trim() };
  }
  // Reserved-token shortcut: `/chat-send all hello` → room=all, text=hello.
  const firstSpace = trimmed.indexOf(" ");
  const head = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const tail = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
  if (head === "all" || head === "primary") {
    return { selector: head, rest: tail };
  }
  return { selector: undefined, rest: trimmed };
}

export function registerChatCommands(pi: ExtensionAPI, deps: ChatRuntimeDeps): void {
  pi.registerCommand("chat-status", {
    description: "Show pi-chat connection status (room, agent, state). Pass `[alias]` to focus one room, or `all` for a list.",
    handler: async (args, ctx) => {
      const { selector } = parseRoomPrefix(args);
      if (selector === "all") {
        const lines = deps.listRooms().map((r) => {
          const marker = r.isPrimary ? "*" : " ";
          return `${marker} alias=${r.alias}  #${r.room}  agent=${r.agent}  state=${r.state.state}${r.isNameDormant ? " (name-dormant)" : ""}  agents=${r.agentCount}  autoreply=${r.autoreply} (${r.autoreplyMode})`;
        });
        const text = [
          `joined ${deps.roomCount()} room(s):`,
          ...(lines.length === 0 ? ["(none)"] : lines),
          `focus: ${deps.getFocusedAlias()}`,
        ].join("\n");
        ctx.ui.notify(text, "info");
        return;
      }
      const status = deps.resolveRoom(selector) ?? deps.getStatus();
      const lines = [
        `server:  ${status.env.server}`,
        `room:    ${status.env.room}  (alias=${status.env.alias})`,
        `agent:   ${status.env.agent}`,
        `state:   ${status.state.state}${status.isNameDormant ? " (name-dormant)" : ""}`,
        `autoreply: ${status.env.autoreply} (${status.env.autoreplyMode})`,
        `agents in room: ${status.agentCount}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("chat-rooms", {
    description: "List joined chat rooms and their aliases",
    handler: async (_args, ctx) => {
      const lines = deps.listRooms().map((r) => {
        const marker = r.isPrimary ? "* " : "  ";
        const sleep = r.isNameDormant ? " (name-dormant)" : "";
        return `${marker}@${r.alias} → #${r.room} on ${r.server}  agent=${r.agent}  state=${r.state.state}${sleep}  agents=${r.agentCount}`;
      });
      const text = [
        `joined ${deps.roomCount()} room(s):`,
        ...(lines.length === 0 ? ["(none)"] : lines),
        `focus: @${deps.getFocusedAlias()}`,
      ].join("\n");
      ctx.ui.notify(text, "info");
    },
  });

  pi.registerCommand("chat-focus", {
    description: "Set the sticky focused room: /chat-focus <alias> (no alias resets to primary)",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (trimmed.length === 0) {
        deps.setFocusedAlias(null);
        ctx.ui.notify(`focus reset to @${deps.getFocusedAlias()}`, "info");
        return;
      }
      const target = trimmed.split(/\s+/)[0];
      const prev = deps.getFocusedAlias();
      deps.setFocusedAlias(target);
      const next = deps.getFocusedAlias();
      if (next === prev && target.toUpperCase() !== prev) {
        ctx.ui.notify(`unknown room alias: ${target}`, "warning");
      } else {
        ctx.ui.notify(`focus set to @${next}`, "info");
      }
    },
  });

  pi.registerCommand("chat-send", {
    description: "Send a quick message: /chat-send [room] <text>",
    handler: async (args, ctx) => {
      const { selector, rest } = parseRoomPrefix(args);
      const text = rest.trim();
      // Footgun guard: `/chat-send backend hello` looks like a room
      // selector but the parser only honours `[backend]` for non-reserved
      // aliases. Warn so the user realises the bare-word form is being
      // sent to the primary room. (LLM callers go through `chat_send`,
      // which DOES validate the room and surfaces the error directly.)
      if (
        text.length > 0 &&
        selector === undefined &&
        /^[A-Za-z][A-Za-z0-9_]*\s\S/.test(args.trim())
      ) {
        const head = args.trim().split(/\s+/)[0];
        let known = "";
        try { known = deps.listRooms().map((r) => `@${r.alias.toLowerCase()}`).join(", "); } catch { /* noop */ }
        if (known.length > 0) {
          ctx.ui.notify(
            `chat-send: ignoring bare alias "${head}". Use brackets — e.g. /chat-send [${head.toLowerCase()}] ${rest}. Known rooms: ${known}.`,
            "warning",
          );
          return;
        }
      }
      if (!text) {
        ctx.ui.notify("Usage: /chat-send [room] <text>  (use the `chat_send` tool for cross-room fan-out)", "warning");
        return;
      }
      try {
        const r = await deps.sendOutbound(selector, text);
        const roomName = (() => { try { return deps.getStatus(selector).env.room; } catch { return "?"; } })();
        ctx.ui.notify(
          `Sent ${r.id.slice(0, 8)}… to #${roomName} (${r.mentions.length} mention${r.mentions.length === 1 ? "" : "s"})`,
          "info",
        );
      } catch (err) {
        ctx.ui.notify(`chat-send failed: ${errorMessage(err)}`, "warning");
      }
    },
  });

  pi.registerCommand("chat-reconnect", {
    description: "Force-close and reopen the SSE connection for one or every room: /chat-reconnect [room|all] (default primary)",
    handler: async (args, ctx) => {
      const { selector } = parseRoomPrefix(args);
      ctx.ui.notify(`Reconnecting ${selector ?? "primary"}…`, "info");
      try {
        await deps.reconnect(selector);
        ctx.ui.notify("Reconnect complete", "info");
      } catch (err) {
        ctx.ui.notify(`chat-reconnect failed: ${errorMessage(err)}`, "warning");
      }
    },
  });

  pi.registerCommand("chat-mute", {
    description: "Disable auto-reply in the focused room (default), one alias, or every room: /chat-mute [room|all]",
    handler: async (args, ctx) => {
      const { selector } = parseRoomPrefix(args);
      // Default scope = focused room (sticky via /chat-focus). Pass
      // `[all]` to mute every room at once, or `[<alias>]` to mute a
      // specific one. Stays single-room by default — flipping the
      // default to "all" would surprise users running two rooms with
      // different modes.
      const scope = selector ?? deps.getFocusedAlias();
      deps.setAutoreply(scope, false);
      const resolved = deps.getStatus(scope);
      ctx.ui.notify(
        `Auto-reply muted — inbound messages in #${resolved.env.room} (alias=${resolved.env.alias}) will be notifications only`,
        "info",
      );
    },
  });

  pi.registerCommand("chat-unmute", {
    description: "Re-enable auto-reply in the focused room (default), one alias, or every room: /chat-unmute [room|all]",
    handler: async (args, ctx) => {
      const { selector } = parseRoomPrefix(args);
      const scope = selector ?? deps.getFocusedAlias();
      deps.setAutoreply(scope, true);
      const resolved = deps.getStatus(scope);
      ctx.ui.notify(
        `Auto-reply enabled in #${resolved.env.room} (alias=${resolved.env.alias})`,
        "info",
      );
    },
  });

  pi.registerCommand("chat-agents", {
    description: "List connected agents in a room: /chat-agents [room|all]",
    handler: async (args, ctx) => {
      const { selector } = parseRoomPrefix(args);
      try {
        if (selector === "all") {
          const sections: string[] = [];
          for (const r of deps.listRooms()) {
            const status = deps.getStatus(r.alias);
            const list = await deps.fetchJsonForStatus<Array<{ name: string; connectedAt: number; lastSeen: number }>>(
              status,
              `/rooms/${encodeURIComponent(status.env.room)}/agents`,
            );
            const body = list.length === 0
              ? "  (no agents connected)"
              : list
                  .slice()
                  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
                  .map((a) => `  ${a.name}  (since ${new Date(a.connectedAt).toISOString()})`)
                  .join("\n");
            sections.push(`#${status.env.room} (alias=${r.alias}):\n${body}`);
          }
          ctx.ui.notify(sections.join("\n\n"), "info");
          return;
        }
        const status = deps.getStatus(selector);
        const list = await deps.fetchJsonForStatus<Array<{ name: string; connectedAt: number; lastSeen: number }>>(
          status,
          `/rooms/${encodeURIComponent(status.env.room)}/agents`,
        );
        if (!list.length) {
          ctx.ui.notify(`No agents connected in #${status.env.room}`, "info");
          return;
        }
        const lines = list
          .slice()
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
          .map((a) => `${a.name}  (since ${new Date(a.connectedAt).toISOString()})`);
        ctx.ui.notify(lines.join("\n"), "info");
      } catch (err) {
        ctx.ui.notify(`chat-agents failed: ${errorMessage(err)}`, "warning");
      }
    },
  });

  pi.registerCommand("chat-history", {
    description: `Pretty-print the last N room messages: /chat-history [room] [N] (default N = PI_CHAT_HISTORY=${deps.getStatus().env.history}, max ${MAX_HISTORY_LIMIT})`,
    handler: async (args, ctx) => {
      const parsed = parseRoomPrefix(args);
      let selector: RoomSelector = parsed.selector;
      let limitArg = parsed.rest.trim();
      // If the leading "[room]" wasn't used, allow `/chat-history backend 50`
      // — i.e. the selector was detected as a single token, but the user
      // could also have intended only a number. Treat a purely-numeric
      // remaining token as a limit, not a room.
      if (selector !== undefined && /^\d+$/.test(selector as string)) {
        limitArg = (selector as string) + (limitArg ? ` ${limitArg}` : "");
        selector = undefined;
      }
      let userLimit: number | null = null;
      if (limitArg.length > 0) {
        const n = Number.parseInt(limitArg, 10);
        if (!Number.isFinite(n) || n < 1) {
          ctx.ui.notify(`Usage: /chat-history [room] <positive integer ≤ ${MAX_HISTORY_LIMIT}>`, "warning");
          return;
        }
        userLimit = n;
      }
      try {
        if (selector === "all") {
          const sections: string[] = [];
          for (const r of deps.listRooms()) {
            const st = deps.getStatus(r.alias);
            const limit = clampHistoryLimit(userLimit ?? st.env.history, st.env.history);
            const items = await deps.fetchJsonForStatus<Array<{ id: string; from: string; text: string; ts: number }>>(
              st,
              `/rooms/${encodeURIComponent(st.env.room)}/history?limit=${limit}`,
            );
            const tag = userLimit !== null && userLimit !== limit ? ` (clamped to ${limit})` : "";
            const body = items.length === 0
              ? "(no messages in history)"
              : deps.formatHistory(items);
            sections.push(`#${st.env.room} (alias=${r.alias}):${tag}\n${body}`);
          }
          ctx.ui.notify(sections.join("\n\n"), "info");
          return;
        }
        const status = deps.getStatus(selector);
        const limit = clampHistoryLimit(userLimit ?? status.env.history, status.env.history);
        const items = await deps.fetchJsonForStatus<Array<{ id: string; from: string; text: string; ts: number }>>(
          status,
          `/rooms/${encodeURIComponent(status.env.room)}/history?limit=${limit}`,
        );
        const body = items.length === 0
          ? "(no messages in history)"
          : deps.formatHistory(items);
        const tag = userLimit !== null && userLimit !== limit ? ` (clamped to ${limit})` : "";
        ctx.ui.notify(`${body}${tag}`, "info");
      } catch (err) {
        ctx.ui.notify(`chat-history failed: ${errorMessage(err)}`, "warning");
      }
    },
  });
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "unknown error";
}

/** Pretty-print chat history (re-exported from runtime-deps consumers). */
export function defaultFormatHistory(items: Array<{ id: string; from: string; text: string; ts: number }>): string {
  if (!items.length) return "(no messages in history)";
  const lines = items.map((m) => {
    const t = new Date(m.ts).toISOString().replace("T", " ").replace(/\..+/, "");
    return `${t}  ${m.from.padEnd(8)}  ${m.text}`;
  });
  return lines.join("\n");
}
