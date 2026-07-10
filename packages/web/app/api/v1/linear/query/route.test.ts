import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LINEAR_LIST_ISSUES_QUERY } from "@relayfile/adapter-linear";

vi.mock("@/lib/integrations/nango-service", () => ({
  getNangoHost: vi.fn(),
  getNangoSecretKey: vi.fn(),
}));

vi.mock("@/lib/integrations/slack-proxy-auth", () => ({
  readBearerTokenFromRequest: vi.fn(),
  readConfiguredSpecialistCloudApiToken: vi.fn(),
}));

vi.mock("@/lib/integrations/workspace-integrations", () => ({
  getWorkspaceIntegration: vi.fn(),
}));

import { getNangoHost, getNangoSecretKey } from "@/lib/integrations/nango-service";
import {
  readBearerTokenFromRequest,
  readConfiguredSpecialistCloudApiToken,
} from "@/lib/integrations/slack-proxy-auth";
import { getWorkspaceIntegration } from "@/lib/integrations/workspace-integrations";

import { POST } from "./route";

const readBearerTokenFromRequestMock = vi.mocked(readBearerTokenFromRequest);
const readConfiguredSpecialistCloudApiTokenMock = vi.mocked(readConfiguredSpecialistCloudApiToken);
const getWorkspaceIntegrationMock = vi.mocked(getWorkspaceIntegration);
const getNangoHostMock = vi.mocked(getNangoHost);
const getNangoSecretKeyMock = vi.mocked(getNangoSecretKey);

type FetchArgs = Parameters<typeof globalThis.fetch>;
type FetchReturn = ReturnType<typeof globalThis.fetch>;
type FetchMock = ReturnType<typeof vi.fn>;

function createFetchMock(): FetchMock {
  return vi.fn();
}

function createRequest(body?: unknown): Request {
  return new Request("http://localhost/api/v1/linear/query", {
    method: "POST",
    headers: body === undefined
      ? undefined
      : {
        "content-type": "application/json",
      },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("POST /api/v1/linear/query", () => {
  let fetchMock = createFetchMock();

  beforeEach(() => {
    fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects requests without a bearer token", async () => {
    readBearerTokenFromRequestMock.mockReturnValue(null);
    readConfiguredSpecialistCloudApiTokenMock.mockReturnValue("expected-token");

    const response = await POST(createRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "Unauthorized",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects requests with a bad bearer token", async () => {
    readBearerTokenFromRequestMock.mockReturnValue("wrong-token");
    readConfiguredSpecialistCloudApiTokenMock.mockReturnValue("expected-token");

    const response = await POST(createRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "Forbidden",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 200 for a valid Linear proxy request", async () => {
    readBearerTokenFromRequestMock.mockReturnValue("expected-token");
    readConfiguredSpecialistCloudApiTokenMock.mockReturnValue("expected-token");
    getWorkspaceIntegrationMock.mockResolvedValue({
      id: "wsi-linear-test",
      workspaceId: "workspace-test",
      provider: "linear",
      connectionId: "conn-123",
      providerConfigKey: "linear-nango-config",
      installationId: null,
      metadata: {},
      createdAt: new Date("2026-04-26T10:00:00.000Z"),
      updatedAt: new Date("2026-04-26T10:00:00.000Z"),
    });
    getNangoHostMock.mockReturnValue("https://nango.example.test");
    getNangoSecretKeyMock.mockReturnValue("nango-secret");
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ data: { issues: { nodes: [{ id: "issue-1" }] } } }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      ),
    );

    const response = await POST(
      createRequest({
        workspaceId: "workspace-test",
        operation: "listIssues",
        params: {
          state: "open",
          limit: 5,
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([{ id: "issue-1" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://nango.example.test/v1/linear-nango-config/proxy",
    );

    // The Nango proxy body must contain a GraphQL request: POST to /graphql
    // with `data: { query, variables }`. The earlier REST-style impl
    // (path: "/issues") returned 404s in production — codex P1 caught it.
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const proxyBody = JSON.parse(String(init?.body ?? "{}"));
    expect(proxyBody.endpoint).toBe("/graphql");
    expect(proxyBody.method).toBe("POST");
    expect(proxyBody.data).toBeDefined();
    expect(proxyBody.data.query).toBe(LINEAR_LIST_ISSUES_QUERY);
    expect(proxyBody.data.variables.first).toBe(5);
    // single-value `state: "open"` flows through readStringList → ["open"] →
    // filter.state.name.in: ["open"]
    expect(proxyBody.data.variables.filter).toEqual({
      state: { name: { in: ["open"] } },
    });
  });

  // Regression for devin + codex P2 review on PR #375. Pre-fix, array-valued
  // `labels` were silently dropped by the REST query-string serializer
  // (`readQueryValue` only handled string/number/boolean). Now they flow
  // through `readStringList` into a Linear IssueFilter `labels.some.name.in`
  // clause.
  it("preserves array-valued labels filter through to the GraphQL IssueFilter", async () => {
    readBearerTokenFromRequestMock.mockReturnValue("expected-token");
    readConfiguredSpecialistCloudApiTokenMock.mockReturnValue("expected-token");
    getWorkspaceIntegrationMock.mockResolvedValue({
      id: "wsi-linear-test",
      workspaceId: "workspace-test",
      provider: "linear",
      connectionId: "conn-123",
      providerConfigKey: "linear-nango-config",
      installationId: null,
      metadata: {},
      createdAt: new Date("2026-04-26T10:00:00.000Z"),
      updatedAt: new Date("2026-04-26T10:00:00.000Z"),
    });
    getNangoHostMock.mockReturnValue("https://nango.example.test");
    getNangoSecretKeyMock.mockReturnValue("nango-secret");
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: { issues: { nodes: [] } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await POST(
      createRequest({
        workspaceId: "workspace-test",
        operation: "listIssues",
        params: {
          labels: ["bug", "urgent"],
          state: ["Todo", "In Progress"],
          limit: 25,
        },
      }),
    );

    expect(response.status).toBe(200);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const proxyBody = JSON.parse(String(init?.body ?? "{}"));
    expect(proxyBody.data.variables.filter).toEqual({
      state: { name: { in: ["Todo", "In Progress"] } },
      labels: { some: { name: { in: ["bug", "urgent"] } } },
    });
  });

  it("treats non-key, non-UUID team filters as team names", async () => {
    readBearerTokenFromRequestMock.mockReturnValue("expected-token");
    readConfiguredSpecialistCloudApiTokenMock.mockReturnValue("expected-token");
    getWorkspaceIntegrationMock.mockResolvedValue({
      id: "wsi-linear-test",
      workspaceId: "workspace-test",
      provider: "linear",
      connectionId: "conn-123",
      providerConfigKey: "linear-nango-config",
      installationId: null,
      metadata: {},
      createdAt: new Date("2026-04-26T10:00:00.000Z"),
      updatedAt: new Date("2026-04-26T10:00:00.000Z"),
    });
    getNangoHostMock.mockReturnValue("https://nango.example.test");
    getNangoSecretKeyMock.mockReturnValue("nango-secret");
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: { issues: { nodes: [] } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await POST(
      createRequest({
        workspaceId: "workspace-test",
        operation: "listIssues",
        params: {
          team: "Platform",
        },
      }),
    );

    expect(response.status).toBe(200);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const proxyBody = JSON.parse(String(init?.body ?? "{}"));
    expect(proxyBody.data.variables.filter).toEqual({
      team: { name: { containsIgnoreCase: "Platform" } },
    });
  });

  it("builds a GraphQL searchIssues query for the searchIssues operation", async () => {
    readBearerTokenFromRequestMock.mockReturnValue("expected-token");
    readConfiguredSpecialistCloudApiTokenMock.mockReturnValue("expected-token");
    getWorkspaceIntegrationMock.mockResolvedValue({
      id: "wsi-linear-test",
      workspaceId: "workspace-test",
      provider: "linear",
      connectionId: "conn-123",
      providerConfigKey: "linear-nango-config",
      installationId: null,
      metadata: {},
      createdAt: new Date("2026-04-26T10:00:00.000Z"),
      updatedAt: new Date("2026-04-26T10:00:00.000Z"),
    });
    getNangoHostMock.mockReturnValue("https://nango.example.test");
    getNangoSecretKeyMock.mockReturnValue("nango-secret");
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: { searchIssues: { nodes: [] } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await POST(
      createRequest({
        workspaceId: "workspace-test",
        operation: "searchIssues",
        params: { query: "API rate limit", limit: 10 },
      }),
    );

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const proxyBody = JSON.parse(String(init?.body ?? "{}"));
    expect(proxyBody.data.query).toContain("searchIssues(term: $term, first: $first)");
    expect(proxyBody.data.variables).toEqual({
      term: "API rate limit",
      first: 10,
    });
  });

  it("normalizes GraphQL response envelopes for each Linear operation", async () => {
    readBearerTokenFromRequestMock.mockReturnValue("expected-token");
    readConfiguredSpecialistCloudApiTokenMock.mockReturnValue("expected-token");
    getWorkspaceIntegrationMock.mockResolvedValue({
      id: "wsi-linear-test",
      workspaceId: "workspace-test",
      provider: "linear",
      connectionId: "conn-123",
      providerConfigKey: "linear-nango-config",
      installationId: null,
      metadata: {},
      createdAt: new Date("2026-04-26T10:00:00.000Z"),
      updatedAt: new Date("2026-04-26T10:00:00.000Z"),
    });
    getNangoHostMock.mockReturnValue("https://nango.example.test");
    getNangoSecretKeyMock.mockReturnValue("nango-secret");
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { searchIssues: { nodes: [{ id: "issue-1" }] } } }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { issue: { id: "issue-2" } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { projects: { nodes: [{ id: "project-1" }] } } }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { issue: { comments: { nodes: [{ id: "comment-1" }] } } },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );

    const searchResponse = await POST(
      createRequest({
        workspaceId: "workspace-test",
        operation: "searchIssues",
        params: { query: "rate", limit: 3 },
      }),
    );
    await expect(searchResponse.json()).resolves.toEqual({
      items: [{ id: "issue-1" }],
    });

    const issueResponse = await POST(
      createRequest({
        workspaceId: "workspace-test",
        operation: "getIssue",
        params: { id: "issue-2" },
      }),
    );
    await expect(issueResponse.json()).resolves.toEqual({ id: "issue-2" });

    const projectsResponse = await POST(
      createRequest({
        workspaceId: "workspace-test",
        operation: "listProjects",
        params: { limit: 3 },
      }),
    );
    await expect(projectsResponse.json()).resolves.toEqual([{ id: "project-1" }]);

    const commentsResponse = await POST(
      createRequest({
        workspaceId: "workspace-test",
        operation: "listComments",
        params: { issueId: "issue-2", limit: 3 },
      }),
    );
    await expect(commentsResponse.json()).resolves.toEqual([{ id: "comment-1" }]);
  });
});
