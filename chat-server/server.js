// chat-server. HTTP + SSE, zero dependencies.
//
// Endpoints:
//   GET    /health
//   POST   /rooms/:room/messages        → { id, ts, mentions }
//   GET    /rooms/:room/events?agent=X  (SSE)
//   GET    /rooms/:room/history?limit=N
//   GET    /rooms/:room/agents
//   POST   /rooms/:room/agents/:name/heartbeat → 204
//
// SSE event types:
//   hello, presence (joined/left), message, ping, goodbye (on shutdown)

import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { ServerState } from "./lib/state.js";
import {
  validateMessage,
  validateAgentQuery,
  validateRoomName,
  LIMITS,
} from "./lib/validation.js";
import { SseConnection } from "./lib/sse.js";
import { startStaleSweeper, stopStaleSweeper } from "./lib/sweeper.js";
import { checkRoomAccess } from "./lib/auth.js";
import { startPingScheduler, stopPingScheduler } from "./lib/ping-scheduler.js";
import { loadConfig } from "./lib/config.js";

// --- constants ------------------------------------------------------------

// Time the shutdown sequence waits for the `goodbye` frame to flush before
// closing every SSE socket. Not env-driven — this is internal sequencing,
// not a deployment tunable.
const SHUTDOWN_GOODBYE_DELAY_MS = 200;
// Hard-exit safety net for the entry-block signal handlers. Shutdown is
// expected to resolve well before this; we kill the process only on a true
// hang (e.g. a misbehaving client keeping a socket open).
const SHUTDOWN_HARD_EXIT_MS = 5_000;

// Path regexes — kept at module top so the dispatcher is purely declarative
// and the room-name capture lives in one place per route.
const HEALTH_PATH_RE = /^\/health\/?$/;
const INDEX_PATH_RE = /^\/?$/;
const MSG_PATH_RE = /^\/rooms\/([^/]+)\/messages\/?$/;
const EVENTS_PATH_RE = /^\/rooms\/([^/]+)\/events\/?$/;
const HISTORY_PATH_RE = /^\/rooms\/([^/]+)\/history\/?$/;
const AGENTS_PATH_RE = /^\/rooms\/([^/]+)\/agents\/?$/;
const HEARTBEAT_PATH_RE = /^\/rooms\/([^/]+)\/agents\/([^/]+)\/heartbeat\/?$/;

// We log a single structured line per request / event for ops.
const log = (...args) => {
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(`[${ts}]`, ...args);
};

// --- helpers --------------------------------------------------------------

/** Send a JSON response. */
function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body, "utf8"),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

/** Send `{ "error": "<code>" }`. Optional `extras` are spread into the body
 *  (used to attach `retry_after_ms` to the rate-limited response without
 *  changing the canonical `{ error }` shape). */
function jsonError(res, status, error, extras) {
  jsonResponse(res, status, extras ? { error, ...extras } : { error });
}

function notFound(res) {
  jsonError(res, 404, "not_found");
}

/** Read a JSON body up to `maxBytes`. */
function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > maxBytes) {
        req.destroy();
        reject(Object.assign(new Error("body_too_large"), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("invalid_json"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

// --- route handlers -------------------------------------------------------

function handleIndex(_req, res, _ctx, _url) {
  void _ctx; void _url;
  jsonResponse(res, 200, {
    name: "pi-chat-server",
    version: "0.1.0",
    endpoints: [
      "GET /health",
      "GET /rooms/:room/history?limit=N",
      "GET /rooms/:room/agents",
      "POST /rooms/:room/agents/:name/heartbeat",
      "GET /rooms/:room/events?agent=<name>",
      "POST /rooms/:room/messages",
    ],
  });
}

function handleHealth(_req, res, ctx, _url) {
  void _url;
  jsonResponse(res, 200, {
    ok: true,
    uptime: ctx.state.uptime(),
    rooms: ctx.state.roomCount(),
  });
}

async function handlePostMessage(req, res, ctx, _url, room) {
  void _url;
  let body;
  try {
    body = await readJsonBody(req, ctx.bodyLimit);
  } catch (e) {
    return jsonError(res, e.status ?? 400, e.message || "invalid_json");
  }

  const v = validateMessage(body, ctx.limits);
  if (!v.ok) return jsonError(res, v.status, v.error);

  let result;
  try {
    result = ctx.state.publish(room, v.value);
  } catch (e) {
    if (e.code === "AGENT_NOT_CONNECTED") {
      return jsonError(res, 400, "agent_not_connected");
    }
    if (e.code === "RATE_LIMITED") {
      // Share `{ error }` shape with the other 4xx paths; expose the rate-
      // limit window so clients can back off intelligently.
      return jsonError(res, 429, "rate_limit", {
        retry_after_ms: ctx.state.rateLimitWindowMs,
      });
    }
    throw e;
  }

  // Sender skip lives in `publish`; the wire shape comes from a single
  // serializer (`ServerState.formatMessageForSse`) so route layer and
  // state layer agree on the payload.
  const payload = ctx.state.formatMessageForSse(result.message, room);
  for (const { conn } of result.recipients) {
    conn.writeEvent("message", payload);
  }

  jsonResponse(res, 201, {
    id: result.message.id,
    ts: result.message.ts,
    mentions: result.message.mentions,
  });
}

function handleGetHistory(_req, res, ctx, url, room) {
  const limitRaw = url.searchParams.get("limit");
  let limit;
  if (limitRaw != null) {
    const parsed = Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return jsonError(res, 400, "invalid_limit");
    }
    limit = parsed;
  }
  const items = ctx.state.getHistory(room, limit);
  return jsonResponse(res, 200, items.map((m) => ({
    id: m.id, from: m.from, text: m.text, ts: m.ts,
  })));
}

function handleGetAgents(_req, res, ctx, _url, room) {
  void _url;
  jsonResponse(res, 200, ctx.state.listAgents(room));
}

function handleHeartbeat(_req, res, ctx, _url, room, agent) {
  void _url;
  const entry = ctx.state.getAgent(room, agent);
  if (!entry) return jsonError(res, 404, "agent_not_connected");
  // Bump the SSE connection's lastSeen — the sweeper reads from there.
  entry.conn.touch();
  res.writeHead(204);
  res.end();
}

function handleGetEvents(_req, res, ctx, url, room) {
  void _req;
  const agentCheck = validateAgentQuery(url.searchParams.get("agent"));
  if (!agentCheck.ok) return jsonError(res, agentCheck.status, agentCheck.error);
  const agent = agentCheck.value;

  // Conflict check *before* writing any SSE header — the 409 must still
  // arrive as a plain HTTP response, not mid-SSE-stream.
  if (ctx.state.getAgent(room, agent)) {
    return jsonError(res, 409, "agent_in_use");
  }

  const conn = new SseConnection(res, {
    onClose: () => {
      // Only act if we're still the registered holder. A second joiner that
      // briefly existed and closed shouldn't unsplice ourselves on their
      // behalf — but that can't happen because we 409 above, so this is
      // defence-in-depth.
      const stillHere = ctx.state.getAgent(room, agent)?.conn === conn;
      if (!stillHere) return;
      ctx.state.removeAgent(room, agent);
      ctx.state.broadcast(
        room,
        "presence",
        { agent, action: "left", at: Date.now() },
        agent,
      );
      ctx._log("sse.close", { room, agent });
    },
  });

  ctx.state.addAgent(room, agent, conn);

  // The very first thing the new client sees.
  conn.writeEvent("hello", {
    agent,
    room,
    agents: ctx.state.listAgents(room),
  });

  // Tell the rest of the room.
  ctx.state.broadcast(
    room,
    "presence",
    { agent, action: "joined", at: Date.now() },
    agent,
  );

  ctx._log("sse.open", { room, agent });
  // The connection stays open until `res.on("close")` fires the onClose hook.
}

// --- dispatcher -----------------------------------------------------------

/**
 * Route table. Each entry says: for this HTTP method + path regex, hand off
 * to this handler with `(req, res, ctx, url, ...captures)`. Path regexes are
 * module-level constants so the capture group positions are stable.
 *
 * Handlers uniformly receive `(req, res, ctx, url, ...captures)` — the room
 * (if any) is always the first capture and the agent (if any) is the
 * second, so handlers that don't need `url` or `agent` can ignore them.
 * Room and agent-name validation happen once in the dispatcher against
 * `m[1]` / `m[2]`.
 *
 * The dispatcher runs the first matching route in declaration order, so
 * register more specific paths above generic ones (in practice they don't
 * conflict because the regexes are disjoint).
 */
const ROUTES = [
  { method: "GET",  re: HEALTH_PATH_RE,    handler: handleHealth },
  { method: "GET",  re: INDEX_PATH_RE,     handler: handleIndex },
  { method: "POST", re: MSG_PATH_RE,       validateRoom: true, requireAuth: true, handler: handlePostMessage },
  { method: "GET",  re: EVENTS_PATH_RE,    validateRoom: true, requireAuth: true, handler: handleGetEvents },
  { method: "GET",  re: HISTORY_PATH_RE,   validateRoom: true, handler: handleGetHistory },
  { method: "GET",  re: AGENTS_PATH_RE,    validateRoom: true, handler: handleGetAgents },
  {
    method: "POST",
    re: HEARTBEAT_PATH_RE,
    validateRoom: true,
    validateAgent: true,
    handler: handleHeartbeat,
  },
];

function dispatch(req, res, ctx, url, method, path) {
  ctx._log("request", { method, path });
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const m = path.match(route.re);
    if (!m) continue;
    if (route.validateRoom) {
      const v = validateRoomName(m[1]);
      if (!v.ok) return jsonError(res, 400, "invalid_room");
    }
    if (route.validateAgent) {
      const v = validateAgentQuery(m[2]);
      if (!v.ok) return jsonError(res, v.status, v.error);
    }
    if (route.requireAuth) {
      const auth = checkRoomAccess(ctx.config, m[1], req);
      if (!auth.ok) return jsonError(res, auth.status, auth.error);
    }
    // Hand off with uniform signature: (req, res, ctx, url, ...captures).
    return route.handler(req, res, ctx, url, ...m.slice(1));
  }
  notFound(res);
}

// --- factory --------------------------------------------------------------

/**
 * Build a chat-server runtime (handlers + http server) bound to its own
 * private state. Returns `{ server, ctx, route, start, shutdown }`.
 *
 * Configuration resolution order (highest priority first):
 *   1. `opts` (per-call override — used by tests)
 *   2. `env` passed via `opts.env` (defaults to `process.env`)
 *   3. Defaults (frozen `Config` from `lib/config.js`)
 *
 * The per-call `env` parameter is plumbed through to `loadConfig()` so test
 * suites can isolate env binding without polluting `process.env`.
 *
 * @param {{
 *   env?: Record<string, string|undefined>,  // override env for testing
 *   port?: number,
 *   host?: string,
 *   maxTextBytes?: number,
 *   maxMetaBytes?: number,
 *   bodyLimit?: number,
 *   historyLimit?: number,
 *   rateLimitPerSec?: number,
 *   rateLimitWindowMs?: number,
 *   staleMs?: number,
 *   sweeperIntervalMs?: number,
 *   pingIntervalMs?: number,
 *   quiet?: boolean,            // suppress request logging (used by tests)
 *   staleSweeper?: boolean,     // false → disable the sweeper (test hook)
 *   pingScheduler?: boolean,    // false → disable the pinger (test hook)
 * }} [opts]
 *
 * @example
 *   // Bind env from a stub object (no `process.env` mutation):
 *   createChatServer({ env: { CHAT_PORT: "0", CHAT_STALE_MS: "500" } })
 */
export function createChatServer(opts = {}) {
  const env = opts.env ?? process.env;
  const config = loadConfig(env);

  const port = opts.port ?? config.port;
  const host = opts.host ?? config.host;
  const maxTextBytes = opts.maxTextBytes ?? config.maxTextBytes;
  const maxMetaBytes = opts.maxMetaBytes ?? config.maxMetaBytes;
  const bodyLimit = opts.bodyLimit ?? config.bodyLimit;
  const historyLimit = opts.historyLimit ?? config.historyLimit;
  const rateLimitPerSec = opts.rateLimitPerSec ?? config.rateLimitPerSec;
  const rateLimitWindowMs = opts.rateLimitWindowMs ?? config.rateLimitWindowMs;
  const staleMs = opts.staleMs ?? config.staleMs;
  const sweeperIntervalMs = opts.sweeperIntervalMs ?? config.sweeperIntervalMs;
  const pingIntervalMs = opts.pingIntervalMs ?? config.pingIntervalMs;

  const limits = {
    maxTextBytes,
    maxMetaBytes,
    IDENT_RE: LIMITS.IDENT_RE,
  };

  const ctx = {
    state: new ServerState({
      historyLimit,
      rateLimitPerSec,
      rateLimitWindowMs,
    }),
    limits,
    bodyLimit,
    config,
    _log: opts.quiet ? () => {} : log,
  };
  // Note: pingIntervalMs must be < staleMs / 2 for the ping to keep
  // idle connections ahead of the sweeper. Defaults satisfy this
  // (20000ms ping, 60000ms stale).

  const handler = (req, res) => {
    Promise.resolve(route(req, res, ctx)).catch((err) => {
      ctx._log("unhandled", err?.stack ?? err);
      if (!res.headersSent) {
        jsonError(res, 500, "internal_error");
      } else {
        // Mid-stream error (most often an open SSE). End the response
        // best-effort and forcibly destroy the socket so the client
        // observes the close instead of a silently-half-open stream.
        try { res.end(); } catch { /* socket already gone */ }
        try { res.destroy(); } catch { /* same */ }
      }
    });
  };

  /** @type {import("node:http").Server | import("node:https").Server} */
  let server;
  if (config.tlsCert && config.tlsKey) {
    try {
      const cert = readFileSync(config.tlsCert, "utf8");
      const key = readFileSync(config.tlsKey, "utf8");
      server = createSecureServer({ cert, key }, handler);
    } catch (e) {
      throw new Error(
        `TLS configured but cert/key file(s) unreadable — ` +
        `cert=${config.tlsCert} key=${config.tlsKey}: ${e.message}`,
        { cause: e },
      );
    }
  } else {
    server = createServer(handler);
  }

  let shuttingDown = false;
  // Stale-SSE sweeper: closes silent connections after `staleMs` (default 60s)
  // and lets SseConnection.onClose() handle presence cleanup.
  let sweeperHandle = null;
  if (opts.staleSweeper !== false) {
    sweeperHandle = startStaleSweeper(ctx.state, {
      intervalMs: sweeperIntervalMs,
      staleMs,
    });
  }

  // Ping scheduler: writes a `: ping` comment frame to every open
  // SSE on a shorter cadence than `staleMs`. Keeps idle-but-healthy
  // connections alive instead of cycling close/reconnect with the sweeper.
  let pingHandle = null;
  if (opts.pingScheduler !== false) {
    pingHandle = startPingScheduler(ctx.state, {
      intervalMs: pingIntervalMs,
    });
  }

  /**
   * Graceful shutdown. Single-exit Promise — no side-effect `process.exit`
   * (the entry block owns that). Stops schedulers, sends a `goodbye`
   * frame to every open SSE, gives it a beat to flush, then closes every
   * connection and waits for the underlying http server to drain.
   *
   * @param {string} signal
   * @returns {Promise<void>}
   */
  function shutdown(signal = "manual") {
    if (shuttingDown) return Promise.resolve();
    shuttingDown = true;
    ctx._log("shutdown", { signal });

    // Stop the ping scheduler *before* the stale sweeper. Otherwise
    // the pinger can write a frame into a connection the sweeper is
    // about to close, producing noisy log entries and a visible-but-
    // benign race during teardown.
    stopPingScheduler(pingHandle);
    pingHandle = null;
    stopStaleSweeper(sweeperHandle);
    sweeperHandle = null;

    // Tell every agent we're going away. The `goodbye` frame lets
    // clients reset backoff.
    let agentCount = 0;
    for (const [, room] of ctx.state.rooms) {
      for (const [, entry] of room.agents) {
        entry.conn.writeEvent("goodbye", { reason: "shutdown" });
        agentCount++;
      }
    }
    ctx._log("shutdown.goodbye", { agents: agentCount });

    return new Promise((resolve, reject) => {
      // Wait for the goodbye to flush before tearing down the sockets.
      // Reference the timer so it can't be reaped before firing — Node's
      // test runner would otherwise see an unresolved Promise.
      setTimeout(() => {
        for (const [, room] of ctx.state.rooms) {
          for (const [, entry] of room.agents) {
            entry.conn.close();
          }
        }
        server.close((err) => {
          if (err) return reject(err);
          ctx._log("shutdown.done");
          resolve();
        });
      }, SHUTDOWN_GOODBYE_DELAY_MS);
    });
  }

  async function start() {
    return new Promise((resolve) => {
      server.listen(port, host, () => {
        ctx._log("listening", { host, port, historyLimit, tls: !!(config.tlsCert && config.tlsKey) });
        resolve(server.address());
      });
    });
  }

  function route(req, res, ctx2) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    return dispatch(req, res, ctx2, url, req.method ?? "GET", url.pathname);
  }

  return { server, ctx, route: (req, res) => route(req, res, ctx), start, shutdown };
}

// --- entry (only when run directly) ---------------------------------------

const _isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (_isMain) {
  // Entry reads config from env (no opts override — the env is the source
  // of truth for production). The entry block also owns `process.exit`;
  // `shutdown()` is a clean Promise so tests can await it without
  // triggering an exit. The `SHUTDOWN_HARD_EXIT_MS` timer is the safety
  // net for a true hang.
  const runtime = createChatServer();
  runtime.start();
  const onSignal = (sig) => {
    const hardExit = setTimeout(() => process.exit(1), SHUTDOWN_HARD_EXIT_MS);
    runtime.shutdown(sig)
      .then(() => { clearTimeout(hardExit); process.exit(0); })
      .catch((err) => {
        clearTimeout(hardExit);
        // eslint-disable-next-line no-console
        console.error(err);
        process.exit(1);
      });
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
}
