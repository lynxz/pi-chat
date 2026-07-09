// Shared test bootstrap for chat-server integration tests.
//
// Every server-side integration test suite needs the same five lines of
// boilerplate around `createChatServer` + `server.listen(0)` + `shutdown`.
// This module centralises that pattern in a single `setupTestServer` helper
// so the tests themselves can stay focused on the wire-shape assertions
// they're trying to make.
//
// Pair with `node:test` lifecycle hooks:
//
//   let setup;
//   before(async () => { setup = await setupTestServer({ historyLimit: 100 }); });
//   after(async () => { await setup.shutdown(); });
//   it("…", async () => { await fetch(`${setup.baseUrl}/rooms/foo/history`); });
//
// Or use inside a single `it` for an ephemeral isolated instance:
//
//   it("…", async () => {
//     const setup = await setupTestServer({ ... });
//     try {
//       // … assertions against setup.baseUrl / setup.runtime …
//     } finally {
//       await setup.shutdown();
//     }
//   });
//
// `quiet: true` is the default — request/event logging is suppressed in
// tests so the test runner output stays readable. Pass `quiet: false`
// to debug a test interactively.

import { createChatServer } from "../server.js";

/**
 * Spin up an isolated chat-server instance on a random port and return
 * `{ baseUrl, runtime, shutdown }`.
 *
 * `port: 0` and `host: "127.0.0.1"` are forced on every call so tests
 * can't be hijacked by a stray `CHAT_PORT` in the ambient env. Tests
 * that genuinely need a different port or host can pass them via `opts`
 * and they'll override the defaults (spread order).
 *
 * `baseUrl` is the `http://127.0.0.1:<port>` prefix for in-test
 * `fetch` / `http.request` calls.
 *
 * `runtime` is the same `{ server, ctx, route, start, shutdown, … }`
 * shape returned by `createChatServer` — useful for tests that want
 * to call `runtime.ctx.state` directly.
 *
 * `shutdown()` calls `runtime.shutdown("test")` so server-side logs
 * identify the shutdown source.
 *
 * @param {Parameters<typeof createChatServer>[0]} [opts]
 * @returns {Promise<{ baseUrl: string, runtime: ReturnType<typeof createChatServer>, shutdown: () => Promise<void> }>}
 */
export async function setupTestServer(opts = {}) {
  const runtime = createChatServer({
    host: "127.0.0.1",
    port: 0,
    quiet: true,
    ...opts,
  });
  const addr = await runtime.start();
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    baseUrl,
    runtime,
    shutdown: () => runtime.shutdown("test"),
  };
}
