import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_TOKEN = "cloud-api-token";
const WORKSPACE_A = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_B = "22222222-2222-4222-8222-222222222222";

const { listSlackWorkspaceSummariesMock } = vi.hoisted(() => ({
  listSlackWorkspaceSummariesMock: vi.fn(),
}));

vi.mock("sst", () => ({
  Resource: {
    SageCloudApiToken: { value: TEST_TOKEN },
  },
}));

vi.mock("@/lib/integrations/workspace-integrations", () => ({
  listSlackWorkspaceSummaries: listSlackWorkspaceSummariesMock,
}));

vi.mock("@/lib/auth/request-auth", () => ({
  requireAuthScope: vi.fn(() => false),
  requireSessionAuth: vi.fn(() => false),
  resolveRequestAuth: vi.fn(async () => null),
}));

vi.mock("@/lib/relay-workspaces", () => ({
  normalizeWorkspacePermissions: vi.fn((value: unknown) => value),
}));

vi.mock("@/lib/workspace-registry", () => ({
  createCloudWorkspaceRegistry: vi.fn(),
  formatWorkspaceResponse: vi.fn(),
}));

type WorkspacesRouteModule = {
  GET: (request: Request) => Promise<Response>;
};

async function loadRouteModule(): Promise<WorkspacesRouteModule> {
  return import(
    new URL(
      "../packages/web/app/api/v1/workspaces/route.ts",
      import.meta.url,
    ).href
  ) as Promise<WorkspacesRouteModule>;
}

function buildRequest(
  url: string,
  token: string | null = TEST_TOKEN,
): Request {
  const headers = new Headers();
  if (token !== null) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return new Request(url, { method: "GET", headers });
}

async function readBody(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
  listSlackWorkspaceSummariesMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.resetModules();
});

describe("GET /api/v1/workspaces?integration=slack", () => {
  it("returns 401 when the bearer token is missing", async () => {
    const { GET } = await loadRouteModule();
    const response = await GET(
      buildRequest(
        "http://localhost/api/v1/workspaces?integration=slack",
        null,
      ),
    );
    expect(response.status).toBe(401);
    await expect(readBody(response)).resolves.toEqual({
      error: "Unauthorized",
    });
    expect(listSlackWorkspaceSummariesMock).not.toHaveBeenCalled();
  });

  it("returns 403 when the bearer token is wrong", async () => {
    const { GET } = await loadRouteModule();
    const response = await GET(
      buildRequest(
        "http://localhost/api/v1/workspaces?integration=slack",
        "wrong-token",
      ),
    );
    expect(response.status).toBe(403);
    await expect(readBody(response)).resolves.toEqual({
      error: "Forbidden",
    });
    expect(listSlackWorkspaceSummariesMock).not.toHaveBeenCalled();
  });

  it("returns 400 when the integration query parameter is missing", async () => {
    const { GET } = await loadRouteModule();
    const response = await GET(
      buildRequest("http://localhost/api/v1/workspaces"),
    );
    expect(response.status).toBe(400);
    await expect(readBody(response)).resolves.toEqual({
      error: "integration query parameter is required",
    });
    expect(listSlackWorkspaceSummariesMock).not.toHaveBeenCalled();
  });

  it("returns 400 for unsupported integrations", async () => {
    const { GET } = await loadRouteModule();
    const response = await GET(
      buildRequest(
        "http://localhost/api/v1/workspaces?integration=github",
      ),
    );
    expect(response.status).toBe(400);
    await expect(readBody(response)).resolves.toEqual({
      error: "Unsupported integration: github",
    });
    expect(listSlackWorkspaceSummariesMock).not.toHaveBeenCalled();
  });

  it("returns the workspaces array on success", async () => {
    listSlackWorkspaceSummariesMock.mockResolvedValue([
      { workspaceId: WORKSPACE_A, slackTeamId: "T12345ABC" },
      { workspaceId: WORKSPACE_B, slackTeamId: null },
    ]);
    const { GET } = await loadRouteModule();
    const response = await GET(
      buildRequest(
        "http://localhost/api/v1/workspaces?integration=slack",
      ),
    );
    expect(response.status).toBe(200);
    await expect(readBody(response)).resolves.toEqual({
      workspaces: [
        { workspaceId: WORKSPACE_A, slackTeamId: "T12345ABC" },
        { workspaceId: WORKSPACE_B, slackTeamId: null },
      ],
    });
    expect(listSlackWorkspaceSummariesMock).toHaveBeenCalledTimes(1);
  });

  it("returns an empty array when no workspaces have Slack connected", async () => {
    listSlackWorkspaceSummariesMock.mockResolvedValue([]);
    const { GET } = await loadRouteModule();
    const response = await GET(
      buildRequest(
        "http://localhost/api/v1/workspaces?integration=slack",
      ),
    );
    expect(response.status).toBe(200);
    await expect(readBody(response)).resolves.toEqual({ workspaces: [] });
  });

  it("returns 500 when the DB layer throws", async () => {
    listSlackWorkspaceSummariesMock.mockRejectedValue(new Error("db down"));
    const { GET } = await loadRouteModule();
    const response = await GET(
      buildRequest(
        "http://localhost/api/v1/workspaces?integration=slack",
      ),
    );
    expect(response.status).toBe(500);
    await expect(readBody(response)).resolves.toEqual({
      error: "Failed to list workspaces",
    });
  });
});
