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
//
// `loadConfigFromFile(path, baseEnv)` layers a JSON config file under
// `baseEnv` so callers can pass the result to `loadConfig` and get the
// documented precedence: env vars > file > defaults. The file's keys
// must use the same names as the env vars in CONFIG_ENV_KEYS.
//
// Both `CHAT_CONFIG_FILE` (env var) and `--config <path>` (CLI flag on
// `server.js`) point the entry layer at a file. Missing / unreadable /
// malformed files fail fast — the operator should see the error at
// startup, not at the first request that depends on a missing key.

import { readFileSync } from "node:fs";
import { LIMITS } from "./validation.js";

/** Numeric defaults shared between env-binding and fallbacks.
 *
 * `maxTextBytes` and `maxMetaBytes` mirror `LIMITS` from `validation.js`
 * and are the defaults for the wire-spec field caps. Override them with
 * `CHAT_MAX_TEXT_BYTES` / `CHAT_MAX_META_BYTES` to widen the limits.
 * `bodyLimit` is derived: `maxTextBytes + maxMetaBytes + bodySlack`.
 *
 * `bodySlack` covers the JSON wrapper around the field-pair body
 * (`{"from":"…","text":"…","meta":{…}}`) plus a margin for UTF-8
 * overhead between raw byte count and string length.
 */
const DEFAULTS = Object.freeze({
  maxTextBytes: 4096,
  maxMetaBytes: 1024,
  bodySlack: 1024,
  historyLimit: 500,
  rateLimitPerSec: 10,
  rateLimitWindowMs: 1_000,
  staleMs: 60_000,
  sweeperIntervalMs: 5_000,
  pingIntervalMs: 20_000,
  port: 8080,
  host: "0.0.0.0",
  tlsCert: "",
  tlsKey: "",
  roomTokens: null,
});

/** Env-var names. Keep aligned with README "Configuration". */
export const CONFIG_ENV_KEYS = Object.freeze({
  port: "CHAT_PORT",
  host: "CHAT_HOST",
  maxTextBytes: "CHAT_MAX_TEXT_BYTES",
  maxMetaBytes: "CHAT_MAX_META_BYTES",
  bodyLimit: "CHAT_MAX_BODY_BYTES",
  historyLimit: "CHAT_HISTORY_LIMIT",
  rateLimitPerSec: "CHAT_RATE_LIMIT_PER_SEC",
  rateLimitWindowMs: "CHAT_RATE_LIMIT_WINDOW_MS",
  staleMs: "CHAT_STALE_MS",
  sweeperIntervalMs: "CHAT_SWEEPER_INTERVAL_MS",
  pingIntervalMs: "CHAT_PING_INTERVAL_MS",
  tlsCert: "CHAT_TLS_CERT",
  tlsKey: "CHAT_TLS_KEY",
  roomTokens: "CHAT_ROOM_TOKENS",
});

const DEFAULT_BODY_LIMIT = DEFAULTS.maxTextBytes + DEFAULTS.maxMetaBytes + DEFAULTS.bodySlack;

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
 * Coerce a JSON-decoded scalar to the string shape `loadConfig` expects.
 *
 * Strings pass through. Numbers / booleans are stringified so a file like
 * `{"CHAT_PORT": 8080}` works the same as `CHAT_PORT=8080` in the env.
 * `null` / `undefined` become the empty string — the same convention as
 * env vars (`unset == ""`). Arrays / objects are rejected: a config file
 * is meant to mirror env-var semantics, and `CHAT_ROOM_TOKENS` in
 * particular must be a JSON-encoded string so `parseRoomTokens` can
 * re-parse it via the same code path used for env vars.
 */
function coerceFileValue(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // Arrays / objects / other shapes: refuse rather than silently stringify.
  // Telling the operator "write a JSON-encoded string" is kinder than
  // stringifying an object and then failing the JSON.parse downstream.
  const kind = Array.isArray(value) ? "array" : typeof value;
  throw new Error(`CHAT_CONFIG_FILE: value of type ${kind} is not supported (write a JSON-encoded string instead)`);
}

/**
 * Load a JSON config file and merge its entries under `baseEnv`.
 *
 * The returned object layers the file at the bottom of the precedence
 * chain (`baseEnv` wins on key collision), so callers can hand it
 * straight to `loadConfig(merged)` and get the documented rule
 * "env > file > default" with no extra bookkeeping.
 *
 * Behaviour:
 *   - File missing or unreadable → throws (fail fast at startup).
 *   - File present but not valid JSON → throws.
 *   - Top-level JSON value is not an object → throws.
 *   - Per-key value is an array or object → throws (use a string).
 *   - Per-key value is `null` / `undefined` → empty string (treat as unset).
 *   - Per-key value is a number / boolean → coerced via `String(value)`.
 *
 * @param {string} filePath Absolute or CWD-relative path to the JSON file.
 * @param {Record<string, string|undefined>} [baseEnv=process.env] The env
 *   to layer the file under. `baseEnv` wins on key collision (env beats file).
 * @returns {Record<string, string|undefined>}
 */
export function loadConfigFromFile(filePath, baseEnv = process.env) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (e) {
    throw new Error(
      `CHAT_CONFIG_FILE=${filePath}: cannot read: ${e.message}`,
      { cause: e },
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `CHAT_CONFIG_FILE=${filePath}: invalid JSON: ${e.message}`,
      { cause: e },
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `CHAT_CONFIG_FILE=${filePath}: expected a JSON object of key=value strings`,
    );
  }
  const fileEntries = {};
  for (const [k, v] of Object.entries(parsed)) {
    fileEntries[k] = coerceFileValue(v);
  }
  // `baseEnv` wins on key collision. `{ ...fileEntries, ...baseEnv }`
  // is the standard "lower-priority first" merge pattern.
  return { ...fileEntries, ...baseEnv };
}

/** Parse CHAT_ROOM_TOKENS from its raw env string into a frozen plain object.
 *
 * Only plain (non-array) objects survive — arrays, primitives, and invalid
 * JSON all fall back to `null`. The returned object is `Object.freeze`-d so
 * consumers cannot accidentally mutate the token map at runtime.
 *
 * @param {string|undefined} raw
 * @returns {Readonly<Record<string,string>> | null}
 */
function parseRoomTokens(raw) {
  if (raw == null || raw === "") return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return Object.freeze(parsed);
  } catch {
    return null;
  }
}

/**
 * Build a frozen Config object from `env`. Values match the inline defaults
 * in the rest of the codebase byte-for-byte, so behaviour is identical when
 * no env vars are set.
 *
 * `maxTextBytes` / `maxMetaBytes` default to 4096 / 1024 and can be widened
 * via `CHAT_MAX_TEXT_BYTES` / `CHAT_MAX_META_BYTES`. `bodyLimit` is derived
 * from them: `maxTextBytes + maxMetaBytes + bodySlack` (default 6144).
 * Set `CHAT_MAX_BODY_BYTES` to override the derived body cap independently
 * (useful when you widen the field limits without recalculating).
 *
 * To layer a JSON config file *under* the env vars, run the file through
 * `loadConfigFromFile(path, process.env)` and pass the result as `env`.
 * Missing / unreadable / malformed files fail fast at the call site — see
 * `loadConfigFromFile` for the exact contract.
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {Readonly<Config>}
 */
export function loadConfig(env = process.env) {
  const maxTextBytes = parseIntStrict(
    env[CONFIG_ENV_KEYS.maxTextBytes],
    DEFAULTS.maxTextBytes,
  );
  const maxMetaBytes = parseIntStrict(
    env[CONFIG_ENV_KEYS.maxMetaBytes],
    DEFAULTS.maxMetaBytes,
  );
  const bodyLimit = parseIntStrict(
    env[CONFIG_ENV_KEYS.bodyLimit],
    maxTextBytes + maxMetaBytes + DEFAULTS.bodySlack,
  );
  return Object.freeze({
    port: parseIntStrict(env[CONFIG_ENV_KEYS.port], DEFAULTS.port),
    host: parseString(env[CONFIG_ENV_KEYS.host], DEFAULTS.host),
    maxTextBytes,
    maxMetaBytes,
    bodyLimit,
    historyLimit: parseIntStrict(env[CONFIG_ENV_KEYS.historyLimit], DEFAULTS.historyLimit),
    rateLimitPerSec: parseIntStrict(env[CONFIG_ENV_KEYS.rateLimitPerSec], DEFAULTS.rateLimitPerSec),
    rateLimitWindowMs: parseIntStrict(env[CONFIG_ENV_KEYS.rateLimitWindowMs], DEFAULTS.rateLimitWindowMs),
    staleMs: parseIntStrict(env[CONFIG_ENV_KEYS.staleMs], DEFAULTS.staleMs),
    sweeperIntervalMs: parseIntStrict(env[CONFIG_ENV_KEYS.sweeperIntervalMs], DEFAULTS.sweeperIntervalMs),
    pingIntervalMs: parseIntStrict(env[CONFIG_ENV_KEYS.pingIntervalMs], DEFAULTS.pingIntervalMs),
    tlsCert: parseString(env[CONFIG_ENV_KEYS.tlsCert], DEFAULTS.tlsCert),
    tlsKey: parseString(env[CONFIG_ENV_KEYS.tlsKey], DEFAULTS.tlsKey),
    roomTokens: parseRoomTokens(env[CONFIG_ENV_KEYS.roomTokens]),
  });
}

/**
 * @typedef {{
 *   port: number,
 *   host: string,
 *   maxTextBytes: number,
 *   maxMetaBytes: number,
 *   bodyLimit: number,
 *   historyLimit: number,
 *   rateLimitPerSec: number,
 *   rateLimitWindowMs: number,
 *   staleMs: number,
 *   sweeperIntervalMs: number,
 *   pingIntervalMs: number,
 *   tlsCert: string,
 *   tlsKey: string,
 *   roomTokens: Readonly<Record<string,string>> | null,
 * }} Config
 */

export const CONFIG_DEFAULTS = DEFAULTS;
