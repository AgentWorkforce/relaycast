import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  hasWorkspaceAccess: vi.fn(),
  getWorkspaceIntegration: vi.fn(),
  getNangoSecretKey: vi.fn(),
  getNangoClient: vi.fn(),
  getConnection: vi.fn(),
  setMetadata: vi.fn(),
  triggerAction: vi.fn(),
  triggerNangoSyncs: vi.fn(),
  upsertWorkspaceIntegration: vi.fn(),
}));

vi.mock("@/lib/app-origin", () => ({
  getConfiguredAppOrigin: () => "https://agentrelay.test",
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: mocks.resolveRequestAuth,
}));

vi.mock("@/lib/integrations/integration-route-handler", () => ({
  CLOUD_INTEGRATIONS_WRITE_SCOPE: "cloud:integrations:write",
  hasCloudControlScope: vi.fn(() => true),
  hasWorkspaceAccess: mocks.hasWorkspaceAccess,
  hasWorkspaceReadAccess: vi.fn(),
}));

vi.mock("@/lib/integrations/workspace-integrations", () => ({
  getWorkspaceIntegration: mocks.getWorkspaceIntegration,
  upsertWorkspaceIntegration: mocks.upsertWorkspaceIntegration,
}));

vi.mock("@/lib/integrations/nango-service", () => ({
  getNangoClient: mocks.getNangoClient,
  getNangoSecretKey: mocks.getNangoSecretKey,
  triggerNangoSyncs: mocks.triggerNangoSyncs,
}));

import { GET, PUT } from "./route";

const auth = {
  userId: "user_123",
  workspaceId: "ws_123",
  organizationId: "org_123",
  source: "session",
  context: {
    user: { id: "user_123", email: "dev@example.test" },
    currentWorkspace: { id: "ws_123" },
    currentOrganization: { id: "org_123" },
    workspaces: [{ id: "ws_123" }],
  },
};

function request(body: unknown): NextRequest {
  return new NextRequest(
    new URL(
      "https://agentrelay.test/api/v1/workspaces/ws_123/integrations/jira/metadata",
    ),
    {
      method: "PUT",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    },
  );
}

function context(provider = "jira") {
  return {
    params: Promise.resolve({ workspaceId: "ws_123", provider }),
  };
}

function integrationRow() {
  return {
    workspaceId: "ws_123",
    provider: "jira",
    connectionId: "conn_jira",
    providerConfigKey: "jira-relay",
    installationId: null,
    metadata: {},
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    updatedAt: new Date("2026-05-01T00:00:00.000Z"),
  };
}

describe("PUT /api/v1/workspaces/:workspaceId/integrations/:provider/metadata", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveRequestAuth.mockResolvedValue(auth);
    mocks.hasWorkspaceAccess.mockReturnValue(true);
    mocks.getNangoSecretKey.mockReturnValue("test-secret");
    mocks.getNangoClient.mockReturnValue({
      getConnection: mocks.getConnection,
      setMetadata: mocks.setMetadata,
      triggerAction: mocks.triggerAction,
    });
    mocks.getConnection.mockResolvedValue({ metadata: { cloudId: "cloud-1" } });
    mocks.setMetadata.mockResolvedValue({ data: { ok: true } });
    mocks.triggerNangoSyncs.mockResolvedValue({ ok: true });
    mocks.triggerAction.mockResolvedValue({
      ok: true,
      webhookSubscriptions: [
        {
          project_id: "20",
          hook_id: "123",
          secret: "existing-secret",
          url: "https://agentrelay.test/api/v1/webhooks/hookdeck",
        },
      ],
    });
    mocks.upsertWorkspaceIntegration.mockResolvedValue(integrationRow());
  });

  it("forwards the metadata payload to nango.setMetadata and echoes the value", async () => {
    mocks.getWorkspaceIntegration.mockResolvedValue(integrationRow());
    const metadata = {
      cloudId: "cloud-1",
      baseUrl: "https://foo.atlassian.net",
      nested: { region: "us-east-1", tags: ["primary", "ops"] },
    };

    const response = await PUT(request({ metadata }), context());

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ ok: true, metadata });
    expect(mocks.setMetadata).toHaveBeenCalledWith(
      "jira-relay",
      "conn_jira",
      metadata,
    );
    expect(mocks.triggerAction).not.toHaveBeenCalled();
  });

  it("normalizes Reddit subreddit metadata and triggers Reddit syncs", async () => {
    mocks.getWorkspaceIntegration.mockResolvedValue({
      ...integrationRow(),
      provider: "reddit",
      providerConfigKey: "reddit-composio-relay",
      connectionId: "conn_reddit",
    });
    mocks.getConnection.mockResolvedValue({
      metadata: { subreddits: ["typescript"] },
    });
    const metadata = {
      subreddits: ["r/typescript", "Programming", "programming"],
    };

    const response = await PUT(request({ metadata }), context("reddit"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      metadata: {
        subreddits: ["typescript", "programming"],
      },
    });
    expect(mocks.setMetadata).toHaveBeenCalledWith(
      "reddit-composio-relay",
      "conn_reddit",
      expect.objectContaining({
        subreddits: ["typescript", "programming"],
      }),
    );
    expect(mocks.triggerNangoSyncs).toHaveBeenCalledWith({
      providerConfigKey: "reddit-composio-relay",
      connectionId: "conn_reddit",
      syncs: [
        "fetch-subreddits",
        "fetch-posts",
        "fetch-hot-posts",
        "fetch-rising-posts",
        "fetch-top-posts",
        "fetch-best-posts",
      ],
      syncMode: "incremental",
    });
    expect(mocks.triggerAction).not.toHaveBeenCalled();
  });

  it("applies Reddit default subreddits when metadata.subreddits is empty", async () => {
    mocks.getWorkspaceIntegration.mockResolvedValue({
      ...integrationRow(),
      provider: "reddit",
      providerConfigKey: "reddit-composio-relay",
      connectionId: "conn_reddit",
    });
    mocks.getConnection.mockResolvedValue({
      metadata: {},
    });

    const response = await PUT(request({ metadata: { subreddits: [] } }), context("reddit"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      metadata: {
        subreddits: ["tech", "claudecode", "ai_agents"],
      },
    });
    expect(mocks.setMetadata).toHaveBeenCalledWith(
      "reddit-composio-relay",
      "conn_reddit",
      expect.objectContaining({
        subreddits: ["tech", "claudecode", "ai_agents"],
      }),
    );
    expect(mocks.triggerNangoSyncs).toHaveBeenCalledWith({
      providerConfigKey: "reddit-composio-relay",
      connectionId: "conn_reddit",
      syncs: [
        "fetch-subreddits",
        "fetch-posts",
        "fetch-hot-posts",
        "fetch-rising-posts",
        "fetch-top-posts",
        "fetch-best-posts",
      ],
      syncMode: "incremental",
    });
  });

  it("persists Daytona organization metadata and initializes webhooks", async () => {
    mocks.getWorkspaceIntegration.mockResolvedValue({
      ...integrationRow(),
      provider: "daytona",
      providerConfigKey: "daytona-relay",
      connectionId: "conn_daytona",
    });
    mocks.getConnection.mockResolvedValue({
      metadata: {
        organizationId: "org_daytona",
      },
    });
    mocks.triggerAction.mockResolvedValue({
      webhookInitializationStatus: {
        organizationId: "org_daytona",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
      },
    });

    const response = await PUT(
      request({ metadata: { organizationId: "org_daytona" } }),
      context("daytona"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      metadata: {
        organizationId: "org_daytona",
      },
    });
    expect(mocks.setMetadata).toHaveBeenCalledWith(
      "daytona-relay",
      "conn_daytona",
      {
        organizationId: "org_daytona",
      },
    );
    expect(mocks.triggerAction).toHaveBeenCalledWith(
      "daytona-relay",
      "conn_daytona",
      "setup-webhooks",
    );
    expect(mocks.upsertWorkspaceIntegration).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_123",
        provider: "daytona",
        connectionId: "conn_daytona",
        providerConfigKey: "daytona-relay",
        metadata: {
          organizationId: "org_daytona",
        },
      }),
    );
  });

  it("stores the shared Hookdeck URL for Cloudflare and provisions webhook setup with it", async () => {
    mocks.getWorkspaceIntegration.mockResolvedValue({
      ...integrationRow(),
      provider: "cloudflare",
      providerConfigKey: "cloudflare-relay",
      connectionId: "conn_cloudflare",
    });
    mocks.getConnection.mockResolvedValue({
      metadata: {
        accountId: "cf-account-1",
      },
    });
    mocks.triggerAction.mockResolvedValue({
      accountId: "cf-account-1",
      webhookId: "cf-webhook-1",
      configuredPolicies: [],
      warnings: [],
    });

    const response = await PUT(
      request({ metadata: { webhookUrl: "https://hkdk.events/test-cloudflare-source" } }),
      context("cloudflare"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      metadata: {
        accountId: "cf-account-1",
        webhookUrl: "https://hkdk.events/test-cloudflare-source",
      },
    });
    expect(mocks.setMetadata).toHaveBeenCalledWith(
      "cloudflare-relay",
      "conn_cloudflare",
      {
        accountId: "cf-account-1",
        webhookUrl: "https://hkdk.events/test-cloudflare-source",
      },
    );
    expect(mocks.triggerAction).toHaveBeenCalledWith(
      "cloudflare-relay",
      "conn_cloudflare",
      "setup-webhooks",
      {
        webhookUrl: "https://hkdk.events/test-cloudflare-source",
      },
    );
    expect(mocks.upsertWorkspaceIntegration).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_123",
        provider: "cloudflare",
        connectionId: "conn_cloudflare",
        providerConfigKey: "cloudflare-relay",
        metadata: {
          accountId: "cf-account-1",
          webhookUrl: "https://hkdk.events/test-cloudflare-source",
        },
      }),
    );
  });

  it("rejects Cloudflare metadata updates when the external Hookdeck source URL is missing", async () => {
    mocks.getWorkspaceIntegration.mockResolvedValue({
      ...integrationRow(),
      provider: "cloudflare",
      providerConfigKey: "cloudflare-relay",
      connectionId: "conn_cloudflare",
    });
    mocks.getConnection.mockResolvedValue({
      metadata: {
        accountId: "cf-account-1",
      },
    });

    const response = await PUT(request({ metadata: {} }), context("cloudflare"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "invalid_metadata",
      error:
        "cloudflare metadata.webhookUrl is required and must be the external Hookdeck source URL.",
    });
    expect(mocks.setMetadata).not.toHaveBeenCalled();
    expect(mocks.triggerAction).not.toHaveBeenCalled();
  });

  it("triggers GitLab webhook setup after project metadata is saved", async () => {
    mocks.getWorkspaceIntegration.mockResolvedValue({
      ...integrationRow(),
      provider: "gitlab",
      providerConfigKey: "gitlab-relay",
      connectionId: "conn_gitlab",
    });
    mocks.getConnection.mockResolvedValue({
      metadata: { webhookSecret: "existing-secret" },
    });
    const metadata = { projectIds: ["20"] };
    const expectedMetadata = {
      projectIds: ["20"],
      webhookSecret: "existing-secret",
      webhookUrl: "https://agentrelay.test/api/v1/webhooks/hookdeck",
    };

    const response = await PUT(request({ metadata }), context("gitlab"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      metadata: {
        projectIds: ["20"],
        webhookSecret: "[redacted]",
        webhookUrl: "https://agentrelay.test/api/v1/webhooks/hookdeck",
      },
    });
    expect(mocks.setMetadata).toHaveBeenCalledWith("gitlab-relay", "conn_gitlab", expectedMetadata);
    expect(mocks.triggerAction).toHaveBeenCalledWith(
      "gitlab-relay",
      "conn_gitlab",
      "setup-project-webhooks",
      {
        projectIds: ["20"],
        webhookUrl: "https://agentrelay.test/api/v1/webhooks/hookdeck",
        webhookSecret: "existing-secret",
      },
    );
    expect(mocks.triggerNangoSyncs).toHaveBeenCalledWith({
      providerConfigKey: "gitlab-relay",
      connectionId: "conn_gitlab",
      syncs: [
        "fetch-merge-requests",
        "fetch-issues",
        "fetch-commits",
        "fetch-pipelines",
        "fetch-deployments",
        "fetch-tags",
      ],
      syncMode: "incremental",
    });
    expect(mocks.upsertWorkspaceIntegration).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_123",
        provider: "gitlab",
        connectionId: "conn_gitlab",
        providerConfigKey: "gitlab-relay",
        metadata: expect.objectContaining({
          projectIds: ["20"],
          webhookSecret: "existing-secret",
          webhookUrl: "https://agentrelay.test/api/v1/webhooks/hookdeck",
          webhookSubscriptions: [
            expect.objectContaining({ project_id: "20", hook_id: "123" }),
          ],
        }),
      }),
    );
    expect(mocks.upsertWorkspaceIntegration.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.triggerNangoSyncs.mock.invocationCallOrder[0],
    );
  });

  it("triggers GitLab backfill when only project objects are selected", async () => {
    mocks.getWorkspaceIntegration.mockResolvedValue({
      ...integrationRow(),
      provider: "gitlab",
      providerConfigKey: "gitlab-relay",
      connectionId: "conn_gitlab",
    });
    mocks.getConnection.mockResolvedValue({
      metadata: { webhookSecret: "existing-secret" },
    });
    const metadata = {
      projects: [{ id: 20, path_with_namespace: "acme/api" }],
    };

    const response = await PUT(request({ metadata }), context("gitlab"));

    expect(response.status).toBe(200);
    expect(mocks.setMetadata).toHaveBeenCalledWith(
      "gitlab-relay",
      "conn_gitlab",
      expect.objectContaining({
        projects: [{ id: 20, path_with_namespace: "acme/api" }],
      }),
    );
    expect(mocks.triggerAction).toHaveBeenCalledWith(
      "gitlab-relay",
      "conn_gitlab",
      "setup-project-webhooks",
      expect.objectContaining({
        projectIds: ["20"],
      }),
    );
    expect(mocks.triggerNangoSyncs).toHaveBeenCalledWith(
      expect.objectContaining({
        providerConfigKey: "gitlab-relay",
        connectionId: "conn_gitlab",
        syncMode: "incremental",
      }),
    );
  });

  it("rejects GitLab project IDs that are not scalar IDs", async () => {
    mocks.getWorkspaceIntegration.mockResolvedValue({
      ...integrationRow(),
      provider: "gitlab",
      providerConfigKey: "gitlab-relay",
      connectionId: "conn_gitlab",
    });
    mocks.getConnection.mockResolvedValue({
      metadata: { webhookSecret: "existing-secret" },
    });

    const response = await PUT(
      request({ metadata: { projectIds: [{ id: "20" }] } }),
      context("gitlab"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "invalid_metadata",
      error: "GitLab projectIds must be an array of non-empty string or number IDs.",
    });
    expect(mocks.setMetadata).not.toHaveBeenCalled();
    expect(mocks.triggerAction).not.toHaveBeenCalled();
    expect(mocks.triggerNangoSyncs).not.toHaveBeenCalled();
  });

  it("reads metadata from Nango connection details", async () => {
    mocks.getWorkspaceIntegration.mockResolvedValue(integrationRow());

    const response = await GET(request({}), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      metadata: { cloudId: "cloud-1" },
    });
    expect(mocks.getConnection).toHaveBeenCalledWith("jira-relay", "conn_jira");
  });

  it("returns Reddit default subreddits on GET when no subreddit metadata is set", async () => {
    mocks.getWorkspaceIntegration.mockResolvedValue({
      ...integrationRow(),
      provider: "reddit",
      providerConfigKey: "reddit-composio-relay",
      connectionId: "conn_reddit",
    });
    mocks.getConnection.mockResolvedValue({ metadata: {} });

    const response = await GET(request({}), context("reddit"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      metadata: { subreddits: ["tech", "claudecode", "ai_agents"] },
    });
  });

  it("redacts sensitive metadata keys from nested response payloads", async () => {
    mocks.getWorkspaceIntegration.mockResolvedValue({
      ...integrationRow(),
      provider: "gitlab",
      providerConfigKey: "gitlab-relay",
      connectionId: "conn_gitlab",
    });
    mocks.getConnection.mockResolvedValue({
      metadata: {
        projectIds: ["20"],
        webhookSecret: "secret-value",
        webhookSubscriptions: [
          {
            project_id: "20",
            hook_id: "123",
            secret: "subscription-secret",
            tokenAlias: "also-sensitive",
          },
        ],
      },
    });

    const response = await GET(request({}), context("gitlab"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      metadata: {
        projectIds: ["20"],
        webhookSecret: "[redacted]",
        webhookSubscriptions: [
          {
            project_id: "20",
            hook_id: "123",
            secret: "[redacted]",
            tokenAlias: "[redacted]",
          },
        ],
      },
    });
  });

  it("returns 404 when the integration row does not exist", async () => {
    mocks.getWorkspaceIntegration.mockResolvedValue(null);

    const response = await PUT(
      request({ metadata: { cloudId: "cloud-1" } }),
      context(),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      code: "integration_not_found",
    });
    expect(mocks.setMetadata).not.toHaveBeenCalled();
  });

  it("returns 400 when the body is not valid JSON", async () => {
    const response = await PUT(request("not-json{"), context());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid_body",
    });
  });

  it("returns 400 when metadata is missing or not an object", async () => {
    const r1 = await PUT(request({}), context());
    expect(r1.status).toBe(400);

    const r2 = await PUT(request({ metadata: "string-not-object" }), context());
    expect(r2.status).toBe(400);

    const r3 = await PUT(request({ metadata: ["array"] }), context());
    expect(r3.status).toBe(400);
  });

  it("rejects Nango-reserved top-level keys", async () => {
    mocks.getWorkspaceIntegration.mockResolvedValue(integrationRow());

    const response = await PUT(
      request({ metadata: { _internal: "no", cloudId: "cloud-1" } }),
      context(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid_metadata",
    });
    expect(mocks.setMetadata).not.toHaveBeenCalled();
  });

  it("rejects connection_*/auth_* top-level keys but allows them nested", async () => {
    mocks.getWorkspaceIntegration.mockResolvedValue(integrationRow());

    const banned = await PUT(
      request({ metadata: { connection_id: "no" } }),
      context(),
    );
    expect(banned.status).toBe(400);

    // Nested under a user-controlled key is fine.
    const allowed = await PUT(
      request({ metadata: { custom: { auth_url: "https://anything" } } }),
      context(),
    );
    expect(allowed.status).toBe(200);
  });

  it("returns 404 for an unknown provider", async () => {
    const response = await PUT(
      request({ metadata: { cloudId: "cloud-1" } }),
      context("not-a-real-provider"),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      code: "unknown_provider",
    });
  });

  it("returns 501 when the Nango backend is not configured", async () => {
    mocks.getNangoSecretKey.mockReturnValue(null);

    const response = await PUT(
      request({ metadata: { cloudId: "cloud-1" } }),
      context(),
    );

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toMatchObject({
      code: "backend_not_configured",
    });
  });

  it("returns 401 / 403 on auth failures", async () => {
    mocks.resolveRequestAuth.mockResolvedValue(null);
    const unauth = await PUT(request({ metadata: {} }), context());
    expect(unauth.status).toBe(401);

    mocks.resolveRequestAuth.mockResolvedValue(auth);
    mocks.hasWorkspaceAccess.mockReturnValue(false);
    const forbidden = await PUT(request({ metadata: {} }), context());
    expect(forbidden.status).toBe(403);
  });

  it("surfaces nango.setMetadata errors as 502 with code upstream_error", async () => {
    mocks.getWorkspaceIntegration.mockResolvedValue(integrationRow());
    mocks.setMetadata.mockRejectedValue(new Error("nango bounced"));

    const response = await PUT(
      request({ metadata: { cloudId: "cloud-1" } }),
      context(),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "upstream_error",
    });
  });
});
