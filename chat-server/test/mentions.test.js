// Layer 1 — mention extraction.
// Table-driven cases covering the regex spec, case-insensitivity, the email
// lookbehind rejection, and the trailing-punctuation trim.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractMentions, hasMentionFor, mentionsAgent, normalize } from "../lib/mentions.js";

describe("extractMentions (regex spec)", () => {
  const cases = [
    ["hello @alice how are you", ["@alice"]],
    ["@alice and @bob, please review", ["@alice", "@bob"]],
    ["ping @Alice", ["@Alice"]], // case preserved on the token itself
    ["send to @Charlie!", ["@Charlie"]], // trailing `!` trimmed
    ["cc @delta.", ["@delta"]], // trailing `.` trimmed
    ["(@echo)", ["@echo"]], // trailing `)` trimmed
    ["x@y.com is spam", []], // lookbehind: `@y` is inside the identifier, no match
    ["plain text with no mentions", []],
    ["emoji @🤖 no", []], // emoji is not in [A-Za-z0-9_-]
    ["multi   @a   @b   @c", ["@a", "@b", "@c"]],
    ["", []],
    ["@a_1-b", ["@a_1-b"]], // underscore + digit + dash allowed
    // length cap (1–32 chars after @). The regex is greedy *up to* 32 chars;
    // a sequence longer than 32 yields a 32-char match (the rest is dropped).
    ["too @" + "x".repeat(33), ["@" + "x".repeat(32)]], // regex caps at 32
    ["@" + "x".repeat(32), ["@" + "x".repeat(32)]], // exactly 32 chars accepted
    ["@" + "x".repeat(31) + ".", ["@" + "x".repeat(31)]], // `.` not in [A-Za-z0-9_-]
    ["one@two three", []], // lookbehind: `@two` is preceded by `one`, so it's not a mention
  ];

  for (const [input, expected] of cases) {
    it(`extracts from ${JSON.stringify(input.slice(0, 40))}`, () => {
      assert.deepEqual(extractMentions(input), expected);
    });
  }

  it("does not over-trim — punctuation already excluded by regex", () => {
    // The regex already restricts matched chars to [A-Za-z0-9_-], so the
    // trailing-punctuation trim is a no-op against in-spec input. These cases
    // assert ordinary punctuated text isn't over-extracted.
    assert.deepEqual(extractMentions("hi @eve!"), ["@eve"]);
    assert.deepEqual(extractMentions("@Alice."), ["@Alice"]);
  });

  it("does not match an empty @", () => {
    assert.deepEqual(extractMentions("text @ here"), []);
  });
});

describe("hasMentionFor / mentionsAgent (case-insensitive)", () => {
  it("matches case-insensitively", () => {
    assert.equal(hasMentionFor(["@Alice"], "alice"), true);
    assert.equal(hasMentionFor(["@alice"], "ALICE"), true);
    assert.equal(hasMentionFor(["@ALICE"], "alice"), true);
  });

  it("rejects other names", () => {
    assert.equal(hasMentionFor(["@bob"], "alice"), false);
    assert.equal(hasMentionFor([], "alice"), false);
    assert.equal(hasMentionFor(null, "alice"), false);
  });

  it("accepts tokens without the leading @", () => {
    assert.equal(hasMentionFor(["alice"], "alice"), true);
    assert.equal(hasMentionFor(["Alice"], "alice"), true);
  });

  it("mentionsAgent lowercases both sides", () => {
    assert.equal(mentionsAgent("@Alice", "alice"), true);
    assert.equal(mentionsAgent("@alice", "Alice"), true);
    assert.equal(mentionsAgent("@bob", "alice"), false);
  });

  it("normalize lowercases safely", () => {
    assert.equal(normalize("Alice"), "alice");
    assert.equal(normalize(undefined), "");
    assert.equal(normalize(null), "");
  });
});
