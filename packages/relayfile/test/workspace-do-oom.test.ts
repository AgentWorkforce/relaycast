import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { streamR2ObjectContent } from "../src/durable-objects/content-read.js";
import {
  InflightAdmissionController,
  inflightAdmissionHttpContract,
  isAdmissionControlPlaneRequest,
  resolveInflightAdmissionOptions,
} from "../src/durable-objects/request-admission.js";
import {
  exportWorkspaceResponse,
  handleBulkWrite,
  handleWriteFile,
  listEvents,
  type WorkspaceFsContext,
} from "../src/durable-objects/handlers/fs.js";
import {
  DIGEST_REFRESH_DUE_STORAGE_KEY,
  ensureNextAlarm,
  handleGetWritebackContext,
  handleGetWritebackContentStream,
  type OpsHandlerContext,
} from "../src/durable-objects/handlers/ops.js";
import { RUNTIME_FILES } from "../src/durable-objects/runtime-files.js";
import {
  iterateWorkspaceFilesForExport,
  countWorkspaceFiles,
  MAX_LIST_ROWS,
  EXPORT_FILE_PAGE_SIZE,
  type WorkspaceAdapterContext,
} from "../src/durable-objects/adapter.js";
import {
  decideWriteAdmission,
  resolveWriteAdmissionClass,
  resolveWriteAdmissionLeaseReason,
} from "../src/durable-objects/write-admission.js";
import { fetchWorkspaceDOWithBackpressure } from "../src/workspace-do-backpressure.js";
import type { TokenClaims } from "../src/middleware/auth.js";

const RUNTIME_PATHS = RUNTIME_FILES.map((file) => file.path);
import type { WorkspaceEvent, WorkspaceFile } from "../src/types.js";

/*
 * Regression tests for the WorkspaceDO OOM fix.
 *
 * Root cause recap (one DO instance per workspace, ~128MB cap):
 *   - buildCoreExportContext loaded every file body into a Map up-front.
 *   - listFiles / listTree / listEvents had no SQL LIMIT.
 *   - handleWriteFile / handleBulkWrite enforced the 10MB cap AFTER
 *     await request.json() had already buffered the whole body.
 *   - handleGetWritebackContext returned the full file body inline.
 *
 * Each test below asserts a memory-shaped invariant against the new
 * implementation: pagination, single-content-load-per-iter, header-based
 * size rejection, and out-of-band content for oversized writebacks.
 */

type Row = Record<string, unknown>;

// Vitest gives back `unknown` from response.json(); cast to a permissive
// indexable shape for assertions.
async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

function makeWorkspaceFile(
  overrides: Partial<WorkspaceFile> = {},
): WorkspaceFile {
  return {
    path: "/notes/file.md",
    revision: "rev_1",
    contentType: "text/markdown",
    contentRef: "content/ws/notes/file.md/rev_1",
    size: 10,
    encoding: "utf-8",
    provider: "notion",
    providerObjectId: "obj_1",
    updatedAt: "2026-05-06T00:00:00.000Z",
    semanticsJson: "{}",
    contentHash: "",
    ...overrides,
  };
}

function fsErrors() {
  return {
    invalidInput: { status: 400, code: "invalid_input", message: "invalid" },
    notFound: { status: 404, code: "not_found", message: "not found" },
    preconditionFailed: {
      status: 412,
      code: "precondition_failed",
      message: "missing If-Match",
    },
    revisionConflict: {
      status: 409,
      code: "revision_conflict",
      message: "revision conflict",
    },
    payloadTooLarge: {
      status: 413,
      code: "payload_too_large",
      message: "payload too large",
    },
    badRequest: { status: 400, code: "bad_request", message: "bad request" },
  };
}

function makeFsContext(
  overrides: Record<string, unknown> = {},
): WorkspaceFsContext {
  return {
    errors: fsErrors(),
    readJson: async <T>(request: Request) => (await request.json()) as T,
    resolveWorkspaceId: async () => "ws_test",
    getRequestClaims: async () => null as TokenClaims | null,
    json: (payload: unknown, status = 200, headers?: HeadersInit) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: {
          "Content-Type": "application/json",
          ...(headers ?? {}),
        },
      }),
    errorResponse: (
      _req: Request,
      status: number,
      code: string,
      message: string,
      details?: Record<string, unknown>,
    ) =>
      new Response(JSON.stringify({ code, message, ...(details ?? {}) }), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    correlationId: () => "corr_test",
    dedupKv: undefined,
    putObject: vi.fn(async () => undefined),
    deleteContent: vi.fn(),
    contentRef: () => "ref",
    recordMutation: vi.fn(async () => ({
      opId: "op_1",
      status: "queued" as const,
      targetRevision: "rev_2",
    })),
    syncWorkspaceStats: vi.fn(async () => undefined),
    touchWorkspaceActivity: vi.fn(async () => undefined),
    allRows: vi.fn(() => []),
    sqlExec: vi.fn(),
    getFileRow: vi.fn(() => null),
    getOperation: vi.fn(() => null),
    insertEvent: vi.fn(),
    loadContent: vi.fn(async () => ""),
    nextId: vi.fn(() => "rev_2"),
    toWorkspaceFile: vi.fn((row) => row as unknown as WorkspaceFile),
    toEvent: vi.fn((row) => row as unknown as WorkspaceEvent),
    toWorkspaceOperation: vi.fn(),
    bindings: {},
    ...overrides,
  } as unknown as WorkspaceFsContext;
}

// ---------------------------------------------------------------------------
// P0-0: WorkspaceDO admission/read-path hardening
// ---------------------------------------------------------------------------

describe("isAdmissionControlPlaneRequest — control-plane bypass (cloud#1261)", () => {
  it("flags the write-admission RELEASE as control-plane (must bypass the gate so it can't be 429'd into a lease leak)", () => {
    expect(
      isAdmissionControlPlaneRequest(
        "POST",
        "/internal/write-admission/release",
      ),
    ).toBe(true);
  });

  it("flags the write-admission ACQUIRE as control-plane", () => {
    expect(
      isAdmissionControlPlaneRequest(
        "POST",
        "/internal/write-admission/acquire",
      ),
    ).toBe(true);
  });

  it("does NOT flag a data-plane write — process-envelope stays gated", () => {
    expect(
      isAdmissionControlPlaneRequest("POST", "/internal/process-envelope"),
    ).toBe(false);
  });

  it("does NOT flag a non-POST method on a control-plane path", () => {
    expect(
      isAdmissionControlPlaneRequest(
        "GET",
        "/internal/write-admission/release",
      ),
    ).toBe(false);
  });

  it("does NOT flag an external data path", () => {
    expect(
      isAdmissionControlPlaneRequest("GET", "/v1/workspaces/ws/fs/file"),
    ).toBe(false);
  });
});

describe("WorkspaceDO request admission and read-path behavior", () => {
  it("uses the production default admission gates: 12 in-flight, 3 reserved foreground, 30s oldest age (cloud#1261)", () => {
    expect(resolveInflightAdmissionOptions({})).toEqual({
      maxInflightRequests: 12,
      maxOldestInflightAgeMs: 30_000,
      retryAfterSeconds: 5,
      reservedForeground: 3,
    });
  });

  it("admits then rejects new work with 429-shaped admission details when in-flight is saturated", () => {
    const admission = new InflightAdmissionController({
      maxInflightRequests: 1,
      maxOldestInflightAgeMs: 10_000,
      retryAfterSeconds: 7,
    });

    const first = admission.tryAcquire(100);
    expect(first.admit).toBe(true);

    const second = admission.tryAcquire(101);
    expect(second).toMatchObject({
      admit: false,
      status: 429,
      code: "workspace_busy",
      reason: "inflight_limit",
      retryAfterSeconds: 7,
      inflight: 1,
      maxInflight: 1,
    });

    if (first.admit) {
      first.release();
    }
  });

  it("rejects new work when the oldest in-flight request exceeds the age gate", () => {
    const admission = new InflightAdmissionController({
      maxInflightRequests: 32,
      maxOldestInflightAgeMs: 30_000,
      retryAfterSeconds: 9,
    });

    const first = admission.tryAcquire(1_000);
    expect(first.admit).toBe(true);

    const second = admission.tryAcquire(31_001);
    expect(second).toMatchObject({
      admit: false,
      status: 429,
      code: "workspace_busy",
      reason: "oldest_inflight_age",
      retryAfterSeconds: 9,
      inflight: 1,
      maxInflight: 32,
      oldestInflightAgeMs: 30_001,
      maxOldestInflightAgeMs: 30_000,
    });

    if (first.admit) {
      first.release();
    }
  });

  it("release frees a slot and is idempotent", () => {
    const admission = new InflightAdmissionController({
      maxInflightRequests: 1,
      maxOldestInflightAgeMs: 10_000,
      retryAfterSeconds: 5,
    });

    const first = admission.tryAcquire(100);
    expect(first.admit).toBe(true);
    if (!first.admit) return;

    expect(admission.tryAcquire(101).admit).toBe(false);
    first.release();
    first.release();

    const second = admission.tryAcquire(102);
    expect(second.admit).toBe(true);
    if (second.admit) {
      second.release();
    }
  });

  it("reserves foreground slots so background can't starve the clone lane (cloud#1261)", () => {
    const admission = new InflightAdmissionController({
      maxInflightRequests: 4,
      maxOldestInflightAgeMs: 60_000,
      retryAfterSeconds: 5,
      reservedForeground: 2,
    });
    // Background may use up to maxInflight - reserved = 2 slots.
    expect(admission.tryAcquire(1_000, false).admit).toBe(true);
    expect(admission.tryAcquire(1_000, false).admit).toBe(true);
    // 3rd BACKGROUND is rejected — the last 2 slots are reserved.
    expect(admission.tryAcquire(1_000, false).admit).toBe(false);
    // FOREGROUND (clone) still gets in — it may use the reserved lane.
    expect(admission.tryAcquire(1_000, true).admit).toBe(true);
    expect(admission.tryAcquire(1_000, true).admit).toBe(true);
    // Total is now 4 (= maxInflight); even foreground is rejected past the cap.
    expect(admission.tryAcquire(1_000, true).admit).toBe(false);
  });

  it("never rejects a foreground op for a stuck BACKGROUND op's age (cloud#1261)", () => {
    const admission = new InflightAdmissionController({
      maxInflightRequests: 8,
      maxOldestInflightAgeMs: 30_000,
      retryAfterSeconds: 5,
      reservedForeground: 2,
    });
    expect(admission.tryAcquire(1_000, false).admit).toBe(true); // background @1s
    // A new BACKGROUND op is rejected once the oldest exceeds the age gate.
    expect(admission.tryAcquire(40_000, false)).toMatchObject({
      admit: false,
      reason: "oldest_inflight_age",
    });
    // FOREGROUND is NOT rejected for the stuck background op — reserved lane.
    expect(admission.tryAcquire(40_000, true).admit).toBe(true);
  });

  it("stores the write-admission purpose as the lease reason label", () => {
    expect(
      resolveWriteAdmissionLeaseReason({
        purpose: " fs_bulk ",
      }),
    ).toBe("fs_bulk");
    expect(
      resolveWriteAdmissionLeaseReason({
        reason: " webhook_envelope ",
      }),
    ).toBe("webhook_envelope");
    expect(
      resolveWriteAdmissionLeaseReason({
        purpose: "fs_file_put",
        reason: "legacy_reason",
      }),
    ).toBe("fs_file_put");
  });

  it("reserves write-admission capacity so background churn cannot starve foreground writes", () => {
    expect(
      decideWriteAdmission({
        writeClass: "foreground_content",
        inflight: 3,
        foregroundInflight: 0,
        maxInflight: 4,
        foregroundReserved: 1,
        backgroundMax: 3,
      }),
    ).toMatchObject({ admit: true, backgroundInflight: 3 });

    expect(
      decideWriteAdmission({
        writeClass: "background_integration",
        inflight: 3,
        foregroundInflight: 0,
        maxInflight: 4,
        foregroundReserved: 1,
        backgroundMax: 3,
      }),
    ).toMatchObject({
      admit: false,
      backgroundInflight: 3,
      reason: "write_admission_limit",
    });
  });

  it("rejects foreground write admission only when the total write pool is exhausted", () => {
    expect(
      decideWriteAdmission({
        writeClass: "foreground_content",
        inflight: 4,
        foregroundInflight: 4,
        maxInflight: 4,
        foregroundReserved: 1,
        backgroundMax: 3,
      }),
    ).toMatchObject({
      admit: false,
      reason: "write_admission_limit",
    });
  });

  it("defaults unclassified writes to background integration", () => {
    expect(resolveWriteAdmissionClass("foreground_control")).toBe(
      "foreground_control",
    );
    expect(resolveWriteAdmissionClass("unknown")).toBe(
      "background_integration",
    );
    expect(resolveWriteAdmissionClass(undefined)).toBe(
      "background_integration",
    );
  });

  it("releases admission after thrown handlers so later work can enter", async () => {
    const admission = new InflightAdmissionController({
      maxInflightRequests: 1,
      maxOldestInflightAgeMs: 10_000,
      retryAfterSeconds: 5,
    });

    await expect(
      withAdmission(admission, async () => {
        throw new Error("handler failed");
      }),
    ).rejects.toThrow("handler failed");

    const next = admission.tryAcquire(200);
    expect(next.admit).toBe(true);
    if (next.admit) {
      next.release();
    }
  });

  it("formats the exact WorkspaceDO 429 contract with Retry-After in seconds", async () => {
    const admission = new InflightAdmissionController({
      maxInflightRequests: 1,
      maxOldestInflightAgeMs: 10_000,
      retryAfterSeconds: 7,
    });

    const first = admission.tryAcquire(100);
    expect(first.admit).toBe(true);
    const rejection = admission.tryAcquire(101);
    expect(rejection.admit).toBe(false);
    if (rejection.admit) return;

    const contract = inflightAdmissionHttpContract(rejection, "corr_admission");
    const response = new Response(JSON.stringify(contract.body), {
      status: contract.status,
      headers: contract.headers,
    });
    const body = await readJson(response);

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("7");
    expect(contract).toEqual({
      status: 429,
      headers: { "Retry-After": "7" },
      body: {
        code: "workspace_busy",
        message:
          "workspace durable object is busy; retry after the advertised delay",
        correlationId: "corr_admission",
        retryAfterSeconds: 7,
        reason: "inflight_limit",
        inflight: 1,
        maxInflight: 1,
        oldestInflightAgeMs: 1,
        maxOldestInflightAgeMs: 10_000,
      },
    });
    expect(body).toEqual({
      code: "workspace_busy",
      message:
        "workspace durable object is busy; retry after the advertised delay",
      correlationId: "corr_admission",
      retryAfterSeconds: 7,
      reason: "inflight_limit",
      inflight: 1,
      maxInflight: 1,
      oldestInflightAgeMs: 1,
      maxOldestInflightAgeMs: 10_000,
    });

    if (first.admit) {
      first.release();
    }
  });

  it("includes active write-admission lease samples in workspace-busy responses", () => {
    const workspaceSource = readFileSync(
      join(import.meta.dirname, "../src/durable-objects/workspace.ts"),
      "utf8",
    );
    const rejectStart = workspaceSource.indexOf(
      "const activeLeases = this.writeAdmissionLeaseSample(workspaceId, now)",
    );
    expect(rejectStart).toBeGreaterThanOrEqual(0);
    const busyResponseStart = workspaceSource.indexOf(
      "private writeAdmissionBusyResponse",
    );
    expect(busyResponseStart).toBeGreaterThanOrEqual(0);
    const rejectBody = workspaceSource.slice(rejectStart, busyResponseStart);
    const busyResponseBody = workspaceSource.slice(
      busyResponseStart,
      workspaceSource.indexOf("\n  private ensureColumn", busyResponseStart),
    );

    expect(rejectBody).toContain("activeLeases");
    expect(busyResponseBody).toContain("activeLeases?:");
    expect(busyResponseBody).toContain(
      "activeLeases: details.activeLeases ?? []",
    );
    expect(busyResponseBody).toContain(
      "SELECT lease_id, reason, write_class, acquired_at, expires_at",
    );
  });

  it("translates durable object overload errors into the workspace_busy 429 path", async () => {
    const stub = {
      fetch: vi.fn(async () => {
        throw new Error(
          "Durable Object is overloaded. Requests queued for too long.",
        );
      }),
    } as unknown as DurableObjectStub;
    const request = new Request("https://relayfile.test/internal/read-file", {
      headers: { "X-Correlation-Id": "corr_overload" },
    });

    const response = await fetchWorkspaceDOWithBackpressure(stub, request, {
      reason: "durable_object_overloaded",
      retryAfterSeconds: 13,
    });
    const body = await readJson(response);

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("13");
    expect(body).toEqual({
      code: "workspace_busy",
      message:
        "workspace durable object is busy; retry after the advertised delay",
      correlationId: "corr_overload",
      retryAfterSeconds: 13,
      reason: "durable_object_overloaded",
    });
  });

  it("streams utf-8 content across chunks with a hard byte ceiling", async () => {
    const result = await streamR2ObjectContent(
      r2Object(["he", "ll", "o"]),
      "utf-8",
      5,
      "content/test/hello",
    );
    expect(result).toBe("hello");

    await expect(
      streamR2ObjectContent(
        r2Object(["hello", "!"]),
        "utf-8",
        5,
        "content/test/too-large",
      ),
    ).rejects.toMatchObject({
      status: 413,
      code: "payload_too_large",
    });
  });

  it("base64-encodes streamed chunks across three-byte boundaries", async () => {
    const bytes = [
      new Uint8Array([0, 1]),
      new Uint8Array([2, 3, 4]),
      new Uint8Array([5]),
    ];
    const result = await streamR2ObjectContent(
      r2Object(bytes),
      "base64",
      6,
      "content/test/base64",
    );
    expect(result).toBe(Buffer.from([0, 1, 2, 3, 4, 5]).toString("base64"));
  });

  it("reads from the R2 body stream instead of object-level buffering helpers", async () => {
    let textCalled = false;
    let arrayBufferCalled = false;
    const object = {
      size: 5,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("he"));
          controller.enqueue(new TextEncoder().encode("llo"));
          controller.close();
        },
      }),
      text: async () => {
        textCalled = true;
        return "should not be used";
      },
      arrayBuffer: async () => {
        arrayBufferCalled = true;
        return new ArrayBuffer(0);
      },
    } as unknown as R2ObjectBody;

    await expect(
      streamR2ObjectContent(object, "utf-8", 5, "content/test/streamed"),
    ).resolves.toBe("hello");
    expect(textCalled).toBe(false);
    expect(arrayBufferCalled).toBe(false);
  });

  it("rejects oversized R2 objects from metadata before reading the stream", async () => {
    let bodyAccessed = false;
    const object = {
      size: 6,
      get body() {
        bodyAccessed = true;
        return new ReadableStream<Uint8Array>({
          pull() {
            throw new Error("stream should not be read");
          },
        });
      },
    } as unknown as R2ObjectBody;

    await expect(
      streamR2ObjectContent(object, "utf-8", 5, "content/test/metadata-large"),
    ).rejects.toMatchObject({
      status: 413,
      code: "payload_too_large",
    });
    expect(bodyAccessed).toBe(false);
  });
});

async function withAdmission<T>(
  admission: InflightAdmissionController,
  handler: () => Promise<T>,
): Promise<T> {
  const acquired = admission.tryAcquire(100);
  if (!acquired.admit) {
    throw new Error("not admitted");
  }
  try {
    return await handler();
  } finally {
    acquired.release();
  }
}

function r2Object(
  chunks: Array<string | Uint8Array>,
  size?: number,
): R2ObjectBody {
  const encoder = new TextEncoder();
  const encoded = chunks.map((chunk) =>
    typeof chunk === "string" ? encoder.encode(chunk) : chunk,
  );
  return {
    size: size ?? encoded.reduce((total, chunk) => total + chunk.byteLength, 0),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of encoded) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    }),
  } as unknown as R2ObjectBody;
}

// ---------------------------------------------------------------------------
// P0-1: Streaming export — no full content materialization
// ---------------------------------------------------------------------------

describe("workspace export: streaming paginated iterator (no full content map)", () => {
  it("paginates the files query with WHERE path > ? ORDER BY path ASC LIMIT N", async () => {
    const PAGE = EXPORT_FILE_PAGE_SIZE;
    // Two pages: PAGE rows on the first call, fewer on the second.
    const page1Rows: Row[] = Array.from({ length: PAGE }, (_, i) => ({
      path: `/p/${String(i).padStart(4, "0")}`,
    }));
    const page2Rows: Row[] = [{ path: "/p/zzzz" }];

    const calls: { sql: string; bindings: unknown[] }[] = [];
    const allRows = vi.fn((sql: string, ...bindings: unknown[]) => {
      calls.push({ sql, bindings });
      if (calls.length === 1) return page1Rows;
      if (calls.length === 2) return page2Rows;
      return [];
    });

    const context = {
      allRows,
      toWorkspaceFile: (row: Row) =>
        makeWorkspaceFile({ path: row.path as string }),
      loadContent: vi.fn(async () => "body"),
      getFileRow: () => null,
      getOperation: () => null,
      insertEvent: vi.fn(),
      nextId: () => "x",
      sqlExec: vi.fn(),
      toEvent: vi.fn(),
      toWorkspaceOperation: vi.fn(),
    } as unknown as WorkspaceAdapterContext;

    const collected: string[] = [];
    for await (const chunk of iterateWorkspaceFilesForExport(
      context,
      "ws_test",
      null,
    )) {
      collected.push(chunk.file.path);
    }

    // First SQL has no path-cursor (no WHERE on the keyset), second does.
    expect(calls[0]?.sql).toContain("ORDER BY path ASC");
    expect(calls[0]?.sql).toContain("LIMIT ?");
    expect(calls[0]?.sql).not.toContain("WHERE path > ?");
    expect(calls[0]?.bindings).toEqual([PAGE]);

    expect(calls[1]?.sql).toContain("WHERE path > ?");
    expect(calls[1]?.sql).toContain("LIMIT ?");
    // Cursor is the last path from page 1.
    expect(calls[1]?.bindings[0]).toBe(
      `/p/${String(PAGE - 1).padStart(4, "0")}`,
    );
    expect(calls[1]?.bindings[1]).toBe(PAGE);

    expect(collected).toHaveLength(PAGE + RUNTIME_PATHS.length + 1);
    expect(collected[0]).toBe("/.skills/activity-summary.md");
  });

  it("loads exactly one file body at a time (never all bodies into a map)", async () => {
    // Build 5 file rows.
    const rows: Row[] = Array.from({ length: 5 }, (_, i) => ({
      path: `/f/${i}`,
    }));
    let concurrent = 0;
    let maxConcurrent = 0;

    const context = {
      allRows: vi.fn((_sql: string, ..._args: unknown[]) => {
        // Return all 5 in one page, then empty.
        return _args[0] === EXPORT_FILE_PAGE_SIZE ? rows : [];
      }),
      toWorkspaceFile: (row: Row) =>
        makeWorkspaceFile({ path: row.path as string }),
      loadContent: vi.fn(async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        // Yield once so the async-generator semantics are exercised.
        await Promise.resolve();
        concurrent -= 1;
        return "body";
      }),
      getFileRow: () => null,
      getOperation: () => null,
      insertEvent: vi.fn(),
      nextId: () => "x",
      sqlExec: vi.fn(),
      toEvent: vi.fn(),
      toWorkspaceOperation: vi.fn(),
    } as unknown as WorkspaceAdapterContext;

    let yielded = 0;
    for await (const _ of iterateWorkspaceFilesForExport(
      context,
      "ws_test",
      null,
    )) {
      yielded += 1;
    }

    expect(yielded).toBe(rows.length + RUNTIME_PATHS.length);
    // The whole point: at no instant does the DO hold more than one body.
    expect(maxConcurrent).toBe(1);
    // Five persisted files, five loadContent calls; the runtime skill body is
    // served without loading from R2.
    expect(
      (context.loadContent as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(5);
  });

  it("rejects export when file count exceeds the configured ceiling", async () => {
    const rows = Array.from({ length: 101 }, (_, i) => ({
      path: `/f/${String(i).padStart(3, "0")}.md`,
    }));
    const ctx = makeFsContext({
      allRows: vi.fn((sql: string) => {
        if (sql.includes("FROM files")) return rows;
        return [];
      }),
      toWorkspaceFile: (row: Row) =>
        makeWorkspaceFile({ path: row.path as string }),
      bindings: { RELAYFILE_MAX_EXPORT_FILES: "100" },
    });
    const res = await exportWorkspaceResponse(ctx, "ws_test", "json", null);
    expect(res.status).toBe(413);
    const body = await readJson(res);
    expect(body.code).toBe("payload_too_large");
    expect(body.message).toContain("more than 100");
    expect(body.message).toContain("100");
  });

  it("streams JSON export as an array body without buffering the whole array", async () => {
    const rows: Row[] = [{ path: "/a.md" }, { path: "/b.md" }];
    const ctx = makeFsContext({
      allRows: vi.fn((sql: string, ..._args: unknown[]) => {
        if (sql.includes("COUNT(*)")) return [{ count: rows.length }];
        if (sql.includes("FROM files")) return rows;
        return [];
      }),
      loadContent: vi.fn(async () => "hi"),
      toWorkspaceFile: (row: Row) =>
        makeWorkspaceFile({ path: row.path as string }),
    });

    const res = await exportWorkspaceResponse(ctx, "ws_test", "json", null);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/application\/json/);
    expect(res.body).toBeTruthy();

    const text = await res.text();
    expect(text.startsWith("[")).toBe(true);
    expect(text.endsWith("]")).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.map((file: { path: string }) => file.path)).toEqual([
      ...RUNTIME_PATHS,
      "/a.md",
      "/b.md",
    ]);
    expect(parsed[0].content).toContain("/digests/today.md");
    expect(parsed[RUNTIME_PATHS.length].content).toBe("hi");
  });

  it("writes long tar paths using the ustar prefix field", async () => {
    const strippedPath = `${"dir/".repeat(30)}file.txt`;
    const rows: Row[] = [{ path: `/${strippedPath}` }];
    const ctx = makeFsContext({
      allRows: vi.fn((sql: string) => {
        if (sql.includes("FROM files")) return rows;
        return [];
      }),
      loadContent: vi.fn(async () => "hi"),
      toWorkspaceFile: (row: Row) =>
        makeWorkspaceFile({ path: row.path as string }),
    });

    const res = await exportWorkspaceResponse(ctx, "ws_test", "tar", null);
    expect(res.status).toBe(200);
    const ungzipped = await new Response(
      res.body!.pipeThrough(new DecompressionStream("gzip")),
    ).arrayBuffer();
    const bytes = new Uint8Array(ungzipped);
    const decodeField = (offset: number, length: number) =>
      new TextDecoder()
        .decode(bytes.slice(offset, offset + length))
        .replace(/\0.*$/u, "");
    const decodePath = (offset: number) =>
      [decodeField(offset + 345, 155), decodeField(offset, 100)]
        .filter(Boolean)
        .join("/");

    expect(decodePath(0)).toBe("workspace/.skills/activity-summary.md");

    let longPathHeaderOffset = -1;
    for (let offset = 0; offset < bytes.length; offset += 512) {
      if (decodeField(offset, 100) === "file.txt") {
        longPathHeaderOffset = offset;
        break;
      }
    }
    expect(longPathHeaderOffset).toBeGreaterThan(-1);
    expect(decodeField(longPathHeaderOffset, 100)).toBe("file.txt");
    // safeTarEntryName roots every member under `workspace/` (see
    // worker-export.test.ts "writes distinct ustar names for long paths").
    expect(decodePath(longPathHeaderOffset)).toBe(`workspace/${strippedPath}`);
  });
});

// ---------------------------------------------------------------------------
// P0-2: Writeback size limit BEFORE buffering the body
// ---------------------------------------------------------------------------

describe("handleWriteFile: Content-Length size guard runs before readJson", () => {
  it("rejects with 413 when Content-Length exceeds the configured limit", async () => {
    let readJsonCalled = false;
    const ctx = makeFsContext({
      readJson: async <T>() => {
        readJsonCalled = true;
        return {} as T;
      },
    });
    // 50 MB Content-Length, default cap is 10 MiB + slack.
    const req = new Request("https://do/write-file", {
      method: "POST",
      headers: {
        "Content-Length": String(50 * 1024 * 1024),
        "If-Match": "0",
      },
      body: "{}",
    });

    const res = await handleWriteFile(ctx, req);
    expect(res.status).toBe(413);
    const body = await readJson(res);
    expect(body.code).toBe("payload_too_large");
    // CRITICAL invariant: we rejected BEFORE buffering the body.
    expect(readJsonCalled).toBe(false);
  });

  it("honors the RELAYFILE_MAX_WRITE_BYTES override", async () => {
    let readJsonCalled = false;
    const ctx = makeFsContext({
      readJson: async <T>() => {
        readJsonCalled = true;
        return {} as T;
      },
      bindings: { RELAYFILE_MAX_WRITE_BYTES: "1024" }, // 1 KB
    });
    const req = new Request("https://do/write-file", {
      method: "POST",
      headers: {
        "Content-Length": String(200 * 1024), // 200 KB
        "If-Match": "0",
      },
      body: "{}",
    });
    const res = await handleWriteFile(ctx, req);
    expect(res.status).toBe(413);
    expect(readJsonCalled).toBe(false);
  });

  it("allows requests whose Content-Length is within the cap", async () => {
    const ctx = makeFsContext({
      resolveWorkspaceId: async () => "ws_test",
    });
    const req = new Request("https://do/write-file", {
      method: "POST",
      headers: {
        "Content-Length": String(1024),
        "If-Match": "0",
      },
      body: JSON.stringify({ workspaceId: "ws_test", path: "/missing.md" }),
    });
    const res = await handleWriteFile(ctx, req);
    // We expect the handler to proceed past the size guard. The body is a
    // stub so it will fail later (missing required fields), but we MUST
    // NOT see 413 or 411.
    expect(res.status).not.toBe(413);
    expect(res.status).not.toBe(411);
  });

  it("rejects oversize bulk-write requests before buffering", async () => {
    let readJsonCalled = false;
    const ctx = makeFsContext({
      readJson: async <T>() => {
        readJsonCalled = true;
        return {} as T;
      },
    });
    const req = new Request("https://do/bulk-write", {
      method: "POST",
      headers: {
        "Content-Length": String(50 * 1024 * 1024),
      },
      body: "{}",
    });
    const res = await handleBulkWrite(ctx, req);
    expect(res.status).toBe(413);
    expect(readJsonCalled).toBe(false);
  });

  // --- Content-Length bypass regression tests ---------------------------
  //
  // Pre-hardening the size guard returned `null` (no rejection) when
  // Content-Length was absent or non-positive. A client could bypass the
  // 10 MiB cap by using `Transfer-Encoding: chunked` (no Content-Length) or
  // simply omitting the header — and the JSON path would then call
  // `await request.json()` with no size limit, the exact OOM vector this
  // PR claims to fix. The handler now requires Content-Length on the JSON
  // path and responds 411 Length Required when it's missing/invalid.

  it("rejects with 411 when Content-Length is missing entirely (no body buffering)", async () => {
    let readJsonCalled = false;
    const ctx = makeFsContext({
      readJson: async <T>() => {
        readJsonCalled = true;
        return {} as T;
      },
    });
    // Construct a Request without a Content-Length header. Note we cannot
    // pass a body here because the WHATWG fetch Request constructor auto-
    // populates Content-Length from a string/Buffer body. The guard kicks
    // in before any body read, so an empty body is fine for this case.
    const req = new Request("https://do/write-file", {
      method: "POST",
      headers: {
        "If-Match": "0",
        // No Content-Length.
      },
    });
    // Sanity: Request() did not synthesize a Content-Length for us.
    expect(req.headers.get("Content-Length")).toBeNull();

    const res = await handleWriteFile(ctx, req);
    expect(res.status).toBe(411);
    const body = await readJson(res);
    expect(body.code).toBe("length_required");
    // CRITICAL: rejected BEFORE the body is buffered.
    expect(readJsonCalled).toBe(false);
  });

  it("rejects with 411 when Transfer-Encoding: chunked has no Content-Length", async () => {
    let readJsonCalled = false;
    const ctx = makeFsContext({
      readJson: async <T>() => {
        readJsonCalled = true;
        return {} as T;
      },
    });
    const req = new Request("https://do/write-file", {
      method: "POST",
      headers: {
        "If-Match": "0",
        "Transfer-Encoding": "chunked",
      },
    });
    expect(req.headers.get("Content-Length")).toBeNull();

    const res = await handleWriteFile(ctx, req);
    expect(res.status).toBe(411);
    const body = await readJson(res);
    expect(body.code).toBe("length_required");
    expect(readJsonCalled).toBe(false);
  });

  it("rejects with 411 when Content-Length is non-numeric", async () => {
    const ctx = makeFsContext();
    const req = new Request("https://do/write-file", {
      method: "POST",
      headers: {
        "Content-Length": "not-a-number",
        "If-Match": "0",
      },
      body: "{}",
    });
    const res = await handleWriteFile(ctx, req);
    expect(res.status).toBe(411);
    const body = await readJson(res);
    expect(body.code).toBe("length_required");
  });

  it("aborts with 413 when the body exceeds the cap mid-read (safety net for lying Content-Length)", async () => {
    // Simulates an upstream proxy stripping or under-reporting
    // Content-Length: the header says 1KB but the actual body is many MB.
    // The streaming reader inside readSizeCappedJson counts bytes on the
    // wire and aborts when consumed > limit.
    const ctx = makeFsContext({
      bindings: { RELAYFILE_MAX_WRITE_BYTES: "1024" }, // 1 KB cap
    });

    // Build a body well over the cap+slack (1KB + 64KB slack = ~65KB).
    const big = "x".repeat(200 * 1024); // 200 KB of payload
    const jsonBody = JSON.stringify({
      workspaceId: "ws_test",
      path: "/big.bin",
      ifMatch: "0",
      content: big,
      encoding: "utf-8",
    });

    // Lie about Content-Length: claim it's within the cap so the header
    // guard accepts the request, then send a much bigger body.
    const req = new Request("https://do/write-file", {
      method: "POST",
      headers: {
        "Content-Length": "100", // way under the cap
        "If-Match": "0",
      },
      body: jsonBody,
    });

    const res = await handleWriteFile(ctx, req);
    expect(res.status).toBe(413);
    const body = await readJson(res);
    expect(body.code).toBe("payload_too_large");
  });

  it("rejects bulk-write with 411 when Content-Length is missing", async () => {
    let readJsonCalled = false;
    const ctx = makeFsContext({
      readJson: async <T>() => {
        readJsonCalled = true;
        return {} as T;
      },
    });
    const req = new Request("https://do/bulk-write", {
      method: "POST",
      headers: {
        "Transfer-Encoding": "chunked",
      },
    });
    const res = await handleBulkWrite(ctx, req);
    expect(res.status).toBe(411);
    expect(readJsonCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P0-3: Bounded list queries (LIMIT applied IN SQL, not after .toArray())
// ---------------------------------------------------------------------------

describe("listEvents: keyset pagination in SQL", () => {
  it("emits LIMIT in the events SELECT (no unbounded scan)", () => {
    const calls: { sql: string; bindings: unknown[] }[] = [];
    const ctx = makeFsContext({
      allRows: vi.fn((sql: string, ...bindings: unknown[]) => {
        calls.push({ sql, bindings });
        return [];
      }),
    });

    listEvents(ctx, "ws_test", undefined, null, 50);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toMatch(/FROM events/);
    expect(calls[0]?.sql).toMatch(/LIMIT \?/);
    // Last binding is limit + 1 (over-fetch by 1 to detect "has more").
    const bindings = calls[0]?.bindings ?? [];
    expect(bindings[bindings.length - 1]).toBe(51);
  });

  it("resolves the cursor to (timestamp, event_id) and pages in SQL", () => {
    const calls: { sql: string; bindings: unknown[] }[] = [];
    const ctx = makeFsContext({
      allRows: vi.fn((sql: string, ...bindings: unknown[]) => {
        calls.push({ sql, bindings });
        // First call resolves the cursor to its (timestamp, event_id).
        if (sql.includes("WHERE event_id = ?")) {
          return [{ timestamp: "2026-05-06T00:00:00.000Z", event_id: "evt_5" }];
        }
        return [];
      }),
    });

    listEvents(ctx, "ws_test", "notion", "evt_5", 100);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.sql).toMatch(/WHERE event_id = \?/);
    expect(calls[0]?.sql).toMatch(/AND provider = \?/);
    expect(calls[0]?.bindings).toEqual(["evt_5", "notion"]);
    expect(calls[1]?.sql).toMatch(/provider = \?/);
    // Forward feed: the cursor is a watermark and the page returns events
    // STRICTLY NEWER than it, ordered oldest-first. (A `<` / DESC feed froze
    // the daemon mirror — see fs-content-hash forward-cursor tests.)
    expect(calls[1]?.sql).toMatch(/timestamp > \? OR/);
    expect(calls[1]?.sql).toMatch(
      /ORDER BY timestamp ASC, CAST\(SUBSTR\(event_id, 5\) AS INTEGER\) ASC/,
    );
    expect(calls[1]?.sql).toMatch(/LIMIT \?/);
  });

  it("caps requested limit at MAX_LIST_ROWS", () => {
    const calls: { sql: string; bindings: unknown[] }[] = [];
    const ctx = makeFsContext({
      allRows: vi.fn((sql: string, ...bindings: unknown[]) => {
        calls.push({ sql, bindings });
        return [];
      }),
    });
    listEvents(ctx, "ws_test", undefined, null, 1_000_000);
    const lastBinding = calls[0]?.bindings.at(-1);
    // Capped at MAX_LIST_ROWS (limit + 1 = MAX_LIST_ROWS + 1).
    expect(lastBinding).toBe(MAX_LIST_ROWS + 1);
  });

  it("supports bounded descending queries for latest-event lookups", () => {
    const calls: { sql: string; bindings: unknown[] }[] = [];
    const ctx = makeFsContext({
      allRows: vi.fn((sql: string, ...bindings: unknown[]) => {
        calls.push({ sql, bindings });
        return [];
      }),
    });

    listEvents(ctx, "ws_test", undefined, null, 1, "desc");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toMatch(/FROM events/);
    expect(calls[0]?.sql).toMatch(
      /ORDER BY timestamp DESC, CAST\(SUBSTR\(event_id, 5\) AS INTEGER\) DESC/,
    );
    expect(calls[0]?.sql).toMatch(/LIMIT \?/);
    expect(calls[0]?.bindings.at(-1)).toBe(2);
  });
});

describe("countWorkspaceFiles", () => {
  it("returns the SQL COUNT(*) result", () => {
    const ctx = {
      allRows: vi.fn(() => [{ count: 42 }]),
    } as unknown as Pick<WorkspaceAdapterContext, "allRows">;
    expect(countWorkspaceFiles(ctx)).toBe(42);
  });
  it("returns 0 when no row comes back", () => {
    const ctx = {
      allRows: vi.fn(() => []),
    } as unknown as Pick<WorkspaceAdapterContext, "allRows">;
    expect(countWorkspaceFiles(ctx)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// P0-4: Writeback context elides oversized bodies
// ---------------------------------------------------------------------------

describe("handleGetWritebackContext: out-of-band content for oversized files", () => {
  function makeOpsContext(
    overrides: Record<string, unknown> = {},
  ): OpsHandlerContext {
    return {
      workspaceId: "ws_test",
      bindings: { WRITEBACK_QUEUE: { send: vi.fn() } },
      state: { storage: { setAlarm: vi.fn(), deleteAlarm: vi.fn() } },
      sql: { exec: vi.fn(() => ({ toArray: () => [] })) },
      readJson: async <T>(request: Request) => (await request.json()) as T,
      resolveWorkspaceId: async () => "ws_test",
      requireWorkspaceId: async () => "ws_test",
      getWorkspaceId: async () => "ws_test",
      correlationId: () => "corr_test",
      json: (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      errorResponse: (
        _r: Request,
        status: number,
        code: string,
        message: string,
      ) =>
        new Response(JSON.stringify({ code, message }), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      coreStorageAdapter: () => ({}) as never,
      upsertWorkspaceOperation: vi.fn(),
      syncWorkspaceStats: vi.fn(),
      getFileRow: vi.fn(() => null),
      loadContent: vi.fn(async () => ""),
      ...overrides,
    } as unknown as OpsHandlerContext;
  }

  function makeRequest(opId: string): Request {
    return new Request("https://do/internal/writeback-context", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws_test", opId }),
    });
  }

  it("inlines content when file size is below the inline threshold", async () => {
    const fileRow = {
      path: "/notes/small.md",
      revision: "rev_1",
      contentType: "text/markdown",
      contentRef: "ref",
      size: 1024,
      encoding: "utf-8" as const,
      provider: "notion",
      providerObjectId: "obj_1",
      updatedAt: "2026-05-06T00:00:00.000Z",
      semanticsJson: "{}",
      contentHash: "",
    };
    const loadContent = vi.fn(async () => "small body");
    const ctx = makeOpsContext({
      sql: {
        exec: (_q: string, ..._b: unknown[]) => ({
          toArray: <R>() =>
            [
              {
                op_id: "op_1",
                path: "/notes/small.md",
                revision: "rev_1",
                action: "file_upsert",
                provider: "notion",
                status: "pending",
                attempt_count: 0,
                next_attempt_at: null,
                last_error: null,
                provider_result_json: null,
                correlation_id: "corr_1",
                created_at: "2026-05-06T00:00:00.000Z",
                updated_at: "2026-05-06T00:00:00.000Z",
                completed_at: null,
              },
            ] as unknown as R[],
        }),
      },
      getFileRow: vi.fn(() => fileRow),
      loadContent,
    });

    const res = await handleGetWritebackContext(ctx, makeRequest("op_1"));
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.contentInline).toBe(true);
    expect(body.contentSize).toBe(1024);
    expect((body.file as Record<string, unknown>).content).toBe("small body");
    expect(loadContent).toHaveBeenCalledTimes(1);
  });

  it("rejects inline writeback context when the file advanced past the operation revision", async () => {
    const oldRow = {
      path: "/notes/race.md",
      revision: "rev_1",
      contentType: "text/markdown",
      contentRef: "ref-old",
      size: 32,
      encoding: "utf-8" as const,
      provider: "notion",
      providerObjectId: "obj_race",
      updatedAt: "2026-05-06T00:00:00.000Z",
      semanticsJson: "{}",
      contentHash: "",
    };
    const newRow = { ...oldRow, revision: "rev_2", contentRef: "ref-new" };
    const ctx = makeOpsContext({
      sql: {
        exec: () => ({
          toArray: <R>() =>
            [
              {
                op_id: "op_race",
                path: "/notes/race.md",
                revision: "rev_1",
                action: "file_upsert",
                provider: "notion",
                status: "pending",
                attempt_count: 0,
                next_attempt_at: null,
                last_error: null,
                provider_result_json: null,
                correlation_id: "corr_race",
                created_at: "2026-05-06T00:00:00.000Z",
                updated_at: "2026-05-06T00:00:00.000Z",
                completed_at: null,
              },
            ] as unknown as R[],
        }),
      },
      getFileRow: vi.fn().mockReturnValueOnce(oldRow).mockReturnValue(newRow),
      loadContent: vi.fn(async () => "new body"),
    });

    const res = await handleGetWritebackContext(ctx, makeRequest("op_race"));
    expect(res.status).toBe(404);
    expect(ctx.loadContent).toHaveBeenCalledTimes(1);
  });

  it("elides content when R2 reports an oversized body despite small row metadata", async () => {
    const fileRow = {
      path: "/notes/underreported.md",
      revision: "rev_underreported",
      contentType: "text/markdown",
      contentRef: "ref-underreported",
      size: 1,
      encoding: "utf-8" as const,
      provider: "notion",
      providerObjectId: "obj_underreported",
      updatedAt: "2026-05-06T00:00:00.000Z",
      semanticsJson: "{}",
      contentHash: "",
    };
    const loadContent = vi.fn(async () => {
      throw new Error(
        "loadContent must not run for underreported large R2 objects",
      );
    });
    const ctx = makeOpsContext({
      bindings: {
        WRITEBACK_QUEUE: { send: vi.fn() },
        CONTENT_BUCKET: {
          head: vi.fn(async () => ({ size: 20 * 1024 * 1024 })),
        },
      },
      sql: {
        exec: () => ({
          toArray: <R>() =>
            [
              {
                op_id: "op_underreported",
                path: "/notes/underreported.md",
                revision: "rev_underreported",
                action: "file_upsert",
                provider: "notion",
                status: "pending",
                attempt_count: 0,
                next_attempt_at: null,
                last_error: null,
                provider_result_json: null,
                correlation_id: "corr_underreported",
                created_at: "2026-05-06T00:00:00.000Z",
                updated_at: "2026-05-06T00:00:00.000Z",
                completed_at: null,
              },
            ] as unknown as R[],
        }),
      },
      getFileRow: vi.fn(() => fileRow),
      loadContent,
    });

    const res = await handleGetWritebackContext(
      ctx,
      makeRequest("op_underreported"),
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.contentInline).toBe(false);
    expect(body.contentSize).toBe(20 * 1024 * 1024);
    expect(loadContent).not.toHaveBeenCalled();
  });

  it("elides content when file size exceeds the inline threshold (no R2 read)", async () => {
    const fileRow = {
      path: "/notes/huge.bin",
      revision: "rev_1",
      contentType: "application/octet-stream",
      contentRef: "ref-huge",
      size: 20 * 1024 * 1024, // 20 MB — well over the 2 MiB default
      encoding: "base64" as const,
      provider: "notion",
      providerObjectId: "obj_huge",
      updatedAt: "2026-05-06T00:00:00.000Z",
      semanticsJson: "{}",
      contentHash: "abcd",
    };
    const loadContent = vi.fn(async () => {
      throw new Error(
        "loadContent must NOT be called for oversized writebacks (out-of-band path)",
      );
    });
    const ctx = makeOpsContext({
      sql: {
        exec: (_q: string, ..._b: unknown[]) => ({
          toArray: <R>() =>
            [
              {
                op_id: "op_2",
                path: "/notes/huge.bin",
                revision: "rev_1",
                action: "file_upsert",
                provider: "notion",
                status: "pending",
                attempt_count: 0,
                next_attempt_at: null,
                last_error: null,
                provider_result_json: null,
                correlation_id: "corr_2",
                created_at: "2026-05-06T00:00:00.000Z",
                updated_at: "2026-05-06T00:00:00.000Z",
                completed_at: null,
              },
            ] as unknown as R[],
        }),
      },
      getFileRow: vi.fn(() => fileRow),
      loadContent,
    });

    const res = await handleGetWritebackContext(ctx, makeRequest("op_2"));
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.contentInline).toBe(false);
    expect(body.contentSize).toBe(20 * 1024 * 1024);
    expect(body.file).toBeTruthy();
    // CRITICAL invariant: content is elided (no multi-MB string in the
    // DO's JSON response) and loadContent never read R2.
    //
    // BACK-COMPAT NOTE: this used to assert `content === ""`. We switched
    // to `null` deliberately so daemons that don't know to consult
    // `contentInline` fail loudly when they touch `file.content` instead
    // of silently writing an empty file to the provider. See the comment
    // at the elision site in `handlers/ops.ts#handleGetWritebackContext`.
    expect((body.file as Record<string, unknown>).content).toBeNull();
    expect(loadContent).not.toHaveBeenCalled();
  });

  it("preserves semantics in the oversized writeback context", async () => {
    const fileRow = {
      path: "/notes/huge.md",
      revision: "rev_sem",
      contentType: "text/markdown",
      contentRef: "ref-huge",
      size: 20 * 1024 * 1024,
      encoding: "utf-8" as const,
      provider: "notion",
      providerObjectId: "obj_huge",
      updatedAt: "2026-05-06T00:00:00.000Z",
      semanticsJson: JSON.stringify({ properties: { title: "Huge" } }),
      contentHash: "",
    };
    const ctx = makeOpsContext({
      sql: {
        exec: () => ({
          toArray: <R>() =>
            [
              {
                op_id: "op_sem",
                path: "/notes/huge.md",
                revision: "rev_sem",
                action: "file_upsert",
                provider: "notion",
                status: "pending",
                attempt_count: 0,
                next_attempt_at: null,
                last_error: null,
                provider_result_json: null,
                correlation_id: "corr_sem",
                created_at: "2026-05-06T00:00:00.000Z",
                updated_at: "2026-05-06T00:00:00.000Z",
                completed_at: null,
              },
            ] as unknown as R[],
        }),
      },
      getFileRow: vi.fn(() => fileRow),
    });

    const res = await handleGetWritebackContext(ctx, makeRequest("op_sem"));
    const body = await readJson(res);
    expect((body.file as { semantics?: unknown }).semantics).toEqual({
      properties: { title: "Huge" },
    });
  });

  it("streams oversized writeback content from R2 with encoding and revision headers", async () => {
    const fileRow = {
      path: "/notes/huge.bin",
      revision: "rev_stream",
      contentType: "application/octet-stream",
      contentRef: "ref-stream",
      size: 2048,
      encoding: "base64" as const,
      provider: "notion",
      providerObjectId: "obj_stream",
      updatedAt: "2026-05-06T00:00:00.000Z",
      semanticsJson: "{}",
      contentHash: "hash-stream",
    };
    const bucket = {
      get: vi.fn(async () => ({
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.close();
          },
        }),
      })),
    };
    const ctx = makeOpsContext({
      bindings: {
        WRITEBACK_QUEUE: { send: vi.fn() },
        CONTENT_BUCKET: bucket,
      },
      sql: {
        exec: () => ({
          toArray: <R>() =>
            [
              {
                op_id: "op_stream",
                path: "/notes/huge.bin",
                revision: "rev_stream",
                action: "file_upsert",
                provider: "notion",
                status: "pending",
                attempt_count: 0,
                next_attempt_at: null,
                last_error: null,
                provider_result_json: null,
                correlation_id: "corr_stream",
                created_at: "2026-05-06T00:00:00.000Z",
                updated_at: "2026-05-06T00:00:00.000Z",
                completed_at: null,
              },
            ] as unknown as R[],
        }),
      },
      getFileRow: vi.fn(() => fileRow),
    });
    const req = new Request("https://do/internal/writeback-content", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws_test", opId: "op_stream" }),
    });

    const res = await handleGetWritebackContentStream(ctx, req);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Relayfile-Encoding")).toBe("base64");
    expect(res.headers.get("X-Relayfile-Revision")).toBe("rev_stream");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("rejects streamed writeback content when the file advanced past the operation revision", async () => {
    const fileRow = {
      path: "/notes/huge.bin",
      revision: "rev_new",
      contentType: "application/octet-stream",
      contentRef: "ref-new",
      size: 20 * 1024 * 1024,
      encoding: "base64" as const,
      provider: "notion",
      providerObjectId: "obj_stream",
      updatedAt: "2026-05-06T00:00:00.000Z",
      semanticsJson: "{}",
      contentHash: "hash-stream",
    };
    const bucket = {
      get: vi.fn(async () => ({
        body: new ReadableStream<Uint8Array>(),
      })),
    };
    const ctx = makeOpsContext({
      bindings: {
        WRITEBACK_QUEUE: { send: vi.fn() },
        CONTENT_BUCKET: bucket,
      },
      sql: {
        exec: () => ({
          toArray: <R>() =>
            [
              {
                op_id: "op_stream_stale",
                path: "/notes/huge.bin",
                revision: "rev_old",
                action: "file_upsert",
                provider: "notion",
                status: "pending",
                attempt_count: 0,
                next_attempt_at: null,
                last_error: null,
                provider_result_json: null,
                correlation_id: "corr_stream_stale",
                created_at: "2026-05-06T00:00:00.000Z",
                updated_at: "2026-05-06T00:00:00.000Z",
                completed_at: null,
              },
            ] as unknown as R[],
        }),
      },
      getFileRow: vi.fn(() => fileRow),
    });
    const req = new Request("https://do/internal/writeback-content", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "ws_test",
        opId: "op_stream_stale",
      }),
    });

    const res = await handleGetWritebackContentStream(ctx, req);
    expect(res.status).toBe(404);
    expect(bucket.get).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// P0-5: Write critical path no longer awaits digest regeneration (cloud#846)
// ---------------------------------------------------------------------------
//
// Regression guard for the cloud#846 root cause: `handleWriteFile` used to
// `await refreshWorkspaceDigests` inline (multi-window × thousands of events
// × per-event R2 content reads), which made every PUT on a busy workspace
// time out at 60s and silently dropped provider-sync writes. The fix moves
// the refresh to a debounced DO alarm via `scheduleDigestRefresh`, with
// `ensureNextAlarm` reconciling the digest due time alongside pending
// writeback ops so neither wipes the other.
//
// The shared-alarm reconciliation is the subtle correctness property here:
// before the fix, `ensureNextAlarm` unconditionally called `deleteAlarm()`
// when no ops were queued, which would have wiped any pending digest alarm.
// These tests pin that behavior down so a future refactor can't quietly
// regress it.

describe("ensureNextAlarm: digest-aware alarm reconciliation (cloud#846)", () => {
  function makeAlarmContext(options: {
    pendingOpAt?: string;
    digestDueAt?: number;
  }) {
    const setAlarm = vi.fn(async () => undefined);
    const deleteAlarm = vi.fn(async () => undefined);
    const get = vi.fn(async (key: string) =>
      key === DIGEST_REFRESH_DUE_STORAGE_KEY ? options.digestDueAt : undefined,
    );
    const sql = {
      exec: vi.fn(
        (
          _query: string,
          ..._bindings: unknown[]
        ): { toArray: <T>() => T[] } => ({
          toArray: <T>() =>
            (options.pendingOpAt
              ? [{ next_attempt_at: options.pendingOpAt }]
              : []) as unknown as T[],
        }),
      ),
    };
    return {
      ctx: {
        sql,
        state: { storage: { setAlarm, deleteAlarm, get } },
      } as unknown as Pick<OpsHandlerContext, "sql" | "state">,
      setAlarm,
      deleteAlarm,
    };
  }

  it("deleteAlarm when neither a pending op nor a digest refresh is queued", async () => {
    const { ctx, setAlarm, deleteAlarm } = makeAlarmContext({});
    await ensureNextAlarm(ctx);
    expect(deleteAlarm).toHaveBeenCalledTimes(1);
    expect(setAlarm).not.toHaveBeenCalled();
  });

  it("setAlarm to the digest due time when ONLY a digest refresh is pending (the critical regression guard)", async () => {
    // Pre-fix, ensureNextAlarm called deleteAlarm() whenever no ops were
    // queued — which would have wiped a digest alarm armed by a fresh
    // write. The fix is supposed to make this branch setAlarm(digestDueAt)
    // instead.
    const dueAt = Date.now() + 15_000;
    const { ctx, setAlarm, deleteAlarm } = makeAlarmContext({
      digestDueAt: dueAt,
    });
    await ensureNextAlarm(ctx);
    expect(deleteAlarm).not.toHaveBeenCalled();
    expect(setAlarm).toHaveBeenCalledTimes(1);
    expect(setAlarm).toHaveBeenCalledWith(dueAt);
  });

  it("setAlarm to the op attempt time when ONLY a writeback op is pending", async () => {
    const opAt = "2026-05-21T10:00:00.000Z";
    const { ctx, setAlarm, deleteAlarm } = makeAlarmContext({
      pendingOpAt: opAt,
    });
    await ensureNextAlarm(ctx);
    expect(deleteAlarm).not.toHaveBeenCalled();
    expect(setAlarm).toHaveBeenCalledTimes(1);
    expect(setAlarm).toHaveBeenCalledWith(Date.parse(opAt));
  });

  it("setAlarm to the EARLIER of an op and a digest when both are queued (op sooner)", async () => {
    const opAt = "2026-05-21T10:00:00.000Z";
    const digestAt = Date.parse(opAt) + 60_000;
    const { ctx, setAlarm } = makeAlarmContext({
      pendingOpAt: opAt,
      digestDueAt: digestAt,
    });
    await ensureNextAlarm(ctx);
    expect(setAlarm).toHaveBeenCalledWith(Date.parse(opAt));
  });

  it("setAlarm to the EARLIER of an op and a digest when both are queued (digest sooner)", async () => {
    const digestAt = Date.parse("2026-05-21T10:00:00.000Z");
    const opAt = new Date(digestAt + 60_000).toISOString();
    const { ctx, setAlarm } = makeAlarmContext({
      pendingOpAt: opAt,
      digestDueAt: digestAt,
    });
    await ensureNextAlarm(ctx);
    expect(setAlarm).toHaveBeenCalledWith(digestAt);
  });

  it("tolerates legacy storage mocks without a `get` method (preserves the pre-fix path)", async () => {
    // Existing tests across the codebase mock `state.storage` as only
    // { setAlarm, deleteAlarm }. The fix made `get` optional on
    // AlarmStorageLike specifically so those mocks keep typechecking and
    // running without modification — this asserts the runtime guard
    // matches the type guard.
    const setAlarm = vi.fn(async () => undefined);
    const deleteAlarm = vi.fn(async () => undefined);
    const sql = {
      exec: vi.fn(() => ({ toArray: <T>() => [] as unknown as T[] })),
    };
    const ctx = {
      sql,
      state: { storage: { setAlarm, deleteAlarm } },
    } as unknown as Pick<OpsHandlerContext, "sql" | "state">;
    await ensureNextAlarm(ctx);
    expect(deleteAlarm).toHaveBeenCalledTimes(1);
    expect(setAlarm).not.toHaveBeenCalled();
  });
});
