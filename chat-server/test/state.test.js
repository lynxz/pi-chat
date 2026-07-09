// Layer 1 — state: ring buffer, fan-out, conflict, name release, rate limit.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { RingBuffer, ServerState } from "../lib/state.js";

/** A stub SseConnection that records writes and can be closed. */
function makeStubConn() {
  const writes = [];
  let closed = false;
  return {
    writes,
    writeEvent(event, data) {
      if (closed) return false;
      writes.push({ event, data });
      return true;
    },
    close() {
      closed = true;
    },
    get closed() { return closed; },
    _close() { closed = true; }, // mimic `res.on("close")`
  };
}

describe("RingBuffer", () => {
  it("writes and reads back in order", () => {
    const r = new RingBuffer(3);
    r.push("a"); r.push("b"); r.push("c");
    assert.deepEqual(r.snapshot(), ["a", "b", "c"]);
    assert.equal(r.size, 3);
  });

  it("evicts oldest beyond limit", () => {
    const r = new RingBuffer(3);
    r.push(1); r.push(2); r.push(3); r.push(4); r.push(5);
    assert.deepEqual(r.snapshot(), [3, 4, 5]);
    assert.equal(r.size, 3);
  });

  it("snapshot(limit) returns last N", () => {
    const r = new RingBuffer(10);
    for (let i = 0; i < 10; i++) r.push(i);
    assert.deepEqual(r.snapshot(3), [7, 8, 9]);
    assert.deepEqual(r.snapshot(0), []);
    assert.deepEqual(r.snapshot(-1), []);
  });

  it("rejects non-positive limits", () => {
    assert.throws(() => new RingBuffer(0), /positive integer/);
    assert.throws(() => new RingBuffer(-1), /positive integer/);
    assert.throws(() => new RingBuffer(1.5), /positive integer/);
  });
});

describe("ServerState — room lifecycle", () => {
  let s;
  beforeEach(() => { s = new ServerState({ historyLimit: 3, rateLimitPerSec: 2, rateLimitWindowMs: 1000 }); });

  it("creates a room on first add", () => {
    const conn = makeStubConn();
    s.addAgent("r1", "alice", conn);
    assert.equal(s.rooms.has("r1"), true);
    assert.equal(s.rooms.get("r1").agents.size, 1);
  });

  it("is a no-op on a second bind for the same name (HTTP layer owns 409)", () => {
    const a = makeStubConn();
    const b = makeStubConn();
    s.addAgent("r1", "alice", a);
    // addAgent itself doesn't throw — it silently keeps the existing binding.
    s.addAgent("r1", "alice", b);
    // The first connection is undisturbed.
    assert.equal(s.rooms.get("r1").agents.get("alice").conn, a);
  });

  it("does not leak empty rooms on a no-op conflict", () => {
    const a = makeStubConn();
    s.addAgent("nowhere", "alice", a);
    s.addAgent("nowhere", "alice", makeStubConn());
    // Just alice in one room — no other rooms created.
    assert.equal(s.rooms.size, 1);
  });

  it("releases the name on removeAgent; a new bind then succeeds", () => {
    const a = makeStubConn();
    s.addAgent("r1", "alice", a);
    s.removeAgent("r1", "alice");
    const b = makeStubConn();
    s.addAgent("r1", "alice", b); // no throw
    assert.equal(s.rooms.get("r1").agents.size, 1);
    assert.equal(s.rooms.get("r1").agents.get("alice").conn, b);
  });

  it("GCs a room with no agents AND no history", () => {
    s.addAgent("r1", "alice", makeStubConn());
    s.removeAgent("r1", "alice");
    assert.equal(s.rooms.has("r1"), false);
  });

  it("keeps a room with history even after agents leave", () => {
    const a = makeStubConn();
    s.addAgent("r1", "alice", a);
    s.publish("r1", { from: "alice", text: "hi" });
    s.removeAgent("r1", "alice");
    assert.equal(s.rooms.has("r1"), true);
    assert.equal(s.rooms.get("r1").history.size, 1);
  });

  it("removeAgent is a no-op for unbound names", () => {
    s.removeAgent("r1", "ghost");
    assert.equal(s.rooms.has("r1"), false);
  });
});

describe("ServerState — publish + fan-out", () => {
  let s;
  beforeEach(() => { s = new ServerState({ historyLimit: 100, rateLimitPerSec: 100, rateLimitWindowMs: 1000 }); });

  it("publishes a message, assigns id+ts+mentions, pushes to history", () => {
    const conn = makeStubConn();
    s.addAgent("r1", "alice", conn);
    const r = s.publish("r1", { from: "alice", text: "hi @bob", meta: { replyTo: "x" } });
    assert.equal(typeof r.message.id, "string");
    assert.equal(r.message.from, "alice");
    assert.equal(r.message.text, "hi @bob");
    assert.equal(r.message.ts > 0, true);
    assert.deepEqual(r.message.mentions, ["@bob"]);
    assert.deepEqual(r.message.meta, { replyTo: "x" });
    assert.equal(s.getHistory("r1").length, 1);
  });

  it("fan-out skips the sender (recipients list)", () => {
    // `publish()` itself doesn't write to recipients — the route layer owns
    // fan-out so state stays decoupled from the wire shape. The contract here
    // is that the returned `recipients` list excludes the sender.
    const a = makeStubConn();
    const b = makeStubConn();
    const c = makeStubConn();
    s.addAgent("r1", "alice", a);
    s.addAgent("r1", "bob", b);
    s.addAgent("r1", "carol", c);
    const r = s.publish("r1", { from: "alice", text: "hi" });
    assert.deepEqual(r.recipients.map((x) => x.name), ["bob", "carol"]);
    // Stub connections received nothing directly from publish.
    assert.equal(a.writes.length, 0);
    assert.equal(b.writes.length, 0);
    assert.equal(c.writes.length, 0);
  });

  it("rejects publish from an unbound agent", () => {
    s.addAgent("r1", "alice", makeStubConn());
    assert.throws(
      () => s.publish("r1", { from: "bob", text: "hi" }),
      (err) => err.code === "AGENT_NOT_CONNECTED",
    );
  });

  it("rate limit: 11th publish in 1s throws RATE_LIMITED", () => {
    // Build a state with the default 10/s cap so the assertion is meaningful.
    const s2 = new ServerState({ rateLimitPerSec: 10, rateLimitWindowMs: 1000 });
    s2.addAgent("r1", "alice", makeStubConn());
    for (let i = 0; i < 10; i++) {
      s2.publish("r1", { from: "alice", text: `m${i}` });
    }
    assert.throws(
      () => s2.publish("r1", { from: "alice", text: "11th" }),
      (err) => err.code === "RATE_LIMITED",
    );
  });

  it("rate limit resets after the window passes", () => {
    const s2 = new ServerState({ rateLimitPerSec: 2, rateLimitWindowMs: 30 });
    s2.addAgent("r1", "alice", makeStubConn());
    s2.publish("r1", { from: "alice", text: "m0" });
    s2.publish("r1", { from: "alice", text: "m1" });
    assert.throws(() => s2.publish("r1", { from: "alice", text: "m2" }),
      (err) => err.code === "RATE_LIMITED");
    return new Promise((r) => setTimeout(r, 60))
      .then(() => {
        // window is past; new publish should succeed.
        const ok = s2.publish("r1", { from: "alice", text: "m3" });
        assert.ok(ok.message);
      });
  });

  it("publish() on an unbound agent does NOT create an empty room", () => {
    // No agent has joined; the only side-effect of throwing should be the
    // throw itself, not a side-effecting room insertion.
    assert.throws(
      () => s.publish("ghost-room", { from: "nobody", text: "hi" }),
      (err) => err.code === "AGENT_NOT_CONNECTED",
    );
    assert.equal(s.rooms.has("ghost-room"), false);
  });

  it("formatMessageForSse builds the wire payload", () => {
    const conn = makeStubConn();
    s.addAgent("r1", "alice", conn);
    const r = s.publish("r1", { from: "alice", text: "hi", meta: { replyTo: "x" } });
    const payload = s.formatMessageForSse(r.message, "r1");
    assert.equal(payload.id, r.message.id);
    assert.equal(payload.room, "r1");
    assert.equal(payload.from, "alice");
    assert.equal(payload.text, "hi");
    assert.equal(payload.ts, r.message.ts);
    assert.deepEqual(payload.mentions, r.message.mentions);
    assert.deepEqual(payload.meta, { replyTo: "x" });
  });

  it("formatMessageForSse omits `meta` when not set", () => {
    const conn = makeStubConn();
    s.addAgent("r1", "alice", conn);
    const r = s.publish("r1", { from: "alice", text: "hi" });
    const payload = s.formatMessageForSse(r.message, "r1");
    assert.equal("meta" in payload, false);
  });

  it("removeAgent clears the rate-limit timestamp slot for that agent", () => {
    // A long-running server with churn could otherwise leak one slot per
    // departed agent in `publishTimestamps`.
    const conn = makeStubConn();
    s.addAgent("r1", "alice", conn);
    s.publish("r1", { from: "alice", text: "m0" });
    const room = s.rooms.get("r1");
    assert.ok(room.publishTimestamps.has("alice"));
    s.removeAgent("r1", "alice");
    // Room is retained because it had activity.
    assert.equal(s.rooms.has("r1"), true);
    assert.equal(room.publishTimestamps.has("alice"), false);
  });

  it("broadcast writes to every agent except the named one", () => {
    const a = makeStubConn();
    const b = makeStubConn();
    const c = makeStubConn();
    s.addAgent("r1", "alice", a);
    s.addAgent("r1", "bob", b);
    s.addAgent("r1", "carol", c);
    const n = s.broadcast("r1", "presence", { hello: true }, "alice");
    assert.equal(n, 2); // bob + carol
    assert.equal(a.writes.length, 0);
    assert.equal(b.writes[0].event, "presence");
  });

  it("broadcast returns 0 for an unknown room", () => {
    assert.equal(s.broadcast("nope", "presence", {}), 0);
  });
});

describe("ServerState — history", () => {
  it("returns [] for an unknown room", () => {
    const s = new ServerState();
    assert.deepEqual(s.getHistory("nothing"), []);
  });
  it("listAgents returns [] for an unknown room", () => {
    const s = new ServerState();
    assert.deepEqual(s.listAgents("nothing"), []);
  });
  it("listAgents sorts by name", () => {
    const s = new ServerState();
    s.addAgent("r1", "carol", makeStubConn());
    s.addAgent("r1", "alice", makeStubConn());
    s.addAgent("r1", "bob", makeStubConn());
    assert.deepEqual(s.listAgents("r1").map((a) => a.name), ["alice", "bob", "carol"]);
  });
});
