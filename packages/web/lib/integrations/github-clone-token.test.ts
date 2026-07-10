import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getNangoClient: vi.fn(),
  getNangoSecretKey: vi.fn(),
  getProviderConfigKey: vi.fn(),
  isWorkspaceIntegrationProvider: vi.fn(),
  listUserIntegrations: vi.fn(),
  listWorkspaceIntegrationsByProviderAlias: vi.fn(),
  isGithubInstallationCentricEnabled: vi.fn(),
  resolveGithubConnectionForWorkspace: vi.fn(),
  isMissingNangoConnectionError: vi.fn(),
  selectRepoCapableConnection: vi.fn(),
  resolveWorkspaceIntegrationIdentity: vi.fn(),
}));

// Reuse the production clone worker's auto-heal helpers (PRs #1433/#1435/#1437)
// rather than forking them.
vi.mock("@cloud/core/clone/github-clone-production.js", () => ({
  isMissingNangoConnectionError: mocks.isMissingNangoConnectionError,
  selectRepoCapableConnection: mocks.selectRepoCapableConnection,
}));

vi.mock("./nango-service", () => ({
  getNangoClient: mocks.getNangoClient,
  getNangoSecretKey: mocks.getNangoSecretKey,
  getProviderConfigKey: mocks.getProviderConfigKey,
}));

vi.mock("./providers", () => ({
  isWorkspaceIntegrationProvider: mocks.isWorkspaceIntegrationProvider,
}));

vi.mock("./user-integrations", () => ({
  listUserIntegrations: mocks.listUserIntegrations,
}));

vi.mock("./workspace-integrations", () => ({
  listWorkspaceIntegrationsByProviderAlias:
    mocks.listWorkspaceIntegrationsByProviderAlias,
}));

vi.mock("./github-installation-centric-flag", () => ({
  isGithubInstallationCentricEnabled: mocks.isGithubInstallationCentricEnabled,
}));

vi.mock("./github-installation-connection", () => ({
  resolveGithubConnectionForWorkspace: mocks.resolveGithubConnectionForWorkspace,
}));

vi.mock("@/lib/workspaces/workspace-integration-identity", () => ({
  resolveWorkspaceIntegrationIdentity: mocks.resolveWorkspaceIntegrationIdentity,
}));

import { resolveGitCloneCredentials } from "./github-clone-token";

const now = new Date("2026-05-29T00:00:00.000Z");
const REMOTE_URL = "https://github.com/AgentWorkforce/pear";
const APP_WORKSPACE_ID = "50587328-441d-4acb-b8f3-dbe1b3c5de99";
const RELAY_WORKSPACE_ID = "rw_pear_relay";

function workspaceIntegration(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: APP_WORKSPACE_ID,
    provider: "github",
    name: null,
    connectionId: "conn-workspace",
    providerConfigKey: "github-relay",
    installationId: null,
    metadata: {},
    writebackDispatchVia: "bridge",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function axiosError(
  status: number,
  data: unknown,
  message = `Request failed with status code ${status}`,
): Error {
  return Object.assign(new Error(message), { response: { status, data } });
}

const INPUT = {
  userId: "22222222-2222-4222-8222-222222222222",
  workspaceId: APP_WORKSPACE_ID,
  remoteUrl: REMOTE_URL,
};

describe("resolveGitCloneCredentials", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getNangoSecretKey.mockReturnValue("nango-secret");
    mocks.getProviderConfigKey.mockReturnValue("github-relay");
    mocks.isWorkspaceIntegrationProvider.mockReturnValue(true);
    mocks.listUserIntegrations.mockResolvedValue([]);
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([
      workspaceIntegration(),
    ]);
    mocks.isGithubInstallationCentricEnabled.mockReturnValue(false);
    mocks.resolveGithubConnectionForWorkspace.mockResolvedValue({
      installationId: "inst-123",
      connectionId: "conn-installation",
      providerConfigKey: "github-relay",
      accountLogin: "AgentWorkforce",
      accountType: "Organization",
      repositorySelection: "selected",
      suspended: false,
      source: "org-installation",
    });
    mocks.isMissingNangoConnectionError.mockImplementation((error: unknown) => {
      const response = (error as { response?: { status?: number; data?: unknown } })
        ?.response;
      const status = response?.status;
      if (status !== 400 && status !== 404) return false;
      const body =
        JSON.stringify(response?.data ?? "") +
        " " +
        ((error as Error)?.message ?? "");
      return /failed to get connection|not_found|unknown_connection|connection not found/i.test(
        body,
      );
    });
    // App workspace id → bound relay workspace id (relay-ws first in scope order).
    mocks.resolveWorkspaceIntegrationIdentity.mockResolvedValue({
      requestedWorkspaceId: APP_WORKSPACE_ID,
      appWorkspaceId: APP_WORKSPACE_ID,
      relayWorkspaceId: RELAY_WORKSPACE_ID,
      organizationId: null,
      candidateWorkspaceIds: [APP_WORKSPACE_ID, RELAY_WORKSPACE_ID],
    });
    // Default: live re-resolution finds nothing (overridden per test).
    mocks.selectRepoCapableConnection.mockRejectedValue(
      new Error("No same-tenant GitHub connection can read AgentWorkforce/pear."),
    );
  });

  it("returns credentials when a candidate can read the repo and mints a token", async () => {
    const proxy = vi.fn().mockResolvedValue({ status: 200 });
    const getToken = vi.fn().mockResolvedValue("ghs_installation_token");
    mocks.getNangoClient.mockReturnValue({ proxy, getToken });

    const result = await resolveGitCloneCredentials(INPUT);

    expect(result).toEqual({
      provider: "github",
      username: "x-access-token",
      token: "ghs_installation_token",
    });
    expect(getToken).toHaveBeenCalledWith("github-relay", "conn-workspace", false, true);
    expect(mocks.selectRepoCapableConnection).not.toHaveBeenCalled();
    expect(mocks.resolveGithubConnectionForWorkspace).not.toHaveBeenCalled();
  });

  it("uses the installation resolver as the GitHub workspace candidate when the flag is on", async () => {
    mocks.isGithubInstallationCentricEnabled.mockReturnValue(true);
    const proxy = vi.fn().mockResolvedValue({ status: 200 });
    const getToken = vi.fn().mockResolvedValue("ghs_installation_token");
    mocks.getNangoClient.mockReturnValue({ proxy, getToken });

    const result = await resolveGitCloneCredentials(INPUT);

    expect(result).toEqual({
      provider: "github",
      username: "x-access-token",
      token: "ghs_installation_token",
    });
    expect(mocks.resolveGithubConnectionForWorkspace).toHaveBeenCalledWith(
      APP_WORKSPACE_ID,
    );
    expect(mocks.listWorkspaceIntegrationsByProviderAlias).not.toHaveBeenCalled();
    expect(proxy).toHaveBeenCalledWith({
      method: "GET",
      endpoint: "/repos/AgentWorkforce/pear",
      connectionId: "conn-installation",
      providerConfigKey: "github-relay",
    });
    expect(getToken).toHaveBeenCalledWith(
      "github-relay",
      "conn-installation",
      false,
      true,
    );
  });

  it("auto-heals a stale stored connection by re-resolving the live connection scoped to the RELAY workspace id", async () => {
    const proxy = vi.fn().mockRejectedValue(
      axiosError(400, {
        error: { code: "unknown_connection", message: "failed to get connection" },
      }),
    );
    const getToken = vi.fn().mockResolvedValue("ghs_live_token");
    mocks.getNangoClient.mockReturnValue({ proxy, getToken });
    // The live connection is RELAY-ws-tagged: only the relay scope resolves it.
    mocks.selectRepoCapableConnection.mockImplementation(
      async (args: { relayfileWorkspaceId: string }) => {
        if (args.relayfileWorkspaceId === RELAY_WORKSPACE_ID) {
          return {
            connectionId: "conn-live-133e04cb",
            providerConfigKey: "github-relay",
            createdAt: null,
            updatedAt: now.toISOString(),
            raw: {},
          };
        }
        throw new Error("No same-tenant GitHub connection can read AgentWorkforce/pear.");
      },
    );

    const result = await resolveGitCloneCredentials(INPUT);

    expect(result).toEqual({
      provider: "github",
      username: "x-access-token",
      token: "ghs_live_token",
    });
    // App workspace id was resolved to the relay workspace id and tried first.
    expect(mocks.resolveWorkspaceIntegrationIdentity).toHaveBeenCalledWith(APP_WORKSPACE_ID);
    expect(mocks.selectRepoCapableConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        providerConfigKey: "github-relay",
        relayfileWorkspaceId: RELAY_WORKSPACE_ID,
        owner: "AgentWorkforce",
        repo: "pear",
      }),
    );
    // Token minted from the LIVE connection.
    expect(getToken).toHaveBeenCalledWith("github-relay", "conn-live-133e04cb", false, true);
  });

  it("falls back to the app-workspace scope when the connection is app-ws-tagged", async () => {
    const proxy = vi.fn().mockRejectedValue(
      axiosError(400, { error: { message: "failed to get connection" } }),
    );
    const getToken = vi.fn().mockResolvedValue("ghs_app_scope");
    mocks.getNangoClient.mockReturnValue({ proxy, getToken });
    mocks.selectRepoCapableConnection.mockImplementation(
      async (args: { relayfileWorkspaceId: string }) => {
        if (args.relayfileWorkspaceId === APP_WORKSPACE_ID) {
          return {
            connectionId: "conn-app-tagged",
            providerConfigKey: "github-relay",
            createdAt: null,
            updatedAt: now.toISOString(),
            raw: {},
          };
        }
        throw new Error("No same-tenant GitHub connection can read AgentWorkforce/pear.");
      },
    );

    const result = await resolveGitCloneCredentials(INPUT);

    expect(result?.token).toBe("ghs_app_scope");
    // Relay scope tried first (and missed), then app scope matched.
    const scopes = mocks.selectRepoCapableConnection.mock.calls.map(
      (call) => (call[0] as { relayfileWorkspaceId: string }).relayfileWorkspaceId,
    );
    expect(scopes).toEqual([RELAY_WORKSPACE_ID, APP_WORKSPACE_ID]);
    expect(getToken).toHaveBeenCalledWith("github-relay", "conn-app-tagged", false, true);
  });

  it("throws an actionable reconnect error when no scope yields a repo-capable connection", async () => {
    const proxy = vi.fn().mockRejectedValue(
      axiosError(400, {
        error: { code: "unknown_connection", message: "failed to get connection" },
      }),
    );
    const getToken = vi.fn();
    mocks.getNangoClient.mockReturnValue({ proxy, getToken });
    // selectRepoCapableConnection rejects for all scopes (beforeEach default).

    let captured: Error | null = null;
    try {
      await resolveGitCloneCredentials(INPUT);
    } catch (error) {
      captured = error as Error;
    }

    expect(captured).toBeInstanceOf(Error);
    const message = captured?.message ?? "";
    expect(message).toContain("workspace_integrations:github-relay/conn-workspace");
    expect(message).toContain("status=400");
    expect(message).toContain("failed to get connection");
    expect(message).toContain("reconnect the GitHub integration");
    // Both candidate scopes were attempted.
    expect(mocks.selectRepoCapableConnection).toHaveBeenCalledTimes(2);
    expect(getToken).not.toHaveBeenCalled();
  });

  it("skips a candidate on 403/404 and returns null without attempting auto-heal", async () => {
    const proxy = vi.fn().mockRejectedValue(axiosError(404, { message: "Not Found" }));
    const getToken = vi.fn();
    mocks.getNangoClient.mockReturnValue({ proxy, getToken });

    const result = await resolveGitCloneCredentials(INPUT);

    expect(result).toBeNull();
    expect(getToken).not.toHaveBeenCalled();
    expect(mocks.selectRepoCapableConnection).not.toHaveBeenCalled();
    expect(mocks.resolveWorkspaceIntegrationIdentity).not.toHaveBeenCalled();
  });

  it("uses a healthy stored sibling before auto-heal when one exists", async () => {
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([
      workspaceIntegration({ connectionId: "conn-stale" }),
      workspaceIntegration({ connectionId: "conn-healthy" }),
    ]);
    const proxy = vi
      .fn()
      .mockRejectedValueOnce(
        axiosError(400, { error: { message: "failed to get connection" } }),
      )
      .mockResolvedValueOnce({ status: 200 });
    const getToken = vi.fn().mockResolvedValue("ghs_healthy");
    mocks.getNangoClient.mockReturnValue({ proxy, getToken });

    const result = await resolveGitCloneCredentials(INPUT);

    expect(result?.token).toBe("ghs_healthy");
    expect(getToken).toHaveBeenCalledWith("github-relay", "conn-healthy", false, true);
    expect(mocks.selectRepoCapableConnection).not.toHaveBeenCalled();
  });
});
