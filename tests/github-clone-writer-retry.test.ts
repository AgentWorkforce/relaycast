import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RelayFileClient } from "@relayfile/sdk";
import { RelayFileApiError } from "@relayfile/sdk";
import {
  chunkedBulkWrite,
  CLONE_RETRY_MAX_ATTEMPTS,
} from "../packages/core/src/clone/github-clone-writer.ts";

type BulkWriteParams = {
  workspaceId: string;
  files: Array<{
    path: string;
    content: string;
    contentType?: string;
    encoding: "utf-8" | "base64";
  }>;
  correlationId: string;
  signal?: AbortSignal;
};

type BulkWriteResult = {
  written: number;
  errors: Array<{ path: string; code: string; message: string }>;
};

class FakeRelayFileClient {
  public readonly calls: BulkWriteParams[] = [];

  public constructor(
    private readonly handler: (params: BulkWriteParams, callIndex: number) => Promise<BulkWriteResult>,
  ) {}

  async bulkWrite(params: BulkWriteParams): Promise<BulkWriteResult> {
    this.calls.push(params);
    return await this.handler(params, this.calls.length - 1);
  }
}

function createFiles(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    path: `/github/repos/acme/demo/contents/file-${String(index).padStart(4, "0")}.txt@abc123.json`,
    content: `file ${index}\n`,
    encoding: "utf-8" as const,
  }));
}

function toClient(client: FakeRelayFileClient): RelayFileClient {
  return client as unknown as RelayFileClient;
}

const FAST_RETRY = { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 10, deadlineMs: 60_000 };

function backpressureError(
  code: string,
  options: {
    retryAfter?: string;
    retryAfterSeconds?: number;
  } = {},
): RelayFileApiError {
  const error = new RelayFileApiError(429, {
    code,
    message: "workspace durable object is busy; retry after the advertised delay",
    retryAfterSeconds: options.retryAfterSeconds,
  } as any);
  if (options.retryAfter !== undefined) {
    Object.assign(error, {
      response: {
        headers: {
          "Retry-After": options.retryAfter,
        },
      },
    });
  }
  return error;
}

describe("github clone writer 429 retry (core)", () => {
  it("retries on 429 workspace_busy and succeeds after backoff", async () => {
    let callCount = 0;
    const client = new FakeRelayFileClient(async (params, callIndex) => {
      callCount++;
      if (callIndex < 2) {
        throw backpressureError("workspace_busy");
      }
      return { written: params.files.length, errors: [] };
    });

    const result = await chunkedBulkWrite({
      client: toClient(client),
      workspaceId: "workspace-retry-1",
      files: createFiles(3),
      chunkSize: 3,
      maxConcurrent: 1,
      retryOptions: FAST_RETRY,
    });

    assert.equal(result.written, 3);
    assert.deepEqual(result.errors, []);
    assert.equal(callCount, 3, "expected 2 retries then success on 3rd call");
  });

  it("retries durable_object_overloaded 429 chunks", async () => {
    let callCount = 0;
    const client = new FakeRelayFileClient(async (params, callIndex) => {
      callCount++;
      if (callIndex === 0) {
        throw backpressureError("durable_object_overloaded");
      }
      return { written: params.files.length, errors: [] };
    });

    const result = await chunkedBulkWrite({
      client: toClient(client),
      workspaceId: "workspace-retry-overloaded",
      files: createFiles(2),
      chunkSize: 2,
      maxConcurrent: 1,
      retryOptions: FAST_RETRY,
    });

    assert.equal(result.written, 2);
    assert.deepEqual(result.errors, []);
    assert.equal(callCount, 2);
  });

  it("uses body retryAfterSeconds for retry delay", async () => {
    let callCount = 0;
    const client = new FakeRelayFileClient(async (params, callIndex) => {
      callCount++;
      if (callIndex === 0) {
        throw backpressureError("workspace_busy", { retryAfterSeconds: 0 });
      }
      return { written: params.files.length, errors: [] };
    });

    const result = await chunkedBulkWrite({
      client: toClient(client),
      workspaceId: "workspace-body-retry-after",
      files: createFiles(2),
      chunkSize: 2,
      maxConcurrent: 1,
      retryOptions: FAST_RETRY,
    });

    assert.equal(result.written, 2);
    assert.deepEqual(result.errors, []);
    assert.equal(callCount, 2);
  });

  it("does not retry 429 errors with unsupported codes even when Retry-After is present", async () => {
    let callCount = 0;
    const client = new FakeRelayFileClient(async () => {
      callCount++;
      throw backpressureError("rate_limited", { retryAfter: "0" });
    });

    const result = await chunkedBulkWrite({
      client: toClient(client),
      workspaceId: "workspace-unsupported-429",
      files: createFiles(2),
      chunkSize: 2,
      maxConcurrent: 1,
      retryOptions: FAST_RETRY,
    });

    assert.equal(result.written, 0);
    assert.equal(result.errors.length, 2);
    assert.equal(result.errors[0]!.code, "rate_limited");
    assert.equal(callCount, 1);
  });

  it("exhausts retries on persistent 429 and returns errors", async () => {
    let callCount = 0;
    const client = new FakeRelayFileClient(async () => {
      callCount++;
      throw backpressureError("workspace_busy");
    });

    const result = await chunkedBulkWrite({
      client: toClient(client),
      workspaceId: "workspace-retry-exhaust",
      files: createFiles(2),
      chunkSize: 2,
      maxConcurrent: 1,
      retryOptions: FAST_RETRY,
    });

    assert.equal(result.written, 0);
    assert.equal(result.errors.length, 2, "one error per file in chunk");
    assert.equal(result.errors[0]!.code, "workspace_busy");
    // attempts counter increments before each call; maxAttempts total calls
    assert.equal(callCount, FAST_RETRY.maxAttempts);
  });

  it("does not retry non-429 errors", async () => {
    let callCount = 0;
    const client = new FakeRelayFileClient(async () => {
      callCount++;
      throw new RelayFileApiError(503, {
        code: "relay_unavailable",
        message: "Relayfile unavailable",
      });
    });

    const result = await chunkedBulkWrite({
      client: toClient(client),
      workspaceId: "workspace-no-retry",
      files: createFiles(2),
      chunkSize: 2,
      maxConcurrent: 1,
      retryOptions: FAST_RETRY,
    });

    assert.equal(result.written, 0);
    assert.equal(result.errors.length, 2);
    assert.equal(callCount, 1, "no retries for non-429 errors");
  });

  it("abort signal cancels during retry wait", async () => {
    const controller = new AbortController();
    const client = new FakeRelayFileClient(async () => {
      // First call throws 429, then we abort during the retry delay
      setTimeout(() => controller.abort(new Error("aborted by test")), 0);
      throw backpressureError("workspace_busy");
    });

    await assert.rejects(
      chunkedBulkWrite({
        client: toClient(client),
        workspaceId: "workspace-abort-retry",
        files: createFiles(1),
        chunkSize: 1,
        maxConcurrent: 1,
        signal: controller.signal,
        retryOptions: { maxAttempts: 5, baseDelayMs: 5_000, maxDelayMs: 60_000 },
      }),
      /aborted by test/,
    );
  });

  it("retries multiple chunks independently", async () => {
    const callsByChunk = new Map<number, number>();
    const client = new FakeRelayFileClient(async (params) => {
      const chunkIndex = Number(params.correlationId.split(":").pop());
      const count = (callsByChunk.get(chunkIndex) ?? 0) + 1;
      callsByChunk.set(chunkIndex, count);

      // Chunk 0 succeeds immediately, chunk 1 needs 1 retry
      if (chunkIndex === 1 && count === 1) {
        throw backpressureError("workspace_busy");
      }
      return { written: params.files.length, errors: [] };
    });

    const result = await chunkedBulkWrite({
      client: toClient(client),
      workspaceId: "workspace-multi-chunk",
      jobId: "test-job",
      files: createFiles(4),
      chunkSize: 2,
      maxConcurrent: 1,
      retryOptions: FAST_RETRY,
    });

    assert.equal(result.written, 4);
    assert.deepEqual(result.errors, []);
    assert.equal(callsByChunk.get(0), 1, "chunk 0 succeeded first try");
    assert.equal(callsByChunk.get(1), 2, "chunk 1 needed one retry");
  });

  it("uses default retry constants when retryOptions not provided", async () => {
    assert.equal(CLONE_RETRY_MAX_ATTEMPTS, 5, "default max attempts is 5");
  });
});
