import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/env.js";
import {
  admitGithubTarImportSnapshotCacheHit,
  handleGithubTarImportQueue,
  importGithubTarball,
  importGithubTarballChunk,
  startGithubTarImportFetch,
} from "../src/routes/import.js";
import { verifyInternalHmac } from "../src/middleware/auth.js";

type PutCall = {
  key: string;
  body: Uint8Array;
  options?: R2PutOptions;
};

function tarGz(
  entries: Array<{ path: string; content: string | Uint8Array }>,
): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const body =
      typeof entry.content === "string"
        ? new TextEncoder().encode(entry.content)
        : entry.content;
    const header = new Uint8Array(512);
    writeString(header, 0, 100, entry.path);
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, body.byteLength);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    writeString(header, 156, 1, "0");
    writeString(header, 257, 6, "ustar");
    writeString(header, 263, 2, "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeOctal(header, 148, 8, checksum);
    blocks.push(header, body);
    const padding = (512 - (body.byteLength % 512)) % 512;
    if (padding > 0) {
      blocks.push(new Uint8Array(padding));
    }
  }
  blocks.push(new Uint8Array(1024));
  return gzipSync(Buffer.concat(blocks.map((block) => Buffer.from(block))));
}

function writeString(
  header: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void {
  header.set(new TextEncoder().encode(value).subarray(0, length), offset);
}

function writeOctal(
  header: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  const encoded = new TextEncoder().encode(
    value
      .toString(8)
      .padStart(length - 1, "0")
      .slice(0, length - 1),
  );
  header.set(encoded, offset);
  header[offset + length - 1] = 0;
}

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function bytesFromR2PutBody(
  body: string | ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>,
): Promise<Uint8Array<ArrayBufferLike>> {
  if (body instanceof ReadableStream) {
    return new Uint8Array(await new Response(body).arrayBuffer());
  }
  if (typeof body === "string") {
    return new TextEncoder().encode(body);
  }
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  return new Uint8Array(body);
}

function createMemoryR2Bucket(initial: Record<string, Uint8Array> = {}): {
  bucket: Pick<R2Bucket, "get" | "put" | "head" | "list" | "delete">;
  objects: Map<string, Uint8Array>;
  putKeys: string[];
  headKeys: string[];
  deletedKeys: string[];
} {
  const objects = new Map<string, Uint8Array>(Object.entries(initial));
  const putKeys: string[] = [];
  const headKeys: string[] = [];
  const deletedKeys: string[] = [];
  return {
    objects,
    putKeys,
    headKeys,
    deletedKeys,
    bucket: {
      get: vi.fn(async (key: string) => {
        const bytes = objects.get(key);
        if (!bytes) {
          return null;
        }
        return {
          body: stream(bytes),
          text: async () => new TextDecoder().decode(bytes),
        } as unknown as R2ObjectBody;
      }),
      put: vi.fn(async (key: string, body: Parameters<R2Bucket["put"]>[1]) => {
        putKeys.push(key);
        objects.set(
          key,
          await bytesFromR2PutBody(
            body as
              | string
              | ArrayBuffer
              | ArrayBufferView
              | ReadableStream<Uint8Array>,
          ),
        );
        return null as unknown as R2Object;
      }) as unknown as R2Bucket["put"],
      head: vi.fn(async (key: string) => {
        headKeys.push(key);
        return objects.has(key) ? ({ key } as unknown as R2Object) : null;
      }),
      list: vi.fn(async (options?: R2ListOptions) => {
        const prefix = options?.prefix ?? "";
        const keys = Array.from(objects.keys())
          .filter((key) => key.startsWith(prefix))
          .sort();
        return {
          objects: keys.map((key) => ({ key })),
          truncated: false,
        } as unknown as R2Objects;
      }),
      delete: vi.fn(async (key: string) => {
        deletedKeys.push(key);
        objects.delete(key);
      }),
    },
  };
}

describe("GitHub tarball import", () => {
  it("stores a multi-file repo in R2 and returns one metadata registration payload", async () => {
    const putCalls: PutCall[] = [];
    const archive = tarGz([
      { path: "octo-demo-abc123/README.md", content: "# Demo\n" },
      {
        path: "octo-demo-abc123/src/app.ts",
        content: "export const ok = true;\n",
      },
      {
        path: "octo-demo-abc123/src/logo.png",
        content: new Uint8Array([0, 1, 2, 3]),
      },
      { path: "octo-demo-abc123/node_modules/skip.js", content: "ignored\n" },
    ]);

    const result = await importGithubTarball(
      {
        env: {
          CONTENT_BUCKET: {
            put: vi.fn(
              async (key: string, body: Uint8Array, options?: R2PutOptions) => {
                putCalls.push({ key, body, options });
                return null;
              },
            ),
          },
        } as unknown as AppEnv["Bindings"],
      },
      {
        workspaceId: "ws-test",
        owner: "octo",
        repo: "demo",
        headSha: "abc123",
        archive: stream(archive),
      },
    );

    expect(result.files).toHaveLength(3);
    expect(putCalls).toHaveLength(3);
    expect(result.skipped).toContainEqual({
      path: "node_modules/skip.js",
      reason: "ignored",
    });
    expect(result.files.map((file) => file.path).sort()).toEqual([
      "/github/repos/octo/demo/contents/README.md@abc123.json",
      "/github/repos/octo/demo/contents/src/app.ts@abc123.json",
      "/github/repos/octo/demo/contents/src/logo.png@abc123.json",
    ]);
    expect(
      result.files.find((file) => file.path.endsWith("logo.png@abc123.json"))
        ?.encoding,
    ).toBe("base64");
    expect(new Set(result.files.map((file) => file.contentRef)).size).toBe(3);
  });

  it("imports bounded chunks and resumes by regular tar entry index", async () => {
    const putCalls: PutCall[] = [];
    const archive = tarGz([
      { path: "octo-demo-abc123/a.txt", content: "a" },
      { path: "octo-demo-abc123/b.txt", content: "b" },
      { path: "octo-demo-abc123/c.txt", content: "c" },
    ]);
    const env = {
      CONTENT_BUCKET: {
        put: vi.fn(
          async (key: string, body: Uint8Array, options?: R2PutOptions) => {
            putCalls.push({ key, body, options });
            return null;
          },
        ),
      },
    } as unknown as AppEnv["Bindings"];

    const first = await importGithubTarballChunk(
      { env },
      {
        workspaceId: "ws-test",
        owner: "octo",
        repo: "demo",
        headSha: "abc123",
        archive: stream(archive),
        startEntryIndex: 0,
        maxEntries: 2,
      },
    );
    expect(first.done).toBe(false);
    expect(first.nextEntryIndex).toBe(2);
    expect(first.files.map((file) => file.path)).toEqual([
      "/github/repos/octo/demo/contents/a.txt@abc123.json",
      "/github/repos/octo/demo/contents/b.txt@abc123.json",
    ]);

    const second = await importGithubTarballChunk(
      { env },
      {
        workspaceId: "ws-test",
        owner: "octo",
        repo: "demo",
        headSha: "abc123",
        archive: stream(archive),
        startEntryIndex: first.nextEntryIndex,
        maxEntries: 2,
      },
    );
    expect(second.done).toBe(true);
    expect(second.nextEntryIndex).toBe(3);
    expect(second.files.map((file) => file.path)).toEqual([
      "/github/repos/octo/demo/contents/c.txt@abc123.json",
    ]);
    expect(putCalls).toHaveLength(3);
  });

  it("short-circuits fetch import admission when a complete base snapshot already exists", async () => {
    const { db, jobs, snapshots } = createGithubImportD1();
    const manifestRef =
      "workspaces/ws-test/bases/github/repos/octo/demo/abc123/manifest.v1.ndjson";
    snapshots.set("ws-test:octo:demo:abc123", {
      workspace_id: "ws-test",
      owner: "octo",
      repo: "demo",
      head_sha: "abc123",
      content_root: "/github/repos/octo/demo/contents",
      manifest_ref: manifestRef,
      file_count: 3,
      bytes: 42,
      current: 1,
      created_at: "2026-05-27T00:00:00.000Z",
      updated_at: "2026-05-27T00:00:00.000Z",
    });
    const r2 = createMemoryR2Bucket({
      [manifestRef]: new TextEncoder().encode("{}\n"),
    });
    const env = {
      DB: db,
      CONTENT_BUCKET: r2.bucket,
      RELAYFILE_GITHUB_BASE_SNAPSHOT_WORKSPACES: "ws-test",
    } as unknown as AppEnv["Bindings"];

    const summary = await admitGithubTarImportSnapshotCacheHit(env, {
      jobId: "job-cache-hit",
      workspaceId: "ws-test",
      owner: "octo",
      repo: "demo",
      ref: "HEAD",
      headSha: "abc123",
      tarballUrl: "https://api.github.com/repos/octo/demo/tarball/HEAD",
    });

    expect(summary).toMatchObject({
      jobId: "job-cache-hit",
      workspaceId: "ws-test",
      owner: "octo",
      repo: "demo",
      headSha: "abc123",
      status: "completed",
      imported: 3,
      errorCount: 0,
      bytesWritten: 42,
    });
    expect(summary?.completedAt).toBeTruthy();
    expect(r2.headKeys).toEqual([manifestRef]);
    expect(r2.putKeys).toEqual([]);
    expect(jobs.get("ws-test:job-cache-hit")).toMatchObject({
      status: "completed",
      next_entry_index: 3,
      imported: 3,
      bytes_written: 42,
    });
  });

  it("does not reuse a base snapshot when the manifest is missing", async () => {
    const { db, jobs, snapshots } = createGithubImportD1();
    const manifestRef =
      "workspaces/ws-test/bases/github/repos/octo/demo/abc123/manifest.v1.ndjson";
    snapshots.set("ws-test:octo:demo:abc123", {
      workspace_id: "ws-test",
      owner: "octo",
      repo: "demo",
      head_sha: "abc123",
      content_root: "/github/repos/octo/demo/contents",
      manifest_ref: manifestRef,
      file_count: 3,
      bytes: 42,
      current: 1,
      created_at: "2026-05-27T00:00:00.000Z",
      updated_at: "2026-05-27T00:00:00.000Z",
    });
    const r2 = createMemoryR2Bucket();
    const env = {
      DB: db,
      CONTENT_BUCKET: r2.bucket,
      RELAYFILE_GITHUB_BASE_SNAPSHOT_WORKSPACES: "ws-test",
    } as unknown as AppEnv["Bindings"];

    const summary = await admitGithubTarImportSnapshotCacheHit(env, {
      jobId: "job-cache-miss",
      workspaceId: "ws-test",
      owner: "octo",
      repo: "demo",
      ref: "HEAD",
      headSha: "abc123",
      tarballUrl: "https://api.github.com/repos/octo/demo/tarball/HEAD",
    });

    expect(summary).toBeNull();
    expect(r2.headKeys).toEqual([manifestRef]);
    expect(jobs.size).toBe(0);
  });

  it("returns an active same-head import instead of enqueueing a duplicate cache fill", async () => {
    const { db, jobs } = createGithubImportD1();
    jobs.set("ws-test:job-active", {
      job_id: "job-active",
      workspace_id: "ws-test",
      owner: "octo",
      repo: "demo",
      ref: "main",
      head_sha: "abc123",
      tarball_url: "https://api.github.com/repos/octo/demo/tarball/main",
      archive_ref: null,
      status: "fetching",
      next_entry_index: 0,
      imported: 0,
      error_count: 0,
      errors_json: "[]",
      skipped_json: "[]",
      bytes_written: 0,
      last_error: null,
      created_at: "2026-05-27T00:00:00.000Z",
      updated_at: "2026-05-27T00:00:00.000Z",
      completed_at: null,
    });
    const sentMessages: unknown[] = [];
    const env = {
      DB: db,
      CONTENT_BUCKET: createMemoryR2Bucket().bucket,
      RELAYFILE_GITHUB_BASE_SNAPSHOT_WORKSPACES: "ws-test",
      GITHUB_TAR_IMPORT_QUEUE: {
        send: vi.fn(async (message: unknown) => {
          sentMessages.push(message);
        }),
      },
    } as unknown as AppEnv["Bindings"];

    const started = await startGithubTarImportFetch(env, {
      jobId: "job-background",
      workspaceId: "ws-test",
      owner: "octo",
      repo: "demo",
      ref: "main",
      headSha: "abc123",
      tarballUrl: "https://api.github.com/repos/octo/demo/tarball/main",
      githubToken: "github-token",
      correlationId: "corr-background",
    });

    expect(started.enqueued).toBe(false);
    expect(started.statusCode).toBe(202);
    expect(started.summary).toMatchObject({
      jobId: "job-active",
      status: "fetching",
      workspaceId: "ws-test",
      owner: "octo",
      repo: "demo",
      headSha: "abc123",
    });
    expect(jobs.has("ws-test:job-background")).toBe(false);
    expect(sentMessages).toEqual([]);
  });

  it("starts a background fetch import without waiting for queue processing", async () => {
    const { db, jobs } = createGithubImportD1();
    const sentMessages: unknown[] = [];
    const env = {
      DB: db,
      CONTENT_BUCKET: createMemoryR2Bucket().bucket,
      RELAYFILE_GITHUB_BASE_SNAPSHOT_WORKSPACES: "ws-test",
      GITHUB_TAR_IMPORT_QUEUE: {
        send: vi.fn(async (message: unknown) => {
          sentMessages.push(message);
        }),
      },
    } as unknown as AppEnv["Bindings"];

    const started = await startGithubTarImportFetch(env, {
      jobId: "job-background",
      workspaceId: "ws-test",
      owner: "octo",
      repo: "demo",
      ref: "main",
      headSha: "abc123",
      tarballUrl: "https://api.github.com/repos/octo/demo/tarball/main",
      githubToken: "github-token",
      correlationId: "corr-background",
    });

    expect(started.enqueued).toBe(true);
    expect(started.statusCode).toBe(202);
    expect(started.summary).toMatchObject({
      jobId: "job-background",
      status: "queued",
      workspaceId: "ws-test",
      owner: "octo",
      repo: "demo",
      headSha: "abc123",
    });
    expect(jobs.get("ws-test:job-background")).toMatchObject({
      status: "queued",
      head_sha: "abc123",
    });
    expect(sentMessages).toEqual([
      {
        type: "fetch",
        jobId: "job-background",
        workspaceId: "ws-test",
        owner: "octo",
        repo: "demo",
        ref: "main",
        headSha: "abc123",
        tarballUrl: "https://api.github.com/repos/octo/demo/tarball/main",
        githubToken: "github-token",
        correlationId: "corr-background",
      },
    ]);
  });

  it("deduplicates concurrent same-head background fetch starts with different job ids", async () => {
    const activeLookupBarrier = createBarrier(2);
    const { db, jobs } = createGithubImportD1({
      beforeActiveSnapshotKeyLookup: activeLookupBarrier.wait,
    });
    const sentMessages: unknown[] = [];
    const env = {
      DB: db,
      CONTENT_BUCKET: createMemoryR2Bucket().bucket,
      RELAYFILE_GITHUB_BASE_SNAPSHOT_WORKSPACES: "ws-test",
      GITHUB_TAR_IMPORT_QUEUE: {
        send: vi.fn(async (message: unknown) => {
          sentMessages.push(message);
        }),
      },
    } as unknown as AppEnv["Bindings"];
    const baseInput = {
      workspaceId: "ws-test",
      owner: "octo",
      repo: "demo",
      ref: "main",
      headSha: "abc123",
      tarballUrl: "https://api.github.com/repos/octo/demo/tarball/main",
      githubToken: "github-token",
      correlationId: "corr-background",
    };

    const [first, second] = await Promise.all([
      startGithubTarImportFetch(env, {
        ...baseInput,
        jobId: "job-background-a",
      }),
      startGithubTarImportFetch(env, {
        ...baseInput,
        jobId: "job-background-b",
      }),
    ]);

    expect(sentMessages).toHaveLength(1);
    expect(jobs.size).toBe(1);
    const admittedJobId = first.summary.jobId;
    expect(second.summary.jobId).toBe(admittedJobId);
    expect(["job-background-a", "job-background-b"]).toContain(admittedJobId);
    expect([first.enqueued, second.enqueued].filter(Boolean)).toHaveLength(1);
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
  });

  it("processes durable import queue archives into an R2 base snapshot with only a DO sentinel registration", async () => {
    const archive = tarGz([
      { path: "octo-demo-abc123/a.txt", content: "a" },
      { path: "octo-demo-abc123/b.txt", content: "b" },
      { path: "octo-demo-abc123/c.txt", content: "c" },
    ]);
    const { db, jobs, snapshots } = createGithubImportD1();
    jobs.set("ws-test:job-1", {
      job_id: "job-1",
      workspace_id: "ws-test",
      owner: "octo",
      repo: "demo",
      ref: "HEAD",
      head_sha: "abc123",
      tarball_url: "https://api.github.com/repos/octo/demo/tarball/HEAD",
      archive_ref: "ws-test/imports/github-clone-archives/job-1.tar.gz",
      status: "importing",
      next_entry_index: 0,
      imported: 0,
      error_count: 0,
      errors_json: "[]",
      skipped_json: "[]",
      bytes_written: 0,
      last_error: null,
      created_at: "2026-05-27T00:00:00.000Z",
      updated_at: "2026-05-27T00:00:00.000Z",
      completed_at: null,
    });
    const sentMessages: unknown[] = [];
    const r2 = createMemoryR2Bucket({
      "ws-test/imports/github-clone-archives/job-1.tar.gz": archive,
    });
    const workspaceFetch = vi.fn(async (request: Request) => {
      expect(request.headers.get("X-Relayfile-Internal-Agent")).toBe(
        "github-clone-worker",
      );
      expect(request.headers.get("X-Relay-Timestamp")).toBeTruthy();
      expect(request.headers.get("X-Relay-Signature")).toMatch(
        /^[a-f0-9]{64}$/,
      );
      await expect(
        verifyInternalHmac(
          request.headers,
          await request.clone().arrayBuffer(),
          "test-internal-secret",
        ),
      ).resolves.toBeUndefined();
      const body = (await request.json()) as {
        files: Array<{ path: string; size: number; contentHash: string }>;
      };
      expect(body.files).toHaveLength(1);
      expect(body.files[0]).toMatchObject({
        path: "/github/repos/octo/demo/.relayfile/clone.json",
        size: JSON.stringify({ headSha: "abc123" }).length,
      });
      return Response.json(
        {
          written: body.files.length,
          errorCount: 0,
          errors: [],
          bytesWritten: body.files.reduce((sum, file) => sum + file.size, 0),
        },
        { status: 202 },
      );
    });
    const env = {
      DB: db,
      CONTENT_BUCKET: r2.bucket,
      GITHUB_TAR_IMPORT_QUEUE: {
        send: vi.fn(async (message: unknown) => {
          sentMessages.push(message);
        }),
      },
      WORKSPACE_DO: {
        idFromName(name: string) {
          return name as unknown as DurableObjectId;
        },
        get() {
          return { fetch: workspaceFetch } as unknown as DurableObjectStub;
        },
      },
      INTERNAL_HMAC_SECRET: "test-internal-secret",
      RELAYFILE_GITHUB_BASE_SNAPSHOT_WORKSPACES: "ws-test",
    } as unknown as AppEnv["Bindings"];
    const batch = createQueueBatch({
      type: "process",
      jobId: "job-1",
      workspaceId: "ws-test",
      correlationId: "corr-1",
    });

    await handleGithubTarImportQueue(batch as unknown as MessageBatch, env);

    const job = jobs.get("ws-test:job-1");
    expect(job?.status).toBe("completed");
    expect(job?.next_entry_index).toBe(3);
    expect(job?.imported).toBe(3);
    expect(workspaceFetch).toHaveBeenCalledOnce();
    expect(
      r2.putKeys.filter((key) =>
        key.startsWith("immutable/github/blobs/sha256/"),
      ),
    ).toHaveLength(4);
    expect(r2.putKeys).toContain(
      "workspaces/ws-test/bases/github/repos/octo/demo/abc123/manifest.v1.ndjson",
    );
    expect(snapshots.get("ws-test:octo:demo:abc123")).toMatchObject({
      manifest_ref:
        "workspaces/ws-test/bases/github/repos/octo/demo/abc123/manifest.v1.ndjson",
      file_count: 3,
      bytes: 3,
      current: 1,
    });
    expect(sentMessages).toEqual([]);
    expect(r2.deletedKeys).toEqual([
      "ws-test/imports/github-clone-archives/job-1.tar.gz",
      "ws-test/imports/github-base-snapshot-parts/job-1/000000000000.ndjson",
    ]);
    expect(batch.messages[0]?.ack).toHaveBeenCalledOnce();
    expect(batch.messages[0]?.retry).not.toHaveBeenCalled();
  });

  it("continues R2 base snapshot imports across bounded queue chunks", async () => {
    const archive = tarGz([
      { path: "octo-demo-abc123/a.txt", content: "a" },
      { path: "octo-demo-abc123/b.txt", content: "b" },
      { path: "octo-demo-abc123/c.txt", content: "c" },
    ]);
    const { db, jobs, snapshots } = createGithubImportD1();
    jobs.set("ws-test:job-chunked", {
      job_id: "job-chunked",
      workspace_id: "ws-test",
      owner: "octo",
      repo: "demo",
      ref: "HEAD",
      head_sha: "abc123",
      tarball_url: "https://api.github.com/repos/octo/demo/tarball/HEAD",
      archive_ref: "ws-test/imports/github-clone-archives/job-chunked.tar.gz",
      status: "importing",
      next_entry_index: 0,
      imported: 0,
      error_count: 0,
      errors_json: "[]",
      skipped_json: "[]",
      bytes_written: 0,
      last_error: null,
      created_at: "2026-05-27T00:00:00.000Z",
      updated_at: "2026-05-27T00:00:00.000Z",
      completed_at: null,
    });
    const sentMessages: unknown[] = [];
    const r2 = createMemoryR2Bucket({
      "ws-test/imports/github-clone-archives/job-chunked.tar.gz": archive,
    });
    const workspaceFetch = vi.fn(async (request: Request) => {
      const body = (await request.json()) as {
        files: Array<{ path: string; size: number }>;
      };
      expect(body.files).toHaveLength(1);
      expect(body.files[0]?.path).toBe(
        "/github/repos/octo/demo/.relayfile/clone.json",
      );
      return Response.json(
        {
          written: 1,
          errorCount: 0,
          errors: [],
          bytesWritten: body.files[0]?.size ?? 0,
        },
        { status: 202 },
      );
    });
    const env = {
      DB: db,
      CONTENT_BUCKET: r2.bucket,
      GITHUB_TAR_IMPORT_QUEUE: {
        send: vi.fn(async (message: unknown) => {
          sentMessages.push(message);
        }),
      },
      WORKSPACE_DO: {
        idFromName(name: string) {
          return name as unknown as DurableObjectId;
        },
        get() {
          return { fetch: workspaceFetch } as unknown as DurableObjectStub;
        },
      },
      INTERNAL_HMAC_SECRET: "test-internal-secret",
      RELAYFILE_GITHUB_BASE_SNAPSHOT_WORKSPACES: "ws-test",
      RELAYFILE_GITHUB_BASE_IMPORT_CHUNK_ENTRIES: "2",
    } as unknown as AppEnv["Bindings"];

    const firstBatch = createQueueBatch({
      type: "process",
      jobId: "job-chunked",
      workspaceId: "ws-test",
      correlationId: "corr-1",
    });
    await handleGithubTarImportQueue(
      firstBatch as unknown as MessageBatch,
      env,
    );

    const partialJob = jobs.get("ws-test:job-chunked");
    expect(partialJob).toMatchObject({
      status: "importing",
      next_entry_index: 2,
      imported: 2,
      bytes_written: 2,
      completed_at: null,
    });
    expect(snapshots.size).toBe(0);
    expect(workspaceFetch).not.toHaveBeenCalled();
    expect(
      r2.objects.has(
        "ws-test/imports/github-clone-archives/job-chunked.tar.gz",
      ),
    ).toBe(true);
    expect(
      r2.objects.has(
        "ws-test/imports/github-base-snapshot-parts/job-chunked/000000000000.ndjson",
      ),
    ).toBe(true);
    expect(
      r2.objects.has(
        "workspaces/ws-test/bases/github/repos/octo/demo/abc123/manifest.v1.ndjson",
      ),
    ).toBe(false);
    expect(sentMessages).toEqual([
      {
        type: "process",
        jobId: "job-chunked",
        workspaceId: "ws-test",
        startEntryIndex: 2,
        correlationId: "corr-1",
      },
    ]);
    expect(firstBatch.messages[0]?.ack).toHaveBeenCalledOnce();

    const staleBatch = createQueueBatch({
      type: "process",
      jobId: "job-chunked",
      workspaceId: "ws-test",
      startEntryIndex: 0,
      correlationId: "corr-1",
    });
    await handleGithubTarImportQueue(
      staleBatch as unknown as MessageBatch,
      env,
    );
    expect(sentMessages).toEqual([
      {
        type: "process",
        jobId: "job-chunked",
        workspaceId: "ws-test",
        startEntryIndex: 2,
        correlationId: "corr-1",
      },
      {
        type: "process",
        jobId: "job-chunked",
        workspaceId: "ws-test",
        startEntryIndex: 2,
        correlationId: "corr-1",
      },
    ]);
    expect(staleBatch.messages[0]?.ack).toHaveBeenCalledOnce();

    const continuation = sentMessages.pop();
    expect(continuation).toBeTruthy();
    const secondBatch = createQueueBatch(continuation);
    await handleGithubTarImportQueue(
      secondBatch as unknown as MessageBatch,
      env,
    );

    const completedJob = jobs.get("ws-test:job-chunked");
    expect(completedJob).toMatchObject({
      status: "completed",
      next_entry_index: 3,
      imported: 3,
      bytes_written: 3,
    });
    expect(workspaceFetch).toHaveBeenCalledOnce();
    expect(snapshots.get("ws-test:octo:demo:abc123")).toMatchObject({
      file_count: 3,
      bytes: 3,
      current: 1,
    });
    expect(
      r2.putKeys.filter((key) =>
        key.startsWith("immutable/github/blobs/sha256/"),
      ),
    ).toHaveLength(4);
    expect(r2.putKeys).toContain(
      "workspaces/ws-test/bases/github/repos/octo/demo/abc123/manifest.v1.ndjson",
    );
    expect(r2.deletedKeys).toEqual([
      "ws-test/imports/github-clone-archives/job-chunked.tar.gz",
      "ws-test/imports/github-base-snapshot-parts/job-chunked/000000000000.ndjson",
      "ws-test/imports/github-base-snapshot-parts/job-chunked/000000000002.ndjson",
    ]);
    expect(secondBatch.messages[0]?.ack).toHaveBeenCalledOnce();
    expect(secondBatch.messages[0]?.retry).not.toHaveBeenCalled();
  });

  it("completes large R2 base snapshot imports beyond one worker subrequest window", async () => {
    const fileCount = 1005;
    const archive = tarGz(
      Array.from({ length: fileCount }, (_, index) => ({
        path: `octo-demo-abc123/src/file-${String(index).padStart(4, "0")}.txt`,
        content: `content-${index}`,
      })),
    );
    const { db, jobs, snapshots } = createGithubImportD1();
    jobs.set("ws-test:job-large", {
      job_id: "job-large",
      workspace_id: "ws-test",
      owner: "octo",
      repo: "demo",
      ref: "HEAD",
      head_sha: "abc123",
      tarball_url: "https://api.github.com/repos/octo/demo/tarball/HEAD",
      archive_ref: "ws-test/imports/github-clone-archives/job-large.tar.gz",
      status: "importing",
      next_entry_index: 0,
      imported: 0,
      error_count: 0,
      errors_json: "[]",
      skipped_json: "[]",
      bytes_written: 0,
      last_error: null,
      created_at: "2026-05-27T00:00:00.000Z",
      updated_at: "2026-05-27T00:00:00.000Z",
      completed_at: null,
    });
    const sentMessages: unknown[] = [];
    const r2 = createMemoryR2Bucket({
      "ws-test/imports/github-clone-archives/job-large.tar.gz": archive,
    });
    const blobPutDelay = () =>
      new Promise<void>((resolve) => setTimeout(resolve, 1));
    const basePut = r2.bucket.put.bind(r2.bucket);
    let activeBlobPuts = 0;
    let maxActiveBlobPuts = 0;
    r2.bucket.put = vi.fn(
      async (
        key: string,
        body: Parameters<R2Bucket["put"]>[1],
        options?: R2PutOptions,
      ) => {
        if (key.startsWith("immutable/github/blobs/sha256/")) {
          activeBlobPuts += 1;
          maxActiveBlobPuts = Math.max(maxActiveBlobPuts, activeBlobPuts);
          await blobPutDelay();
          try {
            return await basePut(key, body, options);
          } finally {
            activeBlobPuts -= 1;
          }
        }
        return basePut(key, body, options);
      },
    ) as unknown as R2Bucket["put"];
    const workspaceFetch = vi.fn(async (request: Request) => {
      const body = (await request.json()) as {
        files: Array<{ path: string; size: number }>;
      };
      expect(body.files).toHaveLength(1);
      return Response.json(
        {
          written: 1,
          errorCount: 0,
          errors: [],
          bytesWritten: body.files[0]?.size ?? 0,
        },
        { status: 202 },
      );
    });
    const env = {
      DB: db,
      CONTENT_BUCKET: r2.bucket,
      GITHUB_TAR_IMPORT_QUEUE: {
        send: vi.fn(async (message: unknown) => {
          sentMessages.push(message);
        }),
      },
      WORKSPACE_DO: {
        idFromName(name: string) {
          return name as unknown as DurableObjectId;
        },
        get() {
          return { fetch: workspaceFetch } as unknown as DurableObjectStub;
        },
      },
      INTERNAL_HMAC_SECRET: "test-internal-secret",
      RELAYFILE_GITHUB_BASE_SNAPSHOT_WORKSPACES: "ws-test",
      RELAYFILE_GITHUB_BASE_IMPORT_CHUNK_ENTRIES: "500",
      RELAYFILE_GITHUB_BASE_IMPORT_BLOB_PUT_CONCURRENCY: "8",
    } as unknown as AppEnv["Bindings"];

    let nextMessage: unknown = {
      type: "process",
      jobId: "job-large",
      workspaceId: "ws-test",
      correlationId: "corr-large",
    };
    let processedMessages = 0;
    while (nextMessage) {
      processedMessages += 1;
      const batch = createQueueBatch(nextMessage);
      await handleGithubTarImportQueue(batch as unknown as MessageBatch, env);
      expect(batch.messages[0]?.ack).toHaveBeenCalledOnce();
      nextMessage = sentMessages.shift();
    }

    expect(processedMessages).toBe(3);
    expect(jobs.get("ws-test:job-large")).toMatchObject({
      status: "completed",
      next_entry_index: fileCount,
      imported: fileCount,
    });
    expect(workspaceFetch).toHaveBeenCalledOnce();
    expect(snapshots.get("ws-test:octo:demo:abc123")).toMatchObject({
      file_count: fileCount,
      current: 1,
    });
    expect(
      r2.putKeys.filter((key) =>
        key.startsWith("immutable/github/blobs/sha256/"),
      ),
    ).toHaveLength(fileCount + 1);
    expect(r2.putKeys).toContain(
      "ws-test/imports/github-base-snapshot-parts/job-large/000000000000.ndjson",
    );
    expect(r2.putKeys).toContain(
      "ws-test/imports/github-base-snapshot-parts/job-large/000000000500.ndjson",
    );
    expect(r2.putKeys).toContain(
      "ws-test/imports/github-base-snapshot-parts/job-large/000000001000.ndjson",
    );
    expect(r2.putKeys).toContain(
      "workspaces/ws-test/bases/github/repos/octo/demo/abc123/manifest.v1.ndjson",
    );
    expect(maxActiveBlobPuts).toBeGreaterThan(1);
    expect(maxActiveBlobPuts).toBeLessThanOrEqual(8);
    expect(r2.deletedKeys).toContain(
      "ws-test/imports/github-clone-archives/job-large.tar.gz",
    );
  });

  it("records and cleans persistent base snapshot chunk failures at queue max attempts", async () => {
    const archive = tarGz([
      { path: "octo-demo-abc123/a.txt", content: "a" },
      { path: "octo-demo-abc123/b.txt", content: "b" },
    ]);
    const { db, jobs } = createGithubImportD1();
    jobs.set("ws-test:job-fail", {
      job_id: "job-fail",
      workspace_id: "ws-test",
      owner: "octo",
      repo: "demo",
      ref: "HEAD",
      head_sha: "abc123",
      tarball_url: "https://api.github.com/repos/octo/demo/tarball/HEAD",
      archive_ref: "ws-test/imports/github-clone-archives/job-fail.tar.gz",
      status: "importing",
      next_entry_index: 0,
      imported: 0,
      error_count: 0,
      errors_json: "[]",
      skipped_json: "[]",
      bytes_written: 0,
      last_error: null,
      created_at: "2026-05-27T00:00:00.000Z",
      updated_at: "2026-05-27T00:00:00.000Z",
      completed_at: null,
    });
    const r2 = createMemoryR2Bucket({
      "ws-test/imports/github-clone-archives/job-fail.tar.gz": archive,
      "ws-test/imports/github-base-snapshot-parts/job-fail/000000000000.ndjson":
        new TextEncoder().encode("{}\n"),
    });
    const basePut = r2.bucket.put;
    r2.bucket.put = vi.fn(
      async (key: string, body: Parameters<R2Bucket["put"]>[1]) => {
        if (key.startsWith("immutable/github/blobs/sha256/")) {
          throw new Error("simulated R2 blob write failure");
        }
        return basePut(key, body);
      },
    ) as unknown as R2Bucket["put"];
    const env = {
      DB: db,
      CONTENT_BUCKET: r2.bucket,
      GITHUB_TAR_IMPORT_QUEUE: {
        send: vi.fn(async () => {}),
      },
      WORKSPACE_DO: {
        idFromName(name: string) {
          return name as unknown as DurableObjectId;
        },
        get() {
          return { fetch: vi.fn() } as unknown as DurableObjectStub;
        },
      },
      INTERNAL_HMAC_SECRET: "test-internal-secret",
      RELAYFILE_GITHUB_BASE_SNAPSHOT_WORKSPACES: "ws-test",
    } as unknown as AppEnv["Bindings"];

    const firstAttempt = createQueueBatch(
      {
        type: "process",
        jobId: "job-fail",
        workspaceId: "ws-test",
        correlationId: "corr-fail",
      },
      { attempts: 1 },
    );
    await handleGithubTarImportQueue(
      firstAttempt as unknown as MessageBatch,
      env,
    );
    expect(firstAttempt.messages[0]?.retry).toHaveBeenCalledOnce();
    expect(firstAttempt.messages[0]?.ack).not.toHaveBeenCalled();
    expect(jobs.get("ws-test:job-fail")).toMatchObject({
      status: "importing",
      last_error: "simulated R2 blob write failure",
      completed_at: null,
    });
    expect(
      r2.objects.has("ws-test/imports/github-clone-archives/job-fail.tar.gz"),
    ).toBe(true);
    expect(
      r2.objects.has(
        "ws-test/imports/github-base-snapshot-parts/job-fail/000000000000.ndjson",
      ),
    ).toBe(true);

    const finalAttempt = createQueueBatch(
      {
        type: "process",
        jobId: "job-fail",
        workspaceId: "ws-test",
        correlationId: "corr-fail",
      },
      { attempts: 3 },
    );
    await handleGithubTarImportQueue(
      finalAttempt as unknown as MessageBatch,
      env,
    );

    expect(finalAttempt.messages[0]?.ack).toHaveBeenCalledOnce();
    expect(finalAttempt.messages[0]?.retry).not.toHaveBeenCalled();
    expect(jobs.get("ws-test:job-fail")).toMatchObject({
      status: "failed",
      last_error: "simulated R2 blob write failure",
    });
    expect(jobs.get("ws-test:job-fail")?.completed_at).toBeTruthy();
    expect(
      r2.objects.has("ws-test/imports/github-clone-archives/job-fail.tar.gz"),
    ).toBe(false);
    expect(
      r2.objects.has(
        "ws-test/imports/github-base-snapshot-parts/job-fail/000000000000.ndjson",
      ),
    ).toBe(false);
  });

  it("keeps durable import queue processing on WorkspaceDO registration when base snapshots are not enabled", async () => {
    const archive = tarGz([
      { path: "octo-demo-abc123/a.txt", content: "a" },
      { path: "octo-demo-abc123/b.txt", content: "b" },
    ]);
    const { db, jobs, snapshots } = createGithubImportD1();
    jobs.set("ws-test:job-legacy", {
      job_id: "job-legacy",
      workspace_id: "ws-test",
      owner: "octo",
      repo: "demo",
      ref: "HEAD",
      head_sha: "abc123",
      tarball_url: "https://api.github.com/repos/octo/demo/tarball/HEAD",
      archive_ref: "ws-test/imports/github-clone-archives/job-legacy.tar.gz",
      status: "importing",
      next_entry_index: 0,
      imported: 0,
      error_count: 0,
      errors_json: "[]",
      skipped_json: "[]",
      bytes_written: 0,
      last_error: null,
      created_at: "2026-05-27T00:00:00.000Z",
      updated_at: "2026-05-27T00:00:00.000Z",
      completed_at: null,
    });
    const putKeys: string[] = [];
    const workspaceFetch = vi.fn(async (request: Request) => {
      const body = (await request.json()) as {
        files: Array<{ path: string; size: number }>;
      };
      expect(body.files.map((file) => file.path)).toEqual([
        "/github/repos/octo/demo/contents/a.txt@abc123.json",
        "/github/repos/octo/demo/contents/b.txt@abc123.json",
      ]);
      return Response.json(
        {
          written: body.files.length,
          errorCount: 0,
          errors: [],
          bytesWritten: body.files.reduce((sum, file) => sum + file.size, 0),
        },
        { status: 202 },
      );
    });
    const env = {
      DB: db,
      CONTENT_BUCKET: {
        get: vi.fn(async () => ({ body: stream(archive) })),
        put: vi.fn(async (key: string) => {
          putKeys.push(key);
          return null;
        }),
        delete: vi.fn(async () => {}),
      },
      WORKSPACE_DO: {
        idFromName(name: string) {
          return name as unknown as DurableObjectId;
        },
        get() {
          return { fetch: workspaceFetch } as unknown as DurableObjectStub;
        },
      },
      INTERNAL_HMAC_SECRET: "test-internal-secret",
    } as unknown as AppEnv["Bindings"];
    const batch = createQueueBatch({
      type: "process",
      jobId: "job-legacy",
      workspaceId: "ws-test",
      correlationId: "corr-1",
    });

    await handleGithubTarImportQueue(batch as unknown as MessageBatch, env);

    const job = jobs.get("ws-test:job-legacy");
    expect(job?.status).toBe("completed");
    expect(job?.imported).toBe(2);
    expect(workspaceFetch).toHaveBeenCalledOnce();
    expect(snapshots.size).toBe(0);
    expect(
      putKeys.some((key) =>
        key.startsWith("workspaces/ws-test/bases/github/repos/"),
      ),
    ).toBe(false);
    expect(batch.messages[0]?.ack).toHaveBeenCalledOnce();
    expect(batch.messages[0]?.retry).not.toHaveBeenCalled();
  });

  it("fetches GitHub tarballs into R2 before queueing chunk processing", async () => {
    const { db, jobs } = createGithubImportD1();
    jobs.set("ws-test:job-fetch", {
      job_id: "job-fetch",
      workspace_id: "ws-test",
      owner: "octo",
      repo: "demo",
      ref: "HEAD",
      head_sha: "abc123",
      tarball_url: "https://api.github.com/repos/octo/demo/tarball/HEAD",
      archive_ref: null,
      status: "queued",
      next_entry_index: 0,
      imported: 0,
      error_count: 0,
      errors_json: "[]",
      skipped_json: "[]",
      bytes_written: 0,
      last_error: null,
      created_at: "2026-05-27T00:00:00.000Z",
      updated_at: "2026-05-27T00:00:00.000Z",
      completed_at: null,
    });
    const sentMessages: unknown[] = [];
    let r2PutKey = "";
    let r2PutBody: Uint8Array<ArrayBufferLike> = new Uint8Array();
    const originalFetch = globalThis.fetch;
    const fetchStub = vi.fn(
      async () => new Response("archive", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchStub);
    const env = {
      DB: db,
      CONTENT_BUCKET: {
        put: vi.fn(
          async (key: string, body: Parameters<R2Bucket["put"]>[1]) => {
            r2PutKey = key;
            r2PutBody = await bytesFromR2PutBody(
              body as
                | string
                | ArrayBuffer
                | ArrayBufferView
                | ReadableStream<Uint8Array>,
            );
            return null;
          },
        ),
      },
      GITHUB_TAR_IMPORT_QUEUE: {
        send: vi.fn(async (message: unknown) => {
          sentMessages.push(message);
        }),
      },
    } as unknown as AppEnv["Bindings"];
    const batch = createQueueBatch({
      type: "fetch",
      jobId: "job-fetch",
      workspaceId: "ws-test",
      owner: "octo",
      repo: "demo",
      ref: "HEAD",
      headSha: "abc123",
      tarballUrl: "https://api.github.com/repos/octo/demo/tarball/HEAD",
      githubToken: "github-token",
      correlationId: "corr-fetch",
    });

    try {
      await handleGithubTarImportQueue(batch as unknown as MessageBatch, env);
    } finally {
      globalThis.fetch = originalFetch;
      vi.unstubAllGlobals();
    }

    expect(fetchStub).toHaveBeenCalledWith(
      "https://api.github.com/repos/octo/demo/tarball/HEAD",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "token github-token",
        }),
      }),
    );
    const job = jobs.get("ws-test:job-fetch");
    expect(job?.status).toBe("importing");
    expect(job?.archive_ref).toBe(
      "ws-test/imports/github-clone-archives/job-fetch.tar.gz",
    );
    expect(r2PutKey).toBe(job?.archive_ref);
    expect(new TextDecoder().decode(r2PutBody)).toBe("archive");
    expect(sentMessages).toEqual([
      {
        type: "process",
        jobId: "job-fetch",
        workspaceId: "ws-test",
        correlationId: "corr-fetch",
      },
    ]);
    expect(batch.messages[0]?.ack).toHaveBeenCalledOnce();
    expect(batch.messages[0]?.retry).not.toHaveBeenCalled();
  });

  it("uses FixedLengthStream when GitHub provides archive Content-Length", async () => {
    const { db, jobs } = createGithubImportD1();
    jobs.set("ws-test:job-fetch-fixed", {
      job_id: "job-fetch-fixed",
      workspace_id: "ws-test",
      owner: "octo",
      repo: "demo",
      ref: "HEAD",
      head_sha: "abc123",
      tarball_url: "https://api.github.com/repos/octo/demo/tarball/HEAD",
      archive_ref: null,
      status: "queued",
      next_entry_index: 0,
      imported: 0,
      error_count: 0,
      errors_json: "[]",
      skipped_json: "[]",
      bytes_written: 0,
      last_error: null,
      created_at: "2026-05-27T00:00:00.000Z",
      updated_at: "2026-05-27T00:00:00.000Z",
      completed_at: null,
    });
    const fixedLengths: number[] = [];
    class TestFixedLengthStream {
      readonly readable: ReadableStream<Uint8Array>;
      readonly writable: WritableStream<Uint8Array>;

      constructor(length: number) {
        fixedLengths.push(length);
        const pair = new TransformStream<Uint8Array, Uint8Array>();
        this.readable = pair.readable;
        this.writable = pair.writable;
      }
    }
    const fetchStub = vi.fn(
      async () =>
        new Response("archive", {
          status: 200,
          headers: { "content-length": "7" },
        }),
    );
    const sentMessages: unknown[] = [];
    let r2PutBody: Uint8Array<ArrayBufferLike> = new Uint8Array();
    vi.stubGlobal("fetch", fetchStub);
    vi.stubGlobal("FixedLengthStream", TestFixedLengthStream);
    const env = {
      DB: db,
      CONTENT_BUCKET: {
        put: vi.fn(
          async (_key: string, body: Parameters<R2Bucket["put"]>[1]) => {
            r2PutBody = await bytesFromR2PutBody(
              body as
                | string
                | ArrayBuffer
                | ArrayBufferView
                | ReadableStream<Uint8Array>,
            );
            return null;
          },
        ),
      },
      GITHUB_TAR_IMPORT_QUEUE: {
        send: vi.fn(async (message: unknown) => {
          sentMessages.push(message);
        }),
      },
    } as unknown as AppEnv["Bindings"];
    const batch = createQueueBatch({
      type: "fetch",
      jobId: "job-fetch-fixed",
      workspaceId: "ws-test",
      owner: "octo",
      repo: "demo",
      ref: "HEAD",
      headSha: "abc123",
      tarballUrl: "https://api.github.com/repos/octo/demo/tarball/HEAD",
      githubToken: "github-token",
      correlationId: "corr-fetch",
    });

    try {
      await handleGithubTarImportQueue(batch as unknown as MessageBatch, env);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fixedLengths).toEqual([7]);
    expect(new TextDecoder().decode(r2PutBody)).toBe("archive");
    expect(sentMessages).toHaveLength(1);
    expect(batch.messages[0]?.ack).toHaveBeenCalledOnce();
    expect(batch.messages[0]?.retry).not.toHaveBeenCalled();
  });
});

type GithubImportJobRow = {
  job_id: string;
  workspace_id: string;
  owner: string;
  repo: string;
  ref: string;
  head_sha: string;
  tarball_url: string;
  archive_ref: string | null;
  status: "queued" | "fetching" | "importing" | "completed" | "failed";
  next_entry_index: number;
  imported: number;
  error_count: number;
  errors_json: string;
  skipped_json: string;
  bytes_written: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type GithubBaseSnapshotRow = {
  workspace_id: string;
  owner: string;
  repo: string;
  head_sha: string;
  content_root: string;
  manifest_ref: string;
  file_count: number;
  bytes: number;
  current: number;
  created_at: string;
  updated_at: string;
};

function createBarrier(parties: number): { wait: () => Promise<void> } {
  let waiting = 0;
  let release: (() => void) | null = null;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    async wait() {
      waiting += 1;
      if (waiting >= parties) {
        release?.();
      }
      await released;
    },
  };
}

function createGithubImportD1(
  options: { beforeActiveSnapshotKeyLookup?: () => Promise<void> } = {},
): {
  db: D1Database;
  jobs: Map<string, GithubImportJobRow>;
  snapshots: Map<string, GithubBaseSnapshotRow>;
} {
  const jobs = new Map<string, GithubImportJobRow>();
  const snapshots = new Map<string, GithubBaseSnapshotRow>();
  return {
    jobs,
    snapshots,
    db: {
      prepare(query: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T>() {
                if (query.includes("FROM github_tar_import_jobs")) {
                  if (query.includes("head_sha = ?")) {
                    await options.beforeActiveSnapshotKeyLookup?.();
                    const [workspaceId, owner, repo, headSha] = args;
                    return (Array.from(jobs.values())
                      .filter(
                        (job) =>
                          job.workspace_id === String(workspaceId) &&
                          job.owner === String(owner) &&
                          job.repo === String(repo) &&
                          job.head_sha === String(headSha) &&
                          (job.status === "queued" ||
                            job.status === "fetching" ||
                            job.status === "importing"),
                      )
                      .sort((left, right) =>
                        left.created_at.localeCompare(right.created_at),
                      )[0] ?? null) as T | null;
                  }
                  return (jobs.get(`${String(args[0])}:${String(args[1])}`) ??
                    null) as T | null;
                }
                if (query.includes("FROM github_base_snapshots")) {
                  return (snapshots.get(
                    `${String(args[0])}:${String(args[1])}:${String(args[2])}:${String(args[3])}`,
                  ) ?? null) as T | null;
                }
                return null;
              },
              async run() {
                if (query.includes("INSERT INTO github_base_snapshots")) {
                  const [
                    workspaceId,
                    owner,
                    repo,
                    headSha,
                    contentRoot,
                    manifestRef,
                    fileCount,
                    bytes,
                    createdAt,
                    updatedAt,
                  ] = args;
                  snapshots.set(
                    `${String(workspaceId)}:${String(owner)}:${String(repo)}:${String(headSha)}`,
                    {
                      workspace_id: String(workspaceId),
                      owner: String(owner),
                      repo: String(repo),
                      head_sha: String(headSha),
                      content_root: String(contentRoot),
                      manifest_ref: String(manifestRef),
                      file_count: Number(fileCount),
                      bytes: Number(bytes),
                      current: 1,
                      created_at: String(createdAt),
                      updated_at: String(updatedAt),
                    },
                  );
                } else if (query.includes("UPDATE github_base_snapshots")) {
                  const [updatedAt, workspaceId, owner, repo, headSha] = args;
                  for (const snapshot of snapshots.values()) {
                    if (
                      snapshot.workspace_id === String(workspaceId) &&
                      snapshot.owner === String(owner) &&
                      snapshot.repo === String(repo) &&
                      snapshot.head_sha !== String(headSha)
                    ) {
                      snapshot.current = 0;
                      snapshot.updated_at = String(updatedAt);
                    }
                  }
                } else if (
                  query.includes("INSERT OR IGNORE INTO github_tar_import_jobs")
                ) {
                  const [
                    jobId,
                    workspaceId,
                    owner,
                    repo,
                    ref,
                    headSha,
                    tarballUrl,
                    createdAt,
                    updatedAt,
                  ] = args.map(String);
                  const hasActive = Array.from(jobs.values()).some(
                    (job) =>
                      job.workspace_id === workspaceId &&
                      job.owner === owner &&
                      job.repo === repo &&
                      job.head_sha === headSha &&
                      (job.status === "queued" ||
                        job.status === "fetching" ||
                        job.status === "importing"),
                  );
                  if (jobs.has(`${workspaceId}:${jobId}`) || hasActive) {
                    return { success: true, meta: { changes: 0 } };
                  }
                  jobs.set(`${workspaceId}:${jobId}`, {
                    job_id: jobId,
                    workspace_id: workspaceId,
                    owner,
                    repo,
                    ref,
                    head_sha: headSha,
                    tarball_url: tarballUrl,
                    archive_ref: null,
                    status: "queued",
                    next_entry_index: 0,
                    imported: 0,
                    error_count: 0,
                    errors_json: "[]",
                    skipped_json: "[]",
                    bytes_written: 0,
                    last_error: null,
                    created_at: createdAt,
                    updated_at: updatedAt,
                    completed_at: null,
                  });
                  return { success: true, meta: { changes: 1 } };
                } else if (
                  query.includes("INSERT INTO github_tar_import_jobs")
                ) {
                  const [
                    jobId,
                    workspaceId,
                    owner,
                    repo,
                    ref,
                    headSha,
                    tarballUrl,
                    status,
                    createdAt,
                    updatedAt,
                  ] = args.map(String);
                  jobs.set(`${workspaceId}:${jobId}`, {
                    job_id: jobId,
                    workspace_id: workspaceId,
                    owner,
                    repo,
                    ref,
                    head_sha: headSha,
                    tarball_url: tarballUrl,
                    archive_ref: null,
                    status: status as GithubImportJobRow["status"],
                    next_entry_index: 0,
                    imported: 0,
                    error_count: 0,
                    errors_json: "[]",
                    skipped_json: "[]",
                    bytes_written: 0,
                    last_error: null,
                    created_at: createdAt,
                    updated_at: updatedAt,
                    completed_at: null,
                  });
                } else if (query.includes("archive_ref = ?")) {
                  const [archiveRef, updatedAt, workspaceId, jobId] = args;
                  const job = jobs.get(
                    `${String(workspaceId)}:${String(jobId)}`,
                  );
                  if (job) {
                    job.archive_ref = String(archiveRef);
                    job.status = "importing";
                    job.updated_at = String(updatedAt);
                  }
                } else if (query.includes("next_entry_index = ?")) {
                  const [
                    status,
                    nextEntryIndex,
                    imported,
                    errorCount,
                    errorsJson,
                    skippedJson,
                    bytesWritten,
                    lastError,
                    updatedAt,
                    finalStatus,
                    completedAt,
                    workspaceId,
                    jobId,
                  ] = args;
                  const job = jobs.get(
                    `${String(workspaceId)}:${String(jobId)}`,
                  );
                  if (job) {
                    job.status = String(status) as GithubImportJobRow["status"];
                    job.next_entry_index = Number(nextEntryIndex);
                    job.imported += Number(imported);
                    job.error_count += Number(errorCount);
                    job.errors_json = String(errorsJson);
                    job.skipped_json = String(skippedJson);
                    job.bytes_written += Number(bytesWritten);
                    job.last_error =
                      lastError === null || lastError === undefined
                        ? null
                        : String(lastError);
                    job.updated_at = String(updatedAt);
                    if (
                      finalStatus === "completed" ||
                      finalStatus === "failed"
                    ) {
                      job.completed_at = String(completedAt);
                    }
                  }
                } else if (query.includes("SET status = ?")) {
                  const [
                    status,
                    lastError,
                    updatedAt,
                    finalStatus,
                    completedAt,
                    workspaceId,
                    jobId,
                  ] = args;
                  const job = jobs.get(
                    `${String(workspaceId)}:${String(jobId)}`,
                  );
                  if (job) {
                    job.status = String(status) as GithubImportJobRow["status"];
                    job.last_error =
                      lastError === null || lastError === undefined
                        ? null
                        : String(lastError);
                    job.updated_at = String(updatedAt);
                    if (
                      finalStatus === "completed" ||
                      finalStatus === "failed"
                    ) {
                      job.completed_at = String(completedAt);
                    }
                  }
                } else if (query.includes("SET last_error = ?")) {
                  const [lastError, updatedAt, workspaceId, jobId] = args;
                  const job = jobs.get(
                    `${String(workspaceId)}:${String(jobId)}`,
                  );
                  if (job) {
                    job.last_error = String(lastError);
                    job.updated_at = String(updatedAt);
                  }
                }
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      },
      async batch(statements: Array<{ run: () => Promise<unknown> }>) {
        return Promise.all(statements.map((statement) => statement.run()));
      },
    } as unknown as D1Database,
  };
}

function createQueueBatch(body: unknown, options: { attempts?: number } = {}) {
  return {
    queue: "relayfile-github-import",
    messages: [
      {
        id: "msg-1",
        timestamp: new Date(),
        body,
        attempts: options.attempts ?? 1,
        ack: vi.fn(),
        retry: vi.fn(),
      },
    ],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
    metadata: {},
  };
}
