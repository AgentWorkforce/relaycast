import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  hasWorkspaceReadAccess: vi.fn(),
  listWorkspaceIntegrations: vi.fn(),
  buildLegacyConnectedReadiness: vi.fn(),
  readProviderReadiness: vi.fn(),
  getWorkspaceIntegrationProviderDefinition: vi.fn(),
  isWorkspaceIntegrationProvider: vi.fn(),
  deriveProviderState: vi.fn(),
  fetchWorkspaceProviderSyncStatus: vi.fn(),
  summarizeProviderInitialSync: vi.fn(),
  summarizeWritebackHealth: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: mocks.resolveRequestAuth,
}));

vi.mock("@/lib/integrations/integration-route-handler", () => ({
  hasWorkspaceReadAccess: mocks.hasWorkspaceReadAccess,
}));

vi.mock("@/lib/integrations/workspace-integrations", () => ({
  listWorkspaceIntegrations: mocks.listWorkspaceIntegrations,
}));

vi.mock("@/lib/integrations/providers", () => ({
  getWorkspaceIntegrationProviderDefinition:
    mocks.getWorkspaceIntegrationProviderDefinition,
  isWorkspaceIntegrationProvider: mocks.isWorkspaceIntegrationProvider,
}));

vi.mock("@cloud/core/provider-readiness.js", () => ({
  buildLegacyConnectedReadiness: mocks.buildLegacyConnectedReadiness,
  readProviderReadiness: mocks.readProviderReadiness,
}));

vi.mock("@/lib/integrations/provider-status", () => ({
  deriveProviderState: mocks.deriveProviderState,
  fetchWorkspaceProviderSyncStatus: mocks.fetchWorkspaceProviderSyncStatus,
  summarizeProviderInitialSync: mocks.summarizeProviderInitialSync,
  summarizeWritebackHealth: mocks.summarizeWritebackHealth,
}));

import { GET } from "./route";

const auth = {
  userId: "user_123",
  workspaceId: "workspace_123",
  organizationId: "org_123",
  source: "token",
  scopes: ["cli:auth"],
};

function request(): NextRequest {
  return new NextRequest(
    "https://agentrelay.test/api/v1/workspaces/workspace_123/sync",
  );
}

function context(workspaceId = "workspace_123") {
  return {
    params: Promise.resolve({ workspaceId }),
  };
}

function initialSync(state: "complete" | "running") {
  return {
    state,
    enqueuedAt: null,
    startedAt: null,
    completedAt: state === "complete" ? "2026-05-22T10:00:00.000Z" : null,
    failedAt: null,
    lastError: null,
    syncName: null,
    model: null,
    modifiedAfter: null,
    byModel: {},
  };
}

function readiness() {
  return {
    providerConfigKey: "slack-relay",
    initialSync: initialSync("complete"),
  };
}

function writeback() {
  return {
    state: "healthy",
    lagSeconds: null,
    watermarkTs: null,
    lastError: null,
    deadLetteredEnvelopes: 0,
    deadLetteredOps: 0,
    failureCodes: {},
    webhookHealthy: null,
    webhookHealth: {
      healthy: false,
      lastEventAt: null,
      lastError: "No provider sync status is available",
    },
  };
}

describe("GET /api/v1/workspaces/:workspaceId/sync", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveRequestAuth.mockResolvedValue(auth);
    mocks.hasWorkspaceReadAccess.mockReturnValue(true);
    mocks.isWorkspaceIntegrationProvider.mockReturnValue(true);
    mocks.getWorkspaceIntegrationProviderDefinition.mockReturnValue({
      defaultConfigKey: "slack-relay",
    });
    mocks.readProviderReadiness.mockReturnValue(readiness());
    mocks.buildLegacyConnectedReadiness.mockReturnValue(readiness());
    mocks.fetchWorkspaceProviderSyncStatus.mockResolvedValue(null);
    mocks.summarizeWritebackHealth.mockReturnValue(writeback());
    mocks.summarizeProviderInitialSync.mockReturnValue(initialSync("running"));
    mocks.deriveProviderState.mockReturnValue("syncing");
  });

  it("derives aggregate status from summarized model-aware initial sync", async () => {
    mocks.listWorkspaceIntegrations.mockResolvedValue([
      {
        workspaceId: "workspace_123",
        provider: "slack",
        connectionId: "conn_slack",
        providerConfigKey: "slack-relay",
        installationId: null,
        metadata: {},
        createdAt: new Date("2026-05-22T10:00:00.000Z"),
        updatedAt: new Date("2026-05-22T10:00:00.000Z"),
      },
    ]);

    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    expect(mocks.summarizeProviderInitialSync).toHaveBeenCalledWith({
      readiness: readiness(),
      providerConfigKey: "slack-relay",
    });
    expect(mocks.deriveProviderState).toHaveBeenCalledWith({
      initialSync: initialSync("running"),
      writeback: writeback(),
    });
    await expect(response.json()).resolves.toEqual({
      workspaceId: "workspace_123",
      providers: [
        {
          provider: "slack",
          status: "syncing",
          lagSeconds: 0,
          watermarkTs: null,
          lastError: null,
          failureCodes: {},
          deadLetteredEnvelopes: 0,
          deadLetteredOps: 0,
          webhookHealthy: null,
          webhookHealth: {
            healthy: false,
            lastEventAt: null,
            lastError: "No provider sync status is available",
          },
        },
      ],
    });
  });

  it("rejects callers without workspace access", async () => {
    mocks.hasWorkspaceReadAccess.mockReturnValue(false);

    const response = await GET(request(), context());

    expect(response.status).toBe(403);
    expect(mocks.listWorkspaceIntegrations).not.toHaveBeenCalled();
  });
});
