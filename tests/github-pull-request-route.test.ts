import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  requireAuthScope: vi.fn(),
}));
const prMocks = vi.hoisted(() => ({
  createGithubProxyPullRequest: vi.fn(),
  GithubProxyPullRequestError: class GithubProxyPullRequestError extends Error {
    status: number;
    code: string;
    constructor(code: string, message: string, status = 500) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));
const dbMocks = vi.hoisted(() => ({
  selectResults: [] as unknown[][],
  sponsorRows: [{
    deployedName: "cloud-small-issue-codex",
    deployedByUserId: "deployer-user",
  }],
  select: vi.fn(() => ({
    from: () => ({
      innerJoin: () => ({
        where: () => ({
          limit: async () => dbMocks.selectResults.shift() ?? dbMocks.sponsorRows,
        }),
      }),
      where: () => ({
        limit: async () => dbMocks.selectResults.shift() ?? [],
      }),
    }),
  })),
}));

vi.mock("next/server", () => ({
  NextRequest: Request,
  NextResponse: {
    json(body: unknown, init?: ResponseInit) {
      return Response.json(body, init);
    },
  },
}));
vi.mock("../packages/web/lib/auth/request-auth", () => authMocks);
vi.mock("../packages/web/lib/integrations/github-proxy-pull-request", () => prMocks);
vi.mock("../packages/web/lib/db", () => ({
  getDb: () => ({
    select: dbMocks.select,
  }),
}));

import { POST } from "../packages/web/app/api/v1/github/pull-request/route";

describe("github pull request route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    dbMocks.selectResults = [];
    dbMocks.sponsorRows = [{
      deployedName: "cloud-small-issue-codex",
      deployedByUserId: "deployer-user",
    }];
    authMocks.resolveRequestAuth.mockResolvedValue({
      userId: "agent-user",
      workspaceId: "ws-1",
      organizationId: "org-1",
      source: "relayfile",
      relayfileSponsorId: "agent-1",
      scopes: ["workflow:invoke:write"],
    });
    authMocks.requireAuthScope.mockReturnValue(true);
    prMocks.createGithubProxyPullRequest.mockResolvedValue({
      prUrl: "https://github.com/AgentWorkforce/cloud/pull/1",
      branch: "codex/small-issue-1",
      sha: "commit-sha",
    });
  });

  it("accepts the matching relayfile persona sponsor and does not take connection input from the sandbox", async () => {
    const response = await POST(new Request("http://localhost/api/v1/github/pull-request", {
      method: "POST",
      headers: { authorization: "Bearer workflow-token" },
      body: JSON.stringify({
        workspaceId: "ws-1",
        owner: "AgentWorkforce",
        repo: "cloud",
        branch: "codex/small-issue-1",
        baseSha: "base-sha",
        title: "Fix small issue #1",
        body: "Fixes #1",
        connectionId: "caller-controlled",
        token: "ghs_should_not_be_used",
        files: [{ path: "README.md", content: "updated\n" }],
      }),
    }) as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      prUrl: "https://github.com/AgentWorkforce/cloud/pull/1",
      branch: "codex/small-issue-1",
      sha: "commit-sha",
    });
    expect(prMocks.createGithubProxyPullRequest).toHaveBeenCalledWith({
      userId: "deployer-user",
      workspaceId: "ws-1",
      owner: "AgentWorkforce",
      repo: "cloud",
      branch: "codex/small-issue-1",
      baseSha: "base-sha",
      title: "Fix small issue #1",
      body: "Fixes #1",
      files: [{ path: "README.md", content: "updated\n", encoding: "utf-8" }],
    });
    expect(JSON.stringify(prMocks.createGithubProxyPullRequest.mock.calls[0][0])).not.toContain("caller-controlled");
    expect(JSON.stringify(prMocks.createGithubProxyPullRequest.mock.calls[0][0])).not.toContain("ghs_should");
  });

  it("returns a local dry-run pull request after sponsor authorization when enabled", async () => {
    vi.stubEnv("GITHUB_PROXY_DRY_RUN", "1");

    const response = await POST(new Request("http://localhost/api/v1/github/pull-request", {
      method: "POST",
      headers: { authorization: "Bearer workflow-token" },
      body: JSON.stringify({
        workspaceId: "ws-1",
        owner: "AgentWorkforce",
        repo: "cloud",
        branch: "codex/small-issue-1",
        baseSha: "base-sha",
        title: "Fix small issue #1",
        body: "Fixes #1",
        files: [{ path: "README.md", content: "updated\n" }],
      }),
    }) as never);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      prUrl: "http://localhost:3000/cloud/dev/github/pull-request/codex%2Fsmall-issue-1",
      branch: "codex/small-issue-1",
      dryRun: true,
    });
    expect(typeof body.sha).toBe("string");
    expect(prMocks.createGithubProxyPullRequest).not.toHaveBeenCalled();
  });

  it("normalizes relay workspace ids before checking the persona sponsor and creating the pull request", async () => {
    const appWorkspaceId = "50587328-441d-4acb-b8f3-dbe1b3c5de99";
    authMocks.resolveRequestAuth.mockResolvedValue({
      userId: "agent-user",
      workspaceId: "rw_boundws01",
      organizationId: "org-1",
      source: "relayfile",
      relayfileSponsorId: "agent-1",
      scopes: ["workflow:invoke:write"],
    });
    dbMocks.selectResults = [
      [{ appWorkspaceId, organizationId: "org-1" }],
      [{
        deployedName: "cloud-small-issue-codex",
        deployedByUserId: "deployer-user",
      }],
    ];

    const response = await POST(new Request("http://localhost/api/v1/github/pull-request", {
      method: "POST",
      headers: { authorization: "Bearer workflow-token" },
      body: JSON.stringify({
        workspaceId: "rw_boundws01",
        owner: "AgentWorkforce",
        repo: "cloud",
        branch: "codex/small-issue-1",
        baseSha: "base-sha",
        title: "Fix small issue #1",
        body: "Fixes #1",
        files: [{ path: "README.md", content: "updated\n" }],
      }),
    }) as never);

    expect(response.status).toBe(200);
    expect(prMocks.createGithubProxyPullRequest).toHaveBeenCalledWith({
      userId: "deployer-user",
      workspaceId: appWorkspaceId,
      owner: "AgentWorkforce",
      repo: "cloud",
      branch: "codex/small-issue-1",
      baseSha: "base-sha",
      title: "Fix small issue #1",
      body: "Fixes #1",
      files: [{ path: "README.md", content: "updated\n", encoding: "utf-8" }],
    });
    expect(dbMocks.selectResults).toEqual([]);
  });

  it("rejects browser/session auth even though sessions normally satisfy scopes", async () => {
    authMocks.resolveRequestAuth.mockResolvedValue({
      userId: "user-1",
      workspaceId: "ws-1",
      organizationId: "org-1",
      source: "session",
    });

    const response = await POST(new Request("http://localhost/api/v1/github/pull-request", {
      method: "POST",
      body: JSON.stringify({}),
    }) as never);

    expect(response.status).toBe(403);
    expect(prMocks.createGithubProxyPullRequest).not.toHaveBeenCalled();
  });

  it("rejects relayfile workflow tokens whose sponsor is not the registered persona", async () => {
    dbMocks.sponsorRows = [{
      deployedName: "different-persona",
      deployedByUserId: "deployer-user",
    }];

    const response = await POST(new Request("http://localhost/api/v1/github/pull-request", {
      method: "POST",
      headers: { authorization: "Bearer workflow-token" },
      body: JSON.stringify({
        owner: "AgentWorkforce",
        repo: "cloud",
        branch: "codex/small-issue-1",
        baseSha: "base-sha",
        title: "Fix small issue #1",
        body: "Fixes #1",
        files: [{ path: "README.md", content: "updated\n" }],
      }),
    }) as never);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "github_write_forbidden",
      message: "GitHub pull request creation requires the matching deployed persona sponsor.",
    });
    expect(prMocks.createGithubProxyPullRequest).not.toHaveBeenCalled();
  });
});
