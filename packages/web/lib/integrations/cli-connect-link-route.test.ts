import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  createConnectSession: vi.fn(),
  getProviderConfigKey: vi.fn(),
  insertWorkspaceIntegrationIfAbsent: vi.fn(),
  buildPendingProviderMetadata: vi.fn(),
  resolveWorkspaceIntegrationIdentity: vi.fn(),
  hasWorkspaceIntegrationAccess: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: mocks.resolveRequestAuth,
}));

vi.mock("@cloud/core/provider-readiness.js", async () => {
  const actual = await vi.importActual<
    typeof import("@cloud/core/provider-readiness.js")
  >("@cloud/core/provider-readiness.js");
  return {
    ...actual,
    buildPendingProviderMetadata: mocks.buildPendingProviderMetadata,
  };
});

vi.mock("@/lib/integrations/nango-service", async () => {
  const actual = await vi.importActual<typeof import("./nango-service")>(
    "@/lib/integrations/nango-service",
  );
  return {
    ...actual,
    createConnectSession: mocks.createConnectSession,
    getProviderConfigKey: mocks.getProviderConfigKey,
  };
});

vi.mock("@/lib/integrations/workspace-integrations", async () => {
  const actual = await vi.importActual<
    typeof import("./workspace-integrations")
  >("@/lib/integrations/workspace-integrations");
  return {
    ...actual,
    insertWorkspaceIntegrationIfAbsent:
      mocks.insertWorkspaceIntegrationIfAbsent,
  };
});

vi.mock("@/lib/workspaces/workspace-integration-identity", () => ({
  resolveWorkspaceIntegrationIdentity:
    mocks.resolveWorkspaceIntegrationIdentity,
  hasWorkspaceIntegrationAccess: mocks.hasWorkspaceIntegrationAccess,
}));

import { POST } from "./cli-connect-link-route";

const NANGO_CONNECTION_ID = "48d75838-5c1b-4885-b0c1-3620a80e12f6";

function jsonRequest(body: unknown): NextRequest {
  return new NextRequest(
    "https://agentrelay.test/api/v1/integrations/connect-link",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
      },
    },
  );
}

describe("POST /api/v1/integrations/connect-link", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveRequestAuth.mockResolvedValue({
      userId: "user_123",
      workspaceId: "workspace_123",
      organizationId: "org_123",
      source: "session",
      context: {
        user: { id: "user_123", email: "dev@example.test" },
        currentWorkspace: { id: "workspace_123" },
        currentOrganization: { id: "org_123" },
        workspaces: [{ id: "workspace_123" }],
      },
    });
    mocks.getProviderConfigKey.mockReturnValue("github-relay");
    mocks.createConnectSession.mockResolvedValue({
      token: "connect-token",
      expiresAt: "2026-05-08T12:00:00.000Z",
      connectLink: "https://connect.nango.dev/session/connect-token",
      connectionId: NANGO_CONNECTION_ID,
    });
    mocks.buildPendingProviderMetadata.mockReturnValue({
      readiness: { status: "pending" },
    });
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
  });

  it("returns backend-neutral link fields while preserving legacy aliases", async () => {
    const response = await POST(
      jsonRequest({
        workspaceId: "workspace_123",
        provider: "github",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      provider: "github",
      backend: "nango",
      backendIntegrationId: "github-relay",
      providerConfigKey: "github-relay",
      workspaceId: "workspace_123",
      relayWorkspaceId: "workspace_123",
      token: "connect-token",
      sessionToken: "connect-token",
      expiresAt: "2026-05-08T12:00:00.000Z",
      connectionId: NANGO_CONNECTION_ID,
      connectUrl: "https://connect.nango.dev/session/connect-token",
      connectLink: "https://connect.nango.dev/session/connect-token",
      url: "https://connect.nango.dev/session/connect-token",
      providers: [
        {
          id: "github",
          displayName: "GitHub",
          backend: "nango",
          backendIntegrationId: "github-relay",
          providerConfigKey: "github-relay",
          backendMetadata: {},
          vfsRoot: "/github",
        },
      ],
    });
    expect(mocks.createConnectSession).toHaveBeenCalledWith({
      endUserId: "workspace_123",
      endUserEmail: "dev@example.test",
      allowedIntegrations: ["github-relay"],
    });
    expect(mocks.insertWorkspaceIntegrationIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace_123",
        provider: "github",
        connectionId: NANGO_CONNECTION_ID,
        providerConfigKey: "github-relay",
      }),
    );
  });

  it("uses the bound Relayfile workspace for Nango identity and eager row when addressed by app UUID", async () => {
    mocks.resolveWorkspaceIntegrationIdentity.mockResolvedValue({
      requestedWorkspaceId: "6090d557-246a-4b1f-a368-5d8a9e4f2092",
      appWorkspaceId: "6090d557-246a-4b1f-a368-5d8a9e4f2092",
      relayWorkspaceId: "rw_7ca2b192",
      organizationId: "org_123",
      candidateWorkspaceIds: [
        "6090d557-246a-4b1f-a368-5d8a9e4f2092",
        "rw_7ca2b192",
      ],
    });

    const response = await POST(
      jsonRequest({
        workspaceId: "6090d557-246a-4b1f-a368-5d8a9e4f2092",
        provider: "github",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      workspaceId: "6090d557-246a-4b1f-a368-5d8a9e4f2092",
      relayWorkspaceId: "rw_7ca2b192",
    });
    expect(mocks.createConnectSession).toHaveBeenCalledWith(
      expect.objectContaining({
        endUserId: "rw_7ca2b192",
        allowedIntegrations: ["github-relay"],
      }),
    );
    expect(mocks.insertWorkspaceIntegrationIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "rw_7ca2b192",
        provider: "github",
        connectionId: NANGO_CONNECTION_ID,
      }),
    );
  });

  it("does not pre-create or return a workspaceId connection placeholder when Nango omits connectionId", async () => {
    mocks.createConnectSession.mockResolvedValue({
      token: "connect-token",
      expiresAt: "2026-05-08T12:00:00.000Z",
      connectLink: "https://connect.nango.dev/session/connect-token",
    });

    const response = await POST(
      jsonRequest({
        workspaceId: "workspace_123",
        provider: "github",
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).not.toHaveProperty("connectionId");
    expect(mocks.insertWorkspaceIntegrationIfAbsent).not.toHaveBeenCalled();
    expect(mocks.buildPendingProviderMetadata).not.toHaveBeenCalled();
  });
});
