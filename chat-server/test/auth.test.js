// Layer 2 — `lib/auth.js` unit tests for `checkRoomAccess`.
// Mock `req` as plain objects with `url` and `headers` — no real HTTP.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { checkRoomAccess } from "../lib/auth.js";

// Helpers ----------------------------------------------------------------

/** Build a minimal config stub with the given roomTokens value. */
function configStub(roomTokens) {
  return { roomTokens };
}

/** @param {{ url?: string, authorization?: string|undefined }} overrides */
function reqStub({ url, authorization } = {}) {
  return {
    url: url ?? "/",
    headers: {
      host: "localhost",
      ...(authorization !== undefined ? { authorization } : {}),
    },
  };
}

// Tests -------------------------------------------------------------------

describe("checkRoomAccess — open rooms", () => {
  it("returns ok when roomTokens is null", () => {
    const cfg = configStub(null);
    const req = reqStub();
    assert.deepStrictEqual(checkRoomAccess(cfg, "lobby", req), { ok: true });
  });

  it("returns ok when the room is not in the token map", () => {
    const cfg = configStub(Object.freeze({ other: "secret" }));
    const req = reqStub();
    assert.deepStrictEqual(checkRoomAccess(cfg, "lobby", req), { ok: true });
  });

  it("returns ok when the room has a non-string value (e.g. null)", () => {
    const cfg = configStub(Object.freeze({ lobby: null }));
    const req = reqStub();
    assert.deepStrictEqual(checkRoomAccess(cfg, "lobby", req), { ok: true });
  });
});

describe("checkRoomAccess — missing token", () => {
  it("returns 401 when no Authorization header and no ?token query", () => {
    const cfg = configStub(Object.freeze({ secure: "s3cret" }));
    const req = reqStub({ url: "/rooms/secure/messages" });
    assert.deepStrictEqual(checkRoomAccess(cfg, "secure", req), {
      ok: false,
      status: 401,
      error: "token_required",
    });
  });
});

describe("checkRoomAccess — Authorization header", () => {
  it("returns 403 for a wrong token in Authorization: Bearer", () => {
    const cfg = configStub(Object.freeze({ secure: "s3cret" }));
    const req = reqStub({ authorization: "Bearer wrong" });
    assert.deepStrictEqual(checkRoomAccess(cfg, "secure", req), {
      ok: false,
      status: 403,
      error: "invalid_token",
    });
  });

  it("returns ok for a correct token in Authorization: Bearer", () => {
    const cfg = configStub(Object.freeze({ secure: "s3cret" }));
    const req = reqStub({ authorization: "Bearer s3cret" });
    assert.deepStrictEqual(checkRoomAccess(cfg, "secure", req), {
      ok: true,
    });
  });
});

describe("checkRoomAccess — query param fallback", () => {
  it("returns ok for a correct token in ?token= query param", () => {
    const cfg = configStub(Object.freeze({ secure: "s3cret" }));
    const req = reqStub({ url: "/rooms/secure/messages?token=s3cret" });
    assert.deepStrictEqual(checkRoomAccess(cfg, "secure", req), {
      ok: true,
    });
  });
});

describe("checkRoomAccess — header precedence", () => {
  it("header wins — correct header + wrong query → ok", () => {
    const cfg = configStub(Object.freeze({ secure: "s3cret" }));
    const req = reqStub({
      url: "/rooms/secure/messages?token=wrong",
      authorization: "Bearer s3cret",
    });
    assert.deepStrictEqual(checkRoomAccess(cfg, "secure", req), { ok: true });
  });

  it("header wins — wrong header + correct query → 403", () => {
    const cfg = configStub(Object.freeze({ secure: "s3cret" }));
    const req = reqStub({
      url: "/rooms/secure/messages?token=s3cret",
      authorization: "Bearer wrong",
    });
    assert.deepStrictEqual(checkRoomAccess(cfg, "secure", req), {
      ok: false,
      status: 403,
      error: "invalid_token",
    });
  });
});

describe("checkRoomAccess — edge cases", () => {
  it("returns 401 when req.url is unparseable (no token fallback)", () => {
    const cfg = configStub(Object.freeze({ secure: "s3cret" }));
    // An invalid URL that the URL constructor rejects in the try/catch.
    const req = reqStub({ url: "not a valid url at all" });
    assert.deepStrictEqual(checkRoomAccess(cfg, "secure", req), {
      ok: false,
      status: 401,
      error: "token_required",
    });
  });

  it("does not match a non-Bearer Authorization header", () => {
    const cfg = configStub(Object.freeze({ secure: "s3cret" }));
    // Basic auth or any scheme other than "Bearer" is ignored → falls back to query.
    const req = reqStub({
      url: "/?token=s3cret",
      authorization: "Basic s3cret",
    });
    assert.deepStrictEqual(checkRoomAccess(cfg, "secure", req), { ok: true });
  });
});
