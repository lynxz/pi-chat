// Multi-room runtime.
//
// Owns one `ChatRoomHandle` per joined room. The runtime is the single
// wiring layer on top of the per-room handles — it owns the consolidated
// Pi event listeners, the cross-room status footer, and the room router
// exposed to tools and commands via `ChatRuntimeDeps`.
//
// Shared state across rooms:
//   - one `pi.sendUserMessage` callback (per message — which room it
//     belongs to is encoded in the prompt itself by `buildThreadPrompt`),
//   - one `ctx.isIdle` check,
//   - one `pi.on("before_agent_start")` hook that fans out per-room
//     context blocks,
//   - one `pi.on("agent_end")` hook that marks all workers done,
//   - one 100 ms pump timer that pumps every worker's queue.
//
// Per-room (`ChatRoomHandle`):
//   - `client` (the SSE/HTTP client)
//   - `autoReply` worker + queue
//   - `replies`, `dedupe`, `cooldown`, `recent`, `replyChain`
//   - `roster`, `lastAnnouncedRoster`, `presenceDeltaSinceAnnounce`
//   - `ackCounters`
//   - `nameDormant` / `nameDormantNotified`
//   - `agentCount`
//   - `env`, `alias`

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { ChatClient, type SendResult } from "./client.ts";
import {
  readChatEnvs,
  isMultiRoomDormant,
  describeEnv,
  loadConfigFromFile,
  type AutoReplyMode,
  type ChatEnv,
  type ChatRoomConfig,
} from "./env.ts";
import { CooldownGate, IdDedupe, ReplyTracker, RecentBuffer, ReplyChainTracker } from "./state.ts";
import { AutoReplyWorker } from "./auto-reply-worker.ts";
import { resolveAutoMention } from "./chat-send.ts";
import { isFromSelf, shouldAutoReply } from "./filters.ts";
import { buildThreadPrompt, formatRosterLine, announceRosterIfChanged, buildChatRoomSystemPrompt } from "./index-helpers.ts";
import { applyStatus, buildMultiRoomStatus, buildStatus } from "./status.ts";
import type {
  ChatRoomSummary,
  ChatRuntimeDeps,
  ChatStatus,
  NotifyLevel,
  RoomSelector,
} from "./runtime-deps.ts";

/**
 * How often the runtime ticks `AutoReplyWorker.pump()`. Short enough that
 * matches feed into agent turns within ~one polling tick of the agent
 * becoming idle; long enough that we don't tax Pi with timers.
 */
const AUTO_REPLY_PUMP_MS = 100;

/**
 * Maximum consecutive acknowledgment messages before auto-reply is suppressed.
 * Prevents multi-agent loops of thanking/approving each other.
 */
const MAX_ACK_ROUNDS = 2;

/**
 * Detect if a message is an acknowledgment (short thank/approval without new content).
 * Used to prevent multi-agent loops of thanking and approving.
 */
function isAcknowledgment(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (/^[\s😀👍🎉🚀🐛✅😄]+$/.test(trimmed)) return true;
  const keywordPatterns = [
    /^thanks!?$/i,
    /^approved!?$/i,
    /^done\.?$/i,
    /^\+$/,
    /^all set!?$/i,
    /^confirmed!?$/i,
  ];
  if (keywordPatterns.some((p) => p.test(trimmed))) return true;
  if (trimmed.length < 10 && /^(yep|yes|yeah|ok|okay|nope?|\+|👍|✓)$/i.test(trimmed)) return true;
  return false;
}

/**
 * Per-room mutable runtime state. One instance per joined room.
 * `alias` is the canonical key under `PI_CHAT_ROOM_<ALIAS>__*`.
 */
export interface ChatRoomHandle {
  alias: string;
  env: ChatEnv;
  client: ChatClient;
  autoreply: { value: boolean; mode: AutoReplyMode };
  autoReply: AutoReplyWorker;
  replies: ReplyTracker;
  dedupe: IdDedupe;
  cooldown: CooldownGate;
  recent: RecentBuffer;
  replyChain: ReplyChainTracker;
  nameDormant: { value: boolean };
  nameDormantNotified: { value: boolean };
  agentCount: { value: number };
  roster: Set<string>;
  lastAnnouncedRoster: Set<string>;
  presenceDeltaSinceAnnounce: { value: number };
  ackCounters: Map<string, number>;
}

export interface ChatRuntimeOptions {
  /** Override fetch — used by tests. */
  fetch?: typeof globalThis.fetch;
  /**
   * Override the env map the runtime reads from. Defaults to
   * `process.env`. When set, `configFile` (if any) is layered *under*
   * this map so env values beat file values on key collision.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Path to a JSON config file. Loaded via `loadConfigFromFile` and
   * merged under `env`. CLI / env layer precedence:
   *   `options.configFile` > `PI_CHAT_CONFIG_FILE` env var > no file.
   * A missing / unreadable / malformed file fails fast at startup.
   */
  configFile?: string;
}

export interface ChatRuntimeHandle {
  /** Per-room router used by tools and commands. */
  deps: ChatRuntimeDeps;
  /** Force-shutdown all rooms (used on session_shutdown). */
  shutdown(): Promise<void>;
}

function makeHandle(config: ChatRoomConfig, opts: ChatRuntimeOptions): ChatRoomHandle {
  const env = config.env;
  return {
    alias: config.alias,
    env,
    client: new ChatClient({
      server: env.server,
      room: env.room,
      agent: env.agent,
      reconnectMs: env.reconnectMs,
      token: env.token,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    }),
    autoreply: { value: env.autoreply, mode: env.autoreplyMode },
    autoReply: null as unknown as AutoReplyWorker, // wired by owner
    replies: new ReplyTracker(),
    dedupe: new IdDedupe(60_000, 2048),
    cooldown: new CooldownGate(env.cooldownMs),
    recent: new RecentBuffer(env.recentBufferSize),
    replyChain: new ReplyChainTracker(env.replyChainMs),
    nameDormant: { value: false },
    nameDormantNotified: { value: false },
    agentCount: { value: 0 },
    roster: new Set<string>(),
    lastAnnouncedRoster: new Set<string>(),
    presenceDeltaSinceAnnounce: { value: 0 },
    ackCounters: new Map<string, number>(),
  };
}

export function buildChatRuntime(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: ChatRuntimeOptions = {},
): ChatRuntimeHandle | null {
  // Build the merged env map. Precedence (highest first):
  //   options.env (test seam) > process.env > JSON config file.
  // `loadConfigFromFile` merges the file under `baseEnv` so env values
  // always beat file values on key collision. Missing / unreadable /
  // malformed files throw — `index.ts` catches and surfaces as a
  // startup-failed notify rather than a silent dormant.
  const baseEnv = options.env ?? process.env;
  const configFile = options.configFile ?? baseEnv.PI_CHAT_CONFIG_FILE;
  const env = configFile ? loadConfigFromFile(configFile, baseEnv) : baseEnv;

  // Discover rooms. Empty result → dormant mode (no tools, one notify).
  const discovered = readChatEnvs(env);
  for (const w of discovered.warnings) {
    ctx.ui.notify(`[chat] ${w}`, "warning");
  }
  if (isMultiRoomDormant(discovered)) {
    ctx.ui.notify(
      "[chat] dormant — set PI_CHAT_SERVER/PI_CHAT_ROOM/PI_CHAT_AGENT (or PI_CHAT_ROOM_<ALIAS>__SERVER/__ROOM/__AGENT) to enable",
      "info",
    );
    return null;
  }

  const rooms = discovered.rooms;
  const primaryAlias = rooms[0].alias;

  const handles = rooms.map((c) => makeHandle(c, options));
  const byAlias = new Map<string, ChatRoomHandle>();
  for (const h of handles) byAlias.set(h.alias, h);

  const focused: { value: string } = { value: primaryAlias };

  // Wire Pi sendUserMessage / isIdle once and share across every worker.
  const sendUserMessage = (text: string) => {
    pi.sendUserMessage(text);
  };
  const isIdle = () => {
    try {
      return typeof ctx.isIdle === "function" ? ctx.isIdle() : true;
    } catch {
      return false;
    }
  };

  for (const h of handles) {
    h.autoReply = new AutoReplyWorker(
      {
        sendUserMessage,
        isIdle,
        onDispatch: (text, q) => ctx.ui.notify(
          `[chat #${h.env.room}] auto-reply → agent (queue=${q}): ${text.length > 80 ? text.slice(0, 77) + "…" : text}`,
          "info",
        ),
        onDrop: (text, reason) => ctx.ui.notify(
          `[chat #${h.env.room}] auto-reply dropped (${reason}): ${text.slice(0, 40)}`,
          "warning",
        ),
      },
      { minGapMs: h.env.minGapMs },
    );
  }

  function resolve(selector: RoomSelector): ChatRoomHandle | undefined {
    if (selector === undefined || selector === null || selector === "" || selector === "primary") {
      return byAlias.get(primaryAlias);
    }
    if (selector === "all") return undefined;
    const target = selector.toUpperCase();
    return byAlias.get(target);
  }

  function snapshot(h: ChatRoomHandle): ChatStatus {
    return {
      state: h.client.status,
      env: snapshotEnv(h),
      agentCount: h.agentCount.value,
      isNameDormant: h.nameDormant.value,
    };
  }

  function snapshotEnv(h: ChatRoomHandle): ChatStatus["env"] {
    return {
      server: h.env.server,
      room: h.env.room,
      agent: h.env.agent,
      alias: h.alias,
      autoreply: h.autoreply.value,
      autoreplyMode: h.autoreply.mode,
      history: h.env.history,
      reconnectMs: h.env.reconnectMs,
      cooldownMs: h.env.cooldownMs,
      minGapMs: h.env.minGapMs,
      replyChainMs: h.env.replyChainMs,
      recentBufferSize: h.env.recentBufferSize,
      threadContext: h.env.threadContext,
      prefix: h.env.prefix,
    };
  }

  function summarize(h: ChatRoomHandle): ChatRoomSummary {
    return {
      alias: h.alias,
      room: h.env.room,
      agent: h.env.agent,
      server: h.env.server,
      state: h.client.status,
      agentCount: h.agentCount.value,
      isNameDormant: h.nameDormant.value,
      autoreply: h.autoreply.value,
      autoreplyMode: h.autoreply.mode,
      isPrimary: h.alias === primaryAlias,
    };
  }

  function applyMultiStatus(): void {
    const summaries = handles
      .filter((h) => h.nameDormant.value || h.client.status.state !== "offline")
      .map((h) => ({
        alias: h.alias,
        agent: h.env.agent,
        agentCount:
          h.client.status.state === "connected"
            ? ((h.client.status.info as { agents?: Array<unknown> } | undefined)?.agents?.length ?? h.agentCount.value)
            : h.agentCount.value,
        state: h.client.status,
        isNameDormant: h.nameDormant.value,
      }));
    const spec = buildMultiRoomStatus(summaries, primaryAlias, focused.value);
    applyStatus(ctx, spec);
  }

  function fetchJsonForStatus<T = unknown>(h: ChatRoomHandle, path: string): Promise<T> {
    const url = `${h.env.server.replace(/\/+$/, "")}${path}`;
    const f = options.fetch ?? globalThis.fetch;
    return (async () => {
      const res = await f(url);
      if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
      return (await res.json()) as T;
    })();
  }

  function sendOutbound(
    room: RoomSelector,
    text: string,
    meta?: Record<string, unknown>,
  ): Promise<SendResult> {
    const target = resolve(room) ?? byAlias.get(primaryAlias);
    if (!target) {
      return Promise.reject(Object.assign(new Error("no_rooms_joined"), { code: "no_rooms" }));
    }
    if (target.nameDormant.value) {
      const err = new Error("name-dormant (change PI_CHAT_AGENT and /reload)");
      (err as { code?: string }).code = "name_dormant";
      return Promise.reject(err);
    }
    const replyTo = meta?.replyTo;
    const resolution = resolveAutoMention(text, meta, target.recent, target.env.agent, target.env.replyChainMs);
    if (resolution.unresolvedReplyTo) {
      ctx.ui.notify(
        `[chat #${target.env.room}] could not resolve @mention for replyTo=${replyTo}; sending without explicit mention`,
        "warning",
      );
    }
    return target.client
      .send(resolution.resolvedText, meta)
      .then((result) => {
        target.replies.remember(result.id);
        target.replyChain.remember(result.id, resolution.resolvedText, result.ts);
        target.recent.record({
          id: result.id,
          from: target.env.agent,
          text: resolution.resolvedText,
          ts: result.ts,
          mentions: result.mentions,
          ...(meta !== undefined ? { meta } : {}),
        });
        // Local echo.
        pi.sendMessage(
          {
            customType: "chat-out",
            content: `${target.env.prefix}${resolution.resolvedText}`,
            display: true,
            details: { room: target.env.room, agent: target.env.agent, alias: target.alias },
          },
          { triggerTurn: false },
        );
        return result;
      });
  }

  function reconnectRoom(room: RoomSelector): Promise<void> {
    const selector = room ?? "all";
    const targets: ChatRoomHandle[] = [];
    if (selector === "all") {
      targets.push(...handles);
    } else {
      const h = resolve(selector);
      if (!h) return Promise.reject(new Error(`unknown room: ${String(selector)}`));
      targets.push(h);
    }
    return Promise.allSettled(
      targets.map(async (h) => {
        await h.client.close();
        h.nameDormant.value = false;
        h.nameDormantNotified.value = false;
        h.dedupe.clear();
        h.cooldown.clear();
        h.replies.clear();
        h.recent.clear();
        h.replyChain.clear();
        h.autoReply.clear();
        h.roster.clear();
        h.lastAnnouncedRoster.clear();
        h.presenceDeltaSinceAnnounce.value = 0;
        h.ackCounters.clear();
        await h.client.start();
      }),
    ).then(() => undefined);
  }

  function setAutoreply(room: RoomSelector, enabled: boolean, mode?: AutoReplyMode): void {
    const selector = room ?? "primary";
    const targets: ChatRoomHandle[] = [];
    if (selector === "all") {
      targets.push(...handles);
    } else {
      const h = resolve(selector);
      if (h) targets.push(h);
    }
    for (const h of targets) {
      h.autoreply.value = enabled;
      if (mode) h.autoreply.mode = mode;
    }
  }

  const deps: ChatRuntimeDeps = {
    listRooms: () => handles.map(summarize),
    roomCount: () => handles.length,
    aliases: () => handles.map((h) => h.alias),
    getStatus: (room) => {
      const h = resolve(room) ?? byAlias.get(primaryAlias);
      return snapshot(h ?? byAlias.get(primaryAlias)!);
    },
    resolveRoom: (room) => {
      const h = resolve(room);
      return h ? snapshot(h) : undefined;
    },
    requireRoom: (room) => {
      // Reject `"all"` explicitly so single-room-targeted tools
      // (`chat_list_agents`, `chat_history`, etc.) don't silently fetch
      // primary's data when the LLM passes `room="all"`. Aggregating
      // tools should call `deps.listRooms()` + iterate instead.
      if (room === "all") {
        throw new Error(
          `room="all" is not supported here; use chat_whoami for cross-room summaries or pass an alias`,
        );
      }
      const h = resolve(room) ?? byAlias.get(primaryAlias);
      if (!h) {
        const known = handles.map((x) => x.alias.toLowerCase()).sort().join(", ");
        throw new Error(
          `unknown room: ${JSON.stringify(room)} (known: ${known || "<none>"})`,
        );
      }
      return snapshot(h);
    },
    fetchJson: <T = unknown>(room: RoomSelector, path: string) => {
      const h = resolve(room) ?? byAlias.get(primaryAlias);
      if (!h) return Promise.reject(new Error("no_rooms_joined"));
      return fetchJsonForStatus<T>(h, path);
    },
    fetchJsonForStatus: <T = unknown>(status: ChatStatus, path: string) => {
      // Match by (room, server) pair — server is included so two rooms on
      // different servers with the same name still resolve independently.
      // Within a single server, room names are unique by server contract.
      const h = handles.find((x) => x.env.room === status.env.room && x.env.server === status.env.server);
      if (!h) return Promise.reject(new Error("status_not_in_runtime"));
      return fetchJsonForStatus<T>(h, path);
    },
    formatHistory: (items) => {
      const arr = Array.isArray(items) ? items as Array<{ id: string; from: string; text: string; ts: number }> : [];
      if (arr.length === 0) return "(no messages in history)";
      return arr
        .map((m) => {
          const t = new Date(m.ts).toISOString().replace("T", " ").replace(/\..+/, "");
          return `${t}  ${m.from.padEnd(8)}  ${m.text}`;
        })
        .join("\n");
    },
    sendOutbound,
    reconnect: reconnectRoom,
    setAutoreply,
    notify: (text, level) => ctx.ui.notify(text, level ?? "info"),
    getFocusedAlias: () => focused.value,
    setFocusedAlias: (alias) => {
      if (alias === null || alias === "") {
        focused.value = primaryAlias;
      } else {
        const target = alias.toUpperCase();
        if (byAlias.has(target)) focused.value = target;
      }
      applyMultiStatus();
    },
  };

  // Per-room event wiring (status + SSE events + inbound + errors).
  for (const h of handles) {
    h.client.onStatus((status) => {
      if (status.state === "conflict") {
        if (!h.nameDormant.value && !h.nameDormantNotified.value) {
          ctx.ui.notify(
            `[chat #${h.env.room}] name '${h.env.agent}' is in use — staying dormant`,
            "warning",
          );
          h.nameDormantNotified.value = true;
        }
        h.nameDormant.value = true;
      }
      if (status.state === "connected") {
        const info = status.info as { agents?: Array<{ name: string }> } | undefined;
        if (Array.isArray(info?.agents)) {
          h.agentCount.value = info.agents.length;
        }
      }
      if (handles.length === 1) {
        // Single-room path uses the original single-line status.
        applyStatus(ctx, buildStatus(h.client.status, h.env.agent, h.env.room, h.nameDormant.value));
      } else {
        applyMultiStatus();
      }
    });

    h.client.onEvent((evt) => {
      switch (evt.kind) {
        case "hello": {
          const hello = evt as unknown as { agents?: Array<{ name: string; connectedAt: number; lastSeen: number }> };
          if (Array.isArray(hello.agents)) {
            h.agentCount.value = hello.agents.length;
            h.roster.clear();
            for (const a of hello.agents) if (a.name !== h.env.agent) h.roster.add(a.name);
            announceRosterIfChangedForHandle(ctx, h, true);
          }
          break;
        }
        case "presence": {
          const verb = evt.action === "joined" ? "joined" : "left";
          ctx.ui.notify(`[chat #${h.env.room}] ${evt.agent} ${verb}`, "info");
          if (evt.action === "joined" && evt.agent !== h.env.agent) h.roster.add(evt.agent);
          else if (evt.action === "left") h.roster.delete(evt.agent);
          announceRosterIfChangedForHandle(ctx, h, false);
          break;
        }
        case "message": {
          handleInbound(ctx, h, evt);
          break;
        }
        case "goodbye":
          ctx.ui.notify(`[chat #${h.env.room}] server shutting down (${evt.reason})`, "warning");
          break;
        case "ping":
          break;
      }
    });

    h.client.onError((e) => {
      if (e.phase === "send") {
        const code = (e.error as { code?: string })?.code;
        const status = (e.error as { status?: number })?.status;
        if (code === "rate_limit") {
          ctx.ui.notify("[chat] rate-limited by server (≥10 msg/s)", "warning");
        } else if (code === "agent_not_connected" || status === 400) {
          ctx.ui.notify(`[chat] send rejected: ${code ?? "bad_request"}`, "warning");
        } else {
          ctx.ui.notify(
            `[chat #${h.env.room}] send error: ${(e.error as Error).message ?? String(e.error)}`,
            "warning",
          );
        }
      } else if (e.phase === "connect" && !h.nameDormant.value) {
        const msg = (e.error as Error)?.message ?? String(e.error);
        if (!msg.includes("409")) {
          ctx.ui.notify(`[chat #${h.env.room}] connect error: ${msg}`, "warning");
        }
      }
    });
  }

  // Consolidated Pi event hooks.
  pi.on("before_agent_start", (event) => {
    // Fan out: build per-room context blocks and concatenate them, one
    // per joined room that has either recent activity or auto-reply
    // enabled. Accumulating into a single string (instead of list-join)
    // avoids the `\n\n\n\n` artefact that list-join produces on top of
    // the per-room `systemPrompt + "\n\n" + block` separator.
    let acc = event.systemPrompt;
    let appended = false;
    for (const h of handles) {
      if (h.nameDormant.value) continue;
      const next = buildChatRoomSystemPrompt(
        h.env,
        h.roster,
        h.recent,
        h.autoreply.value,
        "", // compose each block in isolation; we control the separator
      );
      if (next !== undefined) {
        acc = acc.length > 0 ? `${acc}\n\n${next}` : next;
        appended = true;
      }
    }
    if (!appended || acc === event.systemPrompt) return undefined;
    return { systemPrompt: acc };
  });

  const pumpTimer = setInterval(() => {
    for (const h of handles) h.autoReply.pump();
  }, AUTO_REPLY_PUMP_MS);
  if (typeof pumpTimer.unref === "function") pumpTimer.unref();

  pi.on("agent_end", () => {
    for (const h of handles) h.autoReply.markTurnDone();
  });

  let shutdownInProgress = false;
  const shutdownFn = async (): Promise<void> => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    clearInterval(pumpTimer);
    await Promise.allSettled(handles.map(async (h) => {
      h.autoReply.clear();
      try { await h.client.close(); } catch { /* noop */ }
    }));
  };
  pi.on("session_shutdown", () => { void shutdownFn(); });

  // Boot every room in parallel.
  void Promise.allSettled(handles.map((h) => h.client.start())).then(() => {
    applyMultiStatus();
  });

  if (handles.length === 1) {
    ctx.ui.notify(
      `[chat] joined #${handles[0].env.room} as ${handles[0].env.agent} (${describeEnv(handles[0].env)})`,
      "info",
    );
  } else {
    const summary = handles.map((h) => `#${h.env.room}/${h.env.agent}`).join(", ");
    ctx.ui.notify(`[chat] joined ${handles.length} rooms: ${summary}`, "info");
  }

  return { deps, shutdown: shutdownFn };
}

function announceRosterIfChangedForHandle(
  ctx: ExtensionContext,
  h: ChatRoomHandle,
  isFullReseed: boolean,
): void {
  const current = [...h.roster].sort().join(",");
  const last = [...h.lastAnnouncedRoster].sort().join(",");
  if (current === last) return;
  if (!isFullReseed) {
    h.presenceDeltaSinceAnnounce.value += 1;
    if (h.presenceDeltaSinceAnnounce.value < 2) return;
  }
  h.presenceDeltaSinceAnnounce.value = 0;
  h.lastAnnouncedRoster = new Set(h.roster);
  const text = h.roster.size === 0
    ? `[chat #${h.env.room}] agents now: (none connected)`
    : `[chat #${h.env.room}] agents now: ${[...h.roster].sort().map((n) => `@${n}`).join(", ")}`;
  ctx.ui.notify(text, "info");
}

function handleInbound(
  ctx: ExtensionContext,
  h: ChatRoomHandle,
  message: {
    id: string;
    from: string;
    text: string;
    ts: number;
    mentions: string[];
    meta?: Record<string, unknown>;
  },
): void {
  const env = h.env;

  if (isFromSelf({ ...message }, env.agent)) return;
  if (!h.dedupe.accept(message.id)) return;

  const replyTo = message.meta?.replyTo;
  const isThreadReply =
    typeof replyTo === "string" && h.replyChain.has(replyTo, message.ts);

  if (!isThreadReply && h.cooldown.isOnCooldown(message.from, message.ts)) return;
  if (!isThreadReply) h.cooldown.record(message.from, message.ts);

  h.recent.record({
    id: message.id,
    from: message.from,
    text: message.text,
    ts: message.ts,
    mentions: message.mentions,
    ...(message.meta !== undefined ? { meta: message.meta } : {}),
  });

  let matchedAutoReply = shouldAutoReply(
    { ...env, autoreply: h.autoreply.value, autoreplyMode: h.autoreply.mode } as ChatEnv,
    message,
    h.replies,
  );

  if (matchedAutoReply) {
    if (isAcknowledgment(message.text)) {
      const currentCount = h.ackCounters.get(message.from) ?? 0;
      h.ackCounters.set(message.from, currentCount + 1);
      if (currentCount + 1 > MAX_ACK_ROUNDS) {
        matchedAutoReply = false;
        ctx.ui.notify(
          `[chat #${env.room}] suppressed auto-reply to @${message.from} (ack loop limit reached)`,
          "debug",
        );
      }
    } else {
      h.ackCounters.delete(message.from);
    }
  }

  if (matchedAutoReply && !h.nameDormant.value) {
    // Prefix the prompt with the room + alias so the LLM can address the
    // right room even when several rooms have prompts queued.
    const bodyPrompt = env.threadContext
      ? buildThreadPrompt(env, h.recent, message, h.roster)
      : `[chat ${message.from}] ${message.text}`;
    const roomHeader = `Room: #${env.room} (alias: ${h.alias})\n`;
    h.autoReply.enqueue(roomHeader + bodyPrompt);
    return;
  }

  const preview = message.text.length > 200 ? `${message.text.slice(0, 197)}…` : message.text;
  ctx.ui.notify(`[chat #${env.room} ${message.from}] ${preview}`, "info");
}

export function _testHandleInbound(
  ctx: ExtensionContext,
  h: ChatRoomHandle,
  message: Parameters<typeof handleInbound>[2],
): void {
  handleInbound(ctx, h, message);
}
