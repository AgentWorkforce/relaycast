import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class GithubArchiveLeaseError extends Error {
    readonly stage:
      | "github_app_token_resolve"
      | "ref_resolve_failed"
      | "github_tarball_redirect";
    readonly upstreamStatus?: number;
    constructor(
      message: string,
      stage:
        | "github_app_token_resolve"
        | "ref_resolve_failed"
        | "github_tarball_redirect",
      upstreamStatus?: number,
    ) {
      super(message);
      this.name = "GithubArchiveLeaseError";
      this.stage = stage;
      this.upstreamStatus = upstreamStatus;
    }
  }
  return {
    resolveRequestAuth: vi.fn(),
    requireAuthScope: vi.fn(),
    canAccessWorkflowRun: vi.fn(),
    workflowStore: {
      get: vi.fn(),
    },
    getNangoClient: vi.fn(),
    getNangoSecretKey: vi.fn(),
    getProviderConfigKey: vi.fn(),
    isWorkspaceIntegrationProvider: vi.fn(),
    listWorkspaceIntegrationsByProviderAlias: vi.fn(),
    isGithubInstallationCentricEnabled: vi.fn(),
    resolveGithubConnectionForWorkspace: vi.fn(),
    nangoClient: {
      getToken: vi.fn(),
      proxy: vi.fn(),
    },
    mintGithubArchiveCodeloadUrl: vi.fn(),
    resolveGithubRefToSha: vi.fn(),
    GithubArchiveLeaseError,
  };
});

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: mocks.resolveRequestAuth,
  requireAuthScope: mocks.requireAuthScope,
  canAccessWorkflowRun: mocks.canAccessWorkflowRun,
}));

vi.mock("@/lib/workflows", () => ({
  workflowStore: mocks.workflowStore,
}));

vi.mock("@/lib/integrations/github-archive-lease", () => ({
  GITHUB_CODELOAD_TTL_MS: 5 * 60 * 1000,
  GithubArchiveLeaseError: mocks.GithubArchiveLeaseError,
  mintGithubArchiveCodeloadUrl: mocks.mintGithubArchiveCodeloadUrl,
  resolveGithubRefToSha: mocks.resolveGithubRefToSha,
}));

vi.mock("@/lib/integrations/nango-service", () => ({
  getNangoClient: mocks.getNangoClient,
  getNangoSecretKey: mocks.getNangoSecretKey,
  getProviderConfigKey: mocks.getProviderConfigKey,
}));

vi.mock("@/lib/integrations/providers", () => ({
  isWorkspaceIntegrationProvider: mocks.isWorkspaceIntegrationProvider,
}));

vi.mock("@/lib/integrations/workspace-integrations", () => ({
  listWorkspaceIntegrationsByProviderAlias:
    mocks.listWorkspaceIntegrationsByProviderAlias,
}));

vi.mock("@/lib/integrations/github-installation-centric-flag", () => ({
  isGithubInstallationCentricEnabled: mocks.isGithubInstallationCentricEnabled,
}));

vi.mock("@/lib/integrations/github-installation-connection", () => ({
  resolveGithubConnectionForWorkspace: mocks.resolveGithubConnectionForWorkspace,
}));

import { POST } from "./route";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000002";
const RUN_ID = "11111111-1111-1111-1111-111111111111";
const OWNER = "owner";
const REPO = "repo";
const HEAD_SHA = "abc123def4567890abc123def4567890abc123de";
const RESOLVED_SHA = "def4567890abc123def4567890abc123def45678";
const SECRET_TOKEN = "ghs_FAKE_TOKEN_DO_NOT_LEAK_42";
const CODELOAD_URL =
  "https://codeload.github.com/owner/repo/legacy.tar.gz/refs/heads/main?token=opaque";
const EXPIRES_AT = "2026-01-01T00:05:00.000Z";

const auth = {
  userId: "00000000-0000-0000-0000-000000000001",
  workspaceId: WORKSPACE_ID,
  organizationId: "00000000-0000-0000-0000-000000000003",
  source: "token" as const,
  scopes: ["workflow:runs:read"],
};

function request(
  bodyOverride?: unknown,
  options: { rawBody?: string } = {},
): NextRequest {
  const body =
    options.rawBody !== undefined
      ? options.rawBody
      : JSON.stringify(
          bodyOverride ?? { owner: OWNER, repo: REPO, headSha: HEAD_SHA },
        );
  return new NextRequest(
    `https://cloud.test/api/v1/workflows/runs/${RUN_ID}/clone/archive-lease`,
    {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
    },
  );
}

function context() {
  return {
    params: Promise.resolve({ runId: RUN_ID }),
  };
}

function buildRun(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    runId: RUN_ID,
    workspaceId: WORKSPACE_ID,
    userId: auth.userId,
    status: "running",
    ...overrides,
  };
}

function buildIntegration(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    workspaceId: WORKSPACE_ID,
    provider: "github",
    name: null,
    connectionId: "conn-github",
    providerConfigKey: "github-relay",
    metadata: {},
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("POST /api/v1/workflows/runs/:runId/clone/archive-lease", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveRequestAuth.mockResolvedValue(auth);
    mocks.requireAuthScope.mockReturnValue(true);
    mocks.canAccessWorkflowRun.mockReturnValue(true);
    mocks.workflowStore.get.mockResolvedValue(buildRun());
    mocks.getNangoClient.mockReturnValue(mocks.nangoClient);
    mocks.getNangoSecretKey.mockReturnValue("nango-secret");
    mocks.getProviderConfigKey.mockReturnValue("github-relay");
    mocks.isWorkspaceIntegrationProvider.mockReturnValue(true);
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([
      buildIntegration(),
    ]);
    mocks.isGithubInstallationCentricEnabled.mockReturnValue(false);
    mocks.resolveGithubConnectionForWorkspace.mockResolvedValue({
      installationId: "inst-123",
      connectionId: "conn-installation",
      providerConfigKey: "github-relay",
      accountLogin: "owner",
      accountType: "Organization",
      repositorySelection: "selected",
      suspended: false,
      source: "org-installation",
    });
    mocks.nangoClient.proxy.mockResolvedValue({ status: 200 });
    mocks.nangoClient.getToken.mockResolvedValue(SECRET_TOKEN);
    mocks.resolveGithubRefToSha.mockResolvedValue(RESOLVED_SHA);
    mocks.mintGithubArchiveCodeloadUrl.mockResolvedValue({
      url: CODELOAD_URL,
      expiresAt: EXPIRES_AT,
      sha: HEAD_SHA,
    });
  });

  it("401 unauthorized when bearer missing", async () => {
    mocks.resolveRequestAuth.mockResolvedValue(null);
    const response = await POST(request(), context());
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "unauthorized",
    });
    expect(mocks.workflowStore.get).not.toHaveBeenCalled();
  });

  it("403 forbidden when scope missing", async () => {
    mocks.requireAuthScope.mockReturnValue(false);
    const response = await POST(request(), context());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(mocks.requireAuthScope).toHaveBeenCalledWith(
      auth,
      "workflow:runs:read",
    );
    expect(mocks.workflowStore.get).not.toHaveBeenCalled();
  });

  it("404 run_not_found when canAccessWorkflowRun returns false", async () => {
    mocks.canAccessWorkflowRun.mockReturnValue(false);
    const response = await POST(request(), context());
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "run_not_found",
    });
    expect(mocks.getNangoClient).not.toHaveBeenCalled();
  });

  it("404 run_not_found when workflowStore.get returns null", async () => {
    mocks.workflowStore.get.mockResolvedValue(null);
    const response = await POST(request(), context());
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "run_not_found",
    });
    expect(mocks.canAccessWorkflowRun).not.toHaveBeenCalled();
  });

  it("400 invalid_body when owner missing", async () => {
    const response = await POST(
      request({ repo: REPO, headSha: HEAD_SHA }),
      context(),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "invalid_body",
    });
    expect(mocks.getNangoClient).not.toHaveBeenCalled();
  });

  it("400 invalid_body when repo missing", async () => {
    const response = await POST(
      request({ owner: OWNER, headSha: HEAD_SHA }),
      context(),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "invalid_body",
    });
    expect(mocks.getNangoClient).not.toHaveBeenCalled();
  });

  it("200 success defaults omitted ref/headSha to HEAD and echoes the resolved sha", async () => {
    mocks.mintGithubArchiveCodeloadUrl.mockResolvedValue({
      url: CODELOAD_URL,
      expiresAt: EXPIRES_AT,
      sha: RESOLVED_SHA,
    });

    const response = await POST(
      request({ owner: OWNER, repo: REPO }),
      context(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      url: CODELOAD_URL,
      expiresAt: EXPIRES_AT,
      sha: RESOLVED_SHA,
    });
    expect(mocks.resolveGithubRefToSha).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      ref: "HEAD",
      installationToken: SECRET_TOKEN,
    });
    expect(mocks.mintGithubArchiveCodeloadUrl).toHaveBeenCalledWith(
      expect.objectContaining({ headSha: RESOLVED_SHA }),
    );
  });

  it.each([
    ["owner", { owner: "", repo: REPO, headSha: HEAD_SHA }],
    ["owner", { owner: "   ", repo: REPO, headSha: HEAD_SHA }],
    ["repo", { owner: OWNER, repo: "", headSha: HEAD_SHA }],
    ["repo", { owner: OWNER, repo: "   ", headSha: HEAD_SHA }],
    ["headSha", { owner: OWNER, repo: REPO, headSha: "" }],
    ["headSha", { owner: OWNER, repo: REPO, headSha: "   " }],
    ["ref", { owner: OWNER, repo: REPO, ref: "" }],
    ["ref", { owner: OWNER, repo: REPO, ref: "   " }],
  ])("400 invalid_body when %s is empty or whitespace", async (_field, body) => {
    const response = await POST(
      request(body),
      context(),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "invalid_body",
    });
    expect(mocks.getNangoClient).not.toHaveBeenCalled();
  });

  it("400 invalid_body when JSON parse fails", async () => {
    const response = await POST(
      request(undefined, { rawBody: "not-json{" }),
      context(),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "invalid_body",
    });
    expect(mocks.getNangoClient).not.toHaveBeenCalled();
  });

  it("502 github_token_unavailable when install-token resolver throws", async () => {
    mocks.nangoClient.getToken.mockRejectedValue(
      new Error("nango down"),
    );
    const response = await POST(request(), context());
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "github_token_unavailable",
      stage: "github_app_token_resolve",
    });
    expect(mocks.mintGithubArchiveCodeloadUrl).not.toHaveBeenCalled();
  });

  it("502 github_token_unavailable when install-token resolver returns empty", async () => {
    mocks.nangoClient.getToken.mockResolvedValue("");
    const response = await POST(request(), context());
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "github_token_unavailable",
      stage: "github_app_token_resolve",
    });
    expect(mocks.mintGithubArchiveCodeloadUrl).not.toHaveBeenCalled();
  });

  it("502 github_token_unavailable when install-token resolver returns null", async () => {
    mocks.nangoClient.getToken.mockResolvedValue(null);
    const response = await POST(request(), context());
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "github_token_unavailable",
      stage: "github_app_token_resolve",
    });
    expect(mocks.mintGithubArchiveCodeloadUrl).not.toHaveBeenCalled();
  });

  it("502 archive_lease_mint_failed when GithubArchiveLeaseError is thrown with status", async () => {
    mocks.mintGithubArchiveCodeloadUrl.mockRejectedValue(
      new mocks.GithubArchiveLeaseError(
        "github tarball endpoint did not redirect",
        "github_tarball_redirect",
        404,
      ),
    );
    const response = await POST(request(), context());
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "archive_lease_mint_failed",
      stage: "github_tarball_redirect",
      status: 404,
    });
  });

  it("502 github_token_unavailable when no GitHub workspace integration exists", async () => {
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([]);
    const response = await POST(request(), context());
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "github_token_unavailable",
      stage: "github_app_token_resolve",
    });
    expect(mocks.nangoClient.getToken).not.toHaveBeenCalled();
  });

  it("502 archive_lease_mint_failed when mint throws a non-GithubArchiveLeaseError", async () => {
    mocks.mintGithubArchiveCodeloadUrl.mockRejectedValue(
      new Error("connection reset"),
    );
    const response = await POST(request(), context());
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "archive_lease_mint_failed",
      stage: "github_tarball_redirect",
    });
  });

  it("502 ref_resolve_failed when ref resolution fails with upstream status", async () => {
    mocks.resolveGithubRefToSha.mockRejectedValue(
      new mocks.GithubArchiveLeaseError(
        "github ref resolve failed",
        "ref_resolve_failed",
        404,
      ),
    );
    const response = await POST(
      request({ owner: OWNER, repo: REPO, ref: "refs/heads/main" }),
      context(),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "ref_resolve_failed",
      stage: "ref_resolve_failed",
      status: 404,
    });
    expect(mocks.mintGithubArchiveCodeloadUrl).not.toHaveBeenCalled();
  });

  it("502 archive_lease_mint_failed when GitHub redirects without a codeload Location", async () => {
    mocks.mintGithubArchiveCodeloadUrl.mockRejectedValue(
      new mocks.GithubArchiveLeaseError(
        "github tarball redirect missing codeload Location",
        "github_tarball_redirect",
        302,
      ),
    );
    const response = await POST(request(), context());
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "archive_lease_mint_failed",
      stage: "github_tarball_redirect",
      status: 302,
    });
  });

  it("200 success returns { ok: true, url, expiresAt, sha }; response is JSON; body never contains the installation token literal", async () => {
    const response = await POST(request(), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    const text = await response.text();
    expect(text).not.toContain(SECRET_TOKEN);
    expect(JSON.parse(text)).toEqual({
      ok: true,
      url: CODELOAD_URL,
      expiresAt: EXPIRES_AT,
      sha: HEAD_SHA,
    });
  });

  it("200 success resolves explicit ref to a concrete sha and echoes it", async () => {
    mocks.mintGithubArchiveCodeloadUrl.mockResolvedValue({
      url: CODELOAD_URL,
      expiresAt: EXPIRES_AT,
      sha: RESOLVED_SHA,
    });

    const response = await POST(
      request({ owner: OWNER, repo: REPO, ref: "refs/heads/main" }),
      context(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      url: CODELOAD_URL,
      expiresAt: EXPIRES_AT,
      sha: RESOLVED_SHA,
    });
    expect(mocks.resolveGithubRefToSha).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      ref: "refs/heads/main",
      installationToken: SECRET_TOKEN,
    });
    expect(mocks.mintGithubArchiveCodeloadUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: OWNER,
        repo: REPO,
        headSha: RESOLVED_SHA,
        installationToken: SECRET_TOKEN,
      }),
    );
  });

  it("route uses canAccessWorkflowRun (workspace-identity resolver family)", async () => {
    const run = buildRun();
    mocks.workflowStore.get.mockResolvedValue(run);
    const response = await POST(request(), context());
    expect(response.status).toBe(200);
    expect(mocks.canAccessWorkflowRun).toHaveBeenCalledTimes(1);
    expect(mocks.canAccessWorkflowRun).toHaveBeenCalledWith(auth, run);
  });

  it("mint helper is called with { owner, repo, headSha, installationToken }", async () => {
    await POST(request(), context());
    expect(mocks.resolveGithubRefToSha).not.toHaveBeenCalled();
    expect(mocks.mintGithubArchiveCodeloadUrl).toHaveBeenCalledTimes(1);
    expect(mocks.mintGithubArchiveCodeloadUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: OWNER,
        repo: REPO,
        headSha: HEAD_SHA,
        installationToken: SECRET_TOKEN,
      }),
    );
  });

  it("install-token resolver uses workspace GitHub integration and app-token Nango call", async () => {
    await POST(request(), context());
    expect(mocks.listWorkspaceIntegrationsByProviderAlias).toHaveBeenCalledWith(
      WORKSPACE_ID,
      "github",
    );
    expect(mocks.nangoClient.proxy).toHaveBeenCalledWith({
      method: "GET",
      endpoint: "/repos/owner/repo",
      connectionId: "conn-github",
      providerConfigKey: "github-relay",
    });
    expect(mocks.nangoClient.getToken).toHaveBeenCalledWith(
      "github-relay",
      "conn-github",
      false,
      true,
    );
    expect(mocks.resolveGithubConnectionForWorkspace).not.toHaveBeenCalled();
  });

  it("install-token resolver uses the canonical installation connection when the flag is on", async () => {
    mocks.isGithubInstallationCentricEnabled.mockReturnValue(true);

    const response = await POST(request(), context());

    expect(response.status).toBe(200);
    expect(mocks.resolveGithubConnectionForWorkspace).toHaveBeenCalledWith(
      WORKSPACE_ID,
    );
    expect(mocks.listWorkspaceIntegrationsByProviderAlias).not.toHaveBeenCalled();
    expect(mocks.nangoClient.proxy).toHaveBeenCalledWith({
      method: "GET",
      endpoint: "/repos/owner/repo",
      connectionId: "conn-installation",
      providerConfigKey: "github-relay",
    });
    expect(mocks.nangoClient.getToken).toHaveBeenCalledWith(
      "github-relay",
      "conn-installation",
      false,
      true,
    );
  });

  it("selects the later workspace integration when the first cannot read the requested repo", async () => {
    const wrongIntegration = buildIntegration({
      connectionId: "conn-wrong-installation",
      providerConfigKey: "github-relay",
    });
    const readableIntegration = buildIntegration({
      connectionId: "conn-readable-installation",
      providerConfigKey: "github-ricky",
    });
    const readableToken = "ghs_READABLE_INSTALLATION_TOKEN";
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([
      wrongIntegration,
      readableIntegration,
    ]);
    mocks.nangoClient.proxy.mockImplementation(
      async ({ connectionId }: { connectionId: string }) => ({
        status: connectionId === "conn-readable-installation" ? 200 : 404,
      }),
    );
    mocks.nangoClient.getToken.mockImplementation(
      async (providerConfigKey: string, connectionId: string) => {
        if (
          providerConfigKey === "github-ricky" &&
          connectionId === "conn-readable-installation"
        ) {
          return readableToken;
        }
        throw new Error("wrong installation should not be minted");
      },
    );

    const response = await POST(request(), context());

    expect(response.status).toBe(200);
    expect(mocks.nangoClient.proxy).toHaveBeenNthCalledWith(1, {
      method: "GET",
      endpoint: "/repos/owner/repo",
      connectionId: "conn-wrong-installation",
      providerConfigKey: "github-relay",
    });
    expect(mocks.nangoClient.proxy).toHaveBeenNthCalledWith(2, {
      method: "GET",
      endpoint: "/repos/owner/repo",
      connectionId: "conn-readable-installation",
      providerConfigKey: "github-ricky",
    });
    expect(mocks.nangoClient.getToken).toHaveBeenCalledTimes(1);
    expect(mocks.nangoClient.getToken).toHaveBeenCalledWith(
      "github-ricky",
      "conn-readable-installation",
      false,
      true,
    );
    expect(mocks.mintGithubArchiveCodeloadUrl).toHaveBeenCalledWith(
      expect.objectContaining({ installationToken: readableToken }),
    );
  });

  it("502 github_token_unavailable when no workspace integration can read the requested repo", async () => {
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([
      buildIntegration({
        connectionId: "conn-no-access-1",
        providerConfigKey: "github-relay",
      }),
      buildIntegration({
        connectionId: "conn-no-access-2",
        providerConfigKey: "github-ricky",
      }),
    ]);
    mocks.nangoClient.proxy.mockImplementation(
      async ({ connectionId }: { connectionId: string }) => ({
        status: connectionId === "conn-no-access-1" ? 404 : 403,
      }),
    );

    const response = await POST(request(), context());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "github_token_unavailable",
      stage: "github_app_token_resolve",
    });
    expect(mocks.nangoClient.getToken).not.toHaveBeenCalled();
    expect(mocks.mintGithubArchiveCodeloadUrl).not.toHaveBeenCalled();
  });

  describe("token-leak guardrail", () => {
    const consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];

    afterEach(() => {
      for (const spy of consoleSpies) {
        spy.mockRestore();
      }
      consoleSpies.length = 0;
    });

    it("does not leak the installation token in body, headers, or logs", async () => {
      consoleSpies.push(
        vi.spyOn(console, "info").mockImplementation(() => {}),
        vi.spyOn(console, "warn").mockImplementation(() => {}),
        vi.spyOn(console, "error").mockImplementation(() => {}),
        vi.spyOn(console, "debug").mockImplementation(() => {}),
        vi.spyOn(console, "log").mockImplementation(() => {}),
      );

      const response = await POST(request(), context());
      expect(response.status).toBe(200);

      const text = await response.text();
      expect(text).not.toContain(SECRET_TOKEN);

      for (const [, value] of response.headers.entries()) {
        expect(value).not.toContain(SECRET_TOKEN);
      }

      for (const spy of consoleSpies) {
        expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET_TOKEN);
      }
    });
  });
});
