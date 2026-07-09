#!/usr/bin/env -S node --experimental-transform-types --no-warnings
// Loop canary (Layer 2).
//
// Boots the real `chat-server`, then runs two stub agents in the same room
// under each of the three auto-reply modes and asserts the channel reaches
// a quiescent state within a fixed window. This catches regressions in the
// serial inbound queue: without the worker, two autoreply-on agents in
// `questions` mode loop forever; with it, they settle.
//
// Run with: `node --experimental-transform-types scripts/canary.ts`
// Exits non-zero if any mode regresses into a runaway loop.
//
// Each stub agent implements the *policy* the extension would, but uses
// `client.send(text)` directly rather than `pi.sendUserMessage` — what we
// exercise here is the chat-server's behaviour plus the predicates from
// `filters.ts`. The real extension's serial queue is covered by the
// unit tests in `test/auto-reply-worker.test.ts`.

import { createChatServer } from "../../../chat-server/server.js";
import { ChatClient, type ChatEvent } from "../client.ts";
import { hasMentionFor, endsWithQuestion } from "../filters.ts";
import type { AutoReplyMode } from "../env.ts";

const ROUNDS_PER_MODE = 5;
const QUIESCENCE_WINDOW_MS = 1_500;
const PER_AGENT_CAP = 30; // each mode must send fewer than this in total

interface AgentOpts {
  server: string;
  room: string;
  agent: string;
  mode: AutoReplyMode;
  otherAgent: string;
  onActivity: (from: string, text: string) => void;
  /** After this many messages received, this agent stops auto-replying
   *  (gives the loop a defined stop condition). */
  replyBudget: number;
}

class StubAgent {
  readonly client: ChatClient;
  readonly received: Array<{ from: string; text: string; mentions: string[] }> = [];
  private sentCount = 0;
  private replies = 0;
  private readonly budget: number;
  private readonly opts: AgentOpts;
  private readonly onActivity: (from: string, text: string) => void;

  constructor(opts: AgentOpts) {
    this.opts = opts;
    this.budget = opts.replyBudget;
    this.onActivity = opts.onActivity;

    this.client = new ChatClient({ server: opts.server, room: opts.room, agent: opts.agent, reconnectMs: 50 });
    this.client.onEvent((e: ChatEvent) => {
      if (e.kind === "message") {
        this.handleIncoming(e.from, e.text, e.mentions);
      }
    });
  }

  async start(): Promise<void> {
    await this.client.start();
  }

  async send(text: string): Promise<void> {
    await this.client.send(text);
    this.sentCount++;
    this.onActivity(this.opts.agent, text);
  }

  close(): Promise<void> {
    return this.client.close();
  }

  private async handleIncoming(from: string, text: string, mentions: string[]): Promise<void> {
    this.received.push({ from, text, mentions });
    if (from === this.opts.agent) return;            // self-echo
    if (this.replies >= this.budget) return;          // budget exhausted

    let shouldReply = false;
    switch (this.opts.mode) {
      case "all":
        shouldReply = true;
        break;
      case "mentions":
        shouldReply = hasMentionFor(mentions, this.opts.agent);
        break;
      case "questions":
        shouldReply = hasMentionFor(mentions, this.opts.agent) || endsWithQuestion(text);
        break;
    }
    if (shouldReply) {
      this.replies++;
      // Tiny artificial spacing between replies so the server's per-agent
      // rate-limit (≤ 10 msg/s) doesn't kick in on bursty clusters.
      setTimeout(() => { void this.send(replyFor(this.opts.mode, from)); }, 5);
    }
  }

  get sentTotal(): number { return this.sentCount; }
}

function replyFor(mode: AutoReplyMode, from: string): string {
  switch (mode) {
    case "all":        return `auto-reply to ${from} (round)`;
    case "mentions":   return `@${from} ok, noted`;
    case "questions":  return `@${from} yes, that is a question`;
  }
}

async function runMode(server: string, mode: AutoReplyMode): Promise<{
  total: number;
  quiescent: boolean;
}> {
  let activity = 0;
  const onActivity = (from: string, _text: string) => {
    activity++;
  };

  const a = new StubAgent({
    server,
    room: "canary",
    agent: "alice",
    mode,
    otherAgent: "bob",
    onActivity,
    replyBudget: ROUNDS_PER_MODE,
  });
  const b = new StubAgent({
    server,
    room: "canary",
    agent: "bob",
    mode,
    otherAgent: "alice",
    onActivity,
    replyBudget: ROUNDS_PER_MODE,
  });

  let lastActivityTick = Date.now();
  const tickingClock = setInterval(() => {
    // On each timer fire, if anyone fired activity since the last tick,
    // update the timestamp so the quiescence check below waits long enough.
    if (activity > 0) {
      lastActivityTick = Date.now();
      activity = 0;
    }
  }, 100);
  if (typeof tickingClock.unref === "function") tickingClock.unref();

  try {
    await a.start();
    await b.start();
    await new Promise((r) => setTimeout(r, 50));

    const startA = a.sentTotal;
    const startB = b.sentTotal;

    // Kickoff with a question so the canary reaches a meaningful state in
    // every mode (questions / mentions / all).
    const kickoff = mode === "questions" ? "What do you think? @bob ?" :
                    mode === "mentions" ? "@bob hi there" :
                    "hello";
    await a.send(kickoff);

    // Wait until QUIESCENCE_WINDOW_MS of silence.
    while (Date.now() - lastActivityTick < QUIESCENCE_WINDOW_MS) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 200));   // grace

    const totalA = a.sentTotal - startA;
    const totalB = b.sentTotal - startB;
    const total = totalA + totalB;
    return { total, quiescent: true };
  } finally {
    clearInterval(tickingClock);
    await a.close();
    await b.close();
  }
}

async function main() {
  const runtime = createChatServer({ port: 0, host: "127.0.0.1", quiet: true });
  const addr = await runtime.start();
  const base = `http://127.0.0.1:${addr.port}`;
  console.log(`canary: chat-server up at ${base}`);

  let failed = false;
  for (const mode of ["mentions", "questions", "all"] as AutoReplyMode[]) {
    const r = await runMode(base, mode);
    const ok = r.total < PER_AGENT_CAP;
    console.log(`[${mode}] total=${r.total} cap=${PER_AGENT_CAP} quiescent=${r.quiescent} → ${ok ? "OK" : "FAIL"}`);
    if (!ok) failed = true;
  }

  await runtime.shutdown("canary", false);
  if (failed) {
    console.error("canary: at least one mode regressed into a loop");
    process.exit(1);
  }
  console.log("canary: all modes quiesced within window");
}

main().catch((err) => {
  console.error("canary crashed:", err);
  process.exit(2);
});
