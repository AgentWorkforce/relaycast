import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readAppWorkspaceRelayBinding: vi.fn(),
  resolveAppWorkspaceByRelayWorkspaceId: vi.fn(),
}));

vi.mock("@/lib/workspaces/relay-workspace-binding", () => ({
  isAppWorkspaceId: (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value.trim()),
  isRelayWorkspaceId: (value: string) => /^rw_[A-Za-z0-9_-]+$/u.test(value.trim()),
  readAppWorkspaceRelayBinding: mocks.readAppWorkspaceRelayBinding,
  resolveAppWorkspaceByRelayWorkspaceId: mocks.resolveAppWorkspaceByRelayWorkspaceId,
}));

describe("workspace integration identity runtime helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readAppWorkspaceRelayBinding.mockResolvedValue(null);
    mocks.resolveAppWorkspaceByRelayWorkspaceId.mockResolvedValue({
      appWorkspaceId: null,
      organizationId: null,
    });
  });

  it("keeps legacy runtime fallback for unresolved Relay workspace IDs", async () => {
    const { resolveAppWorkspaceIdForRuntime } = await import("./workspace-integration-identity");

    await expect(resolveAppWorkspaceIdForRuntime("rw_missing")).resolves.toBe("rw_missing");
  });

  it("returns null for unresolved Relay workspace IDs in relay runtime dispatch", async () => {
    const { resolveAppWorkspaceIdForRelayRuntime } = await import("./workspace-integration-identity");

    await expect(resolveAppWorkspaceIdForRelayRuntime("rw_missing")).resolves.toBeNull();
  });

  it("resolves Relay workspace IDs to app workspace UUIDs when the binding exists", async () => {
    mocks.resolveAppWorkspaceByRelayWorkspaceId.mockResolvedValue({
      appWorkspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
      organizationId: "org-1",
    });
    const { resolveAppWorkspaceIdForRelayRuntime } = await import("./workspace-integration-identity");

    await expect(resolveAppWorkspaceIdForRelayRuntime("rw_7ccfea89")).resolves.toBe(
      "50587328-441d-4acb-b8f3-dbe1b3c5de99",
    );
  });
});
