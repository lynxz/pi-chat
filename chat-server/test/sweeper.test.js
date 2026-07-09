// Layer 1 — stale-SSE sweeper.
//
// The sweeper walks every room, closes any SSE whose `lastSeen` is older than
// `staleMs`, and lets `SseConnection.onClose()` do the presence cleanup. We
// exercise `runStaleSweepOnce` directly with a fake `ServerState` and fake
// connections so we don't need to spin up a real HTTP server.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  runStaleSweepOnce,
  startStaleSweeper,
  stopStaleSweeper,
} from "../lib/sweeper.js";

function makeFakeConn(closedCount) {
  return {
    lastSeen: 0,     // mutated by tests
    close() { closedCount.push(true); },
  };
}

function makeFakeState(rooms) {
  // `rooms` mirrors `ServerState.rooms`: { [roomName]: { agents: Map<name, entry> } }
  // (Map, because that's what ServerState uses.)
  const state = { rooms: new Map() };
  for (const [name, agents] of Object.entries(rooms)) {
    state.rooms.set(name, { agents: new Map(Object.entries(agents)) });
  }
  return state;
}

describe("runStaleSweepOnce", () => {
  it("closes a connection older than staleMs", () => {
    const closed = [];
    const conn = makeFakeConn(closed);
    conn.lastSeen = 1_000;
    const state = makeFakeState({ r1: { alice: { conn, since: 1, lastSeen: 1_000 } } });
    const closedCount = runStaleSweepOnce(state, { staleMs: 500, now: 2_000 });
    assert.equal(closedCount, 1);
    assert.deepEqual(closed, [true]);
  });

  it("does not close a connection within the window", () => {
    const closed = [];
    const conn = makeFakeConn(closed);
    conn.lastSeen = 1_000;
    const state = makeFakeState({ r1: { alice: { conn, since: 1, lastSeen: 1_000 } } });
    const closedCount = runStaleSweepOnce(state, { staleMs: 5_000, now: 2_000 });
    assert.equal(closedCount, 0);
    assert.deepEqual(closed, []);
  });

  it("handles multiple rooms and multiple agents", () => {
    const closed = [];
    const oldConn = makeFakeConn(closed);
    oldConn.lastSeen = 0;
    const freshConn = makeFakeConn(closed);
    freshConn.lastSeen = 9_500;
    const state = makeFakeState({
      r1: {
        alice: { conn: oldConn, since: 1, lastSeen: 0 },
        bob: { conn: freshConn, since: 1, lastSeen: 9_500 },
      },
      r2: {
        carol: { conn: oldConn, since: 1, lastSeen: 0 },
      },
    });
    // staleMs=1000; now=10_000. alice=(10000-0)>1000 stale, bob=(10000-9500)=500 NOT stale,
    // carol stale.
    const closedCount = runStaleSweepOnce(state, { staleMs: 1_000, now: 10_000 });
    assert.equal(closedCount, 2); // alice + carol
    assert.equal(closed.length, 2);
  });

  it("returns 0 and is a no-op on empty rooms", () => {
    const state = makeFakeState({});
    assert.equal(runStaleSweepOnce(state), 0);
  });

  it("uses -Infinity for a missing `conn.lastSeen` (treats it as stale)", () => {
    const closed = [];
    const conn = makeFakeConn(closed);
    conn.lastSeen = undefined;  // not initialized
    const state = makeFakeState({ r1: { alice: { conn, since: 1, lastSeen: 0 } } });
    // `?? -Infinity` on the missing `conn.lastSeen` → age = +Inf →
    // the connection MUST be considered stale and closed. The lingering
    // `entry.lastSeen` value is no longer consulted.
    const closedCount = runStaleSweepOnce(state, { staleMs: 1_000, now: 10_000 });
    assert.equal(closedCount, 1, "missing conn.lastSeen should be treated as truly stale");
    assert.deepEqual(closed, [true]);
  });

  it("keeps a connection alive when conn.lastSeen is fresh", () => {
    const closed = [];
    // conn.lastSeen is fresh; extra fields on the entry are ignored.
    const conn = makeFakeConn(closed);
    conn.lastSeen = 9_500;
    const state = makeFakeState({ r1: { alice: { conn, since: 1 } } });
    const closedCount = runStaleSweepOnce(state, { staleMs: 1_000, now: 10_000 });
    assert.equal(closedCount, 0);
    assert.deepEqual(closed, []);
  });
});

describe("startStaleSweeper — timer plumbing", () => {
  it("fires runStaleSweepOnce on the interval", async () => {
    const closed = [];
    const conn = makeFakeConn(closed);
    conn.lastSeen = 0;
    const state = makeFakeState({ r1: { alice: { conn, since: 1, lastSeen: 0 } } });

    const handle = startStaleSweeper(state, { intervalMs: 30, staleMs: 1000 });
    try {
      // Wait long enough for the interval to fire at least twice.
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(closed.length >= 1, `expected at least one close, got ${closed.length}`);
    } finally {
      stopStaleSweeper(handle);
    }
  });

  it("stopStaleSweeper prevents further sweeps", async () => {
    const closed = [];
    const conn = makeFakeConn(closed);
    conn.lastSeen = 0;
    const state = makeFakeState({ r1: { alice: { conn, since: 1, lastSeen: 0 } } });

    const handle = startStaleSweeper(state, { intervalMs: 30, staleMs: 1000 });
    await new Promise((r) => setTimeout(r, 50));
    const beforeStop = closed.length;
    stopStaleSweeper(handle);
    // Wait again — no more closes expected.
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(closed.length, beforeStop, "no further closes expected after stopStaleSweeper");
  });
});
