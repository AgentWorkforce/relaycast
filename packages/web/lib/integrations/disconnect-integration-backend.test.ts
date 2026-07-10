import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteConnection: vi.fn(),
  deleteWorkspaceIntegration: vi.fn(),
  and: vi.fn(),
  eq: vi.fn(),
  getDb: vi.fn(),
  getIntegrationBackend: vi.fn(),
  isGithubInstallationCentricEnabled: vi.fn(),
  recordWorkspaceIntegrationDisconnect: vi.fn(),
  selectIntegrationBackend: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  and: mocks.and,
  eq: mocks.eq,
}));

vi.mock("@/lib/integrations/backend", () => ({
  getIntegrationBackend: mocks.getIntegrationBackend,
  selectIntegrationBackend: mocks.selectIntegrationBackend,
}));

vi.mock("@/lib/db", () => ({
  getDb: mocks.getDb,
}));

vi.mock("@/lib/db/schema", () => ({
  workspaceGithubInstallationLinks: {
    workspaceId: "workspace_github_installation_links.workspace_id",
    installationId: "workspace_github_installation_links.installation_id",
  },
}));

vi.mock("@/lib/integrations/workspace-integrations", () => ({
  deleteWorkspaceIntegration: mocks.deleteWorkspaceIntegration,
  recordWorkspaceIntegrationDisconnect: mocks.recordWorkspaceIntegrationDisconnect,
}));

vi.mock("@/lib/integrations/github-installation-centric-flag", () => ({
  isGithubInstallationCentricEnabled: mocks.isGithubInstallationCentricEnabled,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    warn: mocks.loggerWarn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { disconnectIntegrationBackend } from "./disconnect-integration-backend";
import type { WorkspaceIntegrationRecord } from "./workspace-integrations";

function expectBackendDeleteBeforeWorkspaceDelete() {
  expect(
    mocks.deleteConnection.mock.invocationCallOrder[0],
  ).toBeLessThan(mocks.deleteWorkspaceIntegration.mock.invocationCallOrder[0]);
}

const baseIntegration: WorkspaceIntegrationRecord = {
  id: "integration_123",
  workspaceId: "workspace_123",
  provider: "github",
  connectionId: "conn_123",
  providerConfigKey: "github-custom",
  installationId: null,
  metadata: {},
  createdAt: new Date("2026-05-08T00:00:00.000Z"),
  updatedAt: new Date("2026-05-08T00:00:00.000Z"),
};

describe("disconnectIntegrationBackend", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.eq.mockImplementation((left: unknown, right: unknown) => ({
      op: "eq",
      left,
      right,
    }));
    mocks.and.mockImplementation((...conditions: unknown[]) => ({
      op: "and",
      conditions,
    }));
    mocks.getDb.mockReturnValue({
      delete: vi.fn(() => ({
        where: vi.fn(async () => undefined),
      })),
    });
    mocks.isGithubInstallationCentricEnabled.mockReturnValue(false);
    mocks.deleteConnection.mockResolvedValue(true);
    mocks.recordWorkspaceIntegrationDisconnect.mockResolvedValue({
      workspaceId: "workspace_123",
      provider: "github",
      connectionId: "conn_123",
      providerConfigKey: "github-custom",
      disconnectedAt: new Date("2026-05-08T00:00:00.000Z"),
      expiresAt: new Date("2026-05-15T00:00:00.000Z"),
      createdAt: new Date("2026-05-08T00:00:00.000Z"),
      updatedAt: new Date("2026-05-08T00:00:00.000Z"),
    });
    mocks.deleteWorkspaceIntegration.mockResolvedValue(undefined);
    mocks.getIntegrationBackend.mockResolvedValue({
      backend: "nango",
      deleteConnection: mocks.deleteConnection,
    });
    mocks.selectIntegrationBackend.mockReturnValue({
      provider: "github",
      backend: "nango",
      backendIntegrationId: "github-relay",
      backendMetadata: {},
    });
  });

  it("is a no-op when no workspace integration row exists", async () => {
    const result = await disconnectIntegrationBackend({
      workspaceId: "workspace_123",
      provider: "github",
      integration: null,
    });

    expect(result).toEqual({
      localDeleted: false,
      upstreamDelete: {
        success: true,
        backend: null,
        error: null,
      },
    });
    expect(mocks.selectIntegrationBackend).not.toHaveBeenCalled();
    expect(mocks.getIntegrationBackend).not.toHaveBeenCalled();
    expect(mocks.deleteConnection).not.toHaveBeenCalled();
    expect(mocks.deleteWorkspaceIntegration).not.toHaveBeenCalled();
    expect(mocks.recordWorkspaceIntegrationDisconnect).not.toHaveBeenCalled();
  });

  it("uses the stored providerConfigKey when deleting the backend connection", async () => {
    const result = await disconnectIntegrationBackend({
      workspaceId: "workspace_123",
      provider: "github",
      integration: baseIntegration,
    });

    expect(result).toEqual({
      localDeleted: true,
      upstreamDelete: {
        success: true,
        backend: "nango",
        error: null,
      },
    });
    expect(mocks.selectIntegrationBackend).toHaveBeenCalledWith({
      workspaceId: "workspace_123",
      provider: "github",
    });
    expect(mocks.getIntegrationBackend).toHaveBeenCalledWith("nango");
    expect(mocks.deleteConnection).toHaveBeenCalledWith({
      connectionId: "conn_123",
      backendIntegrationId: "github-custom",
      provider: "github",
    });
    expect(mocks.deleteWorkspaceIntegration).toHaveBeenCalledWith(
      "workspace_123",
      "github",
    );
    expect(mocks.recordWorkspaceIntegrationDisconnect).toHaveBeenCalledWith({
      workspaceId: "workspace_123",
      provider: "github",
      connectionId: "conn_123",
      providerConfigKey: "github-custom",
    });
    expectBackendDeleteBeforeWorkspaceDelete();
  });

  it("falls back to the default provider config key when the row has none", async () => {
    await disconnectIntegrationBackend({
      workspaceId: "workspace_123",
      provider: "github",
      integration: {
        ...baseIntegration,
        providerConfigKey: null,
      },
    });

    expect(mocks.deleteConnection).toHaveBeenCalledWith({
      connectionId: "conn_123",
      backendIntegrationId: "github-relay",
      provider: "github",
    });
    expect(mocks.deleteWorkspaceIntegration).toHaveBeenCalledWith(
      "workspace_123",
      "github",
    );
    expect(mocks.recordWorkspaceIntegrationDisconnect).toHaveBeenCalledWith({
      workspaceId: "workspace_123",
      provider: "github",
      connectionId: "conn_123",
      providerConfigKey: null,
    });
    expectBackendDeleteBeforeWorkspaceDelete();
  });

  it("still deletes the local row when the upstream deleteConnection throws", async () => {
    // Operator-initiated disconnect must be idempotent. If the upstream Nango
    // call fails (rotated secret key, Nango transient 5xx, connection
    // already manually deleted outside cloud), the local row would
    // otherwise be stranded and the operator has no CLI path to clear it —
    // every retry returns 500. Verify the local row delete still runs and
    // the failure is logged for forensics.
    const upstreamError = new Error("Nango request failed: 401 Unauthorized");
    mocks.deleteConnection.mockRejectedValueOnce(upstreamError);

    const result = await disconnectIntegrationBackend({
      workspaceId: "workspace_123",
      provider: "github",
      integration: baseIntegration,
    });

    expect(result).toEqual({
      localDeleted: true,
      upstreamDelete: {
        success: false,
        backend: "nango",
        error: "Nango request failed: 401 Unauthorized",
      },
    });
    expect(mocks.deleteConnection).toHaveBeenCalledTimes(1);
    expect(mocks.deleteWorkspaceIntegration).toHaveBeenCalledWith(
      "workspace_123",
      "github",
    );
    expect(mocks.recordWorkspaceIntegrationDisconnect).toHaveBeenCalledWith({
      workspaceId: "workspace_123",
      provider: "github",
      connectionId: "conn_123",
      providerConfigKey: "github-custom",
    });
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("Upstream backend deleteConnection failed"),
      expect.objectContaining({
        workspaceId: "workspace_123",
        provider: "github",
        backend: "nango",
        connectionId: "conn_123",
        error: "Nango request failed: 401 Unauthorized",
      }),
    );
  });

  it("skips shared upstream deletion and drops only the workspace installation reference when the flag is on", async () => {
    mocks.isGithubInstallationCentricEnabled.mockReturnValue(true);
    const where = vi.fn(async () => undefined);
    const deleteFrom = vi.fn(() => ({ where }));
    mocks.getDb.mockReturnValue({ delete: deleteFrom });

    const result = await disconnectIntegrationBackend({
      workspaceId: "workspace_123",
      provider: "github",
      integration: {
        ...baseIntegration,
        installationId: "inst-123",
      },
    });

    expect(result).toEqual({
      localDeleted: true,
      upstreamDelete: {
        success: true,
        backend: null,
        error: null,
      },
    });
    expect(mocks.selectIntegrationBackend).not.toHaveBeenCalled();
    expect(mocks.getIntegrationBackend).not.toHaveBeenCalled();
    expect(mocks.deleteConnection).not.toHaveBeenCalled();
    expect(mocks.recordWorkspaceIntegrationDisconnect).toHaveBeenCalledWith({
      workspaceId: "workspace_123",
      provider: "github",
      connectionId: "conn_123",
      providerConfigKey: "github-custom",
    });
    expect(deleteFrom).toHaveBeenCalledWith({
      workspaceId: "workspace_github_installation_links.workspace_id",
      installationId: "workspace_github_installation_links.installation_id",
    });
    expect(mocks.eq).toHaveBeenCalledWith(
      "workspace_github_installation_links.workspace_id",
      "workspace_123",
    );
    expect(mocks.eq).toHaveBeenCalledWith(
      "workspace_github_installation_links.installation_id",
      "inst-123",
    );
    expect(where).toHaveBeenCalledTimes(1);
    expect(mocks.deleteWorkspaceIntegration).toHaveBeenCalledWith(
      "workspace_123",
      "github",
    );
  });

  it("uses the normalized Composio toolkit slug when deleting dynamic provider connections", async () => {
    await disconnectIntegrationBackend({
      workspaceId: "workspace_123",
      provider: "docker_hub",
      integration: {
        ...baseIntegration,
        provider: "docker_hub",
        providerConfigKey: "docker_hub-composio-relay",
      },
    });

    expect(mocks.selectIntegrationBackend).not.toHaveBeenCalled();
    expect(mocks.getIntegrationBackend).toHaveBeenCalledWith("composio");
    expect(mocks.deleteConnection).toHaveBeenCalledWith({
      connectionId: "conn_123",
      backendIntegrationId: "docker_hub",
      provider: "docker_hub",
    });
    expect(mocks.deleteWorkspaceIntegration).toHaveBeenCalledWith(
      "workspace_123",
      "docker_hub",
    );
    expect(mocks.recordWorkspaceIntegrationDisconnect).toHaveBeenCalledWith({
      workspaceId: "workspace_123",
      provider: "docker_hub",
      connectionId: "conn_123",
      providerConfigKey: "docker_hub-composio-relay",
    });
    expectBackendDeleteBeforeWorkspaceDelete();
  });
});
