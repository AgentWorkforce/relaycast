import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { refreshCredential } from "../src/auth/credential-refresher.js";
import { parseCredentialExpiry } from "../src/auth/credential-expiry.js";
import { parseCredentialEmail } from "../src/auth/credential-email.js";

// ~/.grok/auth.json shape captured from grok CLI 0.2.38 (values fake).
const XAI_SCOPE = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";
const XAI_CREDENTIAL = JSON.stringify({
  [XAI_SCOPE]: {
    key: "old-access-token",
    auth_mode: "oidc",
    create_time: "2026-06-10T15:05:16.448555Z",
    email: "will@example.com",
    refresh_token: "old-refresh-token",
    expires_at: "2026-06-10T21:05:16.448555Z",
    oidc_issuer: "https://auth.x.ai",
    oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828",
  },
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("parseCredentialExpiry reads the xai scope-keyed expires_at", () => {
  const expiry = parseCredentialExpiry(XAI_CREDENTIAL);
  assert.ok(expiry);
  assert.equal(expiry.toISOString(), "2026-06-10T21:05:16.448Z");
});

test("parseCredentialEmail reads the xai scope-keyed email", () => {
  assert.equal(parseCredentialEmail(XAI_CREDENTIAL), "will@example.com");
});

test("refreshCredential('xai') refreshes against auth.x.ai and persists the ROTATED refresh token", async () => {
  // auth.x.ai rotates refresh tokens on every grant (verified live) — the
  // updated blob must carry the new pair or the stored credential dies.
  let capturedUrl = "";
  let capturedBody = "";
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    capturedUrl = String(url);
    capturedBody = String(init?.body ?? "");
    return new Response(
      JSON.stringify({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 21600,
        token_type: "Bearer",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  const before = Date.now();
  const result = await refreshCredential("xai", XAI_CREDENTIAL);

  assert.equal(capturedUrl, "https://auth.x.ai/oauth2/token");
  const params = new URLSearchParams(capturedBody);
  assert.equal(params.get("grant_type"), "refresh_token");
  assert.equal(params.get("refresh_token"), "old-refresh-token");
  // client_id comes from the credential blob, not a hardcoded constant.
  assert.equal(params.get("client_id"), "b1a00492-073a-47ea-816f-4c329264a828");

  const updated = JSON.parse(result.credentialJson) as Record<
    string,
    { key: string; refresh_token: string; expires_at: string; email: string }
  >;
  const scoped = updated[XAI_SCOPE];
  assert.equal(scoped.key, "new-access-token");
  assert.equal(scoped.refresh_token, "new-refresh-token");
  // Untouched account metadata survives the refresh.
  assert.equal(scoped.email, "will@example.com");

  assert.ok(result.expiresAt);
  const expiresMs = result.expiresAt.getTime();
  assert.ok(expiresMs >= before + 21_600_000 - 5_000);
  assert.ok(expiresMs <= Date.now() + 21_600_000 + 5_000);
  // The blob's expires_at matches what the refresher reports.
  assert.equal(new Date(scoped.expires_at).getTime(), expiresMs);
});

test("refreshCredential('xai') fails loudly when no refresh token is present", async () => {
  await assert.rejects(
    refreshCredential("xai", JSON.stringify({ [XAI_SCOPE]: { key: "k" } })),
    /Missing refresh token for xai/,
  );
});
