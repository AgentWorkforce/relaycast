import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCli, runReplayHarness } from "../src/index.js";
import {
  MutationBlockedError,
  buildTargetUrl,
  replayEntry,
  stripMountPrefixFromPath,
} from "../src/replay.js";
import type { CorpusEntry } from "../src/corpus.js";

function createCorpusEntry(overrides: Partial<CorpusEntry> = {}): CorpusEntry {
  return {
    timestamp: "2026-05-14T13:00:00.000Z",
    method: "GET",
    path: "/api/v1/identical",
    query: "",
    headers: { accept: "application/json" },
    body: null,
    response_status: 200,
    response_headers: {
      "content-type": "application/json",
      "content-length": "11",
      connection: "close",
    },
    response_body: JSON.stringify({ ok: true }),
    request_id: "req-identical",
    ...overrides,
  };
}

describe("stripMountPrefixFromPath", () => {
  it("strips the /cloud prefix", () => {
    expect(stripMountPrefixFromPath("/cloud/api/v1/foo", "/cloud")).toBe("/api/v1/foo");
  });

  it("returns / when the path equals the prefix exactly", () => {
    expect(stripMountPrefixFromPath("/cloud", "/cloud")).toBe("/");
  });

  it("does not strip when prefix is false", () => {
    expect(stripMountPrefixFromPath("/cloud/api/v1/foo", false)).toBe("/cloud/api/v1/foo");
  });

  it("does not strip an unrelated prefix", () => {
    expect(stripMountPrefixFromPath("/api/v1/foo", "/cloud")).toBe("/api/v1/foo");
  });

  it("does not partially match a prefix that is a substring but not a path segment boundary", () => {
    expect(stripMountPrefixFromPath("/cloudflare/api/v1/foo", "/cloud")).toBe(
      "/cloudflare/api/v1/foo",
    );
  });
});

describe("replay harness smoke", () => {
  let server: http.Server;
  let baseUrl = "";
  let tempDir = "";
  let seenMutatingMethods: string[] = [];
  let slowResponseDelayMs = 100;

  beforeEach(async () => {
    seenMutatingMethods = [];
    slowResponseDelayMs = 100;
    server = http.createServer((request, response) => {
      if (request.url === "/api/v1/identical") {
        const body = JSON.stringify({ ok: true });
        response.sendDate = false;
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
          connection: "close",
        });
        response.end(body);
        return;
      }

      if (request.url === "/api/v1/allowlisted") {
        const body = JSON.stringify({ ok: true });
        response.sendDate = false;
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
          connection: "close",
          date: new Date("2026-05-14T13:01:00.000Z").toUTCString(),
        });
        response.end(body);
        return;
      }

      if (request.url === "/api/v1/mutate" && request.method === "POST") {
        seenMutatingMethods.push(request.method);
        const body = JSON.stringify({ ok: true });
        response.sendDate = false;
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
          connection: "close",
        });
        response.end(body);
        return;
      }

      if (request.url === "/api/v1/slow") {
        setTimeout(() => {
          const body = JSON.stringify({ ok: true });
          response.sendDate = false;
          response.writeHead(200, {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(body)),
            connection: "close",
          });
          response.end(body);
        }, slowResponseDelayMs);
        return;
      }

      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
    });
    server.keepAliveTimeout = 0;

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to bind local smoke server.");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "replay-harness-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("passes an identical corpus with zero divergences", async () => {
    const corpusPath = path.join(tempDir, "identical.ndjson");
    const reportPath = path.join(tempDir, "identical-report.json");

    await fs.writeFile(
      corpusPath,
      `${JSON.stringify(createCorpusEntry())}\n`,
      "utf8",
    );

    const report = await runCli([corpusPath, "--target", baseUrl, "--report", reportPath]);

    expect(report.totals).toEqual({
      total: 1,
      identical: 1,
      allowlisted: 0,
      divergent: 0,
    });
  });

  it("strips /cloud mount prefix before building the target URL", async () => {
    // The server only handles /api/v1/identical — corpus has /cloud/api/v1/identical.
    const corpusPath = path.join(tempDir, "prefixed.ndjson");
    const reportPath = path.join(tempDir, "prefixed-report.json");

    await fs.writeFile(
      corpusPath,
      `${JSON.stringify({
        timestamp: "2026-05-14T13:00:00.000Z",
        method: "GET",
        path: "/cloud/api/v1/identical",
        query: "",
        headers: { accept: "application/json" },
        body: null,
        response_status: 200,
        response_headers: {
          "content-type": "application/json",
          "content-length": "11",
          connection: "close",
        },
        response_body: { ok: true },
        request_id: "req-prefixed",
      })}\n`,
      "utf8",
    );

    const report = await runCli([corpusPath, "--target", baseUrl, "--report", reportPath]);

    expect(report.totals.total).toBe(1);
    expect(report.totals.divergent).toBe(0);
    // Target URL should not contain /cloud
    expect(report.results[0]?.targetUrl).not.toContain("/cloud/");
    expect(report.results[0]?.targetUrl).toContain("/api/v1/identical");
  });

  it("skips mutating methods (POST/PUT/PATCH/DELETE) in safe mode", async () => {
    const corpusPath = path.join(tempDir, "mutating.ndjson");
    const reportPath = path.join(tempDir, "mutating-report.json");

    // Mix: one safe GET and one mutating POST.
    await fs.writeFile(
      corpusPath,
      [
        JSON.stringify({
          timestamp: "2026-05-14T13:00:00.000Z",
          method: "GET",
          path: "/api/v1/identical",
          query: "",
          headers: { accept: "application/json" },
          body: null,
          response_status: 200,
          response_headers: { "content-type": "application/json" },
          response_body: { ok: true },
          request_id: "req-get",
        }),
        JSON.stringify({
          timestamp: "2026-05-14T13:00:01.000Z",
          method: "POST",
          path: "/api/v1/some-endpoint",
          query: "",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "create" }),
          response_status: 201,
          response_headers: { "content-type": "application/json" },
          response_body: { id: "123" },
          request_id: "req-post",
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const report = await runCli([corpusPath, "--target", baseUrl, "--report", reportPath]);

    // Only the GET should be replayed; POST is skipped in safe mode.
    expect(report.totals.total).toBe(1);
    expect(report.results[0]?.requestId).toBe("req-get");
  });

  it("throws MutationBlockedError when allowMutations=false and a mutating entry is directly replayed", async () => {
    const entry = {
      timestamp: "2026-05-14T13:00:00.000Z",
      method: "DELETE",
      path: "/api/v1/resource/1",
      query: "",
      headers: {},
      body: null,
      response_status: 200,
      response_headers: {},
      response_body: null,
      request_id: "req-delete",
    };

    await expect(
      replayEntry(entry, baseUrl, { allowMutations: false }),
    ).rejects.toThrow(MutationBlockedError);
  });

  it("passes an Appendix B allowlisted divergence with zero divergences", async () => {
    const corpusPath = path.join(tempDir, "allowlisted.ndjson");
    const reportPath = path.join(tempDir, "allowlisted-report.json");

    await fs.writeFile(
      corpusPath,
      `${JSON.stringify(createCorpusEntry({
        path: "/api/v1/allowlisted",
        response_headers: {
          "content-type": "application/json",
          "content-length": "11",
          connection: "close",
          date: new Date("2026-05-14T13:00:00.000Z").toUTCString(),
        },
        request_id: "req-allowlisted",
      }))}\n`,
      "utf8",
    );

    const report = await runCli([corpusPath, "--target", baseUrl, "--report", reportPath]);

    expect(report.totals).toEqual({
      total: 1,
      identical: 0,
      allowlisted: 1,
      divergent: 0,
    });
    expect(report.results[0]?.result.kind).toBe("allowlisted");
    expect(report.results[0]?.result.details.allowlistedDifferences).toEqual([
      expect.objectContaining({
        field: "header.date",
      }),
    ]);
  });

  it("drops the /cloud mount prefix when building replay target URLs", () => {
    expect(stripMountPrefixFromPath("/cloud/api/v1/identical", "/cloud")).toBe(
      "/api/v1/identical",
    );
    expect(stripMountPrefixFromPath("/cloud", "/cloud")).toBe("/");
    expect(stripMountPrefixFromPath("/cloudish/api", "/cloud")).toBe(
      "/cloudish/api",
    );
    expect(
      buildTargetUrl(
        "https://target.test/base",
        createCorpusEntry({
          path: "/cloud/api/v1/identical",
          query: "a=1",
        }),
      ),
    ).toBe("https://target.test/api/v1/identical?a=1");
  });

  it("skips mutating requests unless mutations are explicitly allowed", async () => {
    const corpusPath = path.join(tempDir, "mutations.ndjson");

    await fs.writeFile(
      corpusPath,
      [
        JSON.stringify(
          createCorpusEntry({
            method: "POST",
            path: "/cloud/api/v1/mutate",
            request_id: "req-post",
          }),
        ),
        JSON.stringify(
          createCorpusEntry({
            path: "/cloud/api/v1/identical",
            request_id: "req-get",
          }),
        ),
        "",
      ].join("\n"),
      "utf8",
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const evaluations = await runReplayHarness(corpusPath, baseUrl);

      expect(evaluations).toHaveLength(1);
      expect(evaluations[0]?.requestId).toBe("req-get");
      expect(evaluations[0]?.targetUrl).toBe(`${baseUrl}/api/v1/identical`);
      expect(warn).toHaveBeenCalledWith(
        "[replay] Skipping mutating request POST /cloud/api/v1/mutate (pass --allow-mutations to include)",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("allows mutating requests when --allow-mutations is passed", async () => {
    const corpusPath = path.join(tempDir, "allowed-mutations.ndjson");
    const reportPath = path.join(tempDir, "allowed-mutations-report.json");

    await fs.writeFile(
      corpusPath,
      `${JSON.stringify(createCorpusEntry({
        method: "POST",
        path: "/cloud/api/v1/mutate",
        request_id: "req-post",
      }))}\n`,
      "utf8",
    );

    const report = await runCli([
      corpusPath,
      "--target",
      baseUrl,
      "--report",
      reportPath,
      "--allow-mutations",
    ]);

    expect(report.totals.total).toBe(1);
    expect(report.results[0]?.targetUrl).toBe(`${baseUrl}/api/v1/mutate`);
    expect(seenMutatingMethods).toEqual(["POST"]);
  });

  it("fails an individual request after the per-request timeout", async () => {
    const entry = createCorpusEntry({ path: "/api/v1/slow" });
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );

    await expect(
      replayEntry(entry, baseUrl, { fetchImpl, requestTimeoutMs: 5 }),
    ).rejects.toThrow(`Request timed out after 5 ms: GET ${baseUrl}/api/v1/slow`);
  });

  it("caps in-flight requests with the overall replay timeout", async () => {
    const corpusPath = path.join(tempDir, "overall-timeout.ndjson");
    slowResponseDelayMs = 300;

    await fs.writeFile(
      corpusPath,
      `${JSON.stringify(createCorpusEntry({ path: "/api/v1/slow" }))}\n`,
      "utf8",
    );

    await expect(
      runReplayHarness(corpusPath, baseUrl, {
        requestTimeoutMs: 1_000,
        replayTimeoutMs: 150,
      }),
    ).rejects.toThrow(
      new RegExp(
        `Request timed out after \\d+ ms: GET ${baseUrl.replaceAll(".", "\\.")}/api/v1/slow`,
      ),
    );
  });
});
