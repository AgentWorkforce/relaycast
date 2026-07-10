import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  eq: vi.fn(),
  findWorkspaceGithubIntegrationByInstallation: vi.fn(),
  getDb: vi.fn(),
  listWorkspaceIntegrationsByProviderAlias: vi.fn(),
  listUserIntegrations: vi.fn(),
  isGithubInstallationCentricEnabled: vi.fn(),
  resolveGithubConnectionForWorkspace: vi.fn(),
  resolveGithubAuthShadow: vi.fn(),
  resolveRepoAllowlistOrRelaxed: vi.fn(),
  getNangoClient: vi.fn(),
  getNangoSecretKey: vi.fn(),
  getProviderConfigKey: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  eq: mocks.eq,
}));

vi.mock("@/lib/db", () => ({
  getDb: mocks.getDb,
}));

vi.mock("@/lib/db/schema", () => ({
  workspaces: {
    id: "workspaces.id",
    relayWorkspaceId: "workspaces.relayWorkspaceId",
  },
}));

vi.mock("@/lib/integrations/workspace-integrations", () => ({
  findWorkspaceGithubIntegrationByInstallation:
    mocks.findWorkspaceGithubIntegrationByInstallation,
  listWorkspaceIntegrationsByProviderAlias: mocks.listWorkspaceIntegrationsByProviderAlias,
}));

vi.mock("@/lib/integrations/user-integrations", () => ({
  listUserIntegrations: mocks.listUserIntegrations,
}));

vi.mock("@/lib/integrations/workflow-repository-allowlists", () => ({
  resolveRepoAllowlistOrRelaxed: mocks.resolveRepoAllowlistOrRelaxed,
}));

vi.mock("@/lib/integrations/github-auth-resolver", () => ({
  resolveGithubAuthShadow: mocks.resolveGithubAuthShadow,
}));

vi.mock("@/lib/integrations/github-installation-centric-flag", () => ({
  isGithubInstallationCentricEnabled: mocks.isGithubInstallationCentricEnabled,
}));

vi.mock("@/lib/integrations/github-installation-connection", () => ({
  resolveGithubConnectionForWorkspace: mocks.resolveGithubConnectionForWorkspace,
}));

vi.mock("@/lib/integrations/nango-service", () => ({
  getNangoClient: mocks.getNangoClient,
  getNangoSecretKey: mocks.getNangoSecretKey,
  getProviderConfigKey: mocks.getProviderConfigKey,
}));

import {
  mintWorkflowGithubWriteToken,
} from "./github-workflow-write-token";
import type { UserIntegrationRecord } from "./user-integrations";
import type { WorkspaceIntegrationRecord } from "./workspace-integrations";

const now = new Date("2026-05-24T00:00:00.000Z");
const APP_WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const RELAY_WORKSPACE_ID = "rw_relay";
const USER_ID = "22222222-2222-4222-8222-222222222222";

function integration(
  overrides: Partial<WorkspaceIntegrationRecord> = {},
): WorkspaceIntegrationRecord {
  return {
    id: "integration_github",
    workspaceId: "workspace-1",
    provider: "github",
    name: null,
    connectionId: "conn-github",
    providerConfigKey: "github-relay",
    installationId: null,
    metadata: {},
    writebackDispatchVia: "bridge",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function userIntegration(
  overrides: Partial<UserIntegrationRecord> = {},
): UserIntegrationRecord {
  return {
    userId: USER_ID,
    provider: "github",
    name: null,
    connectionId: "conn-user",
    providerConfigKey: "github-relay",
    installationId: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function relaxedAllowlist() {
  return {
    workspaceId: "workspace-1",
    repoOwner: "AgentWorkforce",
    repoName: "cloud",
    installationId: "",
    pushAllowed: true,
    allowedAt: now,
    allowedBy: "system:relaxed",
  };
}

function mockRelayWorkspaceLookup(relayWorkspaceId: string | null): void {
  const limit = vi.fn(async () =>
    relayWorkspaceId === null ? [] : [{ relayWorkspaceId }],
  );
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  mocks.getDb.mockReturnValue({ select });
}

describe("mintWorkflowGithubWriteToken", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.eq.mockReturnValue({ op: "eq" });
    mockRelayWorkspaceLookup(null);
    mocks.listUserIntegrations.mockResolvedValue([]);
    mocks.resolveGithubAuthShadow.mockResolvedValue({
      ok: false,
      reason: "missing_installation",
      tokenType: "installation",
      authKind: "app_installation",
    });
    mocks.getNangoSecretKey.mockReturnValue("nango-secret");
    mocks.getProviderConfigKey.mockImplementation((provider: string) => provider);
    mocks.resolveRepoAllowlistOrRelaxed.mockResolvedValue(relaxedAllowlist());
    mocks.getNangoClient.mockReturnValue({
      getToken: vi.fn(async (_providerConfigKey: string, connectionId: string) => {
        if (connectionId === "conn-tokenless") {
          throw new Error("token unavailable");
        }
        return `ghs_${connectionId}`;
      }),
      proxy: vi.fn(async () => ({ status: 200, data: { id: 1 } })),
    });
    mocks.isGithubInstallationCentricEnabled.mockReturnValue(false);
    mocks.resolveGithubConnectionForWorkspace.mockResolvedValue({
      installationId: "131340034",
      connectionId: "conn-installation",
      providerConfigKey: "github-relay",
      accountLogin: "AgentWorkforce",
      accountType: "Organization",
      repositorySelection: "selected",
      suspended: false,
      source: "org-installation",
    });
    delete process.env.CLOUD_GITHUB_AUTH_RESOLVER_WORKFLOW_WRITE_ENABLED;
  });

  it("tries user_integrations before workspace integrations", async () => {
    mocks.listUserIntegrations.mockResolvedValue([
      userIntegration({
        connectionId: "conn-user",
        providerConfigKey: "github-relay",
        installationId: "",
      }),
    ]);
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([
      integration({
        provider: "github-pusher",
        connectionId: "conn-selected",
        providerConfigKey: "github-pusher",
        installationId: "131340034",
      }),
    ]);

    const fetchImpl = vi.fn(async () => {
      throw new Error("repo probe should use Nango proxy, not direct fetch");
    });

    const result = await mintWorkflowGithubWriteToken({
      userId: USER_ID,
      workspaceId: APP_WORKSPACE_ID,
      repoOwner: "AgentWorkforce",
      repoName: "cloud",
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(result).toMatchObject({
      token: "ghs_conn-user",
      installationId: "",
    });
    expect(mocks.getNangoClient().getToken).toHaveBeenCalledWith(
      "github-relay",
      "conn-user",
      false,
      true,
    );
    expect(mocks.getNangoClient().proxy).toHaveBeenCalledWith({
      method: "GET",
      endpoint: "/repos/AgentWorkforce/cloud",
      connectionId: "conn-user",
      providerConfigKey: "github-relay",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("falls back to workspace integrations when user integrations cannot access the repo", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.listUserIntegrations.mockResolvedValue([
      userIntegration({
        connectionId: "conn-user-selected",
        providerConfigKey: "github-relay",
        installationId: "",
      }),
    ]);
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([
      integration({
        provider: "github",
        connectionId: "conn-workspace",
        providerConfigKey: "github-relay",
        installationId: "",
      }),
    ]);

    mocks.getNangoClient().proxy.mockImplementation(async ({ connectionId }: { connectionId: string }) => {
      if (connectionId === "conn-workspace") {
        return { status: 200, data: { id: 1 } };
      }
      throw Object.assign(new Error("Resource not accessible by integration"), {
        response: {
          status: 403,
          data: { message: "Resource not accessible by integration" },
        },
      });
    });
    const fetchImpl = vi.fn(async () => {
      throw new Error("repo probe should use Nango proxy, not direct fetch");
    });

    try {
      await expect(
        mintWorkflowGithubWriteToken({
          userId: USER_ID,
          workspaceId: APP_WORKSPACE_ID,
          repoOwner: "AgentWorkforce",
          repoName: "cloud",
          fetchImpl: fetchImpl as typeof fetch,
        }),
      ).resolves.toMatchObject({
        token: "ghs_conn-workspace",
        installationId: "",
      });

      const logged = JSON.stringify(warnSpy.mock.calls);
      expect(logged).toContain("\"tokenPrefix\":\"ghs_\"");
      expect(logged).toContain("\"githubMessage\":\"Resource not accessible by integration\"");
      expect(logged).not.toContain("ghs_conn-user-selected");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("looks in the bound relay workspace before the app workspace", async () => {
    mockRelayWorkspaceLookup(RELAY_WORKSPACE_ID);
    const listedWorkspaces: string[] = [];
    mocks.listWorkspaceIntegrationsByProviderAlias.mockImplementation(async (workspaceId: string) => {
      listedWorkspaces.push(workspaceId);
      if (workspaceId === RELAY_WORKSPACE_ID) {
        return [
          integration({
            workspaceId,
            provider: "github",
            connectionId: "conn-relay",
            providerConfigKey: "github-relay",
            installationId: "",
          }),
        ];
      }
      return [
        integration({
          workspaceId,
          provider: "github-pusher",
          connectionId: "conn-selected",
          providerConfigKey: "github-pusher",
          installationId: "131340034",
        }),
      ];
    });

    const fetchImpl = vi.fn(async () => {
      throw new Error("repo probe should use Nango proxy, not direct fetch");
    });

    const result = await mintWorkflowGithubWriteToken({
      userId: USER_ID,
      workspaceId: APP_WORKSPACE_ID,
      repoOwner: "AgentWorkforce",
      repoName: "cloud",
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(listedWorkspaces).toEqual([RELAY_WORKSPACE_ID, APP_WORKSPACE_ID]);
    expect(result).toMatchObject({
      token: "ghs_conn-relay",
      installationId: "",
    });
  });

  it("falls back to the app workspace when no relay workspace is bound", async () => {
    mockRelayWorkspaceLookup(null);
    const listedWorkspaces: string[] = [];
    mocks.listWorkspaceIntegrationsByProviderAlias.mockImplementation(async (workspaceId: string) => {
      listedWorkspaces.push(workspaceId);
      return [
        integration({
          workspaceId,
          provider: "github",
          connectionId: "conn-app",
          providerConfigKey: "github-relay",
          installationId: "",
        }),
      ];
    });

    const fetchImpl = vi.fn(async () => {
      throw new Error("repo probe should use Nango proxy, not direct fetch");
    });

    await expect(
      mintWorkflowGithubWriteToken({
        userId: USER_ID,
        workspaceId: APP_WORKSPACE_ID,
        repoOwner: "AgentWorkforce",
        repoName: "cloud",
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).resolves.toMatchObject({
      token: "ghs_conn-app",
      installationId: "",
    });
    expect(listedWorkspaces).toEqual([APP_WORKSPACE_ID]);
  });

  it("uses the GitHub auth resolver before the candidate probe loop when enabled", async () => {
    process.env.CLOUD_GITHUB_AUTH_RESOLVER_WORKFLOW_WRITE_ENABLED = "true";
    mockRelayWorkspaceLookup(RELAY_WORKSPACE_ID);
    mocks.resolveGithubAuthShadow.mockImplementation(async ({ workspaceId }: { workspaceId: string }) => {
      if (workspaceId === RELAY_WORKSPACE_ID) {
        return {
          ok: false,
          reason: "missing_installation",
          tokenType: "installation",
          authKind: "app_installation",
        };
      }
      return {
        ok: true,
        tokenType: "installation",
        authKind: "app_installation",
        installationId: "131340034",
        accountLogin: "AgentWorkforce",
        accountType: "Organization",
        matchedBy: "repository_index",
        connectionId: "conn-resolver",
        providerConfigKey: "github-relay",
      };
    });

    const result = await mintWorkflowGithubWriteToken({
      userId: USER_ID,
      workspaceId: APP_WORKSPACE_ID,
      repoOwner: "AgentWorkforce",
      repoName: "cloud",
    });

    expect(result).toEqual({
      token: "ghs_conn-resolver",
      installationId: "131340034",
      repositoryScoped: false,
    });
    expect(mocks.resolveGithubAuthShadow).toHaveBeenCalledWith({
      workspaceId: RELAY_WORKSPACE_ID,
      owner: "AgentWorkforce",
      repo: "cloud",
      purpose: "workflow_write",
    });
    expect(mocks.resolveGithubAuthShadow).toHaveBeenCalledWith({
      workspaceId: APP_WORKSPACE_ID,
      owner: "AgentWorkforce",
      repo: "cloud",
      purpose: "workflow_write",
    });
    expect(mocks.listUserIntegrations).not.toHaveBeenCalled();
    expect(mocks.listWorkspaceIntegrationsByProviderAlias).not.toHaveBeenCalled();
    expect(mocks.getNangoClient().getToken).toHaveBeenCalledWith(
      "github-relay",
      "conn-resolver",
      false,
      true,
    );
  });

  it("uses the GitHub auth resolver when the installation-centric flag is on", async () => {
    mocks.isGithubInstallationCentricEnabled.mockReturnValue(true);
    mocks.resolveGithubAuthShadow.mockResolvedValue({
      ok: true,
      tokenType: "installation",
      authKind: "app_installation",
      installationId: "131340034",
      accountLogin: "AgentWorkforce",
      accountType: "Organization",
      matchedBy: "repository_index",
      connectionId: "conn-installation",
      providerConfigKey: "github-relay",
    });

    const result = await mintWorkflowGithubWriteToken({
      userId: USER_ID,
      workspaceId: APP_WORKSPACE_ID,
      repoOwner: "AgentWorkforce",
      repoName: "cloud",
    });

    expect(result).toEqual({
      token: "ghs_conn-installation",
      installationId: "131340034",
      repositoryScoped: false,
    });
    expect(mocks.resolveGithubAuthShadow).toHaveBeenCalledWith({
      workspaceId: APP_WORKSPACE_ID,
      owner: "AgentWorkforce",
      repo: "cloud",
      purpose: "workflow_write",
    });
    expect(mocks.listWorkspaceIntegrationsByProviderAlias).not.toHaveBeenCalled();
    expect(mocks.getNangoClient().getToken).toHaveBeenCalledWith(
      "github-relay",
      "conn-installation",
      false,
      true,
    );
  });

  it("uses the canonical installation connection for explicit installation allowlists when the flag is on", async () => {
    mocks.isGithubInstallationCentricEnabled.mockReturnValue(true);
    mocks.resolveRepoAllowlistOrRelaxed.mockResolvedValue({
      ...relaxedAllowlist(),
      installationId: "131340034",
    });

    const result = await mintWorkflowGithubWriteToken({
      userId: USER_ID,
      workspaceId: APP_WORKSPACE_ID,
      repoOwner: "AgentWorkforce",
      repoName: "cloud",
    });

    expect(result).toEqual({
      token: "ghs_conn-installation",
      installationId: "131340034",
      repositoryScoped: false,
    });
    expect(mocks.resolveGithubConnectionForWorkspace).toHaveBeenCalledWith(
      APP_WORKSPACE_ID,
    );
    expect(mocks.findWorkspaceGithubIntegrationByInstallation).not.toHaveBeenCalled();
    expect(mocks.getNangoClient().getToken).toHaveBeenCalledWith(
      "github-relay",
      "conn-installation",
      false,
      true,
    );
  });

  it("falls back to the existing probe loop when the enabled resolver is inconclusive", async () => {
    process.env.CLOUD_GITHUB_AUTH_RESOLVER_WORKFLOW_WRITE_ENABLED = "true";
    mocks.resolveGithubAuthShadow.mockResolvedValue({
      ok: false,
      reason: "ambiguous_installation",
      tokenType: "installation",
      authKind: "app_installation",
      candidates: [
        {
          installationId: "100",
          accountLogin: "AgentWorkforce",
          accountType: "Organization",
          matchedBy: "owner_exact",
        },
        {
          installationId: "200",
          accountLogin: "AgentWorkforce",
          accountType: "Organization",
          matchedBy: "owner_exact",
        },
      ],
    });
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([
      integration({
        provider: "github",
        connectionId: "conn-fallback",
        providerConfigKey: "github-relay",
        installationId: "",
      }),
    ]);

    await expect(
      mintWorkflowGithubWriteToken({
        userId: USER_ID,
        workspaceId: APP_WORKSPACE_ID,
        repoOwner: "AgentWorkforce",
        repoName: "cloud",
      }),
    ).resolves.toMatchObject({
      token: "ghs_conn-fallback",
      installationId: "",
    });
    expect(mocks.listWorkspaceIntegrationsByProviderAlias).toHaveBeenCalledWith(
      APP_WORKSPACE_ID,
      "github",
    );
  });

  it("falls back to the existing probe loop when the enabled resolver throws", async () => {
    process.env.CLOUD_GITHUB_AUTH_RESOLVER_WORKFLOW_WRITE_ENABLED = "true";
    mocks.resolveGithubAuthShadow.mockRejectedValue(new Error("resolver unavailable"));
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([
      integration({
        provider: "github",
        connectionId: "conn-after-throw",
        providerConfigKey: "github-relay",
        installationId: "",
      }),
    ]);

    await expect(
      mintWorkflowGithubWriteToken({
        userId: USER_ID,
        workspaceId: APP_WORKSPACE_ID,
        repoOwner: "AgentWorkforce",
        repoName: "cloud",
      }),
    ).resolves.toMatchObject({
      token: "ghs_conn-after-throw",
      installationId: "",
    });
    expect(mocks.listWorkspaceIntegrationsByProviderAlias).toHaveBeenCalledWith(
      APP_WORKSPACE_ID,
      "github",
    );
  });

  it("mints from a github connection with an empty stored installationId after probing repo access", async () => {
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([
      integration({
        provider: "github-pusher",
        connectionId: "conn-selected",
        providerConfigKey: "github-pusher",
        installationId: "131340034",
      }),
      integration({
        provider: "github",
        connectionId: "conn-relay",
        providerConfigKey: "github-relay",
        installationId: "",
      }),
    ]);

    mocks.getNangoClient().proxy.mockImplementation(async ({ connectionId }: { connectionId: string }) => {
      if (connectionId === "conn-relay") {
        return { status: 200, data: { id: 1 } };
      }
      throw Object.assign(new Error("Not Found"), {
        response: { status: 404, data: { message: "Not Found" } },
      });
    });
    const fetchImpl = vi.fn(async () => {
      throw new Error("repo probe should use Nango proxy, not direct fetch");
    });

    const result = await mintWorkflowGithubWriteToken({
      userId: USER_ID,
      workspaceId: "workspace-1",
      repoOwner: "AgentWorkforce",
      repoName: "cloud",
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(result).toEqual({
      token: "ghs_conn-relay",
      installationId: "",
      repositoryScoped: false,
    });
    expect(mocks.getNangoClient().getToken).toHaveBeenCalledWith(
      "github-relay",
      "conn-relay",
      false,
      true,
    );
  });

  it("skips tokenless rows and keeps trying later github connections", async () => {
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([
      integration({
        provider: "github-oauth",
        connectionId: "conn-tokenless",
        providerConfigKey: "github-relay",
        installationId: null,
      }),
      integration({
        provider: "github",
        connectionId: "conn-relay",
        providerConfigKey: "github-ricky",
        installationId: "",
      }),
    ]);

    const fetchImpl = vi.fn(async () => {
      throw new Error("repo probe should use Nango proxy, not direct fetch");
    });

    await expect(
      mintWorkflowGithubWriteToken({
        userId: USER_ID,
        workspaceId: "workspace-1",
        repoOwner: "AgentWorkforce",
        repoName: "cloud",
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).resolves.toMatchObject({
      token: "ghs_conn-relay",
      installationId: "",
    });
  });

  it("fails closed when no github connection can access the repo", async () => {
    mocks.listUserIntegrations.mockResolvedValue([
      userIntegration({
        connectionId: "conn-user",
        providerConfigKey: "github-relay",
        installationId: "",
      }),
    ]);
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([
      integration({
        provider: "github-pusher",
        connectionId: "conn-selected",
        providerConfigKey: "github-pusher",
        installationId: "131340034",
      }),
      integration({
        provider: "github",
        connectionId: "conn-relay",
        providerConfigKey: "github-relay",
        installationId: "",
      }),
    ]);

    mocks.getNangoClient().proxy.mockRejectedValue(Object.assign(new Error("Not Found"), {
      response: { status: 404, data: { message: "Not Found" } },
    }));
    const fetchImpl = vi.fn(async () => {
      throw new Error("repo probe should use Nango proxy, not direct fetch");
    });

    await expect(
      mintWorkflowGithubWriteToken({
        userId: USER_ID,
        workspaceId: "workspace-1",
        repoOwner: "AgentWorkforce",
        repoName: "cloud",
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toMatchObject({
      code: "repo_push_not_allowed",
      status: 403,
    });
  });
});
