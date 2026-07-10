import { describe, expect, test } from "vitest";
import { stripRelayauthTokenPrefix } from "../src/middleware/auth.js";

// Relayauth's `/v1/tokens/path` and `/v1/tokens/workspace` endpoints
// wrap their issued RS256 JWTs with a class-prefix like `relay_pa_`
// or `relay_ws_`. The Cloudflare-Worker relayfile API at
// `api.relayfile.dev` was rejecting every such token with 401
// "invalid jwt header" because `parseBearer` was splitting on `.`
// without stripping the prefix first — `parts[0]` ended up containing
// `relay_<class>_<header_b64>` which failed base64-decode-then-JSON-
// parse. The mount daemon used by cloud's proactive runtime hit this
// on every poll cycle and silently broke writeback flushing.
//
// These tests pin the strip behaviour so a regression that drops the
// prefix-aware path back to a naive `.split(".")` can't ship.
describe("stripRelayauthTokenPrefix", () => {
  // A real-shaped JWT (three base64url segments) so the test mirrors
  // what `parseBearer` will see after this helper runs.
  const fakeJwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.signature_b64url_value";

  test("strips relay_pa_ prefix (path-access tokens)", () => {
    expect(stripRelayauthTokenPrefix(`relay_pa_${fakeJwt}`)).toBe(fakeJwt);
  });

  test("strips relay_ws_ prefix (workspace tokens)", () => {
    expect(stripRelayauthTokenPrefix(`relay_ws_${fakeJwt}`)).toBe(fakeJwt);
  });

  test("strips relay_id_ prefix (identity tokens)", () => {
    expect(stripRelayauthTokenPrefix(`relay_id_${fakeJwt}`)).toBe(fakeJwt);
  });

  test("strips relay_ag_ prefix (agent tokens)", () => {
    // The AR-264 delegated-token / `relayfile workspace join` chain mints
    // `relay_ag_`-wrapped access tokens via relayauth `/v1/tokens/agent`.
    // Without this prefix in the strip list, `relayfile read`/`pull` 401'd
    // with "invalid jwt header" on a perfectly valid agent token.
    expect(stripRelayauthTokenPrefix(`relay_ag_${fakeJwt}`)).toBe(fakeJwt);
  });

  test("passes bare JWTs through unchanged", () => {
    // Tokens minted directly via `/v1/tokens` (e.g. sage/specialist
    // RS256 mint path) ship as bare JWTs without a relayauth class
    // wrapper. The strip helper must not corrupt those.
    expect(stripRelayauthTokenPrefix(fakeJwt)).toBe(fakeJwt);
  });

  test("only strips one known prefix (no chained stripping)", () => {
    // Defensive: a value of the form `relay_pa_relay_ws_<jwt>` is
    // pathological and not something relayauth emits, but the strip
    // should remove at most one layer so the result is deterministic
    // and any deeper corruption surfaces as the usual JWT parse error
    // rather than silently being "fixed".
    const doubled = `relay_pa_relay_ws_${fakeJwt}`;
    expect(stripRelayauthTokenPrefix(doubled)).toBe(`relay_ws_${fakeJwt}`);
  });

  test("leaves unknown-prefix tokens alone", () => {
    // Future-proofing: an unknown class prefix isn't ours to strip;
    // the JWT-parse layer will reject it cleanly with "invalid jwt
    // header" instead of us silently corrupting the bytes.
    const value = `relay_unknown_${fakeJwt}`;
    expect(stripRelayauthTokenPrefix(value)).toBe(value);
  });

  test("does not strip the prefix in the middle of a string", () => {
    // `startsWith` is the contract — a token that merely contains the
    // prefix substring later in its body must not be mangled.
    const value = `${fakeJwt}relay_pa_trailing`;
    expect(stripRelayauthTokenPrefix(value)).toBe(value);
  });
});
