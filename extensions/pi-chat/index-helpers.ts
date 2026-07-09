// Pure helpers used by both the single-room index.ts path and the
// multi-room runtime. Extracted so they can be unit-tested without
// booting the full runtime.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ChatEnv } from "./env.ts";
import type { RecentBuffer } from "./state.ts";

/**
 * Build a multi-line prompt that includes the recent chat-room context
 * followed by the new inbound message. Format:
 *
 *   You have a new chat message arriving on the shared chat room.
 *   Recent room traffic (for context only — do NOT reply to these in
 *   your own conversation; use the `chat_send` tool to send any reply):
 *
 *     <ts>  <from>  <text>
 *     …
 *
 *   NEW MESSAGE (use `chat_send` to reply — typing a reply in this
 *   conversation will NOT reach the other agent):
 *   Message id: <id>
 *   [chat <from>] <text>
 *   Other agents in this room: @<a>, @<b>, …
 *
 *   To reply, call chat_send with text containing `@<from>` (e.g.
 *   `@<from> thanks!`) and `meta.replyTo: "<id>"`. Writing the
 *   `@mention` explicitly produces a readable transcript for humans;
 *   the runtime also auto-prepends it as a safety net if you forget.
 */
export function buildThreadPrompt(
  env: ChatEnv,
  recent: RecentBuffer,
  inbound: { id: string; from: string; text: string; ts: number },
  roster: ReadonlySet<string>,
): string {
  const window = Math.max(1, env.recentBufferSize);
  const items = recent.recent(window).filter((m) => m.id !== inbound.id);
  const newMessage = `[chat ${inbound.from}] ${inbound.text}`;
  const idHint = `Message id: ${inbound.id}`;
  const rosterLine = formatRosterLine(roster, env.agent);
  const replyInstructions = [
    `Reply by calling chat_send with text containing \`@${inbound.from}\` (e.g. "@${inbound.from} thanks!")`,
    `and \`meta.replyTo: "${inbound.id}"\`. Writing the \`@mention\` explicitly produces a readable transcript`,
    `for humans; the runtime also auto-prepends it as a safety net if you forget.`,
  ].join(" ");
  if (items.length === 0) {
    return [
      "You have a new chat message arriving on the shared chat room.",
      "Use the `chat_send` tool to reply — typing a reply in this conversation will NOT reach the other agent.",
      "",
      "NEW MESSAGE:",
      `${idHint}`,
      newMessage,
      rosterLine,
      "",
      replyInstructions,
    ].join("\n");
  }
  const lines = items.map((m) => {
    const t = new Date(m.ts).toISOString().replace("T", " ").replace(/\..+/, "");
    return `  ${t}  ${m.from.padEnd(8)}  ${m.text}`;
  });
  return [
    "You have a new chat message arriving on the shared chat room.",
    `Recent room traffic (for context only — do NOT reply to these in your own conversation; use the \`chat_send\` tool to send any reply):`,
    "",
    ...lines,
    "",
    "NEW MESSAGE (use `chat_send` to reply — typing a reply in this conversation will NOT reach the other agent):",
    `${idHint}`,
    newMessage,
    rosterLine,
    "",
    replyInstructions,
  ].join("\n");
}

/**
 * Render the roster line shown in the inbound prompt. Excludes only `self`
 * (no point addressing ourselves).
 */
export function formatRosterLine(roster: ReadonlySet<string>, selfAgent: string): string {
  const others = [...roster].filter((n) => n !== selfAgent).sort();
  if (others.length === 0) {
    return "Other agents in this room: (only you)";
  }
  return `Other agents in this room: ${others.map((n) => `@${n}`).join(", ")}`;
}

/**
 * Internal counter / set pair used by `announceRosterIfChanged`.
 */
export interface RosterAnnouncementState {
  roster: Set<string>;
  lastAnnouncedRoster: Set<string>;
  presenceDeltaSinceAnnounce: { value: number };
}

/**
 * Emit a `[chat #room] agents now: …` notification only when the live
 * roster has shifted enough to be worth surfacing.
 */
export function announceRosterIfChanged(
  ctx: ExtensionContext,
  state: RosterAnnouncementState,
  roomLabel: string,
  isFullReseed: boolean,
): boolean {
  const current = [...state.roster].sort().join(",");
  const last = [...state.lastAnnouncedRoster].sort().join(",");
  if (current === last) return false;
  if (!isFullReseed) {
    state.presenceDeltaSinceAnnounce.value += 1;
    if (state.presenceDeltaSinceAnnounce.value < 2) return false;
  }
  state.presenceDeltaSinceAnnounce.value = 0;
  state.lastAnnouncedRoster = new Set(state.roster);
  const text = state.roster.size === 0
    ? `[chat ${roomLabel}] agents now: (none connected)`
    : `[chat ${roomLabel}] agents now: ${[...state.roster].sort().map((n) => `@${n}`).join(", ")}`;
  ctx.ui.notify(text, "info");
  return true;
}

/**
 * Build the system-prompt block injected by `before_agent_start`. Returns
 * `undefined` when no injection should happen.
 */
export function buildChatRoomSystemPrompt(
  env: ChatEnv,
  roster: ReadonlySet<string>,
  recent: RecentBuffer,
  autoreplyOn: boolean,
  systemPrompt: string,
): string | undefined {
  if (recent.recent().length === 0 && !autoreplyOn) return undefined;
  const others = [...roster].filter((n) => n !== env.agent).sort();
  const rosterText = others.length === 0
    ? "(no other agents connected right now)"
    : others.map((n) => `@${n}`).join(", ");
  const block = [
    "## Chat room (pi-chat)",
    `You are agent \`${env.agent}\` in chat room \`#${env.room}\`.`,
    `Other agents currently in the room: ${rosterText}.`,
    "",
    "**Convention:** address specific agents by writing `@<name>` directly in the text of every `chat_send` call (e.g. `@bob can you take a look?`). The chat transcript is read by humans and they rely on `@mentions` for threading — writing the mention explicitly is the expected style.",
  ].join("\n");
  return systemPrompt + "\n\n" + block;
}
