// Input validation for the chat-server protocol.
//
// Limits (defaults, overridable via env on the server entry):
//   text:   required, ≤ 4096 bytes UTF-8
//   from:   required, 1–64 chars, [A-Za-z0-9_-] only
//   meta:   optional object, JSON-serialised, ≤ 1024 bytes
//   mentions: server-derived only — clients MUST NOT send it
//
// All checks return { ok: true, value } on success or
// { ok: false, error, status } on failure. Status is the HTTP status the
// caller should return; `error` is the JSON body.

const utf8Bytes = (s) => Buffer.byteLength(s, "utf8");

/**
 * `LIMITS` is the canonical field-limit table — frozen, so consumers can't
 * mutate the wire-spec defaults. `bodyLimit` is derived from these in
 * `lib/config.js` and adds a 1024-byte slack for the JSON wrapper.
 */
export const LIMITS = Object.freeze({
  maxTextBytes: 4096,
  maxMetaBytes: 1024,
  /** Canonical identifier regex for `from`, `agent`, and `room` names. */
  IDENT_RE: /^[A-Za-z0-9_-]{1,64}$/,
});

/**
 * Validate a `POST /rooms/:room/messages` body.
 * Returns the canonicalised value: `{ from, text, meta? }`.
 */
export function validateMessage(body, limits = LIMITS) {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "body_must_be_object", status: 400 };
  }
  const { from, text, meta } = body;

  // `mentions` is server-derived — clients MUST NOT send it.
  if (body.mentions !== undefined) {
    return { ok: false, error: "mentions_is_server_derived", status: 400 };
  }

  if (typeof from !== "string" || !limits.IDENT_RE.test(from)) {
    return { ok: false, error: "invalid_from", status: 400 };
  }

  if (typeof text !== "string") {
    return { ok: false, error: "text_required", status: 400 };
  }
  if (text.length === 0) {
    return { ok: false, error: "text_empty", status: 400 };
  }
  if (utf8Bytes(text) > limits.maxTextBytes) {
    return { ok: false, error: "text_too_large", status: 400 };
  }

  let canonicalMeta;
  if (meta !== undefined) {
    if (meta == null || typeof meta !== "object" || Array.isArray(meta)) {
      return { ok: false, error: "meta_must_be_object", status: 400 };
    }
    let serialised;
    try {
      serialised = JSON.stringify(meta);
    } catch {
      return { ok: false, error: "meta_not_serialisable", status: 400 };
    }
    if (utf8Bytes(serialised) > limits.maxMetaBytes) {
      return { ok: false, error: "meta_too_large", status: 400 };
    }
    canonicalMeta = meta;
  }

  return {
    ok: true,
    value: { from, text, meta: canonicalMeta },
  };
}

/** Validate the `agent` query parameter on `GET /events`. */
export function validateAgentQuery(name, limits = LIMITS) {
  if (typeof name !== "string" || !limits.IDENT_RE.test(name)) {
    return { ok: false, error: "invalid_agent", status: 400 };
  }
  return { ok: true, value: name };
}

/** Validate a room name (URL path segment). Same IDENT regex as `from`/`agent`. */
export function validateRoomName(name, limits = LIMITS) {
  if (typeof name !== "string" || !limits.IDENT_RE.test(name)) {
    return { ok: false, error: "invalid_room", status: 400 };
  }
  return { ok: true, value: name };
}
