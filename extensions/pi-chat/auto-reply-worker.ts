// Auto-reply worker — the serial inbound queue.
//
// Inbound chat messages that match the runtime auto-reply mode are enqueued
// here. A single worker pulls one message at a time and calls
// `deps.sendUserMessage(text)` (which is `pi.sendUserMessage` in production)
// so only one LLM turn is triggered at a time.
//
// The worker is *pure* (no Pi dependencies) — it operates on injected
// callbacks. This lets unit tests drive the queue without a Pi harness,
// and isolates the queuing policy from the rest of the runtime.
//
// State machine:
//
//   inFlight = false, queue = []
//     pump()  → nothing (no work)
//
//   inFlight = false, queue = [text]
//     pump()  → if isIdle() && !cool: sendUserMessage(text), inFlight = true
//
//   inFlight = true,  queue = [text, ...]
//     pump()  → nothing (one in flight)
//     markTurnDone() → inFlight = false → next pump() can dispatch
//
// Defensive bounds:
// - `minGapMs` enforces a minimum wall-clock gap between dispatches. This is
//   a fallback for the heuristic that `inFlight` is mostly driven by
//   `agent_end` events; if those don't fire as expected, we never
//   dispatch more than once per `minGapMs`.
// - `maxQueue` caps the queue so a misbehaving sender can't OOM the
//   extension. Excess messages are dropped after a notify.

export interface AutoReplyWorkerDeps {
  /** Called for each dispatched message. Should mirror the production
   *  `pi.sendUserMessage(text)` call. Returns void (fire-and-forget). */
  sendUserMessage(text: string): void;
  /** Mirror of `ctx.isIdle()`. True when no turn is in progress. */
  isIdle(): boolean;
  /** Optional hook fired once per dispatch. Useful for logging / tests. */
  onDispatch?(text: string, queueSize: number): void;
  /** Optional hook fired on drop (queue full). */
  onDrop?(text: string, reason: "queue_full"): void;
}

export interface AutoReplyWorkerOptions {
  /** Minimum wall-clock gap between dispatches. Default 1 s — short
   *  enough to keep multi-turn conversations lively, long enough that
   *  the `inFlight` heuristic self-recovers if `agent_end` is missed. */
  minGapMs?: number;
  /** Cap on the pending queue. Default 256. Excess enqueues are dropped. */
  maxQueue?: number;
}

// Default lowered from 5000 → 1000. Configurable via the runtime's
// `PI_CHAT_MIN_GAP_MS` env var.
const DEFAULT_MIN_GAP_MS = 1_000;
const DEFAULT_MAX_QUEUE = 256;

export class AutoReplyWorker {
  private readonly queue: string[] = [];
  private inFlight = false;
  private lastDispatchAt = 0;
  private readonly minGapMs: number;
  private readonly maxQueue: number;
  private dropped = 0;

  constructor(
    private readonly deps: AutoReplyWorkerDeps,
    opts: AutoReplyWorkerOptions = {},
  ) {
    this.minGapMs = opts.minGapMs ?? DEFAULT_MIN_GAP_MS;
    this.maxQueue = opts.maxQueue ?? DEFAULT_MAX_QUEUE;
  }

  /**
   * Add `text` to the pending queue. Returns the new pending count.
   * If the queue is full, the message is dropped and `onDrop` (if any)
   * is fired with `reason: "queue_full"`.
   */
  enqueue(text: string): number {
    if (this.queue.length >= this.maxQueue) {
      this.dropped++;
      this.deps.onDrop?.(text, "queue_full");
      return this.queue.length;
    }
    this.queue.push(text);
    return this.queue.length;
  }

  /**
   * Try to dispatch one pending message. Returns the message dispatched
   * (so callers/tests can observe it), or `undefined` if no dispatch
   * happened.
   *
   * Call this regularly (e.g. on a 100 ms interval) or whenever the
   * agent becomes idle. Dispatch requires:
   *   - non-empty queue,
   *   - `inFlight === false`,
   *   - `deps.isIdle() === true`,
   *   - `minGapMs` elapsed since the last dispatch.
   */
  pump(): string | undefined {
    if (this.inFlight) return undefined;
    if (this.queue.length === 0) return undefined;
    if (!this.deps.isIdle()) return undefined;
    const now = Date.now();
    if (now - this.lastDispatchAt < this.minGapMs) return undefined;

    const text = this.queue.shift()!;
    this.inFlight = true;
    this.lastDispatchAt = now;
    try {
      this.deps.sendUserMessage(text);
    } catch {
      // Don't let a single dispatch exception leave us stuck: reset on
      // failure so the next pump can try again. The text is lost
      // (we don't re-enqueue because that could trigger a runaway loop).
      this.inFlight = false;
      return undefined;
    }
    this.deps.onDispatch?.(text, this.queue.length);
    return text;
  }

  /**
   * Called by external signals (e.g. Pi's `agent_end` event) to indicate
   * the agent has finished processing the previously injected user
   * message. Resets `inFlight` so the next pump can dispatch.
   */
  markTurnDone(): void {
    this.inFlight = false;
  }

  /** Reset all state — drop queue + inFlight + gap. */
  clear(): void {
    this.queue.length = 0;
    this.inFlight = false;
    this.lastDispatchAt = 0;
  }

  get pendingCount(): number { return this.queue.length; }
  get isDispatching(): boolean { return this.inFlight; }
  get dropCount(): number { return this.dropped; }
}
