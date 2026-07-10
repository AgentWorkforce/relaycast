import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { maybeRecord, type RecorderEnv } from "../src/recorder.js";

const FIXED_TIME = new Date("2026-05-14T09:08:07.000Z");
const REQUEST_ID = "123e4567-e89b-12d3-a456-426614174000";
const KEY_PATTERN = /^corpus\/\d{4}\/\d{2}\/\d{2}\/\d{2}\/[a-f0-9-]+\.ndjson$/;

function createEnv(sampleRate: string): {
  env: RecorderEnv;
  put: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
} {
  const put = vi.fn(async () => undefined);
  const get = vi.fn(async () => sampleRate);

  return {
    env: {
      TRAFFIC_RECORDER: {
        put,
      } as unknown as R2Bucket,
      ROUTER_CONFIG: {
        get,
      } as unknown as KVNamespace,
    },
    put,
    get,
  };
}

function createCtx(): {
  ctx: Pick<ExecutionContext, "waitUntil">;
  waitUntil: ReturnType<typeof vi.fn>;
  waits: Promise<unknown>[];
} {
  const waits: Promise<unknown>[] = [];
  const waitUntil = vi.fn((promise: Promise<unknown>) => {
    waits.push(promise);
  });

  return {
    ctx: { waitUntil },
    waitUntil,
    waits,
  };
}

describe("maybeRecord", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_TIME);
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("writes a record when sampling is 100 percent", async () => {
    const { env, put, get } = createEnv("100");
    const { ctx, waitUntil, waits } = createCtx();
    const request = new Request("https://router.test/api/v1/messages?foo=bar", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-token",
        "x-request-id": REQUEST_ID,
      },
      body: JSON.stringify({
        prompt: "hello",
        token: "secret-token",
      }),
    });
    const response = new Response(
      JSON.stringify({
        ok: true,
        refreshToken: "refresh-me",
      }),
      {
        status: 201,
        headers: {
          "content-type": "application/json",
          "set-cookie": "sid=123",
        },
      },
    );

    await maybeRecord(request, response, env, ctx);
    await Promise.all(waits);

    expect(get).toHaveBeenCalledWith("RECORDER_SAMPLE_RATE");
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledOnce();

    const [key, line] = put.mock.calls[0] as [string, string];
    expect(key).toBe("corpus/2026/05/14/09/123e4567-e89b-12d3-a456-426614174000.ndjson");
    expect(key).toMatch(KEY_PATTERN);

    const record = JSON.parse(line) as Record<string, unknown>;
    expect(record).toEqual({
      ts: "2026-05-14T09:08:07.000Z",
      method: "POST",
      path: "/api/v1/messages",
      query: "foo=bar",
      request_headers: {
        authorization: "[REDACTED:19]",
        "content-type": "application/json",
        "x-request-id": REQUEST_ID,
      },
      request_body: JSON.stringify({
        prompt: "hello",
        token: "[REDACTED:12]",
      }),
      response_status: 201,
      response_headers: {
        "content-type": "application/json",
        "set-cookie": "[REDACTED:7]",
      },
      response_body: JSON.stringify({
        ok: true,
        refreshToken: "[REDACTED:10]",
      }),
      request_id: REQUEST_ID,
    });
  });

  it("does not write when sampling is 0 percent", async () => {
    const { env, put } = createEnv("0");
    const { ctx, waitUntil } = createCtx();

    await maybeRecord(
      new Request("https://router.test/api/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: true }),
      }),
      new Response("ok"),
      env,
      ctx,
    );

    expect(waitUntil).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("skips deny-listed paths without touching storage", async () => {
    const { env, put, get } = createEnv("100");
    const { ctx, waitUntil } = createCtx();

    await maybeRecord(
      new Request("https://router.test/observer/session/123"),
      new Response("ok"),
      env,
      ctx,
    );

    expect(get).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("replaces oversize bodies with a placeholder before writing", async () => {
    const { env, put } = createEnv("100");
    const { ctx, waits } = createCtx();
    const oversized = "x".repeat(256 * 1024 + 1);

    await maybeRecord(
      new Request("https://router.test/api/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "x-request-id": REQUEST_ID,
        },
        body: oversized,
      }),
      new Response("ok", {
        headers: { "content-type": "text/plain" },
      }),
      env,
      ctx,
    );
    await Promise.all(waits);

    expect(put).toHaveBeenCalledOnce();
    const [, line] = put.mock.calls[0] as [string, string];
    const record = JSON.parse(line) as { request_body: string; response_body: string };

    expect(record.request_body).toBe("[OVERSIZE:262145]");
    expect(record.response_body).toBe("ok");
  });
});
