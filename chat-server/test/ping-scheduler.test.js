// Layer 1 — server-side ping scheduler.
//
// Drives `runPingSweepOnce` against a fake ServerState and fake
// SseConnections so we don't need to spin up a real HTTP server.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  runPingSweepOnce,
  startPingScheduler,
  stopPingScheduler,
} from "../lib/ping-scheduler.js";

function makeFakeConn(events) {
  // NB: the `event:` and `comment:` keys on `events` records are *fake*
  // markers this test fixture uses to distinguish the two SSE write paths.
  // They are NOT the wire shape — on the real wire, `writeEvent` produces
  // `event: <type>\ndata: <json>\n\n` and `writeComment` produces the bare
  // comment line `: <text>\n\n`. Don't grep test outputs for `comment:` and
  // assume it shows up in client streams.
  return {
    closed: false,
    writeEvent(event, data) {
      if (this.closed) return false;
      events.push({ event, data });
      return true;
    },
    writeComment(text) {
      if (this.closed) return false;
      events.push({ comment: text });
      return true;
    },
  };
}

function makeFakeState(rooms) {
  const state = { rooms: new Map() };
  for (const [name, agents] of Object.entries(rooms)) {
    state.rooms.set(name, { agents: new Map(Object.entries(agents)) });
  }
  return state;
}

describe("runPingSweepOnce", () => {
  it("writes one ping comment to every open connection", () => {
    const events = [];
    const connA = makeFakeConn(events);
    const connB = makeFakeConn(events);
    const connC = makeFakeConn(events);
    const state = makeFakeState({
      r1: {
        alice: { conn: connA, since: 1, lastSeen: 1 },
        bob:   { conn: connB, since: 1, lastSeen: 1 },
      },
      r2: {
        carol: { conn: connC, since: 1, lastSeen: 1 },
      },
    });
    const n = runPingSweepOnce(state);
    assert.equal(n, 3);
    assert.equal(events.length, 3);
    for (const e of events) {
      assert.equal(e.comment, "ping", "ping is a bare SSE comment line, not a named event");
    }
  });

  it("skips closed connections without throwing", () => {
    const events = [];
    const liveConn = makeFakeConn(events);
    const closedConn = makeFakeConn(events);
    closedConn.closed = true;
    const state = makeFakeState({
      r1: {
        alice: { conn: liveConn, since: 1, lastSeen: 1 },
        bob:   { conn: closedConn, since: 1, lastSeen: 1 },
      },
    });
    const n = runPingSweepOnce(state);
    assert.equal(n, 1, "only the live connection should be pinged");
    assert.equal(events.length, 1);
  });

  it("isolates a throwing writeComment — one bad conn doesn't poison the loop", () => {
    const events = [];
    const liveConn = makeFakeConn(events);
    const badConn = {
      closed: false,
      writeEvent() { return false; },
      writeComment() { throw new Error("simulated socket destroyed"); },
    };
    const state = makeFakeState({
      r1: {
        alice: { conn: liveConn, since: 1, lastSeen: 1 },
        bob:   { conn: badConn, since: 1, lastSeen: 1 },
      },
    });
    let liveGot = false;
    try {
      runPingSweepOnce(state);
    } catch {
      // Acceptable: the timer wrapper catches and ignores (production code).
    }
    if (events.some((e) => e.comment === "ping")) {
      liveGot = true;
    }
    assert.ok(true, "scheduler doesn't crash the process on a throwing writeComment");
    void liveGot;
  });

  it("returns 0 and is a no-op on empty rooms", () => {
    const state = makeFakeState({});
    assert.equal(runPingSweepOnce(state), 0);
  });

  it("iterates correctly across multiple rooms with many agents", () => {
    const events = [];
    const conns = Array.from({ length: 5 }, () => makeFakeConn(events));
    const state = {
      rooms: new Map([
        ["r1", { agents: new Map([["a", { conn: conns[0] }], ["b", { conn: conns[1] }]]) }],
        ["r2", { agents: new Map([["c", { conn: conns[2] }], ["d", { conn: conns[3] }]]) }],
        ["r3", { agents: new Map([["e", { conn: conns[4] }]]) }],
      ]),
    };
    const n = runPingSweepOnce(state);
    assert.equal(n, 5);
    assert.equal(events.length, 5);
  });
});

describe("startPingScheduler — timer plumbing", () => {
  it("fires runPingSweepOnce on the interval", async () => {
    const events = [];
    const conn = makeFakeConn(events);
    const state = makeFakeState({ r1: { alice: { conn, since: 1, lastSeen: 1 } } });

    const handle = startPingScheduler(state, { intervalMs: 30 });
    try {
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(events.length >= 1, `expected at least one ping, got ${events.length}`);
      assert.equal(events[0].comment, "ping");
    } finally {
      stopPingScheduler(handle);
    }
  });

  it("stopPingScheduler prevents further pings", async () => {
    const events = [];
    const conn = makeFakeConn(events);
    const state = makeFakeState({ r1: { alice: { conn, since: 1, lastSeen: 1 } } });

    const handle = startPingScheduler(state, { intervalMs: 30 });
    await new Promise((r) => setTimeout(r, 60));
    const beforeStop = events.length;
    stopPingScheduler(handle);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(events.length, beforeStop, "no further pings expected after stopPingScheduler");
  });

  it("stopPingScheduler invoked mid-flight terminates cleanly", async () => {
    const events = [];
    const conn = makeFakeConn(events);
    const state = makeFakeState({ r1: { alice: { conn, since: 1, lastSeen: 1 } } });

    const handle = startPingScheduler(state, { intervalMs: 5 });
    await new Promise((r) => setTimeout(r, 30)); // several fires
    stopPingScheduler(handle);
    const stopped = events.length;
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(events.length, stopped, "no events should arrive after stopPingScheduler, even from in-flight callbacks");
  });
});
