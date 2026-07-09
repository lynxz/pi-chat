// Pure SSE stream primitives over the standard `fetch` API.
//
// `openSse(url, options)` issues `GET` with `Accept: text/event-stream` and
// returns:
//   - `status`  — the HTTP status of the connection attempt
//   - `events`  — an `AsyncIterable<SseFrame>` consumed by the caller
//   - `close()` — best-effort cancellation
//
// The async iterator frames (\n\n-delimited) into `{ event, data }` and
// re-emits them via promise resolution. The caller is responsible for the
// connection-level reconnect logic; this module just owns bytes-to-frames.

export interface SseFrame {
  event: string;
  data: string;
  raw: { event: string; data: string };
}

export interface OpenResult {
  status: number;
  events: AsyncIterable<SseFrame>;
  close(): void;
}

export interface OpenOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Override `fetch` (used by tests). Defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
}

const DEFAULT_HEADERS = { Accept: "text/event-stream", "Cache-Control": "no-cache" };

/** Parse an SSE chunk buffer into zero or more complete frames. */
export function parseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  let rest = buffer;
  let idx: number;
  while ((idx = rest.indexOf("\n\n")) !== -1) {
    const frameText = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    if (frameText.length === 0) continue;
    // Use a `null` sentinel for `event` so we can distinguish a frame with
    // no `event:` line (default to "message" per SSE spec) from a frame
    // that is *entirely* comment lines (the server's ping keep-alive is
    // `: ping\n\n`). Comment-only frames must NOT be emitted: doing so
    // would surface a bogus `message` event with empty data to callers,
    // whose downstream pipeline crashes on undefined `.text` / `.from`.
    let event: string | null = null;
    const dataLines: string[] = [];
    for (const line of frameText.split("\n")) {
      // Per the SSE spec, lines starting with `:` are comments and ignored.
      if (line.startsWith(":")) continue;
      if (line.startsWith("event: ")) {
        event = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        dataLines.push(line.slice(6));
      } else if (line === "data:") {
        dataLines.push("");
      } else if (line.length > 0 && !line.startsWith(":")) {
        // Unrecognised — ignore (the spec lets us be lenient).
      }
    }
    // Drop pure-comment frames (no `event:` line, no `data:` line).
    if (event === null && dataLines.length === 0) continue;
    const resolvedEvent = event ?? "message";
    const data = dataLines.join("\n");
    frames.push({ event: resolvedEvent, data, raw: { event: resolvedEvent, data } });
  }
  return { frames, rest };
}

/**
 * Open an SSE stream and return an async iterable of frames. The caller must
 * `break` the loop and call `close()` to release the underlying reader.
 */
export async function openSse(url: string, options: OpenOptions = {}): Promise<OpenResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  if (options.signal) {
    if (options.signal.aborted) controller.abort(options.signal.reason);
    else options.signal.addEventListener("abort", () => controller.abort(options.signal!.reason), { once: true });
  }

  const res = await fetchImpl(url, {
    method: "GET",
    headers: { ...DEFAULT_HEADERS, ...(options.headers ?? {}) },
    signal: controller.signal,
  });

  if (!res.ok || !res.body) {
    // Drain the body to free resources before returning.
    try { await res.body?.cancel(); } catch { /* best-effort */ }
    return {
      status: res.status,
      events: (async function* () { /* yields nothing */ })(),
      close() { try { controller.abort(); } catch { /* noop */ } },
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  const queue: SseFrame[] = [];
  let waiter: ((v: IteratorResult<SseFrame>) => void) | null = null;
  let closed = false;
  let pumpError: unknown = null;

  const pump = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          closed = true;
          if (waiter) { waiter({ value: undefined, done: true }); waiter = null; }
          return;
        }
        if (value) {
          buffer += decoder.decode(value, { stream: true });
          const { frames, rest } = parseFrames(buffer);
          buffer = rest;
          for (const f of frames) {
            if (waiter) {
              waiter({ value: f, done: false });
              waiter = null;
            } else {
              queue.push(f);
            }
          }
        }
      }
    } catch (err) {
      pumpError = err;
      closed = true;
      if (waiter) { waiter({ value: undefined, done: true }); waiter = null; }
    }
  })();

  const events: AsyncIterable<SseFrame> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<SseFrame>>((resolve) => {
          if (queue.length > 0) {
            resolve({ value: queue.shift()!, done: false });
            return;
          }
          if (closed) {
            resolve({ value: undefined, done: true });
            return;
          }
          waiter = resolve;
        }),
        return: async () => {
          closed = true;
          try { await reader.cancel(); } catch { /* noop */ }
          if (waiter) { waiter({ value: undefined, done: true }); waiter = null; }
          return { value: undefined, done: true };
        },
      };
    },
  };

  return {
    status: res.status,
    events,
    close() {
      if (closed) return;
      closed = true;
      try { controller.abort(); } catch { /* noop */ }
      try { reader.cancel().catch(() => {}); } catch { /* noop */ }
    },
  };
}
