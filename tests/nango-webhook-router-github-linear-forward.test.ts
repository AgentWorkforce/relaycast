// Tests for the forward-webhook content + canonical path follow-ups to
// cloud#529 and cloud#531.
//
// Two bugs land together in this file:
//
// 1. cloud#529 fixed the empty-`content` bug for GitHub forward webhooks
//    (relayfile-go's `ParseGenericEnvelope` reads `payload["content"]` and
//    upserts a zero-byte file when it is missing). Devin's PR review flagged
//    the same bug at `handleLinearForward`, but the comment landed after
//    merge. This test asserts the Linear forward handler now sets a non-empty
//    `content` and `contentType` on the ingest envelope, matching the
//    handleGitHubForward shape.
//
// 2. cloud#526's `e18da6a9` moved the sync writer to the canonical
//    `<n>__<slug>/meta.json` path via `githubPullRequestPath` from
//    `@relayfile/adapter-github/path-mapper`. The forward-webhook handler in
//    `packages/web/lib/integrations/github-relayfile.ts:computePath` still
//    hardcoded `pulls/<n>/metadata.json`, so a webhook landed at one path
//    while the sync landed at another for the same PR. This test asserts the
//    forward webhook now uses the adapter helper directly — no path string
//    is written literally; the expectation is computed by calling the same
//    helper the sync writer calls.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  githubIssuePath,
  githubNumberSlug,
  githubPullRequestPath,
  githubReviewPath,
} from "@relayfile/adapter-github/path-mapper";

const TEST_WORKSPACE_ID = "55555555-5555-4555-8555-555555555555";
const TEST_GITHUB_CONNECTION_ID = "conn-github-001";
const TEST_LINEAR_CONNECTION_ID = "conn-linear-001";

const {
  bootstrapRegistryFromEnvMock,
  computeLinearPathMock,
  createGitHubRelayfileClientMock,
  deleteWorkspaceIntegrationMock,
  fanoutExceptMock,
  fanoutMock,
  findAllWorkspaceIntegrationsByInstallationMock,
  findSlackIntegrationByConnectionIdMock,
  findSlackIntegrationByTeamIdMock,
  findWorkspaceIntegrationByConnectionMock,
  getNangoHostMock,
  getNangoSecretKeyMock,
  getProviderConfigKeyMock,
  getSlackConnectionIdentityMock,
  ingestWebhookMock,
  linearCommentPathMock,
  linearAgentWebhookEventPathMock,
  listMock,
  loggerDebugMock,
  loggerErrorMock,
  loggerInfoMock,
  loggerWarnMock,
  nangoConstructorMock,
  nangoProxyMock,
  normalizeLinearWebhookMock,
  optionalEnvMock,
  registerMock,
  relayfileConstructorMock,
  dispatchLinearSessionEventMock,
  dispatchIntegrationWatchEventMock,
  recordWorkspaceIntegrationDisconnectMock,
  writeBatchToRelayfileMock,
  linearIssueByStatePathMock,
} = vi.hoisted(() => ({
  bootstrapRegistryFromEnvMock: vi.fn(),
  computeLinearPathMock: vi.fn(),
  createGitHubRelayfileClientMock: vi.fn(),
  deleteWorkspaceIntegrationMock: vi.fn(),
  fanoutExceptMock: vi.fn(),
  fanoutMock: vi.fn(),
  findAllWorkspaceIntegrationsByInstallationMock: vi.fn(),
  findSlackIntegrationByConnectionIdMock: vi.fn(),
  findSlackIntegrationByTeamIdMock: vi.fn(),
  findWorkspaceIntegrationByConnectionMock: vi.fn(),
  getNangoHostMock: vi.fn(),
  getNangoSecretKeyMock: vi.fn(),
  getProviderConfigKeyMock: vi.fn(),
  getSlackConnectionIdentityMock: vi.fn(),
  ingestWebhookMock: vi.fn(),
  linearCommentPathMock: vi.fn(),
  linearAgentWebhookEventPathMock: vi.fn(),
  linearIssueByStatePathMock: vi.fn(),
  listMock: vi.fn(),
  loggerDebugMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  nangoConstructorMock: vi.fn(),
  nangoProxyMock: vi.fn(),
  normalizeLinearWebhookMock: vi.fn(),
  optionalEnvMock: vi.fn(),
  registerMock: vi.fn(),
  relayfileConstructorMock: vi.fn(),
  dispatchLinearSessionEventMock: vi.fn(),
  dispatchIntegrationWatchEventMock: vi.fn(),
  recordWorkspaceIntegrationDisconnectMock: vi.fn(),
  writeBatchToRelayfileMock: vi.fn(),
}));

type NangoWebhookEnvelope = {
  from: string;
  type: string;
  providerConfigKey: string;
  connectionId: string | null;
  payload: unknown;
};

type RouterModule = {
  routeForwardEvent: (envelope: NangoWebhookEnvelope) => Promise<void>;
};

function okFanoutResult() {
  return { total: 1, succeeded: ["consumer"], failed: [], skipped: [] };
}

function resetMockDefaults(): void {
  vi.clearAllMocks();

  fanoutMock.mockResolvedValue(okFanoutResult());
  fanoutExceptMock.mockResolvedValue(okFanoutResult());
  listMock.mockReturnValue([{ id: "mock-consumer" }]);
  bootstrapRegistryFromEnvMock.mockReturnValue({
    fanout: fanoutMock,
    fanoutExcept: fanoutExceptMock,
    list: listMock,
    register: registerMock,
  });

  findWorkspaceIntegrationByConnectionMock.mockResolvedValue(null);
  findAllWorkspaceIntegrationsByInstallationMock.mockResolvedValue([]);
  findSlackIntegrationByConnectionIdMock.mockResolvedValue(null);
  findSlackIntegrationByTeamIdMock.mockResolvedValue(null);
  getSlackConnectionIdentityMock.mockResolvedValue(null);

  createGitHubRelayfileClientMock.mockReturnValue({
    ingestWebhook: ingestWebhookMock,
  });
  ingestWebhookMock.mockResolvedValue({ status: "queued", id: "evt-1" });
  writeBatchToRelayfileMock.mockResolvedValue({ written: 1, deleted: 0, errors: 0 });
  deleteWorkspaceIntegrationMock.mockResolvedValue(undefined);
  recordWorkspaceIntegrationDisconnectMock.mockResolvedValue(undefined);
  dispatchLinearSessionEventMock.mockResolvedValue(undefined);
  dispatchIntegrationWatchEventMock.mockResolvedValue({
    delivered: 0,
    failed: 0,
    matched: 0,
  });

  getNangoHostMock.mockReturnValue("https://api.nango.dev");
  getNangoSecretKeyMock.mockReturnValue("test-secret");
  getProviderConfigKeyMock.mockImplementation(
    (provider: string) => `${provider}-relay`,
  );

  nangoConstructorMock.mockImplementation(function Nango() {
    return { proxy: nangoProxyMock };
  });
  relayfileConstructorMock.mockImplementation(function RelayFileClient() {
    return { ingestWebhook: ingestWebhookMock };
  });
  normalizeLinearWebhookMock.mockImplementation((payload: Record<string, unknown>) => {
    const agentSession = payload.agentSession as Record<string, unknown> | undefined;
    const agentActivity = payload.agentActivity as Record<string, unknown> | undefined;
    const notification = payload.notification as Record<string, unknown> | undefined;
    return {
      provider: "linear",
      eventType: `${String(payload.type)}.${String(payload.action)}`,
      objectType: String(payload.type),
      objectId:
        String(agentSession?.id ?? agentActivity?.agentSessionId ?? notification?.id ??
          (payload.type === "OAuthApp" ? payload.oauthClientId : undefined) ??
          payload.webhookId ?? payload.oauthClientId ?? payload.appUserId ?? payload.id),
      payload,
    };
  });
  linearAgentWebhookEventPathMock.mockImplementation((eventType: string, objectId?: string | null) => {
    const root = eventType.startsWith("AgentSessionEvent.")
      ? "/linear/agent-sessions"
      : eventType.startsWith("AppUserNotification.")
        ? "/linear/app-user-notifications"
        : eventType.startsWith("PermissionChange.")
          ? "/linear/permission-changes"
          : eventType.startsWith("OAuthApp.")
            ? "/linear/oauth-app"
            : null;
    if (!root) return null;
    return objectId ? `${root}/${encodeURIComponent(objectId)}.json` : root;
  });
  linearCommentPathMock.mockImplementation(
    (id: string) => `/linear/comments/${encodeURIComponent(id)}.json`,
  );
  linearIssueByStatePathMock.mockImplementation(
    (stateName: string, identifier: string) =>
      `/linear/issues/by-state/${stateName.toLowerCase().replace(/\s+/g, "-")}/${encodeURIComponent(identifier)}.json`,
  );

  loggerDebugMock.mockResolvedValue(undefined);
  loggerErrorMock.mockResolvedValue(undefined);
  loggerInfoMock.mockResolvedValue(undefined);
  loggerWarnMock.mockResolvedValue(undefined);
  optionalEnvMock.mockReturnValue(undefined);
}

function installCommonMocks(): void {
  vi.doMock("@cloud/core/provider-readiness.js", () => ({
    markProviderInitialSyncComplete: vi.fn().mockResolvedValue(undefined),
    markProviderInitialSyncFailed: vi.fn().mockResolvedValue(undefined),
    markProviderInitialSyncQueued: vi.fn().mockResolvedValue(undefined),
    markProviderOAuthConnected: vi.fn().mockResolvedValue(undefined),
  }));

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
    findAllWorkspaceIntegrationsByInstallation:
      findAllWorkspaceIntegrationsByInstallationMock,
    findWorkspaceIntegrationByConnection: findWorkspaceIntegrationByConnectionMock,
    insertWorkspaceIntegrationIfAbsent: vi.fn(),
    recordWorkspaceIntegrationDisconnect: recordWorkspaceIntegrationDisconnectMock,
    upsertWorkspaceIntegration: vi.fn(),
  }));

  // Crucial: do NOT mock `@/lib/integrations/github-relayfile` here. The
  // GitHub forward path-canonicalization fix lives in `computePath` on that
  // module, so the assertion needs to exercise the real implementation. The
  // only piece we stub out is the relayfile client factory — but
  // `createGitHubRelayfileClient` reads relayfile config at runtime, so we
  // replace it via a partial passthrough of the module rather than a full
  // mock.
  vi.doMock(
    "@/lib/integrations/github-relayfile",
    async (importOriginal: () => Promise<Record<string, unknown>>) => {
      const actual = (await importOriginal()) as Record<string, unknown>;
      return {
        ...actual,
        createGitHubRelayfileClient: createGitHubRelayfileClientMock,
      };
    },
  );

  vi.doMock("@relayfile/adapter-linear", () => ({
    linearAgentWebhookEventPath: linearAgentWebhookEventPathMock,
    linearCommentPath: linearCommentPathMock,
    normalizeLinearWebhook: normalizeLinearWebhookMock,
  }));

  vi.doMock("@relayfile/adapter-notion", () => ({
    NotionAdapter: vi.fn(),
  }));

  vi.doMock("@relayfile/adapter-dropbox/webhook-normalizer", () => ({
    normalizeDropboxWebhook: vi.fn(),
  }));

  // Use the real adapter path-mapper. `computePath` now delegates to
  // `githubPullRequestPath` etc. — mocking it would defeat the test.

  vi.doMock("@relayfile/adapter-linear/path-mapper", () => ({
    computeLinearPath: computeLinearPathMock,
    linearIssueByStatePath: linearIssueByStatePathMock,
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

  vi.doMock("@cloud/core/sync/record-writer.js", () => ({
    writeBatchToRelayfile: writeBatchToRelayfileMock,
    buildDeletionRecord: (id: string): Record<string, unknown> => ({
      id,
      _nango_metadata: {
        last_action: "deleted",
        deleted_at: new Date().toISOString(),
      },
    }),
    createWebhookSyncJob: (input: {
      workspaceId: string;
      connectionId: string;
      providerConfigKey: string;
      provider: string;
      syncName: string;
      model: string;
    }) => ({
      type: "nango_sync" as const,
      provider: input.provider,
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey,
      syncName: input.syncName,
      model: input.model,
      modifiedAfter: "",
      cursor: null,
      workspaceId: input.workspaceId,
    }),
  }));

  vi.doMock("@/lib/integrations/nango-service", () => ({
    getNangoConnectionDetails: vi.fn().mockResolvedValue(null),
    getNangoHost: getNangoHostMock,
    getNangoSecretKey: getNangoSecretKeyMock,
    getProviderConfigKey: getProviderConfigKeyMock,
    triggerNangoSyncs: vi.fn(),
    upsertNangoComposioBridgeConnection: vi.fn(),
  }));

  vi.doMock("@/lib/logger", () => ({
    logger: {
      debug: loggerDebugMock,
      error: loggerErrorMock,
      info: loggerInfoMock,
      notice: vi.fn().mockResolvedValue(undefined),
      warn: loggerWarnMock,
    },
  }));

  vi.doMock("@/lib/integrations/nango-slack", () => ({
    getSlackConnectionIdentity: getSlackConnectionIdentityMock,
  }));

  vi.doMock("@/lib/integrations/slack-identity", () => ({
    extractSlackConnectionIdentityFromForwardPayload: vi
      .fn()
      .mockReturnValue({}),
    hasSlackConnectionIdentity: vi.fn().mockReturnValue(false),
    mergeSlackConnectionIdentity: vi.fn().mockReturnValue({}),
    mergeSlackConnectionIdentityMetadata: vi.fn().mockReturnValue({}),
  }));

  vi.doMock("@/lib/env", () => ({
    optionalEnv: optionalEnvMock,
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

  // Side-channel sync trigger is not exercised in these tests.
  vi.doMock("@/lib/integrations/github-incremental-sync-trigger", () => ({
    enqueueIncrementalCloneJob: vi.fn().mockResolvedValue(undefined),
    readPriorCloneManifest: vi.fn().mockResolvedValue(null),
  }));

  // Ricky dispatch fan-outs / dedupe are also out of scope.
  vi.doMock("@/lib/ricky/linear/ingress", () => ({
    dispatchLinearSessionEvent: dispatchLinearSessionEventMock,
  }));
  vi.doMock("@/lib/ricky/slack/ingress", () => ({
    handleRickySlackForward: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock("@/lib/ricky/webhook-dedup", () => ({
    claimWebhookDelivery: vi.fn().mockResolvedValue(true),
  }));

  vi.doMock("@/lib/proactive-runtime/integration-watch-dispatcher", () => ({
    dispatchIntegrationWatchEvent: dispatchIntegrationWatchEventMock,
  }));
}

async function loadRouter(): Promise<RouterModule> {
  vi.resetModules();
  installCommonMocks();
  return (await import(
    new URL(
      "../packages/web/lib/integrations/nango-webhook-router.ts",
      import.meta.url,
    ).href
  )) as RouterModule;
}

function githubEnvelope(body: Record<string, unknown>, event = "pull_request"): NangoWebhookEnvelope {
  return {
    from: "github-relay",
    type: "forward",
    providerConfigKey: "github-relay",
    connectionId: TEST_GITHUB_CONNECTION_ID,
    payload: {
      headers: {
        "x-github-event": event,
        "x-github-delivery": "delivery-abc",
      },
      body,
    },
  };
}

function linearEnvelope(payload: Record<string, unknown>): NangoWebhookEnvelope {
  return {
    from: "linear-relay",
    type: "forward",
    providerConfigKey: "linear-relay",
    connectionId: TEST_LINEAR_CONNECTION_ID,
    payload,
  };
}

beforeEach(() => {
  resetMockDefaults();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("handleGitHubForward — canonical adapter paths (cloud#526 follow-up)", () => {
  it("falls back to GitHub installation.id when the forwarded connection id is stale", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce(null);
    findAllWorkspaceIntegrationsByInstallationMock.mockResolvedValueOnce([
      {
        workspaceId: TEST_WORKSPACE_ID,
        provider: "github",
        connectionId: "current-github-connection",
        providerConfigKey: "github-relay",
        installationId: "133694449",
        metadata: {},
      },
    ]);

    const body = {
      action: "opened",
      installation: { id: 133694449 },
      repository: {
        full_name: "AgentWorkforce/cloud",
        name: "cloud",
        owner: { login: "AgentWorkforce" },
      },
      issue: {
        id: 123,
        number: 870,
        title: "Webhook resolution should survive connection rotation",
      },
    };

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(githubEnvelope(body, "issues"));

    expect(findWorkspaceIntegrationByConnectionMock).toHaveBeenCalledWith(
      "github",
      TEST_GITHUB_CONNECTION_ID,
    );
    expect(findAllWorkspaceIntegrationsByInstallationMock).toHaveBeenCalledWith(
      "github",
      "133694449",
    );
    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(1);
    expect(loggerWarnMock).not.toHaveBeenCalledWith(
      "GitHub forward webhook received with no matching workspace integration",
      expect.anything(),
    );
  });

  it("warns when stale connection fallback finds multiple workspaces for one GitHub installation", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce(null);
    findAllWorkspaceIntegrationsByInstallationMock.mockResolvedValueOnce([
      {
        workspaceId: TEST_WORKSPACE_ID,
        provider: "github",
        connectionId: "current-github-connection",
        providerConfigKey: "github-relay",
        installationId: "133694449",
        metadata: {},
      },
      {
        workspaceId: "66666666-6666-4666-8666-666666666666",
        provider: "github",
        connectionId: "other-github-connection",
        providerConfigKey: "github-relay",
        installationId: "133694449",
        metadata: {},
      },
    ]);

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(
      githubEnvelope(
        {
          action: "opened",
          installation: { id: 133694449 },
          repository: {
            full_name: "AgentWorkforce/cloud",
            name: "cloud",
            owner: { login: "AgentWorkforce" },
          },
          issue: {
            id: 124,
            number: 871,
            title: "Ambiguous installation fallback should warn",
          },
        },
        "issues",
      ),
    );

    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(1);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "GitHub forward webhook installation fallback is ambiguous: multiple workspaces share the installation",
      expect.objectContaining({
        installationId: "133694449",
        matchingWorkspaceIds: [
          TEST_WORKSPACE_ID,
          "66666666-6666-4666-8666-666666666666",
        ],
      }),
    );
  });

  it("PR opened webhook writes to the adapter's <n>__<slug>/meta.json path, not the legacy pulls/<n>/metadata.json", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "github",
      connectionId: TEST_GITHUB_CONNECTION_ID,
      providerConfigKey: "github-relay",
      installationId: null,
      metadata: {},
    });

    const prTitle = "Wire forward webhook canonical paths";
    const body = {
      action: "opened",
      repository: {
        full_name: "AgentWorkforce/cloud",
        name: "cloud",
        owner: { login: "AgentWorkforce" },
      },
      pull_request: {
        id: 999,
        number: 42,
        title: prTitle,
      },
    };

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(githubEnvelope(body, "pull_request"));

    expect(ingestWebhookMock).not.toHaveBeenCalled();
    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(1);
    const fanoutEvent = fanoutExceptMock.mock.calls[0]?.[1] as {
      path: string;
    };
    const recordWriterJob = writeBatchToRelayfileMock.mock.calls[0]?.[2] as {
      syncName: string;
      model: string;
    };

    // Don't write the canonical path literally — the whole point of cloud#526
    // is that one helper owns the path shape. Assert against the adapter's
    // output for the same inputs.
    const expectedPath = githubPullRequestPath(
      "AgentWorkforce",
      "cloud",
      "42",
      prTitle,
    );
    expect(fanoutEvent.path).toBe(expectedPath);
    expect(fanoutEvent.path).toContain("/pulls/42__");
    expect(fanoutEvent.path).toContain("__wire-forward-webhook-canonical-paths");
    expect(fanoutEvent.path.endsWith("/meta.json")).toBe(true);
    expect(fanoutEvent.path).not.toContain("/metadata.json");
    expect(recordWriterJob.syncName).toBe("fetch-open-prs");
    expect(recordWriterJob.model).toBe("PullRequest");
  });

  it("issues.opened webhook writes to the adapter's issues/<n>__<slug>/meta.json path", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "github",
      connectionId: TEST_GITHUB_CONNECTION_ID,
      providerConfigKey: "github-relay",
      installationId: null,
      metadata: {},
    });

    const issueTitle = "Track adapter alignment";
    const body = {
      action: "opened",
      repository: {
        full_name: "AgentWorkforce/cloud",
        name: "cloud",
        owner: { login: "AgentWorkforce" },
      },
      issue: {
        id: 555,
        number: 7,
        title: issueTitle,
      },
    };

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(githubEnvelope(body, "issues"));

    expect(ingestWebhookMock).not.toHaveBeenCalled();
    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(1);
    const fanoutEvent = fanoutExceptMock.mock.calls[0]?.[1] as {
      path: string;
    };
    const recordWriterJob = writeBatchToRelayfileMock.mock.calls[0]?.[2] as {
      syncName: string;
      model: string;
    };
    const expectedPath = githubIssuePath(
      "AgentWorkforce",
      "cloud",
      7,
      issueTitle,
    );
    expect(fanoutEvent.path).toBe(expectedPath);
    expect(fanoutEvent.path).toContain("/issues/7__");
    expect(recordWriterJob.syncName).toBe("fetch-open-issues");
    expect(recordWriterJob.model).toBe("Issue");
  });

  it("issues.labeled webhook dispatches the issue path with the added label name", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "github",
      connectionId: TEST_GITHUB_CONNECTION_ID,
      providerConfigKey: "github-relay",
      installationId: null,
      metadata: {},
    });

    const issueTitle = "Clone small issue fails";
    const body = {
      action: "labeled",
      label: { name: "codex", color: "5319e7" },
      repository: {
        full_name: "AgentWorkforce/cloud",
        name: "cloud",
        owner: { login: "AgentWorkforce" },
      },
      issue: {
        id: 555,
        number: 1168,
        title: issueTitle,
        state: "open",
        labels: [{ name: "codex" }],
      },
    };

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(githubEnvelope(body, "issues"));

    const expectedPath = githubIssuePath(
      "AgentWorkforce",
      "cloud",
      1168,
      issueTitle,
    );
    expect(dispatchIntegrationWatchEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: TEST_WORKSPACE_ID,
        provider: "github",
        eventType: "issues.labeled",
        connectionId: TEST_GITHUB_CONNECTION_ID,
        deliveryId: "delivery-abc",
        paths: [expectedPath],
        payload: expect.objectContaining({
          _webhook: expect.objectContaining({
            action: "labeled",
            labelName: "codex",
          }),
        }),
      }),
    );
  });

  it("pull_request_review webhook writes to the adapter's flat reviews/<id>.json path", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "github",
      connectionId: TEST_GITHUB_CONNECTION_ID,
      providerConfigKey: "github-relay",
      installationId: null,
      metadata: {},
    });

    const body = {
      action: "submitted",
      repository: {
        full_name: "AgentWorkforce/cloud",
        name: "cloud",
        owner: { login: "AgentWorkforce" },
      },
      pull_request: { id: 999, number: 42, title: "ignored" },
      review: { id: 9001, state: "approved" },
    };

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(githubEnvelope(body, "pull_request_review"));

    expect(ingestWebhookMock).toHaveBeenCalledTimes(1);
    const ingestCall = ingestWebhookMock.mock.calls[0]?.[0] as { path: string };
    expect(ingestCall.path).toBe(
      githubReviewPath("AgentWorkforce", "cloud", 9001),
    );
    expect(dispatchIntegrationWatchEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "github",
        eventType: "pull_request_review.submitted",
        paths: [
          githubReviewPath("AgentWorkforce", "cloud", 9001),
          `${githubPullRequestPath("AgentWorkforce", "cloud", 42, "ignored").replace(/\/meta\.json$/u, "")}/**`,
        ],
      }),
    );
  });

  it("issue_comment webhook writes to the issue comments path with non-empty content", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "github",
      connectionId: TEST_GITHUB_CONNECTION_ID,
      providerConfigKey: "github-relay",
      installationId: null,
      metadata: {},
    });

    const body = {
      action: "created",
      repository: {
        full_name: "AgentWorkforce/cloud",
        name: "cloud",
        owner: { login: "AgentWorkforce" },
      },
      issue: { id: 1, number: 10, title: "Webhook comment materialization" },
      comment: {
        id: 4441089669,
        body: "testing webhook comments",
        user: { login: "codex", avatar_url: "https://example.com/avatar.png" },
        created_at: "2026-05-13T12:41:04Z",
        updated_at: "2026-05-13T12:41:04Z",
        reactions: { total_count: 1, "+1": 1 },
      },
    };

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(githubEnvelope(body, "issue_comment"));

    const ingestCall = ingestWebhookMock.mock.calls[0]?.[0] as {
      path: string;
      data: Record<string, unknown>;
      event_type: string;
    };
    expect(ingestCall.event_type).toBe("file.updated");
    expect(ingestCall.path).toBe(
      `/github/repos/AgentWorkforce/cloud/issues/${githubNumberSlug(10, "Webhook comment materialization")}/comments/4441089669.json`,
    );
    expect(typeof ingestCall.data.content).toBe("string");
    expect((ingestCall.data.content as string).length).toBeGreaterThan(0);
    expect(ingestCall.data.contentType).toBe("application/json; charset=utf-8");
    expect(JSON.parse(ingestCall.data.content as string)).toMatchObject({
      id: 4441089669,
      body: "testing webhook comments",
      author: { login: "codex" },
    });
  });
});

describe("handleLinearForward — canonical record writer path", () => {
  it("dispatches Linear AgentSessionEvent webhooks only to integration watches by default", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "linear",
      connectionId: TEST_LINEAR_CONNECTION_ID,
      providerConfigKey: "linear-relay",
      installationId: null,
      metadata: {},
    });

    const payload = {
      type: "AgentSessionEvent",
      action: "created",
      organizationId: "org_linear_123",
      appUserId: "app_user_123",
      agentSession: {
        id: "session_linear_123",
        issue: { identifier: "REL-123", title: "Wire agent webhooks" },
      },
      agentActivity: {
        id: "activity_linear_123",
        agentSessionId: "session_linear_123",
        body: "Please continue.",
      },
      promptContext: "<issue identifier=\"REL-123\">Wire agent webhooks</issue>",
      webhookId: "webhook_agent_session_123",
    };

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(linearEnvelope(payload));

    expect(dispatchIntegrationWatchEventMock).toHaveBeenCalledWith({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "linear",
      eventType: "AgentSessionEvent.created",
      connectionId: TEST_LINEAR_CONNECTION_ID,
      deliveryId: null,
      paths: [
        "/linear/agent-sessions/session_linear_123.json",
        "/linear/comments/activity_linear_123.json",
      ],
      payload,
    });
    expect(dispatchLinearSessionEventMock).not.toHaveBeenCalled();
    expect(normalizeLinearWebhookMock).toHaveBeenCalledWith(payload, {});
    expect(writeBatchToRelayfileMock).not.toHaveBeenCalled();
  });

  it("dispatches Linear AgentSessionEvent webhooks to integration watches even when the old Ricky flag is enabled", async () => {
    optionalEnvMock.mockImplementation((name: string) =>
      name === "LINEAR_RICKY_AGENT_SESSION_ENABLED" ? "true" : undefined,
    );
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "linear",
      connectionId: TEST_LINEAR_CONNECTION_ID,
      providerConfigKey: "linear-relay",
      installationId: null,
      metadata: {},
    });

    const payload = {
      type: "AgentSessionEvent",
      action: "created",
      organizationId: "org_linear_123",
      agentSession: {
        id: "session_linear_123",
        creatorId: "human_user_123",
      },
      webhookId: "webhook_agent_session_123",
    };

    const { routeForwardEvent } = await loadRouter();
    await expect(routeForwardEvent(linearEnvelope(payload))).resolves.toBeUndefined();

    expect(dispatchIntegrationWatchEventMock).toHaveBeenCalledWith({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "linear",
      eventType: "AgentSessionEvent.created",
      connectionId: TEST_LINEAR_CONNECTION_ID,
      deliveryId: null,
      paths: [
        "/linear/agent-sessions/session_linear_123.json",
        "/linear/comments/session_linear_123.json",
      ],
      payload,
    });
    expect(dispatchLinearSessionEventMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      type: "AppUserNotification",
      action: "issueAssignedToYou",
      appUserId: "app_user_123",
      notification: { id: "notification_123" },
    },
    {
      type: "PermissionChange",
      action: "teamAccessChanged",
      appUserId: "app_user_123",
      oauthClientId: "oauth_client_123",
      canAccessAllPublicTeams: false,
      addedTeamIds: ["team_123"],
      removedTeamIds: [],
      webhookId: "webhook_permission_123",
      webhookTimestamp: 1_748_344_800_000,
    },
  ])("acknowledges Linear %s webhooks without Relayfile writes", async (payload) => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "linear",
      connectionId: TEST_LINEAR_CONNECTION_ID,
      providerConfigKey: "linear-relay",
      installationId: null,
      metadata: {},
    });

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(linearEnvelope(payload));

    expect(normalizeLinearWebhookMock).toHaveBeenCalledWith(payload, {});
    expect(computeLinearPathMock).not.toHaveBeenCalled();
    expect(ingestWebhookMock).not.toHaveBeenCalled();
    expect(writeBatchToRelayfileMock).not.toHaveBeenCalled();
    expect(dispatchIntegrationWatchEventMock).toHaveBeenCalledWith({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "linear",
      eventType: `${payload.type}.${payload.action}`,
      connectionId: TEST_LINEAR_CONNECTION_ID,
      deliveryId: null,
      paths: [
        payload.type === "AppUserNotification"
          ? "/linear/app-user-notifications/notification_123.json"
          : "/linear/permission-changes/webhook_permission_123.json",
      ],
      payload,
    });
    expect(loggerInfoMock).toHaveBeenCalledWith(
      "Linear operational agent webhook acknowledged without Relayfile write",
      expect.objectContaining({
        area: "nango-webhook",
        workspaceId: TEST_WORKSPACE_ID,
        connectionId: TEST_LINEAR_CONNECTION_ID,
        type: payload.type,
        action: payload.action,
      }),
    );
  });

  it("handles Linear OAuthApp revoked webhooks as workspace integration disconnects", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "linear",
      connectionId: TEST_LINEAR_CONNECTION_ID,
      providerConfigKey: "linear-relay",
      installationId: null,
      name: "ricky-linear",
      metadata: {},
    });

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(
      linearEnvelope({
        type: "OAuthApp",
        action: "revoked",
        organizationId: "org_linear_123",
        oauthClientId: "oauth_client_123",
        webhookId: "webhook_oauth_revoked_123",
        webhookTimestamp: 1_748_344_800_000,
      }),
    );

    expect(dispatchIntegrationWatchEventMock).toHaveBeenCalledWith({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "linear",
      eventType: "OAuthApp.revoked",
      connectionId: TEST_LINEAR_CONNECTION_ID,
      deliveryId: null,
      paths: ["/linear/oauth-app/oauth_client_123.json"],
      payload: expect.objectContaining({
        type: "OAuthApp",
        action: "revoked",
        oauthClientId: "oauth_client_123",
      }),
    });
    expect(recordWorkspaceIntegrationDisconnectMock).toHaveBeenCalledWith({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "linear",
      connectionId: TEST_LINEAR_CONNECTION_ID,
      providerConfigKey: "linear-relay",
    });
    expect(deleteWorkspaceIntegrationMock).toHaveBeenCalledWith(
      TEST_WORKSPACE_ID,
      "linear",
      "ricky-linear",
    );
    expect(normalizeLinearWebhookMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "OAuthApp",
        action: "revoked",
        oauthClientId: "oauth_client_123",
      }),
      {},
    );
    expect(writeBatchToRelayfileMock).not.toHaveBeenCalled();
  });

  it("Linear issue update writes the full issue record through writeBatchToRelayfile", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "linear",
      connectionId: TEST_LINEAR_CONNECTION_ID,
      providerConfigKey: "linear-relay",
      installationId: null,
      metadata: {},
    });

    computeLinearPathMock.mockReturnValue("/linear/issues/issue-123.json");

    // `hasCompleteLinearForwardData` requires id, identifier, title, state,
    // priority, url, createdAt, updatedAt for `issue`. Build a payload whose
    // `.data` survives that gate (it's the data block the handler ingests).
    const issueData = {
      id: "issue-uuid-001",
      identifier: "REL-42",
      title: "Linear forward webhook content",
      state: { id: "s1", name: "Started" },
      priority: 2,
      url: "https://linear.app/relayfile/issue/REL-42",
      createdAt: "2026-05-12T00:00:00.000Z",
      updatedAt: "2026-05-12T00:01:00.000Z",
    };

    normalizeLinearWebhookMock.mockReturnValue({
      provider: "linear",
      connectionId: TEST_LINEAR_CONNECTION_ID,
      eventType: "issue.update",
      objectType: "issue",
      objectId: "issue-uuid-001",
      payload: { data: issueData },
    });

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(
      linearEnvelope({
        action: "update",
        type: "Issue",
        data: issueData,
      }),
    );

    expect(ingestWebhookMock).not.toHaveBeenCalled();
    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(1);
    const [, records, job] = writeBatchToRelayfileMock.mock.calls[0] ?? [];

    expect(records).toEqual([
      expect.objectContaining({
        id: "issue-uuid-001",
        identifier: "REL-42",
        title: "Linear forward webhook content",
      }),
    ]);
    expect(job).toMatchObject({
      provider: "linear",
      syncName: "fetch-active-issues",
      model: "LinearIssue",
    });
  });

  it("Linear comment webhooks with issueId write through writeBatchToRelayfile", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "linear",
      connectionId: TEST_LINEAR_CONNECTION_ID,
      providerConfigKey: "linear-relay",
      installationId: null,
      metadata: {},
    });

    computeLinearPathMock.mockReturnValue("/linear/comments/comment-123.json");

    const commentData = {
      id: "comment-uuid-123",
      issueId: "issue-uuid-123",
      userId: "user-uuid-123",
      body: "Looks good",
      createdAt: "2026-05-12T00:00:00.000Z",
      updatedAt: "2026-05-12T00:01:00.000Z",
    };

    normalizeLinearWebhookMock.mockReturnValue({
      provider: "linear",
      connectionId: TEST_LINEAR_CONNECTION_ID,
      eventType: "comment.create",
      objectType: "comment",
      objectId: "comment-uuid-123",
      payload: { data: commentData },
    });

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(
      linearEnvelope({
        action: "create",
        type: "Comment",
        data: commentData,
      }),
    );

    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(1);
    const [, records, job] = writeBatchToRelayfileMock.mock.calls[0] ?? [];
    expect(records).toEqual([
      expect.objectContaining({
        id: "comment-uuid-123",
        issueId: "issue-uuid-123",
      }),
    ]);
    expect(job).toMatchObject({
      provider: "linear",
      syncName: "fetch-comments",
      model: "LinearComment",
    });
  });

  it.each([
    {
      name: "label",
      objectType: "label",
      eventType: "label.create",
      syncName: "fetch-labels",
      model: "LinearLabel",
      path: "/linear/labels/label-uuid-123.json",
      data: {
        id: "label-uuid-123",
        name: "Escalation",
        color: "#95a2b3",
        team: { id: "team-uuid-123", name: "Engineering" },
        createdAt: "2026-06-17T10:00:00.000Z",
        updatedAt: "2026-06-17T10:00:00.000Z",
      },
    },
    {
      name: "project",
      objectType: "project",
      eventType: "project.update",
      syncName: "fetch-projects",
      model: "LinearProject",
      path: "/linear/projects/project-uuid-123/meta.json",
      data: {
        id: "project-uuid-123",
        name: "Label Materialization",
        url: "https://linear.app/relayfile/project/label-materialization",
        description: null,
        team_ids: ["team-uuid-123"],
        createdAt: "2026-06-17T10:00:00.000Z",
        updatedAt: "2026-06-17T10:00:00.000Z",
      },
    },
  ])("Linear $name webhooks reconcile through writeBatchToRelayfile", async (input) => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "linear",
      connectionId: TEST_LINEAR_CONNECTION_ID,
      providerConfigKey: "linear-relay",
      installationId: null,
      metadata: {},
    });

    computeLinearPathMock.mockReturnValue(input.path);
    normalizeLinearWebhookMock.mockReturnValue({
      provider: "linear",
      connectionId: TEST_LINEAR_CONNECTION_ID,
      eventType: input.eventType,
      objectType: input.objectType,
      objectId: input.data.id,
      payload: { data: input.data },
    });

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(
      linearEnvelope({
        action: input.eventType.split(".").at(-1),
        type: input.objectType,
        data: input.data,
      }),
    );

    expect(ingestWebhookMock).not.toHaveBeenCalled();
    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(1);
    const [, records, job] = writeBatchToRelayfileMock.mock.calls[0] ?? [];
    expect(records).toEqual([expect.objectContaining({ id: input.data.id })]);
    expect(job).toMatchObject({
      provider: "linear",
      syncName: input.syncName,
      model: input.model,
    });
  });

  it("Linear deletion writes a tombstone through writeBatchToRelayfile", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "linear",
      connectionId: TEST_LINEAR_CONNECTION_ID,
      providerConfigKey: "linear-relay",
      installationId: null,
      metadata: {},
    });

    computeLinearPathMock.mockReturnValue("/linear/issues/issue-321.json");

    normalizeLinearWebhookMock.mockReturnValue({
      provider: "linear",
      connectionId: TEST_LINEAR_CONNECTION_ID,
      eventType: "issue.remove",
      objectType: "issue",
      objectId: "issue-uuid-321",
      // `isLinearForwardDeletionEvent` walks the normalized payload + eventType.
      // `remove`-shaped actions land on the deletion branch (see
      // REMOVAL_OPERATIONS + isRemovalOperation).
      payload: { data: { id: "issue-uuid-321" } },
    });

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(
      linearEnvelope({
        action: "remove",
        type: "Issue",
        data: { id: "issue-uuid-321" },
      }),
    );

    expect(ingestWebhookMock).not.toHaveBeenCalled();
    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(1);
    const [, records, job] = writeBatchToRelayfileMock.mock.calls[0] ?? [];

    expect(records).toEqual([
      expect.objectContaining({
        id: "issue-uuid-321",
        _nango_metadata: expect.objectContaining({
          last_action: "deleted",
        }),
      }),
    ]);
    expect(job).toMatchObject({
      provider: "linear",
      syncName: "fetch-active-issues",
      model: "LinearIssue",
    });
  });

  it("does not fan out Linear issue events when the Relayfile primary write fails", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "linear",
      connectionId: TEST_LINEAR_CONNECTION_ID,
      providerConfigKey: "linear-relay",
      installationId: null,
      metadata: {},
    });

    computeLinearPathMock.mockReturnValue("/linear/issues/issue-123.json");
    writeBatchToRelayfileMock.mockResolvedValueOnce({ written: 0, deleted: 0, errors: 1 });

    const issueData = {
      id: "issue-uuid-001",
      identifier: "REL-42",
      title: "Linear forward webhook content",
      state: { id: "s1", name: "Started" },
      priority: 2,
      url: "https://linear.app/relayfile/issue/REL-42",
      createdAt: "2026-05-12T00:00:00.000Z",
      updatedAt: "2026-05-12T00:01:00.000Z",
    };

    normalizeLinearWebhookMock.mockReturnValue({
      provider: "linear",
      connectionId: TEST_LINEAR_CONNECTION_ID,
      eventType: "issue.update",
      objectType: "issue",
      objectId: "issue-uuid-001",
      payload: { data: issueData },
    });

    const { routeForwardEvent } = await loadRouter();

    await expect(
      routeForwardEvent(
        linearEnvelope({
          action: "update",
          type: "Issue",
          data: issueData,
        }),
      ),
    ).rejects.toThrow("Relayfile provider write failed for linear/LinearIssue");

    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(1);
    expect(dispatchIntegrationWatchEventMock).not.toHaveBeenCalled();
    expect(fanoutExceptMock).not.toHaveBeenCalled();
  });

  it("includes by-state alias paths in integration-watch dispatch for issue state transitions", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "linear",
      connectionId: TEST_LINEAR_CONNECTION_ID,
      providerConfigKey: "linear-relay",
      installationId: null,
      metadata: {},
    });

    computeLinearPathMock.mockReturnValue(
      "/linear/issues/REL-42__issue-uuid-001.json",
    );

    const issueData = {
      id: "issue-uuid-001",
      identifier: "REL-42",
      title: "Move issue to ready",
      state: { id: "s2", name: "Ready for Agent" },
      priority: 2,
      url: "https://linear.app/relayfile/issue/REL-42",
      createdAt: "2026-05-12T00:00:00.000Z",
      updatedAt: "2026-05-12T01:00:00.000Z",
      _webhook: {
        eventType: "issue.update",
        action: "update",
        receivedAt: "2026-05-12T01:00:00.000Z",
        previousData: {
          state_name: "Backlog",
          identifier: "REL-42",
        },
      },
    };

    normalizeLinearWebhookMock.mockReturnValue({
      provider: "linear",
      connectionId: TEST_LINEAR_CONNECTION_ID,
      eventType: "issue.update",
      objectType: "issue",
      objectId: "issue-uuid-001",
      payload: { data: issueData },
    });

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(
      linearEnvelope({
        action: "update",
        type: "Issue",
        data: issueData,
      }),
    );

    expect(dispatchIntegrationWatchEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: TEST_WORKSPACE_ID,
        provider: "linear",
        eventType: "issue.update",
        connectionId: TEST_LINEAR_CONNECTION_ID,
        paths: expect.arrayContaining([
          "/linear/issues/REL-42__issue-uuid-001.json",
          "/linear/issues/by-state/ready-for-agent/REL-42.json",
          "/linear/issues/by-state/backlog/REL-42.json",
        ]),
      }),
    );
  });

  it("includes new by-state path in watch dispatch when previousData state is absent", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "linear",
      connectionId: TEST_LINEAR_CONNECTION_ID,
      providerConfigKey: "linear-relay",
      installationId: null,
      metadata: {},
    });

    computeLinearPathMock.mockReturnValue(
      "/linear/issues/REL-77__issue-uuid-077.json",
    );

    const issueData = {
      id: "issue-uuid-077",
      identifier: "REL-77",
      title: "Implement feature",
      state: { id: "s3", name: "In Progress" },
      priority: 1,
      url: "https://linear.app/relayfile/issue/REL-77",
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T01:00:00.000Z",
    };

    normalizeLinearWebhookMock.mockReturnValue({
      provider: "linear",
      connectionId: TEST_LINEAR_CONNECTION_ID,
      eventType: "issue.update",
      objectType: "issue",
      objectId: "issue-uuid-077",
      payload: { data: issueData },
    });

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(
      linearEnvelope({
        action: "update",
        type: "Issue",
        data: issueData,
      }),
    );

    expect(dispatchIntegrationWatchEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        paths: expect.arrayContaining([
          "/linear/issues/REL-77__issue-uuid-077.json",
          "/linear/issues/by-state/in-progress/REL-77.json",
        ]),
      }),
    );
    expect(linearIssueByStatePathMock).toHaveBeenCalledWith("In Progress", "REL-77");
  });
});
