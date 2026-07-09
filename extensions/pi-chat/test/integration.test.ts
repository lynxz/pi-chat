// Integration — boot the real chat-server from /workspace/chat-server and
// verify end-to-end behaviour against two ChatClient instances. This is the
// Layer-2 of the testing strategy: the transport we ship in `client.ts`
// is exercised against the real server, not a stub.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { ChatClient, type ChatEvent } from "../client.ts";

import { createChatServer } from "../../../chat-server/server.js";

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

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Subscribe to events of `kind` for `durationMs`, then unsubscribe and return. */
async function collectFor<T extends ChatEvent["kind"]>(
  client: ChatClient,
  kind: T,
  durationMs: number,
): Promise<Array<Extract<ChatEvent, { kind: T }>>> {
  const out: Array<Extract<ChatEvent, { kind: T }>> = [];
  const off = client.onEvent((e) => { if (e.kind === kind) out.push(e as Extract<ChatEvent, { kind: T }>); });
  await new Promise((r) => setTimeout(r, durationMs));
  off();
  return out;
}

describe("ChatClient integration (real chat-server)", () => {
  it("alice first, bob joins: alice sees bob's presence-joined; bob sees alice's message", async () => {
    const alice = new ChatClient({ server: baseUrl, room: "team", agent: "alice", reconnectMs: 200 });
    const bob = new ChatClient({ server: baseUrl, room: "team", agent: "bob", reconnectMs: 200 });
    try {
      // Subscribe BEFORE start so we don't miss the `hello` frame.
      const aliceEvents: ChatEvent[] = [];
      alice.onEvent((e) => aliceEvents.push(e));

      await alice.start();
      await waitFor(() => alice.status.state === "connected");
      // hello is synchronous, but give the event loop a tick.
      await new Promise((r) => setTimeout(r, 10));

      assert.ok(
        aliceEvents.some((e) => e.kind === "hello"),
        "alice should have received a hello",
      );

      await bob.start();
      await waitFor(() => bob.status.state === "connected");
      await new Promise((r) => setTimeout(r, 50));

      assert.ok(
        aliceEvents.some((e) => e.kind === "presence" && e.agent === "bob" && e.action === "joined"),
        "alice should have seen bob's presence-joined",
      );

      // bob publishes.
      const r = await bob.send("hello @alice");
      assert.equal(typeof r.id, "string");
      assert.deepEqual(r.mentions, ["@alice"]);

      await waitFor(() => aliceEvents.some((e) => e.kind === "message"));
      const msgs = aliceEvents.filter((e) => e.kind === "message");
      assert.equal(msgs.length, 1, "alice should have received exactly 1 message");
      const m = msgs[0];
      assert.equal(m?.kind, "message");
      if (m?.kind === "message") {
        assert.equal(m.from, "bob");
        assert.equal(m.text, "hello @alice");
        assert.deepEqual(m.mentions, ["@alice"]);
      }

      const bobMessages = await collectFor(bob, "message", 30);
      assert.equal(bobMessages.length, 0);
    } finally {
      await alice.close();
      await bob.close();
    }
  });

  it("presence: a fresh joiner receives `hello` listing earlier agents (no presence replay)", async () => {
    const alice = new ChatClient({ server: baseUrl, room: "presence-room", agent: "alice-p", reconnectMs: 200 });
    await alice.start();
    await waitFor(() => alice.status.state === "connected");
    await new Promise((r) => setTimeout(r, 30));

    const bobEvents: ChatEvent[] = [];
    const bob = new ChatClient({ server: baseUrl, room: "presence-room", agent: "bob-p", reconnectMs: 200 });
    bob.onEvent((e) => bobEvents.push(e));
    await bob.start();
    await waitFor(() => bob.status.state === "connected");
    await new Promise((r) => setTimeout(r, 30));

    // Bob got a hello (which lists earlier agents), but no presence events:
    // alice was already there when bob connected.
    const hello = bobEvents.find((e) => e.kind === "hello");
    assert.ok(hello, "bob should have received a hello");
    if (hello?.kind === "hello") {
      const names = (hello.agents ?? []).map((a) => a.name).sort();
      assert.deepEqual(names, ["alice-p", "bob-p"]);
    }
    assert.equal(
      bobEvents.filter((e) => e.kind === "presence").length,
      0,
      "bob should not have received presence events (alice joined before him)",
    );

    await alice.close();
    await bob.close();
  });

  it("name release on close: a fresh connect for the same name succeeds", async () => {
    const c1 = new ChatClient({ server: baseUrl, room: "release-room", agent: "alice-r", reconnectMs: 100 });
    await c1.start();
    await waitFor(() => c1.status.state === "connected");
    await c1.close();
    await new Promise((r) => setTimeout(r, 50));

    const c2 = new ChatClient({ server: baseUrl, room: "release-room", agent: "alice-r", reconnectMs: 100 });
    await c2.start();
    await waitFor(() => c2.status.state === "connected");
    await c2.close();
  });

  it("name-dormant: second SSE for same name → 'conflict', no reconnect, send is rejected", async () => {
    const alice = new ChatClient({ server: baseUrl, room: "conflict-room", agent: "alice-c", reconnectMs: 50 });
    await alice.start();
    await waitFor(() => alice.status.state === "connected");

    const conflict = new ChatClient({ server: baseUrl, room: "conflict-room", agent: "alice-c", reconnectMs: 50 });
    const states: string[] = [];
    conflict.onStatus((s) => states.push(s.state));
    await conflict.start();
    await waitFor(() => conflict.status.state === "conflict");

    // No reconnect should be scheduled — status stays 'conflict'.
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(conflict.status.state, "conflict");

    await assert.rejects(
      () => conflict.send("hi"),
      (err: Error & { code?: string }) => err.code === "name_dormant",
    );

    await alice.close();
    await conflict.close();
  });
});
