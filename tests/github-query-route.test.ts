import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_TOKEN = "specialist-cloud-token";
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

const { fetchGithubViaNangoMock, getWorkspaceIntegrationMock } = vi.hoisted(() => ({
  fetchGithubViaNangoMock: vi.fn(),
  getWorkspaceIntegrationMock: vi.fn(),
}));

vi.mock("sst", () => ({
  Resource: {
    SpecialistCloudApiToken: { value: TEST_TOKEN },
  },
}));

vi.mock("@/lib/integrations/github-nango-proxy-client", () => ({
  fetchGithubViaNango: fetchGithubViaNangoMock,
}));

vi.mock("@/lib/integrations/workspace-integrations", () => ({
  getWorkspaceIntegration: getWorkspaceIntegrationMock,
}));

type GithubQueryRouteModule = {
  POST: (request: Request) => Promise<Response>;
};

async function loadRouteModule(): Promise<GithubQueryRouteModule> {
  return import(
    new URL("../packages/web/app/api/v1/github/query/route.ts", import.meta.url).href
  ) as Promise<GithubQueryRouteModule>;
}

function buildRequest(
  body: Record<string, unknown>,
  token: string | null = TEST_TOKEN,
): Request {
  const headers = new Headers({
    "Content-Type": "application/json",
  });
  if (token !== null) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return new Request("http://localhost/api/v1/github/query", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
  fetchGithubViaNangoMock.mockReset();
  getWorkspaceIntegrationMock.mockReset();
  getWorkspaceIntegrationMock.mockResolvedValue({
    workspaceId: WORKSPACE_ID,
    provider: "github",
    connectionId: "conn_github_123",
    providerConfigKey: "github-prod",
    installationId: null,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.resetModules();
});

describe("POST /api/v1/github/query", () => {
  it("proxies a valid operation through the workspace Nango connection", async () => {
    fetchGithubViaNangoMock.mockResolvedValue(
      new Response(JSON.stringify([{ number: 340 }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const { POST } = await loadRouteModule();

    const response = await POST(
      buildRequest({
        workspaceId: WORKSPACE_ID,
        operation: "listPulls",
        params: { owner: "AgentWorkforce", repo: "cloud", state: "open", per_page: 25 },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ number: 340 }]);
    expect(getWorkspaceIntegrationMock).toHaveBeenCalledWith(WORKSPACE_ID, "github");
    expect(fetchGithubViaNangoMock).toHaveBeenCalledWith({
      connectionId: "conn_github_123",
      providerConfigKey: "github-prod",
      method: "GET",
      path: "/repos/AgentWorkforce/cloud/pulls",
      query: { state: "open", per_page: 25 },
      accept: "application/vnd.github+json",
    });
  });

  it("returns 401 when the bearer token is missing", async () => {
    const { POST } = await loadRouteModule();
    const response = await POST(
      buildRequest({
        workspaceId: WORKSPACE_ID,
        operation: "getPull",
        params: { owner: "o", repo: "r", number: 1 },
      }, null),
    );

    expect(response.status).toBe(401);
    expect(await readJson(response)).toEqual({ ok: false, error: "Unauthorized" });
    expect(fetchGithubViaNangoMock).not.toHaveBeenCalled();
  });

  it("returns 403 when the bearer token is invalid", async () => {
    const { POST } = await loadRouteModule();
    const response = await POST(
      buildRequest({
        workspaceId: WORKSPACE_ID,
        operation: "getPull",
        params: { owner: "o", repo: "r", number: 1 },
      }, "wrong-token"),
    );

    expect(response.status).toBe(403);
    expect(await readJson(response)).toEqual({ ok: false, error: "Forbidden" });
    expect(fetchGithubViaNangoMock).not.toHaveBeenCalled();
  });

  it("returns 400 for an unknown operation", async () => {
    const { POST } = await loadRouteModule();
    const response = await POST(
      buildRequest({
        workspaceId: WORKSPACE_ID,
        operation: "deleteRepo",
        params: {},
      }),
    );

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ ok: false, error: "Invalid request body." });
    expect(fetchGithubViaNangoMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the workspace has no GitHub integration", async () => {
    getWorkspaceIntegrationMock.mockResolvedValue(null);
    const { POST } = await loadRouteModule();
    const response = await POST(
      buildRequest({
        workspaceId: WORKSPACE_ID,
        operation: "getPullDiff",
        params: { owner: "o", repo: "r", number: 7 },
      }),
    );

    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({
      ok: false,
      error: "GitHub workspace integration was not found.",
    });
    expect(fetchGithubViaNangoMock).not.toHaveBeenCalled();
  });
});
