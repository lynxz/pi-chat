// Centralised runtime configuration for chat-server.
//
// `loadConfig(env)` returns a frozen object whose values match the inline
// literals used elsewhere in the codebase byte-for-byte. Until downstream
// modules migrate to import from `config.js`, this file is a behavioural
// no-op against the inline defaults.
//
// Inputs:
//   - env vars documented in CONFIG_ENV_KEYS (see also README "Configuration")
//   - `process.env` by default; tests may pass a stub `env` for isolation
//
// The returned object is `Object.freeze`-d — consumers must build a new
// config (or override at the call site, as `createChatServer` does) to
// change values.

import { LIMITS } from "./validation.js";

/** Numeric defaults shared between env-binding and fallbacks. */
const DEFAULTS = Object.freeze({
  // Slack bytes added on top of `LIMITS.maxTextBytes + LIMITS.maxMetaBytes`
  // to derive the HTTP body cap (6144). Covers the JSON wrapper around the
  // field-pair body (`{"from":"…","text":"…","meta":{…}}`) plus a margin for
  // UTF-8 overhead between raw byte count and string length. Raise
  // `CHAT_MAX_BODY_BYTES` if your deployment accepts larger envelopes —
  // the wire validators cap text at 4096 / meta at 1024 regardless of this
  // knob unless you also widen `LIMITS.maxTextBytes` / `LIMITS.maxMetaBytes`.
  bodySlack: 1024,
  historyLimit: 500,
  rateLimitPerSec: 10,
  rateLimitWindowMs: 1_000,
  staleMs: 60_000,
  sweeperIntervalMs: 5_000,
  pingIntervalMs: 20_000,
  port: 8080,
  host: "0.0.0.0",
});

/** Env-var names. Keep aligned with README "Configuration". */
export const CONFIG_ENV_KEYS = Object.freeze({
  port: "CHAT_PORT",
  host: "CHAT_HOST",
  bodyLimit: "CHAT_MAX_BODY_BYTES",
  historyLimit: "CHAT_HISTORY_LIMIT",
  rateLimitPerSec: "CHAT_RATE_LIMIT_PER_SEC",
  rateLimitWindowMs: "CHAT_RATE_LIMIT_WINDOW_MS",
  staleMs: "CHAT_STALE_MS",
  sweeperIntervalMs: "CHAT_SWEEPER_INTERVAL_MS",
  pingIntervalMs: "CHAT_PING_INTERVAL_MS",
});

const DEFAULT_BODY_LIMIT = LIMITS.maxTextBytes + LIMITS.maxMetaBytes + DEFAULTS.bodySlack;

/** Strict base-10 integer parse; missing/garbage/non-integer → fallback.
 *
 * Only strings matching `/^-?\d+$/` are accepted. This rejects scientific
 * notation (`"1e4"` → fallback rather than `1`), decimals (`"3.14"` →
 * fallback), trailing whitespace garbage (`" 42 "` → fallback), and any
 * letter-prefixed value (`"port=8080"` → fallback). The rationale:
 * deployment-template typos should fall through to the default rather than
 * bind the server to an unexpected value. `Number.parseInt` alone is too
 * lenient — it strips `"1e4"` to `1` and `"3.14"` to `3`, both of which
 * pass `isFinite(·) && n >= 0` but don't match the field's intent.
 */
const INTEGER_RE = /^-?\d+$/;
function parseIntStrict(raw, fallback) {
  if (typeof raw !== "string" || raw === "") return fallback;
  if (!INTEGER_RE.test(raw)) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function parseString(raw, fallback) {
  if (raw == null || raw === "") return fallback;
  return String(raw);
}

/**
 * Build a frozen Config object from `env`. Values match the inline defaults
 * in the rest of the codebase byte-for-byte, so behaviour is identical when
 * no env vars are set.
 *
 * `bodyLimit` defaults to `LIMITS.maxTextBytes + LIMITS.maxMetaBytes + bodySlack`
 * (currently 6144). Override with `CHAT_MAX_BODY_BYTES` if your deployment
 * needs to accept larger payloads than the wire-spec limits imply — but
 * note the wire validators will still reject text > 4096 or meta > 1024
 * unless you also raise `LIMITS.maxTextBytes` / `LIMITS.maxMetaBytes` (which
 * are not currently env-driven; widen the wire spec first).
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {Readonly<Config>}
 */
export function loadConfig(env = process.env) {
  const bodyLimit = parseIntStrict(
    env[CONFIG_ENV_KEYS.bodyLimit],
    DEFAULT_BODY_LIMIT,
  );
  return Object.freeze({
    port: parseIntStrict(env[CONFIG_ENV_KEYS.port], DEFAULTS.port),
    host: parseString(env[CONFIG_ENV_KEYS.host], DEFAULTS.host),
    bodyLimit,
    historyLimit: parseIntStrict(env[CONFIG_ENV_KEYS.historyLimit], DEFAULTS.historyLimit),
    rateLimitPerSec: parseIntStrict(env[CONFIG_ENV_KEYS.rateLimitPerSec], DEFAULTS.rateLimitPerSec),
    rateLimitWindowMs: parseIntStrict(env[CONFIG_ENV_KEYS.rateLimitWindowMs], DEFAULTS.rateLimitWindowMs),
    staleMs: parseIntStrict(env[CONFIG_ENV_KEYS.staleMs], DEFAULTS.staleMs),
    sweeperIntervalMs: parseIntStrict(env[CONFIG_ENV_KEYS.sweeperIntervalMs], DEFAULTS.sweeperIntervalMs),
    pingIntervalMs: parseIntStrict(env[CONFIG_ENV_KEYS.pingIntervalMs], DEFAULTS.pingIntervalMs),
  });
}

/**
 * @typedef {{
 *   port: number,
 *   host: string,
 *   bodyLimit: number,
 *   historyLimit: number,
 *   rateLimitPerSec: number,
 *   rateLimitWindowMs: number,
 *   staleMs: number,
 *   sweeperIntervalMs: number,
 *   pingIntervalMs: number,
 * }} Config
 */

export const CONFIG_DEFAULTS = DEFAULTS;
