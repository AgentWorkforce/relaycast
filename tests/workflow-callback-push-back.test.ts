import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const workflowStoreGetMock = vi.hoisted(() => vi.fn());
const workflowStoreUpdateMock = vi.hoisted(() => vi.fn());
const resolveRepoAllowlistOrRelaxedMock = vi.hoisted(() => vi.fn());
const readWorkflowPathPatchMock = vi.hoisted(() => vi.fn());
const pushWorkflowPathPatchMock = vi.hoisted(() => vi.fn());
const revokeWorkflowIdentityMock = vi.hoisted(() => vi.fn());
const revokeApiTokenSessionsForRunMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/workflows", () => ({
  workflowStore: {
    get: (...args: unknown[]) => workflowStoreGetMock(...args),
    update: (...args: unknown[]) => workflowStoreUpdateMock(...args),
  },
}));

vi.mock("@/lib/integrations/workflow-repository-allowlists", () => ({
  resolveRepoAllowlistOrRelaxed: (...args: unknown[]) => resolveRepoAllowlistOrRelaxedMock(...args),
}));

vi.mock("@/lib/integrations/github-push-back", () => ({
  readWorkflowPathPatch: (...args: unknown[]) => readWorkflowPathPatchMock(...args),
  pushWorkflowPathPatch: (...args: unknown[]) => pushWorkflowPathPatchMock(...args),
}));

vi.mock("@cloud/core/relayauth/client.js", () => ({
  createRelayAuthClient: () => ({ client: true }),
  revokeWorkflowIdentity: (...args: unknown[]) => revokeWorkflowIdentityMock(...args),
}));

vi.mock("@/lib/auth/api-token-store", () => ({
  revokeApiTokenSessionsForRun: (...args: unknown[]) => revokeApiTokenSessionsForRunMock(...args),
}));

const run = {
  runId: "33333333-3333-4333-8333-333333333333",
  sandboxId: "sandbox_1",
  dispatchType: "sandbox",
  userId: "22222222-2222-4222-8222-222222222222",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  workflow: "name: test",
  fileType: "yaml",
  status: "running",
  callbackToken: "callback-token",
  createdAt: "2026-04-23T00:00:00.000Z",
  updatedAt: "2026-04-23T00:00:00.000Z",
  relayauthIdentityId: "identity_1",
  paths: [
    {
      name: "cloud",
      s3CodeKey: "code-cloud.tar.gz",
      repoOwner: "acme",
      repoName: "cloud",
    },
    {
      name: "relay",
      s3CodeKey: "code-relay.tar.gz",
      repoOwner: "acme",
      repoName: "relay",
    },
  ],
};

async function loadRoute() {
  return import(
    new URL(
      "../packages/web/app/api/v1/workflows/callback/route.ts",
      import.meta.url,
    ).href
  );
}

function callbackRequest() {
  return new Request("https://cloud.test/api/v1/workflows/callback", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-callback-token": "callback-token",
    },
    body: JSON.stringify({
      runId: run.runId,
      status: "completed",
    }),
  });
}

beforeEach(() => {
  workflowStoreGetMock.mockResolvedValue(run);
  workflowStoreUpdateMock.mockImplementation(async (_runId, patch) => ({
    ...run,
    ...patch,
    status: patch.status ?? run.status,
  }));
  resolveRepoAllowlistOrRelaxedMock.mockResolvedValue({
    workspaceId: run.workspaceId,
    repoOwner: "acme",
    repoName: "cloud",
    installationId: "install_1",
    pushAllowed: true,
    allowedAt: new Date(),
    allowedBy: run.userId,
  });
  readWorkflowPathPatchMock.mockResolvedValue({
    patch: "diff --git a/new.txt b/new.txt\n",
    hasChanges: true,
    s3Key: "s3-key",
  });
  pushWorkflowPathPatchMock.mockResolvedValue({
    status: "pushed",
    branch: "agent-relay/run-1",
    prUrl: "https://github.com/acme/cloud/pull/1",
    sha: "sha-1",
    base: { branch: "main", sha: "base-1" },
    strategy: "contents_api",
    pushedAt: "2026-04-23T00:00:00.000Z",
  });
  revokeWorkflowIdentityMock.mockResolvedValue(undefined);
  revokeApiTokenSessionsForRunMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("workflow callback push-back", () => {
  it("persists per-path partial success and failure before cleanup", async () => {
    pushWorkflowPathPatchMock
      .mockResolvedValueOnce({
        status: "pushed",
        branch: "agent-relay/run-1",
        prUrl: "https://github.com/acme/cloud/pull/1",
        sha: "sha-1",
        base: { branch: "main", sha: "base-1" },
        strategy: "contents_api",
        pushedAt: "2026-04-23T00:00:00.000Z",
      })
      .mockResolvedValueOnce({
        status: "failed",
        code: "integration_not_found",
        message: "No integration",
        failedAt: "2026-04-23T00:00:01.000Z",
      });
    const { POST } = await loadRoute();

    const response = await POST(callbackRequest() as never);

    expect(response.status).toBe(200);
    expect(workflowStoreUpdateMock).toHaveBeenCalledWith(run.runId, { pushedTo: {} });
    expect(workflowStoreUpdateMock).toHaveBeenCalledWith(run.runId, {
      pushedTo: {
        cloud: expect.objectContaining({ status: "pushed" }),
      },
    });
    expect(workflowStoreUpdateMock).toHaveBeenCalledWith(run.runId, {
      pushedTo: {
        relay: expect.objectContaining({ status: "failed", code: "integration_not_found" }),
      },
    });
    expect(revokeWorkflowIdentityMock).toHaveBeenCalled();
    expect(revokeApiTokenSessionsForRunMock).toHaveBeenCalledWith(run.runId, "run_completed");
  });

  it("keeps the first persisted path visible if a later push throws", async () => {
    pushWorkflowPathPatchMock
      .mockResolvedValueOnce({
        status: "pushed",
        branch: "agent-relay/run-1",
        prUrl: "https://github.com/acme/cloud/pull/1",
        sha: "sha-1",
        base: { branch: "main", sha: "base-1" },
        strategy: "contents_api",
        pushedAt: "2026-04-23T00:00:00.000Z",
      })
      .mockRejectedValueOnce(new Error("process died"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { POST } = await loadRoute();

    const response = await POST(callbackRequest() as never);

    expect(response.status).toBe(200);
    expect(workflowStoreUpdateMock).toHaveBeenCalledWith(run.runId, {
      pushedTo: {
        cloud: expect.objectContaining({ status: "pushed" }),
      },
    });
    expect(revokeApiTokenSessionsForRunMock).toHaveBeenCalledWith(run.runId, "run_completed");
    consoleErrorSpy.mockRestore();
  });

  it("skips push-back entirely on a re-delivered callback when pushedTo is already populated", async () => {
    // Simulate a second `completed` callback for the same run: the run's
    // `pushedTo` already has the cloud entry from a prior delivery.
    workflowStoreGetMock.mockResolvedValueOnce({
      ...run,
      pushedTo: {
        cloud: {
          status: "pushed",
          branch: "agent-relay/run-prior",
          prUrl: "https://github.com/acme/cloud/pull/99",
          sha: "prior-sha",
          base: { branch: "main", sha: "prior-base" },
          strategy: "contents_api",
          pushedAt: "2026-04-22T00:00:00.000Z",
        },
      },
    });
    const { POST } = await loadRoute();

    const response = await POST(callbackRequest() as never);

    expect(response.status).toBe(200);
    // pushAllowedPathPatches should NOT have run, so neither pushWorkflowPathPatch
    // nor the inner reset-to-{} update should fire.
    expect(pushWorkflowPathPatchMock).not.toHaveBeenCalled();
    expect(workflowStoreUpdateMock).not.toHaveBeenCalledWith(run.runId, { pushedTo: {} });
    // Cleanup (identity revoke + token session revoke) still runs.
    expect(revokeApiTokenSessionsForRunMock).toHaveBeenCalledWith(run.runId, "run_completed");
  });

  it("skips paths whose allowlist row has pushAllowed false", async () => {
    resolveRepoAllowlistOrRelaxedMock.mockImplementation(async (_workspaceId, _owner, repo) => ({
      workspaceId: run.workspaceId,
      repoOwner: "acme",
      repoName: repo,
      installationId: "install_1",
      pushAllowed: repo === "cloud",
      allowedAt: new Date(),
      allowedBy: run.userId,
    }));
    const { POST } = await loadRoute();

    const response = await POST(callbackRequest() as never);

    expect(response.status).toBe(200);
    expect(pushWorkflowPathPatchMock).toHaveBeenCalledTimes(1);
    expect(pushWorkflowPathPatchMock.mock.calls[0]?.[0]).toMatchObject({
      path: { name: "cloud" },
    });
  });
});
