import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GITHUB_EVENTS } from "@relayfile/adapter-github";
import { EVENT_MAP as GITLAB_EVENT_MAP } from "@relayfile/adapter-gitlab";
import {
  WORKFORCE_RUNTIME_AWS_SMITHY_SPECS,
} from "@cloud/core/proactive-runtime/runtime-package.js";
import {
  deriveRelayfileMountPaths,
  getAgentDeploymentTickTarget,
  hashDeploymentWebhookSecret,
  translatePersonaTriggersToWatchGlobs,
} from "@/lib/proactive-runtime/persona-deploy";

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  hasWorkspaceAccess: vi.fn(),
  resolveWorkspaceIntegrationIdentity: vi.fn(),
  resolveRelayWorkspaceIdForRuntime: vi.fn(),
  resolveServerDaytonaAuthParams: vi.fn(),
  registerCronSchedules: vi.fn(),
  listCronSchedules: vi.fn(),
  cancelCronSchedule: vi.fn(),
  resolveAgentGatewayRelaycronEnv: vi.fn(),
  parsePersonaSpec: vi.fn(),
  parseAgentSpec: vi.fn(),
  resolveProviderCredentialRuntimeEnv: vi.fn(),
  enqueueIntegrationWatchDeliveryDrain: vi.fn(),
  storeBundle: vi.fn(),
  loadBundle: vi.fn(),
  bundleContentHash: vi.fn(),
  getSnapshotName: vi.fn(async () => "snapshot-test"),
  createCredentialStoreS3Client: vi.fn(),
  credentialStoreRetrieve: vi.fn(),
  mountCliCredentials: vi.fn(),
  extractAnthropicOauthToken: vi.fn(),
  getDb: vi.fn(),
  recordPersonaBundleDeploymentCreated: vi.fn(),
  daytonaConstructor: vi.fn(),
  daytona: {
    create: vi.fn(),
    sandboxApi: {
      createSandbox: vi.fn(),
    },
    get: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
  },
  sandbox: {
    id: "sbx_deploy",
    state: "STARTED",
    organizationId: "org_daytona",
    getUserHomeDir: vi.fn(),
    fs: {
      uploadFile: vi.fn(),
    },
    process: {
      executeCommand: vi.fn(),
      createSession: vi.fn(),
      executeSessionCommand: vi.fn(),
    },
  },
  db: {
    execute: vi.fn(),
    insert: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("@/lib/auth/request-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/request-auth")>()),
  resolveRequestAuth: mocks.resolveRequestAuth,
}));

vi.mock("@/lib/workspaces/workspace-integration-identity", () => ({
  hasWorkspaceIntegrationAccess: mocks.hasWorkspaceAccess,
  resolveRelayWorkspaceIdForRuntime: mocks.resolveRelayWorkspaceIdForRuntime,
  resolveWorkspaceIntegrationIdentity: mocks.resolveWorkspaceIntegrationIdentity,
}));

vi.mock("@/lib/daytona-auth", () => ({
  resolveServerDaytonaAuthParams: mocks.resolveServerDaytonaAuthParams,
}));

vi.mock("@/lib/db", () => ({
  getDb: mocks.getDb,
}));

vi.mock("@daytonaio/sdk", () => ({
  Daytona: mocks.daytonaConstructor,
}));

vi.mock("@cloud/core/config/snapshot.js", () => ({
  getSnapshotName: mocks.getSnapshotName,
}));

vi.mock("@/lib/proactive-runtime/agent-gateway-relaycron-client", () => ({
  registerCronSchedules: mocks.registerCronSchedules,
  listCronSchedules: mocks.listCronSchedules,
  cancelCronSchedule: mocks.cancelCronSchedule,
  resolveAgentGatewayRelaycronEnv: mocks.resolveAgentGatewayRelaycronEnv,
}));

vi.mock("@/lib/proactive-runtime/persona-deploy-audit", () => ({
  recordPersonaBundleDeploymentCreated: mocks.recordPersonaBundleDeploymentCreated,
}));

vi.mock("@/lib/billing/provider-credential-runtime", () => ({
  resolveProviderCredentialRuntimeEnv: mocks.resolveProviderCredentialRuntimeEnv,
  resolveSubscriptionFallbackEnv: vi.fn().mockResolvedValue({ env: {}, credentials: [] }),
  deriveCtxLlmEnvFromHarnessCredential: vi.fn(() => ({})),
}));

vi.mock("@/lib/proactive-runtime/integration-watch-delivery-queue", () => ({
  enqueueIntegrationWatchDeliveryDrain: mocks.enqueueIntegrationWatchDeliveryDrain,
}));

// Persona-spec validation now routes through @cloud/core's single
// persona-kit consumer (cloud#2192). Mock that boundary — the module
// persona-deploy.ts actually imports — rather than persona-kit itself,
// which is no longer a direct web dependency.
vi.mock("@cloud/core/proactive-runtime/persona-spec.js", () => ({
  isPersonaIntent: (value: unknown) => typeof value === "string",
  parsePersonaSpec: mocks.parsePersonaSpec,
  parseAgentSpec: mocks.parseAgentSpec,
  HARNESS_VALUES: ["opencode", "codex", "claude", "grok"],
}));

vi.mock("@/lib/proactive-runtime/bundle-store", () => ({
  storeBundle: mocks.storeBundle,
  loadBundle: mocks.loadBundle,
  bundleContentHash: mocks.bundleContentHash,
}));

vi.mock("sst", () => ({
  Resource: {
    CredentialEncryptionKey: { value: "credential-encryption-key" },
    WorkflowStorage: { bucketName: "workflow-storage-bucket" },
  },
}));

vi.mock("@cloud/core/auth/cli-credentials.js", () => ({
  CLI_TO_PROVIDER: {
    claude: "anthropic",
    codex: "openai",
    gemini: "google",
    opencode: "opencode",
  },
  mountCliCredentials: mocks.mountCliCredentials,
  extractAnthropicOauthToken: mocks.extractAnthropicOauthToken,
}));

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

import { GET, POST } from "./route";
import { POST as POST_TICK } from "./[agentId]/ticks/route";

// A real app workspace id is a v4 UUID (PG gen_random_uuid). Use a valid
// versioned UUID here so the route's isUuid guard on the resolved app
// workspace id treats the fixture like a real id.
const workspaceId = "00000000-0000-4000-8000-000000000002";
const relayWorkspaceId = "rw_7ccfea89";
const auth = {
  userId: "00000000-0000-0000-0000-000000000001",
  workspaceId,
  organizationId: "00000000-0000-0000-0000-000000000003",
  source: "token" as const,
  scopes: ["cli:auth"],
};

const originalCloudPublicUrl = process.env.CLOUD_PUBLIC_URL;
const originalNextPublicAppUrl = process.env.NEXT_PUBLIC_APP_URL;
const cloudflareContextSymbol = Symbol.for("__cloudflare-context__");

function createdTickSessionId(deploymentId: string): string {
  const escapedDeploymentId = deploymentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^tick-${escapedDeploymentId}-[0-9a-f]{12}$`);
  const call = mocks.sandbox.process.createSession.mock.calls.find(
    ([sessionId]) => typeof sessionId === "string" && pattern.test(sessionId),
  );
  expect(call).toBeTruthy();
  return call?.[0] as string;
}

function request(body: unknown, targetWorkspaceId = workspaceId): NextRequest {
  return new NextRequest(`https://cloud.test/api/v1/workspaces/${targetWorkspaceId}/deployments`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function deploymentListRequest(targetWorkspaceId = workspaceId): NextRequest {
  return new NextRequest(`https://cloud.test/api/v1/workspaces/${targetWorkspaceId}/deployments`);
}

function context(overrides: Partial<{ workspaceId: string }> = {}) {
  return { params: Promise.resolve({ workspaceId: overrides.workspaceId ?? workspaceId }) };
}

function installCloudflareWaitUntil() {
  let background: Promise<unknown> | undefined;
  const waitUntil = vi.fn((promise: Promise<unknown>) => {
    background = promise;
  });
  (globalThis as Record<symbol, unknown>)[cloudflareContextSymbol] = { waitUntil };
  return {
    waitUntil,
    get background() {
      return background;
    },
  };
}

function pendingDeliveryRow(input: {
  id: string;
  agentId: string;
  deploymentId: string;
  payload?: Record<string, unknown>;
  provisioningSandboxId?: string | null;
}) {
  return {
    id: input.id,
    workspace_id: workspaceId,
    agent_id: input.agentId,
    delivery_id: `deployment-tick:${input.deploymentId}`,
    payload: input.payload ?? {},
    attempt_count: 0,
    provisioning_sandbox_id: input.provisioningSandboxId ?? null,
    run_deployment_id: input.deploymentId,
    run_sandbox_id: null,
    run_session_id: null,
    run_command_id: null,
    run_started_at: null,
    run_sandbox_name: null,
    run_mount_configured: null,
    run_envelope: null,
  };
}

function persona(overrides: Record<string, unknown> = {}) {
  return {
    id: "weekly-digest",
    intent: "review",
    slug: "weekly-digest",
    inputs: {},
    integrations: {
      github: { triggers: [{ on: "pull_request.opened" }] },
    },
    schedules: [],
    ...overrides,
  };
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    persona: persona(),
    bundle: {
      runner: "import './agent.bundle.mjs';",
      agent: "export default {};",
      packageJson: { type: "module" },
    },
    inputs: { topic: "AI" },
    ...overrides,
  };
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    triggers: {
      github: [{ on: "pull_request.opened" }],
    },
    schedules: [],
    ...overrides,
  };
}

function queueExecuteRows(rows: Array<Array<Record<string, unknown>>>) {
  for (const rowSet of rows) {
    mocks.db.execute.mockResolvedValueOnce({ rows: rowSet });
  }
}

function mockDb() {
  mocks.db.insert.mockReturnValue({
    values: vi.fn(async () => undefined),
  });
  mocks.db.select.mockReturnValue({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => [{ id: "sbx_deploy" }]),
      })),
    })),
  });
  mocks.db.update.mockReturnValue({
    set: vi.fn(() => ({
      where: vi.fn(async () => undefined),
    })),
  });
  mocks.getDb.mockReturnValue(mocks.db);
}

function mockDeploymentListRows(rows: Array<{
  agentId: string;
  personaId: string;
  deployedName: string;
  imageUrl?: string | null;
  status: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  scheduleIds: string[] | null;
  watchGlobs?: string[] | null;
  watchRules?: unknown[] | null;
  inputValues?: Record<string, string>;
  personaVersionSpec?: Record<string, unknown> | null;
  personaDescription?: string | null;
  deployedByUserId: string;
}>,
runSummaries: Array<Record<string, unknown>> = [],
latestRunSummaries: Array<Record<string, unknown>> = [],
integrationWatchHealthRows: Array<Record<string, unknown>> = [],
integrationWatchFailureSummaryRows: Array<Record<string, unknown>> = [
  { recent_failure_count: 0, latest_failure_at: null },
]) {
  const limit = vi.fn(async () => rows);
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ orderBy }));
  const joinChain = {
    leftJoin: vi.fn(() => joinChain),
    where,
  };
  const from = vi.fn(() => joinChain);
  mocks.db.select.mockReturnValue({ from });
  mocks.db.execute.mockResolvedValueOnce({ rows: runSummaries });
  mocks.db.execute.mockResolvedValueOnce({ rows: latestRunSummaries });
  mocks.db.execute.mockResolvedValueOnce({ rows: integrationWatchHealthRows });
  mocks.db.execute.mockResolvedValueOnce({ rows: integrationWatchFailureSummaryRows });
  return { from, leftJoin: joinChain.leftJoin, where, orderBy, limit };
}

function sqlText(value: unknown): string {
  if (!value || typeof value !== "object" || !("queryChunks" in value)) {
    return "";
  }
  return ((value as { queryChunks: unknown[] }).queryChunks)
    .map((chunk) => {
      if (typeof chunk === "string") {
        return "?";
      }
      if (chunk && typeof chunk === "object" && "value" in chunk) {
        const value = (chunk as { value: unknown }).value;
        return Array.isArray(value) ? value.join("") : String(value);
      }
      return "?";
    })
    .join("");
}

function rawSqlText(value: unknown): string {
  if (!value || typeof value !== "object" || !("queryChunks" in value)) {
    return "";
  }
  return ((value as { queryChunks: unknown[] }).queryChunks)
    .map((chunk) => {
      if (typeof chunk === "string") {
        return chunk;
      }
      if (chunk && typeof chunk === "object" && "value" in chunk) {
        const value = (chunk as { value: unknown }).value;
        return Array.isArray(value) ? value.join("") : String(value);
      }
      return String(chunk);
    })
    .join("");
}

function mockListCronSchedulesOnce(schedules: Array<{
  id: string;
  status: string;
  metadata: Record<string, unknown> | null;
}>) {
  mocks.listCronSchedules.mockImplementationOnce(async (_env: unknown, input: {
    filter?: (schedule: { id: string; status: string; metadata: Record<string, unknown> | null }) => boolean;
    onPage?: (page: { count: number; cursor: string | null | undefined }) => void;
  } = {}) => {
    input.onPage?.({ count: schedules.length, cursor: undefined });
    return input.filter ? schedules.filter(input.filter) : schedules;
  });
}

async function* sandboxList(sandboxes: unknown[]) {
  for (const sandbox of sandboxes) {
    yield sandbox;
  }
}

describe("persona bundle deployments route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveRequestAuth.mockResolvedValue(auth);
    mocks.hasWorkspaceAccess.mockReturnValue(true);
    mocks.resolveWorkspaceIntegrationIdentity.mockImplementation(async (requestedWorkspaceId: string) => ({
      requestedWorkspaceId,
      appWorkspaceId: requestedWorkspaceId === relayWorkspaceId ? workspaceId : requestedWorkspaceId,
      relayWorkspaceId: requestedWorkspaceId === relayWorkspaceId ? relayWorkspaceId : requestedWorkspaceId,
      organizationId: auth.organizationId,
      candidateWorkspaceIds: requestedWorkspaceId === relayWorkspaceId
        ? [relayWorkspaceId, workspaceId]
        : [requestedWorkspaceId, relayWorkspaceId],
    }));
    mocks.resolveRelayWorkspaceIdForRuntime.mockImplementation(async (requestedWorkspaceId: string) =>
      requestedWorkspaceId === workspaceId ? relayWorkspaceId : requestedWorkspaceId
    );
    mocks.resolveServerDaytonaAuthParams.mockReturnValue({ daytonaApiKey: "daytona-key" });
    mocks.storeBundle.mockResolvedValue({
      sha256: "0".repeat(64),
      bytesWritten: 256,
      reused: false,
    });
    mocks.loadBundle.mockResolvedValue({
      runner: "export default 'runner';",
      agent: "export default 'agent';",
      packageJson: { type: "module" },
    });
    mocks.bundleContentHash.mockReturnValue("0".repeat(64));
    mocks.getSnapshotName.mockResolvedValue("snapshot-test");
    mocks.daytonaConstructor.mockImplementation(function () {
      return mocks.daytona;
    } as never);
    mocks.daytona.create.mockResolvedValue(mocks.sandbox);
    mocks.daytona.sandboxApi.createSandbox.mockResolvedValue({
      data: { id: "sbx_deploy", state: "STARTED" },
    });
    mocks.daytona.get.mockResolvedValue(mocks.sandbox);
    mocks.daytona.list.mockImplementation(() => sandboxList([mocks.sandbox]));
    mocks.daytona.delete.mockResolvedValue(undefined);
    mocks.sandbox.getUserHomeDir.mockResolvedValue("/home/daytona");
    mocks.sandbox.fs.uploadFile.mockResolvedValue(undefined);
    mocks.sandbox.process.executeCommand.mockResolvedValue({ exitCode: 0, result: "started" });
    mocks.sandbox.process.createSession.mockResolvedValue(undefined);
    mocks.sandbox.process.executeSessionCommand.mockResolvedValue({
      cmdId: "cmd-deployment-run",
      exitCode: 0,
      output: "started",
    });
    mocks.createCredentialStoreS3Client.mockResolvedValue({ kind: "worker-aware-s3-client" });
    mocks.credentialStoreRetrieve.mockResolvedValue('{"tokens":{"access_token":"token"}}');
    mocks.mountCliCredentials.mockResolvedValue(undefined);
    mocks.extractAnthropicOauthToken.mockReturnValue(null);
    mocks.parsePersonaSpec.mockImplementation((value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw { issues: [{ path: [], message: "persona must be an object" }] };
      }
      const record = value as Record<string, unknown>;
      // Mirror persona-kit's real behavior: `inputs` is optional, and a
      // wrong-type value is a schema error. An absent/empty inputs field
      // is normalized away by the real parser, so cloud's validator
      // sees `undefined` — that path is exercised in the
      // "deploys a persona with no inputs" test below.
      if (
        record.inputs !== undefined
        && (typeof record.inputs !== "object" || Array.isArray(record.inputs) || record.inputs === null)
      ) {
        throw { issues: [{ path: ["inputs"], message: "persona.inputs must be an object" }] };
      }
      return value;
    });
    mocks.parseAgentSpec.mockImplementation((value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw { issues: [{ path: [], message: "agent must be an object" }] };
      }
      return value;
    });
    mocks.resolveAgentGatewayRelaycronEnv.mockReturnValue({
      RELAYCRON_URL: "https://relaycron.test",
      RELAYCRON_API_KEY: "relaycron-key",
    });
    mocks.resolveProviderCredentialRuntimeEnv.mockResolvedValue({ env: {}, credentials: [] });
    mocks.enqueueIntegrationWatchDeliveryDrain.mockResolvedValue("enqueued");
    mocks.registerCronSchedules.mockResolvedValue([
      {
        gatewayScheduleId: "gateway_sched_1",
        relaycronScheduleId: "relaycron_sched_1",
        schedule: "0 9 * * *",
        scheduleType: "cron",
        timezone: "Europe/Oslo",
        createdAt: "2026-05-13T00:00:00.000Z",
        created: true,
        cronExpression: "0 9 * * *",
      },
    ]);
    mocks.listCronSchedules.mockResolvedValue([]);
    mocks.cancelCronSchedule.mockResolvedValue(undefined);
    delete process.env.CLOUD_PUBLIC_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    mockDb();
  });

  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[cloudflareContextSymbol];
    vi.unstubAllGlobals();
    if (originalCloudPublicUrl === undefined) {
      delete process.env.CLOUD_PUBLIC_URL;
    } else {
      process.env.CLOUD_PUBLIC_URL = originalCloudPublicUrl;
    }
    if (originalNextPublicAppUrl === undefined) {
      delete process.env.NEXT_PUBLIC_APP_URL;
    } else {
      process.env.NEXT_PUBLIC_APP_URL = originalNextPublicAppUrl;
    }
  });

  it("lists non-destroyed deployments for a workspace", async () => {
    mockDeploymentListRows(
      [
        {
          agentId: "agent-1",
          personaId: "persona-1",
          deployedName: "weekly-digest",
          imageUrl: "https://cdn.example/weekly-card.png",
          status: "active",
          createdAt: new Date("2026-05-13T08:00:00.000Z"),
          lastUsedAt: null,
          scheduleIds: ["relaycron_sched_1"],
          inputValues: {
            SLACK_CHANNEL: "C0123",
            TOPICS: "launch,review",
            GITHUB_TOKEN: "ghp_should_not_be_masked_by_api",
          },
          personaVersionSpec: {
            persona: {
              inputs: {
                channel: {
                  env: "SLACK_CHANNEL",
                  picker: { provider: "slack", resource: "channels" },
                },
                topics: {
                  env: "TOPICS",
                },
              },
            },
            agent: {
              schedules: [
                {
                  name: "Business hours",
                  cron: "0 9,17 * * *",
                  tz: "Europe/Oslo",
                },
              ],
            },
          },
          personaDescription: "Tracks weekly launch and review updates.",
          deployedByUserId: auth.userId,
        },
      ],
      [
        {
          agent_id: "agent-1",
          last_fired_at: "2026-05-13T09:00:00.000Z",
          last_completed_at: "2026-05-13T09:02:00.000Z",
          run_count: "3",
        },
      ],
    );

    const response = await GET(
      new NextRequest(`https://cloud.test/api/v1/workspaces/${workspaceId}/deployments`),
      context(),
    );

    expect(response.status).toBe(200);
    const runSummarySql = rawSqlText(mocks.db.execute.mock.calls[0][0]);
    expect(runSummarySql).toContain("MAX(r.started_at) AS last_fired_at");
    expect(runSummarySql).toContain("MAX(r.ended_at) AS last_completed_at");
    expect(runSummarySql).toContain("COUNT(DISTINCT r.id) AS run_count");
    expect(runSummarySql).not.toContain("COUNT(DISTINCT d.id) AS run_count");
    expect(runSummarySql).not.toContain("MAX(d.started_at) AS last_fired_at");
    await expect(response.json()).resolves.toEqual({
      agents: [{
        agentId: "agent-1",
        personaId: "persona-1",
        deployedName: "weekly-digest",
        imageUrl: "https://cdn.example/weekly-card.png",
        status: "active",
        createdAt: "2026-05-13T08:00:00.000Z",
        lastUsedAt: null,
        lastFiredAt: "2026-05-13T09:00:00.000Z",
        lastCompletedAt: "2026-05-13T09:02:00.000Z",
        lastRunStatus: null,
        lastError: null,
        runCount: 3,
        scheduleIds: ["relaycron_sched_1"],
        scheduleSpecs: [
          {
            id: "relaycron_sched_1",
            name: "Business hours",
            cronExpression: "0 9,17 * * *",
            timezone: "Europe/Oslo",
          },
        ],
        inputValues: {
          SLACK_CHANNEL: "C0123",
          TOPICS: "launch,review",
          GITHUB_TOKEN: "ghp_should_not_be_masked_by_api",
        },
        inputSpecs: {
          SLACK_CHANNEL: {
            picker: { provider: "slack", resource: "channels" },
          },
          TOPICS: {},
        },
        personaDescription: "Tracks weekly launch and review updates.",
        deployedByUserId: auth.userId,
        integrationWatchHealth: {
          status: "not_configured",
          reason: null,
          lastSuccessfulDeliveryAt: null,
          lastDeliveryAt: null,
          lastFailedDeliveryAt: null,
          pendingDeliveryCount: 0,
          recentFailedDeliveryCount: 0,
          recentWorkspaceDispatchFailureCount: 0,
          latestWorkspaceDispatchFailureAt: null,
        },
      }],
      nextCursor: null,
    });
  });

  it("lists deployments through a bound relay workspace id", async () => {
    mockDeploymentListRows(
      [
        {
          agentId: "agent-relay",
          personaId: "persona-relay",
          deployedName: "meeting-actions",
          status: "active",
          createdAt: new Date("2026-06-14T08:00:00.000Z"),
          lastUsedAt: null,
          scheduleIds: [],
          watchGlobs: ["/slack/channels/C123/messages/**"],
          inputValues: {},
          deployedByUserId: auth.userId,
        },
      ],
      [],
      [],
      [
        {
          agent_id: "agent-relay",
          agent_created_at: "2026-06-14T08:00:00.000Z",
          last_successful_delivery_at: "2026-06-14T08:05:00.000Z",
          last_delivery_at: "2026-06-14T08:05:00.000Z",
          last_failed_delivery_at: null,
          recent_failed_delivery_count: "0",
          pending_delivery_count: "0",
        },
      ],
    );

    const response = await GET(
      deploymentListRequest(relayWorkspaceId),
      context({ workspaceId: relayWorkspaceId }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      agents: [{ agentId: "agent-relay", deployedName: "meeting-actions" }],
    });
    expect(mocks.resolveWorkspaceIntegrationIdentity).toHaveBeenCalledWith(relayWorkspaceId);
    const integrationWatchSql = rawSqlText(mocks.db.execute.mock.calls[2][0]);
    expect(integrationWatchSql).toContain(workspaceId);
    expect(integrationWatchSql).not.toContain(relayWorkspaceId);
    // The workspace dispatch-failure summary is keyed by relay_workspace_id,
    // so it must query the bound rw_ id, NOT the app workspace uuid.
    const failureSummarySql = rawSqlText(mocks.db.execute.mock.calls[3][0]);
    expect(failureSummarySql).toContain(relayWorkspaceId);
    expect(failureSummarySql).not.toContain(workspaceId);
  });

  it("returns 404 without querying when an unbound relay workspace resolves to no app workspace", async () => {
    const unboundRelayId = "rw_unbound01";
    mocks.resolveWorkspaceIntegrationIdentity.mockResolvedValueOnce({
      requestedWorkspaceId: unboundRelayId,
      appWorkspaceId: null,
      relayWorkspaceId: unboundRelayId,
      organizationId: auth.organizationId,
      candidateWorkspaceIds: [unboundRelayId],
    });

    const response = await GET(
      deploymentListRequest(unboundRelayId),
      context({ workspaceId: unboundRelayId }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "workspace_not_found" });
    expect(mocks.db.execute).not.toHaveBeenCalled();
  });

  it("surfaces stale integration-watch subscriptions as unhealthy without overloading status", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchSpy = vi.fn(async () => new Response(null, { status: 202 }));
    const waitUntil = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    (globalThis as Record<symbol, unknown>)[cloudflareContextSymbol] = {
      waitUntil,
      env: {
        NIGHTCTO_EVIDENCE_URL: "https://nightcto.example/webhooks/cloud-runtime",
        NIGHTCTO_EVIDENCE_TOKEN: "evidence-token",
        ENVIRONMENT: "test",
        DEPLOY_VERSION: "test-version",
      },
    };
    mockDeploymentListRows(
      [
        {
          agentId: "agent-watch",
          personaId: "persona-watch",
          deployedName: "customer-health",
          status: "active",
          createdAt: new Date("2026-06-11T00:00:00.000Z"),
          lastUsedAt: null,
          scheduleIds: [],
          watchGlobs: ["/slack/channels/C123/messages/**"],
          inputValues: {},
          personaVersionSpec: {
            agent: {
              triggers: {
                slack: [{ on: "message", paths: ["/slack/channels/C123/messages/**"] }],
              },
            },
          },
          deployedByUserId: auth.userId,
        },
      ],
      [],
      [],
      [
        {
          agent_id: "agent-watch",
          agent_created_at: "2026-06-11T00:00:00.000Z",
          last_successful_delivery_at: "2026-06-11T08:00:00.000Z",
          last_delivery_at: "2026-06-11T08:00:00.000Z",
          last_failed_delivery_at: null,
          recent_failed_delivery_count: "0",
          pending_delivery_count: "5",
        },
      ],
      [{ recent_failure_count: "0", latest_failure_at: null }],
    );

    const response = await GET(
      new NextRequest(`https://cloud.test/api/v1/workspaces/${workspaceId}/deployments`),
      context(),
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.agents[0]).toMatchObject({
      agentId: "agent-watch",
      status: "active",
      integrationWatchHealth: {
        status: "unhealthy",
        reason: "no_successful_delivery_recently",
        lastSuccessfulDeliveryAt: "2026-06-11T08:00:00.000Z",
        pendingDeliveryCount: 5,
        recentWorkspaceDispatchFailureCount: 0,
      },
    });
    expect(warnSpy).toHaveBeenCalledWith(
      "[deployments-list] integration watch unhealthy",
      expect.stringContaining('"reason":"no_successful_delivery_recently"'),
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [evidenceUrl, evidenceInit] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(evidenceUrl).toBe("https://nightcto.example/webhooks/cloud-runtime");
    expect(evidenceInit.method).toBe("POST");
    const evidenceHeaders = new Headers(evidenceInit.headers);
    expect(evidenceHeaders.get("authorization")).toBe("Bearer evidence-token");
    expect(evidenceHeaders.get("x-nightcto-evidence-token")).toBe("evidence-token");
    const evidence = JSON.parse(String(evidenceInit.body));
    expect(evidence).toMatchObject({
      schemaVersion: "cloud-runtime-evidence/1",
      service: "cloud-web",
      environment: "test",
      version: "test-version",
      path: "deployments.integration-watch.health",
      kind: "health",
      outcome: "error",
      severity: 6,
      requestId: `integration-watch-health:${workspaceId}:agent-watch`,
      counts: {
        errors: 1,
        messages: 5,
      },
      errorCode: "no_successful_delivery_recently",
    });
    expect(evidence.summary).toContain("customer-health");
    expect(mocks.enqueueIntegrationWatchDeliveryDrain).toHaveBeenCalledWith({
      workspaceId,
      agentId: "agent-watch",
      limit: 3,
    });
    expect(waitUntil).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it("keeps old terminal integration-watch failures from making a currently healthy agent unhealthy", async () => {
    mockDeploymentListRows(
      [
        {
          agentId: "agent-watch",
          personaId: "persona-watch",
          deployedName: "customer-health",
          status: "active",
          createdAt: new Date("2026-06-10T00:00:00.000Z"),
          lastUsedAt: null,
          scheduleIds: [],
          watchGlobs: ["/slack/channels/C123/messages/**"],
          inputValues: {},
          deployedByUserId: auth.userId,
        },
      ],
      [],
      [],
      [
        {
          agent_id: "agent-watch",
          agent_created_at: "2026-06-10T00:00:00.000Z",
          last_successful_delivery_at: new Date().toISOString(),
          last_delivery_at: new Date().toISOString(),
          last_failed_delivery_at: "2026-06-10T08:00:00.000Z",
          recent_failed_delivery_count: "0",
          pending_delivery_count: "0",
        },
      ],
      [{ recent_failure_count: "0", latest_failure_at: null }],
    );

    const response = await GET(
      new NextRequest(`https://cloud.test/api/v1/workspaces/${workspaceId}/deployments`),
      context(),
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.agents[0].integrationWatchHealth).toMatchObject({
      status: "healthy",
      reason: null,
      recentFailedDeliveryCount: 0,
      lastFailedDeliveryAt: "2026-06-10T08:00:00.000Z",
    });
  });

  it("reports old never-confirmed integration-watch agents as unknown instead of lapsed", async () => {
    mockDeploymentListRows(
      [
        {
          agentId: "agent-idle",
          personaId: "persona-idle",
          deployedName: "quiet-channel-watch",
          status: "active",
          createdAt: new Date("2026-06-10T00:00:00.000Z"),
          lastUsedAt: null,
          scheduleIds: [],
          watchGlobs: ["/slack/channels/CQUIET/messages/**"],
          inputValues: {},
          deployedByUserId: auth.userId,
        },
      ],
      [],
      [],
      [
        {
          agent_id: "agent-idle",
          agent_created_at: "2026-06-10T00:00:00.000Z",
          last_successful_delivery_at: null,
          last_delivery_at: null,
          last_failed_delivery_at: null,
          recent_failed_delivery_count: "0",
          pending_delivery_count: "0",
        },
      ],
      [{ recent_failure_count: "0", latest_failure_at: null }],
    );

    const response = await GET(
      new NextRequest(`https://cloud.test/api/v1/workspaces/${workspaceId}/deployments`),
      context(),
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.agents[0].integrationWatchHealth).toMatchObject({
      status: "unknown",
      reason: "awaiting_first_successful_delivery",
      lastSuccessfulDeliveryAt: null,
    });
  });

  it("extracts deployed schedule specs from legacy top-level persona version schedules", async () => {
    mockDeploymentListRows(
      [
        {
          agentId: "agent-legacy",
          personaId: "persona-legacy",
          deployedName: "legacy-digest",
          status: "active",
          createdAt: new Date("2026-05-13T08:00:00.000Z"),
          lastUsedAt: null,
          scheduleIds: ["relaycron_sched_legacy"],
          inputValues: {},
          personaVersionSpec: {
            schedules: [
              {
                cronExpression: "0 * * * *",
                timezone: "UTC",
              },
            ],
          },
          deployedByUserId: auth.userId,
        },
      ],
    );

    const response = await GET(
      new NextRequest(`https://cloud.test/api/v1/workspaces/${workspaceId}/deployments`),
      context(),
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.agents[0].scheduleSpecs).toEqual([
      {
        id: "relaycron_sched_legacy",
        cronExpression: "0 * * * *",
        timezone: "UTC",
      },
    ]);
  });

  it("supports filters and cursor pagination for deployment lists", async () => {
    const rows = Array.from({ length: 101 }, (_, index) => ({
      agentId: `agent-${index}`,
      personaId: "persona-filtered",
      deployedName: `agent-${index}`,
      status: "active",
      createdAt: new Date(Date.UTC(2026, 4, 13, 8, index)),
      lastUsedAt: index === 0 ? new Date("2026-05-13T09:00:00.000Z") : null,
      scheduleIds: [],
      inputValues: {},
      deployedByUserId: auth.userId,
    }));
    mockDeploymentListRows(rows);
    const url = new URL(`https://cloud.test/api/v1/workspaces/${workspaceId}/deployments`);
    url.searchParams.set("status", "active");
    url.searchParams.set("personaId", "persona-filtered");

    const response = await GET(new NextRequest(url), context());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.agents).toHaveLength(100);
    expect(payload.agents[0].status).toBe("active");
    expect(payload.nextCursor).toEqual(expect.any(String));

    mockDeploymentListRows([]);
    url.searchParams.set("cursor", payload.nextCursor);
    const executeCallsBeforeEmptyPage = mocks.db.execute.mock.calls.length;
    const cursorResponse = await GET(new NextRequest(url), context());
    const cursorPayload = await cursorResponse.json();
    expect(cursorResponse.status).toBe(200);
    expect(cursorPayload).toEqual({ agents: [], nextCursor: null });
    expect(mocks.db.execute).toHaveBeenCalledTimes(executeCallsBeforeEmptyPage);
  });

  it("rejects unauthenticated deployment list requests", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce(null);

    const response = await GET(
      new NextRequest(`https://cloud.test/api/v1/workspaces/${workspaceId}/deployments`),
      context(),
    );

    expect(response.status).toBe(401);
    expect(mocks.db.select).not.toHaveBeenCalled();
  });

  it("returns 201 with status=ready for a valid persona and bundle (cold-start runtime)", async () => {
    // Deploy POST is now a pure metadata operation: persona/version/agent
    // rows + initial deployment record. No Daytona sandbox provisioning.
    // The tick handler provisions on-demand at trigger fire — its tests
    // own the sandbox/runtime assertions that used to live here.
    mocks.resolveProviderCredentialRuntimeEnv.mockResolvedValueOnce({
      env: { ANTHROPIC_API_KEY: "sk-ant-runtime" },
      credentials: [{
        provider: "anthropic",
        providerCredentialId: "credential-anthropic",
        authType: "byo_api_key",
        envVar: "ANTHROPIC_API_KEY",
      }],
    });
    queueExecuteRows([
      [], // upsertPersona
      [],
      [{ id: "version-1", version: 1 }],
      [],
      [{ id: "agent-1" }],
      [],
      [{ id: "deployment-1" }],
    ]);

    const response = await POST(
      request(body({
        credentialSelections: { anthropic: "credential-anthropic" },
        summary: { imageUrl: "https://cdn.example/personas/weekly-digest/card-sm.png" },
      }), relayWorkspaceId),
      context({ workspaceId: relayWorkspaceId }),
    );

    expect(response.status).toBe(201);
    expect(mocks.resolveWorkspaceIntegrationIdentity).toHaveBeenCalledWith(relayWorkspaceId);
    await expect(response.json()).resolves.toEqual({
      agentId: "agent-1",
      workspaceId,
      status: "ready",
      deploymentId: "deployment-1",
      recycledSandboxes: 1,
    });
    // No sandbox is provisioned at deploy time anymore.
    expect(mocks.daytona.create).not.toHaveBeenCalled();
    // Credential resolution still fires (fail-fast on missing creds).
    expect(mocks.resolveProviderCredentialRuntimeEnv).toHaveBeenCalledWith({
      workspaceId,
      userId: auth.userId,
      credentialSelections: { anthropic: "credential-anthropic" },
    });
    const executedSql = mocks.db.execute.mock.calls.map(([query]) => sqlText(query)).join("\n");
    const executeCallsJson = JSON.stringify(mocks.db.execute.mock.calls);
    expect(executedSql).toContain("image_url");
    expect(executeCallsJson).toContain("https://cdn.example/personas/weekly-digest/card-sm.png");
    // Audit fires with sandboxId: null since no sandbox was created.
    expect(mocks.recordPersonaBundleDeploymentCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        personaId: "weekly-digest",
        agentId: "agent-1",
        deploymentId: "deployment-1",
        sandboxId: null,
      }),
    );
  });

  it("returns 404 without running deploy work when workspace resolution throws", async () => {
    mocks.resolveWorkspaceIntegrationIdentity.mockRejectedValueOnce(
      new Error("relay workspace binding lookup failed"),
    );

    const response = await POST(
      request(body(), relayWorkspaceId),
      context({ workspaceId: relayWorkspaceId }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "workspace_not_found" });
    // Resolution fails before any DB / bundle / credential work runs.
    expect(mocks.db.execute).not.toHaveBeenCalled();
    expect(mocks.storeBundle).not.toHaveBeenCalled();
    expect(mocks.credentialStoreRetrieve).not.toHaveBeenCalled();
    expect(mocks.resolveProviderCredentialRuntimeEnv).not.toHaveBeenCalled();
  });

  it("rejects invalid summary image URLs", async () => {
    const response = await POST(
      request(body({ summary: { imageUrl: "javascript:alert(1)" } })),
      context(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid_request",
      error: "summary.imageUrl must be an http(s) URL",
    });
    expect(mocks.db.execute).not.toHaveBeenCalled();
  });

  it("deploys top-level agent listeners and persists a trigger-free persona", async () => {
    queueExecuteRows([
      [], // upsertPersona
      [],
      [{ id: "version-1", version: 1 }],
      [],
      [{ id: "agent-1" }],
      [],
      [{ id: "deployment-1" }],
    ]);

    const response = await POST(
      request(
        body({
          persona: {
            id: "weekly-digest",
            intent: "review",
            slug: "weekly-digest",
            inputs: {},
            integrations: {
              github: { source: { kind: "workspace" }, scope: { repos: "AgentWorkforce/cloud" } },
            },
          },
          agent: agent({
            triggers: {
              github: [{ on: "pull_request.opened" }],
            },
            schedules: [{ name: "daily", cron: "0 9 * * *", tz: "Europe/Oslo" }],
            watch: [{ paths: ["/github/repos/AgentWorkforce/cloud/pulls/**"], events: ["updated"] }],
          }),
        }),
      ),
      context(),
    );

    expect(response.status).toBe(201);
    expect(mocks.parseAgentSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        triggers: { github: [{ on: "pull_request.opened" }] },
      }),
      "agent",
    );
    expect(mocks.parsePersonaSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        integrations: {
          github: expect.not.objectContaining({ triggers: expect.anything() }),
        },
      }),
      "review",
    );
    expect(mocks.registerCronSchedules).toHaveBeenCalledWith(
      {
        RELAYCRON_URL: "https://relaycron.test",
        RELAYCRON_API_KEY: "relaycron-key",
      },
      expect.objectContaining({
        workspace: workspaceId,
        agentId: "agent-1",
        schedules: [{ name: "daily", cron: "0 9 * * *", tz: "Europe/Oslo" }],
      }),
    );
  });

  it("accepts sandbox false and persists it in the deployment snapshot", async () => {
    queueExecuteRows([
      [], // upsertPersona
      [],
      [{ id: "version-1", version: 1 }],
      [],
      [{ id: "agent-1" }],
      [],
      [{ id: "deployment-1" }],
    ]);

    const sandboxlessPersona = {
      id: "linear-chat-lead",
      intent: "review",
      slug: "linear-chat-lead",
      inputs: {},
      sandbox: false,
      integrations: {
        linear: { source: { kind: "workspace" } },
      },
    };
    mocks.parsePersonaSpec.mockImplementationOnce((value: unknown) => {
      expect(value).toEqual(expect.not.objectContaining({ sandbox: expect.anything() }));
      return { ...(value as Record<string, unknown>) };
    });

    const response = await POST(
      request(
        body({
          persona: sandboxlessPersona,
          agent: agent({
            triggers: {
              linear: [{ on: "AgentSessionEvent.prompted" }],
            },
          }),
        }),
      ),
      context(),
    );

    expect(response.status).toBe(201);
    expect(mocks.parsePersonaSpec).toHaveBeenCalledWith(expect.any(Object), "review");
    const executedSql = mocks.db.execute.mock.calls.map(([query]) => sqlText(query)).join("\n");
    const executeCallsJson = JSON.stringify(mocks.db.execute.mock.calls);
    expect(executedSql).toContain("INSERT INTO persona_versions");
    expect(executeCallsJson).toContain('\\"sandbox\\":false');
    expect(executeCallsJson).toContain('\\"persona\\":{\\"id\\":\\"linear-chat-lead\\"');
  });

  it("loudly fails the deploy when the cloud parser drops a declared cloud-owned capability (teamSolve)", async () => {
    // persona-kit < 3.0.42 flat-drops the cloud-only `teamSolve` at parse. We no
    // longer silently re-attach it (cloud#1729 — that backstop MASKED the
    // team-N=1 root cause for weeks). Instead the deploy fails loudly so a strip
    // regression is observable rather than papered over. See cloud#1732.
    const teamSolvePersona = {
      id: "cloud-team-issue",
      intent: "relay-orchestrator",
      slug: "cloud-team-issue",
      inputs: {},
      integrations: { github: { source: { kind: "workspace" } } },
      capabilities: {
        teamSolve: { enabled: true, maxMembers: 1 },
      },
    };
    // Simulate a pre-3.0.42 parser that strips the cloud-owned capability.
    mocks.parsePersonaSpec.mockImplementationOnce((value: unknown) => {
      const record = { ...(value as Record<string, unknown>) };
      if (record.capabilities && typeof record.capabilities === "object") {
        const caps = { ...(record.capabilities as Record<string, unknown>) };
        delete caps.teamSolve;
        record.capabilities = Object.keys(caps).length > 0 ? caps : undefined;
      }
      return record;
    });

    const response = await POST(
      request(
        body({
          persona: teamSolvePersona,
          agent: agent({ triggers: { github: [{ on: "issues.labeled" }] } }),
        }),
      ),
      context(),
    );

    expect(response.status).toBe(500);
    const json = (await response.json()) as { code?: string };
    expect(json.code).toBe("capability_strip_regression");
    // Fail-closed BEFORE persisting — no stripped persona is written.
    const executedSql = mocks.db.execute.mock.calls
      .map(([query]) => sqlText(query))
      .join("\n");
    expect(executedSql).not.toContain("INSERT INTO persona_versions");
  });

  it("persists a declared cloud-owned capability (teamSolve) when the parser preserves it, and ignores non-cloud-owned dropped keys", async () => {
    queueExecuteRows([
      [], // upsertPersona
      [],
      [{ id: "version-1", version: 1 }],
      [],
      [{ id: "agent-1" }],
      [],
      [{ id: "deployment-1" }],
    ]);

    const teamSolvePersona = {
      id: "cloud-team-issue",
      intent: "relay-orchestrator",
      slug: "cloud-team-issue",
      inputs: {},
      integrations: { github: { source: { kind: "workspace" } } },
      capabilities: {
        teamSolve: { enabled: true, maxMembers: 1 },
        parserRejected: { enabled: true },
      },
    };
    // persona-kit >= 3.0.42 PRESERVES the declared cloud-owned `teamSolve`
    // (workforce#183), so the cloud persists it natively with no re-attach. It
    // still drops the unknown `parserRejected` (not cloud-owned) — the detector
    // must NOT fire for that, only for stripped CLOUD_OWNED keys.
    mocks.parsePersonaSpec.mockImplementationOnce((value: unknown) => {
      const record = { ...(value as Record<string, unknown>) };
      if (record.capabilities && typeof record.capabilities === "object") {
        const caps = { ...(record.capabilities as Record<string, unknown>) };
        delete caps.parserRejected; // teamSolve preserved (3.0.42 behavior)
        record.capabilities = Object.keys(caps).length > 0 ? caps : undefined;
      }
      return record;
    });

    const response = await POST(
      request(
        body({
          persona: teamSolvePersona,
          agent: agent({ triggers: { github: [{ on: "issues.labeled" }] } }),
        }),
      ),
      context(),
    );

    expect(response.status).toBe(201);
    const executeCallsJson = JSON.stringify(mocks.db.execute.mock.calls);
    expect(executeCallsJson).toContain('\\"teamSolve\\"');
    expect(executeCallsJson).toContain('\\"maxMembers\\":1');
    expect(executeCallsJson).not.toContain('\\"parserRejected\\"');
  });

  it("reads sandbox false back from the persisted deployment snapshot", async () => {
    mocks.db.execute.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-1",
          deployed_name: "linear-chat-lead",
          deployed_by_user_id: "user-1",
          input_values: {},
          credential_selections: {},
          spec_hash_at_deploy: "spec-hash",
          status: "active",
          schedule_webhook_secret_hash: null,
          pv_bundle_sha256: "bundle-sha",
          pv_spec: {
            sandbox: false,
            persona: {
              id: "linear-chat-lead",
              intent: "review",
              sandbox: false,
            },
            agent: {
              triggers: { linear: [{ on: "AgentSessionEvent.prompted" }] },
            },
          },
          persona_slug: "linear-chat-lead",
          p_spec: null,
        },
      ],
    });

    await expect(getAgentDeploymentTickTarget({
      workspaceId,
      agentId: "agent-1",
    })).resolves.toMatchObject({
      agentId: "agent-1",
      spec: { sandbox: false },
      agentSpec: {
        triggers: { linear: [{ on: "AgentSessionEvent.prompted" }] },
      },
    });
  });

  it("keeps existing snapshots sandbox-on by default when sandbox is absent", async () => {
    mocks.db.execute.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-1",
          deployed_name: "weekly-digest",
          deployed_by_user_id: "user-1",
          input_values: {},
          credential_selections: {},
          spec_hash_at_deploy: "spec-hash",
          status: "active",
          schedule_webhook_secret_hash: null,
          pv_bundle_sha256: "bundle-sha",
          pv_spec: {
            persona: { id: "weekly-digest", intent: "review" },
            agent: { triggers: { github: [{ on: "pull_request.opened" }] } },
          },
          persona_slug: "weekly-digest",
          p_spec: null,
        },
      ],
    });

    const target = await getAgentDeploymentTickTarget({
      workspaceId,
      agentId: "agent-1",
    });

    expect(target?.spec).not.toHaveProperty("sandbox");
  });

  it("deploys issue resolver agent triggers from the top-level agent block", async () => {
    queueExecuteRows([
      [], // upsertPersona
      [],
      [{ id: "version-1", version: 1 }],
      [],
      [{ id: "agent-1" }],
      [],
      [{ id: "deployment-1" }],
    ]);

    const issueResolverAgent = agent({
      triggers: {
        github: [
          {
            on: "issues.opened",
            paths: ["/github/repos/AgentWorkforce/cloud/issues/**"],
          },
          {
            on: "issues.labeled",
            paths: ["/github/repos/AgentWorkforce/cloud/issues/**"],
          },
        ],
        slack: [
          {
            on: "message",
            paths: ["/slack/channels/proj-cloud/messages/**"],
          },
        ],
      },
    });
    const expectedWatchGlobs = [
      "/github/repos/AgentWorkforce/cloud/issues/**",
      "/slack/channels/proj-cloud/messages/**",
    ];
    const issueResolverPersona = {
      id: "cloud-small-issue-codex",
      intent: "review",
      slug: "cloud-small-issue-codex",
      inputs: {},
      integrations: {
        github: { source: { kind: "workspace" } },
        slack: { source: { kind: "workspace" }, scope: { channel: "proj-cloud" } },
      },
    };

    const response = await POST(
      request(body({ persona: issueResolverPersona, agent: issueResolverAgent })),
      context(),
    );

    expect(response.status).toBe(201);
    expect(mocks.parseAgentSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        triggers: issueResolverAgent.triggers,
      }),
      "agent",
    );
    expect(mocks.parsePersonaSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        integrations: {
          github: expect.not.objectContaining({ triggers: expect.anything() }),
          slack: expect.not.objectContaining({ triggers: expect.anything() }),
        },
      }),
      "review",
    );
    expect(
      translatePersonaTriggersToWatchGlobs(
        issueResolverPersona as never,
        issueResolverAgent as never,
      ),
    ).toEqual(expectedWatchGlobs);
    const executedSql = mocks.db.execute.mock.calls.map(([query]) => sqlText(query)).join("\n");
    expect(executedSql).toContain("INSERT INTO persona_versions");
    expect(executedSql).toContain("delivery_max_concurrency");
    expect(executedSql).toContain("INSERT INTO agent_deployments");
  });

  it("rejects conflicting legacy listener fields when top-level agent is present", async () => {
    const response = await POST(
      request(
        body({
          persona: {
            id: "weekly-digest",
            intent: "review",
            slug: "weekly-digest",
            inputs: {},
            integrations: {
              github: { triggers: [{ on: "issues.opened" }] },
            },
          },
          agent: agent({
            triggers: {
              github: [{ on: "pull_request.opened" }],
            },
          }),
        }),
      ),
      context(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid_persona",
      details: [
        expect.objectContaining({
          path: "integrations.github.triggers",
        }),
      ],
    });
    expect(mocks.parseAgentSpec).not.toHaveBeenCalled();
  });

  it("validates legacy listener fallback through parseAgentSpec when top-level agent is absent", async () => {
    mocks.parseAgentSpec.mockImplementationOnce(() => {
      throw { issues: [{ path: ["triggers", "github", 0], message: "invalid legacy trigger" }] };
    });

    const response = await POST(
      request(
        body({
          persona: persona({
            integrations: {
              github: { triggers: [{ on: "" }] },
            },
          }),
        }),
      ),
      context(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid_persona",
      details: [
        expect.objectContaining({
          path: "triggers.github.0",
          message: "invalid legacy trigger",
        }),
      ],
    });
    expect(mocks.parseAgentSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        triggers: {
          github: [{ on: "" }],
        },
      }),
      "agent",
    );
    expect(mocks.parsePersonaSpec).not.toHaveBeenCalled();
  });

  it("keeps agentId stable when re-deploying the same persona spec", async () => {
    queueExecuteRows([
      [], // upsertPersona
      [{ id: "version-1", version: 1 }], // persistPersonaVersion SELECT
      [], // persistPersonaVersion UPDATE bundle_sha256 (refreshed on every re-deploy)
      [{ id: "agent-stable" }],
      [],
      [],
      [{ id: "deployment-2" }],
    ]);

    const response = await POST(request(body()), context());

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      agentId: "agent-stable",
      deploymentId: "deployment-2",
    });
    // +1 for upsertPersona, +1 for the bundle_sha256 refresh UPDATE.
    expect(mocks.db.execute).toHaveBeenCalledTimes(7);
    expect(
      mocks.db.execute.mock.calls
        .map(([query]) => sqlText(query))
        .filter((query) => query.includes("INSERT INTO persona_versions")),
    ).toHaveLength(0);
  });

  it("inherits existing input values on redeploy while letting new values override them", async () => {
    queueExecuteRows([
      [], // upsertPersona
      [{ id: "version-1", version: 1 }], // persistPersonaVersion SELECT
      [], // persistPersonaVersion UPDATE bundle_sha256
      [{
        id: "agent-stable",
        schedule_ids: [],
        input_values: {
          SLACK_CHANNEL: "C0123ABCD",
          TOPICS: "old topics",
          UNCHANGED: "still here",
        },
      }],
      [], // update existing agent
      [], // update schedule state
      [{ id: "deployment-2" }],
    ]);

    const response = await POST(
      request(body({ inputs: { TOPICS: "agents,ai" } })),
      context(),
    );

    expect(response.status).toBe(201);
    const executeCallsJson = JSON.stringify(mocks.db.execute.mock.calls);
    expect(executeCallsJson).toContain('\\"SLACK_CHANNEL\\":\\"C0123ABCD\\"');
    expect(executeCallsJson).toContain('\\"TOPICS\\":\\"agents,ai\\"');
    expect(executeCallsJson).toContain('\\"UNCHANGED\\":\\"still here\\"');
    expect(executeCallsJson).not.toContain('\\"TOPICS\\":\\"old topics\\"');
  });

  it("recycles all warm deployment sandboxes from the cursor-backed Daytona iterator after redeploy", async () => {
    const sandboxPage1 = {
      ...mocks.sandbox,
      id: "sbx_warm_page_1",
      state: "STARTED",
      getUserHomeDir: vi.fn(async () => "/home/daytona"),
    };
    const sandboxStopped = {
      ...mocks.sandbox,
      id: "sbx_stopped",
      state: "STOPPED",
      getUserHomeDir: vi.fn(async () => "/home/daytona"),
    };
    const sandboxPage2 = {
      ...mocks.sandbox,
      id: "sbx_warm_page_2",
      state: "STARTED",
      getUserHomeDir: vi.fn(async () => "/home/daytona"),
    };
    mocks.daytona.list.mockImplementationOnce(() => sandboxList([sandboxStopped, sandboxPage1, sandboxPage2]));
    queueExecuteRows([
      [], // upsertPersona
      [{ id: "version-1", version: 1 }], // existing version
      [], // refresh bundle hash
      [{ id: "agent-stable" }],
      [],
      [],
      [{ id: "deployment-recycle" }],
    ]);

    const response = await POST(request(body()), context());

    expect(response.status).toBe(201);
    expect(mocks.daytona.list).toHaveBeenCalledWith({
      labels: {
        purpose: "workforce-deploy",
        workspaceId,
        agentId: "agent-stable",
      },
      limit: 50,
      states: ["started"],
    });
    expect(mocks.daytona.delete).toHaveBeenCalledTimes(2);
    expect(mocks.daytona.delete).toHaveBeenCalledWith(sandboxPage1);
    expect(mocks.daytona.delete).toHaveBeenCalledWith(sandboxPage2);
  });

  it("treats redeploy sandbox recycle as a no-op when no warm sandbox exists", async () => {
    mocks.daytona.list.mockImplementationOnce(() => sandboxList([]));
    queueExecuteRows([
      [], // upsertPersona
      [{ id: "version-1", version: 1 }], // existing version
      [], // refresh bundle hash
      [{ id: "agent-stable" }],
      [],
      [],
      [{ id: "deployment-noop-recycle" }],
    ]);

    const response = await POST(request(body()), context());

    expect(response.status).toBe(201);
    expect(mocks.daytona.list).toHaveBeenCalledWith({
      labels: {
        purpose: "workforce-deploy",
        workspaceId,
        agentId: "agent-stable",
      },
      limit: 50,
      states: ["started"],
    });
    expect(mocks.daytona.delete).not.toHaveBeenCalled();
  });

  it("keeps a committed deploy when one warm sandbox delete fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sandboxOk = {
      ...mocks.sandbox,
      id: "sbx_delete_ok",
      state: "STARTED",
      getUserHomeDir: vi.fn(async () => "/home/daytona"),
    };
    const sandboxFailed = {
      ...mocks.sandbox,
      id: "sbx_delete_failed",
      state: "STARTED",
      getUserHomeDir: vi.fn(async () => "/home/daytona"),
    };
    mocks.daytona.list.mockImplementationOnce(() => sandboxList([sandboxOk, sandboxFailed]));
    mocks.daytona.delete.mockImplementation(async (sandbox: { id: string }) => {
      if (sandbox.id === "sbx_delete_failed") {
        throw new Error("delete failed");
      }
    });
    queueExecuteRows([
      [], // upsertPersona
      [{ id: "version-1", version: 1 }], // existing version
      [], // refresh bundle hash
      [{ id: "agent-stable" }],
      [],
      [],
      [{ id: "deployment-partial-recycle" }],
    ]);

    try {
      const response = await POST(request(body()), context());

      expect(response.status).toBe(201);
      const payload = await response.json();
      expect(payload).toMatchObject({
        agentId: "agent-stable",
        deploymentId: "deployment-partial-recycle",
        recycledSandboxes: 1,
        recycleWarning: expect.stringContaining("Daytona sandbox recycle failed"),
      });
      expect(payload.recycleWarning).toContain("new bundle will not take effect until that sandbox is gone");
      expect(warn).toHaveBeenCalledWith(
        "[persona-bundle-deploy] warm sandbox recycle failed after deploy commit; stale warm sandbox persists, so the new bundle will not take effect until that sandbox is gone",
        expect.objectContaining({
          workspaceId,
          agentId: "agent-stable",
          failedSandboxIds: ["sbx_delete_failed"],
        }),
      );
      expect(mocks.daytona.delete).toHaveBeenCalledTimes(2);
      expect(
        mocks.db.execute.mock.calls
          .map(([query]) => sqlText(query))
          .some((query) => query.includes("DELETE FROM agent_deployments")),
      ).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps a committed deploy when warm sandbox recycle fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.daytona.list.mockImplementationOnce(() => {
      throw new Error("daytona list failed");
    });
    queueExecuteRows([
      [], // upsertPersona
      [{ id: "version-1", version: 1 }], // existing version
      [], // refresh bundle hash
      [{ id: "agent-stable" }],
      [],
      [],
      [{ id: "deployment-recycle-warning" }],
    ]);

    try {
      const response = await POST(request(body()), context());

      expect(response.status).toBe(201);
      const payload = await response.json();
      expect(payload).toMatchObject({
        agentId: "agent-stable",
        deploymentId: "deployment-recycle-warning",
        recycledSandboxes: 0,
        recycleWarning: expect.stringContaining("Daytona sandbox recycle failed"),
      });
      expect(payload.recycleWarning).toContain("new bundle will not take effect until that sandbox is gone");
      expect(warn).toHaveBeenCalledWith(
        "[persona-bundle-deploy] warm sandbox recycle failed after deploy commit; stale warm sandbox persists, so the new bundle will not take effect until that sandbox is gone",
        expect.objectContaining({
          workspaceId,
          agentId: "agent-stable",
          error: "daytona list failed",
        }),
      );
      expect(
        mocks.db.execute.mock.calls
          .map(([query]) => sqlText(query))
          .some((query) => query.includes("DELETE FROM agent_deployments")),
      ).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("inserts a new persona version when the spec hash changes", async () => {
    queueExecuteRows([
      [], // upsertPersona
      [],
      [{ id: "version-2", version: 2 }],
      [{ id: "agent-stable" }],
      [],
      [],
      [{ id: "deployment-3" }],
    ]);

    const response = await POST(
      request(body({ persona: persona({ name: "Weekly Digest v2" }) })),
      context(),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      agentId: "agent-stable",
      deploymentId: "deployment-3",
    });
    expect(
      mocks.db.execute.mock.calls
        .map(([query]) => sqlText(query))
        .filter((query) => query.includes("INSERT INTO persona_versions")),
    ).toHaveLength(1);
  });

  it("rejects invalid personas before DB writes or sandbox creation", async () => {
    const response = await POST(
      request(body({ persona: persona({ traits: { tone: "friendly" } }) })),
      context(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid_persona",
      details: [{ path: "traits", message: "traits was removed in v1" }],
    });
    expect(mocks.db.execute).not.toHaveBeenCalled();
    expect(mocks.daytona.create).not.toHaveBeenCalled();
  });

  it("accepts memory specs loudly as a deploy v1 runtime no-op", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      queueExecuteRows([
        [], // upsertPersona
        [],
        [{ id: "version-memory", version: 1 }],
        [],
        [{ id: "agent-memory" }],
        [],
        [{ id: "deployment-memory" }],
      ]);

      const response = await POST(
        request(body({ persona: persona({ memory: { provider: "local" } }) })),
        context(),
      );

      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toMatchObject({
        agentId: "agent-memory",
        deploymentId: "deployment-memory",
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("persona.memory is accepted"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("fails with field-pointed schema errors from persona-kit", async () => {
    // Wrong-typed inputs (string instead of an object) should still fail
    // with a path-pointed validation error. An absent inputs field is
    // covered by the "deploys a persona with no inputs" test below.
    const response = await POST(
      request(body({ persona: { id: "wrong-typed-inputs", intent: "review", integrations: {}, inputs: "not-an-object" } })),
      context(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid_persona",
      details: [{ path: "inputs", message: "persona.inputs must be an object" }],
    });
    expect(mocks.db.execute).not.toHaveBeenCalled();
    expect(mocks.daytona.create).not.toHaveBeenCalled();
  });

  it("accepts Slack app mentions as watchforce triggers", async () => {
    const response = await POST(
      request(body({
        persona: persona({
          integrations: {
            slack: { triggers: [{ on: "app_mention" }] },
          },
        }),
      })),
      context(),
    );

    expect(response.status).not.toBe(400);
  });

  it("accepts a persona with no inputs at the validation gate (inputs is optional per persona-kit schema)", async () => {
    // Regression for a real customer-flow blocker: persona-kit's
    // `parsePersonaSpec` normalizes an empty `inputs: {}` field away
    // (returns the parsed object with `inputs: undefined`), so cloud
    // ALWAYS saw `undefined` for personas that declared no runtime
    // parameters. The old required-record check then rejected every
    // input-less persona with `persona.inputs is required`. Validator
    // now matches the schema: optional, but wrong-type still fails.
    //
    // This test asserts only that the persona validation gate doesn't
    // return 400 with the inputs-required code; downstream mocking
    // varies between scenarios and is exercised in the happy-path
    // tests above.
    const response = await POST(
      request(body({
        persona: persona({ id: "no-inputs", inputs: undefined }) as Record<string, unknown>,
      })),
      context(),
    );

    // The minimal test setup doesn't fully mock the downstream sandbox
    // path, so the response may be 500 from a later step. We only care
    // that the validation gate did NOT reject this with `invalid_persona`
    // / `persona.inputs is required` — the absent-inputs path must
    // pass the gate cleanly even if downstream mocks are incomplete.
    if (response.status === 400) {
      const payload = (await response.json()) as { code?: string; details?: Array<{ path?: string }> };
      expect(payload.code).not.toBe("invalid_persona");
      const inputsErr = payload.details?.find((d) => d.path === "inputs");
      expect(inputsErr).toBeUndefined();
    }
  });

  it("translates known provider triggers to RelayFile watch globs", () => {
    expect(
      translatePersonaTriggersToWatchGlobs(
        persona({
          integrations: {
            github: { triggers: [{ on: "pull_request.opened" }] },
            gitlab: { triggers: [{ on: "merge_request.opened" }] },
            linear: { triggers: [{ on: "issue.created" }] },
            slack: { triggers: [{ on: "app_mention" }] },
            confluence: { triggers: [{ on: "page.updated" }] },
            notion: { triggers: [{ on: "database.updated" }] },
            jira: { triggers: [{ on: "issue.created" }] },
            "google-mail": { triggers: [{ on: "message.changed" }] },
            "google-calendar": { triggers: [{ on: "event.changed" }] },
            x: { triggers: [{ on: "post.created" }] },
          },
        }) as never,
      ),
    ).toEqual([
      "/confluence/pages/**",
      "/confluence/spaces/**/pages/**",
      "/github/repos/**/**/pulls/**",
      "/gitlab/projects/**/merge_requests/**",
      "/google-calendar/calendars/**/events/**",
      "/google-calendar/events/**",
      "/google-mail/messages/**",
      "/jira/issues/**",
      "/linear/issues/**",
      "/notion/databases/**",
      "/notion/pages/**",
      "/slack/channels/**",
      "/slack/users/**/messages/**",
      "/x/**",
    ]);
  });

  it("translates top-level agent triggers without reading legacy persona triggers", () => {
    expect(
      translatePersonaTriggersToWatchGlobs(
        persona({
          integrations: {
            github: { triggers: [{ on: "issues.opened" }] },
          },
        }) as never,
        {
          triggers: {
            github: [{ on: "pull_request.opened" }],
          },
        } as never,
      ),
    ).toEqual(["/github/repos/**/**/pulls/**"]);
  });

  it("requires a persona integration connection for agent trigger providers", () => {
    expect(() =>
      translatePersonaTriggersToWatchGlobs(
        persona({ integrations: {} }) as never,
        {
          triggers: {
            github: [{ on: "pull_request.opened" }],
          },
        } as never,
      ),
    ).toThrow(/requires a matching persona\.integrations\.github/);
  });

  it.each(["message.channels", "message.groups", "message.im", "message.mpim"])(
    "rejects Slack %s as a watchforce proactive trigger",
    (triggerName) => {
      expect(() =>
        translatePersonaTriggersToWatchGlobs(
          persona({
            integrations: {
              slack: { triggers: [{ on: triggerName }] },
            },
          }) as never,
        ),
      ).toThrow(/Use 'app_mention'/);
    },
  );

  it("accepts newly added provider trigger actions without a path lookup edit", () => {
    expect(
      translatePersonaTriggersToWatchGlobs(
        persona({
          integrations: {
            github: {
              triggers: [{ on: "pull_request.labeled" }, { on: "issues.labeled" }],
            },
          },
        }) as never,
      ),
    ).toEqual([
      "/github/repos/**/**/issues/**",
      "/github/repos/**/**/pulls/**",
    ]);
  });

  it("accepts adapter-catalog triggers without adding local resource aliases", () => {
    for (const trigger of DEFAULT_GITHUB_EVENTS) {
      expect(() =>
        translatePersonaTriggersToWatchGlobs(
          persona({
            integrations: {
              github: { triggers: [{ on: trigger }] },
            },
          }) as never,
        ),
      ).not.toThrow();
    }

    for (const trigger of Object.keys(GITLAB_EVENT_MAP)) {
      expect(() =>
        translatePersonaTriggersToWatchGlobs(
          persona({
            integrations: {
              gitlab: { triggers: [{ on: trigger }] },
            },
          }) as never,
        ),
      ).not.toThrow();
    }
  });

  it("derives narrow relayfile mount paths from integration scopes", () => {
    expect(
      deriveRelayfileMountPaths(
        persona({
          integrations: {
            github: {
              scope: { repos: "AgentWorkforce/proactive-agents" },
              triggers: [{ on: "issues.opened" }],
            },
          },
        }) as never,
      ),
    ).toContain("/github/repos/AgentWorkforce/proactive-agents/**");
  });

  it("derives narrow Slack DM user-message mount paths from user scopes", () => {
    expect(
      [
        ...deriveRelayfileMountPaths(
          persona({
            integrations: {
              slack: {
                scope: { users: "U123/messages" },
                triggers: [{ on: "message.created" }],
              },
            },
          }) as never,
        ),
      ].sort(),
    ).toEqual(
      [
        "/slack/channels/**/messages/**",
        "/slack/users/**/messages/**",
        "/slack/users/U123/messages/**",
        // self-describing companions auto-included for any mounted provider
        "/slack/LAYOUT.md",
        "/slack/_index.json",
      ].sort(),
    );
  });

  it("auto-includes the provider LAYOUT.md + _index.json so a scoped mount stays self-describing", () => {
    const paths = deriveRelayfileMountPaths(
      persona({
        integrations: {
          linear: { scope: { issues: "/linear/issues/**" } },
        },
      }) as never,
    );
    expect(paths).toContain("/linear/issues/**");
    expect(paths).toContain("/linear/LAYOUT.md");
    expect(paths).toContain("/linear/_index.json");
    // companions are for mounted relayfile providers only — never /memory
    expect(paths).not.toContain("/memory/LAYOUT.md");
  });

  it("expands a bare provider-root scope into the provider's concrete resource subtrees", () => {
    const paths = deriveRelayfileMountPaths(
      persona({
        // an author's "just mount everything for linear" — the path scope key
        // takes a raw provider path.
        integrations: { linear: { scope: { path: "/linear/**" } } },
      }) as never,
    );
    // the bare provider root is dropped by the mirror, so it must NOT survive…
    expect(paths).not.toContain("/linear/**");
    // …it's replaced with the adapter's real resource globs (which DO mount).
    expect(paths).toContain("/linear/issues/**");
    // every expanded entry is a concrete subtree, never another bare root.
    expect(paths.every((path) => !/^\/[^/]+\/\*\*$/u.test(path))).toBe(true);
    // …and the self-describing companions still come along.
    expect(paths).toContain("/linear/LAYOUT.md");
  });

  it("derives trigger mount paths from top-level agent triggers only when provided", () => {
    expect(
      [
        ...deriveRelayfileMountPaths(
          persona({
            integrations: {
              github: {
                scope: { repos: "AgentWorkforce/proactive-agents" },
                triggers: [{ on: "issues.opened" }],
              },
            },
          }) as never,
          {
            triggers: {
              github: [{ on: "pull_request.opened" }],
            },
          } as never,
        ),
      ].sort(),
    ).toEqual(
      [
        "/github/repos/**/**/pulls/**",
        "/github/repos/AgentWorkforce/proactive-agents/**",
        // self-describing companions auto-included for any mounted provider
        "/github/LAYOUT.md",
        "/github/_index.json",
        "/github/repos/_index.json",
      ].sort(),
    );
  });

  it("rejects unknown integration providers with a clear 400", async () => {
    const response = await POST(
      request(
        body({
          persona: persona({
            integrations: { unknown: { triggers: [{ on: "thing.created" }] } },
          }),
        }),
      ),
      context(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "unsupported_trigger",
      error: "Unsupported integration trigger 'unknown:thing.created'",
    });
    expect(mocks.daytona.create).not.toHaveBeenCalled();
  });

  it("registers cron schedules with relaycron and persists returned schedule ids", async () => {
    queueExecuteRows([
      [], // upsertPersona
      [],
      [{ id: "version-1", version: 1 }],
      [],
      [{ id: "agent-1" }],
      [],
      [{ id: "deployment-1" }],
    ]);

    const response = await POST(
      request(
        body({
          persona: persona({
            schedules: [{ name: "daily", cron: "0 9 * * *", tz: "Europe/Oslo" }],
          }),
        }),
      ),
      context(),
    );

    expect(response.status).toBe(201);
    expect(mocks.resolveAgentGatewayRelaycronEnv).toHaveBeenCalledWith();
    expect(mocks.registerCronSchedules).toHaveBeenCalledWith(
      {
        RELAYCRON_URL: "https://relaycron.test",
        RELAYCRON_API_KEY: "relaycron-key",
      },
      expect.objectContaining({
        workspace: workspaceId,
        agentId: "agent-1",
        schedules: [{ name: "daily", cron: "0 9 * * *", tz: "Europe/Oslo" }],
        cloudBaseUrl: "https://cloud.test",
        webhookSecret: expect.stringMatching(/^.+/),
      }),
    );
    expect(mocks.db.execute.mock.calls.map(([query]) => sqlText(query)).join("\n")).toContain(
      "SET schedule_ids = ",
    );
    expect(mocks.db.execute.mock.calls.map(([query]) => sqlText(query)).join("\n")).not.toContain(
      "last_used_at = NOW()",
    );
  });

  it("rejects cron schedules that run more often than every five minutes", async () => {
    const response = await POST(
      request(
        body({
          persona: persona({
            schedules: [{ name: "too-fast", cron: "*/2 * * * *", tz: "UTC" }],
          }),
        }),
      ),
      context(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "unsupported_cron_granularity",
      error: "schedule '*/2 * * * *' runs more often than every 5 minutes",
      details: [
        {
          path: "schedules.0.cron",
          message: "cron schedules must run no more often than every 5 minutes",
        },
      ],
    });
    expect(mocks.registerCronSchedules).not.toHaveBeenCalled();
  });

  it("uses CLOUD_PUBLIC_URL for externally reachable schedule callbacks", async () => {
    process.env.CLOUD_PUBLIC_URL = "https://cloud-public.test/base";
    queueExecuteRows([
      [], // upsertPersona
      [],
      [{ id: "version-1", version: 1 }],
      [],
      [{ id: "agent-1" }],
      [],
      [{ id: "deployment-1" }],
    ]);

    const response = await POST(
      request(
        body({
          persona: persona({
            schedules: [{ name: "daily", cron: "0 9 * * *", timezone: "Europe/Oslo" }],
          }),
        }),
      ),
      context(),
    );

    expect(response.status).toBe(201);
    expect(mocks.resolveAgentGatewayRelaycronEnv).toHaveBeenCalledWith();
    expect(mocks.registerCronSchedules).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        cloudBaseUrl: "https://cloud-public.test/base",
      }),
    );
  });

  it("preserves NEXT_PUBLIC_APP_URL base paths for schedule callbacks", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://agentrelay.com/cloud";
    queueExecuteRows([
      [], // upsertPersona
      [],
      [{ id: "version-1", version: 1 }],
      [],
      [{ id: "agent-1" }],
      [],
      [{ id: "deployment-1" }],
    ]);

    const response = await POST(
      request(
        body({
          persona: persona({
            schedules: [{ name: "daily", cron: "0 9 * * *", timezone: "Europe/Oslo" }],
          }),
        }),
      ),
      context(),
    );

    expect(response.status).toBe(201);
    expect(mocks.registerCronSchedules).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        cloudBaseUrl: "https://agentrelay.com/cloud",
      }),
    );
  });

  it("reuses existing relaycron registrations during scheduled re-deploy", async () => {
    mocks.registerCronSchedules.mockResolvedValueOnce([
      {
        gatewayScheduleId: "old_relaycron_sched",
        relaycronScheduleId: "old_relaycron_sched",
        schedule: "0 9 * * *",
        scheduleType: "cron",
        timezone: "Europe/Oslo",
        createdAt: "2026-05-13T00:00:00.000Z",
        created: false,
        cronExpression: "0 9 * * *",
      },
    ]);
    queueExecuteRows([
      [], // upsertPersona
      [{ id: "version-1", version: 1 }], // persistPersonaVersion SELECT existing
      [], // persistPersonaVersion UPDATE bundle_sha256
      [{ id: "agent-stable", schedule_ids: ["old_relaycron_sched"] }],
      [],
      [],
      [{ id: "deployment-redeploy" }],
    ]);

    const response = await POST(
      request(
        body({
          persona: persona({
            schedules: [{ name: "daily", cron: "0 9 * * *", timezone: "Europe/Oslo" }],
          }),
        }),
      ),
      context(),
    );

    expect(response.status).toBe(201);
    expect(mocks.registerCronSchedules).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        existingRelaycronScheduleIds: ["old_relaycron_sched"],
      }),
    );
    expect(mocks.cancelCronSchedule).not.toHaveBeenCalled();
  });

  it("reconciles orphaned relaycron schedules by exact cloud workspace and agent metadata on re-deploy", async () => {
    const schedulePersona = {
      id: "weekly-digest",
      intent: "review",
      slug: "weekly-digest",
      inputs: {},
      integrations: { github: { source: { kind: "workspace" } } },
    };
    mocks.registerCronSchedules.mockResolvedValueOnce([
      {
        gatewayScheduleId: "relaycron_sched_current",
        relaycronScheduleId: "relaycron_sched_current",
        schedule: "0 9 * * *",
        scheduleType: "cron",
        timezone: "UTC",
        createdAt: "2026-06-12T09:00:00.000Z",
        created: true,
        cronExpression: "0 9 * * *",
      },
    ]);
    mockListCronSchedulesOnce([
      {
        id: "relaycron_sched_orphan",
        status: "active",
        metadata: {
          source: "cloud",
          workspace: workspaceId,
          agentId: "agent-stable",
        },
      },
      {
        id: "relaycron_sched_sibling",
        status: "active",
        metadata: {
          source: "cloud",
          workspace: workspaceId,
          agentId: "agent-other",
        },
      },
      {
        id: "relaycron_sched_other_workspace",
        status: "active",
        metadata: {
          source: "cloud",
          workspace: "00000000-0000-0000-0000-000000000099",
          agentId: "agent-stable",
        },
      },
      {
        id: "relaycron_sched_legacy_unknown",
        status: "active",
        metadata: null,
      },
    ]);
    queueExecuteRows([
      [], // upsertPersona
      [{ id: "version-1", version: 1 }], // persistPersonaVersion SELECT existing
      [], // persistPersonaVersion UPDATE bundle_sha256
      [{ id: "agent-stable", schedule_ids: [] }],
      [], // UPDATE agents
      [], // updateAgentScheduleState
      [{ id: "deployment-redeploy" }],
    ]);

    const response = await POST(
      request(
        body({
          persona: schedulePersona,
          agent: agent({
            schedules: [{ name: "daily", cron: "0 9 * * *", timezone: "UTC" }],
          }),
        }),
      ),
      context(),
    );

    expect(response.status).toBe(201);
    expect(mocks.listCronSchedules).toHaveBeenCalledWith(
      {
        RELAYCRON_URL: "https://relaycron.test",
        RELAYCRON_API_KEY: "relaycron-key",
      },
      expect.objectContaining({
        status: "active",
        filter: expect.any(Function),
        onPage: expect.any(Function),
      }),
    );
    expect(mocks.cancelCronSchedule).toHaveBeenCalledTimes(1);
    expect(mocks.cancelCronSchedule).toHaveBeenCalledWith(
      {
        RELAYCRON_URL: "https://relaycron.test",
        RELAYCRON_API_KEY: "relaycron-key",
      },
      "relaycron_sched_orphan",
    );
  });

  it("cleans up a relaycron orphan created by a failed update rollback before activating the replacement schedule", async () => {
    const schedulePersona = {
      id: "weekly-digest",
      intent: "review",
      slug: "weekly-digest",
      inputs: {},
      integrations: { github: { source: { kind: "workspace" } } },
    };
    mocks.registerCronSchedules
      .mockResolvedValueOnce([
        {
          gatewayScheduleId: "relaycron_sched_orphan",
          relaycronScheduleId: "relaycron_sched_orphan",
          schedule: "0 9 * * *",
          scheduleType: "cron",
          timezone: "UTC",
          createdAt: "2026-06-12T08:00:00.000Z",
          created: true,
          cronExpression: "0 9 * * *",
        },
      ])
      .mockResolvedValueOnce([
        {
          gatewayScheduleId: "relaycron_sched_current",
          relaycronScheduleId: "relaycron_sched_current",
          schedule: "0 9 * * *",
          scheduleType: "cron",
          timezone: "UTC",
          createdAt: "2026-06-12T09:00:00.000Z",
          created: true,
          cronExpression: "0 9 * * *",
        },
      ]);
    mockListCronSchedulesOnce([]);
    mockListCronSchedulesOnce([
        {
          id: "relaycron_sched_orphan",
          status: "active",
          metadata: {
            source: "cloud",
            workspace: workspaceId,
            agentId: "agent-stable",
          },
        },
        {
          id: "relaycron_sched_sibling",
          status: "active",
          metadata: {
            source: "cloud",
            workspace: workspaceId,
            agentId: "agent-other",
          },
        },
        {
          id: "relaycron_sched_legacy_unknown",
          status: "active",
          metadata: null,
        },
      ]);
    mocks.cancelCronSchedule
      .mockRejectedValueOnce(new Error("relaycron delete timed out"))
      .mockResolvedValueOnce(undefined);
    queueExecuteRows([
      [], // first upsertPersona
      [{ id: "version-1", version: 1 }], // first persistPersonaVersion SELECT existing
      [], // first persistPersonaVersion UPDATE bundle_sha256
      [{ id: "agent-stable", schedule_ids: [] }],
      [], // first UPDATE agents
      [], // first updateAgentScheduleState writes orphan id
      [], // first createInitialAgentDeployment returns no rows and triggers rollback
      [], // rollback existing agent clears schedule_ids
      [], // second upsertPersona
      [{ id: "version-1", version: 1 }], // second persistPersonaVersion SELECT existing
      [], // second persistPersonaVersion UPDATE bundle_sha256
      [{ id: "agent-stable", status: "error", schedule_ids: [] }],
      [], // second UPDATE agents
      [], // second updateAgentScheduleState writes current id
      [{ id: "deployment-redeploy" }],
    ]);

    const deployBody = body({
      persona: schedulePersona,
      agent: agent({
        schedules: [{ name: "daily", cron: "0 9 * * *", timezone: "UTC" }],
      }),
    });

    const failedResponse = await POST(request(deployBody), context());
    expect(failedResponse.status).toBe(500);

    const successfulResponse = await POST(request(deployBody), context());
    expect(successfulResponse.status).toBe(201);
    expect(mocks.cancelCronSchedule).toHaveBeenCalledTimes(2);
    expect(mocks.cancelCronSchedule.mock.calls[0][1]).toBe("relaycron_sched_orphan");
    expect(mocks.cancelCronSchedule.mock.calls[1][1]).toBe("relaycron_sched_orphan");
    expect(mocks.cancelCronSchedule.mock.calls.some((call) => call[1] === "relaycron_sched_sibling")).toBe(false);
    expect(mocks.cancelCronSchedule.mock.calls.some((call) => call[1] === "relaycron_sched_legacy_unknown")).toBe(false);
  });

  it("reconciles relaycron orphans when an error-state redeploy removes all schedules", async () => {
    const schedulePersona = {
      id: "weekly-digest",
      intent: "review",
      slug: "weekly-digest",
      inputs: {},
      integrations: { github: { source: { kind: "workspace" } } },
    };
    mocks.registerCronSchedules.mockResolvedValueOnce([]);
    mockListCronSchedulesOnce([
      {
        id: "relaycron_sched_orphan",
        status: "active",
        metadata: {
          source: "cloud",
          workspace: workspaceId,
          agentId: "agent-stable",
        },
      },
    ]);
    queueExecuteRows([
      [], // upsertPersona
      [{ id: "version-1", version: 1 }], // persistPersonaVersion SELECT existing
      [], // persistPersonaVersion UPDATE bundle_sha256
      [{ id: "agent-stable", status: "error", schedule_ids: [] }],
      [], // UPDATE agents
      [], // updateAgentScheduleState writes no schedules
      [{ id: "deployment-redeploy" }],
    ]);

    const response = await POST(
      request(
        body({
          persona: schedulePersona,
          agent: agent({ schedules: [] }),
        }),
      ),
      context(),
    );

    expect(response.status).toBe(201);
    expect(mocks.cancelCronSchedule).toHaveBeenCalledWith(
      {
        RELAYCRON_URL: "https://relaycron.test",
        RELAYCRON_API_KEY: "relaycron-key",
      },
      "relaycron_sched_orphan",
    );
  });

  it("keeps stable relaycron schedule ids without cancel churn on same-set re-deploy", async () => {
    const schedulePersona = {
      id: "weekly-digest",
      intent: "review",
      slug: "weekly-digest",
      inputs: {},
      integrations: { github: { source: { kind: "workspace" } } },
    };
    mocks.registerCronSchedules.mockResolvedValueOnce([
      {
        gatewayScheduleId: "relaycron_sched_existing",
        relaycronScheduleId: "relaycron_sched_existing",
        schedule: "0 9 * * *",
        scheduleType: "cron",
        timezone: "UTC",
        createdAt: "2026-06-12T09:00:00.000Z",
        created: false,
        cronExpression: "0 9 * * *",
      },
    ]);
    queueExecuteRows([
      [], // upsertPersona
      [{ id: "version-1", version: 1 }], // persistPersonaVersion SELECT existing
      [], // persistPersonaVersion UPDATE bundle_sha256
      [{ id: "agent-stable", schedule_ids: ["relaycron_sched_existing"] }],
      [], // UPDATE agents
      [], // updateAgentScheduleState
      [{ id: "deployment-redeploy" }],
    ]);

    const response = await POST(
      request(
        body({
          persona: schedulePersona,
          agent: agent({
            schedules: [{ name: "daily", cron: "0 9 * * *", timezone: "UTC" }],
          }),
        }),
      ),
      context(),
    );

    expect(response.status).toBe(201);
    expect(mocks.listCronSchedules).not.toHaveBeenCalled();
    expect(mocks.cancelCronSchedule).not.toHaveBeenCalled();
  });

  it("rolls back prepared deploy state when initial deployment insert fails", async () => {
    // Deploy POST no longer provisions a sandbox, so the only thing
    // that can fail post-preparePersonaDeploy is the
    // createInitialAgentDeployment write. When that fails, we roll back
    // the prepared persona/version/agent rows + relaycron schedules.
    queueExecuteRows([
      [], // upsertPersona
      [],
      [{ id: "version-1", version: 1 }],
      [],
      [{ id: "agent-1" }],
      [],
      [], // createInitialAgentDeployment returns no rows → throws
      [],
      [],
    ]);

    const response = await POST(
      request(
        body({
          persona: persona({
            schedules: [{ name: "daily", cron: "0 9 * * *", timezone: "Europe/Oslo" }],
          }),
        }),
      ),
      context(),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      code: "deployment_insert_failed",
    });
    expect(mocks.daytona.create).not.toHaveBeenCalled();
    expect(mocks.cancelCronSchedule).toHaveBeenCalledWith(
      {
        RELAYCRON_URL: "https://relaycron.test",
        RELAYCRON_API_KEY: "relaycron-key",
      },
      "relaycron_sched_1",
    );
    expect(mocks.db.execute.mock.calls.map(([query]) => sqlText(query)).join("\n")).toContain(
      "DELETE FROM agents",
    );
  });

  it("cancels just-created relaycron schedules when prepare fails after registration", async () => {
    queueExecuteRows([
      [], // upsertPersona
      [],
      [{ id: "00000000-0000-4000-8000-000000000001", version: 1 }],
      [],
      [{ id: "agent-1" }],
    ]);
    mocks.db.execute.mockRejectedValueOnce(new Error("schedule state write failed"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const uuidSpy = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000002");

    try {
      const response = await POST(
        request(
          body({
            persona: persona({
              schedules: [{ name: "daily", cron: "0 9 * * *", timezone: "Europe/Oslo" }],
            }),
          }),
        ),
        context(),
      );

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        code: "deployment_failed",
      });
      expect(mocks.cancelCronSchedule).toHaveBeenCalledWith(
        {
          RELAYCRON_URL: "https://relaycron.test",
          RELAYCRON_API_KEY: "relaycron-key",
        },
        "relaycron_sched_1",
      );
      const queries = mocks.db.execute.mock.calls.map(([query]) => sqlText(query)).join("\n");
      expect(queries).toContain("DELETE FROM agents");
      expect(queries).toContain("DELETE FROM persona_versions");
    } finally {
      errorSpy.mockRestore();
      uuidSpy.mockRestore();
    }
  });

  // The deploy POST used to also upload the persona bundle to a freshly
  // provisioned Daytona sandbox and start `runner.mjs`. That logic moved
  // to the tick handler under the cold-start runtime model, so the
  // bundle-upload + runner-start tests live with the tick handler now —
  // not here.

  it("returns 401 without auth and 403 with a token missing deploy scopes", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce(null);
    const unauthenticated = await POST(request(body()), context());
    expect(unauthenticated.status).toBe(401);

    mocks.resolveRequestAuth.mockResolvedValueOnce({
      ...auth,
      scopes: ["workflow:runs:read"],
    });
    const forbidden = await POST(request(body()), context());
    expect(forbidden.status).toBe(403);
    expect(mocks.daytona.create).not.toHaveBeenCalled();
  });

  it("accepts authenticated relaycron ticks and creates a clock deployment", async () => {
    const token = "tick-secret";
    const waitUntilContext = installCloudflareWaitUntil();
    queueExecuteRows([
      [
        {
          id: "agent-1",
          deployed_name: "weekly-digest",
          input_values: { topic: "AI" },
          spec_hash_at_deploy: "spec-hash",
          status: "active",
          schedule_webhook_secret_hash: hashDeploymentWebhookSecret(token),
          pv_bundle_sha256: "a".repeat(64),
          pv_spec: { id: "weekly-digest", integrations: {} },
          persona_slug: "weekly-digest",
          p_spec: { id: "weekly-digest", integrations: {} },
        },
      ],
      [{ id: "deployment-clock" }],
      [],
      [pendingDeliveryRow({
        id: "delivery-clock",
        agentId: "agent-1",
        deploymentId: "deployment-clock",
        payload: { scheduleId: "sched_1", triggerKind: "clock" },
      })],
      [
        {
          id: "agent-1",
          deployed_name: "weekly-digest",
          input_values: { topic: "AI" },
          spec_hash_at_deploy: "spec-hash",
          status: "active",
          schedule_webhook_secret_hash: hashDeploymentWebhookSecret(token),
          pv_bundle_sha256: "a".repeat(64),
          pv_spec: { id: "weekly-digest", integrations: {} },
          persona_slug: "weekly-digest",
          p_spec: { id: "weekly-digest", integrations: {} },
        },
      ],
    ]);

    const response = await POST_TICK(
      new NextRequest(
        `https://cloud.test/api/v1/workspaces/${workspaceId}/deployments/agent-1/ticks`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-agentrelay-deployment-token": token,
          },
          body: JSON.stringify({ scheduleId: "sched_1", triggerKind: "clock" }),
        },
      ),
      { params: Promise.resolve({ workspaceId, agentId: "agent-1" }) },
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      agentId: "agent-1",
      workspaceId,
      deploymentId: "deployment-clock",
      status: "starting",
    });
    expect(mocks.daytona.list).toHaveBeenCalledWith({
      labels: {
        purpose: "workforce-deploy",
        workspaceId,
        agentId: "agent-1",
      },
      limit: 10,
      states: ["started"],
    });
    expect(waitUntilContext.waitUntil).toHaveBeenCalledTimes(1);
    await waitUntilContext.background;
    expect(mocks.getSnapshotName).not.toHaveBeenCalled();
    const sessionId = createdTickSessionId("deployment-clock");
    expect(mocks.sandbox.process.createSession).toHaveBeenCalledWith(sessionId);
    expect(mocks.sandbox.process.executeSessionCommand).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        command: expect.stringMatching(
          /WORKFORCE_AGENT_CONTEXT[\s\S]*weekly-digest[\s\S]*topic[\s\S]*AI[\s\S]*node \/home\/daytona\/workforce-runtime\/runner\.mjs/,
        ),
        runAsync: true,
      }),
      15,
    );
    const runningDeliveryUpdateCall = mocks.db.execute.mock.calls.find(([query]) => {
      const text = sqlText(query);
      return (
        text.includes("UPDATE deployment_tick_deliveries") &&
        text.includes("SET status = ") &&
        text.includes("run_deployment_id = ") &&
        text.includes("run_session_id") &&
        text.includes("run_command_id")
      );
    });
    expect(runningDeliveryUpdateCall).toBeTruthy();
  });

  it("acks Cloudflare relaycron ticks before waiting for sandbox delivery", async () => {
    const token = "tick-secret";
    const waitUntilContext = installCloudflareWaitUntil();

    queueExecuteRows([
      [
        {
          id: "agent-cf",
          deployed_name: "weekly-digest",
          input_values: { topic: "AI" },
          credential_selections: {},
          spec_hash_at_deploy: "spec-hash",
          status: "active",
          schedule_webhook_secret_hash: hashDeploymentWebhookSecret(token),
          pv_bundle_sha256: "a".repeat(64),
          pv_spec: { id: "weekly-digest", integrations: {} },
          persona_slug: "weekly-digest",
          p_spec: { id: "weekly-digest", integrations: {} },
        },
      ],
      [{ id: "deployment-cf" }],
      [],
      [pendingDeliveryRow({
        id: "delivery-cf",
        agentId: "agent-cf",
        deploymentId: "deployment-cf",
        payload: { scheduleId: "sched_1", triggerKind: "clock" },
      })],
      [
        {
          id: "agent-cf",
          deployed_name: "weekly-digest",
          input_values: { topic: "AI" },
          credential_selections: {},
          spec_hash_at_deploy: "spec-hash",
          status: "active",
          schedule_webhook_secret_hash: hashDeploymentWebhookSecret(token),
          pv_bundle_sha256: "a".repeat(64),
          pv_spec: { id: "weekly-digest", integrations: {} },
          persona_slug: "weekly-digest",
          p_spec: { id: "weekly-digest", integrations: {} },
        },
      ],
    ]);

    const response = await POST_TICK(
      new NextRequest(
        `https://cloud.test/api/v1/workspaces/${workspaceId}/deployments/agent-cf/ticks`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-agentrelay-deployment-token": token,
          },
          body: JSON.stringify({ scheduleId: "sched_1", triggerKind: "clock" }),
        },
      ),
      { params: Promise.resolve({ workspaceId, agentId: "agent-cf" }) },
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      agentId: "agent-cf",
      workspaceId,
      deploymentId: "deployment-cf",
      status: "starting",
    });
    expect(waitUntilContext.waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntilContext.background).toBeInstanceOf(Promise);
    await waitUntilContext.background;
    const sessionId = createdTickSessionId("deployment-cf");
    expect(mocks.sandbox.process.executeSessionCommand).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        command: expect.stringMatching(/node \/home\/daytona\/workforce-runtime\/runner\.mjs/),
        runAsync: true,
      }),
      15,
    );
  });

  it("accepts relaycron ticks authenticated by the registered URL when headers and payload are dropped", async () => {
    const token = "tick-secret";
    const waitUntilContext = installCloudflareWaitUntil();
    queueExecuteRows([
      [
        {
          id: "agent-url-token",
          deployed_name: "cron-hello",
          input_values: {},
          credential_selections: {},
          spec_hash_at_deploy: "spec-hash",
          status: "active",
          schedule_webhook_secret_hash: hashDeploymentWebhookSecret(token),
          pv_bundle_sha256: "a".repeat(64),
          pv_spec: { id: "cron-hello", integrations: {} },
          persona_slug: "cron-hello",
          p_spec: { id: "cron-hello", integrations: {} },
        },
      ],
      [{ id: "deployment-url-token" }],
      [],
      [pendingDeliveryRow({
        id: "delivery-url-token",
        agentId: "agent-url-token",
        deploymentId: "deployment-url-token",
      })],
      [
        {
          id: "agent-url-token",
          deployed_name: "cron-hello",
          input_values: {},
          credential_selections: {},
          spec_hash_at_deploy: "spec-hash",
          status: "active",
          schedule_webhook_secret_hash: hashDeploymentWebhookSecret(token),
          pv_bundle_sha256: "a".repeat(64),
          pv_spec: { id: "cron-hello", integrations: {} },
          persona_slug: "cron-hello",
          p_spec: { id: "cron-hello", integrations: {} },
        },
      ],
    ]);

    const response = await POST_TICK(
      new NextRequest(
        `https://cloud.test/api/v1/workspaces/${workspaceId}` +
          `/deployments/agent-url-token/ticks?deployment_token=${encodeURIComponent(token)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      ),
      { params: Promise.resolve({ workspaceId, agentId: "agent-url-token" }) },
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      agentId: "agent-url-token",
      workspaceId,
      deploymentId: "deployment-url-token",
      status: "starting",
    });
    expect(waitUntilContext.waitUntil).toHaveBeenCalledTimes(1);
    await waitUntilContext.background;
    const sessionId = createdTickSessionId("deployment-url-token");
    expect(mocks.sandbox.process.executeSessionCommand).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        command: expect.stringMatching(
          /cron\.tick[\s\S]*node \/home\/daytona\/workforce-runtime\/runner\.mjs/,
        ),
        runAsync: true,
      }),
      15,
    );
  });

  it.each([
    ["flat", {
      id: "weekly-digest",
      harness: "claude",
      integrations: {
        github: { source: { kind: "workspace" } },
        slack: { source: { kind: "workspace" } },
      },
      inputs: {
        DAILY_SHIP_REPOS: { default: "AgentWorkforce/*" },
        DAILY_SHIP_SLACK_CHANNEL: { default: "ops-daily" },
      },
      schedules: [{ name: "daily", cron: "0 9 * * *" }],
    }],
    ["wrapper", {
      persona: {
        id: "weekly-digest",
        harness: "claude",
        integrations: {
          github: { source: { kind: "workspace" } },
          slack: { source: { kind: "workspace" } },
        },
        inputs: {
          DAILY_SHIP_REPOS: { default: "AgentWorkforce/*" },
          DAILY_SHIP_SLACK_CHANNEL: { default: "ops-daily" },
        },
        schedules: [{ name: "daily", cron: "0 9 * * *" }],
      },
      agent: {
        schedules: [{ name: "daily", cron: "0 9 * * *" }],
      },
    }],
  ])("cold-start tick provisions a sandbox on-demand from a persisted %s spec", async (shape, pvSpec) => {
    // Cloud#604 made deploy POST a pure metadata op — no warm sandbox
    // at deploy time. The tick handler under cloud#609+ should provision
    // a sandbox on the first trigger fire: load bundle by sha256 from
    // S3, daytona.create, upload files, then exec runner.mjs with the
    // envelope. Subsequent ticks on the same agent reuse the warm
    // sandbox via daytona.list.
    const token = "tick-secret";
    const agentId = `agent-cold-${shape}`;
    const deploymentId = `deployment-cold-${shape}`;
    const waitUntilContext = installCloudflareWaitUntil();
    queueExecuteRows([
      [
        {
          id: agentId,
          deployed_name: "weekly-digest",
          deployed_by_user_id: auth.userId,
          input_values: { DAILY_SHIP_REPOS: "AgentWorkforce/*" },
          credential_selections: {},
          spec_hash_at_deploy: "spec-hash",
          status: "active",
          schedule_webhook_secret_hash: hashDeploymentWebhookSecret(token),
          pv_bundle_sha256: "a".repeat(64),
          pv_spec: pvSpec,
          persona_slug: "weekly-digest",
          p_spec: { id: "weekly-digest", integrations: {} },
        },
      ],
      [{ id: deploymentId }],
      [],
      [pendingDeliveryRow({
        id: `delivery-cold-${shape}`,
        agentId,
        deploymentId,
        payload: { scheduleId: "sched_1", triggerKind: "clock" },
      })],
      [
        {
          id: agentId,
          deployed_name: "weekly-digest",
          deployed_by_user_id: auth.userId,
          input_values: { DAILY_SHIP_REPOS: "AgentWorkforce/*" },
          credential_selections: {},
          spec_hash_at_deploy: "spec-hash",
          status: "active",
          schedule_webhook_secret_hash: hashDeploymentWebhookSecret(token),
          pv_bundle_sha256: "a".repeat(64),
          pv_spec: pvSpec,
          persona_slug: "weekly-digest",
          p_spec: { id: "weekly-digest", integrations: {} },
        },
      ],
    ]);
    // No warm sandbox returned from daytona.list — forces the
    // on-demand provisioning path.
    mocks.daytona.list.mockImplementationOnce(() => sandboxList([]));

    const response = await POST_TICK(
      new NextRequest(
        `https://cloud.test/api/v1/workspaces/${workspaceId}/deployments/${agentId}/ticks`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-cloud-agent-deployment-token": token,
          },
          body: JSON.stringify({ scheduleId: "sched_1", triggerKind: "clock" }),
        },
      ),
      { params: Promise.resolve({ workspaceId, agentId }) },
    );

    expect(response.status).toBe(202);
    expect(waitUntilContext.waitUntil).toHaveBeenCalledTimes(1);
    await waitUntilContext.background;
    expect(mocks.daytonaConstructor).toHaveBeenCalledWith({ apiKey: "daytona-key" });
    expect(mocks.getSnapshotName).toHaveBeenCalledTimes(1);
    // DaytonaRuntime uses the detached create API for per-fire sandboxes
    // so provisioning can return quickly while still applying labels that
    // let later lookups find the sandbox.
    expect(mocks.daytona.sandboxApi.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: "snapshot-test",
        name: "weekly-digest-deployme",
        labels: expect.objectContaining({
          purpose: "workforce-deploy",
          workspaceId,
          personaId: "weekly-digest",
          agentId,
          deploymentId,
          "code-toolbox-language": "python",
        }),
      }),
      undefined,
      expect.objectContaining({ timeout: 15_000 }),
    );
    expect(mocks.sandbox.process.createSession).toHaveBeenCalledWith(
      expect.stringMatching(/^mkdir-sbx_deploy-\d+$/),
    );
    expect(mocks.sandbox.process.executeSessionCommand).toHaveBeenCalledWith(
      expect.stringMatching(/^mkdir-sbx_deploy-\d+$/),
      expect.objectContaining({
        command: "mkdir -p '/home/daytona/workforce-runtime'",
        runAsync: false,
      }),
      30,
    );
    // Bundle files uploaded to the fresh sandbox.
    expect(mocks.sandbox.fs.uploadFile).toHaveBeenCalledWith(
      expect.any(Buffer),
      "/home/daytona/workforce-runtime/runner.mjs",
    );
    expect(mocks.sandbox.fs.uploadFile).toHaveBeenCalledWith(
      expect.any(Buffer),
      "/home/daytona/workforce-runtime/agent.bundle.mjs",
    );
    const personaUpload = mocks.sandbox.fs.uploadFile.mock.calls.find(
      ([, destination]) => destination === "/home/daytona/workforce-runtime/persona.json",
    );
    expect(personaUpload).toBeTruthy();
    const uploadedPersona = JSON.parse(String((personaUpload?.[0] as Buffer).toString("utf8")));
    expect(uploadedPersona).toMatchObject({
      id: "weekly-digest",
      harness: "claude",
      integrations: {
        github: { source: { kind: "workspace" } },
        slack: { source: { kind: "workspace" } },
      },
      inputs: {
        DAILY_SHIP_REPOS: { default: "AgentWorkforce/*" },
        DAILY_SHIP_SLACK_CHANNEL: { default: "ops-daily" },
      },
      schedules: [{ name: "daily", cron: "0 9 * * *" }],
    });
    expect(uploadedPersona).not.toHaveProperty("persona");
    expect(uploadedPersona).not.toHaveProperty("agent");
    expect(mocks.createCredentialStoreS3Client).toHaveBeenCalledWith({ userId: auth.userId });
    expect(mocks.credentialStoreRetrieve).toHaveBeenCalledWith(auth.userId, "anthropic");
    expect(mocks.mountCliCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        process: expect.any(Object),
        fs: expect.any(Object),
      }),
      "/home/daytona",
      '{"tokens":{"access_token":"token"}}',
      "anthropic",
    );
    const sessionId = createdTickSessionId(deploymentId);
    const runCommand = String(mocks.sandbox.process.executeSessionCommand.mock.calls.find(
      ([id]) => id === sessionId,
    )?.[1]?.command ?? "");
    for (const spec of WORKFORCE_RUNTIME_AWS_SMITHY_SPECS) {
      expect(runCommand).toContain(spec);
    }
    expect(runCommand).toContain("emitWarningIfUnsupportedVersion");
    expect(runCommand).toContain("@aws-sdk/lib-storage");
    expect(runCommand).not.toContain("then;");
    expect(mocks.sandbox.process.executeSessionCommand).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        command: expect.stringMatching(
          /WORKFORCE_AGENT_CONTEXT[\s\S]*weekly-digest[\s\S]*DAILY_SHIP_REPOS[\s\S]*AgentWorkforce\/\*[\s\S]*node \/home\/daytona\/workforce-runtime\/runner\.mjs/,
        ),
        runAsync: true,
      }),
      15,
    );
  });

  it("cold-starts instead of reusing a stopped deployment sandbox", async () => {
    const token = "tick-secret";
    const waitUntilContext = installCloudflareWaitUntil();
    queueExecuteRows([
      [
        {
          id: "agent-stopped",
          deployed_name: "weekly-digest",
          input_values: { topic: "AI" },
          credential_selections: {},
          spec_hash_at_deploy: "spec-hash",
          status: "active",
          schedule_webhook_secret_hash: hashDeploymentWebhookSecret(token),
          pv_bundle_sha256: "a".repeat(64),
          pv_spec: { id: "weekly-digest", integrations: {} },
          persona_slug: "weekly-digest",
          p_spec: { id: "weekly-digest", integrations: {} },
        },
      ],
      [{ id: "deployment-stopped" }],
      [],
      [pendingDeliveryRow({
        id: "delivery-stopped",
        agentId: "agent-stopped",
        deploymentId: "deployment-stopped",
        payload: { scheduleId: "sched_1", triggerKind: "clock" },
      })],
      [
        {
          id: "agent-stopped",
          deployed_name: "weekly-digest",
          input_values: { topic: "AI" },
          credential_selections: {},
          spec_hash_at_deploy: "spec-hash",
          status: "active",
          schedule_webhook_secret_hash: hashDeploymentWebhookSecret(token),
          pv_bundle_sha256: "a".repeat(64),
          pv_spec: { id: "weekly-digest", integrations: {} },
          persona_slug: "weekly-digest",
          p_spec: { id: "weekly-digest", integrations: {} },
        },
      ],
    ]);
    mocks.daytona.list.mockImplementationOnce(() =>
      sandboxList([{ ...mocks.sandbox, id: "sbx_stopped", state: "STOPPED" }]),
    );

    const response = await POST_TICK(
      new NextRequest(
        `https://cloud.test/api/v1/workspaces/${workspaceId}/deployments/agent-stopped/ticks`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-cloud-agent-deployment-token": token,
          },
          body: JSON.stringify({ scheduleId: "sched_1", triggerKind: "clock" }),
        },
      ),
      { params: Promise.resolve({ workspaceId, agentId: "agent-stopped" }) },
    );

    expect(response.status).toBe(202);
    expect(waitUntilContext.waitUntil).toHaveBeenCalledTimes(1);
    await waitUntilContext.background;
    expect(mocks.getSnapshotName).toHaveBeenCalledTimes(1);
    expect(mocks.daytona.sandboxApi.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: "snapshot-test",
        labels: expect.objectContaining({
          agentId: "agent-stopped",
          "code-toolbox-language": "python",
        }),
      }),
      undefined,
      expect.objectContaining({ timeout: 15_000 }),
    );
    const sessionId = createdTickSessionId("deployment-stopped");
    expect(mocks.sandbox.process.executeSessionCommand).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ runAsync: true }),
      15,
    );
  });

  it("records running background delivery after async submission", async () => {
    const token = "tick-secret";
    const waitUntilContext = installCloudflareWaitUntil();
    queueExecuteRows([
      [
        {
          id: "agent-empty-output",
          deployed_name: "weekly-digest",
          input_values: { topic: "AI" },
          credential_selections: {},
          spec_hash_at_deploy: "spec-hash",
          status: "active",
          schedule_webhook_secret_hash: hashDeploymentWebhookSecret(token),
          pv_bundle_sha256: "a".repeat(64),
          pv_spec: { id: "weekly-digest", integrations: {} },
          persona_slug: "weekly-digest",
          p_spec: { id: "weekly-digest", integrations: {} },
        },
      ],
      [{ id: "deployment-empty-output" }],
      [],
      [pendingDeliveryRow({
        id: "delivery-empty-output",
        agentId: "agent-empty-output",
        deploymentId: "deployment-empty-output",
        payload: { scheduleId: "sched_1", triggerKind: "clock" },
      })],
      [
        {
          id: "agent-empty-output",
          deployed_name: "weekly-digest",
          input_values: { topic: "AI" },
          credential_selections: {},
          spec_hash_at_deploy: "spec-hash",
          status: "active",
          schedule_webhook_secret_hash: hashDeploymentWebhookSecret(token),
          pv_bundle_sha256: "a".repeat(64),
          pv_spec: { id: "weekly-digest", integrations: {} },
          persona_slug: "weekly-digest",
          p_spec: { id: "weekly-digest", integrations: {} },
        },
      ],
    ]);
    mocks.sandbox.process.executeSessionCommand
      .mockResolvedValueOnce({ exitCode: 0, output: "" })
      .mockResolvedValueOnce({ exitCode: 0, output: "" })
      .mockResolvedValueOnce({
        cmdId: "cmd-empty-output",
        exitCode: 1,
        output: "",
      });
    const response = await POST_TICK(
      new NextRequest(
        `https://cloud.test/api/v1/workspaces/${workspaceId}/deployments/agent-empty-output/ticks`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-cloud-agent-deployment-token": token,
          },
          body: JSON.stringify({ scheduleId: "sched_1", triggerKind: "clock" }),
        },
      ),
      { params: Promise.resolve({ workspaceId, agentId: "agent-empty-output" }) },
    );

    expect(response.status).toBe(202);
    expect(waitUntilContext.waitUntil).toHaveBeenCalledTimes(1);
    await waitUntilContext.background;
    const runInsertCall = mocks.db.execute.mock.calls.find(([query]) =>
      sqlText(query).includes("INSERT INTO agent_deployment_runs"),
    );
    expect(runInsertCall).toBeUndefined();
    const runningDeliveryUpdateCall = mocks.db.execute.mock.calls.find(([query]) => {
      const text = sqlText(query);
      return (
        text.includes("UPDATE deployment_tick_deliveries") &&
        text.includes("SET status = ") &&
        text.includes("run_deployment_id = ") &&
        text.includes("run_session_id") &&
        text.includes("run_command_id")
      );
    });
    expect(runningDeliveryUpdateCall).toBeTruthy();
  });

  it("queues a pre-cold-start agent and records bundle_unavailable in the background", async () => {
    // Legacy agents deployed before cloud#609 have `bundle_sha256 = NULL`.
    // The tick handler can't cold-start them; surface a clear 410 with
    // an actionable code so the operator knows to redeploy.
    const token = "tick-secret";
    const waitUntilContext = installCloudflareWaitUntil();
    queueExecuteRows([
      [
        {
          id: "agent-legacy",
          deployed_name: "legacy-persona",
          input_values: {},
          credential_selections: {},
          spec_hash_at_deploy: "old-hash",
          status: "active",
          schedule_webhook_secret_hash: hashDeploymentWebhookSecret(token),
          pv_bundle_sha256: null,
          pv_spec: null,
          persona_slug: "legacy-persona",
          p_spec: null,
        },
      ],
      [{ id: "deployment-legacy" }],
      [],
      [pendingDeliveryRow({
        id: "delivery-legacy",
        agentId: "agent-legacy",
        deploymentId: "deployment-legacy",
        payload: { scheduleId: "sched_1" },
      })],
      [
        {
          id: "agent-legacy",
          deployed_name: "legacy-persona",
          input_values: {},
          credential_selections: {},
          spec_hash_at_deploy: "old-hash",
          status: "active",
          schedule_webhook_secret_hash: hashDeploymentWebhookSecret(token),
          pv_bundle_sha256: null,
          pv_spec: null,
          persona_slug: "legacy-persona",
          p_spec: null,
        },
      ],
    ]);
    mocks.daytona.list.mockImplementationOnce(() => sandboxList([]));

    const response = await POST_TICK(
      new NextRequest(
        `https://cloud.test/api/v1/workspaces/${workspaceId}/deployments/agent-legacy/ticks`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-cloud-agent-deployment-token": token,
          },
          body: JSON.stringify({ scheduleId: "sched_1" }),
        },
      ),
      { params: Promise.resolve({ workspaceId, agentId: "agent-legacy" }) },
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      agentId: "agent-legacy",
      deploymentId: "deployment-legacy",
      status: "starting",
    });
    expect(waitUntilContext.waitUntil).toHaveBeenCalledTimes(1);
    await waitUntilContext.background;
    expect(mocks.daytona.sandboxApi.createSandbox).not.toHaveBeenCalled();
  });

  it("rejects relaycron ticks with a missing token", async () => {
    const response = await POST_TICK(
      new NextRequest(
        `https://cloud.test/api/v1/workspaces/${workspaceId}/deployments/agent-1/ticks`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scheduleId: "sched_1", triggerKind: "clock" }),
        },
      ),
      { params: Promise.resolve({ workspaceId, agentId: "agent-1" }) },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "unauthorized" });
    expect(mocks.db.execute).not.toHaveBeenCalled();
  });

  it("rejects relaycron ticks with the wrong token", async () => {
    queueExecuteRows([
      [
        {
          id: "agent-1",
          deployed_name: "weekly-digest",
          input_values: {},
          spec_hash_at_deploy: "spec-hash",
          status: "active",
          schedule_webhook_secret_hash: hashDeploymentWebhookSecret("right-token"),
        },
      ],
    ]);

    const response = await POST_TICK(
      new NextRequest(
        `https://cloud.test/api/v1/workspaces/${workspaceId}/deployments/agent-1/ticks`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-cloud-agent-deployment-token": "wrong-token",
          },
          body: JSON.stringify({ scheduleId: "sched_1", triggerKind: "clock" }),
        },
      ),
      { params: Promise.resolve({ workspaceId, agentId: "agent-1" }) },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "unauthorized" });
  });

  it("returns not_found for nonexistent or destroyed relaycron tick targets", async () => {
    queueExecuteRows([[]]);

    const response = await POST_TICK(
      new NextRequest(
        `https://cloud.test/api/v1/workspaces/${workspaceId}/deployments/missing-agent/ticks`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-cloud-agent-deployment-token": "tick-secret",
          },
          body: JSON.stringify({ scheduleId: "sched_1", triggerKind: "clock" }),
        },
      ),
      { params: Promise.resolve({ workspaceId, agentId: "missing-agent" }) },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "not_found" });
  });

  it("returns inactive for relaycron tick targets that are not active", async () => {
    queueExecuteRows([
      [
        {
          id: "agent-1",
          deployed_name: "weekly-digest",
          input_values: {},
          spec_hash_at_deploy: "spec-hash",
          status: "failed",
          schedule_webhook_secret_hash: hashDeploymentWebhookSecret("tick-secret"),
        },
      ],
    ]);

    const response = await POST_TICK(
      new NextRequest(
        `https://cloud.test/api/v1/workspaces/${workspaceId}/deployments/agent-1/ticks`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-cloud-agent-deployment-token": "tick-secret",
          },
          body: JSON.stringify({ scheduleId: "sched_1", triggerKind: "clock" }),
        },
      ),
      { params: Promise.resolve({ workspaceId, agentId: "agent-1" }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "inactive" });
  });

  it("rejects relaycron ticks with invalid JSON", async () => {
    const token = "tick-secret";
    queueExecuteRows([
      [
        {
          id: "agent-1",
          deployed_name: "weekly-digest",
          input_values: {},
          spec_hash_at_deploy: "spec-hash",
          status: "active",
          schedule_webhook_secret_hash: hashDeploymentWebhookSecret(token),
        },
      ],
    ]);

    const response = await POST_TICK(
      new NextRequest(
        `https://cloud.test/api/v1/workspaces/${workspaceId}/deployments/agent-1/ticks`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-cloud-agent-deployment-token": token,
          },
          body: "{",
        },
      ),
      { params: Promise.resolve({ workspaceId, agentId: "agent-1" }) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_request" });
  });
});
