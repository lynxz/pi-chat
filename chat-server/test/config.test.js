// Layer 1 — `lib/config.js` centralises chat-server runtime configuration.
// The goal is to confirm `loadConfig` itself behaves correctly, in
// isolation from the rest of the codebase. Per-module adoption is
// exercised by the existing integration tests on each consume site.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadConfig, CONFIG_DEFAULTS, CONFIG_ENV_KEYS } from "../lib/config.js";
import { LIMITS } from "../lib/validation.js";

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
  });

  it("bodyLimit defaults to maxTextBytes + maxMetaBytes + slack (6144)", () => {
    // `bodyLimit` is a derived field — confirm the formula matches
    // `LIMITS` so the wire limits and the HTTP cap stay in sync.
    const c = loadConfig(EMPTY_ENV);
    const expected = LIMITS.maxTextBytes + LIMITS.maxMetaBytes + CONFIG_DEFAULTS.bodySlack;
    assert.equal(c.bodyLimit, expected);
    assert.equal(c.bodyLimit, 6144); // sanity-pin: 4096 + 1024 + 1024
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

  it("parses a string env var (host)", () => {
    const c = loadConfig({ CHAT_HOST: "127.0.0.1" });
    assert.equal(c.host, "127.0.0.1");
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
});
