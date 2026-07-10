import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  disconnectIntegrationBackend: vi.fn(),
  listWorkspaceIntegrations: vi.fn(),
  purgeRelayfileWorkspace: vi.fn(),
  deleteRelayWorkspaceRecord: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));

vi.mock("@/lib/db/schema", () => ({
  githubCloneJobs: { workspaceId: "workspace_id", id: "id" },
  workspaceIntegrationDisconnects: {
    workspaceId: "workspace_id",
    connectionId: "connection_id",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

vi.mock("@/lib/integrations/disconnect-integration-backend", () => ({
  disconnectIntegrationBackend: mocks.disconnectIntegrationBackend,
}));

vi.mock("@/lib/integrations/workspace-integrations", () => ({
  listWorkspaceIntegrations: mocks.listWorkspaceIntegrations,
}));

vi.mock("@/lib/relay-workspaces", () => ({
  purgeRelayfileWorkspace: mocks.purgeRelayfileWorkspace,
  deleteRelayWorkspaceRecord: mocks.deleteRelayWorkspaceRecord,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
}));

import { deleteWorkspaceCascade } from "./workspace-deletion";

const WORKSPACE_ID = "rw_abcd1234";

function makeDb(rowsByCall: unknown[][]) {
  let call = 0;
  return {
    delete: () => ({
      where: () => ({
        returning: () => Promise.resolve(rowsByCall[call++] ?? []),
      }),
    }),
  };
}

describe("deleteWorkspaceCascade", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.loggerInfo.mockResolvedValue(undefined);
    mocks.loggerWarn.mockResolvedValue(undefined);
    mocks.loggerError.mockResolvedValue(undefined);
    mocks.purgeRelayfileWorkspace.mockResolvedValue({
      ok: true,
      status: 200,
      deletedObjects: 7,
    });
    mocks.deleteRelayWorkspaceRecord.mockResolvedValue(true);
    mocks.getDb.mockReturnValue(makeDb([[{ id: "g1" }], []]));
  });

  it("revokes all integrations, tears down relayfile, deletes rows", async () => {
    mocks.listWorkspaceIntegrations.mockResolvedValue([
      { provider: "slack", connectionId: "c1", providerConfigKey: null },
      { provider: "github", connectionId: "c2", providerConfigKey: null },
    ]);
    mocks.disconnectIntegrationBackend.mockResolvedValue(undefined);

    const summary = await deleteWorkspaceCascade(WORKSPACE_ID);

    expect(summary.integrationsRevoked).toBe(2);
    expect(summary.integrationsFailed).toBe(0);
    expect(summary.relayfileObjectsDeleted).toBe(7);
    expect(summary.githubCloneJobsDeleted).toBe(1);
    expect(summary.relayWorkspaceRowDeleted).toBe(true);
    expect(summary.failures).toHaveLength(0);
    expect(mocks.purgeRelayfileWorkspace).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(mocks.deleteRelayWorkspaceRecord).toHaveBeenCalledWith(WORKSPACE_ID);
  });

  it("records a provider revoke failure but still completes the DB delete", async () => {
    mocks.listWorkspaceIntegrations.mockResolvedValue([
      { provider: "slack", connectionId: "c1", providerConfigKey: null },
    ]);
    mocks.disconnectIntegrationBackend.mockRejectedValue(
      new Error("provider 503"),
    );

    const summary = await deleteWorkspaceCascade(WORKSPACE_ID);

    expect(summary.integrationsRevoked).toBe(0);
    expect(summary.integrationsFailed).toBe(1);
    expect(summary.failures.some((f) => f.phase.startsWith("revoke-integration"))).toBe(
      true,
    );
    // DB cascade still ran despite the flaky provider.
    expect(summary.relayfileObjectsDeleted).toBe(7);
    expect(summary.relayWorkspaceRowDeleted).toBe(true);
    expect(mocks.deleteRelayWorkspaceRecord).toHaveBeenCalledWith(WORKSPACE_ID);
  });

  it("records a relayfile teardown failure and keeps the registry row for retry", async () => {
    mocks.listWorkspaceIntegrations.mockResolvedValue([]);
    mocks.purgeRelayfileWorkspace.mockRejectedValue(new Error("relayfile 500"));

    const summary = await deleteWorkspaceCascade(WORKSPACE_ID);

    // Cascade did not throw and recorded the non-fatal failure.
    expect(
      summary.failures.some((f) => f.phase === "relayfile-teardown"),
    ).toBe(true);
    // Retry-safe contract: the registry row is preserved (not deleted)
    // when the relayfile teardown failed, so a retry can still address it.
    expect(summary.relayWorkspaceRowDeleted).toBe(false);
    expect(mocks.deleteRelayWorkspaceRecord).not.toHaveBeenCalled();
  });

  it("deletes the registry row when relayfile teardown succeeds", async () => {
    mocks.listWorkspaceIntegrations.mockResolvedValue([]);
    mocks.purgeRelayfileWorkspace.mockResolvedValue({
      ok: true,
      status: 200,
      deletedObjects: 3,
    });

    const summary = await deleteWorkspaceCascade(WORKSPACE_ID);

    expect(
      summary.failures.some((f) => f.phase === "relayfile-teardown"),
    ).toBe(false);
    expect(summary.relayWorkspaceRowDeleted).toBe(true);
    expect(mocks.deleteRelayWorkspaceRecord).toHaveBeenCalledTimes(1);
    expect(mocks.deleteRelayWorkspaceRecord).toHaveBeenCalledWith(WORKSPACE_ID);
  });

  it("propagates when the registry-row delete itself throws", async () => {
    mocks.listWorkspaceIntegrations.mockResolvedValue([]);
    mocks.deleteRelayWorkspaceRecord.mockRejectedValue(new Error("db down"));

    await expect(deleteWorkspaceCascade(WORKSPACE_ID)).rejects.toThrow("db down");
  });

  it("treats an already-deleted registry row as relayWorkspaceRowDeleted=false", async () => {
    mocks.listWorkspaceIntegrations.mockResolvedValue([]);
    mocks.deleteRelayWorkspaceRecord.mockResolvedValue(false);

    const summary = await deleteWorkspaceCascade(WORKSPACE_ID);
    expect(summary.relayWorkspaceRowDeleted).toBe(false);
  });
});
