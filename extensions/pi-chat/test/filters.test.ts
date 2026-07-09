// Layer 1 — inbound filters.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  hasMentionFor,
  mentionsAgent,
  endsWithQuestion,
  isFromSelf,
  repliesToMyMessage,
  autoReplyMatches,
  shouldAutoReply,
} from "../filters.ts";
import type { InboundMessage } from "../filters.ts";
import { readChatEnv } from "../env.ts";

function msg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: "m1",
    from: "bob",
    text: "hi",
    ts: 1,
    mentions: [],
    ...overrides,
  };
}

describe("mentionsAgent / hasMentionFor", () => {
  it("matches case-insensitively with or without leading @", () => {
    assert.equal(mentionsAgent("@Alice", "alice"), true);
    assert.equal(mentionsAgent("@alice", "ALICE"), true);
    assert.equal(mentionsAgent("Alice", "alice"), true);
    assert.equal(mentionsAgent("@bob", "alice"), false);
  });

  it("hasMentionFor scans the array", () => {
    assert.equal(hasMentionFor(["@a", "@bob"], "bob"), true);
    assert.equal(hasMentionFor([], "bob"), false);
    assert.equal(hasMentionFor(undefined as unknown as string[], "bob"), false);
    assert.equal(hasMentionFor(["bob"], ""), false); // empty agent → false
  });
});

describe("endsWithQuestion", () => {
  it("detects trailing ?", () => {
    assert.equal(endsWithQuestion("can you help?"), true);
    assert.equal(endsWithQuestion("hi?"), true);
  });
  it("ignores preceding whitespace/punctuation", () => {
    assert.equal(endsWithQuestion("really? "), true);
    assert.equal(endsWithQuestion("ok...   "), false);
  });
  it("false for non-questions", () => {
    assert.equal(endsWithQuestion("hello world"), false);
    assert.equal(endsWithQuestion(""), false);
    assert.equal(endsWithQuestion("ok"), false);
    assert.equal(endsWithQuestion("!?!?!?"), true); // trailing `?` still a question
    assert.equal(endsWithQuestion("ok?!"), true);    // trailing `?` wins over `!`
  });
});

describe("isFromSelf", () => {
  it("true when from equals agent", () => {
    assert.equal(isFromSelf(msg({ from: "alice" }), "alice"), true);
  });
  it("false otherwise", () => {
    assert.equal(isFromSelf(msg({ from: "bob" }), "alice"), false);
  });
});

describe("repliesToMyMessage", () => {
  it("true when replyTo is in our reply map", () => {
    const set = new Set(["id-42"]);
    assert.equal(repliesToMyMessage(msg({ meta: { replyTo: "id-42" } }), set), true);
    assert.equal(repliesToMyMessage(msg({ meta: { replyTo: "id-99" } }), set), false);
  });
  it("false when replyTo is missing or wrong shape", () => {
    assert.equal(repliesToMyMessage(msg(), new Set()), false);
    assert.equal(repliesToMyMessage(msg({ meta: { replyTo: 42 } }), new Set()), false);
    assert.equal(repliesToMyMessage(msg({ meta: { replyTo: null } }), new Set()), false);
  });
});

describe("autoReplyMatches (per mode)", () => {
  const agent = "alice";
  const ourIds = new Set(["mine-1"]);

  it("mentions mode: triggers on @agent or replyTo ours", () => {
    assert.equal(autoReplyMatches(msg({ mentions: ["@bob"] }), agent, "mentions", ourIds), false);
    assert.equal(autoReplyMatches(msg({ mentions: ["@Alice"] }), agent, "mentions", ourIds), true);
    assert.equal(
      autoReplyMatches(msg({ mentions: [], meta: { replyTo: "mine-1" } }), agent, "mentions", ourIds),
      true,
    );
    assert.equal(autoReplyMatches(msg({ mentions: [], text: "any text" }), agent, "mentions", ourIds), false);
  });

  it("questions mode: same as mentions OR trailing ?", () => {
    assert.equal(autoReplyMatches(msg({ text: "is this ok?" }), agent, "questions", ourIds), true);
    assert.equal(autoReplyMatches(msg({ text: "ok!" }), agent, "questions", ourIds), false);
    assert.equal(autoReplyMatches(msg({ mentions: ["@Alice"] }), agent, "questions", ourIds), true);
  });

  it("all mode: triggers on every message", () => {
    assert.equal(autoReplyMatches(msg({ mentions: [] }), agent, "all", new Set()), true);
    assert.equal(autoReplyMatches(msg({ mentions: [], text: "lol" }), agent, "all", new Set()), true);
  });
});

describe("shouldAutoReply (full gate)", () => {
  function withEnv(overrides: Partial<NodeJS.ProcessEnv>): () => void {
    const saved = { ...process.env };
    for (const k of Object.keys(overrides)) {
      if (overrides[k] === undefined) delete process.env[k];
      else process.env[k] = overrides[k] as string;
    }
    return () => {
      for (const k of Object.keys(process.env)) delete process.env[k];
      for (const [k, v] of Object.entries(saved)) {
        if (v !== undefined) process.env[k] = v;
      }
    };
  }

  it("false when autoreply disabled", () => {
    const restore = withEnv({
      PI_CHAT_AUTOREPLY: "false",
      PI_CHAT_AGENT: "alice",
    });
    try {
      const env = readChatEnv();
      assert.equal(shouldAutoReply(env, msg({ from: "bob", mentions: ["@alice"] }), new Set()), false);
    } finally { restore(); }
  });

  it("false on self-echo even if @self or ?", () => {
    const restore = withEnv({
      PI_CHAT_AUTOREPLY: "true",
      PI_CHAT_AUTOREPLY_MODE: "all",
      PI_CHAT_AGENT: "alice",
    });
    try {
      const env = readChatEnv();
      assert.equal(shouldAutoReply(env, msg({ from: "alice", mentions: ["@alice"] }), new Set()), false);
    } finally { restore(); }
  });
});
