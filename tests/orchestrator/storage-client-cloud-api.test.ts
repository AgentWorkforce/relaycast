import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ScopedS3Client } from "../../packages/core/src/storage/client.js";

const originalFetch = globalThis.fetch;
const originalRunId = process.env.RUN_ID;
const originalRefreshToken = process.env.CLOUD_API_REFRESH_TOKEN;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalRunId === undefined) {
    delete process.env.RUN_ID;
  } else {
    process.env.RUN_ID = originalRunId;
  }
  if (originalRefreshToken === undefined) {
    delete process.env.CLOUD_API_REFRESH_TOKEN;
  } else {
    process.env.CLOUD_API_REFRESH_TOKEN = originalRefreshToken;
  }
});

describe("ScopedS3Client cloud-api storage", () => {
  it("refreshes an expired access token and retries the object request", async () => {
    process.env.RUN_ID = "run-456";
    delete process.env.CLOUD_API_REFRESH_TOKEN;
    const requests: Array<{ url: string; authorization: string | null; body?: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
        body: typeof init?.body === "string" ? init.body : undefined,
      });

      if (requests.length === 1) {
        return new Response("expired", { status: 401 });
      }
      if (url === "https://cloud.example.com/api/v1/auth/token/refresh") {
        return Response.json({
          accessToken: "fresh-access",
          refreshToken: "fresh-refresh",
        });
      }
      return new Response("ok");
    }) as typeof fetch;

    const client = new ScopedS3Client({
      backend: "cloud-api",
      accessKeyId: "cloud-api",
      secretAccessKey: "cloud-api",
      sessionToken: "expired-access",
      bucket: "workflow-storage-r2",
      prefix: "user-123/run-456",
      cloudApiUrl: "https://cloud.example.com",
      cloudApiAccessToken: "expired-access",
      cloudApiRefreshToken: "refresh-token",
    });

    const object = await client.getObject("runner.log");

    assert.equal(object.toString("utf8"), "ok");
    assert.deepEqual(requests.map((request) => request.url), [
      "https://cloud.example.com/api/v1/workflows/runs/run-456/storage/runner.log",
      "https://cloud.example.com/api/v1/auth/token/refresh",
      "https://cloud.example.com/api/v1/workflows/runs/run-456/storage/runner.log",
    ]);
    assert.equal(requests[0]?.authorization, "Bearer expired-access");
    assert.equal(requests[1]?.body, JSON.stringify({ refreshToken: "refresh-token" }));
    assert.equal(requests[2]?.authorization, "Bearer fresh-access");
  });
});
