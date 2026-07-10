import { describe, expect, it, vi } from "vitest";
import {
  AVG_FILE_ROW_BYTES,
  decideAdmission,
  estimateRequestFootprint,
  resolveDoMemoryBudgetBytes,
} from "../src/durable-objects/admission.js";
import {
  handleExportManifest,
  type WorkspaceFsContext,
} from "../src/durable-objects/handlers/fs.js";
import type { WorkspaceEvent, WorkspaceFile } from "../src/types.js";

/**
 * Hardening item 4 tests: per-workspace admission control rejects
 * requests that would exceed the DO memory budget BEFORE the heavy work
 * begins, with a typed error code the SDK can read.
 */

type Row = Record<string, unknown>;

function makeWorkspaceFile(
  overrides: Partial<WorkspaceFile> = {},
): WorkspaceFile {
  return {
    path: "/x.md",
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
    resolveWorkspaceId: async (_r: Request, body?: { workspaceId?: string }) =>
      body?.workspaceId ?? "ws_test",
    getRequestClaims: async () => null,
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
    contentRef: () => "ref",
    recordMutation: vi.fn(),
    syncWorkspaceStats: vi.fn(),
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
    bindings: {},
    ...overrides,
  } as unknown as WorkspaceFsContext;
}

describe("estimateRequestFootprint", () => {
  it("sums metadata bytes and body bytes", () => {
    const est = estimateRequestFootprint({
      fileCount: 1000,
      residentFileRows: 10,
    });
    expect(est.metadataBytes).toBe(10 * AVG_FILE_ROW_BYTES);
    expect(est.bodyBytes).toBe(0);
    expect(est.estimatedBytes).toBe(est.metadataBytes + est.bodyBytes);
  });
});

describe("decideAdmission", () => {
  it("admits when below budget", () => {
    const dec = decideAdmission(
      { fileCount: 10, residentFileRows: 10 },
      96 * 1024 * 1024,
    );
    expect(dec.admit).toBe(true);
  });

  it("rejects with workspace_too_large when metadata dominates", () => {
    const dec = decideAdmission(
      { fileCount: 1_000_000, residentFileRows: 1_000 },
      1024,
    );
    expect(dec.admit).toBe(false);
    if (!dec.admit) {
      expect(dec.reason).toBe("workspace_too_large");
      expect(dec.message).toContain("paginated tree/read");
    }
  });

  it("admits 5,000-file workspaces when only one bounded manifest page is resident", () => {
    const dec = decideAdmission(
      { fileCount: 5_000, residentFileRows: 1_000 },
      96 * 1024 * 1024,
    );
    expect(dec.admit).toBe(true);
  });

  it("rejects a genuinely heavy manifest page that exceeds the page budget", () => {
    const dec = decideAdmission(
      { fileCount: 5_000, residentFileRows: 1_000 },
      20 * 1024 * 1024,
    );
    expect(dec.admit).toBe(false);
    if (!dec.admit) {
      expect(dec.reason).toBe("workspace_too_large");
      expect(dec.message).toContain("single manifest page");
    }
  });

  it("can reject with the production budget when measured page bytes exceed it", () => {
    const dec = decideAdmission(
      {
        fileCount: 200,
        residentFileRows: 200,
        residentMetadataBytes: 97 * 1024 * 1024,
      },
      96 * 1024 * 1024,
    );
    expect(dec.admit).toBe(false);
  });
});

describe("resolveDoMemoryBudgetBytes", () => {
  it("uses the default when env var is absent", () => {
    expect(resolveDoMemoryBudgetBytes({})).toBe(96 * 1024 * 1024);
  });
  it("honors RELAYFILE_DO_MEMORY_BUDGET_BYTES", () => {
    expect(
      resolveDoMemoryBudgetBytes({
        RELAYFILE_DO_MEMORY_BUDGET_BYTES: "1024",
      }),
    ).toBe(1024);
  });
});

describe("handleExportManifest admission control", () => {
  it("returns 413 workspace_too_large when the bounded manifest page estimate exceeds budget", async () => {
    const ctx = makeFsContext({
      allRows: vi.fn((sql: string) => {
        if (sql.includes("COUNT(*)")) return [{ count: 100_000 }];
        if (sql.includes("FROM files")) {
          return [
            {
              path: "/large-semantics.md",
              semantics_json: JSON.stringify({ blob: "x".repeat(2048) }),
            },
          ];
        }
        return [];
      }),
      toWorkspaceFile: (row: Row) =>
        makeWorkspaceFile({ path: row.path as string }),
      bindings: {
        RELAYFILE_DO_MEMORY_BUDGET_BYTES: "1024",
        RELAYFILE_MAX_EXPORT_FILES: String(1_000_000),
      },
    });
    const req = new Request("https://do/internal/export-manifest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws_test" }),
    });
    const res = await handleExportManifest(ctx, req);
    expect(res.status).toBe(413);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("workspace_too_large");
    expect(body).toHaveProperty("budget");
    expect(body).toHaveProperty("estimate");
  });

  it("uses actual first-page row bytes so heavy semantics_json can reject", async () => {
    const semanticsJson = JSON.stringify({ blob: "x".repeat(1024 * 1024) });
    const rows = Array.from({ length: 3 }, (_, index) => ({
      path: `/heavy/${index}.json`,
      revision: "rev_1",
      content_type: "application/json",
      content_ref: `ref-${index}`,
      size: 10,
      encoding: "utf-8",
      updated_at: "2026-05-06T00:00:00.000Z",
      semantics_json: semanticsJson,
      provider: "notion",
      provider_object_id: `obj-${index}`,
      content_hash: "",
    }));
    const ctx = makeFsContext({
      allRows: vi.fn((sql: string) => {
        if (sql.includes("COUNT(*)")) return [{ count: rows.length }];
        if (sql.includes("FROM files")) return rows;
        return [];
      }),
      bindings: {
        RELAYFILE_DO_MEMORY_BUDGET_BYTES: String(2 * 1024 * 1024),
        RELAYFILE_MAX_EXPORT_FILES: String(1_000),
      },
    });
    const req = new Request("https://do/internal/export-manifest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws_test" }),
    });
    const res = await handleExportManifest(ctx, req);
    expect(res.status).toBe(413);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("workspace_too_large");
    expect(
      ((body.estimate as Record<string, unknown>).metadataBytes as number) >
        2 * 1024 * 1024,
    ).toBe(true);
  });

  it("admits workspaces above the old whole-table cutoff when export file count allows them", async () => {
    const ctx = makeFsContext({
      allRows: vi.fn((sql: string) => {
        if (sql.includes("COUNT(*)")) return [{ count: 5_000 }];
        return [];
      }),
      bindings: {
        RELAYFILE_MAX_EXPORT_FILES: String(50_000),
      },
    });
    const req = new Request("https://do/internal/export-manifest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws_test" }),
    });
    const res = await handleExportManifest(ctx, req);
    expect(res.status).toBe(200);
  });

  it("returns 413 on the first manifest request when projected export bytes exceed the worker limit", async () => {
    const allRows = vi.fn((sql: string) => {
      if (sql.includes("SELECT path, size")) {
        return [
          { path: "/large-a.md", size: 600_000 },
          { path: "/large-b.md", size: 600_000 },
        ];
      }
      if (sql.includes("SELECT path, revision")) {
        throw new Error("manifest page should not be loaded after body cap");
      }
      return [];
    });
    const ctx = makeFsContext({ allRows });
    const req = new Request("https://do/internal/export-manifest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws_test", maxBodyBytes: 1_000_000 }),
    });

    const res = await handleExportManifest(ctx, req);

    expect(res.status).toBe(413);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("payload_too_large");
    expect(body.message).toContain("paginated tree/read");
    expect(allRows).toHaveBeenCalledTimes(1);
  });

  it("admits normal-sized workspaces", async () => {
    const ctx = makeFsContext({
      allRows: vi.fn((sql: string) => {
        if (sql.includes("FROM files")) return [{ path: "/ok.md" }];
        return [];
      }),
      toWorkspaceFile: (row: Row) =>
        makeWorkspaceFile({ path: row.path as string }),
    });
    const req = new Request("https://do/internal/export-manifest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws_test" }),
    });
    const res = await handleExportManifest(ctx, req);
    expect(res.status).toBe(200);
  });
});
