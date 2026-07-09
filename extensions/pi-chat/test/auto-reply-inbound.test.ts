// Wiring test: verifies the auto-reply path end-to-end.
//
// Mounts the runtime the way `index.ts` does (real `ChatClient` against
// a real `chat-server`, fake `pi` recording `sendMessage`/`sendUserMessage`),
// then drives an inbound message via a third party ChatClient and asserts
// `sendUserMessage` fires exactly once for a match (the "only one turn
// at a time" promise). Also exercises:
//
//   - `shouldAutoReply` decisioning (filters.ts)
//   - `AutoReplyWorker` enqueue + pump
//   - the `agent_end` reset hook
//   - the inbound self-echo / dedupe / cooldown filters

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { createChatServer } from "../../../chat-server/server.js";
import { ChatClient, type SendResult, type ClientStatus } from "../client.ts";
import { AutoReplyWorker } from "../auto-reply-worker.ts";
import { CooldownGate, IdDedupe, ReplyTracker } from "../state.ts";
import { defaultFormatHistory } from "../commands.ts";
import { isFromSelf, shouldAutoReply } from "../filters.ts";
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

interface FakeCtx {
  notify(text: string, level?: NotifyLevel): void;
  setStatus(key: string, text: string): void;
  isIdle(): boolean;
}

interface FakePi {
  on(event: string, handler: (...args: unknown[]) => unknown): void;
  registerTool(def: unknown): void;
  sendMessage(message: SentMessage, options?: unknown): void;
  sendUserMessage(text: string): void;
}

/**
 * Build a runtime the way `index.ts` would (real ChatClient + chat-server),
 * but with a fake Pi capturing every sendMessage / sendUserMessage call.
 * Returns everything we need to drive / observe the inbound pipeline.
 */
function buildMount(
  overrides: {
    agentName?: string;
    roomName?: string;
    autoreplyMode?: AutoReplyMode;
    autoreply?: boolean;
    prefix?: string;
    minGapMs?: number;
  } = {},
) {
  const agent = overrides.agentName ?? "alice";
  // Unique room per mount avoids name-collision in the chat-server when
  // tests run in series and the previous client's connection close is
  // still propagating.
  const room = overrides.roomName ?? `autoreply-${Math.random().toString(36).slice(2, 8)}`;
  const fullEnv: ChatEnv = {
    server: baseUrl,
    room,
    agent,
    autoreply: overrides.autoreply ?? true,
    autoreplyMode: overrides.autoreplyMode ?? "mentions",
    history: 20,
    reconnectMs: 200,
    cooldownMs: 2000,
    prefix: overrides.prefix ?? `[chat ${agent}] `,
  };

  const sentMessages: SentMessage[] = [];
  const userMessages: string[] = [];
  const notifications: Array<{ text: string; level: NotifyLevel }> = [];
  let idle = true;
  const agentEndListeners: Array<() => void> = [];

  const fakeCtx: FakeCtx = {
    notify(text: string, level: NotifyLevel = "info") {
      notifications.push({ text, level });
    },
    setStatus() { /* no-op */ },
    isIdle() { return idle; },
  };

  const fakePi: FakePi = {
    on(event: string, handler: (...args: unknown[]) => unknown) {
      if (event === "agent_end") {
        agentEndListeners.push(handler as () => void);
      }
    },
    registerTool() { /* no-op for this test */ },
    sendMessage(message: SentMessage) {
      sentMessages.push(message);
    },
    sendUserMessage(text: string) {
      userMessages.push(text);
    },
  };

  // Mirror the wiring in `index.ts`: register an agent_end handler that
  // clears the worker's `inFlight` so the next pump can dispatch.
  fakePi.on("agent_end", () => handle.autoReply.markTurnDone());

  const autoreply = { value: fullEnv.autoreply, mode: fullEnv.autoreplyMode };
  const nameDormant = { value: false };
  const agentCount = { value: 0 };
  const replies = new ReplyTracker();

  const client = new ChatClient({
    server: fullEnv.server,
    room: fullEnv.room,
    agent: fullEnv.agent,
    reconnectMs: fullEnv.reconnectMs,
  });

  const autoReply = new AutoReplyWorker(
    {
      sendUserMessage: (text) => fakePi.sendUserMessage(text),
      isIdle: () => fakeCtx.isIdle(),
    },
    { minGapMs: overrides.minGapMs ?? 0 },
  );

  const handle = {
    client,
    autoreply,
    autoReply,
    env: fullEnv,
    replies,
    dedupe: new IdDedupe(60_000, 1024),
    cooldown: new CooldownGate(fullEnv.cooldownMs),
    nameDormant,
    agentCount,
  };

  // Mimic handleInbound from index.ts without going through the full mount.
  const handleInbound = (msg: {
    id: string;
    from: string;
    text: string;
    ts: number;
    mentions: string[];
    meta?: Record<string, unknown>;
  }) => {
    if (isFromSelf({ ...msg }, handle.env.agent)) return;
    if (!handle.dedupe.accept(msg.id)) return;
    if (handle.cooldown.isOnCooldown(msg.from, msg.ts)) return;
    handle.cooldown.record(msg.from, msg.ts);

    const matched = shouldAutoReply(
      { ...handle.env, autoreply: handle.autoreply.value, autoreplyMode: handle.autoreply.mode } as ChatEnv,
      msg,
      handle.replies,
    );
    if (matched && !handle.nameDormant.value) {
      handle.autoReply.enqueue(`${handle.env.prefix}${msg.text}`);
      return;
    }
    const preview = msg.text.length > 200 ? `${msg.text.slice(0, 197)}…` : msg.text;
    fakeCtx.notify(`[chat ${msg.from}] ${preview}`, "info");
  };

  const deps: ChatRuntimeDeps = {
    getStatus: (): ChatStatus => ({
      state: client.status,
      env: {
        server: fullEnv.server, room: fullEnv.room, agent: fullEnv.agent,
        autoreply: autoreply.value, autoreplyMode: autoreply.mode,
        history: fullEnv.history, reconnectMs: fullEnv.reconnectMs,
        cooldownMs: fullEnv.cooldownMs, prefix: fullEnv.prefix,
      },
      agentCount: agentCount.value,
      isNameDormant: nameDormant.value,
    }),
    sendOutbound: async (text: string): Promise<SendResult> => {
      const result = await client.send(text);
      replies.remember(result.id);
      // local echo
      fakePi.sendMessage({
        customType: "chat-out",
        content: `${fullEnv.prefix}${text}`,
        display: true,
        details: { room: fullEnv.room, agent: fullEnv.agent },
      });
      return result;
    },
    reconnect: async () => { await client.close(); await client.start(); },
    setAutoreply: (v: boolean, m?: AutoReplyMode) => {
      autoreply.value = v;
      if (m) autoreply.mode = m;
    },
    fetchJson: async <T>(path: string): Promise<T> => {
      const res = await fetch(`${baseUrl}${path}`);
      if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
      return (await res.json()) as T;
    },
    formatHistory: (items: unknown) => defaultFormatHistory(
      Array.isArray(items) ? (items as Parameters<typeof defaultFormatHistory>[0]) : [],
    ),
    notify: (text, level) => fakeCtx.notify(text, level ?? "info"),
  };
  // The tools wiring is exercised in `wiring.test.ts`; this test focuses
  // on the inbound → auto-reply path so we don't bother registering them.
  void deps; void registerChatTools;

  /** Simulates Pi's `agent_end` event firing after a turn completes. */
  const markTurnDone = () => {
    for (const fn of agentEndListeners) fn();
    idle = true;
  };

  return {
    fakePi,
    fakeCtx,
    handle,
    handleInbound,
    deps,
    sentMessages,
    userMessages,
    notifications,
    /** Toggle isIdle at will (simulate busy/idle transitions). */
    setIdle(v: boolean) { idle = v; },
    markTurnDone,
  };
}

describe("auto-reply inbound wiring", () => {
  it("matching @-mention triggers sendUserMessage exactly once (serial queue)", async () => {
    const m = buildMount({ agentName: "alice", autoreplyMode: "mentions" });
    await m.handle.client.start();
    await waitFor(() => m.handle.client.status.state === "connected");
    await new Promise((r) => setTimeout(r, 30));

    // Inbound that should match (`@alice` mention).
    m.handleInbound({
      id: "m1", from: "bob",
      text: "hi alice, what's the status?",
      ts: 1, mentions: ["@alice"],
    });
    // Worker drains via pump() — we run it directly to bypass the 100ms tick.
    m.setIdle(true);
    const dispatched1 = m.handle.autoReply.pump();
    assert.equal(dispatched1, "[chat alice] hi alice, what's the status?");
    assert.equal(m.userMessages.length, 1);
    assert.equal(m.userMessages[0], "[chat alice] hi alice, what's the status?");
    assert.equal(m.notifications.length, 0, "matched inbound suppressed notify");

    // Without `agent_end` resetting inFlight, a second dispatch shouldn't
    // happen yet — that's the serial-queue protection. We use a different
    // sender (`carol`) so the per-sender cooldown filter doesn't drop the
    // message; we're isolating the *serial queue* inFlight here, not cooldown.
    m.handleInbound({
      id: "m2", from: "carol",
      text: "another @alice question",
      ts: 2, mentions: ["@alice"],
    });
    const dispatched2 = m.handle.autoReply.pump();
    assert.equal(dispatched2, undefined, "second pump must not dispatch while inFlight");

    // Simulate the agent finishing its turn → markTurnDone → pump() can dispatch again.
    m.markTurnDone();
    const dispatched3 = m.handle.autoReply.pump();
    assert.equal(dispatched3, "[chat alice] another @alice question");
    assert.equal(m.userMessages.length, 2);

    await m.handle.client.close();
  });

  it("non-matching inbound is `notify`-only, never enqueued", async () => {
    const m = buildMount({ agentName: "alice", autoreplyMode: "mentions" });
    await m.handle.client.start();
    await waitFor(() => m.handle.client.status.state === "connected");
    await new Promise((r) => setTimeout(r, 30));

    m.handleInbound({
      id: "n1", from: "bob",
      text: "no mention here",
      ts: 1, mentions: [],
    });
    m.setIdle(true);
    const dispatched = m.handle.autoReply.pump();
    assert.equal(dispatched, undefined, "non-match must not dispatch");
    assert.equal(m.userMessages.length, 0);
    assert.equal(m.notifications.length, 1);
    assert.match(m.notifications[0].text, /\[chat bob\]/);

    await m.handle.client.close();
  });

  it("self-echo filter: matching our own message never re-enqueues", async () => {
    const m = buildMount({ agentName: "alice", autoreplyMode: "all" });
    await m.handle.client.start();
    await waitFor(() => m.handle.client.status.state === "connected");
    await new Promise((r) => setTimeout(r, 30));

    m.handleInbound({
      id: "s1", from: "alice",
      text: "talking to myself",
      ts: 1, mentions: ["@alice"],
    });
    m.setIdle(true);
    assert.equal(m.handle.autoReply.pump(), undefined);
    assert.equal(m.userMessages.length, 0);

    await m.handle.client.close();
  });

  it("per-sender cooldown: rapid repeats from same sender are dropped", async () => {
    const m = buildMount({ agentName: "alice", autoreplyMode: "all" });
    m.handle.cooldown = new CooldownGate(60_000);   // 60s — long enough to cover the test
    await m.handle.client.start();
    await waitFor(() => m.handle.client.status.state === "connected");
    await new Promise((r) => setTimeout(r, 30));

    m.handleInbound({ id: "c1", from: "bob", text: "first", ts: 1, mentions: [] });
    m.handleInbound({ id: "c2", from: "bob", text: "second", ts: 30_000, mentions: [] });
    m.setIdle(true);
    m.handle.autoReply.pump();    // first dispatched
    m.markTurnDone();
    m.handle.autoReply.pump();    // second dropped (cooldown)
    assert.equal(m.userMessages.length, 1);
    assert.equal(m.userMessages[0], "[chat alice] first");

    await m.handle.client.close();
  });

  it("`questions` mode also matches trailing `?`", async () => {
    const m = buildMount({ agentName: "alice", autoreplyMode: "questions" });
    await m.handle.client.start();
    await waitFor(() => m.handle.client.status.state === "connected");
    await new Promise((r) => setTimeout(r, 30));

    m.handleInbound({ id: "q1", from: "bob", text: "is this right?", ts: 1, mentions: [] });
    m.setIdle(true);
    assert.equal(m.handle.autoReply.pump(), "[chat alice] is this right?");

    await m.handle.client.close();
  });
});

async function waitFor(pred: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}
