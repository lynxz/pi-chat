// Layer 1/2 — ping scheduler + sweeper integration.
//
// Boots the real `createChatServer` factory with a small `staleMs` and an
// even smaller `pingIntervalMs`. A silent agent (no incoming data, no
// message activity) should NOT be swept while the ping scheduler is
// running, because pings refresh `conn.lastSeen`. Disabling the scheduler
// (or waiting past `staleMs` without pings) lets the sweeper reclaim it.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import http from "node:http";
import { setupTestServer } from "./helpers.js";

let setup;
let baseUrl;

before(async () => {
  setup = await setupTestServer({
    staleMs: 500,
    sweeperIntervalMs: 100,
    pingIntervalMs: 100,  // more than half of staleMs — keeps conn warm
  });
  baseUrl = setup.baseUrl;
});
after(async () => {
  await setup.shutdown();
});

function openSseAgent(agent) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}/rooms/pingit/events?agent=${agent}`,
      { method: "GET" },
      (res) => {
        if (res.statusCode !== 200) {
          reject(Object.assign(new Error("expected 200"), { status: res.statusCode }));
          return;
        }
        let buf = "";
        res.on("data", (c) => {
          buf += c.toString("utf8");
          // Drain to keep the conn readable; we don't need frames here.
        });
        resolve({ req, res, buf: () => buf });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function getAgents() {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}/rooms/pingit/agents`, { method: "GET" }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("ping scheduler keeps a silent SSE alive past staleMs", () => {
  it("idle agent survives longer than staleMs when pings are firing", async () => {
    const conn = await openSseAgent("lived");
    await new Promise((r) => setTimeout(r, 80));   // hello + first ping land

    const before = await getAgents();
    assert.ok(JSON.parse(before.body).some((a) => a.name === "lived"));

    // Wait ~3x staleMs. Without pings, the sweeper would have closed
    // this connection by now. With pings at 100ms intervals refreshing
    // conn.lastSeen every tick, it should still be present.
    await new Promise((r) => setTimeout(r, 1500));

    const after = await getAgents();
    assert.ok(
      JSON.parse(after.body).some((a) => a.name === "lived"),
      "agent should still be present at t = ~1.5s with staleMs=500ms",
    );

    // Cleanup
    conn.req.socket.destroy();
  });
});
