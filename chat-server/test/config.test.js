// Layer 1 — `lib/config.js` centralises chat-server runtime configuration.
// The goal is to confirm `loadConfig` itself behaves correctly, in
// isolation from the rest of the codebase. Per-module adoption is
// exercised by the existing integration tests on each consume site.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadConfig,
  loadConfigFromFile,
  CONFIG_DEFAULTS,
  CONFIG_ENV_KEYS,
} from "../lib/config.js";
import { parseCliArgs } from "../server.js";

/** An "empty" env: `loadConfig` falls back to defaults. */
const EMPTY_ENV = Object.freeze({});

describe("loadConfig — defaults", () => {
  it("returns sensible numeric defaults from an empty env", () => {
    const c = loadConfig(EMPTY_ENV);
    assert.equal(c.port, CONFIG_DEFAULTS.port);
    assert.equal(c.host, CONFIG_DEFAULTS.host);
    assert.equal(c.historyLimit, CONFIG_DEFAULTS.historyLimit);
    assert.equal(c.rateLimitPerSec, CONFIG_DEFAULTS.rateLimitPerSec);
    assert.equal(c.rateLimitWindowMs, CONFIG_DEFAULTS.rateLimitWindowMs);
    assert.equal(c.staleMs, CONFIG_DEFAULTS.staleMs);
    assert.equal(c.sweeperIntervalMs, CONFIG_DEFAULTS.sweeperIntervalMs);
    assert.equal(c.pingIntervalMs, CONFIG_DEFAULTS.pingIntervalMs);
    // New TLS / room-token fields default to empty string / null.
    assert.equal(c.tlsCert, "");
    assert.equal(c.tlsKey, "");
    assert.equal(c.roomTokens, null);
  });

  it("bodyLimit defaults to maxTextBytes + maxMetaBytes + slack (6144)", () => {
    // `bodyLimit` is a derived field — confirm the formula matches
    // `DEFAULTS` so the wire limits and the HTTP cap stay in sync.
    const c = loadConfig(EMPTY_ENV);
    const expected = CONFIG_DEFAULTS.maxTextBytes + CONFIG_DEFAULTS.maxMetaBytes + CONFIG_DEFAULTS.bodySlack;
    assert.equal(c.bodyLimit, expected);
    assert.equal(c.bodyLimit, 6144); // sanity-pin: 4096 + 1024 + 1024
  });

  it("exposes maxTextBytes and maxMetaBytes defaults", () => {
    const c = loadConfig(EMPTY_ENV);
    assert.equal(c.maxTextBytes, 4096);
    assert.equal(c.maxMetaBytes, 1024);
  });

  it("returns a host default of 0.0.0.0", () => {
    const c = loadConfig(EMPTY_ENV);
    assert.equal(c.host, "0.0.0.0");
  });
});

describe("loadConfig — env overrides", () => {
  it("parses integer env vars with parseIntStrict", () => {
    const c = loadConfig({
      CHAT_PORT: "9090",
      CHAT_HISTORY_LIMIT: "1000",
      CHAT_RATE_LIMIT_PER_SEC: "5",
      CHAT_RATE_LIMIT_WINDOW_MS: "2000",
      CHAT_STALE_MS: "30000",
      CHAT_SWEEPER_INTERVAL_MS: "10000",
      CHAT_PING_INTERVAL_MS: "5000",
      CHAT_MAX_BODY_BYTES: "8192",
    });
    assert.equal(c.port, 9090);
    assert.equal(c.historyLimit, 1000);
    assert.equal(c.rateLimitPerSec, 5);
    assert.equal(c.rateLimitWindowMs, 2000);
    assert.equal(c.staleMs, 30000);
    assert.equal(c.sweeperIntervalMs, 10000);
    assert.equal(c.pingIntervalMs, 5000);
    assert.equal(c.bodyLimit, 8192);
  });

  it("parses CHAT_MAX_TEXT_BYTES and CHAT_MAX_META_BYTES env vars", () => {
    const c = loadConfig({
      CHAT_MAX_TEXT_BYTES: "8192",
      CHAT_MAX_META_BYTES: "2048",
    });
    assert.equal(c.maxTextBytes, 8192);
    assert.equal(c.maxMetaBytes, 2048);
    // bodyLimit derives from the new values: 8192 + 2048 + 1024 = 11264
    assert.equal(c.bodyLimit, 11264);
  });

  it("CHAT_MAX_BODY_BYTES overrides the derived body limit independently", () => {
    const c = loadConfig({
      CHAT_MAX_TEXT_BYTES: "8192",
      CHAT_MAX_META_BYTES: "2048",
      CHAT_MAX_BODY_BYTES: "16384",
    });
    assert.equal(c.maxTextBytes, 8192);
    assert.equal(c.maxMetaBytes, 2048);
    // bodyLimit is explicitly overridden, ignoring the derivation
    assert.equal(c.bodyLimit, 16384);
  });

  it("parses a string env var (host)", () => {
    const c = loadConfig({ CHAT_HOST: "127.0.0.1" });
    assert.equal(c.host, "127.0.0.1");
  });

  it("parses TLS cert and key paths as strings (same parseString as host)", () => {
    const c = loadConfig({
      CHAT_TLS_CERT: "/etc/certs/server.crt",
      CHAT_TLS_KEY: "/etc/certs/server.key",
    });
    assert.equal(c.tlsCert, "/etc/certs/server.crt");
    assert.equal(c.tlsKey, "/etc/certs/server.key");
  });

  it("ignores garbage values (non-numeric, negative) and falls back", () => {
    // Garbage → default. This is a robustness check — env vars often come
    // from deployment templates and we don't want a typo to silently turn
    // off rate limiting or similar.
    const c = loadConfig({
      CHAT_PORT: "not-a-number",
      CHAT_HISTORY_LIMIT: "-1",
      CHAT_RATE_LIMIT_PER_SEC: "abc",
    });
    assert.equal(c.port, CONFIG_DEFAULTS.port);
    assert.equal(c.historyLimit, CONFIG_DEFAULTS.historyLimit);
    assert.equal(c.rateLimitPerSec, CONFIG_DEFAULTS.rateLimitPerSec);
  });

  it("treats empty-string env vars as unset", () => {
    const c = loadConfig({
      CHAT_PORT: "",
      CHAT_HOST: "",
      CHAT_HISTORY_LIMIT: "",
    });
    assert.equal(c.port, CONFIG_DEFAULTS.port);
    assert.equal(c.host, CONFIG_DEFAULTS.host);
    assert.equal(c.historyLimit, CONFIG_DEFAULTS.historyLimit);
  });

  it("rejects scientific notation as garbage (parseIntStrict is base-10 only)", () => {
    // Locks in the `parseIntStrict` doc-block claim that only base-10 integer
    // strings are accepted. `Number.parseInt("1e4", 10)` silently truncates
    // to 1, so without this guard a deployment-template typo could bind a
    // server to an unexpected port.
    const c = loadConfig({
      CHAT_PORT: "1e4",
      CHAT_HISTORY_LIMIT: "5e2",
    });
    assert.equal(c.port, CONFIG_DEFAULTS.port);
    assert.equal(c.historyLimit, CONFIG_DEFAULTS.historyLimit);
  });
});

describe("loadConfig — immutability", () => {
  it("returns a frozen object", () => {
    const c = loadConfig(EMPTY_ENV);
    assert.equal(Object.isFrozen(c), true);
  });

  it("rejects mutation of any field (strict mode)", () => {
    const c = loadConfig(EMPTY_ENV);
    assert.throws(() => { c.port = 9999; }, /read only|object is not extensible/);
    assert.throws(() => { c.bodyLimit = 1024; }, /read only|object is not extensible/);
  });

  it("returns a fresh object on each call (no shared mutable state)", () => {
    const a = loadConfig(EMPTY_ENV);
    const b = loadConfig(EMPTY_ENV);
    assert.notStrictEqual(a, b);
    assert.deepEqual(a, b);
  });
});

describe("CONFIG_ENV_KEYS — public surface", () => {
  it("exposes the env-var name table (so ops/tests can read it)", () => {
    // Sanity-check that the keys match the README "Configuration" table.
    // Failures here usually mean the README needs an update too.
    assert.equal(CONFIG_ENV_KEYS.port, "CHAT_PORT");
    assert.equal(CONFIG_ENV_KEYS.host, "CHAT_HOST");
    assert.equal(CONFIG_ENV_KEYS.maxTextBytes, "CHAT_MAX_TEXT_BYTES");
    assert.equal(CONFIG_ENV_KEYS.maxMetaBytes, "CHAT_MAX_META_BYTES");
    assert.equal(CONFIG_ENV_KEYS.bodyLimit, "CHAT_MAX_BODY_BYTES");
    assert.equal(CONFIG_ENV_KEYS.historyLimit, "CHAT_HISTORY_LIMIT");
    assert.equal(CONFIG_ENV_KEYS.rateLimitPerSec, "CHAT_RATE_LIMIT_PER_SEC");
    assert.equal(CONFIG_ENV_KEYS.rateLimitWindowMs, "CHAT_RATE_LIMIT_WINDOW_MS");
    assert.equal(CONFIG_ENV_KEYS.staleMs, "CHAT_STALE_MS");
    assert.equal(CONFIG_ENV_KEYS.sweeperIntervalMs, "CHAT_SWEEPER_INTERVAL_MS");
    assert.equal(CONFIG_ENV_KEYS.pingIntervalMs, "CHAT_PING_INTERVAL_MS");
  });

  it("CONFIG_ENV_KEYS is itself frozen", () => {
    assert.equal(Object.isFrozen(CONFIG_ENV_KEYS), true);
  });

  it("exposes the new TLS and room-token env-var names", () => {
    assert.equal(CONFIG_ENV_KEYS.tlsCert, "CHAT_TLS_CERT");
    assert.equal(CONFIG_ENV_KEYS.tlsKey, "CHAT_TLS_KEY");
    assert.equal(CONFIG_ENV_KEYS.roomTokens, "CHAT_ROOM_TOKENS");
  });
});

describe("loadConfig — roomTokens parsing", () => {
  it("parses valid JSON into a frozen object", () => {
    const c = loadConfig({ CHAT_ROOM_TOKENS: '{"lobby":"secret","ops":"x"}' });
    const tokens = c.roomTokens;
    assert.notEqual(tokens, null);
    assert.equal(typeof tokens, "object");
    assert.equal(tokens.lobby, "secret");
    assert.equal(tokens.ops, "x");
    assert.equal(Object.isFrozen(tokens), true);
  });

  it("returns null for invalid JSON", () => {
    const c = loadConfig({ CHAT_ROOM_TOKENS: "not json" });
    assert.equal(c.roomTokens, null);
  });

  it("returns null for an array", () => {
    const c = loadConfig({ CHAT_ROOM_TOKENS: '["a","b"]' });
    assert.equal(c.roomTokens, null);
  });

  it("returns null for a number", () => {
    const c = loadConfig({ CHAT_ROOM_TOKENS: "42" });
    assert.equal(c.roomTokens, null);
  });

  it("returns null for the string 'null'", () => {
    const c = loadConfig({ CHAT_ROOM_TOKENS: "null" });
    assert.equal(c.roomTokens, null);
  });
});

// --- loadConfigFromFile (JSON config file support) ------------------------
//
// `CHAT_CONFIG_FILE` (env var) or `--config <path>` (CLI flag) points the
// server at a JSON file. The file layers *under* process.env so the
// documented precedence is env > file > defaults. The file format mirrors
// the env-var namespace verbatim — `CHAT_PORT`, `CHAT_TLS_CERT`,
// `CHAT_ROOM_TOKENS`, etc.
describe("loadConfigFromFile", () => {
  let tmpDir;
  let tmpFiles;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "chat-cfg-"));
    tmpFiles = [];
  });
  afterEach(() => {
    for (const f of tmpFiles) {
      try { rmSync(f); } catch { /* best-effort cleanup */ }
    }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* same */ }
  });

  /** Write a JSON file under the per-test tmp dir and return its path. */
  function writeJson(obj) {
    const p = join(tmpDir, `cfg-${tmpFiles.length}.json`);
    writeFileSync(p, JSON.stringify(obj));
    tmpFiles.push(p);
    return p;
  }

  it("returns a flat env map from a valid JSON file", () => {
    const p = writeJson({ CHAT_PORT: "9090", CHAT_HOST: "127.0.0.1" });
    const merged = loadConfigFromFile(p);
    assert.equal(merged.CHAT_PORT, "9090");
    assert.equal(merged.CHAT_HOST, "127.0.0.1");
  });

  it("default baseEnv is process.env (file layered underneath)", () => {
    const p = writeJson({ CHAT_PORT: "9090" });
    const snapshot = process.env.CHAT_PORT;
    process.env.CHAT_PORT = "7777";
    try {
      const merged = loadConfigFromFile(p);
      assert.equal(merged.CHAT_PORT, "7777", "env beats file");
    } finally {
      if (snapshot === undefined) delete process.env.CHAT_PORT;
      else process.env.CHAT_PORT = snapshot;
    }
  });

  it("env beats file on key collision (explicit baseEnv)", () => {
    const p = writeJson({ CHAT_PORT: "9090", CHAT_HOST: "10.0.0.1" });
    const merged = loadConfigFromFile(p, { CHAT_PORT: "8888" });
    assert.equal(merged.CHAT_PORT, "8888", "baseEnv wins on collision");
    assert.equal(merged.CHAT_HOST, "10.0.0.1", "file still fills missing keys");
  });

  it("throws when the file does not exist (fail-fast at startup)", () => {
    assert.throws(
      () => loadConfigFromFile("/nonexistent/chat-server-config.json"),
      /cannot read/,
    );
  });

  it("throws when the file is not valid JSON", () => {
    const p = join(tmpDir, "bad.json");
    writeFileSync(p, "{not json}");
    tmpFiles.push(p);
    assert.throws(() => loadConfigFromFile(p), /invalid JSON/);
  });

  it("throws when the top-level value is not an object", () => {
    const p = writeJson([1, 2, 3]);
    assert.throws(() => loadConfigFromFile(p), /expected a JSON object/);
    const p2 = writeJson("just a string");
    assert.throws(() => loadConfigFromFile(p2), /expected a JSON object/);
    const p3 = writeJson(42);
    assert.throws(() => loadConfigFromFile(p3), /expected a JSON object/);
    const p4 = writeJson(null);
    assert.throws(() => loadConfigFromFile(p4), /expected a JSON object/);
  });

  it("coerces numbers and booleans to strings (env-var semantics)", () => {
    const p = writeJson({
      CHAT_PORT: 9090,
      CHAT_TLS_ENABLED: true,
      CHAT_TLS_DISABLED: false,
    });
    const merged = loadConfigFromFile(p);
    assert.equal(merged.CHAT_PORT, "9090");
    assert.equal(merged.CHAT_TLS_ENABLED, "true");
    assert.equal(merged.CHAT_TLS_DISABLED, "false");
  });

  it("treats null values as the empty string (env unset == \"\")", () => {
    const p = writeJson({ CHAT_HOST: null, CHAT_PORT: null });
    const merged = loadConfigFromFile(p);
    assert.equal(merged.CHAT_HOST, "");
    assert.equal(merged.CHAT_PORT, "");
  });

  it("throws on array values (use a JSON-encoded string instead)", () => {
    const p = writeJson({ CHAT_PORT: [1, 2, 3] });
    assert.throws(() => loadConfigFromFile(p), /not supported|JSON-encoded string/);
  });

  it("throws on object values (use a JSON-encoded string instead)", () => {
    const p = writeJson({ CHAT_ROOM_TOKENS: { lobby: "secret" } });
    assert.throws(() => loadConfigFromFile(p), /not supported|JSON-encoded string/);
  });

  it("CHAT_ROOM_TOKENS as a JSON-encoded string parses through loadConfig", () => {
    // The contract: file values mirror env semantics, so a nested JSON
    // object becomes a string in the merged env and `parseRoomTokens`
    // re-parses it via the same code path used for env vars.
    const tokens = { lobby: "secret", ops: "x" };
    const p = writeJson({ CHAT_ROOM_TOKENS: JSON.stringify(tokens) });
    const merged = loadConfigFromFile(p);
    const c = loadConfig(merged);
    assert.equal(c.roomTokens.lobby, "secret");
    assert.equal(c.roomTokens.ops, "x");
  });

  it("file values flow through to the final Config object", () => {
    const p = writeJson({
      CHAT_PORT: "9090",
      CHAT_HISTORY_LIMIT: "1000",
      CHAT_HOST: "127.0.0.1",
    });
    const c = loadConfig(loadConfigFromFile(p));
    assert.equal(c.port, 9090);
    assert.equal(c.historyLimit, 1000);
    assert.equal(c.host, "127.0.0.1");
  });

  it("empty object file is equivalent to no file (defaults win)", () => {
    const p = writeJson({});
    const c = loadConfig(loadConfigFromFile(p));
    assert.equal(c.port, CONFIG_DEFAULTS.port);
    assert.equal(c.host, CONFIG_DEFAULTS.host);
  });
});

// --- parseCliArgs (CLI flag surface) --------------------------------------
//
// `server.js`'s entry block parses `--config <path>` (alias `-c`) so
// operators can point at a JSON file without an env var. CLI wins over
// the env var because an explicit flag beats an ambient one.
describe("parseCliArgs", () => {
  it("returns an empty object for no flags", () => {
    assert.deepEqual(parseCliArgs([]), {});
  });

  it("parses --config <path>", () => {
    assert.deepEqual(parseCliArgs(["--config", "/etc/chat.json"]), {
      configFile: "/etc/chat.json",
    });
  });

  it("parses -c <path>", () => {
    assert.deepEqual(parseCliArgs(["-c", "/etc/chat.json"]), {
      configFile: "/etc/chat.json",
    });
  });

  it("parses --config=<path>", () => {
    assert.deepEqual(parseCliArgs(["--config=/etc/chat.json"]), {
      configFile: "/etc/chat.json",
    });
  });

  it("ignores unknown flags (forward-compat with new flags)", () => {
    assert.deepEqual(parseCliArgs(["--future-flag", "x", "--config", "/etc/chat.json"]), {
      configFile: "/etc/chat.json",
    });
  });

  it("throws when --config has no path argument", () => {
    assert.throws(() => parseCliArgs(["--config"]), /requires a path/);
  });

  it("throws when --config is followed by another flag", () => {
    // The path argument can't itself start with `--`; that's almost
    // certainly an operator mistake (e.g. swapped arg order) and we
    // want to fail loudly instead of silently dropping the path.
    assert.throws(() => parseCliArgs(["--config", "--other-flag"]), /requires a path/);
  });
});

// --- createChatServer + config-file end-to-end ---------------------------
//
// `createChatServer({ configFile })` is the runtime seam: it loads the
// file via `loadConfigFromFile` and passes the merged env into
// `loadConfig`. The factory is also the path that accepts an explicit
// `opts.configFile` (used by the CLI entry block after `parseCliArgs`).
describe("createChatServer — config-file seam", () => {
  let tmpDir;
  let tmpFiles;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "chat-cfg-e2e-"));
    tmpFiles = [];
  });
  afterEach(() => {
    for (const f of tmpFiles) {
      try { rmSync(f); } catch { /* best-effort */ }
    }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* same */ }
  });
  function writeJson(obj) {
    const p = join(tmpDir, `cfg-${tmpFiles.length}.json`);
    writeFileSync(p, JSON.stringify(obj));
    tmpFiles.push(p);
    return p;
  }

  it("throws at construction time when the file is missing (fail-fast)", async () => {
    const { createChatServer } = await import("../server.js");
    assert.throws(
      () => createChatServer({ configFile: "/nonexistent/chat.json", host: "127.0.0.1", port: 0 }),
      /cannot read/,
    );
  });

  it("applies file values when neither opts.env nor process.env disagrees", async () => {
    const { createChatServer } = await import("../server.js");
    const p = writeJson({ CHAT_HOST: "127.0.0.1", CHAT_PORT: "0" });
    // Reset any ambient env that could interfere with the assertion.
    const snapshot = { CHAT_HOST: process.env.CHAT_HOST, CHAT_PORT: process.env.CHAT_PORT };
    delete process.env.CHAT_HOST;
    delete process.env.CHAT_PORT;
    let runtime;
    try {
      runtime = createChatServer({ configFile: p });
      // start() flips the server into the listening state; shutdown()
      // needs that to call server.close() cleanly. We tear down at the
      // end to release the sweeper / ping handles.
      await runtime.start();
      assert.equal(runtime.ctx.config.host, "127.0.0.1");
      assert.equal(runtime.ctx.config.port, 0);
    } finally {
      if (runtime) await runtime.shutdown("test");
      if (snapshot.CHAT_HOST !== undefined) process.env.CHAT_HOST = snapshot.CHAT_HOST;
      if (snapshot.CHAT_PORT !== undefined) process.env.CHAT_PORT = snapshot.CHAT_PORT;
    }
  });

  it("opts.env beats file values on key collision", async () => {
    const { createChatServer } = await import("../server.js");
    const p = writeJson({ CHAT_HISTORY_LIMIT: "999" });
    let runtime;
    try {
      runtime = createChatServer({
        configFile: p,
        env: { CHAT_HISTORY_LIMIT: "42" },
      });
      await runtime.start();
      assert.equal(runtime.ctx.config.historyLimit, 42, "env beats file");
    } finally {
      if (runtime) await runtime.shutdown("test");
    }
  });
});
