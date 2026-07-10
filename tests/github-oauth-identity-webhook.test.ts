// Reviewer-1 precondition (org-reconcile PR1): a github-oauth-relay
// (user-identity) auth event must be handled WITHOUT touching
// workspace_integrations in any way, and must not be swallowed by the
// generic `github-*` → `github` provider heuristic — the identity guard in
// handleAuthEvent routes it to a dedicated user_integrations handler first.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findWorkspaceIntegrationByConnection: vi.fn(),
  insertWorkspaceIntegrationIfAbsent: vi.fn(),
  upsertWorkspaceIntegration: vi.fn(),
  deleteWorkspaceIntegration: vi.fn(),
  recordWorkspaceIntegrationDisconnect: vi.fn(),
  findUserIntegrationByConnection: vi.fn(),
  upsertUserIntegration: vi.fn(),
  deleteUserIntegration: vi.fn(),
  getNangoConnectionDetails: vi.fn(),
  loggerInfo: vi.fn().mockResolvedValue(undefined),
  loggerWarn: vi.fn().mockResolvedValue(undefined),
}));

function installMocks(): void {
  vi.doMock("@/lib/integrations/workspace-integrations", () => ({
    deleteWorkspaceIntegration: mocks.deleteWorkspaceIntegration,
    findSlackIntegrationByConnectionId: vi.fn().mockResolvedValue(null),
    findSlackIntegrationByTeamId: vi.fn().mockResolvedValue(null),
    findWorkspaceIntegrationByConnection: mocks.findWorkspaceIntegrationByConnection,
    findWorkspaceIntegrationByInstallation: vi.fn().mockResolvedValue(null),
    insertWorkspaceIntegrationIfAbsent: mocks.insertWorkspaceIntegrationIfAbsent,
    recordWorkspaceIntegrationDisconnect: mocks.recordWorkspaceIntegrationDisconnect,
    upsertWorkspaceIntegration: mocks.upsertWorkspaceIntegration,
  }));

  vi.doMock("@/lib/integrations/user-integrations", () => ({
    deleteUserIntegration: mocks.deleteUserIntegration,
    findUserIntegrationByConnection: mocks.findUserIntegrationByConnection,
    upsertUserIntegration: mocks.upsertUserIntegration,
  }));

  vi.doMock(
    "@/lib/integrations/nango-service",
    async (importOriginal: () => Promise<Record<string, unknown>>) => {
      // Partial passthrough: the router's wider import graph (backend
      // registry) needs several exports; only the ones this test touches
      // are overridden.
      const actual = await importOriginal();
      return {
        ...actual,
        getNangoConnectionDetails: mocks.getNangoConnectionDetails,
        getNangoHost: vi.fn().mockReturnValue("https://api.nango.dev"),
        getNangoSecretKey: vi.fn().mockReturnValue("test-secret"),
        getProviderConfigKey: vi.fn((provider: string) => `${provider}-relay`),
      };
    },
  );

  vi.doMock("@/lib/logger", () => ({
    logger: {
      debug: vi.fn().mockResolvedValue(undefined),
      error: vi.fn().mockResolvedValue(undefined),
      info: mocks.loggerInfo,
      notice: vi.fn().mockResolvedValue(undefined),
      warn: mocks.loggerWarn,
    },
  }));

  vi.doMock("@/lib/integrations/github-installation-index", () => ({
    upsertGithubInstallationIndex: vi.fn().mockResolvedValue({
      installationIndexed: false,
      repositoriesIndexed: 0,
    }),
    parseGithubInstallationIndexPayload: vi.fn().mockReturnValue(null),
    normalizeGithubRepositoryCoord: vi.fn(),
    backfillGithubInstallationLinksFromWorkspaceIntegrations: vi.fn(),
  }));

  vi.doMock("@cloud/core/provider-readiness.js", async (importOriginal: () => Promise<Record<string, unknown>>) => {
    // The identity handler uses the real writeProviderReadiness shape; only
    // the mark* network-flavored helpers need to stay inert.
    const actual = await importOriginal();
    return {
      ...actual,
      markProviderInitialSyncComplete: vi.fn().mockResolvedValue(undefined),
      markProviderInitialSyncFailed: vi.fn().mockResolvedValue(undefined),
      markProviderInitialSyncQueued: vi.fn().mockResolvedValue(undefined),
      markProviderOAuthConnected: vi.fn().mockResolvedValue(undefined),
    };
  });

  vi.doMock("@nangohq/node", () => ({ Nango: vi.fn() }));
  vi.doMock("@relayfile/sdk", () => ({ RelayFileClient: vi.fn() }));
  vi.doMock("@/lib/integrations/nango-sync-queue", () => ({
    enqueueNangoSyncJob: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock("@/lib/integrations/webhook-consumer-registry", () => ({
    bootstrapRegistryFromEnv: vi.fn().mockReturnValue({
      fanout: vi.fn(),
      fanoutExcept: vi.fn(),
      list: vi.fn().mockReturnValue([]),
      register: vi.fn(),
    }),
  }));
  vi.doMock("@/lib/env", () => ({ optionalEnv: vi.fn().mockReturnValue(undefined) }));
}

type RouterModule = {
  handleAuthEvent: (envelope: {
    from: string;
    type: string;
    providerConfigKey: string;
    connectionId: string | null;
    payload: unknown;
  }) => Promise<void>;
};

async function loadRouter(): Promise<RouterModule> {
  vi.resetModules();
  installMocks();
  return (await import(
    new URL("../packages/web/lib/integrations/nango-webhook-router.ts", import.meta.url).href
  )) as RouterModule;
}

function identityAuthEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    from: "github-oauth-relay",
    type: "auth",
    providerConfigKey: "github-oauth-relay",
    connectionId: "conn-identity-1",
    payload: {
      operation: "creation",
      success: true,
      provider: "github",
      endUser: {
        tags: {
          relayfile_integration_scope_kind: "deployer_user",
          relayfile_integration_user_id: "user-123",
        },
      },
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findWorkspaceIntegrationByConnection.mockResolvedValue(null);
  mocks.findUserIntegrationByConnection.mockResolvedValue(null);
  mocks.getNangoConnectionDetails.mockResolvedValue(null);
  mocks.upsertUserIntegration.mockResolvedValue(undefined);
  mocks.deleteUserIntegration.mockResolvedValue(undefined);
});

describe("github-oauth-relay identity auth events", () => {
  it("writes ONLY a github-oauth user_integrations row — workspace_integrations completely untouched", async () => {
    const { handleAuthEvent } = await loadRouter();
    await handleAuthEvent(identityAuthEnvelope());

    expect(mocks.upsertUserIntegration).toHaveBeenCalledTimes(1);
    const written = mocks.upsertUserIntegration.mock.calls[0][0];
    expect(written).toMatchObject({
      userId: "user-123",
      provider: "github-oauth",
      connectionId: "conn-identity-1",
      providerConfigKey: "github-oauth-relay",
      installationId: null,
    });
    // The collision the guard exists to prevent: never the `github` provider.
    expect(written.provider).not.toBe("github");

    // Zero workspace_integrations interaction of ANY kind.
    expect(mocks.findWorkspaceIntegrationByConnection).not.toHaveBeenCalled();
    expect(mocks.insertWorkspaceIntegrationIfAbsent).not.toHaveBeenCalled();
    expect(mocks.upsertWorkspaceIntegration).not.toHaveBeenCalled();
    expect(mocks.deleteWorkspaceIntegration).not.toHaveBeenCalled();
    expect(mocks.recordWorkspaceIntegrationDisconnect).not.toHaveBeenCalled();
  });

  it("maps removal operations to deleteUserIntegration only", async () => {
    mocks.findUserIntegrationByConnection.mockResolvedValue({
      userId: "user-123",
      provider: "github-oauth",
      name: null,
      connectionId: "conn-identity-1",
      providerConfigKey: "github-oauth-relay",
      installationId: null,
      metadata: {},
    });
    const { handleAuthEvent } = await loadRouter();
    await handleAuthEvent(identityAuthEnvelope({ operation: "deletion" }));

    expect(mocks.deleteUserIntegration).toHaveBeenCalledWith("user-123", "github-oauth", null);
    expect(mocks.upsertUserIntegration).not.toHaveBeenCalled();
    expect(mocks.deleteWorkspaceIntegration).not.toHaveBeenCalled();
    expect(mocks.recordWorkspaceIntegrationDisconnect).not.toHaveBeenCalled();
  });

  it("drops identity events that cannot be mapped to a user (no scope tags, no existing row)", async () => {
    const { handleAuthEvent } = await loadRouter();
    await handleAuthEvent(identityAuthEnvelope({ endUser: { tags: {} } }));

    expect(mocks.upsertUserIntegration).not.toHaveBeenCalled();
    expect(mocks.insertWorkspaceIntegrationIfAbsent).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalled();
  });

  it("control: a github-relay auth event still routes through the normal workspace path", async () => {
    mocks.findWorkspaceIntegrationByConnection.mockResolvedValue(null);
    mocks.getNangoConnectionDetails.mockResolvedValue(null);
    const { handleAuthEvent } = await loadRouter();
    await handleAuthEvent({
      from: "github-relay",
      type: "auth",
      providerConfigKey: "github-relay",
      connectionId: "conn-workspace-1",
      payload: { operation: "creation", success: true },
    });

    // Normal path consults workspace_integrations (reverse lookup) — proving
    // the identity guard did not swallow non-identity github events.
    expect(mocks.findWorkspaceIntegrationByConnection).toHaveBeenCalledWith(
      "github",
      "conn-workspace-1",
    );
    expect(mocks.upsertUserIntegration).not.toHaveBeenCalled();
  });
});
