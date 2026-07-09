// Server-side ping scheduler — keeps idle SSE connections warm.
//
// The stale sweeper closes connections when `SseConnection.lastSeen`
// goes stale. Idle rooms (no one broadcasting) therefore get their
// connections closed after `staleMs` (default 60 s) even though the
// client is perfectly healthy — the sweeper sees no recent write and
// disconnects.
//
// This module writes a bare SSE comment frame (`: ping\n\n`) to every
// open SseConnection on a fixed interval. Comment lines are part of the
// SSE spec, ignored by clients, and lighter on the wire than a named
// event (no JSON encode round-trip). The write still updates
// `SseConnection.lastSeen` so the sweeper leaves the connection alone.
// A client that runs the receive loop OR whose heartbeat hits
// `entry.conn.touch()` keeps the connection alive either way.
//
// Interval vs `staleMs`: the interval should be SHORTER than `staleMs`
// so a missed ping doesn't immediately trip the sweeper. The recommended
// rule is `pingInterval ≤ staleMs / 2`, but at defaults (20 s vs 60 s)
// we run at ~1/3 — still gives the sweeper ~40 s of slack on a single
// missed ping, which we treat as acceptable.
//
// `runPingSweepOnce(state)` is exported so unit tests can drive the
// schedule without timers. `startPingScheduler` returns the interval
// handle for production use.

const DEFAULT_INTERVAL_MS = 20_000;

/**
 * One ping pass: writes a `: ping\n\n` comment frame to every open
 * SseConnection in every room. Returns the number of pings successfully
 * delivered.
 */
export function runPingSweepOnce(state) {
  let delivered = 0;
  for (const [, room] of state.rooms) {
    for (const [, entry] of room.agents) {
      if (entry.conn.writeComment("ping")) delivered++;
    }
  }
  return delivered;
}

/**
 * Start a periodic ping scheduler. Returns the interval handle so the
 * caller can stop it on shutdown. `unref()`s the handle so the timer
 * never holds the event loop open by itself.
 */
export function startPingScheduler(state, opts = {}) {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const handle = setInterval(() => {
    try { runPingSweepOnce(state); } catch { /* best-effort */ }
  }, intervalMs);
  if (typeof handle.unref === "function") handle.unref();
  return handle;
}

export function stopPingScheduler(handle) {
  if (handle) clearInterval(handle);
}

export const _internals = { DEFAULT_INTERVAL_MS };
