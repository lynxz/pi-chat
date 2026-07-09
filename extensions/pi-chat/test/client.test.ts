// Layer 1 — ChatClient against stubbed fetch + a pretend chat-server.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ChatClient, type ChatEvent } from "../client.ts";

/** Minimal stub route: matches by pathname, responds synchronously. */
interface StubRoute {
  match: (pathname: string, init?: RequestInit) => boolean;
  respond: (body?: unknown) => void;
  /** Direct response factory. Called once per matched fetch. */
  respondNow?: () => Response;
}

interface FetchCall { url: string; init?: RequestInit; }

function pathnameOf(input: string | URL | Request): string {
  const raw = typeof input === "string" ? input : input.toString();
  try { return new URL(raw, "http://stub").pathname; } catch { return raw; }
}

function makeStubFetch(routes: StubRoute[]) {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL | Request).toString();
    calls.push({ url, init });
    for (const r of routes) {
      if (r.match(pathnameOf(input), init)) {
        if (r.respondNow) return r.respondNow();
      }
    }
    return new Response("not stubbed", { status: 599 });
  };
  return { fetchImpl, calls };
}

/** Response whose body is a stream of UTF-8 chunks (sync or async iterable). */
function streamingResponse(chunks: Iterable<string> | AsyncIterable<string>, status = 200): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const c of chunks) {
          controller.enqueue(enc.encode(c));
          await new Promise<void>((r) => setTimeout(r, 1));
        }
        controller.close();
      } catch (e) { controller.error(e as Error); }
    },
  });
  return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
}

async function* frames(stream: string[]): AsyncIterable<string> {
  for (const c of stream) yield c;
}

function sseRoute(stream: AsyncIterable<string>): StubRoute {
  return {
    match: (p) => p.endsWith("/events"),
    respond: () => undefined,
    respondNow: () => streamingResponse(stream),
  };
}

function sseRouteOnce(stream: AsyncIterable<string>): StubRoute {
  let consumed = false;
  return {
    match: (p) => p.endsWith("/events") && !consumed,
    respond: () => undefined,
    respondNow: () => {
      consumed = true;
      return streamingResponse(stream);
    },
  };
}

function staticJsonRoute(pathSuffix: string, status: number, body: unknown): StubRoute {
  return {
    match: (p) => p.endsWith(pathSuffix),
    respond: () => undefined,
    respondNow: () => new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  };
}

function staticTextRoute(pathSuffix: string, status: number, text: string, contentType = "text/event-stream"): StubRoute {
  return {
    match: (p) => p.endsWith(pathSuffix),
    respond: () => undefined,
    respondNow: () => new Response(text, { status, headers: { "Content-Type": contentType } }),
  };
}

/** Like `staticTextRoute` but the stream stays open indefinitely after
 * writing the bytes, so tests can poll for `status.state === 'connected'`
 * without racing the natural-close-induced reconnect loop. */
function keepAliveTextRoute(pathSuffix: string, status: number, text: string): StubRoute {
  return {
    match: (p) => p.endsWith(pathSuffix),
    respond: () => undefined,
    respondNow: () => {
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(enc.encode(text));
          // Keep the stream open forever.
        },
      });
      return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
    },
  };
}

async function waitFor(pred: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("ChatClient", () => {
  it("connects, emits `hello`, and a published `message` round-trips via fetch", async () => {
    const stub = makeStubFetch([
      keepAliveTextRoute("/events", 200,
        "event: hello\ndata: {\"agent\":\"alice\",\"room\":\"team\",\"agents\":[{\"name\":\"alice\",\"connectedAt\":1,\"lastSeen\":1}]}\n\n",
      ),
      staticJsonRoute("/messages", 201, { id: "msg-1", ts: 1, mentions: ["@bob"] }),
    ]);
    const client = new ChatClient({ server: "http://chat", room: "team", agent: "alice", fetch: stub.fetchImpl });
    const events: ChatEvent[] = [];
    client.onEvent((e) => events.push(e));

    const initial = await client.start();
    assert.equal(initial, "connected");
    await waitFor(() => events.some((e) => e.kind === "hello"));
    const hello = events.find((e) => e.kind === "hello");
    assert.ok(hello);

    const r = await client.send("hi @bob");
    assert.equal(typeof r.id, "string");
    assert.deepEqual(r.mentions, ["@bob"]);
    const post = stub.calls.find((c) => c.url.endsWith("/messages") && c.init?.method === "POST");
    assert.ok(post, "expected a POST /messages");
    assert.equal(JSON.parse(post!.init!.body as string).from, "alice");

    await client.close();
  });

  it("marks status 'conflict' on a 409 and stops reconnecting", async () => {
    const stub = makeStubFetch([
      staticJsonRoute("/events", 409, { error: "agent_in_use" }),
    ]);
    const client = new ChatClient({ server: "http://chat", room: "team", agent: "alice", fetch: stub.fetchImpl });
    const states: string[] = [];
    client.onStatus((s) => states.push(s.state));

    const initial = await client.start();
    assert.equal(initial, "conflict");
    assert.ok(states.includes("conflict"));

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(client.status.state, "conflict");
    await client.close();
  });

  it("schedules a reconnect on transient connect failure", async () => {
    let attempts = 0;
    const stub = makeStubFetch([
      {
        match: (p) => p.endsWith("/events"),
        respond: () => undefined,
        respondNow: () => {
          attempts += 1;
          return new Response("nope", { status: 500 });
        },
      },
    ]);
    const client = new ChatClient({ server: "http://chat", room: "team", agent: "alice", reconnectMs: 10, fetch: stub.fetchImpl });
    const transitions: string[] = [];
    client.onStatus((s) => transitions.push(s.state));

    await client.start();
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(attempts > 1, `expected reconnect attempts > 1, got ${attempts}`);
    assert.ok(transitions.filter((s) => s === "connecting").length > 1);
    await client.close();
  });

  it("send() throws on 400 with the server's error code", async () => {
    const stub = makeStubFetch([
      keepAliveTextRoute("/events", 200,
        "event: hello\ndata: {\"agent\":\"ghost\",\"room\":\"team\",\"agents\":[]}\n\n",
      ),
      staticJsonRoute("/messages", 400, { error: "agent_not_connected" }),
    ]);
    const client = new ChatClient({ server: "http://chat", room: "team", agent: "ghost", fetch: stub.fetchImpl });
    await client.start();
    await waitFor(() => client.status.state === "connected");
    await assert.rejects(
      () => client.send("hi"),
      (err: Error & { code?: string; status?: number }) => err.code === "agent_not_connected" && err.status === 400,
    );
    await client.close();
  });

  it("send() throws `name_dormant` when the client is in conflict", async () => {
    const stub = makeStubFetch([
      staticJsonRoute("/events", 409, { error: "agent_in_use" }),
    ]);
    const client = new ChatClient({ server: "http://chat", room: "team", agent: "alice", fetch: stub.fetchImpl });
    await client.start();
    await waitFor(() => client.status.state === "conflict");
    await assert.rejects(
      () => client.send("hi"),
      (err: Error & { code?: string }) => err.code === "name_dormant",
    );
    await client.close();
  });
});
