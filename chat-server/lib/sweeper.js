// Stale-SSE sweeper for the chat-server.
//
// The server closes the SSE response after 60 s of no traffic
// (heartbeat included); the agent is removed from `presence` after a
// short grace period. `SseConnection.lastSeen` is updated on every write
// (including heartbeats via `touch()`), so this sweeper is correct: an
// idle agent whose connection is still half-open will exceed `staleMs`
// after one timeout period and be closed. Closing the SSE triggers
// `SseConnection.onClose()` → `removeAgent(...)` + `presence { left }`
// broadcast, so we don't have to do presence cleanup here.
//
// `runStaleSweepOnce(state, staleMs)` is exported so Layer 1 tests can
// drive the sweep without timers; `startStaleSweeper` returns the interval
// handle for production use.

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_STALE_MS = 60_000;

/**
 * One sweep pass: walks every room, closes any SSE whose
 * `entry.conn.lastSeen` is older than `staleMs`.
 *
 * Notes on the simplification vs the earlier `Math.max(entry.lastSeen,
 * entry.conn.lastSeen)`:
 * - `Room` does not currently update `entry.lastSeen` independently of
 *   the connection; both fields share the same lifecycle (set together
 *   in `addAgent`, never diverged). The `Math.max` was therefore a
 *   no-op masquerading as defence-in-depth.
 * - The heartbeat route is `entry.conn.touch()`, so it updates
 *   `conn.lastSeen` directly — which is the field we read here.
 * - If we ever want a second liveness source, the right move is to wire
 *   it through `SseConnection` (so all paths go through `lastSeen`)
 *   rather than reaching into `entry.lastSeen` here.
 *
 * Returns the count of agents that were closed. `now` defaults to
 * `Date.now()` so tests can pin the clock.
 */
export function runStaleSweepOnce(state, { staleMs = DEFAULT_STALE_MS, now = Date.now() } = {}) {
  let closed = 0;
  for (const [, room] of state.rooms) {
    for (const [, entry] of [...room.agents]) {
      // `-Infinity` for missing timestamps: a never-seen connection
      // should be treated as "born stale" (age = +Inf), not "born now"
      // (age = now - 0 = now, which `> staleMs` would still trip, but
      // only because staleMs is small — keep the intent explicit).
      const lastActivity = entry.conn.lastSeen ?? -Infinity;
      const age = now - lastActivity;
      if (age > staleMs) {
        // Triggers res.on("close") → SseConnection._handleClose → onClose →
        // removeAgent + presence-broadcast. The `entry` reference may be
        // stale by the next iteration of the outer `for` loop, which is
        // why we spread `room.agents` to a snapshot above.
        entry.conn.close();
        closed++;
      }
    }
  }
  return closed;
}

/**
 * Start a periodic stale-SSE sweeper. Returns the interval handle so
 * callers can stop it on shutdown. `unref()`s the handle so the timer
 * never holds the event loop open by itself.
 */
export function startStaleSweeper(state, opts = {}) {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;

  const handle = setInterval(() => {
    try { runStaleSweepOnce(state, { staleMs }); } catch { /* ignore */ }
  }, intervalMs);
  if (typeof handle.unref === "function") handle.unref();
  return handle;
}

export function stopStaleSweeper(handle) {
  if (handle) clearInterval(handle);
}

export const _internals = { DEFAULT_INTERVAL_MS, DEFAULT_STALE_MS };
