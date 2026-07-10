import { mintProxyToken, type ProxyTokenClaims } from "@agent-relay/credential-proxy";
import { describe, expect, it } from "vitest";

import type { Bindings } from "../env.js";
import worker from "../worker.js";

const JWT_SECRET = "worker-test-jwt-secret";

function makeEnv(overrides: Partial<Bindings> = {}): Bindings {
  return {
    CACHE_KV: {} as KVNamespace,
    CREDENTIAL_PROXY_JWT_SECRET: JWT_SECRET,
    OPENAI_API_KEY: "upstream-openai",
    ANTHROPIC_API_KEY: "upstream-anthropic",
    OPENROUTER_API_KEY: "upstream-openrouter",
    ENVIRONMENT: "test",
    ...overrides,
  };
}

function makeCtx(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;
}

async function mintToken(
  secret: string,
  overrides: Partial<ProxyTokenClaims> = {},
): Promise<string> {
  return mintProxyToken(
    {
      sub: "workspace-test",
      aud: "relay-llm-proxy",
      provider: "anthropic",
      credentialId: "user-test",
      ...overrides,
    },
    secret,
  );
}

describe("credential-proxy Worker", () => {
  it("serves /health without auth", async () => {
    const response = await worker.fetch(
      new Request("https://proxy.test/health"),
      makeEnv(),
      makeCtx(),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("rejects requests without a bearer token", async () => {
    const response = await worker.fetch(
      new Request("https://proxy.test/v1/messages", { method: "POST" }),
      makeEnv(),
      makeCtx(),
    );

    expect(response.status).toBe(401);
  });

  it("rejects tokens signed with the wrong secret", async () => {
    const token = await mintToken("some-other-secret");

    const response = await worker.fetch(
      new Request("https://proxy.test/v1/messages", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }),
      makeEnv(),
      makeCtx(),
    );

    expect(response.status).toBe(401);
  });

  it("rejects requests for a provider whose upstream key is not bound", async () => {
    const token = await mintToken(JWT_SECRET, { provider: "openai" });

    const response = await worker.fetch(
      new Request("https://proxy.test/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }),
      makeEnv({ OPENAI_API_KEY: undefined }),
      makeCtx(),
    );

    // The relay router only maps its internal ProxyHttpError / TokenError
    // classes to structured 4xx/5xx responses; a plain Error thrown from a
    // custom CredentialStore falls through to 500/internal_error. Asserting
    // the fail-closed behavior here — a dedicated credential_unavailable
    // status is a follow-up once relay exports ProxyHttpError.
    expect(response.status).toBe(500);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe("internal_error");
  });
});
