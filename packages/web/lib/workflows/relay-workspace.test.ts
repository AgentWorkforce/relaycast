import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  optionalEnv: vi.fn(),
  tryResourceValue: vi.fn(),
  createCloudWorkspaceRegistry: vi.fn(),
  getRelayWorkspace: vi.fn(),
  getDb: vi.fn(),
  isValidWorkspaceId: vi.fn((value: string) => value.startsWith("rw_")),
  resolveRelaycastUrl: vi.fn(() => "https://relaycast.test/"),
}));

vi.mock("@/lib/env", () => ({
  optionalEnv: mocks.optionalEnv,
  tryResourceValue: mocks.tryResourceValue,
}));

vi.mock("@/lib/workspace-registry", () => ({
  createCloudWorkspaceRegistry: mocks.createCloudWorkspaceRegistry,
  resolveRelaycastUrl: mocks.resolveRelaycastUrl,
}));

vi.mock("@/lib/relay-workspaces", () => ({
  getRelayWorkspace: mocks.getRelayWorkspace,
  isValidWorkspaceId: mocks.isValidWorkspaceId,
}));

vi.mock("@/lib/db", () => ({
  getDb: mocks.getDb,
}));

vi.mock("@/lib/db/schema", () => ({
  workspaces: {
    id: "workspaces.id",
    relayWorkspaceId: "workspaces.relay_workspace_id",
  },
}));

describe("relay workspace workflow helpers", () => {
  afterEach(() => {
    mocks.optionalEnv.mockReset();
    mocks.tryResourceValue.mockReset();
    mocks.createCloudWorkspaceRegistry.mockReset();
    mocks.getRelayWorkspace.mockReset();
    mocks.getDb.mockReset();
    mocks.isValidWorkspaceId.mockReset();
    mocks.isValidWorkspaceId.mockImplementation((value: string) => value.startsWith("rw_"));
    mocks.resolveRelaycastUrl.mockReset();
    mocks.resolveRelaycastUrl.mockReturnValue("https://relaycast.test/");
    vi.unstubAllGlobals();
  });

  it("re-registers the existing API key for the existing relay workspace", async () => {
    mocks.tryResourceValue.mockReturnValue("internal-secret");
    mocks.getRelayWorkspace.mockResolvedValue({
      id: "rw_7ccfea89",
      relaycastApiKey: "rk_live_stale",
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://relaycast.test/internal/workspaces/rw_7ccfea89/api-key");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer internal-secret");
      expect(JSON.parse(String(init?.body))).toEqual({ api_key: "rk_live_stale" });
      return Response.json({
        ok: true,
        data: {
          workspace_id: "rw_7ccfea89",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { ensureRelaycastApiKeyForRelayWorkspace } = await import("./relay-workspace");

    await expect(ensureRelaycastApiKeyForRelayWorkspace({
      relayWorkspaceId: "rw_7ccfea89",
    })).resolves.toEqual({
      id: "rw_7ccfea89",
      relaycastApiKey: "rk_live_stale",
      provisioned: false,
    });
  });

  it("repairs an existing direct relay workspace key before returning it", async () => {
    mocks.tryResourceValue.mockReturnValue("internal-secret");
    mocks.getRelayWorkspace.mockResolvedValue({
      id: "rw_7ccfea89",
      relaycastApiKey: "rk_live_stale",
    });
    const fetchMock = vi.fn(async () => Response.json({
      ok: true,
      data: {
        workspace_id: "rw_7ccfea89",
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { resolveOrProvisionRelayWorkspace } = await import("./relay-workspace");

    await expect(resolveOrProvisionRelayWorkspace({
      userId: "usr_123",
      appWorkspaceId: "rw_7ccfea89",
    })).resolves.toEqual({
      id: "rw_7ccfea89",
      relaycastApiKey: "rk_live_stale",
      provisioned: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://relaycast.test/internal/workspaces/rw_7ccfea89/api-key",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ api_key: "rk_live_stale" }),
      }),
    );
    expect(mocks.createCloudWorkspaceRegistry).not.toHaveBeenCalled();
  });

  it("repairs a bound relay workspace key before returning it", async () => {
    mocks.tryResourceValue.mockReturnValue("internal-secret");
    mocks.getDb.mockReturnValue({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [{ relayWorkspaceId: "rw_7ccfea89" }]),
          })),
        })),
      })),
    });
    mocks.getRelayWorkspace.mockResolvedValue({
      id: "rw_7ccfea89",
      relaycastApiKey: "rk_live_stale",
    });
    const fetchMock = vi.fn(async () => Response.json({
      ok: true,
      data: {
        workspace_id: "rw_7ccfea89",
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { resolveOrProvisionRelayWorkspace } = await import("./relay-workspace");

    await expect(resolveOrProvisionRelayWorkspace({
      userId: "usr_123",
      appWorkspaceId: "9c0e778a-7f4e-4a3f-8f31-4d4d52d4387c",
    })).resolves.toEqual({
      id: "rw_7ccfea89",
      relaycastApiKey: "rk_live_stale",
      provisioned: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://relaycast.test/internal/workspaces/rw_7ccfea89/api-key",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ api_key: "rk_live_stale" }),
      }),
    );
    expect(mocks.createCloudWorkspaceRegistry).not.toHaveBeenCalled();
  });

  it("fails closed when the Relaycast internal secret is not configured", async () => {
    mocks.getRelayWorkspace.mockResolvedValue({
      id: "rw_7ccfea89",
      relaycastApiKey: "rk_live_stale",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { ensureRelaycastApiKeyForRelayWorkspace } = await import("./relay-workspace");

    await expect(ensureRelaycastApiKeyForRelayWorkspace({
      relayWorkspaceId: "rw_7ccfea89",
    })).rejects.toThrow("Relaycast internal secret is not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when Cloud has no relaycast API key to re-register", async () => {
    mocks.tryResourceValue.mockReturnValue("internal-secret");
    mocks.getRelayWorkspace.mockResolvedValue({
      id: "rw_7ccfea89",
      relaycastApiKey: "",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { ensureRelaycastApiKeyForRelayWorkspace } = await import("./relay-workspace");

    await expect(ensureRelaycastApiKeyForRelayWorkspace({
      relayWorkspaceId: "rw_7ccfea89",
    })).rejects.toThrow("Relay workspace rw_7ccfea89 has no relaycast API key to re-register");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
