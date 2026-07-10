import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => ({
  getNangoConnection: vi.fn(),
  getNangoSecretKey: vi.fn(),
  getComposioConnectedAccount: vi.fn(),
}));

vi.mock("@/lib/integrations/nango-service", () => ({
  createConnectSession: vi.fn(),
  deleteNangoConnection: vi.fn(),
  getNangoConnection: serviceMocks.getNangoConnection,
  getNangoSecretKey: serviceMocks.getNangoSecretKey,
}));

vi.mock("@/lib/integrations/composio-service", () => ({
  createComposioAuthConfig: vi.fn(),
  createComposioConnectionLink: vi.fn(),
  deleteComposioConnectedAccount: vi.fn(),
  getComposioConnectedAccount: serviceMocks.getComposioConnectedAccount,
  isComposioManagedAuthUnavailable: vi.fn(() => false),
  listComposioAuthConfigs: vi.fn(),
  resolveComposioToolkit: vi.fn(),
}));

vi.mock("@/lib/integrations/composio-connect-callback", () => ({
  buildComposioConnectCallbackUrl: vi.fn(() => "https://cloud.test/composio/callback"),
}));

import {
  normalizePersonaIntegrationSource,
  resolvePersonaIntegrations,
  serializeResolvedPersonaIntegrations,
  type PersonaIntegrationResolverDeps,
  type UserIntegrationRow,
  type WorkspaceIntegrationRow,
} from "./persona-integration-resolver";

const now = new Date("2026-05-12T22:00:00.000Z");

function userIntegration(
  overrides: Partial<UserIntegrationRow> = {},
): UserIntegrationRow {
  return {
    id: "user-integration-1",
    userId: "user-1",
    provider: "slack",
    name: null,
    connectionId: "user-conn-1",
    providerConfigKey: "slack-relay",
    installationId: null,
    metadata: {},
    adapter: "nango",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function workspaceIntegration(
  overrides: Partial<WorkspaceIntegrationRow> = {},
): WorkspaceIntegrationRow {
  return {
    id: "workspace-integration-1",
    workspaceId: "workspace-1",
    provider: "slack",
    name: null,
    connectionId: "workspace-conn-1",
    providerConfigKey: "slack-relay",
    installationId: null,
    metadata: {},
    adapter: "nango",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createDeps(input: {
  users?: UserIntegrationRow[];
  workspaces?: WorkspaceIntegrationRow[];
} = {}) {
  const getConnection = vi.fn(async (lookup: {
    connectionId: string;
    backendIntegrationId?: string;
    provider?: string;
  }) => ({
    backend: lookup.connectionId.startsWith("ca_") ? "composio" as const : "nango" as const,
    connectionId: lookup.connectionId,
    backendIntegrationId: lookup.backendIntegrationId,
    provider: lookup.provider,
    status: "active" as const,
    raw: {},
  }));
  const deps: Required<PersonaIntegrationResolverDeps> = {
    findUserIntegration: vi.fn(async ({ userId, provider, name }) =>
      input.users?.find((row) =>
        row.userId === userId &&
        row.provider === provider &&
        row.name === name
      ) ?? null),
    findWorkspaceIntegration: vi.fn(async ({ workspaceId, provider, name }) =>
      input.workspaces?.find((row) =>
        row.workspaceId === workspaceId &&
        row.provider === provider &&
        row.name === name
      ) ?? null),
    getIntegrationBackend: vi.fn((adapter) => ({
      getConnection,
      backend: adapter,
    })),
  };
  return { deps, getConnection };
}

describe("normalizePersonaIntegrationSource", () => {
  it("injects deployer_user when source is missing", () => {
    expect(normalizePersonaIntegrationSource({})).toEqual({ kind: "deployer_user" });
    expect(normalizePersonaIntegrationSource(null)).toEqual({ kind: "deployer_user" });
  });

  it("rejects malformed falsy integration source values cleanly", () => {
    for (const source of [0, false, ""]) {
      expect(() =>
        normalizePersonaIntegrationSource({ source } as never),
      ).toThrow("integration source must be an object.");
    }
  });

  it("rejects malformed workspace service account source names cleanly", () => {
    for (const name of ["", "   ", 123, null, undefined]) {
      expect(() =>
        normalizePersonaIntegrationSource({
          source: { kind: "workspace_service_account", name } as never,
        }),
      ).toThrow("workspace_service_account integration source requires a non-empty name.");
    }
  });
});

describe("resolvePersonaIntegrations", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    serviceMocks.getNangoSecretKey.mockReturnValue("nango-secret");
    serviceMocks.getNangoConnection.mockResolvedValue({
      backend: "nango",
      connectionId: "nango-conn",
      backendIntegrationId: "slack-relay",
      provider: "slack",
      status: "active",
      raw: { secret: "not-forwarded" },
    });
    serviceMocks.getComposioConnectedAccount.mockResolvedValue({
      id: "ca_github",
      status: "ACTIVE",
    });
  });

  it("resolves deployer_user integrations from user_integrations", async () => {
    const row = userIntegration();
    const { deps, getConnection } = createDeps({ users: [row] });

    const result = await resolvePersonaIntegrations({
      workspaceId: "workspace-1",
      deployerUserId: "user-1",
      integrations: { slack: { source: { kind: "deployer_user" } } },
      deps,
    });

    expect(result.slack).toMatchObject({
      provider: "slack",
      source: { kind: "deployer_user" },
      user_oauth: { connectionId: "user-conn-1" },
    });
    expect(deps.findUserIntegration).toHaveBeenCalledWith({
      userId: "user-1",
      provider: "slack",
      name: null,
    });
    expect(getConnection).toHaveBeenCalledWith({
      connectionId: "user-conn-1",
      backendIntegrationId: "slack-relay",
      provider: "slack",
    });
  });

  it("defaults missing source to deployer_user at resolver entry", async () => {
    const row = userIntegration({ provider: "linear", providerConfigKey: "linear-relay" });
    const { deps } = createDeps({ users: [row] });

    const result = await resolvePersonaIntegrations({
      workspaceId: "workspace-1",
      deployerUserId: "user-1",
      integrations: { linear: {} },
      deps,
    });

    expect(result.linear.source).toEqual({ kind: "deployer_user" });
    expect(deps.findUserIntegration).toHaveBeenCalledWith({
      userId: "user-1",
      provider: "linear",
      name: null,
    });
  });

  it("resolves workspace integrations from workspace_integrations with name IS NULL", async () => {
    const row = workspaceIntegration({ provider: "notion", providerConfigKey: "notion-relay" });
    const { deps } = createDeps({ workspaces: [row] });

    const result = await resolvePersonaIntegrations({
      workspaceId: "workspace-1",
      deployerUserId: "user-1",
      integrations: { notion: { source: { kind: "workspace" } } },
      deps,
    });

    expect(result.notion).toMatchObject({
      provider: "notion",
      source: { kind: "workspace" },
      workspace_integration: { connectionId: "workspace-conn-1" },
    });
    expect(deps.findWorkspaceIntegration).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      provider: "notion",
      name: null,
    });
  });

  it("resolves named workspace service accounts", async () => {
    const row = workspaceIntegration({
      provider: "github",
      name: "release-bot",
      connectionId: "svc-conn-1",
      providerConfigKey: "github-relay",
    });
    const { deps } = createDeps({ workspaces: [row] });

    const result = await resolvePersonaIntegrations({
      workspaceId: "workspace-1",
      deployerUserId: "user-1",
      integrations: {
        github: {
          source: { kind: "workspace_service_account", name: "release-bot" },
        },
      },
      deps,
    });

    expect(result.github).toMatchObject({
      source: { kind: "workspace_service_account", name: "release-bot" },
      workspace_service_account: { connectionId: "svc-conn-1" },
    });
    expect(deps.findWorkspaceIntegration).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      provider: "github",
      name: "release-bot",
    });
  });

  it("combines GitHub deployer_user OAuth with workspace App install", async () => {
    const user = userIntegration({
      provider: "github",
      connectionId: "github-user-oauth",
      providerConfigKey: "github-relay",
    });
    const workspace = workspaceIntegration({
      provider: "github",
      connectionId: "github-app-install",
      providerConfigKey: "github-relay",
      installationId: "12345",
    });
    const { deps, getConnection } = createDeps({ users: [user], workspaces: [workspace] });

    const result = await resolvePersonaIntegrations({
      workspaceId: "workspace-1",
      deployerUserId: "user-1",
      integrations: { github: { source: { kind: "deployer_user" } } },
      deps,
    });

    expect(result.github).toMatchObject({
      provider: "github",
      user_oauth: { connectionId: "github-user-oauth" },
      workspace_install: {
        connectionId: "github-app-install",
        installationId: "12345",
      },
    });
    expect(getConnection).toHaveBeenCalledTimes(2);
  });

  it("fails clearly when GitHub workspace install is missing", async () => {
    const { deps } = createDeps({
      users: [userIntegration({ provider: "github" })],
      workspaces: [],
    });

    await expect(resolvePersonaIntegrations({
      workspaceId: "workspace-1",
      deployerUserId: "user-1",
      integrations: { github: { source: { kind: "deployer_user" } } },
      deps,
    })).rejects.toThrow(
      "GitHub deploys require both a user OAuth and a workspace GitHub App install. Workspace install missing.",
    );
  });

  it("fails clearly when GitHub workspace install has no installation id", async () => {
    const { deps } = createDeps({
      users: [userIntegration({ provider: "github" })],
      workspaces: [
        workspaceIntegration({
          provider: "github",
          connectionId: "github-app-install",
          providerConfigKey: "github-relay",
          installationId: null,
        }),
      ],
    });

    await expect(resolvePersonaIntegrations({
      workspaceId: "workspace-1",
      deployerUserId: "user-1",
      integrations: { github: { source: { kind: "deployer_user" } } },
      deps,
    })).rejects.toThrow(
      "GitHub deploys require both a user OAuth and a workspace GitHub App install. Workspace install missing.",
    );
  });

  it("fails clearly when deployer user credentials are missing", async () => {
    const { deps } = createDeps();

    await expect(resolvePersonaIntegrations({
      workspaceId: "workspace-1",
      deployerUserId: "user-1",
      integrations: { slack: { source: { kind: "deployer_user" } } },
      deps,
    })).rejects.toThrow(
      "Integration 'slack' requires deployer user credentials for user 'user-1'.",
    );
  });

  it("throws not-yet-wired for pipedream and unknown adapters", async () => {
    await expect(resolvePersonaIntegrations({
      workspaceId: "workspace-1",
      deployerUserId: "user-1",
      integrations: { slack: { source: { kind: "workspace" } } },
      deps: createDeps({
        workspaces: [workspaceIntegration({ adapter: "pipedream" })],
      }).deps,
    })).rejects.toThrow("Adapter 'pipedream' not yet wired");

    await expect(resolvePersonaIntegrations({
      workspaceId: "workspace-1",
      deployerUserId: "user-1",
      integrations: { slack: { source: { kind: "workspace" } } },
      deps: createDeps({
        workspaces: [workspaceIntegration({ adapter: "zapier" })],
      }).deps,
    })).rejects.toThrow("Adapter 'zapier' not yet wired");
  });

  it("dispatches adapter introspection to Nango and Composio backends", async () => {
    const nango = userIntegration({
      provider: "slack",
      adapter: "nango",
      connectionId: "nango-conn",
      providerConfigKey: "slack-relay",
    });
    const composio = workspaceIntegration({
      provider: "github",
      adapter: "composio",
      connectionId: "ca_github",
      providerConfigKey: "github",
    });
    const { deps } = createDeps({
      users: [nango],
      workspaces: [composio],
    });

    await resolvePersonaIntegrations({
      workspaceId: "workspace-1",
      deployerUserId: "user-1",
      integrations: {
        slack: { source: { kind: "deployer_user" } },
        github: { source: { kind: "workspace" } },
      },
      deps,
    });

    expect(deps.getIntegrationBackend).toHaveBeenCalledWith("nango");
    expect(deps.getIntegrationBackend).toHaveBeenCalledWith("composio");
  });

  it("routes adapter introspection through the production backend registry services", async () => {
    const nango = userIntegration({
      provider: "slack",
      adapter: "nango",
      connectionId: "nango-conn",
      providerConfigKey: "slack-relay",
    });
    const composio = workspaceIntegration({
      provider: "github",
      adapter: "composio",
      connectionId: "ca_github",
      providerConfigKey: "github",
    });
    const { deps } = createDeps({
      users: [nango],
      workspaces: [composio],
    });

    await resolvePersonaIntegrations({
      workspaceId: "workspace-1",
      deployerUserId: "user-1",
      integrations: {
        slack: { source: { kind: "deployer_user" } },
        github: { source: { kind: "workspace" } },
      },
      deps: {
        findUserIntegration: deps.findUserIntegration,
        findWorkspaceIntegration: deps.findWorkspaceIntegration,
      },
    });

    expect(serviceMocks.getNangoConnection).toHaveBeenCalledWith(
      "nango-conn",
      "slack-relay",
      { provider: "slack" },
    );
    expect(serviceMocks.getComposioConnectedAccount).toHaveBeenCalledWith("ca_github");
  });

  it("serializes GitHub combined rows with both backend connections for deploy consumers", async () => {
    const user = userIntegration({
      provider: "github",
      connectionId: "github-user-oauth",
      providerConfigKey: "github-relay",
    });
    const workspace = workspaceIntegration({
      provider: "github",
      connectionId: "github-app-install",
      providerConfigKey: "github-relay",
      installationId: "12345",
    });
    const { deps } = createDeps({ users: [user], workspaces: [workspace] });

    const resolved = await resolvePersonaIntegrations({
      workspaceId: "workspace-1",
      deployerUserId: "user-1",
      integrations: { github: { source: { kind: "deployer_user" } } },
      deps,
    });

    expect(serializeResolvedPersonaIntegrations(resolved).github).toMatchObject({
      provider: "github",
      user_oauth: { connectionId: "github-user-oauth" },
      workspace_install: {
        connectionId: "github-app-install",
        installationId: "12345",
      },
      backendConnections: {
        user_oauth: { connectionId: "github-user-oauth" },
        workspace_install: { connectionId: "github-app-install" },
      },
    });
  });
});
