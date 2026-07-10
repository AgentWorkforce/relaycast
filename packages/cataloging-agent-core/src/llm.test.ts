import { afterEach, describe, expect, it, vi } from "vitest";

import { summarizeInsight } from "./llm.js";
import type { GithubSignalBuckets } from "./insight-schema.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const SIGNALS: GithubSignalBuckets = {
  domain: "github",
  blockedOnReview: [{ number: 17, repo: "acme/platform", waitingDays: 4, reviewer: "bob" }],
  ciFailing: [],
  staleDraft: [],
  mergeConflict: [],
};

const METRICS = { openCount: 1, draftCount: 0, p50AgeDays: 4, p90AgeDays: 4 };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("summarizeInsight", () => {
  it("returns the trimmed assistant content on a 2xx response", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        choices: [
          {
            message: {
              content: "  acme/platform#17 has been waiting on bob for 4 days.  ",
            },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await summarizeInsight({
      domain: "github",
      signals: SIGNALS,
      metrics: METRICS,
      apiKey: "key_test",
    });

    expect(result).toEqual({ summary: "acme/platform#17 has been waiting on bob for 4 days." });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(OPENROUTER_URL);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer key_test");
  });

  it("returns { summary: null, reason } on a non-2xx response without throwing", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(503, { error: "service unavailable" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await summarizeInsight({
      domain: "github",
      signals: SIGNALS,
      metrics: METRICS,
      apiKey: "key_test",
    });

    expect(result).toEqual({ summary: null, reason: "openrouter returned 503" });
  });

  it("returns { summary: null, reason: 'invalid response' } on unparseable JSON", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("<<not json>>", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await summarizeInsight({
      domain: "github",
      signals: SIGNALS,
      metrics: METRICS,
      apiKey: "key_test",
    });

    expect(result).toEqual({ summary: null, reason: "invalid response" });
  });

  it("returns { summary: null, reason: 'invalid response' } when content is missing", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { choices: [{ message: {} }] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await summarizeInsight({
      domain: "github",
      signals: SIGNALS,
      metrics: METRICS,
      apiKey: "key_test",
    });

    expect(result).toEqual({ summary: null, reason: "invalid response" });
  });

  it("returns { summary: null, reason: 'timed out' } when fetch outlasts the 3s budget", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = summarizeInsight({
      domain: "github",
      signals: SIGNALS,
      metrics: METRICS,
      apiKey: "key_test",
    });

    await vi.advanceTimersByTimeAsync(3_001);
    const result = await promise;

    expect(result).toEqual({ summary: null, reason: "timed out" });
  });

  it("returns { summary: null, reason: 'aborted' } when the parent signal is already aborted", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    controller.abort();

    const result = await summarizeInsight({
      domain: "github",
      signals: SIGNALS,
      metrics: METRICS,
      apiKey: "key_test",
      signal: controller.signal,
    });

    expect(result).toEqual({ summary: null, reason: "aborted" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns { summary: null, reason: 'request failed' } on a network error", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await summarizeInsight({
      domain: "github",
      signals: SIGNALS,
      metrics: METRICS,
      apiKey: "key_test",
    });

    expect(result).toEqual({ summary: null, reason: "request failed" });
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
