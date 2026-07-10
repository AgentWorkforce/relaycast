import { describe, expect, it, vi, beforeEach } from "vitest";

const nangoProxyMock = vi.hoisted(() => vi.fn());
const nangoGetTokenMock = vi.hoisted(() => vi.fn());
const allowlistMock = vi.hoisted(() => vi.fn());
const listUserIntegrationsMock = vi.hoisted(() => vi.fn());
const listWorkspaceIntegrationsMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/integrations/nango-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/integrations/nango-service")>(
    "@/lib/integrations/nango-service",
  );
  return {
    ...actual,
    getNangoClient: () => ({ proxy: nangoProxyMock, getToken: nangoGetTokenMock }),
  };
});
vi.mock("@/lib/integrations/workflow-repository-allowlists", () => ({
  resolveRepoAllowlistOrRelaxed: allowlistMock,
}));
vi.mock("@/lib/integrations/user-integrations", () => ({
  listUserIntegrations: listUserIntegrationsMock,
}));
vi.mock("@/lib/integrations/workspace-integrations", () => ({
  findWorkspaceGithubIntegrationByInstallation: vi.fn(),
  listWorkspaceIntegrationsByProviderAlias: listWorkspaceIntegrationsMock,
}));

import {
  createGithubProxyIssueComment,
  createGithubProxyPullRequest,
} from "../packages/web/lib/integrations/github-proxy-pull-request";

describe("github proxy pull request", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nangoGetTokenMock.mockResolvedValue(null);
    allowlistMock.mockResolvedValue({
      workspaceId: "ws-1",
      repoOwner: "agentworkforce",
      repoName: "cloud",
      installationId: "",
      pushAllowed: true,
    });
    listUserIntegrationsMock.mockResolvedValue([]);
    listWorkspaceIntegrationsMock.mockResolvedValue([
      {
        workspaceId: "ws-1",
        provider: "github",
        connectionId: "conn-github",
        providerConfigKey: "github-relay",
        installationId: "134609235",
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    nangoProxyMock.mockImplementation(async ({ endpoint, method }: { endpoint: string; method: string }) => {
      if (method === "GET" && endpoint === "/repos/AgentWorkforce/cloud") {
        return { status: 200, data: { id: 1 } };
      }
      if (method === "GET" && endpoint === "/repos/AgentWorkforce/cloud/git/commits/base-sha") {
        return { status: 200, data: { tree: { sha: "base-tree" } } };
      }
      if (method === "POST" && endpoint === "/repos/AgentWorkforce/cloud/git/blobs") {
        return { status: 201, data: { sha: "blob-sha" } };
      }
      if (method === "POST" && endpoint === "/repos/AgentWorkforce/cloud/git/trees") {
        return { status: 201, data: { sha: "tree-sha" } };
      }
      if (method === "POST" && endpoint === "/repos/AgentWorkforce/cloud/git/commits") {
        return { status: 201, data: { sha: "commit-sha" } };
      }
      if (method === "POST" && endpoint === "/repos/AgentWorkforce/cloud/git/refs") {
        return { status: 201, data: { ref: "refs/heads/codex/small-issue-1" } };
      }
      if (method === "POST" && endpoint === "/repos/AgentWorkforce/cloud/pulls") {
        return { status: 201, data: { html_url: "https://github.com/AgentWorkforce/cloud/pull/1084" } };
      }
      if (method === "POST" && endpoint === "/repos/AgentWorkforce/cloud/issues/1091/comments") {
        return { status: 201, data: { html_url: "https://github.com/AgentWorkforce/cloud/issues/1091#issuecomment-1" } };
      }
      throw new Error(`unexpected proxy call ${method} ${endpoint}`);
    });
  });

  it("creates a one-commit branch and PR through Nango proxy only", async () => {
    await expect(createGithubProxyPullRequest({
      userId: "user-1",
      workspaceId: "ws-1",
      owner: "AgentWorkforce",
      repo: "cloud",
      branch: "codex/small-issue-1",
      baseSha: "base-sha",
      title: "Fix small issue #1",
      body: "Fixes #1",
      files: [{ path: "README.md", content: "updated\n" }],
    })).resolves.toEqual({
      prUrl: "https://github.com/AgentWorkforce/cloud/pull/1084",
      branch: "codex/small-issue-1",
      sha: "commit-sha",
    });

    expect(nangoProxyMock).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "conn-github",
      providerConfigKey: "github-relay",
      method: "GET",
      endpoint: "/repos/AgentWorkforce/cloud",
    }));
    expect(nangoProxyMock).toHaveBeenCalledWith(expect.objectContaining({
      method: "POST",
      endpoint: "/repos/AgentWorkforce/cloud/pulls",
      data: expect.objectContaining({ head: "codex/small-issue-1" }),
    }));
    for (const call of nangoProxyMock.mock.calls) {
      expect(call[0]).not.toHaveProperty("headers.Authorization");
      expect(JSON.stringify(call[0])).not.toContain("ghs_");
    }
  });

  it("creates issue comments through the same Nango proxy path", async () => {
    await expect(createGithubProxyIssueComment({
      userId: "user-1",
      workspaceId: "ws-1",
      owner: "AgentWorkforce",
      repo: "cloud",
      issueNumber: 1091,
      body: "Workflow launch failed before the sandbox could start.",
    })).resolves.toEqual({
      commentUrl: "https://github.com/AgentWorkforce/cloud/issues/1091#issuecomment-1",
    });

    expect(nangoProxyMock).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "conn-github",
      providerConfigKey: "github-relay",
      method: "POST",
      endpoint: "/repos/AgentWorkforce/cloud/issues/1091/comments",
      data: {
        body: "Workflow launch failed before the sandbox could start.",
      },
    }));
    for (const call of nangoProxyMock.mock.calls) {
      expect(call[0]).not.toHaveProperty("headers.Authorization");
      expect(JSON.stringify(call[0])).not.toContain("ghs_");
    }
  });
});
