// Layer 1 — env-var reader + multi-room discovery.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  readChatEnv,
  readChatEnvs,
  isDormant,
  isMultiRoomDormant,
  describeEnv,
  normaliseAlias,
  parseRoomKey,
} from "../env.ts";

/** Snapshot env vars and restore them after each test. */
let snapshot: NodeJS.ProcessEnv;
beforeEach(() => {
  snapshot = { ...process.env };
  // Wipe every PI_CHAT_* key (flat + prefixed) for a clean slate.
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("PI_CHAT_")) delete process.env[k];
  }
});
afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  for (const [k, v] of Object.entries(snapshot)) {
    if (v !== undefined) process.env[k] = v;
  }
});

describe("readChatEnv", () => {
  it("returns empty defaults when nothing is set", () => {
    const e = readChatEnv();
    assert.equal(e.server, "");
    assert.equal(e.room, "");
    assert.equal(e.agent, "");
    assert.equal(e.autoreply, true);
    assert.equal(e.autoreplyMode, "mentions");
    assert.equal(e.history, 20);
    assert.equal(e.reconnectMs, 2000);
    assert.equal(e.cooldownMs, 2000);
  });

  it("parses required vars when present", () => {
    process.env.PI_CHAT_SERVER = "http://chat:8080";
    process.env.PI_CHAT_ROOM = "team";
    process.env.PI_CHAT_AGENT = "alice";
    const e = readChatEnv();
    assert.equal(e.server, "http://chat:8080");
    assert.equal(e.room, "team");
    assert.equal(e.agent, "alice");
  });

  it("interprets PI_CHAT_AUTOREPLY=false/0/no as disabled", () => {
    process.env.PI_CHAT_AUTOREPLY = "false";
    assert.equal(readChatEnv().autoreply, false);
    process.env.PI_CHAT_AUTOREPLY = "0";
    assert.equal(readChatEnv().autoreply, false);
    process.env.PI_CHAT_AUTOREPLY = "no";
    assert.equal(readChatEnv().autoreply, false);
    process.env.PI_CHAT_AUTOREPLY = "true";
    assert.equal(readChatEnv().autoreply, true);
    process.env.PI_CHAT_AUTOREPLY = "YES";
    assert.equal(readChatEnv().autoreply, true);
  });

  it("falls back to mentions for unknown modes", () => {
    process.env.PI_CHAT_AUTOREPLY_MODE = "unknown";
    assert.equal(readChatEnv().autoreplyMode, "mentions");
    process.env.PI_CHAT_AUTOREPLY_MODE = "questions";
    assert.equal(readChatEnv().autoreplyMode, "questions");
    process.env.PI_CHAT_AUTOREPLY_MODE = "all";
    assert.equal(readChatEnv().autoreplyMode, "all");
  });

  it("clamps numeric knobs to their minimum", () => {
    process.env.PI_CHAT_RECONNECT_MS = "0";
    assert.equal(readChatEnv().reconnectMs, 2000); // falls back to default
    process.env.PI_CHAT_HISTORY = "-5";
    assert.equal(readChatEnv().history, 20);
    process.env.PI_CHAT_COOLDOWN_MS = "garbage";
    assert.equal(readChatEnv().cooldownMs, 2000);
    process.env.PI_CHAT_RECONNECT_MS = "500";
    assert.equal(readChatEnv().reconnectMs, 500);
  });

  it("substitutes {agent} in the prefix", () => {
    process.env.PI_CHAT_AGENT = "alice";
    process.env.PI_CHAT_PREFIX = "[chat {agent}] ping";
    assert.equal(readChatEnv().prefix, "[chat alice] ping");
  });

  it("trims surrounding whitespace", () => {
    process.env.PI_CHAT_SERVER = "  http://chat:8080  ";
    process.env.PI_CHAT_ROOM = "  team  ";
    process.env.PI_CHAT_AGENT = "  alice  ";
    const e = readChatEnv();
    assert.equal(e.server, "http://chat:8080");
    assert.equal(e.room, "team");
    assert.equal(e.agent, "alice");
  });
});

describe("isDormant", () => {
  it("true when any required var is missing", () => {
    assert.equal(isDormant(readChatEnv()), true);
    process.env.PI_CHAT_SERVER = "http://chat";
    assert.equal(isDormant(readChatEnv()), true);
    process.env.PI_CHAT_ROOM = "r";
    assert.equal(isDormant(readChatEnv()), true);
    process.env.PI_CHAT_AGENT = "alice";
    assert.equal(isDormant(readChatEnv()), false);
  });
});

describe("describeEnv", () => {
  it("includes all the knobs", () => {
    process.env.PI_CHAT_SERVER = "http://chat";
    process.env.PI_CHAT_ROOM = "r";
    process.env.PI_CHAT_AGENT = "alice";
    const out = describeEnv(readChatEnv());
    for (const k of ["http://chat", "room=r", "alice", "autoreply", "cooldown"]) {
      assert.ok(out.includes(k), `expected "${k}" in ${out}`);
    }
  });
});

// --- multi-room -----------------------------------------------------------

describe("normaliseAlias", () => {
  it("uppercases and keeps [A-Z0-9_]", () => {
    assert.equal(normaliseAlias("backend"), "BACKEND");
    assert.equal(normaliseAlias("Backend"), "BACKEND");
    assert.equal(normaliseAlias("BACKEND"), "BACKEND");
  });

  it("preserves underscores", () => {
    assert.equal(normaliseAlias("front_end"), "FRONT_END");
    assert.equal(normaliseAlias("Front_End"), "FRONT_END");
  });

  it("replaces non-[A-Z0-9_] with underscores", () => {
    assert.equal(normaliseAlias("back-end"), "BACK_END");
    assert.equal(normaliseAlias("backend.team"), "BACKEND_TEAM");
    assert.equal(normaliseAlias("room 42"), "ROOM_42");
    assert.equal(normaliseAlias("a!b@c"), "A_B_C");
  });

  it("strips leading and trailing underscores", () => {
    assert.equal(normaliseAlias("__backend__"), "BACKEND");
    assert.equal(normaliseAlias("---"), "");
    assert.equal(normaliseAlias(""), "");
  });

  it("truncates to 32 characters", () => {
    const long = "A".repeat(64);
    const out = normaliseAlias(long);
    assert.equal(out.length, 32);
    assert.equal(out, "A".repeat(32));
  });

  it("returns empty string for input that sanitises to empty", () => {
    assert.equal(normaliseAlias("---"), "");
    assert.equal(normaliseAlias("!@#$%"), "");
  });
});

describe("parseRoomKey", () => {
  it("parses a valid PI_CHAT_ROOM_<ALIAS>__<FIELD> key", () => {
    assert.deepEqual(parseRoomKey("PI_CHAT_ROOM_BACKEND__SERVER"), {
      rawAlias: "BACKEND",
      field: "SERVER",
    });
    assert.deepEqual(parseRoomKey("PI_CHAT_ROOM_FRONT_END__AGENT"), {
      rawAlias: "FRONT_END",
      field: "AGENT",
    });
  });

  it("rejects the flat PI_CHAT_* namespace", () => {
    assert.equal(parseRoomKey("PI_CHAT_SERVER"), null);
    assert.equal(parseRoomKey("PI_CHAT_ROOM"), null);
    assert.equal(parseRoomKey("PI_CHAT_AGENT"), null);
  });

  it("rejects keys without the double-underscore separator", () => {
    // Single-underscore is ambiguous with the field name; require __.
    assert.equal(parseRoomKey("PI_CHAT_ROOM_BACKEND_SERVER"), null);
    assert.equal(parseRoomKey("PI_CHAT_ROOM_BACKEND"), null);
  });

  it("rejects unknown field names (case-insensitive)", () => {
    assert.equal(parseRoomKey("PI_CHAT_ROOM_BACKEND__BOGUS"), null);
    assert.equal(parseRoomKey("PI_CHAT_ROOM_BACKEND__bogus"), null);
  });

  it("rejects empty aliases", () => {
    assert.equal(parseRoomKey("PI_CHAT_ROOM___SERVER"), null);
  });

  it("is case-insensitive on the field segment too", () => {
    // Both spellings are accepted; the canonical (uppercase) form is returned.
    assert.deepEqual(parseRoomKey("PI_CHAT_ROOM_BACKEND__server"), {
      rawAlias: "BACKEND",
      field: "SERVER",
    });
    assert.deepEqual(parseRoomKey("PI_CHAT_ROOM_BACKEND__SERVER"), {
      rawAlias: "BACKEND",
      field: "SERVER",
    });
  });
});

describe("readChatEnvs", () => {
  it("returns no rooms when nothing is set", () => {
    const r = readChatEnvs();
    assert.deepEqual(r.rooms, []);
    assert.equal(isMultiRoomDormant(r), true);
  });

  it("synthesises DEFAULT from the flat env vars", () => {
    process.env.PI_CHAT_SERVER = "http://chat:8080";
    process.env.PI_CHAT_ROOM = "team";
    process.env.PI_CHAT_AGENT = "alice";
    const r = readChatEnvs();
    assert.equal(r.rooms.length, 1);
    assert.equal(r.rooms[0].alias, "DEFAULT");
    assert.equal(r.rooms[0].env.server, "http://chat:8080");
    assert.equal(r.rooms[0].env.room, "team");
    assert.equal(r.rooms[0].env.agent, "alice");
  });

  it("returns the prefixed rooms when only prefixed vars are set", () => {
    process.env.PI_CHAT_ROOM_BACKEND__SERVER = "http://chat:8080";
    process.env.PI_CHAT_ROOM_BACKEND__ROOM = "backend-team";
    process.env.PI_CHAT_ROOM_BACKEND__AGENT = "alice";
    process.env.PI_CHAT_ROOM_INCIDENTS__SERVER = "http://chat:8080";
    process.env.PI_CHAT_ROOM_INCIDENTS__ROOM = "incidents";
    process.env.PI_CHAT_ROOM_INCIDENTS__AGENT = "alice-oncall";
    const r = readChatEnvs();
    assert.equal(r.rooms.length, 2);
    // Lex-sorted: BACKEND before INCIDENTS.
    assert.equal(r.rooms[0].alias, "BACKEND");
    assert.equal(r.rooms[0].env.room, "backend-team");
    assert.equal(r.rooms[0].env.agent, "alice");
    assert.equal(r.rooms[1].alias, "INCIDENTS");
    assert.equal(r.rooms[1].env.room, "incidents");
    assert.equal(r.rooms[1].env.agent, "alice-oncall");
  });

  it("prefixed rooms win when both flat and prefixed are set; flat is fallback only", () => {
    process.env.PI_CHAT_SERVER = "http://flat:9999";
    process.env.PI_CHAT_ROOM = "flat-room";
    process.env.PI_CHAT_AGENT = "flat-agent";
    process.env.PI_CHAT_ROOM_BACKEND__SERVER = "http://chat:8080";
    process.env.PI_CHAT_ROOM_BACKEND__ROOM = "backend-team";
    // AGENT intentionally omitted — should fall back to flat PI_CHAT_AGENT.
    const r = readChatEnvs();
    assert.equal(r.rooms.length, 1);
    assert.equal(r.rooms[0].alias, "BACKEND");
    assert.equal(r.rooms[0].env.server, "http://chat:8080");
    assert.equal(r.rooms[0].env.room, "backend-team");
    assert.equal(r.rooms[0].env.agent, "flat-agent"); // fell back to flat
    assert.ok(
      r.warnings.some((w) => w.includes("both set")),
      `expected a 'both set' warning; got: ${r.warnings.join(" | ")}`,
    );
  });

  it("per-field override: prefixed _AUTOREPLY beats flat PI_CHAT_AUTOREPLY", () => {
    process.env.PI_CHAT_AUTOREPLY = "true";
    process.env.PI_CHAT_ROOM_BACKEND__SERVER = "http://chat:8080";
    process.env.PI_CHAT_ROOM_BACKEND__ROOM = "backend-team";
    process.env.PI_CHAT_ROOM_BACKEND__AGENT = "alice";
    process.env.PI_CHAT_ROOM_BACKEND__AUTOREPLY = "false";
    const r = readChatEnvs();
    assert.equal(r.rooms[0].env.autoreply, false);
  });

  it("per-field fallback: prefixed _HISTORY inherits flat PI_CHAT_HISTORY", () => {
    process.env.PI_CHAT_HISTORY = "50";
    process.env.PI_CHAT_ROOM_BACKEND__SERVER = "http://chat:8080";
    process.env.PI_CHAT_ROOM_BACKEND__ROOM = "backend-team";
    process.env.PI_CHAT_ROOM_BACKEND__AGENT = "alice";
    const r = readChatEnvs();
    assert.equal(r.rooms[0].env.history, 50);
  });

  it("substitutes {agent} in the per-room prefix", () => {
    process.env.PI_CHAT_ROOM_BACKEND__SERVER = "http://chat:8080";
    process.env.PI_CHAT_ROOM_BACKEND__ROOM = "backend-team";
    process.env.PI_CHAT_ROOM_BACKEND__AGENT = "alice";
    process.env.PI_CHAT_ROOM_BACKEND__PREFIX = "[{agent}@backend]";
    const r = readChatEnvs();
    assert.equal(r.rooms[0].env.prefix, "[alice@backend]");
  });

  it("skips a room missing a required field and warns", () => {
    process.env.PI_CHAT_ROOM_BACKEND__SERVER = "http://chat:8080";
    // ROOM and AGENT intentionally missing.
    const r = readChatEnvs();
    assert.equal(r.rooms.length, 0);
    assert.ok(
      r.warnings.some((w) => w.includes("BACKEND") && w.includes("missing")),
      `expected a 'missing' warning for BACKEND; got: ${r.warnings.join(" | ")}`,
    );
  });

  it("keeps valid rooms and skips broken ones", () => {
    process.env.PI_CHAT_ROOM_BACKEND__SERVER = "http://chat:8080";
    process.env.PI_CHAT_ROOM_BACKEND__ROOM = "backend-team";
    process.env.PI_CHAT_ROOM_BACKEND__AGENT = "alice";
    // BROKEN has only one field set.
    process.env.PI_CHAT_ROOM_BROKEN__SERVER = "http://chat:8080";
    const r = readChatEnvs();
    assert.equal(r.rooms.length, 1);
    assert.equal(r.rooms[0].alias, "BACKEND");
    assert.ok(r.warnings.some((w) => w.includes("BROKEN")));
  });

  it("normalises the alias case (lowercase env keys still resolve)", () => {
    process.env.pi_chat_room_backend__server = "http://chat:8080";
    process.env.pi_chat_room_backend__room = "backend-team";
    process.env.pi_chat_room_backend__agent = "alice";
    const r = readChatEnvs();
    assert.equal(r.rooms.length, 1);
    assert.equal(r.rooms[0].alias, "BACKEND");
  });

  it("case-insensitive: different cases of the alias collapse to one room", () => {
    // Two raw spellings — case differs, normaliseAlias uppercases both
    // to BACKENDTEAM. The merge warning is emitted when fields conflict
    // across the colliding raw spellings.
    process.env.PI_CHAT_ROOM_BackendTeam__SERVER = "http://chat:8080";
    process.env.PI_CHAT_ROOM_BackendTeam__ROOM = "team-one";
    process.env.PI_CHAT_ROOM_BACKENDTEAM__SERVER = "http://chat:8080";
    process.env.PI_CHAT_ROOM_BACKENDTEAM__ROOM = "team-two";
    process.env.PI_CHAT_ROOM_BACKENDTEAM__AGENT = "alice";
    const r = readChatEnvs();
    assert.equal(r.rooms.length, 1);
    assert.equal(r.rooms[0].alias, "BACKENDTEAM");
    assert.ok(
      r.warnings.some((w) => w.includes("BACKENDTEAM") && w.includes("multiple")),
      `expected a 'multiple raw aliases' warning; got: ${r.warnings.join(" | ")}`,
    );
  });

  it("parses per-room numeric, boolean, and mode overrides", () => {
    process.env.PI_CHAT_ROOM_BACKEND__SERVER = "http://chat:8080";
    process.env.PI_CHAT_ROOM_BACKEND__ROOM = "backend-team";
    process.env.PI_CHAT_ROOM_BACKEND__AGENT = "alice";
    process.env.PI_CHAT_ROOM_BACKEND__HISTORY = "100";
    process.env.PI_CHAT_ROOM_BACKEND__RECONNECT_MS = "500";
    process.env.PI_CHAT_ROOM_BACKEND__COOLDOWN_MS = "100";
    process.env.PI_CHAT_ROOM_BACKEND__MIN_GAP_MS = "200";
    process.env.PI_CHAT_ROOM_BACKEND__REPLY_CHAIN_MS = "30000";
    process.env.PI_CHAT_ROOM_BACKEND__RECENT_BUFFER = "50";
    process.env.PI_CHAT_ROOM_BACKEND__AUTOREPLY = "false";
    process.env.PI_CHAT_ROOM_BACKEND__AUTOREPLY_MODE = "all";
    process.env.PI_CHAT_ROOM_BACKEND__THREAD_CONTEXT = "false";
    const r = readChatEnvs();
    const env = r.rooms[0].env;
    assert.equal(env.history, 100);
    assert.equal(env.reconnectMs, 500);
    assert.equal(env.cooldownMs, 100);
    assert.equal(env.minGapMs, 200);
    assert.equal(env.replyChainMs, 30_000);
    assert.equal(env.recentBufferSize, 50);
    assert.equal(env.autoreply, false);
    assert.equal(env.autoreplyMode, "all");
    assert.equal(env.threadContext, false);
  });

  it("ignores PI_CHAT_ROOM_* keys that don't match the schema", () => {
    // Single-underscore separator is not the schema; should be ignored.
    process.env.PI_CHAT_ROOM_BACKEND_SERVER = "http://chat:8080";
    process.env.PI_CHAT_ROOM_BACKEND_ROOM = "team";
    // Unknown field name.
    process.env.PI_CHAT_ROOM_BACKEND__BOGUS = "x";
    // Flat var (not under the prefix).
    process.env.PI_CHAT_ROOM = "x"; // the singular flat ROOM, ignored
    const r = readChatEnvs();
    assert.equal(r.rooms.length, 0);
  });

  it("survives when both flat and prefixed are unset", () => {
    // Pure sanity: no env at all yields the dormant sentinel.
    const r = readChatEnvs();
    assert.equal(r.rooms.length, 0);
    assert.equal(isMultiRoomDormant(r), true);
  });
});

describe("compose-pattern fallback (docker-compose example)", () => {
  // Local beforeEach / afterEach — wipe just the PI_CHAT_* keys so the
  // surrounding describe blocks' beforeEach snapshot is unaffected.
  beforeEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("PI_CHAT_")) delete process.env[k];
    }
  });

  // Defensive test for the canonical compose shape documented in README:
  //
  //   services:
  //     pi-multi:
  //       environment:
  //         PI_CHAT_SERVER: "http://chat:8080"
  //         PI_CHAT_AGENT: "alice"
  //         PI_CHAT_COOLDOWN_MS: "2000"
  //         PI_CHAT_ROOM_BACKEND__ROOM: "backend"
  //         PI_CHAT_ROOM_INCIDENTS__ROOM: "incidents"
  //         PI_CHAT_ROOM_INCIDENTS__COOLDOWN_MS: "200"
  //
  // Each room should resolve to (server, agent) via flat fallback and
  // inherit cooldownMs=2000 from the flat. INCIDENTS' cooldownMs override
  // must take precedence on that room only. Pinned against future
  // refactors of `resolveOneRoom`.
  it("resolves per-room + flat fallback chain the way the docker-compose docs claim", () => {
    process.env.PI_CHAT_SERVER = "http://chat:8080";
    process.env.PI_CHAT_AGENT = "alice";
    process.env.PI_CHAT_COOLDOWN_MS = "2000";
    process.env.PI_CHAT_ROOM_BACKEND__ROOM = "backend";
    process.env.PI_CHAT_ROOM_INCIDENTS__ROOM = "incidents";
    process.env.PI_CHAT_ROOM_INCIDENTS__COOLDOWN_MS = "200";

    const r = readChatEnvs();
    assert.equal(r.rooms.length, 2);

    const backend = r.rooms.find((x) => x.alias === "BACKEND")!;
    assert.equal(backend.env.server, "http://chat:8080", "server from flat");
    assert.equal(backend.env.agent, "alice", "agent from flat");
    assert.equal(backend.env.room, "backend");
    assert.equal(backend.env.cooldownMs, 2000, "cooldownMs from flat (no per-room override)");

    const incidents = r.rooms.find((x) => x.alias === "INCIDENTS")!;
    assert.equal(incidents.env.server, "http://chat:8080", "server from flat");
    assert.equal(incidents.env.agent, "alice", "agent from flat");
    assert.equal(incidents.env.room, "incidents");
    assert.equal(incidents.env.cooldownMs, 200, "cooldownMs per-room override wins over flat");
  });
});
