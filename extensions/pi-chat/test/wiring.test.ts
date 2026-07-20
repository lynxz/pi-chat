// Wiring test: confirms that when chat_send is invoked via the
// runtime deps (as `pi.registerTool(...)` would do, just exercising the
// `execute` callback directly), it triggers `ctx.ui.notify` for the local
// echo AND POSTs to the chat-server. This is the integration glue between
// `tools.ts`, the runtime handle in `index.ts`, and the ChatClient.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { createChatServer } from "../../../chat-server/server.js";
import { ChatClient, type SendResult } from "../client.ts";
import { CooldownGate, IdDedupe, ReplyTracker } from "../state.ts";
import { defaultFormatHistory } from "../commands.ts";
import { isFromSelf } from "../filters.ts";
import { registerChatTools } from "../tools.ts";
import type { ChatRuntimeDeps, ChatStatus, NotifyLevel } from "../runtime-deps.ts";
import type { AutoReplyMode, ChatEnv } from "../env.ts";

let runtime: Awaited<ReturnType<typeof createChatServer>>;
let baseUrl: string;

before(async () => {
  runtime = createChatServer({ port: 0, host: "127.0.0.1", quiet: true });
  const addr = await runtime.start();
  baseUrl = `http://127.0.0.1:${addr.port}`;
});
after(async () => {
  await runtime.shutdown("test", false);
});

interface SentMessage {
  customType: string;
  content: string;
  display?: boolean;
  details?: unknown;
}

/**
 * Build the runtime handle + deps the way `index.ts` would, but with a fake
 * Pi that records `sendMessage` and `registerTool` calls. This lets us drive
 * the chat_send tool end-to-end via the wiring layer without booting Pi.
 */
function buildFakeRuntime(env: Partial<ChatEnv> & { prefix?: string } = {}) {
  const fullEnv: ChatEnv = {
    server: baseUrl,
    room: "wiring",
    agent: "alice",
    autoreply: true,
    autoreplyMode: "mentions" as AutoReplyMode,
    history: 20,
    reconnectMs: 200,
    cooldownMs: 2000,
    prefix: env.prefix ?? "[chat alice] ",
    ...env,
  } as ChatEnv;

  const autoreply = { value: fullEnv.autoreply, mode: fullEnv.autoreplyMode };
  const nameDormant = { value: false };
  const nameDormantNotified = { value: false };
  const agentCount = { value: 0 };

  const sentMessages: SentMessage[] = [];
  const notifications: Array<{ text: string; level?: NotifyLevel }> = [];
  const tools: Record<string, (id: string, params: any) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>> = {};

  const fakePi = {
    on(_event: string, _handler: (...args: unknown[]) => unknown): void { /* noop */ },
    registerTool(def: { name: string; execute: (id: string, params: any) => Promise<unknown> }) {
      tools[def.name] = def.execute as never;
    },
    sendMessage(message: SentMessage): void {
      sentMessages.push(message);
    },
  };

  const replies = new ReplyTracker();
  const client = new ChatClient({
    server: fullEnv.server,
    room: fullEnv.room,
    agent: fullEnv.agent,
    reconnectMs: fullEnv.reconnectMs,
  });

  const echoLocal = (text: string) => {
    notifications.push({ text: `${fullEnv.prefix}${text}`, level: "info" });
  };

  const sendOutbound = async (_room: unknown, text: string, meta?: Record<string, unknown>): Promise<SendResult> => {
    if (nameDormant.value) throw Object.assign(new Error("name-dormant"), { code: "name_dormant" });
    const r = await client.send(text, meta);
    replies.remember(r.id);
    echoLocal(text);
    return r;
  };

  const statusBuilder = (): ChatStatus => ({
    state: client.status,
    env: {
      server: fullEnv.server, room: fullEnv.room, agent: fullEnv.agent, alias: "DEFAULT",
      autoreply: autoreply.value, autoreplyMode: autoreply.mode,
      history: fullEnv.history, reconnectMs: fullEnv.reconnectMs,
      cooldownMs: fullEnv.cooldownMs, prefix: fullEnv.prefix,
    },
    agentCount: agentCount.value,
    isNameDormant: nameDormant.value,
  });

  const deps: ChatRuntimeDeps = {
    listRooms: () => [],
    roomCount: () => 0,
    aliases: () => ["DEFAULT"],
    getStatus: statusBuilder,
    resolveRoom: () => statusBuilder(),
    requireRoom: () => statusBuilder(),
    fetchJsonForStatus: async <T>(_status, path: string): Promise<T> => {
      const url = `${fullEnv.server.replace(/\/+$/, "")}${path}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
      return (await res.json()) as T;
    },
    sendOutbound,
    reconnect: async () => { await client.close(); await client.start(); },
    setAutoreply: (_room, v: boolean, m?: AutoReplyMode) => {
      autoreply.value = v;
      if (m) autoreply.mode = m;
    },
    fetchJson: async <T>(_room, path: string): Promise<T> => {
      const url = `${fullEnv.server.replace(/\/+$/, "")}${path}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
      return (await res.json()) as T;
    },
    formatHistory: (items: unknown) => defaultFormatHistory(
      Array.isArray(items) ? (items as Parameters<typeof defaultFormatHistory>[0]) : [],
    ),
    notify: (text: string, level?: NotifyLevel) => {
      notifications.push({ text, level });
    },
    getFocusedAlias: () => "DEFAULT",
    setFocusedAlias: () => undefined,
  };

  registerChatTools(fakePi as unknown as Parameters<typeof registerChatTools>[0], deps);

  return { fakePi, sentMessages, notifications, tools, client, replies, fullEnv, deps };
}

beforeEach(() => {
  // Reset room state by using a fresh agent each test if needed.
});

describe("chat_send — full wiring (POST + local echo)", () => {
  it("POSTs to chat-server AND echoes locally via ctx.ui.notify", async () => {
    const { fakePi, sentMessages, notifications, tools, client, replies, fullEnv } = buildFakeRuntime();
    // Pretend we're connected — the public server still validates that POST /messages comes from an
    // agent with an active SSE. We open an SSE so the POST succeeds.
    await client.start();

    const result = await tools.chat_send("t1", { text: "hello @bob" });
    void fakePi; // silence unused

    // Send succeeded
    const details = result.details as { id: string; ts: number; mentions: string[] };
    assert.equal(typeof details.id, "string");
    assert.equal(typeof details.ts, "number");
    assert.deepEqual(details.mentions, ["@bob"]);
    assert.match(result.content[0].text, new RegExp(`Sent message ${details.id.slice(0, 8)}`));

    // Local echo via ctx.ui.notify (NOT pi.sendMessage — that would feed back into the agent loop).
    assert.equal(notifications.length, 1);
    const note = notifications[0];
    assert.equal(note.level, "info");
    assert.equal(note.text, `${fullEnv.prefix}hello @bob`);

    // No pi.sendMessage call — the echo must not pollute the agent's input stream.
    assert.equal(sentMessages.length, 0, "no pi.sendMessage echo — echo is notify-only");

    // Reply tracker remembered the sent id (so future inbound `meta.replyTo` can hit).
    assert.equal(replies.has(details.id), true);

    await client.close();
  });

  it("name-dormant suppresses the local echo and returns a clear error", async () => {
    // Stand up two agents: alice first (holds the SSE), bob as a stub forced into name-dormant
    // by sending a 409 to him.
    const alice = new ChatClient({ server: baseUrl, room: "dorm", agent: "alice", reconnectMs: 100 });
    await alice.start();

    // Build bob's runtime pointed at baseUrl with the SAME agent name → 409 name-dormant.
    // (The chat-client itself flips to `name-dormant` on 409 and we mirror that in the fake
    // handle by hard-coding the flag.)
    const fakePi = { registerTool() {}, sendMessage() {}, on() {} };
    const sentMessages: SentMessage[] = [];
    const notifications: Array<{ text: string; level?: NotifyLevel }> = [];
    const tools: Record<string, (id: string, params: any) => Promise<unknown>> = {};
    (fakePi as { registerTool: (d: unknown) => void }).registerTool = (def: any) => {
      tools[def.name] = def.execute;
    };
    (fakePi as { sendMessage: (m: SentMessage) => void }).sendMessage = (m: SentMessage) => {
      sentMessages.push(m);
    };

    const bobClient = new ChatClient({ server: baseUrl, room: "dorm", agent: "alice", reconnectMs: 100 });
    await bobClient.start(); // returns 'conflict'

    const nameDormant = { value: bobClient.status.state === "conflict" };
    const replies = new ReplyTracker();

    const sendOutbound = async () => {
      if (nameDormant.value) {
        const err = new Error("name-dormant (change PI_CHAT_AGENT and /reload)");
        (err as { code?: string }).code = "name_dormant";
        throw err;
      }
      throw new Error("unreachable");
    };

    registerChatTools(fakePi as unknown as Parameters<typeof registerChatTools>[0], {
      listRooms: () => [],
      roomCount: () => 0,
      aliases: () => ["DEFAULT"],
      requireRoom: () => ({
        state: bobClient.status,
        env: {
          server: baseUrl, room: "dorm", agent: "alice", alias: "DEFAULT",
          autoreply: true, autoreplyMode: "mentions",
          history: 20, reconnectMs: 100, cooldownMs: 2000, prefix: "[chat alice] ",
        },
        agentCount: 0,
        isNameDormant: nameDormant.value,
      }),
      getStatus: () => ({
        state: bobClient.status,
        env: {
          server: baseUrl, room: "dorm", agent: "alice", alias: "DEFAULT",
          autoreply: true, autoreplyMode: "mentions",
          history: 20, reconnectMs: 100, cooldownMs: 2000, prefix: "[chat alice] ",
        },
        agentCount: 0,
        isNameDormant: nameDormant.value,
      }),
      resolveRoom: () => undefined as never,
      fetchJson: async () => undefined as never,
      fetchJsonForStatus: async () => undefined as never,
      sendOutbound,
      formatHistory: () => "",
      setAutoreply: () => undefined,
      reconnect: async () => undefined,
      notify: (text: string, level?: NotifyLevel) => {
        notifications.push({ text, level });
      },
      getFocusedAlias: () => "DEFAULT",
      setFocusedAlias: () => undefined,
    });

    await assert.rejects(
      () => tools.chat_send("t1", { text: "hello" }),
      (e: Error & { code?: string }) => e.code === "name_dormant",
    );
    assert.equal(sentMessages.length, 0, "no pi.sendMessage on name-dormant");
    assert.equal(notifications.length, 0, "no local echo on name-dormant");

    void replies; // silence unused
    await alice.close();
    await bobClient.close();
  });

  it("inbound pipeline: handleInbound drops the agent's own messages (self-echo)", async () => {
    // Pure logic test of the inbound filter pipeline used by index.ts.
    const dedupe = new IdDedupe(60_000, 100);
    const cooldown = new CooldownGate(2000);
    const agent = "alice";
    const env: ChatEnv = {
      server: baseUrl, room: "r", agent, autoreply: true, autoreplyMode: "mentions",
      history: 20, reconnectMs: 200, cooldownMs: 2000, prefix: "[chat alice] ",
    };

    const messages = [
      { id: "m1", from: agent, text: "self-echo", ts: 1, mentions: [] },
      { id: "m2", from: "bob", text: "hi alice", ts: 2, mentions: [] },
      { id: "m3", from: "bob", text: "dup", ts: 3, mentions: [] },
    ];

    const accepted = [];
    for (const m of messages) {
      if (isFromSelf({ ...m }, env.agent)) continue;
      if (!dedupe.accept(m.id)) continue;
      if (cooldown.isOnCooldown(m.from, m.ts)) continue;
      cooldown.record(m.from, m.ts);
      accepted.push(m);
    }

    assert.deepEqual(accepted.map((m) => m.id), ["m2"]);
  });
});
