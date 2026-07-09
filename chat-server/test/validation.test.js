// Layer 1 — validation (field limits and error shapes).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  validateMessage,
  validateAgentQuery,
  validateRoomName,
} from "../lib/validation.js";

describe("validateMessage", () => {
  it("accepts a minimal valid body", () => {
    const r = validateMessage({ from: "alice", text: "hi" });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { from: "alice", text: "hi", meta: undefined });
  });

  it("rejects non-object body", () => {
    assert.equal(validateMessage(null).ok, false);
    assert.equal(validateMessage(undefined).ok, false);
    assert.equal(validateMessage("hi").ok, false);
    assert.equal(validateMessage([1, 2]).ok, false);
  });

  it("rejects mentions — server-derived only", () => {
    const r = validateMessage({ from: "alice", text: "hi", mentions: ["@bob"] });
    assert.equal(r.ok, false);
    assert.equal(r.error, "mentions_is_server_derived");
    assert.equal(r.status, 400);
  });

  it("rejects missing or invalid `from`", () => {
    for (const bad of ["", null, undefined, "alice bob", "alice@bob", "x".repeat(65)]) {
      const r = validateMessage({ from: bad, text: "hi" });
      assert.equal(r.ok, false, `should reject ${JSON.stringify(bad)}`);
      assert.equal(r.error, "invalid_from");
      assert.equal(r.status, 400);
    }
  });

  it("accepts all valid `from` characters", () => {
    for (const good of ["a", "A", "0", "_", "-", "abc-123_xyz"]) {
      assert.equal(validateMessage({ from: good, text: "hi" }).ok, true);
    }
  });

  it("rejects empty / missing / non-string `text`", () => {
    for (const bad of ["", null, undefined, 42, true, []]) {
      const r = validateMessage({ from: "alice", text: bad });
      assert.equal(r.ok, false);
      assert.equal(["text_required", "text_empty"][0] === r.error || r.error === "text_empty" || r.error === "text_required", true);
    }
  });

  it("rejects oversized text (>4096 bytes UTF-8)", () => {
    const big = "a".repeat(4097);
    const r = validateMessage({ from: "alice", text: big });
    assert.equal(r.ok, false);
    assert.equal(r.error, "text_too_large");
    assert.equal(r.status, 400);
  });

  it("counts UTF-8 bytes correctly (multi-byte char trips the limit)", () => {
    const ugh = "💣".repeat(2000); // each char is 4 bytes UTF-8 → 8000 bytes total
    const r = validateMessage({ from: "alice", text: ugh });
    assert.equal(r.ok, false);
    assert.equal(r.error, "text_too_large");
  });

  it("accepts text right at the limit (4096 bytes)", () => {
    const r = validateMessage({ from: "alice", text: "a".repeat(4096) });
    assert.equal(r.ok, true);
  });

  it("rejects non-object `meta`", () => {
    for (const bad of ["hi", 1, true, [1, 2]]) {
      const r = validateMessage({ from: "alice", text: "hi", meta: bad });
      assert.equal(r.ok, false, `should reject meta=${JSON.stringify(bad)}`);
      assert.equal(r.error, "meta_must_be_object");
    }
  });

  it("rejects oversized meta (>1024 bytes after JSON serialisation)", () => {
    const fat = { note: "x".repeat(1100) };
    const r = validateMessage({ from: "alice", text: "hi", meta: fat });
    assert.equal(r.ok, false);
    assert.equal(r.error, "meta_too_large");
    assert.equal(r.status, 400);
  });

  it("passes valid meta through unchanged", () => {
    const meta = { replyTo: "abc", branch: "main" };
    const r = validateMessage({ from: "alice", text: "hi", meta });
    assert.equal(r.ok, true);
    assert.equal(r.value.meta, meta);
  });

  it("passes through undefined meta as undefined", () => {
    const r = validateMessage({ from: "alice", text: "hi" });
    assert.equal(r.ok, true);
    assert.equal(r.value.meta, undefined);
  });
});

describe("validateAgentQuery", () => {
  it("accepts a valid agent name", () => {
    const r = validateAgentQuery("alice_2");
    assert.equal(r.ok, true);
    assert.equal(r.value, "alice_2");
  });
  it("rejects empty / bad", () => {
    for (const bad of ["", null, undefined, "alice bob", "x".repeat(65)]) {
      const r = validateAgentQuery(bad);
      assert.equal(r.ok, false);
      assert.equal(r.status, 400);
      assert.equal(r.error, "invalid_agent");
    }
  });
});

describe("validateRoomName", () => {
  it("accepts a simple room", () => {
    assert.equal(validateRoomName("backend-team").ok, true);
  });
  it("rejects spaces / oversize", () => {
    assert.equal(validateRoomName("with spaces").ok, false);
    assert.equal(validateRoomName("x".repeat(65)).ok, false);
    assert.equal(validateRoomName("").ok, false);
  });
});
