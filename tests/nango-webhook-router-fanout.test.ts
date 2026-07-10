import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

const {
  bootstrapRegistryFromEnvMock,
  computePathMock,
  computeLinearPathMock,
  createGitHubRelayfileClientMock,
  deleteWorkspaceIntegrationMock,
  dispatchIntegrationWatchEventMock,
  fanoutExceptMock,
  fanoutMock,
  findSlackIntegrationByConnectionIdMock,
  findSlackIntegrationByTeamIdMock,
  findWorkspaceIntegrationByConnectionMock,
  findWorkspaceIntegrationByInstallationMock,
  findUserIntegrationByConnectionMock,
  forwardSlackToRelayMock,
  upsertUserIntegrationMock,
  deleteUserIntegrationMock,
  getNangoConnectionDetailsMock,
  getNangoHostMock,
  getNangoSecretKeyMock,
  getProviderConfigKeyMock,
  getSlackConnectionIdentityMock,
  ingestWebhookMock,
  listMock,
  loggerDebugMock,
  loggerErrorMock,
  loggerInfoMock,
  loggerWarnMock,
  markProviderInitialSyncCompleteMock,
  markProviderInitialSyncFailedMock,
  markProviderInitialSyncQueuedMock,
  markProviderOAuthConnectedMock,
  nangoConstructorMock,
  nangoProxyMock,
  normalizeLinearWebhookMock,
  normalizeWebhookMock,
  recordWorkspaceIntegrationDisconnectMock,
  registerMock,
  relayfileConstructorMock,
  resolveRelayfileCredentialWorkspaceIdMock,
  startNangoSyncSchedulesMock,
  triggerNangoSyncsMock,
  upsertWorkspaceIntegrationMock,
  writeBatchToRelayfileMock,
} = vi.hoisted(() => ({
  bootstrapRegistryFromEnvMock: vi.fn(),
  computePathMock: vi.fn(),
  computeLinearPathMock: vi.fn(() => "/linear/issues/issue-123.json"),
  createGitHubRelayfileClientMock: vi.fn(),
  deleteWorkspaceIntegrationMock: vi.fn(),
  dispatchIntegrationWatchEventMock: vi.fn().mockResolvedValue({
    delivered: 0,
    failed: 0,
    matched: 0,
  }),
  fanoutExceptMock: vi.fn(),
  fanoutMock: vi.fn(),
  findSlackIntegrationByConnectionIdMock: vi.fn(),
  findSlackIntegrationByTeamIdMock: vi.fn(),
  findWorkspaceIntegrationByConnectionMock: vi.fn(),
  findWorkspaceIntegrationByInstallationMock: vi.fn(),
  findUserIntegrationByConnectionMock: vi.fn(),
  forwardSlackToRelayMock: vi.fn().mockResolvedValue({ status: "skipped", reason: "not linked" }),
  upsertUserIntegrationMock: vi.fn(),
  deleteUserIntegrationMock: vi.fn(),
  getNangoConnectionDetailsMock: vi.fn(),
  getNangoHostMock: vi.fn(),
  getNangoSecretKeyMock: vi.fn(),
  getProviderConfigKeyMock: vi.fn(),
  getSlackConnectionIdentityMock: vi.fn(),
  ingestWebhookMock: vi.fn(),
  listMock: vi.fn(),
  loggerDebugMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  markProviderInitialSyncCompleteMock: vi.fn().mockResolvedValue(undefined),
  markProviderInitialSyncFailedMock: vi.fn().mockResolvedValue(undefined),
  markProviderInitialSyncQueuedMock: vi.fn().mockResolvedValue(undefined),
  markProviderOAuthConnectedMock: vi.fn().mockResolvedValue(undefined),
  nangoConstructorMock: vi.fn(),
  nangoProxyMock: vi.fn(),
  normalizeLinearWebhookMock: vi.fn(),
  normalizeWebhookMock: vi.fn(),
  recordWorkspaceIntegrationDisconnectMock: vi.fn(),
  registerMock: vi.fn(),
  relayfileConstructorMock: vi.fn(),
  resolveRelayfileCredentialWorkspaceIdMock: vi.fn(),
  startNangoSyncSchedulesMock: vi.fn(),
  triggerNangoSyncsMock: vi.fn(),
  upsertWorkspaceIntegrationMock: vi.fn(),
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
  routeNangoWebhook: (envelope: NangoWebhookEnvelope) => Promise<void>;
};

type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type FetchMock = ReturnType<typeof vi.fn>;

const ORIGINAL_WEBHOOK_CONSUMERS_JSON = process.env.WEBHOOK_CONSUMERS_JSON;
const ORIGINAL_SAGE_WEBHOOK_URL = process.env.SAGE_WEBHOOK_URL;

function okFanoutResult() {
  return {
    total: 1,
    succeeded: ["consumer"],
    failed: [],
    skipped: [],
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

async function flushPromises(turns = 3): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await Promise.resolve();
  }
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
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
  findUserIntegrationByConnectionMock.mockResolvedValue(null);
  findSlackIntegrationByConnectionIdMock.mockResolvedValue(null);
  findSlackIntegrationByTeamIdMock.mockResolvedValue(null);
  findWorkspaceIntegrationByInstallationMock.mockResolvedValue(null);
  upsertWorkspaceIntegrationMock.mockResolvedValue(undefined);
  upsertUserIntegrationMock.mockResolvedValue(undefined);
  deleteUserIntegrationMock.mockResolvedValue(undefined);
  deleteWorkspaceIntegrationMock.mockResolvedValue(undefined);
  recordWorkspaceIntegrationDisconnectMock.mockResolvedValue(undefined);
  resolveRelayfileCredentialWorkspaceIdMock.mockImplementation(async (workspaceId: string) => workspaceId);
  getSlackConnectionIdentityMock.mockResolvedValue(null);
  writeBatchToRelayfileMock.mockResolvedValue({ written: 1, deleted: 0, errors: 0 });
  startNangoSyncSchedulesMock.mockResolvedValue({ ok: true, syncs: [] });
  triggerNangoSyncsMock.mockResolvedValue({ ok: true });

  createGitHubRelayfileClientMock.mockReturnValue({
    ingestWebhook: ingestWebhookMock,
  });
  ingestWebhookMock.mockResolvedValue({ status: "queued", id: "evt-1" });
  computePathMock.mockReturnValue(
    "/github/repos/AgentWorkforce/cloud/pulls/17/metadata.json",
  );
  normalizeWebhookMock.mockReturnValue({
    provider: "github",
    connectionId: "conn-github-123",
    eventType: "pull_request.opened",
    objectType: "pull_request",
    objectId: "17",
    payload: createGitHubBody(),
  });
  normalizeLinearWebhookMock.mockReturnValue({
    provider: "linear",
    connectionId: "conn-linear-123",
    eventType: "issue.update",
    objectType: "issue",
    objectId: "issue-123",
    payload: {},
  });

  getNangoHostMock.mockReturnValue("https://api.nango.dev");
  getNangoSecretKeyMock.mockReturnValue("test-nango-secret");
  getProviderConfigKeyMock.mockImplementation((provider: string) => `${provider}-sage`);
  getNangoConnectionDetailsMock.mockResolvedValue(null);
  nangoProxyMock.mockImplementation(async (input?: { params?: { channel?: string } }) => {
    const channel = input?.params?.channel;
    return {
      status: 200,
      data: {
        ok: true,
        channel: {
          ...(channel ? { id: channel } : {}),
          name: "fallback-channel",
        },
      },
    };
  });
  nangoConstructorMock.mockImplementation(function Nango() {
    return {
      proxy: nangoProxyMock,
    };
  });
  relayfileConstructorMock.mockImplementation(function RelayFileClient() {
    return {
      ingestWebhook: ingestWebhookMock,
    };
  });

  loggerDebugMock.mockResolvedValue(undefined);
  loggerErrorMock.mockResolvedValue(undefined);
  loggerInfoMock.mockResolvedValue(undefined);
  loggerWarnMock.mockResolvedValue(undefined);
}

function installCommonMocks(): void {
  vi.doMock("@cloud/core/provider-readiness.js", () => ({
    markProviderInitialSyncComplete: markProviderInitialSyncCompleteMock,
    markProviderInitialSyncFailed: markProviderInitialSyncFailedMock,
    markProviderInitialSyncQueued: markProviderInitialSyncQueuedMock,
    markProviderOAuthConnected: markProviderOAuthConnectedMock,
    writeProviderReadiness: (
      metadata: Record<string, unknown>,
      patch: Record<string, unknown>,
    ) => ({
      ...metadata,
      readiness: patch,
    }),
  }));

  vi.doMock("@cloud/core/sync/record-writer.js", () => ({
    buildDeletionRecord: (id: string): Record<string, unknown> => ({
      id,
      _nango_metadata: { last_action: "deleted" },
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
    writeBatchToRelayfile: writeBatchToRelayfileMock,
  }));

  vi.doMock("@cloud/core/sync/notion-record-shapes.js", () => ({
    NOTION_PAGE_CONTENT_MODEL: "NotionPageContent",
    NOTION_PAGE_MODEL: "NotionPage",
    buildNotionContentRecord: vi.fn(),
    buildNotionPageRecord: vi.fn(),
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

  vi.doMock("@/lib/integrations/relayfile-integration-push", () => ({
    resolveRelayfileCredentialWorkspaceId: resolveRelayfileCredentialWorkspaceIdMock,
  }));

  vi.doMock("@/lib/integrations/github-incremental-sync-trigger", () => ({
    enqueueIncrementalCloneJob: vi.fn().mockResolvedValue(null),
    readPriorCloneManifest: vi.fn().mockResolvedValue(null),
  }));

  vi.doMock("@/lib/integrations/workspace-integrations", () => ({
    deleteWorkspaceIntegration: deleteWorkspaceIntegrationMock,
    findSlackIntegrationByConnectionId: findSlackIntegrationByConnectionIdMock,
    findSlackIntegrationByTeamId: findSlackIntegrationByTeamIdMock,
    findWorkspaceIntegrationByConnection: findWorkspaceIntegrationByConnectionMock,
    findWorkspaceIntegrationByInstallation: findWorkspaceIntegrationByInstallationMock,
    recordWorkspaceIntegrationDisconnect: recordWorkspaceIntegrationDisconnectMock,
    upsertWorkspaceIntegration: upsertWorkspaceIntegrationMock,
  }));

  vi.doMock("@/lib/integrations/user-integrations", () => ({
    deleteUserIntegration: deleteUserIntegrationMock,
    findUserIntegrationByConnection: findUserIntegrationByConnectionMock,
    upsertUserIntegration: upsertUserIntegrationMock,
  }));

  vi.doMock("@/lib/integrations/github-relayfile", () => ({
    buildGitHubWebhookFileData: vi.fn((normalized: { payload?: Record<string, unknown> }) => normalized.payload ?? {}),
    // Identity passthrough: this suite asserts fanout/ingest mechanics, not
    // the delivery-payload author enrichment (covered in the forward test).
    enrichGitHubWatchPayload: vi.fn(
      (data: Record<string, unknown>) => data,
    ),
    buildGitHubWebhookIngestData: vi.fn((normalized: { eventType?: string; payload?: Record<string, unknown> }) => ({
      eventType: "file.updated",
      data: normalized.payload ?? {},
    })),
    computePath: computePathMock,
    createGitHubRelayfileClient: createGitHubRelayfileClientMock,
    getGitHubWebhookRecordWriterTarget: vi.fn().mockReturnValue({
      syncName: "fetch-open-prs",
      model: "PullRequest",
    }),
    normalizeWebhook: normalizeWebhookMock,
  }));

  vi.doMock("@/lib/integrations/slack-relay-bridge/bridge", () => ({
    forwardSlackToRelay: forwardSlackToRelayMock,
  }));
  vi.doMock("@/lib/integrations/slack-relay-bridge/relaycast", () => ({
    createRelaycastPoster: vi.fn(() => ({})),
  }));
  vi.doMock("@/lib/integrations/slack-relay-bridge/store", () => ({
    createSlackRelayBridgeStore: vi.fn(() => ({})),
  }));

  vi.doMock("@relayfile/adapter-linear", () => ({
    normalizeLinearWebhook: normalizeLinearWebhookMock,
  }));

  vi.doMock("@relayfile/adapter-notion", () => ({
    NotionAdapter: vi.fn(),
  }));

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
    messagePath: vi.fn((channelId: string, ts: string) => `/slack/channels/${channelId}/messages/${ts.replace(".", "_")}/meta.json`),
    slackChannelsIndexPath: vi.fn(() => "/slack/channels/_index.json"),
    threadPath: vi.fn((channelId: string, threadTs: string) => `/slack/channels/${channelId}/threads/${threadTs.replace(".", "_")}/meta.json`),
    threadReplyPath: vi.fn((channelId: string, threadTs: string, replyTs: string) => `/slack/channels/${channelId}/threads/${threadTs.replace(".", "_")}/replies/${replyTs.replace(".", "_")}/meta.json`),
  }));

  vi.doMock("@cloud/core/sync/linear-semantics.js", () => ({
    buildLinearSyncSemantics: vi.fn(),
  }));

  vi.doMock("@/lib/integrations/nango-service", () => ({
    getNangoConnectionDetails: getNangoConnectionDetailsMock,
    getNangoHost: getNangoHostMock,
    getNangoSecretKey: getNangoSecretKeyMock,
    getProviderConfigKey: getProviderConfigKeyMock,
    startNangoSyncSchedules: startNangoSyncSchedulesMock,
    triggerNangoSyncs: triggerNangoSyncsMock,
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
    extractSlackConnectionIdentityFromForwardPayload: vi.fn((payload: Record<string, unknown>) => ({
      teamId: typeof payload?.team_id === "string" ? payload.team_id : null,
      enterpriseId:
        typeof payload?.enterprise_id === "string" ? payload.enterprise_id : null,
      botUserId: null,
      workspaceName: null,
      workspaceUrl: null,
    })),
    hasSlackConnectionIdentity: vi.fn((identity: { teamId?: string | null; enterpriseId?: string | null }) =>
      Boolean(identity?.teamId || identity?.enterpriseId),
    ),
    mergeSlackConnectionIdentity: vi.fn((identity: Record<string, unknown>) => identity),
    mergeSlackConnectionIdentityMetadata: vi.fn((
      metadata: Record<string, unknown>,
      identity: { teamId?: string | null; enterpriseId?: string | null },
    ) => ({
      ...metadata,
      ...(identity.teamId ? { slackTeamId: identity.teamId } : {}),
      ...(identity.enterpriseId ? { slackEnterpriseId: identity.enterpriseId } : {}),
    })),
  }));

  vi.doMock("@/lib/ricky/linear/ingress", () => ({
    dispatchLinearSessionEvent: vi.fn().mockResolvedValue(undefined),
  }));

  vi.doMock("@/lib/ricky/slack/ingress", () => ({
    handleRickySlackForward: vi.fn().mockResolvedValue(undefined),
  }));

  vi.doMock("@/lib/ricky/webhook-dedup", () => ({
    claimWebhookDelivery: vi.fn().mockResolvedValue(true),
  }));

  vi.doMock("@/lib/env", () => ({
    optionalEnv: vi.fn().mockReturnValue(undefined),
  }));

  vi.doMock("@cloud/core/workspace/id.js", () => ({
    isValidWorkspaceIdAny: vi.fn().mockReturnValue(false),
  }));

  vi.doMock("@/lib/proactive-runtime/integration-watch-dispatcher", () => ({
    dispatchIntegrationWatchEvent: dispatchIntegrationWatchEventMock,
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
}

async function loadRouter(options: { mockRegistry?: boolean } = {}): Promise<RouterModule> {
  vi.resetModules();
  installCommonMocks();

  if (options.mockRegistry ?? true) {
    vi.doMock("@/lib/integrations/webhook-consumer-registry", () => ({
      bootstrapRegistryFromEnv: bootstrapRegistryFromEnvMock,
    }));
  } else {
    vi.doUnmock("@/lib/integrations/webhook-consumer-registry");
  }

  return import(
    new URL(
      "../packages/web/lib/integrations/nango-webhook-router.ts",
      import.meta.url,
    ).href
  ) as Promise<RouterModule>;
}

function createSlackEnvelope(payload: Record<string, unknown> = {}): NangoWebhookEnvelope {
  return {
    from: "slack-sage",
    type: "forward",
    providerConfigKey: "slack-sage",
    connectionId: "conn-slack-123",
    payload: {
      event: {
        type: "app_mention",
        text: "hello sage",
      },
      team_id: "T123",
      ...payload,
    },
  };
}

function createGitHubBody(): Record<string, unknown> {
  return {
    action: "opened",
    repository: {
      full_name: "AgentWorkforce/cloud",
      name: "cloud",
      owner: { login: "AgentWorkforce" },
    },
    pull_request: {
      id: 123,
      number: 17,
      title: "Fix webhook fanout",
    },
  };
}

function createGitHubEnvelope(body = createGitHubBody()): NangoWebhookEnvelope {
  return {
    from: "github-sage",
    type: "forward",
    providerConfigKey: "github-sage",
    connectionId: "conn-github-123",
    payload: {
      headers: {
        "x-github-event": "pull_request",
        "x-github-delivery": "delivery-123",
      },
      body,
    },
  };
}

function createGitLabPushEnvelope(): NangoWebhookEnvelope {
  return {
    from: "gitlab-relay",
    type: "forward",
    providerConfigKey: "gitlab-relay",
    connectionId: "conn-gitlab-123",
    payload: {
      headers: {
        "x-gitlab-event": "Push Hook",
        "x-gitlab-event-uuid": "gitlab-delivery-123",
      },
      body: {
        object_kind: "push",
        project: {
          id: 20,
          path_with_namespace: "AgentWorkforce/cloud",
        },
        commits: [
          {
            id: "abc123",
            title: "First commit",
            timestamp: "2026-05-15T09:00:00.000Z",
          },
          {
            id: "def456",
            title: "Second commit",
            timestamp: "2026-05-15T09:05:00.000Z",
          },
        ],
      },
    },
  };
}

function createGitLabIssueDeleteEnvelope(): NangoWebhookEnvelope {
  return {
    from: "gitlab-relay",
    type: "forward",
    providerConfigKey: "gitlab-relay",
    connectionId: "conn-gitlab-123",
    payload: {
      headers: {
        "x-gitlab-event": "Issue Hook",
        "x-gitlab-event-uuid": "gitlab-delivery-issue-delete",
      },
      body: {
        object_kind: "issue",
        project: {
          id: 20,
          path_with_namespace: "AgentWorkforce/cloud",
        },
        object_attributes: {
          id: 3001,
          iid: 17,
          action: "delete",
          title: "Remove stale issue",
          state: "closed",
        },
      },
    },
  };
}

function createJiraBody(): Record<string, unknown> {
  return {
    webhookEvent: "jira:issue_updated",
    issue: {
      id: "10042",
      key: "AGENT-42",
      fields: {
        summary: "Normalize agent webhook context",
        updated: "2026-05-09T12:34:56.000+0000",
        project: {
          id: "10000",
          key: "AGENT",
          name: "Agent Platform",
        },
        status: {
          id: "3",
          name: "In Progress",
          statusCategory: {
            id: 4,
            key: "indeterminate",
            name: "In Progress",
          },
        },
        assignee: {
          accountId: "pii-account-id",
          displayName: "Ada Lovelace",
          emailAddress: "ada@example.com",
        },
        reporter: {
          accountId: "pii-reporter-id",
          displayName: "Grace Hopper",
          emailAddress: "grace@example.com",
        },
      },
    },
  };
}

function createJiraEnvelope(body: Record<string, unknown> = createJiraBody()): NangoWebhookEnvelope {
  return {
    from: "jira-relay",
    type: "forward",
    providerConfigKey: "jira-relay",
    connectionId: "conn-jira-123",
    payload: {
      headers: {
        "x-atlassian-webhook-identifier": "jira-delivery-123",
      },
      body,
    },
  };
}

beforeEach(() => {
  restoreEnvValue("WEBHOOK_CONSUMERS_JSON", ORIGINAL_WEBHOOK_CONSUMERS_JSON);
  restoreEnvValue("SAGE_WEBHOOK_URL", ORIGINAL_SAGE_WEBHOOK_URL);
  resetMockDefaults();
});

afterEach(() => {
  vi.doUnmock("@/lib/integrations/webhook-consumer-registry");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restoreEnvValue("WEBHOOK_CONSUMERS_JSON", ORIGINAL_WEBHOOK_CONSUMERS_JSON);
  restoreEnvValue("SAGE_WEBHOOK_URL", ORIGINAL_SAGE_WEBHOOK_URL);
});

describe("routeNangoWebhook fanout integration", () => {
  it("routes Slack forward envelopes through registry fanout once", async () => {
    const { routeNangoWebhook } = await loadRouter({ mockRegistry: true });
    const envelope = createSlackEnvelope();

    await routeNangoWebhook(envelope);

    expect(fanoutMock).toHaveBeenCalledTimes(1);
    expect(fanoutMock).toHaveBeenCalledWith(
      "slack",
      expect.objectContaining({
        from: "slack",
        type: "forward",
        provider: "slack",
        eventType: "forward",
        providerConfigKey: "slack-sage",
        connectionId: "conn-slack-123",
        payload: envelope.payload,
      }),
    );
  });

  it("routes Slack relayfile forwards by team id when the forwarded connection id is stale", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce(null);
    findSlackIntegrationByConnectionIdMock.mockResolvedValueOnce(null);
    findSlackIntegrationByTeamIdMock.mockResolvedValue({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "slack",
      connectionId: "current-slack-connection",
      providerConfigKey: "slack-relay",
      installationId: null,
      metadata: { slackTeamId: "T123" },
    });

    const { routeNangoWebhook } = await loadRouter({ mockRegistry: true });

    await routeNangoWebhook({
      from: "slack",
      type: "forward",
      providerConfigKey: "slack-relay",
      connectionId: "stale-slack-connection",
      payload: {
        team_id: "T123",
        event: {
          type: "message",
          subtype: "bot_message",
          channel: "C123",
          ts: "1711111000.000100",
          text: "hello relayfile",
          user: "U123",
        },
      },
    });

    expect(findSlackIntegrationByTeamIdMock).toHaveBeenCalledWith("T123");
    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(1);
    expect(loggerErrorMock).not.toHaveBeenCalledWith(
      "Slack relayfile forward webhook received with no matching workspace integration",
      expect.anything(),
    );
  });

  it("writes human Slack messages as message.created before dispatching the proactive VFS trigger", async () => {
    const integration = {
      workspaceId: TEST_WORKSPACE_ID,
      provider: "slack",
      connectionId: "conn-slack-123",
      providerConfigKey: "slack-relay",
      installationId: null,
      metadata: { slackTeamId: "T123" },
    };
    findWorkspaceIntegrationByConnectionMock
      .mockResolvedValueOnce(integration)
      .mockResolvedValueOnce(integration);

    const { routeNangoWebhook } = await loadRouter({ mockRegistry: true });

    await routeNangoWebhook({
      from: "slack",
      type: "forward",
      providerConfigKey: "slack-relay",
      connectionId: "conn-slack-123",
      payload: {
        team_id: "T123",
        event: {
          type: "message",
          channel: "C123",
          thread_ts: "1711111000.000100",
          ts: "1711111222.000300",
          event_ts: "1711111222.000300",
          text: "human reply",
          user: "U234",
        },
      },
    });

    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(1);
    const record = writeBatchToRelayfileMock.mock.calls[0]?.[1]?.[0] as Record<string, unknown>;
    expect(record).toMatchObject({
      id: "C123:1711111222.000300",
      channel: "C123",
      thread_ts: "1711111000.000100",
      ts: "1711111222.000300",
      text: "human reply",
      user: "U234",
      _webhook: { eventType: "message.created" },
    });
    expect(dispatchIntegrationWatchEventMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "slack",
      eventType: "message.created",
      connectionId: "conn-slack-123",
      deliveryId: null,
      paths: [
        "/slack/channels/C123__fallback-channel/threads/1711111000_000100/replies/1711111222_000300/meta.json",
        "/slack/channels/C123__fallback-channel/messages/1711111000_000100/replies/**",
      ],
      payload: record,
    }));
    expect(
      writeBatchToRelayfileMock.mock.invocationCallOrder[0],
    ).toBeLessThan(dispatchIntegrationWatchEventMock.mock.invocationCallOrder[0] ?? 0);
  });

  it("drops bot-authored Slack message echoes before Relayfile write and proactive dispatch", async () => {
    const integration = {
      workspaceId: TEST_WORKSPACE_ID,
      provider: "slack",
      connectionId: "conn-slack-123",
      providerConfigKey: "slack-relay",
      installationId: null,
      metadata: { slackTeamId: "T123", slackBotUserId: "U0B2596R7EZ" },
    };
    findWorkspaceIntegrationByConnectionMock
      .mockResolvedValueOnce(integration)
      .mockResolvedValueOnce(integration);

    const { routeNangoWebhook } = await loadRouter({ mockRegistry: true });

    await routeNangoWebhook({
      from: "slack",
      type: "forward",
      providerConfigKey: "slack-relay",
      connectionId: "conn-slack-123",
      payload: {
        team_id: "T123",
        event: {
          type: "message",
          subtype: "bot_message",
          channel: "C123",
          ts: "1711111000.000100",
          event_ts: "1711111000.000100",
          text: "agent response echo",
          user: "U0B2596R7EZ",
          bot_id: "B0123BOT",
        },
      },
    });

    expect(writeBatchToRelayfileMock).not.toHaveBeenCalled();
    expect(dispatchIntegrationWatchEventMock).not.toHaveBeenCalled();
    expect(forwardSlackToRelayMock).not.toHaveBeenCalled();
  });

  it("drops Slack message echoes marked as bot-authored without bot_id", async () => {
    const integration = {
      workspaceId: TEST_WORKSPACE_ID,
      provider: "slack",
      connectionId: "conn-slack-123",
      providerConfigKey: "slack-relay",
      installationId: null,
      metadata: { slackTeamId: "T123" },
    };
    findWorkspaceIntegrationByConnectionMock
      .mockResolvedValueOnce(integration)
      .mockResolvedValueOnce(integration);

    const { routeNangoWebhook } = await loadRouter({ mockRegistry: true });

    await routeNangoWebhook({
      from: "slack",
      type: "forward",
      providerConfigKey: "slack-relay",
      connectionId: "conn-slack-123",
      payload: {
        team_id: "T123",
        event: {
          type: "message",
          subtype: "bot_message",
          channel: "C123",
          ts: "1711111000.000100",
          event_ts: "1711111000.000100",
          text: "agent response echo",
          user: "U999BOT",
          is_bot: true,
        },
      },
    });

    expect(writeBatchToRelayfileMock).not.toHaveBeenCalled();
    expect(dispatchIntegrationWatchEventMock).not.toHaveBeenCalled();
    expect(forwardSlackToRelayMock).not.toHaveBeenCalled();
  });

  it("writes Slack app mentions before dispatching the proactive VFS trigger", async () => {
    const integration = {
      workspaceId: TEST_WORKSPACE_ID,
      provider: "slack",
      connectionId: "conn-slack-123",
      providerConfigKey: "slack-relay",
      installationId: null,
      metadata: { slackTeamId: "T123" },
    };
    findWorkspaceIntegrationByConnectionMock
      .mockResolvedValueOnce(integration)
      .mockResolvedValueOnce(integration);

    const { routeNangoWebhook } = await loadRouter({ mockRegistry: true });

    await routeNangoWebhook({
      from: "slack",
      type: "forward",
      providerConfigKey: "slack-relay",
      connectionId: "conn-slack-123",
      payload: {
        team_id: "T123",
        event: {
          type: "app_mention",
          channel: "C123",
          ts: "1711111000.000100",
          event_ts: "1711111000.000100",
          text: "<@U0B2596R7EZ> file this",
          user: "U234",
        },
      },
    });

    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(1);
    const record = writeBatchToRelayfileMock.mock.calls[0]?.[1]?.[0] as Record<string, unknown>;
    expect(record).toMatchObject({
      id: "C123:1711111000.000100",
      channel: "C123",
      ts: "1711111000.000100",
      text: "<@U0B2596R7EZ> file this",
      user: "U234",
      _webhook: { eventType: "app_mention" },
    });
    expect(dispatchIntegrationWatchEventMock).toHaveBeenCalledWith({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "slack",
      eventType: "app_mention",
      connectionId: "conn-slack-123",
      deliveryId: null,
      paths: ["/slack/channels/C123__fallback-channel/messages/1711111000_000100/meta.json"],
      payload: record,
    });
    expect(
      writeBatchToRelayfileMock.mock.invocationCallOrder[0],
    ).toBeLessThan(dispatchIntegrationWatchEventMock.mock.invocationCallOrder[0] ?? 0);
  });

  it("dispatches threaded Slack app mentions with the reply writeback subtree", async () => {
    const integration = {
      workspaceId: TEST_WORKSPACE_ID,
      provider: "slack",
      connectionId: "conn-slack-123",
      providerConfigKey: "slack-relay",
      installationId: null,
      metadata: { slackTeamId: "T123" },
    };
    findWorkspaceIntegrationByConnectionMock
      .mockResolvedValueOnce(integration)
      .mockResolvedValueOnce(integration);

    const { routeNangoWebhook } = await loadRouter({ mockRegistry: true });

    await routeNangoWebhook({
      from: "slack",
      type: "forward",
      providerConfigKey: "slack-relay",
      connectionId: "conn-slack-123",
      payload: {
        team_id: "T123",
        event: {
          type: "app_mention",
          channel: "C123",
          thread_ts: "1711111000.000100",
          ts: "1711111222.000300",
          event_ts: "1711111222.000300",
          text: "<@U0B2596R7EZ> can you reply here?",
          user: "U234",
        },
      },
    });

    const record = writeBatchToRelayfileMock.mock.calls[0]?.[1]?.[0] as Record<string, unknown>;
    expect(record).toMatchObject({
      id: "C123:1711111222.000300",
      channel: "C123",
      thread_ts: "1711111000.000100",
      ts: "1711111222.000300",
      _webhook: { eventType: "app_mention" },
    });
    expect(dispatchIntegrationWatchEventMock).toHaveBeenCalledWith(expect.objectContaining({
      provider: "slack",
      eventType: "app_mention",
      paths: [
        "/slack/channels/C123__fallback-channel/threads/1711111000_000100/replies/1711111222_000300/meta.json",
        "/slack/channels/C123__fallback-channel/messages/1711111000_000100/replies/**",
      ],
      payload: record,
    }));
  });

  it("stores Jira forward webhooks as privacy-safe relayfile updates and fans out the normalized event", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "jira",
      connectionId: "conn-jira-123",
      providerConfigKey: "jira-relay",
      installationId: null,
      metadata: {},
    });

    const { routeNangoWebhook } = await loadRouter({ mockRegistry: true });

    await routeNangoWebhook(createJiraEnvelope());

    expect(findWorkspaceIntegrationByConnectionMock).toHaveBeenCalledWith(
      "jira",
      "conn-jira-123",
    );
    expect(ingestWebhookMock).not.toHaveBeenCalled();
    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(1);
    const data = writeBatchToRelayfileMock.mock.calls[0]?.[1]?.[0] as Record<string, unknown>;
    expect(data).toMatchObject({
      id: "10042",
      key: "AGENT-42",
      fields: {
        summary: "Normalize agent webhook context",
        status: {
          id: "3",
          name: "In Progress",
        },
        project: {
          id: "10000",
          key: "AGENT",
          name: "Agent Platform",
        },
      },
    });
    expect(writeBatchToRelayfileMock.mock.calls[0]?.[2]).toMatchObject({
      provider: "jira",
      syncName: "fetch-issues",
      model: "JiraIssue",
    });
    expect(fanoutExceptMock).toHaveBeenCalledWith(
      "jira",
      expect.objectContaining({
        provider: "jira",
        connectionId: "conn-jira-123",
        workspaceId: TEST_WORKSPACE_ID,
        eventType: "jira:issue_updated",
        payload: expect.objectContaining({
          id: "10042",
          key: "AGENT-42",
        }),
      }),
      ["relayfile-primary"],
    );
  });

  it("starts GitHub registry fanout after Relayfile ingest succeeds, and fanout failure does not block ingest", async () => {
    const githubBody = createGitHubBody();
    const ingestDeferred = createDeferred<{ written: number; deleted: number; errors: number }>();
    writeBatchToRelayfileMock.mockReturnValueOnce(ingestDeferred.promise);
    fanoutMock.mockRejectedValueOnce(new Error("fanout unavailable"));
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "github",
      connectionId: "conn-github-123",
      providerConfigKey: "github-sage",
      installationId: null,
      metadata: {},
    });
    normalizeWebhookMock.mockReturnValueOnce({
      provider: "github",
      connectionId: "conn-github-123",
      eventType: "pull_request.opened",
      objectType: "pull_request",
      objectId: "17",
      payload: githubBody,
    });

    const { routeNangoWebhook } = await loadRouter({ mockRegistry: true });
    const routePromise = routeNangoWebhook(createGitHubEnvelope(githubBody));

    await vi.waitFor(() => expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(1));
    expect(fanoutExceptMock).not.toHaveBeenCalled();
    ingestDeferred.resolve({ written: 1, deleted: 0, errors: 0 });

    await expect(routePromise).resolves.toBeUndefined();
    expect(fanoutExceptMock).toHaveBeenCalledWith(
      "github",
      expect.objectContaining({
        provider: "github",
        connectionId: "conn-github-123",
        workspaceId: TEST_WORKSPACE_ID,
        eventType: "pull_request.opened",
        path: "/github/repos/AgentWorkforce/cloud/pulls/17/metadata.json",
        deliveryId: "delivery-123",
      }),
      ["relayfile-primary"],
    );
    expect(writeBatchToRelayfileMock.mock.calls[0]?.[2]).toMatchObject({
      provider: "github",
      syncName: "fetch-open-prs",
      model: "PullRequest",
    });
  });

  it("fans out GitHub forward events before surfacing Relayfile batch write errors", async () => {
    writeBatchToRelayfileMock.mockResolvedValueOnce({ written: 0, deleted: 0, errors: 1 });
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "github",
      connectionId: "conn-github-123",
      providerConfigKey: "github-sage",
      installationId: null,
      metadata: {},
    });

    const { routeNangoWebhook } = await loadRouter({ mockRegistry: true });

    await expect(routeNangoWebhook(createGitHubEnvelope())).rejects.toThrow(
      "Relayfile provider write failed for github/PullRequest",
    );
    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(1);
    expect(loggerErrorMock).toHaveBeenCalledWith(
      "Relayfile provider write completed with errors",
      expect.objectContaining({
        provider: "github",
        model: "PullRequest",
        errors: 1,
      }),
    );
    expect(loggerErrorMock).toHaveBeenCalledWith(
      "GitHub forward relayfile primary write failed; continuing webhook fanout",
      expect.objectContaining({
        provider: "github",
        eventType: "pull_request.opened",
        connectionId: "conn-github-123",
        deliveryId: "delivery-123",
      }),
    );
    expect(fanoutExceptMock).toHaveBeenCalledWith(
      "github",
      expect.objectContaining({
        provider: "github",
        connectionId: "conn-github-123",
        workspaceId: TEST_WORKSPACE_ID,
        eventType: "pull_request.opened",
        path: "/github/repos/AgentWorkforce/cloud/pulls/17/metadata.json",
        deliveryId: "delivery-123",
      }),
      ["relayfile-primary"],
    );
  });

  it("fans out all GitLab push commit records while preserving the raw payload", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "gitlab",
      connectionId: "conn-gitlab-123",
      providerConfigKey: "gitlab-relay",
      installationId: null,
      metadata: {},
    });

    const envelope = createGitLabPushEnvelope();
    const { routeNangoWebhook } = await loadRouter({ mockRegistry: true });

    await routeNangoWebhook(envelope);

    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(1);
    expect(writeBatchToRelayfileMock.mock.calls[0]?.[1]).toHaveLength(2);
    expect(writeBatchToRelayfileMock.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "abc123" }),
        expect.objectContaining({ id: "def456" }),
      ]),
    );
    expect(writeBatchToRelayfileMock.mock.calls[0]?.[2]).toMatchObject({
      provider: "gitlab",
      syncName: "fetch-commits",
      model: "GitLabCommit",
    });
    expect(fanoutExceptMock).toHaveBeenCalledWith(
      "gitlab",
      expect.objectContaining({
        provider: "gitlab",
        connectionId: "conn-gitlab-123",
        workspaceId: TEST_WORKSPACE_ID,
        eventType: "push",
        payload: (envelope.payload as { body: Record<string, unknown> }).body,
        data: expect.arrayContaining([
          expect.objectContaining({ id: "abc123" }),
          expect.objectContaining({ id: "def456" }),
        ]),
        deliveryId: "gitlab-delivery-123",
      }),
      ["relayfile-primary"],
    );
  });

  it("triggers a GitLab commit sync when push webhooks are truncated", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "gitlab",
      connectionId: "conn-gitlab-123",
      providerConfigKey: "gitlab-relay",
      installationId: null,
      metadata: {},
    });

    const envelope = createGitLabPushEnvelope();
    const body = (envelope.payload as { body: Record<string, unknown> }).body;
    body.commits = Array.from({ length: 20 }, (_, index) => ({
      id: `commit-${index + 1}`,
      title: `Commit ${index + 1}`,
      timestamp: "2026-05-15T09:00:00.000Z",
    }));
    body.total_commits_count = 25;

    const { routeNangoWebhook } = await loadRouter({ mockRegistry: true });

    await routeNangoWebhook(envelope);

    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(1);
    expect(writeBatchToRelayfileMock.mock.calls[0]?.[1]).toHaveLength(20);
    expect(triggerNangoSyncsMock).toHaveBeenCalledWith({
      providerConfigKey: "gitlab-relay",
      connectionId: "conn-gitlab-123",
      syncs: ["fetch-commits"],
      syncMode: "incremental",
    });
  });

  it("marks GitLab issue delete webhooks as scoped Relayfile tombstones", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "gitlab",
      connectionId: "conn-gitlab-123",
      providerConfigKey: "gitlab-relay",
      installationId: null,
      metadata: {},
    });

    const envelope = createGitLabIssueDeleteEnvelope();
    const { routeNangoWebhook } = await loadRouter({ mockRegistry: true });

    await routeNangoWebhook(envelope);

    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(1);
    expect(writeBatchToRelayfileMock.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({
        id: "3001",
        iid: "17",
        project_id: "20",
        project_path: "AgentWorkforce/cloud",
        title: "Remove stale issue",
        _nango_metadata: expect.objectContaining({
          last_action: "deleted",
        }),
      }),
    ]);
    expect(writeBatchToRelayfileMock.mock.calls[0]?.[2]).toMatchObject({
      provider: "gitlab",
      syncName: "fetch-issues",
      model: "GitLabIssue",
    });
    expect(fanoutExceptMock).toHaveBeenCalledWith(
      "gitlab",
      expect.objectContaining({
        provider: "gitlab",
        eventType: "issue.delete",
        deliveryId: "gitlab-delivery-issue-delete",
      }),
      ["relayfile-primary"],
    );
  });

  it("marks OAuth-connected providers as queued for initial sync on auth webhooks", async () => {
    getNangoConnectionDetailsMock.mockResolvedValueOnce({
      payload: { workspaceId: TEST_WORKSPACE_ID, team: { id: "T123" } },
      installationId: "inst-1",
    });
    const { routeNangoWebhook } = await loadRouter({ mockRegistry: true });

    await routeNangoWebhook({
      from: "github-sage",
      type: "auth",
      providerConfigKey: "github-sage",
      connectionId: "conn-github-123",
      payload: {
        success: true,
        operation: "creation",
        workspaceId: TEST_WORKSPACE_ID,
      },
    });

    expect(upsertWorkspaceIntegrationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: TEST_WORKSPACE_ID,
        provider: "github",
        connectionId: "conn-github-123",
        providerConfigKey: "github-sage",
      }),
    );
    expect(markProviderOAuthConnectedMock).toHaveBeenCalledWith({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "github",
      connectionId: "conn-github-123",
      providerConfigKey: "github-sage",
    });
  });

  it("does not overwrite a workspace integration from an unverified auth webhook connection", async () => {
    const { routeNangoWebhook } = await loadRouter({ mockRegistry: true });

    await routeNangoWebhook({
      from: "github-sage",
      type: "auth",
      providerConfigKey: "github-sage",
      connectionId: "conn-github-raw-only",
      payload: {
        success: true,
        operation: "creation",
        workspaceId: TEST_WORKSPACE_ID,
      },
    });

    expect(upsertWorkspaceIntegrationMock).not.toHaveBeenCalled();
    expect(markProviderOAuthConnectedMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "Nango auth webhook skipped workspace integration write: connection was not verified upstream",
      expect.objectContaining({
        workspaceId: TEST_WORKSPACE_ID,
        provider: "github",
        connectionId: "conn-github-raw-only",
      }),
    );
  });

  it("updates deployer_user rows on auth webhooks when the connect-session pre-created one", async () => {
    findUserIntegrationByConnectionMock.mockResolvedValueOnce({
      userId: "user-123",
      provider: "github",
      name: null,
      connectionId: "conn-user-123",
      providerConfigKey: "github-sage",
      installationId: null,
      metadata: {},
      createdAt: new Date("2026-05-22T10:00:00.000Z"),
      updatedAt: new Date("2026-05-22T10:00:00.000Z"),
    });
    getNangoConnectionDetailsMock.mockResolvedValueOnce({
      payload: { account: { login: "octocat" } },
      installationId: "inst-user-1",
    });
    const { routeNangoWebhook } = await loadRouter({ mockRegistry: true });

    await routeNangoWebhook({
      from: "github-sage",
      type: "auth",
      providerConfigKey: "github-sage",
      connectionId: "conn-user-123",
      payload: {
        success: true,
        operation: "creation",
        workspaceId: TEST_WORKSPACE_ID,
      },
    });

    expect(upsertUserIntegrationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-123",
        provider: "github",
        name: null,
        connectionId: "conn-user-123",
        providerConfigKey: "github-sage",
        installationId: "inst-user-1",
      }),
    );
    expect(upsertWorkspaceIntegrationMock).not.toHaveBeenCalled();
    expect(markProviderOAuthConnectedMock).not.toHaveBeenCalled();
  });

  it("preserves workspace_service_account names on auth webhooks", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "github",
      name: "release-bot",
      connectionId: "conn-service-123",
      providerConfigKey: "github-sage",
      installationId: null,
      metadata: {},
      createdAt: new Date("2026-05-22T10:00:00.000Z"),
      updatedAt: new Date("2026-05-22T10:00:00.000Z"),
    });
    getNangoConnectionDetailsMock.mockResolvedValueOnce({
      payload: { workspaceId: TEST_WORKSPACE_ID, account: { login: "release-bot" } },
      installationId: "inst-service-1",
    });
    const { routeNangoWebhook } = await loadRouter({ mockRegistry: true });

    await routeNangoWebhook({
      from: "github-sage",
      type: "auth",
      providerConfigKey: "github-sage",
      connectionId: "conn-service-123",
      payload: {
        success: true,
        operation: "creation",
        workspaceId: TEST_WORKSPACE_ID,
      },
    });

    expect(upsertWorkspaceIntegrationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: TEST_WORKSPACE_ID,
        provider: "github",
        name: "release-bot",
        connectionId: "conn-service-123",
        providerConfigKey: "github-sage",
        installationId: "inst-service-1",
      }),
    );
    expect(markProviderOAuthConnectedMock).not.toHaveBeenCalled();
  });

  it("deletes the named workspace_service_account row on auth removal webhooks", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "github",
      name: "release-bot",
      connectionId: "conn-service-123",
      providerConfigKey: "github-sage",
      installationId: "inst-service-1",
      metadata: {},
      createdAt: new Date("2026-05-22T10:00:00.000Z"),
      updatedAt: new Date("2026-05-22T10:00:00.000Z"),
    });
    const { routeNangoWebhook } = await loadRouter({ mockRegistry: true });

    await routeNangoWebhook({
      from: "github-sage",
      type: "auth",
      providerConfigKey: "github-sage",
      connectionId: "conn-service-123",
      payload: {
        success: true,
        operation: "deletion",
        workspaceId: TEST_WORKSPACE_ID,
      },
    });

    expect(deleteWorkspaceIntegrationMock).toHaveBeenCalledWith(
      TEST_WORKSPACE_ID,
      "github",
      "release-bot",
    );
  });

  it("routes the new `-relay` Nango config keys to the same workspace provider as the legacy `-sage` keys", async () => {
    // Forward-compat: once the Nango integrations are republished under
    // `-relay` keys, auth/sync envelopes will arrive with the new
    // providerConfigKey. They must resolve to the existing workspace
    // provider id so DB rows are not duplicated. Legacy `-sage` envelopes
    // must continue to route the same way until the migration is complete.
    getNangoConnectionDetailsMock.mockResolvedValue({
      payload: { workspaceId: TEST_WORKSPACE_ID, team: { id: "T123" } },
      installationId: "inst-1",
    });
    const { routeNangoWebhook } = await loadRouter({ mockRegistry: true });

    await routeNangoWebhook({
      from: "github-relay",
      type: "auth",
      providerConfigKey: "github-relay",
      connectionId: "conn-github-relay-1",
      payload: {
        success: true,
        operation: "creation",
        workspaceId: TEST_WORKSPACE_ID,
      },
    });

    expect(upsertWorkspaceIntegrationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: TEST_WORKSPACE_ID,
        // Workspace provider id is unchanged — only the Nango config key
        // is the renamed surface.
        provider: "github",
        connectionId: "conn-github-relay-1",
        providerConfigKey: "github-relay",
      }),
    );
  });

  it("does not surface registry fanout failures from routeNangoWebhook", async () => {
    fanoutMock.mockRejectedValueOnce(new Error("sage is down"));
    const { routeNangoWebhook } = await loadRouter({ mockRegistry: true });

    await expect(routeNangoWebhook(createSlackEnvelope())).resolves.toBeUndefined();

    expect(loggerErrorMock).toHaveBeenCalledWith(
      "Webhook fanout dispatch failed",
      expect.objectContaining({
        area: "webhook-fanout",
        provider: "slack",
        eventType: "forward",
        error: expect.any(String),
      }),
    );
  });

  it("bootstraps the default Sage Slack consumer when WEBHOOK_CONSUMERS_JSON is empty", async () => {
    process.env.WEBHOOK_CONSUMERS_JSON = "";
    process.env.SAGE_WEBHOOK_URL = "https://sage.example";
    const fetchMock: FetchMock = vi.fn();
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const { routeNangoWebhook } = await loadRouter({ mockRegistry: false });
    const envelope = createSlackEnvelope();

    await routeNangoWebhook(envelope);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as Parameters<FetchImpl>;
    expect(String(url)).toBe("https://sage.example/api/webhooks/slack");
    expect(init).toEqual(
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(JSON.parse(String(init?.body))).toEqual(
      expect.objectContaining({
        from: "slack",
        type: "forward",
        provider: "slack",
        eventType: "forward",
        providerConfigKey: "slack-sage",
        connectionId: "conn-slack-123",
        payload: envelope.payload,
      }),
    );
  });
});
