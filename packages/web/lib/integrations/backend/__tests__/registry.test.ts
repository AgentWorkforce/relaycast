import { describe, expect, it, vi } from "vitest";
import { BackendPolicyError, getIntegrationBackend } from "..";
import { BackendNotConfiguredError } from "../../backend-config";
import { parseComposioConnectCallbackState } from "../../composio-connect-callback";

vi.mock("sst", () => ({
  Resource: {
    AuthSessionSecret: { value: "test-auth-session-secret" },
  },
}));

describe("getIntegrationBackend", () => {
  const resolveComposioToolkit = vi.fn(async (slug: string) => ({
    slug: slug === "dockerhub" ? "docker_hub" : slug,
    name: slug === "dockerhub" || slug === "docker_hub" ? "Docker Hub" : "GitHub",
  }));

  it("maps Nango setup sessions to the backend-neutral contract", async () => {
    const createConnectSession = vi.fn(async () => ({
      token: "session-token",
      expiresAt: "2026-05-08T12:00:00.000Z",
      connectLink: "https://nango.test/connect",
      connectionId: "conn_123",
    }));
    const backend = getIntegrationBackend("nango", { createConnectSession });

    await expect(
      backend.createSetupSession({
        workspaceId: "workspace-1",
        endUserId: "workspace-1",
        endUserEmail: "user@example.test",
        allowedIntegrations: [
          {
            provider: "github",
            backendIntegrationId: "github-relay",
            displayName: "GitHub",
          },
        ],
      }),
    ).resolves.toMatchObject({
      backend: "nango",
      connectLink: "https://nango.test/connect",
      sessionToken: "session-token",
      expiresAt: "2026-05-08T12:00:00.000Z",
      connectionId: "conn_123",
    });
    expect(createConnectSession).toHaveBeenCalledWith({
      endUserId: "workspace-1",
      endUserEmail: "user@example.test",
      allowedIntegrations: ["github-relay"],
      tags: undefined,
      integrationConfigDefaults: undefined,
    });
  });

  it.each([
    ["linear", "linear-relay", "Linear"],
    ["linear", "linear-sage", "Linear"],
    ["linear-ricky", "linear-ricky", "Linear (Ricky)"],
  ])(
    "passes %s app actor authorization params into Nango setup sessions",
    async (provider, backendIntegrationId, displayName) => {
      const createConnectSession = vi.fn(async () => ({
        token: "session-token",
        connectLink: "https://nango.test/connect",
      }));
      const backend = getIntegrationBackend("nango", { createConnectSession });

      await backend.createSetupSession({
        workspaceId: "workspace-1",
        endUserId: "workspace-1",
        endUserEmail: null,
        allowedIntegrations: [
          {
            provider,
            backendIntegrationId,
            displayName,
          },
        ],
      });

      expect(createConnectSession).toHaveBeenCalledWith({
        endUserId: "workspace-1",
        endUserEmail: null,
        allowedIntegrations: [backendIntegrationId],
        tags: undefined,
        integrationConfigDefaults: {
          [backendIntegrationId]: {
            authorization_params: { actor: "app" },
          },
        },
      });
    },
  );

  it("leaves Nango default integration expansion to the existing helper", async () => {
    const createConnectSession = vi.fn(async () => ({
      token: "session-token",
      connectLink: "https://nango.test/connect",
    }));
    const backend = getIntegrationBackend("nango", { createConnectSession });

    await backend.createSetupSession({
      workspaceId: "workspace-1",
      endUserId: "workspace-1",
      endUserEmail: null,
      allowedIntegrations: [],
    });

    expect(createConnectSession).toHaveBeenCalledWith({
      endUserId: "workspace-1",
      endUserEmail: null,
      allowedIntegrations: undefined,
      integrationConfigDefaults: undefined,
    });
  });

  it("maps Nango connection lookups to the backend-neutral contract", async () => {
    const getNangoConnection = vi.fn(async () => ({
      backend: "nango" as const,
      connectionId: "conn_123",
      provider: "github",
      backendIntegrationId: "github-relay",
      status: "active" as const,
      raw: {},
    }));
    const backend = getIntegrationBackend("nango", { getNangoConnection });

    await expect(
      backend.getConnection({
        connectionId: "conn_123",
        backendIntegrationId: "github-relay",
        provider: "github",
      }),
    ).resolves.toMatchObject({
      backend: "nango",
      connectionId: "conn_123",
      backendIntegrationId: "github-relay",
      status: "active",
    });
    expect(getNangoConnection).toHaveBeenCalledWith(
      "conn_123",
      "github-relay",
      { provider: "github" },
    );
  });

  it("creates Composio setup sessions from auth config discovery", async () => {
    const listComposioAuthConfigs = vi.fn(async () => [
      { id: "ac_github", toolkit: { slug: "github" } },
    ]);
    const createComposioConnectionLink = vi.fn(async () => ({
      link_token: "link_123",
      redirect_url: "https://composio.test/connect",
      connected_account_id: "ca_123",
      expires_at: "2026-05-08T12:00:00.000Z",
    }));
    const backend = getIntegrationBackend("composio", {
      listComposioAuthConfigs,
      createComposioConnectionLink,
      resolveComposioToolkit,
    });

    await expect(
      backend.createSetupSession({
        workspaceId: "workspace-1",
        endUserId: "workspace-1",
        allowedIntegrations: [
          {
            provider: "github",
            backendIntegrationId: "github",
            displayName: "GitHub",
          },
        ],
        successRedirectUrl: "https://agentrelay.test/cloud/api/v1/webhooks/composio/connect/callback",
      }),
    ).resolves.toMatchObject({
      backend: "composio",
      connectLink: "https://composio.test/connect",
      sessionToken: "link_123",
      connectionId: "ca_123",
      backendMetadata: {
        authConfigId: "ac_github",
        toolkitSlug: "github",
        provider: "github",
      },
    });
    expect(listComposioAuthConfigs).toHaveBeenCalledWith("github");
    expect(createComposioConnectionLink).toHaveBeenCalledWith({
      userId: "workspace-1",
      authConfigId: "ac_github",
      callbackUrl: expect.stringContaining(
        "https://agentrelay.test/cloud/api/v1/webhooks/composio/connect/callback?state=",
      ),
      connectionData: {
        workspaceId: "workspace-1",
        provider: "github",
        backendIntegrationId: "github",
      },
    });
  });

  it("maps Composio connection lookups to the backend-neutral contract", async () => {
    const getComposioConnectedAccount = vi.fn(async () => ({
      id: "ca_123",
      status: "ACTIVE",
    }));
    const backend = getIntegrationBackend("composio", {
      getComposioConnectedAccount,
    });

    await expect(
      backend.getConnection({
        connectionId: "ca_123",
        backendIntegrationId: "github",
        provider: "github",
      }),
    ).resolves.toMatchObject({
      backend: "composio",
      connectionId: "ca_123",
      backendIntegrationId: "github",
      status: "active",
    });
    expect(getComposioConnectedAccount).toHaveBeenCalledWith("ca_123");
  });

  it("creates a missing Composio auth config before linking", async () => {
    const createComposioAuthConfig = vi.fn(async () => ({
      auth_config: { id: "ac_created" },
    }));
    const createComposioConnectionLink = vi.fn(async () => ({
      link_token: "link_123",
      redirect_url: "https://composio.test/connect",
    }));
    const backend = getIntegrationBackend("composio", {
      listComposioAuthConfigs: vi.fn(async () => []),
      createComposioAuthConfig,
      createComposioConnectionLink,
      resolveComposioToolkit,
    });

    await expect(
      backend.createSetupSession({
        workspaceId: "workspace-1",
        endUserId: "workspace-1",
        allowedIntegrations: [
          {
            provider: "github",
            backendIntegrationId: "github",
          },
        ],
      }),
    ).resolves.toMatchObject({
      backend: "composio",
      backendMetadata: {
        authConfigId: "ac_created",
      },
    });
    expect(createComposioAuthConfig).toHaveBeenCalledWith("github");
  });

  it("discovers a custom Composio auth config after managed auth is unavailable", async () => {
    const listComposioAuthConfigs = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "ac_docker_hub_custom", toolkit: { slug: "docker_hub" } },
      ]);
    const createComposioAuthConfig = vi.fn(async () => {
      throw new Error(
        'Composio auth config creation failed with 400: Default auth config not found for toolkit "docker_hub". Composio does not have managed credentials for this toolkit.',
      );
    });
    const createComposioConnectionLink = vi.fn(async () => ({
      link_token: "link_123",
      redirect_url: "https://composio.test/connect",
    }));
    const backend = getIntegrationBackend("composio", {
      listComposioAuthConfigs,
      createComposioAuthConfig,
      createComposioConnectionLink,
      resolveComposioToolkit,
    });

    await expect(
      backend.createSetupSession({
        workspaceId: "workspace-1",
        endUserId: "workspace-1",
        allowedIntegrations: [
          {
            provider: "dockerhub",
            backendIntegrationId: "dockerhub",
          },
        ],
      }),
    ).resolves.toMatchObject({
      backend: "composio",
      backendMetadata: {
        authConfigId: "ac_docker_hub_custom",
        toolkitSlug: "docker_hub",
      },
    });
    expect(listComposioAuthConfigs).toHaveBeenCalledTimes(2);
    expect(listComposioAuthConfigs).toHaveBeenNthCalledWith(1, "docker_hub");
    expect(listComposioAuthConfigs).toHaveBeenNthCalledWith(2, "docker_hub");
    expect(createComposioAuthConfig).toHaveBeenCalledWith("docker_hub");
    expect(createComposioConnectionLink).toHaveBeenCalledWith(
      expect.objectContaining({
        authConfigId: "ac_docker_hub_custom",
      }),
    );
  });

  it("returns an actionable error when a Composio toolkit needs a custom auth config", async () => {
    const listComposioAuthConfigs = vi.fn(async () => []);
    const createComposioAuthConfig = vi.fn(async () => {
      throw new Error(
        'Composio auth config creation failed with 400: Default auth config not found for toolkit "docker_hub". Composio does not have managed credentials for this toolkit.',
      );
    });
    const backend = getIntegrationBackend("composio", {
      listComposioAuthConfigs,
      createComposioAuthConfig,
      resolveComposioToolkit,
    });

    await expect(
      backend.createSetupSession({
        workspaceId: "workspace-1",
        endUserId: "workspace-1",
        allowedIntegrations: [
          {
            provider: "dockerhub",
            backendIntegrationId: "dockerhub",
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "backend_misconfigured",
      message:
        'Composio toolkit "docker_hub" does not support automatic managed auth config creation. Add a custom auth config for toolkit "docker_hub" in Composio Authentication Management, then retry; Cloud will discover it dynamically.',
    });
  });

  it("requires exactly one Composio allowed integration", async () => {
    const listComposioAuthConfigs = vi.fn(async () => [
      { id: "ac_github", toolkit: { slug: "github" } },
    ]);
    const backend = getIntegrationBackend("composio", {
      listComposioAuthConfigs,
    });

    await expect(
      backend.createSetupSession({
        workspaceId: "workspace-1",
        endUserId: "workspace-1",
        allowedIntegrations: [
          {
            provider: "github",
            backendIntegrationId: "github",
          },
          {
            provider: "github",
            backendIntegrationId: "github",
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "backend_misconfigured",
      message: "Composio setup requires exactly one allowed integration",
    });
    expect(listComposioAuthConfigs).not.toHaveBeenCalled();
  });

  it("maps Composio not-configured service errors to backend policy errors", async () => {
    const backend = getIntegrationBackend("composio", {
      resolveComposioToolkit,
      listComposioAuthConfigs: vi.fn(async () => {
        throw new BackendNotConfiguredError("composio");
      }),
    });

    await expect(
      backend.createSetupSession({
        workspaceId: "workspace-1",
        endUserId: "workspace-1",
        allowedIntegrations: [
          {
            provider: "github",
            backendIntegrationId: "github",
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "backend_not_configured",
      message: "Composio backend not configured",
    });
  });

  it("maps Composio request failures to typed setup errors", async () => {
    const backend = getIntegrationBackend("composio", {
      resolveComposioToolkit,
      listComposioAuthConfigs: vi.fn(async () => {
        throw new Error("Composio auth config lookup failed with 500");
      }),
    });

    await expect(
      backend.createSetupSession({
        workspaceId: "workspace-1",
        endUserId: "workspace-1",
        allowedIntegrations: [
          {
            provider: "github",
            backendIntegrationId: "github",
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "backend_misconfigured",
      message: "Composio auth config lookup failed with 500",
    });
  });

  it("accepts a dynamic Composio toolkit alias as the provider id", async () => {
    const createComposioConnectionLink = vi.fn(async () => ({
      link_token: "link_123",
      redirect_url: "https://composio.test/connect",
    }));
    const backend = getIntegrationBackend("composio", {
      resolveComposioToolkit,
      listComposioAuthConfigs: vi.fn(async () => [
        { id: "ac_dockerhub", toolkit: { slug: "docker_hub" } },
      ]),
      createComposioConnectionLink,
    });

    await expect(
      backend.createSetupSession({
        workspaceId: "workspace-1",
        endUserId: "workspace-1",
        allowedIntegrations: [
          {
            provider: "dockerhub",
            backendIntegrationId: "dockerhub",
          },
        ],
        successRedirectUrl: "https://agentrelay.test/cloud/api/v1/webhooks/composio/connect/callback",
        metadata: { dockerHubUsername: "khaliqgant" },
      }),
    ).resolves.toMatchObject({
      backend: "composio",
      backendMetadata: {
        authConfigId: "ac_dockerhub",
        toolkitSlug: "docker_hub",
        provider: "docker_hub",
        displayName: "Docker Hub",
      },
    });
    expect(createComposioConnectionLink).toHaveBeenCalledWith(
      expect.objectContaining({
        callbackUrl: expect.stringContaining("state="),
        connectionData: expect.objectContaining({
          provider: "docker_hub",
          backendIntegrationId: "docker_hub",
        }),
      }),
    );
    const firstCall = createComposioConnectionLink.mock.calls[0] as unknown as
      | [{ callbackUrl?: string }]
      | undefined;
    const callbackUrl = firstCall?.[0].callbackUrl;
    expect(typeof callbackUrl).toBe("string");
    const state = new URL(callbackUrl as string).searchParams.get("state");
    expect(state).toBeTruthy();
    expect(
      parseComposioConnectCallbackState(state as string, "test-auth-session-secret"),
    ).toMatchObject({
      provider: "docker_hub",
      toolkitSlug: "docker_hub",
      dockerHubUsername: "khaliqgant",
    });
  });
});
