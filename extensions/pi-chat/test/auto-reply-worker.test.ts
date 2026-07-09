// Layer 1 — `AutoReplyWorker`, the serial inbound queue.
//
// Critical assertions:
//   - Only one message at a time leaves the queue via `sendUserMessage`.
//   - `markTurnDone` lets the next pump dispatch.
//   - `isIdle` gating prevents dispatch while a turn is running.
//   - `minGapMs` is a backstop so the heuristic can't double-fire.
//   - The queue caps at `maxQueue` and excess messages drop cleanly.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { AutoReplyWorker } from "../auto-reply-worker.ts";

function makeWorker(opts: {
  sendUserMessage?: (text: string) => void;
  idle?: boolean;
  minGapMs?: number;
  maxQueue?: number;
  onDispatch?: (text: string, q: number) => void;
  onDrop?: (text: string, r: "queue_full") => void;
} = {}) {
  const sentMessages: string[] = [];
  const w = new AutoReplyWorker(
    {
      sendUserMessage: opts.sendUserMessage ?? ((t) => { sentMessages.push(t); }),
      isIdle: () => opts.idle ?? true,
      onDispatch: opts.onDispatch,
      onDrop: opts.onDrop,
    },
    { minGapMs: opts.minGapMs, maxQueue: opts.maxQueue },
  );
  return { w, sentMessages };
}

describe("AutoReplyWorker — single-shot dispatch", () => {
  it("pump on empty queue is a no-op", () => {
    const { w, sentMessages } = makeWorker();
    assert.equal(w.pump(), undefined);
    assert.equal(sentMessages.length, 0);
    assert.equal(w.pendingCount, 0);
    assert.equal(w.isDispatching, false);
  });

  it("enqueue + pump with idle → dispatches, marks inFlight", () => {
    const { w, sentMessages } = makeWorker();
    w.enqueue("hello");
    assert.equal(w.pump(), "hello");
    assert.deepEqual(sentMessages, ["hello"]);
    assert.equal(w.isDispatching, true);
    assert.equal(w.pendingCount, 0);
  });

  it("does not dispatch while inFlight (serial — one at a time)", () => {
    const { w, sentMessages } = makeWorker();
    w.enqueue("a");
    w.enqueue("b");
    w.enqueue("c");
    assert.equal(w.pump(), "a");
    assert.equal(w.pendingCount, 2);
    // Three more pumps while inFlight → only one dispatch happened.
    assert.equal(w.pump(), undefined);
    assert.equal(w.pump(), undefined);
    assert.equal(w.pump(), undefined);
    assert.deepEqual(sentMessages, ["a"]);
  });

  it("does not dispatch when isIdle returns false", () => {
    const { w, sentMessages } = makeWorker({ idle: false });
    w.enqueue("queued");
    assert.equal(w.pump(), undefined);
    assert.equal(sentMessages.length, 0);
    assert.equal(w.pendingCount, 1);  // still queued
  });

  it("dispatches after markTurnDone", () => {
    const { w, sentMessages } = makeWorker({ minGapMs: 0 });
    w.enqueue("a");
    w.enqueue("b");
    assert.equal(w.pump(), "a");
    assert.equal(w.pump(), undefined);  // inFlight
    w.markTurnDone();
    assert.equal(w.pump(), "b");
    assert.deepEqual(sentMessages, ["a", "b"]);
  });
});

describe("AutoReplyWorker — FIFO order", () => {
  it("three messages dispatched in enqueue order", () => {
    const { w, sentMessages } = makeWorker({ minGapMs: 0 });
    w.enqueue("first");
    w.enqueue("second");
    w.enqueue("third");
    w.pump();
    w.markTurnDone();
    w.pump();
    w.markTurnDone();
    w.pump();
    assert.deepEqual(sentMessages, ["first", "second", "third"]);
  });
});

describe("AutoReplyWorker — minGapMs backstop", () => {
  it("does not dispatch twice within minGapMs window", () => {
    const { w, sentMessages } = makeWorker({ minGapMs: 100 });
    w.enqueue("a");
    w.enqueue("b");
    w.pump();         // dispatches "a"; lastDispatchAt = now
    w.markTurnDone();
    w.pump();         // gap too small, no dispatch even though idle+!inFlight
    assert.equal(sentMessages.length, 1);
    assert.equal(w.pendingCount, 1);
  });

  it("dispatches again once minGapMs has elapsed", async () => {
    const { w, sentMessages } = makeWorker({ minGapMs: 30 });
    w.enqueue("a");
    w.enqueue("b");
    w.pump();
    w.markTurnDone();
    await new Promise((r) => setTimeout(r, 50));
    w.pump();
    assert.deepEqual(sentMessages, ["a", "b"]);
  });
});

describe("AutoReplyWorker — maxQueue cap", () => {
  it("drops excess messages when queue is full", () => {
    const drops: Array<{ text: string; reason: string }> = [];
    const { w, sentMessages } = makeWorker({ maxQueue: 2 });
    w.enqueue("a");
    w.enqueue("b");
    w.enqueue("c");   // dropped
    w.enqueue("d");   // dropped
    assert.equal(w.pendingCount, 2);
    assert.equal(w.dropCount, 2);
    assert.equal(drops.length, 0);  // no onDrop registered
  });

  it("calls onDrop for excess messages", () => {
    const drops: Array<{ text: string; reason: "queue_full" }> = [];
    const { w } = makeWorker({
      maxQueue: 1,
      onDrop: (text, reason) => drops.push({ text, reason }),
    });
    w.enqueue("a");
    w.enqueue("overflowed");
    assert.deepEqual(drops, [{ text: "overflowed", reason: "queue_full" }]);
  });

  it("after pumping, queue can absorb new messages", () => {
    const { w } = makeWorker({ maxQueue: 2, minGapMs: 0 });
    w.enqueue("a");
    w.enqueue("b");
    w.enqueue("c");                     // dropped (queue full)
    assert.equal(w.dropCount, 1);
    assert.equal(w.pendingCount, 2);
    w.pump();                            // dispatches a, queue has 1 slot
    w.markTurnDone();
    w.enqueue("c");                     // fits now (b + c)
    assert.equal(w.pendingCount, 2);
    assert.equal(w.dropCount, 1);        // still only one drop
  });

  it("after pumping, queue can absorb new messages", () => {
    const { w } = makeWorker({ maxQueue: 2, minGapMs: 0 });
    w.enqueue("a");
    w.enqueue("b");
    assert.equal(w.dropCount, 0);
    w.enqueue("c");   // dropped (queue full = 2)
    assert.equal(w.dropCount, 1);
    w.pump();         // dispatches a, queue has 1 slot again
    w.markTurnDone();
    w.enqueue("c");
    assert.equal(w.dropCount, 1);
    assert.equal(w.pendingCount, 2);
  });
});

describe("AutoReplyWorker — clear + exception safety", () => {
  it("clear() empties queue + resets inFlight", () => {
    const { w, sentMessages } = makeWorker({ minGapMs: 0 });
    w.enqueue("a");
    w.pump();
    w.enqueue("b");
    w.clear();
    assert.equal(w.pendingCount, 0);
    assert.equal(w.isDispatching, false);
    w.markTurnDone();  // no-op after clear
    w.pump();          // nothing to dispatch
    assert.equal(sentMessages.length, 1);  // "a" was dispatched before clear
  });

  it("sendUserMessage throwing does not leave inFlight stuck", () => {
    const { w } = makeWorker({
      sendUserMessage: () => { throw new Error("boom"); },
      minGapMs: 0,
    });
    w.enqueue("a");
    w.pump();
    assert.equal(w.isDispatching, false);  // reset even though dispatch errored
    w.enqueue("b");
    w.pump();  // would dispatch if not for the throw — but it'd throw again
    void w;
  });
});
