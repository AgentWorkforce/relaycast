/**
 * Worker-side broker client tests.
 *
 * Covers the three behaviours that are most prone to silent breakage:
 *   1. In-memory cache hit/miss based on `expiresAt` and refresh skew.
 *   2. Exponential backoff on 5xx, terminal failure on 4xx.
 *   3. HMAC-signed request shape — headers + body produced by the
 *      Worker must verify against the Node-side verifier (cross-platform
 *      contract sanity check).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { verifyRequest } from "@cloud/sts-broker/hmac-node.js";
import {
  REQUEST_SIGNATURE_HEADER,
  REQUEST_TIMESTAMP_HEADER,
} from "@cloud/sts-broker/hmac.js";
import {
  BrokerClientError,
  clearBrokerCacheForTesting,
  getStsCredentials,
  inspectBrokerCacheForTesting,
} from "./broker-client";

const SECRET = "test-broker-hmac-secret";
const BROKER_URL = "https://broker.example.com";

beforeEach(() => {
  clearBrokerCacheForTesting();
});

function makeCreds(expiresInMs = 900_000) {
  return {
    accessKeyId: "AKIAFAKE",
    secretAccessKey: "secret",
    sessionToken: "session-token",
    bucket: "test-bucket",
    prefix: "alice/run-1",
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  };
}

describe("getStsCredentials — happy path", () => {
  it("calls the broker with HMAC-signed POST and caches the response", async () => {
    const calls: Array<{
      url: string;
      method?: string;
      headers: Record<string, string>;
      body: string;
    }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method,
        headers: init?.headers as Record<string, string>,
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify(makeCreds()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const result = await getStsCredentials(
      { userId: "alice", runId: "run-1" },
      { brokerUrl: BROKER_URL, hmacSecret: SECRET, fetchImpl },
    );

    expect(result.bucket).toBe("test-bucket");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://broker.example.com/broker/sts/assume-role");
    expect(calls[0].method).toBe("POST");

    // Signed body must round-trip through Node-side verifier.
    const headers = calls[0].headers as Record<string, string>;
    const verification = verifyRequest({
      method: "POST",
      path: "/broker/sts/assume-role",
      body: calls[0].body,
      headers: {
        [REQUEST_SIGNATURE_HEADER]: headers[REQUEST_SIGNATURE_HEADER],
        [REQUEST_TIMESTAMP_HEADER]: headers[REQUEST_TIMESTAMP_HEADER],
      },
      secret: SECRET,
    });
    expect(verification).toEqual({ ok: true });

    // Body should declare the scope explicitly (default workflow-run).
    expect(JSON.parse(calls[0].body)).toEqual({
      scope: "workflow-run",
      userId: "alice",
      runId: "run-1",
    });
  });

  it("hits the in-memory cache on the second call within validity window", async () => {
    let callCount = 0;
    const fetchImpl = async () => {
      callCount += 1;
      return new Response(JSON.stringify(makeCreds()), { status: 200 });
    };

    const config = { brokerUrl: BROKER_URL, hmacSecret: SECRET, fetchImpl };
    await getStsCredentials({ userId: "alice", runId: "run-1" }, config);
    await getStsCredentials({ userId: "alice", runId: "run-1" }, config);
    expect(callCount).toBe(1);
    expect(inspectBrokerCacheForTesting().size).toBe(1);
  });

  it("refreshes when cached creds are within the refresh skew window", async () => {
    let callCount = 0;
    const fetchImpl = async () => {
      callCount += 1;
      // First call: cred expires very soon (less than skew).
      // Second call: fresh creds with full window.
      const expiresInMs = callCount === 1 ? 30_000 : 900_000;
      return new Response(JSON.stringify(makeCreds(expiresInMs)), {
        status: 200,
      });
    };

    const config = { brokerUrl: BROKER_URL, hmacSecret: SECRET, fetchImpl };
    await getStsCredentials({ userId: "alice", runId: "run-1" }, config);
    await getStsCredentials({ userId: "alice", runId: "run-1" }, config);
    expect(callCount).toBe(2);
  });

  it("uses scope-aware cache keys (workflow-run vs credential-store)", async () => {
    let callCount = 0;
    const fetchImpl = async () => {
      callCount += 1;
      return new Response(JSON.stringify(makeCreds()), { status: 200 });
    };
    const config = { brokerUrl: BROKER_URL, hmacSecret: SECRET, fetchImpl };

    await getStsCredentials(
      { scope: "workflow-run", userId: "alice", runId: "run-1" },
      config,
    );
    await getStsCredentials(
      { scope: "credential-store", userId: "alice" },
      config,
    );
    expect(callCount).toBe(2);
    expect(inspectBrokerCacheForTesting().size).toBe(2);
  });
});

describe("getStsCredentials — retries", () => {
  it("retries on 5xx and succeeds eventually", async () => {
    let callCount = 0;
    const fetchImpl = async () => {
      callCount += 1;
      if (callCount < 3) {
        return new Response("oops", { status: 503 });
      }
      return new Response(JSON.stringify(makeCreds()), { status: 200 });
    };

    const sleeps: number[] = [];
    const config = {
      brokerUrl: BROKER_URL,
      hmacSecret: SECRET,
      fetchImpl,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    };

    const result = await getStsCredentials(
      { userId: "alice", runId: "run-1" },
      config,
    );
    expect(result.bucket).toBe("test-bucket");
    expect(callCount).toBe(3);
    // Three attempts means two backoff waits.
    expect(sleeps).toEqual([250, 500]);
  });

  it("gives up after the retry budget and propagates BrokerClientError", async () => {
    let callCount = 0;
    const fetchImpl = async () => {
      callCount += 1;
      return new Response("upstream sad", { status: 502 });
    };

    const config = {
      brokerUrl: BROKER_URL,
      hmacSecret: SECRET,
      fetchImpl,
      sleep: async () => undefined,
    };

    await expect(
      getStsCredentials({ userId: "alice", runId: "run-1" }, config),
    ).rejects.toBeInstanceOf(BrokerClientError);
    // Budget is initial + 5 retries = 6 attempts.
    expect(callCount).toBe(6);
  });

  it("retries Lambda Function URL 429 concurrency throttles", async () => {
    let callCount = 0;
    const fetchImpl = async () => {
      callCount += 1;
      if (callCount < 2) {
        return new Response(
          '{"Reason":"ConcurrentInvocationLimitExceeded","Type":"User","message":"Rate Exceeded."}',
          { status: 429 },
        );
      }
      return new Response(JSON.stringify(makeCreds()), { status: 200 });
    };

    const sleeps: number[] = [];
    const config = {
      brokerUrl: BROKER_URL,
      hmacSecret: SECRET,
      fetchImpl,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    };

    const result = await getStsCredentials(
      { userId: "alice", runId: "run-1" },
      config,
    );
    expect(result.bucket).toBe("test-bucket");
    expect(callCount).toBe(2);
    expect(sleeps).toEqual([250]);
  });

  it("does NOT retry on 4xx (terminal failure)", async () => {
    let callCount = 0;
    const fetchImpl = async () => {
      callCount += 1;
      return new Response("forbidden", { status: 403 });
    };
    const config = {
      brokerUrl: BROKER_URL,
      hmacSecret: SECRET,
      fetchImpl,
      sleep: async () => undefined,
    };

    await expect(
      getStsCredentials({ userId: "alice", runId: "run-1" }, config),
    ).rejects.toBeInstanceOf(BrokerClientError);
    expect(callCount).toBe(1);
  });
});

describe("getStsCredentials — input validation", () => {
  it("requires runId for workflow-run scope", async () => {
    const fetchImpl = async () => new Response("{}", { status: 200 });
    const config = { brokerUrl: BROKER_URL, hmacSecret: SECRET, fetchImpl };
    await expect(
      getStsCredentials({ userId: "alice" }, config),
    ).rejects.toThrow(/runId is required/);
  });

  it("throws when broker URL is missing", async () => {
    const fetchImpl = async () => new Response("{}", { status: 200 });
    await expect(
      getStsCredentials(
        { userId: "alice", runId: "r" },
        { brokerUrl: "", hmacSecret: SECRET, fetchImpl },
      ),
    ).rejects.toThrow(/BROKER_URL/);
  });
});
