// Layer 1/2 — stale-SSE sweeper integration.
//
// Boots the real `createChatServer` factory with a tiny `staleMs`, then
// simulates a dead TCP connection by hard-closing the underlying `req`
// without sending a clean close (so the server's `res.on("close")` only
// fires after the OS surfaces the half-open). The sweeper is expected to
// close the SSE on the server side and free the agent from `presence`.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import http from "node:http";
import { setupTestServer } from "./helpers.js";

let setup;
let baseUrl;

before(async () => {
  setup = await setupTestServer({
    staleMs: 200,       // very small — the test doesn't want to wait 60s
    sweeperIntervalMs: 50,
  });
  baseUrl = setup.baseUrl;
});
after(async () => {
  await setup.shutdown();
});

function openSseAgent(agent) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}/rooms/sweep/events?agent=${agent}`, { method: "GET" }, (res) => {
      if (res.statusCode !== 200) {
        reject(Object.assign(new Error("expected 200"), { status: res.statusCode }));
        return;
      }
      const frames = [];
      let buf = "";
      res.on("data", (c) => {
        buf += c.toString("utf8");
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
          let e = "message", d = "";
          for (const line of frame.split("\n")) {
            if (line.startsWith("event: ")) e = line.slice(7);
            else if (line.startsWith("data: ")) d += (d ? "\n" : "") + line.slice(6);
          }
          frames.push({ event: e, data: d });
        }
      });
      resolve({ req, res, frames });
    });
    req.on("error", reject);
    req.end();
  });
}

function getAgents(agentName) {
  return new Promise((resolve, reject) => {
    http.request(`${baseUrl}/rooms/sweep/agents`, { method: "GET" }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    })
      .on("error", reject)
      .end();
  });
}

function postHeartbeat(agent) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}/rooms/sweep/agents/${encodeURIComponent(agent)}/heartbeat`,
      { method: "POST" },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("stale-SSE sweeper end-to-end", () => {
  it("closes a silent SSE after `staleMs` and clears presence", async () => {
    const conn = await openSseAgent("swept");
    // Allow the hello frame to land.
    await new Promise((r) => setTimeout(r, 50));

    const before = await getAgents();
    assert.equal(before.status, 200);
    assert.ok(JSON.parse(before.body).some((a) => a.name === "swept"));

    // Hard-close the underlying TCP socket WITHOUT sending a clean close —
    // simulates a half-open agent (e.g. crashed container). The server's
    // `res.on("close")` only fires once the OS surfaces the dead socket;
    // before that, the connection is still "open" from the server's view.
    conn.req.socket.destroy();

    // Poll up to ~2s waiting for the sweeper to fire and the agent to
    // disappear from /agents.
    let present = true;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const r1 = await getAgents();
      const list = JSON.parse(r1.body);
      present = list.some((a) => a.name === "swept");
      if (!present) break;
    }
    assert.equal(present, false, "stale agent should be cleaned up by the sweeper");
  });

  // `entry.conn.touch()` is the heartbeat path and the
  // sweeper reads `conn.lastSeen`, but no test verified the wired-up loop.
  // `staleMs` is set to 200 ms in `before()`; the heartbeat must arrive
  // within that window to keep the connection alive past the next sweep.
  it("POST /heartbeat keeps an idle SSE alive past staleMs", async () => {
    const conn = await openSseAgent("heartbeat-alive");
    await new Promise((r) => setTimeout(r, 50)); // hello lands

    // Sleep almost to the staleMs boundary, then issue a heartbeat (which
    // calls `entry.conn.touch()` and refreshes `conn.lastSeen`).
    await new Promise((r) => setTimeout(r, 150));
    const hb = await postHeartbeat("heartbeat-alive");
    assert.equal(hb.status, 204);

    // Wait long enough for at least one sweeper cycle (50 ms interval) but
    // not long enough for the post-heartbeat connection to age past
    // staleMs again (~150 ms budget after the heartbeat).
    await new Promise((r) => setTimeout(r, 120));
    const r1 = await getAgents();
    const list = JSON.parse(r1.body);
    assert.ok(
      list.some((a) => a.name === "heartbeat-alive"),
      "agent should still be present after a recent heartbeat",
    );
    conn.req.destroy();
  });

  it("without heartbeat, an idle SSE is reaped after staleMs", async () => {
    const conn = await openSseAgent("heartbeat-dead");
    await new Promise((r) => setTimeout(r, 50)); // hello lands

    // Wait past staleMs + one sweep cycle. No heartbeat — should be reaped.
    let present = true;
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const r1 = await getAgents();
      const list = JSON.parse(r1.body);
      present = list.some((a) => a.name === "heartbeat-dead");
      if (!present) break;
    }
    assert.equal(present, false, "idle agent without heartbeat should be reaped");
    conn.req.destroy();
  });
});
