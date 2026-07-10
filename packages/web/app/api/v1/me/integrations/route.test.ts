import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  requireSessionAuth: vi.fn(),
  requireAuthScope: vi.fn(),
  listUserIntegrations: vi.fn(),
  buildLegacyConnectedReadiness: vi.fn(),
  readProviderReadiness: vi.fn(),
  deriveProviderState: vi.fn(),
  fetchWorkspaceProviderSyncStatus: vi.fn(),
  summarizeProviderInitialSync: vi.fn(),
  summarizeWritebackHealth: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  requireAuthScope: mocks.requireAuthScope,
  requireSessionAuth: mocks.requireSessionAuth,
  resolveRequestAuth: mocks.resolveRequestAuth,
}));

vi.mock("@/lib/integrations/user-integrations", () => ({
  listUserIntegrations: mocks.listUserIntegrations,
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
  return new NextRequest("https://agentrelay.test/api/v1/me/integrations");
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
    state: "unknown",
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

describe("GET /api/v1/me/integrations", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveRequestAuth.mockResolvedValue(auth);
    mocks.requireSessionAuth.mockReturnValue(false);
    mocks.requireAuthScope.mockImplementation(
      (authArg, scope) => authArg === auth && scope === "cli:auth",
    );
    mocks.readProviderReadiness.mockReturnValue(null);
    mocks.buildLegacyConnectedReadiness.mockReturnValue(readiness());
    mocks.summarizeProviderInitialSync.mockImplementation(
      ({ readiness }) => readiness.initialSync,
    );
    mocks.summarizeWritebackHealth.mockReturnValue(writeback());
    mocks.deriveProviderState.mockReturnValue("ready");
  });

  it("lists integrations for the authenticated user using the shared integration response shape", async () => {
    mocks.listUserIntegrations.mockResolvedValue([
      {
        userId: "user_123",
        provider: "linear",
        connectionId: "conn_linear",
        providerConfigKey: "linear-relay",
        installationId: null,
        metadata: {},
        createdAt: new Date("2026-05-22T10:00:00.000Z"),
        updatedAt: new Date("2026-05-22T10:00:00.000Z"),
      },
    ]);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(mocks.listUserIntegrations).toHaveBeenCalledWith("user_123");
    expect(mocks.fetchWorkspaceProviderSyncStatus).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual([
      {
        provider: "linear",
        providerConfigKey: "linear-relay",
        status: "ready",
        connectionId: "conn_linear",
        webhookHealth: {
          healthy: false,
          lastEventAt: null,
          lastError: "No provider sync status is available",
        },
      },
    ]);
  });

  it("rejects unauthenticated callers", async () => {
    mocks.resolveRequestAuth.mockResolvedValue(null);

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(mocks.listUserIntegrations).not.toHaveBeenCalled();
  });

  it("rejects authenticated callers without session auth or cli scope", async () => {
    mocks.requireAuthScope.mockReturnValue(false);

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(mocks.listUserIntegrations).not.toHaveBeenCalled();
  });
});
