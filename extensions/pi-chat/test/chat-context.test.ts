// Tests for the chat-context helpers exported from `index.ts`:
//   - formatRosterLine        (fixed for 2-agent case)
//   - announceRosterIfChanged (with delta≥2 mitigation)
//   - buildChatRoomSystemPrompt (with single-player gating)
//   - buildThreadPrompt       (with flipped @-mention language)
//
// These cover the four behaviour-rich additions in `index.ts`.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  formatRosterLine,
  announceRosterIfChanged,
  buildChatRoomSystemPrompt,
  buildThreadPrompt,
} from "../index-helpers.ts";
import { RecentBuffer } from "../state.ts";
import type { ChatEnv } from "../env.ts";

interface NotifyCall { text: string; level: string }
interface FakeCtx { ui: { notify: (text: string, level?: string) => void; setStatus: (k: string, t: string) => void } }
function makeCtx(): FakeCtx & { notifies: NotifyCall[] } {
  const notifies: NotifyCall[] = [];
  return {
    notifies,
    ui: {
      notify(text, level = "info") { notifies.push({ text, level }); },
      setStatus() { /* noop */ },
    },
  };
}

// --- minimal RuntimeHandle-shaped object for announceRosterIfChanged ---
interface HandleLike {
  roster: Set<string>;
  lastAnnouncedRoster: Set<string>;
  presenceDeltaSinceAnnounce: { value: number };
}
function makeHandle(): HandleLike {
  return {
    roster: new Set(),
    lastAnnouncedRoster: new Set(),
    presenceDeltaSinceAnnounce: { value: 0 },
  };
}

const BASE_ENV: ChatEnv = {
  server: "http://chat",
  room: "team",
  agent: "alice",
  autoreply: true,
  autoreplyMode: "mentions",
  history: 20,
  reconnectMs: 2000,
  cooldownMs: 2000,
  minGapMs: 5000,
  replyChainMs: 60_000,
  recentBufferSize: 20,
  threadContext: true,
  prefix: "[chat alice] ",
};

describe("formatRosterLine", () => {
  it("lists other agents with @-handles, excluding only self", () => {
    const line = formatRosterLine(new Set(["bob", "carol", "alice"]), "alice");
    assert.equal(line, "Other agents in this room: @bob, @carol");
  });

  it("returns '(only you)' when the roster is only self", () => {
    const line = formatRosterLine(new Set(["alice"]), "alice");
    assert.equal(line, "Other agents in this room: (only you)");
  });

  it("returns '(only you)' for an empty roster", () => {
    const line = formatRosterLine(new Set(), "alice");
    assert.equal(line, "Other agents in this room: (only you)");
  });

  it("keeps the inbound sender in the list (2-agent room — bug fix)", () => {
    // Regression: previously excluded both self AND inbound sender, which
    // produced "(none)" in 2-agent rooms.
    const line = formatRosterLine(new Set(["bob"]), "alice");
    assert.equal(line, "Other agents in this room: @bob");
  });

  it("sorts the listed agents alphabetically", () => {
    const line = formatRosterLine(new Set(["zoe", "alice", "bob"]), "alice");
    assert.equal(line, "Other agents in this room: @bob, @zoe");
  });
});

describe("announceRosterIfChanged", () => {
  let ctx: ReturnType<typeof makeCtx>;
  let handle: HandleLike;

  beforeEach(() => {
    ctx = makeCtx();
    handle = makeHandle();
  });

  it("emits the aggregate on a full reseed (isFullReseed=true)", () => {
    handle.roster.add("bob");
    const emitted = announceRosterIfChanged(
      ctx as unknown as ExtensionContext,
      handle as unknown as Parameters<typeof announceRosterIfChanged>[1],
      "#team",
      true,
    );
    assert.equal(emitted, true);
    assert.equal(ctx.notifies.length, 1);
    assert.match(ctx.notifies[0].text, /agents now: @bob/);
  });

  it("suppresses a single-edge presence event (delta < 2)", () => {
    handle.roster.add("bob");
    const emitted = announceRosterIfChanged(
      ctx as unknown as ExtensionContext,
      handle as unknown as Parameters<typeof announceRosterIfChanged>[1],
      "#team",
      false,
    );
    assert.equal(emitted, false);
    assert.equal(ctx.notifies.length, 0);
    // Counter increments but no emit yet.
    assert.equal(handle.presenceDeltaSinceAnnounce.value, 1);
  });

  it("emits once the delta reaches 2", () => {
    handle.roster.add("bob");
    // First edge: suppressed.
    announceRosterIfChanged(
      ctx as unknown as ExtensionContext,
      handle as unknown as Parameters<typeof announceRosterIfChanged>[1],
      "#team",
      false,
    );
    assert.equal(ctx.notifies.length, 0);
    // Second edge: emits.
    handle.roster.add("carol");
    const emitted = announceRosterIfChanged(
      ctx as unknown as ExtensionContext,
      handle as unknown as Parameters<typeof announceRosterIfChanged>[1],
      "#team",
      false,
    );
    assert.equal(emitted, true);
    assert.equal(ctx.notifies.length, 1);
    assert.match(ctx.notifies[0].text, /agents now: @bob, @carol/);
    // Counter reset.
    assert.equal(handle.presenceDeltaSinceAnnounce.value, 0);
  });

  it("dedupes: two identical full-reseed emits back-to-back emit only once", () => {
    handle.roster.add("bob");
    announceRosterIfChanged(
      ctx as unknown as ExtensionContext,
      handle as unknown as Parameters<typeof announceRosterIfChanged>[1],
      "#team",
      true,
    );
    announceRosterIfChanged(
      ctx as unknown as ExtensionContext,
      handle as unknown as Parameters<typeof announceRosterIfChanged>[1],
      "#team",
      true,
    );
    assert.equal(ctx.notifies.length, 1);
  });

  it("emits '(none connected)' when the room empties out", () => {
    handle.roster.add("bob");
    announceRosterIfChanged(
      ctx as unknown as ExtensionContext,
      handle as unknown as Parameters<typeof announceRosterIfChanged>[1],
      "#team",
      true,
    );
    ctx.notifies.length = 0; // reset
    handle.roster.clear();
    const emitted = announceRosterIfChanged(
      ctx as unknown as ExtensionContext,
      handle as unknown as Parameters<typeof announceRosterIfChanged>[1],
      "#team",
      true,
    );
    assert.equal(emitted, true);
    assert.equal(ctx.notifies.length, 1);
    assert.match(ctx.notifies[0].text, /agents now: \(none connected\)/);
  });
});

describe("buildChatRoomSystemPrompt", () => {
  it("appends the chat-room block to the existing system prompt", () => {
    const recent = new RecentBuffer(20);
    recent.record({ id: "x1", from: "bob", text: "hi", ts: 1, mentions: ["@alice"] });
    const result = buildChatRoomSystemPrompt(
      BASE_ENV,
      new Set(["bob"]),
      recent,
      true,
      "BASE PROMPT",
    );
    assert.ok(result !== undefined);
    assert.match(result!, /^BASE PROMPT\n\n## Chat room \(pi-chat\)/);
    assert.match(result!, /agent `alice` in chat room `#team`/);
    assert.match(result!, /Other agents currently in the room: @bob/);
    assert.match(result!, /address specific agents by writing `@<name>`/);
  });

  it("returns undefined on single-player turns (no recent AND autoreply off)", () => {
    const recent = new RecentBuffer(20);
    const result = buildChatRoomSystemPrompt(
      BASE_ENV,
      new Set(),
      recent,
      false,
      "BASE PROMPT",
    );
    assert.equal(result, undefined);
  });

  it("injects when autoreply is on even with no recent traffic", () => {
    const recent = new RecentBuffer(20);
    const result = buildChatRoomSystemPrompt(
      BASE_ENV,
      new Set(["bob"]),
      recent,
      true,
      "BASE",
    );
    assert.ok(result !== undefined);
    assert.match(result!, /Other agents currently in the room: @bob/);
  });

  it("injects when there's recent traffic even with autoreply off", () => {
    const recent = new RecentBuffer(20);
    recent.record({ id: "x1", from: "bob", text: "hi", ts: 1, mentions: [] });
    const result = buildChatRoomSystemPrompt(
      BASE_ENV,
      new Set(["bob"]),
      recent,
      false,
      "BASE",
    );
    assert.ok(result !== undefined);
  });

  it("renders '(no other agents connected right now)' for an empty roster", () => {
    const recent = new RecentBuffer(20);
    recent.record({ id: "x1", from: "bob", text: "hi", ts: 1, mentions: [] });
    const result = buildChatRoomSystemPrompt(
      BASE_ENV,
      new Set(),
      recent,
      true,
      "BASE",
    );
    assert.match(result!, /Other agents currently in the room: \(no other agents connected right now\)/);
  });

  it("does NOT include the redundant 'auto-prepend' or 'chat_list_agents' lines (bob's trim)", () => {
    const recent = new RecentBuffer(20);
    recent.record({ id: "x1", from: "bob", text: "hi", ts: 1, mentions: [] });
    const result = buildChatRoomSystemPrompt(
      BASE_ENV,
      new Set(["bob"]),
      recent,
      true,
      "BASE",
    );
    assert.ok(result !== undefined);
    assert.doesNotMatch(result!, /auto-prepend/);
    assert.doesNotMatch(result!, /chat_list_agents/);
  });
});

describe("buildThreadPrompt", () => {
  function buf(): RecentBuffer {
    const b = new RecentBuffer(20);
    b.record({ id: "h1", from: "bob", text: "earlier", ts: 1000, mentions: [] });
    return b;
  }

  it("includes the Message id line for replyTo correlation", () => {
    const prompt = buildThreadPrompt(
      BASE_ENV,
      buf(),
      { id: "new1", from: "carol", text: "ping", ts: 2000 },
      new Set(["bob", "carol"]),
    );
    assert.match(prompt, /Message id: new1/);
  });

  it("includes the roster line with @-handles (excluding self)", () => {
    const prompt = buildThreadPrompt(
      BASE_ENV,
      buf(),
      { id: "new1", from: "carol", text: "ping", ts: 2000 },
      new Set(["bob", "carol"]),
    );
    assert.match(prompt, /Other agents in this room: @bob, @carol/);
  });

  it("tells the LLM to write @<sender> explicitly in the reply", () => {
    const prompt = buildThreadPrompt(
      BASE_ENV,
      buf(),
      { id: "new1", from: "carol", text: "ping", ts: 2000 },
      new Set(["carol"]),
    );
    assert.match(prompt, /Reply by calling chat_send with text containing `@carol`/);
    assert.match(prompt, /meta\.replyTo: "new1"/);
  });

  it("no longer tells the LLM NOT to add the @mention (bob's flip)", () => {
    const prompt = buildThreadPrompt(
      BASE_ENV,
      buf(),
      { id: "new1", from: "carol", text: "ping", ts: 2000 },
      new Set(["carol"]),
    );
    assert.doesNotMatch(prompt, /do not add the @mention yourself/);
  });

  it("renders a shorter prompt when there's no recent history", () => {
    const empty = new RecentBuffer(20);
    const prompt = buildThreadPrompt(
      BASE_ENV,
      empty,
      { id: "first", from: "bob", text: "first!", ts: 1 },
      new Set(["bob"]),
    );
    assert.match(prompt, /NEW MESSAGE:/);
    assert.match(prompt, /Message id: first/);
    assert.match(prompt, /Other agents in this room: @bob/);
    assert.doesNotMatch(prompt, /Recent room traffic/);
  });

  it("includes recent history when present", () => {
    const prompt = buildThreadPrompt(
      BASE_ENV,
      buf(),
      { id: "new1", from: "carol", text: "ping", ts: 2000 },
      new Set(["carol"]),
    );
    assert.match(prompt, /Recent room traffic/);
    assert.match(prompt, /earlier/);
  });
});