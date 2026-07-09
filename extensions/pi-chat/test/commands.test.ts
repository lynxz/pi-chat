// Layer 1 — slash-command wiring.
//
// `registerChatCommands` depends on `ExtensionAPI` + `ExtensionContext` which
// we mock here so the test can exercise each command's URL construction and
// notification shape without spinning up a TUI.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { registerChatCommands, defaultFormatHistory } from "../commands.ts";
import type { ChatRuntimeDeps } from "../runtime-deps.ts";
import type { ClientStatus } from "../client.ts";

// A minimal mock of the Pi surface we touch. We assert on the calls.
interface MockUI {
  notifications: Array<{ text: string; level: "info" | "warning" | "error" }>;
  notify(text: string, level?: "info" | "warning" | "error"): void;
}
interface MockPi {
  commands: Record<string, (args: string, ctx: { ui: MockUI }) => Promise<void> | void>;
  registerCommand(name: string, opts: { handler: (args: string, ctx: { ui: MockUI }) => Promise<void> | void }): void;
}

function makePi(): MockPi {
  const commands: MockPi["commands"] = {};
  return {
    commands,
    registerCommand(name, opts) { commands[name] = opts.handler as never; },
  };
}

function makeCtx(): { ui: MockUI } {
  const notifications: MockUI["notifications"] = [];
  return {
    ui: {
      notifications,
      notify(text, level = "info") { notifications.push({ text, level }); },
    },
  };
}

function makeDeps(overrides: Partial<ChatRuntimeDeps> = {}): ChatRuntimeDeps {
  const baseStatus = {
    state: { state: "connected" as ClientStatus["state"], attempts: 0, info: undefined } as ClientStatus,
    env: {
      server: "http://chat", room: "team", agent: "alice", alias: "DEFAULT",
      autoreply: true, autoreplyMode: "mentions",
      history: 20, reconnectMs: 2000, cooldownMs: 2000, prefix: "[chat alice] ",
    },
    agentCount: 2,
    isNameDormant: false,
  };
  const fetchJsonForStatus = overrides.fetchJsonForStatus ?? (async () => [] as never);
  const resolveRoom = overrides.resolveRoom ?? (() => baseStatus);
  const fetchJson = overrides.fetchJson ?? (async () => [] as never);
  const sendOutbound = overrides.sendOutbound ?? (async (_room, _text) => ({ id: "fixed-id", ts: 1, mentions: [] }));
  const setAutoreply = overrides.setAutoreply ?? (() => undefined);
  return {
    listRooms: () => [],
    roomCount: () => 0,
    getStatus: () => baseStatus,
    resolveRoom,
    fetchJson,
    fetchJsonForStatus,
    formatHistory: (items: unknown) => defaultFormatHistory(
      Array.isArray(items) ? (items as Parameters<typeof defaultFormatHistory>[0]) : [],
    ),
    sendOutbound,
    reconnect: async () => undefined,
    setAutoreply,
    notify: (_text, _level) => undefined,
    getFocusedAlias: () => "DEFAULT",
    setFocusedAlias: () => undefined,
    ...overrides,
  };
}

describe("registerChatCommands", () => {
  let pi: MockPi;
  let ctx: ReturnType<typeof makeCtx>;
  let deps: ChatRuntimeDeps;
  beforeEach(() => {
    pi = makePi();
    ctx = makeCtx();
    deps = makeDeps();
    registerChatCommands(pi as unknown as Parameters<typeof registerChatCommands>[0], deps);
  });

  it("registers the expected command names", () => {
    for (const name of [
      "chat-status",
      "chat-send",
      "chat-reconnect",
      "chat-mute",
      "chat-unmute",
      "chat-agents",
      "chat-history",
    ]) {
      assert.ok(pi.commands[name], `missing command ${name}`);
    }
  });

  it("/chat-status prints a multi-line summary", async () => {
    await pi.commands["chat-status"]("", ctx);
    const note = ctx.ui.notifications.at(-1)!;
    assert.match(note.text, /server:\s+http:\/\/chat/);
    assert.match(note.text, /room:\s+team/);
    assert.match(note.text, /agent:\s+alice/);
    assert.match(note.text, /state:\s+connected/);
  });

  it("/chat-send warns on empty args", async () => {
    await pi.commands["chat-send"]("", ctx);
    const note = ctx.ui.notifications.at(-1)!;
    assert.match(note.text, /Usage/i);
    assert.equal(note.level, "warning");
  });

  it("/chat-send calls deps.send and reports the message id", async () => {
    let sent = "";
    deps = makeDeps({ sendOutbound: async (_room, t) => { sent = t; return { id: "abcdef12-3456", ts: 1, mentions: [] }; } });
    registerChatCommands(pi as unknown as Parameters<typeof registerChatCommands>[0], deps);
    await pi.commands["chat-send"]("hello", ctx);
    assert.equal(sent, "hello");
    const note = ctx.ui.notifications.at(-1)!;
    assert.match(note.text, /Sent abcdef12/);
  });

  it("/chat-send surfaces server errors as a warning", async () => {
    deps = makeDeps({ sendOutbound: async () => { throw new Error("name-dormant"); } });
    registerChatCommands(pi as unknown as Parameters<typeof registerChatCommands>[0], deps);
    await pi.commands["chat-send"]("hi", ctx);
    const note = ctx.ui.notifications.at(-1)!;
    assert.match(note.text, /chat-send failed/);
    assert.match(note.text, /name-dormant/);
    assert.equal(note.level, "warning");
  });

  it("/chat-send warns on bare-word alias (use [room] instead)", async () => {
    // Make `listRooms` return two joined rooms so the footgun guard kicks in.
    deps = makeDeps({
      listRooms: () => [
        { alias: "BACKEND", room: "backend", agent: "alice", server: "http://chat", state: { state: "connected" } as never, agentCount: 0, isNameDormant: false, autoreply: true, autoreplyMode: "mentions" as const, isPrimary: true },
        { alias: "INCIDENTS", room: "incidents", agent: "alice", server: "http://chat", state: { state: "connected" } as never, agentCount: 0, isNameDormant: false, autoreply: true, autoreplyMode: "all" as const, isPrimary: false },
      ],
      sendOutbound: async () => ({ id: "x", ts: 1, mentions: [] }),
    });
    registerChatCommands(pi as unknown as Parameters<typeof registerChatCommands>[0], deps);
    await pi.commands["chat-send"]("backend hello", ctx);
    const note = ctx.ui.notifications.at(-1)!;
    assert.match(note.text, /bare alias "backend"/);
    assert.match(note.text, /\[backend\]/);
    assert.equal(note.level, "warning");
  });

  it("/chat-send accepts the [room] bracket form", async () => {
    let sent = "";
    deps = makeDeps({
      getStatus: () => ({
        state: { state: "connected", attempts: 0, info: undefined },
        env: {
          server: "http://chat", room: "backend", agent: "alice", alias: "BACKEND",
          autoreply: true, autoreplyMode: "mentions",
          history: 20, reconnectMs: 2000, cooldownMs: 2000, prefix: "[chat alice] ",
        },
        agentCount: 0,
        isNameDormant: false,
      }),
      sendOutbound: async (_room, t) => { sent = t; return { id: "abcdef12-3456", ts: 1, mentions: [] }; },
    });
    registerChatCommands(pi as unknown as Parameters<typeof registerChatCommands>[0], deps);
    await pi.commands["chat-send"]("[backend] hello", ctx);
    assert.equal(sent, "hello");
    const note = ctx.ui.notifications.at(-1)!;
    assert.match(note.text, /Sent abcdef12/);
  });

  it("/chat-mute toggles autoreply off", async () => {
    let flag: boolean | undefined;
    deps = makeDeps({ setAutoreply: (_room, v) => { flag = v; } });
    registerChatCommands(pi as unknown as Parameters<typeof registerChatCommands>[0], deps);
    await pi.commands["chat-mute"]("", ctx);
    assert.equal(flag, false);
  });

  it("/chat-agents fetches /rooms/:room/agents", async () => {
    const calls: string[] = [];
    deps = makeDeps({
      fetchJsonForStatus: async (_status, path) => {
        calls.push(path);
        return [
          { name: "bob", connectedAt: 1, lastSeen: 2 },
          { name: "alice", connectedAt: 3, lastSeen: 4 },
        ] as never;
      },
    });
    registerChatCommands(pi as unknown as Parameters<typeof registerChatCommands>[0], deps);
    await pi.commands["chat-agents"]("", ctx);
    assert.deepEqual(calls, ["/rooms/team/agents"]);
    const note = ctx.ui.notifications.at(-1)!;
    // Sorted by name — alice first
    assert.match(note.text, /alice/);
    assert.match(note.text, /bob/);
  });

  it("/chat-history defaults to limit=20 and shows the formatted text", async () => {
    const calls: string[] = [];
    deps = makeDeps({
      fetchJsonForStatus: async (_status, path) => {
        calls.push(path);
        return [
          { id: "m1", from: "bob", text: "hi", ts: Date.UTC(2025, 0, 1) },
          { id: "m2", from: "alice", text: "hey", ts: Date.UTC(2025, 0, 2) },
        ] as never;
      },
    });
    registerChatCommands(pi as unknown as Parameters<typeof registerChatCommands>[0], deps);
    await pi.commands["chat-history"]("", ctx);
    assert.deepEqual(calls, ["/rooms/team/history?limit=20"]);
    const note = ctx.ui.notifications.at(-1)!;
    assert.match(note.text, /bob/);
    assert.match(note.text, /alice/);
  });

  it("/chat-history accepts an integer override", async () => {
    const calls: string[] = [];
    deps = makeDeps({ fetchJsonForStatus: async (_status, path) => { calls.push(path); return [] as never; } });
    registerChatCommands(pi as unknown as Parameters<typeof registerChatCommands>[0], deps);
    await pi.commands["chat-history"]("5", ctx);
    assert.deepEqual(calls, ["/rooms/team/history?limit=5"]);
  });

  it("/chat-history clamps values above MAX_HISTORY_LIMIT and surfaces the clamp", async () => {
    const calls: string[] = [];
    deps = makeDeps({ fetchJsonForStatus: async (_status, path) => { calls.push(path); return [] as never; } });
    registerChatCommands(pi as unknown as Parameters<typeof registerChatCommands>[0], deps);

    await pi.commands["chat-history"]("9999", ctx);
    assert.deepEqual(calls, ["/rooms/team/history?limit=500"]);
    const note = ctx.ui.notifications.at(-1)!;
    // The notification body should mention the clamp so the user knows.
    assert.match(note.text, /clamped to 500/);
  });

  it("/chat-history flags bad input with a usage notification (no fetch)", async () => {
    let called = false;
    deps = makeDeps({ fetchJsonForStatus: async () => { called = true; return [] as never; } });
    registerChatCommands(pi as unknown as Parameters<typeof registerChatCommands>[0], deps);

    // `""` is the default path (use fallback), not a bad input. The rest are bad.
    for (const bad of ["abc", "-3", "0"]) {
      await pi.commands["chat-history"](bad, ctx);
    }
    assert.equal(called, false, "/chat-history must NOT fetch on bad input");
    const last = ctx.ui.notifications.at(-1)!;
    assert.equal(last.level, "warning");
    assert.match(last.text, /Usage/);
  });

  it("/chat-history empty list renders the friendly placeholder via deps.formatHistory", async () => {
    deps = makeDeps({ fetchJsonForStatus: async () => [] as never });
    registerChatCommands(pi as unknown as Parameters<typeof registerChatCommands>[0], deps);
    await pi.commands["chat-history"]("", ctx);
    const note = ctx.ui.notifications.at(-1)!;
    assert.match(note.text, /no messages in history/);
  });
});

describe("defaultFormatHistory", () => {
  it("returns a friendly placeholder on an empty array", () => {
    assert.equal(defaultFormatHistory([]), "(no messages in history)");
  });
  it("formats each row with timestamp, sender, and text", () => {
    const out = defaultFormatHistory([
      { id: "m1", from: "bob", text: "hi", ts: Date.UTC(2025, 0, 1) },
    ]);
    assert.match(out, /\d{4}-\d{2}-\d{2}/);
    assert.match(out, /bob/);
    assert.match(out, /hi/);
  });
});
