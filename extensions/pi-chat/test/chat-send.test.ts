// Unit tests for `chat-send.ts` — outbound auto-mention resolution and
// the silent-drop diagnostic.
//
// These tests cover the pure resolver in isolation from `sendOutbound` /
// the chat-server. The wiring test (`wiring.test.ts`) already exercises
// the integration path end-to-end; this file pins down the resolver's
// edge cases.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveAutoMention } from "../chat-send.ts";
import { RecentBuffer } from "../state.ts";

function bufferWith(...msgs: Array<{ id: string; from: string; ts: number }>): RecentBuffer {
  const buf = new RecentBuffer(64);
  for (const m of msgs) {
    buf.record({ ...m, text: `from ${m.from}`, mentions: [] });
  }
  return buf;
}

const NOW = 1_000_000;
const REPLY_CHAIN_MS = 60_000;

describe("resolveAutoMention", () => {
  it("returns the text unchanged when meta is absent", () => {
    const buf = bufferWith();
    const r = resolveAutoMention("hello", undefined, buf, "alice", REPLY_CHAIN_MS, NOW);
    assert.equal(r.resolvedText, "hello");
    assert.equal(r.originalFrom, undefined);
    assert.equal(r.unresolvedReplyTo, false);
  });

  it("resolves via replyTo when the id is in recent", () => {
    const buf = bufferWith({ id: "m1", from: "bob", ts: NOW - 1_000 });
    const r = resolveAutoMention(
      "thanks!",
      { replyTo: "m1" },
      buf,
      "alice",
      REPLY_CHAIN_MS,
      NOW,
    );
    assert.equal(r.resolvedText, "@bob thanks!");
    assert.equal(r.originalFrom, "bob");
    assert.equal(r.unresolvedReplyTo, false);
  });

  it("falls back to recency when replyTo is missing", () => {
    // No replyTo set, but a fresh inbound from bob is in the buffer.
    const buf = bufferWith({ id: "m1", from: "bob", ts: NOW - 5_000 });
    const r = resolveAutoMention(
      "thanks!",
      undefined,
      buf,
      "alice",
      REPLY_CHAIN_MS,
      NOW,
    );
    assert.equal(r.resolvedText, "@bob thanks!");
    assert.equal(r.originalFrom, "bob");
    assert.equal(r.unresolvedReplyTo, false);
  });

  it("skips recency fallback when the latest non-self is too old", () => {
    const buf = bufferWith({ id: "m1", from: "bob", ts: NOW - REPLY_CHAIN_MS - 1 });
    const r = resolveAutoMention(
      "hi all",
      undefined,
      buf,
      "alice",
      REPLY_CHAIN_MS,
      NOW,
    );
    assert.equal(r.resolvedText, "hi all");
    assert.equal(r.originalFrom, undefined);
    // Without replyTo, unresolvedReplyTo is false even if there's no sender.
    assert.equal(r.unresolvedReplyTo, false);
  });

  it("ignores self-authored recent messages when picking the fallback sender", () => {
    // alice's own message is the freshest; should be skipped.
    const buf = bufferWith(
      { id: "m1", from: "alice", ts: NOW - 100 },
      { id: "m2", from: "bob", ts: NOW - 1_000 },
    );
    const r = resolveAutoMention(
      "ack",
      undefined,
      buf,
      "alice",
      REPLY_CHAIN_MS,
      NOW,
    );
    assert.equal(r.originalFrom, "bob");
    assert.equal(r.resolvedText, "@bob ack");
  });

  it("does NOT prepend when the @mention is already in the text", () => {
    const buf = bufferWith({ id: "m1", from: "bob", ts: NOW - 1_000 });
    const r = resolveAutoMention(
      "@bob already mentioned",
      { replyTo: "m1" },
      buf,
      "alice",
      REPLY_CHAIN_MS,
      NOW,
    );
    assert.equal(r.resolvedText, "@bob already mentioned");
    assert.equal(r.originalFrom, "bob");
  });

  it("does NOT prepend when the resolved sender is self", () => {
    const buf = bufferWith({ id: "m1", from: "alice", ts: NOW - 1_000 });
    const r = resolveAutoMention(
      "reminder to myself",
      { replyTo: "m1" },
      buf,
      "alice",
      REPLY_CHAIN_MS,
      NOW,
    );
    assert.equal(r.resolvedText, "reminder to myself");
    assert.equal(r.originalFrom, undefined);
  });

  // Silent-drop diagnostic.
  describe("unresolvedReplyTo flag", () => {
    it("true when meta.replyTo is set but no sender can be resolved", () => {
      const buf = bufferWith(); // empty
      const r = resolveAutoMention(
        "hi",
        { replyTo: "ghost-id" },
        buf,
        "alice",
        REPLY_CHAIN_MS,
        NOW,
      );
      assert.equal(r.unresolvedReplyTo, true);
      assert.equal(r.originalFrom, undefined);
      assert.equal(r.resolvedText, "hi");
    });

    it("false when meta.replyTo resolves successfully", () => {
      const buf = bufferWith({ id: "m1", from: "bob", ts: NOW - 1_000 });
      const r = resolveAutoMention(
        "hi",
        { replyTo: "m1" },
        buf,
        "alice",
        REPLY_CHAIN_MS,
        NOW,
      );
      assert.equal(r.unresolvedReplyTo, false);
    });

    it("false when meta.replyTo is absent (broadcast / status)", () => {
      const buf = bufferWith();
      const r = resolveAutoMention(
        "good morning",
        undefined,
        buf,
        "alice",
        REPLY_CHAIN_MS,
        NOW,
      );
      assert.equal(r.unresolvedReplyTo, false);
    });

    it("false when meta.replyTo resolves via recency fallback", () => {
      // No explicit replyTo id in recent, but a fresh inbound from bob is.
      const buf = bufferWith({ id: "m1", from: "bob", ts: NOW - 1_000 });
      const r = resolveAutoMention(
        "hi",
        undefined,
        buf,
        "alice",
        REPLY_CHAIN_MS,
        NOW,
      );
      assert.equal(r.unresolvedReplyTo, false);
      assert.equal(r.originalFrom, "bob");
    });
  });
});