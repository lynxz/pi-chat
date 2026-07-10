# Implementation Plan: Optional TLS + Room-Level Access Control

## Architecture Decisions

- **Zero new npm dependencies.** Use `node:https`, `node:tls`, `node:fs` — all built-in.
- **Opt-in only.** No TLS cert → plain HTTP (backward compatible). No room token → open room (backward compatible).
- **Env-driven config.** Follow the existing `loadConfig()` pattern in `lib/config.js`.
- **Route-level auth check.** The dispatcher validates auth before handing off to handlers — clean separation.

---

## Step 1: Add TLS and room-token config to `lib/config.js`

**Action:** Extend `loadConfig()` to parse three new env vars:
- `CHAT_TLS_CERT` (string, path to cert PEM)
- `CHAT_TLS_KEY` (string, path to key PEM)
- `CHAT_ROOM_TOKENS` (string, JSON — e.g. `{"room1":"secret","room2":null}`)

**Rules:**
- `parseString` already exists — reuse it.
- `CHAT_ROOM_TOKENS`: if provided, `JSON.parse` it. If parse fails or it's not an object, fallback to `null` (all rooms open). The parsed value should be `Record<string, string>` — only string values are protected rooms; `null` or absent keys are open.
- Add new entries to `CONFIG_ENV_KEYS`.
- Add new entries to `DEFAULTS` (empty strings for cert/key, `null` for tokens).
- Return frozen config with the three new fields.

**File:** `lib/config.js`

---

## Step 2: Create `lib/auth.js`

**Action:** New file with a single function `checkRoomAccess(config, room, req)`.

**Signature:**
```js
export function checkRoomAccess(config, room, req) {
  // Returns { ok: true } or { ok: false, status: 401|403, error: string }
}
```

**Logic:**
1. If `config.roomTokens` is `null` or doesn't have a key for `room` → `{ ok: true }` (open room).
2. If the room has a token in `config.roomTokens`:
   - Extract the token from the request. Check **both** `Authorization: Bearer <token>` header AND `?token=<value>` query param. Header takes priority if both present.
   - If no token provided → `{ ok: false, status: 401, error: "token_required" }`.
   - If token doesn't match the room's configured token → `{ ok: false, status: 403, error: "invalid_token" }`.
   - If token matches → `{ ok: true }`.

**Note:** The auth check is **stateless** — no server state mutation needed.

**File:** `lib/auth.js` (new)

---

## Step 3: Wire TLS (`node:https`) into `server.js`

**Action:** In `createChatServer()`:
1. Import `node:https`, `node:fs` at the top.
2. After `loadConfig(env)`, check `config.tlsCert && config.tlsKey`.
3. If both are truthy:
   - `fs.readFileSync(config.tlsCert, "utf8")` and `fs.readFileSync(config.tlsKey, "utf8")`.
   - Pass `{ cert, key }` to `https.createServer(options, handler)` instead of `http.createServer(handler)`.
4. If either is missing, fall through to `http.createServer(handler)` (existing behaviour).
5. Wrap the file reads in a try/catch — a missing/unreadable cert file should throw early with a clear message so the server fails fast at startup.
6. Log which transport is active: `ctx._log("listening", { host, port, historyLimit, tls: !!config.tlsCert })`.

**The `server` variable** currently holds `http.createServer(...)`. Change its type to `http.Server | https.Server` and adjust the `server.listen` / `server.close` calls (they're the same API — no changes needed beyond the constructor).

**File:** `server.js`

---

## Step 4: Wire auth check into the route dispatcher in `server.js`

**Action:** In the `ROUTES` table and `dispatch()` function:
1. Add `requireAuth: true` to the two routes that need it:
   - `POST /rooms/:room/messages`
   - `GET /rooms/:room/events`
2. Routes that do **not** need auth:
   - `GET /health` — liveness probe, always open
   - `GET /` — index, always open
   - `GET /rooms/:room/history` — read-only, useful for debugging
   - `GET /rooms/:room/agents` — read-only, useful for debugging
   - `POST /rooms/:room/agents/:name/heartbeat` — keepalive, always open
3. In `dispatch()`, after room validation (`if (route.validateRoom)`), add:
   ```
   if (route.requireAuth) {
     const auth = checkRoomAccess(config, room, req);
     if (!auth.ok) return jsonError(res, auth.status, auth.error);
   }
   ```
4. `config` needs to be passed through to the dispatcher. Currently `createChatServer` creates `ctx` and the `route` closure. Add `config` to `ctx` or plumb it separately. Cleanest: `ctx.config = config` so the dispatcher reads `ctx.config`.

**File:** `server.js`

---

## Step 5: Unit tests for `lib/auth.js`

**Action:** New test file covering:
- Open room (no roomTokens config) → `ok: true`
- Room not in tokens map → `ok: true`
- Room with token, no token in request → `401 token_required`
- Room with token, wrong token → `403 invalid_token`
- Room with token, correct token in `Authorization: Bearer <val>` → `ok: true`
- Room with token, correct token in `?token=<val>` → `ok: true`
- Room with token, both header and query provided, header wins (correct) → `ok: true`
- Room with token, both header (wrong) and query (correct) → `403 invalid_token` (header wins, wrong)
- Room with token, null roomTokens config → `ok: true` (misconfig fallback)
- Malformed JSON in CHAT_ROOM_TOKENS → `null` fallback, `ok: true`

**File:** `test/auth.test.js` (new)

---

## Step 6: Unit tests for TLS config loading in `lib/config.js`

**Action:** Extend `test/config.test.js` with:
- `CHAT_TLS_CERT` and `CHAT_TLS_KEY` parse as strings
- `CHAT_ROOM_TOKENS` parses valid JSON → frozen object
- `CHAT_ROOM_TOKENS` with invalid JSON → `null`
- `CHAT_ROOM_TOKENS` with non-object JSON (array, string, number) → `null`
- All three default to empty string / null when not set

**File:** `test/config.test.js` (modify)

---

## Step 7: Integration tests for auth gating in `test/server.test.js`

**Action:** Add test cases using `createChatServer` with `roomTokens` config:
- Open room: messages + SSE work as before
- Protected room: POST message without token → `401`
- Protected room: POST message with wrong token → `403`
- Protected room: POST message with correct token → `201` + fan-out works
- Protected room: GET events without token → `401`
- Protected room: GET events with correct token → SSE opens, `hello` received
- Protected room: GET history / agents / heartbeat WITHOUT token → `200` (read endpoints are open)
- Health and index always return `200`

**File:** `test/server.test.js` (modify)

---

## Step 8: Update README and docker-compose

**Action:**
1. Add new env vars to README configuration table.
2. Add a "Security" section explaining room tokens and TLS.
3. In `docker-compose.yml`: add commented-out examples for `CHAT_TLS_CERT`, `CHAT_TLS_KEY`, and `CHAT_ROOM_TOKENS` on the `chat` service.

**Files:** `chat-server/README.md`, `docker-compose.yml` (modify)
