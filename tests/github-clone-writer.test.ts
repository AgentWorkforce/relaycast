import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import type { RelayFileClient } from "@relayfile/sdk";
import { RelayFileApiError } from "@relayfile/sdk";
import * as writerModule from "../packages/web/lib/integrations/github-clone-writer.ts";

const writer = writerModule.default ?? writerModule;
const {
  GITHUB_CLONE_BULK_WRITE_MAX_ATTEMPTS,
  GITHUB_CLONE_MAX_BULK_WRITE_BODY_BYTES,
  GITHUB_CLONE_CHUNK_SIZE,
  GITHUB_CLONE_MAX_CONCURRENT,
  chunkedBulkWrite,
} = writer;

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

function bulkWriteBodyBytes(files: BulkWriteParams["files"]): number {
  return Buffer.byteLength(JSON.stringify({ files }), "utf-8");
}

function toClient(client: FakeRelayFileClient): RelayFileClient {
  return client as unknown as RelayFileClient;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function workspaceBusyError(
  retryAfter: string | null,
  options: { code?: string; retryAfterSeconds?: number } = {},
): RelayFileApiError {
  const error = new RelayFileApiError(429, {
    code: options.code ?? "workspace_busy",
    message: "Workspace is applying another bulk write.",
    retryAfterSeconds: options.retryAfterSeconds,
  } as any);
  if (retryAfter !== null) {
    Object.assign(error, {
      code: options.code ?? "workspace_busy",
      status: 429,
      response: {
        headers: {
          "Retry-After": retryAfter,
        },
      },
    });
  }
  return error;
}

describe("github clone writer", () => {
  it("chunks files into serialized calls using the throttled clone chunk size", async () => {
    const client = new FakeRelayFileClient(async (params) => ({
      written: params.files.length,
      errors: [],
    }));

    const result = await chunkedBulkWrite({
      client: toClient(client),
      workspaceId: "workspace-1",
      files: createFiles(60),
    });

    assert.equal(GITHUB_CLONE_CHUNK_SIZE, 25);
    assert.deepEqual(
      client.calls.map((call) => call.files.length),
      [25, 25, 10],
    );
    assert.equal(result.written, 60);
    assert.deepEqual(result.errors, []);
  });

  it("splits chunks before the Relayfile bulk-write JSON body limit", async () => {
    const client = new FakeRelayFileClient(async (params) => ({
      written: params.files.length,
      errors: [],
    }));
    const files = createFiles(10).map((file) => ({
      ...file,
      content: "x".repeat(1024 * 1024),
    }));

    const result = await chunkedBulkWrite({
      client: toClient(client),
      workspaceId: "workspace-body-limit",
      files,
      chunkSize: 200,
      maxConcurrent: 1,
    });

    assert.equal(GITHUB_CLONE_MAX_BULK_WRITE_BODY_BYTES, 8 * 1024 * 1024);
    assert.ok(client.calls.length > 1, "expected byte-bounded chunks");
    assert.ok(
      client.calls.every(
        (call) =>
          bulkWriteBodyBytes(call.files) <= GITHUB_CLONE_MAX_BULK_WRITE_BODY_BYTES,
      ),
      "every bulkWrite request body stays below the byte cap",
    );
    assert.equal(result.written, files.length);
    assert.deepEqual(result.errors, []);
  });

  it("peak concurrent bulkWrite calls never exceeds GITHUB_CLONE_MAX_CONCURRENT", async () => {
    const firstWaveReady = createDeferred<void>();
    const releaseFirstWave = createDeferred<void>();
    let activeCalls = 0;
    let peakConcurrency = 0;

    const client = new FakeRelayFileClient(async (params, callIndex) => {
      activeCalls += 1;
      peakConcurrency = Math.max(peakConcurrency, activeCalls);

      try {
        if (callIndex === GITHUB_CLONE_MAX_CONCURRENT - 1) {
          firstWaveReady.resolve();
        }

        if (callIndex < GITHUB_CLONE_MAX_CONCURRENT) {
          await releaseFirstWave.promise;
        } else {
          await delay(5);
        }

        return {
          written: params.files.length,
          errors: [],
        };
      } finally {
        activeCalls -= 1;
      }
    });

    const writePromise = chunkedBulkWrite({
      client: toClient(client),
      workspaceId: "workspace-2",
      files: createFiles(10),
      chunkSize: 1,
    });

    await firstWaveReady.promise;
    assert.equal(peakConcurrency, GITHUB_CLONE_MAX_CONCURRENT);
    releaseFirstWave.resolve();

    await writePromise;
    assert.ok(peakConcurrency <= GITHUB_CLONE_MAX_CONCURRENT);
  });

  it("returns accumulated errors without throwing", async () => {
    const client = new FakeRelayFileClient(async (params, callIndex) => {
      if (callIndex === 1) {
        throw new RelayFileApiError(503, {
          code: "relay_unavailable",
          message: "Relayfile unavailable",
        });
      }

      if (callIndex === 2) {
        return {
          written: 1,
          errors: [
            {
              path: params.files[1]!.path,
              code: "conflict",
              message: "Revision conflict",
            },
          ],
        };
      }

      return {
        written: params.files.length,
        errors: [],
      };
    });

    const result = await chunkedBulkWrite({
      client: toClient(client),
      workspaceId: "workspace-3",
      files: createFiles(6),
      chunkSize: 2,
      maxConcurrent: 1,
    });

    assert.equal(result.written, 3);
    assert.deepEqual(result.errors, [
      {
        path: createFiles(6)[2]!.path,
        code: "relay_unavailable",
        message: "Relayfile unavailable",
      },
      {
        path: createFiles(6)[3]!.path,
        code: "relay_unavailable",
        message: "Relayfile unavailable",
      },
      {
        path: createFiles(6)[5]!.path,
        code: "conflict",
        message: "Revision conflict",
      },
    ]);
  });

  it("retries a 429 workspace_busy chunk using seconds-form Retry-After", async () => {
    const client = new FakeRelayFileClient(async (params, callIndex) => {
      if (callIndex === 0) {
        throw workspaceBusyError("0");
      }
      return {
        written: params.files.length,
        errors: [],
      };
    });

    const result = await chunkedBulkWrite({
      client: toClient(client),
      workspaceId: "workspace-busy",
      files: createFiles(2),
      chunkSize: 2,
      maxConcurrent: 1,
    });

    assert.equal(client.calls.length, 2);
    assert.equal(result.written, 2);
    assert.deepEqual(result.errors, []);
  });

  it("retries a 429 durable_object_overloaded chunk", async () => {
    const client = new FakeRelayFileClient(async (params, callIndex) => {
      if (callIndex === 0) {
        throw workspaceBusyError("0", { code: "durable_object_overloaded" });
      }
      return {
        written: params.files.length,
        errors: [],
      };
    });

    const result = await chunkedBulkWrite({
      client: toClient(client),
      workspaceId: "workspace-overloaded",
      files: createFiles(2),
      chunkSize: 2,
      maxConcurrent: 1,
    });

    assert.equal(client.calls.length, 2);
    assert.equal(result.written, 2);
    assert.deepEqual(result.errors, []);
  });

  it("retries a 429 workspace_busy chunk using body retryAfterSeconds", async () => {
    const client = new FakeRelayFileClient(async (params, callIndex) => {
      if (callIndex === 0) {
        throw workspaceBusyError(null, { retryAfterSeconds: 0 });
      }
      return {
        written: params.files.length,
        errors: [],
      };
    });

    const result = await chunkedBulkWrite({
      client: toClient(client),
      workspaceId: "workspace-busy-body-retry-after",
      files: createFiles(2),
      chunkSize: 2,
      maxConcurrent: 1,
    });

    assert.equal(client.calls.length, 2);
    assert.equal(result.written, 2);
    assert.deepEqual(result.errors, []);
  });

  it("does not retry 429 chunks with unsupported codes", async () => {
    const client = new FakeRelayFileClient(async () => {
      throw workspaceBusyError("0", { code: "rate_limited" });
    });

    const result = await chunkedBulkWrite({
      client: toClient(client),
      workspaceId: "workspace-unsupported-429",
      files: createFiles(2),
      chunkSize: 2,
      maxConcurrent: 1,
    });

    assert.equal(client.calls.length, 1);
    assert.equal(result.written, 0);
    assert.deepEqual(
      result.errors.map((error) => error.code),
      ["rate_limited", "rate_limited"],
    );
  });

  it("retries a 429 workspace_busy chunk using date-form Retry-After", async () => {
    const retryAfterDate = new Date(Date.now() - 1000).toUTCString();
    const client = new FakeRelayFileClient(async (params, callIndex) => {
      if (callIndex === 0) {
        throw workspaceBusyError(retryAfterDate);
      }
      return {
        written: params.files.length,
        errors: [],
      };
    });

    const result = await chunkedBulkWrite({
      client: toClient(client),
      workspaceId: "workspace-busy-date",
      files: createFiles(2),
      chunkSize: 2,
      maxConcurrent: 1,
    });

    assert.equal(client.calls.length, 2);
    assert.equal(result.written, 2);
    assert.deepEqual(result.errors, []);
  });

  it("stops retrying 429 workspace_busy chunks after the bounded attempt budget", async () => {
    const client = new FakeRelayFileClient(async () => {
      throw workspaceBusyError("0");
    });

    const result = await chunkedBulkWrite({
      client: toClient(client),
      workspaceId: "workspace-busy-exhausted",
      files: createFiles(2),
      chunkSize: 2,
      maxConcurrent: 1,
    });

    assert.equal(client.calls.length, GITHUB_CLONE_BULK_WRITE_MAX_ATTEMPTS);
    assert.equal(result.written, 0);
    assert.deepEqual(
      result.errors.map((error) => error.code),
      ["workspace_busy", "workspace_busy"],
    );
    assert.match(result.errors[0]!.message, /retry exhausted after 6 attempts/);
  });

  it("propagates aborted signal — subsequent chunks are not started", async () => {
    const controller = new AbortController();
    const firstCallStarted = createDeferred<void>();
    const client = new FakeRelayFileClient(
      async ({ signal }) => await new Promise<BulkWriteResult>((resolve, reject) => {
        firstCallStarted.resolve();

        const onAbort = () => {
          reject(signal?.reason ?? new Error("aborted"));
        };

        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    );

    const writePromise = chunkedBulkWrite({
      client: toClient(client),
      workspaceId: "workspace-4",
      files: createFiles(3),
      chunkSize: 1,
      maxConcurrent: 1,
      signal: controller.signal,
    });

    await firstCallStarted.promise;
    controller.abort(new Error("aborted by test"));

    await assert.rejects(writePromise, /aborted by test/);
    assert.equal(client.calls.length, 1);
  });

  it("returns written count as sum of successful chunk written counts", async () => {
    const writesPerChunk = [2, 1, 3];
    const client = new FakeRelayFileClient(async (_params, callIndex) => ({
      written: writesPerChunk[callIndex] ?? 0,
      errors: [],
    }));

    const result = await chunkedBulkWrite({
      client: toClient(client),
      workspaceId: "workspace-5",
      files: createFiles(6),
      chunkSize: 2,
      maxConcurrent: 1,
    });

    assert.equal(result.written, 6);
    assert.deepEqual(result.errors, []);
  });

  it("threads clone jobId through chunk correlation IDs", async () => {
    const client = new FakeRelayFileClient(async (params) => ({
      written: params.files.length,
      errors: [],
    }));

    await chunkedBulkWrite({
      client: toClient(client),
      workspaceId: "workspace-job",
      jobId: "clone_job_123",
      files: createFiles(3),
      chunkSize: 2,
      maxConcurrent: 1,
    });

    assert.deepEqual(
      client.calls.map((call) => call.correlationId),
      [
        "github-clone-job:clone_job_123:chunk:0",
        "github-clone-job:clone_job_123:chunk:1",
      ],
    );
  });
});
