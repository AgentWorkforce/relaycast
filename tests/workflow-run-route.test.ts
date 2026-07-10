import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const buildCredentialBundleMock = vi.fn();
const launchOrchestratorSandboxMock = vi.fn();
const mintS3CredentialsMock = vi.fn();
const getCliCredentialsMock = vi.fn();
const listConnectedProvidersMock = vi.fn();
const workflowNeedsCliCredentialsMock = vi.fn();
const getAllProvidersMock = vi.fn();
const workflowStoreCreateMock = vi.fn();
const workflowStoreUpdateMock = vi.fn();
const resolveRequestAuthMock = vi.fn();
const requireSessionAuthMock = vi.fn();
const requireAuthScopeMock = vi.fn();
const getBrokerKeySecretMock = vi.fn();
const resolveServerDaytonaAuthParamsMock = vi.fn();
const attachSandboxToApiTokenSessionMock = vi.fn();
const createApiTokenSessionMock = vi.fn();
const revokeApiTokenSessionByIdMock = vi.fn();
const getConfiguredAppOriginMock = vi.fn();
const toAbsoluteAppUrlMock = vi.fn();
const toAppPathMock = vi.fn();
const getCloudflareContextMock = vi.fn();
const getDbMock = vi.fn();
const deriveInteractiveMock = vi.fn();
const resolveRelayfileConfigMock = vi.fn();
const ensureRelayWorkspaceMock = vi.fn();
const runWorkerAssignmentMaintenanceMock = vi.fn();
const enqueueForWorkerMock = vi.fn();
const resolveRelayApiKeyForWorkspaceMock = vi.fn();
const resolveOrProvisionRelayWorkspaceMock = vi.fn();
const workerRegistrySelectMock = vi.fn();
const packageWorkflowRefMock = vi.fn();
const resolveRelaycastUrlMock = vi.fn();
const resolveRepoAllowlistOrRelaxedMock = vi.fn();
const resolveWorkflowGithubWriteGrantMock = vi.fn();
const mintWorkflowGithubWriteTokenMock = vi.fn();
const createWorkflowLaunchJobMock = vi.fn();
const markWorkflowLaunchJobFailedMock = vi.fn();
const encryptWorkflowLaunchEnvelopeMock = vi.fn();
const enqueueWorkflowLaunchJobMock = vi.fn();
const optionalEnvMock = vi.fn();

class MockWorkflowGithubWriteTokenError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 500) {
    super(message);
    this.name = "WorkflowGithubWriteTokenError";
    this.code = code;
    this.status = status;
  }
}

// The per-step-sandbox path now returns `{ runId, status: "pending" }`
// immediately and registers the heavy launch via the Cloudflare Worker
// `waitUntil` (read off `Symbol.for("__cloudflare-context__")`). Capture those
// promises here so tests can await the background launch before asserting on
// its side effects (launchOrchestratorSandbox, workflowStore.update, etc.).
const cloudflareContextSymbol = Symbol.for("__cloudflare-context__");
let backgroundLaunches: Array<Promise<unknown>> = [];
async function flushBackgroundLaunches(): Promise<void> {
  while (backgroundLaunches.length > 0) {
    const pending = backgroundLaunches;
    backgroundLaunches = [];
    await Promise.allSettled(pending);
  }
}

async function withCapturedConsole<T>(fn: () => Promise<T>) {
  const originalLog = console.log;
  const originalError = console.error;
  const logs: unknown[][] = [];
  const errors: unknown[][] = [];
  console.log = (...args: unknown[]) => {
    logs.push(args);
  };
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    const result = await fn();
    return { result, logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

vi.mock("sst", () => ({
  Resource: {
    CredentialEncryptionKey: { value: "cred-key" },
    WorkflowStorage: {
      stsRoleArn: "arn:aws:iam::123456789012:role/workflow-storage",
      bucketName: "workflow-bucket",
    },
  },
}));

vi.mock("@cloud/core/relayfile/client.js", () => ({
  mintRelayfileToken: vi.fn(async () => "relayfile-token"),
}));

vi.mock("@cloud/core/workspace/id.js", () => ({
  generateWorkspaceId: () => "rw_generated1",
  isValidWorkspaceId: (value: string) => value.startsWith("rw_"),
}));

vi.mock("@cloud/core/bootstrap/launcher.js", () => ({
  deriveInteractive: (...args: unknown[]) => deriveInteractiveMock(...args),
}));

vi.mock("@/lib/workflows", () => ({
  buildCredentialBundle: (...args: unknown[]) => buildCredentialBundleMock(...args),
  launchOrchestratorSandbox: (...args: unknown[]) => launchOrchestratorSandboxMock(...args),
  mintS3Credentials: (...args: unknown[]) => mintS3CredentialsMock(...args),
  getCliCredentials: (...args: unknown[]) => getCliCredentialsMock(...args),
  listConnectedProviders: (...args: unknown[]) => listConnectedProvidersMock(...args),
  resolveCredentialProxyConfig: vi.fn(() => ({})),
  workflowNeedsCliCredentials: (...args: unknown[]) => workflowNeedsCliCredentialsMock(...args),
  getAllProviders: (...args: unknown[]) => getAllProvidersMock(...args),
  workflowStore: {
    create: (...args: unknown[]) => workflowStoreCreateMock(...args),
    update: (...args: unknown[]) => workflowStoreUpdateMock(...args),
  },
}));

// The run route now goes through the broker-aware façade. Reuse the
// existing mintS3CredentialsMock so test setups that call
// `mintS3CredentialsMock.mockResolvedValue(...)` continue to drive the
// route's mint call without per-test rewiring.
vi.mock("@/lib/aws/sts-credentials", () => ({
  mintScopedS3Credentials: (...args: unknown[]) => mintS3CredentialsMock(...args),
}));

vi.mock("@/lib/aws/broker-client", () => ({
  BrokerClientError: class BrokerClientError extends Error {
    readonly status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
      this.name = "BrokerClientError";
    }
  },
}));

vi.mock("@/lib/aws/runtime", () => ({
  isWorkerRuntime: () => false,
  readWorkerEnv: () => undefined,
  readBrokerConfig: () => undefined,
}));

vi.mock("@/lib/env", () => ({
  optionalEnv: (...args: unknown[]) => optionalEnvMock(...args),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: (...args: unknown[]) => resolveRequestAuthMock(...args),
  requireSessionAuth: (...args: unknown[]) => requireSessionAuthMock(...args),
  requireAuthScope: (...args: unknown[]) => requireAuthScopeMock(...args),
}));

vi.mock("@/lib/auth/secrets", () => ({
  getBrokerKeySecret: (...args: unknown[]) => getBrokerKeySecretMock(...args),
}));

vi.mock("@/lib/daytona-auth", () => ({
  resolveServerDaytonaAuthParams: (...args: unknown[]) => resolveServerDaytonaAuthParamsMock(...args),
}));

vi.mock("@/lib/auth/api-token-store", () => ({
  attachSandboxToApiTokenSession: (...args: unknown[]) => attachSandboxToApiTokenSessionMock(...args),
  createApiTokenSession: (...args: unknown[]) => createApiTokenSessionMock(...args),
  revokeApiTokenSessionById: (...args: unknown[]) => revokeApiTokenSessionByIdMock(...args),
}));

vi.mock("@/lib/app-origin", () => ({
  getConfiguredAppOrigin: (...args: unknown[]) => getConfiguredAppOriginMock(...args),
}));

vi.mock("@/lib/app-path", () => ({
  toAbsoluteAppUrl: (...args: unknown[]) => toAbsoluteAppUrlMock(...args),
  toAppPath: (...args: unknown[]) => toAppPathMock(...args),
}));

vi.mock("@/lib/cloudflare-context", () => ({
  getCloudflareContext: (...args: unknown[]) => getCloudflareContextMock(...args),
}));

vi.mock("@/lib/db", () => ({
  getDb: (...args: unknown[]) => getDbMock(...args),
}));

vi.mock("@/lib/db/schema", () => ({
  agents: {
    id: "agents.id",
    workspaceId: "agents.workspace_id",
    deployedByUserId: "agents.deployed_by_user_id",
    deployedName: "agents.deployed_name",
  },
  workspaces: {
    id: "workspaces.id",
    organizationId: "workspaces.organization_id",
  },
  sandboxes: {},
}));

vi.mock("@/lib/relayfile", () => ({
  resolveRelayfileConfig: (...args: unknown[]) => resolveRelayfileConfigMock(...args),
}));

vi.mock("@/lib/relay-workspaces", () => ({
  ensureRelayWorkspace: (...args: unknown[]) => ensureRelayWorkspaceMock(...args),
}));

vi.mock("@/lib/integrations/workflow-repository-allowlists", () => ({
  resolveRepoAllowlistOrRelaxed: (...args: unknown[]) => resolveRepoAllowlistOrRelaxedMock(...args),
}));

vi.mock("@/lib/integrations/github-workflow-write-token", () => ({
  mintWorkflowGithubWriteToken: (...args: unknown[]) => mintWorkflowGithubWriteTokenMock(...args),
  WorkflowGithubWriteTokenError: MockWorkflowGithubWriteTokenError,
}));

vi.mock("@cloud/core/workflow-launch/job-store.js", () => ({
  createWorkflowLaunchJob: (...args: unknown[]) => createWorkflowLaunchJobMock(...args),
  markWorkflowLaunchJobFailed: (...args: unknown[]) => markWorkflowLaunchJobFailedMock(...args),
}));

vi.mock("@/lib/workflows/invocation-registry", () => ({
  resolveWorkflowGithubWriteGrant: (...args: unknown[]) => resolveWorkflowGithubWriteGrantMock(...args),
}));

vi.mock("@/lib/workflows/launch-job-envelope", () => ({
  encryptWorkflowLaunchEnvelopeAsync: (...args: unknown[]) => encryptWorkflowLaunchEnvelopeMock(...args),
}));

vi.mock("@/lib/workflows/durable-launch-queue", () => ({
  enqueueWorkflowLaunchJob: (...args: unknown[]) => enqueueWorkflowLaunchJobMock(...args),
}));

vi.mock("@/lib/workers/assignments", () => ({
  enqueueForWorker: (...args: unknown[]) => enqueueForWorkerMock(...args),
  runWorkerAssignmentMaintenance: (...args: unknown[]) => runWorkerAssignmentMaintenanceMock(...args),
}));

vi.mock("@/lib/workers/registry", () => ({
  WorkerRegistry: vi.fn(function () {
    return {
      select: (...args: unknown[]) => workerRegistrySelectMock(...args),
    };
  }),
}));

vi.mock("@/lib/workers/workflow-ref", () => ({
  packageWorkflowRef: (...args: unknown[]) => packageWorkflowRefMock(...args),
}));

vi.mock("@/lib/workflows/relay-api-key", () => ({
  resolveRelayApiKeyForWorkspace: (...args: unknown[]) => resolveRelayApiKeyForWorkspaceMock(...args),
}));

vi.mock("@/lib/workflows/relay-workspace", () => ({
  resolveOrProvisionRelayWorkspace: (...args: unknown[]) => resolveOrProvisionRelayWorkspaceMock(...args),
}));

vi.mock("@/lib/workspace-registry", () => ({
  resolveRelaycastUrl: (...args: unknown[]) => resolveRelaycastUrlMock(...args),
}));

async function loadRoute() {
  const routeUrl = new URL(
    "../packages/web/app/api/v1/workflows/run/route.ts",
    import.meta.url,
  ).href;
  return import(routeUrl);
}

function mockDbWithRelayfileOwner(owner: {
  userId: string;
  organizationId: string;
  deployedName?: string;
}) {
  const insertValuesMock = vi.fn().mockResolvedValue(undefined);
  const insertMock = vi.fn(() => ({ values: insertValuesMock }));
  const ownerLimitMock = vi.fn().mockResolvedValue([
    {
      deployedByUserId: owner.userId,
      organizationId: owner.organizationId,
      deployedName: owner.deployedName ?? "cloud-small-issue-codex",
    },
  ]);
  const ownerWhereMock = vi.fn(() => ({ limit: ownerLimitMock }));
  const ownerInnerJoinMock = vi.fn(() => ({ where: ownerWhereMock }));
  const ownerFromMock = vi.fn(() => ({ innerJoin: ownerInnerJoinMock }));
  const selectMock = vi.fn(() => ({ from: ownerFromMock }));
  getDbMock.mockReturnValue({
    insert: insertMock,
    select: selectMock,
  });
}

beforeEach(() => {
  resolveRequestAuthMock.mockResolvedValue({
    userId: "user_123",
    workspaceId: "rw_12345678",
    organizationId: "org_123",
    source: "session",
  });
  requireSessionAuthMock.mockReturnValue(true);
  requireAuthScopeMock.mockReturnValue(true);
  workflowNeedsCliCredentialsMock.mockReturnValue(false);
  resolveRelayfileConfigMock.mockReturnValue({
    relayfileUrl: "https://relayfile.test",
    relayJwtSecret: "relay-jwt-secret",
    relayAuthUrl: "https://api.relayauth.test",
    relayAuthApiKey: "relayauth-api-key",
  });
  createApiTokenSessionMock.mockResolvedValue({
    sessionId: "session_123",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    accessTokenExpiresAt: "2026-04-19T12:00:00.000Z",
  });
  mintS3CredentialsMock.mockResolvedValue({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "secret",
    sessionToken: "session-token",
    bucket: "workflow-bucket",
    prefix: "user-123/run-123",
  });
  resolveServerDaytonaAuthParamsMock.mockReturnValue({
    daytonaApiKey: "daytona-key",
  });
  resolveRelayApiKeyForWorkspaceMock.mockResolvedValue("rk_live_workspace");
  resolveOrProvisionRelayWorkspaceMock.mockResolvedValue({
    id: "rw_12345678",
    relaycastApiKey: "rk_live_workspace",
    provisioned: false,
  });
  buildCredentialBundleMock.mockImplementation((input: unknown) => input);
  launchOrchestratorSandboxMock.mockResolvedValue({ sandboxId: "sandbox_123" });
  workflowStoreCreateMock.mockResolvedValue({});
  workflowStoreUpdateMock.mockResolvedValue({});
  attachSandboxToApiTokenSessionMock.mockResolvedValue(undefined);
  runWorkerAssignmentMaintenanceMock.mockResolvedValue(undefined);
  enqueueForWorkerMock.mockResolvedValue({ id: "assignment_123" });
  workerRegistrySelectMock.mockResolvedValue({
    id: "worker_123",
    name: "worker-one",
  });
  packageWorkflowRefMock.mockReturnValue({
    type: "inline",
    value: JSON.stringify({ runId: "run_123" }),
  });
  resolveRelaycastUrlMock.mockReturnValue("https://api.relaycast.test");
  deriveInteractiveMock.mockReturnValue(false);
  getBrokerKeySecretMock.mockReturnValue("broker-secret");
  getConfiguredAppOriginMock.mockReturnValue("http://localhost");
  toAbsoluteAppUrlMock.mockImplementation((origin: string, pathname: string) => new URL(pathname, origin));
  toAppPathMock.mockImplementation((pathname: string) => pathname);
  getCloudflareContextMock.mockReturnValue({ env: undefined });
  optionalEnvMock.mockReturnValue("");
  resolveRepoAllowlistOrRelaxedMock.mockResolvedValue({
    workspaceId: "rw_12345678",
    repoOwner: "AgentWorkforce",
    repoName: "cloud",
    installationId: "install_123",
    pushAllowed: false,
    allowedAt: new Date(),
    allowedBy: "user_123",
  });
  resolveWorkflowGithubWriteGrantMock.mockReturnValue(undefined);
  mintWorkflowGithubWriteTokenMock.mockResolvedValue({
    token: "ghs_workflow_write_token",
    installationId: "134609235",
    repositoryScoped: false,
  });
  createWorkflowLaunchJobMock.mockResolvedValue({ id: "launch-job-1" });
  markWorkflowLaunchJobFailedMock.mockResolvedValue(undefined);
  encryptWorkflowLaunchEnvelopeMock.mockReturnValue({
    v: 1,
    iv: "iv",
    tag: "tag",
    ciphertext: "ciphertext",
  });
  enqueueWorkflowLaunchJobMock.mockResolvedValue(undefined);

  const insertValuesMock = vi.fn().mockResolvedValue(undefined);
  const insertMock = vi.fn(() => ({ values: insertValuesMock }));
  getDbMock.mockReturnValue({ insert: insertMock });

  // Register a Cloudflare-style ExecutionContext so the per-step-sandbox path
  // hands its background launch promise to `waitUntil`, which we capture for
  // deterministic flushing in tests.
  backgroundLaunches = [];
  (globalThis as Record<symbol, unknown>)[cloudflareContextSymbol] = {
    waitUntil: (promise: Promise<unknown>) => {
      backgroundLaunches.push(promise);
    },
  };
});

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[cloudflareContextSymbol];
  backgroundLaunches = [];
  vi.clearAllMocks();
  vi.resetModules();
});

describe("workflow run route", () => {
  it("enqueues per-step Daytona launches when the durable launch flag is enabled", async () => {
    optionalEnvMock.mockImplementation((name: string) =>
      name === "WORKFLOW_LAUNCH_QUEUE_ENABLED" ? "true" : "",
    );
    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow: "name: durable-test\nagents: []",
          fileType: "yaml",
        }),
      }) as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      runId: expect.any(String),
      status: "pending",
      launchJobId: "launch-job-1",
    });
    expect(workflowStoreCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchType: "sandbox",
        sandboxId: null,
        status: "pending",
      }),
    );
    expect(encryptWorkflowLaunchEnvelopeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: expect.any(String),
        workspaceId: "rw_12345678",
        runtime: expect.objectContaining({ executionMode: "per-step-sandbox" }),
        envSecrets: undefined,
      }),
      "cred-key",
    );
    expect(createWorkflowLaunchJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: expect.any(String),
        workspaceId: "rw_12345678",
        requestEnvelope: {
          v: 1,
          iv: "iv",
          tag: "tag",
          ciphertext: "ciphertext",
        },
      }),
    );
    expect(enqueueWorkflowLaunchJobMock).toHaveBeenCalledWith({
      jobId: "launch-job-1",
      runId: expect.any(String),
    });
    expect(launchOrchestratorSandboxMock).not.toHaveBeenCalled();
    expect(backgroundLaunches).toHaveLength(0);
  });

  it("logs the durable workflow launch boundary without exposing tokens", async () => {
    optionalEnvMock.mockImplementation((name: string) =>
      name === "WORKFLOW_LAUNCH_QUEUE_ENABLED" ? "true" : "",
    );
    const { POST } = await loadRoute();

    const { result: response, logs, errors } = await withCapturedConsole<Response>(
      () =>
        POST(
          new Request("http://localhost/api/v1/workflows/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              workflow: "name: durable-test\nagents: []",
              fileType: "yaml",
              metadata: {
                invocationSlug: "cloud-small-issue-codex",
                invocationArgs: JSON.stringify({ issueNumber: "1595" }),
              },
            }),
          }) as never,
        ),
    );

    expect(response.status).toBe(200);
    expect(errors).toEqual([]);
    expect(logs).toEqual(expect.arrayContaining([
      [
        "[gate-b-resolver-diag] workflow-launch-enqueued",
        expect.objectContaining({
          launchJobId: "launch-job-1",
          workspaceId: "rw_12345678",
          invocationSlug: "cloud-small-issue-codex",
          issueNumber: 1595,
          runtimeId: "daytona",
          executionMode: "per-step-sandbox",
        }),
      ],
    ]));
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain("access-token");
    expect(serialized).not.toContain("relayfile-token");
  });

  it("keeps server-side GitHub write grants in the durable launch envelope without minting when no sandbox env targets are registered", async () => {
    optionalEnvMock.mockImplementation((name: string) =>
      name === "WORKFLOW_LAUNCH_QUEUE_ENABLED" ? "true" : "",
    );
    resolveWorkflowGithubWriteGrantMock.mockReturnValue({
      slug: "cloud-small-issue-codex",
      owner: "AgentWorkforce",
      repo: "cloud",
      envTokenNames: [],
    });
    resolveRequestAuthMock.mockResolvedValue({
      userId: "agent_673cc207",
      workspaceId: "rw_12345678",
      organizationId: "org_agent",
      source: "relayfile",
      relayfileSponsorId: "agent_673cc207",
      bearerToken: "relayfile-persona-token",
    });
    requireSessionAuthMock.mockReturnValue(false);
    mockDbWithRelayfileOwner({
      userId: "0403d3ba-deployer",
      organizationId: "org_deployer",
      deployedName: "cloud-small-issue-codex",
    });

    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow: "name: durable-path2\nagents: []",
          fileType: "yaml",
          metadata: {
            invocationSlug: "cloud-small-issue-codex",
          },
          envSecrets: {
            EXISTING_SECRET: "kept",
          },
          inputs: {
            issueNumber: 1091,
          },
        }),
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(mintWorkflowGithubWriteTokenMock).not.toHaveBeenCalled();
    expect(encryptWorkflowLaunchEnvelopeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        envSecrets: {
          EXISTING_SECRET: "kept",
          WORKFORCE_WORKSPACE_TOKEN: "relayfile-persona-token",
        },
        githubWrite: {
          slug: "cloud-small-issue-codex",
          owner: "AgentWorkforce",
          repo: "cloud",
          envTokenNames: [],
          relayfileSponsorId: "agent_673cc207",
        },
        failureNotification: {
          githubIssue: {
            owner: "AgentWorkforce",
            repo: "cloud",
            issueNumber: 1091,
          },
        },
      }),
      "cred-key",
    );
    expect(launchOrchestratorSandboxMock).not.toHaveBeenCalled();
  });

  it("uses the canonical relay workspace record for sandbox credentials and persisted run state", async () => {
    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow: "name: sandbox-test\nagents: []",
          fileType: "yaml",
        }),
      }) as never,
    );

    expect(response.status).toBe(200);
    // Early run-row create happens before the (now background) launch so
    // status polls resolve immediately; relayWorkspaceId is filled in by the
    // launch's workflowStore.update once it resolves.
    expect(workflowStoreCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchType: "sandbox",
        workspaceId: "rw_12345678",
        sandboxId: null,
        status: "pending",
      }),
    );
    await flushBackgroundLaunches();
    expect(resolveOrProvisionRelayWorkspaceMock).toHaveBeenCalledWith({
      userId: "user_123",
      appWorkspaceId: "rw_12345678",
    });
    expect(ensureRelayWorkspaceMock).toHaveBeenCalledWith("rw_12345678", { ignored: [], readonly: [] });
    expect(buildCredentialBundleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "rw_12345678",
        relayApiKey: "rk_live_workspace",
      }),
    );
    expect(workflowStoreUpdateMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        sandboxId: "sandbox_123",
        relayWorkspaceId: "rw_12345678",
      }),
    );
  });

  it("mints and injects the registered workflow GitHub token for the matching deployed persona sponsor", async () => {
    resolveWorkflowGithubWriteGrantMock.mockReturnValue({
      slug: "cloud-small-issue-codex",
      owner: "AgentWorkforce",
      repo: "cloud",
      envTokenNames: ["GITHUB_TOKEN", "GH_TOKEN"],
    });
    resolveRequestAuthMock.mockResolvedValue({
      userId: "agent_673cc207",
      workspaceId: "rw_12345678",
      organizationId: "org_agent",
      source: "relayfile",
      relayfileSponsorId: "agent_673cc207",
      bearerToken: "relayfile-persona-token",
    });
    requireSessionAuthMock.mockReturnValue(false);
    listConnectedProvidersMock.mockResolvedValue(["openai"]);
    getCliCredentialsMock.mockResolvedValue("openai-secret");
    mockDbWithRelayfileOwner({
      userId: "0403d3ba-deployer",
      organizationId: "org_deployer",
      deployedName: "cloud-small-issue-codex",
    });

    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/workflows/run", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Deployed runtime 3.0.21 sends literal "true", not the in-process
          // delegation secret. This must still mint via sponsor binding.
          "x-agentworkforce-workspace-workflow-invocation": "true",
        },
        body: JSON.stringify({
          runId: "run_github_write",
          workflow: "console.log('phase-c');",
          fileType: "ts",
          sourceFileType: "workflow",
          metadata: {
            invocationSlug: "cloud-small-issue-codex",
            invocationArgs: "{}",
          },
          envSecrets: {
            EXISTING_SECRET: "kept",
          },
        }),
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(resolveWorkflowGithubWriteGrantMock).toHaveBeenCalledWith("cloud-small-issue-codex");
    expect(mintWorkflowGithubWriteTokenMock).toHaveBeenCalledWith({
      userId: "0403d3ba-deployer",
      workspaceId: "rw_12345678",
      repoOwner: "AgentWorkforce",
      repoName: "cloud",
    });
    await flushBackgroundLaunches();
    expect(launchOrchestratorSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        envSecrets: {
          EXISTING_SECRET: "kept",
          WORKFORCE_WORKSPACE_TOKEN: "relayfile-persona-token",
          GITHUB_TOKEN: "ghs_workflow_write_token",
          GH_TOKEN: "ghs_workflow_write_token",
        },
        metadata: {
          invocationSlug: "cloud-small-issue-codex",
          invocationArgs: "{}",
        },
      }),
    );
  });

  it("does not mint or inject a sandbox GitHub token when the registered workflow grant has no env targets", async () => {
    resolveWorkflowGithubWriteGrantMock.mockReturnValue({
      slug: "cloud-small-issue-codex",
      owner: "AgentWorkforce",
      repo: "cloud",
      envTokenNames: [],
    });
    resolveRequestAuthMock.mockResolvedValue({
      userId: "agent_673cc207",
      workspaceId: "rw_12345678",
      organizationId: "org_agent",
      source: "relayfile",
      relayfileSponsorId: "agent_673cc207",
      bearerToken: "relayfile-persona-token",
    });
    requireSessionAuthMock.mockReturnValue(false);
    listConnectedProvidersMock.mockResolvedValue(["openai"]);
    getCliCredentialsMock.mockResolvedValue("openai-secret");
    mockDbWithRelayfileOwner({
      userId: "0403d3ba-deployer",
      organizationId: "org_deployer",
      deployedName: "cloud-small-issue-codex",
    });

    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/workflows/run", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-agentworkforce-workspace-workflow-invocation": "true",
        },
        body: JSON.stringify({
          runId: "run_github_write_server_side_only",
          workflow: "console.log('path-2');",
          fileType: "ts",
          sourceFileType: "workflow",
          metadata: {
            invocationSlug: "cloud-small-issue-codex",
          },
          envSecrets: {
            EXISTING_SECRET: "kept",
          },
        }),
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(resolveWorkflowGithubWriteGrantMock).toHaveBeenCalledWith("cloud-small-issue-codex");
    expect(mintWorkflowGithubWriteTokenMock).not.toHaveBeenCalled();
    await flushBackgroundLaunches();
    expect(launchOrchestratorSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        envSecrets: {
          EXISTING_SECRET: "kept",
          WORKFORCE_WORKSPACE_TOKEN: "relayfile-persona-token",
        },
        metadata: expect.objectContaining({
          invocationSlug: "cloud-small-issue-codex",
        }),
      }),
    );
  });

  it("forwards the relayfile persona token for the complex issue workflow grant", async () => {
    resolveWorkflowGithubWriteGrantMock.mockReturnValue({
      slug: "cloud-complex-issue-workflow",
      owner: "AgentWorkforce",
      repo: "cloud",
      envTokenNames: [],
    });
    resolveRequestAuthMock.mockResolvedValue({
      userId: "agent_complex",
      workspaceId: "rw_12345678",
      organizationId: "org_agent",
      source: "relayfile",
      relayfileSponsorId: "agent_complex",
      bearerToken: "relayfile-complex-persona-token",
    });
    requireSessionAuthMock.mockReturnValue(false);
    listConnectedProvidersMock.mockResolvedValue(["openai"]);
    getCliCredentialsMock.mockResolvedValue("openai-secret");
    mockDbWithRelayfileOwner({
      userId: "0403d3ba-deployer",
      organizationId: "org_deployer",
      deployedName: "cloud-complex-issue-workflow",
    });

    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/workflows/run", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-agentworkforce-workspace-workflow-invocation": "true",
        },
        body: JSON.stringify({
          runId: "run_complex_github_write",
          workflow: "console.log('complex path-2');",
          fileType: "ts",
          sourceFileType: "workflow",
          metadata: {
            invocationSlug: "cloud-complex-issue-workflow",
          },
          envSecrets: {
            EXISTING_SECRET: "kept",
          },
        }),
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(resolveWorkflowGithubWriteGrantMock).toHaveBeenCalledWith("cloud-complex-issue-workflow");
    expect(mintWorkflowGithubWriteTokenMock).not.toHaveBeenCalled();
    await flushBackgroundLaunches();
    expect(launchOrchestratorSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        envSecrets: {
          EXISTING_SECRET: "kept",
          WORKFORCE_WORKSPACE_TOKEN: "relayfile-complex-persona-token",
        },
        metadata: expect.objectContaining({
          invocationSlug: "cloud-complex-issue-workflow",
        }),
      }),
    );
  });

  it("rejects registered workflow GitHub token minting when the relayfile sponsor deployedName does not match the grant", async () => {
    resolveWorkflowGithubWriteGrantMock.mockReturnValue({
      slug: "cloud-small-issue-codex",
      owner: "AgentWorkforce",
      repo: "cloud",
      envTokenNames: ["GITHUB_TOKEN", "GH_TOKEN"],
    });
    resolveRequestAuthMock.mockResolvedValue({
      userId: "agent_other",
      workspaceId: "rw_12345678",
      organizationId: "org_agent",
      source: "relayfile",
      relayfileSponsorId: "agent_other",
    });
    requireSessionAuthMock.mockReturnValue(false);
    mockDbWithRelayfileOwner({
      userId: "deployer_other",
      organizationId: "org_deployer",
      deployedName: "different-persona",
    });

    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow: "console.log(process.env.GITHUB_TOKEN);",
          fileType: "ts",
          metadata: {
            invocationSlug: "cloud-small-issue-codex",
          },
        }),
      }) as never,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "github_write_forbidden",
    });
    expect(mintWorkflowGithubWriteTokenMock).not.toHaveBeenCalled();
    expect(launchOrchestratorSandboxMock).not.toHaveBeenCalled();
  });

  it("does not mint registered workflow GitHub tokens for non-delegated callers", async () => {
    resolveWorkflowGithubWriteGrantMock.mockReturnValue({
      slug: "cloud-small-issue-codex",
      owner: "AgentWorkforce",
      repo: "cloud",
      envTokenNames: ["GITHUB_TOKEN", "GH_TOKEN"],
    });

    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow: "console.log('nope');",
          fileType: "ts",
          metadata: {
            invocationSlug: "cloud-small-issue-codex",
          },
        }),
      }) as never,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "github_write_forbidden",
    });
    expect(mintWorkflowGithubWriteTokenMock).not.toHaveBeenCalled();
    expect(launchOrchestratorSandboxMock).not.toHaveBeenCalled();
  });

  it("surfaces registered workflow GitHub token mint failures before launch", async () => {
    resolveWorkflowGithubWriteGrantMock.mockReturnValue({
      slug: "cloud-small-issue-codex",
      owner: "AgentWorkforce",
      repo: "cloud",
      envTokenNames: ["GITHUB_TOKEN", "GH_TOKEN"],
    });
    resolveRequestAuthMock.mockResolvedValue({
      userId: "agent_673cc207",
      workspaceId: "rw_12345678",
      organizationId: "org_agent",
      source: "relayfile",
      relayfileSponsorId: "agent_673cc207",
    });
    requireSessionAuthMock.mockReturnValue(false);
    mockDbWithRelayfileOwner({
      userId: "0403d3ba-deployer",
      organizationId: "org_deployer",
      deployedName: "cloud-small-issue-codex",
    });
    mintWorkflowGithubWriteTokenMock.mockRejectedValue(
      new MockWorkflowGithubWriteTokenError(
        "repo_push_not_allowed",
        "Workflow GitHub write is not allowed for AgentWorkforce/cloud.",
        403,
      ),
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { POST } = await loadRoute();

      const response = await POST(
        new Request("http://localhost/api/v1/workflows/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workflow: "console.log('blocked');",
            fileType: "ts",
            metadata: {
              invocationSlug: "cloud-small-issue-codex",
            },
          }),
        }) as never,
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: "repo_push_not_allowed",
        repoOwner: "AgentWorkforce",
        repoName: "cloud",
      });
      expect(launchOrchestratorSandboxMock).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("auto-provisions a relay workspace when the user has none and uses the minted API key", async () => {
    resolveRequestAuthMock.mockResolvedValue({
      userId: "user_without_relay_ws",
      // App workspace UUID, not rw_-format — the case that previously
      // generated a fresh orphan rw_ID per call and returned empty keys.
      workspaceId: "550e8400-e29b-41d4-a716-446655440000",
      organizationId: "org_123",
      source: "session",
    });
    resolveOrProvisionRelayWorkspaceMock.mockResolvedValue({
      id: "rw_provisioned1",
      relaycastApiKey: "rk_live_freshly_provisioned",
      provisioned: true,
    });

    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow: "name: sandbox-test\nagents: []",
          fileType: "yaml",
        }),
      }) as never,
    );

    expect(response.status).toBe(200);
    await flushBackgroundLaunches();
    expect(resolveOrProvisionRelayWorkspaceMock).toHaveBeenCalledWith({
      userId: "user_without_relay_ws",
      appWorkspaceId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(buildCredentialBundleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "rw_provisioned1",
        relayApiKey: "rk_live_freshly_provisioned",
      }),
    );
  });

  it("passes cloud resume and start-from options through to the sandbox launcher", async () => {
    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow: "name: sandbox-test\nagents: []",
          fileType: "yaml",
          resume: "run-resume-123",
          startFrom: "external-path-smoke",
          previousRunId: "run-prev-456",
        }),
      }) as never,
    );

    expect(response.status).toBe(200);
    await flushBackgroundLaunches();
    expect(launchOrchestratorSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeRunId: "run-resume-123",
        startFrom: "external-path-smoke",
        previousRunId: "run-prev-456",
      }),
    );
  });

  it("defaults omitted executionMode to per-step-sandbox and returns it in the launch response", async () => {
    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow: "name: sandbox-test\nagents: []",
          fileType: "yaml",
        }),
      }) as never,
    );

    expect(response.status).toBe(200);
    // The per-step-sandbox path returns immediately with just the runId;
    // the launch (and its sandboxId/observerUrl) completes in the background.
    await expect(response.json()).resolves.toEqual({
      runId: expect.any(String),
      status: "pending",
    });
    await flushBackgroundLaunches();
    expect(launchOrchestratorSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        executionMode: "per-step-sandbox",
        observerUrl: expect.stringContaining("http://localhost/runs/"),
        orchestratorLibUrl: "http://localhost/orchestrator-lib.tar.gz",
      }),
    );
  });

  it("uses the configured public app origin for sandbox cloud URLs even when the request hits the origin host", async () => {
    getConfiguredAppOriginMock.mockReturnValue("https://agentrelay.com");
    toAbsoluteAppUrlMock.mockImplementation(
      (origin: string, pathname: string) => new URL(pathname === "/" ? "/cloud" : `/cloud${pathname}`, origin),
    );
    const { POST } = await loadRoute();

    const response = await POST(
      new Request("https://origin.agentrelay.com/cloud/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow: "name: sandbox-test\nagents: []",
          fileType: "yaml",
        }),
      }) as never,
    );

    expect(response.status).toBe(200);
    await flushBackgroundLaunches();
    expect(buildCredentialBundleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudApiUrl: "https://agentrelay.com/cloud",
      }),
    );
    expect(launchOrchestratorSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        callbackUrl: "https://agentrelay.com/cloud/api/v1/workflows/callback",
        observerUrl: expect.stringMatching(/^https:\/\/agentrelay\.com\/cloud\/runs\//),
        orchestratorLibUrl: "https://agentrelay.com/cloud/orchestrator-lib.tar.gz",
      }),
    );
  });

  it("loads orchestrator lib bytes from the Worker ASSETS binding and still forwards the fallback URL", async () => {
    const assetBytes = new Uint8Array([31, 139, 8, 0, 1, 2, 3, 4]);
    const assetFetch = vi.fn(async () =>
      new Response(assetBytes, {
        status: 200,
        headers: { "content-type": "application/gzip" },
      }),
    );
    getCloudflareContextMock.mockReturnValue({
      env: {
        ASSETS: {
          fetch: assetFetch,
        },
      },
    });
    getConfiguredAppOriginMock.mockReturnValue("https://agentrelay.com");
    toAppPathMock.mockImplementation((pathname: string) => `/cloud${pathname}`);
    toAbsoluteAppUrlMock.mockImplementation(
      (origin: string, pathname: string) => new URL(pathname === "/" ? "/cloud" : `/cloud${pathname}`, origin),
    );
    const { POST } = await loadRoute();

    const response = await POST(
      new Request("https://origin.agentrelay.com/cloud/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow: "name: sandbox-test\nagents: []",
          fileType: "yaml",
        }),
      }) as never,
    );

    expect(response.status).toBe(200);
    await flushBackgroundLaunches();
    expect(assetFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        href: "https://origin.agentrelay.com/cloud/orchestrator-lib.tar.gz",
      }),
    );
    expect(launchOrchestratorSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orchestratorLibTarball: assetBytes,
        orchestratorLibUrl: "https://agentrelay.com/cloud/orchestrator-lib.tar.gz",
      }),
    );
  });

  it("falls back to the orchestrator lib URL when the ASSETS binding misses", async () => {
    const assetFetch = vi.fn(async () => new Response("not found", { status: 404 }));
    getCloudflareContextMock.mockReturnValue({
      env: {
        ASSETS: {
          fetch: assetFetch,
        },
      },
    });
    getConfiguredAppOriginMock.mockReturnValue("https://agentrelay.com");
    toAppPathMock.mockImplementation((pathname: string) => `/cloud${pathname}`);
    toAbsoluteAppUrlMock.mockImplementation(
      (origin: string, pathname: string) => new URL(pathname === "/" ? "/cloud" : `/cloud${pathname}`, origin),
    );
    const { POST } = await loadRoute();

    const response = await POST(
      new Request("https://origin.agentrelay.com/cloud/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow: "name: sandbox-test\nagents: []",
          fileType: "yaml",
        }),
      }) as never,
    );

    expect(response.status).toBe(200);
    await flushBackgroundLaunches();
    expect(assetFetch).toHaveBeenCalledOnce();
    expect(launchOrchestratorSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orchestratorLibTarball: undefined,
        orchestratorLibUrl: "https://agentrelay.com/cloud/orchestrator-lib.tar.gz",
      }),
    );
  });

  it("falls back to the orchestrator lib URL when ASSETS returns non-gzip bytes", async () => {
    const assetFetch = vi.fn(async () =>
      new Response("<!doctype html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    getCloudflareContextMock.mockReturnValue({
      env: {
        ASSETS: {
          fetch: assetFetch,
        },
      },
    });
    getConfiguredAppOriginMock.mockReturnValue("https://agentrelay.com");
    toAppPathMock.mockImplementation((pathname: string) => `/cloud${pathname}`);
    toAbsoluteAppUrlMock.mockImplementation(
      (origin: string, pathname: string) => new URL(pathname === "/" ? "/cloud" : `/cloud${pathname}`, origin),
    );
    const { POST } = await loadRoute();

    const response = await POST(
      new Request("https://origin.agentrelay.com/cloud/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow: "name: sandbox-test\nagents: []",
          fileType: "yaml",
        }),
      }) as never,
    );

    expect(response.status).toBe(200);
    await flushBackgroundLaunches();
    expect(assetFetch).toHaveBeenCalledOnce();
    expect(launchOrchestratorSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orchestratorLibTarball: undefined,
        orchestratorLibUrl: "https://agentrelay.com/cloud/orchestrator-lib.tar.gz",
      }),
    );
  });

  it("accepts shared-sandbox runtime config and forwards MSD inputs without GitHub write authority", async () => {
    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow: "name: msd-review\nagents: []",
          fileType: "yaml",
          runtime: {
            kind: "relay-workflow",
            config: {
              executionMode: "shared-sandbox",
              sandboxProvider: "daytona",
              ttlMinutes: 120,
            },
          },
          inputs: {
            repository: { fullName: "my-org/my-repo" },
            pullRequest: { number: 123, headSha: "head" },
            callback: { completionUrl: "https://msd.example.test/completion" },
          },
        }),
      }) as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      relayWorkspaceId: "rw_12345678",
      sandboxId: "sandbox_123",
      executionMode: "shared-sandbox",
      observerUrl: expect.stringContaining("http://localhost/runs/"),
    });
    expect(launchOrchestratorSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        executionMode: "shared-sandbox",
        runtimeConfig: expect.objectContaining({
          executionMode: "shared-sandbox",
          sandboxProvider: "daytona",
          ttlMinutes: 120,
        }),
        runInputs: expect.objectContaining({
          repository: { fullName: "my-org/my-repo" },
          pullRequest: { number: 123, headSha: "head" },
        }),
      }),
    );

    const payload = JSON.stringify(launchOrchestratorSandboxMock.mock.calls.at(-1)?.[0]);
    expect(payload).not.toContain("GITHUB_TOKEN");
    expect(payload).not.toContain("pushAllowed");
  });

  it("rejects shared-sandbox when the request is not MSD review-shaped (no inputs, no source)", async () => {
    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow: "name: random\nagents: []",
          fileType: "yaml",
          runtime: {
            kind: "relay-workflow",
            config: {
              executionMode: "shared-sandbox",
              sandboxProvider: "daytona",
            },
          },
          // No inputs.repository / inputs.pullRequest, no runtime.config.source
        }),
      }) as never,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "shared_sandbox_source_unsupported",
    });
    expect(launchOrchestratorSandboxMock).not.toHaveBeenCalled();
  });

  it("accepts shared-sandbox when the runtime config declares an msd-review source", async () => {
    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow: "name: msd\nagents: []",
          fileType: "yaml",
          runtime: {
            kind: "relay-workflow",
            config: {
              executionMode: "shared-sandbox",
              sandboxProvider: "daytona",
              source: "msd-review",
            },
          },
        }),
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(launchOrchestratorSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        executionMode: "shared-sandbox",
      }),
    );
  });

  it("rejects shared-sandbox for worker dispatch so MCP and worker callers stay explicit", async () => {
    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow: "name: sandbox-test\nagents: []",
          fileType: "yaml",
          runtime: {
            id: "worker",
            config: {
              executionMode: "shared-sandbox",
              name: "worker-one",
            },
          },
        }),
      }) as never,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "shared_sandbox_unsupported",
      runtime: "worker",
    });
    expect(launchOrchestratorSandboxMock).not.toHaveBeenCalled();
    expect(enqueueForWorkerMock).not.toHaveBeenCalled();
  });

  it("does not reject legacy non-env metadata and only forwards valid entries", async () => {
    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow: "name: sandbox-test\nagents: []",
          fileType: "yaml",
          metadata: {
            RICKY_RUN_ID: "ricky_123",
            START_FROM: "reserved",
            "not-env": "ignored",
            nested: { value: "ignored" },
            count: 3,
          },
        }),
      }) as never,
    );

    expect(response.status).toBe(200);
    await flushBackgroundLaunches();
    expect(launchOrchestratorSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          RICKY_RUN_ID: "ricky_123",
        },
      }),
    );
  });

  it("forwards workflow invocation metadata through the sandbox launch payload", async () => {
    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow: "name: invocation-metadata\nagents: []",
          fileType: "yaml",
          metadata: {
            invocationSlug: "echo",
            invocationArgs: JSON.stringify({ foo: 1 }),
            S3_BUCKET: "reserved",
          },
        }),
      }) as never,
    );

    expect(response.status).toBe(200);
    await flushBackgroundLaunches();
    expect(launchOrchestratorSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          invocationSlug: "echo",
          invocationArgs: JSON.stringify({ foo: 1 }),
        },
      }),
    );
  });

  it("accepts direct workspace-token invocation on the heavy workflow run route", async () => {
    resolveRequestAuthMock.mockResolvedValue({
      userId: "sandbox_user",
      workspaceId: "rw_12345678",
      organizationId: "org_123",
      source: "token",
      scopes: ["workflow:invoke:write"],
      subjectType: "sandbox",
    });
    requireSessionAuthMock.mockReturnValue(false);
    requireAuthScopeMock.mockImplementation(
      (_auth: unknown, scope: string) => scope === "workflow:invoke:write",
    );

    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow: "name: forbidden-direct-invoke\nagents: []",
          fileType: "yaml",
        }),
      }) as never,
    );

    expect(response.status).toBe(200);
    await flushBackgroundLaunches();
    expect(launchOrchestratorSandboxMock).toHaveBeenCalled();
  });

  it("rejects direct workspace-token invocation for a different requested workspace", async () => {
    resolveRequestAuthMock.mockResolvedValue({
      userId: "sandbox_user",
      workspaceId: "rw_12345678",
      organizationId: "org_123",
      source: "token",
      scopes: ["workflow:invoke:write"],
      subjectType: "sandbox",
    });
    requireSessionAuthMock.mockReturnValue(false);
    requireAuthScopeMock.mockImplementation(
      (_auth: unknown, scope: string) => scope === "workflow:invoke:write",
    );

    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: "rw_otherworkspace",
          workflow: "console.log('forbidden');",
          fileType: "ts",
        }),
      }) as never,
    );

    expect(response.status).toBe(403);
    expect(launchOrchestratorSandboxMock).not.toHaveBeenCalled();
  });

  it("accepts delegated workspace invocation with workflow sourceFileType metadata", async () => {
    resolveRequestAuthMock.mockResolvedValue({
      userId: "sandbox_user",
      workspaceId: "rw_12345678",
      organizationId: "org_123",
      source: "token",
      scopes: ["workflow:invoke:write"],
      subjectType: "sandbox",
    });
    requireSessionAuthMock.mockReturnValue(false);
    requireAuthScopeMock.mockImplementation(
      (_auth: unknown, scope: string) => scope === "workflow:invoke:write",
    );
    listConnectedProvidersMock.mockResolvedValue(["openai"]);
    getCliCredentialsMock.mockResolvedValue("OPENAI_API_KEY=test-key");

    const {
      POST,
      WORKSPACE_WORKFLOW_INVOCATION_DELEGATION_HEADER,
      WORKSPACE_WORKFLOW_INVOCATION_DELEGATION_TOKEN,
    } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/workflows/run", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [WORKSPACE_WORKFLOW_INVOCATION_DELEGATION_HEADER]:
            WORKSPACE_WORKFLOW_INVOCATION_DELEGATION_TOKEN,
        },
        body: JSON.stringify({
          workflow: "console.log('echo');",
          fileType: "ts",
          sourceFileType: "workflow",
          s3CodeKey: "workflows/echo/latest.tar.gz",
          workflowPath: "workflow.ts",
          metadata: {
            invocationSlug: "echo",
            invocationArgs: JSON.stringify({ foo: 1 }),
          },
        }),
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(workflowStoreCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        fileType: "ts",
      }),
    );
    await flushBackgroundLaunches();
    expect(launchOrchestratorSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        fileType: "typescript",
        workflowFileName: "workflow.ts",
        metadata: {
          invocationSlug: "echo",
          invocationArgs: JSON.stringify({ foo: 1 }),
        },
      }),
    );
  });

  it("uses the deploying user as the owner for relayfile delegated workflow invocations", async () => {
    resolveRequestAuthMock.mockResolvedValue({
      userId: "relay_identity_user",
      workspaceId: "rw_12345678",
      organizationId: "org_dev",
      source: "relayfile",
      scopes: ["workflow:invoke:write"],
      relayfileSponsorId: "673cc207-9ee1-42c1-a3e0-1fe88e148992",
    });
    requireSessionAuthMock.mockReturnValue(false);
    requireAuthScopeMock.mockImplementation(
      (_auth: unknown, scope: string) => scope === "workflow:invoke:write",
    );
    listConnectedProvidersMock.mockResolvedValue(["openai"]);
    getCliCredentialsMock.mockResolvedValue("OPENAI_API_KEY=test-key");

    const insertValuesMock = vi.fn().mockResolvedValue(undefined);
    const insertMock = vi.fn(() => ({ values: insertValuesMock }));
    const limitMock = vi.fn().mockResolvedValue([
      {
        deployedByUserId: "0403d3ba-55ba-4ee6-aeee-13403d9aeac2",
        organizationId: "11111111-2222-4333-8444-555555555555",
      },
    ]);
    const whereMock = vi.fn(() => ({ limit: limitMock }));
    const innerJoinMock = vi.fn(() => ({ where: whereMock }));
    const fromMock = vi.fn(() => ({ innerJoin: innerJoinMock }));
    const selectMock = vi.fn(() => ({ from: fromMock }));
    getDbMock.mockReturnValue({ insert: insertMock, select: selectMock });

    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow: "workflow().agent('impl', { cli: 'codex' });",
          fileType: "ts",
          sourceFileType: "workflow",
        }),
      }) as never,
    );

    expect(response.status).toBe(200);
    await flushBackgroundLaunches();
    expect(createApiTokenSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "0403d3ba-55ba-4ee6-aeee-13403d9aeac2",
        workspaceId: "rw_12345678",
        organizationId: "11111111-2222-4333-8444-555555555555",
        accessTokenTtlSeconds: 4 * 3600,
      }),
    );
    expect(listConnectedProvidersMock).toHaveBeenCalledWith(
      "0403d3ba-55ba-4ee6-aeee-13403d9aeac2",
      "cred-key",
    );
    expect(getCliCredentialsMock).toHaveBeenCalledWith(
      "0403d3ba-55ba-4ee6-aeee-13403d9aeac2",
      "openai",
      "cred-key",
    );
    expect(mintS3CredentialsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "0403d3ba-55ba-4ee6-aeee-13403d9aeac2",
        runId: expect.any(String),
      }),
    );
    expect(resolveOrProvisionRelayWorkspaceMock).toHaveBeenCalledWith({
      userId: "0403d3ba-55ba-4ee6-aeee-13403d9aeac2",
      appWorkspaceId: "rw_12345678",
    });
    expect(buildCredentialBundleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "0403d3ba-55ba-4ee6-aeee-13403d9aeac2",
      }),
    );
    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "0403d3ba-55ba-4ee6-aeee-13403d9aeac2",
        organizationId: "11111111-2222-4333-8444-555555555555",
        workspaceId: "rw_12345678",
      }),
    );
    expect(workflowStoreCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "0403d3ba-55ba-4ee6-aeee-13403d9aeac2",
        workspaceId: "rw_12345678",
      }),
    );
    expect(launchOrchestratorSandboxMock).toHaveBeenCalled();
  });

  it("passes Ricky rerun context through worker dispatch payload packaging", async () => {
    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: "run_repaired",
          workflow: "console.log('fixed');",
          fileType: "ts",
          sourceFileType: "ts",
          s3CodeKey: "user-123/run_repaired/code.tar.gz",
          workflowPath: "workflows/fix.ts",
          previousRunId: "run_failed",
          startFrom: "verify",
          metadata: {
            RICKY_RUN_ID: "ricky_123",
            RICKY_ATTEMPT: "2",
            RICKY_REPAIR_MODE: "ricky_openrouter",
          },
          runtime: {
            id: "worker",
            config: { name: "worker-one" },
          },
        }),
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(workerRegistrySelectMock).toHaveBeenCalledWith("rw_12345678", { name: "worker-one" });
    expect(packageWorkflowRefMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run_repaired",
        workflow: "console.log('fixed');",
        fileType: "ts",
        sourceFileType: "ts",
        workflowFileName: "workflow.ts",
        s3CodeKey: "user-123/run_repaired/code.tar.gz",
        previousRunId: "run_failed",
        startFrom: "verify",
        relaycastBaseUrl: "https://api.relaycast.test",
        metadata: {
          RICKY_RUN_ID: "ricky_123",
          RICKY_ATTEMPT: "2",
          RICKY_REPAIR_MODE: "ricky_openrouter",
        },
      }),
    );
    expect(enqueueForWorkerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run_repaired",
        workflowRef: {
          type: "inline",
          value: JSON.stringify({ runId: "run_123" }),
        },
      }),
    );
  });

  it("forwards multi-repo paths through worker dispatch payload packaging", async () => {
    // Phase B P1: a multi-path submit dispatched to worker mode must
    // include `paths` in the queued payload so the worker can mount
    // per-repo dirs. Pre-fix, only `s3CodeKey` was carried over and
    // `paths` was silently dropped, leaving multi-repo workers with
    // nothing to mount.
    resolveRepoAllowlistOrRelaxedMock.mockResolvedValue({
      workspaceId: "ws-1",
      repoOwner: "agentrelay",
      repoName: "cloud",
      installationId: "install_1",
      pushAllowed: false,
      allowedAt: new Date(),
      allowedBy: "user-1",
    });

    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: "run_multi",
          workflow: "console.log('multi');",
          fileType: "ts",
          sourceFileType: "ts",
          workflowPath: "cloud/workflows/runner.ts",
          paths: [
            {
              name: "cloud",
              s3CodeKey: "user-123/run_multi/cloud.tar.gz",
              repoOwner: "agentrelay",
              repoName: "cloud",
            },
            {
              name: "relay",
              s3CodeKey: "user-123/run_multi/relay.tar.gz",
            },
          ],
          runtime: {
            id: "worker",
            config: { name: "worker-one" },
          },
        }),
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(packageWorkflowRefMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run_multi",
        // The carry-over: paths must be present in what's packaged into
        // workflowRef. If this assertion fails, multi-repo workers will
        // boot without any path tarballs to download.
        paths: [
          expect.objectContaining({
            name: "cloud",
            s3CodeKey: "user-123/run_multi/cloud.tar.gz",
            repoOwner: "agentrelay",
            repoName: "cloud",
          }),
          expect.objectContaining({
            name: "relay",
            s3CodeKey: "user-123/run_multi/relay.tar.gz",
          }),
        ],
      }),
    );
  });

  it("revokes the token session when relay workspace provisioning fails (sandbox path)", async () => {
    resolveOrProvisionRelayWorkspaceMock.mockRejectedValue(
      new Error("relaycast backend rejected create"),
    );

    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow: "name: sandbox-test\nagents: []",
          fileType: "yaml",
        }),
      }) as never,
    );

    // The per-step-sandbox path responds immediately (the launch runs in the
    // background), so a provisioning failure no longer surfaces as a 500 on
    // this response — it is handled by performLaunch's own cleanup and the
    // background catch marks the run failed.
    expect(response.status).toBe(200);
    await flushBackgroundLaunches();
    expect(launchOrchestratorSandboxMock).not.toHaveBeenCalled();
    // Regression guard: performLaunch OWNS its API-token session cleanup. Even
    // when the failure runs in the background (so it never reaches the outer
    // catch), the session created for the launch must still be revoked.
    expect(revokeApiTokenSessionByIdMock).toHaveBeenCalledWith(
      "session_123",
      "launch_failed",
    );
    // The background catch marks the run failed so status polls reflect it.
    expect(workflowStoreUpdateMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("surfaces workflow storage broker throttling as a transient storage outage", async () => {
    const { BrokerClientError } = await import("@/lib/aws/broker-client");
    mintS3CredentialsMock.mockRejectedValue(
      new BrokerClientError(
        '[broker-client] broker rejected request: 429 {"Reason":"ConcurrentInvocationLimitExceeded","Type":"User","message":"Rate Exceeded."}',
        429,
      ),
    );

    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow: "name: sandbox-test\nagents: []",
          fileType: "yaml",
        }),
      }) as never,
    );

    // The per-step-sandbox path responds before the (background) launch, so a
    // mid-launch storage broker throttle no longer surfaces synchronously as a
    // 503. It is caught in the background and the run is marked failed; status
    // polls then reflect the failure. (The shared-sandbox path still awaits the
    // launch and surfaces the BrokerClientError 503 — see the outer catch.)
    expect(response.status).toBe(200);
    await flushBackgroundLaunches();
    expect(workflowStoreUpdateMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("marks a per-step run failed with the real error message (not the launch_response sentinel) when no CLI credentials are connected", async () => {
    // TS workflow → needs CLI creds; no connected providers → the pre-launch
    // no-creds LaunchResponseError fires inside the backgrounded performLaunch.
    listConnectedProvidersMock.mockResolvedValue([]);

    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow: "export default async function () {}",
          fileType: "ts",
        }),
      }) as never,
    );

    // Per-step responds immediately; the no-creds failure surfaces via the
    // background catch marking the run failed.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      runId: expect.any(String),
      status: "pending",
    });
    await flushBackgroundLaunches();

    // Regression for the LaunchResponseError message: the run.error must carry
    // the REAL reason, not the "launch_response" sentinel.
    const failedCall = workflowStoreUpdateMock.mock.calls.find(
      ([, patch]) => (patch as { status?: string } | undefined)?.status === "failed",
    );
    expect(failedCall).toBeDefined();
    const errorText = (failedCall?.[1] as { error?: string } | undefined)?.error ?? "";
    expect(errorText).toContain("No CLI credentials connected");
    expect(errorText).not.toContain("launch_response");
  });

  it("does not leave a stuck pending run row when a shared-sandbox launch fails", async () => {
    // Shared-sandbox awaits the launch synchronously and uses create-after-
    // success (no early-create), so a failed launch must leave NO run row.
    launchOrchestratorSandboxMock.mockRejectedValue(new Error("daytona shared launch boom"));

    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow: "name: msd-review\nagents: []",
          fileType: "yaml",
          runtime: {
            kind: "relay-workflow",
            config: { executionMode: "shared-sandbox", sandboxProvider: "daytona", ttlMinutes: 120 },
          },
          inputs: {
            repository: { fullName: "my-org/my-repo" },
            pullRequest: { number: 123, headSha: "head" },
            callback: { completionUrl: "https://msd.example.test/completion" },
          },
        }),
      }) as never,
    );

    // Shared-sandbox awaits the launch, so the failure surfaces on this response.
    expect(response.status).toBe(500);
    // No orphaned "pending" row: shared never pre-creates, and the post-launch
    // create is never reached because the launch threw first.
    expect(workflowStoreCreateMock).not.toHaveBeenCalled();
    // performLaunch still cleans up the API-token session on failure.
    expect(revokeApiTokenSessionByIdMock).toHaveBeenCalledWith("session_123", "launch_failed");
  });

  it("accepts valid paths and forwards only read-only mount fields to the sandbox", async () => {
    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow: "name: sandbox-test\nagents: []",
          fileType: "yaml",
          paths: [
            {
              name: "cloud",
              s3CodeKey: "code-cloud.tar.gz",
              repoOwner: "AgentWorkforce",
              repoName: "cloud",
            },
          ],
        }),
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(resolveRepoAllowlistOrRelaxedMock).toHaveBeenCalledWith("rw_12345678", "AgentWorkforce", "cloud");
    await flushBackgroundLaunches();
    expect(launchOrchestratorSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        paths: [
          {
            name: "cloud",
            s3CodeKey: "code-cloud.tar.gz",
            repoOwner: "AgentWorkforce",
            repoName: "cloud",
          },
        ],
      }),
    );
    expect(JSON.stringify(launchOrchestratorSandboxMock.mock.calls[0][0])).not.toContain("pushAllowed");
    expect(workflowStoreCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        paths: [
          {
            name: "cloud",
            s3CodeKey: "code-cloud.tar.gz",
            repoOwner: "AgentWorkforce",
            repoName: "cloud",
          },
        ],
      }),
    );
  });

  it("rejects with 400 repo_not_allowlisted when the resolver returns null", async () => {
    // The diagnostic bypass from #428 is gone (cloud#439 restored the
    // gate). When the resolver returns null cleanly — meaning no
    // install can reach the repo and no infra error — the route must
    // fail closed at submit so the sandbox doesn't get launched
    // against a repo Phase C will be unable to push to.
    resolveRepoAllowlistOrRelaxedMock.mockResolvedValue(null);
    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow: "name: sandbox-test\nagents: []",
          fileType: "yaml",
          paths: [
            {
              name: "cloud",
              s3CodeKey: "code-cloud.tar.gz",
              repoOwner: "AgentWorkforce",
              repoName: "cloud",
            },
          ],
        }),
      }) as never,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "repo_not_allowlisted",
      repoOwner: "AgentWorkforce",
      repoName: "cloud",
    });
    expect(launchOrchestratorSandboxMock).not.toHaveBeenCalled();
  });

  it("rejects with 503 allowlist_resolver_unavailable when the resolver throws (infra misconfig)", async () => {
    // Distinct from null-return: when the resolver throws (e.g. Nango
    // secret binding missing on the lambda, install revoked, transient
    // 5xx from GitHub during the access probe) the route must surface
    // the underlying error rather than collapsing it into 400
    // `repo_not_allowlisted`. Operators reading the response can then
    // tell "fix Nango/App wiring" apart from "this repo isn't listed".
    resolveRepoAllowlistOrRelaxedMock.mockRejectedValue(
      Object.assign(new Error("NANGO_SECRET_KEY is not configured."), {
        name: "PushBackError",
        code: "installation_token_failed",
      }),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { POST } = await loadRoute();

      const response = await POST(
        new Request("http://localhost/api/v1/workflows/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workflow: "name: sandbox-test\nagents: []",
            fileType: "yaml",
            paths: [
              {
                name: "cloud",
                s3CodeKey: "code-cloud.tar.gz",
                repoOwner: "AgentWorkforce",
                repoName: "cloud",
              },
            ],
          }),
        }) as never,
      );

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: "allowlist_resolver_unavailable",
        message: expect.stringContaining("NANGO_SECRET_KEY"),
      });
      expect(launchOrchestratorSandboxMock).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("accepts non-git path submissions without an allowlist lookup", async () => {
    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow: "name: sandbox-test\nagents: []",
          fileType: "yaml",
          paths: [
            {
              name: "fixture",
              s3CodeKey: "code-fixture.tar.gz",
            },
          ],
        }),
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(resolveRepoAllowlistOrRelaxedMock).not.toHaveBeenCalled();
    await flushBackgroundLaunches();
    expect(launchOrchestratorSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        paths: [{ name: "fixture", s3CodeKey: "code-fixture.tar.gz" }],
      }),
    );
  });

  it("treats explicit empty paths as legacy single-repo submission", async () => {
    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow: "name: sandbox-test\nagents: []",
          fileType: "yaml",
          s3CodeKey: "code.tar.gz",
          paths: [],
        }),
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(resolveRepoAllowlistOrRelaxedMock).not.toHaveBeenCalled();
    expect(workflowStoreCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        paths: undefined,
      }),
    );
    await flushBackgroundLaunches();
    expect(launchOrchestratorSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        s3CodeKey: "code.tar.gz",
        paths: [],
      }),
    );
  });

  it("persists validated push-back options from path submissions", async () => {
    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow: "name: sandbox-test\nagents: []",
          fileType: "yaml",
          paths: [
            {
              name: "cloud",
              s3CodeKey: "code-cloud.tar.gz",
              repoOwner: "AgentWorkforce",
              repoName: "cloud",
              pushBranch: "feature/api-keys",
              pushBase: "develop",
              pushPrBody: "Custom PR body",
            },
          ],
        }),
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(workflowStoreCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        paths: [
          expect.objectContaining({
            name: "cloud",
            pushBranch: "feature/api-keys",
            pushBase: "develop",
            pushPrBody: "Custom PR body",
          }),
        ],
      }),
    );
  });

  it("rejects unsafe push branch names in path submissions", async () => {
    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow: "name: sandbox-test\nagents: []",
          fileType: "yaml",
          paths: [
            {
              name: "cloud",
              s3CodeKey: "code-cloud.tar.gz",
              repoOwner: "AgentWorkforce",
              repoName: "cloud",
              pushBranch: "../bad",
            },
          ],
        }),
      }) as never,
    );

    expect(response.status).toBe(400);
  });

  it("does not leak pushAllowed into the sandbox launch payload", async () => {
    const body = {
      workflow: "name: sandbox-test\nagents: []",
      fileType: "yaml",
      runId: "11111111-1111-4111-8111-111111111111",
      paths: [
        {
          name: "cloud",
          s3CodeKey: "code-cloud.tar.gz",
          repoOwner: "AgentWorkforce",
          repoName: "cloud",
        },
      ],
    };

    const { POST } = await loadRoute();
    resolveRepoAllowlistOrRelaxedMock.mockResolvedValueOnce({ pushAllowed: false });
    await POST(
      new Request("http://localhost/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }) as never,
    );
    await flushBackgroundLaunches();
    const falsePayload = { ...launchOrchestratorSandboxMock.mock.calls.at(-1)?.[0], callbackToken: "<nonce>" };

    vi.clearAllMocks();
    resolveRequestAuthMock.mockResolvedValue({
      userId: "user_123",
      workspaceId: "rw_12345678",
      organizationId: "org_123",
      source: "session",
    });
    requireSessionAuthMock.mockReturnValue(true);
    requireAuthScopeMock.mockReturnValue(true);
    workflowNeedsCliCredentialsMock.mockReturnValue(false);
    resolveRelayfileConfigMock.mockReturnValue({
      relayfileUrl: "https://relayfile.test",
      relayJwtSecret: "relay-jwt-secret",
      relayAuthUrl: "https://api.relayauth.test",
      relayAuthApiKey: "relayauth-api-key",
    });
    createApiTokenSessionMock.mockResolvedValue({
      sessionId: "session_123",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      accessTokenExpiresAt: "2026-04-19T12:00:00.000Z",
    });
    mintS3CredentialsMock.mockResolvedValue({
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "secret",
      sessionToken: "session-token",
      bucket: "workflow-bucket",
      prefix: "user-123/run-123",
    });
    resolveServerDaytonaAuthParamsMock.mockReturnValue({ daytonaApiKey: "daytona-key" });
    resolveRelayApiKeyForWorkspaceMock.mockResolvedValue("rk_live_workspace");
    resolveOrProvisionRelayWorkspaceMock.mockResolvedValue({
      id: "rw_12345678",
      relaycastApiKey: "rk_live_workspace",
      provisioned: false,
    });
    buildCredentialBundleMock.mockImplementation((input: unknown) => input);
    launchOrchestratorSandboxMock.mockResolvedValue({ sandboxId: "sandbox_123" });
    workflowStoreCreateMock.mockResolvedValue({});
    workflowStoreUpdateMock.mockResolvedValue({});
    attachSandboxToApiTokenSessionMock.mockResolvedValue(undefined);
    getBrokerKeySecretMock.mockReturnValue("broker-secret");
    toAbsoluteAppUrlMock.mockImplementation((origin: string, pathname: string) => new URL(pathname, origin));
    resolveRepoAllowlistOrRelaxedMock.mockResolvedValueOnce({ pushAllowed: true });
    const insertValuesMock = vi.fn().mockResolvedValue(undefined);
    const insertMock = vi.fn(() => ({ values: insertValuesMock }));
    getDbMock.mockReturnValue({ insert: insertMock });

    await POST(
      new Request("http://localhost/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }) as never,
    );
    await flushBackgroundLaunches();
    const truePayload = { ...launchOrchestratorSandboxMock.mock.calls.at(-1)?.[0], callbackToken: "<nonce>" };

    expect(JSON.stringify(truePayload)).not.toContain("pushAllowed");
    expect(truePayload).toEqual(falsePayload);
  });

  it("rejects unsupported runtime ids with a 400 instead of falling back to daytona", async () => {
    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow: "name: sandbox-test\nagents: []",
          fileType: "yaml",
          runtime: { id: "foo" },
        }),
      }) as never,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "unsupported_runtime",
    });
    expect(launchOrchestratorSandboxMock).not.toHaveBeenCalled();
    expect(enqueueForWorkerMock).not.toHaveBeenCalled();
  });

  it("strips credential-shaped keys from runtimeConfig and runInputs before forwarding to the sandbox", async () => {
    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow: "name: sandbox-test\nagents: []",
          fileType: "yaml",
          runtime: {
            id: "daytona",
            config: {
              source: "msd-review",
              version: "2026-05-07",
              executionMode: "shared-sandbox",
              sandboxProvider: "daytona",
              ttlMinutes: 60,
              GITHUB_TOKEN: "ghp_should_be_stripped",
              providerSecret: "should_also_be_stripped",
            },
          },
          inputs: {
            repository: { fullName: "my-org/my-repo", surprise: "drop me" },
            pullRequest: { number: 42, headSha: "head", token: "drop me" },
            callback: { completionUrl: "https://msd.example.test/done", auth: "drop me" },
            profilePlan: { ok: true, secretKey: "drop me", apiToken: "drop me" },
            attacker_field: "drop me",
          },
        }),
      }) as never,
    );

    expect(response.status).toBe(200);
    const launchOpts = launchOrchestratorSandboxMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(launchOpts).toBeDefined();
    const serialized = JSON.stringify({
      runtimeConfig: launchOpts.runtimeConfig,
      runInputs: launchOpts.runInputs,
    });
    expect(serialized).not.toContain("ghp_should_be_stripped");
    expect(serialized).not.toContain("providerSecret");
    expect(serialized).not.toContain("attacker_field");
    expect(serialized).not.toContain("surprise");
    expect(serialized).not.toContain("\"token\"");
    expect(serialized).not.toContain("\"auth\"");
    expect(serialized).not.toContain("secretKey");
    expect(serialized).not.toContain("apiToken");
    // Allowed fields survived.
    expect(launchOpts.runtimeConfig).toMatchObject({
      source: "msd-review",
      executionMode: "shared-sandbox",
      sandboxProvider: "daytona",
      ttlMinutes: 60,
    });
    expect(launchOpts.runInputs).toMatchObject({
      repository: { fullName: "my-org/my-repo" },
      pullRequest: { number: 42, headSha: "head" },
      callback: { completionUrl: "https://msd.example.test/done" },
      profilePlan: { ok: true },
    });
  });
});
