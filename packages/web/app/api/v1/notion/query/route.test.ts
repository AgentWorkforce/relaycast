import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readBearerTokenFromRequest: vi.fn(),
  readConfiguredSpecialistCloudApiToken: vi.fn(),
  getWorkspaceIntegration: vi.fn(),
  proxy: vi.fn(),
}));

vi.mock("@/lib/integrations/slack-proxy-auth", () => ({
  readBearerTokenFromRequest: mocks.readBearerTokenFromRequest,
  readConfiguredSpecialistCloudApiToken: mocks.readConfiguredSpecialistCloudApiToken,
}));

vi.mock("@/lib/integrations/workspace-integrations", () => ({
  getWorkspaceIntegration: mocks.getWorkspaceIntegration,
}));

vi.mock("@/lib/integrations/nango-service", () => ({
  getNangoClient: () => ({
    proxy: mocks.proxy,
  }),
}));

import { POST } from "./route";

function createRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/v1/notion/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/v1/notion/query", () => {
  beforeEach(() => {
    mocks.readBearerTokenFromRequest.mockReset();
    mocks.readConfiguredSpecialistCloudApiToken.mockReset();
    mocks.getWorkspaceIntegration.mockReset();
    mocks.proxy.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when the bearer token is missing", async () => {
    mocks.readBearerTokenFromRequest.mockReturnValue(null);
    mocks.readConfiguredSpecialistCloudApiToken.mockReturnValue("expected-token");

    const response = await POST(
      createRequest({
        workspaceId: "ws_test",
        operation: "listPages",
        params: {},
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "Unauthorized",
    });
  });

  it("returns 403 when the bearer token does not match", async () => {
    mocks.readBearerTokenFromRequest.mockReturnValue("bad-token");
    mocks.readConfiguredSpecialistCloudApiToken.mockReturnValue("expected-token");

    const response = await POST(
      createRequest({
        workspaceId: "ws_test",
        operation: "listPages",
        params: {},
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "Forbidden",
    });
  });

  it("returns 200 and proxies searchPages through Nango with the Notion version header", async () => {
    mocks.readBearerTokenFromRequest.mockReturnValue("expected-token");
    mocks.readConfiguredSpecialistCloudApiToken.mockReturnValue("expected-token");
    mocks.getWorkspaceIntegration.mockResolvedValue({
      connectionId: "conn-123",
      providerConfigKey: "notion-prod",
    });
    mocks.proxy.mockResolvedValue({
      status: 200,
      data: JSON.stringify({ results: [{ id: "page-1" }] }),
      headers: { "content-type": "application/json; charset=utf-8" },
    });

    const response = await POST(
      createRequest({
        workspaceId: "ws_test",
        operation: "searchPages",
        params: {
          query: "docs",
          limit: 7,
        },
      }),
    );

    expect(mocks.getWorkspaceIntegration).toHaveBeenCalledWith("ws_test", "notion");
    expect(mocks.proxy).toHaveBeenCalledWith({
      method: "POST",
      endpoint: "/v1/search",
      connectionId: "conn-123",
      providerConfigKey: "notion-prod",
      headers: {
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
      },
      responseType: "text",
      data: {
        query: "docs",
        page_size: 7,
        filter: {
          property: "object",
          value: "page",
        },
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    await expect(response.json()).resolves.toEqual({
      results: [{ id: "page-1" }],
    });
  });

  it("routes database-scoped listPages through the Notion database query endpoint", async () => {
    mocks.readBearerTokenFromRequest.mockReturnValue("expected-token");
    mocks.readConfiguredSpecialistCloudApiToken.mockReturnValue("expected-token");
    mocks.getWorkspaceIntegration.mockResolvedValue({
      connectionId: "conn-123",
      providerConfigKey: "notion-prod",
    });
    mocks.proxy.mockResolvedValue({
      status: 200,
      data: JSON.stringify({ results: [{ id: "page-1" }] }),
      headers: { "content-type": "application/json" },
    });

    const response = await POST(
      createRequest({
        workspaceId: "ws_test",
        operation: "listPages",
        params: {
          database: "db-123",
          limit: 9,
          cursor: "cursor-1",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.proxy).toHaveBeenCalledWith({
      method: "POST",
      endpoint: "/v1/databases/db-123/query",
      connectionId: "conn-123",
      providerConfigKey: "notion-prod",
      headers: {
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
      },
      responseType: "text",
      data: {
        page_size: 9,
        start_cursor: "cursor-1",
      },
    });
    await expect(response.json()).resolves.toEqual({
      results: [{ id: "page-1" }],
    });
  });
});
