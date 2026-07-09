// Layer 1 — tool registration and execution.
//
// We mock the ExtensionAPI surface (`pi.registerTool`, `pi.sendMessage`),
// stub the `ChatRuntimeDeps` callbacks, and verify that each tool:
//   1. gets registered with the expected name, schema, prompt snippet,
//      and prompt guidelines;
//   2. executes the right runtime dep (`sendOutbound`, `fetchJson`,
//      `getStatus`, `setAutoreply`);
//   3. returns the expected content + details to the LLM.
//
// Errors thrown by `execute` mark the tool as failed in Pi.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { registerChatTools } from "../tools.ts";
import type { ChatRuntimeDeps } from "../runtime-deps.ts";

interface MockUI {
  setStatus: (key: string, text: string) => void;
  notify: (text: string, level?: string) => void;
}
interface MockPi {
  /** All tools passed to `pi.registerTool` collected by name. */
  tools: Record<string, {
    name: string;
    label?: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: unknown;
    execute: (toolCallId: string, params: any) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
  }>;
  /** All `pi.sendMessage` calls. */
  sentMessages: Array<{ message: { customType: string; content: string; display?: boolean }; options?: unknown }>;
  registerTool(def: any): void;
  sendMessage(message: any, options?: unknown): void;
}

function makePi(): MockPi {
  const pi: MockPi = {
    tools: {},
    sentMessages: [],
    registerTool(def) {
      pi.tools[def.name] = def;
    },
    sendMessage(message, options) {
      pi.sentMessages.push({ message, options });
    },
  };
  return pi;
}

function makeDeps(overrides: Partial<ChatRuntimeDeps> = {}): ChatRuntimeDeps {
  const baseStatus = (overrides.getStatus?.() ?? {
    state: { state: "connected", attempts: 0, info: undefined },
    env: {
      server: "http://chat",
      room: "team",
      agent: "alice",
      alias: "DEFAULT",
      autoreply: true,
      autoreplyMode: "mentions",
      history: 20,
      reconnectMs: 2000,
      cooldownMs: 2000,
      prefix: "[chat alice] ",
    },
    agentCount: 2,
    isNameDormant: false,
  });
  const base: ChatRuntimeDeps = {
    listRooms: () => [],
    roomCount: () => 0,
    aliases: () => ["DEFAULT"],
    getStatus: overrides.getStatus ?? (() => baseStatus),
    resolveRoom: overrides.resolveRoom,
    requireRoom: overrides.requireRoom ?? (overrides.getStatus ?? (() => baseStatus)),
    fetchJson: overrides.fetchJson ?? (async () => [] as never),
    fetchJsonForStatus: overrides.fetchJsonForStatus ?? (async () => [] as never),
    formatHistory: () => "(formatted)",
    sendOutbound: async (_room, _text, _meta) => ({
      id: "fake-msg-id",
      ts: 1,
      mentions: [],
    }),
    setAutoreply: overrides.setAutoreply ?? (() => undefined),
    reconnect: async () => undefined,
    notify: () => undefined,
    getFocusedAlias: () => "DEFAULT",
    setFocusedAlias: () => undefined,
    ...overrides,
  };
  return base;
}

let pi: MockPi;
let deps: ChatRuntimeDeps;

beforeEach(() => {
  pi = makePi();
  deps = makeDeps();
  registerChatTools(pi as unknown as Parameters<typeof registerChatTools>[0], deps);
});

describe("chat_send", () => {
  it("is registered with the expected schema, prompt snippet, and guidelines", () => {
    const t = pi.tools["chat_send"];
    assert.ok(t);
    assert.ok(t.description.length > 0);
    assert.match(t.description, /End the message with `\?`/);
    assert.match(t.promptSnippet ?? "", /Send a chat message/);
    const guidelines = t.promptGuidelines ?? [];
    assert.ok(guidelines.length >= 2);
    // Each guideline must name the tool (per docs warning).
    for (const g of guidelines) assert.match(g, /chat_send|chat_whoami|room=/);
  });

  it("execute: posts via deps.sendOutbound and returns id/text/details", async () => {
    let receivedText = "";
    let receivedMeta: unknown = null;
    deps = makeDeps({
      sendOutbound: async (_room, text, meta) => {
        receivedText = text;
        receivedMeta = meta;
        return { id: "abcdef12-3456-7890", ts: 1234567890, mentions: ["@bob"] };
      },
    });
    registerChatTools(pi as unknown as Parameters<typeof registerChatTools>[0], deps);

    const result = await pi.tools["chat_send"].execute(
      "t1",
      { text: "hello @bob", meta: { replyTo: "x1", branch: "main" } },
    );
    assert.equal(receivedText, "hello @bob");
    assert.deepEqual(receivedMeta, { replyTo: "x1", branch: "main" });
    assert.equal(result.details.id, "abcdef12-3456-7890");
    assert.equal(result.details.ts, 1234567890);
    assert.deepEqual(result.details.mentions, ["@bob"]);
    assert.match(result.content[0].text, /Sent message abcdef12/);
  });

  it("execute: name-dormant error surfaces as a tool failure (throw)", async () => {
    deps = makeDeps({
      sendOutbound: async () => {
        const err = new Error("name-dormant (change PI_CHAT_AGENT and /reload)");
        (err as { code?: string }).code = "name_dormant";
        throw err;
      },
    });
    registerChatTools(pi as unknown as Parameters<typeof registerChatTools>[0], deps);

    await assert.rejects(
      () => pi.tools["chat_send"].execute("t1", { text: "hi" }),
      (e: Error & { code?: string }) => e.code === "name_dormant",
    );
  });

  it("execute: surfaces send errors as tool failures (throw)", async () => {
    deps = makeDeps({ sendOutbound: async () => { throw new Error("rate_limit"); } });
    registerChatTools(pi as unknown as Parameters<typeof registerChatTools>[0], deps);

    await assert.rejects(
      () => pi.tools["chat_send"].execute("t1", { text: "hi" }),
      (e: Error) => e.message === "rate_limit",
    );
  });

  // Post-send nudge. When the model is in a thread
  // reply (meta.replyTo set) but the text contains no `@mention` token,
  // the tool result includes a one-line tip reminding the model to write
  // @-mentions explicitly next time.
  describe("post-send nudge", () => {
    it("appends a tip when meta.replyTo is set but text has no @mention", async () => {
      deps = makeDeps({
        sendOutbound: async () => ({ id: "abcdef12", ts: 1, mentions: [] }),
      });
      registerChatTools(pi as unknown as Parameters<typeof registerChatTools>[0], deps);

      const result = await pi.tools["chat_send"].execute(
        "t1",
        { text: "thanks!", meta: { replyTo: "x1" } },
      );
      assert.match(result.content[0].text, /Sent message abcdef12/);
      assert.match(
        result.content[0].text,
        /Tip: humans read the room transcript .* include `@<name>`/,
      );
    });

    it("does NOT append a tip when text already contains an @mention", async () => {
      deps = makeDeps({
        sendOutbound: async () => ({ id: "abcdef12", ts: 1, mentions: ["@bob"] }),
      });
      registerChatTools(pi as unknown as Parameters<typeof registerChatTools>[0], deps);

      const result = await pi.tools["chat_send"].execute(
        "t1",
        { text: "thanks @bob", meta: { replyTo: "x1" } },
      );
      assert.doesNotMatch(result.content[0].text, /Tip:/);
    });

    it("does NOT append a tip when meta.replyTo is absent (broadcast / status)", async () => {
      deps = makeDeps({
        sendOutbound: async () => ({ id: "abcdef12", ts: 1, mentions: [] }),
      });
      registerChatTools(pi as unknown as Parameters<typeof registerChatTools>[0], deps);

      const result = await pi.tools["chat_send"].execute(
        "t1",
        { text: "good morning everyone" },
      );
      assert.doesNotMatch(result.content[0].text, /Tip:/);
    });

    it("rejects email-shaped addresses — does NOT count them as @mentions", async () => {
      // Per the mention regex: lookbehind rejects identifiers/emails.
      deps = makeDeps({
        sendOutbound: async () => ({ id: "abcdef12", ts: 1, mentions: [] }),
      });
      registerChatTools(pi as unknown as Parameters<typeof registerChatTools>[0], deps);

      const result = await pi.tools["chat_send"].execute(
        "t1",
        { text: "send to foo@bar.com please", meta: { replyTo: "x1" } },
      );
      // The text has no actual mention, so a thread reply should still get the tip.
      assert.match(result.content[0].text, /Tip:/);
    });
  });
});

describe("chat_list_agents", () => {
  it("fetches /rooms/:room/agents with the current room name", async () => {
    const paths: string[] = [];
    deps = makeDeps({
      fetchJsonForStatus: async (_status, path) => {
        paths.push(path);
        return [
          { name: "bob", connectedAt: 1, lastSeen: 2 },
          { name: "alice", connectedAt: 3, lastSeen: 4 },
        ] as never;
      },
    });
    registerChatTools(pi as unknown as Parameters<typeof registerChatTools>[0], deps);

    const result = await pi.tools["chat_list_agents"].execute("t1", {});
    assert.deepEqual(paths, ["/rooms/team/agents"]);
    // Sorted by name — alice first.
    assert.match(result.content[0].text, /alice/);
    assert.match(result.content[0].text, /bob/);
    // alice appears before bob in the formatted text.
    assert.ok(
      result.content[0].text.indexOf("alice") < result.content[0].text.indexOf("bob"),
    );
  });

  it("execute: empty list shows '(no agents connected in #team)'", async () => {
    deps = makeDeps({ fetchJsonForStatus: async () => [] as never });
    registerChatTools(pi as unknown as Parameters<typeof registerChatTools>[0], deps);

    const result = await pi.tools["chat_list_agents"].execute("t1", {});
    assert.equal(result.content[0].text, "(no agents connected in #team)");
    const details = result.details as { agents: unknown[]; room: string };
    assert.deepEqual(details.agents, []);
    assert.equal(details.room, "team");
  });
});

describe("chat_history", () => {
  it("uses PI_CHAT_HISTORY as the default limit when none is provided", async () => {
    const paths: string[] = [];
    deps = makeDeps({
      fetchJsonForStatus: async (_status, path) => {
        paths.push(path);
        return [] as never;
      },
    });
    registerChatTools(pi as unknown as Parameters<typeof registerChatTools>[0], deps);

    const result = await pi.tools["chat_history"].execute("t1", {});
    assert.deepEqual(paths, ["/rooms/team/history?limit=20"]);
    assert.equal(result.details.limit, 20);
  });

  it("respects an explicit `limit` argument", async () => {
    const paths: string[] = [];
    deps = makeDeps({
      fetchJsonForStatus: async (_status, path) => { paths.push(path); return [] as never; },
    });
    registerChatTools(pi as unknown as Parameters<typeof registerChatTools>[0], deps);

    await pi.tools["chat_history"].execute("t1", { limit: 5 });
    assert.deepEqual(paths, ["/rooms/team/history?limit=5"]);
  });
});

describe("chat_whoami", () => {
  it("returns a multi-line identity summary + structured details", async () => {
    const result = await pi.tools["chat_whoami"].execute("t1", {});
    const text = result.content[0].text;
    for (const line of ["server:", "room:", "agent:", "state:", "autoreply:", "agents in room:"]) {
      assert.ok(text.includes(line), `expected "${line}" in ${text}`);
    }
    const details = result.details as { env: { room: string }; state: string; agentCount: number; isNameDormant: boolean };
    assert.equal(details.env.room, "team");
    assert.equal(details.state, "connected");
    assert.equal(details.agentCount, 2);
    assert.equal(details.isNameDormant, false);
  });
});

describe("chat_set_autoreply", () => {
  it("enabled=true mutates the runtime flag; mode may be omitted", async () => {
    let flag: boolean | undefined;
    let mode: string | undefined;
    deps = makeDeps({
      setAutoreply: (_room, v, m) => { flag = v; mode = m ?? "(unset)"; },
    });
    registerChatTools(pi as unknown as Parameters<typeof registerChatTools>[0], deps);

    await pi.tools["chat_set_autoreply"].execute("t1", { enabled: true });
    assert.equal(flag, true);
  });

  it("mode update flows through to setAutoreply", async () => {
    let modeApplied: string | undefined;
    deps = makeDeps({
      setAutoreply: (_room, _v, m) => { if (m) modeApplied = m; },
    });
    registerChatTools(pi as unknown as Parameters<typeof registerChatTools>[0], deps);

    await pi.tools["chat_set_autoreply"].execute("t1", { enabled: true, mode: "questions" });
    assert.equal(modeApplied, "questions");
  });

  it("disabled surfaces the change in the response text", async () => {
    deps = makeDeps({
      getStatus: () => ({
        state: { state: "connected", attempts: 0, info: undefined },
        env: {
          server: "http://chat",
          room: "team",
          agent: "alice",
          alias: "DEFAULT",
          autoreply: false,
          autoreplyMode: "mentions",
          history: 20,
          reconnectMs: 2000,
          cooldownMs: 2000,
          prefix: "[chat alice] ",
        },
        agentCount: 2,
        isNameDormant: false,
      }),
      setAutoreply: () => undefined,
    });
    registerChatTools(pi as unknown as Parameters<typeof registerChatTools>[0], deps);

    const result = await pi.tools["chat_set_autoreply"].execute("t1", { enabled: false });
    assert.match(result.content[0].text, /auto-reply disabled/);
  });
});

describe("wiring invariants", () => {
  it("registers all five tools", () => {
    for (const name of ["chat_send", "chat_list_agents", "chat_history", "chat_whoami", "chat_set_autoreply"]) {
      assert.ok(pi.tools[name], `missing tool ${name}`);
    }
  });

  it("every tool with a snippet has matching guidelines", () => {
    for (const name of Object.keys(pi.tools)) {
      const t = pi.tools[name];
      if (!t.promptSnippet) continue;
      // Heuristic: any guidelines mentioning the tool name in plain text.
      const guidelines = t.promptGuidelines ?? [];
      const has = guidelines.some((g) => g.includes(name));
      assert.ok(has, `tool ${name} has a snippet but no guideline naming it (per docs warning)`);
    }
  });
});

describe("chat_send description", () => {
  it("tells the LLM to write @<name> explicitly in the text", () => {
    const t = pi.tools["chat_send"];
    assert.match(t.description, /Always address specific agents by including `@<name>`/);
    assert.match(t.description, /End the message with `\?`/);
  });

  it("no longer tells the LLM it does NOT need to add the @mention", () => {
    // Regression: the old phrasing actively discouraged @mentions.
    const t = pi.tools["chat_send"];
    assert.doesNotMatch(t.description, /you do not need to add the @mention/);
    assert.doesNotMatch(t.description, /do not add the @mention yourself/);
  });

  it("guidelines include the @-mention convention", () => {
    const t = pi.tools["chat_send"];
    const guidelines = t.promptGuidelines ?? [];
    assert.ok(
      guidelines.some((g) => /Always include `@<recipient-name>`/.test(g)),
      "expected an explicit @-mention convention guideline",
    );
    assert.ok(
      guidelines.some((g) => /writing it explicitly produces a more readable transcript/i.test(g)),
      "expected guideline encouraging explicit @-mention writing",
    );
  });
});
