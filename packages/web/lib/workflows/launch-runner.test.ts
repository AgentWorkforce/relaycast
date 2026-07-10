import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowLaunchEnvelope } from "./launch-job-envelope";

const mocks = vi.hoisted(() => ({
  and: vi.fn(),
  eq: vi.fn(),
  deriveInteractive: vi.fn(),
  mintCredentialProxyToken: vi.fn(),
  resolveProxyProviderFromCredentialProvider: vi.fn(),
  buildCredentialBundle: vi.fn(),
  getAllProviders: vi.fn(),
  getCliCredentials: vi.fn(),
  launchOrchestratorSandbox: vi.fn(),
  listConnectedProviders: vi.fn(),
  resolveCredentialProxyConfig: vi.fn(),
  workflowNeedsCliCredentials: vi.fn(),
  mintScopedS3Credentials: vi.fn(),
  isWorkerRuntime: vi.fn(),
  buildCloudApiWorkflowStorageCredentials: vi.fn(),
  getWorkflowStorageBackend: vi.fn(),
  attachSandboxToApiTokenSession: vi.fn(),
  createApiTokenSession: vi.fn(),
  revokeApiTokenSessionById: vi.fn(),
  getBrokerKeySecret: vi.fn(),
  resolveServerDaytonaAuthParams: vi.fn(),
  getDb: vi.fn(),
  optionalEnv: vi.fn(),
  toAbsoluteAppUrl: vi.fn(),
  resolveRelayfileConfig: vi.fn(),
  ensureRelayWorkspace: vi.fn(),
  mintWorkflowGithubWriteToken: vi.fn(),
  resolveOrProvisionRelayWorkspace: vi.fn(),
  resolveRelaycastUrl: vi.fn(),
  dbInsert: vi.fn(),
  dbValues: vi.fn(),
}));

vi.mock("sst", () => ({
  Resource: {
    CredentialEncryptionKey: { value: "0".repeat(64) },
  },
}));

vi.mock("drizzle-orm", () => ({
  and: mocks.and,
  eq: mocks.eq,
}));

vi.mock("@cloud/core/bootstrap/launcher.js", () => ({
  deriveInteractive: mocks.deriveInteractive,
  WorkflowSandboxProvisioningPendingError: class WorkflowSandboxProvisioningPendingError extends Error {
    sandboxId: string;
    state?: string;
    constructor(sandboxId: string, state?: string) {
      super(`Workflow sandbox ${sandboxId} is still provisioning`);
      this.name = "WorkflowSandboxProvisioningPendingError";
      this.sandboxId = sandboxId;
      this.state = state;
    }
  },
}));

vi.mock("@cloud/core/auth/proxy-token.js", () => ({
  mintCredentialProxyToken: mocks.mintCredentialProxyToken,
  resolveProxyProviderFromCredentialProvider: mocks.resolveProxyProviderFromCredentialProvider,
}));

vi.mock("../workflows", () => ({
  buildCredentialBundle: mocks.buildCredentialBundle,
  getAllProviders: mocks.getAllProviders,
  getCliCredentials: mocks.getCliCredentials,
  launchOrchestratorSandbox: mocks.launchOrchestratorSandbox,
  listConnectedProviders: mocks.listConnectedProviders,
  resolveCredentialProxyConfig: mocks.resolveCredentialProxyConfig,
  workflowNeedsCliCredentials: mocks.workflowNeedsCliCredentials,
}));

vi.mock("../aws/sts-credentials", () => ({
  mintScopedS3Credentials: mocks.mintScopedS3Credentials,
}));

vi.mock("../aws/runtime", () => ({
  isWorkerRuntime: mocks.isWorkerRuntime,
}));

vi.mock("../storage", () => ({
  buildCloudApiWorkflowStorageCredentials: mocks.buildCloudApiWorkflowStorageCredentials,
  getWorkflowStorageBackend: mocks.getWorkflowStorageBackend,
}));

vi.mock("../auth/api-token-store", () => ({
  attachSandboxToApiTokenSession: mocks.attachSandboxToApiTokenSession,
  createApiTokenSession: mocks.createApiTokenSession,
  revokeApiTokenSessionById: mocks.revokeApiTokenSessionById,
}));

vi.mock("../auth/secrets", () => ({
  getBrokerKeySecret: mocks.getBrokerKeySecret,
}));

vi.mock("../daytona-auth", () => ({
  resolveServerDaytonaAuthParams: mocks.resolveServerDaytonaAuthParams,
}));

vi.mock("../db", () => ({
  getDb: mocks.getDb,
}));

vi.mock("../db/schema", () => ({
  agents: { id: "agents.id", workspaceId: "agents.workspaceId", deployedName: "agents.deployedName" },
  sandboxes: { id: "sandboxes.id" },
  workspaces: { id: "workspaces.id" },
}));

vi.mock("../env", () => ({
  optionalEnv: mocks.optionalEnv,
}));

vi.mock("../app-path", () => ({
  toAbsoluteAppUrl: mocks.toAbsoluteAppUrl,
}));

vi.mock("../relayfile", () => ({
  resolveRelayfileConfig: mocks.resolveRelayfileConfig,
}));

vi.mock("../relay-workspaces", () => ({
  ensureRelayWorkspace: mocks.ensureRelayWorkspace,
}));

vi.mock("../integrations/github-workflow-write-token", () => ({
  mintWorkflowGithubWriteToken: mocks.mintWorkflowGithubWriteToken,
  WorkflowGithubWriteTokenError: class WorkflowGithubWriteTokenError extends Error {},
}));

vi.mock("./relay-workspace", () => ({
  resolveOrProvisionRelayWorkspace: mocks.resolveOrProvisionRelayWorkspace,
}));

vi.mock("../workspace-registry", () => ({
  resolveRelaycastUrl: mocks.resolveRelaycastUrl,
}));

import { runWorkflowLaunch } from "./launch-runner";

type ProvisioningPendingCtor = new (sandboxId: string, state?: string) => Error;

function envelope(): WorkflowLaunchEnvelope {
  return {
    runId: "run-1",
    callbackToken: "callback-token",
    appOrigin: "https://cloud.agentrelay.com",
    workflowOwnerUserId: "user-1",
    workflowOwnerOrganizationId: "org-1",
    workspaceId: "workspace-1",
    rawWorkflow: "name: durable\nagents: []",
    workflow: "name: durable\nagents: []",
    fileType: "yaml",
    sourceFileType: "yaml",
    normalizedFileType: "yaml",
    runtime: {
      id: "runtime-1",
      executionMode: "per-step-sandbox",
    },
    envSecrets: {
      EXISTING_SECRET: "kept",
      WORKFORCE_WORKSPACE_TOKEN: "relayfile-persona-token",
    },
    paths: [],
    githubWrite: {
      slug: "cloud-small-issue-codex",
      owner: "AgentWorkforce",
      repo: "cloud",
      envTokenNames: [],
      relayfileSponsorId: "agent_673cc207",
    },
  };
}

describe("runWorkflowLaunch", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.deriveInteractive.mockReturnValue(false);
    mocks.workflowNeedsCliCredentials.mockReturnValue(false);
    mocks.getWorkflowStorageBackend.mockReturnValue("r2");
    mocks.buildCloudApiWorkflowStorageCredentials.mockReturnValue({
      endpoint: "https://cloud.agentrelay.com/api/v1/workflows/storage",
      accessToken: "cloud-api-access-token",
    });
    mocks.createApiTokenSession.mockResolvedValue({
      sessionId: "token-session-1",
      accessToken: "cloud-api-access-token",
      refreshToken: "cloud-api-refresh-token",
      accessTokenExpiresAt: "2026-05-25T20:00:00.000Z",
    });
    mocks.resolveServerDaytonaAuthParams.mockReturnValue({ daytonaApiKey: "daytona-key" });
    mocks.resolveRelayfileConfig.mockReturnValue({
      relayfileUrl: "https://relayfile.agentrelay.com",
      relayAuthUrl: "https://relayauth.agentrelay.com",
      relayAuthApiKey: "relay-auth-key",
    });
    mocks.toAbsoluteAppUrl.mockImplementation((_origin: string, path: string) => new URL(path, "https://cloud.agentrelay.com"));
    mocks.optionalEnv.mockReturnValue(undefined);
    mocks.resolveCredentialProxyConfig.mockReturnValue({});
    mocks.resolveOrProvisionRelayWorkspace.mockResolvedValue({
      id: "rw-1",
      relaycastApiKey: "relaycast-key",
      provisioned: false,
    });
    mocks.resolveRelaycastUrl.mockReturnValue("https://relaycast.agentrelay.com");
    mocks.ensureRelayWorkspace.mockResolvedValue(undefined);
    mocks.buildCredentialBundle.mockReturnValue({ bundled: true });
    mocks.launchOrchestratorSandbox.mockResolvedValue({
      sandboxId: "sandbox-1",
      executionMode: "per-step-sandbox",
      observerUrl: "https://cloud.agentrelay.com/runs/run-1",
      workdir: "/project",
    });
    mocks.dbValues.mockResolvedValue(undefined);
    mocks.dbInsert.mockReturnValue({ values: mocks.dbValues });
    mocks.getDb.mockReturnValue({ insert: mocks.dbInsert });
    mocks.attachSandboxToApiTokenSession.mockResolvedValue(undefined);
  });

  it("carries durable launch envelope envSecrets into the orchestrator sandbox", async () => {
    await expect(runWorkflowLaunch({ envelope: envelope() })).resolves.toMatchObject({
      sandboxId: "sandbox-1",
      relayWorkspaceId: "rw-1",
    });

    expect(mocks.launchOrchestratorSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        envSecrets: {
          EXISTING_SECRET: "kept",
          WORKFORCE_WORKSPACE_TOKEN: "relayfile-persona-token",
        },
      }),
    );
    expect(mocks.mintWorkflowGithubWriteToken).not.toHaveBeenCalled();
  });

  it("mints the sandbox access token with a four-hour ttl", async () => {
    await expect(runWorkflowLaunch({ envelope: envelope() })).resolves.toMatchObject({
      sandboxId: "sandbox-1",
    });

    expect(mocks.createApiTokenSession).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: "sandbox",
        accessTokenTtlSeconds: 4 * 3600,
        scopes: expect.arrayContaining(["workflow:invoke:write"]),
      }),
    );
  });

  it("persists a provisioning sandbox id without registering it until startup completes", async () => {
    const { WorkflowSandboxProvisioningPendingError } = await import("@cloud/core/bootstrap/launcher.js") as {
      WorkflowSandboxProvisioningPendingError: ProvisioningPendingCtor;
    };
    const onSandboxCreated = vi.fn();
    mocks.launchOrchestratorSandbox.mockImplementation(async (options: {
      onProvisioningSandboxCreated?: (sandboxId: string) => Promise<void>;
    }) => {
      await options.onProvisioningSandboxCreated?.("sandbox-1");
      throw new WorkflowSandboxProvisioningPendingError("sandbox-1", "STARTING");
    });

    await expect(runWorkflowLaunch({ envelope: envelope(), onSandboxCreated })).rejects.toBeInstanceOf(
      WorkflowSandboxProvisioningPendingError,
    );

    expect(onSandboxCreated).toHaveBeenCalledWith("sandbox-1");
    expect(mocks.attachSandboxToApiTokenSession).not.toHaveBeenCalled();
    expect(mocks.dbValues).not.toHaveBeenCalled();
  });
});
