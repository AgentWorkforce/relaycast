import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getRelayWorkspaceMock = vi.fn();
const registryCreateMock = vi.fn();

const dbSelectFromWhereLimitMock = vi.fn();
const dbUpdateSetWhereMock = vi.fn();

function buildMockDb() {
  const limitMock = vi.fn(() => dbSelectFromWhereLimitMock());
  const whereSelectMock = vi.fn(() => ({ limit: limitMock }));
  const fromMock = vi.fn(() => ({ where: whereSelectMock }));
  const selectMock = vi.fn(() => ({ from: fromMock }));

  const whereUpdateMock = vi.fn((...args: unknown[]) => dbUpdateSetWhereMock(...args));
  const setMock = vi.fn(() => ({ where: whereUpdateMock }));
  const updateMock = vi.fn(() => ({ set: setMock }));

  return {
    select: selectMock,
    update: updateMock,
    _spies: { selectMock, fromMock, whereSelectMock, limitMock, updateMock, setMock, whereUpdateMock },
  };
}

let mockDb: ReturnType<typeof buildMockDb>;

vi.mock("@/lib/relay-workspaces", () => ({
  getRelayWorkspace: (...args: unknown[]) => getRelayWorkspaceMock(...args),
  isValidWorkspaceId: (value: string) => /^rw_[a-z0-9]{8}$/.test(value),
}));

vi.mock("@/lib/workspace-registry", () => ({
  createCloudWorkspaceRegistry: () => ({
    registry: { create: (...args: unknown[]) => registryCreateMock(...args) },
    serviceConfig: {},
  }),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => mockDb,
}));

vi.mock("@/lib/db/schema", () => ({
  workspaces: { id: "workspaces.id", relayWorkspaceId: "workspaces.relay_workspace_id" },
}));

async function loadResolver() {
  const moduleUrl = new URL(
    "../packages/web/lib/workflows/relay-workspace.ts",
    import.meta.url,
  ).href;
  return import(moduleUrl);
}

const APP_WORKSPACE_UUID = "550e8400-e29b-41d4-a716-446655440000";

beforeEach(() => {
  getRelayWorkspaceMock.mockReset();
  registryCreateMock.mockReset();
  dbSelectFromWhereLimitMock.mockReset();
  dbUpdateSetWhereMock.mockReset();
  mockDb = buildMockDb();
});

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("resolveOrProvisionRelayWorkspace", () => {
  it("uses the app workspace directly when it is rw_-format with a minted key (legacy/bootstrap)", async () => {
    getRelayWorkspaceMock.mockResolvedValue({
      id: "rw_appws001",
      relaycastApiKey: "rk_live_existing",
    });
    const { resolveOrProvisionRelayWorkspace } = await loadResolver();

    const result = await resolveOrProvisionRelayWorkspace({
      userId: "user_1",
      appWorkspaceId: "rw_appws001",
    });

    expect(result).toEqual({
      id: "rw_appws001",
      relaycastApiKey: "rk_live_existing",
      provisioned: false,
    });
    expect(dbSelectFromWhereLimitMock).not.toHaveBeenCalled();
    expect(registryCreateMock).not.toHaveBeenCalled();
  });

  it("reuses the bound relay workspace when the app workspace has relay_workspace_id set", async () => {
    dbSelectFromWhereLimitMock.mockResolvedValue([{ relayWorkspaceId: "rw_boundws01" }]);
    getRelayWorkspaceMock.mockResolvedValue({
      id: "rw_boundws01",
      relaycastApiKey: "rk_live_bound",
    });
    const { resolveOrProvisionRelayWorkspace } = await loadResolver();

    const result = await resolveOrProvisionRelayWorkspace({
      userId: "user_1",
      appWorkspaceId: APP_WORKSPACE_UUID,
    });

    expect(result).toEqual({
      id: "rw_boundws01",
      relaycastApiKey: "rk_live_bound",
      provisioned: false,
    });
    expect(getRelayWorkspaceMock).toHaveBeenCalledWith("rw_boundws01");
    expect(registryCreateMock).not.toHaveBeenCalled();
  });

  it("provisions a fresh relay workspace and persists the binding when none exists", async () => {
    dbSelectFromWhereLimitMock.mockResolvedValue([{ relayWorkspaceId: null }]);
    registryCreateMock.mockResolvedValue({
      id: "rw_new12345",
      relaycastApiKey: "rk_live_fresh",
    });
    const { resolveOrProvisionRelayWorkspace } = await loadResolver();

    const result = await resolveOrProvisionRelayWorkspace({
      userId: "user_1",
      appWorkspaceId: APP_WORKSPACE_UUID,
    });

    expect(result).toEqual({
      id: "rw_new12345",
      relaycastApiKey: "rk_live_fresh",
      provisioned: true,
    });
    expect(registryCreateMock).toHaveBeenCalledWith({
      createdBy: "user_1",
      name: "default",
    });
    // Regression guard: binding must be persisted. Without this, every run
    // re-provisions (the exact Codex P2 on #242).
    expect(mockDb._spies.updateMock).toHaveBeenCalledTimes(1);
    expect(mockDb._spies.setMock).toHaveBeenCalledWith(
      expect.objectContaining({ relayWorkspaceId: "rw_new12345" }),
    );
  });

  it("re-provisions and rebinds when the bound relay workspace has an empty key", async () => {
    // Codex P2 on #242: oldest-row-with-empty-key locked a user into
    // infinite re-provisioning because the binding was user-scoped via
    // `findFirstRelayWorkspaceForUser`. With the per-workspace binding we
    // still re-provision here (the bound record is broken) but the UPDATE
    // step points the app workspace at the fresh workspace so subsequent
    // runs resolve to the new key without further provisioning.
    dbSelectFromWhereLimitMock.mockResolvedValue([{ relayWorkspaceId: "rw_legacy001" }]);
    getRelayWorkspaceMock.mockResolvedValue({
      id: "rw_legacy001",
      relaycastApiKey: "   ",
    });
    registryCreateMock.mockResolvedValue({
      id: "rw_freshws01",
      relaycastApiKey: "rk_live_fresh",
    });
    const { resolveOrProvisionRelayWorkspace } = await loadResolver();

    const result = await resolveOrProvisionRelayWorkspace({
      userId: "user_1",
      appWorkspaceId: APP_WORKSPACE_UUID,
    });

    expect(result.provisioned).toBe(true);
    expect(result.id).toBe("rw_freshws01");
    expect(mockDb._spies.setMock).toHaveBeenCalledWith(
      expect.objectContaining({ relayWorkspaceId: "rw_freshws01" }),
    );
  });

  it("throws when the registry returns a workspace without a minted API key", async () => {
    dbSelectFromWhereLimitMock.mockResolvedValue([{ relayWorkspaceId: null }]);
    registryCreateMock.mockResolvedValue({
      id: "rw_new12345",
      relaycastApiKey: "",
    });
    const { resolveOrProvisionRelayWorkspace } = await loadResolver();

    await expect(
      resolveOrProvisionRelayWorkspace({
        userId: "user_1",
        appWorkspaceId: APP_WORKSPACE_UUID,
      }),
    ).rejects.toThrow(/returned no relaycastApiKey/i);
    // Must not persist a binding when provisioning didn't yield a usable
    // key — otherwise the app workspace gets locked to a broken record.
    expect(mockDb._spies.updateMock).not.toHaveBeenCalled();
  });

  it("skips the binding lookup when the app workspace ID isn't a UUID (service auth / empty)", async () => {
    registryCreateMock.mockResolvedValue({
      id: "rw_new12345",
      relaycastApiKey: "rk_live_fresh",
    });
    const { resolveOrProvisionRelayWorkspace } = await loadResolver();

    await resolveOrProvisionRelayWorkspace({
      userId: "user_1",
      appWorkspaceId: "",
    });

    // No SELECT against workspaces (empty ID); provisioning proceeds but
    // no UPDATE either (nothing to bind against).
    expect(dbSelectFromWhereLimitMock).not.toHaveBeenCalled();
    expect(mockDb._spies.updateMock).not.toHaveBeenCalled();
    expect(registryCreateMock).toHaveBeenCalledTimes(1);
  });
});
