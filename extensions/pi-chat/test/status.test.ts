// Layer 1 — `buildStatus()` covers all six footer states.
//
//   dormant        → "chat: dormant"                          (dormant mode at load)
//   offline        → "! chat: offline"                        (alert)
//   connecting     → "chat: connecting… (#room)"              (transient)
//   connected      → "chat: N in #room you=agent"
//   conflict       → "! chat: name in use (#room)"            (alert; server 409)
//   name-dormant   → "! chat: name-dormant in #room"          (alert; local)

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildStatus, buildMultiRoomStatus, applyStatus, STATUS_KEY } from "../status.ts";
import type { ClientStatus } from "../client.ts";

function status(state: ClientStatus["state"], info?: unknown): ClientStatus {
  return { state, attempts: 0, info };
}

describe("buildStatus — six footer states", () => {
  it("connecting", () => {
    const s = buildStatus(status("connecting"), "alice", "team", false);
    assert.equal(s.text, "chat: connecting… (#team)");
    assert.equal(s.alert, undefined);
  });

  it("connected with agents", () => {
    const info = { agents: [{ name: "a" }, { name: "b" }, { name: "c" }] };
    const s = buildStatus(status("connected", info), "alice", "team", false);
    assert.equal(s.text, "chat: 3 in #team you=alice");
    assert.equal(s.alert, undefined);
  });

  it("connected without agents list (defensive)", () => {
    const s = buildStatus(status("connected", undefined), "alice", "team", false);
    assert.equal(s.text, "chat: 0 in #team you=alice");
  });

  it("offline (alert)", () => {
    const s = buildStatus(status("offline"), "alice", "team", false);
    assert.equal(s.text, "! chat: offline");
    assert.equal(s.alert, true);
  });

  it("conflict (alert)", () => {
    const s = buildStatus(status("conflict"), "alice", "team", false);
    assert.equal(s.text, "! chat: name in use (#team)");
    assert.equal(s.alert, true);
  });

  it("name-dormant overrides connected state", () => {
    const info = { agents: [{ name: "a" }] };
    const s = buildStatus(status("connected", info), "alice", "team", true);
    assert.equal(s.text, "! chat: name-dormant in #team");
    assert.equal(s.alert, true);
  });

  it("unknown state falls through", () => {
    const s = buildStatus(status("offline"), "alice", "team", true);
    // name-dormant still wins for the test (alphabetical ordering of branches
    // doesn't matter — the `if (isNameDormant)` guard runs first).
    assert.equal(s.text, "! chat: name-dormant in #team");
  });

  it("include you= only when an agent name is present", () => {
    const s = buildStatus(status("connected", { agents: [] }), "", "team", false);
    assert.equal(s.text, "chat: 0 in #team");
    // The leading space before `you=` would be visible, so it's elided.
    assert.equal(s.text.includes("you="), false);
  });

  it("connected agents[] of any shape (defensive)", () => {
    // defensive: not-an-array or missing agents[] doesn't crash.
    const s = buildStatus(status("connected", { agents: "not an array" }), "alice", "team", false);
    assert.equal(s.text, "chat: 0 in #team you=alice");
    const s2 = buildStatus(status("connected", null), "alice", "team", false);
    assert.equal(s2.text, "chat: 0 in #team you=alice");
  });
});

describe("applyStatus + STATUS_KEY", () => {
  it("calls ctx.ui.setStatus with the chat key", () => {
    const calls: Array<[string, string | undefined]> = [];
    applyStatus({ ui: { setStatus: (k, v) => calls.push([k, v]) } }, { text: "hello" });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [STATUS_KEY, "hello"]);
    assert.equal(STATUS_KEY, "pi-chat");
  });

  it("swallows errors from setStatus in non-tui modes", () => {
    // setStatus throwing shouldn't blow up the wiring — there's no UI in
    // print/json modes, and the no-op fallback should be silent.
    assert.doesNotThrow(() =>
      applyStatus({ ui: { setStatus: () => { throw new Error("not a tui"); } } }, { text: "x" }),
    );
  });
});

describe("buildMultiRoomStatus", () => {
  function summary(overrides: {
    alias?: string;
    agent?: string;
    agentCount?: number;
    state?: ClientStatus["state"];
    isNameDormant?: boolean;
  }) {
    return {
      alias: overrides.alias ?? "BACKEND",
      agent: overrides.agent ?? "alice",
      agentCount: overrides.agentCount ?? 3,
      state: status(overrides.state ?? "connected"),
      isNameDormant: overrides.isNameDormant ?? false,
    };
  }

  it("emits 'you=<agent>' tag using the primary room's agent", () => {
    const out = buildMultiRoomStatus(
      [
        summary({ alias: "BACKEND", agent: "alice", agentCount: 3 }),
        summary({ alias: "INCIDENTS", agent: "alice", agentCount: 1 }),
      ],
      "BACKEND",
      "BACKEND",
    );
    assert.match(out.text, /you=alice/);
  });

  it("marks the focused room with a trailing '*'", () => {
    const out = buildMultiRoomStatus(
      [
        summary({ alias: "BACKEND", agent: "alice", agentCount: 3 }),
        summary({ alias: "INCIDENTS", agent: "alice", agentCount: 1 }),
      ],
      "BACKEND",
      "INCIDENTS",
    );
    assert.match(out.text, /backend=3, incidents=1\*/);
  });

  it("collapses to 'chat: offline' (alert) when every room is offline (all dropped)", () => {
    // buildMultiRoomStatus drops offline rooms, so passing only offline
    // rooms produces an empty `parts` array and the alert footer.
    const out = buildMultiRoomStatus(
      [
        summary({ alias: "BACKEND", state: "offline", agentCount: 0 }),
      ],
      "BACKEND",
      "BACKEND",
    );
    assert.equal(out.text, "chat: offline");
    assert.equal(out.alert, true);
  });

  it("returns 'chat: dormant' when no rooms are configured", () => {
    const out = buildMultiRoomStatus([], "DEFAULT", "DEFAULT");
    assert.equal(out.text, "chat: dormant");
    assert.equal(out.alert, true);
  });

  it("drops plain offline rooms but keeps name-dormant ones in the summary", () => {
    const out = buildMultiRoomStatus(
      [
        summary({ alias: "BACKEND", agent: "alice", agentCount: 3, state: "connected" }),
        summary({ alias: "INCIDENTS", agent: "alice", agentCount: 0, state: "offline" }),
        summary({ alias: "GHOST", agent: "alice", agentCount: 0, state: "offline", isNameDormant: true }),
      ],
      "BACKEND",
      "BACKEND",
    );
    assert.match(out.text, /backend=3/);
    assert.doesNotMatch(out.text, /incidents=/);
    assert.match(out.text, /ghost/);
  });
});
