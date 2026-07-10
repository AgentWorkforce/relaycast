import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  bulkWrite,
  handleDeleteFile,
  handleBulkWrite,
  handleRegisterImportedContent,
  handleWriteFile,
  listTree,
  type WorkspaceFsContext,
} from "../src/durable-objects/handlers/fs.js";
import { hashContent } from "../src/durable-objects/content-hash.js";
import type { TokenClaims } from "../src/middleware/auth.js";

const WRITEBACK_DRAFT_IDENTITY_KIND = "mount-writeback-create-draft";
const WRITEBACK_DRAFT_TTL_SECONDS = 2592000;
const GOLDEN_WORKSPACE_ID = "ws_test";
const GOLDEN_WRITEBACK_PATH =
  "/slack/channels/C123/messages/messages 5ab77d67.json";
const GOLDEN_WRITEBACK_CONTENT =
  '{"channel":"C123","text":"hello writeback idempotency"}\n';
const GOLDEN_WRITEBACK_CONTENT_HASH =
  "751f9591557700f69b5ceefcdec7ead8563a10f0a712c501a5028699be021511";
const GOLDEN_WRITEBACK_IDENTITY_KEY = `${GOLDEN_WORKSPACE_ID}:${GOLDEN_WRITEBACK_PATH}:${GOLDEN_WRITEBACK_CONTENT_HASH}`;

type FileRowFixture = {
  path: string;
  revision?: string;
  contentType?: string;
  contentRef?: string;
  size?: number;
  encoding?: "utf-8" | "base64";
  provider?: string;
  providerObjectId?: string;
  updatedAt?: string;
  semanticsJson?: string;
  contentHash?: string;
};

// Keep the default claims shape aligned with what parseBearer produces —
// productId is optional on the JWT, so the fixture omits it by default.
// Tests that need to assert the "product-tagged" path supply it explicitly.
function createClaims(overrides: Partial<TokenClaims> = {}): TokenClaims {
  return {
    workspaceId: "ws_123",
    agentName: "test-agent",
    scopes: new Set(["fs:write"]),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

function createWriteRequest(
  body: Record<string, unknown>,
  path = "/docs/readme.md",
): Request {
  // Encode once so we can also publish the byte length for the
  // mandatory Content-Length header — the JSON write path rejects with
  // 411 Length Required when this header is missing/non-numeric.
  const serialized = JSON.stringify(body);
  const byteLength = new TextEncoder().encode(serialized).byteLength;
  return new Request(
    `https://relayfile.test/v1/workspaces/ws_123/fs/file?path=${encodeURIComponent(path)}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(byteLength),
        "If-Match": "0",
        "X-Correlation-Id": "corr_123",
      },
      body: serialized,
    },
  );
}

function createBulkWriteRequest(
  body: Record<string, unknown>,
  correlationId = "corr_123",
): Request {
  const serialized = JSON.stringify(body);
  const byteLength = new TextEncoder().encode(serialized).byteLength;
  return new Request("https://relayfile.test/v1/workspaces/ws_123/fs/bulk", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(byteLength),
      "X-Correlation-Id": correlationId,
    },
    body: serialized,
  });
}

function createDeleteRequest(
  body: Record<string, unknown>,
  path = "/docs/readme.md",
): Request {
  const serialized = JSON.stringify(body);
  const byteLength = new TextEncoder().encode(serialized).byteLength;
  return new Request(
    `https://relayfile.test/v1/workspaces/ws_123/fs/file?path=${encodeURIComponent(path)}`,
    {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(byteLength),
        "If-Match": "*",
        "X-Correlation-Id": "corr_123",
      },
      body: serialized,
    },
  );
}

function createContext(options: {
  claims?: TokenClaims | null;
  dedupEntries?: Record<string, string>;
  staleWritePaths?: ReadonlySet<string>;
  postFlushInvisiblePaths?: ReadonlySet<string>;
  withFlushStorage?: boolean;
  withDedupKv?: boolean;
  simulateProviderSyncFlush?: boolean;
}) {
  const order: string[] = [];
  const rows = new Map<
    string,
    {
      path: string;
      revision: string;
      contentType: string;
      contentRef: string;
      size: number;
      encoding: "utf-8" | "base64";
      provider: string;
      providerObjectId: string;
      updatedAt: string;
      semanticsJson: string;
      contentHash: string;
    }
  >();
  let dedupNowMs = 1710000000000;
  const dedupStore = new Map<string, { value: string; expiresAt?: number }>(
    Object.entries(options.dedupEntries ?? {}).map(([key, value]) => [
      key,
      { value },
    ]),
  );
  const dedupGet = vi.fn(async (key: string) => {
    order.push("dedup:get");
    const entry = dedupStore.get(key);
    if (!entry) {
      return null;
    }
    if (typeof entry.expiresAt === "number" && entry.expiresAt <= dedupNowMs) {
      dedupStore.delete(key);
      return null;
    }
    return entry.value;
  });
  const dedupPut = vi.fn(
    async (
      key: string,
      value: string,
      options?: { expirationTtl?: number },
    ) => {
      order.push("dedup:put");
      dedupStore.set(key, {
        value,
        expiresAt: options?.expirationTtl
          ? dedupNowMs + options.expirationTtl * 1000
          : undefined,
      });
    },
  );
  const putObject = vi.fn(async () => {
    order.push("putObject");
  });
  const putObjectStream = vi.fn(async () => {
    order.push("putObjectStream");
  });
  const deleteContent = vi.fn(async () => {
    order.push("deleteContent");
  });
  let storageFlushed = false;
  const flushStorage = vi.fn(async () => {
    order.push("flushStorage");
    storageFlushed = true;
  });
  const toFileRow = (
    row: typeof rows extends Map<string, infer T> ? T : never,
  ) => ({
    path: row.path,
    revision: row.revision,
    content_type: row.contentType,
    content_ref: row.contentRef,
    size: row.size,
    encoding: row.encoding,
    updated_at: row.updatedAt,
    semantics_json: row.semanticsJson,
    provider: row.provider,
    provider_object_id: row.providerObjectId,
    content_hash: row.contentHash,
  });
  const sqlExec = vi.fn((query: string, ...bindings: unknown[]) => {
    order.push("sqlExec");
    if (query.includes("DELETE FROM files")) {
      rows.delete(String(bindings[0] ?? ""));
      return;
    }
    if (!query.includes("INSERT INTO files")) return;
    const path = String(bindings[0] ?? "");
    if (options.staleWritePaths?.has(path)) {
      rows.set(path, {
        path,
        revision: "rev_999",
        contentType: String(bindings[2] ?? "text/plain"),
        contentRef: `content/ws_123${path}/rev_999`,
        size: Number(bindings[4] ?? 0),
        encoding: (bindings[5] as "utf-8" | "base64") ?? "utf-8",
        provider: String(bindings[8] ?? ""),
        providerObjectId: String(bindings[9] ?? ""),
        updatedAt: new Date().toISOString(),
        semanticsJson: String(bindings[7] ?? "{}"),
        contentHash: String(bindings[10] ?? ""),
      });
      return;
    }
    rows.set(path, {
      path,
      revision: String(bindings[1] ?? ""),
      contentType: String(bindings[2] ?? "text/plain"),
      contentRef: String(bindings[3] ?? ""),
      size: Number(bindings[4] ?? 0),
      encoding: (bindings[5] as "utf-8" | "base64") ?? "utf-8",
      provider: String(bindings[8] ?? ""),
      providerObjectId: String(bindings[9] ?? ""),
      updatedAt: String(bindings[6] ?? ""),
      semanticsJson: String(bindings[7] ?? "{}"),
      contentHash: String(bindings[10] ?? ""),
    });
  });
  let recordingBatch = false;
  const recordMutation = vi.fn(
    async (input?: { origin?: string; path?: string }) => {
      order.push("recordMutation");
      if (
        options.simulateProviderSyncFlush &&
        input?.origin === "provider_sync" &&
        !recordingBatch
      ) {
        await flushStorage();
      }
      return {
        opId: "op_123",
        status: "queued" as const,
        targetRevision: "rev_123",
      };
    },
  );
  const recordMutations = vi.fn(
    async (inputs: Array<{ origin?: string; path?: string }>) => {
      recordingBatch = true;
      try {
        const responses = [];
        for (const input of inputs) {
          responses.push(await recordMutation(input));
        }
        if (inputs.length > 0 && options.withFlushStorage) {
          await flushStorage();
          return { responses, syncCount: 1 };
        }
        return { responses, syncCount: 0 };
      } finally {
        recordingBatch = false;
      }
    },
  );

  const context = {
    errors: {
      invalidInput: { status: 400, code: "invalid_input", message: "invalid" },
      notFound: { status: 404, code: "not_found", message: "not found" },
      preconditionFailed: {
        status: 412,
        code: "precondition_failed",
        message: "missing If-Match header",
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
    },
    readJson: async <T>(request: Request) => (await request.json()) as T,
    resolveWorkspaceId: async () => "ws_123",
    getRequestClaims: async () => options.claims ?? createClaims(),
    json: (payload: unknown, status = 200, headers?: HeadersInit) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: {
          "Content-Type": "application/json",
          ...(headers ?? {}),
        },
      }),
    errorResponse: (
      _request: Request,
      status: number,
      code: string,
      message: string,
      details?: Record<string, unknown>,
    ) =>
      new Response(JSON.stringify({ code, message, ...(details ?? {}) }), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    correlationId: (request: Request) =>
      request.headers.get("X-Correlation-Id") ?? "corr_123",
    dedupKv:
      options.withDedupKv === false
        ? undefined
        : ({
            get: dedupGet,
            put: dedupPut,
          } as unknown as KVNamespace),
    putObject,
    putObjectStream,
    deleteContent,
    contentRef: (workspaceId: string, path: string, revision: string) =>
      `content/${workspaceId}${path}/${revision}`,
    recordMutation,
    recordMutations,
    syncWorkspaceStats: vi.fn(async () => undefined),
    touchWorkspaceWriteStats: vi.fn(async () => undefined),
    touchWorkspaceActivity: vi.fn(async () => undefined),
    // Digest regeneration is deferred to the DO alarm (cloud#846). Fixtures
    // expose a spy so individual tests can assert the deferral.
    scheduleDigestRefresh: vi.fn(async () => undefined),
    allRows: vi.fn((query: string, ...bindings: unknown[]) => {
      if (!query.includes("FROM files")) {
        return [];
      }
      if (bindings.length >= 4) {
        const [base, lower, upper] = bindings as [string, string, string];
        const hasCursor = bindings.length === 5;
        const cursor = hasCursor ? String(bindings[3]) : null;
        const limit = Number(bindings[hasCursor ? 4 : 3]);
        return Array.from(rows.values())
          .filter(
            (row) =>
              row.path === base || (row.path >= lower && row.path < upper),
          )
          .filter((row) => (cursor ? row.path > cursor : true))
          .sort((a, b) => a.path.localeCompare(b.path))
          .slice(0, limit)
          .map(toFileRow);
      }
      if (bindings.length === 1 && typeof bindings[0] === "number") {
        return Array.from(rows.values())
          .sort((a, b) => a.path.localeCompare(b.path))
          .slice(0, bindings[0])
          .map(toFileRow);
      }
      return [];
    }),
    sqlExec,
    getFileRow: vi.fn((path: string) => {
      if (storageFlushed && options.postFlushInvisiblePaths?.has(path)) {
        return null;
      }
      return rows.get(path) ?? null;
    }),
    getOperation: vi.fn(() => null),
    insertEvent: vi.fn(),
    loadContent: vi.fn(async () => ""),
    nextId: vi.fn(() => "rev_123"),
    toWorkspaceFile: vi.fn((row) => ({
      path: row.path,
      revision: row.revision,
      contentType: row.content_type,
      contentRef: row.content_ref,
      size: row.size,
      encoding: row.encoding,
      updatedAt: row.updated_at,
      semanticsJson: row.semantics_json,
      provider: row.provider,
      providerObjectId: row.provider_object_id,
      contentHash: row.content_hash,
    })),
    toEvent: vi.fn(),
    toWorkspaceOperation: vi.fn(),
    ...(options.withFlushStorage ? { flushStorage } : {}),
  } as unknown as WorkspaceFsContext;

  return {
    context,
    order,
    seedFileRow: (row: FileRowFixture) => {
      rows.set(row.path, {
        path: row.path,
        revision: row.revision ?? "rev_existing",
        contentType: row.contentType ?? "application/json",
        contentRef: row.contentRef ?? `content/ws_123${row.path}/rev_existing`,
        size: row.size ?? 0,
        encoding: row.encoding ?? "utf-8",
        provider: row.provider ?? "",
        providerObjectId: row.providerObjectId ?? "",
        updatedAt: row.updatedAt ?? "2026-06-17T00:00:00.000Z",
        semanticsJson: row.semanticsJson ?? "{}",
        contentHash: row.contentHash ?? "0".repeat(64),
      });
    },
    dedupStore,
    dedupGet,
    dedupPut,
    advanceDedupTime: (ms: number) => {
      dedupNowMs += ms;
    },
    putObject,
    putObjectStream,
    deleteContent,
    flushStorage,
    sqlExec,
    recordMutation,
    recordMutations,
    syncWorkspaceStats: context.syncWorkspaceStats as ReturnType<typeof vi.fn>,
    touchWorkspaceWriteStats: context.touchWorkspaceWriteStats as ReturnType<
      typeof vi.fn
    >,
    scheduleDigestRefresh: context.scheduleDigestRefresh as ReturnType<
      typeof vi.fn
    >,
  };
}

function expectedDedupHash(
  workspaceId: string,
  kind: string,
  key: string,
): string {
  return createHash("sha256")
    .update(workspaceId)
    .update("\0")
    .update(kind)
    .update("\0")
    .update(key)
    .digest("hex");
}

type SpyWithCalls = { mock: { calls: unknown[][] } };

function putObjectPaths(spy: SpyWithCalls): string[] {
  return spy.mock.calls.map((call) => String(call[5]));
}

function sqlExecPaths(spy: SpyWithCalls): string[] {
  return spy.mock.calls.map((call) => String(call[1]));
}

// Asserts the new (post-cloud#846) contract: the source path is written
// EXACTLY ONCE inline to R2 + D1, the digest regeneration is scheduled (not
// run inline), and no /digests/* writes leak into the synchronous write path.
function expectSourceWriteWithDeferredDigest(
  putObject: SpyWithCalls,
  sqlExec: SpyWithCalls,
  scheduleDigestRefresh: ReturnType<typeof vi.fn>,
  path = "/docs/readme.md",
) {
  const r2Paths = putObjectPaths(putObject);
  const d1Paths = sqlExecPaths(sqlExec);

  expect(r2Paths.filter((entry) => entry === path)).toHaveLength(1);
  expect(d1Paths.filter((entry) => entry === path)).toHaveLength(1);

  // CRITICAL invariant (cloud#846 regression guard): no /digests/* file is
  // written from the synchronous write path. The DO alarm owns those writes.
  const inlineDigestR2 = r2Paths.filter((entry) =>
    entry.startsWith("/digests/"),
  );
  const inlineDigestD1 = d1Paths.filter((entry) =>
    entry.startsWith("/digests/"),
  );
  expect(inlineDigestR2).toEqual([]);
  expect(inlineDigestD1).toEqual([]);

  // The deferred refresh was scheduled exactly once with the changed path.
  expect(scheduleDigestRefresh).toHaveBeenCalledTimes(1);
  const [scheduledOptions] = scheduleDigestRefresh.mock.calls[0] as [
    { changedPaths: readonly string[] },
  ];
  expect(scheduledOptions.changedPaths).toEqual([path]);
}

describe("relayfile write dedup", () => {
  it("keeps full workspace stats rollups out of admitted FS hot write handlers", () => {
    const fsSource = readFileSync(
      new URL("../src/durable-objects/handlers/fs.ts", import.meta.url),
      "utf8",
    );
    const statsSource = readFileSync(
      new URL("../src/durable-objects/stats.ts", import.meta.url),
      "utf8",
    );
    const hotHandlers = [
      "handleWriteFileStream",
      "handleWriteFile",
      "handleDeleteFileWithBody",
      "handleBulkWrite",
      "handleRegisterImportedContent",
    ];

    for (const handler of hotHandlers) {
      const start = fsSource.indexOf(`export async function ${handler}`);
      expect(start, `${handler} should exist`).toBeGreaterThanOrEqual(0);
      const next = fsSource.indexOf("\nexport async function ", start + 1);
      const body = fsSource.slice(start, next === -1 ? undefined : next);

      expect(body).not.toContain("syncWorkspaceStats(");
      expect(body).toContain("touchWorkspaceWriteStats(");
    }

    const touchStart = statsSource.indexOf(
      "export async function touchWorkspaceWriteStats",
    );
    expect(
      touchStart,
      "touchWorkspaceWriteStats should exist",
    ).toBeGreaterThanOrEqual(0);
    const touchNext = statsSource.indexOf(
      "\nexport async function ",
      touchStart + 1,
    );
    const touchBody = statsSource.slice(
      touchStart,
      touchNext === -1 ? undefined : touchNext,
    );
    expect(touchBody).not.toContain("FROM files");
    expect(touchBody).not.toContain("FROM operations");
    expect(touchBody).not.toContain("SELECT path, size");
  });

  it("skips dedup KV writes when contentIdentity is absent and still performs R2 + D1 writes", async () => {
    const { context, dedupGet, dedupPut, putObject, sqlExec, recordMutation } =
      createContext({});

    const response = await handleWriteFile(
      context,
      createWriteRequest({
        content: "# updated",
        contentType: "text/markdown",
      }),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      opId: "op_123",
      status: "queued",
      targetRevision: "rev_123",
    });
    expect(dedupGet).not.toHaveBeenCalled();
    expect(dedupPut).not.toHaveBeenCalled();
    expectSourceWriteWithDeferredDigest(
      putObject,
      sqlExec,
      context.scheduleDigestRefresh as ReturnType<typeof vi.fn>,
    );
    expect(recordMutation).toHaveBeenCalledOnce();
  });

  it("lifts parentRef from a writeback draft body into the mutation input (server-side threading)", async () => {
    const { context, recordMutation } = createContext({});
    const headerPath = "/slack/channels/C0/messages/messages header.json";

    const response = await handleWriteFile(
      context,
      createWriteRequest(
        {
          content: JSON.stringify({ text: "links", parentRef: headerPath }),
          contentType: "application/json",
        },
        "/slack/channels/C0/messages/messages reply.json",
      ),
    );

    expect(response.status).toBe(202);
    expect(recordMutation).toHaveBeenCalledOnce();
    expect(recordMutation.mock.calls[0][0]).toMatchObject({
      parentRef: headerPath,
    });
  });

  it("omits parentRef when the draft body has none (ordinary write)", async () => {
    const { context, recordMutation } = createContext({});

    await handleWriteFile(
      context,
      createWriteRequest({
        content: "# plain doc",
        contentType: "text/markdown",
      }),
    );

    expect(recordMutation).toHaveBeenCalledOnce();
    const input = recordMutation.mock.calls[0]?.[0] as
      | { parentRef?: string }
      | undefined;
    expect(input?.parentRef).toBeUndefined();
  });

  it("short-circuits duplicate writes when the dedup key already exists", async () => {
    const { context, dedupPut, putObject, sqlExec, recordMutation } =
      createContext({
        dedupEntries: {
          [expectedDedupHash("ws_123", "github-clone", "owner/repo@main")]:
            JSON.stringify({
              productId: "prod_original",
              ts: 1710000000000,
            }),
        },
      });

    const response = await handleWriteFile(
      context,
      createWriteRequest({
        content: "# updated",
        contentType: "text/markdown",
        contentIdentity: {
          kind: "github-clone",
          key: "owner/repo@main",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      deduped: true,
      originalWriter: "prod_original",
    });
    expect(dedupPut).not.toHaveBeenCalled();
    expect(putObject).not.toHaveBeenCalled();
    expect(sqlExec).not.toHaveBeenCalled();
    expect(recordMutation).not.toHaveBeenCalled();
  });

  it("records the dedup key on a KV miss before performing the underlying write", async () => {
    const { context, order, dedupPut, putObject, sqlExec, recordMutation } =
      createContext({
        // No productId — falls back to agentName for the writer tag.
        claims: createClaims(),
      });

    const response = await handleWriteFile(
      context,
      createWriteRequest({
        content: "# updated",
        contentType: "text/markdown",
        contentIdentity: {
          kind: "github-clone",
          key: "owner/repo@main",
        },
      }),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      opId: "op_123",
      status: "queued",
      targetRevision: "rev_123",
    });
    // Dedup KV put happens AFTER the write chain succeeds so a failed
    // downstream write can't orphan a dedup key and cause silent retry
    // short-circuits.
    // R2 putObject happens BEFORE the files-row sqlExec so a put failure
    // leaves no row pointing at a missing object. The rev counter is
    // already burned via flushStorage before putObject so a later rewind
    // can't reuse the same rev_N. See PR #460 review (Codex P1).
    //
    // Post-cloud#846: digest regeneration is deferred to the DO alarm, so
    // the inline order no longer contains the 5 extra putObject+sqlExec
    // pairs from the default digest windows. The deferred refresh is
    // covered by the separate `scheduleDigestRefresh` spy assertion.
    expect(order).toEqual([
      "dedup:get",
      "putObject",
      "sqlExec",
      "recordMutation",
      "dedup:put",
    ]);
    expectSourceWriteWithDeferredDigest(
      putObject,
      sqlExec,
      context.scheduleDigestRefresh as ReturnType<typeof vi.fn>,
    );
    expect(recordMutation).toHaveBeenCalledOnce();
    expect(dedupPut).toHaveBeenCalledWith(
      expectedDedupHash("ws_123", "github-clone", "owner/repo@main"),
      expect.any(String),
      { expirationTtl: 600 },
    );
    const payload = JSON.parse(dedupPut.mock.calls[0][1] as string) as {
      productId: string;
      ts: number;
    };
    // productId absent from claims → falls back to agentName
    expect(payload.productId).toBe("test-agent");
    expect(typeof payload.ts).toBe("number");
  });

  it("records productId when the JWT carries one", async () => {
    const { context, dedupPut } = createContext({
      claims: createClaims({ productId: "sage" }),
    });

    await handleWriteFile(
      context,
      createWriteRequest({
        content: "# updated",
        contentType: "text/markdown",
        contentIdentity: {
          kind: "github-clone",
          key: "owner/repo@v2",
        },
      }),
    );

    const payload = JSON.parse(dedupPut.mock.calls[0][1] as string) as {
      productId: string;
    };
    expect(payload.productId).toBe("sage");
  });

  it("does NOT persist the dedup key when the downstream write fails", async () => {
    // Regression: earlier revision wrote the dedup KV entry BEFORE putObject,
    // so a subsequent retry after an R2/SQL failure would short-circuit as
    // {deduped: true} without the data ever being persisted.
    const { context, dedupGet, dedupPut, putObject } = createContext({});
    putObject.mockImplementationOnce(async () => {
      throw new Error("simulated R2 outage");
    });

    await expect(
      handleWriteFile(
        context,
        createWriteRequest({
          content: "# updated",
          contentType: "text/markdown",
          contentIdentity: {
            kind: "github-clone",
            key: "owner/repo@main",
          },
        }),
      ),
    ).rejects.toThrow("simulated R2 outage");

    // GET ran (dedup check) but PUT did NOT run (no reservation commit).
    expect(dedupGet).toHaveBeenCalledOnce();
    expect(dedupPut).not.toHaveBeenCalled();
  });

  it("keeps the existing write path when DEDUP_KV is not bound", async () => {
    const { context, dedupGet, dedupPut, putObject, sqlExec, recordMutation } =
      createContext({
        withDedupKv: false,
      });

    const response = await handleWriteFile(
      context,
      createWriteRequest({
        content: "# updated",
        contentType: "text/markdown",
        contentIdentity: {
          kind: "github-clone",
          key: "owner/repo@main",
        },
      }),
    );

    expect(response.status).toBe(202);
    expect(dedupGet).not.toHaveBeenCalled();
    expect(dedupPut).not.toHaveBeenCalled();
    expectSourceWriteWithDeferredDigest(
      putObject,
      sqlExec,
      context.scheduleDigestRefresh as ReturnType<typeof vi.fn>,
    );
    expect(recordMutation).toHaveBeenCalledOnce();
  });

  it("pins the mount writeback draft contentIdentity golden vector", async () => {
    expect(await hashContent(GOLDEN_WRITEBACK_CONTENT, "utf-8")).toBe(
      GOLDEN_WRITEBACK_CONTENT_HASH,
    );
    expect(GOLDEN_WRITEBACK_IDENTITY_KEY).toBe(
      "ws_test:/slack/channels/C123/messages/messages 5ab77d67.json:751f9591557700f69b5ceefcdec7ead8563a10f0a712c501a5028699be021511",
    );
    expect(GOLDEN_WRITEBACK_IDENTITY_KEY.trim()).toBe(
      GOLDEN_WRITEBACK_IDENTITY_KEY,
    );
  });

  it("honors bulk contentIdentity, commits the dedup key after persistence, and skips duplicate replays", async () => {
    const { context, order, dedupPut, putObject, sqlExec, recordMutation } =
      createContext({
        claims: createClaims({ productId: "hn-monitor" }),
      });

    const first = await bulkWrite(
      context,
      GOLDEN_WORKSPACE_ID,
      [
        {
          path: GOLDEN_WRITEBACK_PATH,
          content: GOLDEN_WRITEBACK_CONTENT,
          contentType: "application/json",
          contentIdentity: {
            kind: WRITEBACK_DRAFT_IDENTITY_KIND,
            key: GOLDEN_WRITEBACK_IDENTITY_KEY,
            ttlSeconds: WRITEBACK_DRAFT_TTL_SECONDS,
          },
        },
      ],
      "corr_writeback_1",
      createClaims({ productId: "hn-monitor" }),
    );

    expect(first).toMatchObject({
      written: 1,
      errorCount: 0,
      errors: [],
      correlationId: "corr_writeback_1",
      bytesWritten: Buffer.byteLength(GOLDEN_WRITEBACK_CONTENT, "utf-8"),
      syncCount: 0,
    });
    expect(first.dedupedFiles).toBeUndefined();
    expect(order).toEqual([
      "dedup:get",
      "putObject",
      "sqlExec",
      "recordMutation",
      "dedup:put",
    ]);
    expect(dedupPut).toHaveBeenCalledWith(
      expectedDedupHash(
        GOLDEN_WORKSPACE_ID,
        WRITEBACK_DRAFT_IDENTITY_KIND,
        GOLDEN_WRITEBACK_IDENTITY_KEY,
      ),
      expect.any(String),
      { expirationTtl: WRITEBACK_DRAFT_TTL_SECONDS },
    );
    expect(recordMutation).toHaveBeenCalledOnce();

    const replay = await bulkWrite(
      context,
      GOLDEN_WORKSPACE_ID,
      [
        {
          path: GOLDEN_WRITEBACK_PATH,
          content: GOLDEN_WRITEBACK_CONTENT,
          contentType: "application/json",
          contentIdentity: {
            kind: WRITEBACK_DRAFT_IDENTITY_KIND,
            key: GOLDEN_WRITEBACK_IDENTITY_KEY,
            ttlSeconds: WRITEBACK_DRAFT_TTL_SECONDS,
          },
        },
      ],
      "corr_writeback_2",
      createClaims({ productId: "hn-monitor" }),
    );

    expect(replay).toMatchObject({
      written: 0,
      errorCount: 0,
      errors: [],
      correlationId: "corr_writeback_2",
      dedupedFiles: [
        {
          path: GOLDEN_WRITEBACK_PATH,
          deduped: true,
          originalWriter: "hn-monitor",
          revision: null,
        },
      ],
      bytesWritten: 0,
      syncCount: 0,
    });
    expect(putObject).toHaveBeenCalledOnce();
    expect(sqlExec).toHaveBeenCalledOnce();
    expect(recordMutation).toHaveBeenCalledOnce();
    expect(dedupPut).toHaveBeenCalledOnce();
  });

  it("keeps bulk writes unchanged when contentIdentity is absent", async () => {
    const {
      context,
      dedupGet,
      dedupPut,
      putObject,
      sqlExec,
      recordMutation,
      syncWorkspaceStats,
      touchWorkspaceWriteStats,
    } = createContext({});

    const response = await bulkWrite(
      context,
      "ws_123",
      [
        {
          path: "/docs/no-identity.md",
          content: "# no identity\n",
          contentType: "text/markdown",
        },
      ],
      "corr_no_identity",
      createClaims(),
    );

    expect(response).toMatchObject({
      written: 1,
      errorCount: 0,
      errors: [],
      correlationId: "corr_no_identity",
      bytesWritten: Buffer.byteLength("# no identity\n", "utf-8"),
      syncCount: 0,
    });
    expect(response.dedupedFiles).toBeUndefined();
    expect(dedupGet).not.toHaveBeenCalled();
    expect(dedupPut).not.toHaveBeenCalled();
    expect(putObject).toHaveBeenCalledOnce();
    expect(sqlExec).toHaveBeenCalledOnce();
    expect(recordMutation).toHaveBeenCalledOnce();
    expect(syncWorkspaceStats).not.toHaveBeenCalled();
    expect(touchWorkspaceWriteStats).not.toHaveBeenCalled();
  });

  it("resolves provider from canonical path for agent updates of existing synced records", async () => {
    const { context, seedFileRow, recordMutation } = createContext({});
    const path =
      "/linear/issues/AR-50__735918f4-1111-4111-8111-111111111111.json";

    seedFileRow({
      path,
      revision: "rev_existing",
      provider: "",
      providerObjectId: "735918f4-1111-4111-8111-111111111111",
      size: 2048,
    });

    const response = await bulkWrite(
      context,
      "ws_123",
      [
        {
          path,
          content: JSON.stringify({ labels: [{ name: "harness" }] }),
          contentType: "application/json",
        },
      ],
      "corr_linear_update",
      createClaims({ agentName: "ricky" }),
    );

    expect(response).toMatchObject({
      written: 1,
      errorCount: 0,
      errors: [],
      correlationId: "corr_linear_update",
    });
    expect(recordMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        path,
        provider: "linear",
        origin: "agent_write",
        eventType: "file.updated",
        action: "file_upsert",
      }),
    );
    expect(context.getFileRow(path)).toMatchObject({
      provider: "linear",
      providerObjectId: "735918f4-1111-4111-8111-111111111111",
    });
  });

  it("does not run the full workspace stats rollup before fs bulk responds", async () => {
    const { context, syncWorkspaceStats, touchWorkspaceWriteStats } =
      createContext({});

    const response = await handleBulkWrite(
      context,
      createBulkWriteRequest({
        workspaceId: "ws_123",
        files: [
          {
            path: "/docs/a.md",
            content: "# a\n",
            contentType: "text/markdown",
          },
          {
            path: "/docs/b.md",
            content: "# b\n",
            contentType: "text/markdown",
          },
        ],
      }),
    );

    expect(response.status).toBe(202);
    expect(syncWorkspaceStats).not.toHaveBeenCalled();
    expect(touchWorkspaceWriteStats).toHaveBeenCalledWith(
      "ws_123",
      expect.objectContaining({
        lastEventAt: expect.any(String),
        lastActivity: expect.any(String),
        fileCountDelta: 2,
        bytesStoredDelta:
          Buffer.byteLength("# a\n", "utf-8") +
          Buffer.byteLength("# b\n", "utf-8"),
        operationCountDelta: 2,
      }),
    );
  });

  it("lifts parentRef from a draft body in a bulk write (the mount-sync path)", async () => {
    const { context, recordMutations } = createContext({});
    const headerPath = "/slack/channels/C0/messages/messages header.json";

    const response = await handleBulkWrite(
      context,
      createBulkWriteRequest({
        workspaceId: "ws_123",
        files: [
          {
            path: "/slack/channels/C0/messages/messages reply.json",
            content: JSON.stringify({ text: "links", parentRef: headerPath }),
            contentType: "application/json",
          },
        ],
      }),
    );

    expect(response.status).toBe(202);
    expect(recordMutations).toHaveBeenCalledOnce();
    const inputs = recordMutations.mock.calls[0]?.[0] as Array<{
      parentRef?: string;
    }>;
    expect(inputs[0]).toMatchObject({ parentRef: headerPath });
  });

  it("uses pre-write sizes for bounded stats byte deltas", async () => {
    const { context, syncWorkspaceStats, touchWorkspaceWriteStats } =
      createContext({});

    const createResponse = await handleBulkWrite(
      context,
      createBulkWriteRequest({
        workspaceId: "ws_123",
        files: [
          {
            path: "/docs/size.md",
            content: "a".repeat(100),
            contentType: "text/markdown",
          },
        ],
      }),
    );
    expect(createResponse.status).toBe(202);
    expect(touchWorkspaceWriteStats).toHaveBeenLastCalledWith(
      "ws_123",
      expect.objectContaining({
        fileCountDelta: 1,
        bytesStoredDelta: 100,
      }),
    );

    const updateResponse = await handleBulkWrite(
      context,
      createBulkWriteRequest({
        workspaceId: "ws_123",
        files: [
          {
            path: "/docs/size.md",
            content: "b".repeat(250),
            contentType: "text/markdown",
          },
        ],
      }),
    );
    expect(updateResponse.status).toBe(202);
    expect(context.getFileRow("/docs/size.md")).toMatchObject({ size: 250 });
    expect(touchWorkspaceWriteStats).toHaveBeenLastCalledWith(
      "ws_123",
      expect.objectContaining({
        fileCountDelta: 0,
        bytesStoredDelta: 150,
      }),
    );

    const deleteResponse = await handleBulkWrite(
      context,
      createBulkWriteRequest({
        workspaceId: "ws_123",
        files: [
          {
            op: "delete",
            path: "/docs/size.md",
            baseRevision: "*",
          },
        ],
      }),
    );
    expect(deleteResponse.status).toBe(202);
    expect(context.getFileRow("/docs/size.md")).toBeNull();
    expect(touchWorkspaceWriteStats).toHaveBeenLastCalledWith(
      "ws_123",
      expect.objectContaining({
        fileCountDelta: -1,
        bytesStoredDelta: -250,
      }),
    );
    expect(syncWorkspaceStats).not.toHaveBeenCalled();
  });

  it("uses bounded stats touches for all admitted FS hot write handlers", async () => {
    const assertBoundedStatsTouch = async (
      label: string,
      act: (
        context: WorkspaceFsContext,
      ) => Promise<{ status: number } | Response>,
    ) => {
      const { context, syncWorkspaceStats, touchWorkspaceWriteStats } =
        createContext({});

      const result = await act(context);

      expect(result.status, label).toBe(202);
      expect(syncWorkspaceStats, label).not.toHaveBeenCalled();
      expect(touchWorkspaceWriteStats, label).toHaveBeenCalledWith(
        "ws_123",
        expect.objectContaining({
          lastEventAt: expect.any(String),
          lastActivity: expect.any(String),
        }),
      );
    };

    await assertBoundedStatsTouch("handleWriteFile", (context) =>
      handleWriteFile(
        context,
        createWriteRequest({
          content: "# json\n",
          contentType: "text/markdown",
        }),
      ),
    );

    await assertBoundedStatsTouch("handleWriteFileStream", (context) =>
      handleWriteFile(
        context,
        new Request("https://relayfile.test/v1/workspaces/ws_123/fs/file", {
          method: "PUT",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Relayfile-Path": "/docs/stream.md",
            "X-Relayfile-Encoding": "utf-8",
            "X-Relayfile-Content-Type": "text/markdown",
            "If-Match": "0",
            "X-Correlation-Id": "corr_stream",
          },
          body: new TextEncoder().encode("# stream\n"),
        }),
      ),
    );

    await assertBoundedStatsTouch("handleDeleteFile", async (context) => {
      const statsContext = context as unknown as {
        syncWorkspaceStats: ReturnType<typeof vi.fn>;
        touchWorkspaceWriteStats: ReturnType<typeof vi.fn>;
      };
      const createResponse = await handleWriteFile(
        context,
        createWriteRequest({
          content: "# delete me\n",
          contentType: "text/markdown",
        }),
      );
      expect(createResponse.status).toBe(202);
      statsContext.syncWorkspaceStats.mockClear();
      statsContext.touchWorkspaceWriteStats.mockClear();
      return handleDeleteFile(
        context,
        createDeleteRequest({ path: "/docs/readme.md", ifMatch: "*" }),
      );
    });

    await assertBoundedStatsTouch("handleBulkWrite", (context) =>
      handleBulkWrite(
        context,
        createBulkWriteRequest({
          workspaceId: "ws_123",
          files: [
            {
              path: "/docs/bulk.md",
              content: "# bulk\n",
              contentType: "text/markdown",
            },
          ],
        }),
      ),
    );

    await assertBoundedStatsTouch("handleRegisterImportedContent", (context) =>
      handleRegisterImportedContent(
        context,
        createBulkWriteRequest({
          workspaceId: "ws_123",
          files: [
            {
              path: "/docs/imported.md",
              contentRef: "content/ws_123/docs/imported.md/rev_imported",
              contentType: "text/markdown",
              size: 11,
              encoding: "utf-8",
              contentHash:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            },
          ],
        }),
      ),
    );
  });

  it("writes edited bulk draft content when the content hash changes", async () => {
    const { context, dedupPut, putObject, recordMutation } = createContext({});
    const editedContent =
      '{"channel":"C123","text":"edited writeback idempotency"}\n';
    const editedHash = createHash("sha256")
      .update(editedContent, "utf-8")
      .digest("hex");
    const editedKey = `${GOLDEN_WORKSPACE_ID}:${GOLDEN_WRITEBACK_PATH}:${editedHash}`;

    const first = await bulkWrite(
      context,
      GOLDEN_WORKSPACE_ID,
      [
        {
          path: GOLDEN_WRITEBACK_PATH,
          content: GOLDEN_WRITEBACK_CONTENT,
          contentType: "application/json",
          contentIdentity: {
            kind: WRITEBACK_DRAFT_IDENTITY_KIND,
            key: GOLDEN_WRITEBACK_IDENTITY_KEY,
            ttlSeconds: WRITEBACK_DRAFT_TTL_SECONDS,
          },
        },
      ],
      "corr_writeback_1",
      createClaims(),
    );
    const edited = await bulkWrite(
      context,
      GOLDEN_WORKSPACE_ID,
      [
        {
          path: GOLDEN_WRITEBACK_PATH,
          content: editedContent,
          contentType: "application/json",
          contentIdentity: {
            kind: WRITEBACK_DRAFT_IDENTITY_KIND,
            key: editedKey,
            ttlSeconds: WRITEBACK_DRAFT_TTL_SECONDS,
          },
        },
      ],
      "corr_writeback_edited",
      createClaims(),
    );

    expect(first.written).toBe(1);
    expect(edited.written).toBe(1);
    expect(edited.dedupedFiles).toBeUndefined();
    expect(putObject).toHaveBeenCalledTimes(2);
    expect(recordMutation).toHaveBeenCalledTimes(2);
    expect(dedupPut.mock.calls.map((call) => call[0])).toEqual([
      expectedDedupHash(
        GOLDEN_WORKSPACE_ID,
        WRITEBACK_DRAFT_IDENTITY_KIND,
        GOLDEN_WRITEBACK_IDENTITY_KEY,
      ),
      expectedDedupHash(
        GOLDEN_WORKSPACE_ID,
        WRITEBACK_DRAFT_IDENTITY_KIND,
        editedKey,
      ),
    ]);
  });

  it("does not collide bulk dedup keys across paths or workspaces", async () => {
    const { context, dedupPut, putObject, recordMutation } = createContext({});
    const otherPath = "/slack/channels/C123/messages/messages other.json";
    const otherPathKey = `${GOLDEN_WORKSPACE_ID}:${otherPath}:${GOLDEN_WRITEBACK_CONTENT_HASH}`;
    const otherWorkspaceId = "ws_other";
    const otherWorkspaceKey = `${otherWorkspaceId}:${GOLDEN_WRITEBACK_PATH}:${GOLDEN_WRITEBACK_CONTENT_HASH}`;

    const sameWorkspace = await bulkWrite(
      context,
      GOLDEN_WORKSPACE_ID,
      [
        {
          path: GOLDEN_WRITEBACK_PATH,
          content: GOLDEN_WRITEBACK_CONTENT,
          contentType: "application/json",
          contentIdentity: {
            kind: WRITEBACK_DRAFT_IDENTITY_KIND,
            key: GOLDEN_WRITEBACK_IDENTITY_KEY,
            ttlSeconds: WRITEBACK_DRAFT_TTL_SECONDS,
          },
        },
        {
          path: otherPath,
          content: GOLDEN_WRITEBACK_CONTENT,
          contentType: "application/json",
          contentIdentity: {
            kind: WRITEBACK_DRAFT_IDENTITY_KIND,
            key: otherPathKey,
            ttlSeconds: WRITEBACK_DRAFT_TTL_SECONDS,
          },
        },
      ],
      "corr_same_workspace",
      createClaims(),
    );
    const otherWorkspace = await bulkWrite(
      context,
      otherWorkspaceId,
      [
        {
          path: GOLDEN_WRITEBACK_PATH,
          content: GOLDEN_WRITEBACK_CONTENT,
          contentType: "application/json",
          contentIdentity: {
            kind: WRITEBACK_DRAFT_IDENTITY_KIND,
            key: otherWorkspaceKey,
            ttlSeconds: WRITEBACK_DRAFT_TTL_SECONDS,
          },
        },
      ],
      "corr_other_workspace",
      createClaims({ workspaceId: otherWorkspaceId }),
    );

    expect(sameWorkspace.written).toBe(2);
    expect(otherWorkspace.written).toBe(1);
    expect(putObject).toHaveBeenCalledTimes(3);
    expect(recordMutation).toHaveBeenCalledTimes(3);
    expect(dedupPut.mock.calls.map((call) => call[0])).toEqual([
      expectedDedupHash(
        GOLDEN_WORKSPACE_ID,
        WRITEBACK_DRAFT_IDENTITY_KIND,
        GOLDEN_WRITEBACK_IDENTITY_KEY,
      ),
      expectedDedupHash(
        GOLDEN_WORKSPACE_ID,
        WRITEBACK_DRAFT_IDENTITY_KIND,
        otherPathKey,
      ),
      expectedDedupHash(
        otherWorkspaceId,
        WRITEBACK_DRAFT_IDENTITY_KIND,
        otherWorkspaceKey,
      ),
    ]);
  });

  it("misses bulk dedup after an expired short TTL and dedupes within the chosen TTL", async () => {
    const { context, advanceDedupTime, dedupPut, putObject, recordMutation } =
      createContext({});
    const shortTtlIdentity = {
      kind: WRITEBACK_DRAFT_IDENTITY_KIND,
      key: `${GOLDEN_WRITEBACK_IDENTITY_KEY}:short-ttl-control`,
      ttlSeconds: 60,
    };
    const longTtlIdentity = {
      kind: WRITEBACK_DRAFT_IDENTITY_KIND,
      key: `${GOLDEN_WRITEBACK_IDENTITY_KEY}:long-ttl-control`,
      ttlSeconds: WRITEBACK_DRAFT_TTL_SECONDS,
    };

    const writeDraft = (contentIdentity: typeof shortTtlIdentity) =>
      bulkWrite(
        context,
        GOLDEN_WORKSPACE_ID,
        [
          {
            path: GOLDEN_WRITEBACK_PATH,
            content: GOLDEN_WRITEBACK_CONTENT,
            contentType: "application/json",
            contentIdentity,
          },
        ],
        `corr_${contentIdentity.key.split(":").at(-1)}`,
        createClaims(),
      );

    const shortFirst = await writeDraft(shortTtlIdentity);
    advanceDedupTime(61_000);
    const shortAfterExpiry = await writeDraft(shortTtlIdentity);
    const longFirst = await writeDraft(longTtlIdentity);
    advanceDedupTime(61_000);
    const longReplay = await writeDraft(longTtlIdentity);

    expect(shortFirst.written).toBe(1);
    expect(shortAfterExpiry.written).toBe(1);
    expect(shortAfterExpiry.dedupedFiles).toBeUndefined();
    expect(longFirst.written).toBe(1);
    expect(longReplay.written).toBe(0);
    expect(longReplay.dedupedFiles).toEqual([
      {
        path: GOLDEN_WRITEBACK_PATH,
        deduped: true,
        originalWriter: "test-agent",
        revision: null,
      },
    ]);
    expect(putObject).toHaveBeenCalledTimes(3);
    expect(recordMutation).toHaveBeenCalledTimes(3);
    expect(dedupPut).toHaveBeenCalledTimes(3);
  });

  it("drops a stale single-file write after a lost monotonic upsert", async () => {
    const { context, putObject, deleteContent, sqlExec, recordMutation } =
      createContext({
        staleWritePaths: new Set(["/docs/readme.md"]),
      });

    const response = await handleWriteFile(
      context,
      createWriteRequest({
        content: "# stale",
        contentType: "text/markdown",
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "revision_conflict",
      currentRevision: "rev_999",
    });
    expect(putObject).toHaveBeenCalledOnce();
    expect(sqlExec).toHaveBeenCalledOnce();
    expect(deleteContent).toHaveBeenCalledWith(
      "content/ws_123/docs/readme.md/rev_123",
    );
    expect(recordMutation).not.toHaveBeenCalled();
  });

  it("rejects ACL marker writes without admin:acl scope", async () => {
    const { context, putObject, sqlExec, recordMutation } = createContext({});

    const response = await handleWriteFile(
      context,
      createWriteRequest(
        {
          content: "scope:finance",
          contentType: "text/plain",
          semantics: {
            permissions: ["scope:finance"],
          },
        },
        "/notion/private/.relayfile.acl",
      ),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "forbidden",
    });
    expect(putObject).not.toHaveBeenCalled();
    expect(sqlExec).not.toHaveBeenCalled();
    expect(recordMutation).not.toHaveBeenCalled();
  });

  it("allows ACL marker writes with admin:acl scope", async () => {
    const { context, putObject, sqlExec, recordMutation } = createContext({
      claims: createClaims({ scopes: new Set(["fs:write", "admin:acl"]) }),
    });

    const response = await handleWriteFile(
      context,
      createWriteRequest(
        {
          content: "scope:finance",
          contentType: "text/plain",
          semantics: {
            permissions: ["scope:finance"],
          },
        },
        "/notion/private/.relayfile.acl",
      ),
    );

    expect(response.status).toBe(202);
    expectSourceWriteWithDeferredDigest(
      putObject,
      sqlExec,
      context.scheduleDigestRefresh as ReturnType<typeof vi.fn>,
      "/notion/private/.relayfile.acl",
    );
    expect(recordMutation).toHaveBeenCalledOnce();
  });

  it("rejects ACL marker bulk writes without admin:acl scope", async () => {
    const { context, putObject, sqlExec, recordMutation } = createContext({});

    const response = await bulkWrite(
      context,
      "ws_123",
      [
        {
          path: "/notion/private/.relayfile.acl",
          content: "scope:finance",
          contentType: "text/plain",
          semantics: {
            permissions: ["scope:finance"],
          },
        },
      ],
      "corr_123",
      createClaims(),
    );

    expect(response.written).toBe(0);
    expect(response.errorCount).toBe(1);
    expect(response.errors).toEqual([
      {
        path: "/notion/private/.relayfile.acl",
        code: "forbidden",
        message: "ACL marker mutation requires admin:acl scope",
      },
    ]);
    expect(putObject).not.toHaveBeenCalled();
    expect(sqlExec).not.toHaveBeenCalled();
    expect(recordMutation).not.toHaveBeenCalled();
  });

  it("skips dependent bulk entries when an earlier dependency fails", async () => {
    const { context, putObject, sqlExec, recordMutation } = createContext({});

    const response = await bulkWrite(
      context,
      "ws_123",
      [
        {
          path: "/linear/issues/AGE-1__issue-1.json",
          content: "not-base64",
          contentType: "application/json",
          encoding: "base64",
        },
        {
          path: "/linear/issues/by-uuid/issue-1.json",
          dependsOn: ["/linear/issues/AGE-1__issue-1.json"],
          content: "{}",
          contentType: "application/json",
        },
      ],
      "corr_123",
      createClaims(),
    );

    expect(response.written).toBe(0);
    expect(response.errorCount).toBe(2);
    expect(response.errors).toEqual([
      {
        path: "/linear/issues/AGE-1__issue-1.json",
        code: "invalid_content",
        message: "invalid content encoding",
      },
      {
        path: "/linear/issues/by-uuid/issue-1.json",
        code: "dependency_failed",
        message:
          "dependent bulk write skipped because /linear/issues/AGE-1__issue-1.json failed",
      },
    ]);
    expect(putObject).not.toHaveBeenCalled();
    expect(sqlExec).not.toHaveBeenCalled();
    expect(recordMutation).not.toHaveBeenCalled();
  });

  it("drops stale bulk write entries after a lost monotonic upsert", async () => {
    const { context, putObject, deleteContent, sqlExec, recordMutation } =
      createContext({
        staleWritePaths: new Set(["/docs/readme.md"]),
      });

    const response = await bulkWrite(
      context,
      "ws_123",
      [
        {
          path: "/docs/readme.md",
          content: "# stale",
          contentType: "text/markdown",
        },
      ],
      "corr_123",
      createClaims(),
    );

    expect(response).toMatchObject({
      written: 0,
      errorCount: 1,
      errors: [
        {
          path: "/docs/readme.md",
          code: "revision_conflict",
          message: "newer revision already exists",
        },
      ],
    });
    expect(putObject).toHaveBeenCalledOnce();
    expect(sqlExec).toHaveBeenCalledOnce();
    expect(deleteContent).toHaveBeenCalledWith(
      "content/ws_123/docs/readme.md/rev_123",
    );
    expect(recordMutation).not.toHaveBeenCalled();
  });

  it("flushes bulk write rows before recording visible mutations", async () => {
    const { context, order, flushStorage, putObject, recordMutation } =
      createContext({
        withFlushStorage: true,
      });
    const committedPaths: string[] = [];

    const response = await bulkWrite(
      context,
      "ws_123",
      [
        {
          path: "/docs/readme.md",
          content: "# updated",
          contentType: "text/markdown",
        },
      ],
      "corr_123",
      createClaims(),
      {
        onCommittedPath: (path) => {
          committedPaths.push(path);
        },
      },
    );

    expect(response.written).toBe(1);
    expect(flushStorage).toHaveBeenCalledTimes(2);
    expect(putObject).toHaveBeenCalledOnce();
    expect(order).toEqual([
      "putObject",
      "sqlExec",
      "flushStorage",
      "recordMutation",
      "flushStorage",
    ]);
    expect(committedPaths).toEqual(["/docs/readme.md"]);
    expect(recordMutation).toHaveBeenCalledOnce();
  });

  it("records bulk-write mutations only after rows remain readable after chunk flush", async () => {
    const hiddenPath = "/linear/labels/by-id/label-hidden.json";
    const visiblePath = "/linear/labels/by-id/label-visible.json";
    const { context, flushStorage, putObject, recordMutation } = createContext({
      withFlushStorage: true,
      postFlushInvisiblePaths: new Set([hiddenPath]),
    });
    const committedPaths: string[] = [];

    const response = await bulkWrite(
      context,
      "ws_123",
      [
        {
          path: hiddenPath,
          content: "hidden",
          contentType: "application/json",
        },
        {
          path: visiblePath,
          content: "ok",
          contentType: "application/json",
        },
      ],
      "corr_123",
      createClaims({ agentName: "nango-sync-worker" }),
      {
        onCommittedPath: (path) => {
          committedPaths.push(path);
        },
      },
    );

    expect(response.written).toBe(1);
    expect(response.errorCount).toBe(1);
    expect(response.errors).toEqual([
      {
        path: hiddenPath,
        code: "commit_not_visible",
        message: "bulk write was not readable after commit",
      },
    ]);
    expect(response.bytesWritten).toBe(2);
    expect(response.bytesStoredDelta).toBe(2);
    expect(response.fileCountDelta).toBe(1);
    expect(flushStorage).toHaveBeenCalledTimes(2);
    expect(putObject).toHaveBeenCalledTimes(2);
    expect(recordMutation).toHaveBeenCalledOnce();
    expect(recordMutation.mock.calls[0]?.[0]?.path).toBe(visiblePath);
    expect(committedPaths).toEqual([visiblePath]);
  });

  it("does not record a mutation when a bulk write is not visible after commit", async () => {
    const hiddenPath = "/linear/labels/by-id/label-hidden.json";
    const { context, flushStorage, putObject, deleteContent, recordMutation } =
      createContext({
        withFlushStorage: true,
        postFlushInvisiblePaths: new Set([hiddenPath]),
      });
    const committedPaths: string[] = [];

    const response = await bulkWrite(
      context,
      "ws_123",
      [
        {
          path: hiddenPath,
          content: "hidden",
          contentType: "application/json",
        },
      ],
      "corr_123",
      createClaims({ agentName: "nango-sync-worker" }),
      {
        onCommittedPath: (path) => {
          committedPaths.push(path);
        },
      },
    );

    expect(response.written).toBe(0);
    expect(response.errorCount).toBe(1);
    expect(response.errors).toEqual([
      {
        path: hiddenPath,
        code: "commit_not_visible",
        message: "bulk write was not readable after commit",
      },
    ]);
    expect(flushStorage).toHaveBeenCalledOnce();
    expect(putObject).toHaveBeenCalledOnce();
    expect(deleteContent).toHaveBeenCalledWith(
      `content/ws_123${hiddenPath}/rev_123`,
    );
    expect(recordMutation).not.toHaveBeenCalled();
    expect(committedPaths).toEqual([]);
  });

  it("keeps #1166 clone ingest ordering safe by delaying broadcasts until the chunk-end flush", async () => {
    // #1166 restored a pre-R2 flush for single-file writes so daemon reads
    // could not observe content ahead of durable SQL state. Clone bulk ingest
    // is safe with one chunk-end flush because materialization starts only
    // after the clone worker writes its sentinel after all chunks.
    const { context, order, flushStorage, putObject, recordMutation } =
      createContext({
        withFlushStorage: true,
      });

    const response = await bulkWrite(
      context,
      "ws_123",
      [
        {
          path: "/github/repos/org/repo/a.json",
          content: "a",
          contentType: "application/json",
        },
        {
          path: "/github/repos/org/repo/b.json",
          content: "bb",
          contentType: "application/json",
        },
      ],
      "github-clone-job:clone_job_123:chunk:0",
      createClaims({ agentName: "github-clone-worker" }),
    );

    expect(response.written).toBe(2);
    expect(putObject).toHaveBeenCalledTimes(2);
    expect(recordMutation).toHaveBeenCalledTimes(2);
    expect(flushStorage).toHaveBeenCalledTimes(2);
    expect(order).toEqual([
      "putObject",
      "sqlExec",
      "putObject",
      "sqlExec",
      "flushStorage",
      "recordMutation",
      "recordMutation",
      "flushStorage",
    ]);
  });

  it("records provider-sync events after the chunk-end visibility flush", async () => {
    const { context, order, flushStorage, putObject, recordMutation } =
      createContext({
        withFlushStorage: true,
        simulateProviderSyncFlush: true,
      });

    const response = await bulkWrite(
      context,
      "ws_123",
      [
        {
          path: "/github/repos/org/repo/a.json",
          content: "a",
          contentType: "application/json",
        },
        {
          path: "/github/repos/org/repo/b.json",
          content: "bb",
          contentType: "application/json",
        },
        {
          path: "/github/repos/org/repo/c.json",
          content: "ccc",
          contentType: "application/json",
        },
      ],
      "corr_123",
      createClaims({ agentName: "nango-sync-worker" }),
    );

    expect(response.written).toBe(3);
    expect(putObject).toHaveBeenCalledTimes(3);
    expect(recordMutation).toHaveBeenCalledTimes(3);
    expect(recordMutation.mock.calls.map(([input]) => input?.path)).toEqual([
      "/github/repos/org/repo/a.json",
      "/github/repos/org/repo/b.json",
      "/github/repos/org/repo/c.json",
    ]);
    expect(recordMutation.mock.calls.map(([input]) => input?.origin)).toEqual([
      "provider_sync",
      "provider_sync",
      "provider_sync",
    ]);
    expect(flushStorage).toHaveBeenCalledTimes(2);
    expect(order.at(-1)).toBe("flushStorage");
  });

  it("bulk writes a 3000-file provider-sync chunk without per-file durability flushes", async () => {
    const { context, flushStorage, putObject, recordMutation } = createContext({
      withFlushStorage: true,
      simulateProviderSyncFlush: true,
    });
    const files = Array.from({ length: 3000 }, (_, index) => ({
      path: `/github/repos/org/repo/file-${String(index).padStart(4, "0")}.json`,
      content: `{"index":${index}}`,
      contentType: "application/json",
    }));
    const startedAt = Date.now();

    const response = await bulkWrite(
      context,
      "ws_123",
      files,
      "corr_123",
      createClaims({ agentName: "nango-sync-worker" }),
    );

    expect(response.written).toBe(3000);
    expect(response.errorCount).toBe(0);
    expect(putObject).toHaveBeenCalledTimes(3000);
    expect(recordMutation).toHaveBeenCalledTimes(3000);
    expect(flushStorage).toHaveBeenCalledTimes(2);
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it("logs GitHub clone bulk write completion with jobId and chunk metrics", async () => {
    const { context } = createContext({
      withFlushStorage: true,
    });
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    try {
      const response = await handleBulkWrite(
        context,
        createBulkWriteRequest(
          {
            workspaceId: "ws_123",
            files: [
              {
                path: "/github/repos/org/repo/a.json",
                content: "abc",
                contentType: "application/json",
              },
              {
                path: "/github/repos/org/repo/b.json",
                content: "defg",
                contentType: "application/json",
              },
            ],
          },
          "github-clone-job:clone_job_123:chunk:0",
        ),
      );

      expect(response.status).toBe(202);
      expect(infoSpy).toHaveBeenCalledWith(
        "relayfile.github_clone.bulk_write.completed",
        expect.objectContaining({
          jobId: "clone_job_123",
          workspaceId: "ws_123",
          files: 2,
          bytes: 7,
          syncCount: 2,
          durationMs: expect.any(Number),
        }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("passes through contentIdentity ttlSeconds overrides to KV put", async () => {
    const { context, dedupPut, putObject, sqlExec, recordMutation } =
      createContext({});

    const response = await handleWriteFile(
      context,
      createWriteRequest({
        content: "# updated",
        contentType: "text/markdown",
        contentIdentity: {
          kind: "github-clone",
          key: "owner/repo@main",
          ttlSeconds: 30,
        },
      }),
    );

    expect(response.status).toBe(202);
    // ttlSeconds: 30 is clamped up to the Cloudflare KV minimum of 60s.
    expect(dedupPut).toHaveBeenCalledWith(
      expectedDedupHash("ws_123", "github-clone", "owner/repo@main"),
      expect.any(String),
      { expirationTtl: 60 },
    );
    expectSourceWriteWithDeferredDigest(
      putObject,
      sqlExec,
      context.scheduleDigestRefresh as ReturnType<typeof vi.fn>,
    );
    expect(recordMutation).toHaveBeenCalledOnce();
  });

  // Regression: synced records (e.g. /notion/pages/<id>.json from Nango
  // fetch-pages) were being written through the same writeFile handler as
  // user/agent writes, which dispatched a writeback op for every record.
  // The writeback queue consumer then tried to UPDATE the upstream record
  // via the Notion adapter and failed permanently because the synced
  // payload lacks `properties`. The cloud must mark these writes with
  // `origin="provider_sync"` based on the JWT agentName so recordMutation
  // can skip op creation entirely.
  it.each(["nango-sync-worker", "nango-sync-workflow"])(
    "tags writes from %s with origin=provider_sync",
    async (agentName) => {
      const { context, recordMutation } = createContext({
        claims: createClaims({ agentName }),
      });

      const response = await handleWriteFile(
        context,
        createWriteRequest({
          content: JSON.stringify({
            id: "page_1",
            title: "Synced Page",
            url: "https://www.notion.so/Synced-Page",
            parent_type: "workspace",
            parent_id: "ws",
            last_edited_time: "2026-05-07T10:00:00.000Z",
            content_preview: "...",
          }),
          contentType: "application/json; charset=utf-8",
        }),
      );

      expect(response.status).toBe(202);
      expect(recordMutation).toHaveBeenCalledOnce();
      expect(recordMutation).toHaveBeenCalledWith(
        expect.objectContaining({ origin: "provider_sync" }),
      );
    },
  );

  it.each([
    [
      "/discovery/github/.adapter.md",
      "# GitHub adapter\n\nProvider contract for GitHub.",
      "text/markdown; charset=utf-8",
      "discovery",
    ],
    [
      "/github/repos/AgentWorkforce/cloud/issues/1190__e2e-probe-6-atomic-opened-with-label/meta.json",
      JSON.stringify({
        id: 1190,
        number: 1190,
        title: "e2e probe 6 atomic opened with label",
        state: "open",
      }),
      "application/json; charset=utf-8",
      "github",
    ],
  ])(
    "tags cloud-github provider-ingest writes to %s with origin=provider_sync",
    async (path, content, contentType, provider) => {
      const { context, recordMutation } = createContext({
        claims: createClaims({ agentName: "cloud-github" }),
      });

      const response = await handleWriteFile(
        context,
        createWriteRequest(
          {
            content,
            contentType,
          },
          path,
        ),
      );

      expect(response.status).toBe(202);
      expect(recordMutation).toHaveBeenCalledOnce();
      expect(recordMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          origin: "provider_sync",
          path,
          provider,
        }),
      );
    },
  );

  it("tags writes from a regular agent with origin=agent_write", async () => {
    const { context, recordMutation } = createContext({
      claims: createClaims({ agentName: "ricky" }),
    });

    await handleWriteFile(
      context,
      createWriteRequest({
        content: "# updated",
        contentType: "text/markdown",
      }),
    );

    expect(recordMutation).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "agent_write" }),
    );
  });

  it.each(["nango-sync-worker", "nango-sync-workflow"])(
    "tags bulk writes from %s with origin=provider_sync",
    async (agentName) => {
      const { context, recordMutation } = createContext({});

      await bulkWrite(
        context,
        "ws_123",
        [
          {
            path: "/notion/pages/abc123.json",
            content: JSON.stringify({
              id: "abc123",
              title: "Synced",
              url: "https://www.notion.so/abc123",
              parent_type: "workspace",
              parent_id: "ws",
              last_edited_time: "2026-05-07T10:00:00.000Z",
              content_preview: "...",
            }),
            contentType: "application/json; charset=utf-8",
          },
        ],
        "corr_123",
        createClaims({ agentName }),
      );

      expect(recordMutation).toHaveBeenCalledWith(
        expect.objectContaining({ origin: "provider_sync" }),
      );
    },
  );

  it("writes GitHub clone cache bulk entries as provider-sync events without writeback", async () => {
    const { context, putObject, sqlExec, recordMutation, flushStorage } =
      createContext({
        withFlushStorage: true,
      });

    const response = await bulkWrite(
      context,
      "ws_123",
      [
        {
          path: "/github/repos/acme/demo/contents/README.md@abc123.json",
          content: "# Demo\n",
          contentType: "text/markdown",
        },
        {
          path: "/github/repos/acme/demo/contents/src/index.ts@abc123.json",
          content: "export const demo = true;\n",
          contentType: "text/plain; charset=utf-8",
        },
      ],
      "github-clone-job:clone_job_123:chunk:0",
      createClaims({ agentName: "github-clone-worker" }),
    );

    expect(response.written).toBe(2);
    expect(response.syncCount).toBe(2);
    expect(putObject).toHaveBeenCalledTimes(2);
    expect(sqlExec).toHaveBeenCalledTimes(2);
    expect(recordMutation).toHaveBeenCalledTimes(2);
    expect(recordMutation.mock.calls.map(([input]) => input?.origin)).toEqual([
      "provider_sync",
      "provider_sync",
    ]);
    expect(flushStorage).toHaveBeenCalledTimes(2);
  });

  it("lists GitHub provider-sync rows after the write path commits a revision", async () => {
    const { context, recordMutation, flushStorage } = createContext({
      withFlushStorage: true,
    });
    const issueRoot =
      "/github/repos/AgentWorkforce/cloud/issues/1588__e2e-probe";
    const metaPath = `${issueRoot}/meta.json`;

    const response = await bulkWrite(
      context,
      "ws_123",
      [
        {
          path: metaPath,
          content: JSON.stringify({
            provider: "github",
            objectType: "issue",
            objectId: 1588,
          }),
          contentType: "application/json",
        },
      ],
      "github-clone-job:clone_job_123:chunk:0",
      createClaims({ agentName: "github-clone-worker" }),
    );

    expect(response.written).toBe(1);
    expect(response.syncCount).toBe(2);
    expect(context.getFileRow(metaPath)).toMatchObject({
      path: metaPath,
      revision: "rev_123",
    });
    expect(recordMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: "provider_sync",
        path: metaPath,
        revision: "rev_123",
      }),
    );
    expect(flushStorage).toHaveBeenCalledTimes(2);
    expect(
      listTree(context, "ws_123", "/github", 2, null, null).entries,
    ).not.toEqual([]);
    expect(
      listTree(
        context,
        "ws_123",
        "/github/repos/AgentWorkforce/cloud/issues",
        2,
        null,
        null,
      ).entries,
    ).not.toEqual([]);
    expect(
      listTree(context, "ws_123", issueRoot, 2, null, null).entries,
    ).not.toEqual([]);
  });

  it("does not schedule digest refreshes for GitHub clone cache bulk writes", async () => {
    const {
      context,
      putObject,
      sqlExec,
      recordMutation,
      scheduleDigestRefresh,
    } = createContext({
      claims: createClaims({ agentName: "github-clone-worker" }),
      withFlushStorage: true,
    });

    const response = await handleBulkWrite(
      context,
      createBulkWriteRequest({
        workspaceId: "ws_123",
        files: [
          {
            path: "/github/repos/acme/demo/contents/README.md@abc123.json",
            content: "# Demo\n",
            contentType: "text/markdown",
          },
        ],
      }),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      written: 1,
      errorCount: 0,
    });
    expect(putObject).toHaveBeenCalledOnce();
    expect(sqlExec).toHaveBeenCalledOnce();
    expect(recordMutation).toHaveBeenCalledOnce();
    expect(recordMutation).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "provider_sync" }),
    );
    expect(scheduleDigestRefresh).not.toHaveBeenCalled();
  });
});
