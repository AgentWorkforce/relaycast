import { describe, expect, it, vi } from "vitest";
import {
  EXPORT_FILE_PAGE_SIZE,
  listWorkspaceExportManifestPage,
  type WorkspaceAdapterContext,
} from "../src/durable-objects/adapter.js";
import {
  handleExportManifest,
  type WorkspaceFsContext,
} from "../src/durable-objects/handlers/fs.js";
import { RUNTIME_FILES } from "../src/durable-objects/runtime-files.js";
import type { TokenClaims } from "../src/middleware/auth.js";
import type { WorkspaceEvent, WorkspaceFile } from "../src/types.js";

/**
 * Hardening item 1 tests: the export manifest endpoint MUST return
 * metadata only (never a file body) and MUST page deterministically. The
 * parent Worker is the only component allowed to read R2 bodies during
 * export, so these tests assert the DO never calls `loadContent` for an
 * export manifest request.
 */

type Row = Record<string, unknown>;
const RUNTIME_PATHS = RUNTIME_FILES.map((file) => file.path);

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

function claimsWith(scopes: string[]): TokenClaims {
  return {
    workspaceId: "ws_test",
    agentName: "agent_test",
    scopes: new Set(scopes),
    exp: Math.floor(Date.now() / 1000) + 3600,
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
    json: (payload: unknown, status = 200, headers?: HeadersInit) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json", ...(headers ?? {}) },
      }),
    errorResponse: (
      _req: Request,
      status: number,
      code: string,
      message: string,
    ) =>
      new Response(JSON.stringify({ code, message }), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    correlationId: () => "corr_test",
    putObject: vi.fn(),
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
    // CRITICAL: a failing spy. The export manifest path must NEVER call
    // loadContent — that's the whole point of moving export out of the DO.
    loadContent: vi.fn(async () => {
      throw new Error(
        "loadContent must NOT be called during export-manifest paging",
      );
    }),
    nextId: vi.fn(() => "rev_2"),
    toWorkspaceFile: vi.fn((row) => row as unknown as WorkspaceFile),
    toEvent: vi.fn((row) => row as unknown as WorkspaceEvent),
    toWorkspaceOperation: vi.fn(),
    bindings: {},
    ...overrides,
  } as unknown as WorkspaceFsContext;
}

describe("listWorkspaceExportManifestPage", () => {
  it("paginates with WHERE path > ? on subsequent calls", () => {
    const rows: Row[] = Array.from(
      { length: EXPORT_FILE_PAGE_SIZE },
      (_, i) => ({
        path: `/p/${String(i).padStart(4, "0")}`,
      }),
    );

    const calls: { sql: string; bindings: unknown[] }[] = [];
    const ctx = {
      allRows: vi.fn((sql: string, ...bindings: unknown[]) => {
        calls.push({ sql, bindings });
        const cursor = typeof bindings[0] === "string" ? bindings[0] : null;
        return rows.filter((row) => !cursor || String(row.path) > cursor);
      }),
      toWorkspaceFile: (row: Row) =>
        makeWorkspaceFile({ path: row.path as string }),
      loadContent: vi.fn(async () => {
        throw new Error("manifest paging must not load content");
      }),
      getFileRow: () => null,
      getOperation: () => null,
      insertEvent: vi.fn(),
      nextId: () => "x",
      sqlExec: vi.fn(),
      toEvent: vi.fn(),
      toWorkspaceOperation: vi.fn(),
    } as unknown as WorkspaceAdapterContext;

    const page1 = listWorkspaceExportManifestPage(ctx, "ws_test", null, null);
    expect(calls[0]?.sql).toContain("ORDER BY path ASC");
    expect(calls[0]?.sql).toContain("LIMIT ?");
    expect(calls[0]?.sql).not.toContain("WHERE path > ?");
    expect(page1.entries).toHaveLength(EXPORT_FILE_PAGE_SIZE);
    expect(page1.entries[0]?.path).toBe("/.skills/activity-summary.md");
    expect(page1.nextCursor).toBe(
      `/p/${String(EXPORT_FILE_PAGE_SIZE - RUNTIME_PATHS.length - 1).padStart(4, "0")}`,
    );

    const page2 = listWorkspaceExportManifestPage(
      ctx,
      "ws_test",
      null,
      page1.nextCursor,
    );
    expect(calls[1]?.sql).toContain("WHERE path > ?");
    expect(calls[1]?.bindings[0]).toBe(page1.nextCursor);
    expect(page2.entries.map((entry) => entry.path)).toEqual([
      `/p/${String(EXPORT_FILE_PAGE_SIZE - RUNTIME_PATHS.length).padStart(4, "0")}`,
      `/p/${String(EXPORT_FILE_PAGE_SIZE - RUNTIME_PATHS.length + 1).padStart(4, "0")}`,
      `/p/${String(EXPORT_FILE_PAGE_SIZE - 1).padStart(4, "0")}`,
    ]);
    expect(page2.nextCursor).toBeNull();
  });

  it("never reads R2 content for any manifest entry", () => {
    const rows: Row[] = [{ path: "/a" }, { path: "/b" }];
    const loadContent = vi.fn(async () => {
      throw new Error("must not be called");
    });
    const ctx = {
      allRows: vi.fn(() => rows),
      toWorkspaceFile: (row: Row) =>
        makeWorkspaceFile({ path: row.path as string }),
      loadContent,
      getFileRow: () => null,
      getOperation: () => null,
      insertEvent: vi.fn(),
      nextId: () => "x",
      sqlExec: vi.fn(),
      toEvent: vi.fn(),
      toWorkspaceOperation: vi.fn(),
    } as unknown as WorkspaceAdapterContext;

    const page = listWorkspaceExportManifestPage(ctx, "ws_test", null, null);
    expect(page.entries.map((entry) => entry.path)).toEqual([
      ...RUNTIME_PATHS,
      "/a",
      "/b",
    ]);
    expect(loadContent).not.toHaveBeenCalled();
  });

  it("includes the hosted activity-summary skill in export manifests", () => {
    const ctx = {
      allRows: vi.fn(() => []),
      toWorkspaceFile: (row: Row) =>
        makeWorkspaceFile({ path: row.path as string }),
      loadContent: vi.fn(async () => {
        throw new Error("manifest paging must not load content");
      }),
      getFileRow: () => null,
      getOperation: () => null,
      insertEvent: vi.fn(),
      nextId: () => "x",
      sqlExec: vi.fn(),
      toEvent: vi.fn(),
      toWorkspaceOperation: vi.fn(),
    } as unknown as WorkspaceAdapterContext;

    const page = listWorkspaceExportManifestPage(ctx, "ws_test", null, null);

    expect(page.entries).toContainEqual(
      expect.objectContaining({
        path: "/.skills/activity-summary.md",
        contentRef: "runtime:activity-summary",
        provider: "runtime",
      }),
    );
  });

  it("continues past ACL-denied rows without truncating later allowed entries", () => {
    const files = [
      makeWorkspaceFile({
        path: "/docs/a-denied.md",
        semanticsJson: JSON.stringify({ permissions: ["scope:finance"] }),
      }),
      makeWorkspaceFile({
        path: "/docs/b-denied.md",
        semanticsJson: JSON.stringify({ permissions: ["scope:finance"] }),
      }),
      makeWorkspaceFile({ path: "/docs/c-allowed.md" }),
    ];
    const calls: { sql: string; bindings: unknown[] }[] = [];
    const ctx = {
      allRows: vi.fn((sql: string, ...bindings: unknown[]) => {
        calls.push({ sql, bindings });
        const cursor = bindings.length === 4 ? String(bindings[2]) : null;
        const limit = Number(bindings.at(-1));
        const lower = String(bindings[0]);
        const upper = String(bindings[1]);
        return files
          .filter((file) => file.path >= lower && file.path < upper)
          .filter((file) => (cursor ? file.path > cursor : true))
          .slice(0, limit)
          .map((file) => ({ path: file.path }));
      }),
      toWorkspaceFile: (row: Row) => {
        const path = row.path as string;
        const file = files.find((candidate) => candidate.path === path);
        if (!file) throw new Error(`Unexpected row ${path}`);
        return file;
      },
      getFileRow: (path: string) =>
        files.find((candidate) => candidate.path === path) ?? null,
      loadContent: vi.fn(async () => {
        throw new Error("manifest paging must not load content");
      }),
      getOperation: () => null,
      insertEvent: vi.fn(),
      nextId: () => "x",
      sqlExec: vi.fn(),
      toEvent: vi.fn(),
      toWorkspaceOperation: vi.fn(),
    } as unknown as WorkspaceAdapterContext;

    const page = listWorkspaceExportManifestPage(
      ctx,
      "ws_test",
      null,
      null,
      2,
      "/docs",
    );

    expect(page.entries.map((entry) => entry.path)).toEqual([
      "/docs/c-allowed.md",
    ]);
    expect(page.nextCursor).toBeNull();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.bindings[2]).toBe("/docs/b-denied.md");
  });

  it("limits export manifest pages to the requested pathPrefix subtree", async () => {
    const rows: Row[] = [
      { path: "/github/repos/acme/demo/contents/a.ts@sha.json" },
      { path: "/github/repos/acme/demo/contents/nested/b.ts@sha.json" },
      { path: "/github/repos/acme/other/contents/c.ts@sha.json" },
      { path: "/notion/pages/page.json" },
    ];
    const calls: { sql: string; bindings: unknown[] }[] = [];
    const ctx = makeFsContext({
      allRows: vi.fn((sql: string, ...bindings: unknown[]) => {
        calls.push({ sql, bindings });
        if (sql.includes("COUNT(*)")) return [{ count: 2 }];
        const lower = String(bindings[0]);
        const upper = String(bindings[1]);
        return rows.filter(
          (row) => String(row.path) >= lower && String(row.path) < upper,
        );
      }),
      toWorkspaceFile: (row: Row) =>
        makeWorkspaceFile({ path: row.path as string }),
    });
    const pathPrefix = "/github/repos/acme/demo/contents";
    const req = new Request("https://do/internal/export-manifest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws_test", pathPrefix }),
    });

    const res = await handleExportManifest(ctx, req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      fileCount: number;
      entries: WorkspaceFile[];
      nextCursor: string | null;
    };

    expect(body.fileCount).toBe(2);
    expect(body.entries.map((entry) => entry.path)).toEqual([
      "/github/repos/acme/demo/contents/a.ts@sha.json",
      "/github/repos/acme/demo/contents/nested/b.ts@sha.json",
    ]);
    const manifestCall = calls.find(
      (call) =>
        call.sql.includes("FROM files") &&
        call.sql.includes("ORDER BY path ASC"),
    );
    expect(manifestCall?.sql).toContain("path >= ?");
    expect(manifestCall?.sql).toContain("path < ?");
    expect(manifestCall?.bindings.slice(0, 2)).toEqual([
      `${pathPrefix}/`,
      `${pathPrefix}0`,
    ]);
  });

  it("returns zero entries for a pathPrefix outside the workspace rows", async () => {
    const rows: Row[] = [
      { path: "/github/repos/acme/demo/contents/a.ts@sha.json" },
    ];
    const ctx = makeFsContext({
      allRows: vi.fn((sql: string, ...bindings: unknown[]) => {
        if (!sql.includes("FROM files")) return [];
        const lower = String(bindings[0]);
        const upper = String(bindings[1]);
        return rows.filter(
          (row) => String(row.path) >= lower && String(row.path) < upper,
        );
      }),
      toWorkspaceFile: (row: Row) =>
        makeWorkspaceFile({ path: row.path as string }),
    });
    const req = new Request("https://do/internal/export-manifest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "ws_test",
        pathPrefix: "/github/repos/acme/missing/contents",
      }),
    });

    const res = await handleExportManifest(ctx, req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      fileCount: number;
      entries: WorkspaceFile[];
      nextCursor: string | null;
    };

    expect(body.fileCount).toBe(0);
    expect(body.entries).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });
});

describe("handleExportManifest", () => {
  it("returns metadata-only entries with no content field", async () => {
    const rows: Row[] = [{ path: "/x.md" }];
    const ctx = makeFsContext({
      allRows: vi.fn((sql: string, ...bindings: unknown[]) => {
        void bindings;
        if (sql.includes("COUNT(*)")) return [{ count: 1 }];
        return rows;
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
    const body = (await res.json()) as {
      fileCount: number;
      entries: WorkspaceFile[];
      nextCursor: string | null;
    };
    expect(body.fileCount).toBe(RUNTIME_PATHS.length + 1);
    expect(body.entries.map((entry) => entry.path)).toEqual([
      ...RUNTIME_PATHS,
      "/x.md",
    ]);
    expect(body.entries[0]).toHaveProperty("contentRef");
    expect(body.entries[0]).not.toHaveProperty("content");
    // CRITICAL: loadContent was NOT called by the DO during manifest
    // paging. The Worker fetches bodies from R2 directly.
    expect(ctx.loadContent).not.toHaveBeenCalled();
  });

  it("exports rows allowed by workspace ACL rules and path-scoped relayfile read tokens", async () => {
    const repoRoot = "/github/repos/AgentWorkforce/cloud";
    const commentPath = `${repoRoot}/issues/1593/comments/create-comment.json`;
    const rows: Row[] = [{ path: commentPath }];
    const files = [
      makeWorkspaceFile({
        path: "/.relayfile.acl",
        semanticsJson: JSON.stringify({
          permissions: [
            "allow:scope:workspace:agent_test:read:*",
            "deny:scope:workspace:agent_test:read:/secrets/*",
          ],
        }),
      }),
      makeWorkspaceFile({ path: commentPath }),
    ];
    const ctx = makeFsContext({
      getRequestClaims: async () => claimsWith(["relayfile:fs:read:/github/*"]),
      allRows: vi.fn((sql: string, ...bindings: unknown[]) => {
        if (sql.includes("COUNT(*)")) return [{ count: 1 }];
        if (sql.includes("SELECT path, size")) {
          return rows.map((row) => ({ ...row, size: 10 }));
        }
        return rows;
      }),
      getFileRow: (path: string) =>
        files.find((file) => file.path === path) ?? null,
      toWorkspaceFile: (row: Row) =>
        files.find((file) => file.path === row.path) ??
        makeWorkspaceFile({ path: row.path as string }),
    });
    const req = new Request("https://do/internal/export-manifest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws_test", pathPrefix: repoRoot }),
    });

    const res = await handleExportManifest(ctx, req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      fileCount: number;
      entries: WorkspaceFile[];
      nextCursor: string | null;
    };

    expect(body.fileCount).toBe(1);
    expect(body.entries.map((entry) => entry.path)).toEqual([commentPath]);
    expect(ctx.loadContent).not.toHaveBeenCalled();
  });

  it("rejects with 413 when first-page file count exceeds the ceiling", async () => {
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
    const req = new Request("https://do/internal/export-manifest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws_test" }),
    });
    const res = await handleExportManifest(ctx, req);
    expect(res.status).toBe(413);
  });

  it("skips the COUNT(*) ceiling check on subsequent pages (afterPath set)", async () => {
    const countSpy = vi.fn(() => [{ count: 1 }]);
    const ctx = makeFsContext({
      allRows: vi.fn((sql: string) => {
        if (sql.includes("COUNT(*)")) return countSpy();
        return [];
      }),
    });
    const req = new Request("https://do/internal/export-manifest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws_test", afterPath: "/seen" }),
    });
    const res = await handleExportManifest(ctx, req);
    expect(res.status).toBe(200);
    // The COUNT(*) ceiling is only enforced on the first page so we don't
    // re-query it for every page of a long export.
    expect(countSpy).not.toHaveBeenCalled();
  });

  it("clamps requested pageSize to the export manifest page size", async () => {
    const calls: { sql: string; bindings: unknown[] }[] = [];
    const ctx = makeFsContext({
      allRows: vi.fn((sql: string, ...bindings: unknown[]) => {
        calls.push({ sql, bindings });
        return [];
      }),
    });
    const req = new Request("https://do/internal/export-manifest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws_test", pageSize: 999_999 }),
    });
    const res = await handleExportManifest(ctx, req);
    expect(res.status).toBe(200);
    const manifestCall = calls.filter((call) =>
      call.sql.includes("FROM files"),
    )[1];
    expect(manifestCall.bindings.at(-1)).toBe(EXPORT_FILE_PAGE_SIZE);
  });
});
