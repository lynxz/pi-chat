// ChatClient — HTTP+SSE transport for the chat-server protocol.
//
// Pure transport layer: no Pi, no DOM, no UI. All Pi-touching concerns live
// in the wiring layer (`index.ts`). ChatClient is built around three callbacks
// (`onEvent`, `onStatus`, `onError`) so it can be tested with a stub.
//
// Lifecycle:
//   const client = new ChatClient({ server, room, agent, reconnectMs, fetch? });
//   client.onEvent((evt) => …); client.onStatus((s) => …); client.onError((e) => …);
//   await client.start();                 // opens SSE; returns 'connected' | 'conflict' | 'offline'
//   const r = await client.send(text, meta?);
//   await client.close();
//
// State machine for `client.status.state`:
//   'offline'    — not started, or after `close()`. No reconnect attempts.
//   'connecting' — initial connect, or a reconnect attempt in progress.
//   'connected'  — SSE open, server has sent `hello`. `info` is the hello payload.
//   'conflict'   — server returned 409 at SSE-connect time (name-dormant).
//                  Terminal for the session: stop trying to reconnect (the agent
//                  can recover by changing PI_CHAT_AGENT and /reload-ing.

import { openSse, type SseFrame } from "./sse-stream.ts";

export interface ChatClientConfig {
  server: string;            // base URL, e.g. "http://chat:8080"
  room: string;              // room name
  agent: string;             // this agent's name (URL-safe)
  reconnectMs?: number;      // base backoff (default 2000)
  /** Override `fetch` — used by tests. */
  fetch?: typeof globalThis.fetch;
}

export interface ChatEventMessage {
  kind: "message";
  id: string;
  from: string;
  text: string;
  ts: number;
  mentions: string[];
  meta?: Record<string, unknown>;
}

export interface ChatEventPresence {
  kind: "presence";
  agent: string;
  action: "joined" | "left";
  at: number;
}

export interface ChatEventHello {
  kind: "hello";
  agent: string;
  room: string;
  agents: Array<{ name: string; connectedAt: number; lastSeen: number }>;
}

export interface ChatEventGoodbye {
  kind: "goodbye";
  reason: string;
}

export type ChatEvent =
  | ChatEventHello
  | ChatEventPresence
  | ChatEventMessage
  | ChatEventGoodbye
  | { kind: "ping" };

export type ClientState = "offline" | "connecting" | "connected" | "conflict";

export interface ClientStatus {
  state: ClientState;
  /** Extra context — e.g. the agents list from `hello`. */
  info?: unknown;
  /** Current reconnect attempt count (0 when connected cleanly). */
  attempts: number;
}

export interface ClientError {
  phase: "connect" | "send" | "reconnect";
  error: unknown;
}

export interface SendResult {
  id: string;
  ts: number;
  mentions: string[];
}

type Listener<T> = (value: T) => void;

const MAX_BACKOFF_MS = 30_000;

export class ChatClient {
  private readonly config: Required<Pick<ChatClientConfig, "server" | "room" | "agent" | "reconnectMs">> & {
    fetch: typeof globalThis.fetch;
  };

  private statusListeners = new Set<Listener<ClientStatus>>();
  private eventListeners = new Set<Listener<ChatEvent>>();
  private errorListeners = new Set<Listener<ClientError>>();

  private currentStatus: ClientStatus = { state: "offline", attempts: 0 };
  private abortCurrentSse: (() => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = true; // becomes false on `start()`, true again on `close()`
  private reconnectAttempts = 0;

  /** Public read-only view of the most recent status. */
  get status(): ClientStatus { return this.currentStatus; }

  constructor(config: ChatClientConfig) {
    this.config = {
      server: config.server.replace(/\/+$/, ""),
      room: config.room,
      agent: config.agent,
      reconnectMs: config.reconnectMs ?? 2000,
      fetch: config.fetch ?? globalThis.fetch,
    };
  }

  // --- subscriptions ------------------------------------------------------

  onEvent(listener: Listener<ChatEvent>): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onStatus(listener: Listener<ClientStatus>): () => void {
    this.statusListeners.add(listener);
    // Replay current status once so freshly-subscribed listeners don't miss
    // the most recent state change.
    try { listener(this.currentStatus); } catch { /* swallow */ }
    return () => this.statusListeners.delete(listener);
  }

  onError(listener: Listener<ClientError>): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  // --- lifecycle ---------------------------------------------------------

  /**
   * Open the SSE stream. Resolves with the resulting ClientState:
   *   'connected' — hello received, we are live.
   *   'conflict'  — server returned 409 (name-dormant for the session).
   *   'offline'   — initial connect failed; reconnect loop will keep trying.
   */
  async start(): Promise<ClientState> {
    this.closed = false;
    return this.connect();
  }

  /** Cancel any open SSE and stop reconnecting. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.abortCurrentSse) {
      try { this.abortCurrentSse(); } catch { /* noop */ }
      this.abortCurrentSse = null;
    }
    this.setStatus({ state: "offline", attempts: this.reconnectAttempts });
  }

  /**
   * Publish a message. Throws on transport failure (or a structured error
   * with `.code` for `agent_not_connected` / `rate_limit` / etc. — the wiring
   * layer maps those to notifications).
   */
  async send(text: string, meta?: Record<string, unknown>): Promise<SendResult> {
    if (this.closed) throw new Error("client_closed");
    if (this.currentStatus.state === "conflict") {
      const err = new Error("name-dormant: agent name is in use in this room");
      (err as { code?: string }).code = "name_dormant";
      throw err;
    }
    const url = `${this.config.server}/rooms/${encodeURIComponent(this.config.room)}/messages`;
    const body: { from: string; text: string; meta?: Record<string, unknown> } = {
      from: this.config.agent,
      text,
    };
    if (meta !== undefined) body.meta = meta;
    let res: Response;
    try {
      res = await this.config.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      this.emitError({ phase: "send", error });
      throw error;
    }
    if (!res.ok) {
      let code: string | undefined;
      let payload: unknown = null;
      try { payload = await res.json(); } catch { /* ignore */ }
      if (payload && typeof payload === "object" && "error" in (payload as Record<string, unknown>)) {
        code = String((payload as { error: unknown }).error);
      }
      const err = new Error(`post_failed: ${res.status} ${code ?? ""}`);
      (err as { code?: string; status?: number }).code = code;
      (err as { code?: string; status?: number }).status = res.status;
      this.emitError({ phase: "send", error: err });
      throw err;
    }
    return (await res.json()) as SendResult;
  }

  // --- internals ---------------------------------------------------------

  private setStatus(s: ClientStatus): void {
    this.currentStatus = s;
    for (const l of this.statusListeners) {
      try { l(s); } catch { /* swallow */ }
    }
  }

  private emitEvent(evt: ChatEvent): void {
    for (const l of this.eventListeners) {
      try { l(evt); } catch { /* swallow */ }
    }
  }

  private emitError(e: ClientError): void {
    for (const l of this.errorListeners) {
      try { l(e); } catch { /* swallow */ }
    }
  }

  private async connect(): Promise<ClientState> {
    this.setStatus({ state: "connecting", attempts: this.reconnectAttempts });

    let sse;
    try {
      sse = await openSse(
        `${this.config.server}/rooms/${encodeURIComponent(this.config.room)}/events?agent=${encodeURIComponent(this.config.agent)}`,
        { fetch: this.config.fetch },
      );
    } catch (error) {
      this.emitError({ phase: "connect", error });
      this.scheduleReconnect();
      return "offline";
    }

    if (sse.status === 409) {
      // Name-dormant for the session. Stop reconnecting.
      this.setStatus({ state: "conflict", attempts: this.reconnectAttempts });
      sse.close();
      return "conflict";
    }
    if (sse.status !== 200) {
      this.emitError({ phase: "connect", error: new Error(`sse_status_${sse.status}`) });
      sse.close();
      this.scheduleReconnect();
      return "offline";
    }

    this.abortCurrentSse = sse.close;
    this.reconnectAttempts = 0;
    let resolved: ClientState = "connected";

    (async () => {
      try {
        for await (const frame of sse.events) {
          this.handleFrame(frame);
        }
      } catch (error) {
        this.emitError({ phase: "connect", error });
      } finally {
        this.abortCurrentSse = null;
        if (!this.closed && resolved !== "conflict") {
          this.scheduleReconnect();
        }
      }
    })();

    // We can't wait for `hello` in `connect()` because the first frame may
    // already have arrived between `openSse()` returning and us reading it.
    // Caller can observe the state transition via the `onStatus` listener.
    return resolved;
  }

  private handleFrame(frame: SseFrame): void {
    let data: unknown = null;
    if (frame.data) {
      try { data = JSON.parse(frame.data); } catch { data = frame.data; }
    }
    switch (frame.event) {
      case "hello": {
        const hello = (data ?? {}) as ChatEventHello;
        this.setStatus({
          state: "connected",
          attempts: 0,
          info: hello,
        });
        this.emitEvent({ kind: "hello", ...hello });
        break;
      }
      case "presence": {
        const p = (data ?? {}) as Omit<ChatEventPresence, "kind">;
        this.emitEvent({ kind: "presence", ...p });
        break;
      }
      case "message": {
        const m = (data ?? {}) as Omit<ChatEventMessage, "kind">;
        this.emitEvent({ kind: "message", ...m });
        break;
      }
      case "goodbye": {
        const g = (data ?? {}) as Omit<ChatEventGoodbye, "kind">;
        this.emitEvent({ kind: "goodbye", ...g });
        break;
      }
      case "ping":
        this.emitEvent({ kind: "ping" });
        break;
      default:
        // Unknown event type — ignore, but log via onError for diagnostics.
        this.emitError({ phase: "connect", error: new Error(`unknown_sse_event: ${frame.event}`) });
        break;
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.currentStatus.state === "conflict") return;
    if (this.reconnectTimer) return; // already scheduled
    this.reconnectAttempts += 1;
    const base = Math.max(this.config.reconnectMs, 100);
    // Exponential up to MAX_BACKOFF_MS (caps reconnect delay at 30s).
    const delay = Math.min(base * Math.pow(2, this.reconnectAttempts - 1), MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    this.setStatus({ state: "connecting", attempts: this.reconnectAttempts });
  }
}
