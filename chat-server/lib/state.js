// In-memory server state.
//
//   rooms: Map<roomName, Room>
//   Room: {
//     agents: Map<agentName, { conn: SseConnection, since: number, lastSeen: number }>
//     history: RingBuffer<Message>
//   }
//
// `agents` is keyed by agentName. A second SSE connect for an already-bound
// name silently no-ops at the state layer; the HTTP layer's `handleGetEvents`
// owns the 409 mapping (single source of truth, no duplicate defence).
//
// `publishTimestamps` is cleared per-agent on `removeAgent` so disconnected
// agents don't leak one slot per churn event in long-running servers.
//
// `publish()` fans out to every connected agent in the room, skipping the
// sender (`from`) — clients also self-filter as defence-in-depth net.

import { randomUUID } from "node:crypto";
import { extractMentions } from "./mentions.js";

/** Bounded ring buffer. `push` evicts the oldest entry once full. */
export class RingBuffer {
  constructor(limit) {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new TypeError(`RingBuffer limit must be a positive integer, got ${limit}`);
    }
    this.limit = limit;
    /** @type {any[]} */
    this.items = [];
  }
  push(item) {
    this.items.push(item);
    if (this.items.length > this.limit) this.items.shift();
  }
  /** Snapshot. Optional `limit` returns only the most recent N. */
  snapshot(limit) {
    if (limit == null) return this.items.slice();
    if (!Number.isInteger(limit) || limit <= 0) return [];
    return this.items.slice(-limit);
  }
  get size() {
    return this.items.length;
  }
}

/**
 * One room. The per-room rate-limit config lives on the owning `ServerState`
 * (single source of truth) — `Room` keeps a back-reference instead of taking
 * rate-limit fields in its constructor.
 */
export class Room {
  /**
   * @param {{ historyLimit: number }} opts
   * @param {ServerState} serverState
   */
  constructor({ historyLimit }, serverState) {
    /** @type {Map<string, { conn: import("./sse.js").SseConnection, since: number }>} */
    this.agents = new Map();
    this.history = new RingBuffer(historyLimit);
    /** @type {Map<string, number[]>} rolling publish-timestamp window per agent */
    this.publishTimestamps = new Map();
    this._state = serverState;
  }
}

export class ServerState {
  /**
   * @param {{
   *   historyLimit?: number,
   *   rateLimitPerSec?: number,
   *   rateLimitWindowMs?: number,
   * }} [opts]
   */
  constructor({
    historyLimit = 500,
    rateLimitPerSec = 10,
    rateLimitWindowMs = 1000,
  } = {}) {
    this.historyLimit = historyLimit;
    this.rateLimitPerSec = rateLimitPerSec;
    this.rateLimitWindowMs = rateLimitWindowMs;
    this.bootTime = Date.now();
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
  }

  /** @returns {Room} */
  getOrCreate(roomName) {
    let r = this.rooms.get(roomName);
    if (!r) {
      r = new Room({ historyLimit: this.historyLimit }, this);
      this.rooms.set(roomName, r);
    }
    return r;
  }

  /** @returns {Room | undefined} */
  get(roomName) {
    return this.rooms.get(roomName);
  }

  /**
   * Bind an SSE connection to an agent name in a room. Silently no-ops when
   * the name is already bound — `handleGetEvents` owns the 409 mapping, so
   * a throw here would be an unreachable defence-in-depth.
   */
  addAgent(roomName, agentName, conn) {
    const room = this.getOrCreate(roomName);
    if (room.agents.has(agentName)) return room;
    const since = Date.now();
    room.agents.set(agentName, { conn, since });
    return room;
  }

  /**
   * Broadcast an SSE event to every connected agent in a room, optionally
   * skipping one (typically the joiner or leaver themselves). Returns the
   * number of clients the event was successfully written to.
   */
  broadcast(roomName, event, data, skipName = null) {
    const room = this.rooms.get(roomName);
    if (!room) return 0;
    let n = 0;
    for (const [name, entry] of room.agents) {
      if (name === skipName) continue;
      if (entry.conn.writeEvent(event, data)) n++;
    }
    return n;
  }

  /**
   * Release an agent name. Also clears its rate-limit window slot so the
   * `publishTimestamps` map doesn't leak one entry per disconnected agent.
   * Rooms with no agents AND no history are GC'd; rooms with history are
   * kept across all-disconnect events so `GET /history` still works.
   */
  removeAgent(roomName, agentName) {
    const room = this.rooms.get(roomName);
    if (!room) return;
    room.publishTimestamps.delete(agentName);
    if (room.agents.delete(agentName) && room.agents.size === 0 && room.history.size === 0) {
      this.rooms.delete(roomName);
    }
  }

  /** @returns {{conn, since, lastSeen} | undefined} */
  getAgent(roomName, agentName) {
    const room = this.rooms.get(roomName);
    return room?.agents.get(agentName);
  }

  /**
   * Snapshot of agents in the room, sorted by name for stable UI.
   * `lastSeen` reflects the SSE connection's most recent activity timestamp
   * (`SseConnection.lastSeen`); it's the same value the stale sweeper reads.
   * @returns {{name: string, connectedAt: number, lastSeen: number}[]}
   */
  listAgents(roomName) {
    const room = this.rooms.get(roomName);
    if (!room) return [];
    const out = [];
    for (const [name, { since, conn }] of room.agents) {
      out.push({ name, connectedAt: since, lastSeen: conn.lastSeen });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /**
   * Most recent N messages from the ring buffer.
   * @returns {Array<{id: string, from: string, text: string, ts: number, mentions: string[]}>}
   */
  getHistory(roomName, limit) {
    const room = this.rooms.get(roomName);
    if (!room) return [];
    return room.history.snapshot(limit);
  }

  /**
   * Publish a message: validate the sender holds an active SSE in this room,
   * assign id + ts + mentions, push to the history ring buffer, fan out to all
   * connections (skipping `from`).
   *
   * @returns {{ message: object, recipients: Array<{ conn, name }> }}
   * @throws {Error} `{ code: 'AGENT_NOT_CONNECTED' }` if `from` is not bound.
   */
  publish(roomName, { from, text, meta }) {
    const room = this.rooms.get(roomName);
    if (!room || !room.agents.has(from)) {
      const err = new Error(`agent "${from}" has no active SSE in room "${roomName}"`);
      err.code = "AGENT_NOT_CONNECTED";
      throw err;
    }
    // Rate limit: ≤ 10 msg/s/agent; 11th within a 1s window → 429.
    // The while-loop with `stamps.shift()` is O(n), but n is bounded by
    // `rateLimitPerSec` (default 10), so it's a non-issue in practice.
    const now = Date.now();
    const stamps = room.publishTimestamps.get(from) ?? [];
    while (stamps.length > 0 && stamps[0] < now - this.rateLimitWindowMs) {
      stamps.shift();
    }
    if (stamps.length >= this.rateLimitPerSec) {
      const err = new Error(`rate_limit_exceeded for ${from}`);
      err.code = "RATE_LIMITED";
      throw err;
    }
    stamps.push(now);
    room.publishTimestamps.set(from, stamps);

    const id = randomUUID();
    const ts = Date.now();
    const mentions = extractMentions(text);
    const message = { id, from, text, ts, mentions, ...(meta ? { meta } : {}) };
    room.history.push(message);

    const recipients = [];
    for (const [name, entry] of room.agents) {
      if (name === from) continue; // sender skip
      recipients.push({ conn: entry.conn, name });
    }
    return { message, recipients };
  }

  /** Uptime in seconds, modulo the boot time set in the constructor. */
  uptime() {
    return Math.floor((Date.now() - this.bootTime) / 1000);
  }

  /** Number of rooms currently in the registry. */
  roomCount() {
    return this.rooms.size;
  }

  /**
   * Build the SSE payload for a published message. Pure function — the route
   * layer calls this instead of shaping the payload by hand, which keeps a
   * single definition of the wire shape.
   *
   * `roomName` is the URL-derived room, not anything carried in `message`.
   *
   * @param {{id: string, from: string, text: string, ts: number, mentions: string[], meta?: object}} message
   * @param {string} roomName
   */
  formatMessageForSse(message, roomName) {
    return {
      id: message.id,
      room: roomName,
      from: message.from,
      text: message.text,
      ts: message.ts,
      mentions: message.mentions,
      ...(message.meta ? { meta: message.meta } : {}),
    };
  }
}
