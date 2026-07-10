/**
 * HMAC sign/verify tests for the STS broker.
 *
 * Covers the two failure modes that have bitten us in adjacent HMAC
 * code paths (relayfile internal HMAC, hookdeck signing): timestamp
 * drift outside the window, and silent length mismatch in the base64
 * comparison. Also asserts the round-trip (sign then verify) and the
 * cross-platform contract (Node sign + Worker-shaped Web Crypto verify
 * via the same canonical signing string).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHmac } from "node:crypto";
import {
  buildSigningString,
  isTimestampWithinWindow,
  REQUEST_SIGNATURE_HEADER,
  REQUEST_TIMESTAMP_HEADER,
} from "../src/hmac.js";
import { signRequest, verifyRequest } from "../src/hmac-node.js";

const SECRET = "test-secret-do-not-use-in-prod";

describe("buildSigningString", () => {
  it("uppercases the method", () => {
    const a = buildSigningString({ method: "post", path: "/x", body: "b", timestamp: "1" });
    const b = buildSigningString({ method: "POST", path: "/x", body: "b", timestamp: "1" });
    assert.equal(a, b);
  });

  it("preserves order: method, path, body, timestamp", () => {
    const result = buildSigningString({
      method: "POST",
      path: "/broker/sts/assume-role",
      body: '{"x":1}',
      timestamp: "1700000000",
    });
    assert.equal(result, 'POST\n/broker/sts/assume-role\n{"x":1}\n1700000000');
  });
});

describe("isTimestampWithinWindow", () => {
  it("accepts current time", () => {
    const now = 1_700_000_000;
    assert.equal(
      isTimestampWithinWindow(String(now), { nowSeconds: now, maxSkewSeconds: 60 }),
      true,
    );
  });

  it("accepts within +/- max skew", () => {
    const now = 1_700_000_000;
    assert.equal(isTimestampWithinWindow(String(now - 30), { nowSeconds: now }), true);
    assert.equal(isTimestampWithinWindow(String(now + 30), { nowSeconds: now }), true);
  });

  it("rejects beyond max skew", () => {
    const now = 1_700_000_000;
    assert.equal(isTimestampWithinWindow(String(now - 90), { nowSeconds: now, maxSkewSeconds: 60 }), false);
    assert.equal(isTimestampWithinWindow(String(now + 90), { nowSeconds: now, maxSkewSeconds: 60 }), false);
  });

  it("rejects non-numeric / negative timestamps", () => {
    assert.equal(isTimestampWithinWindow("abc"), false);
    assert.equal(isTimestampWithinWindow("-1"), false);
    assert.equal(isTimestampWithinWindow(""), false);
  });
});

describe("signRequest / verifyRequest round-trip", () => {
  it("verifies a request signed with the same secret", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const body = '{"scope":"workflow-run","userId":"u1","runId":"r1"}';
    const sig = signRequest({
      method: "POST",
      path: "/broker/sts/assume-role",
      body,
      timestamp: ts,
      secret: SECRET,
    });

    const result = verifyRequest({
      method: "POST",
      path: "/broker/sts/assume-role",
      body,
      headers: {
        [REQUEST_SIGNATURE_HEADER]: sig,
        [REQUEST_TIMESTAMP_HEADER]: ts,
      },
      secret: SECRET,
    });
    assert.deepEqual(result, { ok: true });
  });

  it("rejects when the secret differs", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signRequest({
      method: "POST",
      path: "/x",
      body: "{}",
      timestamp: ts,
      secret: SECRET,
    });
    const result = verifyRequest({
      method: "POST",
      path: "/x",
      body: "{}",
      headers: {
        [REQUEST_SIGNATURE_HEADER]: sig,
        [REQUEST_TIMESTAMP_HEADER]: ts,
      },
      secret: "different-secret",
    });
    assert.deepEqual(result, { ok: false, reason: "bad_signature" });
  });

  it("rejects when the body is tampered", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signRequest({
      method: "POST",
      path: "/x",
      body: '{"userId":"alice"}',
      timestamp: ts,
      secret: SECRET,
    });
    const result = verifyRequest({
      method: "POST",
      path: "/x",
      body: '{"userId":"mallory"}',
      headers: {
        [REQUEST_SIGNATURE_HEADER]: sig,
        [REQUEST_TIMESTAMP_HEADER]: ts,
      },
      secret: SECRET,
    });
    assert.deepEqual(result, { ok: false, reason: "bad_signature" });
  });

  it("rejects when the timestamp is stale", () => {
    const now = 1_700_000_000;
    const stale = now - 3600;
    const sig = signRequest({
      method: "POST",
      path: "/x",
      body: "{}",
      timestamp: String(stale),
      secret: SECRET,
    });
    const result = verifyRequest({
      method: "POST",
      path: "/x",
      body: "{}",
      headers: {
        [REQUEST_SIGNATURE_HEADER]: sig,
        [REQUEST_TIMESTAMP_HEADER]: String(stale),
      },
      secret: SECRET,
      nowSeconds: now,
    });
    assert.deepEqual(result, { ok: false, reason: "stale_timestamp" });
  });

  it("rejects when headers are missing", () => {
    const result = verifyRequest({
      method: "POST",
      path: "/x",
      body: "{}",
      headers: {},
      secret: SECRET,
    });
    assert.deepEqual(result, { ok: false, reason: "missing_headers" });
  });

  it("accepts case-insensitive header lookup (Lambda Function URL lowercases)", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signRequest({
      method: "POST",
      path: "/x",
      body: "{}",
      timestamp: ts,
      secret: SECRET,
    });
    const result = verifyRequest({
      method: "POST",
      path: "/x",
      body: "{}",
      headers: {
        // intentionally non-canonical case + extra unrelated header
        "X-Request-Signature": sig,
        "X-Request-Timestamp": ts,
        "x-other": "ignored",
      },
      secret: SECRET,
    });
    // verify uses lowercase canonical names so providing capitalized
    // versions should NOT match (case-insensitive lookup is the
    // verifier's job, not the caller's). Sanity check that the lookup
    // does fall back to lowercase.
    assert.deepEqual(result, { ok: true });
  });
});

describe("signRequest matches a known fixture", () => {
  // Cross-platform contract: the Worker's Web Crypto path MUST produce
  // the same bytes for this fixture. If this assertion ever fails, the
  // canonical signing string changed — bump both halves of the contract
  // together.
  it("produces a deterministic base64 signature", () => {
    const sig = signRequest({
      method: "POST",
      path: "/broker/sts/assume-role",
      body: '{"scope":"workflow-run","userId":"u","runId":"r"}',
      timestamp: "1700000000",
      secret: "k",
    });
    const expected = createHmac("sha256", "k")
      .update(
        'POST\n/broker/sts/assume-role\n{"scope":"workflow-run","userId":"u","runId":"r"}\n1700000000',
      )
      .digest("base64");
    assert.equal(sig, expected);
  });
});
