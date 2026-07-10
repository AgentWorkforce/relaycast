import { beforeEach, describe, expect, test, vi } from "vitest";

// Mock the lower-level integrations runProductionGithubClone reaches into.
// We control the Nango proxy, the RelayFileClient methods, and the workspace
// integrations DB lookup — everything else stays real so we exercise the
// actual incremental branching logic.

const compareMocks = vi.hoisted(() => ({
  compareGithubRefs: vi.fn(),
}));

const nangoCtorMock = vi.hoisted(() => vi.fn());
const relayfileCtorMock = vi.hoisted(() => vi.fn());
const mintRelayfileTokenMock = vi.hoisted(() => vi.fn());
const nangoProxyMock = vi.hoisted(() => vi.fn());
const nangoGetTokenMock = vi.hoisted(() => vi.fn());
const relayfileBulkWriteMock = vi.hoisted(() => vi.fn());
const relayfileDeleteFileMock = vi.hoisted(() => vi.fn());
const relayfileWriteFileMock = vi.hoisted(() => vi.fn());
const relayfileReadFileMock = vi.hoisted(() => vi.fn());

vi.mock("../packages/core/src/clone/github-clone-compare", () => compareMocks);

vi.mock("@nangohq/node", () => ({
  Nango: nangoCtorMock,
}));

vi.mock("@relayfile/sdk", () => {
  class RelayFileApiError extends Error {
    constructor(public readonly status: number, message: string, public readonly code = "api_error") {
      super(message);
    }
  }
  return {
    RelayFileApiError,
    RelayFileClient: relayfileCtorMock,
  };
});

vi.mock("sst", () => ({
  Resource: {},
}));

vi.mock("../packages/core/src/relayfile/client.js", () => ({
  mintRelayfileToken: mintRelayfileTokenMock,
}));

import { runProductionGithubClone } from "../packages/core/src/clone/github-clone-production";
import type { GithubCloneJobRequest } from "../packages/core/src/clone/github-clone-job";

type RelayfileWriteFileCall = [{
  path: string;
  content: string;
}];

function buildDb(integrationOverrides: Partial<{
  connectionId: string;
  providerConfigKey: string | null;
}> = {}) {
  // Drizzle-shaped chain: db.select().from(table).where(cond).limit(n).
  const integrationRow = {
    connectionId: "conn-1",
    providerConfigKey: "github-sage",
    ...integrationOverrides,
  };

  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [integrationRow],
        }),
      }),
    }),
  };
}

function buildDeps(
  request: GithubCloneJobRequest,
  envOverrides: Record<string, string | undefined> = {},
) {
  return {
    db: buildDb(),
    jobId: "job-incr-1",
    request,
    workspaceId: request.workspaceId,
    env: {
      NANGO_SECRET_KEY: "test-secret",
      NANGO_HOST: "https://nango.test",
      WEB_RELAYAUTH_API_KEY: "relay-key",
      WEB_RELAYAUTH_URL: "https://relayauth.test",
      RELAYFILE_URL: "https://relayfile.test",
      ...envOverrides,
    },
  };
}

const incrementalRequest: GithubCloneJobRequest = {
  workspaceId: "ws-1",
  owner: "octo",
  repo: "hello-world",
  ref: "main",
  connectionId: "conn-1",
  mode: "incremental",
  baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

beforeEach(() => {
  vi.clearAllMocks();

  nangoCtorMock.mockImplementation(function Nango() {
    return {
    proxy: nangoProxyMock,
    getToken: nangoGetTokenMock,
    };
  });
  relayfileCtorMock.mockImplementation(function RelayFileClient() {
    return {
    bulkWrite: relayfileBulkWriteMock,
    deleteFile: relayfileDeleteFileMock,
    writeFile: relayfileWriteFileMock,
    readFile: relayfileReadFileMock,
    };
  });
  mintRelayfileTokenMock.mockResolvedValue("test-token");

  // Default: manifest reads succeed with a known prior head.
  relayfileReadFileMock.mockImplementation(async (_workspaceId: string, path: string) => {
    if (path.endsWith("/.relayfile/clone.json")) {
      return {
        revision: "rev-sentinel",
        content: JSON.stringify({
          jobId: "prior-job",
          defaultBranch: "main",
          headSha: incrementalRequest.baseSha,
          clonedAt: "2026-01-01T00:00:00.000Z",
          filesWritten: 100,
          cloneSource: "github-tarball-via-nango",
        }),
      };
    }
    if (path.endsWith("/meta.json")) {
      return {
        revision: "rev-meta",
        content: JSON.stringify({
          defaultBranch: "main",
          headSha: incrementalRequest.baseSha,
          clonedAt: "2026-01-01T00:00:00.000Z",
          filesWritten: 100,
        }),
      };
    }
    const err = new Error("not found");
    Object.assign(err, { status: 404 });
    throw err;
  });
  relayfileWriteFileMock.mockResolvedValue({ revision: "rev-next" });
  relayfileBulkWriteMock.mockResolvedValue({ written: 0, errors: [] });
  relayfileDeleteFileMock.mockResolvedValue(undefined);
});

describe("runProductionGithubClone — incremental sync branch", () => {
  test("full clone uses one tar import call and does not bulkWrite per file", async () => {
    const fullRequest: GithubCloneJobRequest = {
      workspaceId: "ws-1",
      owner: "octo",
      repo: "hello-world",
      ref: "main",
      connectionId: "conn-1",
      mode: "full",
    };

    nangoGetTokenMock.mockResolvedValue("installation-token");
    nangoProxyMock.mockImplementation(async ({ endpoint }: { endpoint: string }) => {
      if (endpoint.endsWith("/repos/octo/hello-world")) {
        return { status: 200, headers: {}, data: { default_branch: "main" } };
      }
      if (endpoint.includes("/commits/")) {
        return {
          status: 200,
          headers: {},
          data: { sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
        };
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    });

    const importCalls: Array<{ url: string; body: unknown }> = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
        const href = url instanceof Request ? url.url : String(url);
        if (href.startsWith("https://api.github.com/")) {
          return new Response(new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0, 0]), {
            status: 200,
            headers: { "content-type": "application/x-gzip" },
          });
        }
        if (href.startsWith("https://relayfile.test/")) {
          importCalls.push({ url: href, body: init?.body });
          return new Response(
            JSON.stringify({
              imported: 2766,
              errorCount: 0,
              errors: [],
              skipped: [],
              bytesWritten: 123456,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`unexpected fetch ${href}`);
      });

    try {
      const result = await runProductionGithubClone(buildDeps(fullRequest), fullRequest);

      expect(result.filesWritten).toBe(2766);
      expect(result.headSha).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
      expect(importCalls).toHaveLength(1);
      expect(importCalls[0]?.url).toContain("/fs/import/github-tarball");
      expect(importCalls[0]?.url).toContain("owner=octo");
      expect(importCalls[0]?.url).toContain("repo=hello-world");
      expect(importCalls[0]?.url).toContain("headSha=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
      expect(importCalls[0]?.body).toBeDefined();
      expect(relayfileBulkWriteMock).not.toHaveBeenCalled();
      expect(relayfileWriteFileMock).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/github/repos/octo/hello-world/.relayfile/clone.json",
          content: expect.stringContaining('"filesWritten":2766'),
        }),
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("full clone emits local_archive materialization when RelayFile admits a cold background fill", async () => {
    const fullRequest: GithubCloneJobRequest = {
      workspaceId: "ws-1",
      owner: "octo",
      repo: "hello-world",
      ref: "main",
      connectionId: "conn-1",
      mode: "full",
    };

    nangoGetTokenMock.mockResolvedValue("installation-token");
    nangoProxyMock.mockImplementation(async ({ endpoint }: { endpoint: string }) => {
      if (endpoint.endsWith("/repos/octo/hello-world")) {
        return { status: 200, headers: {}, data: { default_branch: "main" } };
      }
      if (endpoint.includes("/commits/")) {
        return {
          status: 200,
          headers: {},
          data: { sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
        };
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    });

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ jobId: "job-incr-1", status: "queued" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
      );

    try {
      const result = await runProductionGithubClone(
        buildDeps(fullRequest, {
          GITHUB_CLONE_RELAYFILE_FETCH_IMPORT: "true",
          CLOUD_PUBLIC_URL: "https://cloud.example/cloud",
          GITHUB_CLONE_ARCHIVE_LEASE_TTL_SECONDS: "900",
        }),
        fullRequest,
      );

      expect(result.filesWritten).toBeNull();
      expect(result.headSha).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
      expect(result.materialization).toMatchObject({
        mode: "local_archive",
        headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        filesExpected: null,
        archiveUrl: "https://cloud.example/cloud/api/v1/github/clone/archive/job-incr-1",
        stripComponents: 1,
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
        "https://relayfile.test/v1/workspaces/ws-1/fs/import/github-tarball/fetch",
      );
      const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
      expect(init.headers).toMatchObject({
        Authorization: "Bearer test-token",
        "X-GitHub-Token": "installation-token",
      });
      expect(relayfileWriteFileMock).not.toHaveBeenCalled();
      expect(relayfileBulkWriteMock).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("full clone keeps relayfile_export materialization when RelayFile reports a warm cache hit", async () => {
    const fullRequest: GithubCloneJobRequest = {
      workspaceId: "ws-1",
      owner: "octo",
      repo: "hello-world",
      ref: "main",
      connectionId: "conn-1",
      mode: "full",
    };

    nangoGetTokenMock.mockResolvedValue("installation-token");
    nangoProxyMock.mockImplementation(async ({ endpoint }: { endpoint: string }) => {
      if (endpoint.endsWith("/repos/octo/hello-world")) {
        return { status: 200, headers: {}, data: { default_branch: "main" } };
      }
      if (endpoint.includes("/commits/")) {
        return {
          status: 200,
          headers: {},
          data: { sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
        };
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    });

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            jobId: "job-incr-1",
            status: "completed",
            imported: 4,
            errorCount: 0,
            errors: [],
            skipped: [],
            bytesWritten: 40,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

    try {
      const result = await runProductionGithubClone(
        buildDeps(fullRequest, {
          GITHUB_CLONE_RELAYFILE_FETCH_IMPORT: "true",
          CLOUD_PUBLIC_URL: "https://cloud.example/cloud",
        }),
        fullRequest,
      );

      expect(result.filesWritten).toBe(4);
      expect(result.materialization).toMatchObject({
        mode: "relayfile_export",
        headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        filesExpected: 4,
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(relayfileWriteFileMock).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/github/repos/octo/hello-world/.relayfile/clone.json",
          content: expect.stringContaining('"filesWritten":4'),
        }),
      );
      expect(relayfileBulkWriteMock).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("no_change result writes a zero-byte completion and updates the manifest", async () => {
    compareMocks.compareGithubRefs.mockResolvedValue({ kind: "no_change" });

    const result = await runProductionGithubClone(buildDeps(incrementalRequest), incrementalRequest);

    expect(result.filesWritten).toBe(0);
    expect(result.headSha).toBe(incrementalRequest.baseSha);
    expect(relayfileBulkWriteMock).not.toHaveBeenCalled();
    expect(relayfileDeleteFileMock).not.toHaveBeenCalled();
    // Sentinel + legacy meta.json are both refreshed (lastIncrementalSyncAt).
    expect(relayfileWriteFileMock).toHaveBeenCalledTimes(2);
    const sentinelCall = (relayfileWriteFileMock.mock.calls as RelayfileWriteFileCall[]).find(([call]) =>
      call.path.endsWith("/.relayfile/clone.json"),
    );
    expect(sentinelCall).toBeDefined();
    const sentinelBody = JSON.parse(sentinelCall![0].content);
    expect(sentinelBody.headSha).toBe(incrementalRequest.baseSha);
    expect(sentinelBody.lastIncrementalSyncAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test("changes result writes blobs via bulkWrite and removes deleted paths", async () => {
    compareMocks.compareGithubRefs.mockResolvedValue({
      kind: "changes",
      headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      files: [
        { status: "added", path: "src/new.ts", sha: "sha-new" },
        { status: "modified", path: "src/existing.ts", sha: "sha-mod" },
        { status: "renamed", path: "src/renamed.ts", previousPath: "src/old-name.ts", sha: "sha-renamed" },
        { status: "removed", path: "src/old.ts" },
      ],
    });

    // Nango proxy serves blob payloads for the writes.
    nangoProxyMock.mockImplementation(async ({ endpoint }: { endpoint: string }) => {
      if (endpoint.endsWith("/git/blobs/sha-new")) {
        return {
          status: 200,
          headers: {},
          data: {
            content: Buffer.from("new file body").toString("base64"),
            encoding: "base64",
          },
        };
      }
      if (endpoint.endsWith("/git/blobs/sha-mod")) {
        return {
          status: 200,
          headers: {},
          data: {
            content: Buffer.from("modified body").toString("base64"),
            encoding: "base64",
          },
        };
      }
      if (endpoint.endsWith("/git/blobs/sha-renamed")) {
        return {
          status: 200,
          headers: {},
          data: {
            content: Buffer.from("renamed body").toString("base64"),
            encoding: "base64",
          },
        };
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    });
    relayfileBulkWriteMock.mockResolvedValue({ written: 3, errors: [] });

    const result = await runProductionGithubClone(buildDeps(incrementalRequest), incrementalRequest);

    expect(result.filesWritten).toBe(3);
    expect(result.headSha).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

    expect(relayfileDeleteFileMock).toHaveBeenCalledTimes(2);
    expect(relayfileDeleteFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        baseRevision: "*",
        path: expect.stringContaining("src/old.ts"),
      }),
    );
    expect(relayfileDeleteFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        baseRevision: "*",
        path: expect.stringContaining("src/old-name.ts"),
      }),
    );

    expect(relayfileBulkWriteMock).toHaveBeenCalledTimes(1);
    const [bulkArgs] = relayfileBulkWriteMock.mock.calls[0];
    expect(bulkArgs.workspaceId).toBe("ws-1");
    expect(bulkArgs.files).toHaveLength(3);
    const writtenPaths = bulkArgs.files.map((file: { path: string }) => file.path);
    expect(writtenPaths.some((path: string) => path.includes("src/new.ts"))).toBe(true);
    expect(writtenPaths.some((path: string) => path.includes("src/existing.ts"))).toBe(true);
    expect(writtenPaths.some((path: string) => path.includes("src/renamed.ts"))).toBe(true);
  });

  test("diverged result falls back to full clone", async () => {
    compareMocks.compareGithubRefs.mockResolvedValue({
      kind: "diverged",
      reason: "force_push",
    });

    // Nango proxy needs to satisfy the full-clone path: tarball + repo + commit.
    nangoGetTokenMock.mockResolvedValue("installation-token");
    nangoProxyMock.mockImplementation(async ({ endpoint }: { endpoint: string }) => {
      if (endpoint.endsWith("/repos/octo/hello-world")) {
        return { status: 200, headers: {}, data: { default_branch: "main" } };
      }
      if (endpoint.includes("/commits/")) {
        return {
          status: 200,
          headers: {},
          data: { sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
        };
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    });

    // Stub global fetch (the production code uses globalThis.fetch for the
    // tarball download). We return an empty tar.gz stream so walkGithubTarball
    // yields nothing — the branch we care about is the fallback log + executor
    // returning the full-clone result shape.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      // node:stream/Readable.fromWeb requires a real ReadableStream; an empty
      // stream is enough since walkGithubTarball gracefully handles it.
      .mockResolvedValue(
        new Response(new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0, 0]), {
          status: 200,
          headers: { "content-type": "application/x-gzip" },
        }),
      );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    let caught: unknown = null;
    try {
      await runProductionGithubClone(buildDeps(incrementalRequest), incrementalRequest);
    } catch (error) {
      // The tarball walker may reject because our stub bytes aren't a valid
      // gzip; that's fine — what we need to verify is that the fallback log
      // ran (i.e. compareGithubRefs was inspected and we attempted the
      // full-clone path). Tighter coverage of the full-clone tarball happens
      // in github-clone-runner.contract.test.ts.
      caught = error;
    }

    expect(compareMocks.compareGithubRefs).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("incremental_sync_fallback_to_full"),
    );
    // The fallback either threw downstream or returned a full-clone result.
    // Either way: the incremental no-op path was bypassed.
    if (!caught) {
      // success path — make sure it tried fetch (the full-clone tarball)
      expect(fetchSpy).toHaveBeenCalled();
    }
    fetchSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
