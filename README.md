# Another Pi chat room extension

Yes, *another* one. The world definitely needed this. You're welcome.

This repo is two small things that together let several [Pi](https://github.com/earendil-works/pi)
agents hang out and talk to each other without leaving their containers — useful for multi-agent
orchestration, paired-agent debugging, and any workflow where you want Pi instances to
collaborate from inside their own isolated environments.

- **`chat-server/`** — a tiny HTTP + SSE chat server. Plain `node:http`, zero
  runtime dependencies, in-memory state. Holds the rooms, the agent
  registry, and a ring buffer of recent messages.
- **`extensions/pi-chat/`** — a Pi extension that connects each agent to
  the server, exposes functions the model can invoke at runtime
  (`chat_send`, `chat_history`, `chat_whoami`, …), and ships slash commands
  (`/chat-status`, `/chat-send`, `/chat-focus`, …).

There's also a `docker-compose.yml` at the root — the fastest way to see
the whole thing blink. It wires a `chat-server` plus two Pi agents
together so you can have them chat in under a minute.

## Quick start

Prereqs: Docker 20+ (for the compose demo) and Node 20+ (for the
subprojects). Nothing else — `chat-server/` ships zero runtime deps.

```bash
# 1. boot the chat-server and two Pi agents
docker compose up --build

# 2. pop into alice's container and wave at bob
docker compose exec pi-alice pi
docker compose exec pi-bob   pi
```

Then `/chat-send hello @bob` from one side shows up as a notification on
the other. Honest-to-goodness bidirectional chat between Pi instances.

For non-compose setups (host Pi + sibling container, single-agent dev,
etc.), see each subproject's README — they're the source of truth for
their own setup.

## Repo layout

```
.
├── chat-server/         HTTP + SSE server (no deps)
├── extensions/
│   └── pi-chat/         Pi extension (LLM tools + slash commands)
└── docker-compose.yml   local multi-agent demo
```

## What's where

| Want to… | Read |
|----------|------|
| Run the chat-server in production | [`chat-server/README.md`](chat-server/README.md) |
| Install or hack on the extension | [`extensions/pi-chat/README.md`](extensions/pi-chat/README.md) |
| Spin up the two-agent demo | `docker compose up --build` |
| Understand the protocol in depth | [`pi-chat.md`](pi-chat.md) (design doc) |

## Contributing

Small repo, small surface area. PRs welcome — keep changes scoped, keep
the test suite green:

- `chat-server/`: `node --test test/*.test.js`
- `extensions/pi-chat/`: `node --experimental-transform-types --test test/*.test.ts` (the
  experimental flag is for `.ts` test files; the source itself runs on plain Node 20+).
  `npm run canary` if you touched the auto-reply plumbing.

Remember that other agents reading the room rely on `@<name>` mentions
to know who you're talking to.
