// Layer 1 — SSE parser, framing, and `openSse` against a stubbed fetch.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseFrames, openSse } from "../sse-stream.ts";

describe("parseFrames", () => {
  it("splits on \\n\\n boundaries", () => {
    const a = parseFrames("event: hello\ndata: {\"a\":1}\n\nevent: ping\ndata: {}\n\n");
    assert.equal(a.frames.length, 2);
    assert.equal(a.frames[0].event, "hello");
    assert.equal(a.frames[0].data, '{"a":1}');
    assert.equal(a.frames[1].event, "ping");
    assert.equal(a.rest, "");
  });

  it("keeps incomplete tails for next call", () => {
    const a = parseFrames("event: x\ndata: 1\n\nevent:");
    assert.equal(a.frames.length, 1);
    assert.equal(a.frames[0].event, "x");
    assert.equal(a.frames[0].data, "1");
    assert.equal(a.rest, "event:");
  });

  it("defaults event to `message`", () => {
    const a = parseFrames("data: hello\n\n");
    assert.equal(a.frames.length, 1);
    assert.equal(a.frames[0].event, "message");
    assert.equal(a.frames[0].data, "hello");
  });

  it("joins multi-line data with newlines", () => {
    const a = parseFrames("event: x\ndata: line1\ndata: line2\n\n");
    assert.equal(a.frames[0].data, "line1\nline2");
  });

  it("ignores comment lines starting with `:`", () => {
    const a = parseFrames(": this is a comment\nevent: ok\ndata: yep\n\n");
    assert.equal(a.frames[0].event, "ok");
    assert.equal(a.frames[0].data, "yep");
  });

  it("treats empty / buffer-less input as no frames", () => {
    assert.equal(parseFrames("").frames.length, 0);
    assert.equal(parseFrames("event: x").frames.length, 0); // no terminator
  });
});

describe("openSse", () => {
  function makeResponseStream(body: ReadableStream<Uint8Array>, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      body,
    } as unknown as Response;
  }

  function chunkedStream(chunks: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream({
      pull(controller) {
        if (i < chunks.length) {
          controller.enqueue(enc.encode(chunks[i++]));
        } else {
          controller.close();
        }
      },
    });
  }

  function mockFetchOk(chunks: string[]) {
    return async (_url: string, _init?: RequestInit) => makeResponseStream(chunkedStream(chunks), 200);
  }

  function mockFetchStatus(status: number) {
    return async (_url: string, _init?: RequestInit) => ({
      ok: false,
      status,
      body: null,
    } as Response);
  }

  it("parses a streamed hello + message sequence", async () => {
    const fetchImpl = mockFetchOk([
      "event: hello\ndata: {\"a\":1}\n\n",
      "event: message\ndata: {\"from\":\"bob\"}\n\n",
    ]);
    const r = await openSse("http://x/y", { fetch: fetchImpl as unknown as typeof fetch });
    assert.equal(r.status, 200);
    const events: Array<{ event: string; data: string }> = [];
    for await (const f of r.events) events.push(f);
    assert.equal(events.length, 2);
    assert.equal(events[0].event, "hello");
    assert.equal(events[0].data, '{"a":1}');
    assert.equal(events[1].event, "message");
    r.close();
  });

  it("supports multi-chunk frames split across reads", async () => {
    const fetchImpl = mockFetchOk([
      "event: hello\nda",
      "ta: {\"x\":1}\n\nevent: ping\ndat",
      "a: {}\n\n",
    ]);
    const r = await openSse("http://x/y", { fetch: fetchImpl as unknown as typeof fetch });
    const events: Array<{ event: string; data: string }> = [];
    for await (const f of r.events) events.push(f);
    assert.equal(events.length, 2);
    assert.equal(events[0].data, '{"x":1}');
    assert.equal(events[1].data, "{}");
    r.close();
  });

  it("returns an empty iterator when the response is non-2xx", async () => {
    const fetchImpl = mockFetchStatus(409);
    const r = await openSse("http://x/y", { fetch: fetchImpl as unknown as typeof fetch });
    assert.equal(r.status, 409);
    const events = [];
    for await (const f of r.events) events.push(f);
    assert.equal(events.length, 0);
    r.close();
  });

  it("`close()` ends iteration promptly", async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode("event: hello\ndata: {}\n\n"));
        // Never close — keep streaming forever until the consumer gives up.
      },
    });
    const fetchImpl = async () => makeResponseStream(stream, 200);
    const r = await openSse("http://x/y", { fetch: fetchImpl as unknown as typeof fetch });
    const events: Array<unknown> = [];
    (async () => {
      for await (const f of r.events) {
        events.push(f);
        if (events.length >= 1) r.close();
      }
    })();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(events.length, 1);
    r.close();
  });
});
