// Layer 1 — `clampHistoryLimit()` plus the cross-tool/slash-command parity.
// `/chat-history` and `chat_history` both run through this helper so
// neither side can ask the server for more than the ring buffer holds.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { clampHistoryLimit, MAX_HISTORY_LIMIT } from "../limits.ts";

describe("clampHistoryLimit", () => {
  it("falls back for absent / NaN input", () => {
    assert.equal(clampHistoryLimit(undefined, 20), 20);
    assert.equal(clampHistoryLimit(null, 20), 20);
    assert.equal(clampHistoryLimit("", 20), 20);
    assert.equal(clampHistoryLimit("abc", 20), 20);
    assert.equal(clampHistoryLimit(NaN, 20), 20);
  });

  it("falls back for out-of-range (≤ 0)", () => {
    assert.equal(clampHistoryLimit(0, 20), 20);
    assert.equal(clampHistoryLimit(-3, 20), 20);
  });

  it("passes through values inside [1, MAX_HISTORY_LIMIT]", () => {
    assert.equal(clampHistoryLimit(1, 20), 1);
    assert.equal(clampHistoryLimit(50, 20), 50);
    assert.equal(clampHistoryLimit(MAX_HISTORY_LIMIT, 20), MAX_HISTORY_LIMIT);
  });

  it("clamps the upper bound", () => {
    assert.equal(clampHistoryLimit(MAX_HISTORY_LIMIT + 1, 20), MAX_HISTORY_LIMIT);
    assert.equal(clampHistoryLimit(1_000_000, 20), MAX_HISTORY_LIMIT);
  });

  it("floors fractional input", () => {
    assert.equal(clampHistoryLimit(3.7, 20), 3);
    assert.equal(clampHistoryLimit(0.99, 20), 20); // floor of < 1 → < 1, → fallback
  });

  it("parses numeric strings", () => {
    assert.equal(clampHistoryLimit("42", 20), 42);
    assert.equal(clampHistoryLimit("42.9", 20), 42);
  });
});

describe("constants", () => {
  it("MAX_HISTORY_LIMIT matches the chat-server ring buffer default", () => {
    // Server ring buffer default = 500. If the server bumps this, update here.
    assert.equal(MAX_HISTORY_LIMIT, 500);
  });
});
