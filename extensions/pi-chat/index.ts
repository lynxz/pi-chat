// pi-chat extension entry point.
//
// This file is intentionally thin. All wiring lives in
// `runtime.ts` (`buildChatRuntime`) — `index.ts` just calls the factory
// in `session_start` and surfaces the runtime error if any.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { applyStatus } from "./status.ts";
import { buildChatRuntime } from "./runtime.ts";
import { registerChatCommands } from "./commands.ts";
import { registerChatTools } from "./tools.ts";

export default function piChatExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    // The factory is the single source of truth for dormancy — it inspects
    // both flat (PI_CHAT_SERVER/ROOM/AGENT) and prefixed
    // (PI_CHAT_ROOM_<ALIAS>__<FIELD>) env vars, emits the right notify,
    // and returns null on no-room-found. Doing an early `isDormant(flat)`
    // check here would silently drop valid prefixed-only configs.
    try {
      const runtime = buildChatRuntime(pi, ctx);
      if (!runtime) {
        // Already notified inside the factory.
        applyStatus(ctx, { text: "chat: dormant", alert: true });
        return;
      }
      registerChatCommands(pi, runtime.deps);
      registerChatTools(pi, runtime.deps);
    } catch (err) {
      ctx.ui.notify(`[chat] startup failed: ${(err as Error).message ?? String(err)}`, "error");
      applyStatus(ctx, { text: `! chat: startup failed`, alert: true });
    }
  });
}
