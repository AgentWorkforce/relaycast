import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  hasWorkspaceReadAccess: vi.fn(),
  resolveWorkspaceIntegrationIdentity: vi.fn(),
  hasWorkspaceIntegrationReadAccess: vi.fn(),
  listWorkspaceIntegrations: vi.fn(),
  buildLegacyConnectedReadiness: vi.fn(),
  readProviderReadiness: vi.fn(),
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

vi.mock("@/lib/workspaces/workspace-integration-identity", () => ({
  resolveWorkspaceIntegrationIdentity: mocks.resolveWorkspaceIntegrationIdentity,
  hasWorkspaceIntegrationReadAccess: mocks.hasWorkspaceIntegrationReadAccess,
}));

vi.mock("@/lib/integrations/workspace-integrations", () => ({
  listWorkspaceIntegrations: mocks.listWorkspaceIntegrations,
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
    "https://agentrelay.test/api/v1/workspaces/workspace_123/integrations",
  );
}

function context(workspaceId = "workspace_123") {
  return {
    params: Promise.resolve({ workspaceId }),
  };
}

function readiness() {
  return {
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

describe("GET /api/v1/workspaces/:workspaceId/integrations", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveRequestAuth.mockResolvedValue(auth);
    mocks.hasWorkspaceReadAccess.mockReturnValue(true);
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
    mocks.readProviderReadiness.mockReturnValue(null);
    mocks.buildLegacyConnectedReadiness.mockReturnValue(readiness());
    mocks.fetchWorkspaceProviderSyncStatus.mockResolvedValue(null);
    mocks.summarizeProviderInitialSync.mockImplementation(
      ({ readiness }) => readiness.initialSync,
    );
    mocks.summarizeWritebackHealth.mockReturnValue(writeback());
    mocks.deriveProviderState.mockReturnValue("ready");
  });

  it("includes providerConfigKey and derives status for each workspace integration", async () => {
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
    await expect(response.json()).resolves.toEqual([
      {
        provider: "slack",
        providerConfigKey: "slack-relay",
        status: "ready",
        connectionId: "conn_slack",
        webhookHealth: {
          healthy: false,
          lastEventAt: null,
          lastError: "No provider sync status is available",
        },
      },
    ]);
    expect(mocks.fetchWorkspaceProviderSyncStatus).toHaveBeenCalledWith(
      "workspace_123",
      "slack",
    );
    expect(mocks.deriveProviderState).toHaveBeenCalledWith({
      initialSync: readiness().initialSync,
      writeback: writeback(),
    });
  });

  it("rejects callers without workspace access", async () => {
    mocks.hasWorkspaceIntegrationReadAccess.mockReturnValue(false);

    const response = await GET(request(), context());

    expect(response.status).toBe(403);
    expect(mocks.listWorkspaceIntegrations).not.toHaveBeenCalled();
  });

  it("lists integrations from the bound Relayfile workspace for app UUID requests", async () => {
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
    mocks.listWorkspaceIntegrations.mockResolvedValue([]);

    const response = await GET(
      request(),
      context("50587328-441d-4acb-b8f3-dbe1b3c5de99"),
    );

    expect(response.status).toBe(200);
    expect(mocks.listWorkspaceIntegrations).toHaveBeenCalledWith("rw_7ccfea89");
  });
});
