import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getRelayWorkspaceMock = vi.fn();
const optionalEnvMock = vi.fn();

vi.mock("@/lib/relay-workspaces", () => ({
  getRelayWorkspace: (...args: unknown[]) => getRelayWorkspaceMock(...args),
}));

vi.mock("@/lib/env", () => ({
  optionalEnv: (...args: unknown[]) => optionalEnvMock(...args),
}));

async function loadResolver() {
  const moduleUrl = new URL(
    "../packages/web/lib/workflows/relay-api-key.ts",
    import.meta.url,
  ).href;
  return import(moduleUrl);
}

beforeEach(() => {
  getRelayWorkspaceMock.mockReset();
  optionalEnvMock.mockReset();
  optionalEnvMock.mockReturnValue("");
});

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("resolveRelayApiKeyForWorkspace", () => {
  it("returns the per-workspace key when the relay workspace record has one", async () => {
    getRelayWorkspaceMock.mockResolvedValue({
      relaycastApiKey: " rk_live_workspace ",
    });
    const { resolveRelayApiKeyForWorkspace } = await loadResolver();

    await expect(resolveRelayApiKeyForWorkspace("rw_12345678")).resolves.toBe("rk_live_workspace");
    expect(optionalEnvMock).not.toHaveBeenCalled();
  });

  it("falls back to the global key only when the record is missing a workspace key", async () => {
    getRelayWorkspaceMock.mockResolvedValue({
      relaycastApiKey: "   ",
    });
    optionalEnvMock.mockImplementation((name: string) => (name === "RELAY_API_KEY" ? "rk_live_global" : ""));
    const warn = vi.fn();
    const { resolveRelayApiKeyForWorkspace } = await loadResolver();

    await expect(
      resolveRelayApiKeyForWorkspace("rw_legacy0001", { warn }),
    ).resolves.toBe("rk_live_global");
    expect(warn).toHaveBeenCalledWith(
      "[run] Workspace rw_legacy0001 using global RELAY_API_KEY fallback because relay_workspaces has no relaycastApiKey",
    );
  });
});
