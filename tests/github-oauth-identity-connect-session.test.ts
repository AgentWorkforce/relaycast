// connect-session contract for the github-oauth-relay user-identity connect
// (org-reconcile PR1): deployer_user-forced, exclusive, persisted ONLY as a
// user_integrations row under the github-oauth provider.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  resolveWorkspaceIntegrationIdentity: vi.fn(),
  hasWorkspaceIntegrationAccess: vi.fn(),
  createSetupSession: vi.fn(),
  getIntegrationBackend: vi.fn(),
  selectIntegrationBackend: vi.fn(),
  insertUserIntegrationIfAbsent: vi.fn(),
  insertWorkspaceIntegrationIfAbsent: vi.fn(),
  isGithubInstallationCentricEnabled: vi.fn(),
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

vi.mock("../packages/web/lib/integrations/backend", () => ({
  BackendPolicyError: class BackendPolicyError extends Error {
    code: string;
    backend?: string;
    constructor(code: string, message: string, backend?: string) {
      super(message);
      this.code = code;
      this.backend = backend;
    }
  },
  getIntegrationBackend: mocks.getIntegrationBackend,
  selectIntegrationBackend: mocks.selectIntegrationBackend,
}));

vi.mock("../packages/web/lib/integrations/user-integrations", () => ({
  insertUserIntegrationIfAbsent: mocks.insertUserIntegrationIfAbsent,
}));

vi.mock("../packages/web/lib/integrations/workspace-integrations", () => ({
  insertWorkspaceIntegrationIfAbsent: mocks.insertWorkspaceIntegrationIfAbsent,
}));

vi.mock("../packages/web/lib/integrations/github-installation-centric-flag", () => ({
  isGithubInstallationCentricEnabled: mocks.isGithubInstallationCentricEnabled,
}));

vi.mock("../packages/web/lib/logger", () => ({
  logger: {
    debug: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
    info: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../packages/web/lib/app-origin", () => ({
  getConfiguredAppOrigin: vi.fn().mockReturnValue("https://example.test"),
}));

import { POST } from "../packages/web/app/api/v1/workspaces/[workspaceId]/integrations/connect-session/route";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/v1/workspaces/ws/integrations/connect-session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function routeContext() {
  return { params: Promise.resolve({ workspaceId: WORKSPACE_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveRequestAuth.mockResolvedValue({
    userId: "user-1",
    source: "session",
    context: { user: { email: "dev@example.test" } },
  });
  mocks.resolveWorkspaceIntegrationIdentity.mockResolvedValue({
    relayWorkspaceId: WORKSPACE_ID,
  });
  mocks.hasWorkspaceIntegrationAccess.mockReturnValue(true);
  mocks.createSetupSession.mockResolvedValue({
    connectLink: "https://nango.test/connect",
    sessionToken: "session-token",
    connectionId: "conn-identity-new",
  });
  mocks.getIntegrationBackend.mockReturnValue({
    createSetupSession: mocks.createSetupSession,
  });
  mocks.insertUserIntegrationIfAbsent.mockResolvedValue({ inserted: true });
  mocks.insertWorkspaceIntegrationIfAbsent.mockResolvedValue({ inserted: true });
  mocks.isGithubInstallationCentricEnabled.mockReturnValue(false);
});

describe("connect-session github-oauth-relay (user identity)", () => {
  it("creates a Nango session + pre-creates ONLY the github-oauth user row under deployer_user scope", async () => {
    const response = await POST(
      makeRequest({
        allowedIntegrations: ["github-oauth-relay"],
        scope: { kind: "deployer_user" },
      }) as never,
      routeContext() as never,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.backend).toBe("nango");
    expect(body.backendIntegrationId).toBe("github-oauth-relay");
    expect(body.providers).toEqual([
      expect.objectContaining({
        id: "github-oauth",
        providerConfigKey: "github-oauth-relay",
        backendIntegrationId: "github-oauth-relay",
      }),
    ]);

    const sessionArgs = mocks.createSetupSession.mock.calls[0][0];
    expect(sessionArgs.allowedIntegrations).toEqual([
      expect.objectContaining({
        provider: "github-oauth",
        backendIntegrationId: "github-oauth-relay",
      }),
    ]);
    // Scope tags carry deployer_user + the user id for the auth webhook.
    expect(sessionArgs.metadata).toMatchObject({
      relayfile_integration_scope_kind: "deployer_user",
      relayfile_integration_user_id: "user-1",
    });

    expect(mocks.insertUserIntegrationIfAbsent).toHaveBeenCalledTimes(1);
    expect(mocks.insertUserIntegrationIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        provider: "github-oauth",
        connectionId: "conn-identity-new",
        providerConfigKey: "github-oauth-relay",
      }),
    );
    // Never a workspace integration.
    expect(mocks.insertWorkspaceIntegrationIfAbsent).not.toHaveBeenCalled();
  });

  it("400s user_identity_scope_required for workspace scope", async () => {
    const response = await POST(
      makeRequest({ allowedIntegrations: ["github-oauth-relay"] }) as never,
      routeContext() as never,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("user_identity_scope_required");
    expect(mocks.createSetupSession).not.toHaveBeenCalled();
  });

  it("400s user_identity_exclusive when mixed with workspace integrations", async () => {
    const response = await POST(
      makeRequest({
        allowedIntegrations: ["github-oauth-relay", "github"],
        scope: { kind: "deployer_user" },
      }) as never,
      routeContext() as never,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("user_identity_exclusive");
    expect(mocks.createSetupSession).not.toHaveBeenCalled();
  });

  it("control: a plain github connect still selects the workspace backend policy", async () => {
    mocks.selectIntegrationBackend.mockReturnValue({
      backend: "nango",
      backendIntegrationId: "github-relay",
    });
    const response = await POST(
      makeRequest({ allowedIntegrations: ["github"] }) as never,
      routeContext() as never,
    );
    expect(response.status).toBe(200);
    expect(mocks.selectIntegrationBackend).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "github" }),
    );
    // Workspace-scope github pre-creates a workspace row, not a user row.
    expect(mocks.insertWorkspaceIntegrationIfAbsent).toHaveBeenCalled();
    expect(mocks.insertUserIntegrationIfAbsent).not.toHaveBeenCalled();
  });
});
