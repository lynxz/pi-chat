// Room-level access control for chat-server.
//
// `checkRoomAccess(config, room, req)` is a stateless pure lookup — no
// session, no cookie, no mutation. It answers one question: "is this
// incoming request authorised to interact with this room?"
//
// Rules (see the implementation plan for the full matrix):
//   - `config.roomTokens` is null or doesn't cover this room → open (ok)
//   - room has a token string:
//       • Read `Authorization: Bearer <token>` header first
//       • Fall back to `?token=<value>` query param if header absent or
//         doesn't start with `"Bearer "`
//       • No token   → 401 token_required
//       • Wrong token → 403 invalid_token
//       • Match       → ok

/**
 * @param {import("./config.js").Config} config
 * @param {string} room
 * @param {import("node:http").IncomingMessage} req
 * @returns {{ ok: true } | { ok: false, status: number, error: string }}
 */
export function checkRoomAccess(config, room, req) {
  // No roomTokens at all → every room is open.
  if (config.roomTokens === null) return { ok: true };

  // Room not covered by the token map → open.
  if (!(room in config.roomTokens)) return { ok: true };

  const expected = config.roomTokens[room];

  // Only string values represent protected rooms — null entries
  // are explicitly open (e.g. `{"lobby":null}` in CHAT_ROOM_TOKENS).
  if (typeof expected !== "string") return { ok: true };

  // Read token: header wins, query param is fallback.

  // 1. Authorization: Bearer <token>
  const authHeader = req.headers.authorization;
  let provided = null;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    provided = authHeader.slice(7);
  }

  // 2. Fallback: ?token= query param
  if (provided === null) {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      provided = url.searchParams.get("token");
    } catch {
      // Unparseable URL — treat as no token.
    }
  }

  if (provided === null) return { ok: false, status: 401, error: "token_required" };
  if (provided !== expected) return { ok: false, status: 403, error: "invalid_token" };

  return { ok: true };
}
