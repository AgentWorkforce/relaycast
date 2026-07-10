import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { slackUserReplyCorrelationKey } from "./continuation-correlation";

const mocks = vi.hoisted(() => ({
  createInitialAgentDeployment: vi.fn(),
  deriveRelayfileMountPaths: vi.fn(),
  getAgentDeploymentTickTarget: vi.fn(),
  execute: vi.fn(),
  getDb: vi.fn(),
  loadBundle: vi.fn(),
  mintRelayfileToken: vi.fn(),
  mintWorkspaceScopedRelayfileTokenPair: vi.fn(async (_input?: unknown) => ({
    accessToken: "relay-ag-token",
    refreshToken: "relay-ag-refresh",
    accessTokenExpiresAt: "2026-06-19T13:30:00.000Z",
    refreshTokenExpiresAt: "2026-09-17T12:30:00.000Z",
    tokenType: "Bearer",
    scopes: ["relayfile:fs:read:/slack/**", "relayfile:fs:write:/slack/**", "relayfile:ops:read:*"],
  })),
  mintPathScopedRelayfileToken: vi.fn(async (_input?: unknown) => "relay-pa-token"),
  mintRelayAuthWorkspaceToken: vi.fn(),
  relayfileReadFile: vi.fn(),
  relayfileWriteFile: vi.fn(),
  createCredentialStoreS3Client: vi.fn(),
  credentialStoreRetrieve: vi.fn(),
  mountCliCredentials: vi.fn(),
  resolveDaytonaCredentialRuntimeEnv: vi.fn(),
  resolveProviderCredentialRuntimeEnv: vi.fn(),
  resolveSubscriptionFallbackEnv: vi.fn(),
  deriveCtxLlmEnvFromHarnessCredential: vi.fn((): Record<string, string> => ({})),
  mintWorkflowGithubWriteToken: vi.fn(),
  postLinearAgentSessionTerminalWriteback: vi.fn(),
  postSlackConversationTerminalReply: vi.fn(),
  resolveGitCloneCredentials: vi.fn(),
  relayfilePathsForIntegrations: vi.fn((): string[] => []),
  buildRelayfileMountCleanupInvocationShell: vi.fn(() => ""),
  buildRelayfileMountLifecycleShell: vi.fn(() => ""),
  readGithubProxyCommitCheckRuns: vi.fn(),
  readGithubProxyPullRequest: vi.fn(),
  GithubProxyPullRequestError: class GithubProxyPullRequestError extends Error {
    readonly status: number;
    readonly code: string;

    constructor(code: string, message: string, status = 500) {
      super(message);
      this.name = "GithubProxyPullRequestError";
      this.status = status;
      this.code = code;
    }
  },
  resolveRelayAuthConfig: vi.fn(),
  resolveRelayfileConfig: vi.fn(),
  resolveRelayWorkspaceIdForRuntime: vi.fn(),
  fetch: vi.fn(),
  continuationStore: {
    get: vi.fn(),
    put: vi.fn(),
    findByCorrelation: vi.fn(),
  },
  PostgresContinuationStore: vi.fn(),
  runtime: {
    id: "daytona",
    findByLabels: vi.fn(),
    findAllByLabels: vi.fn(),
    getById: vi.fn(),
    launch: vi.fn(),
    launchDetached: vi.fn(),
    uploadBundle: vi.fn(),
    runScript: vi.fn(),
    startScript: vi.fn(),
    getScriptStatus: vi.fn(),
    getScriptLogs: vi.fn(),
    destroy: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({
  getDb: mocks.getDb,
}));

vi.mock("@/lib/proactive-runtime/bundle-store", () => ({
  loadBundle: mocks.loadBundle,
}));

vi.mock("@/lib/proactive-runtime/persona-deploy", () => ({
  createInitialAgentDeployment: mocks.createInitialAgentDeployment,
  deriveRelayfileMountPaths: mocks.deriveRelayfileMountPaths,
  getAgentDeploymentTickTarget: mocks.getAgentDeploymentTickTarget,
}));

vi.mock("@/lib/proactive-runtime/continuation-adapters", () => ({
  PostgresContinuationStore: mocks.PostgresContinuationStore,
}));

vi.mock("@/lib/proactive-runtime/sandbox-runtime", () => ({
  createDeploymentSandboxRuntime: vi.fn(() => mocks.runtime),
}));

vi.mock("sst", () => ({
  Resource: {
    CredentialEncryptionKey: { value: "credential-encryption-key" },
    WorkflowStorage: { bucketName: "workflow-storage-bucket" },
  },
}));

vi.mock("@cloud/core/executor/sandbox-orchestrator.js", () => ({
  buildRelayfileMountCleanupInvocationShell: mocks.buildRelayfileMountCleanupInvocationShell,
  buildRelayfileMountLifecycleShell: mocks.buildRelayfileMountLifecycleShell,
  SandboxOrchestrator: class SandboxOrchestrator {
    constructor(private readonly impl: {
      provision?: (...args: unknown[]) => unknown;
      uploadBundle?: (...args: unknown[]) => unknown;
      runScript?: (...args: unknown[]) => unknown;
      teardown?: (...args: unknown[]) => unknown;
    }) {}

    provision(options: unknown) {
      return this.impl.provision?.(options);
    }

    uploadBundle(handle: unknown, files: unknown) {
      return this.impl.uploadBundle?.(handle, files);
    }

    runScript(handle: unknown, options: unknown) {
      return this.impl.runScript?.(handle, options);
    }

    teardown(handle: unknown) {
      return this.impl.teardown?.(handle);
    }

    captureOutput(result: unknown) {
      return result;
    }
  },
}));

vi.mock("@cloud/core/proactive-runtime/runtime-package.js", () => ({
  WORKFORCE_RUNTIME_AWS_SMITHY_SPECS: [
    "@aws-sdk/client-s3@3.1041.0",
    "@aws-sdk/client-sts@3.1037.0",
    "@aws-sdk/lib-storage@3.1037.0",
    "@smithy/smithy-client@4.12.13",
  ],
  WORKFORCE_RUNTIME_AWS_SMITHY_REQUIRE_CHECK:
    "const smithy=require('@smithy/smithy-client');if(typeof smithy.emitWarningIfUnsupportedVersion!=='function'){throw new Error('@smithy/smithy-client resolved without emitWarningIfUnsupportedVersion: '+require.resolve('@smithy/smithy-client'))};require('@aws-sdk/client-s3');require('@aws-sdk/client-sts');require('@aws-sdk/lib-storage');",
  WORKFORCE_RUNTIME_PACKAGE: "@agentworkforce/runtime",
  WORKFORCE_RUNTIME_SMITHY_DIAGNOSTIC: "console.log('[smithy-diag] stub')",
  WORKFORCE_RUNTIME_SMITHY_LOAD_CHECK:
    "const smithy=require('@smithy/smithy-client');if(typeof smithy.emitWarningIfUnsupportedVersion!=='function'){throw new Error('@smithy/smithy-client resolved without emitWarningIfUnsupportedVersion: '+require.resolve('@smithy/smithy-client'))};require('@aws-sdk/client-s3');require('@aws-sdk/client-sts');require('@aws-sdk/lib-storage');import('@agentworkforce/runtime')",
  WORKFORCE_RUNTIME_SPEC: "@agentworkforce/runtime@3.0.42",
  WORKFORCE_RUNTIME_VERSION: "3.0.42",
}));

vi.mock("@cloud/core/auth/cli-credentials.js", async () => {
  // Real module for the pure helpers (extractAnthropicOauthToken) — only the
  // sandbox-touching mount is mocked. A bare factory object here silently
  // breaks every new export (the factory-mock missing-export trap).
  const actual = await vi.importActual<
    typeof import("@cloud/core/auth/cli-credentials.js")
  >("@cloud/core/auth/cli-credentials.js");
  return {
    ...actual,
    CLI_TO_PROVIDER: {
      claude: "anthropic",
      codex: "openai",
      gemini: "google",
      opencode: "opencode",
    },
    extractAnthropicOauthToken: actual.extractAnthropicOauthToken ?? ((credentialJson: string) => {
      try {
        const parsed = JSON.parse(credentialJson) as {
          modelProvider?: unknown;
          token?: unknown;
          type?: unknown;
        };
        return parsed.type === "oauth_token"
          && (parsed.modelProvider === undefined || parsed.modelProvider === "anthropic")
          && typeof parsed.token === "string"
          && parsed.token.length > 0
          ? parsed.token
          : null;
      } catch {
        return null;
      }
    }),
    mountCliCredentials: mocks.mountCliCredentials,
  };
});

vi.mock("@cloud/core/auth/credential-store.js", () => ({
  CredentialStore: class CredentialStore {
    readonly config: unknown;

    constructor(config: unknown) {
      this.config = config;
    }

    retrieve(userId: string, provider: string) {
      return mocks.credentialStoreRetrieve(userId, provider);
    }
  },
}));

vi.mock("@/lib/storage", () => ({
  createCredentialStoreS3Client: mocks.createCredentialStoreS3Client,
}));

vi.mock("@/lib/billing/provider-credential-runtime", () => ({
  resolveDaytonaCredentialRuntimeEnv: mocks.resolveDaytonaCredentialRuntimeEnv,
  resolveProviderCredentialRuntimeEnv: mocks.resolveProviderCredentialRuntimeEnv,
  resolveSubscriptionFallbackEnv: mocks.resolveSubscriptionFallbackEnv,
  deriveCtxLlmEnvFromHarnessCredential: mocks.deriveCtxLlmEnvFromHarnessCredential,
}));

vi.mock("@/lib/integrations/github-workflow-write-token", () => ({
  mintWorkflowGithubWriteToken: mocks.mintWorkflowGithubWriteToken,
}));

vi.mock("@/lib/integrations/linear-agent-activity-writeback", () => ({
  postLinearAgentSessionTerminalWriteback:
    mocks.postLinearAgentSessionTerminalWriteback,
}));

vi.mock("@/lib/proactive-runtime/slack-conversation-terminal-reply", () => ({
  postSlackConversationTerminalReply: mocks.postSlackConversationTerminalReply,
}));

vi.mock("@/lib/integrations/github-clone-token", () => ({
  resolveGitCloneCredentials: mocks.resolveGitCloneCredentials,
}));

vi.mock("@/lib/integrations/github-proxy-pull-request", () => {
  return {
    GithubProxyPullRequestError: mocks.GithubProxyPullRequestError,
    readGithubProxyCommitCheckRuns: mocks.readGithubProxyCommitCheckRuns,
    readGithubProxyPullRequest: mocks.readGithubProxyPullRequest,
  };
});

vi.mock("@cloud/core/relayfile/event-scopes.js", () => ({
  eventScopedSyncPaths: vi.fn(() => []),
}));

vi.mock("@cloud/core/relayfile/path-scopes.js", () => ({
  normalizeRelayfilePath: (path: string) => path,
  relayfilePathsForIntegrations: mocks.relayfilePathsForIntegrations,
}));

vi.mock("@/lib/relayfile", () => ({
  resolveRelayAuthConfig: mocks.resolveRelayAuthConfig,
  resolveRelayfileConfig: mocks.resolveRelayfileConfig,
}));

vi.mock("@/lib/relay-workspaces", () => ({
  mintRelayAuthWorkspaceToken: mocks.mintRelayAuthWorkspaceToken,
  mintPathScopedRelayfileTokenWithWorkspaceCache: vi.fn(async (input) => {
    const workspaceToken = await mocks.mintRelayAuthWorkspaceToken({
      workspaceId: input.workspaceId,
      agentName: input.agentName,
    });
    return mocks.mintPathScopedRelayfileToken({
      ...input,
      workspaceToken,
    });
  }),
}));

vi.mock("@cloud/core/relayfile/client.js", () => ({
  mintPathScopedRelayfileToken: mocks.mintPathScopedRelayfileToken,
  mintRelayfileToken: mocks.mintRelayfileToken,
  mintWorkspaceScopedRelayfileTokenPair: mocks.mintWorkspaceScopedRelayfileTokenPair,
}));

vi.mock("@relayfile/sdk", () => ({
  RelayFileClient: class RelayFileClient {
    readonly config: unknown;

    constructor(config: unknown) {
      this.config = config;
    }

    readFile(workspaceId: string, path: string) {
      return mocks.relayfileReadFile(workspaceId, path);
    }

    writeFile(input: unknown) {
      return mocks.relayfileWriteFile(input);
    }
  },
}));

vi.mock("@cloud/core/config/snapshot.js", () => ({
  getSnapshotName: vi.fn(async () => "snapshot-current"),
}));

vi.mock("@/lib/workspaces/workspace-integration-identity-core", () => ({
  resolveRelayWorkspaceIdForRuntime: mocks.resolveRelayWorkspaceIdForRuntime,
}));

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks.map((chunk) => {
    if (typeof chunk === "string") {
      return "?";
    }
    if (!chunk) {
      return "?";
    }
    const value = (chunk as { value?: unknown }).value;
    return Array.isArray(value) ? value.join("") : "?";
  }).join("");
}

function sqlParams(query: unknown): unknown[] {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  const params: unknown[] = [];
  for (const chunk of chunks) {
    if (chunk && typeof chunk === "object" && "value" in chunk) {
      const value = (chunk as { value?: unknown }).value;
      if (!Array.isArray(value)) {
        params.push(value);
      }
      continue;
    }
    if (chunk === null || typeof chunk !== "object") {
      params.push(chunk);
    }
  }
  return params;
}

function installDefaultExecuteMock() {
  let claimCount = 0;
  mocks.execute.mockImplementation(async (query: unknown) => {
    const text = sqlText(query);
    if (text.includes("SELECT") && text.includes("FROM conversation_sandbox_leases")) {
      return { rows: [] };
    }
    if (text.includes("INSERT INTO conversation_sandbox_leases")) {
      claimCount += 1;
      return {
        rows: [{
          id: `lease-claim-${claimCount}`,
          workspace_id: "workspace-1",
          deployment_id: "deployment-1",
          agent_id: "agent-1",
          conversation_key: "C123:1770000000.000100",
          harness_session_id: "8b2d5a84-9a22-4e02-8e0b-3d8de624a98c",
          sandbox_id: null,
          sandbox_name: `conv-claimed-${claimCount}`,
          state: "warming",
          lease_until: null,
          last_used_at: new Date("2026-06-08T12:00:00.000Z"),
          attempt_count: 0,
          current_step: "provisioning",
          snapshot_version: "snapshot-current",
        }],
      };
    }
    if (text.includes("UPDATE conversation_sandbox_leases")) {
      return { rowCount: 1, rows: [] };
    }
    return { rows: [] };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.getDb.mockReturnValue({ execute: mocks.execute });
  installDefaultExecuteMock();
  mocks.createInitialAgentDeployment.mockResolvedValue("deployment-1");
  mocks.getAgentDeploymentTickTarget.mockResolvedValue(null);
  mocks.resolveRelayAuthConfig.mockReturnValue({ relayAuthUrl: "https://auth.example", relayAuthApiKey: "" });
  mocks.resolveRelayfileConfig.mockReturnValue({
    relayAuthUrl: "https://auth.example",
      relayfileUrl: "https://relayfile.example",
      relayAuthApiKey: "auth-api-key",
    });
  mocks.mintRelayAuthWorkspaceToken.mockResolvedValue("workspace-token");
  mocks.mintWorkspaceScopedRelayfileTokenPair.mockResolvedValue({
    accessToken: "relay-ag-token",
    refreshToken: "relay-ag-refresh",
    accessTokenExpiresAt: "2026-06-19T13:30:00.000Z",
    refreshTokenExpiresAt: "2026-09-17T12:30:00.000Z",
    tokenType: "Bearer",
    scopes: [
      "relayfile:fs:read:/slack/*",
      "relayfile:fs:write:/slack/*",
      "relayfile:ops:read:*",
    ],
  });
  mocks.mintPathScopedRelayfileToken.mockResolvedValue("relay-pa-token");
  mocks.relayfileReadFile.mockRejectedValue({ status: 404 });
  mocks.relayfileWriteFile.mockResolvedValue({ opId: "op-logs" });
  mocks.createCredentialStoreS3Client.mockResolvedValue({ kind: "worker-aware-s3-client" });
  mocks.credentialStoreRetrieve.mockResolvedValue('{"tokens":{"access_token":"token"}}');
  mocks.mountCliCredentials.mockResolvedValue(undefined);
  mocks.resolveDaytonaCredentialRuntimeEnv.mockResolvedValue({});
  mocks.resolveProviderCredentialRuntimeEnv.mockResolvedValue({ env: {}, credentials: [] });
  mocks.deriveCtxLlmEnvFromHarnessCredential.mockReturnValue({});
  mocks.mintWorkflowGithubWriteToken.mockResolvedValue({
    token: "github-installation-token",
    installationId: "12345",
    repositoryScoped: false,
  });
  mocks.resolveGitCloneCredentials.mockResolvedValue({
    provider: "github",
    username: "x-access-token",
    token: "github-clone-token",
  });
  mocks.readGithubProxyCommitCheckRuns.mockResolvedValue([]);
  mocks.readGithubProxyPullRequest.mockResolvedValue({
    number: 1495,
    head: {
      sha: "hydrated-head-sha",
      ref: "fix/comment-trigger",
      repo: { full_name: "AgentWorkforce/cloud" },
    },
    base: {
      sha: "hydrated-base-sha",
      ref: "main",
      repo: {
        full_name: "AgentWorkforce/cloud",
        clone_url: "https://github.com/AgentWorkforce/cloud.git",
      },
    },
  });
  mocks.resolveRelayWorkspaceIdForRuntime.mockImplementation(async (workspaceId: string) => workspaceId);
  mocks.relayfilePathsForIntegrations.mockReturnValue([]);
  mocks.buildRelayfileMountCleanupInvocationShell.mockReturnValue("");
  mocks.buildRelayfileMountLifecycleShell.mockReturnValue("");
  mocks.deriveRelayfileMountPaths.mockReturnValue([]);
  mocks.loadBundle.mockResolvedValue({
    runner: "console.log('runner');",
    agent: "console.log('agent');",
    packageJson: { dependencies: {} },
  });
  mocks.runtime.findByLabels.mockResolvedValue({
    id: "sbx-starting",
    state: "STARTED",
    name: "cloud-small-issue-codex-deploy",
  });
  mocks.runtime.findAllByLabels.mockResolvedValue([
    {
      id: "sbx-starting",
      state: "STARTED",
      name: "cloud-small-issue-codex-deploy",
    },
  ]);
  mocks.runtime.getById.mockResolvedValue({
    id: "sbx-starting",
    state: "STARTED",
    name: "cloud-small-issue-codex-deploy",
  });
  mocks.runtime.launchDetached.mockResolvedValue({
    id: "sbx-detached",
    state: "STARTED",
    name: "cloud-small-issue-codex-deployment-1",
  });
  mocks.runtime.uploadBundle.mockResolvedValue(undefined);
  mocks.runtime.startScript.mockResolvedValue({
    sessionId: "tick-deployment-1",
    commandId: "cmd-1",
  });
  mocks.fetch.mockResolvedValue(Response.json({ ok: true }));
  mocks.PostgresContinuationStore.mockImplementation(function PostgresContinuationStore() {
    return mocks.continuationStore;
  });
  mocks.continuationStore.get.mockResolvedValue(null);
  mocks.continuationStore.put.mockResolvedValue(undefined);
  mocks.continuationStore.findByCorrelation.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function conversationalDelivery(overrides: {
  workspaceId?: string;
  deploymentId?: string;
  payload?: Record<string, unknown>;
  spec?: Record<string, unknown>;
  options?: Record<string, unknown>;
} = {}) {
  return {
    workspaceId: overrides.workspaceId ?? "workspace-1",
    agentId: "agent-1",
    payload: overrides.payload ?? {
      type: "slack.app_mention",
      provider: "slack",
      eventType: "app_mention",
      slackConversation: {
        channel: "C123",
        threadTs: "1770000000.000100",
      },
    },
    options: { asyncRunScript: true, ...(overrides.options ?? {}) },
    ...(overrides.deploymentId ? { deploymentId: overrides.deploymentId } : {}),
    target: {
      agentId: "agent-1",
      deployedName: "slack-helper",
      deployedByUserId: "user-1",
      personaSlug: "slack-helper",
      status: "active",
      specHash: "spec-hash",
      spec: overrides.spec ?? {
        capabilities: { conversational: true },
        integrations: { slack: { triggers: [{ on: "app_mention" }] } },
      },
      bundleSha256: "bundle-sha",
      inputValues: {},
      credentialSelections: {},
    } as never,
  };
}

describe("deliverDeploymentTrigger conversational sandbox warm lease", () => {
  it("creates a warm conversation sandbox on first fire and passes a seed harness session", async () => {
    vi.stubEnv("CONVERSATION_SANDBOX_WARM_ENABLED", "1");
    mocks.runtime.findAllByLabels.mockResolvedValue([]);
    mocks.runtime.launchDetached.mockResolvedValue({
      id: "sbx-conv-first",
      state: "STARTED",
      name: "conv-workspace-agent-deploy-first",
    });
    mocks.runtime.startScript.mockResolvedValue({
      sessionId: "tick-deployment-1",
      commandId: "cmd-conv-first",
    });
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger(conversationalDelivery({
      deploymentId: "deployment-conv-1",
    }) as never)).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.runtime.launchDetached).toHaveBeenCalledWith(expect.objectContaining({
      labels: expect.objectContaining({
        workspaceId: "workspace-1",
        agentId: "agent-1",
        deploymentId: "deployment-1",
        conversationKey: "C123:1770000000.000100",
        warmLease: "conversational",
      }),
    }));
    expect(mocks.runtime.destroy).not.toHaveBeenCalled();
    const command = String(mocks.runtime.startScript.mock.calls[0]?.[1]?.command ?? "");
    const sessionMatch = command.match(/"harnessSession":\{"id":"([^"]+)","resume":false\}/u);
    expect(sessionMatch?.[1]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(command).toContain("export WORKFORCE_HARNESS_RESUME_SESSION_ID=");
    expect(command).toContain(sessionMatch![1]);
    expect(command).not.toContain("\"resumeContext\"");
    expect(mocks.execute.mock.calls.some((call) =>
      sqlText(call[0]).includes("INSERT INTO conversation_sandbox_leases"),
    )).toBe(true);
  });

  it("reuses a warm conversation sandbox and marks harnessSession resume true", async () => {
    vi.stubEnv("CONVERSATION_SANDBOX_WARM_ENABLED", "true");
    const harnessSessionId = "6e09bb29-79d9-46c1-b391-a447dc0d80aa";
    const leasedHandle = {
      id: "sbx-conv-reuse",
      state: "STARTED",
      name: "conv-existing",
    };
    mocks.execute
      .mockResolvedValueOnce({
        rows: [{
          id: "lease-conv",
          workspace_id: "workspace-1",
          deployment_id: "deployment-conv-1",
          agent_id: "agent-1",
          conversation_key: "C123:1770000000.000100",
          harness_session_id: harnessSessionId,
          sandbox_id: leasedHandle.id,
          sandbox_name: leasedHandle.name,
          state: "warm",
          lease_until: null,
          last_used_at: new Date("2026-06-08T12:00:00.000Z"),
          attempt_count: 1,
          current_step: "sandbox-ready",
          snapshot_version: "snapshot-current",
        }],
      })
      .mockImplementation(async (query: unknown) => {
        const text = sqlText(query);
        if (text.includes("UPDATE conversation_sandbox_leases")) {
          return { rowCount: 1, rows: [] };
        }
        return { rows: [] };
      });
    mocks.runtime.getById.mockResolvedValue(leasedHandle);
    mocks.runtime.startScript.mockResolvedValue({
      sessionId: "tick-deployment-1",
      commandId: "cmd-conv-reuse",
    });
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger(conversationalDelivery({
      deploymentId: "deployment-conv-1",
    }) as never)).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.runtime.launchDetached).not.toHaveBeenCalled();
    expect(mocks.runtime.uploadBundle).toHaveBeenCalled();
    const command = String(mocks.runtime.startScript.mock.calls[0]?.[1]?.command ?? "");
    expect(command).toContain(
      `"harnessSession":{"id":"${harnessSessionId}","resume":true}`,
    );
    expect(command).toContain("export WORKFORCE_HARNESS_RESUME_SESSION_ID=");
    expect(command).toContain(harnessSessionId);
    expect(command).not.toContain("\"resumeContext\"");
    expect(mocks.runtime.destroy).not.toHaveBeenCalled();
  });

  it("reuses across two real-minted deployment ids for the same agent and thread", async () => {
    vi.stubEnv("CONVERSATION_SANDBOX_WARM_ENABLED", "1");
    const harnessSessionId = "4b0aa0c4-a913-4ef6-85a8-87b423a31e5d";
    const firstHandle = { id: "sbx-stable-thread", state: "STARTED", name: "conv-stable-thread" };
    let leaseRecorded = false;
    mocks.createInitialAgentDeployment
      .mockResolvedValueOnce("deployment-fire-1")
      .mockResolvedValueOnce("deployment-fire-2");
    mocks.execute.mockImplementation(async (query: unknown) => {
      const text = sqlText(query);
      if (text.includes("SELECT") && text.includes("FROM conversation_sandbox_leases")) {
        if (text.includes("lease_until IS NOT NULL") || text.includes("ORDER BY")) {
          return { rows: [] };
        }
        return { rows: leaseRecorded ? [{
          id: "lease-stable-thread",
          workspace_id: "workspace-1",
          deployment_id: "deployment-fire-1",
          agent_id: "agent-1",
          conversation_key: "C123:1770000000.000100",
          harness_session_id: harnessSessionId,
          sandbox_id: firstHandle.id,
          sandbox_name: firstHandle.name,
          state: "warm",
          lease_until: null,
          last_used_at: new Date("2026-06-08T12:00:00.000Z"),
          attempt_count: 1,
          current_step: "sandbox-ready",
          snapshot_version: "snapshot-current",
        }] : [] };
      }
      if (text.includes("INSERT INTO conversation_sandbox_leases")) {
        return { rows: [{
          id: "lease-stable-thread",
          workspace_id: "workspace-1",
          deployment_id: "deployment-fire-1",
          agent_id: "agent-1",
          conversation_key: "C123:1770000000.000100",
          harness_session_id: harnessSessionId,
          sandbox_id: null,
          sandbox_name: firstHandle.name,
          state: "warming",
          lease_until: null,
          last_used_at: new Date("2026-06-08T12:00:00.000Z"),
          attempt_count: 0,
          current_step: "provisioning",
          snapshot_version: "snapshot-current",
        }] };
      }
      if (text.includes("UPDATE conversation_sandbox_leases")) {
        if (text.includes("sandbox_id = ?")) leaseRecorded = true;
        return { rowCount: 1, rows: [] };
      }
      return { rows: [] };
    });
    mocks.runtime.findAllByLabels.mockResolvedValue([]);
    mocks.runtime.launchDetached.mockResolvedValue(firstHandle);
    mocks.runtime.getById.mockResolvedValue(firstHandle);
    mocks.runtime.startScript
      .mockResolvedValueOnce({ sessionId: "tick-fire-1", commandId: "cmd-fire-1" })
      .mockResolvedValueOnce({ sessionId: "tick-fire-2", commandId: "cmd-fire-2" });
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger(conversationalDelivery() as never))
      .rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);
    await expect(deliverDeploymentTrigger(conversationalDelivery() as never))
      .rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.runtime.launchDetached).toHaveBeenCalledTimes(1);
    expect(mocks.runtime.uploadBundle).toHaveBeenCalledTimes(2);
    const firstCommand = String(mocks.runtime.startScript.mock.calls[0]?.[1]?.command ?? "");
    const secondCommand = String(mocks.runtime.startScript.mock.calls[1]?.[1]?.command ?? "");
    expect(firstCommand).toContain(`"harnessSession":{"id":"${harnessSessionId}","resume":false}`);
    expect(firstCommand).toContain("WORKFORCE_HARNESS_RESUME_SESSION_RESUME=");
    expect(firstCommand).toContain("'0'");
    expect(secondCommand).toContain(`"harnessSession":{"id":"${harnessSessionId}","resume":true}`);
    expect(secondCommand).toContain("WORKFORCE_HARNESS_RESUME_SESSION_RESUME=");
    expect(secondCommand).toContain("'1'");
    expect(firstCommand).toContain("\"id\":\"deployment-fire-1\"");
    expect(secondCommand).toContain("\"id\":\"deployment-fire-2\"");
  });

  it("leaves non-conversational personas on the existing sandbox acquisition path", async () => {
    vi.stubEnv("CONVERSATION_SANDBOX_WARM_ENABLED", "1");
    mocks.runtime.findAllByLabels.mockResolvedValue([{
      id: "sbx-generic",
      state: "STARTED",
      name: "generic-existing",
    }]);
    mocks.runtime.startScript.mockResolvedValue({
      sessionId: "tick-deployment-1",
      commandId: "cmd-generic",
    });
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger(conversationalDelivery({
      spec: { integrations: { slack: { triggers: [{ on: "app_mention" }] } } },
    }) as never)).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.runtime.findAllByLabels).toHaveBeenCalledWith(
      {
        purpose: "workforce-deploy",
        workspaceId: "workspace-1",
        agentId: "agent-1",
      },
      { states: ["STARTED"], limit: 10 },
    );
    expect(mocks.runtime.launchDetached).not.toHaveBeenCalled();
    const command = String(mocks.runtime.startScript.mock.calls[0]?.[1]?.command ?? "");
    expect(command).not.toContain("harnessSession");
    expect(command).not.toContain("WORKFORCE_HARNESS_RESUME_SESSION_ID");
  });

  it("falls back when Slack channel/thread cannot resolve", async () => {
    vi.stubEnv("CONVERSATION_SANDBOX_WARM_ENABLED", "1");
    mocks.runtime.findAllByLabels.mockResolvedValue([]);
    mocks.runtime.launchDetached.mockResolvedValue({
      id: "sbx-cold",
      state: "STARTED",
      name: "slack-helper-cold",
    });
    mocks.runtime.startScript.mockResolvedValue({
      sessionId: "tick-deployment-1",
      commandId: "cmd-cold",
    });
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger(conversationalDelivery({
      payload: {
        type: "slack.app_mention",
        provider: "slack",
        eventType: "app_mention",
        event: { channel: "C123", text: "hello" },
      },
    }) as never)).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.runtime.launchDetached).toHaveBeenCalledWith(expect.objectContaining({
      labels: expect.not.objectContaining({
        warmLease: "conversational",
      }),
    }));
    const command = String(mocks.runtime.startScript.mock.calls[0]?.[1]?.command ?? "");
    expect(command).not.toContain("harnessSession");
    expect(command).not.toContain("WORKFORCE_HARNESS_RESUME_SESSION_ID");
  });

  it("does not share warm labels across workspaces or threads", async () => {
    vi.stubEnv("CONVERSATION_SANDBOX_WARM_ENABLED", "1");
    mocks.createInitialAgentDeployment
      .mockResolvedValueOnce("deployment-one")
      .mockResolvedValueOnce("deployment-two");
    mocks.runtime.findAllByLabels.mockResolvedValue([]);
    mocks.runtime.launchDetached
      .mockResolvedValueOnce({ id: "sbx-workspace-1", state: "STARTED", name: "conv-one" })
      .mockResolvedValueOnce({ id: "sbx-workspace-2", state: "STARTED", name: "conv-two" });
    mocks.runtime.startScript
      .mockResolvedValueOnce({ sessionId: "tick-deployment-1", commandId: "cmd-one" })
      .mockResolvedValueOnce({ sessionId: "tick-deployment-2", commandId: "cmd-two" });
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger(conversationalDelivery({
      workspaceId: "workspace-1",
      deploymentId: "deployment-one",
      payload: {
        type: "slack.app_mention",
        slackConversation: { channel: "C123", threadTs: "1770000000.000100" },
      },
    }) as never)).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);
    await expect(deliverDeploymentTrigger(conversationalDelivery({
      workspaceId: "workspace-2",
      deploymentId: "deployment-two",
      payload: {
        type: "slack.app_mention",
        slackConversation: { channel: "C123", threadTs: "1770000000.000200" },
      },
    }) as never)).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    const firstLabels = mocks.runtime.launchDetached.mock.calls[0]?.[0]?.labels;
    const secondLabels = mocks.runtime.launchDetached.mock.calls[1]?.[0]?.labels;
    expect(firstLabels).toEqual(expect.objectContaining({
      workspaceId: "workspace-1",
      deploymentId: "deployment-one",
      conversationKey: "C123:1770000000.000100",
    }));
    expect(secondLabels).toEqual(expect.objectContaining({
      workspaceId: "workspace-2",
      deploymentId: "deployment-two",
      conversationKey: "C123:1770000000.000200",
    }));
    expect(firstLabels).not.toMatchObject(secondLabels);
  });
});

describe("buildDeploymentInvokeScript setup gate", () => {
  it("fails closed when runtime setup fails before push-back", async () => {
    const { buildDeploymentInvokeScript } = await import("./deployment-trigger-delivery");

    const command = buildDeploymentInvokeScript({
      envVars: {},
      envelope: { type: "cron.tick" },
      mount: null,
    });

    expect(command).toContain(
      `|| { echo "[proactive-runtime] npm install failed with exit code $?"; exit 1; }`,
    );
    // The load-check failure branch now re-emits the smithy diagnostic before
    // failing closed, so its echo marker is no longer immediately followed by
    // `exit 1`. Assert the marker and the fail-closed `exit 1` tail separately.
    expect(command).toContain(
      `|| { echo "[proactive-runtime] runtime load check failed"; `,
    );
    expect(command).toMatch(
      /echo "\[proactive-runtime\] runtime load check failed";[^}]*exit 1; \}/,
    );
    expect(command).toContain(
      `if [ "$RUNNER_EXIT" -eq 0 ]; then`,
    );
    const installGuardIdx = command.indexOf(
      `|| { echo "[proactive-runtime] npm install failed with exit code $?"; exit 1; }`,
    );
    const loadGuardIdx = command.indexOf(
      `|| { echo "[proactive-runtime] runtime load check failed"; `,
    );
    const runnerIdx = command.indexOf("node /home/daytona/workforce-runtime/runner.mjs");
    const pushGateIdx = command.indexOf(`if [ "$RUNNER_EXIT" -eq 0 ]; then`);

    expect(installGuardIdx).toBeGreaterThan(-1);
    expect(loadGuardIdx).toBeGreaterThan(installGuardIdx);
    expect(runnerIdx).toBeGreaterThan(loadGuardIdx);
    expect(pushGateIdx).toBeGreaterThan(runnerIdx);
  });
});

const linearPayload = {
  id: "delivery-linear-1",
  deliveryId: "delivery-linear-1",
  type: "linear.AgentSessionEvent.prompted",
  provider: "linear",
  eventType: "AgentSessionEvent.prompted",
  connectionId: "conn-linear-1",
  resource: {
    agentSession: { id: "session-linear-1" },
    agentActivity: { id: "activity-linear-1", body: "Please handle AR-70" },
  },
};

type CleanupLogOverrides = {
  flushExitCode?: number | null;
  killAttempted?: boolean | null;
  killExitCode?: number | null;
  pendingWriteback?: number | null;
  hasPendingWriteback?: boolean | null;
  outboxNeedsAttention?: boolean | null;
  commandDraftWrittenThisRun?: boolean | null;
  commandDraftsUndeliverable?: number | null;
};

function cleanupOnlyRunOutput(input: {
  handlerMessages?: readonly string[];
  cleanup?: CleanupLogOverrides;
} = {}): string {
  const handlerMessages = input.handlerMessages ?? ["runner.handler.ok"];
  const handlerLines = handlerMessages.map((message, index) =>
    JSON.stringify({
      t: `2026-06-19T20:00:5${index}.000Z`,
      level: message === "runner.handler.error" ? "error" : "info",
      message,
      eventId: "delivery-cleanup-only",
      source: "slack",
      type: "slack.message.created",
      ...(message === "runner.handler.error" ? { error: "handler failed after partial batch" } : {}),
    })
  );
  return [
    ...handlerLines,
    JSON.stringify({
      t: "2026-06-19T20:00:56.078Z",
      level: "info",
      message: "runner.envelope-stream.ended",
      persona: "customer-health",
    }),
    JSON.stringify({
      message: "relayfile.mount.cleanup",
      flushExitCode: 1,
      killAttempted: true,
      killExitCode: 0,
      pendingWriteback: 0,
      hasPendingWriteback: false,
      outboxNeedsAttention: false,
      commandDraftWrittenThisRun: false,
      commandDraftsUndeliverable: 0,
      ...(input.cleanup ?? {}),
    }),
  ].join("\n");
}

describe("Linear AgentSession terminal writeback", () => {

  it("posts a terminal Linear writeback after a synchronous successful run", async () => {
    mocks.runtime.runScript.mockResolvedValue({
      output: "opened pull request https://github.com/AgentWorkforce/cloud/pull/999",
      exitCode: 0,
      cmdId: "cmd-linear-sync",
    });
    const { deliverDeploymentTrigger } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: linearPayload,
      target: activeTarget({
        deployedName: "linear-chat-lead",
        personaSlug: "linear-chat-lead",
        spec: { integrations: { linear: {} } },
      }),
    })).resolves.toMatchObject({ status: "starting" });

    expect(mocks.postLinearAgentSessionTerminalWriteback).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        agentId: "agent-1",
        deploymentId: "deployment-1",
        payload: linearPayload,
        terminalStatus: "completed",
        result: expect.objectContaining({
          output: expect.stringContaining("opened pull request"),
          exitCode: 0,
        }),
        error: undefined,
        sandboxId: "sbx-starting",
        sessionId: null,
        commandId: "cmd-linear-sync",
      }),
    );
    expect(mocks.postSlackConversationTerminalReply).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      payload: linearPayload,
      outcome: {
        kind: "completed",
        output: "opened pull request https://github.com/AgentWorkforce/cloud/pull/999",
      },
      delivery: { agentId: "agent-1" },
    });
  });

  it("posts a terminal Linear writeback after an async successful poll", async () => {
    mocks.runtime.getScriptStatus.mockResolvedValue({ exitCode: 0 });
    mocks.runtime.getScriptLogs.mockResolvedValue({
      stdout: "opened pull request https://github.com/AgentWorkforce/cloud/pull/1000",
      stderr: "",
      output: "",
    });
    const { pollDeploymentTriggerRun } = await import("./deployment-trigger-delivery");

    await expect(pollDeploymentTriggerRun({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: linearPayload,
      deploymentId: "deployment-async",
      sandboxId: "sbx-starting",
      sessionId: "tick-deployment-async",
      commandId: "cmd-linear-async",
      startedAt: "2026-06-01T10:00:20.000Z",
    })).resolves.toBeUndefined();

    expect(mocks.postLinearAgentSessionTerminalWriteback).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        agentId: "agent-1",
        deploymentId: "deployment-async",
        payload: linearPayload,
        terminalStatus: "completed",
        result: expect.objectContaining({
          output: expect.stringContaining("opened pull request"),
          exitCode: 0,
        }),
        error: null,
        sandboxId: "sbx-starting",
        sessionId: "tick-deployment-async",
        commandId: "cmd-linear-async",
      }),
    );
    expect(mocks.postSlackConversationTerminalReply).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      payload: linearPayload,
      outcome: {
        kind: "completed",
        output: "opened pull request https://github.com/AgentWorkforce/cloud/pull/1000",
      },
      delivery: { agentId: "agent-1" },
    });
  });

  it("posts a terminal Linear error writeback when an async run times out", async () => {
    mocks.runtime.getScriptStatus.mockResolvedValue({ exitCode: null });
    mocks.runtime.getScriptLogs.mockResolvedValue({
      output: "still running while finalizing pull request",
      exitCode: null,
    });
    const {
      DeploymentTriggerRunTimedOutError,
      pollDeploymentTriggerRun,
    } = await import("./deployment-trigger-delivery");

    await expect(pollDeploymentTriggerRun({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: linearPayload,
      deploymentId: "deployment-timeout",
      sandboxId: "sbx-starting",
      sessionId: "tick-deployment-timeout",
      commandId: "cmd-linear-timeout",
      startedAt: "2026-06-01T09:00:00.000Z",
      options: { runScriptMaxSeconds: 1 },
    })).rejects.toBeInstanceOf(DeploymentTriggerRunTimedOutError);

    expect(mocks.postLinearAgentSessionTerminalWriteback).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        agentId: "agent-1",
        deploymentId: "deployment-timeout",
        payload: linearPayload,
        terminalStatus: "timeout",
        result: expect.objectContaining({
          output: expect.stringContaining("still running"),
          exitCode: null,
        }),
        error: expect.any(DeploymentTriggerRunTimedOutError),
        sandboxId: "sbx-starting",
        sessionId: "tick-deployment-timeout",
        commandId: "cmd-linear-timeout",
      }),
    );
    expect(mocks.postSlackConversationTerminalReply).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      payload: linearPayload,
      outcome: {
        kind: "failed",
        reason: "timeout",
      },
      delivery: { agentId: "agent-1" },
    });
  });

});

describe("cleanup-only nonzero delivery completion", () => {
  const cleanupPayload = {
    type: "slack.message.created",
    provider: "slack",
    eventType: "message.created",
  };

  async function expectAsyncCleanupPollDelivered(output: string): Promise<void> {
    mocks.runtime.getScriptStatus.mockResolvedValue({ exitCode: 1 });
    mocks.runtime.getScriptLogs.mockResolvedValue({ stdout: output, stderr: "", output: "" });
    const { pollDeploymentTriggerRun } = await import("./deployment-trigger-delivery");

    await expect(pollDeploymentTriggerRun({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: cleanupPayload,
      deliveryId: "delivery-cleanup-only",
      deploymentId: "deployment-cleanup-only",
      sandboxId: "sbx-starting",
      sessionId: "tick-deployment-cleanup-only",
      commandId: "cmd-cleanup-only",
      startedAt: new Date().toISOString(),
      mountConfigured: true,
    })).resolves.toBeUndefined();

    expect(mocks.postSlackConversationTerminalReply).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      payload: cleanupPayload,
      outcome: { kind: "completed", output },
      delivery: { agentId: "agent-1", deliveryId: "delivery-cleanup-only" },
    });
    expect(mocks.postLinearAgentSessionTerminalWriteback).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalStatus: "completed",
        error: null,
      }),
    );
    expect(mocks.execute.mock.calls.some((call) =>
      sqlText(call[0]).includes("UPDATE agents") &&
      sqlText(call[0]).includes("last_error = NULL")
    )).toBe(true);
  }

  async function expectAsyncCleanupPollFailed(output: string): Promise<void> {
    mocks.runtime.getScriptStatus.mockResolvedValue({ exitCode: 1 });
    mocks.runtime.getScriptLogs.mockResolvedValue({ stdout: output, stderr: "", output: "" });
    const { pollDeploymentTriggerRun } = await import("./deployment-trigger-delivery");

    await expect(pollDeploymentTriggerRun({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: cleanupPayload,
      deliveryId: "delivery-cleanup-only",
      deploymentId: "deployment-cleanup-only",
      sandboxId: "sbx-starting",
      sessionId: "tick-deployment-cleanup-only",
      commandId: "cmd-cleanup-only",
      startedAt: new Date().toISOString(),
      mountConfigured: true,
    })).rejects.toThrow();

    expect(mocks.postSlackConversationTerminalReply).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      payload: cleanupPayload,
      outcome: { kind: "failed", reason: "error" },
      delivery: { agentId: "agent-1", deliveryId: "delivery-cleanup-only" },
    });
    expect(mocks.postLinearAgentSessionTerminalWriteback).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalStatus: "error",
        error: expect.any(Error),
      }),
    );
  }

  async function expectSyncCleanupDelivered(output: string): Promise<void> {
    mocks.deriveRelayfileMountPaths.mockReturnValue(["/slack/**"]);
    mocks.runtime.runScript.mockResolvedValue({
      output,
      exitCode: 1,
      cmdId: "cmd-cleanup-sync",
    });
    const { deliverDeploymentTrigger } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      deliveryId: "delivery-cleanup-only",
      payload: cleanupPayload,
      target: activeTarget({
        spec: { integrations: { slack: {} } },
      }),
    })).resolves.toMatchObject({ status: "starting" });

    expect(mocks.postSlackConversationTerminalReply).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      payload: cleanupPayload,
      outcome: { kind: "completed", output },
      delivery: { agentId: "agent-1", deliveryId: "delivery-cleanup-only" },
    });
    expect(mocks.postLinearAgentSessionTerminalWriteback).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalStatus: "completed",
        error: undefined,
      }),
    );
  }

  async function expectSyncCleanupFailed(output: string): Promise<void> {
    mocks.deriveRelayfileMountPaths.mockReturnValue(["/slack/**"]);
    mocks.runtime.runScript.mockResolvedValue({
      output,
      exitCode: 1,
      cmdId: "cmd-cleanup-sync",
    });
    const { deliverDeploymentTrigger } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      deliveryId: "delivery-cleanup-only",
      payload: cleanupPayload,
      target: activeTarget({
        spec: { integrations: { slack: {} } },
      }),
    })).rejects.toThrow();

    expect(mocks.postSlackConversationTerminalReply).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      payload: cleanupPayload,
      outcome: { kind: "failed", reason: "error" },
      delivery: { agentId: "agent-1", deliveryId: "delivery-cleanup-only" },
    });
    expect(mocks.postLinearAgentSessionTerminalWriteback).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalStatus: "error",
        error: expect.any(Error),
      }),
    );
  }

  it("marks primary async cleanup-nonzero handler-ok runs completed", async () => {
    await expectAsyncCleanupPollDelivered(cleanupOnlyRunOutput());
  });

  it("marks synchronous cleanup-nonzero handler-ok runs completed", async () => {
    await expectSyncCleanupDelivered(cleanupOnlyRunOutput());
  });

  it.each([
    [
      "outboxNeedsAttention",
      cleanupOnlyRunOutput({
        cleanup: {
          outboxNeedsAttention: true,
          commandDraftWrittenThisRun: true,
        },
      }),
    ],
    [
      "commandDraftsUndeliverable",
      cleanupOnlyRunOutput({
        cleanup: {
          commandDraftWrittenThisRun: true,
          commandDraftsUndeliverable: 1,
        },
      }),
    ],
    [
      "hasPendingWriteback",
      cleanupOnlyRunOutput({
        cleanup: {
          pendingWriteback: 0,
          hasPendingWriteback: true,
          commandDraftWrittenThisRun: true,
        },
      }),
    ],
    [
      "missing handler.ok",
      cleanupOnlyRunOutput({ handlerMessages: [] }),
    ],
    [
      "mixed handler.ok and handler.error",
      cleanupOnlyRunOutput({ handlerMessages: ["runner.handler.ok", "runner.handler.error"] }),
    ],
  ])("keeps primary async cleanup-nonzero runs failed for %s", async (_name, output) => {
    await expectAsyncCleanupPollFailed(output);
  });

  it.each([
    [
      "outboxNeedsAttention",
      cleanupOnlyRunOutput({
        cleanup: {
          outboxNeedsAttention: true,
          commandDraftWrittenThisRun: true,
        },
      }),
    ],
    [
      "commandDraftsUndeliverable",
      cleanupOnlyRunOutput({
        cleanup: {
          commandDraftWrittenThisRun: true,
          commandDraftsUndeliverable: 1,
        },
      }),
    ],
    [
      "hasPendingWriteback",
      cleanupOnlyRunOutput({
        cleanup: {
          pendingWriteback: 0,
          hasPendingWriteback: true,
          commandDraftWrittenThisRun: true,
        },
      }),
    ],
    [
      "missing handler.ok",
      cleanupOnlyRunOutput({ handlerMessages: [] }),
    ],
    [
      "mixed handler.ok and handler.error",
      cleanupOnlyRunOutput({ handlerMessages: ["runner.handler.ok", "runner.handler.error"] }),
    ],
  ])("keeps synchronous cleanup-nonzero runs failed for %s", async (_name, output) => {
    await expectSyncCleanupFailed(output);
  });
});

describe("deliverDeploymentTrigger continuation resume", () => {
  it("leaves flag-off delivery on the fresh-dispatch path", async () => {
    mocks.runtime.runScript.mockResolvedValue({
      output: JSON.stringify({
        t: "2026-06-02T10:00:00.000Z",
        level: "info",
        message: "runner.handler.ok",
      }),
      exitCode: 0,
      cmdId: "cmd-fresh",
    });
    const { deliverDeploymentTrigger } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: {
        type: "continuation_wake",
        continuationId: "cont-clock",
        wakeUpId: "continuation:cont-clock",
      },
      target: activeTarget(),
    })).resolves.toMatchObject({ status: "starting" });

    expect(mocks.PostgresContinuationStore).not.toHaveBeenCalled();
    expect(mocks.continuationStore.get).not.toHaveBeenCalled();
    expect(mocks.runtime.runScript).toHaveBeenCalledTimes(1);
    const command = String(mocks.runtime.runScript.mock.calls[0]?.[1]?.command ?? "");
    expect(command).not.toContain("resumeContext");
  });

  it("resumes a scheduled wake continuation before sandbox delivery when the flag is on", async () => {
    vi.stubEnv("PROACTIVE_CONTINUATION_RESUME_TEST_MODE", "1");
    mocks.continuationStore.get.mockResolvedValue(continuationRecord({
      id: "cont-clock",
      waitFor: { type: "scheduled_wake", wakeUpId: "continuation:cont-clock" },
    }));
    mocks.runtime.runScript.mockResolvedValue({
      output: JSON.stringify({ message: "runner.handler.ok" }),
      exitCode: 0,
      cmdId: "cmd-resume-clock",
    });
    const { deliverDeploymentTrigger } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: {
        type: "continuation_wake",
        continuationId: "cont-clock",
        wakeUpId: "continuation:cont-clock",
        firedAt: "2026-06-02T10:00:00.000Z",
      },
      target: activeTarget(),
    })).resolves.toMatchObject({ status: "starting" });

    expect(mocks.continuationStore.get).toHaveBeenCalledWith("cont-clock");
    expect(mocks.runtime.runScript).toHaveBeenCalledTimes(1);
    const command = String(mocks.runtime.runScript.mock.calls[0]?.[1]?.command ?? "");
    expect(command).toContain("\"resumeContext\"");
    expect(command).toContain("\"continuationId\":\"cont-clock\"");
    expect(command).toContain("\"triggerType\":\"scheduled_wake\"");
    expect(command).toContain("\"resumedTurnId\":\"cont-clock:resume:1\"");
  });

  it("resumes an inbox reply by correlation before sandbox delivery", async () => {
    vi.stubEnv("PROACTIVE_CONTINUATION_RESUME_TEST_MODE", "true");
    mocks.continuationStore.findByCorrelation.mockResolvedValue("cont-inbox");
    mocks.continuationStore.get.mockResolvedValue(continuationRecord({
      id: "cont-inbox",
      waitFor: { type: "user_reply", correlationKey: "slack:channel:C123:thread:1700000000.000100:user:U123" },
    }));
    mocks.runtime.runScript.mockResolvedValue({
      output: JSON.stringify({ message: "runner.handler.ok" }),
      exitCode: 0,
      cmdId: "cmd-resume-inbox",
    });
    const { deliverDeploymentTrigger } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: {
        type: "slack.message.created",
        provider: "slack",
        eventType: "message.created",
        resource: {
          channel: "C123",
          thread_ts: "1700000000.000100",
          user: "U123",
          ts: "1700000001.000200",
          text: "continue please",
        },
      },
      target: activeTarget(),
    })).resolves.toMatchObject({ status: "starting" });

    expect(mocks.continuationStore.findByCorrelation).toHaveBeenCalledWith(
      "user_reply",
      slackUserReplyCorrelationKey({
        channel: "C123",
        thread: "1700000000.000100",
        user: "U123",
      }),
    );
    expect(mocks.continuationStore.get).toHaveBeenCalledWith("cont-inbox");
    const command = String(mocks.runtime.runScript.mock.calls[0]?.[1]?.command ?? "");
    expect(command).toContain("\"continuationId\":\"cont-inbox\"");
    expect(command).toContain("\"triggerType\":\"user_reply\"");
    expect(command).toContain("\"priorState\"");
  });

  it("falls through to fresh dispatch when no inbox continuation matches", async () => {
    vi.stubEnv("PROACTIVE_CONTINUATION_RESUME_TEST_MODE", "enabled");
    mocks.continuationStore.findByCorrelation.mockResolvedValue(null);
    mocks.runtime.runScript.mockResolvedValue({
      output: JSON.stringify({ message: "runner.handler.ok" }),
      exitCode: 0,
      cmdId: "cmd-no-match",
    });
    const { deliverDeploymentTrigger } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: {
        type: "slack.message.created",
        provider: "slack",
        eventType: "message.created",
        resource: {
          channel: "C123",
          thread_ts: "1700000000.000100",
          user: "U123",
          text: "new message",
        },
      },
      target: activeTarget(),
    })).resolves.toMatchObject({ status: "starting" });

    expect(mocks.continuationStore.findByCorrelation).toHaveBeenCalledTimes(1);
    expect(mocks.continuationStore.get).not.toHaveBeenCalled();
    expect(mocks.runtime.runScript).toHaveBeenCalledTimes(1);
    const command = String(mocks.runtime.runScript.mock.calls[0]?.[1]?.command ?? "");
    expect(command).not.toContain("resumeContext");
  });

  it("preserves async pending delivery semantics for resumed turns", async () => {
    vi.stubEnv("PROACTIVE_CONTINUATION_RESUME_TEST_MODE", "1");
    mocks.continuationStore.get.mockResolvedValue(continuationRecord({
      id: "cont-async",
      waitFor: { type: "scheduled_wake", wakeUpId: "continuation:cont-async" },
    }));
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: {
        type: "continuation_wake",
        continuationId: "cont-async",
        wakeUpId: "continuation:cont-async",
      },
      options: { asyncRunScript: true },
      target: activeTarget(),
    })).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.runtime.startScript).toHaveBeenCalledTimes(1);
    const command = String(mocks.runtime.startScript.mock.calls[0]?.[1]?.command ?? "");
    expect(command).toContain("\"resumeContext\"");
    expect(command).toContain("\"continuationId\":\"cont-async\"");
    expect(mocks.continuationStore.put).toHaveBeenCalledWith(expect.objectContaining({
      id: "cont-async",
      status: "completed",
      terminalReason: "completed",
    }));
  });

  it("uses a fresh async run session id for repeated starts of the same deployment", async () => {
    const uuidSpy = vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
      .mockReturnValueOnce("22222222-2222-4222-8222-222222222222");
    mocks.runtime.startScript
      .mockResolvedValueOnce({
        sessionId: "tick-deployment-1-111111111111",
        commandId: "cmd-first",
      })
      .mockResolvedValueOnce({
        sessionId: "tick-deployment-1-222222222222",
        commandId: "cmd-second",
      });
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    try {
      const input = {
        workspaceId: "workspace-1",
        agentId: "agent-1",
        payload: { type: "manual.dashboard.run" },
        options: { asyncRunScript: true },
        target: activeTarget(),
      } as const;

      const first = await deliverDeploymentTrigger(input)
        .catch((error: unknown) => error);
      const second = await deliverDeploymentTrigger(input)
        .catch((error: unknown) => error);

      expect(first).toBeInstanceOf(DeploymentTriggerRunPendingError);
      expect(second).toBeInstanceOf(DeploymentTriggerRunPendingError);
      const firstSession = mocks.runtime.startScript.mock.calls[0]?.[1]?.sessionId;
      const secondSession = mocks.runtime.startScript.mock.calls[1]?.[1]?.sessionId;
      expect(firstSession).toBe("tick-deployment-1-111111111111");
      expect(secondSession).toBe("tick-deployment-1-222222222222");
      expect(firstSession).not.toBe(secondSession);
      expect((first as InstanceType<typeof DeploymentTriggerRunPendingError>).run.sessionId).toBe(
        "tick-deployment-1-111111111111",
      );
      expect((second as InstanceType<typeof DeploymentTriggerRunPendingError>).run.sessionId).toBe(
        "tick-deployment-1-222222222222",
      );
      expect(mocks.runtime.startScript.mock.calls[0]?.[0]).toBe(mocks.runtime.startScript.mock.calls[1]?.[0]);
    } finally {
      uuidSpy.mockRestore();
    }
  });

  it("treats duplicate terminal continuation wakes as benign no-ops", async () => {
    vi.stubEnv("PROACTIVE_CONTINUATION_RESUME_TEST_MODE", "1");
    mocks.continuationStore.get.mockResolvedValue(continuationRecord({
      id: "cont-terminal",
      status: "completed",
      terminalReason: "completed",
      waitFor: { type: "scheduled_wake", wakeUpId: "continuation:cont-terminal" },
    }));
    const { deliverDeploymentTrigger } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: {
        type: "continuation_wake",
        continuationId: "cont-terminal",
        wakeUpId: "continuation:cont-terminal",
      },
      target: activeTarget(),
    })).resolves.toMatchObject({ status: "starting" });

    expect(mocks.continuationStore.get).toHaveBeenCalledWith("cont-terminal");
    expect(mocks.runtime.runScript).not.toHaveBeenCalled();
  });

  it("treats missing continuation wakes as benign no-ops", async () => {
    vi.stubEnv("PROACTIVE_CONTINUATION_RESUME_TEST_MODE", "1");
    mocks.continuationStore.get.mockResolvedValue(null);
    const { deliverDeploymentTrigger } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: {
        type: "continuation_wake",
        continuationId: "cont-missing",
        wakeUpId: "continuation:cont-missing",
      },
      target: activeTarget(),
    })).resolves.toMatchObject({ status: "starting" });

    expect(mocks.continuationStore.get).toHaveBeenCalledWith("cont-missing");
    expect(mocks.runtime.runScript).not.toHaveBeenCalled();
  });
});

describe("deliverDeploymentTrigger provisioning resume", () => {
  it("persists structured runner logs to workspace /_logs on terminal handler error", async () => {
    mocks.runtime.getScriptStatus.mockResolvedValue({ exitCode: 1 });
    mocks.runtime.getScriptLogs.mockResolvedValue({
      output: [
        "plain setup line",
        JSON.stringify({
          t: "2026-06-01T10:00:23.534Z",
          level: "warn",
          message: "daily-ship.ignored",
          source: "cron",
          cloudApiAccessToken: "cloud-api-token-secret",
        }),
        JSON.stringify({
          t: "2026-06-01T10:00:24.000Z",
          level: "error",
          message: "runner.handler.error",
          eventId: "evt-1",
          source: "cron",
          type: "cron.tick",
          deploymentId: "spoofed-deployment",
          eventSource: "spoofed-event-source",
          sandboxId: "spoofed-sandbox",
          sessionId: "spoofed-session",
          commandId: "spoofed-command",
          stream: "spoofed-stream",
          error: "failed with relay_pa_secretSECRETSECRET and Authorization: Bearer cloud-secret",
          stack: [
            "Error: failed with Authorization: Bearer stack-secret-token",
            "    at handler ghp_123456789012345678901234",
            "    at relay relay_ws_secretSECRETSECRET",
            "    at provider OPENAI_API_KEY=sk-provider-secret",
          ].join("\n"),
        }),
      ].join("\n"),
      exitCode: null,
    });
    const {
      pollDeploymentTriggerRun,
    } = await import("./deployment-trigger-delivery");

    await expect(pollDeploymentTriggerRun({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: { type: "cron.tick" },
      deploymentId: "deployment-1",
      sandboxId: "sbx-starting",
      sessionId: "tick-deployment-1",
      commandId: "cmd-1",
      startedAt: "2026-06-01T10:00:20.000Z",
    })).rejects.toThrow("failed with");
    expect(mocks.postLinearAgentSessionTerminalWriteback).toHaveBeenCalledWith(expect.objectContaining({
      terminalStatus: "error",
      error: expect.any(Error),
    }));

    expect(mocks.mintPathScopedRelayfileToken).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      workspaceToken: "workspace-token",
      paths: ["/_logs/workspace-1/**"],
      agentName: "agent-1",
      agentId: "agent-1",
    }));
    expect(mocks.relayfileWriteFile).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      path: "/_logs/workspace-1/2026-06-01.jsonl",
      contentType: "application/x-ndjson",
      encoding: "utf-8",
    }));
    const content = String(mocks.relayfileWriteFile.mock.calls[0]?.[0]?.content ?? "");
    const entries = content.trim().split("\n").map((line) => JSON.parse(line));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      ts: "2026-06-01T10:00:23.534Z",
      level: "warn",
      workspace: "workspace-1",
      agentId: "agent-1",
      deploymentId: "deployment-1",
      eventSource: "cron",
      sandboxId: "sbx-starting",
      sessionId: "tick-deployment-1",
      commandId: "cmd-1",
      msg: "daily-ship.ignored",
      source: "cron",
    });
    expect(entries[1]).toMatchObject({
      level: "error",
      msg: "runner.handler.error",
      eventId: "evt-1",
      error: expect.stringContaining("[REDACTED]"),
    });
    expect(entries[1]).toMatchObject({
      deploymentId: "deployment-1",
      eventSource: "cron",
      sandboxId: "sbx-starting",
      sessionId: "tick-deployment-1",
      commandId: "cmd-1",
      stream: "runner",
    });
    expect(content).not.toContain("spoofed-deployment");
    expect(content).not.toContain("spoofed-event-source");
    expect(content).not.toContain("spoofed-sandbox");
    expect(content).not.toContain("spoofed-session");
    expect(content).not.toContain("spoofed-command");
    expect(content).not.toContain("spoofed-stream");
    expect(content).not.toContain("cloud-api-token-secret");
    expect(content).not.toContain("relay_pa_secretSECRETSECRET");
    expect(content).not.toContain("cloud-secret");
    expect(content).not.toContain("stack-secret-token");
    expect(content).not.toContain("ghp_123456789012345678901234");
    expect(content).not.toContain("relay_ws_secretSECRETSECRET");
    expect(content).not.toContain("sk-provider-secret");
  });

  it("marks a terminal handler error as failed even when the runner exits 0", async () => {
    mocks.runtime.getScriptStatus.mockResolvedValue({ exitCode: 0 });
    mocks.runtime.getScriptLogs.mockResolvedValue({
      output: JSON.stringify({
        t: "2026-06-01T10:00:24.000Z",
        level: "error",
        message: "runner.handler.error",
        error: "linear.getIssue ENOENT",
        source: "cron",
      }),
      exitCode: 0,
    });
    const {
      pollDeploymentTriggerRun,
    } = await import("./deployment-trigger-delivery");

    await expect(pollDeploymentTriggerRun({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: { type: "cron.tick" },
      deploymentId: "deployment-1",
      sandboxId: "sbx-starting",
      sessionId: "tick-deployment-1",
      commandId: "cmd-1",
      startedAt: "2026-06-01T10:00:20.000Z",
    })).rejects.toThrow("linear.getIssue ENOENT");

    expect(mocks.postLinearAgentSessionTerminalWriteback).toHaveBeenCalledWith(expect.objectContaining({
      terminalStatus: "error",
      error: expect.any(Error),
    }));
    expect(mocks.postSlackConversationTerminalReply).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      payload: { type: "cron.tick" },
      outcome: {
        kind: "failed",
        reason: "error",
      },
      delivery: { agentId: "agent-1" },
    });
    const insertCall = mocks.execute.mock.calls.find((call) =>
      sqlText(call[0]).includes("INSERT INTO agent_deployment_runs"),
    );
    expect(insertCall).toBeTruthy();
    expect(sqlText(insertCall?.[0])).toContain("INSERT INTO agent_deployment_runs");
  });

  it("persists split stderr from sandbox runtime failures", async () => {
    mocks.runtime.runScript.mockResolvedValue({
      output: "",
      stdout: "",
      stderr: "[smithy-diag] node=v25.6.0\nruntime load failed from stderr",
      exitCode: 1,
      cmdId: "cmd-stderr-only",
    });
    const {
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: { type: "cron.tick" },
      target: activeTarget(),
    })).rejects.toThrow("runner.mjs failed");

    const insertCall = mocks.execute.mock.calls.find((call) =>
      sqlText(call[0]).includes("INSERT INTO agent_deployment_runs"),
    );
    expect(insertCall).toBeTruthy();
    const insertParams = sqlParams(insertCall?.[0]);
    expect(insertParams).toContain("[smithy-diag] node=v25.6.0\nruntime load failed from stderr");
    expect(insertParams).toContain("runner.mjs failed");
  });

  it("fails a deployment run promptly when its sandbox has entered a terminal state", async () => {
    // Lane-6 crash-recovery: a crashed-then-STOPPED box reports no exitCode, so
    // before the fix the poll re-throws DeploymentTriggerRunPendingError and the
    // delivery re-polls every 15s until the ~30min wall-clock cap. With the fix a
    // terminal box short-circuits to DeploymentTriggerRunSandboxTerminalError (a
    // sibling of the timeout error) → the bounded markPendingDeliveryFailed path.
    // Age is kept well under maxAgeSeconds so this exercises the terminal-state
    // branch, NOT the wall-clock timeout (which would already be bounded).
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T10:01:00.000Z"));
    mocks.runtime.getById.mockResolvedValue({
      id: "sbx-stopped",
      state: "STOPPED",
      name: "cloud-small-issue-codex-deploy",
    });
    mocks.runtime.getScriptStatus.mockResolvedValue({ exitCode: null });
    mocks.runtime.getScriptLogs.mockResolvedValue({
      output: JSON.stringify({
        t: "2026-06-01T10:00:45.000Z",
        level: "error",
        message: "runner.crashed.before.exit",
        source: "cron",
      }),
      exitCode: null,
    });
    const {
      DeploymentTriggerRunSandboxTerminalError,
      pollDeploymentTriggerRun,
    } = await import("./deployment-trigger-delivery");

    await expect(pollDeploymentTriggerRun({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: { type: "cron.tick" },
      deploymentId: "deployment-1",
      sandboxId: "sbx-stopped",
      sessionId: "tick-deployment-1",
      commandId: "cmd-1",
      startedAt: "2026-06-01T10:00:20.000Z",
    })).rejects.toBeInstanceOf(DeploymentTriggerRunSandboxTerminalError);

    expect(mocks.relayfileWriteFile).toHaveBeenCalledWith(expect.objectContaining({
      path: "/_logs/workspace-1/2026-06-01.jsonl",
    }));
    expect(mocks.postSlackConversationTerminalReply).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      payload: { type: "cron.tick" },
      outcome: {
        kind: "failed",
        reason: "sandbox_terminal",
      },
      delivery: { agentId: "agent-1" },
    });
    const queries = mocks.execute.mock.calls.map((call) => sqlText(call[0]));
    expect(queries.some((query) => query.includes("INSERT INTO agent_deployment_runs"))).toBe(true);
    expect(queries.some((query) => query.includes("UPDATE agent_deployments"))).toBe(true);
    expect(queries.some((query) => query.includes("UPDATE agents"))).toBe(true);
  });

  it("keeps polling a still-running sandbox with no exit (over-fire guard)", async () => {
    // Over-fire guard for the terminal short-circuit above: a HEALTHY box
    // (STARTED, not in the terminal set) with no exitCode must NOT trip the
    // terminal-state branch — it stays a normal re-poll (RunPendingError). Age is
    // kept under maxAgeSeconds so this isolates the running path from the
    // wall-clock timeout. Makes the no-false-fail invariant self-documenting.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T10:01:00.000Z"));
    mocks.runtime.getById.mockResolvedValue({
      id: "sbx-running",
      state: "STARTED",
      name: "cloud-small-issue-codex-deploy",
    });
    mocks.runtime.getScriptStatus.mockResolvedValue({ exitCode: null });
    const {
      DeploymentTriggerRunPendingError,
      pollDeploymentTriggerRun,
    } = await import("./deployment-trigger-delivery");

    await expect(pollDeploymentTriggerRun({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: { type: "cron.tick" },
      deploymentId: "deployment-1",
      sandboxId: "sbx-running",
      sessionId: "tick-deployment-1",
      commandId: "cmd-1",
      startedAt: "2026-06-01T10:00:20.000Z",
    })).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);
  });

  it("retries structured runner log appends after Relayfile revision conflicts", async () => {
    mocks.runtime.getScriptStatus.mockResolvedValue({ exitCode: 1 });
    mocks.runtime.getScriptLogs.mockResolvedValue({
      output: JSON.stringify({
        t: "2026-06-01T10:00:24.000Z",
        level: "error",
        message: "runner.handler.error",
        source: "cron",
      }),
      exitCode: null,
    });
    mocks.relayfileReadFile
      .mockResolvedValueOnce({
        content: `${JSON.stringify({ msg: "previous", ts: "2026-06-01T09:00:00.000Z" })}\n`,
        revision: "rev-1",
      })
      .mockResolvedValueOnce({
        content: `${JSON.stringify({ msg: "previous", ts: "2026-06-01T09:00:00.000Z" })}\n${JSON.stringify({
          msg: "concurrent",
          ts: "2026-06-01T09:59:59.000Z",
        })}\n`,
        revision: "rev-2",
      });
    mocks.relayfileWriteFile
      .mockRejectedValueOnce({ status: 409, message: "revision conflict" })
      .mockResolvedValueOnce({ opId: "op-logs" });
    const {
      pollDeploymentTriggerRun,
    } = await import("./deployment-trigger-delivery");

    await expect(pollDeploymentTriggerRun({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: { type: "cron.tick" },
      deploymentId: "deployment-1",
      sandboxId: "sbx-starting",
      sessionId: "tick-deployment-1",
      commandId: "cmd-1",
      startedAt: "2026-06-01T10:00:20.000Z",
    })).rejects.toThrow("runner.handler.error");

    expect(mocks.relayfileReadFile).toHaveBeenCalledTimes(2);
    expect(mocks.relayfileWriteFile).toHaveBeenCalledTimes(2);
    expect(mocks.relayfileWriteFile.mock.calls[0]?.[0]).toMatchObject({
      baseRevision: "rev-1",
    });
    expect(mocks.relayfileWriteFile.mock.calls[1]?.[0]).toMatchObject({
      baseRevision: "rev-2",
    });
    const content = String(mocks.relayfileWriteFile.mock.calls[1]?.[0]?.content ?? "");
    expect(content).toContain("\"msg\":\"previous\"");
    expect(content).toContain("\"msg\":\"concurrent\"");
    expect(content).toContain("\"msg\":\"runner.handler.error\"");
  });

  it("caps oversized structured runner log messages before writing /_logs", async () => {
    const oversizedMessage = `runner.handler.error ${"x".repeat(20_000)} tail-marker`;
    mocks.runtime.getScriptStatus.mockResolvedValue({ exitCode: 1 });
    mocks.runtime.getScriptLogs.mockResolvedValue({
      output: JSON.stringify({
        t: "2026-06-01T10:00:24.000Z",
        level: "error",
        message: oversizedMessage,
        source: "cron",
      }),
      exitCode: null,
    });
    const {
      pollDeploymentTriggerRun,
    } = await import("./deployment-trigger-delivery");

    await expect(pollDeploymentTriggerRun({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: { type: "cron.tick" },
      deploymentId: "deployment-1",
      sandboxId: "sbx-starting",
      sessionId: "tick-deployment-1",
      commandId: "cmd-1",
      startedAt: "2026-06-01T10:00:20.000Z",
    })).rejects.toThrow("runner.handler.error");

    const content = String(mocks.relayfileWriteFile.mock.calls[0]?.[0]?.content ?? "");
    const [entry] = content.trim().split("\n").map((line) => JSON.parse(line));
    expect(entry.msg).toHaveLength(16_384);
    expect(entry.msg).toContain("runner.handler.error");
    expect(entry.msg).not.toContain("tail-marker");
  });

  it("persists structured runner logs before surfacing async timeout", async () => {
    mocks.runtime.getScriptStatus.mockResolvedValue({ exitCode: null });
    mocks.runtime.getScriptLogs.mockResolvedValue({
      output: JSON.stringify({
        t: "2026-06-01T10:05:00.000Z",
        level: "info",
        message: "complex.stage.outcome",
        stage: "open-pr",
        outcome: "started",
      }),
      exitCode: null,
    });
    const {
      DeploymentTriggerRunTimedOutError,
      pollDeploymentTriggerRun,
    } = await import("./deployment-trigger-delivery");

    await expect(pollDeploymentTriggerRun({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: { type: "github.issues.opened" },
      deploymentId: "deployment-1",
      sandboxId: "sbx-starting",
      sessionId: "tick-deployment-1",
      commandId: "cmd-1",
      startedAt: "2026-06-01T09:00:00.000Z",
      options: { runScriptMaxSeconds: 1 },
    })).rejects.toBeInstanceOf(DeploymentTriggerRunTimedOutError);

    expect(mocks.relayfileWriteFile).toHaveBeenCalledWith(expect.objectContaining({
      path: "/_logs/workspace-1/2026-06-01.jsonl",
    }));
    const content = String(mocks.relayfileWriteFile.mock.calls[0]?.[0]?.content ?? "");
    expect(content).toContain("\"msg\":\"complex.stage.outcome\"");
    expect(content).toContain("\"stage\":\"open-pr\"");
  });

  it("persists structured runner logs from the synchronous delivery path", async () => {
    mocks.runtime.runScript.mockResolvedValue({
      output: JSON.stringify({
        t: "2026-06-01T10:10:00.000Z",
        level: "info",
        message: "runner.handler.ok",
        eventId: "evt-sync",
        source: "cron",
        type: "cron.tick",
        durationMs: 12,
      }),
      exitCode: 0,
      cmdId: "cmd-sync",
    });
    const {
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: { type: "cron.tick" },
      target: {
        agentId: "agent-1",
        deployedName: "daily-ship",
        deployedByUserId: "user-1",
        personaSlug: "daily-ship",
        status: "active",
        specHash: "spec-hash",
        spec: {},
        bundleSha256: "bundle-sha",
        inputValues: {},
        credentialSelections: {},
      } as never,
    })).resolves.toMatchObject({ status: "starting" });

    expect(mocks.relayfileWriteFile).toHaveBeenCalledWith(expect.objectContaining({
      path: "/_logs/workspace-1/2026-06-01.jsonl",
    }));
    const content = String(mocks.relayfileWriteFile.mock.calls[0]?.[0]?.content ?? "");
    expect(content).toContain("\"msg\":\"runner.handler.ok\"");
    expect(content).toContain("\"commandId\":\"cmd-sync\"");
  });

  it("does not change synchronous delivery status when structured runner log persistence fails", async () => {
    mocks.runtime.runScript.mockResolvedValue({
      output: JSON.stringify({
        t: "2026-06-01T10:10:00.000Z",
        level: "info",
        message: "runner.handler.ok",
        eventId: "evt-sync",
        source: "cron",
        type: "cron.tick",
        durationMs: 12,
      }),
      exitCode: 0,
      cmdId: "cmd-sync",
    });
    mocks.relayfileWriteFile.mockRejectedValue(new Error("relayfile unavailable"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const {
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: { type: "cron.tick" },
      target: {
        agentId: "agent-1",
        deployedName: "daily-ship",
        deployedByUserId: "user-1",
        personaSlug: "daily-ship",
        status: "active",
        specHash: "spec-hash",
        spec: {},
        bundleSha256: "bundle-sha",
        inputValues: {},
        credentialSelections: {},
      } as never,
    })).resolves.toMatchObject({ status: "starting" });

    expect(mocks.relayfileWriteFile).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "[persona-bundle-deploy] failed to persist structured runner logs",
      expect.objectContaining({
        agentId: "agent-1",
        deploymentId: "deployment-1",
        error: "relayfile unavailable",
      }),
    );
    warnSpy.mockRestore();
  });

  it("uploads the persona bundle before running a sandbox resumed by provisioningSandboxId", async () => {
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      provisioningSandboxId: "sbx-starting",
      payload: { type: "github.issues.opened" },
      options: { asyncRunScript: true },
      target: {
        agentId: "agent-1",
        deployedName: "cloud-small-issue-codex",
        deployedByUserId: "user-1",
        personaSlug: "cloud-small-issue-codex",
        status: "active",
        specHash: "spec-hash",
        spec: {},
        bundleSha256: "bundle-sha",
        inputValues: {},
        credentialSelections: {},
      } as never,
    })).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.runtime.getById).toHaveBeenCalledWith("sbx-starting", {
      states: null,
      owned: true,
    });
    expect(mocks.runtime.uploadBundle).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sbx-starting" }),
      expect.objectContaining({
        files: expect.arrayContaining([
          expect.objectContaining({ destination: "/home/daytona/workforce-runtime/runner.mjs" }),
          expect.objectContaining({ destination: "/home/daytona/workforce-runtime/agent.bundle.mjs" }),
        ]),
      }),
    );
    expect(mocks.runtime.startScript).toHaveBeenCalled();
    expect(mocks.runtime.uploadBundle.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runtime.startScript.mock.invocationCallOrder[0],
    );
  });

  it("refreshes the persona bundle before running a warm-reused sandbox", async () => {
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: { type: "github.issues.opened" },
      options: { asyncRunScript: true },
      target: {
        agentId: "agent-1",
        deployedName: "cloud-small-issue-codex",
        deployedByUserId: "user-1",
        personaSlug: "cloud-small-issue-codex",
        status: "active",
        specHash: "spec-hash",
        spec: {},
        bundleSha256: "bundle-sha",
        inputValues: {},
        credentialSelections: {},
      } as never,
    })).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.runtime.findAllByLabels).toHaveBeenCalledWith(
      {
        purpose: "workforce-deploy",
        workspaceId: "workspace-1",
        agentId: "agent-1",
      },
      { states: ["STARTED"], limit: 10 },
    );
    expect(mocks.runtime.getById).not.toHaveBeenCalled();
    expect(mocks.runtime.uploadBundle).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sbx-starting" }),
      expect.objectContaining({
        files: expect.arrayContaining([
          expect.objectContaining({ destination: "/home/daytona/workforce-runtime/runner.mjs" }),
          expect.objectContaining({ destination: "/home/daytona/workforce-runtime/agent.bundle.mjs" }),
        ]),
      }),
    );
    expect(mocks.runtime.uploadBundle.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runtime.startScript.mock.invocationCallOrder[0],
    );
    expect(mocks.runtime.startScript).toHaveBeenCalled();
  });

  it("does not reuse a warm sandbox leased by an active async run", async () => {
    mocks.execute
      .mockResolvedValueOnce({ rows: [{ sandbox_id: "sbx-busy" }] })
      .mockResolvedValue({ rows: [] });
    mocks.runtime.findAllByLabels.mockResolvedValue([
      { id: "sbx-busy", state: "STARTED", name: "busy" },
      { id: "sbx-free", state: "STARTED", name: "free" },
    ]);
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: { type: "github.issues.opened" },
      options: { asyncRunScript: true },
      target: {
        agentId: "agent-1",
        deployedName: "cloud-small-issue-codex",
        deployedByUserId: "user-1",
        personaSlug: "cloud-small-issue-codex",
        status: "active",
        specHash: "spec-hash",
        spec: {},
        bundleSha256: "bundle-sha",
        inputValues: {},
        credentialSelections: {},
      } as never,
    })).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.runtime.uploadBundle).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sbx-free" }),
      expect.any(Object),
    );
    expect(mocks.runtime.startScript).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sbx-free" }),
      expect.any(Object),
    );
    const leaseQuery = sqlText(mocks.execute.mock.calls[0]?.[0]);
    expect(leaseQuery).toContain("status IN ('running', 'processing')");
    expect(leaseQuery).toContain("FROM integration_watch_deliveries");
    expect(leaseQuery).toContain("FROM deployment_tick_deliveries");
  });

  it("reuses a young idle started deployment sandbox", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-06T12:00:00.000Z"));
    mocks.runtime.findAllByLabels.mockResolvedValue([
      {
        id: "sbx-young",
        state: "STARTED",
        name: "young",
        createdAt: "2026-06-01T12:00:01.000Z",
      },
    ]);
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: { type: "cron.tick" },
      options: { asyncRunScript: true },
      target: activeTarget(),
    })).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.runtime.destroy).not.toHaveBeenCalled();
    expect(mocks.runtime.launchDetached).not.toHaveBeenCalled();
    expect(mocks.runtime.uploadBundle).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sbx-young" }),
      expect.any(Object),
    );
    expect(mocks.runtime.startScript).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sbx-young" }),
      expect.any(Object),
    );
  });

  it("destroys an old idle started deployment sandbox and provisions a fresh replacement", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-06T12:00:00.000Z"));
    const oldHandle = {
      id: "sbx-old",
      state: "STARTED",
      name: "old",
      createdAt: "2026-05-29T11:59:59.000Z",
    };
    const freshHandle = {
      id: "sbx-fresh",
      state: "STARTED",
      name: "fresh-from-base-snapshot",
      createdAt: "2026-06-06T12:00:00.000Z",
    };
    mocks.runtime.findAllByLabels.mockResolvedValue([oldHandle]);
    mocks.runtime.launchDetached.mockResolvedValueOnce(freshHandle);
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: { type: "cron.tick" },
      options: { asyncRunScript: true },
      target: activeTarget(),
    })).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.runtime.destroy).toHaveBeenCalledWith(oldHandle);
    expect(mocks.runtime.launchDetached).toHaveBeenCalledOnce();
    expect(mocks.runtime.uploadBundle).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: "sbx-old" }),
      expect.any(Object),
    );
    expect(mocks.runtime.uploadBundle).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sbx-fresh" }),
      expect.any(Object),
    );
    expect(mocks.runtime.startScript).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sbx-fresh" }),
      expect.any(Object),
    );
  });

  it("does not destroy an old started sandbox while an active lease references it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-06T12:00:00.000Z"));
    mocks.execute
      .mockResolvedValueOnce({ rows: [{ sandbox_id: "sbx-old-busy" }] })
      .mockResolvedValue({ rows: [] });
    mocks.runtime.findAllByLabels.mockResolvedValue([
      {
        id: "sbx-old-busy",
        state: "STARTED",
        name: "old-busy",
        createdAt: "2026-05-01T00:00:00.000Z",
      },
      {
        id: "sbx-free",
        state: "STARTED",
        name: "free",
        createdAt: "2026-06-04T12:00:00.000Z",
      },
    ]);
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: { type: "cron.tick" },
      options: { asyncRunScript: true },
      target: activeTarget(),
    })).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.runtime.destroy).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: "sbx-old-busy" }),
    );
    expect(mocks.runtime.uploadBundle).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sbx-free" }),
      expect.any(Object),
    );
  });

  it("does not reuse a warm sandbox leased by an active cron tick", async () => {
    mocks.execute
      .mockResolvedValueOnce({ rows: [{ sandbox_id: "sbx-busy" }] })
      .mockResolvedValue({ rows: [] });
    mocks.runtime.findAllByLabels.mockResolvedValue([
      { id: "sbx-busy", state: "STARTED", name: "busy" },
      { id: "sbx-free", state: "STARTED", name: "free" },
    ]);
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: { type: "cron.tick" },
      options: { asyncRunScript: true },
      target: {
        agentId: "agent-1",
        deployedName: "daily-ship",
        deployedByUserId: "user-1",
        personaSlug: "daily-ship",
        status: "active",
        specHash: "spec-hash",
        spec: {},
        bundleSha256: "bundle-sha",
        inputValues: {},
        credentialSelections: {},
      } as never,
    })).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.runtime.uploadBundle).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sbx-free" }),
      expect.any(Object),
    );
    expect(mocks.runtime.startScript).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sbx-free" }),
      expect.any(Object),
    );
    const leaseQuery = sqlText(mocks.execute.mock.calls[0]?.[0]);
    expect(leaseQuery).toContain("status IN ('running', 'processing')");
    expect(leaseQuery).toContain("FROM integration_watch_deliveries");
    expect(leaseQuery).toContain("FROM deployment_tick_deliveries");
  });

  it("treats reclaimed processing deliveries with a sandbox id as active leases", async () => {
    mocks.execute
      .mockResolvedValueOnce({ rows: [{ sandbox_id: "sbx-processing" }] })
      .mockResolvedValue({ rows: [] });
    mocks.runtime.findAllByLabels.mockResolvedValue([
      { id: "sbx-processing", state: "STARTED", name: "processing" },
      { id: "sbx-free", state: "STARTED", name: "free" },
    ]);
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: { type: "github.issues.opened" },
      options: { asyncRunScript: true },
      target: {
        agentId: "agent-1",
        deployedName: "cloud-small-issue-codex",
        deployedByUserId: "user-1",
        personaSlug: "cloud-small-issue-codex",
        status: "active",
        specHash: "spec-hash",
        spec: {},
        bundleSha256: "bundle-sha",
        inputValues: {},
        credentialSelections: {},
      } as never,
    })).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.runtime.uploadBundle).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sbx-free" }),
      expect.any(Object),
    );
    expect(mocks.runtime.startScript).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sbx-free" }),
      expect.any(Object),
    );
    const leaseQuery = sqlText(mocks.execute.mock.calls[0]?.[0]);
    expect(leaseQuery).toContain("status IN ('running', 'processing')");
    expect(leaseQuery).toContain("FROM integration_watch_deliveries");
    expect(leaseQuery).toContain("FROM deployment_tick_deliveries");
  });

  it("does not resume a provisioning sandbox already leased by another active run", async () => {
    mocks.execute
      .mockResolvedValueOnce({ rows: [{ sandbox_id: "sbx-busy" }] })
      .mockResolvedValue({ rows: [] });
    mocks.runtime.launchDetached.mockResolvedValueOnce({
      id: "sbx-new",
      state: "STARTED",
      name: "cloud-small-issue-codex-deployment-1",
    });
    mocks.runtime.findAllByLabels.mockResolvedValueOnce([]);
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      provisioningSandboxId: "sbx-busy",
      payload: { type: "github.issues.opened" },
      options: { asyncRunScript: true },
      target: {
        agentId: "agent-1",
        deployedName: "cloud-small-issue-codex",
        deployedByUserId: "user-1",
        personaSlug: "cloud-small-issue-codex",
        status: "active",
        specHash: "spec-hash",
        spec: {},
        bundleSha256: "bundle-sha",
        inputValues: {},
        credentialSelections: {},
      } as never,
    })).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.runtime.getById).not.toHaveBeenCalledWith("sbx-busy", expect.any(Object));
    expect(mocks.runtime.launchDetached).toHaveBeenCalled();
    expect(mocks.runtime.startScript).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sbx-new" }),
      expect.any(Object),
    );
  });

  it("does not record a failed run while a detached cold sandbox is still provisioning", async () => {
    mocks.runtime.findAllByLabels.mockResolvedValueOnce([]);
    mocks.runtime.launchDetached.mockResolvedValueOnce({
      id: "sbx-cold",
      state: "creating",
      name: "cloud-small-issue-codex-deployment-1",
    });
    mocks.runtime.getById.mockResolvedValueOnce({
      id: "sbx-cold",
      state: "creating",
      name: "cloud-small-issue-codex-deployment-1",
    });
    const {
      DeploymentSandboxProvisioningPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: { type: "github.issues.opened" },
      options: { asyncRunScript: true, sandboxCreateTimeoutSeconds: 0 },
      target: {
        agentId: "agent-1",
        deployedName: "cloud-small-issue-codex",
        deployedByUserId: "user-1",
        personaSlug: "cloud-small-issue-codex",
        status: "active",
        specHash: "spec-hash",
        spec: {},
        bundleSha256: "bundle-sha",
        inputValues: {},
        credentialSelections: {},
      } as never,
    })).rejects.toBeInstanceOf(DeploymentSandboxProvisioningPendingError);

    expect(mocks.runtime.launchDetached).toHaveBeenCalled();
    expect(mocks.runtime.uploadBundle).not.toHaveBeenCalled();
    expect(mocks.runtime.startScript).not.toHaveBeenCalled();
    expect(
      mocks.execute.mock.calls
        .map((call) => sqlText(call[0]))
        .some((query) => query.includes("INSERT INTO agent_deployment_runs")),
    ).toBe(false);
  });

  it("waits for a detached cold sandbox to start before uploading and running", async () => {
    mocks.runtime.findAllByLabels.mockResolvedValueOnce([]);
    mocks.runtime.launchDetached.mockResolvedValueOnce({
      id: "sbx-cold",
      state: "creating",
      name: "cloud-small-issue-codex-deployment-1",
    });
    mocks.runtime.getById.mockResolvedValueOnce({
      id: "sbx-cold",
      state: "STARTED",
      name: "cloud-small-issue-codex-deployment-1",
    });
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: { type: "github.issues.opened" },
      options: { asyncRunScript: true, sandboxProvisionPollIntervalMs: 100 },
      target: {
        agentId: "agent-1",
        deployedName: "cloud-small-issue-codex",
        deployedByUserId: "user-1",
        personaSlug: "cloud-small-issue-codex",
        status: "active",
        specHash: "spec-hash",
        spec: {},
        bundleSha256: "bundle-sha",
        inputValues: {},
        credentialSelections: {},
      } as never,
    })).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.runtime.getById).toHaveBeenCalledWith("sbx-cold", {
      states: null,
      owned: true,
    });
    expect(mocks.runtime.uploadBundle).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sbx-cold" }),
      expect.any(Object),
    );
    expect(mocks.runtime.startScript).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sbx-cold" }),
      expect.any(Object),
    );
  });

  it("adopts a same-named provisioning sandbox after a Daytona create conflict", async () => {
    const conflict = new Error("Sandbox with name daily-ship-deployme already exists");
    (conflict as { statusCode?: number }).statusCode = 409;
    mocks.runtime.findAllByLabels
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: "sbx-existing",
        state: "creating",
        name: "daily-ship-deployme",
      }]);
    mocks.runtime.launchDetached.mockRejectedValueOnce(conflict);
    mocks.runtime.getById.mockResolvedValueOnce({
      id: "sbx-existing",
      state: "STARTED",
      name: "daily-ship-deployme",
    });
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: { type: "github.issues.opened" },
      options: { asyncRunScript: true },
      target: activeTarget({
        deployedName: "daily-ship",
        personaSlug: "daily-ship",
      }),
    })).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.runtime.findAllByLabels).toHaveBeenNthCalledWith(2, {
      purpose: "workforce-deploy",
      workspaceId: "workspace-1",
      personaId: "daily-ship",
      agentId: "agent-1",
      deploymentId: "deployment-1",
      sandboxName: "daily-ship-deployme",
    }, {
      states: null,
      limit: 5,
      owned: true,
    });
    expect(mocks.runtime.getById).toHaveBeenCalledWith("sbx-existing", {
      states: null,
      owned: true,
    });
    expect(mocks.runtime.uploadBundle).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sbx-existing" }),
      expect.any(Object),
    );
    expect(mocks.runtime.startScript).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sbx-existing" }),
      expect.any(Object),
    );
    expect(mocks.runtime.launchDetached).toHaveBeenCalledTimes(1);
  });

  it("destroys a terminal same-named sandbox after a Daytona create conflict and retries", async () => {
    const conflict = new Error("Sandbox with name daily-ship-deployme already exists");
    (conflict as { statusCode?: number }).statusCode = 409;
    const staleHandle = {
      id: "sbx-stale",
      state: "STOPPED",
      name: "daily-ship-deployme",
    };
    mocks.runtime.findAllByLabels
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([staleHandle]);
    mocks.runtime.launchDetached
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({
        id: "sbx-new",
        state: "STARTED",
        name: "daily-ship-deployme",
      });
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: { type: "github.issues.opened" },
      options: { asyncRunScript: true },
      target: activeTarget({
        deployedName: "daily-ship",
        personaSlug: "daily-ship",
      }),
    })).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.runtime.destroy).toHaveBeenCalledWith(staleHandle);
    expect(mocks.runtime.launchDetached).toHaveBeenCalledTimes(2);
    expect(mocks.runtime.uploadBundle).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sbx-new" }),
      expect.any(Object),
    );
    expect(mocks.runtime.startScript).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sbx-new" }),
      expect.any(Object),
    );
  });

  it("caps cold sandbox polling below the worker waitUntil budget", async () => {
    vi.useFakeTimers();
    mocks.runtime.findAllByLabels.mockResolvedValueOnce([]);
    mocks.runtime.launchDetached.mockResolvedValueOnce({
      id: "sbx-cold",
      state: "creating",
      name: "cloud-small-issue-codex-deployment-1",
    });
    mocks.runtime.getById.mockResolvedValue({
      id: "sbx-cold",
      state: "creating",
      name: "cloud-small-issue-codex-deployment-1",
    });
    const {
      DeploymentSandboxProvisioningPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    const delivery = deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: { type: "github.issues.opened" },
      options: {
        asyncRunScript: true,
        sandboxCreateTimeoutSeconds: 120,
        sandboxProvisionPollIntervalMs: 10_000,
      },
      target: {
        agentId: "agent-1",
        deployedName: "cloud-small-issue-codex",
        deployedByUserId: "user-1",
        personaSlug: "cloud-small-issue-codex",
        status: "active",
        specHash: "spec-hash",
        spec: {},
        bundleSha256: "bundle-sha",
        inputValues: {},
        credentialSelections: {},
      } as never,
    });
    const assertion = expect(delivery).rejects.toBeInstanceOf(DeploymentSandboxProvisioningPendingError);

    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    expect(mocks.runtime.uploadBundle).not.toHaveBeenCalled();
  });

  it("injects canonical Cloud API env aliases for sandbox credential reads", async () => {
    vi.stubEnv("CLOUD_PUBLIC_URL", "https://cloud.example/cloud///");
    mocks.resolveRelayAuthConfig.mockReturnValue({
      relayAuthUrl: "https://auth.example",
      relayAuthApiKey: "auth-api-key",
    });
    mocks.deriveRelayfileMountPaths.mockReturnValue(["/slack/**"]);
    mocks.mintRelayfileToken.mockResolvedValue("workflow-token");
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: { type: "github.issues.opened" },
      options: { asyncRunScript: true },
      target: {
        agentId: "agent-1",
        deployedName: "cloud-small-issue-codex",
        deployedByUserId: "user-1",
        personaSlug: "cloud-small-issue-codex",
        status: "active",
        specHash: "spec-hash",
        spec: {},
        bundleSha256: "bundle-sha",
        inputValues: {},
        credentialSelections: {},
      } as never,
    })).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    const command = String(mocks.runtime.startScript.mock.calls[0]?.[1]?.command ?? "");
    expect(command).toMatch(/export WORKFORCE_AGENT_TOKEN=.*workflow-token/);
    expect(command).toMatch(/export WORKFORCE_WORKSPACE_TOKEN=.*workflow-token/);
    expect(command).toMatch(/export CLOUD_API_ACCESS_TOKEN=.*workflow-token/);
    expect(command).toMatch(/export RELAYFILE_TOKEN=.*relay-ag-token/);
    expect(mocks.mintWorkspaceScopedRelayfileTokenPair).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      relayAuthApiKey: "auth-api-key",
      scopes: expect.arrayContaining([
        "relayfile:fs:read:/slack/*",
        "relayfile:fs:write:/slack/*",
        "relayfile:ops:read:*",
      ]),
      agentName: "agent-1",
      agentId: "agent-1",
    }));
    expect(command).toMatch(/export WORKFORCE_CLOUD_BASE_URL=.*https:\/\/cloud\.example\/cloud/);
    expect(command).toMatch(/export WORKFORCE_CLOUD_URL=.*https:\/\/cloud\.example\/cloud/);
    expect(command).toMatch(/export WORKFORCE_DEPLOY_CLOUD_URL=.*https:\/\/cloud\.example\/cloud/);
    expect(command).toMatch(/export CLOUD_API_URL=.*https:\/\/cloud\.example\/cloud/);
  });

  it("keeps reviewer pull request dispatch on the legacy sandbox and cold checkout path when warm lease input is off", async () => {
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: {
        type: "github.pull_request.opened",
        resource: {
          number: 1397,
          repository: {
            full_name: "AgentWorkforce/cloud",
            clone_url: "https://github.com/AgentWorkforce/cloud.git",
          },
          head: {
            sha: "head-sha",
            ref: "fix/pr-reviewer-real-checkout",
            repo: { full_name: "AgentWorkforce/cloud" },
          },
          base: {
            sha: "base-sha",
            ref: "main",
            repo: { full_name: "AgentWorkforce/cloud" },
          },
        },
      },
      options: { asyncRunScript: true },
      target: {
        agentId: "agent-1",
        deployedName: "pr-reviewer",
        deployedByUserId: "user-1",
        personaSlug: "pr-reviewer",
        status: "active",
        specHash: "spec-hash",
        spec: {
          intent: "review",
          harness: "codex",
          integrations: {
            github: { triggers: [{ on: "pull_request.opened" }] },
          },
        },
        bundleSha256: "bundle-sha",
        inputValues: {},
        credentialSelections: {},
      } as never,
    })).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.mintWorkflowGithubWriteToken).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: "workspace-1",
      repoOwner: "AgentWorkforce",
      repoName: "cloud",
    });
    expect(mocks.runtime.findAllByLabels).toHaveBeenCalledWith(
      {
        purpose: "workforce-deploy",
        workspaceId: "workspace-1",
        agentId: "agent-1",
      },
      { states: ["STARTED"], limit: 10 },
    );
    expect(mocks.runtime.findAllByLabels).not.toHaveBeenCalledWith(
      { purpose: "workforce-deploy" },
      { states: ["STARTED"], limit: 11, owned: true },
    );
    expect(
      mocks.execute.mock.calls
        .map((call) => sqlText(call[0]))
        .some((query) => query.includes("pr_sandbox_leases")),
    ).toBe(false);
    expect(mocks.runtime.launchDetached).not.toHaveBeenCalled();
    expect(mocks.runtime.startScript).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sbx-starting" }),
      expect.any(Object),
    );

    const startArgs = mocks.runtime.startScript.mock.calls[0]?.[1] ?? {};
    const command = String(startArgs.command ?? "");
    expect(startArgs.env).toEqual(expect.objectContaining({
      GITHUB_PR_WORKSPACE_TOKEN: "github-installation-token",
    }));
    expect(command).toContain("rm -rf /home/daytona/workspace/* /home/daytona/workspace/.[!.]* /home/daytona/workspace/..?*");
    expect(command).toContain("git init /home/daytona/workspace");
    expect(command).toContain("git remote add origin");
    expect(command).toContain("refs/pull/1397/head");
    expect(command).toContain("git diff --binary \"$MERGE_BASE...pr-head\"");
    expect(command).not.toContain("if [ -d /home/daytona/workspace/.git ]; then");
    expect(command).not.toContain("git remote set-url origin");
    expect(command).not.toContain("git reset --hard");
    expect(command).not.toContain("git clean -ffd");
    expect(command).not.toContain("git clean -ffdx");
    expect(command).not.toContain("[pr-reviewer] reusing existing pull request workspace checkout");
  });

  it("resolves a proactive GitHub clone token and passes it only through the run env", async () => {
    mocks.deriveRelayfileMountPaths.mockReturnValue([
      "/github/repos/AgentWorkforce/cloud/**",
      "/linear/**",
    ]);
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: {
        type: "linear.comment.create",
        resource: {
          payload: {
            body: "@agentrelay please implement this.",
            issue_identifier: "AR-70",
          },
        },
      },
      options: { asyncRunScript: true },
      target: activeTarget({
        deployedName: "linear-implementer",
        personaSlug: "linear-implementer",
        spec: {
          intent: "relay-orchestrator",
          harness: "codex",
          integrations: {
            linear: {},
            github: { scope: { repo: "AgentWorkforce/cloud" } },
          },
        },
      }),
    })).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.resolveGitCloneCredentials).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: "workspace-1",
      remoteUrl: "https://github.com/AgentWorkforce/cloud.git",
    });
    const startArgs = mocks.runtime.startScript.mock.calls[0]?.[1] ?? {};
    const command = String(startArgs.command ?? "");
    expect(startArgs.env).toEqual(expect.objectContaining({
      GITHUB_PROACTIVE_WORKSPACE_TOKEN: "github-clone-token",
    }));
    expect(command).toContain("[proactive-runtime] preparing git workspace source");
    expect(command).toContain("git clone --filter=blob:none --depth 1 --no-tags");
    expect(command).toContain("https://github.com/AgentWorkforce/cloud.git");
    expect(command).toContain("/home/daytona/workspace/github/repos/AgentWorkforce/cloud");
    expect(command).toContain("GITHUB_PROACTIVE_WORKSPACE_TOKEN");
    expect(command).toContain("PROACTIVE_GIT_WORKSPACE_TOKEN_VALUE=\"${GITHUB_PROACTIVE_WORKSPACE_TOKEN:-}\"");
    expect(command).not.toContain("export PROACTIVE_GIT_WORKSPACE_TOKEN_VALUE=");
    expect(command).toContain("unset GITHUB_PROACTIVE_WORKSPACE_TOKEN");
    expect(command).toContain("unset PROACTIVE_GIT_WORKSPACE_TOKEN_VALUE");
    expect(command).toContain("PROACTIVE_GIT_WORKSPACE_TOKEN_VALUE=\"$PROACTIVE_GIT_WORKSPACE_TOKEN_VALUE\" git clone --filter=blob:none");
    expect(command).not.toContain("github-clone-token");
    expect(command).not.toContain("x-access-token:");
    const cloneIdx = command.indexOf("git clone --filter=blob:none --depth 1 --no-tags");
    const runnerIdx = command.indexOf("node /home/daytona/workforce-runtime/runner.mjs");
    expect(command.indexOf("unset GITHUB_PROACTIVE_WORKSPACE_TOKEN")).toBeLessThan(cloneIdx);
    expect(command.indexOf("unset PROACTIVE_GIT_WORKSPACE_TOKEN_VALUE")).toBeGreaterThan(cloneIdx);
    expect(command.indexOf("unset PROACTIVE_GIT_WORKSPACE_TOKEN_VALUE")).toBeLessThan(runnerIdx);
  });

  it("fails loud before launching when proactive GitHub source has no clone token", async () => {
    mocks.resolveGitCloneCredentials.mockResolvedValue(null);
    mocks.deriveRelayfileMountPaths.mockReturnValue([
      "/github/repos/AgentWorkforce/cloud/**",
      "/linear/**",
    ]);
    const {
      DeploymentTriggerDeliveryError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    let thrown: unknown;
    try {
      await deliverDeploymentTrigger({
        workspaceId: "workspace-1",
        agentId: "agent-1",
        payload: {
          type: "linear.comment.create",
          resource: {
            payload: {
              body: "@agentrelay please implement this.",
              issue_identifier: "AR-70",
            },
          },
        },
        options: { asyncRunScript: true },
        target: activeTarget({
          deployedName: "linear-implementer",
          personaSlug: "linear-implementer",
          spec: {
            intent: "relay-orchestrator",
            harness: "codex",
            integrations: {
              linear: {},
              github: { scope: { repo: "AgentWorkforce/cloud" } },
            },
          },
        }),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DeploymentTriggerDeliveryError);
    expect(thrown).toMatchObject({
      code: "proactive_git_clone_token_unavailable",
      status: 503,
    });
    expect(mocks.resolveGitCloneCredentials).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: "workspace-1",
      remoteUrl: "https://github.com/AgentWorkforce/cloud.git",
    });
    expect(mocks.resolveGitCloneCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.runtime.startScript).not.toHaveBeenCalled();
    expect(mocks.runtime.runScript).not.toHaveBeenCalled();
  });

  it("materializes pull request code through the warm lease path when the persona input is enabled", async () => {
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: {
        type: "github.pull_request.opened",
        resource: {
          number: 1397,
          repository: {
            full_name: "AgentWorkforce/cloud",
            clone_url: "https://github.com/AgentWorkforce/cloud.git",
          },
          head: {
            sha: "head-sha",
            ref: "fix/pr-reviewer-real-checkout",
            repo: { full_name: "AgentWorkforce/cloud" },
          },
          base: {
            sha: "base-sha",
            ref: "main",
            repo: { full_name: "AgentWorkforce/cloud" },
          },
        },
      },
      options: { asyncRunScript: true },
      target: {
        agentId: "agent-1",
        deployedName: "pr-reviewer",
        deployedByUserId: "user-1",
        personaSlug: "pr-reviewer",
        status: "active",
        specHash: "spec-hash",
        spec: {
          intent: "review",
          harness: "codex",
          integrations: {
            github: { triggers: [{ on: "pull_request.opened" }] },
          },
        },
        bundleSha256: "bundle-sha",
        inputValues: { PR_SANDBOX_WARM_LEASE_ENABLED: "true" },
        credentialSelections: {},
      } as never,
    })).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.mintWorkflowGithubWriteToken).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: "workspace-1",
      repoOwner: "AgentWorkforce",
      repoName: "cloud",
    });

    const startArgs = mocks.runtime.startScript.mock.calls[0]?.[1] ?? {};
    const command = String(startArgs.command ?? "");
    const launchArgs = mocks.runtime.launchDetached.mock.calls[0]?.[0] ?? {};
    expect(launchArgs.name).toMatch(/^pr-reviewer-/);
    expect(launchArgs.labels).toEqual(expect.objectContaining({
      purpose: "workforce-deploy",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      repoFullName: "AgentWorkforce/cloud",
      prNumber: "1397",
      warmLease: "pull-request",
    }));
    expect(mocks.runtime.findAllByLabels).toHaveBeenCalledWith(
      { purpose: "workforce-deploy" },
      { states: ["STARTED"], limit: 11, owned: true },
    );
    expect(startArgs.env).toEqual(expect.objectContaining({
      GITHUB_PR_WORKSPACE_TOKEN: "github-installation-token",
    }));
    expect(command).toContain("cd /home/daytona/workforce-runtime");
    expect(command).toContain("[pr-reviewer] preparing pull request workspace");
    expect(command).toContain("git init /home/daytona/workspace");
    expect(command).toContain("if [ -d /home/daytona/workspace/.git ]; then");
    expect(command).toContain("git remote set-url origin");
    expect(command).toContain("https://github.com/AgentWorkforce/cloud.git");
    expect(command).toContain("git reset --hard");
    expect(command).toContain("refs/remotes/origin/pr/1397/head");
    const excludeIdx = command.indexOf("cat > .git/info/exclude <<");
    const cleanIdx = command.indexOf("git clean -ffd");
    expect(excludeIdx).toBeGreaterThan(-1);
    expect(cleanIdx).toBeGreaterThan(excludeIdx);
    expect(command).toContain("github/");
    expect(command).toContain("slack/");
    expect(command).toContain("node_modules/");
    expect(command).toContain("git clean -ffd");
    expect(command).not.toContain("git clean -ffdx");
    expect(command).toContain("refs/pull/1397/head");
    expect(command).toMatch(/git fetch --no-tags --depth=200 origin .*refs\/pull\/1397\/head:refs\/remotes\/origin\/pr\/1397\/head.*\+base-sha:refs\/remotes\/origin\/pr\/1397\/base/);
    expect(command).not.toContain("git update-ref refs/remotes/origin/pr/1397/base");
    expect(command).toContain("git diff --binary \"$MERGE_BASE...pr-head\"");
    expect(command).toContain("[pr-reviewer] prepared pull request workspace for #1397");
    expect(command).toContain("node /home/daytona/workforce-runtime/runner.mjs");
    expect(command).toContain("[pr-reviewer] changed tree detected; committing and pushing fixes");
    expect(command).toContain("[pr-reviewer] clean tree after harness; no push needed");
    expect(command).toContain("[pr-reviewer] pushed fixes for #1397");
    expect(command).toContain("[pr-reviewer] push failed; fetching remote head and retrying once");
    expect(command).toContain("git fetch --no-tags --depth=200 origin");
    expect(command).toContain("+refs/heads/fix/pr-reviewer-real-checkout:refs/remotes/origin/fix/pr-reviewer-real-checkout");
    expect(command).toContain("git rebase");
    expect(command).toContain("refs/remotes/origin/fix/pr-reviewer-real-checkout");
    expect(command).toContain("[pr-reviewer] pushed fixes for #1397 after rebase retry");
    expect(command).toContain("HEAD:refs/heads/fix/pr-reviewer-real-checkout");
    expect(command).not.toContain("github-installation-token");
    expect(command).toContain("GitHub token is installation-scoped; runtime limits usage to AgentWorkforce/cloud");
    expect(mocks.runtime.uploadBundle.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runtime.startScript.mock.invocationCallOrder[0],
    );
  });

  it("materializes pull request code and writeback for a renamed capability-declared reviewer", async () => {
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: {
        type: "github.pull_request.opened",
        resource: {
          number: 1448,
          repository: {
            full_name: "AgentWorkforce/cloud",
            clone_url: "https://github.com/AgentWorkforce/cloud.git",
          },
          head: {
            sha: "head-sha",
            ref: "fix/general-reviewer",
            repo: { full_name: "AgentWorkforce/cloud" },
          },
          base: {
            sha: "base-sha",
            ref: "main",
            repo: { full_name: "AgentWorkforce/cloud" },
          },
        },
      },
      options: { asyncRunScript: true },
      target: {
        agentId: "agent-1",
        deployedName: "custom-reviewer",
        deployedByUserId: "user-1",
        personaSlug: "custom-reviewer",
        status: "active",
        specHash: "spec-hash",
        spec: {
          capabilities: {
            pullRequest: {
              checkout: true,
              writeback: true,
              formalReview: true,
              botIdentity: "custom-reviewer[bot]",
            },
          },
          harness: "codex",
          integrations: {
            github: { triggers: [{ on: "pull_request.opened" }] },
          },
        },
        bundleSha256: "bundle-sha",
        inputValues: { PR_SANDBOX_WARM_LEASE_ENABLED: "1" },
        credentialSelections: {},
      } as never,
    })).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.mintWorkflowGithubWriteToken).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: "workspace-1",
      repoOwner: "AgentWorkforce",
      repoName: "cloud",
    });
    const startArgs = mocks.runtime.startScript.mock.calls[0]?.[1] ?? {};
    const command = String(startArgs.command ?? "");
    expect(startArgs.env).toEqual(expect.objectContaining({
      GITHUB_PR_WORKSPACE_TOKEN: "github-installation-token",
    }));
    expect(command).toContain("[pr-reviewer] preparing pull request workspace");
    expect(command).toContain("refs/pull/1448/head");
  });

  it("checks out pull request code without write token or push script for watch-only reviewers", async () => {
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: {
        type: "github.pull_request.opened",
        resource: {
          number: 1448,
          repository: {
            full_name: "AgentWorkforce/cloud",
            clone_url: "https://github.com/AgentWorkforce/cloud.git",
          },
          head: {
            sha: "head-sha",
            ref: "watch-only-review",
            repo: { full_name: "AgentWorkforce/cloud" },
          },
          base: {
            sha: "base-sha",
            ref: "main",
            repo: { full_name: "AgentWorkforce/cloud" },
          },
        },
      },
      options: { asyncRunScript: true },
      target: {
        agentId: "agent-1",
        deployedName: "watch-only-reviewer",
        deployedByUserId: "user-1",
        personaSlug: "watch-only-reviewer",
        status: "active",
        specHash: "spec-hash",
        spec: {
          capabilities: {
            pullRequest: {
              checkout: true,
              writeback: false,
              formalReview: true,
              botIdentity: "watch-only-reviewer[bot]",
            },
          },
          harness: "codex",
          integrations: {
            github: { triggers: [{ on: "pull_request.opened" }] },
          },
        },
        bundleSha256: "bundle-sha",
        inputValues: {},
        credentialSelections: {},
      } as never,
    })).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.mintWorkflowGithubWriteToken).not.toHaveBeenCalled();
    const startArgs = mocks.runtime.startScript.mock.calls[0]?.[1] ?? {};
    const command = String(startArgs.command ?? "");
    expect(startArgs.env).toBeUndefined();
    expect(command).toContain("[pr-reviewer] preparing pull request workspace");
    expect(command).toContain("refs/pull/1448/head");
    expect(command).toContain("git fetch --no-tags --depth=200 origin");
    expect(command).not.toContain("[pr-reviewer] creating formal pull request review draft");
    expect(command).not.toContain("\"reviews\"");
    expect(command).not.toContain("GITHUB_PR_WORKSPACE_TOKEN");
    expect(command).not.toContain("PR_REVIEWER_GIT_TOKEN_VALUE");
    expect(command).not.toContain("GIT_ASKPASS");
    expect(command).not.toContain("[pr-reviewer] changed tree detected; committing and pushing fixes");
    expect(command).not.toContain("git push origin");
    expect(command).not.toContain("[pr-reviewer] annotating review comment with authoritative push outcome");
  });

  it("warm-reuses a started PR sandbox lease for reviewer pull request events", async () => {
    mocks.execute.mockResolvedValueOnce({
      rows: [{
        id: "lease-pr-1397",
        workspace_id: "workspace-1",
        agent_id: "agent-1",
        repo_full_name: "AgentWorkforce/cloud",
        pr_number: 1397,
        sandbox_id: "sbx-pr-1397",
        sandbox_name: "pr-reviewer-workspace-agent-cloud-1397",
        state: "warm",
        lease_until: null,
        last_used_at: new Date("2026-05-29T09:00:00.000Z"),
        attempt_count: 1,
        current_step: "sandbox-ready",
        snapshot_version: "snapshot-current",
      }],
    }).mockResolvedValue({ rows: [] });
    mocks.runtime.getById.mockResolvedValueOnce({
      id: "sbx-pr-1397",
      state: "STARTED",
      name: "pr-reviewer-workspace-agent-cloud-1397",
    });
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: {
        type: "github.pull_request.opened",
        resource: {
          number: 1397,
          repository: {
            full_name: "AgentWorkforce/cloud",
            clone_url: "https://github.com/AgentWorkforce/cloud.git",
          },
          head: {
            sha: "head-sha",
            ref: "fix/pr-reviewer-real-checkout",
            repo: { full_name: "AgentWorkforce/cloud" },
          },
          base: {
            sha: "base-sha",
            ref: "main",
            repo: { full_name: "AgentWorkforce/cloud" },
          },
        },
      },
      options: { asyncRunScript: true },
      target: {
        agentId: "agent-1",
        deployedName: "pr-reviewer",
        deployedByUserId: "user-1",
        personaSlug: "pr-reviewer",
        status: "active",
        specHash: "spec-hash",
        spec: {
          intent: "review",
          harness: "codex",
          integrations: {
            github: { triggers: [{ on: "pull_request.opened" }] },
          },
        },
        bundleSha256: "bundle-sha",
        inputValues: { PR_SANDBOX_WARM_LEASE_ENABLED: "yes" },
        credentialSelections: {},
      } as never,
    })).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.runtime.getById).toHaveBeenCalledWith("sbx-pr-1397", {
      states: null,
      owned: true,
    });
    expect(mocks.runtime.launchDetached).not.toHaveBeenCalled();
    expect(mocks.runtime.findAllByLabels).not.toHaveBeenCalledWith(
      { purpose: "workforce-deploy" },
      expect.any(Object),
    );
    expect(mocks.runtime.uploadBundle).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sbx-pr-1397" }),
      expect.any(Object),
    );
    expect(mocks.runtime.startScript).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sbx-pr-1397" }),
      expect.any(Object),
    );
    expect(
      mocks.execute.mock.calls
        .map((call) => sqlText(call[0]))
        .some((query) => query.includes("UPDATE pr_sandbox_leases")),
    ).toBe(true);
  });

  it("retries a sandbox harness exit 137 once in a fresh sandbox with a fresh session", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      mocks.runtime.runScript
        .mockResolvedValueOnce({
          output: "review started\nKilled\n",
          chunks: [],
          exitCode: 137,
          cmdId: "cmd-oom-1",
          startedAt: "2026-06-04T09:01:00.000Z",
          endedAt: "2026-06-04T09:02:00.000Z",
          durationMs: 60_000,
        })
        .mockResolvedValueOnce({
          output: "review completed\n",
          chunks: [],
          exitCode: 0,
          cmdId: "cmd-ok",
          startedAt: "2026-06-04T09:02:10.000Z",
          endedAt: "2026-06-04T09:03:00.000Z",
          durationMs: 50_000,
        });
      mocks.runtime.launchDetached
        .mockResolvedValueOnce({
          id: "sbx-pr-first",
          state: "STARTED",
          name: "pr-reviewer-workspace-agent-cloud-1397",
        })
        .mockResolvedValueOnce({
          id: "sbx-pr-retry",
          state: "STARTED",
          name: "pr-reviewer-deployment-1-retry1",
        });
      const {
        deliverDeploymentTrigger,
      } = await import("./deployment-trigger-delivery");

      await expect(deliverDeploymentTrigger({
        workspaceId: "workspace-1",
        agentId: "agent-1",
        payload: {
          type: "github.pull_request.opened",
          resource: {
            number: 1397,
            repository: {
              full_name: "AgentWorkforce/cloud",
              clone_url: "https://github.com/AgentWorkforce/cloud.git",
            },
            head: {
              sha: "head-sha",
              ref: "fix/pr-reviewer-real-checkout",
              repo: { full_name: "AgentWorkforce/cloud" },
            },
            base: {
              sha: "base-sha",
              ref: "main",
              repo: { full_name: "AgentWorkforce/cloud" },
            },
          },
        },
        target: {
          agentId: "agent-1",
          deployedName: "pr-reviewer",
          deployedByUserId: "user-1",
          personaSlug: "pr-reviewer",
          status: "active",
          specHash: "spec-hash",
          spec: {
            intent: "review",
            harness: "codex",
            integrations: {
              github: { triggers: [{ on: "pull_request.opened" }] },
            },
          },
          bundleSha256: "bundle-sha",
          inputValues: { PR_SANDBOX_WARM_LEASE_ENABLED: "true" },
          credentialSelections: {},
        } as never,
      })).resolves.toMatchObject({
        agentId: "agent-1",
        workspaceId: "workspace-1",
        deploymentId: "deployment-1",
        status: "starting",
      });

      expect(mocks.runtime.runScript).toHaveBeenCalledTimes(2);
      expect(mocks.runtime.runScript.mock.calls[0]?.[0]).toMatchObject({ id: "sbx-pr-first" });
      expect(mocks.runtime.runScript.mock.calls[1]?.[0]).toMatchObject({ id: "sbx-pr-retry" });
      const firstSession = String(mocks.runtime.runScript.mock.calls[0]?.[1]?.sessionId ?? "");
      const secondSession = String(mocks.runtime.runScript.mock.calls[1]?.[1]?.sessionId ?? "");
      expect(firstSession).toMatch(/^tick-deployment-1-/);
      expect(secondSession).toMatch(/^tick-deployment-1-/);
      expect(secondSession).not.toBe(firstSession);
      expect(mocks.runtime.destroy).toHaveBeenCalledWith(expect.objectContaining({ id: "sbx-pr-first" }));
      expect(mocks.runtime.launchDetached).toHaveBeenCalledTimes(2);
      expect(mocks.runtime.launchDetached.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
        name: expect.stringContaining("-retry1"),
        labels: expect.objectContaining({
          oomRetry: "exit-137",
          retryAttempt: "1",
        }),
      }));
      const runInserts = mocks.execute.mock.calls
        .map((call) => sqlText(call[0]))
        .filter((query) => query.includes("INSERT INTO agent_deployment_runs"));
      expect(runInserts).toHaveLength(2);
      expect(mocks.postLinearAgentSessionTerminalWriteback).toHaveBeenCalledWith(
        expect.objectContaining({
          terminalStatus: "error",
          sandboxId: "sbx-pr-first",
          sessionId: firstSession,
          commandId: "cmd-oom-1",
          result: expect.objectContaining({ exitCode: 137 }),
          error: expect.objectContaining({ code: "harness_exit_137" }),
        }),
      );
      expect(consoleWarn).toHaveBeenCalledWith(
        "[harness] exited with code 137",
        expect.objectContaining({
          diag: "harness-exit-137",
          agentName: "pr-reviewer",
          sandboxId: "sbx-pr-first",
          commandId: "cmd-oom-1",
          retrying: true,
          outputTail: expect.stringContaining("Killed"),
        }),
      );
      expect(consoleInfo).toHaveBeenCalledWith(
        "[harness] released warm sandbox lease after exit-137 retry handoff",
        expect.objectContaining({
          diag: "harness-exit-137",
          repoFullName: "AgentWorkforce/cloud",
          prNumber: 1397,
        }),
      );
    } finally {
      consoleInfo.mockRestore();
      consoleWarn.mockRestore();
    }
  });

  it("retries a non-PR sandbox persona exit 137 once in a fresh sandbox", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mocks.runtime.runScript
        .mockResolvedValueOnce({
          output: "linear work started\nKilled\n",
          chunks: [],
          exitCode: 137,
          cmdId: "cmd-oom-1",
          startedAt: "2026-06-04T09:01:00.000Z",
          endedAt: "2026-06-04T09:02:00.000Z",
          durationMs: 60_000,
        })
        .mockResolvedValueOnce({
          output: "linear work completed\n",
          chunks: [],
          exitCode: 0,
          cmdId: "cmd-ok",
          startedAt: "2026-06-04T09:02:10.000Z",
          endedAt: "2026-06-04T09:03:00.000Z",
          durationMs: 50_000,
        });
      mocks.runtime.findByLabels.mockResolvedValueOnce({
        id: "sbx-linear-first",
        state: "STARTED",
        name: "daily-ship-deployment-1",
      });
      mocks.runtime.findAllByLabels.mockResolvedValueOnce([{
        id: "sbx-linear-first",
        state: "STARTED",
        name: "daily-ship-deployment-1",
      }]);
      mocks.runtime.launchDetached.mockResolvedValueOnce({
        id: "sbx-linear-retry",
        state: "STARTED",
        name: "daily-ship-deployment-1-retry1",
      });
      const { deliverDeploymentTrigger } = await import("./deployment-trigger-delivery");

      await expect(deliverDeploymentTrigger({
        workspaceId: "workspace-1",
        agentId: "agent-1",
        payload: linearPayload,
        target: activeTarget({
          deployedName: "daily-ship",
          personaSlug: "daily-ship",
          spec: { integrations: { linear: {} } },
        }),
      })).resolves.toMatchObject({
        agentId: "agent-1",
        workspaceId: "workspace-1",
        deploymentId: "deployment-1",
        status: "starting",
      });

      expect(mocks.runtime.runScript).toHaveBeenCalledTimes(2);
      expect(mocks.runtime.runScript.mock.calls[0]?.[0]).toMatchObject({ id: "sbx-linear-first" });
      expect(mocks.runtime.runScript.mock.calls[1]?.[0]).toMatchObject({ id: "sbx-linear-retry" });
      expect(mocks.runtime.destroy).toHaveBeenCalledWith(expect.objectContaining({ id: "sbx-linear-first" }));
      expect(mocks.runtime.launchDetached).toHaveBeenCalledWith(expect.objectContaining({
        name: expect.stringContaining("-retry1"),
        labels: expect.objectContaining({
          oomRetry: "exit-137",
          retryAttempt: "1",
        }),
      }));
      expect(mocks.postLinearAgentSessionTerminalWriteback).toHaveBeenCalledWith(
        expect.objectContaining({
          terminalStatus: "error",
          sandboxId: "sbx-linear-first",
          commandId: "cmd-oom-1",
          result: expect.objectContaining({ exitCode: 137 }),
          error: expect.objectContaining({ code: "harness_exit_137" }),
        }),
      );
      expect(consoleWarn).toHaveBeenCalledWith(
        "[harness] exited with code 137",
        expect.objectContaining({
          diag: "harness-exit-137",
          agentName: "daily-ship",
          sandboxId: "sbx-linear-first",
          commandId: "cmd-oom-1",
          retrying: true,
          outputTail: expect.stringContaining("Killed"),
        }),
      );
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it("fails after one sandbox harness exit 137 retry with a redacted stdout stderr tail", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mocks.runtime.runScript
        .mockResolvedValueOnce({
          output: "first attempt\nKilled\n",
          chunks: [],
          exitCode: 137,
          cmdId: "cmd-oom-1",
          startedAt: "2026-06-04T09:01:00.000Z",
          endedAt: "2026-06-04T09:02:00.000Z",
          durationMs: 60_000,
        })
        .mockResolvedValueOnce({
          output: "second attempt\nsecret ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nKilled again\n",
          chunks: [],
          exitCode: 137,
          cmdId: "cmd-oom-2",
          startedAt: "2026-06-04T09:02:10.000Z",
          endedAt: "2026-06-04T09:03:00.000Z",
          durationMs: 50_000,
        });
      mocks.runtime.launchDetached
        .mockResolvedValueOnce({
          id: "sbx-pr-first",
          state: "STARTED",
          name: "pr-reviewer-workspace-agent-cloud-1397",
        })
        .mockResolvedValueOnce({
          id: "sbx-pr-retry",
          state: "STARTED",
          name: "pr-reviewer-deployment-1-retry1",
        });
      const {
        HarnessExit137Error,
        deliverDeploymentTrigger,
      } = await import("./deployment-trigger-delivery");

      let thrown: unknown;
      try {
        await deliverDeploymentTrigger({
          workspaceId: "workspace-1",
          agentId: "agent-1",
          payload: {
            type: "github.pull_request.opened",
            resource: {
              number: 1397,
              repository: {
                full_name: "AgentWorkforce/cloud",
                clone_url: "https://github.com/AgentWorkforce/cloud.git",
              },
              head: {
                sha: "head-sha",
                ref: "fix/pr-reviewer-real-checkout",
                repo: { full_name: "AgentWorkforce/cloud" },
              },
              base: {
                sha: "base-sha",
                ref: "main",
                repo: { full_name: "AgentWorkforce/cloud" },
              },
            },
          },
          target: {
            agentId: "agent-1",
            deployedName: "pr-reviewer",
            deployedByUserId: "user-1",
            personaSlug: "pr-reviewer",
            status: "active",
            specHash: "spec-hash",
            spec: {
              intent: "review",
              harness: "codex",
              integrations: {
                github: { triggers: [{ on: "pull_request.opened" }] },
              },
            },
            bundleSha256: "bundle-sha",
            inputValues: { PR_SANDBOX_WARM_LEASE_ENABLED: "true" },
            credentialSelections: {},
          } as never,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(HarnessExit137Error);
      expect(thrown).toMatchObject({
        code: "harness_exit_137",
        status: 502,
      });
      expect(String((thrown as Error).message)).toContain("pr-reviewer harness exited with code 137");
      expect(String((thrown as Error).message)).toContain("stdout/stderr tail:");
      expect(String((thrown as Error).message)).toContain("Killed again");
      expect(String((thrown as Error).message)).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
      expect(mocks.runtime.runScript).toHaveBeenCalledTimes(2);
      expect(mocks.runtime.launchDetached).toHaveBeenCalledTimes(2);
      expect(mocks.runtime.destroy).toHaveBeenCalledWith(expect.objectContaining({ id: "sbx-pr-first" }));
      expect(consoleWarn).toHaveBeenCalledWith(
        "[harness] exited with code 137",
        expect.objectContaining({
          diag: "harness-exit-137",
          agentName: "pr-reviewer",
          sandboxId: "sbx-pr-retry",
          commandId: "cmd-oom-2",
          retrying: false,
          outputTail: expect.stringContaining("Killed again"),
        }),
      );
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it("retries an async non-PR sandbox persona exit 137 from the poller", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mocks.getAgentDeploymentTickTarget.mockResolvedValue(activeTarget({
        deployedName: "daily-ship",
        personaSlug: "daily-ship",
        spec: { integrations: { linear: {} } },
      }));
      mocks.runtime.getById.mockResolvedValueOnce({
        id: "sbx-linear-first",
        state: "STARTED",
        name: "daily-ship-deployment-1",
      });
      mocks.runtime.getScriptStatus.mockResolvedValueOnce({ exitCode: 137 });
      mocks.runtime.getScriptLogs.mockResolvedValueOnce({
        output: "linear work started\nKilled\n",
        stdout: "",
        stderr: "",
      });
      mocks.runtime.launchDetached.mockResolvedValueOnce({
        id: "sbx-linear-retry",
        state: "STARTED",
        name: "daily-ship-deployment-1-retry1",
      });
      mocks.runtime.startScript.mockResolvedValueOnce({
        sessionId: "tick-deployment-1-retry",
        commandId: "cmd-retry",
      });
      const {
        DeploymentTriggerRunPendingError,
        pollDeploymentTriggerRun,
      } = await import("./deployment-trigger-delivery");

      await expect(pollDeploymentTriggerRun({
        workspaceId: "workspace-1",
        agentId: "agent-1",
        deploymentId: "deployment-1",
        sandboxId: "sbx-linear-first",
        sandboxName: "daily-ship-deployment-1",
        sessionId: "tick-deployment-1-first",
        commandId: "cmd-oom-1",
        startedAt: "2026-06-04T09:01:00.000Z",
        mountConfigured: true,
        payload: linearPayload,
      })).rejects.toMatchObject({
        name: "DeploymentTriggerRunPendingError",
        run: expect.objectContaining({
          deploymentId: "deployment-1",
          sandboxId: "sbx-linear-retry",
          sessionId: "tick-deployment-1-retry",
          commandId: "cmd-retry",
          sandboxName: expect.stringContaining("-retry1"),
        }),
      });

      expect(DeploymentTriggerRunPendingError).toBeDefined();
      expect(mocks.runtime.destroy).toHaveBeenCalledWith(expect.objectContaining({ id: "sbx-linear-first" }));
      expect(mocks.runtime.launchDetached).toHaveBeenCalledWith(expect.objectContaining({
        name: expect.stringContaining("-retry1"),
        labels: expect.objectContaining({
          oomRetry: "exit-137",
          retryAttempt: "1",
        }),
      }));
      expect(mocks.runtime.startScript).toHaveBeenCalledWith(
        expect.objectContaining({ id: "sbx-linear-retry" }),
        expect.objectContaining({ sessionId: expect.stringMatching(/^tick-deployment-1-/) }),
      );
      expect(consoleWarn).toHaveBeenCalledWith(
        "[harness] exited with code 137",
        expect.objectContaining({
          diag: "harness-exit-137",
          agentName: "daily-ship",
          sandboxId: "sbx-linear-first",
          commandId: "cmd-oom-1",
          retrying: true,
          outputTail: expect.stringContaining("Killed"),
        }),
      );
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it("retries an async sandbox harness exit 137 from the poller in a fresh sandbox", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      mocks.getAgentDeploymentTickTarget.mockResolvedValue(activeTarget({
        deployedName: "pr-reviewer",
        personaSlug: "pr-reviewer",
        spec: {
          intent: "review",
          harness: "codex",
          integrations: {
            github: { triggers: [{ on: "pull_request.opened" }] },
          },
        },
        inputValues: { PR_SANDBOX_WARM_LEASE_ENABLED: "true" },
      }));
      mocks.runtime.getById.mockResolvedValueOnce({
        id: "sbx-pr-first",
        state: "STARTED",
        name: "pr-reviewer-workspace-agent-cloud-1397",
      });
      mocks.runtime.getScriptStatus.mockResolvedValueOnce({ exitCode: 137 });
      mocks.runtime.getScriptLogs.mockResolvedValueOnce({
        output: "review started\nKilled\n",
        stdout: "",
        stderr: "",
      });
      mocks.runtime.launchDetached.mockResolvedValueOnce({
        id: "sbx-pr-retry",
        state: "STARTED",
        name: "pr-reviewer-deployment-1-retry1",
      });
      mocks.runtime.startScript.mockResolvedValueOnce({
        sessionId: "tick-deployment-1-retry",
        commandId: "cmd-retry",
      });
      const {
        DeploymentTriggerRunPendingError,
        pollDeploymentTriggerRun,
      } = await import("./deployment-trigger-delivery");

      await expect(pollDeploymentTriggerRun({
        workspaceId: "workspace-1",
        agentId: "agent-1",
        deploymentId: "deployment-1",
        sandboxId: "sbx-pr-first",
        sandboxName: "pr-reviewer-workspace-agent-cloud-1397",
        sessionId: "tick-deployment-1-first",
        commandId: "cmd-oom-1",
        startedAt: "2026-06-04T09:01:00.000Z",
        mountConfigured: true,
        payload: {
          type: "github.pull_request.opened",
          resource: {
            number: 1397,
            repository: {
              full_name: "AgentWorkforce/cloud",
              clone_url: "https://github.com/AgentWorkforce/cloud.git",
            },
            head: {
              sha: "head-sha",
              ref: "fix/pr-reviewer-real-checkout",
              repo: { full_name: "AgentWorkforce/cloud" },
            },
            base: {
              sha: "base-sha",
              ref: "main",
              repo: { full_name: "AgentWorkforce/cloud" },
            },
          },
        },
      })).rejects.toMatchObject({
        name: "DeploymentTriggerRunPendingError",
        run: expect.objectContaining({
          deploymentId: "deployment-1",
          sandboxId: "sbx-pr-retry",
          sessionId: "tick-deployment-1-retry",
          commandId: "cmd-retry",
          sandboxName: expect.stringContaining("-retry1"),
        }),
      });

      expect(DeploymentTriggerRunPendingError).toBeDefined();
      expect(mocks.runtime.destroy).toHaveBeenCalledWith(expect.objectContaining({ id: "sbx-pr-first" }));
      expect(mocks.runtime.launchDetached).toHaveBeenCalledWith(expect.objectContaining({
        name: expect.stringContaining("-retry1"),
        labels: expect.objectContaining({
          oomRetry: "exit-137",
          retryAttempt: "1",
        }),
      }));
      expect(mocks.runtime.startScript).toHaveBeenCalledWith(
        expect.objectContaining({ id: "sbx-pr-retry" }),
        expect.objectContaining({ sessionId: expect.stringMatching(/^tick-deployment-1-/) }),
      );
      expect(consoleWarn).toHaveBeenCalledWith(
        "[harness] exited with code 137",
        expect.objectContaining({
          diag: "harness-exit-137",
          agentName: "pr-reviewer",
          sandboxId: "sbx-pr-first",
          commandId: "cmd-oom-1",
          retrying: true,
          outputTail: expect.stringContaining("Killed"),
        }),
      );
      expect(consoleInfo).toHaveBeenCalledWith(
        "[harness] released warm sandbox lease after exit-137 retry handoff",
        expect.objectContaining({
          diag: "harness-exit-137",
          repoFullName: "AgentWorkforce/cloud",
          prNumber: 1397,
        }),
      );
    } finally {
      consoleInfo.mockRestore();
      consoleWarn.mockRestore();
    }
  });

  it("does not retry a persisted async sandbox harness exit 137 retry sandbox again", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mocks.getAgentDeploymentTickTarget.mockResolvedValue(activeTarget({
        deployedName: "pr-reviewer",
        personaSlug: "pr-reviewer",
        spec: {
          intent: "review",
          harness: "codex",
          integrations: {
            github: { triggers: [{ on: "pull_request.opened" }] },
          },
        },
        inputValues: { PR_SANDBOX_WARM_LEASE_ENABLED: "true" },
      }));
      mocks.runtime.getById.mockResolvedValueOnce({
        id: "sbx-pr-retry",
        state: "STARTED",
        name: "pr-reviewer-deployment-1-retry1",
      });
      mocks.runtime.getScriptStatus.mockResolvedValueOnce({ exitCode: 137 });
      mocks.runtime.getScriptLogs.mockResolvedValueOnce({
        output: "second attempt\nKilled again\n",
        stdout: "",
        stderr: "",
      });
      const {
        HarnessExit137Error,
        pollDeploymentTriggerRun,
      } = await import("./deployment-trigger-delivery");

      await expect(pollDeploymentTriggerRun({
        workspaceId: "workspace-1",
        agentId: "agent-1",
        deploymentId: "deployment-1",
        sandboxId: "sbx-pr-retry",
        sandboxName: "pr-reviewer-deployment-1-retry1",
        sessionId: "tick-deployment-1-retry",
        commandId: "cmd-oom-2",
        startedAt: "2026-06-04T09:02:00.000Z",
        mountConfigured: true,
        payload: {
          type: "github.pull_request.opened",
          resource: {
            number: 1397,
            repository: {
              full_name: "AgentWorkforce/cloud",
              clone_url: "https://github.com/AgentWorkforce/cloud.git",
            },
            head: {
              sha: "head-sha",
              ref: "fix/pr-reviewer-real-checkout",
              repo: { full_name: "AgentWorkforce/cloud" },
            },
            base: {
              sha: "base-sha",
              ref: "main",
              repo: { full_name: "AgentWorkforce/cloud" },
            },
          },
        },
      })).rejects.toBeInstanceOf(HarnessExit137Error);

      expect(mocks.runtime.launchDetached).not.toHaveBeenCalled();
      expect(mocks.runtime.startScript).not.toHaveBeenCalled();
      expect(consoleWarn).toHaveBeenCalledWith(
        "[harness] exited with code 137",
        expect.objectContaining({
          diag: "harness-exit-137",
          agentName: "pr-reviewer",
          sandboxId: "sbx-pr-retry",
          commandId: "cmd-oom-2",
          retrying: false,
          attempt: 2,
          outputTail: expect.stringContaining("Killed again"),
        }),
      );
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it("releases a warm PR sandbox on pull_request.closed without running a review", async () => {
    mocks.execute.mockResolvedValueOnce({
      rows: [{
        id: "lease-pr-1397",
        workspace_id: "workspace-1",
        agent_id: "agent-1",
        repo_full_name: "AgentWorkforce/cloud",
        pr_number: 1397,
        sandbox_id: "sbx-pr-1397",
        sandbox_name: "pr-reviewer-workspace-agent-cloud-1397",
        state: "warm",
        lease_until: null,
        last_used_at: new Date("2026-05-29T09:00:00.000Z"),
        attempt_count: 1,
        current_step: "sandbox-ready",
        snapshot_version: "snapshot-current",
      }],
    }).mockResolvedValueOnce({ rows: [] }).mockResolvedValue({ rows: [] });
    mocks.runtime.getById.mockResolvedValueOnce({
      id: "sbx-pr-1397",
      state: "STARTED",
      name: "pr-reviewer-workspace-agent-cloud-1397",
    });
    const {
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: {
        type: "github.pull_request.closed",
        resource: {
          action: "closed",
          pull_request: {
            number: 1397,
            merged: true,
            head: {
              sha: "head-sha",
              ref: "fix/pr-reviewer-real-checkout",
              repo: { full_name: "AgentWorkforce/cloud" },
            },
            base: {
              sha: "base-sha",
              ref: "main",
              repo: { full_name: "AgentWorkforce/cloud" },
            },
          },
          repository: {
            full_name: "AgentWorkforce/cloud",
            clone_url: "https://github.com/AgentWorkforce/cloud.git",
          },
        },
      },
      options: { asyncRunScript: true },
      target: {
        agentId: "agent-1",
        deployedName: "pr-reviewer",
        deployedByUserId: "user-1",
        personaSlug: "pr-reviewer",
        status: "active",
        specHash: "spec-hash",
        spec: {
          intent: "review",
          harness: "codex",
          integrations: {
            github: { triggers: [{ on: "pull_request.closed" }] },
          },
        },
        bundleSha256: "bundle-sha",
        inputValues: { PR_SANDBOX_WARM_LEASE_ENABLED: "true" },
        credentialSelections: {},
      } as never,
    })).resolves.toMatchObject({
      agentId: "agent-1",
      workspaceId: "workspace-1",
      deploymentId: "deployment-1",
      status: "starting",
    });

    expect(mocks.runtime.destroy).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sbx-pr-1397" }),
    );
    expect(mocks.runtime.launchDetached).not.toHaveBeenCalled();
    expect(mocks.runtime.startScript).not.toHaveBeenCalled();
    expect(mocks.runtime.uploadBundle).not.toHaveBeenCalled();
    expect(mocks.mintWorkflowGithubWriteToken).not.toHaveBeenCalled();
    expect(sqlText(mocks.execute.mock.calls[2]?.[0])).toContain("UPDATE pr_sandbox_leases");
  });

  it("mints a GitHub token for fork PR checkout while disabling push-back", async () => {
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: {
        id: "evt_pr",
        type: "github.pull_request.opened",
        resource: {
          number: 1397,
          repository: {
            full_name: "AgentWorkforce/cloud",
            clone_url: "https://github.com/AgentWorkforce/cloud.git",
          },
          head: {
            sha: "head-sha",
            ref: "contributor-branch",
            repo: { full_name: "external/cloud" },
          },
          base: {
            sha: "base-sha",
            ref: "main",
            repo: { full_name: "AgentWorkforce/cloud" },
          },
        },
      },
      options: { asyncRunScript: true },
      target: {
        agentId: "agent-1",
        deployedName: "pr-reviewer",
        deployedByUserId: "user-1",
        personaSlug: "pr-reviewer",
        status: "active",
        specHash: "spec-hash",
        spec: {
          intent: "review",
          harness: "codex",
          integrations: {
            github: { triggers: [{ on: "pull_request.opened" }] },
          },
        },
        bundleSha256: "bundle-sha",
        inputValues: {},
        credentialSelections: {},
      } as never,
    })).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.mintWorkflowGithubWriteToken).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: "workspace-1",
      repoOwner: "AgentWorkforce",
      repoName: "cloud",
    });
    const startArgs = mocks.runtime.startScript.mock.calls[0]?.[1] ?? {};
    const command = String(startArgs.command ?? "");
    expect(startArgs.env).toEqual(expect.objectContaining({
      GITHUB_PR_WORKSPACE_TOKEN: "github-installation-token",
    }));
    expect(command).toContain("GIT_ASKPASS=\"$PR_REVIEWER_GIT_ASKPASS\" GITHUB_PR_WORKSPACE_TOKEN=\"$PR_REVIEWER_GIT_TOKEN_VALUE\" git fetch");
    expect(command).toContain("cannot push pr-reviewer fixes for fork or read-only PR");
    expect(command).not.toContain("git push origin");
    expect(command).not.toContain("github-installation-token");
  });

  it("does not enable pull request checkout machinery for non-review personas on pull_request events", async () => {
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: {
        type: "github.pull_request.opened",
        resource: {
          number: 1397,
          repository: {
            full_name: "AgentWorkforce/cloud",
            clone_url: "https://github.com/AgentWorkforce/cloud.git",
          },
          head: {
            sha: "head-sha",
            ref: "feature-from-human",
            repo: { full_name: "AgentWorkforce/cloud" },
          },
          base: {
            sha: "base-sha",
            ref: "main",
            repo: { full_name: "AgentWorkforce/cloud" },
          },
        },
      },
      options: { asyncRunScript: true },
      target: {
        agentId: "agent-1",
        deployedName: "issue-greeter",
        deployedByUserId: "user-1",
        personaSlug: "issue-greeter",
        status: "active",
        specHash: "spec-hash",
        spec: {
          intent: "triage",
          harness: "codex",
          integrations: {
            github: { triggers: [{ on: "pull_request.opened" }] },
          },
        },
        bundleSha256: "bundle-sha",
        inputValues: {},
        credentialSelections: {},
      } as never,
    })).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.mintWorkflowGithubWriteToken).not.toHaveBeenCalled();
    const startArgs = mocks.runtime.startScript.mock.calls[0]?.[1] ?? {};
    const command = String(startArgs.command ?? "");
    expect(startArgs.env).toBeUndefined();
    expect(command).not.toContain("[pr-reviewer] preparing pull request workspace");
    expect(command).not.toContain("GITHUB_PR_WORKSPACE_TOKEN");
    expect(command).not.toContain("refs/pull/1397/head");
  });

  it("fails loudly for pr-reviewer pull_request events that cannot materialize a checkout", async () => {
    const {
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: {
        type: "github.pull_request.opened",
        resource: {
          number: 1397,
          repository: {
            full_name: "AgentWorkforce/cloud",
            clone_url: "https://github.com/AgentWorkforce/cloud.git",
          },
          head: {
            sha: "head-sha",
            ref: "fix/pr-reviewer-real-checkout",
            repo: { full_name: "AgentWorkforce/cloud" },
          },
        },
      },
      options: { asyncRunScript: true },
      target: {
        agentId: "agent-1",
        deployedName: "pr-reviewer",
        deployedByUserId: "user-1",
        personaSlug: "pr-reviewer",
        status: "active",
        specHash: "spec-hash",
        spec: {
          intent: "review",
          harness: "codex",
          integrations: {
            github: { triggers: [{ on: "pull_request.opened" }] },
          },
        },
        bundleSha256: "bundle-sha",
        inputValues: {},
        credentialSelections: {},
      } as never,
    })).rejects.toMatchObject({
      code: "pr_reviewer_checkout_unavailable",
      status: 422,
    });

    expect(mocks.mintWorkflowGithubWriteToken).not.toHaveBeenCalled();
    expect(mocks.runtime.startScript).not.toHaveBeenCalled();
  });

  it("hydrates stripped review-comment payloads before materializing a PR checkout", async () => {
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: {
        type: "github.pull_request_review_comment.created",
        paths: ["/github/repos/AgentWorkforce/cloud/pulls/1495__comment-trigger/meta.json"],
        resource: {
          pull_request_url: "https://api.github.com/repos/AgentWorkforce/cloud/pulls/1495",
          _links: {
            pull_request: {
              href: "https://api.github.com/repos/AgentWorkforce/cloud/pulls/1495",
            },
          },
          repository: {
            full_name: "AgentWorkforce/cloud",
          },
          commit_id: "abc123",
          comment: {
            user: { login: "human-reviewer", type: "User" },
          },
        },
      },
      options: { asyncRunScript: true },
      target: {
        agentId: "agent-1",
        deployedName: "pr-reviewer",
        deployedByUserId: "user-1",
        personaSlug: "pr-reviewer",
        status: "active",
        specHash: "spec-hash",
        spec: {
          intent: "review",
          harness: "codex",
          integrations: {
            github: { triggers: [{ on: "pull_request_review_comment.created" }] },
          },
        },
        bundleSha256: "bundle-sha",
        inputValues: {},
        credentialSelections: {},
      } as never,
    })).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.mintWorkflowGithubWriteToken).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: "workspace-1",
      repoOwner: "AgentWorkforce",
      repoName: "cloud",
    });
    expect(mocks.readGithubProxyPullRequest).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: "workspace-1",
      owner: "AgentWorkforce",
      repo: "cloud",
      pullNumber: 1495,
    });
    const startArgs = mocks.runtime.startScript.mock.calls[0]?.[1] ?? {};
    const command = String(startArgs.command ?? "");
    expect(startArgs.env).toEqual(expect.objectContaining({
      GITHUB_PR_WORKSPACE_TOKEN: "github-installation-token",
    }));
    expect(command).toContain("refs/pull/1495/head");
    expect(command).toContain("hydrated-head-sha");
    expect(command).toContain("hydrated-base-sha");
    expect(command).toContain("HEAD:refs/heads/fix/comment-trigger");
  });

  it("treats missing hydrated PR metadata as terminal checkout unavailable", async () => {
    mocks.readGithubProxyPullRequest.mockRejectedValueOnce(
      new mocks.GithubProxyPullRequestError("github_api_error", "Not Found", 404),
    );
    const {
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: {
        type: "github.pull_request_review_comment.created",
        paths: ["/github/repos/AgentWorkforce/cloud/pulls/1495__comment-trigger/meta.json"],
        resource: {
          pull_request_url: "https://api.github.com/repos/AgentWorkforce/cloud/pulls/1495",
          repository: { full_name: "AgentWorkforce/cloud" },
        },
      },
      options: { asyncRunScript: true },
      target: {
        agentId: "agent-1",
        deployedName: "pr-reviewer",
        deployedByUserId: "user-1",
        personaSlug: "pr-reviewer",
        status: "active",
        specHash: "spec-hash",
        spec: {
          intent: "review",
          harness: "codex",
          integrations: {
            github: { triggers: [{ on: "pull_request_review_comment.created" }] },
          },
        },
        bundleSha256: "bundle-sha",
        inputValues: {},
        credentialSelections: {},
      } as never,
    })).rejects.toMatchObject({
      code: "pr_reviewer_checkout_unavailable",
      status: 404,
    });

    expect(mocks.runtime.startScript).not.toHaveBeenCalled();
  });

  it("treats transient hydrated PR API failures as retryable", async () => {
    mocks.readGithubProxyPullRequest.mockRejectedValueOnce(
      new mocks.GithubProxyPullRequestError("github_api_error", "server error", 503),
    );
    const {
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: {
        type: "github.pull_request_review_comment.created",
        paths: ["/github/repos/AgentWorkforce/cloud/pulls/1495__comment-trigger/meta.json"],
        resource: {
          pull_request_url: "https://api.github.com/repos/AgentWorkforce/cloud/pulls/1495",
          repository: { full_name: "AgentWorkforce/cloud" },
        },
      },
      options: { asyncRunScript: true },
      target: {
        agentId: "agent-1",
        deployedName: "pr-reviewer",
        deployedByUserId: "user-1",
        personaSlug: "pr-reviewer",
        status: "active",
        specHash: "spec-hash",
        spec: {
          intent: "review",
          harness: "codex",
          integrations: {
            github: { triggers: [{ on: "pull_request_review_comment.created" }] },
          },
        },
        bundleSha256: "bundle-sha",
        inputValues: {},
        credentialSelections: {},
      } as never,
    })).rejects.toMatchObject({
      code: "pr_reviewer_checkout_hydration_failed",
      status: 503,
    });

    expect(mocks.runtime.startScript).not.toHaveBeenCalled();
  });

  it("unmasks Nango proxy outages during pr-reviewer PR hydration", async () => {
    mocks.readGithubProxyPullRequest.mockRejectedValueOnce(
      new mocks.GithubProxyPullRequestError(
        "github_nango_proxy_unavailable",
        "GitHub proxy request GET /repos/AgentWorkforce/cloud/pulls/1495 failed with status 503: Nango is temporarily unavailable",
        503,
      ),
    );
    const {
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: {
        type: "github.pull_request_review_comment.created",
        paths: ["/github/repos/AgentWorkforce/cloud/pulls/1495__comment-trigger/meta.json"],
        resource: {
          pull_request_url: "https://api.github.com/repos/AgentWorkforce/cloud/pulls/1495",
          repository: { full_name: "AgentWorkforce/cloud" },
        },
      },
      options: { asyncRunScript: true },
      target: {
        agentId: "agent-1",
        deployedName: "pr-reviewer",
        deployedByUserId: "user-1",
        personaSlug: "pr-reviewer",
        status: "active",
        specHash: "spec-hash",
        spec: {
          intent: "review",
          harness: "codex",
          integrations: {
            github: { triggers: [{ on: "pull_request_review_comment.created" }] },
          },
        },
        bundleSha256: "bundle-sha",
        inputValues: {},
        credentialSelections: {},
      } as never,
    })).rejects.toMatchObject({
      code: "pr_reviewer_nango_hydration_unavailable",
      status: 503,
      message: expect.stringContaining("Nango GitHub proxy is unavailable"),
    });

    expect(mocks.runtime.startScript).not.toHaveBeenCalled();
  });

  it("keeps GitHub permission 403 during PR hydration terminal", async () => {
    mocks.readGithubProxyPullRequest.mockRejectedValueOnce(
      new mocks.GithubProxyPullRequestError(
        "github_api_error",
        "Resource not accessible by integration",
        403,
      ),
    );
    const {
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: {
        type: "github.pull_request_review_comment.created",
        paths: ["/github/repos/AgentWorkforce/cloud/pulls/1495__comment-trigger/meta.json"],
        resource: {
          pull_request_url: "https://api.github.com/repos/AgentWorkforce/cloud/pulls/1495",
          repository: { full_name: "AgentWorkforce/cloud" },
        },
      },
      options: { asyncRunScript: true },
      target: {
        agentId: "agent-1",
        deployedName: "pr-reviewer",
        deployedByUserId: "user-1",
        personaSlug: "pr-reviewer",
        status: "active",
        specHash: "spec-hash",
        spec: {
          intent: "review",
          harness: "codex",
          integrations: {
            github: { triggers: [{ on: "pull_request_review_comment.created" }] },
          },
        },
        bundleSha256: "bundle-sha",
        inputValues: {},
        credentialSelections: {},
      } as never,
    })).rejects.toMatchObject({
      code: "pr_reviewer_checkout_unavailable",
      status: 403,
    });

    expect(mocks.runtime.startScript).not.toHaveBeenCalled();
  });

  it("treats GitHub secondary-rate-limit 403 during PR hydration as retryable", async () => {
    mocks.readGithubProxyPullRequest.mockRejectedValueOnce(
      new mocks.GithubProxyPullRequestError(
        "github_rate_limited",
        "GitHub proxy request GET /repos/AgentWorkforce/cloud/pulls/1495 failed with status 403: secondary rate limit.",
        503,
      ),
    );
    const {
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: {
        type: "github.pull_request_review_comment.created",
        paths: ["/github/repos/AgentWorkforce/cloud/pulls/1495__comment-trigger/meta.json"],
        resource: {
          pull_request_url: "https://api.github.com/repos/AgentWorkforce/cloud/pulls/1495",
          repository: { full_name: "AgentWorkforce/cloud" },
        },
      },
      options: { asyncRunScript: true },
      target: {
        agentId: "agent-1",
        deployedName: "pr-reviewer",
        deployedByUserId: "user-1",
        personaSlug: "pr-reviewer",
        status: "active",
        specHash: "spec-hash",
        spec: {
          intent: "review",
          harness: "codex",
          integrations: {
            github: { triggers: [{ on: "pull_request_review_comment.created" }] },
          },
        },
        bundleSha256: "bundle-sha",
        inputValues: {},
        credentialSelections: {},
      } as never,
    })).rejects.toMatchObject({
      code: "pr_reviewer_checkout_hydration_failed",
      status: 503,
    });

    expect(mocks.runtime.startScript).not.toHaveBeenCalled();
  });

  it("mints Relayfile mount credentials for the bound rw workspace while preserving app workspace dispatch", async () => {
    mocks.resolveRelayWorkspaceIdForRuntime.mockResolvedValue("rw_7ccfea89");
    mocks.deriveRelayfileMountPaths.mockReturnValue(["/slack/**"]);
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
      agentId: "agent-1",
      payload: { type: "slack.app_mention" },
      options: { asyncRunScript: true },
      target: {
        agentId: "agent-1",
        deployedName: "linear-assistant",
        deployedByUserId: "user-1",
        personaSlug: "linear-assistant",
        status: "active",
        specHash: "spec-hash",
        spec: { integrations: { slack: { triggers: [{ on: "app_mention" }] } } },
        bundleSha256: "bundle-sha",
        inputValues: {},
        credentialSelections: {},
      } as never,
    })).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.mintRelayAuthWorkspaceToken).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "rw_7ccfea89",
        agentName: "agent-1",
      }),
    );
    expect(mocks.runtime.findAllByLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
        agentId: "agent-1",
      }),
      expect.any(Object),
    );
    const startArgs = mocks.runtime.startScript.mock.calls[0]?.[1] ?? {};
    const command = String(startArgs.command ?? "");
    expect(command).toContain("export WORKFORCE_WORKSPACE_ID=");
    expect(command).toContain("50587328-441d-4acb-b8f3-dbe1b3c5de99");
    expect(command).toContain("export RELAY_DEFAULT_WORKSPACE=");
    expect(command).toContain("rw_7ccfea89");
  });

  it("preserves agent-block trigger mounts when the persisted wrapper is unwrapped at load", async () => {
    mocks.resolveRelayWorkspaceIdForRuntime.mockResolvedValue("rw_7ccfea89");
    mocks.relayfilePathsForIntegrations.mockReturnValue(["/slack/**"]);
    mocks.deriveRelayfileMountPaths.mockImplementation((_persona, agent) =>
      agent && typeof agent === "object" && "triggers" in agent ? ["/slack/**"] : []
    );
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
      agentId: "agent-1",
      payload: { type: "slack.app_mention" },
      options: { asyncRunScript: true },
      target: {
        agentId: "agent-1",
        deployedName: "linear-assistant",
        deployedByUserId: "user-1",
        personaSlug: "linear-assistant",
        status: "active",
        specHash: "spec-hash",
        spec: { id: "linear-assistant", integrations: {} },
        agentSpec: { triggers: { slack: [{ on: "app_mention" }] } },
        bundleSha256: "bundle-sha",
        inputValues: {},
        credentialSelections: {},
      } as never,
    })).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.deriveRelayfileMountPaths).toHaveBeenCalledWith(
      { id: "linear-assistant", integrations: {} },
      { triggers: { slack: [{ on: "app_mention" }] } },
    );
    expect(mocks.relayfilePathsForIntegrations).toHaveBeenCalledWith({
      slack: { triggers: [{ on: "app_mention" }] },
    });
    expect(mocks.mintWorkspaceScopedRelayfileTokenPair).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "rw_7ccfea89",
      scopes: expect.arrayContaining([
        "relayfile:fs:read:/slack/*",
        "relayfile:fs:write:/slack/*",
        "relayfile:ops:read:*",
      ]),
    }));
    expect(mocks.mintPathScopedRelayfileToken).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "rw_7ccfea89",
      paths: ["/slack/**"],
      agentName: "agent-1",
      agentId: "agent-1",
    }));
  });

  it("fails loud before cold sandbox provisioning when relay workspace resolution rejects", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.runtime.findAllByLabels.mockResolvedValueOnce([]);
    mocks.resolveRelayWorkspaceIdForRuntime.mockRejectedValueOnce(new Error("binding lookup failed"));
    const {
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    try {
      await expect(deliverDeploymentTrigger({
        workspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
        agentId: "agent-1",
        payload: { type: "github.issues.opened" },
        options: { asyncRunScript: true },
        target: {
          agentId: "agent-1",
          deployedName: "cloud-small-issue-codex",
          deployedByUserId: "user-1",
          personaSlug: "cloud-small-issue-codex",
          status: "active",
          specHash: "spec-hash",
          spec: {},
          bundleSha256: "bundle-sha",
          inputValues: {},
          credentialSelections: {},
        } as never,
      })).rejects.toMatchObject({
        code: "relay_workspace_resolution_failed",
        status: 502,
      });

      expect(mocks.runtime.launchDetached).not.toHaveBeenCalled();
      expect(mocks.runtime.startScript).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith(
        "[persona-bundle-deploy] relay workspace resolution failed; refusing to continue",
        expect.objectContaining({
          agentId: "agent-1",
          workspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
          phase: "provision",
          error: "binding lookup failed",
        }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("fails loud before warm sandbox delivery when relay workspace resolution rejects", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.resolveRelayWorkspaceIdForRuntime.mockRejectedValueOnce(new Error("relay binding unavailable"));
    const {
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    try {
      await expect(deliverDeploymentTrigger({
        workspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
        agentId: "agent-1",
        payload: { type: "github.issues.opened" },
        options: { asyncRunScript: true },
        target: {
          agentId: "agent-1",
          deployedName: "cloud-small-issue-codex",
          deployedByUserId: "user-1",
          personaSlug: "cloud-small-issue-codex",
          status: "active",
          specHash: "spec-hash",
          spec: {},
          bundleSha256: "bundle-sha",
          inputValues: {},
          credentialSelections: {},
        } as never,
      })).rejects.toMatchObject({
        code: "relay_workspace_resolution_failed",
        status: 502,
      });

      expect(mocks.runtime.startScript).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith(
        "[persona-bundle-deploy] relay workspace resolution failed; refusing to continue",
        expect.objectContaining({
          agentId: "agent-1",
          workspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
          phase: "deliver",
          error: "relay binding unavailable",
        }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("fails loud when a Relayfile mount token is required but cannot be minted", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.resolveRelayWorkspaceIdForRuntime.mockResolvedValue("rw_7ccfea89");
    mocks.deriveRelayfileMountPaths.mockReturnValue(["/slack/**"]);
    mocks.mintRelayAuthWorkspaceToken.mockRejectedValueOnce(new Error("relayauth unavailable"));
    const {
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    try {
      await expect(deliverDeploymentTrigger({
        workspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
        agentId: "agent-1",
        payload: { type: "slack.app_mention" },
        options: { asyncRunScript: true },
        target: {
          agentId: "agent-1",
          deployedName: "linear-assistant",
          deployedByUserId: "user-1",
          personaSlug: "linear-assistant",
          status: "active",
          specHash: "spec-hash",
          spec: { integrations: { slack: { triggers: [{ on: "app_mention" }] } } },
          bundleSha256: "bundle-sha",
          inputValues: {},
          credentialSelections: {},
        } as never,
      })).rejects.toMatchObject({
        code: "relayfile_mount_token_unavailable",
        status: 502,
      });

      expect(mocks.runtime.startScript).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith(
        "[persona-bundle-deploy] relayfile mount token mint failed; refusing to continue",
        expect.objectContaining({
          agentId: "agent-1",
          workspaceId: "rw_7ccfea89",
          pathRoots: ["/slack/**"],
          error: "relayauth unavailable",
        }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("fails loud when workflow cloud auth is required but token minting fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("CLOUD_PUBLIC_URL", "https://cloud.example");
    mocks.resolveRelayAuthConfig.mockReturnValue({
      relayAuthUrl: "https://auth.example",
      relayAuthApiKey: "auth-api-key",
    });
    mocks.mintRelayfileToken.mockRejectedValueOnce(new Error("token service unavailable"));
    const {
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    try {
      await expect(deliverDeploymentTrigger({
        workspaceId: "workspace-1",
        agentId: "agent-1",
        payload: { type: "github.issues.opened" },
        options: { asyncRunScript: true },
        target: {
          agentId: "agent-1",
          deployedName: "cloud-small-issue-codex",
          deployedByUserId: "user-1",
          personaSlug: "cloud-small-issue-codex",
          status: "active",
          specHash: "spec-hash",
          spec: {},
          bundleSha256: "bundle-sha",
          inputValues: {},
          credentialSelections: {},
        } as never,
      })).rejects.toMatchObject({
        code: "workflow_workspace_token_unavailable",
        status: 502,
      });

      expect(mocks.runtime.startScript).not.toHaveBeenCalled();
      const insertCall = mocks.execute.mock.calls.find((call) =>
        sqlText(call[0]).includes("INSERT INTO agent_deployment_runs"),
      );
      expect(insertCall).toBeTruthy();
      const insertParams = sqlParams(insertCall?.[0]);
      expect(insertParams).toContain(
        "[deployment-trigger] failed before sandbox output was captured: failed to mint workflow workspace token for deployment trigger: token service unavailable",
      );
      expect(insertParams).toContain(
        "failed to mint workflow workspace token for deployment trigger: token service unavailable",
      );
      expect(consoleError).toHaveBeenCalledWith(
        "[persona-bundle-deploy] workflow token mint failed; refusing to continue",
        expect.objectContaining({
          agentId: "agent-1",
          workspaceId: "workspace-1",
          error: "token service unavailable",
        }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("fails loud when workflow cloud auth is required but RelayAuth API key is missing", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("CLOUD_PUBLIC_URL", "https://cloud.example");
    mocks.resolveRelayAuthConfig.mockReturnValue({
      relayAuthUrl: "https://auth.example",
      relayAuthApiKey: "",
    });
    const {
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    try {
      await expect(deliverDeploymentTrigger({
        workspaceId: "workspace-1",
        agentId: "agent-1",
        payload: { type: "github.issues.opened" },
        options: { asyncRunScript: true },
        target: {
          agentId: "agent-1",
          deployedName: "cloud-small-issue-codex",
          deployedByUserId: "user-1",
          personaSlug: "cloud-small-issue-codex",
          status: "active",
          specHash: "spec-hash",
          spec: {},
          bundleSha256: "bundle-sha",
          inputValues: {},
          credentialSelections: {},
        } as never,
      })).rejects.toMatchObject({
        code: "workflow_workspace_token_unavailable",
        status: 503,
      });

      expect(mocks.mintRelayfileToken).not.toHaveBeenCalled();
      expect(mocks.runtime.startScript).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith(
        "[persona-bundle-deploy] workflow token mint skipped because RelayAuth API key is missing; refusing to continue",
        expect.objectContaining({
          agentId: "agent-1",
          workspaceId: "workspace-1",
        }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it.each([
    ["codex", "openai"],
    ["claude", "anthropic"],
    ["gemini", "google"],
  ])("mounts connected %s CLI credentials before running direct harness personas", async (harness, provider) => {
    vi.clearAllMocks();
    mocks.getDb.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ rows: [] });
    mocks.createInitialAgentDeployment.mockResolvedValue("deployment-1");
    mocks.resolveRelayAuthConfig.mockReturnValue({ relayAuthUrl: "https://auth.example", relayAuthApiKey: "" });
    mocks.resolveRelayfileConfig.mockReturnValue({
      relayAuthUrl: "https://auth.example",
      relayfileUrl: "https://relayfile.example",
    });
    mocks.mintRelayAuthWorkspaceToken.mockResolvedValue("workspace-token");
    mocks.createCredentialStoreS3Client.mockResolvedValue({ kind: "worker-aware-s3-client" });
    mocks.credentialStoreRetrieve.mockResolvedValue('{"tokens":{"access_token":"token"}}');
    mocks.mountCliCredentials.mockResolvedValue(undefined);
    mocks.resolveProviderCredentialRuntimeEnv.mockResolvedValue({ env: {}, credentials: [] });
    mocks.resolveRelayWorkspaceIdForRuntime.mockImplementation(async (workspaceId: string) => workspaceId);
    mocks.deriveRelayfileMountPaths.mockReturnValue([
      "/github/repos/AgentWorkforce/cloud/**",
      "/linear/**",
    ]);
    mocks.loadBundle.mockResolvedValue({
      runner: "console.log('runner');",
      agent: "console.log('agent');",
      packageJson: { dependencies: {} },
    });
    mocks.runtime.findByLabels.mockResolvedValue({
      id: `sbx-${harness}`,
      state: "STARTED",
      name: `${harness}-agent-deploy`,
    });
    mocks.runtime.findAllByLabels.mockResolvedValue([{
      id: `sbx-${harness}`,
      state: "STARTED",
      name: `${harness}-agent-deploy`,
    }]);
    mocks.runtime.uploadBundle.mockResolvedValue(undefined);
    mocks.runtime.startScript.mockResolvedValue({
      sessionId: "tick-deployment-1",
      commandId: `cmd-${harness}`,
    });
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: {
        type: "github.pull_request.opened",
        resource: {
          number: 1397,
          repository: {
            full_name: "AgentWorkforce/cloud",
            clone_url: "https://github.com/AgentWorkforce/cloud.git",
          },
          head: {
            sha: "head-sha",
            ref: "fix/pr-reviewer-real-checkout",
            repo: { full_name: "AgentWorkforce/cloud" },
          },
          base: {
            sha: "base-sha",
            ref: "main",
            repo: { full_name: "AgentWorkforce/cloud" },
          },
        },
      },
      options: { asyncRunScript: true },
      target: {
        agentId: "agent-1",
        deployedName: "pr-reviewer",
        deployedByUserId: "user-1",
        personaSlug: "pr-reviewer",
        status: "active",
        specHash: "spec-hash",
        spec: { harness },
        bundleSha256: "bundle-sha",
        inputValues: {},
        credentialSelections: {},
      } as never,
    })).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.createCredentialStoreS3Client).toHaveBeenCalledWith({ userId: "user-1" });
    expect(mocks.credentialStoreRetrieve).toHaveBeenCalledWith("user-1", provider);
    expect(mocks.mountCliCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        process: expect.any(Object),
        fs: expect.any(Object),
      }),
      "/home/daytona",
      '{"tokens":{"access_token":"token"}}',
      provider,
    );
    expect(mocks.mountCliCredentials.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runtime.startScript.mock.invocationCallOrder[0],
    );
  });

  it("mounts harness CLI credentials even when provider credentials are selected", async () => {
    mocks.credentialStoreRetrieve.mockResolvedValue('{"tokens":{"access_token":"operator-token"}}');
    mocks.mountCliCredentials.mockResolvedValue(undefined);
    mocks.resolveProviderCredentialRuntimeEnv.mockResolvedValue({
      env: {
        ANTHROPIC_API_KEY: "ambient-key",
        GITHUB_TOKEN: "github-token",
      },
      credentials: [],
    });
    mocks.resolveRelayWorkspaceIdForRuntime.mockImplementation(async (workspaceId: string) => workspaceId);
    mocks.deriveRelayfileMountPaths.mockReturnValue([]);
    mocks.loadBundle.mockResolvedValue({
      runner: "console.log('runner');",
      agent: "console.log('agent');",
      packageJson: { dependencies: {} },
    });
    mocks.runtime.findByLabels.mockResolvedValue({
      id: "sbx-claude",
      state: "STARTED",
      name: "claude-agent-deploy",
    });
    mocks.runtime.findAllByLabels.mockResolvedValue([{
      id: "sbx-claude",
      state: "STARTED",
      name: "claude-agent-deploy",
    }]);
    mocks.runtime.uploadBundle.mockResolvedValue(undefined);
    mocks.runtime.startScript.mockResolvedValue({
      sessionId: "tick-deployment-1",
      commandId: "cmd-claude",
    });
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: { type: "cron.tick" },
      options: { asyncRunScript: true },
      target: {
        agentId: "agent-1",
        deployedName: "daily-ship",
        deployedByUserId: "user-1",
        personaSlug: "daily-ship",
        status: "active",
        specHash: "spec-hash",
        spec: { harness: "claude" },
        bundleSha256: "bundle-sha",
        inputValues: {},
        credentialSelections: { github: "credential-github" },
      } as never,
    })).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.credentialStoreRetrieve).toHaveBeenCalledWith("user-1", "anthropic");
    expect(mocks.mountCliCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        process: expect.any(Object),
        fs: expect.any(Object),
      }),
      "/home/daytona",
      '{"tokens":{"access_token":"operator-token"}}',
      "anthropic",
    );
    expect(mocks.resolveProviderCredentialRuntimeEnv).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      userId: "user-1",
      credentialSelections: { github: "credential-github" },
    });
    const command = String(mocks.runtime.startScript.mock.calls[0]?.[1]?.command ?? "");
    expect(command).toContain("unset ANTHROPIC_API_KEY");
    expect(command).not.toContain("export ANTHROPIC_API_KEY=");
    expect(command).toContain("export GITHUB_TOKEN=");
    expect(command).toContain("github-token");
  });

  it("exports CLAUDE_CODE_OAUTH_TOKEN for setup-token anthropic blobs (no .credentials.json shape)", async () => {
    // Setup-token blobs make mountCliCredentials skip the .credentials.json
    // upload BY DESIGN, expecting an env injection that (until this fix) only
    // the workflow launcher performed — persona boxes ended up with neither
    // file nor env while reporting a successful mount (the empty hn-monitor
    // box, 2026-06-04).
    mocks.credentialStoreRetrieve.mockResolvedValue(
      '{"type":"oauth_token","modelProvider":"anthropic","token":"sk-ant-oat01-test"}',
    );
    mocks.mountCliCredentials.mockResolvedValue(undefined);
    mocks.resolveProviderCredentialRuntimeEnv.mockResolvedValue({ env: {}, credentials: [] });
    // The setup-token harness blob feeds ctx.llm via the same in-sandbox
    // credential the harness uses; the resolver derives CLAUDE_CODE_OAUTH_TOKEN
    // from it (mountCliCredentials self-skips the .credentials.json mount for
    // this shape, so the env carries the bearer for both harness and ctx.llm).
    mocks.deriveCtxLlmEnvFromHarnessCredential.mockReturnValue({
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test",
    });
    mocks.resolveRelayWorkspaceIdForRuntime.mockImplementation(async (workspaceId: string) => workspaceId);
    mocks.deriveRelayfileMountPaths.mockReturnValue([]);
    mocks.loadBundle.mockResolvedValue({
      runner: "console.log('runner');",
      agent: "console.log('agent');",
      packageJson: { dependencies: {} },
    });
    mocks.runtime.findByLabels.mockResolvedValue({
      id: "sbx-claude-oat",
      state: "STARTED",
      name: "claude-agent-deploy",
    });
    mocks.runtime.findAllByLabels.mockResolvedValue([{
      id: "sbx-claude-oat",
      state: "STARTED",
      name: "claude-agent-deploy",
    }]);
    mocks.runtime.uploadBundle.mockResolvedValue(undefined);
    mocks.runtime.startScript.mockResolvedValue({
      sessionId: "tick-deployment-1",
      commandId: "cmd-claude-oat",
    });
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: { type: "cron.tick" },
      options: { asyncRunScript: true },
      target: {
        agentId: "agent-1",
        deployedName: "hn-monitor",
        deployedByUserId: "user-1",
        personaSlug: "hn-monitor",
        status: "active",
        specHash: "spec-hash",
        spec: { harness: "claude" },
        bundleSha256: "bundle-sha",
        inputValues: {},
        credentialSelections: {},
      } as never,
    })).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    // mountCliCredentials still runs (it writes the onboarding stub and
    // self-skips the credentials file for this shape).
    expect(mocks.mountCliCredentials).toHaveBeenCalled();
    const command = String(mocks.runtime.startScript.mock.calls[0]?.[1]?.command ?? "");
    expect(command).toContain("export CLAUDE_CODE_OAUTH_TOKEN=");
    expect(command).toContain("sk-ant-oat01-test");
    // The ambient unset must keep scrubbing the api-key var and must NOT
    // touch the OAuth bearer.
    expect(command).toContain("unset ANTHROPIC_API_KEY");
    expect(command).not.toContain("unset CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("exports fresh Daytona credential env for personas that declare the daytona integration", async () => {
    mocks.credentialStoreRetrieve.mockResolvedValue(
      '{"type":"oauth_token","modelProvider":"anthropic","token":"sk-ant-oat01-test"}',
    );
    mocks.mountCliCredentials.mockResolvedValue(undefined);
    mocks.resolveDaytonaCredentialRuntimeEnv.mockResolvedValue({
      DAYTONA_ACCESS_TOKEN: "daytona-access-token",
    });
    mocks.resolveProviderCredentialRuntimeEnv.mockResolvedValue({ env: {}, credentials: [] });
    mocks.deriveCtxLlmEnvFromHarnessCredential.mockReturnValue({
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test",
    });
    mocks.resolveRelayWorkspaceIdForRuntime.mockImplementation(async (workspaceId: string) => workspaceId);
    mocks.deriveRelayfileMountPaths.mockReturnValue([]);
    mocks.loadBundle.mockResolvedValue({
      runner: "console.log('runner');",
      agent: "console.log('agent');",
      packageJson: { dependencies: {} },
    });
    mocks.runtime.findByLabels.mockResolvedValue({
      id: "sbx-daytona-monitor",
      state: "STARTED",
      name: "daytona-monitor-deploy",
    });
    mocks.runtime.findAllByLabels.mockResolvedValue([{
      id: "sbx-daytona-monitor",
      state: "STARTED",
      name: "daytona-monitor-deploy",
    }]);
    mocks.runtime.uploadBundle.mockResolvedValue(undefined);
    mocks.runtime.startScript.mockResolvedValue({
      sessionId: "tick-deployment-1",
      commandId: "cmd-daytona-monitor",
    });
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: { type: "cron.tick" },
      options: { asyncRunScript: true },
      target: {
        agentId: "agent-1",
        deployedName: "daytona-monitor",
        deployedByUserId: "user-1",
        personaSlug: "daytona-monitor",
        status: "active",
        specHash: "spec-hash",
        spec: {
          harness: "claude",
          integrations: { daytona: {} },
        },
        bundleSha256: "bundle-sha",
        inputValues: { DAYTONA_ORG_ID: "org-from-input" },
        credentialSelections: {},
      } as never,
    })).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.resolveDaytonaCredentialRuntimeEnv).toHaveBeenCalledWith({
      userId: "user-1",
    });
    const command = String(mocks.runtime.startScript.mock.calls[0]?.[1]?.command ?? "");
    expect(command).toContain("export DAYTONA_ACCESS_TOKEN=");
    expect(command).toContain("daytona-access-token");
    expect(command).toContain("export DAYTONA_ORG_ID=");
    expect(command).toContain("org-from-input");
  });

  it("fails soft when Daytona credential env is unavailable", async () => {
    mocks.credentialStoreRetrieve.mockResolvedValue(
      '{"type":"oauth_token","modelProvider":"anthropic","token":"sk-ant-oat01-test"}',
    );
    mocks.mountCliCredentials.mockResolvedValue(undefined);
    mocks.resolveDaytonaCredentialRuntimeEnv.mockRejectedValue(
      new Error("No daytona credentials found"),
    );
    mocks.resolveProviderCredentialRuntimeEnv.mockResolvedValue({ env: {}, credentials: [] });
    mocks.deriveCtxLlmEnvFromHarnessCredential.mockReturnValue({
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test",
    });
    mocks.resolveRelayWorkspaceIdForRuntime.mockImplementation(async (workspaceId: string) => workspaceId);
    mocks.deriveRelayfileMountPaths.mockReturnValue([]);
    mocks.loadBundle.mockResolvedValue({
      runner: "console.log('runner');",
      agent: "console.log('agent');",
      packageJson: { dependencies: {} },
    });
    mocks.runtime.findByLabels.mockResolvedValue({
      id: "sbx-daytona-monitor",
      state: "STARTED",
      name: "daytona-monitor-deploy",
    });
    mocks.runtime.findAllByLabels.mockResolvedValue([{
      id: "sbx-daytona-monitor",
      state: "STARTED",
      name: "daytona-monitor-deploy",
    }]);
    mocks.runtime.uploadBundle.mockResolvedValue(undefined);
    mocks.runtime.startScript.mockResolvedValue({
      sessionId: "tick-deployment-1",
      commandId: "cmd-daytona-monitor",
    });
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: { type: "cron.tick" },
      options: { asyncRunScript: true },
      target: {
        agentId: "agent-1",
        deployedName: "daytona-monitor",
        deployedByUserId: "user-1",
        personaSlug: "daytona-monitor",
        status: "active",
        specHash: "spec-hash",
        spec: {
          harness: "claude",
          integrations: { daytona: {} },
        },
        bundleSha256: "bundle-sha",
        inputValues: { DAYTONA_ORG_ID: "org-from-input" },
        credentialSelections: {},
      } as never,
    })).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.resolveDaytonaCredentialRuntimeEnv).toHaveBeenCalledWith({
      userId: "user-1",
    });
    expect(mocks.runtime.startScript).toHaveBeenCalled();
    const command = String(mocks.runtime.startScript.mock.calls[0]?.[1]?.command ?? "");
    expect(command).not.toContain("export DAYTONA_ACCESS_TOKEN=");
    expect(command).toContain("export DAYTONA_ORG_ID=");
    expect(command).toContain("org-from-input");
  });

  it("does not export CLAUDE_CODE_OAUTH_TOKEN for legacy claudeAiOauth blobs (file-mount path unchanged)", async () => {
    mocks.credentialStoreRetrieve.mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: "legacy-access", expiresAt: Date.now() + 8 * 60 * 60 * 1000 } }),
    );
    mocks.mountCliCredentials.mockResolvedValue(undefined);
    mocks.resolveProviderCredentialRuntimeEnv.mockResolvedValue({ env: {}, credentials: [] });
    mocks.resolveRelayWorkspaceIdForRuntime.mockImplementation(async (workspaceId: string) => workspaceId);
    mocks.deriveRelayfileMountPaths.mockReturnValue([]);
    mocks.loadBundle.mockResolvedValue({
      runner: "console.log('runner');",
      agent: "console.log('agent');",
      packageJson: { dependencies: {} },
    });
    mocks.runtime.findByLabels.mockResolvedValue({
      id: "sbx-claude-legacy",
      state: "STARTED",
      name: "claude-agent-deploy",
    });
    mocks.runtime.findAllByLabels.mockResolvedValue([{
      id: "sbx-claude-legacy",
      state: "STARTED",
      name: "claude-agent-deploy",
    }]);
    mocks.runtime.uploadBundle.mockResolvedValue(undefined);
    mocks.runtime.startScript.mockResolvedValue({
      sessionId: "tick-deployment-1",
      commandId: "cmd-claude-legacy",
    });
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: { type: "cron.tick" },
      options: { asyncRunScript: true },
      target: {
        agentId: "agent-1",
        deployedName: "hn-monitor",
        deployedByUserId: "user-1",
        personaSlug: "hn-monitor",
        status: "active",
        specHash: "spec-hash",
        spec: { harness: "claude" },
        bundleSha256: "bundle-sha",
        inputValues: {},
        credentialSelections: {},
      } as never,
    })).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    const command = String(mocks.runtime.startScript.mock.calls[0]?.[1]?.command ?? "");
    expect(command).not.toContain("export CLAUDE_CODE_OAUTH_TOKEN=");
    expect(command).toContain("unset ANTHROPIC_API_KEY");
  });

  it("skips harness CLI credentials and pull request checkout for sandbox false personas", async () => {
    mocks.credentialStoreRetrieve.mockResolvedValue('{"tokens":{"access_token":"operator-token"}}');
    mocks.mountCliCredentials.mockResolvedValue(undefined);
    mocks.resolveProviderCredentialRuntimeEnv.mockResolvedValue({ env: {}, credentials: [] });
    mocks.resolveRelayWorkspaceIdForRuntime.mockImplementation(async (workspaceId: string) => workspaceId);
    mocks.deriveRelayfileMountPaths.mockReturnValue([]);
    mocks.loadBundle.mockResolvedValue({
      runner: "console.log('runner');",
      agent: "console.log('agent');",
      packageJson: { dependencies: {} },
    });
    mocks.runtime.findByLabels.mockResolvedValue({
      id: "sbx-linear-chat",
      state: "STARTED",
      name: "linear-chat-deploy",
    });
    mocks.runtime.findAllByLabels.mockResolvedValue([{
      id: "sbx-linear-chat",
      state: "STARTED",
      name: "linear-chat-deploy",
    }]);
    mocks.runtime.uploadBundle.mockResolvedValue(undefined);
    mocks.runtime.startScript.mockResolvedValue({
      sessionId: "tick-deployment-1",
      commandId: "cmd-linear-chat",
    });
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: {
        type: "linear.AgentSessionEvent.prompted",
        resource: {
          agentSession: { id: "session-1" },
          agentActivity: { id: "activity-1", body: "can you clarify?" },
        },
      },
      options: { asyncRunScript: true },
      target: {
        agentId: "agent-1",
        deployedName: "linear-chat-lead",
        deployedByUserId: "user-1",
        personaSlug: "linear-chat-lead",
        status: "active",
        specHash: "spec-hash",
        spec: {
          sandbox: false,
          harness: "claude",
          capabilities: { pullRequestWriteback: true },
          integrations: {
            linear: {},
            github: { scope: { repo: "AgentWorkforce/cloud" } },
          },
        },
        bundleSha256: "bundle-sha",
        inputValues: {},
        credentialSelections: {},
      } as never,
    })).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.createCredentialStoreS3Client).not.toHaveBeenCalled();
    expect(mocks.credentialStoreRetrieve).not.toHaveBeenCalled();
    expect(mocks.mountCliCredentials).not.toHaveBeenCalled();
    expect(mocks.mintWorkflowGithubWriteToken).not.toHaveBeenCalled();
    expect(mocks.resolveGitCloneCredentials).not.toHaveBeenCalled();
    expect(mocks.runtime.startScript).toHaveBeenCalledTimes(1);
    const command = String(mocks.runtime.startScript.mock.calls[0]?.[1]?.command ?? "");
    expect(command).toContain("node /home/daytona/workforce-runtime/runner.mjs");
    expect(command).not.toContain("[pr-reviewer] preparing pull request workspace");
    expect(command).not.toContain("[proactive-runtime] preparing git workspace source");
    expect(command).not.toContain("GITHUB_PROACTIVE_WORKSPACE_TOKEN");
    expect(command).not.toContain("git clone --filter=blob:none");
  });

  it("injects RELAYFILE_TOKEN/URL/WORKSPACE_ID on the lightweight (sandbox:false) path so direct HTTP writeback works without an FS mount", async () => {
    // A sandbox:false reply bot has no FS mount, so @relayfile/relay-helpers must
    // fall back to the relayfile HTTP API (RelayFileClient) keyed off these env
    // vars. Assert the lightweight delivery path still mints + exports them.
    mocks.credentialStoreRetrieve.mockResolvedValue('{"tokens":{"access_token":"operator-token"}}');
    mocks.mountCliCredentials.mockResolvedValue(undefined);
    mocks.resolveProviderCredentialRuntimeEnv.mockResolvedValue({ env: {}, credentials: [] });
    mocks.resolveRelayWorkspaceIdForRuntime.mockImplementation(async (workspaceId: string) => workspaceId);
    // A real Slack reply bot has relayfile paths — the token is only minted when
    // there is at least one path to scope it to.
    mocks.deriveRelayfileMountPaths.mockReturnValue(["/slack/**"]);
    mocks.loadBundle.mockResolvedValue({
      runner: "console.log('runner');",
      agent: "console.log('agent');",
      packageJson: { dependencies: {} },
    });
    mocks.runtime.findByLabels.mockResolvedValue({
      id: "sbx-slack-reply",
      state: "STARTED",
      name: "slack-reply-deploy",
    });
    mocks.runtime.findAllByLabels.mockResolvedValue([{
      id: "sbx-slack-reply",
      state: "STARTED",
      name: "slack-reply-deploy",
    }]);
    mocks.runtime.uploadBundle.mockResolvedValue(undefined);
    mocks.runtime.startScript.mockResolvedValue({
      sessionId: "tick-deployment-1",
      commandId: "cmd-slack-reply",
    });
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: {
        type: "slack.app_mention",
        resource: { channel: "C9", text: "hey bot" },
      },
      options: { asyncRunScript: true },
      target: {
        agentId: "agent-1",
        deployedName: "slack-reply-bot",
        deployedByUserId: "user-1",
        personaSlug: "slack-reply-bot",
        status: "active",
        specHash: "spec-hash",
        spec: {
          sandbox: false,
          harness: "claude",
          integrations: { slack: {} },
        },
        bundleSha256: "bundle-sha",
        inputValues: {},
        credentialSelections: {},
      } as never,
    })).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.runtime.startScript).toHaveBeenCalledTimes(1);
    const command = String(mocks.runtime.startScript.mock.calls[0]?.[1]?.command ?? "");
    // The three env vars @relayfile/relay-helpers' HTTP fallback reads.
    expect(command).toMatch(/export RELAYFILE_TOKEN=.*relay-ag-token/);
    expect(command).toMatch(/export RELAYFILE_URL=.*https:\/\/relayfile\.example/);
    expect(command).toMatch(/export RELAYFILE_WORKSPACE_ID=.*workspace-1/);
    // Minted with the persona's relayfile path scope (no FS mount needed).
    expect(mocks.mintWorkspaceScopedRelayfileTokenPair).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
    }));
  });

  const subscriptionFallbackDelivery = (overrides: {
    spec: Record<string, unknown>;
    credentialSelections?: Record<string, string>;
  }) => ({
    workspaceId: "workspace-1",
    agentId: "agent-1",
    payload: {
      type: "linear.AgentSessionEvent.prompted",
      resource: {
        agentSession: { id: "session-1" },
        agentActivity: { id: "activity-1", body: "can you clarify?" },
      },
    },
    options: { asyncRunScript: true },
    target: {
      agentId: "agent-1",
      deployedName: "linear-chat-lead",
      deployedByUserId: "user-1",
      personaSlug: "linear-chat-lead",
      status: "active",
      specHash: "spec-hash",
      spec: overrides.spec,
      bundleSha256: "bundle-sha",
      inputValues: {},
      credentialSelections: overrides.credentialSelections ?? {},
    } as never,
  });

  const armSubscriptionFallbackMocks = () => {
    mocks.resolveRelayWorkspaceIdForRuntime.mockImplementation(async (workspaceId: string) => workspaceId);
    mocks.deriveRelayfileMountPaths.mockReturnValue([]);
    mocks.loadBundle.mockResolvedValue({
      runner: "console.log('runner');",
      agent: "console.log('agent');",
      packageJson: { dependencies: {} },
    });
    mocks.runtime.findByLabels.mockResolvedValue({
      id: "sbx-linear-chat",
      state: "STARTED",
      name: "linear-chat-deploy",
    });
    mocks.runtime.findAllByLabels.mockResolvedValue([{
      id: "sbx-linear-chat",
      state: "STARTED",
      name: "linear-chat-deploy",
    }]);
    mocks.runtime.uploadBundle.mockResolvedValue(undefined);
    mocks.runtime.startScript.mockResolvedValue({
      sessionId: "tick-deployment-1",
      commandId: "cmd-linear-chat",
    });
  };

  it("falls back to the active subscription credential for useSubscription personas without selections", async () => {
    // The linear-chat-lead production shape: sandbox:false, no harness,
    // useSubscription:true, deployed (pre-#197 CLI) with empty selections.
    // The consent flag routes the delivery through the subscription
    // fallback, whose env must reach the run command.
    armSubscriptionFallbackMocks();
    mocks.resolveSubscriptionFallbackEnv.mockResolvedValue({
      env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-fallback-access" },
      credentials: [{
        provider: "anthropic",
        providerCredentialId: "credential-active",
        authType: "provider_oauth",
        envVar: "CLAUDE_CODE_OAUTH_TOKEN",
      }],
    });
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger(subscriptionFallbackDelivery({
      spec: {
        sandbox: false,
        useSubscription: true,
        model: "gpt-5.5",
        integrations: { linear: {} },
      },
    }) as never)).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.resolveSubscriptionFallbackEnv).toHaveBeenCalledTimes(1);
    expect(mocks.resolveSubscriptionFallbackEnv).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      userId: "user-1",
      personaModel: "gpt-5.5",
      personaHarness: null,
    });
    expect(mocks.resolveProviderCredentialRuntimeEnv).not.toHaveBeenCalled();
    const command = String(mocks.runtime.startScript.mock.calls[0]?.[1]?.command ?? "");
    expect(command).toContain("export CLAUDE_CODE_OAUTH_TOKEN=");
  });

  it("passes the codex harness as the subscription fallback hint when model is absent", async () => {
    // Legacy Codex deployments can carry harness+useSubscription without a
    // model string. The harness hint keeps them on the codex backend instead
    // of drifting to the deterministic anthropic fallback row.
    armSubscriptionFallbackMocks();
    mocks.resolveSubscriptionFallbackEnv.mockResolvedValue({
      env: { CODEX_OAUTH_CREDENTIAL: "{\"tokens\":{\"access_token\":\"chatgpt\",\"account_id\":\"acct\"}}" },
      credentials: [{
        provider: "openai",
        providerCredentialId: "credential-codex",
        authType: "provider_oauth",
        envVar: "CODEX_OAUTH_CREDENTIAL",
      }],
    });
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger(subscriptionFallbackDelivery({
      spec: {
        sandbox: false,
        harness: "codex",
        useSubscription: true,
        integrations: { linear: {} },
      },
    }) as never)).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.resolveSubscriptionFallbackEnv).toHaveBeenCalledTimes(1);
    expect(mocks.resolveSubscriptionFallbackEnv).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      userId: "user-1",
      personaModel: null,
      personaHarness: "codex",
    });
    const command = String(mocks.runtime.startScript.mock.calls[0]?.[1]?.command ?? "");
    expect(command).toContain("export CODEX_OAUTH_CREDENTIAL=");
  });

  it("reads useSubscription through the wrapped {persona, agent} spec snapshot", async () => {
    // Deployment rows can persist the wrapped spec shape; a flat-only read
    // would silently skip the fallback for those rows (#1649 class).
    armSubscriptionFallbackMocks();
    mocks.resolveSubscriptionFallbackEnv.mockResolvedValue({
      env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-fallback-access" },
      credentials: [{
        provider: "anthropic",
        providerCredentialId: "credential-active",
        authType: "provider_oauth",
        envVar: "CLAUDE_CODE_OAUTH_TOKEN",
      }],
    });
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger(subscriptionFallbackDelivery({
      spec: {
        persona: {
          sandbox: false,
          useSubscription: true,
          model: "gpt-5.5",
          integrations: { linear: {} },
        },
        agent: {},
      },
    }) as never)).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.resolveSubscriptionFallbackEnv).toHaveBeenCalledTimes(1);
    expect(mocks.resolveSubscriptionFallbackEnv).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      userId: "user-1",
      personaModel: "gpt-5.5",
      personaHarness: null,
    });
  });

  it("does not consult the subscription fallback without the useSubscription consent flag", async () => {
    armSubscriptionFallbackMocks();
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger(subscriptionFallbackDelivery({
      spec: {
        sandbox: false,
        model: "gpt-5.5",
        integrations: { linear: {} },
      },
    }) as never)).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.resolveSubscriptionFallbackEnv).not.toHaveBeenCalled();
    expect(mocks.resolveProviderCredentialRuntimeEnv).not.toHaveBeenCalled();
  });

  it("falls back when explicit selections fail to resolve for a useSubscription persona (#1903)", async () => {
    // Stale selections (e.g. the selected row was deleted via the dashboard
    // Disconnect) must degrade to the active-credential fallback instead of
    // hard-failing the delivery — but ONLY under the useSubscription consent.
    armSubscriptionFallbackMocks();
    mocks.resolveProviderCredentialRuntimeEnv.mockRejectedValue(
      new Error("Provider credential credential-deleted was not found"),
    );
    mocks.resolveSubscriptionFallbackEnv.mockResolvedValue({
      env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-fallback-access" },
      credentials: [{
        provider: "anthropic",
        providerCredentialId: "credential-active",
        authType: "provider_oauth",
        envVar: "CLAUDE_CODE_OAUTH_TOKEN",
      }],
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    try {
      await expect(deliverDeploymentTrigger(subscriptionFallbackDelivery({
        spec: {
          sandbox: false,
          useSubscription: true,
          model: "gpt-5.5",
          integrations: { linear: {} },
        },
        credentialSelections: { openai: "credential-deleted" },
      }) as never)).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

      expect(mocks.resolveProviderCredentialRuntimeEnv).toHaveBeenCalledTimes(1);
      expect(mocks.resolveSubscriptionFallbackEnv).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        "[persona-bundle-deploy] credential selection resolution failed; using useSubscription fallback",
        expect.objectContaining({
          credentialSelections: { openai: "credential-deleted" },
        }),
      );
      const command = String(mocks.runtime.startScript.mock.calls[0]?.[1]?.command ?? "");
      expect(command).toContain("export CLAUDE_CODE_OAUTH_TOKEN=");
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps selection-resolution failures fatal without the useSubscription consent flag", async () => {
    armSubscriptionFallbackMocks();
    mocks.resolveProviderCredentialRuntimeEnv.mockRejectedValue(
      new Error("Provider credential credential-deleted was not found"),
    );
    const { deliverDeploymentTrigger } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger(subscriptionFallbackDelivery({
      spec: {
        sandbox: false,
        model: "gpt-5.5",
        integrations: { linear: {} },
      },
      credentialSelections: { openai: "credential-deleted" },
    }) as never)).rejects.toThrow("credential-deleted was not found");

    expect(mocks.resolveSubscriptionFallbackEnv).not.toHaveBeenCalled();
  });

  it("gives explicit credential selections absolute precedence over the subscription fallback", async () => {
    armSubscriptionFallbackMocks();
    mocks.resolveProviderCredentialRuntimeEnv.mockResolvedValue({
      env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-selected" },
      credentials: [],
    });
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger(subscriptionFallbackDelivery({
      spec: {
        sandbox: false,
        useSubscription: true,
        model: "gpt-5.5",
        integrations: { linear: {} },
      },
      credentialSelections: { anthropic: "credential-explicit" },
    }) as never)).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.resolveProviderCredentialRuntimeEnv).toHaveBeenCalledTimes(1);
    expect(mocks.resolveSubscriptionFallbackEnv).not.toHaveBeenCalled();
  });

  it("continues with ambient auth when no harness CLI credentials are stored", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mocks.credentialStoreRetrieve.mockResolvedValue(null);
      mocks.mountCliCredentials.mockResolvedValue(undefined);
      mocks.resolveProviderCredentialRuntimeEnv.mockResolvedValue({
        env: { ANTHROPIC_API_KEY: "ambient-key" },
        credentials: [],
      });
      mocks.resolveRelayWorkspaceIdForRuntime.mockImplementation(async (workspaceId: string) => workspaceId);
      mocks.deriveRelayfileMountPaths.mockReturnValue([]);
      mocks.loadBundle.mockResolvedValue({
        runner: "console.log('runner');",
        agent: "console.log('agent');",
        packageJson: { dependencies: {} },
      });
      mocks.runtime.findByLabels.mockResolvedValue({
        id: "sbx-claude",
        state: "STARTED",
        name: "claude-agent-deploy",
      });
      mocks.runtime.findAllByLabels.mockResolvedValue([{
        id: "sbx-claude",
        state: "STARTED",
        name: "claude-agent-deploy",
      }]);
      mocks.runtime.uploadBundle.mockResolvedValue(undefined);
      mocks.runtime.runScript.mockResolvedValue({
        output: "",
        exitCode: 0,
      });
      mocks.runtime.startScript.mockResolvedValue({
        sessionId: "tick-deployment-1",
        commandId: "cmd-claude",
      });
      const {
        DeploymentTriggerRunPendingError,
        deliverDeploymentTrigger,
      } = await import("./deployment-trigger-delivery");

      await expect(deliverDeploymentTrigger({
        workspaceId: "workspace-1",
        agentId: "agent-1",
        payload: { type: "cron.tick" },
        options: { asyncRunScript: true },
        target: {
          agentId: "agent-1",
          deployedName: "daily-ship",
          deployedByUserId: "user-1",
          personaSlug: "daily-ship",
          status: "active",
          specHash: "spec-hash",
          spec: { harness: "claude" },
          bundleSha256: "bundle-sha",
          inputValues: {},
          credentialSelections: { github: "credential-github" },
        } as never,
      })).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

      expect(mocks.credentialStoreRetrieve).toHaveBeenCalledWith("user-1", "anthropic");
      expect(mocks.mountCliCredentials).not.toHaveBeenCalled();
      expect(mocks.runtime.runScript).toHaveBeenCalledWith(
        expect.objectContaining({ id: "sbx-claude" }),
        expect.objectContaining({
          command: "rm -f '/home/daytona/.claude/.credentials.json' '/home/daytona/.claude.json'",
          timeoutMs: 30_000,
        }),
      );
      expect(mocks.runtime.runScript.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.runtime.startScript.mock.invocationCallOrder[0],
      );
      expect(consoleWarn).toHaveBeenCalledWith(
        "[persona-bundle-deploy] harness CLI credential not connected; falling back to ambient sandbox auth",
        {
          harness: "claude",
          provider: "anthropic",
          userId: "user-1",
        },
      );
      const command = String(mocks.runtime.startScript.mock.calls[0]?.[1]?.command ?? "");
      expect(command).not.toContain("unset ANTHROPIC_API_KEY");
      expect(command).toContain("export ANTHROPIC_API_KEY=");
      expect(command).toContain("ambient-key");
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it("aborts ambient fallback when stale harness credential cleanup fails", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mocks.credentialStoreRetrieve.mockResolvedValue(null);
      mocks.mountCliCredentials.mockResolvedValue(undefined);
      mocks.resolveProviderCredentialRuntimeEnv.mockResolvedValue({
        env: { ANTHROPIC_API_KEY: "ambient-key" },
        credentials: [],
      });
      mocks.resolveRelayWorkspaceIdForRuntime.mockImplementation(async (workspaceId: string) => workspaceId);
      mocks.deriveRelayfileMountPaths.mockReturnValue([]);
      mocks.loadBundle.mockResolvedValue({
        runner: "console.log('runner');",
        agent: "console.log('agent');",
        packageJson: { dependencies: {} },
      });
      mocks.runtime.findByLabels.mockResolvedValue({
        id: "sbx-claude",
        state: "STARTED",
        name: "claude-agent-deploy",
      });
      mocks.runtime.findAllByLabels.mockResolvedValue([{
        id: "sbx-claude",
        state: "STARTED",
        name: "claude-agent-deploy",
      }]);
      mocks.runtime.uploadBundle.mockResolvedValue(undefined);
      mocks.runtime.runScript.mockResolvedValue({
        output: "permission denied",
        exitCode: 1,
      });
      mocks.runtime.startScript.mockResolvedValue({
        sessionId: "tick-deployment-1",
        commandId: "cmd-claude",
      });
      const {
        DeploymentTriggerRunPendingError,
        deliverDeploymentTrigger,
      } = await import("./deployment-trigger-delivery");

      await expect(deliverDeploymentTrigger({
        workspaceId: "workspace-1",
        agentId: "agent-1",
        payload: { type: "cron.tick" },
        options: { asyncRunScript: true },
        target: {
          agentId: "agent-1",
          deployedName: "daily-ship",
          deployedByUserId: "user-1",
          personaSlug: "daily-ship",
          status: "active",
          specHash: "spec-hash",
          spec: { harness: "claude" },
          bundleSha256: "bundle-sha",
          inputValues: {},
          credentialSelections: { github: "credential-github" },
        } as never,
      })).rejects.toThrow("permission denied");

      expect(mocks.mountCliCredentials).not.toHaveBeenCalled();
      expect(mocks.runtime.startScript).not.toHaveBeenCalled();
      expect(consoleWarn).not.toHaveBeenCalledWith(
        "[persona-bundle-deploy] harness CLI credential not connected; falling back to ambient sandbox auth",
        expect.anything(),
      );
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it("exports selected provider credentials for plan or BYOK persona deploys", async () => {
    mocks.resolveProviderCredentialRuntimeEnv.mockResolvedValue({
      env: { OPENAI_API_KEY: "sk-test" },
      credentials: [],
    });
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: {
        type: "github.pull_request.opened",
        resource: {
          number: 1397,
          repository: {
            full_name: "AgentWorkforce/cloud",
            clone_url: "https://github.com/AgentWorkforce/cloud.git",
          },
          head: {
            sha: "head-sha",
            ref: "fix/pr-reviewer-real-checkout",
            repo: { full_name: "AgentWorkforce/cloud" },
          },
          base: {
            sha: "base-sha",
            ref: "main",
            repo: { full_name: "AgentWorkforce/cloud" },
          },
        },
      },
      options: { asyncRunScript: true },
      target: {
        agentId: "agent-1",
        deployedName: "pr-reviewer",
        deployedByUserId: "user-1",
        personaSlug: "pr-reviewer",
        status: "active",
        specHash: "spec-hash",
        spec: { harness: "codex" },
        bundleSha256: "bundle-sha",
        inputValues: {},
        credentialSelections: { openai: "credential-openai" },
      } as never,
    })).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.resolveProviderCredentialRuntimeEnv).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      userId: "user-1",
      credentialSelections: { openai: "credential-openai" },
    });
    const command = String(mocks.runtime.startScript.mock.calls[0]?.[1]?.command ?? "");
    expect(command).toContain("export OPENAI_API_KEY=");
    expect(command).toContain("sk-test");
  });

  it("exports structured CODEX_OAUTH_CREDENTIAL for selected OpenAI subscription credentials", async () => {
    const codexCredential = JSON.stringify({
      tokens: {
        access_token: "chatgpt-access",
        refresh_token: "chatgpt-refresh",
        account_id: "account-123",
      },
      last_refresh: "2026-06-04T20:00:00.000Z",
    });
    mocks.resolveProviderCredentialRuntimeEnv.mockResolvedValue({
      env: { CODEX_OAUTH_CREDENTIAL: codexCredential },
      credentials: [{
        provider: "openai",
        providerCredentialId: "credential-openai-oauth",
        authType: "provider_oauth",
        envVar: "CODEX_OAUTH_CREDENTIAL",
      }],
    });
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: { type: "cron.tick" },
      options: { asyncRunScript: true },
      target: {
        agentId: "agent-1",
        deployedName: "linear-chat-lead",
        deployedByUserId: "user-1",
        personaSlug: "linear-chat-lead",
        status: "active",
        specHash: "spec-hash",
        spec: {
          harness: "codex",
          model: "gpt-5.5",
          useSubscription: true,
        },
        bundleSha256: "bundle-sha",
        inputValues: {},
        credentialSelections: { openai: "credential-openai-oauth" },
      } as never,
    })).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    expect(mocks.resolveProviderCredentialRuntimeEnv).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      userId: "user-1",
      credentialSelections: { openai: "credential-openai-oauth" },
    });
    const command = String(mocks.runtime.startScript.mock.calls[0]?.[1]?.command ?? "");
    expect(command).toContain("export CODEX_OAUTH_CREDENTIAL=");
    expect(command).toContain("$CODEX_OAUTH_CREDENTIAL\" > /home/daytona/.codex/auth.json");
    expect(command).toContain("account-123");
    expect(command).toContain("chatgpt-access");
    expect(command).not.toContain("export OPENAI_API_KEY=");
  });
});

function activeTarget(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "agent-1",
    deployedName: "daily-ship",
    deployedByUserId: "user-1",
    personaSlug: "daily-ship",
    status: "active",
    specHash: "spec-hash",
    spec: {},
    agentSpec: null,
    bundleSha256: "bundle-sha",
    inputValues: {},
    credentialSelections: {},
    ...overrides,
  } as never;
}

function continuationRecord(overrides: Record<string, unknown> = {}) {
  const now = "2026-06-02T10:00:00.000Z";
  return {
    id: "cont-1",
    assistantId: "agent-1",
    sessionId: "session-1",
    threadId: "thread-1",
    userId: "user-1",
    origin: {
      turnId: "turn-original",
      outcome: "needs_clarification",
      stopReason: "clarification_required",
      createdAt: now,
    },
    status: "pending",
    waitFor: { type: "user_reply", correlationKey: "reply-1" },
    continuation: {
      id: "harness-cont-1",
      type: "clarification",
      createdAt: now,
      turnId: "turn-original",
      sessionId: "session-1",
      resumeToken: "resume-1",
      state: { prior: true },
    },
    delivery: { status: "not_applicable" },
    bounds: {
      expiresAt: "2099-06-02T11:00:00.000Z",
      maxResumeAttempts: 3,
      resumeAttempts: 0,
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("deliverDeploymentTrigger cold provisioning yields instead of in-process waiting", () => {
  it("yields immediately when a freshly-created tick sandbox is still booting (persists its id, no in-process poll)", async () => {
    // No reusable warm sandbox → forces the cold on-demand provisioning path.
    mocks.runtime.findAllByLabels.mockResolvedValue([]);
    // The box we launch isn't STARTED yet — it's still coming up.
    mocks.runtime.launchDetached.mockResolvedValue({
      id: "sbx-cold-booting",
      state: "STARTING",
      name: "daily-ship-deployment-1",
    });
    const {
      DeploymentSandboxProvisioningPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    const error = await deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: { type: "cron.tick" },
      // The tick drain enables yield because it persists provisioning_sandbox_id.
      options: { provisioningYieldEnabled: true },
      target: activeTarget(),
    } as never).catch((err: unknown) => err);

    // It yields with ProvisioningPendingError so the tick layer records
    // provisioning_sandbox_id and reschedules — rather than holding the Worker.
    expect(error).toBeInstanceOf(DeploymentSandboxProvisioningPendingError);
    expect(
      (error as InstanceType<typeof DeploymentSandboxProvisioningPendingError>).sandboxId,
    ).toBe("sbx-cold-booting");
    // Yielded the instant it saw STARTING — never entered the getById poll loop...
    expect(mocks.runtime.getById).not.toHaveBeenCalled();
    // ...and never proceeded to upload a bundle or start a run on a not-ready box.
    expect(mocks.runtime.uploadBundle).not.toHaveBeenCalled();
    expect(mocks.runtime.startScript).not.toHaveBeenCalled();
    expect(mocks.runtime.runScript).not.toHaveBeenCalled();
  });

  it("does not double-launch: a started sandbox proceeds straight to the run", async () => {
    mocks.runtime.findAllByLabels.mockResolvedValue([]);
    mocks.runtime.launchDetached.mockResolvedValue({
      id: "sbx-cold-ready",
      state: "STARTED",
      name: "daily-ship-deployment-1",
    });
    mocks.runtime.startScript.mockResolvedValue({
      sessionId: "tick-deployment-1",
      commandId: "cmd-cold-ready",
    });
    const {
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    await expect(
      deliverDeploymentTrigger({
        workspaceId: "workspace-1",
        agentId: "agent-1",
        payload: { type: "cron.tick" },
        options: { asyncRunScript: true },
        target: activeTarget(),
      } as never),
    ).rejects.toBeInstanceOf(DeploymentTriggerRunPendingError);

    // Created exactly once, uploaded, and started — no yield when already STARTED.
    expect(mocks.runtime.launchDetached).toHaveBeenCalledTimes(1);
    expect(mocks.runtime.uploadBundle).toHaveBeenCalledTimes(1);
    expect(mocks.runtime.startScript).toHaveBeenCalledTimes(1);
  });

  it("does NOT yield for a clock delivery without the drain's persist option (in-process wait instead)", async () => {
    // A clock-kind payload that reaches a caller which can't persist the sandbox
    // id (e.g. the direct inbox/vfs deliver routes seeing an empty payload). The
    // yield must stay off so a 503 retry can't orphan a booting sandbox.
    mocks.runtime.findAllByLabels.mockResolvedValue([]);
    mocks.runtime.launchDetached.mockResolvedValue({
      id: "sbx-no-option",
      state: "STARTING",
      name: "daily-ship-deployment-1",
    });
    // In-process wait polls getById until the box is STARTED, then proceeds.
    mocks.runtime.getById.mockResolvedValue({
      id: "sbx-no-option",
      state: "STARTED",
      name: "daily-ship-deployment-1",
    });
    mocks.runtime.startScript.mockResolvedValue({
      sessionId: "tick-deployment-1",
      commandId: "cmd-no-option",
    });
    const {
      DeploymentSandboxProvisioningPendingError,
      DeploymentTriggerRunPendingError,
      deliverDeploymentTrigger,
    } = await import("./deployment-trigger-delivery");

    const error = await deliverDeploymentTrigger({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      payload: { type: "cron.tick" },
      // No provisioningYieldEnabled → must NOT yield on provision.
      options: { asyncRunScript: true },
      target: activeTarget(),
    } as never).catch((err: unknown) => err);

    // It blocked in-process (polled getById) and reached the run — NOT a
    // provisioning yield that would strand the sandbox.
    expect(error).not.toBeInstanceOf(DeploymentSandboxProvisioningPendingError);
    expect(error).toBeInstanceOf(DeploymentTriggerRunPendingError);
    expect(mocks.runtime.getById).toHaveBeenCalled();
    expect(mocks.runtime.startScript).toHaveBeenCalledTimes(1);
  });
});
