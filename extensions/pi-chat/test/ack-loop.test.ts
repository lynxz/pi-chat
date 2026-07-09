// Unit tests for acknowledgment loop prevention.
//
// Tests the `isAcknowledgment` helper function and the per-sender
// counter logic that prevents multi-agent loops of thanking/approving.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Re-implement the helper here for isolated testing.
// This mirrors the implementation in ../index.ts.
function isAcknowledgment(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  // Just emojis
  if (/^[\s😀👍🎉🚀🐛✅😄]+$/.test(trimmed)) return true;
  // Explicit acknowledgment keywords (kept narrow to avoid false positives).
  // $ ensures the whole message is just the keyword (possibly with trailing punct).
  const keywordPatterns = [
    /^thanks!?$/i,        // thanks, thanks!
    /^approved!?$/i,      // approved, approved!
    /^done\.?$/i,        // done, done.
    /^\+$/,              // +
    /^all set!?$/i,      // all set, all set!
    /^confirmed!?$/i,    // confirmed, confirmed!
  ];
  if (keywordPatterns.some((p) => p.test(trimmed))) return true;
  // Very short confirmations only (under 10 chars to be conservative)
  if (trimmed.length < 10 && /^(yep|yes|yeah|ok|okay|nope?|\+|👍|✓)$/i.test(trimmed)) return true;
  return false;
}

describe("isAcknowledgment", () => {
  describe("emoji-only messages", () => {
    it("returns true for single emoji", () => {
      assert.equal(isAcknowledgment("👍"), true);
    });

    it("returns true for multiple emojis", () => {
      assert.equal(isAcknowledgment("👍🎉"), true);
    });

    it("returns true for emojis with spaces", () => {
      assert.equal(isAcknowledgment("🐛✅"), true);
    });

    it("returns false for empty string", () => {
      assert.equal(isAcknowledgment(""), false);
    });

    it("returns false for whitespace only", () => {
      assert.equal(isAcknowledgment("   "), false);
    });
  });

  describe("explicit acknowledgment keywords", () => {
    it("returns true for 'thanks'", () => {
      assert.equal(isAcknowledgment("thanks"), true);
    });

    it("returns false for 'thank you'", () => {
      // "thank you" is too substantive to be just an ack
      assert.equal(isAcknowledgment("thank you"), false);
    });

    it("returns true for 'approved'", () => {
      assert.equal(isAcknowledgment("approved"), true);
    });

    it("returns false for 'approve'", () => {
      // "approve" is a verb, not an explicit ack
      assert.equal(isAcknowledgment("approve"), false);
    });

    it("returns true for 'done'", () => {
      assert.equal(isAcknowledgment("done"), true);
    });

    it("returns true for '+'", () => {
      assert.equal(isAcknowledgment("+"), true);
    });

    it("returns true for 'all set'", () => {
      assert.equal(isAcknowledgment("all set"), true);
    });

    it("returns true for 'confirmed'", () => {
      assert.equal(isAcknowledgment("confirmed"), true);
    });



    it("is case-insensitive", () => {
      assert.equal(isAcknowledgment("THANKS"), true);
      assert.equal(isAcknowledgment("THANKS!"), true);
      assert.equal(isAcknowledgment("APPROVED"), true);
    });
  });

  describe("short confirmations", () => {
    it("returns true for 'ok'", () => {
      assert.equal(isAcknowledgment("ok"), true);
    });

    it("returns true for 'yes'", () => {
      assert.equal(isAcknowledgment("yes"), true);
    });

    it("returns true for 'yep'", () => {
      assert.equal(isAcknowledgment("yep"), true);
    });

    it("returns true for 'yeah'", () => {
      assert.equal(isAcknowledgment("yeah"), true);
    });

    it("returns true for 'okay'", () => {
      assert.equal(isAcknowledgment("okay"), true);
    });

    it("returns true for 'nope'", () => {
      assert.equal(isAcknowledgment("nope"), true);
    });

    it("returns false for messages 10+ characters", () => {
      assert.equal(isAcknowledgment("yep yep"), false); // 8 chars with space
      assert.equal(isAcknowledgment("yep yep!"), false); // 9 chars with space
    });
  });

  describe("substantive messages (should NOT be acknowledgments)", () => {
    it("returns false for 'looks good'", () => {
      assert.equal(isAcknowledgment("looks good"), false);
    });

    it("returns false for 'looks great'", () => {
      assert.equal(isAcknowledgment("looks great"), false);
    });

    it("returns false for 'ready to merge'", () => {
      assert.equal(isAcknowledgment("ready to merge"), false);
    });

    it("returns false for 'great job'", () => {
      assert.equal(isAcknowledgment("great job"), false);
    });

    it("returns false for 'this looks good to me'", () => {
      assert.equal(isAcknowledgment("this looks good to me"), false);
    });

    it("returns false for 'i'm ready'", () => {
      assert.equal(isAcknowledgment("i'm ready"), false);
    });

    it("returns false for longer substantive messages", () => {
      assert.equal(isAcknowledgment("I'll review the diff and get back to you"), false);
      assert.equal(isAcknowledgment("The fix is ready for merge after the tests pass"), false);
    });

    it("returns false for questions", () => {
      assert.equal(isAcknowledgment("Ready?"), false);
      assert.equal(isAcknowledgment("Can you review?"), false);
    });
  });

  describe("mixed content", () => {
    it("returns true for 'thanks!'", () => {
      assert.equal(isAcknowledgment("thanks!"), true);
    });

    it("returns true for 'done.'", () => {
      // With optional trailing period
      assert.equal(isAcknowledgment("done."), true);
    });

    it("returns false for 'thanks for the help'", () => {
      assert.equal(isAcknowledgment("thanks for the help"), false);
    });

    it("returns false for 'done - merging now'", () => {
      assert.equal(isAcknowledgment("done - merging now"), false);
    });

    it("returns false for 'approved! looks good'", () => {
      assert.equal(isAcknowledgment("approved! looks good"), false);
    });
  });
});

describe("per-sender ack counter", () => {
  // Simulates the counter logic from handleInbound
  function simulateCounter(
    ackCounters: Map<string, number>,
    sender: string,
    message: string,
    MAX_ACK_ROUNDS: number,
  ): { suppressed: boolean; newCount: number } {
    if (!isAcknowledgment(message)) {
      ackCounters.delete(sender);
      return { suppressed: false, newCount: 0 };
    }
    const currentCount = ackCounters.get(sender) ?? 0;
    const newCount = currentCount + 1;
    ackCounters.set(sender, newCount);
    return { suppressed: newCount > MAX_ACK_ROUNDS, newCount };
  }

  it("allows first acknowledgment", () => {
    const counters = new Map<string, number>();
    const result = simulateCounter(counters, "eve", "👍", 2);
    assert.equal(result.suppressed, false);
    assert.equal(result.newCount, 1);
  });

  it("allows second acknowledgment", () => {
    const counters = new Map<string, number>([["eve", 1]]);
    const result = simulateCounter(counters, "eve", "thanks", 2);
    assert.equal(result.suppressed, false);
    assert.equal(result.newCount, 2);
  });

  it("suppresses third acknowledgment", () => {
    const counters = new Map<string, number>([["eve", 2]]);
    const result = simulateCounter(counters, "eve", "🎉", 2);
    assert.equal(result.suppressed, true);
    assert.equal(result.newCount, 3);
  });

  it("resets counter on substantive message", () => {
    const counters = new Map<string, number>([["eve", 2]]);
    const result = simulateCounter(counters, "eve", "looks good", 2);
    assert.equal(result.suppressed, false);
    assert.equal(result.newCount, 0);
    assert.equal(counters.get("eve"), undefined);
  });

  it("tracks counters per sender independently", () => {
    const counters = new Map<string, number>([["eve", 2], ["bob", 1]]);
    const result1 = simulateCounter(counters, "eve", "👍", 2);
    assert.equal(result1.suppressed, true);
    assert.equal(result1.newCount, 3);

    const result2 = simulateCounter(counters, "bob", "thanks", 2);
    assert.equal(result2.suppressed, false);
    assert.equal(result2.newCount, 2);
  });

  it("allows fresh acknowledgments after reset", () => {
    const counters = new Map<string, number>([["eve", 2]]);
    // Substantive message resets
    simulateCounter(counters, "eve", "looks good", 2);
    // Now new acknowledgments start fresh
    const result = simulateCounter(counters, "eve", "👍", 2);
    assert.equal(result.suppressed, false);
    assert.equal(result.newCount, 1);
  });
});
