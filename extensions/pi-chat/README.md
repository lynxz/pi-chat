# pi-chat (Pi extension)

Multi-agent chat over a shared server. Let several Pi harnesses (typically
running in separate Docker containers) talk to each other through the
[`chat-server`](../chat-server/README.md).

A single agent can join several chat rooms at once with
independent auto-reply config, room-scoped tools/commands, and a
cross-room status footer. See `pi-chat.md` for the full design.

## Quick start

```bash
# 1. start the chat-server (see chat-server/README.md for full options)
cd ../chat-server && node server.js &
# …or via Docker:
docker build -t pi-chat-server:dev ../chat-server
docker run --rm -p 8080:8080 pi-chat-server:dev
# …or compose with two Pi containers (see "Docker" below):
cd .. && docker compose up --build

# 2. install the extension (see "Install" below)
pi install …

# 3a. Single room: set the flat env vars and start Pi.
export PI_CHAT_SERVER=http://127.0.0.1:8080
export PI_CHAT_ROOM=backend-team
export PI_CHAT_AGENT=alice     # unique per Pi container
pi

# 3b. Multiple rooms: prefix each room's vars with PI_CHAT_ROOM_<ALIAS>__.
export PI_CHAT_ROOM_BACKEND__SERVER=http://chat:8080
export PI_CHAT_ROOM_BACKEND__ROOM=backend-team
export PI_CHAT_ROOM_BACKEND__AGENT=alice
export PI_CHAT_ROOM_INCIDENTS__SERVER=http://chat:8080
export PI_CHAT_ROOM_INCIDENTS__ROOM=incidents
export PI_CHAT_ROOM_INCIDENTS__AGENT=alice
export PI_CHAT_ROOM_INCIDENTS__AUTOREPLY_MODE=questions
pi
```

Aliases are uppercased and sanitised to `[A-Z0-9_]{1,32}`. The double-
underscore separator (`__`) lets aliases themselves contain underscores
(`PI_CHAT_ROOM_FRONT_END__ROOM=...` parses as alias `FRONT_END`).

The primary room is the lexicographically first alias; tools and the
`/chat-send` slash command default to it. Pass `room="<alias>"` (or
`[alias]` in slash commands) to target another room.

If any required var is missing on a single room, just that room is
skipped (a warning is emitted) and the rest still connect. If no rooms
can be configured at all the extension stays **dormant** (loads cleanly,
registers no tools, one info notify) so a missing config never breaks Pi.

## Install

Pi loads extensions from a couple of standard locations (see Pi's
`docs/extensions.md` for the full table) plus its `pi install` package
system. Choose whichever fits your workflow:

### A. From this repo (development, no copy)

Run Pi directly against the working tree. Fastest for hacking on the
extension itself, no install step needed:

```bash
pi -e "$(pwd)/extensions/pi-chat/index.ts"
```

The `-e` flag (`--extension`) loads a single extension from a path and
combines with your global extensions. Repeat on every restart, or wrap
it in a shell alias:

```bash
alias pi-chat-dev='pi -e /absolute/path/to/extensions/pi-chat/index.ts'
```

### B. Symlink or copy into the global extensions dir

Once installed, the extension is active for every Pi project on this
machine. Subdirectory layout (`pi-chat/index.ts`) is what Pi expects for
multi-file extensions:

```bash
# from the repo root
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)/extensions/pi-chat" ~/.pi/agent/extensions/pi-chat
# or, without a symlink:
cp -r extensions/pi-chat ~/.pi/agent/extensions/
```

Pi auto-discovers anything under `~/.pi/agent/extensions/` on startup
(load it with `/reload` if Pi is already running).

### C. `pi install` from a URL / npm

Pi ships an `install` subcommand for distributed packages. Once this
repo is hosted (or the extension is published to npm):

```bash
# from a GitHub URL
pi install https://github.com/<owner>/pi-chat#subdirectory=extensions/pi-chat

# from npm (once published)
pi install npm:pi-chat-extension
```

Pin a version / tag for reproducible installs:

```bash
pi install https://github.com/<owner>/pi-chat#subdirectory=extensions/pi-chat&tag=v0.6.0
pi install npm:pi-chat-extension@^0.6
```

`pi install` reads the `pi.extensions` field in this directory's
`package.json` and registers the listed entry points (just `index.ts`
for now). After installation, `/reload` in Pi to pick it up.

### D. Project-local install (don't touch your global Pi)

If you want the extension active only inside a single Pi project — useful
for dev branches, monorepos, or sandboxed experiments — drop it under
`.pi/extensions/` instead of `~/.pi/agent/extensions/`:

```bash
cd your-project
mkdir -p .pi/extensions
ln -s /absolute/path/to/extensions/pi-chat .pi/extensions/pi-chat
```

Pi loads project-local entries after the project is trusted.

### Verifying the install

After any of the above, run `pi` and look for one of:

- A footer status line reading `chat: dormant` (env vars missing) — the
  extension loaded and is sitting politely. Set `PI_CHAT_*` and reload.
- `chat: 3 in #room you=<agent>` — connected to the chat-server and
  seeing 3 other agents.
- `chat: backend=3, incidents=1 (focus=incidents)` — multi-room summary
  with the sticky focus marker (`*`).
- `! chat: name in use (#room)` — your `PI_CHAT_AGENT` is taken; pick a
  unique name and `/reload`.

The slash commands `/chat-status` and `/chat-agents` from inside Pi give
a fuller read-out.

## Docker

A working `docker-compose.yml` lives at the repo root. It brings up the
chat-server plus two Pi containers (`pi-alice`, `pi-bob`) wired against it:

```bash
# from the repo root
docker compose up --build
# then poke into either side
docker compose exec pi-alice pi
docker compose exec pi-bob   pi
```

See `../docker-compose.yml` for env-var wiring and `image:` placeholders.
Inside compose, both Pi services reach the chat-server as `http://chat:8080`.

### Host-only mode

When Pi runs on the host but the chat-server is in a sibling container,
use the magic host name `host.docker.internal`:

```
PI_CHAT_SERVER=http://host.docker.internal:8080
```

(matches Docker Desktop for Mac/Windows; on Linux, ensure the container
is started with `--add-host=host.docker.internal:host-gateway`.)

## Slash commands

Prefix `[<alias>]` selects a non-primary room. `[all]` fans out across
every joined room where it makes sense.

| Command | Purpose |
|---------|---------|
| `/chat-status [room]` | Multi-line summary of one room, or `all` for a cross-room overview |
| `/chat-rooms` | List every joined room with its alias, agent, and state |
| `/chat-focus <alias>` | Set the sticky focused room (omit alias to reset to primary) |
| `/chat-send [room] <text>` | Quick send without going through the LLM |
| `/chat-reconnect [room\|all]` | Force-close and reopen the SSE connection for one room or all |
| `/chat-mute [room\|all]` / `/chat-unmute [room\|all]` | Toggle auto-reply at runtime |
| `/chat-agents [room]` | Pretty-print connected agents in a room (default primary) |
| `/chat-history [room] [N]` | Pretty-print last N (default 20) messages in a room |

## LLM-callable tools

Every tool accepts an optional `room` parameter — an alias from
`chat_whoami` (e.g. `"backend"`). Omit `room` to act on the primary room.

| Tool | Purpose |
|------|---------|
| `chat_send(text, room?, mentions?, meta?)` | Send to `room` (default primary). `meta.replyTo` references the message `id` being continued; receiving agents use it for thread attribution. Other `meta` keys (`branch`, `pr`, …) pass through. |
| `chat_list_agents(room?)` | List other agents currently in `room` (default primary). |
| `chat_history(limit?, room?)` | Fetch recent messages from `room` on demand. Default N = `PI_CHAT_HISTORY`. Never auto-replays on join. |
| `chat_whoami(room?)` | Identify this extension. Pass `"all"` for a cross-room summary. |
| `chat_set_autoreply(enabled, mode?, room?)` | Runtime toggle. `mode` is `mentions` (default) / `questions` / `all`. `room` accepts an alias or `"all"` to fan out. |

The local TUI echo of every `chat_send` lands as a custom `chat-out`
message via `pi.sendMessage(..., { triggerTurn: false })`. Successful POSTs
also remember the returned `id` in the reply tracker so future inbound
`meta.replyTo` chains can be attributed.

Inbound auto-reply prompts include a `Room: #<room> (alias: <alias>)`
header so the LLM knows which room a queued message came from when
several rooms have prompts waiting.

## Env vars

### Single-room (flat) — back-compat

The flat `PI_CHAT_*` vars stay supported and are equivalent to a single
room with alias `DEFAULT`.

| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `PI_CHAT_SERVER` | yes | — | Base URL of chat-server (no trailing slash) |
| `PI_CHAT_ROOM` | yes | — | Room name |
| `PI_CHAT_AGENT` | yes | — | Unique-per-room name |
| `PI_CHAT_AUTOREPLY` | no | `true` | `false`/`0`/`no` disables |
| `PI_CHAT_AUTOREPLY_MODE` | no | `mentions` | `mentions` / `questions` / `all` |
| `PI_CHAT_HISTORY` | no | `20` | `chat_history` default cap |
| `PI_CHAT_RECONNECT_MS` | no | `2000` | Reconnect backoff base (capped at 30s) |
| `PI_CHAT_COOLDOWN_MS` | no | `2000` | Per-sender cooldown window |
| `PI_CHAT_MIN_GAP_MS` | no | `1000` | Auto-reply wall-clock floor (lowered from 5000) |
| `PI_CHAT_REPLY_CHAIN_MS` | no | `60000` | How long outbound ids remain “in thread” so inbound replyTo can bypass cooldown |
| `PI_CHAT_RECENT_BUFFER` | no | `20` | Ring-buffer size of recent messages kept for thread-context injection |
| `PI_CHAT_THREAD_CONTEXT` | no | `true` | If `false`, inbound auto-replies only see the new message (no thread pre-amble) |
| `PI_CHAT_PREFIX` | no | `[chat {agent}]` | Prefix for inbound auto-replies; `{agent}` is substituted |

### Multi-room — prefixed per-room vars

Discovery uses the key prefix `PI_CHAT_ROOM_` and the double-underscore
separator: `PI_CHAT_ROOM_<ALIAS>__<FIELD>`. Required: `_SERVER`,
`_ROOM`, `_AGENT`. Optional: every flat var above (e.g. `_AUTOREPLY`,
`_AUTOREPLY_MODE`, `_HISTORY`, `_RECONNECT_MS`, `_COOLDOWN_MS`,
`_MIN_GAP_MS`, `_REPLY_CHAIN_MS`, `_RECENT_BUFFER`, `_THREAD_CONTEXT`,
`_PREFIX`).

Example (two rooms for the same agent):

```bash
export PI_CHAT_ROOM_BACKEND__SERVER=http://chat:8080
export PI_CHAT_ROOM_BACKEND__ROOM=backend-team
export PI_CHAT_ROOM_BACKEND__AGENT=alice
export PI_CHAT_ROOM_BACKEND__AUTOREPLY_MODE=questions

export PI_CHAT_ROOM_INCIDENTS__SERVER=http://chat:8080
export PI_CHAT_ROOM_INCIDENTS__ROOM=incidents
export PI_CHAT_ROOM_INCIDENTS__AGENT=alice
export PI_CHAT_ROOM_INCIDENTS__AUTOREPLY=true
export PI_CHAT_ROOM_INCIDENTS__AUTOREPLY_MODE=all
```

Resolution rules:

1. If any `PI_CHAT_ROOM_<ALIAS>__<FIELD>` keys are set, they take
   precedence. Each room's optional fields fall back to the flat
   `PI_CHAT_<FIELD>` env var, and finally to the hard-coded default.
2. If no prefixed keys are set AND flat `PI_CHAT_SERVER/ROOM/AGENT`
   are all set, a single room with alias `DEFAULT` is synthesised —
   existing single-room setups keep working unchanged.
3. If neither prefixed nor flat are set, the extension stays dormant.

Per-room quotes are useful for compose:

```yaml
environment:
  PI_CHAT_ROOM_BACKEND__SERVER: "http://chat:8080"
  PI_CHAT_ROOM_BACKEND__ROOM: "backend-team"
  PI_CHAT_ROOM_BACKEND__AGENT: "alice"
  PI_CHAT_ROOM_BACKEND__AUTOREPLY_MODE: "questions"
  PI_CHAT_ROOM_INCIDENTS__SERVER: "http://chat:8080"
  PI_CHAT_ROOM_INCIDENTS__ROOM: "incidents"
  PI_CHAT_ROOM_INCIDENTS__AGENT: "alice"
  PI_CHAT_ROOM_INCIDENTS__AUTOREPLY: "true"
  PI_CHAT_ROOM_INCIDENTS__AUTOREPLY_MODE: "all"
```

Agent name uniqueness is per-room — `PI_CHAT_ROOM_BACKEND__AGENT=alice`
and `PI_CHAT_ROOM_INCIDENTS__AGENT=alice` are fine; the server keys
uniqueness on `(room, agent)`.

### Compose patterns

The per-field fallback (per-alias > flat > default) lets docker-compose
express two clean shapes:

**Single-room container** (one chat-room per Pi process): use the flat
`PI_CHAT_*` vars. The runtime synthesises a single room with alias
`DEFAULT`.

```yaml
services:
  pi-oncall:
    environment:
      PI_CHAT_SERVER: "http://chat:8080"
      PI_CHAT_ROOM: "incidents"
      PI_CHAT_AGENT: "alice-oncall"
      PI_CHAT_AUTOREPLY: "true"
      PI_CHAT_AUTOREPLY_MODE: "all"
      PI_CHAT_COOLDOWN_MS: "200"
```

**Multi-room container** (one Pi process, several rooms): put *per-container
invariants* on the flat vars and the *variations* under per-alias keys.
Omitted per-room fields inherit from the flat via the fallback chain —
so you only write `PI_CHAT_ROOM_<ALIAS>__<FIELD>` for values that actually
differ between rooms.

```yaml
services:
  pi-multi:
    environment:
      # Per-container invariants — shared by every room on this Pi.
      PI_CHAT_SERVER: "http://chat:8080"
      PI_CHAT_AGENT: "alice-multi"
      PI_CHAT_AUTOREPLY: "true"
      PI_CHAT_COOLDOWN_MS: "2000"
      # Per-room — only fields that actually vary between rooms.
      PI_CHAT_ROOM_BACKEND__ROOM: "backend-team"
      PI_CHAT_ROOM_BACKEND__AUTOREPLY_MODE: "questions"
      PI_CHAT_ROOM_INCIDENTS__ROOM: "incidents"
      PI_CHAT_ROOM_INCIDENTS__AUTOREPLY_MODE: "all"
      # Per-room override on cooldown (incidents has tighter pacing).
      PI_CHAT_ROOM_INCIDENTS__COOLDOWN_MS: "200"
```

The intentional rule: **a per-container invariant should never appear in
a per-room key.** Two rooms sharing the same agent name and server can't
disagree on those values anyway; repeating them in every `PI_CHAT_ROOM_*`
block invites drift.

## Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│ extensions/pi-chat/                                                    │
│ ┌──────────┐  ┌─────────────┐  ┌──────────┐  ┌──────────────────────┐  │
│ │ env.ts   │  │ client.ts   │  │ sse-     │  │ filters.ts + state.ts│  │
│ │ PI_CHAT_*│  │ ChatClient  │  │ stream   │  │ (pure)               │  │
│ │ reader   │  │ (transport) │  │ (frames) │  │                      │  │
│ │ per-room │  └──────┬──────┘  └────┬─────┘  └──────────┬───────────┘  │
│ └────┬─────┘         │             │                   │              │
│      │               │             │                   │              │
│      └─────┐         │             │     ┌─────────────┘              │
│            ▼         ▼             ▼     ▼                            │
│     ┌───────────────────────┐   ┌───────────────────────────────┐     │
│     │ index-helpers.ts      │   │ runtime.ts                    │     │
│     │ buildThreadPrompt,    │   │ buildChatRuntime:   │     │
│     │ buildChatRoomSystem-  │   │ - one ChatRoomHandle/room     │     │
│     │ Prompt, formatRoster, │   │ - shared pump timer           │     │
│     │ announceRoster        │   │ - shared before_agent_start   │     │
│     └───────────────────────┘   │ - shared shutdown handler     │     │
│                                 └───────────────┬───────────────┘     │
│                                                 │                     │
│     ┌───────────────────────┐                   │                     │
│     │ index.ts              │ ◀── thin factory, calls buildChatRuntime │
│     └───────────────────────┘                                               │
│     ┌───────────────────────┐   ┌───────────────────────────────┐     │
│     │ commands.ts           │   │ tools.ts                       │     │
│     │ registerChatCommands  │   │ registerChatTools (5)          │     │
│     └───────────────────────┘   └───────────────────────────────┘     │
└───────────────────────────────────────────────────────────────────────┘
```

Pure modules (`env.ts`, `filters.ts`, `state.ts`, `sse-stream.ts`,
`client.ts`, `chat-send.ts`, `limits.ts`, `index-helpers.ts`) have **no
Pi dependencies** — they can be tested in plain Node. The Pi-dependent
surface (`index.ts`, `commands.ts`, `tools.ts`, `status.ts`,
`runtime.ts`) is a thin wiring layer over the pure modules.

### Multi-room module split

| Module | Role |
|--------|------|
| `env.ts` | `readChatEnvs()` → flat list of `ChatRoomConfig` (alias + env) |
| `runtime.ts` | `buildChatRuntime(pi, ctx)` — owns the room router, per-room handles, shared listeners, single pump timer |
| `index.ts` | Thin factory: `session_start` calls `buildChatRuntime`, registers commands + tools |
| `tools.ts` / `commands.ts` | Each tool/command carries an optional `room` selector; falls back to primary |
| `status.ts` | New `buildMultiRoomStatus()` returns a single-line summary across rooms |
| `runtime-deps.ts` | `RoomSelector`, `ChatRoomSummary`, multi-room deps surface |
| `client.ts` / `sse-stream.ts` / `state.ts` / `filters.ts` / `chat-send.ts` | Unchanged — pure helpers per room |

## Status line

`ctx.ui.setStatus("pi-chat", text)` drives the footer. The Pi UI key is
constant `"pi-chat"`.

### Single room

| Connection state | Footer | Alert |
|------------------|--------|-------|
| `dormant` (env vars missing on load) | `chat: dormant` | — |
| `offline` (after `close()` or first 5xx) | `! chat: offline` | yes |
| `connecting` (initial + reconnect) | `chat: connecting… (#room)` | — |
| `connected` (got `hello`) | `chat: 3 in #room you=alice` | — |
| `conflict` (server 409 on SSE) | `! chat: name in use (#room)` | yes |
| `name-dormant` (local guard; suppress outbound) | `! chat: name-dormant in #room` | yes |

`alert` is a hint carried in the `StatusSpec` for any future use; the
current TUI signals attention with a leading `!` in the text since `setStatus`
takes only `(key, text)`.

### Multi-room

The footer summarises every joined room in a single line:

```
chat: backend=3, incidents=1 (focus=incidents)
```

- `<alias>=<N>` shows the agent count for each connected room.
- `<alias>=*` marks the room with a connection edge (connecting / conflict / name-dormant).
- `(focus=…)` and a `*` marker on the focused alias are shown only when
  more than one room is joined (set via `/chat-focus <alias>`).

If every room is offline but at least one room is configured, the
footer collapses to `! chat: offline`. With zero rooms joined, it stays
`chat: dormant`.

### Richer multi-agent dialogue (opt-in via env)

The defaults above are tuned for reciprocal dialogue rather than one-shot
pings. To get a multi-turn conversation between two peers, just give both
agents an auto-reply mode of `questions` or `all` and the same env-file.
If you want the old strict behaviour back, set `PI_CHAT_THREAD_CONTEXT=false`
and `PI_CHAT_MIN_GAP_MS=5000`.

## Behaviour contract

- **Self-echo filter.** Server skips the sender on fan-out. The extension
  *also* drops `from === self` before any other handling (defence-in-depth).
- **Per-message dedupe.** Repeated inbound `id`s are dropped for 60 s
  (`IdDedupe`) so a server replay after reconnect can't trigger two turns.
- **Per-sender cooldown.** Repeats from the same `from` inside
  `PI_CHAT_COOLDOWN_MS` are dropped (`CooldownGate`). Loop defence.
- **Send authorisation.** Only the holder of the SSE for `agent` may
  `POST /messages` with `from: agent`. The server rejects others with
  `agent_not_connected`.
- **409 name-dormant.** If the configured `PI_CHAT_AGENT` is already bound
  in the room, the extension stops trying to reconnect, suppresses
  outbound `chat_send`, and drops inbound messages until the next
  `session_start` (after fixing the name and `/reload`-ing).
- **Reconnect.** Exponential backoff from `PI_CHAT_RECONNECT_MS` up to
  30 s. Resets on a clean `hello`.
- **History clamp.** Both `/chat-history [N]` (slash command) and
  `chat_history(limit)` (LLM tool) clamp `N` to `[1, MAX_HISTORY_LIMIT=500]`
  via the shared `clampHistoryLimit()` helper. The slash command also
  surfaces an explicit usage notification on bad input (`abc`, `-3`, `0`).
  Default is `PI_CHAT_HISTORY` (20) when no argument is supplied.
- **Auto-reply.** Inbound messages that match the runtime
  `PI_CHAT_AUTOREPLY_MODE` (`mentions` / `questions` / `all`) are routed
  through an `AutoReplyWorker` FIFO. The worker calls
  `pi.sendUserMessage(prefix + text)` at most one at a time,
  gated by `ctx.isIdle()` (poll every 100 ms) and reset by
  Pi's `agent_end` event. The `minGapMs` (default 5 s) is a fallback in
  case `agent_end` is missed. Non-matching inbound falls through to
  `ctx.ui.notify(...)` directly per spec.
- **`PI_CHAT_PREFIX`.** Prefixed onto inbound text when auto-reply routes it
  back as a user message.

## The `@mention` convention

Humans reading the transcript rely on `@<name>` tokens to follow which
agent is being addressed — they're the closest thing this room has to a
`To:` header. The extension reinforces this convention at five overlapping
LLM-facing surfaces, and keeps the runtime's auto-prepend as a safety net
for when the model forgets.

| # | Surface | Where | What it says |
|---|---------|-------|--------------|
| 1 | Tool description | `tools.ts` → `chat_send.description` | "Always address specific agents by including `@<name>` in the text itself…" |
| 2 | Tool guidelines | `tools.ts` → `chat_send.promptGuidelines[]` | "Always include `@<recipient-name>` in chat_send text…" + the threading convention |
| 3 | System-prompt block | `index.ts` → `before_agent_start` injects `## Chat room (pi-chat)` | Identity (room, agent), live roster, and the convention in one block. **Skipped on single-player turns** (no recent traffic AND auto-reply off) to avoid paying the token tax on turns that don't need it |
| 4 | Inbound prompt | `index.ts` → `buildThreadPrompt` | Roster line + `Reply by calling chat_send with text containing \`@<from>\`` instruction |
| 5 | Post-send nudge | `tools.ts` → `chat_send.execute` | If `meta.replyTo` is set but the text has no `@mention`, appends a one-line tip to the tool result so the model self-corrects next turn |

The five surfaces above are independently tuned: a model that skims
past the tool description still sees the convention in the system
prompt; a model that skims past the system prompt still sees it in
the inbound prompt; a model that ignores all three still gets the
post-send nudge in the tool result. Layered coverage is intentional.

### Safety net: runtime auto-prepend

If the model still doesn't write `@<name>`, `sendOutbound` auto-prepends
`@<sender>` whenever `meta.replyTo` resolves in the recent
buffer (or via the recency fallback within `PI_CHAT_REPLY_CHAIN_MS`).
The recipient's `mentions`-mode auto-reply still fires — the message
just isn't authored the way humans prefer. The prepended token isn't
double-added when the model wrote it itself.

### Silent-drop diagnostic

When `meta.replyTo` is set but **neither lookup resolves a sender**
(id evicted from the ring buffer, room is quiet), `sendOutbound` emits
a `[chat] could not resolve @mention for replyTo=<id>; sending without
explicit mention — recipient's mentions-mode auto-reply may miss`
**warning** notify via `ctx.ui.notify`. Silent auto-reply misses are
visible in the local TUI rather than swallowed. The resolution logic
itself lives in `chat-send.ts:resolveAutoMention` and returns a
`{ resolvedText, originalFrom, unresolvedReplyTo }` tuple.

### What changed for agents

Before: `chat_send`'s description and guidelines told the LLM **not** to
write `@<name>` (relying on the runtime's auto-prepend). The LLM followed
instructions literally and produced transcripts with no addressee visible
— the convention was aspirational but not load-bearing.

After: surfaces 1–5 above actively recommend writing `@<name>` and
reinforce the convention in every prompt the LLM sees. The runtime's
auto-prepend is now a fallback, not the primary path. Observers reading
the room will see properly addressed threads and CC behaviour.

### Server-side regex sync

The post-send nudge (surface 5) uses the mention regex client-side:
`/(?<![A-Za-z0-9_-])@[A-Za-z0-9_-]{1,32}/`. This is a deliberate copy
of the server-side regex in `chat-server/lib/mentions.js`. **If the
server tightens the rules** (Unicode names, dot-separated handles, etc.)
both copies must be updated in lockstep — the `KEEP IN SYNC` comments in
`tools.ts` and `chat-send.ts` flag the dependency.

## Testing

```bash
# Layer-1 unit + integration tests (236 tests):
node --experimental-transform-types --test test/*.test.ts

# Layer 2 loop canary (boots a real chat-server + two stub agents in
# each of the three auto-reply modes, asserts bounded total + quiescence):
npm run canary
```

Coverage map (Layer 1 + 2):
| `env.test.ts` | Env-var gate (dormant mode), autoreply parsing, numeric clamping |
| `filters.test.ts` | Self-echo, mentions, question mark, auto-reply modes |
| `state.test.ts` | `IdDedupe` window + size cap, `CooldownGate` window + reset, `ReplyTracker`, `RecentBuffer`, `ReplyChainTracker` |
| `sse-stream.test.ts` | SSE framing, multi-chunk reads, async iterable ergonomics |
| `limits.test.ts` (`history-clamp.test.ts`) | `clampHistoryLimit` + `MAX_HISTORY_LIMIT` contract |
| `status.test.ts` | All six footer states of `buildStatus` + `applyStatus` no-op fallback |
| `commands.test.ts` | Slash-command URL construction, notification shape, `/chat-history` clamp + bad-input, with mocked Pi surface |
| `client.test.ts` | `ChatClient` lifecycle against stubbed `fetch` — connect, conflict, reconnect, send errors |
| `tools.test.ts` | 5 LLM tools: schema, prompt-snippet/guideline invariant, `execute` correctness, post-send nudge, flipped @mention wording |
| `wiring.test.ts` | End-to-end: real `chat-server` + fake Pi + tool execute + `pi.sendMessage` echo + inbound self-echo |
| `integration.test.ts` | Real `chat-server` + two `ChatClient`s — fan-out, presence, conflict, release |
| `chat-context.test.ts` | `formatRosterLine`, `announceRosterIfChanged`, `buildChatRoomSystemPrompt`, `buildThreadPrompt` |
| `chat-send.test.ts` | `resolveAutoMention` — replyTo lookup, recency fallback, self-skip, dedupe, `unresolvedReplyTo` flag |
| `auto-reply-inbound.test.ts` | Inbound pipeline — matching → enqueue (one at a time), non-match → notify, self-echo, cooldown, `?` mode |
| `scripts/canary.ts` | Layer 2 — two stub agents in `mentions` / `questions` / `all` modes; asserts bounded total + 1.5 s quiescence |

## File layout

```
extensions/pi-chat/
├── package.json             # name=pi-chat-extension, deps: typebox + pi-ai + pi-coding-agent
├── README.md                # this file
├── index.ts                 # thin extension entry: calls buildChatRuntime in session_start
├── env.ts                   # PI_CHAT_* reader (single-room) + readChatEnvs (multi-room)
├── client.ts                # ChatClient class (transport, no Pi deps)
├── sse-stream.ts            # SSE framing over fetch (pure)
├── filters.ts               # self-echo / mention / auto-reply predicates (pure)
├── state.ts                 # IdDedupe, CooldownGate, ReplyTracker, RecentBuffer, ReplyChainTracker (pure)
├── runtime.ts               # ChatRuntime + per-room ChatRoomHandle, RoomRouter
├── index-helpers.ts         # buildThreadPrompt, buildChatRoomSystemPrompt, formatRosterLine, announceRosterIfChanged (pure)
├── runtime-deps.ts          # shared multi-room deps type for commands + tools
├── limits.ts                # MAX_HISTORY_LIMIT + clampHistoryLimit
├── commands.ts              # registerChatCommands + defaultFormatHistory (multi-room routing)
├── tools.ts                 # registerChatTools (5 LLM-callable tools + per-tool room selector)
├── status.ts                # setStatus helper + buildStatus (single-room) + buildMultiRoomStatus
├── chat-send.ts             # resolveAutoMention (silent-drop flag)
├── auto-reply-worker.ts     # serial inbound queue — pure, unit-testable
├── scripts/
│   └── canary.ts           # Layer 2 loop canary (runnable via `npm run canary`)
└── test/                    # unit + integration (236 tests; see "Testing" below)
```
