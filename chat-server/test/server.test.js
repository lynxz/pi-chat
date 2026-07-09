// Layer 1 — end-to-end HTTP/SSE tests against a real chat-server instance.
//
// Spins up `createChatServer({ port: 0 })` for the suite, asserts on responses
// using `fetch` for JSON endpoints and `node:http.request` (with a tiny SSE
// parser) for streaming endpoints.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { setupTestServer } from "./helpers.js";

let setup;
let base;

before(async () => {
  setup = await setupTestServer({
    historyLimit: 100,
    rateLimitPerSec: 10,
  });
  base = setup.baseUrl;
});
after(async () => {
  await setup.shutdown();
});

/** Per-test ephemeral setup, mirroring `setupTestServer` but with a fresh runtime. */
async function ephemeralTestServer(opts = {}) {
  return setupTestServer(opts);
}

/**
 * Open an SSE stream and resolve as soon as the server sends the `hello` frame
 * (which proves the connection is established and a `presence joined` event
 * has been broadcast). Frames continue to accumulate into `frames` for the
 * lifetime of the connection; the caller MUST `conn.req.destroy()` when done.
 */
function openSse({ room, agent }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${base}/rooms/${room}/events?agent=${encodeURIComponent(agent)}`,
      { method: "GET", headers: { Accept: "text/event-stream" } },
      (res) => {
        if (res.statusCode !== 200) {
          // Drain and reject so the calling test can see the status.
          let body = "";
          res.on("data", (c) => (body += c.toString("utf8")));
          res.on("end", () =>
            reject(Object.assign(new Error("sse_not_200"), { status: res.statusCode, body })),
          );
          return;
        }

        const frames = [];
        let buf = "";
        let resolved = false;

        const parse = () => {
          let idx;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            let event = "message";
            let data = "";
            for (const line of frame.split("\n")) {
              if (line.startsWith("event: ")) event = line.slice(7).trim();
              else if (line.startsWith("data: ")) data += (data ? "\n" : "") + line.slice(6);
            }
            const parsed = { event, data: data ? JSON.parse(data) : null };
            frames.push(parsed);
            if (!resolved && event === "hello") {
              resolved = true;
              resolve({ req, res, frames });
            }
          }
        };

        res.on("data", (c) => { buf += c.toString("utf8"); parse(); });
        res.on("error", (e) => { if (!resolved) reject(e); });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function postMessage(room, body, headers = {}) {
  const res = await fetch(`${base}/rooms/${room}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json };
}

describe("chat-server (HTTP integration)", () => {
  // ===== /health & meta ====================================================
  it("GET /health returns ok", async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.ok, true);
    assert.equal(typeof j.uptime, "number");
    assert.equal(typeof j.rooms, "number");
  });

  it("GET / returns endpoint list", async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.ok(Array.isArray(j.endpoints));
  });

  // ===== POST /messages — error paths ======================================
  it("rejects POST when the agent has no SSE", async () => {
    const r = await postMessage("r-no-sse", { from: "ghost", text: "hi" });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "agent_not_connected");
  });

  it("returns 400 with invalid_from on a bad `from`", async () => {
    const r = await postMessage("r-bad-from", { from: "alice bob", text: "hi" });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "invalid_from");
  });

  it("returns 400 when the client sends `mentions`", async () => {
    const r = await postMessage("r-mk", { from: "alice", text: "hi", mentions: ["@bob"] });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "mentions_is_server_derived");
  });

  it("returns 400 with text_too_large", async () => {
    const r = await postMessage("r-too-big", { from: "alice", text: "a".repeat(4097) });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "text_too_large");
  });

  // ===== Conflict (409) ====================================================
  it("returns 409 on a conflicting SSE connect", async () => {
    const first = await openSse({ room: "r-conflict", agent: "alice" });

    // Try to open a second SSE for the same name — must 409 immediately.
    const secondStatus = await new Promise((resolve, reject) => {
      const req = http.request(
        `${base}/rooms/r-conflict/events?agent=alice`,
        { method: "GET" },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c.toString("utf8")));
          res.on("end", () => resolve({ status: res.statusCode, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    try {
      assert.equal(secondStatus.status, 409);
      assert.match(secondStatus.body, /agent_in_use/);
      // First connection is undisturbed — `hello` must have arrived.
      assert.ok(first.frames.find((f) => f.event === "hello"));
    } finally {
      first.req.destroy();
    }
  });

  // ===== End-to-end fan-out =================================================
  it("two SSEs and a POST: the other side receives the message via SSE", async () => {
    const room = "r-fanout";
    const alice = await openSse({ room, agent: "alice" });
    const bob = await openSse({ room, agent: "bob" });
    // Drain a tick so any presence event broadcast at bob's join time has a
    // chance to land in alice's `frames` array before we assert on it. The
    // two SSEs are independent TCP streams, so the order in which their data
    // events arrive at the parsers is not deterministic.
    await new Promise((r) => setTimeout(r, 50));

    try {
      // Bob's hello should list alice + bob (self).
      const bobHello = bob.frames.find((f) => f.event === "hello");
      assert.ok(bobHello);
      assert.deepEqual(
        bobHello.data.agents.map((a) => a.name).sort(),
        ["alice", "bob"],
      );

      // Alice should have seen bob join.
      assert.ok(
        alice.frames.some((f) =>
          f.event === "presence" &&
          f.data.agent === "bob" &&
          f.data.action === "joined",
        ),
        "alice should have seen bob's presence-joined event",
      );

      // Alice publishes; bob should receive the message.
      const r = await postMessage(room, {
        from: "alice",
        text: "hello @bob",
        meta: { replyTo: "x" },
      });
      assert.equal(r.status, 201);
      assert.equal(typeof r.json.id, "string");
      assert.equal(typeof r.json.ts, "number");
      assert.deepEqual(r.json.mentions, ["@bob"]);

      // Give the SSE a moment to flush the message frame.
      await new Promise((r) => setTimeout(r, 50));
      const msg = bob.frames.find((f) =>
        f.event === "message" && f.data.from === "alice",
      );
      assert.ok(msg, "bob received the published message");
      assert.equal(msg.data.text, "hello @bob");
      assert.deepEqual(msg.data.mentions, ["@bob"]);
      assert.deepEqual(msg.data.meta, { replyTo: "x" });

      // Alice must NOT have received it (sender skip + self-filter).
      const aliceMsg = alice.frames.find((f) => f.event === "message");
      assert.equal(aliceMsg, undefined);
    } finally {
      alice.req.destroy();
      bob.req.destroy();
    }
  });

  // ===== History / agents ===================================================
  it("GET /history returns past messages", async () => {
    const room = "r-history";
    const conn = await openSse({ room, agent: "alice" });
    try {
      const r1 = await postMessage(room, { from: "alice", text: "one" });
      const r2 = await postMessage(room, { from: "alice", text: "two" });
      assert.equal(r1.status, 201);
      assert.equal(r2.status, 201);

      const hist = await (await fetch(`${base}/rooms/${room}/history?limit=10`)).json();
      assert.equal(hist.length, 2);
      assert.equal(hist[0].text, "one");
      assert.equal(hist[1].text, "two");
      // history shape: id, from, text, ts — no `mentions`.
      assert.equal("mentions" in hist[0], false);
    } finally {
      conn.req.destroy();
    }
  });

  it("GET /agents returns connected agents sorted by name", async () => {
    const room = "r-agents";
    const a = await openSse({ room, agent: "carol" });
    const b = await openSse({ room, agent: "alice" });
    try {
      const list = await (await fetch(`${base}/rooms/${room}/agents`)).json();
      assert.deepEqual(list.map((x) => x.name), ["alice", "carol"]);
      assert.equal(typeof list[0].connectedAt, "number");
      assert.equal(typeof list[0].lastSeen, "number");
    } finally {
      a.req.destroy();
      b.req.destroy();
    }
  });

  // ===== Heartbeat ==========================================================
  it("POST /heartbeat returns 204 and updates lastSeen", async () => {
    const room = "r-heart";
    const conn = await openSse({ room, agent: "alice" });
    try {
      const before = await (await fetch(`${base}/rooms/${room}/agents`)).json();
      await new Promise((r) => setTimeout(r, 5));
      const hb = await fetch(`${base}/rooms/${room}/agents/alice/heartbeat`, { method: "POST" });
      assert.equal(hb.status, 204);
      const after = await (await fetch(`${base}/rooms/${room}/agents`)).json();
      assert.ok(after[0].lastSeen >= before[0].lastSeen);
    } finally {
      conn.req.destroy();
    }
  });

  it("heartbeat for a non-connected agent returns 404", async () => {
    const hb = await fetch(`${base}/rooms/r-nobody/agents/ghost/heartbeat`, { method: "POST" });
    assert.equal(hb.status, 404);
  });

  it("heartbeat rejects an invalid agent name with 400 invalid_agent", async () => {
    // Agent name captured from the URL path now runs through
    // `validateAgentQuery` in the dispatcher, so a malformed segment is
    // rejected before it reaches `handleHeartbeat`.
    const hb = await fetch(`${base}/rooms/r-nobody/agents/has%20space/heartbeat`, { method: "POST" });
    assert.equal(hb.status, 400);
    const body = await hb.json();
    assert.equal(body.error, "invalid_agent");
  });

  // ===== Name release on close ==============================================
  it("closing the SSE releases the name — a fresh connect succeeds", async () => {
    const room = "r-release";
    const first = await openSse({ room, agent: "alice" });
    first.req.destroy();
    // Give the server a tick to process the close.
    await new Promise((r) => setTimeout(r, 50));
    const second = await openSse({ room, agent: "alice" });
    assert.ok(second.frames.find((f) => f.event === "hello"));
    second.req.destroy();
  });

  // ===== Rate limit =========================================================
  it("returns 429 with { error: 'rate_limit' } on the 11th msg/s", async () => {
    const room = "r-rate";
    const conn = await openSse({ room, agent: "alice" });
    try {
      for (let i = 0; i < 10; i++) {
        const r = await postMessage(room, { from: "alice", text: `m${i}` });
        assert.equal(r.status, 201, `msg ${i} should succeed`);
      }
      const over = await postMessage(room, { from: "alice", text: "11th" });
      assert.equal(over.status, 429);
      assert.equal(over.json.error, "rate_limit");
      // 429 carries the rate-limit window so clients can back off without
      // re-deriving it from documentation.
      assert.equal(typeof over.json.retry_after_ms, "number");
      assert.ok(over.json.retry_after_ms > 0);
    } finally {
      conn.req.destroy();
    }
  });

  // ===== Goodbye on shutdown ================================================
  it("emits `goodbye` with { reason: 'shutdown' } on graceful shutdown", async () => {
    // Use a dedicated ephemeral runtime so we don't interfere with the
    // shared one used by the other tests.
    const ephemeral = await ephemeralTestServer({});

    const sse = await new Promise((resolve, reject) => {
      const req = http.request(
        `${ephemeral.baseUrl}/rooms/r-goodbye/events?agent=alice`,
        { method: "GET" },
        (res) => {
          const frames = [];
          let buf = "";
          const parse = () => {
            let idx;
            while ((idx = buf.indexOf("\n\n")) !== -1) {
              const frame = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              let event = "message";
              let data = "";
              for (const line of frame.split("\n")) {
                if (line.startsWith("event: ")) event = line.slice(7).trim();
                else if (line.startsWith("data: ")) data += (data ? "\n" : "") + line.slice(6);
              }
              frames.push({ event, data: data ? JSON.parse(data) : null });
              if (event === "hello") resolve({ frames, req, res });
            }
          };
          res.on("data", (c) => { buf += c.toString("utf8"); parse(); });
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end();
    });

    // Trigger graceful shutdown.
    await ephemeral.shutdown();

    const gb = sse.frames.find((f) => f.event === "goodbye");
    assert.ok(gb, "client should have received a `goodbye` event before close");
    assert.deepEqual(gb.data, { reason: "shutdown" });

    sse.req.destroy();
  });
});
