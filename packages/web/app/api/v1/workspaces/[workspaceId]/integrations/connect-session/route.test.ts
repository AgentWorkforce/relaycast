import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// This route is the one `relayfile integration connect` uses. The bug under
// test: it never pre-created a pending workspace_integrations row, so when the
// Nango connection-created ("auth") webhook misrouted / arrived with stripped
// end-user tags / never reached the deployment, the connection was never
// recorded and the status endpoint reported oauth.connected:false forever
// (CLI polled until "context deadline exceeded"). The legacy
// cli-connect-link-route already pre-created the row (#461); connect-session
// regressed that safety net.

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  hasWorkspaceAccess: vi.fn(),
  resolveWorkspaceIntegrationIdentity: vi.fn(),
  hasWorkspaceIntegrationAccess: vi.fn(),
  getIntegrationBackend: vi.fn(),
  selectIntegrationBackend: vi.fn(),
  insertUserIntegrationIfAbsent: vi.fn(),
  insertWorkspaceIntegrationIfAbsent: vi.fn(),
  buildPendingProviderMetadata: vi.fn(),
  isGithubInstallationCentricEnabled: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: mocks.resolveRequestAuth,
}));

vi.mock("@/lib/integrations/integration-route-handler", () => ({
  CLOUD_INTEGRATIONS_WRITE_SCOPE: "cloud:integrations:write",
  hasCloudControlScope: vi.fn(() => true),
  hasWorkspaceAccess: mocks.hasWorkspaceAccess,
}));

vi.mock("@/lib/workspaces/workspace-integration-identity", () => ({
  resolveWorkspaceIntegrationIdentity: mocks.resolveWorkspaceIntegrationIdentity,
  hasWorkspaceIntegrationAccess: mocks.hasWorkspaceIntegrationAccess,
}));

vi.mock("@/lib/integrations/backend", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/integrations/backend")
  >("@/lib/integrations/backend");
  return {
    ...actual,
    getIntegrationBackend: mocks.getIntegrationBackend,
    selectIntegrationBackend: mocks.selectIntegrationBackend,
  };
});

vi.mock("@cloud/core/provider-readiness.js", async () => {
  const actual = await vi.importActual<
    typeof import("@cloud/core/provider-readiness.js")
  >("@cloud/core/provider-readiness.js");
  return {
    ...actual,
    buildPendingProviderMetadata: mocks.buildPendingProviderMetadata,
  };
});

vi.mock("@/lib/integrations/workspace-integrations", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/integrations/workspace-integrations")
  >("@/lib/integrations/workspace-integrations");
  return {
    ...actual,
    insertWorkspaceIntegrationIfAbsent: mocks.insertWorkspaceIntegrationIfAbsent,
  };
});

vi.mock("@/lib/logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
  },
}));

vi.mock("@/lib/integrations/user-integrations", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/integrations/user-integrations")
  >("@/lib/integrations/user-integrations");
  return {
    ...actual,
    insertUserIntegrationIfAbsent: mocks.insertUserIntegrationIfAbsent,
  };
});

vi.mock("@/lib/integrations/github-installation-centric-flag", () => ({
  isGithubInstallationCentricEnabled: mocks.isGithubInstallationCentricEnabled,
}));

import { POST } from "./route";

function jsonRequest(workspaceId: string, body: unknown): NextRequest {
  return new NextRequest(
    `https://agentrelay.test/api/v1/workspaces/${workspaceId}/integrations/connect-session`,
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    },
  );
}

function context(workspaceId: string) {
  return { params: Promise.resolve({ workspaceId }) };
}

const WORKSPACE_ID = "rw_fc7b534b";
const NANGO_CONNECTION_ID = "48d75838-5c1b-4885-b0c1-3620a80e12f6";

describe("POST /api/v1/workspaces/[workspaceId]/integrations/connect-session", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = "https://agentrelay.test";
    mocks.resolveRequestAuth.mockResolvedValue({
      userId: "user_123",
      source: "session",
      context: { user: { email: "dev@example.test" } },
    });
    mocks.hasWorkspaceAccess.mockReturnValue(true);
    mocks.resolveWorkspaceIntegrationIdentity.mockImplementation(
      async (workspaceId: string) => ({
        requestedWorkspaceId: workspaceId,
        appWorkspaceId: workspaceId,
        relayWorkspaceId: workspaceId,
        organizationId: "org_123",
        candidateWorkspaceIds: [workspaceId],
      }),
    );
    mocks.hasWorkspaceIntegrationAccess.mockReturnValue(true);
    mocks.selectIntegrationBackend.mockReturnValue({
      backend: "nango",
      backendIntegrationId: "confluence-relay",
    });
    mocks.getIntegrationBackend.mockReturnValue({
      backend: "nango",
      createSetupSession: vi.fn().mockResolvedValue({
        backend: "nango",
        connectLink: "https://connect.nango.dev/session/tok",
        sessionToken: "tok",
        expiresAt: "2026-05-19T12:00:00.000Z",
        connectionId: NANGO_CONNECTION_ID,
      }),
    });
    mocks.buildPendingProviderMetadata.mockReturnValue({
      readiness: { status: "pending" },
    });
    mocks.insertWorkspaceIntegrationIfAbsent.mockResolvedValue({
      inserted: true,
    });
    mocks.insertUserIntegrationIfAbsent.mockResolvedValue({
      inserted: true,
    });
    mocks.isGithubInstallationCentricEnabled.mockReturnValue(false);
  });

  it("pre-creates a pending workspace_integrations row for a nango provider (confluence repro)", async () => {
    const response = await POST(
      jsonRequest(WORKSPACE_ID, { allowedIntegrations: ["confluence"] }),
      context(WORKSPACE_ID),
    );

    expect(response.status).toBe(200);
    expect(mocks.insertWorkspaceIntegrationIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        provider: "confluence",
        connectionId: NANGO_CONNECTION_ID,
        providerConfigKey: "confluence-relay",
        installationId: null,
      }),
    );
    expect(mocks.buildPendingProviderMetadata).toHaveBeenCalledWith({
      connectionId: NANGO_CONNECTION_ID,
      providerConfigKey: "confluence-relay",
    });
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "connect-session pre-created pending integration",
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        provider: "confluence",
        providerConfigKey: "confluence-relay",
      }),
    );
  });

  it("uses the bound Relayfile workspace for Nango session tags when addressed by app UUID", async () => {
    const createSetupSession = vi.fn().mockResolvedValue({
      backend: "nango",
      connectLink: "https://connect.nango.dev/session/tok",
      sessionToken: "tok",
      expiresAt: "2026-05-19T12:00:00.000Z",
      connectionId: NANGO_CONNECTION_ID,
    });
    mocks.resolveWorkspaceIntegrationIdentity.mockResolvedValue({
      requestedWorkspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
      appWorkspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
      relayWorkspaceId: "rw_7ccfea89",
      organizationId: "org_123",
      candidateWorkspaceIds: [
        "50587328-441d-4acb-b8f3-dbe1b3c5de99",
        "rw_7ccfea89",
      ],
    });
    mocks.getIntegrationBackend.mockReturnValue({
      backend: "nango",
      createSetupSession,
    });

    const response = await POST(
      jsonRequest("50587328-441d-4acb-b8f3-dbe1b3c5de99", {
        allowedIntegrations: ["slack"],
      }),
      context("50587328-441d-4acb-b8f3-dbe1b3c5de99"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      workspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
      relayWorkspaceId: "rw_7ccfea89",
    });
    expect(mocks.selectIntegrationBackend).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "rw_7ccfea89",
        provider: "slack",
      }),
    );
    expect(createSetupSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "rw_7ccfea89",
        endUserId: "rw_7ccfea89",
        metadata: expect.objectContaining({
          workspaceId: "rw_7ccfea89",
          end_user_id: "rw_7ccfea89",
        }),
      }),
    );
    expect(mocks.insertWorkspaceIntegrationIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "rw_7ccfea89",
        provider: "slack",
      }),
    );
  });

  it("does not write or return a workspaceId placeholder when Nango omits connectionId", async () => {
    mocks.getIntegrationBackend.mockReturnValue({
      backend: "nango",
      createSetupSession: vi.fn().mockResolvedValue({
        backend: "nango",
        connectLink: "https://connect.nango.dev/session/tok",
        sessionToken: "tok",
        expiresAt: "2026-05-19T12:00:00.000Z",
      }),
    });

    const response = await POST(
      jsonRequest(WORKSPACE_ID, { allowedIntegrations: ["slack"] }),
      context(WORKSPACE_ID),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).not.toHaveProperty("connectionId");
    expect(mocks.insertWorkspaceIntegrationIfAbsent).not.toHaveBeenCalled();
    expect(mocks.buildPendingProviderMetadata).not.toHaveBeenCalled();
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "connect-session skipped pending workspace integration pre-create without connection id",
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
      }),
    );
  });

  it("does not pre-create a Nango workspace row from a Composio-style connection id", async () => {
    mocks.getIntegrationBackend.mockReturnValue({
      backend: "nango",
      createSetupSession: vi.fn().mockResolvedValue({
        backend: "nango",
        connectLink: "https://connect.nango.dev/session/tok",
        sessionToken: "tok",
        expiresAt: "2026-05-19T12:00:00.000Z",
        connectionId: "ca_5YtkH6snwxJW",
      }),
    });

    const response = await POST(
      jsonRequest(WORKSPACE_ID, { allowedIntegrations: ["neon"] }),
      context(WORKSPACE_ID),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      connectionId: "ca_5YtkH6snwxJW",
    });
    expect(mocks.insertWorkspaceIntegrationIfAbsent).not.toHaveBeenCalled();
    expect(mocks.buildPendingProviderMetadata).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "connect-session skipped Nango pending integration pre-create with non-Nango connection id",
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        connectionId: "ca_5YtkH6snwxJW",
      }),
    );
  });

  it("does not pre-create rows for the composio backend (guard-rail: composio path unchanged)", async () => {
    mocks.selectIntegrationBackend.mockReturnValue({
      backend: "composio",
      backendIntegrationId: "confluence",
    });
    mocks.getIntegrationBackend.mockReturnValue({
      backend: "composio",
      createSetupSession: vi.fn().mockResolvedValue({
        backend: "composio",
        connectLink: "https://composio.test/connect",
        sessionToken: "ctok",
        backendMetadata: { toolkitSlug: "confluence" },
      }),
    });

    const response = await POST(
      jsonRequest(WORKSPACE_ID, {
        allowedIntegrations: ["confluence"],
        requestedBackend: "composio",
      }),
      context(WORKSPACE_ID),
    );

    expect(response.status).toBe(200);
    expect(mocks.insertWorkspaceIntegrationIfAbsent).not.toHaveBeenCalled();
  });

  it("requires dockerHubUsername when connecting Docker Hub through Composio", async () => {
    mocks.selectIntegrationBackend.mockReturnValue({
      backend: "composio",
      backendIntegrationId: "docker_hub",
    });

    const response = await POST(
      jsonRequest(WORKSPACE_ID, {
        allowedIntegrations: ["docker_hub"],
        requestedBackend: "composio",
      }),
      context(WORKSPACE_ID),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "missing_docker_hub_username",
      message: "dockerHubUsername is required when connecting Docker Hub through Composio.",
    });
    expect(mocks.getIntegrationBackend).not.toHaveBeenCalled();
  });

  it("passes dockerHubUsername into the Composio setup session metadata", async () => {
    const createSetupSession = vi.fn().mockResolvedValue({
      backend: "composio",
      connectLink: "https://composio.test/connect",
      sessionToken: "ctok",
      backendMetadata: { toolkitSlug: "docker_hub" },
    });
    mocks.selectIntegrationBackend.mockReturnValue({
      backend: "composio",
      backendIntegrationId: "docker_hub",
    });
    mocks.getIntegrationBackend.mockReturnValue({
      backend: "composio",
      createSetupSession,
    });

    const response = await POST(
      jsonRequest(WORKSPACE_ID, {
        allowedIntegrations: ["docker_hub"],
        requestedBackend: "composio",
        dockerHubUsername: "  khaliqgant  ",
      }),
      context(WORKSPACE_ID),
    );

    expect(response.status).toBe(200);
    expect(createSetupSession).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { dockerHubUsername: "khaliqgant" },
      }),
    );
  });

  it("still returns 200 if the pending-row insert throws (never fails connect)", async () => {
    mocks.insertWorkspaceIntegrationIfAbsent.mockRejectedValue(
      new Error("db down"),
    );

    const response = await POST(
      jsonRequest(WORKSPACE_ID, { allowedIntegrations: ["confluence"] }),
      context(WORKSPACE_ID),
    );

    expect(response.status).toBe(200);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "connect-session failed to pre-create pending integration",
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        provider: "confluence",
        error: "db down",
      }),
    );
  });

  it("pre-creates one row per distinct nango provider when multiple are allowed", async () => {
    const response = await POST(
      jsonRequest(WORKSPACE_ID, {
        allowedIntegrations: ["confluence", "github", "confluence"],
      }),
      context(WORKSPACE_ID),
    );

    expect(response.status).toBe(200);
    const providersInserted = mocks.insertWorkspaceIntegrationIfAbsent.mock.calls.map(
      (call) => (call[0] as { provider: string }).provider,
    );
    expect(providersInserted).toContain("confluence");
    expect(providersInserted).toContain("github");
    // de-duplicated: confluence appears once despite being listed twice
    expect(providersInserted.filter((p) => p === "confluence")).toHaveLength(1);
  });

  it("pre-creates deployer_user scoped rows in user_integrations", async () => {
    const response = await POST(
      jsonRequest(WORKSPACE_ID, {
        allowedIntegrations: ["github"],
        scope: { kind: "deployer_user" },
      }),
      context(WORKSPACE_ID),
    );

    expect(response.status).toBe(200);
    expect(mocks.insertUserIntegrationIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_123",
        provider: "github",
        connectionId: NANGO_CONNECTION_ID,
        providerConfigKey: "github-relay",
        installationId: null,
      }),
    );
    expect(mocks.insertWorkspaceIntegrationIfAbsent).not.toHaveBeenCalled();
  });

  it("pre-creates workspace_service_account scoped rows with the service account name", async () => {
    const response = await POST(
      jsonRequest(WORKSPACE_ID, {
        allowedIntegrations: ["github"],
        scope: { kind: "workspace_service_account", name: "release-bot" },
      }),
      context(WORKSPACE_ID),
    );

    expect(response.status).toBe(200);
    expect(mocks.insertWorkspaceIntegrationIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        provider: "github",
        name: "release-bot",
        connectionId: NANGO_CONNECTION_ID,
        providerConfigKey: "github-relay",
      }),
    );
    expect(mocks.insertUserIntegrationIfAbsent).not.toHaveBeenCalled();
  });

  it("keeps githubInstallationFlow opt-in on the legacy github session when the flag is off", async () => {
    mocks.selectIntegrationBackend.mockReturnValue({
      backend: "nango",
      backendIntegrationId: "github-relay",
    });

    const response = await POST(
      jsonRequest(WORKSPACE_ID, {
        allowedIntegrations: ["github"],
        githubInstallationFlow: true,
      }),
      context(WORKSPACE_ID),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      backendIntegrationId: "github-relay",
      githubInstallationFlow: { enabled: false },
    });
    expect(mocks.selectIntegrationBackend).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "github" }),
    );
    expect(mocks.insertWorkspaceIntegrationIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "github",
        providerConfigKey: "github-relay",
      }),
    );
    expect(mocks.insertUserIntegrationIfAbsent).not.toHaveBeenCalled();
  });

  it("returns a github user-OAuth session and reconcile metadata for the flag-on installation flow", async () => {
    mocks.isGithubInstallationCentricEnabled.mockReturnValue(true);

    const response = await POST(
      jsonRequest(WORKSPACE_ID, {
        allowedIntegrations: ["github"],
        githubInstallationFlow: true,
      }),
      context(WORKSPACE_ID),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      backendIntegrationId: "github-oauth-relay",
      githubInstallationFlow: {
        enabled: true,
        oauthProviderConfigKey: "github-oauth-relay",
        installProviderConfigKey: "github-relay",
      },
      providers: [
        expect.objectContaining({
          id: "github-oauth",
          providerConfigKey: "github-oauth-relay",
        }),
      ],
    });
    expect(mocks.selectIntegrationBackend).not.toHaveBeenCalled();
    expect(mocks.insertUserIntegrationIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "github-oauth",
        providerConfigKey: "github-oauth-relay",
      }),
    );
    expect(mocks.insertWorkspaceIntegrationIfAbsent).not.toHaveBeenCalled();
  });
});
