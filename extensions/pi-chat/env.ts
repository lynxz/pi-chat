// PI_CHAT_* env-var reader.
//
// The reader exposes both `readChatEnv()` (single-room, kept for back-compat)
// and `readChatEnvs()` which returns one or more per-room configs. The flat
// `PI_CHAT_*` vars are preserved as a synthesised `DEFAULT` room so existing
// compose files keep working unchanged.
//
// Pure — no Pi, no fetch, no I/O. Both readers accept an `env` map (defaulting
// to `process.env`) so callers can layer a config file *under* the real env
// via `loadConfigFromFile(path, process.env)` and get the documented
// precedence "env > file > default". The wiring layer (`index.ts` →
// `runtime.ts`) decides when to load a file (via `PI_CHAT_CONFIG_FILE` or
// `options.configFile`) and surfaces the `warnings[]` array via `ctx.ui.notify`.

import { readFileSync } from "node:fs";

export type AutoReplyMode = "mentions" | "questions" | "all";

/** Numeric helper: parse a value with a default and a min. */
function envIntValue(raw: string | undefined, def: number, min: number): number {
  if (raw === undefined || raw === "") return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min) return def;
  return n;
}

/** Numeric helper: read a value from an env map, then parse. */
function envIntFromEnv(env: NodeJS.ProcessEnv, name: string, def: number, min: number): number {
  return envIntValue(env[name], def, min);
}

/** Bool helper: treat "true"/"1"/"yes" as on, everything else as off (incl. unset). */
function envBoolValue(raw: string | undefined, def: boolean): boolean {
  if (raw === undefined || raw === "") return def;
  const v = raw.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

/** Bool helper: read a value from an env map, then parse. */
function envBoolFromEnv(env: NodeJS.ProcessEnv, name: string, def: boolean): boolean {
  return envBoolValue(env[name], def);
}

/** Auto-reply boolean: `false`/`0`/`no` disable, anything else (incl. unset) enables. */
function parseAutoreply(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  return v !== "false" && v !== "0" && v !== "no";
}

/** Auto-reply mode: `mentions` (default) / `questions` / `all`. */
function parseMode(raw: string | undefined): AutoReplyMode {
  if (raw === undefined) return "mentions";
  const v = raw.trim().toLowerCase();
  return v === "all" || v === "questions" || v === "mentions" ? v : "mentions";
}

export interface ChatEnv {
  /** base URL of chat-server (e.g. "http://chat:8080") — required */
  server: string;
  /** room name — required */
  room: string;
  /** this agent's display name (unique in the room) — required */
  agent: string;
  /** whether inbound messages can be auto-injected as prompts */
  autoreply: boolean;
  /** auto-reply filter mode */
  autoreplyMode: AutoReplyMode;
  /** default cap for the chat_history tool */
  history: number;
  /** base reconnect backoff in ms */
  reconnectMs: number;
  /** per-sender cooldown window in ms */
  cooldownMs: number;
  /**
   * Wall-clock backstop between auto-reply dispatches. Default 1000ms.
   * Smaller values = more frequent back-and-forth; large values make
   * the ping-pong heuristic safer at the cost of latency.
   */
  minGapMs: number;
  /**
   * Time window during which an inbound message carrying `meta.replyTo`
   * matching one of our recent outbounds is treated as a thread reply
   * and bypasses the per-sender `cooldownMs` gate. Default 60s.
   */
  replyChainMs: number;
  /**
   * Ring buffer size (in messages) for the in-memory thread context that
   * gets prepended to inbound prompts when `threadContext` is on.
   */
  recentBufferSize: number;
  /**
   * If true (default), matching inbound messages are prefixed with the
   * recent chat room context before being handed to the agent. If false,
   * only the raw inbound message is injected.
   */
  threadContext: boolean;
  /** room-level access token for auth-protected rooms (CHAT_ROOM_TOKENS on server). Passed as Bearer token on SSE connect and POST. */
  token?: string;
  /** prefix used when echoing sent messages back into the local session */
  prefix: string;
}

/**
 * Multi-room config. `alias` is the env-var key the room was discovered
 * under (uppercased + sanitised, e.g. `BACKEND` or `DEFAULT`). The runtime
 * uses `alias` for routing tools/commands and the per-room status line;
 * `env.room` is the chat-server room name (which can differ).
 */
export interface ChatRoomConfig {
  alias: string;
  env: ChatEnv;
}

/**
 * Result of `readChatEnvs()`. `rooms` is sorted by alias (lexicographic)
 * so the runtime can pick a deterministic primary. `warnings` is a list
 * of human-readable strings the wiring layer surfaces via `ctx.ui.notify`
 * — env-var issues that don't warrant a full dormant mode (e.g. one
 * missing per-room field, a duplicate alias, both flat and prefixed
 * vars set).
 */
export interface ReadChatEnvsResult {
  rooms: ChatRoomConfig[];
  warnings: string[];
}

// --- multi-room schema ----------------------------------------------------
//
// Per-room env vars use the form: PI_CHAT_ROOM_<ALIAS>__<FIELD>
// (double-underscore separator). Double-underscore is deliberate so
// aliases can themselves contain underscores without breaking the parser
// (e.g. `PI_CHAT_ROOM_FRONT_END__ROOM=...` → alias=`FRONT_END`,
// field=`ROOM`).
//
// ALIAS rules:
//   - normalised via `normaliseAlias()` (see below)
//   - sanitised to `[A-Z0-9_]{1,32}` after uppercase
//   - env vars are case-sensitive on the *key*; we normalise the alias
//     part so `pi_chat_room_backend__room` and `PI_CHAT_ROOM_BACKEND__ROOM`
//     both bind to the same room.

const ROOM_KEY_PREFIX = "PI_CHAT_ROOM_";
const ROOM_KEY_SEPARATOR = "__";

const ROOM_FIELDS = [
  "SERVER",
  "ROOM",
  "AGENT",
  "TOKEN",
  "AUTOREPLY",
  "AUTOREPLY_MODE",
  "HISTORY",
  "RECONNECT_MS",
  "COOLDOWN_MS",
  "MIN_GAP_MS",
  "REPLY_CHAIN_MS",
  "RECENT_BUFFER",
  "THREAD_CONTEXT",
  "PREFIX",
] as const;

export type RoomField = typeof ROOM_FIELDS[number];

const REQUIRED_ROOM_FIELDS: ReadonlyArray<RoomField> = ["SERVER", "ROOM", "AGENT"];

const ROOM_FIELDS_SET: ReadonlySet<string> = new Set(ROOM_FIELDS);

/** Alias segment of a `PI_CHAT_ROOM_<alias>__<field>` env var. */
export interface ParsedRoomKey {
  rawAlias: string;
  field: RoomField;
}

/**
 * Parse an env var key of the form `PI_CHAT_ROOM_<ALIAS>__<FIELD>`. Returns
 * `null` for non-matching keys, keys with no separator, or unknown field
 * names. The prefix match is case-insensitive so operators can use
 * `pi_chat_room_backend__server` and have it bind to alias `BACKEND`.
 * The returned `rawAlias` preserves the case the operator used; the
 * runtime normalises via `normaliseAlias()` before grouping.
 */
export function parseRoomKey(key: string): ParsedRoomKey | null {
  if (key.length < ROOM_KEY_PREFIX.length) return null;
  if (key.slice(0, ROOM_KEY_PREFIX.length).toUpperCase() !== ROOM_KEY_PREFIX) return null;
  const rest = key.slice(ROOM_KEY_PREFIX.length);
  const sepIdx = rest.indexOf(ROOM_KEY_SEPARATOR);
  if (sepIdx <= 0) return null;
  const rawAlias = rest.slice(0, sepIdx);
  const fieldUpper = rest.slice(sepIdx + ROOM_KEY_SEPARATOR.length).toUpperCase();
  if (!ROOM_FIELDS_SET.has(fieldUpper)) return null;
  return { rawAlias, field: fieldUpper as RoomField };
}

/**
 * Normalise a raw alias segment to the canonical form. The transformation
 * is deterministic so `pi_chat_room_Backend__room` and
 * `PI_CHAT_ROOM_BACKEND__ROOM` bind to the same room.
 *
 * Steps:
 *   1. Uppercase.
 *   2. Replace any character outside `[A-Z0-9_]` with `_`.
 *   3. Strip leading/trailing underscores.
 *   4. Truncate to 32 characters.
 *
 * Returns `""` if the result is empty (caller should skip + warn).
 */
export function normaliseAlias(raw: string): string {
  if (raw.length === 0) return "";
  const upper = raw.toUpperCase();
  let cleaned = "";
  for (let i = 0; i < upper.length; i++) {
    const c = upper[i];
    if ((c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_") {
      cleaned += c;
    } else {
      cleaned += "_";
    }
  }
  const trimmed = cleaned.replace(/^_+|_+$/g, "");
  if (trimmed.length === 0) return "";
  return trimmed.slice(0, 32);
}

/**
 * Coerce a JSON-decoded scalar to the string shape the env-based readers
 * expect. Strings pass through; numbers / booleans stringify; `null` /
 * `undefined` become the empty string (env unset == ""). Arrays / objects
 * are rejected so operators write a JSON-encoded string (e.g. for nested
 * configs) instead of having us silently double-encode.
 */
function coerceFileValue(filePath: string, key: string, value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const kind = Array.isArray(value) ? "array" : typeof value;
  throw new Error(
    `PI_CHAT_CONFIG_FILE=${filePath}: key "${key}" is ${kind}, expected string (write a JSON-encoded string instead)`,
  );
}

/**
 * Load a JSON config file and merge its entries under `baseEnv`.
 *
 * The returned map layers the file *below* `baseEnv` so callers can hand
 * it straight to `readChatEnv(merged)` / `readChatEnvs(merged)` and get
 * the documented precedence "env > file > default" without further
 * bookkeeping. File values are coerced to strings to match env-var
 * semantics — see `coerceFileValue` for the rules.
 *
 * Failure modes (all throw, fail-fast at startup):
 *   - file does not exist or is unreadable
 *   - file contents are not valid JSON
 *   - top-level value is not a JSON object
 *   - any per-key value is an array or object
 *
 * Duplicated from `chat-server/lib/config.js` to keep both packages
 * self-contained (the project ships zero runtime deps and does not
 * share modules across the two subprojects).
 *
 * @param filePath Absolute or CWD-relative path to the JSON file.
 * @param baseEnv The env to layer the file under; `baseEnv` wins on
 *   key collision (env beats file).
 */
export function loadConfigFromFile(
  filePath: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    throw new Error(
      `PI_CHAT_CONFIG_FILE=${filePath}: cannot read: ${err.message}`,
      { cause: e },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const err = e as Error;
    throw new Error(
      `PI_CHAT_CONFIG_FILE=${filePath}: invalid JSON: ${err.message}`,
      { cause: e },
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `PI_CHAT_CONFIG_FILE=${filePath}: expected a JSON object of key=value strings`,
    );
  }
  const fileEntries: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    fileEntries[k] = coerceFileValue(filePath, k, v);
  }
  return { ...fileEntries, ...baseEnv };
}

// --- per-room resolution --------------------------------------------------

type PerRoomOverrides = Partial<Record<RoomField, string>>;

/**
 * Resolve one room's env from its per-alias overrides and the flat env
 * vars in `env` (used as per-field fallback). Returns `null` for `env` if
 * any required field is missing. Warnings are non-fatal (per-field parsing
 * issues, etc.) — currently unused but reserved for future cases (e.g.
 * unknown mode string, etc.).
 *
 * `env` is an env-shaped map (any `Record<string, string|undefined>`),
 * typically `process.env` but optionally a file-merged variant — see
 * `loadConfigFromFile`.
 */
function resolveOneRoom(
  alias: string,
  perRoom: PerRoomOverrides,
  env: NodeJS.ProcessEnv,
): { env: ChatEnv | null; warnings: string[] } {
  const warnings: string[] = [];

  const get = (field: RoomField): string | undefined =>
    perRoom[field] ?? env[flatName(field)];

  const server = (get("SERVER") ?? "").trim();
  const room = (get("ROOM") ?? "").trim();
  const agent = (get("AGENT") ?? "").trim();

  const missing: RoomField[] = [];
  if (!server) missing.push("SERVER");
  if (!room) missing.push("ROOM");
  if (!agent) missing.push("AGENT");
  if (missing.length > 0) {
    return {
      env: null,
      warnings: [`alias=${alias}: missing required field(s): ${missing.join(", ")}`],
    };
  }

  const token = (get("TOKEN") ?? "").trim() || undefined;

  const envOut: ChatEnv = {
    server,
    room,
    agent,
    token,
    autoreply: parseAutoreply(get("AUTOREPLY")),
    autoreplyMode: parseMode(get("AUTOREPLY_MODE")),
    history: envIntValue(get("HISTORY"), 20, 1),
    reconnectMs: envIntValue(get("RECONNECT_MS"), 2000, 100),
    cooldownMs: envIntValue(get("COOLDOWN_MS"), 2000, 0),
    minGapMs: envIntValue(get("MIN_GAP_MS"), 1000, 0),
    replyChainMs: envIntValue(get("REPLY_CHAIN_MS"), 60_000, 0),
    recentBufferSize: envIntValue(get("RECENT_BUFFER"), 20, 1),
    threadContext: envBoolValue(get("THREAD_CONTEXT"), true),
    prefix: (get("PREFIX") ?? "[chat {agent}]").replace(/\{agent\}/g, agent),
  };
  return { env: envOut, warnings };
}

function flatName(field: RoomField): string {
  // PI_CHAT_<FIELD> (e.g. AUTOREPLY → PI_CHAT_AUTOREPLY). Exception: ROOM
  // → PI_CHAT_ROOM and AGENT → PI_CHAT_AGENT — these happen to be
  // identical to the per-room field names, which is fine.
  return `PI_CHAT_${field}`;
}

// --- public readers -------------------------------------------------------

/**
 * Read the env into a single typed `ChatEnv`. Empty strings in required
 * vars stay `""`. Kept for back-compat with the single-room API and the
 * existing env test suite; the multi-room path uses `readChatEnvs()`.
 *
 * `env` defaults to `process.env`. Callers that have layered a config
 * file *under* the real env via `loadConfigFromFile(path, process.env)`
 * pass the merged map here so file values are visible without being
 * shadowed by anything else in `process.env`.
 */
export function readChatEnv(env: NodeJS.ProcessEnv = process.env): ChatEnv {
  return {
    server: (env.PI_CHAT_SERVER ?? "").trim(),
    room: (env.PI_CHAT_ROOM ?? "").trim(),
    agent: (env.PI_CHAT_AGENT ?? "").trim(),
    token: (env.PI_CHAT_TOKEN ?? "").trim() || undefined,
    autoreply: parseAutoreply(env.PI_CHAT_AUTOREPLY),
    autoreplyMode: parseMode(env.PI_CHAT_AUTOREPLY_MODE),
    history: envIntFromEnv(env, "PI_CHAT_HISTORY", 20, 1),
    reconnectMs: envIntFromEnv(env, "PI_CHAT_RECONNECT_MS", 2000, 100),
    cooldownMs: envIntFromEnv(env, "PI_CHAT_COOLDOWN_MS", 2000, 0),
    minGapMs: envIntFromEnv(env, "PI_CHAT_MIN_GAP_MS", 1000, 0),
    replyChainMs: envIntFromEnv(env, "PI_CHAT_REPLY_CHAIN_MS", 60_000, 0),
    recentBufferSize: envIntFromEnv(env, "PI_CHAT_RECENT_BUFFER", 20, 1),
    threadContext: envBoolFromEnv(env, "PI_CHAT_THREAD_CONTEXT", true),
    prefix: (env.PI_CHAT_PREFIX ?? "[chat {agent}]")
      .replace(/\{agent\}/g, env.PI_CHAT_AGENT ?? ""),
  };
}

/**
 * Discover every room configured via `PI_CHAT_ROOM_<ALIAS>__<FIELD>` env
 * vars, plus the synthesised `DEFAULT` room from flat `PI_CHAT_*` vars.
 *
 * Discovery rules:
 *   1. Walk `env` and group every key matching
 *      `PI_CHAT_ROOM_<ALIAS>__<FIELD>` (double-underscore separator) by
 *      its normalised alias.
 *   2. For each group, normalise the alias. Sanitised-to-empty aliases
 *      are skipped with a warning. Aliases that collide after
 *      normalisation are merged (last write wins) with a warning if any
 *      field was specified in both raw forms.
 *   3. Resolve each room via `resolveOneRoom()`. Required fields come
 *      from the per-alias overrides OR the flat env. Optional fields
 *      follow the same per-alias-then-flat layering.
 *   4. If no prefixed rooms resolved AND the flat `PI_CHAT_SERVER/ROOM/
 *      AGENT` are all set → synthesise a `DEFAULT` room from
 *      `readChatEnv(env)`.
 *   5. If both prefixed and flat are set → prefixed wins. A warning
 *      is emitted so operators know the flat vars are being used only
 *      as per-field fallback (not as their own room).
 *
 * The returned list is sorted by alias (lexicographic) so the runtime
 * can pick a deterministic primary room.
 *
 * `env` defaults to `process.env`. Callers that have layered a config
 * file *under* the real env via `loadConfigFromFile(path, process.env)`
 * pass the merged map here so file values participate in the same
 * per-alias / flat layering as env vars. File values never beat env
 * values because the merge orders file below `baseEnv`.
 */
export function readChatEnvs(env: NodeJS.ProcessEnv = process.env): ReadChatEnvsResult {
  const warnings: string[] = [];

  // 1. Discover per-alias buckets.
  const rawBuckets = new Map<string, PerRoomOverrides>();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const parsed = parseRoomKey(key);
    if (!parsed) continue;
    let bucket = rawBuckets.get(parsed.rawAlias);
    if (!bucket) {
      bucket = {};
      rawBuckets.set(parsed.rawAlias, bucket);
    }
    bucket[parsed.field] = value;
  }

  // 2. Normalise aliases and merge collisions.
  const groups = new Map<string, PerRoomOverrides>();
  for (const [rawAlias, bucket] of rawBuckets) {
    const alias = normaliseAlias(rawAlias);
    if (!alias) {
      warnings.push(
        `ignoring PI_CHAT_ROOM_${rawAlias}__*: alias is empty after sanitisation`,
      );
      continue;
    }
    if (alias !== rawAlias) {
      // Not a hard error — operators commonly use lowercase keys for
      // shell ergonomics. Just record the canonical form.
    }
    const existing = groups.get(alias);
    if (existing) {
      // Collision: same normalised alias from different raw spellings.
      for (const [k, v] of Object.entries(bucket)) {
        const field = k as RoomField;
        if (existing[field] !== undefined && existing[field] !== v) {
          warnings.push(
            `alias=${alias}: field ${field} specified under multiple raw aliases; keeping last value`,
          );
        }
        existing[field] = v;
      }
    } else {
      groups.set(alias, { ...bucket });
    }
  }

  // 3. Detect "both flat and prefixed" for the warning.
  const hasFlat =
    !!((env.PI_CHAT_SERVER ?? "").trim()) &&
    !!((env.PI_CHAT_ROOM ?? "").trim()) &&
    !!((env.PI_CHAT_AGENT ?? "").trim());
  if (groups.size > 0 && hasFlat) {
    warnings.push(
      "PI_CHAT_ROOM_* and flat PI_CHAT_* are both set; prefixed rooms take precedence and flat vars are used only as per-field fallback (no DEFAULT room is synthesised)",
    );
  }

  // 4. Resolve each prefixed room.
  const rooms: ChatRoomConfig[] = [];
  for (const alias of [...groups.keys()].sort()) {
    const bucket = groups.get(alias)!;
    const { env: roomEnv, warnings: roomWarnings } = resolveOneRoom(alias, bucket, env);
    warnings.push(...roomWarnings);
    if (roomEnv) rooms.push({ alias, env: roomEnv });
  }

  // 5. Synthesise DEFAULT from flat env if no prefixed rooms resolved.
  if (rooms.length === 0 && hasFlat) {
    rooms.push({ alias: "DEFAULT", env: readChatEnv(env) });
  }

  return { rooms, warnings };
}

/** True if any required env var is missing or empty (dormant mode). */
export function isDormant(env: ChatEnv): boolean {
  return !env.server || !env.room || !env.agent;
}

/**
 * Convenience: true if `readChatEnvs()` produced zero rooms. The wiring
 * layer can use this to enter dormant mode (one-line notify, register
 * no tools).
 */
export function isMultiRoomDormant(result: ReadChatEnvsResult): boolean {
  return result.rooms.length === 0;
}

export function describeEnv(env: ChatEnv): string {
  return [
    `server=${env.server || "<unset>"}`,
    `room=${env.room || "<unset>"}`,
    `agent=${env.agent || "<unset>"}`,
    `autoreply=${env.autoreply} (${env.autoreplyMode})`,
    `cooldown=${env.cooldownMs}ms`,
    `minGap=${env.minGapMs}ms`,
    `threadContext=${env.threadContext} (buf=${env.recentBufferSize})`,
  ].join("  ");
}
