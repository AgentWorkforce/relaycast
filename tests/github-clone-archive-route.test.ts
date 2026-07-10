import { beforeEach, describe, expect, test, vi } from "vitest";

const jobStoreMocks = vi.hoisted(() => ({
  getGithubCloneJob: vi.fn(),
}));
const authMocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  requireAuthScope: vi.fn(),
}));
const relayWorkspaceMocks = vi.hoisted(() => ({
  normalizeRelayWorkspaceIdToAppWorkspaceId: vi.fn(),
  readBoundRelayWorkspaceId: vi.fn(),
}));
const dbMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));
const nangoMocks = vi.hoisted(() => ({
  getGitHubProviderConfigKey: vi.fn(),
  getNangoClient: vi.fn(),
}));

vi.mock("@cloud/core/clone/github-clone-job-store.js", () => jobStoreMocks);
vi.mock("../packages/web/lib/auth/request-auth", () => authMocks);
vi.mock("../packages/web/lib/db", () => dbMocks);
vi.mock("../packages/web/lib/integrations/nango-service", () => nangoMocks);
vi.mock(
  "../packages/web/lib/workspaces/relay-workspace-binding",
  () => relayWorkspaceMocks,
);

import { GET } from "../packages/web/app/api/v1/github/clone/archive/[jobId]/route";

function dbReturningProviderConfigKey(providerConfigKey: string | null) {
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                async limit() {
                  return providerConfigKey === null ? [] : [{ providerConfigKey }];
                },
              };
            },
          };
        },
      };
    },
  };
}

describe("github clone archive route", () => {
  const fetchMock = vi.fn();
  const getTokenMock = vi.fn();
  const localArchiveJob = {
    id: "job-1",
    workspaceId: "ws-1",
    owner: "octo",
    repo: "demo",
    ref: "main",
    connectionId: "conn-1",
    status: "completed",
    mode: "full",
    attempts: 1,
    filesWritten: null,
    headSha: "abc123",
    baseSha: null,
    durationMs: 250,
    materializationJson: {
      mode: "local_archive",
      headSha: "abc123",
      filesExpected: null,
      archiveUrl: "https://cloud.example/api/v1/github/clone/archive/job-1",
      stripComponents: 1,
      expiresAt: "2999-01-01T00:00:00.000Z",
    },
    lastError: null,
    createdAt: new Date("2026-01-01T12:00:00.000Z"),
    updatedAt: new Date("2026-01-01T12:00:01.000Z"),
    startedAt: new Date("2026-01-01T12:00:00.000Z"),
    completedAt: new Date("2026-01-01T12:00:01.000Z"),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SageCloudApiToken = "sage-token";
    process.env.SpecialistCloudApiToken = "specialist-token";
    authMocks.resolveRequestAuth.mockResolvedValue(null);
    authMocks.requireAuthScope.mockReturnValue(false);
    relayWorkspaceMocks.normalizeRelayWorkspaceIdToAppWorkspaceId.mockImplementation(
      async (workspaceId: string) => workspaceId,
    );
    relayWorkspaceMocks.readBoundRelayWorkspaceId.mockResolvedValue(null);
    dbMocks.getDb.mockReturnValue(dbReturningProviderConfigKey("github-relay"));
    nangoMocks.getGitHubProviderConfigKey.mockReturnValue("github-relay");
    getTokenMock.mockResolvedValue("github-installation-secret");
    nangoMocks.getNangoClient.mockReturnValue({ getToken: getTokenMock });
    fetchMock.mockResolvedValue(
      new Response("tarball-bytes", {
        status: 200,
        headers: {
          "content-type": "application/x-gzip",
          "content-length": "13",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  test("streams a local archive lease through Cloud auth without exposing the GitHub token", async () => {
    jobStoreMocks.getGithubCloneJob.mockResolvedValue(localArchiveJob);

    const response = await GET(
      new Request("http://localhost/api/v1/github/clone/archive/job-1", {
        headers: { SageCloudApiToken: "sage-token" },
      }),
      { params: { jobId: "job-1" } },
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("tarball-bytes");
    expect(getTokenMock).toHaveBeenCalledWith("github-relay", "conn-1", false, true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/octo/demo/tarball/abc123",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Accept: "application/vnd.github+json",
          Authorization: "Bearer github-installation-secret",
          "X-GitHub-Api-Version": "2022-11-28",
        }),
      }),
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toEqual(
      expect.objectContaining({
        Accept: "application/x-gzip, application/octet-stream",
      }),
    );
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="octo-demo-abc123.tar.gz"',
    );
  });

  test("rejects expired archive leases before minting a GitHub token", async () => {
    jobStoreMocks.getGithubCloneJob.mockResolvedValue({
      ...localArchiveJob,
      materializationJson: {
        ...localArchiveJob.materializationJson,
        expiresAt: "2000-01-01T00:00:00.000Z",
      },
    });

    const response = await GET(
      new Request("http://localhost/api/v1/github/clone/archive/job-1", {
        headers: { SageCloudApiToken: "sage-token" },
      }),
      { params: { jobId: "job-1" } },
    );

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "clone_archive_lease_expired",
    });
    expect(getTokenMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects completed relayfile-export jobs because they do not need an archive lease", async () => {
    jobStoreMocks.getGithubCloneJob.mockResolvedValue({
      ...localArchiveJob,
      materializationJson: {
        mode: "relayfile_export",
        headSha: "abc123",
        filesExpected: 2,
        sentinelPath: "/github/repos/octo/demo/.relayfile/clone.json",
        contentRoot: "/github/repos/octo/demo/contents",
        exportParams: {
          format: "tar",
          decode: "github-working-tree",
          gzip: false,
        },
      },
    });

    const response = await GET(
      new Request("http://localhost/api/v1/github/clone/archive/job-1", {
        headers: { SageCloudApiToken: "sage-token" },
      }),
      { params: { jobId: "job-1" } },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "clone_archive_unavailable",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
