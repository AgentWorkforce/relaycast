import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  eq: vi.fn(),
  getDb: vi.fn(),
  getNangoClient: vi.fn(),
  getNangoConnectionDetails: vi.fn(),
  getProviderConfigKey: vi.fn(),
  listUserIntegrations: vi.fn(),
  listWorkspaceIntegrationsByProviderAlias: vi.fn(),
  findWorkspaceGithubIntegrationByInstallation: vi.fn(),
  resolveRepoAllowlistOrRelaxed: vi.fn(),
  commitViaGitDatabaseRequest: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  eq: mocks.eq,
}));

vi.mock("@/lib/db", () => ({
  getDb: mocks.getDb,
}));

vi.mock("@/lib/db/schema", () => ({
  workspaces: {
    id: "workspaces.id",
    relayWorkspaceId: "workspaces.relayWorkspaceId",
  },
}));

vi.mock("./nango-service", () => ({
  getNangoClient: mocks.getNangoClient,
  getNangoConnectionDetails: mocks.getNangoConnectionDetails,
  getProviderConfigKey: mocks.getProviderConfigKey,
}));

vi.mock("./user-integrations", () => ({
  listUserIntegrations: mocks.listUserIntegrations,
}));

vi.mock("./workspace-integrations", () => ({
  listWorkspaceIntegrationsByProviderAlias: mocks.listWorkspaceIntegrationsByProviderAlias,
  findWorkspaceGithubIntegrationByInstallation: mocks.findWorkspaceGithubIntegrationByInstallation,
}));

vi.mock("./workflow-repository-allowlists", () => ({
  resolveRepoAllowlistOrRelaxed: mocks.resolveRepoAllowlistOrRelaxed,
}));

vi.mock("./relayfile-writeback-bridge", () => ({
  commitViaGitDatabaseRequest: mocks.commitViaGitDatabaseRequest,
}));

import {
  createGithubProxyPullRequest,
  readGithubProxyPullRequest,
} from "./github-proxy-pull-request";
import type { UserIntegrationRecord } from "./user-integrations";
import type { WorkspaceIntegrationRecord } from "./workspace-integrations";

const now = new Date("2026-05-25T00:00:00.000Z");

function userIntegration(overrides: Partial<UserIntegrationRecord> = {}): UserIntegrationRecord {
  return {
    userId: "user-1",
    provider: "github",
    name: null,
    connectionId: "conn-user",
    providerConfigKey: "github-relay",
    installationId: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function workspaceIntegration(
  overrides: Partial<WorkspaceIntegrationRecord> = {},
): WorkspaceIntegrationRecord {
  return {
    id: "integration_workspace",
    workspaceId: "workspace-1",
    provider: "github",
    name: null,
    connectionId: "conn-workspace",
    providerConfigKey: "github-relay",
    installationId: "123",
    metadata: {},
    writebackDispatchVia: "bridge",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function allowlist() {
  return {
    workspaceId: "workspace-1",
    repoOwner: "AgentWorkforce",
    repoName: "cloud",
    installationId: "",
    pushAllowed: true,
    allowedAt: now,
    allowedBy: "system:relaxed",
  };
}

function requestInput() {
  return {
    userId: "user-1",
    workspaceId: "workspace-1",
    owner: "AgentWorkforce",
    repo: "cloud",
    branch: "codex/test",
    baseSha: "base-sha",
    baseBranch: "main",
    title: "Test PR",
    body: "Body",
    files: [{ path: "README.md", content: "updated", encoding: "utf-8" as const }],
  };
}

describe("createGithubProxyPullRequest", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
    mocks.eq.mockReturnValue({ op: "eq" });
    mocks.getProviderConfigKey.mockImplementation((provider: string) => provider);
    mocks.resolveRepoAllowlistOrRelaxed.mockResolvedValue(allowlist());
    mocks.listUserIntegrations.mockResolvedValue([]);
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([]);
    mocks.findWorkspaceGithubIntegrationByInstallation.mockResolvedValue(null);
    mocks.getNangoConnectionDetails.mockResolvedValue(null);
    mocks.getNangoClient.mockReturnValue({
      getToken: vi.fn(),
      proxy: vi.fn(async () => ({ status: 200, data: { id: 1, html_url: "https://github.com/proxy/pr" } })),
    });
    mocks.commitViaGitDatabaseRequest.mockImplementation(async ({ request }) => {
      await request({
        method: "POST",
        endpoint: "/repos/AgentWorkforce/cloud/git/blobs",
        data: { content: "updated", encoding: "utf-8" },
      });
      return "commit-sha";
    });
  });

  it("uses the deployer user OAuth token for GitHub write requests", async () => {
    mocks.listUserIntegrations.mockResolvedValue([
      userIntegration({ connectionId: "conn-user" }),
    ]);
    mocks.getNangoConnectionDetails.mockResolvedValue({
      payload: {
        connection_config: {
          userCredentials: { access_token: "gho_user-token" },
        },
      },
      installationId: null,
    });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        authorization: "Bearer gho_user-token",
      });
      return new Response(JSON.stringify({ html_url: "https://github.com/AgentWorkforce/cloud/pull/1" }), {
        status: 201,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(createGithubProxyPullRequest(requestInput())).resolves.toMatchObject({
      prUrl: "https://github.com/AgentWorkforce/cloud/pull/1",
      branch: "codex/test",
      sha: "commit-sha",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/AgentWorkforce/cloud",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/AgentWorkforce/cloud/git/blobs",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/AgentWorkforce/cloud/pulls",
      expect.objectContaining({ method: "POST" }),
    );
    expect(mocks.getNangoClient().proxy).not.toHaveBeenCalled();
  });

  it("uses embedded GitHub App user credentials from a workspace connection", async () => {
    mocks.resolveRepoAllowlistOrRelaxed.mockResolvedValue({
      ...allowlist(),
      installationId: "123",
    });
    mocks.findWorkspaceGithubIntegrationByInstallation.mockResolvedValue(
      workspaceIntegration({ connectionId: "conn-workspace", installationId: "123" }),
    );
    mocks.getNangoConnectionDetails.mockResolvedValue({
      payload: {
        userCredentials: {
          type: "OAUTH2",
          access_token: "ghu_workspace-user-token",
          raw: { access_token: "ghu_raw-user-token" },
        },
      },
      installationId: "123",
    });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        authorization: "Bearer ghu_workspace-user-token",
      });
      return new Response(JSON.stringify({ html_url: "https://github.com/AgentWorkforce/cloud/pull/4" }), {
        status: 201,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(createGithubProxyPullRequest(requestInput())).resolves.toMatchObject({
      prUrl: "https://github.com/AgentWorkforce/cloud/pull/4",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/AgentWorkforce/cloud",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/AgentWorkforce/cloud/pulls",
      expect.objectContaining({ method: "POST" }),
    );
    expect(mocks.getNangoClient().proxy).not.toHaveBeenCalled();
  });

  it("falls back to the workspace installation when embedded user credentials cannot access the repo", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.resolveRepoAllowlistOrRelaxed.mockResolvedValue({
      ...allowlist(),
      installationId: "123",
    });
    mocks.findWorkspaceGithubIntegrationByInstallation.mockResolvedValue(
      workspaceIntegration({ connectionId: "conn-workspace", installationId: "123" }),
    );
    mocks.getNangoConnectionDetails.mockResolvedValue({
      payload: {
        userCredentials: {
          type: "OAUTH2",
          access_token: "ghu_workspace-user-token",
        },
      },
      installationId: "123",
    });
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    mocks.getNangoClient().proxy.mockImplementation(async ({ endpoint }: { endpoint: string }) => ({
      status: endpoint.endsWith("/pulls") ? 201 : 200,
      data: endpoint.endsWith("/pulls")
        ? { html_url: "https://github.com/AgentWorkforce/cloud/pull/5" }
        : { id: 1 },
    }));

    try {
      await expect(createGithubProxyPullRequest(requestInput())).resolves.toMatchObject({
        prUrl: "https://github.com/AgentWorkforce/cloud/pull/5",
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.github.com/repos/AgentWorkforce/cloud",
        expect.objectContaining({ method: "GET" }),
      );
      expect(mocks.getNangoClient().proxy).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: "conn-workspace",
          endpoint: "/repos/AgentWorkforce/cloud/pulls",
          method: "POST",
        }),
      );
      expect(JSON.stringify(warnSpy.mock.calls)).toContain("repo probe failed");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("falls back to the workspace installation when the user credential can read but not write", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.resolveRepoAllowlistOrRelaxed.mockResolvedValue({
      ...allowlist(),
      installationId: "123",
    });
    mocks.findWorkspaceGithubIntegrationByInstallation.mockResolvedValue(
      workspaceIntegration({ connectionId: "conn-workspace", installationId: "123" }),
    );
    mocks.getNangoConnectionDetails.mockResolvedValue({
      payload: {
        userCredentials: {
          type: "OAUTH2",
          access_token: "ghu_workspace-user-token",
        },
      },
      installationId: "123",
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "https://api.github.com/repos/AgentWorkforce/cloud") {
        return new Response(JSON.stringify({ id: 1 }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    mocks.getNangoClient().proxy.mockImplementation(async ({ endpoint }: { endpoint: string }) => ({
      status: endpoint.endsWith("/pulls") ? 201 : 200,
      data: endpoint.endsWith("/pulls")
        ? { html_url: "https://github.com/AgentWorkforce/cloud/pull/6" }
        : { id: 1 },
    }));

    try {
      await expect(createGithubProxyPullRequest(requestInput())).resolves.toMatchObject({
        prUrl: "https://github.com/AgentWorkforce/cloud/pull/6",
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.github.com/repos/AgentWorkforce/cloud",
        expect.objectContaining({ method: "GET" }),
      );
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.github.com/repos/AgentWorkforce/cloud/git/blobs",
        expect.objectContaining({ method: "POST" }),
      );
      expect(mocks.getNangoClient().proxy).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: "conn-workspace",
          endpoint: "/repos/AgentWorkforce/cloud/git/blobs",
          method: "POST",
        }),
      );
      expect(mocks.getNangoClient().proxy).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: "conn-workspace",
          endpoint: "/repos/AgentWorkforce/cloud/pulls",
          method: "POST",
        }),
      );
      const logged = JSON.stringify(warnSpy.mock.calls);
      expect(logged).toContain("write failed");
      expect(logged).toContain("/repos/AgentWorkforce/cloud/git/blobs");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("can explicitly use the app-authored Nango proxy path", async () => {
    mocks.resolveRepoAllowlistOrRelaxed.mockResolvedValue({
      ...allowlist(),
      installationId: "123",
    });
    mocks.findWorkspaceGithubIntegrationByInstallation.mockResolvedValue(
      workspaceIntegration({ connectionId: "conn-workspace", installationId: "123" }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(createGithubProxyPullRequest({
      ...requestInput(),
      authorshipMode: "app",
    })).resolves.toMatchObject({
      prUrl: "https://github.com/proxy/pr",
    });

    expect(mocks.getNangoConnectionDetails).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.getNangoClient().proxy).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "conn-workspace",
        endpoint: "/repos/AgentWorkforce/cloud/pulls",
        method: "POST",
      }),
    );
  });

  it("falls back to the Nango user connection token when details do not expose credentials", async () => {
    mocks.listUserIntegrations.mockResolvedValue([
      userIntegration({ connectionId: "conn-user", providerConfigKey: "github" }),
    ]);
    mocks.getNangoConnectionDetails.mockResolvedValue({ payload: {}, installationId: null });
    mocks.getNangoClient().getToken.mockResolvedValue({ access_token: "gho_login-token" });
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ html_url: "https://github.com/AgentWorkforce/cloud/pull/3" }), {
        status: 201,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(createGithubProxyPullRequest(requestInput())).resolves.toMatchObject({
      prUrl: "https://github.com/AgentWorkforce/cloud/pull/3",
    });

    expect(mocks.getNangoClient().getToken).toHaveBeenCalledWith("github", "conn-user");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/AgentWorkforce/cloud",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer gho_login-token" }),
      }),
    );
    expect(mocks.getNangoClient().proxy).not.toHaveBeenCalled();
  });

  it("rejects a user integration that exposes an installation token and falls back", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.listUserIntegrations.mockResolvedValue([
      userIntegration({ connectionId: "conn-user" }),
    ]);
    mocks.getNangoConnectionDetails.mockResolvedValue({
      payload: {
        connection_config: {
          userCredentials: { access_token: "ghs_installation-token" },
        },
      },
      installationId: "123",
    });
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([
      workspaceIntegration({ connectionId: "conn-workspace" }),
    ]);
    mocks.getNangoClient().proxy.mockImplementation(async ({ endpoint }: { endpoint: string }) => ({
      status: endpoint.endsWith("/pulls") ? 201 : 200,
      data: endpoint.endsWith("/pulls")
        ? { html_url: "https://github.com/AgentWorkforce/cloud/pull/2" }
        : { id: 1 },
    }));

    try {
      await expect(createGithubProxyPullRequest(requestInput())).resolves.toMatchObject({
        prUrl: "https://github.com/AgentWorkforce/cloud/pull/2",
      });

      const logged = JSON.stringify(warnSpy.mock.calls);
      expect(logged).toContain("user_oauth_token_not_found");
      expect(logged).not.toContain("ghs_installation-token");
      expect(mocks.getNangoClient().proxy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("reads pull request metadata through the app-authenticated Nango proxy path", async () => {
    mocks.resolveRepoAllowlistOrRelaxed.mockResolvedValue({
      ...allowlist(),
      installationId: "123",
    });
    mocks.findWorkspaceGithubIntegrationByInstallation.mockResolvedValue(
      workspaceIntegration({ connectionId: "conn-workspace", installationId: "123" }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mocks.getNangoClient().proxy.mockImplementation(async ({ endpoint }: { endpoint: string }) => ({
      status: 200,
      data: endpoint.endsWith("/pulls/1495")
        ? {
            number: 1495,
            head: { sha: "head-sha" },
            base: { sha: "base-sha" },
          }
        : { id: 1 },
    }));

    await expect(readGithubProxyPullRequest({
      userId: "user-1",
      workspaceId: "workspace-1",
      owner: "AgentWorkforce",
      repo: "cloud",
      pullNumber: 1495,
    })).resolves.toMatchObject({
      number: 1495,
      head: { sha: "head-sha" },
      base: { sha: "base-sha" },
    });

    expect(mocks.getNangoConnectionDetails).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.getNangoClient().proxy).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "conn-workspace",
        endpoint: "/repos/AgentWorkforce/cloud/pulls/1495",
        method: "GET",
      }),
    );
  });

  it("surfaces status-less Nango proxy transport failures", async () => {
    mocks.resolveRepoAllowlistOrRelaxed.mockResolvedValue({
      ...allowlist(),
      installationId: "123",
    });
    mocks.findWorkspaceGithubIntegrationByInstallation.mockResolvedValue(
      workspaceIntegration({ connectionId: "conn-workspace", installationId: "123" }),
    );
    const failure = new Error("[unenv] https.request is not implemented yet!");
    failure.name = "AxiosError";
    (failure as Error & { cause?: Error }).cause = new Error("node:https unavailable");
    mocks.getNangoClient().proxy.mockRejectedValue(failure);

    await expect(readGithubProxyPullRequest({
      userId: "user-1",
      workspaceId: "workspace-1",
      owner: "AgentWorkforce",
      repo: "cloud",
      pullNumber: 1495,
    })).rejects.toMatchObject({
      code: "github_nango_proxy_unavailable",
      status: 503,
      message: expect.stringContaining(
        "AxiosError: [unenv] https.request is not implemented yet!",
      ),
      payload: {
        message: expect.stringContaining("node:https unavailable"),
      },
    });
  });

  it("surfaces Nango proxy 5xx pull request reads as Nango proxy outages", async () => {
    mocks.resolveRepoAllowlistOrRelaxed.mockResolvedValue({
      ...allowlist(),
      installationId: "123",
    });
    mocks.findWorkspaceGithubIntegrationByInstallation.mockResolvedValue(
      workspaceIntegration({ connectionId: "conn-workspace", installationId: "123" }),
    );
    mocks.getNangoClient().proxy.mockImplementation(async ({ endpoint }: { endpoint: string }) => {
      if (endpoint.endsWith("/pulls/1495")) {
        throw {
          response: {
            status: 503,
            data: { message: "Nango is temporarily unavailable" },
            headers: { "retry-after": "30" },
          },
        };
      }
      return { status: 200, data: { id: 1 } };
    });

    await expect(readGithubProxyPullRequest({
      userId: "user-1",
      workspaceId: "workspace-1",
      owner: "AgentWorkforce",
      repo: "cloud",
      pullNumber: 1495,
    })).rejects.toMatchObject({
      code: "github_nango_proxy_unavailable",
      status: 503,
      message: expect.stringContaining("Nango is temporarily unavailable"),
    });
  });

  it("keeps pull request permission 403 responses terminal", async () => {
    mocks.resolveRepoAllowlistOrRelaxed.mockResolvedValue({
      ...allowlist(),
      installationId: "123",
    });
    mocks.findWorkspaceGithubIntegrationByInstallation.mockResolvedValue(
      workspaceIntegration({ connectionId: "conn-workspace", installationId: "123" }),
    );
    mocks.getNangoClient().proxy.mockImplementation(async ({ endpoint }: { endpoint: string }) => {
      if (endpoint.endsWith("/pulls/1495")) {
        throw {
          response: {
            status: 403,
            data: { message: "Resource not accessible by integration" },
            headers: { "x-ratelimit-remaining": "4999" },
          },
        };
      }
      return { status: 200, data: { id: 1 } };
    });

    await expect(readGithubProxyPullRequest({
      userId: "user-1",
      workspaceId: "workspace-1",
      owner: "AgentWorkforce",
      repo: "cloud",
      pullNumber: 1495,
    })).rejects.toMatchObject({
      code: "github_api_error",
      status: 403,
    });
  });

  it("maps secondary-rate-limit 403 pull request reads to retryable failures", async () => {
    mocks.resolveRepoAllowlistOrRelaxed.mockResolvedValue({
      ...allowlist(),
      installationId: "123",
    });
    mocks.findWorkspaceGithubIntegrationByInstallation.mockResolvedValue(
      workspaceIntegration({ connectionId: "conn-workspace", installationId: "123" }),
    );
    mocks.getNangoClient().proxy.mockImplementation(async ({ endpoint }: { endpoint: string }) => {
      if (endpoint.endsWith("/pulls/1495")) {
        throw {
          response: {
            status: 403,
            data: {
              message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
            },
            headers: { "retry-after": "60" },
          },
        };
      }
      return { status: 200, data: { id: 1 } };
    });

    await expect(readGithubProxyPullRequest({
      userId: "user-1",
      workspaceId: "workspace-1",
      owner: "AgentWorkforce",
      repo: "cloud",
      pullNumber: 1495,
    })).rejects.toMatchObject({
      code: "github_rate_limited",
      status: 503,
    });
  });

  it("maps secondary-rate-limit 403 repo probes before pull request reads to retryable failures", async () => {
    mocks.resolveRepoAllowlistOrRelaxed.mockResolvedValue({
      ...allowlist(),
      installationId: "123",
    });
    mocks.findWorkspaceGithubIntegrationByInstallation.mockResolvedValue(
      workspaceIntegration({ connectionId: "conn-workspace", installationId: "123" }),
    );
    mocks.getNangoClient().proxy.mockImplementation(async ({ endpoint }: { endpoint: string }) => {
      if (endpoint === "/repos/AgentWorkforce/cloud") {
        throw {
          response: {
            status: 403,
            data: { message: "Resource not accessible by integration" },
            headers: new Headers({ "retry-after": "60" }),
          },
        };
      }
      return { status: 200, data: { id: 1 } };
    });

    await expect(readGithubProxyPullRequest({
      userId: "user-1",
      workspaceId: "workspace-1",
      owner: "AgentWorkforce",
      repo: "cloud",
      pullNumber: 1495,
    })).rejects.toMatchObject({
      code: "github_rate_limited",
      status: 503,
    });

    expect(mocks.getNangoClient().proxy).not.toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "/repos/AgentWorkforce/cloud/pulls/1495",
      }),
    );
  });

  it("maps 429 pull request reads to retryable failures", async () => {
    mocks.resolveRepoAllowlistOrRelaxed.mockResolvedValue({
      ...allowlist(),
      installationId: "123",
    });
    mocks.findWorkspaceGithubIntegrationByInstallation.mockResolvedValue(
      workspaceIntegration({ connectionId: "conn-workspace", installationId: "123" }),
    );
    mocks.getNangoClient().proxy.mockImplementation(async ({ endpoint }: { endpoint: string }) => {
      if (endpoint.endsWith("/pulls/1495")) {
        throw {
          response: {
            status: 429,
            data: { message: "rate limit exceeded" },
            headers: { "retry-after": "30" },
          },
        };
      }
      return { status: 200, data: { id: 1 } };
    });

    await expect(readGithubProxyPullRequest({
      userId: "user-1",
      workspaceId: "workspace-1",
      owner: "AgentWorkforce",
      repo: "cloud",
      pullNumber: 1495,
    })).rejects.toMatchObject({
      code: "github_rate_limited",
      status: 503,
    });
  });

  it("keeps missing pull request reads terminal", async () => {
    mocks.resolveRepoAllowlistOrRelaxed.mockResolvedValue({
      ...allowlist(),
      installationId: "123",
    });
    mocks.findWorkspaceGithubIntegrationByInstallation.mockResolvedValue(
      workspaceIntegration({ connectionId: "conn-workspace", installationId: "123" }),
    );
    mocks.getNangoClient().proxy.mockImplementation(async ({ endpoint }: { endpoint: string }) => {
      if (endpoint.endsWith("/pulls/1495")) {
        throw {
          response: {
            status: 404,
            data: { message: "Not Found" },
            headers: {},
          },
        };
      }
      return { status: 200, data: { id: 1 } };
    });

    await expect(readGithubProxyPullRequest({
      userId: "user-1",
      workspaceId: "workspace-1",
      owner: "AgentWorkforce",
      repo: "cloud",
      pullNumber: 1495,
    })).rejects.toMatchObject({
      code: "github_api_error",
      status: 404,
    });
  });
});
