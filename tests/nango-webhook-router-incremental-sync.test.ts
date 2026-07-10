// Verifies the push-event branch in handleGitHubForward (router):
//   - push to default branch with a stored prior head → enqueueIncrementalCloneJob
//   - push to a non-default branch                    → no enqueue
//   - push with no prior manifest                     → no enqueue
//   - push where head matches stored sha              → no enqueue (no-op)
//
// Mirrors the heavyweight mock harness in
// tests/nango-webhook-router-fanout.test.ts but pares it down to only the
// surfaces our branch touches.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

const {
  bootstrapRegistryFromEnvMock,
  computePathMock,
  createGitHubRelayfileClientMock,
  enqueueIncrementalCloneJobMock,
  fanoutExceptMock,
  fanoutMock,
  findWorkspaceIntegrationByConnectionMock,
  ingestWebhookMock,
  listMock,
  loggerInfoMock,
  loggerWarnMock,
  loggerDebugMock,
  loggerErrorMock,
  nangoConstructorMock,
  nangoProxyMock,
  normalizeWebhookMock,
  readPriorCloneManifestMock,
  registerMock,
  relayfileConstructorMock,
  upsertWorkspaceIntegrationMock,
  deleteWorkspaceIntegrationMock,
  findSlackIntegrationByConnectionIdMock,
  findSlackIntegrationByTeamIdMock,
  findWorkspaceIntegrationByInstallationMock,
  getSlackConnectionIdentityMock,
  getNangoConnectionDetailsMock,
  getNangoHostMock,
  getNangoSecretKeyMock,
  getProviderConfigKeyMock,
  computeLinearPathMock,
  normalizeLinearWebhookMock,
} = vi.hoisted(() => ({
  bootstrapRegistryFromEnvMock: vi.fn(),
  computePathMock: vi.fn(),
  computeLinearPathMock: vi.fn(),
  createGitHubRelayfileClientMock: vi.fn(),
  enqueueIncrementalCloneJobMock: vi.fn(),
  fanoutExceptMock: vi.fn(),
  fanoutMock: vi.fn(),
  findWorkspaceIntegrationByConnectionMock: vi.fn(),
  ingestWebhookMock: vi.fn(),
  listMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  loggerDebugMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  nangoConstructorMock: vi.fn(),
  nangoProxyMock: vi.fn(),
  normalizeWebhookMock: vi.fn(),
  normalizeLinearWebhookMock: vi.fn(),
  readPriorCloneManifestMock: vi.fn(),
  registerMock: vi.fn(),
  relayfileConstructorMock: vi.fn(),
  upsertWorkspaceIntegrationMock: vi.fn(),
  deleteWorkspaceIntegrationMock: vi.fn(),
  findSlackIntegrationByConnectionIdMock: vi.fn(),
  findSlackIntegrationByTeamIdMock: vi.fn(),
  findWorkspaceIntegrationByInstallationMock: vi.fn(),
  getSlackConnectionIdentityMock: vi.fn(),
  getNangoConnectionDetailsMock: vi.fn(),
  getNangoHostMock: vi.fn(),
  getNangoSecretKeyMock: vi.fn(),
  getProviderConfigKeyMock: vi.fn(),
}));

type NangoWebhookEnvelope = {
  from: string;
  type: string;
  providerConfigKey: string;
  connectionId: string | null;
  payload: unknown;
};

type RouterModule = {
  routeNangoWebhook: (envelope: NangoWebhookEnvelope) => Promise<void>;
};

function installCommonMocks(): void {
  vi.doMock("@nangohq/node", () => ({
    Nango: nangoConstructorMock,
  }));
  vi.doMock("@relayfile/sdk", () => ({
    RelayFileClient: relayfileConstructorMock,
  }));
  vi.doMock("@/lib/integrations/nango-sync-queue", () => ({
    enqueueNangoSyncJob: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock("@/lib/integrations/workspace-integrations", () => ({
    deleteWorkspaceIntegration: deleteWorkspaceIntegrationMock,
    findSlackIntegrationByConnectionId: findSlackIntegrationByConnectionIdMock,
    findSlackIntegrationByTeamId: findSlackIntegrationByTeamIdMock,
    findWorkspaceIntegrationByConnection: findWorkspaceIntegrationByConnectionMock,
    findWorkspaceIntegrationByInstallation: findWorkspaceIntegrationByInstallationMock,
    upsertWorkspaceIntegration: upsertWorkspaceIntegrationMock,
  }));
  vi.doMock("@/lib/integrations/github-relayfile", () => ({
    enrichGitHubWatchPayload: vi.fn((data: Record<string, unknown>) => data),
    computePath: computePathMock,
    createGitHubRelayfileClient: createGitHubRelayfileClientMock,
    normalizeWebhook: normalizeWebhookMock,
  }));
  vi.doMock("@relayfile/adapter-linear", () => ({
    normalizeLinearWebhook: normalizeLinearWebhookMock,
  }));
  vi.doMock("@relayfile/adapter-notion", () => ({ NotionAdapter: vi.fn() }));
  vi.doMock("@relayfile/adapter-github/path-mapper", () => ({
    computeGitHubPath: vi.fn(),
    normalizeNangoGitHubModel: vi.fn(),
  }));
  vi.doMock("@relayfile/adapter-linear/path-mapper", () => ({
    computeLinearPath: computeLinearPathMock,
  }));
  vi.doMock("@relayfile/adapter-slack/path-mapper", () => ({
    computeSlackPath: vi.fn(),
    createSlackMessageObjectId: vi.fn(),
    createSlackThreadObjectId: vi.fn(),
    createSlackThreadReplyObjectId: vi.fn(),
  }));
  vi.doMock("@cloud/core/sync/linear-semantics.js", () => ({
    buildLinearSyncSemantics: vi.fn(),
  }));
  vi.doMock("@/lib/integrations/nango-service", () => ({
    getNangoConnectionDetails: getNangoConnectionDetailsMock,
    getNangoHost: getNangoHostMock,
    getNangoSecretKey: getNangoSecretKeyMock,
    getProviderConfigKey: getProviderConfigKeyMock,
  }));
  vi.doMock("@/lib/logger", () => ({
    logger: {
      debug: loggerDebugMock,
      error: loggerErrorMock,
      info: loggerInfoMock,
      warn: loggerWarnMock,
      notice: vi.fn().mockResolvedValue(undefined),
    },
  }));
  vi.doMock("@/lib/integrations/nango-slack", () => ({
    getSlackConnectionIdentity: getSlackConnectionIdentityMock,
  }));
  vi.doMock("@/lib/integrations/slack-identity", () => ({
    extractSlackConnectionIdentityFromForwardPayload: vi.fn().mockReturnValue({}),
    hasSlackConnectionIdentity: vi.fn().mockReturnValue(false),
    mergeSlackConnectionIdentity: vi.fn().mockReturnValue({}),
    mergeSlackConnectionIdentityMetadata: vi.fn().mockReturnValue({}),
  }));
  vi.doMock("@/lib/env", () => ({
    optionalEnv: vi.fn().mockReturnValue(undefined),
  }));
  vi.doMock("@cloud/core/workspace/id.js", () => ({
    isValidWorkspaceIdAny: vi.fn().mockReturnValue(false),
  }));
  vi.doMock("@relayfile/provider-nango", () => ({
    fetchNangoRecords: vi.fn(),
    recordNotionIngest: vi.fn(),
    NotionIngestHandler: {
      handleNotionBulkIngest: vi.fn(),
      handleNotionSyncNotification: vi.fn(),
    },
    NotionSupportedModelSchema: { safeParse: () => ({ success: false }) },
  }));
  vi.doMock("@/lib/integrations/webhook-consumer-registry", () => ({
    bootstrapRegistryFromEnv: bootstrapRegistryFromEnvMock,
  }));
  vi.doMock("@/lib/integrations/github-incremental-sync-trigger", () => ({
    enqueueIncrementalCloneJob: enqueueIncrementalCloneJobMock,
    readPriorCloneManifest: readPriorCloneManifestMock,
  }));
}

async function loadRouter(): Promise<RouterModule> {
  vi.resetModules();
  installCommonMocks();
  return import(
    new URL(
      "../packages/web/lib/integrations/nango-webhook-router.ts",
      import.meta.url,
    ).href
  ) as Promise<RouterModule>;
}

function buildPushEnvelope(input: {
  ref: string;
  after: string;
  defaultBranch?: string | null;
}): NangoWebhookEnvelope {
  // Nango wraps GitHub webhooks under payload + headers; we mimic the
  // shape `unwrapGitHubForwardPayload` expects. The router pulls
  // `repository.default_branch` off the unwrapped body.
  return {
    from: "github",
    type: "forward",
    providerConfigKey: "github-sage",
    connectionId: "conn-github-1",
    payload: {
      headers: {
        "x-github-event": "push",
        "x-github-delivery": "deliv-7",
      },
      body: {
        ref: input.ref,
        after: input.after,
        before: "0".repeat(40),
        repository: {
          name: "hello-world",
          owner: { login: "octo" },
          full_name: "octo/hello-world",
          default_branch: input.defaultBranch ?? null,
        },
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  fanoutMock.mockResolvedValue({ total: 0, succeeded: [], failed: [], skipped: [] });
  fanoutExceptMock.mockResolvedValue({ total: 0, succeeded: [], failed: [], skipped: [] });
  listMock.mockReturnValue([]);
  bootstrapRegistryFromEnvMock.mockReturnValue({
    fanout: fanoutMock,
    fanoutExcept: fanoutExceptMock,
    list: listMock,
    register: registerMock,
  });

  findWorkspaceIntegrationByConnectionMock.mockResolvedValue({
    workspaceId: TEST_WORKSPACE_ID,
    provider: "github",
    connectionId: "conn-github-1",
    providerConfigKey: "github-sage",
    installationId: null,
    metadata: {},
  });
  findSlackIntegrationByConnectionIdMock.mockResolvedValue(null);
  findSlackIntegrationByTeamIdMock.mockResolvedValue(null);
  findWorkspaceIntegrationByInstallationMock.mockResolvedValue(null);
  createGitHubRelayfileClientMock.mockReturnValue({
    ingestWebhook: ingestWebhookMock,
  });
  ingestWebhookMock.mockResolvedValue({ status: "queued", id: "evt-1" });
  computePathMock.mockReturnValue(
    "/github/repos/octo/hello-world/commits/abcdef.json",
  );
  normalizeWebhookMock.mockImplementation((input: { payload: Record<string, unknown> }) => ({
    provider: "github",
    connectionId: "conn-github-1",
    eventType: "push",
    objectType: "commit",
    objectId: typeof input.payload.after === "string" ? input.payload.after : "unknown",
    payload: input.payload,
  }));

  getNangoHostMock.mockReturnValue("https://api.nango.dev");
  getNangoSecretKeyMock.mockReturnValue("test-secret");
  getProviderConfigKeyMock.mockReturnValue("github-sage");

  loggerInfoMock.mockResolvedValue(undefined);
  loggerWarnMock.mockResolvedValue(undefined);
  loggerDebugMock.mockResolvedValue(undefined);
  loggerErrorMock.mockResolvedValue(undefined);

  enqueueIncrementalCloneJobMock.mockResolvedValue({ ok: true, jobId: "job-incr-99" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("nango-webhook-router push → incremental sync", () => {
  it("enqueues an incremental sync when push lands on the default branch", async () => {
    readPriorCloneManifestMock.mockResolvedValue({
      headSha: "old-sha",
      defaultBranch: "main",
      source: "sentinel",
    });

    const router = await loadRouter();
    await router.routeNangoWebhook(
      buildPushEnvelope({
        ref: "refs/heads/main",
        after: "new-sha",
        defaultBranch: "main",
      }),
    );

    expect(enqueueIncrementalCloneJobMock).toHaveBeenCalledTimes(1);
    expect(enqueueIncrementalCloneJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: TEST_WORKSPACE_ID,
        owner: "octo",
        repo: "hello-world",
        ref: "main",
        connectionId: "conn-github-1",
        baseSha: "old-sha",
        deliveryId: "deliv-7",
      }),
    );
  });

  it("does NOT enqueue when push is to a non-default branch", async () => {
    readPriorCloneManifestMock.mockResolvedValue({
      headSha: "old-sha",
      defaultBranch: "main",
      source: "sentinel",
    });

    const router = await loadRouter();
    await router.routeNangoWebhook(
      buildPushEnvelope({
        ref: "refs/heads/feat/something",
        after: "new-sha",
        defaultBranch: "main",
      }),
    );

    expect(enqueueIncrementalCloneJobMock).not.toHaveBeenCalled();
  });

  it("does NOT enqueue when no prior manifest exists (repo never cloned)", async () => {
    readPriorCloneManifestMock.mockResolvedValue(null);

    const router = await loadRouter();
    await router.routeNangoWebhook(
      buildPushEnvelope({
        ref: "refs/heads/main",
        after: "new-sha",
        defaultBranch: "main",
      }),
    );

    expect(enqueueIncrementalCloneJobMock).not.toHaveBeenCalled();
  });

  it("does NOT enqueue when head equals the stored prior sha", async () => {
    readPriorCloneManifestMock.mockResolvedValue({
      headSha: "same-sha",
      defaultBranch: "main",
      source: "sentinel",
    });

    const router = await loadRouter();
    await router.routeNangoWebhook(
      buildPushEnvelope({
        ref: "refs/heads/main",
        after: "same-sha",
        defaultBranch: "main",
      }),
    );

    expect(enqueueIncrementalCloneJobMock).not.toHaveBeenCalled();
  });
});
