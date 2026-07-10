import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "@/lib/logger";
import {
  CloudAgentBoxError,
  buildStickySandboxName,
  createOrAdoptStickySandbox,
  defaultCloudAgentBoxDeps,
  ensureBrokerReady,
  ensureSandboxStarted,
  finalizeBoxConnection,
  flushBoxRelayfileMount,
  mountBoxCredentials,
  prepareBoxGitOverlayRoots,
  reapExpiredCloudAgentBoxKeepalives,
  startBoxRelayfileMount,
  syncBoxGitWorkspace,
  type CloudAgentBoxDeps,
  readCloudAgentBox,
  resetBoxMountCredsThrottleForTesting,
  startCloudAgentBoxWarm,
  stopCloudAgentBox,
  updateCloudAgentBoxMountPaths,
  warmCloudAgentBox,
  writeBoxMountCredsFile,
} from "./box-manager";

const auth = {
  userId: "00000000-0000-0000-0000-000000000001",
  workspaceId: "00000000-0000-0000-0000-000000000002",
  organizationId: "00000000-0000-0000-0000-000000000003",
};

const cloudAgentId = "00000000-0000-0000-0000-000000000004";
const daytona524Error = new Error(
  "<!DOCTYPE html><title>524: A timeout occurred</title> proxy.app.daytona.io",
);

type Credential = Awaited<ReturnType<CloudAgentBoxDeps["findCredential"]>>;
type SandboxRow = Awaited<ReturnType<CloudAgentBoxDeps["findStickySandbox"]>>;

function connectedCredential(overrides: Partial<NonNullable<Credential>> = {}): NonNullable<Credential> {
  return {
    id: cloudAgentId,
    organizationId: auth.organizationId,
    workspaceId: auth.workspaceId,
    userId: auth.userId,
    harness: "claude",
    modelProvider: "anthropic",
    authType: "provider_oauth",
    displayName: "Claude",
    defaultModel: "claude-sonnet-4-5",
    status: "connected",
    credentialExpiresAt: null,
    refreshExhausted: false,
    lastError: null,
    ...overrides,
  };
}

function createHarness() {
  const credentials = new Map<string, NonNullable<Credential>>([
    [cloudAgentId, connectedCredential()],
  ]);
  const sandboxRows = new Map<string, NonNullable<SandboxRow>>();
  const remoteFiles = new Map<string, string>();
  const providerCredentialDeletes: string[] = [];
  let nextSandbox = 1;

  const sandbox = {
    id: "sbx_1",
    organizationId: "org_daytona",
    state: "started",
    getUserHomeDir: vi.fn(async () => "/home/daytona"),
    getSignedPreviewUrl: vi.fn(async () => ({ url: "https://sbx-1.daytona.test/" })),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    process: {
      executeCommand: vi.fn(async (command: string) => {
        const catMatch = /^cat '([^']+)' 2>\/dev\/null$/.exec(command);
        if (catMatch) {
          const content = remoteFiles.get(catMatch[1] ?? "");
          return content === undefined
            ? { exitCode: 1, result: "" }
            : { exitCode: 0, result: content };
        }
        // Simulate the atomic tmp+rename the mount creds writer uses.
        const mvMatch = /^mv -f '([^']+)' '([^']+)'$/.exec(command);
        if (mvMatch) {
          const content = remoteFiles.get(mvMatch[1] ?? "");
          if (content === undefined) {
            return { exitCode: 1, result: "mv: no such file" };
          }
          remoteFiles.set(mvMatch[2] ?? "", content);
          remoteFiles.delete(mvMatch[1] ?? "");
          return { exitCode: 0, result: "" };
        }
        return { exitCode: 0, result: "ok" };
      }),
    },
    fs: {
      uploadFile: vi.fn(async (content: Buffer, destination: string) => {
        remoteFiles.set(destination, content.toString("utf8"));
      }),
    },
  };

  const daytona = {
    create: vi.fn(async () => {
      sandbox.id = `sbx_${nextSandbox}`;
      nextSandbox += 1;
      return sandbox;
    }),
    get: vi.fn(async (sandboxId: string) => {
      sandbox.id = sandboxId;
      return sandbox;
    }),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };

  const deps: CloudAgentBoxDeps = {
    findCredential: vi.fn(async (input) => {
      const credential = credentials.get(input.cloudAgentId);
      if (!credential) {
        return null;
      }
      if (
        credential.userId !== input.auth.userId ||
        credential.workspaceId !== input.auth.workspaceId
      ) {
        return null;
      }
      return credential;
    }),
    findStickySandbox: vi.fn(async (input) => {
      return sandboxRows.get(`${input.workspaceId}:${input.cloudAgentId}`) ?? null;
    }),
    insertSandbox: vi.fn(async (input) => {
      sandboxRows.set(`${input.workspaceId}:${input.cloudAgentId}`, {
        id: input.sandboxId,
        status: input.status,
        brokerPort: input.brokerPort ?? null,
        error: input.error ?? null,
        expectedReadyBy: input.expectedReadyBy ?? null,
        keepaliveUntil: input.keepaliveUntil ?? null,
      });
    }),
    updateSandbox: vi.fn(async (input) => {
      const key = `${input.workspaceId}:${cloudAgentId}`;
      const existing = sandboxRows.get(key);
      if (existing) {
        sandboxRows.set(key, {
          ...existing,
          status: input.status ?? existing.status,
          brokerPort: input.brokerPort === undefined ? existing.brokerPort : input.brokerPort,
          error: input.error === undefined ? existing.error : input.error,
          expectedReadyBy: input.expectedReadyBy === undefined
            ? existing.expectedReadyBy
            : input.expectedReadyBy,
          keepaliveUntil: input.keepaliveUntil === undefined
            ? input.status
              ? null
              : existing.keepaliveUntil
            : input.keepaliveUntil,
        });
      }
    }),
    replaceSandboxId: vi.fn(async (input) => {
      const oldKey = `${input.workspaceId}:${cloudAgentId}`;
      const existing = sandboxRows.get(oldKey);
      if (existing) {
        sandboxRows.set(oldKey, {
          ...existing,
          id: input.newSandboxId,
          status: input.status,
          brokerPort: input.brokerPort === undefined ? existing.brokerPort : input.brokerPort,
          error: input.error === undefined ? existing.error : input.error,
          expectedReadyBy: input.expectedReadyBy === undefined
            ? existing.expectedReadyBy
            : input.expectedReadyBy,
          keepaliveUntil: input.keepaliveUntil ?? null,
        });
      }
    }),
    listExpiredKeepaliveSandboxes: vi.fn(async (input) => {
      return Array.from(sandboxRows.entries())
        .filter(([, row]) => {
          if (row.status !== "running" || !row.keepaliveUntil) {
            return false;
          }
          return new Date(row.keepaliveUntil).getTime() <= input.now.getTime();
        })
        .slice(0, input.limit)
        .map(([key, row]) => {
          const [workspaceId, rowCloudAgentId] = key.split(":");
          return {
            id: row.id,
            workspaceId,
            cloudAgentId: rowCloudAgentId,
            keepaliveUntil: row.keepaliveUntil!,
          };
        });
    }),
    scheduleBackgroundTask: vi.fn((task) => {
      void task();
    }),
    markCredentialUsed: vi.fn(async () => undefined),
    createDaytonaClient: vi.fn(() => daytona),
    getSnapshotName: vi.fn(async () => "snapshot-test"),
    getLiteSnapshotName: vi.fn(async () => "snapshot-lite-test"),
    getCredentialSecret: vi.fn(async () => JSON.stringify({ oauth: true })),
    mountCliCredentials: vi.fn(async () => undefined),
    mintPathScopedRelayfileToken: vi.fn(async (input) => {
      return `relay_pa_${input.paths.join("_")}`;
    }),
    mintRelayAuthWorkspaceToken: vi.fn(async (input) => {
      return `relay_ws_${input.workspaceId}`;
    }),
    evictRelayAuthWorkspaceTokenCache: vi.fn(),
    getBrokerKeySecret: vi.fn(() => "broker-secret"),
    deriveBrokerApiKey: vi.fn((_secret, sandboxId) => `api_${sandboxId}`),
    resolveRelayAuthConfig: vi.fn(() => ({
      relayAuthUrl: "https://api.relayauth.test",
      relayAuthApiKey: "relayauth-api-key",
    })),
    resolveRelayfileConfig: vi.fn(() => ({
      relayfileUrl: "https://relayfile.test",
      relayAuthUrl: "https://api.relayauth.test",
      relayAuthApiKey: "relayauth-api-key",
    })),
    resolveGitCloneCredentials: vi.fn(async () => null),
    startRelayfileMount: vi.fn(async () => ({ pid: "12345" })),
    flushRelayfileMount: vi.fn(async () => undefined),
    withCloudAgentBoxLock: vi.fn(async (_input, fn) => fn()),
    now: vi.fn(() => new Date("2026-05-21T12:00:00.000Z")),
  };

  return { credentials, providerCredentialDeletes, remoteFiles, sandboxRows, sandbox, daytona, deps };
}

async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

async function runNextRetryTimer(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await flushMicrotasks();
    if (vi.getTimerCount() > 0) {
      await vi.runOnlyPendingTimersAsync();
      return;
    }
  }
  expect(vi.getTimerCount()).toBeGreaterThan(0);
}

function mockColdBrokerStart(harness: ReturnType<typeof createHarness>): void {
  let brokerStarted = false;
  vi.mocked(harness.sandbox.process.executeCommand).mockImplementation(async (command: string) => {
    if (command.includes("curl -sf http://127.0.0.1:9800/health")) {
      return brokerStarted
        ? { exitCode: 0, result: "ok\n" }
        : { exitCode: 1, result: "" };
    }
    if (command.includes("require.resolve('@agent-relay/sdk')")) {
      return { exitCode: 0, result: "/tmp/agent-relay-broker-linux-x64\n" };
    }
    if (command.includes("require('@agent-relay/sdk')")) {
      return { exitCode: 0, result: "" };
    }
    if (command.includes("nohup")) {
      brokerStarted = true;
      return { exitCode: 0, result: "" };
    }
    return { exitCode: 0, result: "ok" };
  });
}

function brokerStartCommand(harness: ReturnType<typeof createHarness>): string {
  return vi.mocked(harness.sandbox.process.executeCommand).mock.calls
    .map(([command]) => command)
    .find((command) => command.includes("nohup") && command.includes("agent-relay-broker")) ?? "";
}

describe("cloud agent box manager", () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetBoxMountCredsThrottleForTesting();
    harness = createHarness();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("warms a box using auth.workspaceId, mints a path-scoped token, and returns pear's required fields", async () => {
    const response = await warmCloudAgentBox(harness.deps, {
      auth,
      urlWorkspaceId: "11111111-1111-1111-1111-111111111111",
      cloudAgentId,
      workspaceToken: null,
      mountPaths: ["/workspace", "/docs"],
    });

    expect(harness.deps.findCredential).toHaveBeenCalledWith({
      auth,
      cloudAgentId,
    });
    expect(harness.deps.mintRelayAuthWorkspaceToken).toHaveBeenCalledWith({
      workspaceId: auth.workspaceId,
      agentName: "Claude",
    });
    expect(harness.deps.mintPathScopedRelayfileToken).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: auth.workspaceId,
        relayAuthUrl: "https://api.relayauth.test",
        workspaceToken: `relay_ws_${auth.workspaceId}`,
        paths: ["/docs", "/workspace"],
      }),
    );
    expect(harness.deps.withCloudAgentBoxLock).toHaveBeenCalledWith(
      {
        workspaceId: auth.workspaceId,
        cloudAgentId,
      },
      expect.any(Function),
    );
    expect(harness.daytona.create).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: expect.objectContaining({
          workspaceId: auth.workspaceId,
          cloudAgentId,
        }),
      }),
      { timeout: 120 },
    );
    expect(response).toMatchObject({
      sandboxId: "sbx_1",
      execUrl: "https://sbx-1.daytona.test",
      relayfileToken: "relay_pa_/docs_/workspace",
      relayfileMountPath: "/workspace",
      status: "ready",
      apiKey: "api_sbx_1",
    });
    expect(harness.deps.startRelayfileMount).toHaveBeenCalledWith({
      sandbox: harness.sandbox,
      sandboxHome: "/home/daytona",
      config: {
        baseUrl: "https://relayfile.test",
        workspaceId: auth.workspaceId,
        localDir: "/workspace",
        token: "relay_pa_/docs_/workspace",
        interval: "3s",
        paths: ["/docs", "/workspace"],
        websocket: false,
        credsFilePath: "/home/daytona/.relayfile-mount-creds.json",
      },
    });
  });

  it("clones a large git workspace directly while mounting only integration paths", async () => {
    const response = await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
      mountPaths: ["/integrations/github"],
      workspaceSource: {
        kind: "git",
        remoteUrl: "https://github.com/acme/large-repo.git",
        ref: "main",
        commit: "abc123",
        shallow: true,
        targetDir: "/workspace",
        largeReason: "6000 tracked files",
      },
    });

    expect(response).toMatchObject({
      sandboxId: "sbx_1",
      relayfileMountPath: "/workspace",
      status: "ready",
    });
    expect(harness.deps.mintPathScopedRelayfileToken).toHaveBeenCalledWith(
      expect.objectContaining({
        paths: ["/integrations/github"],
      }),
    );
    expect(harness.deps.startRelayfileMount).toHaveBeenCalledWith({
      sandbox: harness.sandbox,
      sandboxHome: "/home/daytona",
      config: expect.objectContaining({
        localDir: "/",
        paths: ["/integrations/github"],
      }),
    });
    const commands = vi.mocked(harness.sandbox.process.executeCommand).mock.calls
      .map(([command]) => command);
    expect(commands.some((command) => command.includes("git clone") && command.includes("https://github.com/acme/large-repo.git"))).toBe(true);
    expect(commands.some((command) => command.includes("checkout --detach 'abc123'"))).toBe(true);
  });

  it("evicts a stale cached workspace token and retries path-scoped token mint once", async () => {
    vi.mocked(harness.deps.mintRelayAuthWorkspaceToken)
      .mockResolvedValueOnce("relay_ws_stale")
      .mockResolvedValueOnce("relay_ws_fresh");
    vi.mocked(harness.deps.mintPathScopedRelayfileToken)
      .mockRejectedValueOnce(new Error("relayauth path-token mint failed: 401 unauthorized: authentication failed: Bearer token is invalid"))
      .mockResolvedValueOnce("relay_pa_fresh");

    const response = await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
      mountPaths: ["/workspace"],
    });

    expect(response).toMatchObject({
      sandboxId: "sbx_1",
      relayfileToken: "relay_pa_fresh",
      relayfileMountPath: "/workspace",
      status: "ready",
    });
    expect(harness.deps.mintRelayAuthWorkspaceToken).toHaveBeenCalledTimes(2);
    expect(harness.deps.evictRelayAuthWorkspaceTokenCache).toHaveBeenCalledWith({
      relayAuthApiKey: "relayauth-api-key",
      workspaceId: auth.workspaceId,
    });
    expect(harness.deps.mintPathScopedRelayfileToken).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        workspaceToken: "relay_ws_stale",
        paths: ["/workspace"],
      }),
    );
    expect(harness.deps.mintPathScopedRelayfileToken).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        workspaceToken: "relay_ws_fresh",
        paths: ["/workspace"],
      }),
    );
  });

  it("clones a git-overlay workspace before mounting relayfile on /workspace", async () => {
    const response = await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
      mountPaths: ["/workspace", "/integrations/github"],
      workspaceSource: {
        kind: "git-overlay",
        remoteUrl: "https://github.com/acme/fast-repo.git",
        ref: "main",
        commit: "abc123",
        shallow: true,
        targetDir: "/workspace",
      },
    });

    expect(response).toMatchObject({
      sandboxId: "sbx_1",
      relayfileMountPath: "/workspace",
      status: "ready",
    });
    expect(harness.deps.mintPathScopedRelayfileToken).toHaveBeenCalledWith(
      expect.objectContaining({
        paths: ["/integrations/github", "/workspace"],
      }),
    );
    expect(harness.deps.startRelayfileMount).toHaveBeenCalledWith({
      sandbox: harness.sandbox,
      sandboxHome: "/home/daytona",
      config: expect.objectContaining({
        localDir: "/workspace",
        paths: ["/integrations/github", "/workspace"],
      }),
    });
    const commands = vi.mocked(harness.sandbox.process.executeCommand).mock.calls
      .map(([command]) => command);
    const gitCommandIndex = commands.findIndex((command) =>
      command.includes("git clone") && command.includes("https://github.com/acme/fast-repo.git"));
    expect(gitCommandIndex).toBeGreaterThanOrEqual(0);
    expect(
      vi.mocked(harness.sandbox.process.executeCommand).mock.invocationCallOrder[gitCommandIndex],
    ).toBeLessThan(
      vi.mocked(harness.deps.startRelayfileMount).mock.invocationCallOrder[0],
    );
    expect(commands.some((command) => command.includes("mkdir -p '/workspace'"))).toBe(true);
    expect(commands.some((command) => command.includes("mkdir -p '/integrations'"))).toBe(false);

    // /workspace dir-provisioning perms fix: the clone target at filesystem root
    // is created with a privileged (sudo) fallback and chowned to the sandbox
    // user before the clone, since the non-root daytona user cannot mkdir at /.
    const gitSyncCommand = commands[gitCommandIndex];
    expect(gitSyncCommand).toContain(
      "mkdir -p '/workspace' 2>/dev/null || sudo mkdir -p '/workspace'",
    );
    expect(gitSyncCommand).toContain(
      "chown \"$(id -u):$(id -g)\" '/workspace' 2>/dev/null || sudo chown \"$(id -u):$(id -g)\" '/workspace'",
    );
    // The dir itself is never removed (it may be privileged/a mount point); only
    // its contents are emptied before cloning into the existing empty dir.
    expect(gitSyncCommand).not.toContain("rm -rf '/workspace' &&");
    expect(gitSyncCommand).toContain(
      "find '/workspace' -mindepth 1 -maxdepth 1 -exec rm -rf {} +",
    );
  });

  it("rejects direct git Relayfile mounts that overlap the cloned workspace", async () => {
    await expect(warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
      mountPaths: ["/workspace", "/integrations/github"],
      workspaceSource: {
        kind: "git",
        remoteUrl: "https://github.com/acme/large-repo.git",
        ref: "main",
        shallow: true,
        targetDir: "/workspace",
      },
    })).rejects.toMatchObject({
      status: 400,
      code: "invalid_request",
    });

    expect(harness.daytona.create).not.toHaveBeenCalled();
  });

  it("uses a GitHub integration token for private direct git clones without embedding it in the remote", async () => {
    vi.mocked(harness.deps.resolveGitCloneCredentials).mockResolvedValueOnce({
      provider: "github",
      username: "x-access-token",
      token: "ghs_private-token",
    });

    await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
      mountPaths: ["/integrations/github"],
      workspaceSource: {
        kind: "git",
        remoteUrl: "https://github.com/acme/private-repo.git",
        ref: "main",
        shallow: true,
        targetDir: "/workspace",
      },
    });

    expect(harness.deps.resolveGitCloneCredentials).toHaveBeenCalledWith({
      userId: auth.userId,
      workspaceId: auth.workspaceId,
      remoteUrl: "https://github.com/acme/private-repo.git",
    });
    const gitCall = vi.mocked(harness.sandbox.process.executeCommand).mock.calls
      .find(([command]) => command.includes("git clone"));
    expect(gitCall).toBeTruthy();
    expect(gitCall?.[0]).toContain("GIT_ASKPASS");
    expect(gitCall?.[0]).toContain("https://github.com/acme/private-repo.git");
    expect(gitCall?.[0]).not.toContain("ghs_private-token");
    expect((gitCall as unknown as unknown[])?.[2]).toEqual({
      GIT_CLONE_USERNAME: "x-access-token",
      GIT_CLONE_TOKEN: "ghs_private-token",
    });
  });

  it("strips embedded credentials from direct git remotes before clone, env persistence, and token resolution", async () => {
    await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
      mountPaths: ["/integrations/github"],
      workspaceSource: {
        kind: "git",
        remoteUrl: "https://user:secret-token@github.com/acme/private-repo.git?x=1#frag",
        ref: "main",
        shallow: true,
        targetDir: "/workspace",
      },
    });

    expect(harness.deps.resolveGitCloneCredentials).toHaveBeenCalledWith({
      userId: auth.userId,
      workspaceId: auth.workspaceId,
      remoteUrl: "https://github.com/acme/private-repo.git",
    });
    const gitCall = vi.mocked(harness.sandbox.process.executeCommand).mock.calls
      .find(([command]) => command.includes("git clone"));
    expect(gitCall?.[0]).toContain("https://github.com/acme/private-repo.git");
    expect(gitCall?.[0]).not.toContain("secret-token");
    const envFile = JSON.parse(harness.remoteFiles.get("/home/daytona/.cloud-agent-box-env.json") ?? "{}") as Record<string, string>;
    expect(envFile.PEAR_WORKSPACE_GIT_REMOTE).toBe("https://github.com/acme/private-repo.git");
  });

  it("uses a GitLab integration token for private direct git clones", async () => {
    vi.mocked(harness.deps.resolveGitCloneCredentials).mockResolvedValueOnce({
      provider: "gitlab",
      username: "oauth2",
      token: "gl_oauth-token",
    });

    await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
      mountPaths: ["/integrations/gitlab"],
      workspaceSource: {
        kind: "git",
        remoteUrl: "https://gitlab.com/acme/platform/private-repo.git",
        ref: "main",
        shallow: true,
        targetDir: "/workspace",
      },
    });

    expect(harness.deps.resolveGitCloneCredentials).toHaveBeenCalledWith({
      userId: auth.userId,
      workspaceId: auth.workspaceId,
      remoteUrl: "https://gitlab.com/acme/platform/private-repo.git",
    });
    const gitCall = vi.mocked(harness.sandbox.process.executeCommand).mock.calls
      .find(([command]) => command.includes("git clone"));
    expect(gitCall).toBeTruthy();
    expect(gitCall?.[0]).toContain("https://gitlab.com/acme/platform/private-repo.git");
    expect(gitCall?.[0]).not.toContain("gl_oauth-token");
    expect((gitCall as unknown as unknown[])?.[2]).toEqual({
      GIT_CLONE_USERNAME: "oauth2",
      GIT_CLONE_TOKEN: "gl_oauth-token",
    });
  });

  it("gracefully continues if relayfile mount startup fails", async () => {
    const warn = vi.spyOn(logger, "warn").mockResolvedValue(undefined);
    vi.mocked(harness.deps.startRelayfileMount).mockRejectedValueOnce(new Error("fuse denied"));

    const response = await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
    });

    expect(response).toMatchObject({
      sandboxId: "sbx_1",
      status: "ready",
      apiKey: "api_sbx_1",
    });
    expect(harness.sandbox.fs.uploadFile).toHaveBeenCalled();
    expect(harness.sandbox.process.executeCommand).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[cloud-agent-box] relayfile mount startup failed; continuing without FUSE",
      expect.objectContaining({
        area: "cloud-agent-box",
        workspaceId: auth.workspaceId,
        cloudAgentId,
        sandboxId: "sbx_1",
        error: "fuse denied",
      }),
    );
  });

  it("returns 404 when the cloud agent credential is absent or not owned by the caller", async () => {
    harness.credentials.delete(cloudAgentId);

    await expect(
      warmCloudAgentBox(harness.deps, {
        auth,
        cloudAgentId,
        workspaceToken: null,
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: "cloud_agent_not_found",
    });

    harness.credentials.set(
      cloudAgentId,
      connectedCredential({ workspaceId: "11111111-1111-1111-1111-111111111111" }),
    );

    await expect(
      warmCloudAgentBox(harness.deps, {
        auth,
        cloudAgentId,
        workspaceToken: null,
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: "cloud_agent_not_found",
    });
  });

  it("returns credential_unavailable for unusable credentials", async () => {
    harness.credentials.set(
      cloudAgentId,
      connectedCredential({ lastError: "credential disconnected" }),
    );

    await expect(
      warmCloudAgentBox(harness.deps, {
        auth,
        cloudAgentId,
        workspaceToken: null,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "credential_unavailable",
    });
  });

  it("reuses the sticky sandbox for repeated warm calls", async () => {
    const first = await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
    });
    const second = await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
    });

    expect(first.sandboxId).toBe("sbx_1");
    expect(second.sandboxId).toBe("sbx_1");
    expect(harness.daytona.create).toHaveBeenCalledTimes(1);
    expect(harness.deps.flushRelayfileMount).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(harness.deps.flushRelayfileMount).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(harness.deps.startRelayfileMount).mock.invocationCallOrder[1],
    );
  });

  it("names the sandbox with a cloudAgentId suffix so distinct cloud agents never collide", async () => {
    await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
    });

    expect(harness.daytona.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: buildStickySandboxName({ displayName: "Claude", cloudAgentId }),
      }),
      { timeout: 120 },
    );
  });

  it("adopts the existing same-named sandbox when Daytona reports a name conflict", async () => {
    const expectedName = buildStickySandboxName({ displayName: "Claude", cloudAgentId });
    harness.daytona.create.mockRejectedValueOnce(
      new Error(`Sandbox with name ${expectedName} already exists`),
    );
    // The drifted box resolves by name and is auto-stopped, so it must be started.
    harness.daytona.get.mockImplementationOnce(async () => {
      harness.sandbox.id = "sbx_adopted";
      harness.sandbox.state = "stopped";
      return harness.sandbox;
    });

    const response = await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
    });

    expect(harness.daytona.create).toHaveBeenCalledTimes(1);
    expect(harness.daytona.get).toHaveBeenCalledWith(expectedName);
    expect(harness.daytona.start).toHaveBeenCalledWith(harness.sandbox, 120);
    // The adopted box predates this request, so it must never be deleted as a
    // rollback even though we did not create it here.
    expect(harness.daytona.delete).not.toHaveBeenCalled();
    expect(response).toMatchObject({ sandboxId: "sbx_adopted", status: "ready" });
    expect(harness.deps.insertSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxId: "sbx_adopted", status: "running" }),
    );
  });

  it("adopts on an HTTP 409 conflict even when the message wording changes", async () => {
    const conflict = Object.assign(new Error("conflict: resource already in use"), {
      statusCode: 409,
    });
    harness.daytona.create.mockRejectedValueOnce(conflict);

    const response = await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
    });

    expect(harness.daytona.get).toHaveBeenCalledWith(
      buildStickySandboxName({ displayName: "Claude", cloudAgentId }),
    );
    expect(response).toMatchObject({ status: "ready" });
  });

  it("does not adopt on create errors that are not name conflicts", async () => {
    harness.daytona.create.mockRejectedValueOnce(new Error("invalid snapshot"));

    await expect(
      warmCloudAgentBox(harness.deps, {
        auth,
        cloudAgentId,
        workspaceToken: null,
      }),
    ).rejects.toThrow("invalid snapshot");
    expect(harness.daytona.get).not.toHaveBeenCalled();
    expect(harness.deps.insertSandbox).not.toHaveBeenCalled();
  });

  it("retries Daytona create upstream timeouts before surfacing a ready box", async () => {
    vi.useFakeTimers();
    harness.daytona.create
      .mockRejectedValueOnce(daytona524Error)
      .mockRejectedValueOnce(daytona524Error)
      .mockResolvedValueOnce(harness.sandbox);

    const warmPromise = warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
    });

    await flushMicrotasks();
    expect(harness.daytona.create).toHaveBeenCalledTimes(1);

    await runNextRetryTimer();
    await flushMicrotasks();
    expect(harness.daytona.create).toHaveBeenCalledTimes(2);

    await runNextRetryTimer();
    await flushMicrotasks();
    expect(harness.daytona.create).toHaveBeenCalledTimes(3);

    await expect(warmPromise).resolves.toMatchObject({
      sandboxId: "sbx_1",
      status: "ready",
    });
    expect(harness.deps.insertSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxId: "sbx_1",
        status: "running",
      }),
    );
  });

  it("turns exhausted Daytona create upstream timeouts into a clean 504 box error", async () => {
    vi.useFakeTimers();
    harness.daytona.create.mockRejectedValue(daytona524Error);

    const warmPromise = warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
    });
    const observedError = warmPromise.catch((error) => error);

    await flushMicrotasks();
    expect(harness.daytona.create).toHaveBeenCalledTimes(1);

    await runNextRetryTimer();
    await flushMicrotasks();
    expect(harness.daytona.create).toHaveBeenCalledTimes(2);

    await runNextRetryTimer();
    await flushMicrotasks();
    expect(harness.daytona.create).toHaveBeenCalledTimes(3);

    const error = await observedError;
    expect(error).toBeInstanceOf(CloudAgentBoxError);
    expect(error).toMatchObject({
      status: 504,
      code: "daytona_upstream_timeout",
      message: "Daytona is currently unresponsive — please retry in a moment",
    });
    expect(harness.deps.insertSandbox).not.toHaveBeenCalled();
  });

  it("PATCH re-scopes mount paths with a fresh returned token", async () => {
    await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
    });

    const response = await updateCloudAgentBoxMountPaths(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
      mountPaths: ["/workspace", "/integrations/slack"],
    });

    expect(response).toMatchObject({
      sandboxId: "sbx_1",
      relayfileToken: "relay_pa_/integrations/slack_/workspace",
      relayfileMountPath: "/workspace",
      status: "ready",
    });
    expect(harness.deps.mintPathScopedRelayfileToken).toHaveBeenCalledWith(
      expect.objectContaining({
        relayAuthUrl: "https://api.relayauth.test",
        workspaceToken: `relay_ws_${auth.workspaceId}`,
        paths: ["/integrations/slack", "/workspace"],
      }),
    );
    expect(harness.deps.flushRelayfileMount).toHaveBeenCalledWith({
      sandbox: harness.sandbox,
      sandboxHome: "/home/daytona",
      config: {
        baseUrl: "https://relayfile.test",
        workspaceId: auth.workspaceId,
        localDir: "/workspace",
        token: "relay_pa_/workspace",
        interval: "3s",
        paths: ["/workspace"],
        websocket: false,
        credsFilePath: "/home/daytona/.relayfile-mount-creds.json",
      },
    });
    expect(harness.deps.startRelayfileMount).toHaveBeenLastCalledWith({
      sandbox: harness.sandbox,
      sandboxHome: "/home/daytona",
      config: {
        baseUrl: "https://relayfile.test",
        workspaceId: auth.workspaceId,
        localDir: "/workspace",
        token: "relay_pa_/integrations/slack_/workspace",
        interval: "3s",
        paths: ["/integrations/slack", "/workspace"],
        websocket: false,
        credsFilePath: "/home/daytona/.relayfile-mount-creds.json",
      },
    });
    expect(
      vi.mocked(harness.deps.flushRelayfileMount).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(harness.deps.startRelayfileMount).mock.invocationCallOrder[1],
    );
  });

  it("PATCH syncs a direct git workspace before restarting the integration mount", async () => {
    await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
    });
    vi.mocked(harness.sandbox.process.executeCommand).mockClear();
    vi.mocked(harness.deps.startRelayfileMount).mockClear();

    const response = await updateCloudAgentBoxMountPaths(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
      mountPaths: ["/integrations/github"],
      workspaceSource: {
        kind: "git",
        remoteUrl: "https://github.com/acme/large-repo.git",
        ref: "main",
        commit: "abc123",
        shallow: true,
        targetDir: "/workspace",
      },
    });

    expect(response).toMatchObject({
      sandboxId: "sbx_1",
      relayfileMountPath: "/workspace",
      status: "ready",
    });
    const commands = vi.mocked(harness.sandbox.process.executeCommand).mock.calls
      .map(([command]) => command);
    expect(commands.some((command) => command.includes("git clone") && command.includes("https://github.com/acme/large-repo.git"))).toBe(true);
    expect(harness.deps.startRelayfileMount).toHaveBeenLastCalledWith({
      sandbox: harness.sandbox,
      sandboxHome: "/home/daytona",
      config: expect.objectContaining({
        localDir: "/",
        paths: ["/integrations/github"],
      }),
    });
  });

  it("PATCH syncs a git-overlay workspace before restarting the workspace mount", async () => {
    await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
    });
    vi.mocked(harness.sandbox.process.executeCommand).mockClear();
    vi.mocked(harness.deps.startRelayfileMount).mockClear();

    const response = await updateCloudAgentBoxMountPaths(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
      mountPaths: ["/workspace", "/integrations/github"],
      workspaceSource: {
        kind: "git-overlay",
        remoteUrl: "https://github.com/acme/fast-repo.git",
        ref: "main",
        commit: "abc123",
        shallow: true,
        targetDir: "/workspace",
      },
    });

    expect(response).toMatchObject({
      sandboxId: "sbx_1",
      relayfileMountPath: "/workspace",
      status: "ready",
    });
    const commands = vi.mocked(harness.sandbox.process.executeCommand).mock.calls
      .map(([command]) => command);
    expect(commands.some((command) => command.includes("git clone") && command.includes("https://github.com/acme/fast-repo.git"))).toBe(true);
    expect(harness.deps.startRelayfileMount).toHaveBeenLastCalledWith({
      sandbox: harness.sandbox,
      sandboxHome: "/home/daytona",
      config: expect.objectContaining({
        localDir: "/workspace",
        paths: ["/integrations/github", "/workspace"],
      }),
    });
  });

  it("warm seeds the mount creds file and points the daemon at it (#T15)", async () => {
    await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
      mountPaths: ["/workspace"],
    });

    const creds = JSON.parse(
      harness.remoteFiles.get("/home/daytona/.relayfile-mount-creds.json") ?? "null",
    );
    expect(creds?.token).toBe("relay_pa_/workspace");
    expect(typeof creds?.mintedAt).toBe("string");
    expect(typeof creds?.expiresAt).toBe("string");
    // tmp file is renamed away, never left behind
    expect(harness.remoteFiles.has("/home/daytona/.relayfile-mount-creds.json.tmp")).toBe(false);
    expect(harness.deps.startRelayfileMount).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          credsFilePath: "/home/daytona/.relayfile-mount-creds.json",
        }),
      }),
    );
  });

  it("mount creds writer fails if the atomic rename fails (#T15)", async () => {
    vi.mocked(harness.sandbox.process.executeCommand).mockResolvedValueOnce({
      exitCode: 1,
      result: "mv: no such file",
    });

    await expect(
      writeBoxMountCredsFile(
        harness.deps,
        harness.sandbox,
        "/home/daytona",
        "relay_pa_/workspace",
      ),
    ).rejects.toThrow("mv: no such file");

    expect(harness.remoteFiles.has("/home/daytona/.relayfile-mount-creds.json")).toBe(false);
  });

  it("GET refreshes the mount creds file only past the TTL/2 throttle (#T15)", async () => {
    const baseNow = new Date("2026-05-21T12:00:00.000Z");
    await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
      mountPaths: ["/workspace", "/docs"],
    });
    const seeded = JSON.parse(
      harness.remoteFiles.get("/home/daytona/.relayfile-mount-creds.json") ?? "null",
    );
    expect(seeded?.mintedAt).toBe(baseNow.toISOString());

    // Within the throttle window: no rewrite.
    vi.mocked(harness.deps.now).mockReturnValue(
      new Date(baseNow.getTime() + 10 * 60_000),
    );
    await readCloudAgentBox(harness.deps, { auth, cloudAgentId, workspaceToken: null });
    const unchanged = JSON.parse(
      harness.remoteFiles.get("/home/daytona/.relayfile-mount-creds.json") ?? "null",
    );
    expect(unchanged?.mintedAt).toBe(baseNow.toISOString());

    // Past TTL/2 (30min): a body-less GET rewrites, scoped to the ACTIVE env
    // mount paths — not the GET's default /workspace scope.
    const later = new Date(baseNow.getTime() + 31 * 60_000);
    vi.mocked(harness.deps.now).mockReturnValue(later);
    await readCloudAgentBox(harness.deps, { auth, cloudAgentId, workspaceToken: null });
    const refreshed = JSON.parse(
      harness.remoteFiles.get("/home/daytona/.relayfile-mount-creds.json") ?? "null",
    );
    expect(refreshed?.mintedAt).toBe(later.toISOString());
    expect(refreshed?.token).toBe("relay_pa_/docs_/workspace");
  });

  it("GET refresh never narrows the creds scope below the PATCHed mount paths (#T15)", async () => {
    const baseNow = new Date("2026-05-21T12:00:00.000Z");
    await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
    });

    await updateCloudAgentBoxMountPaths(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
      mountPaths: ["/workspace", "/integrations/slack"],
    });

    // Past TTL/2 after the PATCH, a body-less GET (the normal poll shape)
    // must keep the creds token scoped to the active custom paths.
    const later = new Date(baseNow.getTime() + 31 * 60_000);
    vi.mocked(harness.deps.now).mockReturnValue(later);
    await readCloudAgentBox(harness.deps, { auth, cloudAgentId, workspaceToken: null });

    const refreshed = JSON.parse(
      harness.remoteFiles.get("/home/daytona/.relayfile-mount-creds.json") ?? "null",
    );
    expect(refreshed?.mintedAt).toBe(later.toISOString());
    expect(refreshed?.token).toBe("relay_pa_/integrations/slack_/workspace");
  });

  it("PATCH rewrites the mount creds file with the fresh token before flushing (#T15)", async () => {
    await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
      mountPaths: ["/workspace"],
    });

    await updateCloudAgentBoxMountPaths(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
      mountPaths: ["/workspace", "/integrations/slack"],
    });

    const creds = JSON.parse(
      harness.remoteFiles.get("/home/daytona/.relayfile-mount-creds.json") ?? "null",
    );
    expect(creds?.token).toBe("relay_pa_/integrations/slack_/workspace");
    // The restarted mount keeps pointing at the creds file.
    expect(harness.deps.startRelayfileMount).toHaveBeenLastCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          credsFilePath: "/home/daytona/.relayfile-mount-creds.json",
        }),
      }),
    );
    // The pre-re-scope flush also carries it so a stale-token flush can heal.
    expect(harness.deps.flushRelayfileMount).toHaveBeenLastCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          credsFilePath: "/home/daytona/.relayfile-mount-creds.json",
        }),
      }),
    );
  });

  it("injects workspaceKey/brokerName verbatim as AGENT_RELAY env vars on warm (#125)", async () => {
    await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
      workspaceKey: "wsk_explicit-workspace",
      brokerName: "cloud-00000000",
    });

    const envFile = JSON.parse(
      harness.remoteFiles.get("/home/daytona/.cloud-agent-box-env.json") ?? "{}",
    );
    expect(envFile.AGENT_RELAY_WORKSPACE_KEY).toBe("wsk_explicit-workspace");
    expect(envFile.AGENT_RELAY_BROKER_NAME).toBe("cloud-00000000");
  });

  it("passes broker instance name to broker launch and keeps workspace key env-only (#125)", async () => {
    mockColdBrokerStart(harness);

    await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
      workspaceKey: "wsk_explicit-workspace",
      brokerName: "cloud-00000000",
    });

    const command = brokerStartCommand(harness);
    expect(command).toContain("'--instance-name' 'cloud-00000000'");
    expect(command).toContain("'--name' 'Claude'");
    expect(command).toContain("export AGENT_RELAY_WORKSPACE_KEY='wsk_explicit-workspace'");
    expect(command).not.toContain("--workspace-key");
  });

  it("omits AGENT_RELAY identity env vars when not provided (#125)", async () => {
    await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
    });

    const envFile = JSON.parse(
      harness.remoteFiles.get("/home/daytona/.cloud-agent-box-env.json") ?? "{}",
    );
    expect(envFile).not.toHaveProperty("AGENT_RELAY_WORKSPACE_KEY");
    expect(envFile).not.toHaveProperty("AGENT_RELAY_BROKER_NAME");
  });

  it("keeps legacy broker launch naming unchanged without brokerName (#125)", async () => {
    mockColdBrokerStart(harness);

    await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
    });

    const command = brokerStartCommand(harness);
    expect(command).toContain("'--name' 'Claude'");
    expect(command).not.toContain("--instance-name");
    expect(command).not.toContain("--workspace-key");
  });

  it("PATCH preserves AGENT_RELAY identity env vars across the env-file rewrite when omitted (#125)", async () => {
    await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
      workspaceKey: "wsk_explicit-workspace",
      brokerName: "cloud-00000000",
    });

    await updateCloudAgentBoxMountPaths(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
      mountPaths: ["/workspace", "/integrations/slack"],
    });

    const envFile = JSON.parse(
      harness.remoteFiles.get("/home/daytona/.cloud-agent-box-env.json") ?? "{}",
    );
    expect(envFile.AGENT_RELAY_WORKSPACE_KEY).toBe("wsk_explicit-workspace");
    expect(envFile.AGENT_RELAY_BROKER_NAME).toBe("cloud-00000000");
    expect(envFile.RELAYFILE_MOUNT_PATHS).toBe(
      JSON.stringify(["/integrations/slack", "/workspace"]),
    );
  });

  it("GET returns the existing box with a freshly minted token", async () => {
    await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
    });

    const response = await readCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
    });

    expect(response).toMatchObject({
      sandboxId: "sbx_1",
      relayfileToken: "relay_pa_/workspace",
      status: "ready",
      phase: "ready",
      etaMs: 0,
    });
  });

  it("warm self-heals a vanished sticky sandbox: re-provisions fresh + re-points the row", async () => {
    // Sticky row points at a Daytona box that was destroyed/evicted out-of-band.
    harness.sandboxRows.set(`${auth.workspaceId}:${cloudAgentId}`, {
      id: "old-deleted-box",
      status: "running",
      brokerPort: 9800,
      error: null,
      expectedReadyBy: null,
    });
    harness.daytona.get.mockRejectedValueOnce(
      new Error("Sandbox with ID or name old-deleted-box not found"),
    );

    const response = await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
    });

    // Did not brick: created a fresh sandbox and returned ready.
    expect(harness.daytona.create).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({ sandboxId: "sbx_1", status: "ready" });
    // The stale sticky row was re-pointed at the fresh sandbox id.
    expect(harness.deps.replaceSandboxId).toHaveBeenCalledWith(
      expect.objectContaining({ oldSandboxId: "old-deleted-box", newSandboxId: "sbx_1" }),
    );
    expect(harness.sandboxRows.get(`${auth.workspaceId}:${cloudAgentId}`)).toMatchObject({
      id: "sbx_1",
      status: "running",
    });
  });

  it("warm still fails (does NOT re-provision) on a non-not-found daytona error", async () => {
    harness.sandboxRows.set(`${auth.workspaceId}:${cloudAgentId}`, {
      id: "sbx_existing",
      status: "running",
      brokerPort: 9800,
      error: null,
      expectedReadyBy: null,
    });
    harness.daytona.get.mockRejectedValueOnce(new Error("internal daytona explosion"));

    await expect(
      warmCloudAgentBox(harness.deps, { auth, cloudAgentId, workspaceToken: null }),
    ).rejects.toThrow("internal daytona explosion");
    // NOT-FOUND-only guard: a generic error must NOT trigger fresh provisioning.
    expect(harness.daytona.create).not.toHaveBeenCalled();
    expect(harness.sandboxRows.get(`${auth.workspaceId}:${cloudAgentId}`)).toMatchObject({
      status: "failed",
    });
  });

  it("GET on an orphaned sticky row (vanished box) returns stopped, not a 503", async () => {
    harness.sandboxRows.set(`${auth.workspaceId}:${cloudAgentId}`, {
      id: "old-deleted-box",
      status: "running",
      brokerPort: 9800,
      error: null,
      expectedReadyBy: null,
    });
    harness.daytona.get.mockRejectedValue(
      new Error("Sandbox with ID or name old-deleted-box not found"),
    );

    const response = await readCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
    });

    expect(response).toMatchObject({ sandboxId: "old-deleted-box", status: "stopped" });
  });

  it("async warm returns warming immediately and completes in the scheduled task", async () => {
    let task: (() => Promise<void>) | undefined;
    vi.mocked(harness.deps.scheduleBackgroundTask).mockImplementationOnce((next) => {
      task = next;
    });

    const started = await startCloudAgentBoxWarm(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
    });

    expect(started.status).toBe(202);
    expect(started.response).toMatchObject({
      status: "warming",
      relayfileToken: "relay_pa_/workspace",
      relayfileMountPath: "/workspace",
      phase: "queued",
      etaMs: 300_000,
    });
    expect(started.response.sandboxId).toMatch(/^boxwarm_/);
    expect(harness.daytona.create).not.toHaveBeenCalled();
    expect(harness.sandboxRows.get(`${auth.workspaceId}:${cloudAgentId}`)).toMatchObject({
      id: started.response.sandboxId,
      status: "warming",
      brokerPort: null,
      error: null,
    });

    const warming = await readCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
    });
    expect(warming).toMatchObject({
      sandboxId: started.response.sandboxId,
      status: "warming",
      phase: "queued",
      etaMs: 300_000,
    });
    expect(harness.daytona.get).not.toHaveBeenCalled();

    await task?.();

    expect(harness.daytona.create).toHaveBeenCalledTimes(1);
    expect(harness.deps.replaceSandboxId).toHaveBeenCalledWith(
      expect.objectContaining({
        oldSandboxId: started.response.sandboxId,
        newSandboxId: "sbx_1",
        status: "warming",
        brokerPort: null,
        error: null,
      }),
    );
    expect(harness.deps.updateSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxId: "sbx_1",
        status: "running",
        brokerPort: 9800,
        error: null,
      }),
    );
    expect(harness.sandboxRows.get(`${auth.workspaceId}:${cloudAgentId}`)).toMatchObject({
      id: "sbx_1",
      status: "running",
      error: null,
    });
  });

  it("async warm restarts a DB-running sandbox that Daytona has stopped", async () => {
    let task: (() => Promise<void>) | undefined;
    vi.mocked(harness.deps.scheduleBackgroundTask).mockImplementationOnce((next) => {
      task = next;
    });
    harness.sandbox.state = "stopped";
    harness.sandboxRows.set(`${auth.workspaceId}:${cloudAgentId}`, {
      id: "sbx_1",
      status: "running",
      brokerPort: 9800,
      error: null,
      expectedReadyBy: null,
    });

    const started = await startCloudAgentBoxWarm(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
    });

    expect(started.status).toBe(202);
    expect(started.response).toMatchObject({
      sandboxId: "sbx_1",
      status: "warming",
      phase: "starting",
      etaMs: 300_000,
    });
    expect(harness.sandboxRows.get(`${auth.workspaceId}:${cloudAgentId}`)).toMatchObject({
      id: "sbx_1",
      status: "warming",
      brokerPort: null,
      error: null,
    });

    await task?.();

    expect(harness.daytona.start).toHaveBeenCalledWith(harness.sandbox, 120);
    expect(harness.sandboxRows.get(`${auth.workspaceId}:${cloudAgentId}`)).toMatchObject({
      id: "sbx_1",
      status: "running",
      brokerPort: 9800,
      error: null,
    });
  });

  it("GET returns failed async warm status without calling Daytona", async () => {
    harness.sandboxRows.set(`${auth.workspaceId}:${cloudAgentId}`, {
      id: "boxwarm_failed",
      status: "failed",
      brokerPort: null,
      error: "broker failed",
      expectedReadyBy: null,
    });

    const response = await readCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
    });

    expect(response).toMatchObject({
      sandboxId: "boxwarm_failed",
      status: "failed",
      error: "broker failed",
      relayfileToken: "relay_pa_/workspace",
    });
    expect(harness.daytona.get).not.toHaveBeenCalled();
  });

  it("GET returns stopped without reading the box env file from a stopped sandbox", async () => {
    // A stopped box has no live sandbox: exec'ing the env-file read inside it
    // throws and was previously masked as a 503. The read must be skipped.
    harness.sandbox.state = "stopped";
    vi.mocked(harness.sandbox.process.executeCommand).mockRejectedValue(
      new Error("Sandbox is not running"),
    );
    harness.sandboxRows.set(`${auth.workspaceId}:${cloudAgentId}`, {
      id: "sbx_1",
      status: "stopped",
      brokerPort: null,
      error: null,
      expectedReadyBy: null,
    });

    const response = await readCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
    });

    expect(response).toMatchObject({
      sandboxId: "sbx_1",
      status: "stopped",
      relayfileToken: "relay_pa_/workspace",
    });
    // The env-file read (and any other in-sandbox exec) must be skipped so the
    // stopped box never throws and 503s.
    expect(harness.sandbox.process.executeCommand).not.toHaveBeenCalled();
  });

  it("GET returns stopping without reading the box env file from a stopping sandbox", async () => {
    harness.sandbox.state = "stopping";
    vi.mocked(harness.sandbox.process.executeCommand).mockRejectedValue(
      new Error("Sandbox is not running"),
    );
    harness.sandboxRows.set(`${auth.workspaceId}:${cloudAgentId}`, {
      id: "sbx_1",
      status: "stopping",
      brokerPort: null,
      error: null,
      expectedReadyBy: null,
    });

    const response = await readCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
    });

    expect(response).toMatchObject({
      sandboxId: "sbx_1",
      status: "stopping",
      relayfileToken: "relay_pa_/workspace",
    });
    expect(harness.sandbox.process.executeCommand).not.toHaveBeenCalled();
  });

  it("GET reports starting for a warming row that already points at a real Daytona sandbox", async () => {
    harness.sandboxRows.set(`${auth.workspaceId}:${cloudAgentId}`, {
      id: "sbx_1",
      status: "warming",
      brokerPort: null,
      error: null,
      expectedReadyBy: new Date("2026-05-21T12:05:00.000Z"),
    });

    const response = await readCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
    });

    expect(response).toMatchObject({
      sandboxId: "sbx_1",
      status: "warming",
      phase: "starting",
      etaMs: 300_000,
    });
  });

  it("GET fails an expired warming row when it already points at a real Daytona sandbox", async () => {
    harness.sandboxRows.set(`${auth.workspaceId}:${cloudAgentId}`, {
      id: "sbx_1",
      status: "warming",
      brokerPort: null,
      error: null,
      expectedReadyBy: new Date("2026-05-21T11:59:00.000Z"),
    });

    const response = await readCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
    });

    expect(response).toMatchObject({
      sandboxId: "sbx_1",
      status: "failed",
      relayfileToken: "relay_pa_/workspace",
      error: "Cloud agent box warm timed out",
    });
    expect(harness.daytona.get).toHaveBeenCalledWith("sbx_1");
    expect(harness.sandboxRows.get(`${auth.workspaceId}:${cloudAgentId}`)).toMatchObject({
      id: "sbx_1",
      status: "failed",
      brokerPort: null,
      error: "Cloud agent box warm timed out",
      expectedReadyBy: null,
    });
  });

  it("GET marks expired warming rows failed so clients stop polling forever", async () => {
    harness.sandboxRows.set(`${auth.workspaceId}:${cloudAgentId}`, {
      id: "boxwarm_expired",
      status: "warming",
      brokerPort: null,
      error: null,
      expectedReadyBy: new Date("2026-05-21T11:59:00.000Z"),
    });

    const response = await readCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
    });

    expect(response).toMatchObject({
      sandboxId: "boxwarm_expired",
      status: "failed",
      error: "Cloud agent box warm timed out",
    });
    expect(harness.sandboxRows.get(`${auth.workspaceId}:${cloudAgentId}`)).toMatchObject({
      status: "failed",
      error: "Cloud agent box warm timed out",
      expectedReadyBy: null,
    });
    expect(harness.daytona.get).not.toHaveBeenCalled();
  });

  it("GET with enforceWarmDeadline:false (queue path) keeps an expired warming row as warming, not timed-out", async () => {
    // #1384: on the queue path the job state + DLQ own failure detection, so the
    // legacy 300s warm-deadline must NOT flip a long-but-progressing warm to failed.
    harness.sandboxRows.set(`${auth.workspaceId}:${cloudAgentId}`, {
      id: "boxwarm_qexpired",
      status: "warming",
      brokerPort: null,
      error: null,
      expectedReadyBy: new Date("2026-05-21T11:59:00.000Z"),
    });

    const response = await readCloudAgentBox(
      harness.deps,
      { auth, cloudAgentId, workspaceToken: null },
      { enforceWarmDeadline: false },
    );

    expect(response).toMatchObject({
      sandboxId: "boxwarm_qexpired",
      status: "warming",
      phase: "queued",
      etaMs: 0,
    });
    expect(response.error).toBeUndefined();
    // The row is NOT mutated to failed (no false timeout on the queue path).
    expect(harness.sandboxRows.get(`${auth.workspaceId}:${cloudAgentId}`)).toMatchObject({
      status: "warming",
      error: null,
    });
    expect(harness.daytona.get).not.toHaveBeenCalled();
  });

  it("DELETE flushes and keeps the box warm until the idle TTL expires", async () => {
    await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
    });

    const response = await stopCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
    });

    expect(response).toEqual({
      sandboxId: "sbx_1",
      status: "stopping",
      keepaliveUntil: "2026-05-21T12:10:00.000Z",
    });
    expect(harness.sandboxRows.get(`${auth.workspaceId}:${cloudAgentId}`)).toMatchObject({
      status: "running",
      keepaliveUntil: new Date("2026-05-21T12:10:00.000Z"),
    });
    expect(harness.credentials.has(cloudAgentId)).toBe(true);
    expect(harness.providerCredentialDeletes).toHaveLength(0);
    expect(harness.daytona.stop).not.toHaveBeenCalled();
    expect(harness.deps.flushRelayfileMount).toHaveBeenCalledWith({
      sandbox: harness.sandbox,
      sandboxHome: "/home/daytona",
      config: {
        baseUrl: "https://relayfile.test",
        workspaceId: auth.workspaceId,
        localDir: "/workspace",
        token: "relay_pa_/workspace",
        interval: "3s",
        paths: ["/workspace"],
        websocket: false,
        credsFilePath: "/home/daytona/.relayfile-mount-creds.json",
      },
    });
    expect(
      vi.mocked(harness.deps.flushRelayfileMount).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(harness.deps.updateSandbox).mock.invocationCallOrder.at(-1)!);
  });

  it("DELETE falls back to immediate Daytona stop when keepalive TTL is disabled", async () => {
    vi.stubEnv("CLOUD_AGENT_KEEPALIVE_TTL_MS", "0");
    await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
    });

    const response = await stopCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
    });

    expect(response).toEqual({ sandboxId: "sbx_1", status: "stopping" });
    expect(harness.daytona.stop).toHaveBeenCalledWith(harness.sandbox);
    expect(harness.sandboxRows.get(`${auth.workspaceId}:${cloudAgentId}`)).toMatchObject({
      status: "stopping",
      keepaliveUntil: null,
    });
  });

  it("reattach within the keepalive window reuses the ready box without re-preparing", async () => {
    await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
    });
    await stopCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
    });
    vi.mocked(harness.deps.mountCliCredentials).mockClear();
    vi.mocked(harness.deps.flushRelayfileMount).mockClear();
    vi.mocked(harness.deps.startRelayfileMount).mockClear();
    harness.daytona.create.mockClear();

    const response = await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
    });

    expect(response).toMatchObject({
      sandboxId: "sbx_1",
      status: "ready",
      apiKey: "api_sbx_1",
    });
    expect(harness.daytona.create).not.toHaveBeenCalled();
    expect(harness.deps.mountCliCredentials).not.toHaveBeenCalled();
    expect(harness.deps.flushRelayfileMount).not.toHaveBeenCalled();
    expect(harness.deps.startRelayfileMount).not.toHaveBeenCalled();
    expect(harness.sandboxRows.get(`${auth.workspaceId}:${cloudAgentId}`)).toMatchObject({
      status: "running",
      keepaliveUntil: null,
    });
  });

  it("reattach with a missing box env file re-prepares instead of assuming mounts still match", async () => {
    await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
    });
    await stopCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
    });
    harness.remoteFiles.clear();
    vi.mocked(harness.deps.mountCliCredentials).mockClear();
    vi.mocked(harness.deps.startRelayfileMount).mockClear();

    const response = await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
      mountPaths: ["/docs"],
    });

    expect(response).toMatchObject({
      sandboxId: "sbx_1",
      status: "ready",
      relayfileMountPath: "/docs",
    });
    expect(harness.deps.mountCliCredentials).toHaveBeenCalled();
    expect(harness.deps.startRelayfileMount).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          paths: ["/docs"],
        }),
      }),
    );
    expect(harness.sandboxRows.get(`${auth.workspaceId}:${cloudAgentId}`)).toMatchObject({
      status: "running",
      keepaliveUntil: null,
    });
  });

  it("reattach with a different git workspace source re-prepares the kept-alive box", async () => {
    await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
      workspaceSource: {
        kind: "git-overlay",
        remoteUrl: "https://github.com/acme/old-repo.git",
        ref: "main",
        targetDir: "/workspace",
      },
    });
    await stopCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
    });
    vi.mocked(harness.deps.startRelayfileMount).mockClear();
    vi.mocked(harness.deps.resolveGitCloneCredentials).mockClear();

    const response = await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
      workspaceSource: {
        kind: "git-overlay",
        remoteUrl: "https://github.com/acme/new-repo.git",
        ref: "main",
        targetDir: "/workspace",
      },
    });

    expect(response).toMatchObject({
      sandboxId: "sbx_1",
      status: "ready",
      relayfileMountPath: "/workspace",
    });
    expect(harness.deps.resolveGitCloneCredentials).toHaveBeenCalledWith({
      userId: auth.userId,
      workspaceId: auth.workspaceId,
      remoteUrl: "https://github.com/acme/new-repo.git",
    });
    expect(harness.deps.startRelayfileMount).toHaveBeenCalled();
  });

  it("gracefully continues if relayfile mount flush fails on stop", async () => {
    const warn = vi.spyOn(logger, "warn").mockResolvedValue(undefined);
    await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
    });
    vi.mocked(harness.deps.flushRelayfileMount).mockRejectedValueOnce(new Error("sync failed"));

    const response = await stopCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
    });

    expect(response).toMatchObject({ sandboxId: "sbx_1", status: "stopping" });
    expect(harness.daytona.stop).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[cloud-agent-box] relayfile mount flush on stop failed; continuing",
      expect.objectContaining({
        area: "cloud-agent-box",
        workspaceId: auth.workspaceId,
        cloudAgentId,
        sandboxId: "sbx_1",
        error: "sync failed",
      }),
    );
  });

  it("DELETE flushes the active custom mount paths from the sandbox env file", async () => {
    await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
      mountPaths: ["/integrations/slack", "/workspace"],
    });

    await stopCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
    });

    expect(harness.deps.flushRelayfileMount).toHaveBeenCalledWith({
      sandbox: harness.sandbox,
      sandboxHome: "/home/daytona",
      config: {
        baseUrl: "https://relayfile.test",
        workspaceId: auth.workspaceId,
        localDir: "/workspace",
        token: "relay_pa_/integrations/slack_/workspace",
        interval: "3s",
        paths: ["/integrations/slack", "/workspace"],
        websocket: false,
        credsFilePath: "/home/daytona/.relayfile-mount-creds.json",
      },
    });
  });

  it("DELETE fallback flush carries the mount creds file when the sandbox env file is missing", async () => {
    await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
    });
    harness.remoteFiles.delete("/home/daytona/.cloud-agent-box-env.json");
    vi.mocked(harness.deps.flushRelayfileMount).mockClear();

    await stopCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
    });

    expect(harness.deps.flushRelayfileMount).toHaveBeenCalledWith({
      sandbox: harness.sandbox,
      sandboxHome: "/home/daytona",
      config: {
        baseUrl: "https://relayfile.test",
        workspaceId: auth.workspaceId,
        localDir: "/workspace",
        token: "relay_pa_/workspace",
        interval: "3s",
        paths: ["/workspace"],
        websocket: false,
        credsFilePath: "/home/daytona/.relayfile-mount-creds.json",
      },
    });
  });

  it("DELETE returns 404 when no box exists", async () => {
    await expect(
      stopCloudAgentBox(harness.deps, {
        auth,
        cloudAgentId,
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: "box_not_found",
    });
  });

  it("reaps expired keepalive boxes by stopping Daytona and clearing the idle deadline", async () => {
    harness.sandboxRows.set(`${auth.workspaceId}:${cloudAgentId}`, {
      id: "sbx_1",
      status: "running",
      brokerPort: 9800,
      error: null,
      expectedReadyBy: null,
      keepaliveUntil: new Date("2026-05-21T11:59:00.000Z"),
    });

    const result = await reapExpiredCloudAgentBoxKeepalives(harness.deps);

    expect(result).toEqual({
      found: 1,
      stopped: 1,
      vanished: 0,
      failed: [],
    });
    expect(harness.daytona.stop).toHaveBeenCalledWith(harness.sandbox);
    expect(harness.sandboxRows.get(`${auth.workspaceId}:${cloudAgentId}`)).toMatchObject({
      status: "stopping",
      keepaliveUntil: null,
    });
  });

  it("reaper skips an expired row that was reattached before the lock", async () => {
    const key = `${auth.workspaceId}:${cloudAgentId}`;
    harness.sandboxRows.set(key, {
      id: "sbx_1",
      status: "running",
      brokerPort: 9800,
      error: null,
      expectedReadyBy: null,
      keepaliveUntil: new Date("2026-05-21T11:59:00.000Z"),
    });
    vi.mocked(harness.deps.listExpiredKeepaliveSandboxes).mockImplementationOnce(async () => {
      const rows = [{
        id: "sbx_1",
        workspaceId: auth.workspaceId,
        cloudAgentId,
        keepaliveUntil: new Date("2026-05-21T11:59:00.000Z"),
      }];
      harness.sandboxRows.set(key, {
        ...harness.sandboxRows.get(key)!,
        keepaliveUntil: null,
      });
      return rows;
    });

    const result = await reapExpiredCloudAgentBoxKeepalives(harness.deps);

    expect(result).toEqual({
      found: 1,
      stopped: 0,
      vanished: 0,
      failed: [],
    });
    expect(harness.daytona.stop).not.toHaveBeenCalled();
    expect(harness.deps.withCloudAgentBoxLock).toHaveBeenCalledWith(
      {
        workspaceId: auth.workspaceId,
        cloudAgentId,
      },
      expect.any(Function),
    );
    expect(harness.sandboxRows.get(key)).toMatchObject({
      status: "running",
      keepaliveUntil: null,
    });
  });

  it("reaper marks vanished keepalive boxes stopped without failing the sweep", async () => {
    harness.sandboxRows.set(`${auth.workspaceId}:${cloudAgentId}`, {
      id: "sbx_missing",
      status: "running",
      brokerPort: 9800,
      error: null,
      expectedReadyBy: null,
      keepaliveUntil: new Date("2026-05-21T11:59:00.000Z"),
    });
    harness.daytona.get.mockRejectedValueOnce(new Error("Sandbox sbx_missing not found"));

    const result = await reapExpiredCloudAgentBoxKeepalives(harness.deps);

    expect(result).toEqual({
      found: 1,
      stopped: 0,
      vanished: 1,
      failed: [],
    });
    expect(harness.sandboxRows.get(`${auth.workspaceId}:${cloudAgentId}`)).toMatchObject({
      status: "stopped",
      brokerPort: null,
      keepaliveUntil: null,
    });
  });
});

describe("buildStickySandboxName", () => {
  it("suffixes the display name with a stable, dash-stripped cloudAgentId slice", () => {
    expect(
      buildStickySandboxName({
        displayName: "Anthropic",
        cloudAgentId: "abcd1234-5678-90ab-cdef-1234567890ab",
      }),
    ).toBe("Anthropic-abcd1234");
  });

  it("produces distinct names for cloud agents that share a display name", () => {
    const a = buildStickySandboxName({
      displayName: "Anthropic",
      cloudAgentId: "11111111-1111-1111-1111-111111111111",
    });
    const b = buildStickySandboxName({
      displayName: "Anthropic",
      cloudAgentId: "22222222-2222-2222-2222-222222222222",
    });
    expect(a).not.toBe(b);
  });

  it("sanitizes non-alphanumeric characters into single hyphens for DNS-safe names", () => {
    expect(
      buildStickySandboxName({
        displayName: "My Custom Agent! (prod)",
        cloudAgentId: "abcd1234-5678-90ab-cdef-1234567890ab",
      }),
    ).toBe("My-Custom-Agent-prod-abcd1234");
  });

  it("stays within Daytona's name limit and tolerates a blank display name", () => {
    const long = buildStickySandboxName({
      displayName: "x".repeat(200),
      cloudAgentId: "abcd1234-5678-90ab-cdef-1234567890ab",
    });
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long.endsWith("-abcd1234")).toBe(true);

    // A display name with no usable characters falls back to a stable base.
    expect(
      buildStickySandboxName({
        displayName: " !!! ",
        cloudAgentId: "abcd1234-5678-90ab-cdef-1234567890ab",
      }),
    ).toBe("cloud-agent-abcd1234");
  });
});

describe("cloud agent box relayfile mount helpers", () => {
  const mountConfig = {
    baseUrl: "https://relayfile.test",
    workspaceId: auth.workspaceId,
    localDir: "/workspace",
    token: "relay_pa_/docs_/workspace",
    paths: ["/docs", "/workspace"],
  };

  function createSandbox() {
    return {
      id: "sbx_mount",
      process: {
        executeCommand: vi.fn(async (command: string) => {
          if (command.includes("nohup relayfile-mount")) {
            return { exitCode: 0, result: "12345\n" };
          }
          // Status probe for the detached initial sync — report success so
          // the orchestrator's poll loop completes.
          if (command.includes("relayfile-initial-sync-exit:")) {
            return { exitCode: 0, result: "relayfile-initial-sync-exit:0\n" };
          }
          return { exitCode: 0, result: "ok\n" };
        }),
      },
      fs: {
        uploadFile: vi.fn(async () => undefined),
      },
    };
  }

  it("starts through SandboxOrchestrator while preserving box warm-restart stale-daemon cleanup", async () => {
    const sandbox = createSandbox();
    const deps = defaultCloudAgentBoxDeps();

    await expect(
      deps.startRelayfileMount({
        sandbox,
        sandboxHome: "/home/daytona",
        config: mountConfig,
      }),
    ).resolves.toEqual({ pid: "12345" });

    const calls = sandbox.process.executeCommand.mock.calls;
    expect(calls[0]).toEqual(["mkdir -p '/workspace'", "/home/daytona", undefined, undefined]);
    expect(calls[1]).toEqual([
      "pkill -f '(^|/)relayfile-mount( |$)' 2>/dev/null || true",
      "/home/daytona",
      undefined,
      undefined,
    ]);
    expect(calls[2]?.[0]).toContain("nohup relayfile-mount");
    expect(calls[2]?.[0]).toContain("--base-url 'https://relayfile.test'");
    expect(calls[2]?.[0]).toContain("--token 'relay_pa_/docs_/workspace'");
    // Continuous sync is scoped to the requested remote roots so the daemon
    // never pulls a full workspace export (relayfile #206 / cloud #1029).
    expect(calls[2]?.[0]).toContain("--remote-path '/docs'");
    expect(calls[2]?.[0]).toContain("--remote-path '/workspace'");
    // The initial sync launches detached (heredoc script + nohup) so it can
    // outlive a single Daytona exec; the orchestrator then polls the exit
    // sentinel with short execs instead of blocking one exec on the sync.
    expect(calls[3]?.[0]).toContain("relayfile-mount --once");
    expect(calls[3]?.[0]).toContain("--remote-path '/docs'");
    expect(calls[3]?.[0]).toContain("--remote-path '/workspace'");
    expect(calls[3]?.[0]).toContain("RELAYFILE_INITIAL_SYNC_EOF");
    expect(calls[3]).toEqual([
      expect.stringContaining("relayfile-mount --once"),
      "/home/daytona",
      undefined,
      undefined,
    ]);
    expect(calls[4]?.[0]).toContain("relayfile-initial-sync-exit:");
  });

  it("flushes through SandboxOrchestrator with bounded timeout and path-scoped token only", async () => {
    const sandbox = createSandbox();
    const deps = defaultCloudAgentBoxDeps();

    await deps.flushRelayfileMount({
      sandbox,
      sandboxHome: "/home/daytona",
      config: mountConfig,
    });

    expect(sandbox.process.executeCommand).toHaveBeenCalledTimes(1);
    expect(sandbox.process.executeCommand).toHaveBeenCalledWith(
      expect.stringContaining("relayfile-mount --once"),
      "/home/daytona",
      undefined,
      120,
    );
    const command = sandbox.process.executeCommand.mock.calls[0]?.[0] ?? "";
    expect(command).toContain("--base-url 'https://relayfile.test'");
    expect(command).toContain("--workspace '00000000-0000-0000-0000-000000000002'");
    expect(command).toContain("--local-dir '/'");
    expect(command).toContain("--token 'relay_pa_/docs_/workspace'");
    // Flush mirrors the scoped roots so writeback stays bounded to the mount
    // scopes rather than the whole workspace (cloud #1029).
    expect(command).toContain("--remote-path '/docs'");
    expect(command).toContain("--remote-path '/workspace'");
  });

  it("preserves split-artifact stderr before crossing into SandboxOrchestrator", async () => {
    const sandbox = createSandbox();
    const deps = defaultCloudAgentBoxDeps();
    sandbox.process.executeCommand.mockResolvedValueOnce({
      exitCode: 1,
      artifacts: {
        stdout: "stdout-only",
        stderr: "stderr-only",
      },
    } as never);

    await expect(
      deps.flushRelayfileMount({
        sandbox,
        sandboxHome: "/home/daytona",
        config: mountConfig,
      }),
    ).rejects.toThrow("Failed to flush relayfile mount: stdout-only\nstderr-only");
  });

  it("fail-fast outlives an explicit exec timeout before aborting a hung exec", async () => {
    vi.useFakeTimers();
    vi.stubEnv("CLOUD_AGENT_DAYTONA_EXEC_FAIL_FAST_MS", "1000");
    const sandbox = createSandbox();
    const deps = defaultCloudAgentBoxDeps();
    sandbox.process.executeCommand.mockImplementation(
      () => new Promise<never>(() => undefined),
    );

    const flushPromise = deps.flushRelayfileMount({
      sandbox,
      sandboxHome: "/home/daytona",
      config: mountConfig,
    });
    let settled = false;
    const observedError = flushPromise.catch((error) => {
      settled = true;
      return error;
    });

    await flushMicrotasks();
    expect(sandbox.process.executeCommand).toHaveBeenCalledTimes(1);

    // Flush passes an explicit 120s server-side exec timeout. The client
    // fail-fast must not undercut it (that killed legitimately long initial
    // syncs at the 45s default) — it aborts only after timeout + margin.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);

    const error = await observedError;
    expect(error).toBeInstanceOf(CloudAgentBoxError);
    expect(error).toMatchObject({
      code: "daytona_exec_timeout",
      status: 504,
    });
    expect(error.message).toContain("Daytona exec relayfile-mount exceeded 135s client timeout");
  });

  it("fail-fast still bounds execs that have no explicit timeout", async () => {
    vi.useFakeTimers();
    vi.stubEnv("CLOUD_AGENT_DAYTONA_EXEC_FAIL_FAST_MS", "1000");
    const sandbox = createSandbox();
    const deps = defaultCloudAgentBoxDeps();
    sandbox.process.executeCommand.mockImplementation(
      () => new Promise<never>(() => undefined),
    );

    // startRelayfileMount's first exec (mkdir) carries no explicit timeout, so
    // the env fail-fast applies as-is.
    const startPromise = deps.startRelayfileMount({
      sandbox,
      sandboxHome: "/home/daytona",
      config: mountConfig,
    });
    const observedError = startPromise.catch((error) => error);

    await flushMicrotasks();
    expect(sandbox.process.executeCommand).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);

    const error = await observedError;
    expect(error).toBeInstanceOf(CloudAgentBoxError);
    expect(error).toMatchObject({
      code: "daytona_exec_timeout",
      status: 504,
    });
    expect(error.message).toContain("Daytona exec relayfile-mount exceeded 1s client timeout");
  });
});

describe("warm step extraction (issue #1384 slice 1)", () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetBoxMountCredsThrottleForTesting();
    harness = createHarness();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const gitInput = {
    auth,
    cloudAgentId,
    workspaceToken: null as string | null,
    mountPaths: ["/integrations/github"],
    workspaceSource: {
      kind: "git" as const,
      remoteUrl: "https://github.com/acme/repo.git",
      ref: "main",
    },
  };
  const overlayInput = {
    auth,
    cloudAgentId,
    workspaceToken: null as string | null,
    mountPaths: ["/integrations/github"],
    workspaceSource: {
      kind: "git-overlay" as const,
      remoteUrl: "https://github.com/acme/repo.git",
      ref: "main",
    },
  };
  const plainInput = { auth, cloudAgentId, workspaceToken: null as string | null };
  const sampleEnv = {
    RELAYFILE_URL: "https://relayfile.test",
    RELAYFILE_WORKSPACE_ID: auth.workspaceId,
    RELAYFILE_TOKEN: "relay_pa_/workspace",
    RELAY_AGENT_NAME: "Claude",
  };

  // ensure-sandbox helper -------------------------------------------------
  it("ensureSandboxStarted starts a stopped sandbox and is idempotent", async () => {
    const daytona = harness.deps.createDaytonaClient();
    harness.sandbox.state = "stopped";
    await ensureSandboxStarted(daytona, harness.sandbox);
    await ensureSandboxStarted(daytona, harness.sandbox);
    // Rerun does not throw; start is invoked each time the box reports stopped.
    expect(harness.daytona.start).toHaveBeenCalledWith(harness.sandbox, 120);
    expect(harness.daytona.start).toHaveBeenCalledTimes(2);
  });

  it("ensureSandboxStarted is a no-op when the sandbox is already started", async () => {
    const daytona = harness.deps.createDaytonaClient();
    harness.sandbox.state = "started";
    await ensureSandboxStarted(daytona, harness.sandbox, "running");
    await ensureSandboxStarted(daytona, harness.sandbox, "running");
    expect(harness.daytona.start).not.toHaveBeenCalled();
  });

  // ensure-sandbox --------------------------------------------------------
  it("createOrAdoptStickySandbox returns a created sandbox and reruns without throwing", async () => {
    const daytona = harness.deps.createDaytonaClient();
    const credential = connectedCredential();
    const first = await createOrAdoptStickySandbox(harness.deps, daytona, plainInput, credential, sampleEnv);
    const second = await createOrAdoptStickySandbox(harness.deps, daytona, plainInput, credential, sampleEnv);
    // A fresh create is rollback-eligible (createdSandboxId is the new id);
    // rerunning the step does not throw.
    expect(first.createdSandboxId).toBeTruthy();
    expect(second.createdSandboxId).toBeTruthy();
  });

  it("createOrAdoptStickySandbox uses the full snapshot for CLI-backed credentials", async () => {
    const daytona = harness.deps.createDaytonaClient();
    await createOrAdoptStickySandbox(harness.deps, daytona, plainInput, connectedCredential(), sampleEnv);

    expect(harness.deps.getSnapshotName).toHaveBeenCalledTimes(1);
    expect(harness.deps.getLiteSnapshotName).not.toHaveBeenCalled();
    expect(harness.daytona.create).toHaveBeenCalledWith(
      expect.objectContaining({ snapshot: "snapshot-test" }),
      { timeout: 120 },
    );
  });

  it("createOrAdoptStickySandbox uses the lite snapshot for ctx.llm-only BYOK credentials", async () => {
    const daytona = harness.deps.createDaytonaClient();
    const credential = connectedCredential({ authType: "byo_api_key" });
    await createOrAdoptStickySandbox(harness.deps, daytona, plainInput, credential, sampleEnv);

    expect(harness.deps.getSnapshotName).not.toHaveBeenCalled();
    expect(harness.deps.getLiteSnapshotName).toHaveBeenCalledTimes(1);
    expect(harness.daytona.create).toHaveBeenCalledWith(
      expect.objectContaining({ snapshot: "snapshot-lite-test" }),
      { timeout: 120 },
    );
  });

  it("createOrAdoptStickySandbox adopts the existing box on a name conflict (createdSandboxId null)", async () => {
    const daytona = harness.deps.createDaytonaClient();
    const credential = connectedCredential();
    harness.daytona.create.mockRejectedValueOnce(
      new Error("sandbox with name cloud-agent-claude already exists"),
    );
    const adopted = await createOrAdoptStickySandbox(harness.deps, daytona, plainInput, credential, sampleEnv);
    expect(adopted.sandbox.id).toBeTruthy();
    expect(adopted.createdSandboxId).toBeNull();
  });

  // mount-credentials -----------------------------------------------------
  it("mountBoxCredentials mounts CLI credentials and is idempotent", async () => {
    const credential = connectedCredential();
    await mountBoxCredentials(harness.deps, harness.sandbox, "/home/daytona", credential, "secret");
    await mountBoxCredentials(harness.deps, harness.sandbox, "/home/daytona", credential, "secret");
    expect(harness.deps.mountCliCredentials).toHaveBeenCalledTimes(2);
  });

  it("mountBoxCredentials is a no-op for byo_api_key credentials", async () => {
    const credential = connectedCredential({ authType: "byo_api_key" });
    await mountBoxCredentials(harness.deps, harness.sandbox, "/home/daytona", credential, "secret");
    await mountBoxCredentials(harness.deps, harness.sandbox, "/home/daytona", credential, "secret");
    expect(harness.deps.mountCliCredentials).not.toHaveBeenCalled();
  });

  // flush-relayfile -------------------------------------------------------
  it("flushBoxRelayfileMount is idempotent and swallows flush failures", async () => {
    const credential = connectedCredential();
    await flushBoxRelayfileMount(harness.deps, harness.sandbox, "/home/daytona", plainInput, credential);
    vi.mocked(harness.deps.flushRelayfileMount).mockRejectedValueOnce(new Error("flush boom"));
    // Best-effort: a failing flush must not throw out of the step.
    await expect(
      flushBoxRelayfileMount(harness.deps, harness.sandbox, "/home/daytona", plainInput, credential),
    ).resolves.toBeUndefined();
  });

  // sync-git --------------------------------------------------------------
  it("syncBoxGitWorkspace clones a git source and is idempotent", async () => {
    await syncBoxGitWorkspace(harness.deps, gitInput, harness.sandbox, "/home/daytona");
    await syncBoxGitWorkspace(harness.deps, gitInput, harness.sandbox, "/home/daytona");
    const gitCalls = vi.mocked(harness.sandbox.process.executeCommand).mock.calls.filter(
      ([command]) => command.includes("git clone") || command.includes("git -C"),
    );
    expect(gitCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("syncBoxGitWorkspace is a no-op when there is no git source", async () => {
    await syncBoxGitWorkspace(harness.deps, plainInput, harness.sandbox, "/home/daytona");
    expect(harness.deps.resolveGitCloneCredentials).not.toHaveBeenCalled();
  });

  // prepare-git-overlay-roots --------------------------------------------
  // Fires only for a direct-git source (kind "git"); see
  // isDirectGitWorkspaceSource. git-overlay and relayfile sources are no-ops.
  it("prepareBoxGitOverlayRoots creates mount roots for a direct-git source and is idempotent", async () => {
    await prepareBoxGitOverlayRoots(gitInput, harness.sandbox, "/home/daytona", ["/integrations/github"]);
    await expect(
      prepareBoxGitOverlayRoots(gitInput, harness.sandbox, "/home/daytona", ["/integrations/github"]),
    ).resolves.toBeUndefined();
    const mkdirCalls = vi.mocked(harness.sandbox.process.executeCommand).mock.calls.filter(
      ([command]) => command.includes("mkdir -p"),
    );
    expect(mkdirCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("prepareBoxGitOverlayRoots is a no-op for git-overlay and relayfile sources", async () => {
    await prepareBoxGitOverlayRoots(overlayInput, harness.sandbox, "/home/daytona", ["/integrations/github"]);
    await prepareBoxGitOverlayRoots(plainInput, harness.sandbox, "/home/daytona", ["/workspace"]);
    expect(harness.sandbox.process.executeCommand).not.toHaveBeenCalled();
  });

  // start-relayfile-mount -------------------------------------------------
  it("startBoxRelayfileMount starts the mount and is idempotent", async () => {
    const credential = connectedCredential();
    await startBoxRelayfileMount(harness.deps, plainInput, harness.sandbox, "/home/daytona", credential, sampleEnv, ["/workspace"]);
    await startBoxRelayfileMount(harness.deps, plainInput, harness.sandbox, "/home/daytona", credential, sampleEnv, ["/workspace"]);
    expect(harness.deps.startRelayfileMount).toHaveBeenCalledTimes(2);
  });

  it("startBoxRelayfileMount rethrows for git sources but swallows otherwise", async () => {
    const credential = connectedCredential();
    vi.mocked(harness.deps.startRelayfileMount).mockRejectedValue(new Error("mount boom"));
    await expect(
      startBoxRelayfileMount(harness.deps, gitInput, harness.sandbox, "/home/daytona", credential, sampleEnv, ["/integrations/github"]),
    ).rejects.toThrow("mount boom");
    // No git source: failure is logged and swallowed (continue without FUSE).
    await expect(
      startBoxRelayfileMount(harness.deps, plainInput, harness.sandbox, "/home/daytona", credential, sampleEnv, ["/workspace"]),
    ).resolves.toBeUndefined();
  });

  it("retries ensureBrokerReady when a fail-fast exec timeout fires before Daytona's proxy timeout", async () => {
    vi.useFakeTimers();
    vi.stubEnv("CLOUD_AGENT_DAYTONA_EXEC_FAIL_FAST_MS", "1000");
    let calls = 0;
    vi.mocked(harness.sandbox.process.executeCommand).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return new Promise<never>(() => undefined);
      }
      return { exitCode: 0, result: "ok\n" };
    });

    const readyPromise = ensureBrokerReady(
      harness.sandbox,
      "/home/daytona",
      { RELAY_AGENT_NAME: "Claude" },
      "api_sbx_1",
    );

    await flushMicrotasks();
    expect(harness.sandbox.process.executeCommand).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(harness.sandbox.process.executeCommand).toHaveBeenCalledTimes(1);

    await runNextRetryTimer();
    await flushMicrotasks();
    expect(harness.sandbox.process.executeCommand).toHaveBeenCalledTimes(2);
    await expect(readyPromise).resolves.toBeUndefined();
  });

  // finalize --------------------------------------------------------------
  it("finalizeBoxConnection produces an identical ready response on rerun", async () => {
    const apiKey = "api_sbx_1";
    const first = await finalizeBoxConnection(harness.sandbox, apiKey, "relay_pa_/workspace", ["/workspace"], undefined);
    const second = await finalizeBoxConnection(harness.sandbox, apiKey, "relay_pa_/workspace", ["/workspace"], undefined);
    expect(first).toEqual(second);
    expect(first.status).toBe("running");
    expect(first.response).toMatchObject({ status: "ready", relayfileToken: "relay_pa_/workspace" });
  });

  // full sequential warm --------------------------------------------------
  it("the full sequential warm produces an identical ready result when rerun", async () => {
    const firstWarm = await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
      mountPaths: ["/workspace"],
    });
    const secondWarm = await warmCloudAgentBox(harness.deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
      mountPaths: ["/workspace"],
    });
    expect(firstWarm).toEqual(secondWarm);
    expect(secondWarm).toMatchObject({
      sandboxId: "sbx_1",
      status: "ready",
      relayfileToken: "relay_pa_/workspace",
      execUrl: "https://sbx-1.daytona.test",
      apiKey: "api_sbx_1",
    });
  });
});
