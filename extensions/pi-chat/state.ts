// Tiny stateful helpers used by the inbound pipeline:
//   - `IdDedupe` remembers recent inbound `id`s and rejects duplicates
//     (defence against server replays after reconnect).
//   - `CooldownGate` enforces the per-sender cooldown window.
//   - `ReplyTracker` records `id`s of messages *we* sent so the agent can
//     decide whether an inbound is a reply to one of ours.
//
// All three are pure-ish: they only mutate their own internal maps.

/** Bounded LRU-ish set of recently-seen inbound ids. */
export class IdDedupe {
  private readonly seen: Map<string, number> = new Map();

  constructor(private readonly maxAgeMs = 30_000, private readonly maxSize = 1024) {}

  /** Returns `true` if the id is new (and thus accepted). */
  accept(id: string, now: number = Date.now()): boolean {
    const cutoff = now - this.maxAgeMs;
    // GC expired ids lazily.
    for (const [k, t] of this.seen) {
      if (t < cutoff) this.seen.delete(k);
    }
    if (this.seen.has(id)) return false;
    if (this.seen.size >= this.maxSize) {
      // Drop the oldest. Map iteration is insertion order so this is FIFO.
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.set(id, now);
    return true;
  }

  clear(): void { this.seen.clear(); }
  get size(): number { return this.seen.size; }
}

/** Per-sender cooldown window. */
export class CooldownGate {
  private readonly lastAccepted: Map<string, number> = new Map();

  constructor(public readonly windowMs: number) {
    if (!Number.isFinite(windowMs) || windowMs < 0) {
      throw new RangeError(`CooldownGate.windowMs must be a non-negative number, got ${windowMs}`);
    }
  }

  /**
   * Returns `true` if the message is within the cooldown window from the
   * last accepted one (and is therefore dropped). Returns `false` if the
   * message is *outside* the window (and should be accepted). Caller
   * timestamps the message via `now`.
   */
  isOnCooldown(from: string, now: number = Date.now()): boolean {
    const last = this.lastAccepted.get(from);
    if (last === undefined) return false;
    return now - last < this.windowMs;
  }

  /** Record `from` as having just sent a message. Use only when accepted. */
  record(from: string, now: number = Date.now()): void {
    this.lastAccepted.set(from, now);
  }

  clear(): void { this.lastAccepted.clear(); }
}

/**
 * Tracks the `id`s of messages *we* sent. Used by the inbound pipeline to
 * recognise `meta.replyTo` chains.
 */
export class ReplyTracker {
  private readonly ids: Set<string> = new Set();

  remember(id: string): void {
    this.ids.add(id);
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  clear(): void { this.ids.clear(); }
}

/** Minimal record kept in the recent-context buffer. */
export interface RecentMessage {
  id: string;
  from: string;
  text: string;
  ts: number;
  mentions: string[];
  meta?: Record<string, unknown>;
}

/**
 * Bounded ring buffer of recent messages seen on the wire — both inbound
 * (from server fan-out) and outbound (from `chat_send`). Used by the
 * thread-context injector to prepend chat-room history to inbound prompts.
 *
 *   - FIFO: oldest insertion is evicted when full.
 *   - `record(...)` is idempotent on duplicate ids — replays don't pollute.
 */
export class RecentBuffer {
  private readonly items: RecentMessage[] = [];

  constructor(private readonly maxSize: number) {
    if (!Number.isFinite(maxSize) || maxSize < 1) {
      throw new RangeError(`RecentBuffer.maxSize must be ≥ 1, got ${maxSize}`);
    }
  }

  /** Returns true on insertion, false on duplicate-id skip. */
  record(msg: RecentMessage): boolean {
    if (this.items.some((m) => m.id === msg.id)) return false;
    this.items.push(msg);
    if (this.items.length > this.maxSize) {
      this.items.splice(0, this.items.length - this.maxSize);
    }
    return true;
  }

  /** Up to `limit` most recent messages, oldest-first. */
  recent(limit?: number): RecentMessage[] {
    if (limit === undefined || limit >= this.items.length) {
      return this.items.slice();
    }
    return this.items.slice(this.items.length - limit);
  }

  /** Lookup a buffered message by id. Returns undefined if not buffered. */
  find(id: string): RecentMessage | undefined {
    return this.items.find((m) => m.id === id);
  }

  get size(): number { return this.items.length; }

  clear(): void { this.items.length = 0; }
}

/**
 * Time-windowed map of outbound message ids → {text, ts}. Inbound messages
 * whose `meta.replyTo` matches a key inside the window are treated as
 * thread replies (outbound-aware follow-up): the per-sender cooldown
 * is bypassed for them.
 *
 * The window is enforced lazily on lookup — no background timer needed.
 */
export class ReplyChainTracker {
  private readonly entries: Map<string, { text: string; ts: number }> = new Map();

  constructor(public readonly windowMs: number) {
    if (!Number.isFinite(windowMs) || windowMs < 0) {
      throw new RangeError(`ReplyChainTracker.windowMs must be non-negative, got ${windowMs}`);
    }
  }

  remember(id: string, text: string, ts: number = Date.now()): void {
    this.entries.set(id, { text, ts });
    if (this.entries.size > 256) {
      const toDrop = [...this.entries.keys()].slice(0, this.entries.size - 256);
      for (const k of toDrop) this.entries.delete(k);
    }
  }

  /**
   * Recorded entry iff `id` is in the tracker and its `ts` is within
   * `windowMs` of `now`. Otherwise undefined.
   */
  lookup(id: string, now: number = Date.now()): { text: string; ts: number } | undefined {
    const e = this.entries.get(id);
    if (!e) return undefined;
    if (this.windowMs === 0) return e;
    if (now - e.ts >= this.windowMs) {
      this.entries.delete(id);
      return undefined;
    }
    return e;
  }

  has(id: string, now: number = Date.now()): boolean {
    return this.lookup(id, now) !== undefined;
  }

  clear(): void { this.entries.clear(); }
}
