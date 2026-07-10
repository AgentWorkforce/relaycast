// Route contract tests for POST
// /api/v1/workspaces/[workspaceId]/integrations/github/reconcile
// (org-reconcile PR1, guided-authorize design — pure detection).
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  resolveWorkspaceIntegrationIdentity: vi.fn(),
  hasWorkspaceIntegrationAccess: vi.fn(),
  resolveGithubIdentityConnection: vi.fn(),
  fetchGithubIdentityOrgs: vi.fn(),
  findGithubInstallationsByAccountLogins: vi.fn(),
  getWorkspaceIntegrationByProviderAlias: vi.fn(),
  loggerWarn: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body: unknown, init?: ResponseInit) {
      return Response.json(body, init);
    },
  },
}));

vi.mock("../packages/web/lib/auth/request-auth", () => ({
  resolveRequestAuth: mocks.resolveRequestAuth,
}));

vi.mock("../packages/web/lib/workspaces/workspace-integration-identity", () => ({
  resolveWorkspaceIntegrationIdentity: mocks.resolveWorkspaceIntegrationIdentity,
  hasWorkspaceIntegrationAccess: mocks.hasWorkspaceIntegrationAccess,
}));

vi.mock("../packages/web/lib/integrations/github-oauth-identity", () => ({
  resolveGithubIdentityConnection: mocks.resolveGithubIdentityConnection,
  fetchGithubIdentityOrgs: mocks.fetchGithubIdentityOrgs,
  findGithubInstallationsByAccountLogins: mocks.findGithubInstallationsByAccountLogins,
}));

vi.mock("../packages/web/lib/integrations/workspace-integrations", () => ({
  getWorkspaceIntegrationByProviderAlias: mocks.getWorkspaceIntegrationByProviderAlias,
}));

vi.mock("../packages/web/lib/logger", () => ({
  logger: {
    debug: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
    info: vi.fn().mockResolvedValue(undefined),
    warn: mocks.loggerWarn,
  },
}));

import { POST } from "../packages/web/app/api/v1/workspaces/[workspaceId]/integrations/github/reconcile/route";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

function makeRequest(body?: unknown): Request {
  return new Request("http://localhost/api/v1/workspaces/ws/integrations/github/reconcile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
}

function routeContext() {
  return { params: Promise.resolve({ workspaceId: WORKSPACE_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveRequestAuth.mockResolvedValue({ userId: "user-1", source: "session" });
  mocks.resolveWorkspaceIntegrationIdentity.mockResolvedValue({
    relayWorkspaceId: WORKSPACE_ID,
  });
  mocks.hasWorkspaceIntegrationAccess.mockReturnValue(true);
  mocks.resolveGithubIdentityConnection.mockResolvedValue({ connectionId: "conn-identity" });
  mocks.fetchGithubIdentityOrgs.mockResolvedValue({
    userLogin: "octocat",
    candidateLogins: ["octocat", "acmeorg"],
    orgCount: 1,
  });
  mocks.findGithubInstallationsByAccountLogins.mockResolvedValue([]);
  mocks.getWorkspaceIntegrationByProviderAlias.mockResolvedValue(null);
});

describe("POST github/reconcile", () => {
  it("401s without auth", async () => {
    mocks.resolveRequestAuth.mockResolvedValue(null);
    const response = await POST(makeRequest() as never, routeContext() as never);
    expect(response.status).toBe(401);
  });

  it("403s machine tokens with no user identity (org membership is user-private)", async () => {
    mocks.resolveRequestAuth.mockResolvedValue({ userId: "", source: "token" });
    const response = await POST(makeRequest() as never, routeContext() as never);
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("user_identity_required");
  });

  it("403s without workspace access", async () => {
    mocks.hasWorkspaceIntegrationAccess.mockReturnValue(false);
    const response = await POST(makeRequest() as never, routeContext() as never);
    expect(response.status).toBe(403);
  });

  it("409 oauth_required when the caller has no github-oauth identity connection", async () => {
    mocks.resolveGithubIdentityConnection.mockResolvedValue(null);
    const response = await POST(makeRequest() as never, routeContext() as never);
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("oauth_required");
  });

  it("rejects a foreign oauthConnectionId via the ownership check", async () => {
    mocks.resolveGithubIdentityConnection.mockResolvedValue(null);
    const response = await POST(
      makeRequest({ oauthConnectionId: "someone-elses-conn" }) as never,
      routeContext() as never,
    );
    expect(response.status).toBe(409);
    expect(mocks.resolveGithubIdentityConnection).toHaveBeenCalledWith(
      "user-1",
      "someone-elses-conn",
    );
  });

  it("502 org_listing_failed when the GitHub org listing fails", async () => {
    mocks.fetchGithubIdentityOrgs.mockRejectedValue(new Error("nango proxy 500"));
    const response = await POST(makeRequest() as never, routeContext() as never);
    expect(response.status).toBe(502);
    expect((await response.json()).code).toBe("org_listing_failed");
  });

  it("returns detection matches with suspended surfaced and the github-relay fallthrough", async () => {
    mocks.findGithubInstallationsByAccountLogins.mockResolvedValue([
      {
        installationId: "9001",
        accountLogin: "AcmeOrg",
        accountType: "Organization",
        suspended: false,
      },
      {
        installationId: "9002",
        accountLogin: "SuspendedOrg",
        accountType: "Organization",
        suspended: true,
      },
    ]);

    const response = await POST(makeRequest() as never, routeContext() as never);
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.userLogin).toBe("octocat");
    expect(body.orgCount).toBe(1);
    expect(body.fallthrough).toBe("github-relay");
    expect(body.workspaceHasGithub).toBe(false);
    expect(body.matches).toEqual([
      {
        installationId: "9001",
        accountLogin: "AcmeOrg",
        accountType: "Organization",
        suspended: false,
        alreadyConnected: false,
      },
      {
        installationId: "9002",
        accountLogin: "SuspendedOrg",
        accountType: "Organization",
        suspended: true,
        alreadyConnected: false,
      },
    ]);
    // Detection-only contract: no connection internals leak to clients.
    expect(JSON.stringify(body)).not.toContain("connectionId");
    expect(JSON.stringify(body)).not.toContain("providerConfigKey");
    // Matching used the user's own identity connection.
    expect(mocks.fetchGithubIdentityOrgs).toHaveBeenCalledWith("conn-identity");
    expect(mocks.findGithubInstallationsByAccountLogins).toHaveBeenCalledWith([
      "octocat",
      "acmeorg",
    ]);
  });

  it("zero matches is a 200 with an empty list (client falls through), not an error", async () => {
    const response = await POST(makeRequest() as never, routeContext() as never);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.matches).toEqual([]);
    expect(body.fallthrough).toBe("github-relay");
  });

  it("marks alreadyConnected when the workspace's github row holds the matched installation", async () => {
    mocks.getWorkspaceIntegrationByProviderAlias.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      provider: "github",
      connectionId: "conn-own",
      providerConfigKey: "github-relay",
      installationId: "9001",
      metadata: {},
    });
    mocks.findGithubInstallationsByAccountLogins.mockResolvedValue([
      {
        installationId: "9001",
        accountLogin: "AcmeOrg",
        accountType: "Organization",
        suspended: false,
      },
    ]);

    const response = await POST(makeRequest() as never, routeContext() as never);
    const body = await response.json();
    expect(body.workspaceHasGithub).toBe(true);
    expect(body.matches[0].alreadyConnected).toBe(true);
  });
});
