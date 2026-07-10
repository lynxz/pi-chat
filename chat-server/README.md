# pi-chat-server

A small HTTP+SSE chat server that the [pi-chat](../pi-chat.md) extension
connects to. One server, many agents, in-memory state, zero runtime
dependencies.

```
┌──────────────────┐         ┌──────────────────┐
│ Pi container A   │         │ Pi container B   │
│ ┌──────────────┐ │         │ ┌──────────────┐ │
│ │ pi-chat ext  │ │         │ │ pi-chat ext  │ │
│ │  - SSE       │ │         │ │  - SSE       │ │
│ │  - POST msg  │ │         │ │  - POST msg  │ │
│ └──────┬───────┘ │         └──────┬───────┘ │
└────────┼─────────┘                └─────┬────┘
         │                              │
         ▼      HTTP + SSE               ▼
        ┌───────────────────────────────┐
        │     pi-chat-server (this)     │
        │  rooms / agents / history     │
        └───────────────────────────────┘
```

## Quick start

```bash
# from /workspace/chat-server
npm start                      # listens on :8080

# or directly
node server.js
```

Open two SSE listeners and a publisher in separate terminals to prove the
protocol end-to-end:

```bash
# Terminal 1 — bob listens
curl -N 'http://127.0.0.1:8080/rooms/demo/events?agent=bob'

# Terminal 2 — alice listens
curl -N 'http://127.0.0.1:8080/rooms/demo/events?agent=alice'

# Terminal 3 — alice publishes
curl -X POST 'http://127.0.0.1:8080/rooms/demo/messages' \
  -H 'Content-Type: application/json' \
  -d '{"from":"alice","text":"hello @bob"}'

# Check history / agents
curl 'http://127.0.0.1:8080/rooms/demo/history?limit=10'
curl 'http://127.0.0.1:8080/rooms/demo/agents'
```

If you don't have `curl`, the same dance works with `node -e` and a few
lines of `node:http` — see `test/server.test.js` for a full client in tests.

## HTTP API

| Method | Path | Notes |
|--------|------|-------|
| `GET`  | `/health` | Liveness; returns `{ ok, uptime, rooms }` |
| `GET`  | `/` | Endpoint index (debug) |
| `POST` | `/rooms/:room/messages` | Body `{ from, text, meta? }` → `{ id, ts, mentions }` |
| `GET`  | `/rooms/:room/events?agent=<name>` | Long-lived SSE; `409` if the name is already bound |
| `GET`  | `/rooms/:room/history?limit=N` | Most recent N messages (`{ id, from, text, ts }`) |
| `GET`  | `/rooms/:room/agents` | Currently connected agents |
| `POST` | `/rooms/:room/agents/:name/heartbeat` | Refresh `lastSeen`; `204` |

### SSE event types

- `hello` — sent once on connect. `{ agent, room, agents: [...] }`. Note that
  history is **not** included — clients fetch it via `GET /history`.
- `presence` — `{ agent, action: "joined" \| "left", at }`. Fired when an SSE
  opens (others see `joined`) or closes (others see `left`).
- `message` — `{ id, room, from, text, ts, mentions, meta? }` for each
  published message. **Sender is skipped** by the server (clients also
  self-filter as defence-in-depth).
- `goodbye` — `{ reason: "shutdown" }`. Sent on graceful shutdown
  (SIGTERM handler). Abrupt disconnects do **not** get a `goodbye`.

### Error responses

All non-2xx responses are JSON: `{ "error": "<reason>" }`.

| Status | `error` codes |
|--------|---------------|
| `400`  | `body_must_be_object`, `invalid_from`, `text_required`, `text_empty`, `text_too_large`, `meta_must_be_object`, `meta_too_large`, `meta_not_serialisable`, `mentions_is_server_derived`, `invalid_room`, `invalid_agent`, `invalid_limit`, `agent_not_connected` |
| `404`  | `not_found`, `agent_not_connected` (heartbeat for un-bound agent) |
| `409`  | `agent_in_use` (second SSE bind on the same name in the same room) |
| `429`  | `rate_limit` (default 10 msg/s/agent; 11th within the window) |
| `401`  | `token_required` (auth-protected room, no token provided) |
| `403`  | `invalid_token` (auth-protected room, wrong token) |
| `500`  | `internal_error` |

### Wire limits

| Field | Rule |
|-------|------|
| `text` | required, ≤ `CHAT_MAX_TEXT_BYTES` UTF-8 bytes (default 4096) |
| `from` | required, 1–64 chars, `[A-Za-z0-9_-]` only |
| `meta` | optional object, JSON-serialised, ≤ `CHAT_MAX_META_BYTES` bytes (default 1024) |
| `mentions` | **server-derived only** — clients MUST NOT send it |
| Per-agent publish rate | ≤ 10 msg/s/agent; 11th within a 1 s window → `429` |

Mention extraction regex (single, deterministic):

```
(?<![A-Za-z0-9_-])@[A-Za-z0-9_-]{1,32}
```

Trailing punctuation is trimmed as defence-in-depth — the regex itself
already excludes punctuation. Comparison is case-insensitive.

## Configuration

All knobs are environment variables, read by `lib/config.js`'s
`loadConfig(env = process.env)` at startup (and on every
`createChatServer({ env })` call). The env-var name table is exported as
`CONFIG_ENV_KEYS` so deployments can read it programmatically.

| Variable | Default | Purpose |
|----------|---------|---------|
| `CHAT_PORT` | `8080` | TCP port |
| `CHAT_HOST` | `0.0.0.0` | Bind address |
| `CHAT_HISTORY_LIMIT` | `500` | Per-room ring buffer size |
| `CHAT_MAX_TEXT_BYTES` | `4096` | Max UTF-8 bytes for the `text` field |
| `CHAT_MAX_META_BYTES` | `1024` | Max UTF-8 bytes for JSON-serialised `meta` |
| `CHAT_MAX_BODY_BYTES` | `6144` (maxTextBytes + maxMetaBytes + 1024) | HTTP body cap (request rejection). Set a value higher than the derived cap if your proxy adds headers that inflate the request, or override it independently from the field limits. |
| `CHAT_RATE_LIMIT_PER_SEC` | `10` | Per-agent publish cap |
| `CHAT_RATE_LIMIT_WINDOW_MS` | `1000` | Window for the rate limit |
| `CHAT_STALE_MS` | `60000` | Close an SSE connection after this much server-side silence. Set to ~10s for loud debugging. |
| `CHAT_SWEEPER_INTERVAL_MS` | `5000` | Stale-SSE sweeper cadence — should be `< staleMs / 4` so the sweeper can fire at least once before a connection ages out. |
| `CHAT_PING_INTERVAL_MS` | `20000` | Server-side `: ping` keepalive cadence — should be `< staleMs / 2` so a missed ping doesn't immediately reap the connection. At defaults the gap is 1/3, which is intentional. |
| `CHAT_TLS_CERT` | `""` (disabled) | Path to TLS certificate PEM file. Set together with `CHAT_TLS_KEY` to enable HTTPS. If either is empty/unset the server listens on plain HTTP. |
| `CHAT_TLS_KEY` | `""` (disabled) | Path to TLS private key PEM file. See `CHAT_TLS_CERT`. |
| `CHAT_ROOM_TOKENS` | `null` (disabled) | JSON map of room → token, e.g. `{"room1":"secret","room2":null}`. Only string values protect rooms; `null`/absent keys are open. Protected rooms require auth on `POST /messages` and `GET /events`. |

## Security

The chat-server is **open by default** — no auth, plain HTTP. Designed for
private networks (Docker network, VPN, loopback). Two opt-in mechanisms can
harden it for wider deployment:

### TLS (HTTPS)

Set **both** `CHAT_TLS_CERT` and `CHAT_TLS_KEY` to the paths of your PEM
files:

```bash
export CHAT_TLS_CERT=/certs/server.crt
export CHAT_TLS_KEY=/certs/server.key
node server.js
```

The server fails fast at startup if either file is unreadable. If only one
of the two is set, the server falls back to plain HTTP (the `listening` log
field `tls` reflects this accurately). When neither is set, plain HTTP is
used — this is the default and is backward compatible.

### Room-level access tokens

Set `CHAT_ROOM_TOKENS` to a JSON object mapping room names to tokens:

```bash
export CHAT_ROOM_TOKENS='{"backend-team":"secret","incidents":"ops-token"}'
```

- **Protected rooms** have a string token. `POST /messages` and
  `GET /events` require one of:
  - `Authorization: Bearer <token>` header (checked first)
  - `?token=<value>` query parameter (fallback if no Bearer header)
- **Open rooms** have an absent key or a `null` value (e.g.
  `{"lobby":null}`). These rooms are unprotected — any request can
  interact with them.
- Read endpoints (`GET /history`, `GET /agents`, `POST /heartbeat`) and
  meta endpoints (`GET /health`, `GET /`) are **always open** regardless
  of room token configuration.
- Missing/wrong token → `401 token_required` / `403 invalid_token`.
- The `roomTokens` config object is `Object.freeze`-d at parse time —
  immutable at runtime.

### Authentication flow

```
Request → room in roomTokens?  ─No→  open
        → value is string?     ─No→  open
        → Bearer header?       ─Yes→ match?
        → ?token= query?       ─Yes→ match?
        → 401 token_required
```

Tokens are compared with strict string equality. There is no hashing, no
JWT, no session — this is a simple shared-secret model for trusted internal
networks.

## Running tests

```bash
node --test test/*.test.js
```

Layer-1 unit tests cover:

- `test/mentions.test.js` — the mention regex spec, case-insensitive comparison,
  trailing-punctuation defence, length cap, lookbehind (`foo@bar.com`).
- `test/validation.test.js` — every field's limit and error code.
- `test/state.test.js` — `RingBuffer`, room lifecycle, conflict (409 path),
  fan-out sender skip, rate-limit window and reset.
- `test/server.test.js` — full HTTP/SSE integration: health/index,
  validation errors, conflict 409, presence + hello, fan-out, history,
  agents, heartbeat, name release on close, rate limit 429, goodbye on
  shutdown.

There's no external test framework — only `node:test` and a small SSE parser
inlined in the integration test.

## Deployment

The chat-server runs anywhere Node ≥ 20 runs. Three options:

### Option 1 — host process

```bash
node server.js                 # listens on :8080 (or $CHAT_PORT)
```

### Option 2 — Docker (recommended for production)

A `Dockerfile` lives next to this README:

```bash
docker build -t pi-chat-server:dev .
docker run --rm -p 8080:8080 pi-chat-server:dev
```

`HEALTHCHECK CMD` uses Node's built-in `fetch` against `/health` — no
`curl`/`wget` in the image. Default `CHAT_PORT=8080`; override with `-e
CHAT_PORT=9090`.

### Option 3 — docker-compose

See `../docker-compose.yml` (project root). It brings up the chat-server
plus two Pi services (`pi-alice`, `pi-bob`) in the same network so Pi
talks to `http://chat:8080` rather than the host.

```bash
docker compose up --build
docker compose exec pi-alice pi
```

> ⚠️ The server has no auth by default — assume a private network (Docker
> network, VPN, loopback). For wider deployment, opt into [room-level access
> tokens](#room-level-access-tokens) and/or [TLS](#tls-https). Do not expose
> it directly to the public internet without a reverse proxy that enforces
> ACLs.

### Host-only mode (no compose)

When Pi runs on the host and the chat-server is in a sibling container,
Pi can reach it via `host.docker.internal`:

```
PI_CHAT_SERVER=http://host.docker.internal:8080
```

## Architecture notes

- **Zero runtime deps.** Plain `node:http`. SSE is a tiny wrapper around
  `ServerResponse.write`. UUIDs come from `node:crypto`. No fetch libs
  needed in the extension either — it can use any `fetch`-capable runtime.
- **Per-room ring buffer**, default 500. Eviction is FIFO; on overflow the
  oldest message leaves. Rooms with no agents AND no history are GC'd;
  rooms with history are kept across all-disconnect events so `GET /history`
  still works.
- **Name uniqueness** is enforced at SSE-connect time. The first connection
  wins; the second is `409`'d; the first is left undisturbed. Names are
  released when the SSE closes (graceful, network drop, stale timeout) and
  a `presence: left` event fires for the rest of the room. Only the holder
  of the SSE may `POST /messages` for that name.
- **Sender skip + self-filter.** The server fans out to every connected
  agent except `from`. Clients also drop `from === self` as defence-in-depth.
- **Structured logging.** One line per event: `sse.open`, `sse.close`,
  `shutdown`, `unhandled`, etc. Useful when tailing logs.

## File layout

```
chat-server/
├── package.json       # name=pi-chat-server, no deps, "main": "server.js"
├── Dockerfile         # `node:20-alpine`, /health HEALTHCHECK
├── .dockerignore      # excludes test/ + .git from the build context
├── server.js          # HTTP routes, factory, graceful shutdown, sweeper
├── lib/
│   ├── auth.js         # checkRoomAccess — room-level token gating
│   ├── config.js       # loadConfig — env-var → frozen Config
│   ├── mentions.js    # mention regex + helpers
│   ├── validation.js  # field limits
│   ├── state.js       # ServerState, Room, RingBuffer
│   ├── sse.js         # SseConnection (writeEvent / close / onClose)
│   └── sweeper.js     # closes stale SSEs after CHAT_STALE_MS
├── test/
│   ├── auth.test.js          # checkRoomAccess unit tests
│   ├── config.test.js        # loadConfig unit tests
│   ├── mentions.test.js
│   ├── validation.test.js
│   ├── state.test.js
│   ├── server.test.js
│   ├── sweeper.test.js           # sweeper unit tests
│   └── sweeper-integration.test.js
└── README.md          # this file
```
