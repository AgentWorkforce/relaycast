import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  hasWorkspaceReadAccess: vi.fn(),
  hasWorkspaceAccess: vi.fn(),
  getUserIntegration: vi.fn(),
  getWorkspaceIntegration: vi.fn(),
  getWorkspaceIntegrationByName: vi.fn(),
  getNangoConnection: vi.fn(),
  getNangoSecretKey: vi.fn(),
  getNangoSyncScheduleStatuses: vi.fn(),
  getDb: vi.fn(),
  createCredentialStoreS3Client: vi.fn(),
  credentialStoreExists: vi.fn(),
  disconnectIntegrationBackend: vi.fn(),
  resolveWorkspaceIntegrationIdentity: vi.fn(),
  hasWorkspaceIntegrationReadAccess: vi.fn(),
  hasWorkspaceIntegrationAccess: vi.fn(),
  buildLegacyConnectedReadiness: vi.fn(),
  readProviderReadiness: vi.fn(),
  deriveProviderState: vi.fn(),
  fetchWorkspaceProviderSyncStatus: vi.fn(),
  liveNangoInitialSyncSucceeded: vi.fn(),
  summarizeProviderInitialSync: vi.fn(),
  summarizeWritebackHealth: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: mocks.resolveRequestAuth,
}));

vi.mock("sst", () => ({
  Resource: {
    WorkflowStorage: { bucketName: "workflow-storage-test" },
    CredentialEncryptionKey: { value: "test-encryption-key" },
  },
}));

vi.mock("@cloud/core/auth/credential-store.js", () => ({
  CredentialStore: class {
    exists = mocks.credentialStoreExists;
  },
}));

vi.mock("@/lib/db", () => ({
  getDb: mocks.getDb,
}));

vi.mock("@/lib/storage", () => ({
  createCredentialStoreS3Client: mocks.createCredentialStoreS3Client,
}));

vi.mock("@/lib/integrations/integration-route-handler", () => ({
  CLOUD_INTEGRATIONS_WRITE_SCOPE: "cloud:integrations:write",
  hasCloudControlScope: vi.fn(() => true),
  hasWorkspaceAccess: mocks.hasWorkspaceAccess,
  hasWorkspaceReadAccess: mocks.hasWorkspaceReadAccess,
}));

vi.mock("@/lib/integrations/workspace-integrations", () => ({
  getWorkspaceIntegration: mocks.getWorkspaceIntegration,
  getWorkspaceIntegrationByName: mocks.getWorkspaceIntegrationByName,
  upsertWorkspaceIntegration: vi.fn(),
}));

vi.mock("@/lib/integrations/user-integrations", () => ({
  getUserIntegration: mocks.getUserIntegration,
}));

vi.mock("@/lib/integrations/nango-service", () => ({
  createConnectSession: vi.fn(),
  deleteNangoConnection: vi.fn(),
  getNangoConnection: mocks.getNangoConnection,
  getNangoSecretKey: mocks.getNangoSecretKey,
  getNangoSyncScheduleStatuses: mocks.getNangoSyncScheduleStatuses,
  triggerNangoSyncs: vi.fn(async () => ({ ok: true })),
  upsertNangoComposioBridgeConnection: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/lib/integrations/composio-service", () => ({
  createComposioAuthConfig: vi.fn(async () => ({ id: "ac_test" })),
  createComposioConnectionLink: vi.fn(async () => ({
    link_token: "link_test",
    redirect_url: "https://composio.test/connect",
  })),
  deleteComposioConnectedAccount: vi.fn(async () => true),
  getComposioConnectedAccount: vi.fn(async () => ({
    id: "ca_test",
    status: "ACTIVE",
  })),
  listComposioAuthConfigs: vi.fn(async () => [{ id: "ac_test" }]),
  resolveComposioToolkit: vi.fn(async (slug: string) => ({ slug, name: slug })),
}));

vi.mock("@/lib/integrations/disconnect-integration-backend", () => ({
  disconnectIntegrationBackend: mocks.disconnectIntegrationBackend,
}));

vi.mock("@/lib/workspaces/workspace-integration-identity", () => ({
  resolveWorkspaceIntegrationIdentity: mocks.resolveWorkspaceIntegrationIdentity,
  hasWorkspaceIntegrationReadAccess: mocks.hasWorkspaceIntegrationReadAccess,
  hasWorkspaceIntegrationAccess: mocks.hasWorkspaceIntegrationAccess,
}));

vi.mock("@cloud/core/provider-readiness.js", () => ({
  buildLegacyConnectedReadiness: mocks.buildLegacyConnectedReadiness,
  markProviderInitialSyncFailed: vi.fn(async () => undefined),
  markProviderInitialSyncComplete: vi.fn(async () => undefined),
  markProviderInitialSyncQueued: vi.fn(async () => undefined),
  markProviderOAuthConnected: vi.fn(async () => undefined),
  readProviderReadiness: mocks.readProviderReadiness,
}));

vi.mock("@/lib/integrations/provider-status", () => ({
  deriveProviderState: mocks.deriveProviderState,
  fetchWorkspaceProviderSyncStatus: mocks.fetchWorkspaceProviderSyncStatus,
  liveNangoInitialSyncSucceeded: mocks.liveNangoInitialSyncSucceeded,
  summarizeProviderInitialSync: mocks.summarizeProviderInitialSync,
  summarizeWritebackHealth: mocks.summarizeWritebackHealth,
}));

import { BackendPolicyError } from "@/lib/integrations/backend";
import { DELETE, GET } from "./route";

const auth = {
  userId: "user_123",
  workspaceId: "workspace_123",
  organizationId: "org_123",
  source: "session",
  context: {
    user: { id: "user_123", email: "dev@example.test" },
    currentWorkspace: { id: "workspace_123" },
    currentOrganization: { id: "org_123" },
    workspaces: [{ id: "workspace_123" }],
  },
};

function request(connectionId?: string): NextRequest {
  const url = new URL(
    "https://agentrelay.test/api/v1/workspaces/workspace_123/integrations/github/status",
  );
  if (connectionId) {
    url.searchParams.set("connectionId", connectionId);
  }

  return new NextRequest(url);
}

function context(provider = "github") {
  return {
    params: Promise.resolve({
      workspaceId: "workspace_123",
      provider,
    }),
  };
}

function providerCredentialDb(rows: unknown[]) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(async () => rows),
          })),
        })),
      })),
    })),
  };
}

function readiness(overrides: Record<string, unknown> = {}) {
  return {
    oauthConnectedAt: null,
    lastAuthAt: null,
    connectionId: "conn_123",
    providerConfigKey: "github-relay",
    updatedAt: null,
    initialSync: {
      state: "complete",
      enqueuedAt: null,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      lastError: null,
      syncName: null,
      model: null,
      modifiedAfter: null,
      byModel: {},
    },
    ...overrides,
  };
}

describe("GET /api/v1/workspaces/:workspaceId/integrations/:provider/status", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveRequestAuth.mockResolvedValue(auth);
    mocks.hasWorkspaceReadAccess.mockReturnValue(true);
    mocks.hasWorkspaceAccess.mockReturnValue(true);
    mocks.resolveWorkspaceIntegrationIdentity.mockImplementation(
      async (workspaceId: string) => ({
        requestedWorkspaceId: workspaceId,
        appWorkspaceId: workspaceId,
        relayWorkspaceId: workspaceId,
        organizationId: "org_123",
        candidateWorkspaceIds: [workspaceId],
      }),
    );
    mocks.hasWorkspaceIntegrationReadAccess.mockReturnValue(true);
    mocks.hasWorkspaceIntegrationAccess.mockReturnValue(true);
    mocks.readProviderReadiness.mockReturnValue(null);
    mocks.buildLegacyConnectedReadiness.mockReturnValue(readiness());
    mocks.fetchWorkspaceProviderSyncStatus.mockResolvedValue(null);
    mocks.summarizeProviderInitialSync.mockImplementation(
      ({ readiness }) => readiness.initialSync,
    );
    mocks.summarizeWritebackHealth.mockReturnValue({
      webhookHealthy: true,
      webhookHealth: {
        healthy: true,
        lastEventAt: "2026-05-20T10:37:00.000Z",
        lastError: null,
      },
      state: "healthy",
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
    });
    mocks.deriveProviderState.mockReturnValue("ready");
    mocks.liveNangoInitialSyncSucceeded.mockReturnValue(false);
    mocks.getNangoSecretKey.mockReturnValue("test-secret");
    mocks.getNangoConnection.mockResolvedValue({
      backend: "nango",
      connectionId: "conn_123",
      backendIntegrationId: "github-relay",
      status: "active",
      raw: {},
    });
    mocks.getNangoSyncScheduleStatuses.mockResolvedValue({
      ok: true,
      syncs: [
        {
          name: "fetch-repos",
          status: "RUNNING",
          frequency: "every 12 hours",
          nextScheduledSyncAt: "2026-06-04T18:00:00.000Z",
          finishedAt: "2026-06-04T06:00:00.000Z",
        },
      ],
    });
    mocks.getDb.mockReturnValue(providerCredentialDb([]));
    mocks.createCredentialStoreS3Client.mockResolvedValue({ kind: "s3-client" });
    mocks.credentialStoreExists.mockResolvedValue(false);
    mocks.getUserIntegration.mockResolvedValue(null);
    mocks.getWorkspaceIntegrationByName.mockResolvedValue(null);
  });

  it("returns the default Nango backend fields while preserving the legacy providerConfigKey fallback", async () => {
    mocks.getWorkspaceIntegration.mockResolvedValue({
      workspaceId: "workspace_123",
      provider: "github",
      connectionId: "conn_123",
      providerConfigKey: "github-legacy-relay",
      installationId: null,
      metadata: {},
      createdAt: new Date("2026-05-08T12:00:00.000Z"),
      updatedAt: new Date("2026-05-08T12:00:00.000Z"),
    });

    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(mocks.getNangoConnection).toHaveBeenCalledWith(
      "conn_123",
      "github-legacy-relay",
      { provider: "github" },
    );
    expect(body.backendIntegrationId).toEqual(expect.any(String));
    expect(body.backendIntegrationId).not.toHaveLength(0);
    expect(body).toMatchObject({
      ready: true,
      state: "ready",
      provider: "github",
      displayName: "GitHub",
      backend: "nango",
      backendIntegrationId: "github-relay",
      configKey: "github-legacy-relay",
      currentConnectionId: "conn_123",
      connectionMatched: true,
      webhookHealthy: true,
      webhookHealth: {
        healthy: true,
        lastEventAt: "2026-05-20T10:37:00.000Z",
        lastError: null,
      },
      oauth: {
        connected: true,
      },
      nangoSyncSchedules: {
        ok: true,
        syncs: [
          {
            name: "fetch-repos",
            status: "RUNNING",
            frequency: "every 12 hours",
            nextScheduledSyncAt: "2026-06-04T18:00:00.000Z",
            finishedAt: "2026-06-04T06:00:00.000Z",
          },
        ],
      },
    });
    expect(mocks.getNangoSyncScheduleStatuses).toHaveBeenCalledWith({
      providerConfigKey: "github-legacy-relay",
      connectionId: "conn_123",
    });
  });

  it("promotes a stale persisted blob to ready and flags readinessStale when live Nango syncs all succeeded", async () => {
    // Persisted readiness stuck non-complete (durable sync-completion pipeline
    // degraded), but the live Nango schedule reports all syncs SUCCESS. The
    // route should report ready/ready while surfacing readinessStale: true so
    // the broken persisted pipeline is never silently masked.
    mocks.getWorkspaceIntegration.mockResolvedValue({
      workspaceId: "workspace_123",
      provider: "github",
      connectionId: "conn_123",
      providerConfigKey: "github-relay",
      installationId: null,
      metadata: {},
      createdAt: new Date("2026-05-08T12:00:00.000Z"),
      updatedAt: new Date("2026-05-08T12:00:00.000Z"),
    });
    mocks.summarizeProviderInitialSync.mockReturnValue({
      state: "queued",
      enqueuedAt: null,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      lastError: null,
      syncName: null,
      model: null,
      modifiedAfter: null,
      byModel: {},
    });
    // Persisted-derived state is pending; the promoted re-derivation is ready.
    mocks.deriveProviderState
      .mockReturnValueOnce("pending")
      .mockReturnValueOnce("ready");
    mocks.liveNangoInitialSyncSucceeded.mockReturnValue(true);

    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ready: true,
      state: "ready",
      readinessStale: true,
      // Raw persisted blob is preserved for debugging even though we promoted.
      initialSync: { state: "queued" },
    });
  });

  it("leaves readinessStale false when the persisted blob is authoritative", async () => {
    mocks.getWorkspaceIntegration.mockResolvedValue({
      workspaceId: "workspace_123",
      provider: "github",
      connectionId: "conn_123",
      providerConfigKey: "github-relay",
      installationId: null,
      metadata: {},
      createdAt: new Date("2026-05-08T12:00:00.000Z"),
      updatedAt: new Date("2026-05-08T12:00:00.000Z"),
    });
    // liveNangoInitialSyncSucceeded defaults to false in beforeEach.
    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.readinessStale).toBe(false);
  });

  it("reads app-UUID requests from the bound Relayfile workspace", async () => {
    mocks.resolveWorkspaceIntegrationIdentity.mockResolvedValue({
      requestedWorkspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
      appWorkspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
      relayWorkspaceId: "rw_7ccfea89",
      organizationId: "org_123",
      candidateWorkspaceIds: [
        "50587328-441d-4acb-b8f3-dbe1b3c5de99",
        "rw_7ccfea89",
      ],
    });
    mocks.getWorkspaceIntegration.mockResolvedValue({
      workspaceId: "rw_7ccfea89",
      provider: "slack",
      connectionId: "conn_slack",
      providerConfigKey: "slack-relay",
      installationId: null,
      metadata: {},
      createdAt: new Date("2026-05-08T12:00:00.000Z"),
      updatedAt: new Date("2026-05-08T12:00:00.000Z"),
    });

    const url = new URL(
      "https://agentrelay.test/api/v1/workspaces/50587328-441d-4acb-b8f3-dbe1b3c5de99/integrations/slack/status",
    );
    url.searchParams.set("connectionId", "50587328-441d-4acb-b8f3-dbe1b3c5de99");
    const response = await GET(new NextRequest(url), {
      params: Promise.resolve({
        workspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
        provider: "slack",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ready: true,
      currentConnectionId: "conn_slack",
      connectionMatched: true,
    });
    expect(mocks.getWorkspaceIntegration).toHaveBeenCalledWith(
      "rw_7ccfea89",
      "slack",
    );
    expect(mocks.fetchWorkspaceProviderSyncStatus).toHaveBeenCalledWith(
      "rw_7ccfea89",
      "slack",
    );
  });

  it("marks an inactive backend connection as unmatched", async () => {
    mocks.getWorkspaceIntegration.mockResolvedValue({
      workspaceId: "workspace_123",
      provider: "github",
      connectionId: "conn_123",
      providerConfigKey: "github-relay",
      installationId: null,
      metadata: {},
      createdAt: new Date("2026-05-08T12:00:00.000Z"),
      updatedAt: new Date("2026-05-08T12:00:00.000Z"),
    });
    mocks.getNangoConnection.mockResolvedValue({
      backend: "nango",
      connectionId: "conn_123",
      backendIntegrationId: "github-relay",
      status: "inactive",
      raw: {},
    });

    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ready: false,
      state: "ready",
      connectionMatched: false,
      oauth: {
        connected: true,
      },
    });
  });

  it("translates backend configuration failures into a typed 501 response", async () => {
    mocks.getWorkspaceIntegration.mockResolvedValue({
      workspaceId: "workspace_123",
      provider: "github",
      connectionId: "conn_123",
      providerConfigKey: "github-relay",
      installationId: null,
      metadata: {},
      createdAt: new Date("2026-05-08T12:00:00.000Z"),
      updatedAt: new Date("2026-05-08T12:00:00.000Z"),
    });
    mocks.getNangoSecretKey.mockReturnValue(null);

    const response = await GET(request(), context());

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toEqual({
      error: "Nango backend not configured",
      code: "backend_not_configured",
      backend: "nango",
    });
  });

  it("returns pending disconnected status when no integration row exists", async () => {
    mocks.getWorkspaceIntegration.mockResolvedValue(null);
    mocks.deriveProviderState.mockReturnValue("pending");

    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    expect(mocks.getNangoConnection).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      ready: false,
      state: "pending",
      backend: "nango",
      backendIntegrationId: "github-relay",
      currentConnectionId: null,
      connectionMatched: false,
      oauth: {
        connected: false,
      },
    });
  });

  it("reports Daytona connected from provider_credentials plus the credential store", async () => {
    mocks.getDb.mockReturnValue(
      providerCredentialDb([
        {
          id: "cred_daytona",
          status: "connected",
          credentialStoredAt: new Date("2026-06-12T10:00:00.000Z"),
          credentialExpiresAt: new Date("2026-06-13T10:00:00.000Z"),
          lastAuthenticatedAt: new Date("2026-06-12T10:00:00.000Z"),
          updatedAt: new Date("2026-06-12T10:00:00.000Z"),
        },
      ]),
    );
    mocks.credentialStoreExists.mockResolvedValue(true);

    const response = await GET(request(), context("daytona"));

    expect(response.status).toBe(200);
    expect(mocks.createCredentialStoreS3Client).toHaveBeenCalledWith({
      userId: "user_123",
    });
    expect(mocks.credentialStoreExists).toHaveBeenCalledWith("user_123", "daytona");
    expect(mocks.getWorkspaceIntegration).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      ready: true,
      state: "ready",
      provider: "daytona",
      displayName: "Daytona",
      backend: "provider-credential",
      backendIntegrationId: "daytona",
      configKey: "daytona",
      vfsRoot: "/daytona",
      currentConnectionId: "cred_daytona",
      connectionMatched: true,
      oauth: {
        connected: true,
        connectedAt: "2026-06-12T10:00:00.000Z",
        lastAuthAt: "2026-06-12T10:00:00.000Z",
      },
      nangoSyncSchedules: null,
    });
  });

  it("does not report Daytona connected when the credential store object is missing", async () => {
    mocks.getDb.mockReturnValue(
      providerCredentialDb([
        {
          id: "cred_daytona",
          status: "connected",
          credentialStoredAt: new Date("2026-06-12T10:00:00.000Z"),
          credentialExpiresAt: new Date("2026-06-13T10:00:00.000Z"),
          lastAuthenticatedAt: new Date("2026-06-12T10:00:00.000Z"),
          updatedAt: new Date("2026-06-12T10:00:00.000Z"),
        },
      ]),
    );
    mocks.credentialStoreExists.mockResolvedValue(false);

    const response = await GET(request(), context("daytona"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ready: false,
      state: "pending",
      oauth: {
        connected: false,
      },
    });
  });

  it("uses user_integrations when polling deployer_user scope", async () => {
    mocks.getUserIntegration.mockResolvedValue({
      userId: "user_123",
      provider: "github",
      name: null,
      connectionId: "conn_123",
      providerConfigKey: "github-relay",
      installationId: null,
      metadata: {},
      createdAt: new Date("2026-05-08T12:00:00.000Z"),
      updatedAt: new Date("2026-05-08T12:00:00.000Z"),
    });

    const scopedRequest = request();
    scopedRequest.nextUrl.searchParams.set("scope", "deployer_user");
    const response = await GET(scopedRequest, context());

    expect(response.status).toBe(200);
    expect(mocks.getUserIntegration).toHaveBeenCalledWith("user_123", "github");
    expect(mocks.getWorkspaceIntegration).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      oauth: { connected: true },
      currentConnectionId: "conn_123",
      connectionMatched: true,
    });
  });

  it("uses named workspace rows when polling workspace_service_account scope", async () => {
    mocks.getWorkspaceIntegrationByName.mockResolvedValue({
      workspaceId: "workspace_123",
      provider: "github",
      name: "release-bot",
      connectionId: "conn_123",
      providerConfigKey: "github-relay",
      installationId: null,
      metadata: {},
      createdAt: new Date("2026-05-08T12:00:00.000Z"),
      updatedAt: new Date("2026-05-08T12:00:00.000Z"),
    });

    const scopedRequest = request();
    scopedRequest.nextUrl.searchParams.set("scope.kind", "workspace_service_account");
    scopedRequest.nextUrl.searchParams.set("scope.name", "release-bot");
    const response = await GET(scopedRequest, context());

    expect(response.status).toBe(200);
    expect(mocks.getWorkspaceIntegrationByName).toHaveBeenCalledWith(
      "workspace_123",
      "github",
      "release-bot",
    );
    expect(mocks.getWorkspaceIntegration).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      oauth: { connected: true },
      currentConnectionId: "conn_123",
      connectionMatched: true,
    });
  });
});

describe("DELETE /api/v1/workspaces/:workspaceId/integrations/:provider/status", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveRequestAuth.mockResolvedValue(auth);
    mocks.hasWorkspaceAccess.mockReturnValue(true);
    mocks.resolveWorkspaceIntegrationIdentity.mockImplementation(
      async (workspaceId: string) => ({
        requestedWorkspaceId: workspaceId,
        appWorkspaceId: workspaceId,
        relayWorkspaceId: workspaceId,
        organizationId: "org_123",
        candidateWorkspaceIds: [workspaceId],
      }),
    );
    mocks.hasWorkspaceIntegrationAccess.mockReturnValue(true);
    mocks.getWorkspaceIntegration.mockResolvedValue({
      workspaceId: "workspace_123",
      provider: "github",
      connectionId: "conn_123",
      providerConfigKey: "github-relay",
      installationId: null,
      metadata: {},
      createdAt: new Date("2026-05-08T12:00:00.000Z"),
      updatedAt: new Date("2026-05-08T12:00:00.000Z"),
    });
    mocks.disconnectIntegrationBackend.mockResolvedValue(undefined);
  });

  it("translates backend configuration failures into a typed 501 response", async () => {
    mocks.disconnectIntegrationBackend.mockRejectedValue(
      new BackendPolicyError(
        "backend_not_configured",
        "Composio backend not configured",
        "composio",
      ),
    );

    const response = await DELETE(request(), context());

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toEqual({
      error: "Composio backend not configured",
      code: "backend_not_configured",
      backend: "composio",
    });
  });
});
