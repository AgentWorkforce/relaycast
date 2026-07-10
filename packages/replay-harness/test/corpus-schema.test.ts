import { describe, expect, it } from "vitest";

import { parseCorpusForTest } from "../src/corpus.js";

// Regression: the production traffic recorder
// (packages/router/src/recorder.ts) writes `ts` / `request_headers` /
// `request_body`, but the harness historically only read `timestamp` /
// `headers` / `body`. That contract drift made the cutover replay gate
// fail with `timestamp must be a non-empty string` against a real
// recorded corpus. The parser must accept the recorder schema (and stay
// backward-compatible with the legacy schema).
describe("corpus schema compatibility", () => {
  it("accepts the production recorder schema (ts / request_headers / request_body)", () => {
    const line = JSON.stringify({
      ts: "2026-05-16T21:00:00.000Z",
      method: "get",
      path: "/cloud/api/health",
      query: "",
      request_headers: { "x-test": "1" },
      request_body: null,
      response_status: 200,
      response_headers: { "content-type": "application/json" },
      response_body: '{"status":"ok"}',
      request_id: "req-123",
    });

    const [entry] = parseCorpusForTest(line);

    expect(entry.timestamp).toBe("2026-05-16T21:00:00.000Z");
    expect(entry.method).toBe("GET");
    expect(entry.path).toBe("/cloud/api/health");
    expect(entry.headers).toEqual({ "x-test": "1" });
    expect(entry.body).toBeNull();
    expect(entry.response_status).toBe(200);
    expect(entry.request_id).toBe("req-123");
  });

  it("stays backward-compatible with the legacy schema (timestamp / headers / body)", () => {
    const line = JSON.stringify({
      timestamp: "2026-05-14T13:00:00.000Z",
      method: "POST",
      path: "/cloud/api/thing",
      headers: { "x-legacy": "1" },
      body: "hello",
      response_status: 201,
      response_headers: {},
      response_body: null,
    });

    const [entry] = parseCorpusForTest(line);

    expect(entry.timestamp).toBe("2026-05-14T13:00:00.000Z");
    expect(entry.headers).toEqual({ "x-legacy": "1" });
    expect(entry.body).toBe("hello");
    expect(entry.response_status).toBe(201);
  });

  it("still rejects an entry with neither timestamp nor ts", () => {
    const line = JSON.stringify({
      method: "GET",
      path: "/cloud",
      response_status: 200,
    });

    expect(() => parseCorpusForTest(line)).toThrow(
      /timestamp must be a non-empty string/,
    );
  });
});
