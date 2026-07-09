// Layer 1 — id dedupe, per-sender cooldown, reply tracker.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CooldownGate, IdDedupe, ReplyTracker, RecentBuffer, ReplyChainTracker } from "../state.ts";

describe("IdDedupe", () => {
  it("accepts a fresh id; rejects a repeat", () => {
    const d = new IdDedupe();
    assert.equal(d.accept("a", 1000), true);
    assert.equal(d.accept("a", 1100), false); // dup
    assert.equal(d.accept("b", 1100), true);
    assert.equal(d.size, 2);
  });

  it("expires ids after the window elapses", () => {
    const d = new IdDedupe(100 /*ms*/, 10);
    assert.equal(d.accept("a", 0), true);
    assert.equal(d.accept("a", 50), false); // still inside window
    assert.equal(d.accept("a", 150), true); // 150ms > 100ms maxAge
  });

  it("drops oldest entries beyond maxSize", () => {
    const d = new IdDedupe(60_000, 3);
    d.accept("a", 1);
    d.accept("b", 2);
    d.accept("c", 3);
    assert.equal(d.accept("d", 4), true);
    assert.equal(d.size, 3);
    // 'a' was evicted (oldest); a fresh accept should succeed now
    assert.equal(d.accept("a", 5), true);
  });
});

describe("CooldownGate", () => {
  it("first message always accepted", () => {
    const g = new CooldownGate(1000);
    assert.equal(g.isOnCooldown("bob", 0), false);
  });

  it("rejects repeats inside the window", () => {
    const g = new CooldownGate(1000);
    g.record("bob", 0);
    assert.equal(g.isOnCooldown("bob", 100), true);
    assert.equal(g.isOnCooldown("bob", 999), true);
    assert.equal(g.isOnCooldown("bob", 1000), false); // exactly at window
    assert.equal(g.isOnCooldown("bob", 1500), false);
  });

  it("treats different senders independently", () => {
    const g = new CooldownGate(1000);
    g.record("bob", 0);
    assert.equal(g.isOnCooldown("bob", 100), true);
    assert.equal(g.isOnCooldown("alice", 100), false);
  });

  it("zero window disables cooldown entirely", () => {
    const g = new CooldownGate(0);
    g.record("bob", 0);
    assert.equal(g.isOnCooldown("bob", 0), false);
  });

  it("rejects negative window", () => {
    assert.throws(() => new CooldownGate(-1), /non-negative/);
  });
});

describe("ReplyTracker", () => {
  it("round-trips ids", () => {
    const t = new ReplyTracker();
    assert.equal(t.has("x"), false);
    t.remember("x");
    assert.equal(t.has("x"), true);
    t.clear();
    assert.equal(t.has("x"), false);
  });
});

describe("RecentBuffer", () => {
  it("records and returns messages oldest-first", () => {
    const b = new RecentBuffer(5);
    assert.equal(b.size, 0);
    assert.deepEqual(b.recent(), []);
    b.record({ id: "a", from: "alice", text: "hi", ts: 1, mentions: [] });
    b.record({ id: "b", from: "bob",   text: "yo", ts: 2, mentions: [] });
    assert.equal(b.size, 2);
    assert.deepEqual(b.recent().map((m) => m.id), ["a", "b"]);
  });

  it("caps at maxSize, evicting FIFO", () => {
    const b = new RecentBuffer(2);
    b.record({ id: "a", from: "x", text: "a", ts: 1, mentions: [] });
    b.record({ id: "b", from: "x", text: "b", ts: 2, mentions: [] });
    b.record({ id: "c", from: "x", text: "c", ts: 3, mentions: [] });
    assert.equal(b.size, 2);
    assert.deepEqual(b.recent().map((m) => m.id), ["b", "c"]);
  });

  it("is idempotent on duplicate id", () => {
    const b = new RecentBuffer(5);
    assert.equal(b.record({ id: "a", from: "x", text: "1", ts: 1, mentions: [] }), true);
    assert.equal(b.record({ id: "a", from: "x", text: "2", ts: 2, mentions: [] }), false);
    assert.equal(b.size, 1, "duplicate not re-recorded");
    assert.equal(b.recent()[0].text, "1", "first insert wins on dup");
  });

  it("recent(limit) returns last N, oldest-first", () => {
    const b = new RecentBuffer(10);
    for (let i = 0; i < 5; i++) b.record({ id: `m${i}`, from: "x", text: `${i}`, ts: i, mentions: [] });
    assert.deepEqual(b.recent(3).map((m) => m.id), ["m2", "m3", "m4"]);
    assert.deepEqual(b.recent(99).map((m) => m.id), ["m0", "m1", "m2", "m3", "m4"]);
  });

  it("rejects invalid maxSize", () => {
    assert.throws(() => new RecentBuffer(0), /RecentBuffer.maxSize must be/);
    assert.throws(() => new RecentBuffer(-1), /RecentBuffer.maxSize must be/);
  });

  it("find(id) returns the matching record or undefined", () => {
    const b = new RecentBuffer(5);
    b.record({ id: "a", from: "x", text: "1", ts: 1, mentions: [] });
    b.record({ id: "b", from: "y", text: "2", ts: 2, mentions: [] });
    const hit = b.find("a");
    assert.ok(hit);
    assert.equal(hit?.from, "x");
    assert.equal(hit?.text, "1");
    assert.equal(b.find("nope"), undefined);
  });
});

describe("ReplyChainTracker", () => {
  it("remembers and lookups entries within window", () => {
    const t = new ReplyChainTracker(1000);
    t.remember("a", "hello bob", 1000);
    assert.equal(t.has("a", 1500), true);
    assert.equal(t.lookup("a", 1500)?.text, "hello bob");
  });

  it("drops entries outside the window (lazy GC)", () => {
    const t = new ReplyChainTracker(500);
    t.remember("a", "hi", 1000);
    assert.equal(t.has("a", 1500), false, "500ms after ts = outside window");
    assert.equal(t.lookup("a", 1500), undefined);
  });

  it("windowMs === 0 disables the window entirely", () => {
    const t = new ReplyChainTracker(0);
    t.remember("a", "hi", 1);
    assert.equal(t.has("a", 1_000_000_000), true, "no window means always fresh");
  });

  it("rejects negative windowMs", () => {
    assert.throws(() => new ReplyChainTracker(-1), /non-negative/);
  });

  it("clears all entries", () => {
    const t = new ReplyChainTracker(1000);
    t.remember("a", "1", 1);
    t.remember("b", "2", 2);
    t.clear();
    assert.equal(t.has("a"), false);
    assert.equal(t.has("b"), false);
  });
});
