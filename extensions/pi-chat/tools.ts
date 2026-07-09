// LLM-callable chat tools.
//
// Each tool accepts an optional `room` parameter (an alias like
// `"backend"`, or `"primary"`, or absent for default). `chat_whoami` and
// `chat_set_autoreply` accept `"all"` to fan out. All five delegate
// execution to a `ChatRuntimeDeps` object supplied by `runtime.ts` so
// this file stays free of network plumbing — pure wiring.

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ChatRuntimeDeps, RoomSelector } from "./runtime-deps.ts";
import { MAX_HISTORY_LIMIT, clampHistoryLimit } from "./limits.ts";

// --- schemas ---------------------------------------------------------------

const ROOM_SELECTOR_DESCRIPTION =
  "Which chat room to act on. Use an alias from `chat_whoami` (e.g. `\"backend\"`, `\"incidents\"`). " +
  "Omit to act on the primary room. `\"all\"` is accepted only on tools that fan out (chat_whoami, chat_set_autoreply).";

const roomSelector = (description: string = ROOM_SELECTOR_DESCRIPTION) =>
  Type.Optional(Type.String({ description }));

const CHAT_SEND_PARAMS = Type.Object({
  text: Type.String({
    description: "Message body. End with `?` to trigger the `questions` auto-reply mode on recipients.",
    minLength: 1,
    maxLength: 4096,
  }),
  room: roomSelector(),
  mentions: Type.Optional(Type.Array(
    Type.String({ description: "Optional mention tokens (without the leading `@`)." }),
    { description: "Optional list of mentions; the server already derives them from `text` but you can attach extras (e.g. for tools that scan ahead)." },
  )),
  meta: Type.Optional(Type.Object(
    {
      replyTo: Type.Optional(Type.String({
        description: "id of the message you are continuing. Receiving agents use this to attribute the thread.",
      })),
      branch: Type.Optional(Type.String()),
      pr: Type.Optional(Type.String()),
    },
    {
      description: "Free-form extension metadata (e.g. replyTo, branch, pr). Other keys are passed through verbatim.",
      additionalProperties: true,
    },
  )),
});

const CHAT_LIST_AGENTS_PARAMS = Type.Object({
  room: roomSelector("Which room to list agents for. Defaults to primary."),
});

const CHAT_HISTORY_PARAMS = Type.Object({
  limit: Type.Optional(Type.Number({
    minimum: 1,
    maximum: MAX_HISTORY_LIMIT,
    description: "Cap on the number of messages returned. Defaults to PI_CHAT_HISTORY.",
  })),
  room: roomSelector("Which room's history to read. Defaults to primary."),
});

const CHAT_WHOAMI_PARAMS = Type.Object({
  room: roomSelector(
    "Pass an alias to get per-room identity. Pass `\"all\"` for a cross-room summary. Defaults to primary.",
  ),
});

const CHAT_SET_AUTOREPLY_PARAMS = Type.Object({
  enabled: Type.Boolean({ description: "True to enable auto-reply, false to disable." }),
  mode: Type.Optional(StringEnum(["mentions", "questions", "all"] as const, {
    description: "Filter mode. Omit to keep the current mode.",
  })),
  room: roomSelector(
    "Which room to mutate. `\"all\"` toggles every joined room. Defaults to primary.",
  ),
});

/** Resolve a `RoomSelector` safely (returns undefined if the alias is unknown). */
function roomArgOrUndef(room: unknown): RoomSelector {
  if (typeof room !== "string" || room.length === 0) return undefined;
  return room;
}

// --- registration ---------------------------------------------------------

export function registerChatTools(pi: ExtensionAPI, deps: ChatRuntimeDeps): void {
  pi.registerTool({
    name: "chat_send",
    label: "Send chat message",
    description:
      "Send a message to every other Pi agent in a chat room. Pass `room=\"<alias>\"` to address a specific joined room " +
      "(see `chat_whoami` for the list). " +
      "Always address specific agents by including `@<name>` in the text itself (e.g. \"@bob can you review this?\") — " +
      "the chat transcript is read by humans who rely on `@mentions` to follow which agent is being addressed. " +
      "End the message with `?` to trigger the `questions` auto-reply mode on recipients; " +
      "set `meta.replyTo` to the `id` of the message you are continuing so receivers can attach their reply to the same thread.",
    promptSnippet: "Send a chat message to the other Pi agents in a joined room.",
    promptGuidelines: [
      "Use chat_send when you want to ask another agent for help, hand off a task, or report a result back to the room.",
      "Use chat_whoami first if you are unsure which rooms you have joined — every room has its own alias.",
      "Pass `room=\"<alias>\"` to choose a non-primary room. Omitting `room` sends to the primary room.",
      "Always include `@<recipient-name>` in chat_send text when addressing a specific agent — humans reading the room rely on it for threading.",
      "End the chat_send message with `?` if you want recipients to react via the `questions` auto-reply mode.",
      "Set chat_send `meta.replyTo` to the id of the message you are continuing so other agents can attach their reply to the same thread. The runtime will auto-prepend `@<originalFrom>` if missing — but writing it explicitly produces a more readable transcript.",
    ],
    parameters: CHAT_SEND_PARAMS,
    async execute(_toolCallId, params) {
      // Validate the room selector before sending so a typo doesn't silently
      // route to the primary room. `requireRoom` throws on unknown aliases
      // and rejects `"all"` (use chat_whoami for cross-room summaries).
      const sel = roomArgOrUndef(params.room);
      if (sel !== undefined) {
        deps.requireRoom(sel);
      }
      const result = await deps.sendOutbound(sel, params.text, params.meta);
      const mentionSummary = result.mentions.length > 0
        ? `, mentions=${JSON.stringify(result.mentions)}`
        : "";
      const hasMention = /(?<![A-Za-z0-9_-])@[A-Za-z0-9_-]{1,32}/.test(params.text);
      const replyTo = params.meta?.replyTo;
      const shouldNudge =
        !hasMention &&
        typeof replyTo === "string" &&
        replyTo.length > 0;
      const tip = shouldNudge
        ? ` Tip: humans read the room transcript — include \`@<name>\` in chat_send text next time so the addressee is visible.`
        : "";
      return {
        content: [{ type: "text", text: `Sent message ${result.id}${mentionSummary}.${tip}` }],
        details: { id: result.id, ts: result.ts, mentions: result.mentions },
      };
    },
  });

  pi.registerTool({
    name: "chat_list_agents",
    label: "List chat agents",
    description:
      "List other Pi agents currently connected to a chat room. Pass `room=\"<alias>\"` to choose a non-primary room; omit for the primary room.",
    promptSnippet: "List agents currently connected to the same room.",
    promptGuidelines: [
      "Use chat_list_agents to discover who is reachable in the room before sending messages.",
      "Pass `room=\"<alias>\"` to target a non-primary room.",
    ],
    parameters: CHAT_LIST_AGENTS_PARAMS,
    async execute(_toolCallId, params) {
      const status = deps.requireRoom(roomArgOrUndef(params.room));
      const list = await deps.fetchJsonForStatus<Array<{ name: string; connectedAt: number; lastSeen: number }>>(
        status,
        `/rooms/${encodeURIComponent(status.env.room)}/agents`,
      );
      const lines = list.length === 0
        ? [`(no agents connected in #${status.env.room})`]
        : list.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
          .map((a) => `- ${a.name}  (since ${new Date(a.connectedAt).toISOString()})`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { agents: list, room: status.env.room, alias: status.env.alias },
      };
    },
  });

  pi.registerTool({
    name: "chat_history",
    label: "Chat history",
    description:
      "Fetch the last N messages from a chat room's history. Default N = PI_CHAT_HISTORY. " +
      "Pass `room=\"<alias>\"` to choose a non-primary room; omit for the primary room. " +
      "History is never auto-replayed on join — call this to load context on demand.",
    promptSnippet: "Read recent messages from a chat room's history on demand.",
    promptGuidelines: [
      "Use chat_history to pull recent context from a room. Do not assume you've already seen anything that arrived before this session.",
      "Pass `room=\"<alias>\"` to read a non-primary room.",
    ],
    parameters: CHAT_HISTORY_PARAMS,
    async execute(_toolCallId, params) {
      const status = deps.requireRoom(roomArgOrUndef(params.room));
      const limit = clampHistoryLimit(params.limit, status.env.history);
      const items = await deps.fetchJsonForStatus<Array<{ id: string; from: string; text: string; ts: number }>>(
        status,
        `/rooms/${encodeURIComponent(status.env.room)}/history?limit=${limit}`,
      );
      const text = items.length === 0
        ? "(no messages in history)"
        : deps.formatHistory(items);
      return {
        content: [{ type: "text", text }],
        details: { count: items.length, limit, room: status.env.room, alias: status.env.alias },
      };
    },
  });

  pi.registerTool({
    name: "chat_whoami",
    label: "Chat whoami",
    description:
      "Return this extension's identity. " +
      "Pass `room=\"<alias>\"` for per-room state, omit for the primary room, or pass `\"all\"` for a cross-room summary. " +
      "Use this if unsure which rooms you have joined.",
    promptSnippet: "Identify the joined rooms, agent names, and connection state for pi-chat.",
    promptGuidelines: [
      "Call chat_whoami first if any chat tool seems to talk to the wrong room or a different agent.",
      "Pass `\"all\"` for a cross-room summary of every joined room.",
    ],
    parameters: CHAT_WHOAMI_PARAMS,
    async execute(_toolCallId, params) {
      const selector = roomArgOrUndef(params.room);
      if (selector === "all") {
        const lines = deps.listRooms().map((r) => {
          const marker = r.isPrimary ? "*" : " ";
          return [
            `${marker} alias=${r.alias}  room=#${r.room}  agent=${r.agent}`,
            `    server=${r.server}  state=${r.state.state}${r.isNameDormant ? " (name-dormant)" : ""}  agents=${r.agentCount}`,
            `    autoreply=${r.autoreply} (${r.autoreplyMode})`,
          ].join("\n");
        });
        const text = [
          `joined ${deps.roomCount()} room(s):`,
          ...(lines.length === 0 ? ["(none)"] : lines),
          `focus: ${deps.getFocusedAlias()}`,
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          details: { rooms: deps.listRooms(), focus: deps.getFocusedAlias() },
        };
      }
      const s = deps.getStatus(selector);
      const env = s.env;
      const text = [
        `server:  ${env.server}`,
        `room:    ${env.room}`,
        `alias:   ${env.alias}`,
        `agent:   ${env.agent}`,
        `state:   ${s.state.state}${s.isNameDormant ? " (name-dormant)" : ""}`,
        `autoreply: ${env.autoreply} (${env.autoreplyMode})`,
        `agents in room: ${s.agentCount}`,
      ].join("\n");
      return {
        content: [{ type: "text", text }],
        details: {
          env,
          state: s.state.state,
          agentCount: s.agentCount,
          isNameDormant: s.isNameDormant,
        },
      };
    },
  });

  pi.registerTool({
    name: "chat_set_autoreply",
    label: "Set auto-reply",
    description:
      "Toggle auto-reply at runtime for one or every joined room. When enabled, inbound messages that match the current mode " +
      "(`mentions` / `questions` / `all`) are routed back into the agent loop via `pi.sendUserMessage`. " +
      "When disabled, inbound messages appear as notifications only. " +
      "Pass `room=\"<alias>\"` for one room, `\"all\"` for every joined room, or omit for the primary room.",
    promptSnippet: "Toggle whether inbound chat messages trigger your agent loop.",
    promptGuidelines: [
      "Use chat_set_autoreply to control how chat messages wake you up. Default mode is `mentions`; switch to `all` for full broadcast mode, or disable to receive notifications only.",
      "Pass `room=\"<alias>\"` for one room, or `\"all\"` to fan out across every joined room.",
    ],
    parameters: CHAT_SET_AUTOREPLY_PARAMS,
    async execute(_toolCallId, params) {
      deps.setAutoreply(roomArgOrUndef(params.room), params.enabled, params.mode);
      // Surface per-room state when fanning out so the LLM sees the new
      // mode on each room instead of misreporting primary's mode as the
      // fan-out result.
      if (params.room === "all") {
        const lines = deps.listRooms().map((r) => {
          return `  @${r.alias}: ${r.autoreply ? "enabled" : "disabled"} (${r.autoreplyMode})`;
        });
        return {
          content: [{
            type: "text",
            text: `auto-reply ${params.enabled ? "enabled" : "disabled"} in all rooms${params.mode ? " (mode now: " + params.mode + ")" : ""}:\n${lines.join("\n")}`,
          }],
          details: {
            enabled: params.enabled,
            mode: params.mode ?? null,
            rooms: deps.listRooms().map((r) => ({ alias: r.alias, autoreply: r.autoreply, autoreplyMode: r.autoreplyMode })),
          },
        };
      }
      const s = deps.getStatus(roomArgOrUndef(params.room));
      const scope = `#${s.env.room} (alias=${s.env.alias})`;
      return {
        content: [{
          type: "text",
          text: `auto-reply ${params.enabled ? "enabled" : "disabled"} in ${scope}${params.mode ? ` (mode: ${s.env.autoreplyMode})` : ` (mode unchanged: ${s.env.autoreplyMode})`}.`,
        }],
        details: {
          enabled: params.enabled,
          mode: params.mode ?? null,
          room: s.env.alias,
        },
      };
    },
  });
}
