import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { CloudApiClient } from "../../packages/core/src/auth/api-token-client.js";

const originalFetch = globalThis.fetch;

describe("CloudApiClient", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("shares an in-flight refresh across concurrent fetch calls", async () => {
    let refreshCalls = 0;
    const authorizationHeaders: string[] = [];
    let releaseRefresh: (() => void) | null = null;

    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });

    globalThis.fetch = async (input, init) => {
      const url = input instanceof URL ? input.toString() : input instanceof Request ? input.url : String(input);

      if (url.endsWith("/api/v1/auth/token/refresh")) {
        refreshCalls += 1;
        await refreshGate;

        return new Response(
          JSON.stringify({
            accessToken: "next-access-token",
            accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            refreshToken: "next-refresh-token",
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          },
        );
      }

      authorizationHeaders.push(new Headers(init?.headers).get("Authorization") ?? "");
      return new Response(null, { status: 200 });
    };

    const client = new CloudApiClient({
      apiUrl: "https://cloud.example.com",
      accessToken: "stale-access-token",
      refreshToken: "stale-refresh-token",
      accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const firstFetch = client.fetch("/api/v1/runs");
    const secondFetch = client.fetch("/api/v1/runs");

    await Promise.resolve();
    assert.equal(refreshCalls, 1);

    (releaseRefresh as (() => void) | null)?.();

    await Promise.all([firstFetch, secondFetch]);

    assert.equal(refreshCalls, 1);
    assert.deepEqual(authorizationHeaders, [
      "Bearer next-access-token",
      "Bearer next-access-token",
    ]);
  });

  it("re-exports CloudApiClient from the core cloud index", async () => {
    const mod = await import("../../packages/core/src/cloud-index.js");
    assert.equal(mod.CloudApiClient, CloudApiClient);
  });

  it("exposes a snapshot with the latest token values", async () => {
    globalThis.fetch = async (input) => {
      const url = input instanceof URL ? input.toString() : input instanceof Request ? input.url : String(input);
      if (url.endsWith("/api/v1/auth/token/refresh")) {
        return new Response(
          JSON.stringify({
            accessToken: "fresh-access-token",
            accessTokenExpiresAt: "2026-03-14T00:00:00.000Z",
            refreshToken: "fresh-refresh-token",
            refreshTokenExpiresAt: "2026-03-15T00:00:00.000Z",
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          },
        );
      }

      return new Response(null, { status: 200 });
    };

    const client = new CloudApiClient({
      apiUrl: "https://cloud.example.com",
      accessToken: "stale-access-token",
      refreshToken: "stale-refresh-token",
      accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    await client.fetch("/api/v1/runs");

    assert.deepEqual(client.snapshot(), {
      apiUrl: "https://cloud.example.com",
      accessToken: "fresh-access-token",
      refreshToken: "fresh-refresh-token",
      accessTokenExpiresAt: "2026-03-14T00:00:00.000Z",
      refreshTokenExpiresAt: "2026-03-15T00:00:00.000Z",
    });
  });
});
