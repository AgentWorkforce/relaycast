import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCredentialEmail } from "../src/auth/credential-email.js";

function fakeJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

test("parses the claudeAiOauth account email", () => {
  const json = JSON.stringify({
    claudeAiOauth: {
      accessToken: "not-a-jwt",
      emailAddress: "founder@example.com",
    },
  });
  assert.equal(parseCredentialEmail(json), "founder@example.com");
});

test("parses the .claude.json oauthAccount email", () => {
  const json = JSON.stringify({
    oauthAccount: { emailAddress: "claude-user@example.com" },
  });
  assert.equal(parseCredentialEmail(json), "claude-user@example.com");
});

test("parses the codex id_token email claim", () => {
  const json = JSON.stringify({
    OPENAI_API_KEY: "sk-...",
    tokens: {
      id_token: fakeJwt({ email: "codex-user@example.com", exp: 1900000000 }),
      access_token: "opaque",
    },
  });
  assert.equal(parseCredentialEmail(json), "codex-user@example.com");
});

test("parses the namespaced openai profile claim", () => {
  const json = JSON.stringify({
    tokens: {
      access_token: fakeJwt({
        "https://api.openai.com/profile": { email: "ns-user@example.com" },
      }),
    },
  });
  assert.equal(parseCredentialEmail(json), "ns-user@example.com");
});

test("returns null for plain API keys", () => {
  assert.equal(parseCredentialEmail(JSON.stringify({ key: "sk-ant-api-key" })), null);
});

test("returns null for malformed JSON and non-email fields", () => {
  assert.equal(parseCredentialEmail("not json"), null);
  assert.equal(
    parseCredentialEmail(JSON.stringify({ email: "not-an-email" })),
    null,
  );
});
