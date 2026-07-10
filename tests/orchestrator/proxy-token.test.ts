import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mintCredentialProxyToken,
  parseCredentialProxyTokens,
  PROXY_TOKEN_AUDIENCE,
  resolveProxyEnvForCli,
  resolveProxyEnvForProvider,
  resolveProxyProviderFromCli,
  resolveProxyProviderFromCredentialProvider,
} from "../../packages/core/src/auth/proxy-token.js";

function decodeJwtPayload(token: string): Record<string, unknown> {
  const [, payload = ""] = token.split(".");
  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (normalized.length % 4)) % 4;
  return JSON.parse(
    Buffer.from(normalized + "=".repeat(pad), "base64").toString("utf8"),
  ) as Record<string, unknown>;
}

describe("mintCredentialProxyToken", () => {
  it("mints an HS256 JWT with relay proxy claims", async () => {
    const token = await mintCredentialProxyToken({
      subject: "rw_test1234",
      provider: "anthropic",
      credentialId: "user-123",
      secret: "proxy-secret",
      budget: 5000,
      ttlSeconds: 300,
    });

    const payload = decodeJwtPayload(token);

    assert.equal(payload.sub, "rw_test1234");
    assert.equal(payload.aud, PROXY_TOKEN_AUDIENCE);
    assert.equal(payload.provider, "anthropic");
    assert.equal(payload.credentialId, "user-123");
    assert.equal(payload.budget, 5000);
    assert.equal(typeof payload.iat, "number");
    assert.equal(typeof payload.exp, "number");
    assert.ok((payload.exp as number) >= (payload.iat as number));
  });
});

describe("proxy provider resolution", () => {
  // The proxy Worker only binds OPENROUTER_API_KEY today, so CLIs whose
  // upstream provider is openai or anthropic must NOT resolve — they stay
  // on mounted credentials. When a provider key is added on the Worker
  // (infra/credential-proxy.ts) and the corresponding entry added to
  // SUPPORTED_PROXY_PROVIDERS in proxy-token.ts, update these expectations.
  it("returns undefined for CLIs whose provider is not proxy-supported today", () => {
    assert.equal(resolveProxyProviderFromCli("claude"), undefined);
    assert.equal(resolveProxyProviderFromCli("codex"), undefined);
    assert.equal(resolveProxyProviderFromCli("opencode"), undefined);
    assert.equal(resolveProxyProviderFromCli("gemini"), undefined);
    assert.equal(resolveProxyProviderFromCli("agent"), undefined);
  });

  it("returns undefined for credential providers not in the supported set", () => {
    assert.equal(resolveProxyProviderFromCredentialProvider("anthropic"), undefined);
    assert.equal(resolveProxyProviderFromCredentialProvider("openai"), undefined);
    assert.equal(resolveProxyProviderFromCredentialProvider("google"), undefined);
  });

  it("resolves openrouter (the only currently-bound upstream)", () => {
    assert.equal(resolveProxyProviderFromCredentialProvider("openrouter"), "openrouter");
  });
});

describe("resolveProxyEnvForProvider", () => {
  it("emits CLI-specific proxy env overrides without loading workflow runtime modules", () => {
    assert.deepEqual(
      resolveProxyEnvForCli("aider", "https://proxy.example.com", "proxy-token"),
      {
        OPENAI_API_BASE: "https://proxy.example.com",
        OPENAI_API_KEY: "proxy-token",
      },
    );
    assert.deepEqual(
      resolveProxyEnvForCli("agent", "https://proxy.example.com", "proxy-token"),
      {
        OPENAI_BASE_URL: "https://proxy.example.com",
        OPENAI_API_KEY: "proxy-token",
      },
    );
  });

  it("emits openai-compatible env overrides", () => {
    assert.deepEqual(
      resolveProxyEnvForProvider("openai", "https://proxy.example.com", "proxy-token"),
      {
        OPENAI_BASE_URL: "https://proxy.example.com",
        OPENAI_API_BASE: "https://proxy.example.com",
        OPENAI_API_KEY: "proxy-token",
      },
    );
  });

  it("emits openrouter env overrides alongside openai-compatible vars", () => {
    assert.deepEqual(
      resolveProxyEnvForProvider("openrouter", "https://proxy.example.com", "proxy-token"),
      {
        OPENAI_BASE_URL: "https://proxy.example.com",
        OPENAI_API_BASE: "https://proxy.example.com",
        OPENAI_API_KEY: "proxy-token",
        OPENROUTER_API_KEY: "proxy-token",
      },
    );
  });
});

describe("parseCredentialProxyTokens", () => {
  it("keeps only tokens for providers in the supported-proxy-providers allowlist", () => {
    // Providers outside the allowlist (currently anthropic + openai, since
    // their upstream keys aren't bound on the Worker) are dropped so the
    // sandbox never tries to route them through a proxy that would fail.
    assert.deepEqual(
      parseCredentialProxyTokens(
        JSON.stringify({
          anthropic: "anthropic-token",
          openai: "openai-token",
          openrouter: "openrouter-token",
          google: "ignored",
        }),
      ),
      {
        openrouter: "openrouter-token",
      },
    );
  });

  it("returns undefined when no allowlisted providers are present", () => {
    assert.equal(
      parseCredentialProxyTokens(
        JSON.stringify({
          anthropic: "only-unsupported-token",
          google: "ignored",
        }),
      ),
      undefined,
    );
  });
});
