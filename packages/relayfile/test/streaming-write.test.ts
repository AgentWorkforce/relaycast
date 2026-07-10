import { describe, expect, it, vi } from "vitest";
import {
  handleWriteFile,
  handleWriteFileStream,
  type WorkspaceFsContext,
} from "../src/durable-objects/handlers/fs.js";
import type { WorkspaceEvent, WorkspaceFile } from "../src/types.js";

/**
 * Hardening item 2: streaming writeback ingest must:
 *   - take application/octet-stream PUTs without buffering the body,
 *   - never call atob on the body,
 *   - compute a SHA-256 bit-identical to the buffered path's hashContent,
 *   - pipe the body straight to R2.put(ReadableStream).
 */

function makeWorkspaceFile(
  overrides: Partial<WorkspaceFile> = {},
): WorkspaceFile {
  return {
    path: "/notes/x.md",
    revision: "rev_1",
    contentType: "text/markdown",
    contentRef: "ref",
    size: 10,
    encoding: "utf-8",
    provider: "notion",
    providerObjectId: "",
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
    getRequestClaims: async () => null,
    json: (payload: unknown, status = 200, headers?: HeadersInit) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json", ...(headers ?? {}) },
      }),
    errorResponse: (
      _r: Request,
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
    putObject: vi.fn(),
    putObjectStream: vi.fn(),
    deleteContent: vi.fn(),
    contentRef: (_w: string, p: string, r: string) => `ref:${p}@${r}`,
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
    loadContent: vi.fn(),
    nextId: vi.fn(() => "rev_2"),
    toWorkspaceFile: vi.fn((row) => row as unknown as WorkspaceFile),
    toEvent: vi.fn((row) => row as unknown as WorkspaceEvent),
    toWorkspaceOperation: vi.fn(),
    // Digest regeneration is deferred to the DO alarm (cloud#846); fixtures
    // expose a spy so individual tests can assert the schedule call.
    scheduleDigestRefresh: vi.fn(async () => undefined),
    bindings: {},
    ...overrides,
  } as unknown as WorkspaceFsContext;
}

describe("handleWriteFile dispatches to streaming when Content-Type is application/octet-stream", () => {
  it("routes octet-stream requests through the streaming handler", async () => {
    const putStream = vi.fn(
      async (_ref: string, stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader();
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
        reader.releaseLock();
      },
    );
    // Simulate "row appeared in files table after INSERT" so the
    // upsertFileRowMonotonic check passes — getFileRow first returns
    // null (pre-existing check), then the just-inserted row.
    let inserted = false;
    const ctx = makeFsContext({
      putObjectStream: putStream,
      getFileRow: () =>
        inserted
          ? makeWorkspaceFile({
              revision: "rev_2",
              contentRef: "ref:/x.md@rev_2",
            })
          : null,
      sqlExec: (sql: string) => {
        if (sql.includes("INSERT INTO files")) inserted = true;
      },
    });

    const body = new TextEncoder().encode("hello world");
    const req = new Request("https://do/write-file?path=/x.md", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Relayfile-Path": "/x.md",
        "X-Relayfile-Encoding": "utf-8",
        "X-Relayfile-Content-Type": "text/markdown",
        "If-Match": "0",
      },
      body,
    });
    const res = await handleWriteFile(ctx, req);
    expect([200, 202]).toContain(res.status);
    expect(putStream).toHaveBeenCalledTimes(1);
    // putObject (the JSON-base64 path) must NOT have been called.
    expect(ctx.putObject).not.toHaveBeenCalled();
  });
});

describe("handleWriteFileStream", () => {
  it("computes a SHA-256 bit-identical to the buffered hashContent", async () => {
    const putStream = vi.fn(
      async (_ref: string, stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader();
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
        reader.releaseLock();
      },
    );
    let capturedHash = "";
    const ctx = makeFsContext({
      putObjectStream: putStream,
      // We can observe the recorded hash through the sqlExec call that
      // inserts/updates the files row. Cheaper to just inspect the SHA
      // here by intercepting `upsertFileRowMonotonic` via the spy on
      // `sqlExec` and `getFileRow`.
      sqlExec: vi.fn((sql: string, ...bindings: unknown[]) => {
        if (sql.includes("INSERT INTO files")) {
          // The contentHash is the LAST binding written before the
          // `RETURNING` clause — capture it.
          for (const b of bindings) {
            if (typeof b === "string" && /^[0-9a-f]{64}$/.test(b)) {
              capturedHash = b;
            }
          }
        }
      }),
    });

    const body = new TextEncoder().encode("hello world");
    const req = new Request("https://do/write-file", {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Relayfile-Path": "/x.md",
        "X-Relayfile-Encoding": "utf-8",
        "If-Match": "0",
      },
      body,
    });
    await handleWriteFileStream(ctx, req);

    const reference = new Uint8Array(
      await crypto.subtle.digest("SHA-256", body),
    );
    const refHex = Array.from(reference, (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    expect(capturedHash).toBe(refHex);
  });

  it("pipes the body straight to R2.put — never calls atob", async () => {
    const realAtob = globalThis.atob;
    const atobSpy = vi.fn((s: string) => realAtob(s));
    (globalThis as { atob: typeof atob }).atob = atobSpy as typeof atob;

    try {
      const putStream = vi.fn(
        async (_ref: string, stream: ReadableStream<Uint8Array>) => {
          // Drain to completion so the tee finishes.
          const reader = stream.getReader();
          for (;;) {
            const { done } = await reader.read();
            if (done) break;
          }
          reader.releaseLock();
        },
      );
      const ctx = makeFsContext({ putObjectStream: putStream });

      // 1 MiB body
      const body = new Uint8Array(1024 * 1024);
      for (let i = 0; i < body.length; i += 1) body[i] = i & 0xff;
      const req = new Request("https://do/write-file", {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Relayfile-Path": "/x.md",
          "If-Match": "0",
        },
        body,
      });
      await handleWriteFileStream(ctx, req);
      expect(atobSpy).not.toHaveBeenCalled();
      expect(putStream).toHaveBeenCalledTimes(1);
    } finally {
      (globalThis as { atob: typeof atob }).atob = realAtob;
    }
  });

  it("rejects with 412 when If-Match is missing", async () => {
    const ctx = makeFsContext({ putObjectStream: vi.fn() });
    const req = new Request("https://do/write-file", {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Relayfile-Path": "/x.md",
      },
      body: new Uint8Array(10),
    });
    const res = await handleWriteFileStream(ctx, req);
    expect(res.status).toBe(412);
  });

  it("rejects with 413 when the streamed body exceeds the byte cap", async () => {
    const putStream = vi.fn(
      async (_ref: string, stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader();
        try {
          for (;;) {
            const { done } = await reader.read();
            if (done) break;
          }
        } finally {
          reader.releaseLock();
        }
      },
    );
    const ctx = makeFsContext({
      putObjectStream: putStream,
      bindings: { RELAYFILE_MAX_WRITE_BYTES: "100" },
    });
    const body = new Uint8Array(500);
    const req = new Request("https://do/write-file", {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Relayfile-Path": "/x.md",
        "If-Match": "0",
      },
      body,
    });
    const res = await handleWriteFileStream(ctx, req);
    expect(res.status).toBe(413);
    expect(ctx.deleteContent).toHaveBeenCalled();
    expect(
      (ctx.sqlExec as ReturnType<typeof vi.fn>).mock.calls.some(([sql]) =>
        String(sql).includes("INSERT INTO files"),
      ),
    ).toBe(false);
  });

  it("stops reading a chunked stream as soon as the byte cap is exceeded", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(50));
        if (pulls >= 10) controller.close();
      },
    });
    const putStream = vi.fn(
      async (_ref: string, stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader();
        try {
          for (;;) {
            const { done } = await reader.read();
            if (done) break;
          }
        } finally {
          reader.releaseLock();
        }
      },
    );
    const ctx = makeFsContext({
      putObjectStream: putStream,
      bindings: { RELAYFILE_MAX_WRITE_BYTES: "100" },
    });
    const req = new Request("https://do/write-file", {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Relayfile-Path": "/x.md",
        "If-Match": "0",
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const res = await handleWriteFileStream(ctx, req);
    expect(res.status).toBe(413);
    expect(pulls).toBeLessThan(10);
    expect(ctx.deleteContent).toHaveBeenCalled();
  });

  it("deletes the allocated content ref when the streaming put fails", async () => {
    const putStream = vi.fn(async () => {
      throw new Error("r2 failed");
    });
    const ctx = makeFsContext({ putObjectStream: putStream });
    const req = new Request("https://do/write-file", {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Relayfile-Path": "/x.md",
        "If-Match": "0",
      },
      body: new Uint8Array(10),
    });
    const res = await handleWriteFileStream(ctx, req);
    expect(res.status).toBe(500);
    expect(ctx.deleteContent).toHaveBeenCalledWith("ref:/x.md@rev_2");
  });
});
