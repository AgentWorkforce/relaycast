import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLinearIntegration } from "./linear-api-client.js";

const CLOUD_API_URL = "https://cloud.example.test/";
const CLOUD_API_TOKEN = "specialist-cloud-token";
const WORKSPACE_ID = "workspace-test";

type FetchArgs = Parameters<typeof globalThis.fetch>;
type FetchReturn = ReturnType<typeof globalThis.fetch>;

function createFetchMock() {
  return vi.fn<FetchArgs, FetchReturn>();
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
    ...init,
  });
}

function createIntegration() {
  return createLinearIntegration({
    cloudApiUrl: CLOUD_API_URL,
    cloudApiToken: CLOUD_API_TOKEN,
    workspaceId: WORKSPACE_ID,
  });
}

function expectCloudRequest(
  fetchMock: ReturnType<typeof createFetchMock>,
  input: {
    operation: string;
    params: Record<string, unknown>;
  },
): void {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]?.[0]).toBe("https://cloud.example.test/api/v1/linear/query");
  expect(fetchMock.mock.calls[0]?.[1]).toEqual({
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${CLOUD_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      workspaceId: WORKSPACE_ID,
      operation: input.operation,
      params: input.params,
    }),
  });
}

describe("createLinearIntegration", () => {
  let fetchMock = createFetchMock();

  beforeEach(() => {
    fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts listIssues to the linear query route with auth headers", async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ id: "issue-1" }]));
    const integration = createIntegration();

    const result = await integration.listIssues({
      state: "open",
      team: "Platform",
      assignee: "Ada",
      labels: ["bug", "urgent"],
      limit: 7,
    });

    expect(result).toEqual(
      expect.objectContaining({
        data: [{ id: "issue-1" }],
        source: "linear.cloud.nango",
        timestamp: expect.any(String),
      }),
    );
    expectCloudRequest(fetchMock, {
      operation: "listIssues",
      params: {
        state: "open",
        team: "Platform",
        assignee: "Ada",
        labels: ["bug", "urgent"],
        limit: 7,
      },
    });
  });

  it("posts searchIssues to the linear query route with the trimmed query", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [{ id: "issue-2" }] }));
    const integration = createIntegration();

    const result = await integration.searchIssues("  auth regression  ", { limit: 9 });

    expect(result).toEqual(
      expect.objectContaining({
        data: {
          items: [{ id: "issue-2" }],
        },
        source: "linear.cloud.nango",
        timestamp: expect.any(String),
      }),
    );
    expectCloudRequest(fetchMock, {
      operation: "searchIssues",
      params: {
        query: "auth regression",
        limit: 9,
      },
    });
  });

  it("posts getIssue to the linear query route with the trimmed id", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "issue-3" }));
    const integration = createIntegration();

    const result = await integration.getIssue("  issue-3  ");

    expect(result).toEqual(
      expect.objectContaining({
        data: { id: "issue-3" },
        source: "linear.cloud.nango",
        timestamp: expect.any(String),
      }),
    );
    expectCloudRequest(fetchMock, {
      operation: "getIssue",
      params: {
        id: "issue-3",
      },
    });
  });

  it("posts listProjects to the linear query route with the correct body", async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ id: "project-1" }]));
    const integration = createIntegration();

    const result = await integration.listProjects({
      state: "planned",
      team: "Core",
      limit: 11,
    });

    expect(result).toEqual(
      expect.objectContaining({
        data: [{ id: "project-1" }],
        source: "linear.cloud.nango",
        timestamp: expect.any(String),
      }),
    );
    expectCloudRequest(fetchMock, {
      operation: "listProjects",
      params: {
        state: "planned",
        team: "Core",
        limit: 11,
      },
    });
  });

  it("posts listComments to the linear query route with the trimmed issue id", async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ id: "comment-1" }]));
    const integration = createIntegration();

    const result = await integration.listComments("  issue-4  ", { limit: 3 });

    expect(result).toEqual(
      expect.objectContaining({
        data: [{ id: "comment-1" }],
        source: "linear.cloud.nango",
        timestamp: expect.any(String),
      }),
    );
    expectCloudRequest(fetchMock, {
      operation: "listComments",
      params: {
        issueId: "issue-4",
        limit: 3,
      },
    });
  });

  it("raises when the cloud query route returns an error response", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "upstream failed" }), {
        status: 502,
        headers: {
          "content-type": "application/json",
        },
      }),
    );
    const integration = createIntegration();

    await expect(integration.listIssues()).rejects.toThrow(
      "linear cloud query listIssues failed: status=502",
    );
  });
});
