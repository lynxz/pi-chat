// Minimal SSE connection wrapper over `node:http` ServerResponse.
//
// Owns:
//   - the SSE response headers
//   - a `writeEvent(event, data)` helper that frames JSON payloads as
//     `event: <type>\ndata: <json>\n\n`
//   - an idempotent `close()` and an `onClose` callback fired when the
//     underlying socket goes away (graceful close, network drop, or our own
//     `close()`)
//
// This module knows nothing about rooms or chat — it's a transport primitive,
// so the route layer can compose it freely.

const noop = () => {};

export class SseConnection {
  /**
   * @param {import("node:http").ServerResponse} res
   * @param {{ onClose?: () => void }} [opts]
   */
  constructor(res, { onClose = noop } = {}) {
    this.res = res;
    this.onClose = onClose;
    this.closed = false;
    this._lastSeen = Date.now();
    this._installHeaders(res);
    res.on("close", () => this._handleClose());
    res.on("error", () => this._handleClose());
  }

  _installHeaders(res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable nginx response buffering so events flush immediately.
      "X-Accel-Buffering": "no",
    });
    // `flushHeaders` exists on Node ≥ 16. Calling it ensures headers reach the
    // client right away; important for proxies and `curl -N`.
    if (typeof res.flushHeaders === "function") res.flushHeaders();
  }

  /**
   * Frame and write one SSE event. Returns false if the connection is closed
   * (caller should not retry).
   * @param {string} event
   * @param {unknown} data
   */
  writeEvent(event, data) {
    if (this.closed) return false;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    try {
      this.res.write(payload);
      this._lastSeen = Date.now();
      return true;
    } catch {
      this._handleClose();
      return false;
    }
  }

  /**
   * Write a bare SSE comment line (`": <text>\n\n"`). Per the SSE spec, comment
   * lines keep the connection warm and are ignored by clients. Cheaper than
   * `writeEvent()` because no JSON round-trip is needed. Counts as activity
   * for the stale sweeper.
   * @param {string} [text]
   */
  writeComment(text = "") {
    if (this.closed) return false;
    const payload = `: ${text}\n\n`;
    try {
      this.res.write(payload);
      this._lastSeen = Date.now();
      return true;
    } catch {
      this._handleClose();
      return false;
    }
  }

  /** Last successful write timestamp (ms). Used by the stale sweeper. */
  get lastSeen() {
    return this._lastSeen;
  }

  /**
   * Bump the lastSeen timestamp without writing a frame. Used by the
   * heartbeat route so the stale sweeper sees the agent as alive even
   * when the server itself isn't pushing any events (idle rooms).
   */
  touch() {
    this._lastSeen = Date.now();
  }

  /** Idempotent end. */
  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.res.end();
    } catch {
      /* socket already destroyed */
    }
    this.onClose();
  }

  /**
   * Idempotent close handler. Three callers can fire this:
   *   1. the underlying socket's `"close"` event,
   *   2. the underlying socket's `"error"` event,
   *   3. an explicit `close()` call (which itself triggers the socket's
   *      `"close"` event after the response is ended — so this can fire
   *      twice in close succession).
   * The `closed` flag keeps `onClose()` from running more than once.
   * Never write to `res` here — the socket is gone.
   */
  _handleClose() {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }
}
