import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  and: vi.fn(),
  eq: vi.fn(),
  resolveRequestAuth: vi.fn(),
  requireSessionAuth: vi.fn(),
  requireAuthScope: vi.fn(),
  getDb: vi.fn(),
  hasWorkspaceAccess: vi.fn(),
  recordWorkflowInvocation: vi.fn(),
  buildCredentialBundle: vi.fn(),
  launchOrchestratorSandbox: vi.fn(),
  mintScopedS3Credentials: vi.fn(),
  getCliCredentials: vi.fn(),
  listConnectedProviders: vi.fn(),
  workflowNeedsCliCredentials: vi.fn(),
  getAllProviders: vi.fn(),
  workflowStoreCreate: vi.fn(),
  getBrokerKeySecret: vi.fn(),
  resolveServerDaytonaAuthParams: vi.fn(),
  attachSandboxToApiTokenSession: vi.fn(),
  createApiTokenSession: vi.fn(),
  revokeApiTokenSessionById: vi.fn(),
  toAbsoluteAppUrl: vi.fn(),
  deriveInteractive: vi.fn(),
  resolveRelayfileConfig: vi.fn(),
  ensureRelayWorkspace: vi.fn(),
  runWorkerAssignmentMaintenance: vi.fn(),
  enqueueForWorker: vi.fn(),
  resolveRelayApiKeyForWorkspace: vi.fn(),
  resolveOrProvisionRelayWorkspace: vi.fn(),
  workerRegistrySelect: vi.fn(),
  packageWorkflowRef: vi.fn(),
  resolveRelaycastUrl: vi.fn(),
  resolveRepoAllowlistOrRelaxed: vi.fn(),
}));

vi.mock("sst", () => ({
  Resource: {
    CredentialEncryptionKey: { value: "cred-key" },
    WorkflowStorage: {
      stsRoleArn: "arn:aws:iam::123456789012:role/workflow-storage",
      bucketName: "workflow-bucket",
    },
  },
}));

vi.mock("drizzle-orm", () => ({
  and: mocks.and,
  eq: mocks.eq,
}));

vi.mock("@cloud/core/relayfile/client.js", () => ({
  mintRelayfileToken: vi.fn(async () => "relayfile-token"),
}));

vi.mock("@cloud/core/bootstrap/launcher.js", () => ({
  deriveInteractive: (...args: unknown[]) => mocks.deriveInteractive(...args),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: (...args: unknown[]) => mocks.resolveRequestAuth(...args),
  requireSessionAuth: (...args: unknown[]) => mocks.requireSessionAuth(...args),
  requireAuthScope: (...args: unknown[]) => mocks.requireAuthScope(...args),
}));

vi.mock("@/lib/auth/secrets", () => ({
  getBrokerKeySecret: (...args: unknown[]) => mocks.getBrokerKeySecret(...args),
}));

vi.mock("@/lib/daytona-auth", () => ({
  resolveServerDaytonaAuthParams: (...args: unknown[]) =>
    mocks.resolveServerDaytonaAuthParams(...args),
}));

vi.mock("@/lib/auth/api-token-store", () => ({
  attachSandboxToApiTokenSession: (...args: unknown[]) =>
    mocks.attachSandboxToApiTokenSession(...args),
  createApiTokenSession: (...args: unknown[]) =>
    mocks.createApiTokenSession(...args),
  revokeApiTokenSessionById: (...args: unknown[]) =>
    mocks.revokeApiTokenSessionById(...args),
}));

vi.mock("@/lib/app-path", () => ({
  toAbsoluteAppUrl: (...args: unknown[]) => mocks.toAbsoluteAppUrl(...args),
}));

vi.mock("@/lib/db", () => ({
  getDb: (...args: unknown[]) => mocks.getDb(...args),
}));

vi.mock("@/lib/db/schema", () => ({
  agents: {
    id: "agents.id",
    workspaceId: "agents.workspace_id",
    deployedByUserId: "agents.deployed_by_user_id",
  },
  sandboxes: {},
  workspaces: {
    id: "workspaces.id",
    defaultRuntime: "workspaces.defaultRuntime",
  },
}));

vi.mock("@/lib/env", () => ({
  optionalEnv: vi.fn(() => ""),
}));

vi.mock("@/lib/integrations/integration-route-handler", () => ({
  hasWorkspaceAccess: (...args: unknown[]) => mocks.hasWorkspaceAccess(...args),
}));

vi.mock("@/lib/integrations/workflow-repository-allowlists", () => ({
  resolveRepoAllowlistOrRelaxed: (...args: unknown[]) =>
    mocks.resolveRepoAllowlistOrRelaxed(...args),
}));

vi.mock("@/lib/relayfile", () => ({
  resolveRelayfileConfig: (...args: unknown[]) =>
    mocks.resolveRelayfileConfig(...args),
}));

vi.mock("@/lib/relay-workspaces", () => ({
  ensureRelayWorkspace: (...args: unknown[]) =>
    mocks.ensureRelayWorkspace(...args),
}));

vi.mock("@/lib/workers/assignments", () => ({
  enqueueForWorker: (...args: unknown[]) => mocks.enqueueForWorker(...args),
  runWorkerAssignmentMaintenance: (...args: unknown[]) =>
    mocks.runWorkerAssignmentMaintenance(...args),
}));

vi.mock("@/lib/workers/registry", () => ({
  WorkerRegistry: vi.fn(function () {
    return {
      select: (...args: unknown[]) => mocks.workerRegistrySelect(...args),
    };
  }),
}));

vi.mock("@/lib/workers/workflow-ref", () => ({
  packageWorkflowRef: (...args: unknown[]) => mocks.packageWorkflowRef(...args),
}));

vi.mock("@/lib/aws/sts-credentials", () => ({
  mintScopedS3Credentials: (...args: unknown[]) =>
    mocks.mintScopedS3Credentials(...args),
}));

vi.mock("@/lib/workflows", () => ({
  buildCredentialBundle: (...args: unknown[]) =>
    mocks.buildCredentialBundle(...args),
  launchOrchestratorSandbox: (...args: unknown[]) =>
    mocks.launchOrchestratorSandbox(...args),
  getCliCredentials: (...args: unknown[]) => mocks.getCliCredentials(...args),
  listConnectedProviders: (...args: unknown[]) =>
    mocks.listConnectedProviders(...args),
  resolveCredentialProxyConfig: vi.fn(() => ({})),
  workflowNeedsCliCredentials: (...args: unknown[]) =>
    mocks.workflowNeedsCliCredentials(...args),
  getAllProviders: (...args: unknown[]) => mocks.getAllProviders(...args),
  workflowStore: {
    create: (...args: unknown[]) => mocks.workflowStoreCreate(...args),
  },
}));

vi.mock("@/lib/workflows/relay-api-key", () => ({
  resolveRelayApiKeyForWorkspace: (...args: unknown[]) =>
    mocks.resolveRelayApiKeyForWorkspace(...args),
}));

vi.mock("@/lib/workflows/relay-workspace", () => ({
  resolveOrProvisionRelayWorkspace: (...args: unknown[]) =>
    mocks.resolveOrProvisionRelayWorkspace(...args),
}));

vi.mock("@/lib/workspace-registry", () => ({
  resolveRelaycastUrl: (...args: unknown[]) => mocks.resolveRelaycastUrl(...args),
}));

vi.mock("../workflow-invocation-audit", () => ({
  recordWorkflowInvocation: (...args: unknown[]) =>
    mocks.recordWorkflowInvocation(...args),
}));

import { POST } from "./route";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000002";

function request(body: unknown): NextRequest {
  return new NextRequest(
    `https://cloud.test/api/v1/workspaces/${WORKSPACE_ID}/workflows/run`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer sandbox-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

function context() {
  return { params: Promise.resolve({ workspaceId: WORKSPACE_ID }) };
}

describe("workspace workflow invocation integration", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    const auth = {
      userId: "00000000-0000-0000-0000-000000000001",
      workspaceId: WORKSPACE_ID,
      organizationId: "00000000-0000-0000-0000-000000000003",
      source: "token" as const,
      subjectType: "sandbox" as const,
      scopes: ["workflow:invoke:write"],
    };
    mocks.resolveRequestAuth.mockResolvedValue(auth);
    mocks.requireSessionAuth.mockReturnValue(false);
    mocks.requireAuthScope.mockImplementation(
      (candidateAuth: { scopes?: string[] } | null, scope: string) =>
        Boolean(candidateAuth?.scopes?.includes(scope)),
    );
    mocks.hasWorkspaceAccess.mockReturnValue(true);

    const insertValues = vi.fn().mockResolvedValue(undefined);
    mocks.getDb.mockReturnValue({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              { defaultRuntime: { id: "daytona" } },
            ]),
          }),
        }),
      }),
      insert: vi.fn(() => ({ values: insertValues })),
    });

    mocks.workflowNeedsCliCredentials.mockReturnValue(false);
    mocks.listConnectedProviders.mockResolvedValue(["openai"]);
    mocks.getCliCredentials.mockResolvedValue("OPENAI_API_KEY=test-key");
    mocks.resolveRelayfileConfig.mockReturnValue({
      relayfileUrl: "https://relayfile.test",
      relayJwtSecret: "relay-jwt-secret",
      relayAuthUrl: "https://api.relayauth.test",
      relayAuthApiKey: "relayauth-api-key",
    });
    mocks.createApiTokenSession.mockResolvedValue({
      sessionId: "session_123",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      accessTokenExpiresAt: "2026-05-13T12:00:00.000Z",
    });
    mocks.mintScopedS3Credentials.mockResolvedValue({
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "secret",
      sessionToken: "session-token",
      bucket: "workflow-bucket",
      prefix: "user-123/run-123",
    });
    mocks.resolveServerDaytonaAuthParams.mockReturnValue({
      daytonaApiKey: "daytona-key",
    });
    mocks.resolveOrProvisionRelayWorkspace.mockResolvedValue({
      id: "rw_12345678",
      relaycastApiKey: "rk_live_workspace",
      provisioned: false,
    });
    mocks.ensureRelayWorkspace.mockResolvedValue(undefined);
    mocks.buildCredentialBundle.mockImplementation((input: unknown) => input);
    mocks.launchOrchestratorSandbox.mockResolvedValue({
      sandboxId: "sandbox_123",
    });
    mocks.workflowStoreCreate.mockResolvedValue({});
    mocks.attachSandboxToApiTokenSession.mockResolvedValue(undefined);
    mocks.getBrokerKeySecret.mockReturnValue("broker-secret");
    mocks.toAbsoluteAppUrl.mockImplementation(
      (origin: string, pathname: string) => new URL(pathname, origin),
    );
    mocks.resolveRelaycastUrl.mockReturnValue("https://api.relaycast.test");
    mocks.deriveInteractive.mockReturnValue(false);
  });

  it("runs MCP-style echo invocations through the real heavy route and returns a runId instead of 501", async () => {
    const response = await POST(
      request({ name: "echo", args: { foo: 1 } }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(response.status).not.toBe(501);
    await expect(response.json()).resolves.toMatchObject({
      runId: expect.any(String),
      sandboxId: "sandbox_123",
      status: "pending",
    });
    expect(mocks.launchOrchestratorSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        s3CodeKey: "workflows/echo/latest.tar.gz",
        workflowPath: "workflow.ts",
        workflowFileContent: expect.stringContaining("args: invocationArgs"),
        fileType: "typescript",
        workflowFileName: "workflow.ts",
        metadata: {
          invocationSlug: "echo",
          invocationArgs: JSON.stringify({ foo: 1 }),
        },
      }),
    );
    expect(mocks.recordWorkflowInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        slug: "echo",
        runId: expect.any(String),
        requester: "00000000-0000-0000-0000-000000000001",
        outcome: "accepted",
      }),
    );
  });
});
