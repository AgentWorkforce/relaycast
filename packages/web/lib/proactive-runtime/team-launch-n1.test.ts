import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRelayfileConfig: vi.fn(),
  mintWorkspacePathScopedRelayfileToken: vi.fn(),
  tryResourceValue: vi.fn(),
  buildCloudApiWorkflowStorageCredentials: vi.fn(),
  buildCredentialBundle: vi.fn(),
  createApiTokenSession: vi.fn(),
  ensureRelayWorkspace: vi.fn(),
  getCliCredentials: vi.fn(),
  getWorkflowStorageBackend: vi.fn(),
  isWorkerRuntime: vi.fn(),
  mintScopedS3Credentials: vi.fn(),
  readBoundRelayWorkspaceId: vi.fn(),
  resolveOrProvisionRelayWorkspace: vi.fn(),
  resolveRelaycastUrl: vi.fn(),
  resolveServerDaytonaAuthParams: vi.fn(),
  mintWorkflowGithubWriteToken: vi.fn(),
  getCloudflareContext: vi.fn(),
  loggerWarn: vi.fn(),
  loggerInfo: vi.fn(),
}));

vi.mock("sst", () => ({
  Resource: {
    CredentialEncryptionKey: { value: "credential-encryption-key" },
    WorkflowStorage: { bucketName: "workflow-storage-bucket", stsRoleArn: "workflow-storage-role" },
  },
}));

vi.mock("@/lib/relayfile", () => ({
  resolveRelayfileConfig: mocks.resolveRelayfileConfig,
}));

vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  tryResourceValue: mocks.tryResourceValue,
}));

vi.mock("@cloud/core/relayfile/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cloud/core/relayfile/client.js")>()),
  mintWorkspacePathScopedRelayfileToken: mocks.mintWorkspacePathScopedRelayfileToken,
}));

vi.mock("@/lib/auth/api-token-store", () => ({
  createApiTokenSession: mocks.createApiTokenSession,
}));

vi.mock("@/lib/aws/runtime", () => ({
  isWorkerRuntime: mocks.isWorkerRuntime,
}));

vi.mock("@/lib/aws/sts-credentials", () => ({
  mintScopedS3Credentials: mocks.mintScopedS3Credentials,
}));

vi.mock("@/lib/daytona-auth", () => ({
  resolveServerDaytonaAuthParams: mocks.resolveServerDaytonaAuthParams,
}));

vi.mock("@/lib/relay-workspaces", () => ({
  ensureRelayWorkspace: mocks.ensureRelayWorkspace,
}));

vi.mock("@/lib/storage", () => ({
  buildCloudApiWorkflowStorageCredentials: mocks.buildCloudApiWorkflowStorageCredentials,
  getWorkflowStorageBackend: mocks.getWorkflowStorageBackend,
}));

vi.mock("@cloud/core/auth/credentials.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cloud/core/auth/credentials.js")>()),
  buildCredentialBundle: mocks.buildCredentialBundle,
}));

vi.mock("@cloud/core/auth/cli-credentials.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cloud/core/auth/cli-credentials.js")>()),
  getCliCredentials: mocks.getCliCredentials,
}));

vi.mock("@/lib/workflows/relay-workspace", () => ({
  resolveOrProvisionRelayWorkspace: mocks.resolveOrProvisionRelayWorkspace,
}));

vi.mock("@/lib/workspaces/relay-workspace-binding", () => ({
  readBoundRelayWorkspaceId: mocks.readBoundRelayWorkspaceId,
}));

vi.mock("@/lib/workspace-registry", () => ({
  resolveRelaycastUrl: mocks.resolveRelaycastUrl,
}));

vi.mock("@/lib/cloudflare-context", () => ({
  getCloudflareContext: mocks.getCloudflareContext,
}));

vi.mock("@/lib/integrations/github-workflow-write-token", () => ({
  mintWorkflowGithubWriteToken: mocks.mintWorkflowGithubWriteToken,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    warn: mocks.loggerWarn,
    info: mocks.loggerInfo,
  },
}));

import { scopesFromRelayfileAccessToken } from "@cloud/core/bootstrap/launch-member.js";
import {
  memberWritePath,
  pathScope,
  readPathScope,
} from "@cloud/core/proactive-runtime/member-token-scope.js";
import {
  assertExactSingleWriteScope,
  assertTeamLaunchN1ReadSurface,
  buildLegacyTeamLaunchPayload,
  buildTeamLaunchPayload,
  buildTeamLaunchMemberOptions,
  deriveGithubIssueAssignedRoot,
  dispatchTeamLaunchN1,
  isTeamLaunchN1Enabled,
  memberLocalRootForAssignedRoot,
  mintDirectMemberRelayfileToken,
} from "./team-launch-n1";
import type { TeamLaunchMemberOptions } from "./team-launch-n1";

function credentialBundle() {
  return {
    s3Credentials: {
      accessKeyId: "ak",
      secretAccessKey: "sk",
      sessionToken: "st",
      bucket: "bucket",
      prefix: "prefix",
    },
    cliCredentials: "",
    workspaceId: "rw_workspace",
    relayApiKey: "relaycast_api_key",
    relayBaseUrl: "https://api.relaycast.dev",
    runId: "run-1",
    userId: "user-1",
  };
}

function relayPaToken(scopes: string[], ttlSeconds = 120): string {
  const now = 1_800_000_000;
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    scopes,
    iat: now,
    exp: now + ttlSeconds,
  })).toString("base64url");
  return `relay_pa_${header}.${payload}.signature`;
}

function payload(label = "team") {
  return {
    id: "delivery-1",
    type: "github.issues.labeled",
    eventType: "issues.labeled",
    provider: "github",
    workspaceId: "workspace-1",
    deliveryId: "delivery-1",
    paths: ["/github/repos/AgentWorkforce/cloud/issues/123.json"],
    resource: {
      label: { name: label },
      issue: { number: 123 },
      repository: { full_name: "AgentWorkforce/cloud" },
    },
  };
}

function payloadWithLaunch() {
  return {
    ...payload(),
    launchMember: {
      credentialBundle: credentialBundle(),
      workflowFileContent: "export default async function main() { return {}; }",
      workflowFileName: "member.ts",
    },
  };
}

async function buildDefaultLaunchPayloadForTest(input?: {
  deliveryId?: string;
}) {
  const deliveryId = input?.deliveryId ??
    "integration-watch:workspace-1:github:issues.labeled:event-1:/github/repos/AgentWorkforce/cloud/issues/123__team/meta.json";
  const launchPayload = await buildLegacyTeamLaunchPayload({
    workspaceId: "workspace-1",
    agentId: "agent-1",
    deliveryId,
    payload: {
      ...payload(),
      id: deliveryId,
      deliveryId,
    },
    deployedByUserId: "user-1",
    organizationId: "org-1",
    appOrigin: "https://cloud.example",
  });
  const launchMember = launchPayload.launchMember as {
    runId: string;
    credentialBundle: ReturnType<typeof credentialBundle>;
    envSecrets?: Record<string, string>;
  };
  return { deliveryId, launchMember, launchPayload };
}

function launchOptions(input: {
  assignedRoot: string;
  localRoot: string;
  relayAuthApiKey?: string;
}): TeamLaunchMemberOptions {
  return {
    memberName: "cloud-team-issue-n1",
    role: "implementer",
    channel: "team-launch-n1-agent",
    assignedRoot: input.assignedRoot,
    localRoot: input.localRoot,
    workspaceId: "rw_workspace",
    relayfileUrl: "https://relayfile.example",
    relayAuthUrl: "https://relayauth.example",
    relayAuthApiKey: input.relayAuthApiKey ?? "org-api-key",
    runId: "run-1",
    harness: "claude",
    model: "claude-sonnet-4-6",
    credentialBundle: credentialBundle(),
    fileType: "typescript",
    workflowFileContent: "export default async function main() { return {}; }",
    workflowFileName: "member.ts",
  };
}

const ORIGINAL_ENV = { ...process.env };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

describe("team-launch-n1 adapter", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.CLOUD_TEAM_LAUNCH_N1_ENABLED;
    delete process.env.TEAM_LAUNCH_N1_TEST_MODE;
    vi.clearAllMocks();
    mocks.tryResourceValue.mockReturnValue(undefined);
    mocks.buildCloudApiWorkflowStorageCredentials.mockImplementation((input: {
      userId: string;
      runId: string;
      apiUrl: string;
      accessToken: string;
      refreshToken?: string;
    }) => ({
      backend: "cloud-api",
      accessKeyId: "cloud-api",
      secretAccessKey: "cloud-api",
      sessionToken: input.accessToken,
      bucket: "workflow-storage-r2",
      prefix: `${input.userId}/${input.runId}`,
      cloudApiUrl: input.apiUrl,
      cloudApiAccessToken: input.accessToken,
      cloudApiRefreshToken: input.refreshToken,
    }));
    mocks.buildCredentialBundle.mockImplementation((input: Record<string, unknown>) => ({
      ...input,
      relayBaseUrl: input.relayBaseUrl ?? "https://api.relaycast.dev",
    }));
    mocks.createApiTokenSession.mockResolvedValue({
      sessionId: "session-1",
      tokenFamilyId: "family-1",
      accessToken: "cld_at_member",
      accessTokenExpiresAt: "2026-06-03T10:00:00.000Z",
      refreshToken: "cld_rt_member",
      refreshTokenExpiresAt: "2026-07-03T10:00:00.000Z",
      subjectType: "sandbox",
      scopes: [],
    });
    mocks.ensureRelayWorkspace.mockResolvedValue(undefined);
    mocks.getCliCredentials.mockResolvedValue("");
    mocks.getWorkflowStorageBackend.mockReturnValue("r2");
    mocks.isWorkerRuntime.mockReturnValue(true);
    mocks.mintScopedS3Credentials.mockResolvedValue({
      accessKeyId: "ak",
      secretAccessKey: "sk",
      sessionToken: "st",
      bucket: "bucket",
      prefix: "prefix",
    });
    mocks.resolveOrProvisionRelayWorkspace.mockResolvedValue({
      id: "rw_workspace",
      relaycastApiKey: "relaycast_api_key",
    });
    mocks.readBoundRelayWorkspaceId.mockResolvedValue("rw_workspace");
    mocks.resolveRelaycastUrl.mockReturnValue("https://api.relaycast.dev");
    mocks.mintWorkflowGithubWriteToken.mockResolvedValue({
      token: "github-write-token",
      installationId: "installation-1",
      repositoryScoped: true,
      tokenPrefix: "ghs_1234",
    });
    mocks.resolveServerDaytonaAuthParams.mockReturnValue({});
    mocks.getCloudflareContext.mockImplementation(() => {
      throw new Error("Cloudflare context is not available");
    });
    mocks.resolveRelayfileConfig.mockReturnValue({
      relayfileUrl: "https://relayfile.example",
      relayAuthUrl: "https://relayauth.example",
      relayAuthApiKey: "org-api-key",
    });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("keeps the N=1 launch flag default-off", () => {
    expect(isTeamLaunchN1Enabled()).toBe(false);
  });

  it("uses the SST Resource flag first and lets empty Resource values fall through to env fallback", () => {
    mocks.tryResourceValue.mockReturnValueOnce("true");
    expect(isTeamLaunchN1Enabled()).toBe(true);

    mocks.tryResourceValue.mockReturnValueOnce(undefined);
    process.env.CLOUD_TEAM_LAUNCH_N1_ENABLED = "true";
    expect(isTeamLaunchN1Enabled()).toBe(true);

    mocks.tryResourceValue.mockReturnValueOnce(undefined);
    delete process.env.CLOUD_TEAM_LAUNCH_N1_ENABLED;
    process.env.TEAM_LAUNCH_N1_TEST_MODE = "true";
    expect(isTeamLaunchN1Enabled()).toBe(true);
  });

  it("derives a strict issue root and localRoot from a GitHub issue label payload", () => {
    const assignedRoot = deriveGithubIssueAssignedRoot(payload());

    expect(assignedRoot).toBe("/github/repos/AgentWorkforce/cloud/issues/123");
    expect(memberLocalRootForAssignedRoot(assignedRoot!)).toBe(
      "/github/repos/AgentWorkforce/cloud/issues/123",
    );
    expect(() => assertTeamLaunchN1ReadSurface({
      assignedRoot: assignedRoot!,
      localRoot: memberLocalRootForAssignedRoot(assignedRoot!),
    })).not.toThrow();
  });

  it("normalizes encoded repository segments before deriving the issue root", () => {
    const assignedRoot = deriveGithubIssueAssignedRoot({
      ...payload(),
      paths: ["/github/repos/Agent%20Workforce/cloud%2Dcore/issues/123.json"],
      resource: {},
    });

    expect(assignedRoot).toBe("/github/repos/Agent%20Workforce/cloud-core/issues/123");
  });

  it("rejects repository full names with extra path segments", () => {
    const assignedRoot = deriveGithubIssueAssignedRoot({
      ...payload(),
      paths: [],
      resource: {
        issue: { number: 123 },
        repository: { full_name: "AgentWorkforce/cloud/extra" },
      },
    });

    expect(assignedRoot).toBeNull();
  });

  it("fails closed when localRoot widens beyond the assigned issue root", () => {
    expect(() => assertTeamLaunchN1ReadSurface({
      assignedRoot: "/github/repos/AgentWorkforce/cloud/issues/123",
      localRoot: "/github/repos/AgentWorkforce/cloud",
    })).toThrow(/localRoot/);
  });

  it("rejects invalid assigned roots before launch options are built", async () => {
    const buildLaunchOptions = vi.fn();

    await expect(dispatchTeamLaunchN1(
      {
        workspaceId: "workspace-1",
        agentId: "agent-1",
        deliveryId: "delivery-1",
        payload: {
          ...payload(),
          paths: ["/github/repos/AgentWorkforce/cloud/issues/../secrets.json"],
        },
      },
      {
        isEnabled: () => true,
        buildLaunchOptions,
      },
    )).rejects.toThrow(/traversal/);

    expect(buildLaunchOptions).not.toHaveBeenCalled();
  });

  it("rejects traversal anywhere in event paths before launch options are built", async () => {
    const buildLaunchOptions = vi.fn();

    await expect(dispatchTeamLaunchN1(
      {
        workspaceId: "workspace-1",
        agentId: "agent-1",
        deliveryId: "delivery-1",
        payload: {
          ...payload(),
          paths: [
            "/github/repos/AgentWorkforce/cloud/issues/123.json",
            "/github/repos/AgentWorkforce/cloud/issues/%2E%2E/secret.json",
          ],
        },
      },
      {
        isEnabled: () => true,
        buildLaunchOptions,
      },
    )).rejects.toThrow(/unsafe traversal/);

    expect(buildLaunchOptions).not.toHaveBeenCalled();
  });

  it("emits exactly one fleet spawn and returns no token material", async () => {
    const assignedRoot = "/github/repos/AgentWorkforce/cloud/issues/123";
    const spawns: unknown[] = [];

    const result = await dispatchTeamLaunchN1(
      {
        workspaceId: "workspace-1",
        agentId: "agent-1",
        deliveryId: "delivery-1",
        payload: payload(),
      },
      {
        isEnabled: () => true,
        fleet: {
          spawn: async (input) => {
            spawns.push(input);
            return {
              name: input.name,
              invocationId: input.invocationId,
              sessionRef: "session-1",
            };
          },
        },
      },
    );

    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({
      name: "cloud-team-issue-n1",
      capability: "spawn:claude",
      workspaceId: "workspace-1",
      persona: "cloud-team-issue-n1",
      recipe: "single",
      repo: "AgentWorkforce/cloud",
      channel: "team-launch-n1-agent",
      model: "claude-sonnet-4-6",
      invocationId: "proactive:workspace-1:agent-1:delivery-1:cloud-team-issue-n1",
      inputs: {
        deliveryId: "delivery-1",
        agentId: "agent-1",
        assignedRoot,
        role: "implementer",
      },
    });
    expect(JSON.stringify(spawns[0])).toContain(`Relayfile issue root ${assignedRoot}`);
    expect(JSON.stringify(spawns[0])).not.toContain("/home/daytona");
    // Finding B: the fleet node owns credential provisioning for spawn:* personas
    // (mirrors factory-cloud-orchestrator). The emitted spawn must therefore carry
    // NO GitHub token, NO scoped Relayfile token, and NO credential bundle — only
    // the assigned-root pin in `inputs` plus the bound-to-root task prompt.
    const emittedSpawn = spawns[0] as Record<string, unknown>;
    expect(emittedSpawn).not.toHaveProperty("credentialBundle");
    expect(emittedSpawn).not.toHaveProperty("envSecrets");
    const emittedInputs = emittedSpawn.inputs as Record<string, unknown>;
    expect(emittedInputs).not.toHaveProperty("GITHUB_TOKEN");
    expect(emittedInputs).not.toHaveProperty("credentialBundle");
    expect(emittedInputs.assignedRoot).toBe(assignedRoot);
    const emittedSpawnJson = JSON.stringify(emittedSpawn);
    expect(emittedSpawnJson).not.toContain("GITHUB_TOKEN");
    expect(emittedSpawnJson).not.toContain("github-write-token");
    expect(emittedSpawnJson).not.toContain("relay_pa_");
    expect(emittedSpawnJson).not.toContain("relay_ws_");
    expect(mocks.mintWorkflowGithubWriteToken).not.toHaveBeenCalled();
    expect(mocks.mintWorkspacePathScopedRelayfileToken).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "launched",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      deliveryId: "delivery-1",
      memberName: "cloud-team-issue-n1",
      role: "implementer",
      channel: "team-launch-n1-agent",
      invocationId: "proactive:workspace-1:agent-1:delivery-1:cloud-team-issue-n1",
      capability: "spawn:claude",
      persona: "cloud-team-issue-n1",
      sessionRef: "session-1",
      sandboxId: null,
      assignedRoot,
    });
    expect(JSON.stringify(result)).not.toContain("relay_pa_");
    expect(JSON.stringify(result)).not.toContain("org-api-key");
  });

  it("derives the PR base from the assigned repo instead of hardcoding AgentWorkforce/cloud", async () => {
    const spawns: Array<{ task?: string; repo?: string }> = [];

    await dispatchTeamLaunchN1(
      {
        workspaceId: "workspace-1",
        agentId: "agent-1",
        deliveryId: "delivery-1",
        payload: {
          ...payload(),
          paths: ["/github/repos/acme/widgets/issues/77.json"],
          resource: {
            label: { name: "team" },
            issue: { number: 77 },
            repository: { full_name: "acme/widgets" },
          },
        },
      },
      {
        isEnabled: () => true,
        fleet: {
          spawn: async (input) => {
            spawns.push({ task: input.task, repo: input.repo });
            return { name: input.name, invocationId: input.invocationId };
          },
        },
      },
    );

    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.repo).toBe("acme/widgets");
    expect(spawns[0]?.task).toContain("gh repo clone acme/widgets");
    expect(spawns[0]?.task).toContain("gh pr create against acme/widgets");
    expect(spawns[0]?.task).not.toContain("AgentWorkforce/cloud");
  });

  it("requires the decoded write-scope set to be exactly the assigned root", () => {
    const assignedRoot = "/github/repos/AgentWorkforce/cloud/issues/123";
    const token = relayPaToken([
      pathScope("/github/repos/AgentWorkforce/cloud/issues/124"),
    ]);

    expect(scopesFromRelayfileAccessToken(token)).toHaveLength(1);
    expect(() => assertExactSingleWriteScope({
      assignedRoot,
      writeScopes: scopesFromRelayfileAccessToken(token),
    })).toThrow(/exactly match/);
  });

  it("rejects out-of-subtree member write scopes", () => {
    const assignedRoot = "/github/repos/AgentWorkforce/cloud/issues/123";

    expect(memberWritePath(assignedRoot)).toBe("/github/repos/AgentWorkforce/cloud/issues/123/*");
    expect(pathScope(assignedRoot)).toBe("relayfile:fs:write:/github/repos/AgentWorkforce/cloud/issues/123/*");
    expect(() => assertExactSingleWriteScope({
      assignedRoot,
      writeScopes: [pathScope("/github/repos/AgentWorkforce/cloud/pulls/123")],
    })).toThrow(/exactly match/);
  });

  it("allows a same-root defaulted read scope while counting exactly one write scope", () => {
    const assignedRoot = "/github/repos/AgentWorkforce/cloud/issues/123";
    const token = relayPaToken([
      pathScope(assignedRoot),
      readPathScope(assignedRoot),
    ]);

    expect(scopesFromRelayfileAccessToken(token)).toHaveLength(2);
    expect(assertExactSingleWriteScope({
      assignedRoot,
      writeScopes: scopesFromRelayfileAccessToken(token),
    })).toEqual([pathScope(assignedRoot)]);
  });

  it("rejects broad or provider-root read scopes on member relay_pa tokens", () => {
    const assignedRoot = "/github/repos/AgentWorkforce/cloud/issues/123";

    for (const readScope of [
      "relayfile:fs:read:/*",
      "relayfile:fs:read:/github/repos/AgentWorkforce/cloud/issues/*",
    ]) {
      expect(() => assertExactSingleWriteScope({
        assignedRoot,
        writeScopes: [pathScope(assignedRoot), readScope],
      })).toThrow(/member read scope/);
    }
  });

  it("rejects unexpected non-read non-write scopes on member relay_pa tokens", () => {
    const assignedRoot = "/github/repos/AgentWorkforce/cloud/issues/123";

    for (const extraScope of [
      "sync:read",
      "relayfile:fs:list:/github/repos/AgentWorkforce/cloud/issues/123/*",
      "foo:bar",
    ]) {
      expect(() => assertExactSingleWriteScope({
        assignedRoot,
        writeScopes: [pathScope(assignedRoot), extraScope],
      })).toThrow(/member scope/);
    }
  });

  it("ignores legacy Daytona launch dependencies on the fleet path", async () => {
    const buildLaunchOptions = vi.fn();
    const launchMember = vi.fn();
    const result = await dispatchTeamLaunchN1(
      {
        workspaceId: "workspace-1",
        agentId: "agent-1",
        deliveryId: "delivery-1",
        payload: payload(),
      },
      {
        isEnabled: () => true,
        buildLaunchOptions,
        launchMember,
        fleet: {
          spawn: async (input) => ({
            name: input.name,
            invocationId: input.invocationId,
          }),
        },
      },
    );

    expect(result.status).toBe("launched");
    expect(buildLaunchOptions).not.toHaveBeenCalled();
    expect(launchMember).not.toHaveBeenCalled();
  });

  it("stands down without building launch options when disabled", async () => {
    const buildLaunchOptions = vi.fn();
    const result = await dispatchTeamLaunchN1(
      {
        workspaceId: "workspace-1",
        agentId: "agent-1",
        deliveryId: "delivery-1",
        payload: payload(),
      },
      {
        isEnabled: () => false,
        buildLaunchOptions,
      },
    );

    expect(result).toEqual({
      status: "skipped",
      reason: "disabled",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      deliveryId: "delivery-1",
    });
    expect(buildLaunchOptions).not.toHaveBeenCalled();
  });

  it("emits through an injected fleet factory when enabled without legacy launch dependencies", async () => {
    const createFleetEmitter = vi.fn(async () => ({
      spawn: async (input: { name: string; invocationId: string }) => ({
        name: input.name,
        invocationId: input.invocationId,
      }),
    }));
    const result = await dispatchTeamLaunchN1(
      {
        workspaceId: "workspace-1",
        agentId: "agent-1",
        deliveryId: "delivery-1",
        payload: payload(),
      },
      {
        isEnabled: () => true,
        createFleetEmitter,
      },
    );

    expect(createFleetEmitter).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("launched");
  });

  it("builds launch options using direct workspace-path mint with explicit assigned-root scope", async () => {
    const appWorkspaceId = "50587328-441d-4acb-b8f3-dbe1b3c5de99";
    const assignedRoot = "/github/repos/AgentWorkforce/cloud/issues/123";
    const expectedWriteScope = pathScope(assignedRoot);
    const token = relayPaToken([expectedWriteScope]);
    const tarball = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
    const assetsFetch = vi.fn(async () => new Response(tarball));
    process.env.NEXT_PUBLIC_APP_URL = "https://agentrelay.com/cloud";
    mocks.getCloudflareContext.mockReturnValue({
      env: {
        ASSETS: {
          fetch: assetsFetch,
        },
      },
    });
    mocks.readBoundRelayWorkspaceId.mockResolvedValue("rw_7ccfea89");
    mocks.mintWorkspacePathScopedRelayfileToken.mockResolvedValue(token);

    const options = await buildTeamLaunchMemberOptions({
      workspaceId: appWorkspaceId,
      agentId: "agent-1",
      deliveryId: "delivery-1",
      payload: payloadWithLaunch(),
      assignedRoot,
      localRoot: assignedRoot,
    });

    expect(mocks.resolveRelayfileConfig).toHaveBeenCalledTimes(1);
    expect(mocks.readBoundRelayWorkspaceId).toHaveBeenCalledWith(appWorkspaceId);
    expect(mocks.mintWorkspacePathScopedRelayfileToken).toHaveBeenCalledWith({
      workspaceId: "rw_7ccfea89",
      relayAuthUrl: "https://relayauth.example",
      relayAuthApiKey: "org-api-key",
      agentName: "cloud-team-issue-n1",
      agentId: "agent-1",
      paths: ["/github/repos/AgentWorkforce/cloud/issues/123/*"],
      scopes: [expectedWriteScope],
      ttlSeconds: 3600,
    });
    expect(options).toMatchObject({
      memberName: "cloud-team-issue-n1",
      role: "implementer",
      channel: "team-launch-n1-agent",
      assignedRoot,
      localRoot: assignedRoot,
      workspaceId: appWorkspaceId,
      relayfileUrl: "https://relayfile.example",
      relayAuthUrl: "https://relayauth.example",
      relayfileToken: token,
      runId: "delivery-1",
      credentialBundle: credentialBundle(),
      fileType: "typescript",
      harness: "claude",
      model: "claude-sonnet-4-6",
      relayAuthApiKey: "org-api-key",
      orchestratorLibUrl: "https://agentrelay.com/cloud/orchestrator-lib.tar.gz",
      orchestratorLibTarball: tarball,
    });
    expect(assetsFetch).toHaveBeenCalledWith(
      new URL("https://agentrelay.com/cloud/orchestrator-lib.tar.gz"),
    );
    expect(options).not.toHaveProperty("workspaceToken");
    expect(JSON.stringify(options)).not.toContain("relay_ws_");
  });

  it("builds launch options from resolved team roster member config when present", async () => {
    const appWorkspaceId = "50587328-441d-4acb-b8f3-dbe1b3c5de99";
    const assignedRoot = "/github/repos/AgentWorkforce/cloud/issues/123";
    const expectedWriteScope = pathScope(assignedRoot);
    const token = relayPaToken([expectedWriteScope]);
    mocks.readBoundRelayWorkspaceId.mockResolvedValue("rw_7ccfea89");
    mocks.mintWorkspacePathScopedRelayfileToken.mockResolvedValue(token);

    const options = await buildTeamLaunchMemberOptions({
      workspaceId: appWorkspaceId,
      agentId: "agent-1",
      deliveryId: "delivery-1",
      payload: payloadWithLaunch(),
      assignedRoot,
      localRoot: assignedRoot,
      memberConfig: {
        memberName: "cloud-team-issue-n1",
        role: "implementer",
        personaSpec: {
          persona: {
            slug: "cloud-team-issue",
            harness: "codex",
            model: "gpt-5",
          },
          agent: {},
        },
      },
    });

    expect(mocks.mintWorkspacePathScopedRelayfileToken).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: "cloud-team-issue-n1",
        agentId: "agent-1",
        scopes: [expectedWriteScope],
      }),
    );
    expect(options).toMatchObject({
      memberName: "cloud-team-issue-n1",
      role: "implementer",
      channel: "team-launch-n1-agent",
      harness: "codex",
      model: "gpt-5",
      relayfileToken: token,
    });
  });

  it("fails closed when the app workspace has no relay workspace binding", async () => {
    const appWorkspaceId = "50587328-441d-4acb-b8f3-dbe1b3c5de99";
    mocks.readBoundRelayWorkspaceId.mockResolvedValue(null);

    await expect(buildTeamLaunchMemberOptions({
      workspaceId: appWorkspaceId,
      agentId: "agent-1",
      deliveryId: "delivery-1",
      payload: payloadWithLaunch(),
      assignedRoot: "/github/repos/AgentWorkforce/cloud/issues/123",
      localRoot: "/github/repos/AgentWorkforce/cloud/issues/123",
    })).rejects.toThrow(
      new RegExp(`RelayFile workspace binding not found for app workspace ${appWorkspaceId}`),
    );

    expect(mocks.readBoundRelayWorkspaceId).toHaveBeenCalledWith(appWorkspaceId);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "teamLaunchN1 RelayFile workspace binding not found",
      expect.objectContaining({
        area: "team-launch-n1",
        diag: "relay-workspace-binding-missing",
        workspaceId: appWorkspaceId,
        agentId: "agent-1",
        deliveryId: "delivery-1",
        assignedRoot: "/github/repos/AgentWorkforce/cloud/issues/123",
      }),
    );
    expect(mocks.mintWorkspacePathScopedRelayfileToken).not.toHaveBeenCalled();
  });

  it("does not consult the legacy launch-options builder before emitting a fleet spawn", async () => {
    const appWorkspaceId = "50587328-441d-4acb-b8f3-dbe1b3c5de99";
    mocks.readBoundRelayWorkspaceId.mockResolvedValue(null);

    const buildLaunchOptions = vi.fn();
    const launchMember = vi.fn();
    const result = await dispatchTeamLaunchN1(
      {
        workspaceId: appWorkspaceId,
        agentId: "agent-1",
        deliveryId: "delivery-1",
        payload: payloadWithLaunch(),
      },
      {
        isEnabled: () => true,
        buildLaunchOptions,
        launchMember,
        fleet: {
          spawn: async (input) => ({
            name: input.name,
            invocationId: input.invocationId,
          }),
        },
      },
    );

    expect(result.status).toBe("launched");
    expect(buildLaunchOptions).not.toHaveBeenCalled();
    expect(mocks.readBoundRelayWorkspaceId).not.toHaveBeenCalled();
    expect(mocks.mintWorkspacePathScopedRelayfileToken).not.toHaveBeenCalled();
    expect(launchMember).not.toHaveBeenCalled();
  });

  it("builds a fleet launchMember config without minting legacy credentials", async () => {
    const launchPayload = await buildTeamLaunchPayload({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      deliveryId: "delivery-1",
      payload: payload(),
    });

    expect(launchPayload.launchMember).toMatchObject({
      memberName: "cloud-team-issue-n1",
      role: "implementer",
      channel: "team-launch-n1-agent",
      harness: "claude",
      model: "claude-sonnet-4-6",
      runId: expect.stringMatching(UUID_RE),
    });
    expect((launchPayload.launchMember as Record<string, unknown>).runId).not.toBe("delivery-1");
    expect(launchPayload.launchMember).not.toHaveProperty("credentialBundle");
    expect(launchPayload.launchMember).not.toHaveProperty("workflowConfig");
    expect(launchPayload.launchMember).not.toHaveProperty("envSecrets");
    expect(launchPayload.launchMember).not.toHaveProperty("fileType");
    expect(JSON.stringify(launchPayload)).not.toContain("relay_ws");
    expect(JSON.stringify(launchPayload)).not.toContain("relay_pa");
    expect(mocks.createApiTokenSession).not.toHaveBeenCalled();
    expect(mocks.buildCloudApiWorkflowStorageCredentials).not.toHaveBeenCalled();
    expect(mocks.mintScopedS3Credentials).not.toHaveBeenCalled();
    expect(mocks.resolveOrProvisionRelayWorkspace).not.toHaveBeenCalled();
    expect(mocks.ensureRelayWorkspace).not.toHaveBeenCalled();
    expect(mocks.mintWorkflowGithubWriteToken).not.toHaveBeenCalled();
    expect(mocks.buildCredentialBundle).not.toHaveBeenCalled();
  });

  it("builds the fleet drain payload and dispatches it without legacy credential setup", async () => {
    mocks.createApiTokenSession.mockRejectedValue(new Error("legacy credential path must not run"));
    mocks.mintWorkflowGithubWriteToken.mockRejectedValue(new Error("github token path must not run"));
    mocks.resolveOrProvisionRelayWorkspace.mockRejectedValue(new Error("relay workspace path must not run"));
    const launchPayload = await buildTeamLaunchPayload({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      deliveryId: "delivery-1",
      payload: payload(),
      deployedByUserId: null,
      organizationId: null,
    });
    const runId = (launchPayload.launchMember as { runId: string }).runId;
    const spawns: unknown[] = [];

    const result = await dispatchTeamLaunchN1({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      deliveryId: "delivery-1",
      payload: launchPayload,
    }, {
      isEnabled: () => true,
      fleet: {
        spawn: async (input) => {
          spawns.push(input);
          return { name: input.name, invocationId: input.invocationId };
        },
      },
    });

    expect(result.status).toBe("launched");
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({
      inputs: {
        assignedRoot: "/github/repos/AgentWorkforce/cloud/issues/123",
        runId,
      },
    });
    expect(mocks.createApiTokenSession).not.toHaveBeenCalled();
    expect(mocks.mintWorkflowGithubWriteToken).not.toHaveBeenCalled();
    expect(mocks.resolveOrProvisionRelayWorkspace).not.toHaveBeenCalled();
  });

  it("uses member roster config from the member's deployed persona spec when present", async () => {
    const launchPayload = await buildTeamLaunchPayload({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      deliveryId: "delivery-1",
      payload: payload(),
      memberConfig: {
        personaSpec: {
          persona: {
            slug: "cloud-team-issue-codex-member",
            harness: "codex",
            model: "gpt-5",
            capabilities: {
              teamSolve: {
                enabled: true,
                roles: ["reviewer"],
              },
            },
          },
          agent: {},
        },
      },
    });

    expect(launchPayload.launchMember).toMatchObject({
      memberName: "cloud-team-issue-codex-member",
      role: "reviewer",
      channel: "team-launch-n1-agent",
      harness: "codex",
      model: "gpt-5",
      runId: expect.stringMatching(UUID_RE),
    });
    expect(launchPayload.launchMember).not.toHaveProperty("credentialBundle");
  });

  it("lets a resolved member persona without a model use the harness default", async () => {
    const launchPayload = await buildTeamLaunchPayload({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      deliveryId: "delivery-1",
      payload: payload(),
      memberConfig: {
        personaSpec: {
          persona: {
            slug: "cloud-team-issue-codex-member",
            harness: "codex",
            capabilities: {
              teamSolve: {
                enabled: true,
                roles: ["reviewer"],
              },
            },
          },
          agent: {},
        },
      },
    });

    expect(launchPayload.launchMember).toMatchObject({
      memberName: "cloud-team-issue-codex-member",
      role: "reviewer",
      harness: "codex",
      runId: expect.stringMatching(UUID_RE),
    });
    expect(launchPayload.launchMember).not.toHaveProperty("model");
  });

  it("threads one generated member run UUID through token, cloud-api storage, bundle, and launch config", async () => {
    const { deliveryId, launchMember } = await buildDefaultLaunchPayloadForTest();
    const runId = launchMember.runId;

    expect(runId).toMatch(UUID_RE);
    expect(runId).not.toBe(deliveryId);
    expect(mocks.createApiTokenSession).toHaveBeenCalledWith(expect.objectContaining({
      subjectType: "sandbox",
      runId,
    }));
    expect(mocks.buildCloudApiWorkflowStorageCredentials).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      runId,
    }));
    expect(mocks.mintScopedS3Credentials).not.toHaveBeenCalled();
    expect(mocks.buildCredentialBundle).toHaveBeenCalledWith(expect.objectContaining({
      runId,
      s3Credentials: expect.objectContaining({
        prefix: `user-1/${runId}`,
      }),
    }));
    expect(launchMember.credentialBundle).toMatchObject({
      runId,
      s3Credentials: expect.objectContaining({
        prefix: `user-1/${runId}`,
      }),
    });
    expect(mocks.mintWorkflowGithubWriteToken).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: "workspace-1",
      repoOwner: "AgentWorkforce",
      repoName: "cloud",
    });
    expect(launchMember.envSecrets).toEqual({
      GITHUB_TOKEN: "github-write-token",
    });
    expect(JSON.stringify(mocks.createApiTokenSession.mock.calls[0]?.[0])).not.toContain(deliveryId);
    expect(JSON.stringify(launchMember)).not.toContain(deliveryId);
  });

  it("uses the same generated member run UUID for the S3 storage credential sink", async () => {
    mocks.getWorkflowStorageBackend.mockReturnValue("s3");
    mocks.isWorkerRuntime.mockReturnValue(false);
    mocks.mintScopedS3Credentials.mockImplementation(async (input: {
      userId: string;
      runId: string;
    }) => ({
      accessKeyId: "ak",
      secretAccessKey: "sk",
      sessionToken: "st",
      bucket: "bucket",
      prefix: `${input.userId}/${input.runId}`,
    }));

    const { deliveryId, launchMember } = await buildDefaultLaunchPayloadForTest();
    const runId = launchMember.runId;

    expect(runId).toMatch(UUID_RE);
    expect(runId).not.toBe(deliveryId);
    expect(mocks.createApiTokenSession).toHaveBeenCalledWith(expect.objectContaining({ runId }));
    expect(mocks.mintScopedS3Credentials).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      runId,
    }));
    expect(mocks.buildCloudApiWorkflowStorageCredentials).not.toHaveBeenCalled();
    expect(launchMember.credentialBundle).toMatchObject({
      runId,
      s3Credentials: expect.objectContaining({
        prefix: `user-1/${runId}`,
      }),
    });
    expect(JSON.stringify(mocks.createApiTokenSession.mock.calls[0]?.[0])).not.toContain(deliveryId);
  });

  it("fails closed when direct launch credentials are missing", async () => {
    await expect(buildTeamLaunchMemberOptions({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      deliveryId: "delivery-1",
      payload: payload(),
      assignedRoot: "/github/repos/AgentWorkforce/cloud/issues/123",
      localRoot: "/github/repos/AgentWorkforce/cloud/issues/123",
    })).rejects.toThrow(/launch credentials/);
    expect(mocks.mintWorkspacePathScopedRelayfileToken).not.toHaveBeenCalled();
  });

  it("does not require legacy launch credentials to emit a fleet spawn", async () => {
    const buildLaunchOptions = vi.fn();
    const launchMember = vi.fn();
    const result = await dispatchTeamLaunchN1(
      {
        workspaceId: "workspace-1",
        agentId: "agent-1",
        deliveryId: "delivery-1",
        payload: payload(),
      },
      {
        isEnabled: () => true,
        buildLaunchOptions,
        launchMember,
        fleet: {
          spawn: async (input) => ({
            name: input.name,
            invocationId: input.invocationId,
          }),
        },
      },
    );

    expect(result.status).toBe("launched");
    expect(buildLaunchOptions).not.toHaveBeenCalled();
    expect(launchMember).not.toHaveBeenCalled();
  });

  it("byte-matches the decoded direct relay_pa write scope and honors one-hour TTL", async () => {
    const assignedRoot = "/github/repos/AgentWorkforce/cloud/issues/123";
    const expectedWriteScope = pathScope(assignedRoot);
    mocks.mintWorkspacePathScopedRelayfileToken.mockResolvedValue(relayPaToken([
      readPathScope(assignedRoot),
      expectedWriteScope,
    ], 3600));

    const token = await mintDirectMemberRelayfileToken({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      memberName: "member-a",
      assignedRoot,
      relayAuthUrl: "https://relayauth.example",
      relayAuthApiKey: "org-api-key",
    });

    expect(scopesFromRelayfileAccessToken(token).filter((scope) =>
      scope.startsWith("relayfile:fs:write:")
    )).toEqual([expectedWriteScope]);
  });

  it("rejects direct minted relay_pa tokens with provider-root collapse, wrong root, or long TTL", async () => {
    const assignedRoot = "/github/repos/AgentWorkforce/cloud/issues/123";
    for (const token of [
      relayPaToken(["relayfile:fs:write:/github/repos/AgentWorkforce/cloud/issues/*"]),
      relayPaToken([pathScope("/github/repos/AgentWorkforce/cloud/issues/124")]),
      relayPaToken([pathScope(assignedRoot)], 3601),
    ]) {
      mocks.mintWorkspacePathScopedRelayfileToken.mockResolvedValueOnce(token);
      await expect(mintDirectMemberRelayfileToken({
        workspaceId: "workspace-1",
        agentId: "agent-1",
        memberName: "member-a",
        assignedRoot,
        relayAuthUrl: "https://relayauth.example",
        relayAuthApiKey: "org-api-key",
      })).rejects.toThrow(/write scope|TTL/);
    }
  });
});
