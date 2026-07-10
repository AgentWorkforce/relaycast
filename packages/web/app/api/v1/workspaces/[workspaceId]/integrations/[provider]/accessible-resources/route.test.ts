import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  hasWorkspaceReadAccess: vi.fn(),
  getWorkspaceIntegration: vi.fn(),
  getNangoSecretKey: vi.fn(),
  getNangoClient: vi.fn(),
  proxy: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: mocks.resolveRequestAuth,
}));

vi.mock("@/lib/integrations/integration-route-handler", () => ({
  hasWorkspaceReadAccess: mocks.hasWorkspaceReadAccess,
  hasWorkspaceAccess: vi.fn(),
}));

vi.mock("@/lib/integrations/workspace-integrations", () => ({
  getWorkspaceIntegration: mocks.getWorkspaceIntegration,
}));

vi.mock("@/lib/integrations/nango-service", () => ({
  getNangoClient: mocks.getNangoClient,
  getNangoSecretKey: mocks.getNangoSecretKey,
}));

import { GET } from "./route";

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

function request(): NextRequest {
  return new NextRequest(
    new URL(
      "https://agentrelay.test/api/v1/workspaces/ws_123/integrations/jira/accessible-resources",
    ),
  );
}

function context(provider = "jira") {
  return {
    params: Promise.resolve({ workspaceId: "ws_123", provider }),
  };
}

function integrationRow(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "ws_123",
    provider: "jira",
    connectionId: "conn_jira",
    providerConfigKey: "jira-relay",
    installationId: null,
    metadata: {},
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    updatedAt: new Date("2026-05-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("GET /api/v1/workspaces/:workspaceId/integrations/:provider/accessible-resources", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveRequestAuth.mockResolvedValue(auth);
    mocks.hasWorkspaceReadAccess.mockReturnValue(true);
    mocks.getNangoSecretKey.mockReturnValue("test-secret");
    mocks.getNangoClient.mockReturnValue({ proxy: mocks.proxy });
  });

  it("normalizes Atlassian accessible-resources via the Nango proxy", async () => {
    mocks.getWorkspaceIntegration.mockResolvedValue(integrationRow());
    mocks.proxy.mockResolvedValue({
      data: [
        {
          id: "cloud-1",
          url: "https://foo.atlassian.net",
          name: "Foo",
          scopes: ["read:jira-work"],
          avatarUrl: "https://avatars.example/foo.png",
        },
        {
          id: "cloud-2",
          url: "https://bar.atlassian.net",
        },
        // junk entries should be filtered out
        { id: "cloud-3" },
        { url: "https://baz.atlassian.net" },
        null,
        "not-an-object",
      ],
    });

    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      resources: [
        {
          id: "cloud-1",
          url: "https://foo.atlassian.net",
          name: "Foo",
          scopes: ["read:jira-work"],
          avatarUrl: "https://avatars.example/foo.png",
        },
        { id: "cloud-2", url: "https://bar.atlassian.net" },
      ],
    });
    expect(mocks.proxy).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        endpoint: "/oauth/token/accessible-resources",
        connectionId: "conn_jira",
        providerConfigKey: "jira-relay",
        baseUrlOverride: "https://api.atlassian.com",
      }),
    );
  });

  it("returns 404 when no integration row exists for this workspace", async () => {
    mocks.getWorkspaceIntegration.mockResolvedValue(null);

    const response = await GET(request(), context());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "integration_not_found",
    });
    expect(mocks.proxy).not.toHaveBeenCalled();
  });

  it("returns 400 for providers that have no accessible-resources concept", async () => {
    const response = await GET(request(), context("linear"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "provider_has_no_accessible_resources",
    });
    expect(mocks.getWorkspaceIntegration).not.toHaveBeenCalled();
    expect(mocks.proxy).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown provider id", async () => {
    const response = await GET(request(), context("not-a-real-provider"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "unknown_provider",
    });
  });

  it("returns 501 when the Nango backend is not configured", async () => {
    mocks.getNangoSecretKey.mockReturnValue(null);

    const response = await GET(request(), context());

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "backend_not_configured",
    });
  });

  it("returns 401 when the request is unauthenticated", async () => {
    mocks.resolveRequestAuth.mockResolvedValue(null);

    const response = await GET(request(), context());

    expect(response.status).toBe(401);
  });

  it("returns 403 when the caller lacks workspace read access", async () => {
    mocks.hasWorkspaceReadAccess.mockReturnValue(false);

    const response = await GET(request(), context());

    expect(response.status).toBe(403);
  });

  it("surfaces upstream errors from Nango as a 502 with a code", async () => {
    mocks.getWorkspaceIntegration.mockResolvedValue(integrationRow());
    mocks.proxy.mockRejectedValue(new Error("nango proxy 500"));

    const response = await GET(request(), context());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "upstream_error",
    });
  });

  it("returns an empty list when Atlassian responds with no sites", async () => {
    mocks.getWorkspaceIntegration.mockResolvedValue(integrationRow());
    mocks.proxy.mockResolvedValue({ data: [] });

    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      resources: [],
    });
  });

  it("normalizes GitLab projects via the Nango proxy", async () => {
    mocks.getWorkspaceIntegration.mockResolvedValue(integrationRow({
      provider: "gitlab",
      providerConfigKey: "gitlab-relay",
      connectionId: "conn_gitlab",
    }));
    mocks.proxy.mockResolvedValue({
      data: [
        {
          id: 20,
          name: "api",
          name_with_namespace: "Acme / API",
          path_with_namespace: "acme/api",
          web_url: "https://gitlab.com/acme/api",
          avatar_url: "https://gitlab.example/avatar.png",
        },
      ],
    });

    const response = await GET(request(), context("gitlab"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      resources: [
        {
          id: "20",
          name: "Acme / API",
          path: "acme/api",
          url: "https://gitlab.com/acme/api",
          avatarUrl: "https://gitlab.example/avatar.png",
        },
      ],
    });
    expect(mocks.proxy).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        endpoint: "/api/v4/projects",
        connectionId: "conn_gitlab",
        providerConfigKey: "gitlab-relay",
        params: expect.objectContaining({
          membership: "true",
          simple: "true",
          per_page: 100,
          page: 1,
        }),
      }),
    );
  });

  it("normalizes Reddit subreddit listings via the Nango proxy", async () => {
    mocks.getWorkspaceIntegration.mockResolvedValue(integrationRow({
      provider: "reddit",
      providerConfigKey: "reddit-composio-relay",
      connectionId: "conn_reddit",
    }));
    mocks.proxy.mockResolvedValue({
      data: {
        data: {
          children: [
            {
              data: {
                display_name: "typescript",
                title: "TypeScript",
                icon_img: "https://styles.redditmedia.com/t5_2qjib/styles/communityIcon/example.png",
              },
            },
            {
              data: {
                name: "programming",
                title: "Programming",
              },
            },
          ],
        },
      },
    });

    const response = await GET(request(), context("reddit"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      resources: [
        {
          id: "typescript",
          url: "https://www.reddit.com/r/typescript",
          name: "TypeScript",
          path: "r/typescript",
          avatarUrl: "https://styles.redditmedia.com/t5_2qjib/styles/communityIcon/example.png",
        },
        {
          id: "programming",
          url: "https://www.reddit.com/r/programming",
          name: "Programming",
          path: "r/programming",
        },
      ],
    });
    expect(mocks.proxy).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        endpoint: "/subreddits/popular.json",
        connectionId: "conn_reddit",
        providerConfigKey: "reddit-composio-relay",
        baseUrlOverride: "https://www.reddit.com",
      }),
    );
  });

  it("paginates GitLab projects through the Nango proxy", async () => {
    mocks.getWorkspaceIntegration.mockResolvedValue(integrationRow({
      provider: "gitlab",
      providerConfigKey: "gitlab-relay",
      connectionId: "conn_gitlab",
    }));
    mocks.proxy
      .mockResolvedValueOnce({
        data: Array.from({ length: 100 }, (_, index) => ({
          id: index + 1,
          name: `project-${index + 1}`,
          path_with_namespace: `acme/project-${index + 1}`,
          web_url: `https://gitlab.com/acme/project-${index + 1}`,
        })),
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: 101,
            name: "project-101",
            path_with_namespace: "acme/project-101",
            web_url: "https://gitlab.com/acme/project-101",
          },
        ],
      });

    const response = await GET(request(), context("gitlab"));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.resources).toHaveLength(101);
    expect(mocks.proxy).toHaveBeenNthCalledWith(1, expect.objectContaining({
      params: expect.objectContaining({ page: 1, per_page: 100 }),
    }));
    expect(mocks.proxy).toHaveBeenNthCalledWith(2, expect.objectContaining({
      params: expect.objectContaining({ page: 2, per_page: 100 }),
    }));
  });
});
