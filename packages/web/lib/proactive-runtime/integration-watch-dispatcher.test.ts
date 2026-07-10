import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import teamIssuePersona from "../../../../personas/cloud-team-issue/persona.json" with { type: "json" };

const mocks = vi.hoisted(() => ({
  dbExecute: vi.fn(),
  enqueueIntegrationWatchDelivery: vi.fn(),
  enqueueIntegrationWatchDeliveryDrain: vi.fn(),
  drainIntegrationWatchDeliveries: vi.fn(),
  dedupeFetch: vi.fn(),
  dedupeBrokerEnabled: false,
  claimWebhookDelivery: vi.fn(),
  releaseWebhookDelivery: vi.fn(),
  resolveAppWorkspaceIdForRuntime: vi.fn(),
  listWorkspaceIntegrationsByProviderAlias: vi.fn(),
  buildTeamLaunchPayload: vi.fn(),
  dispatchTeamLaunchN1: vi.fn(),
  isTeamLaunchN1Enabled: vi.fn(),
  TeamLaunchOptionsUnavailableError: class TeamLaunchOptionsUnavailableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "TeamLaunchOptionsUnavailableError";
    }
  },
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  cooldownEnv: undefined as string | undefined,
}));

const cloudflareContextSymbol = Symbol.for("__cloudflare-context__");

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: Array<{ value?: string[] }> }).queryChunks;
  return chunks?.flatMap((chunk) => chunk?.value ?? []).join(" ") ?? "";
}

function sqlInterpolatedValues(query: unknown): unknown[] {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks.flatMap((chunk) => {
    if (typeof chunk === "string") {
      return [chunk];
    }
    if (chunk && typeof chunk === "object" && "value" in chunk) {
      const value = (chunk as { value?: unknown }).value;
      return Array.isArray(value) ? [] : [value];
    }
    return [];
  });
}

vi.mock("@/lib/db", () => ({
  getDb: () => ({ execute: mocks.dbExecute }),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
}));

vi.mock("@/lib/proactive-runtime/integration-watch-deliveries", () => ({
  enqueueIntegrationWatchDelivery: mocks.enqueueIntegrationWatchDelivery,
  drainIntegrationWatchDeliveries: mocks.drainIntegrationWatchDeliveries,
}));

vi.mock("@/lib/proactive-runtime/integration-watch-delivery-queue", () => ({
  enqueueIntegrationWatchDeliveryDrain: mocks.enqueueIntegrationWatchDeliveryDrain,
}));

vi.mock("@/lib/cloudflare-context", () => ({
  getCloudflareContext: () => ({
    env: {
      ...(mocks.dedupeBrokerEnabled
        ? {
            AGENT_GATEWAY_DEDUPE_BROKER: {
              fetch: mocks.dedupeFetch,
            },
          }
        : {}),
      ...(mocks.cooldownEnv
        ? { CLOUD_AGENT_ISSUE_DISPATCH_COOLDOWN_SECONDS: mocks.cooldownEnv }
        : {}),
    },
  }),
}));

vi.mock("@/lib/ricky/webhook-dedup", () => ({
  claimWebhookDelivery: mocks.claimWebhookDelivery,
  releaseWebhookDelivery: mocks.releaseWebhookDelivery,
}));

vi.mock("@/lib/workspaces/workspace-integration-identity-core", () => ({
  resolveAppWorkspaceIdForRelayRuntime: mocks.resolveAppWorkspaceIdForRuntime,
  resolveAppWorkspaceIdForRuntime: mocks.resolveAppWorkspaceIdForRuntime,
}));

vi.mock("@/lib/integrations/workspace-integrations", () => ({
  listWorkspaceIntegrationsByProviderAlias: mocks.listWorkspaceIntegrationsByProviderAlias,
}));

vi.mock("@/lib/proactive-runtime/team-launch-n1", async () => {
  // Real module for the pure helpers (teamSolveMaxMembers and the flag
  // readers) — a bare factory object silently breaks every new export (the
  // factory-mock missing-export trap).
  const actual = await vi.importActual<
    typeof import("@/lib/proactive-runtime/team-launch-n1")
  >("@/lib/proactive-runtime/team-launch-n1");
  return {
    ...actual,
    buildTeamLaunchPayload: mocks.buildTeamLaunchPayload,
    buildTeamLaunchMemberOptions: vi.fn(),
    dispatchTeamLaunchN1: mocks.dispatchTeamLaunchN1,
    isTeamLaunchN1Enabled: mocks.isTeamLaunchN1Enabled,
    launchTeamMember: vi.fn(),
    TeamLaunchOptionsUnavailableError: mocks.TeamLaunchOptionsUnavailableError,
  };
});

let pg: PGlite | null = null;

async function usePgliteDispatcherDb(): Promise<PGlite> {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE persona_versions (
      id text PRIMARY KEY,
      persona_id text NOT NULL,
      version integer NOT NULL,
      spec_hash text NOT NULL,
      spec jsonb
    );

    CREATE TABLE agents (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      deployed_by_user_id text NOT NULL DEFAULT 'user-1',
      status text NOT NULL,
      deployed_name text,
      watch_globs text[],
      watch_rules jsonb,
      delivery_max_concurrency_by_trigger jsonb,
      pinned_version_id text REFERENCES persona_versions(id)
    );

    CREATE TABLE workspaces (
      id text PRIMARY KEY,
      organization_id text NOT NULL
    );

    INSERT INTO workspaces (id, organization_id)
    VALUES ('workspace-1', 'org-1');

    CREATE TABLE integration_watch_issue_dispatch_dedup (
      id bigserial PRIMARY KEY,
      workspace_id text NOT NULL,
      issue_key text NOT NULL,
      agent_id text NOT NULL,
      delivery_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      pending_delivery_id text,
      pending_payload jsonb,
      UNIQUE (workspace_id, issue_key, agent_id)
    );
  `);
  const db = drizzle(pg);
  mocks.dbExecute.mockImplementation((query: unknown) => db.execute(query as never));
  return pg;
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function wrappedDeploymentSpec(
  persona: Record<string, unknown>,
  agent: Record<string, unknown> = {},
): Record<string, unknown> {
  return { persona, agent };
}

async function insertPgliteAgent(input: {
  id: string;
  deployedName?: string;
  watchGlobs: readonly string[];
  watchRules?: readonly unknown[];
  deliveryMaxConcurrencyByTrigger?: Record<string, number>;
  spec: Record<string, unknown>;
  workspaceId?: string;
}): Promise<void> {
  const workspaceId = input.workspaceId ?? "workspace-1";
  const personaId = `${input.id}-persona`;
  const versionId = `${input.id}-version`;
  await pg!.query(
    "INSERT INTO persona_versions (id, persona_id, version, spec_hash, spec) VALUES ($1, $2, 1, $3, $4::jsonb)",
    [versionId, personaId, `${input.id}-spec-hash`, JSON.stringify(input.spec)],
  );
  const watchGlobs = input.watchGlobs.map(sqlLiteral).join(", ");
  const watchGlobsSql = watchGlobs.length > 0 ? `ARRAY[${watchGlobs}]` : "ARRAY[]::text[]";
  await pg!.query(
    `
      INSERT INTO agents (
        id,
        workspace_id,
        deployed_by_user_id,
        status,
        deployed_name,
        watch_globs,
        watch_rules,
        delivery_max_concurrency_by_trigger,
        pinned_version_id
      )
      VALUES ($1, $2, 'user-1', 'active', $3, ${watchGlobsSql}, $4::jsonb, $5::jsonb, $6)
    `,
    [
      input.id,
      workspaceId,
      input.deployedName ?? input.id,
      input.watchRules ? JSON.stringify(input.watchRules) : null,
      input.deliveryMaxConcurrencyByTrigger ? JSON.stringify(input.deliveryMaxConcurrencyByTrigger) : null,
      versionId,
    ],
  );
}

describe("dispatchIntegrationWatchEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (globalThis as Record<symbol, unknown>)[cloudflareContextSymbol];
    mocks.dedupeBrokerEnabled = false;
    mocks.cooldownEnv = undefined;
    delete process.env.CLOUD_TEAM_ISSUE_ENABLED;
    delete process.env.TEAM_ISSUE_TEST_MODE;
    mocks.claimWebhookDelivery.mockResolvedValue(true);
    mocks.releaseWebhookDelivery.mockResolvedValue(undefined);
    mocks.resolveAppWorkspaceIdForRuntime.mockImplementation(async (workspaceId: string) => workspaceId);
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([
      {
        workspaceId: "workspace-1",
        provider: "github",
        name: null,
        connectionId: "conn-1",
        providerConfigKey: "github-relay",
        installationId: null,
        metadata: { botLogin: "file-by-agent-relay[bot]" },
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);
    mocks.enqueueIntegrationWatchDelivery.mockResolvedValue("queued");
    mocks.enqueueIntegrationWatchDeliveryDrain.mockResolvedValue("enqueued");
    mocks.buildTeamLaunchPayload.mockImplementation(async (input: { payload: unknown }) => ({
      ...(input.payload as Record<string, unknown>),
      launchMember: {
        memberName: "cloud-team-issue-n1",
        role: "implementer",
        channel: "team-launch-n1-agent",
        harness: "claude",
        model: "claude-sonnet-4-6",
        credentialBundle: {
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
          runId: "delivery-1",
          userId: "user-1",
        },
        workflowConfig: "{}",
        fileType: "config",
      },
    }));
    mocks.dispatchTeamLaunchN1.mockResolvedValue({
      status: "launched",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      deliveryId: "delivery-1",
      memberName: "cloud-team-issue-n1",
      role: "implementer",
      channel: "team-launch-n1-agent",
      sandboxId: "sandbox-1",
      assignedRoot: "/github/repos/AgentWorkforce/cloud/issues/123",
      localRoot: "/home/daytona/workspace/github/repos/AgentWorkforce/cloud/issues/123",
      writeScopes: ["relayfile:fs:write:/github/repos/AgentWorkforce/cloud/issues/123/*"],
    });
    mocks.isTeamLaunchN1Enabled.mockReturnValue(false);
    mocks.drainIntegrationWatchDeliveries.mockResolvedValue({
      attempted: 0,
      delivered: 0,
      failed: 0,
      pending: 0,
      terminal: 0,
    });
  });

  afterEach(async () => {
    delete process.env.CLOUD_TEAM_ISSUE_ENABLED;
    delete process.env.TEAM_ISSUE_TEST_MODE;
    delete process.env.FACTORY_BRAIN_TEST_MODE;
    delete process.env.CLOUD_FACTORY_BRAIN_ENABLED;
    await pg?.close();
    pg = null;
  });

  it("uses a warm-only fast-path budget (zero provision wait) for inline webhook drains", async () => {
    const waitUntil = vi.fn();
    (globalThis as Record<symbol, unknown>)[cloudflareContextSymbol] = { waitUntil };
    mocks.dbExecute.mockResolvedValue({
      rows: [
        {
          id: "agent-1",
          watch_globs: ["/github/repos/**/**/issues/**"],
          spec: {
            integrations: {
              github: { triggers: [{ on: "issues.opened" }] },
            },
          },
        },
      ],
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "issues.opened",
      connectionId: "conn-1",
      deliveryId: "delivery-1",
      paths: ["/github/repos/acme/cloud/issues/42__bug/meta.json"],
      payload: { number: 42 },
    });

    expect(result).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDeliveryDrain).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      deliveryId: "delivery-1",
    });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(mocks.drainIntegrationWatchDeliveries).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      deliveryId: "delivery-1",
      deliveryOptions: {
        sandboxCreateTimeoutSeconds: 120,
        // waitUntil caps inline drains at ~30s post-response: never poll a
        // cold sandbox inline — bail with the provisioning-pending error so
        // the sandbox id is persisted and the sweep re-attaches to it.
        sandboxProvisionWaitTimeoutMs: 0,
        runScriptTimeoutMs: 15_000,
        asyncRunScript: true,
      },
    }));
  });

  it("warns when inline webhook drains cannot be scheduled without waitUntil", async () => {
    mocks.dbExecute.mockResolvedValue({
      rows: [
        {
          id: "agent-1",
          watch_globs: ["/github/repos/**/**/issues/**"],
          spec: {
            integrations: {
              github: { triggers: [{ on: "issues.opened" }] },
            },
          },
        },
      ],
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "issues.opened",
      connectionId: "conn-1",
      deliveryId: "delivery-1",
      paths: ["/github/repos/acme/cloud/issues/42__bug/meta.json"],
      payload: { number: 42 },
    });

    expect(result).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledTimes(1);
    expect(mocks.drainIntegrationWatchDeliveries).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "Integration watch inline delivery drain skipped without waitUntil",
      expect.objectContaining({
        area: "integration-watch-dispatch",
        workspaceId: "workspace-1",
        agentId: "agent-1",
        deliveryId: "delivery-1",
      }),
    );
  });

  it("delivers provider events to active agents whose watch globs and triggers match", async () => {
    mocks.dbExecute.mockResolvedValue({
      rows: [
        {
          id: "agent-1",
          watch_globs: ["/github/repos/**/**/issues/**"],
          spec: {
            integrations: {
              github: { triggers: [{ on: "issues.opened" }] },
            },
          },
        },
      ],
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "issues.opened",
      connectionId: "conn-1",
      deliveryId: "delivery-1",
      paths: ["/github/repos/acme/cloud/issues/42__bug/meta.json"],
      payload: { number: 42 },
    });

    expect(result).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      deliveryId: "delivery-1",
      payload: expect.objectContaining({
        type: "github.issues.opened",
        eventType: "issues.opened",
        provider: "github",
        connectionId: "conn-1",
        deliveryId: "delivery-1",
      }),
    }));
  });

  it("stamps the most restrictive matched trigger key onto queued deliveries", async () => {
    await usePgliteDispatcherDb();
    await insertPgliteAgent({
      id: "agent-1",
      watchGlobs: [],
      watchRules: [
        {
          paths: ["/github/repos/acme/cloud/issues/**"],
          events: ["issues.opened"],
          triggerKey: "provider:github:trigger:0",
        },
        {
          paths: ["/github/repos/acme/cloud/issues/**"],
          events: ["issues.opened"],
          triggerKey: "provider:github:trigger:1",
        },
      ],
      deliveryMaxConcurrencyByTrigger: {
        "provider:github:trigger:1": 1,
      },
      spec: {
        integrations: {
          github: {
            triggers: [
              { on: "issues.opened" },
              { on: "issues.opened", maxConcurrency: 1 },
            ],
          },
        },
      },
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "issues.opened",
      connectionId: "conn-1",
      deliveryId: "delivery-1",
      paths: ["/github/repos/acme/cloud/issues/42__bug/meta.json"],
      payload: { number: 42 },
    });

    expect(result).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      deliveryId: "delivery-1",
      triggerKey: "provider:github:trigger:1",
    }));
  });

  it("stands down teamSolve rows when the N=1 flag is disabled without falling through to normal delivery", async () => {
    await usePgliteDispatcherDb();
    await insertPgliteAgent({
      id: "agent-1",
      watchGlobs: [],
      watchRules: [{
        paths: ["/github/repos/AgentWorkforce/cloud/issues/**"],
        events: ["issues.labeled"],
        conditions: [{ field: "label.name", equals: "team" }],
      }],
      spec: wrappedDeploymentSpec({
        intent: "team-solve",
        capabilities: { teamSolve: { enabled: true, maxMembers: 1 } },
      }),
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "issues.labeled",
      connectionId: "conn-1",
      deliveryId: "delivery-1",
      paths: ["/github/repos/AgentWorkforce/cloud/issues/123.json"],
      payload: {
        label: { name: "team" },
        issue: { number: 123 },
        repository: { full_name: "AgentWorkforce/cloud" },
      },
    });

    expect(result).toEqual({ matched: 1, delivered: 0, failed: 0 });
    expect(mocks.dispatchTeamLaunchN1).not.toHaveBeenCalled();
    expect(mocks.enqueueIntegrationWatchDelivery).not.toHaveBeenCalled();
    expect(mocks.drainIntegrationWatchDeliveries).not.toHaveBeenCalled();
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Integration watch teamSolve N=1 stand-down",
      expect.objectContaining({
        area: "team-launch-n1",
        diag: "disabled",
        agentId: "agent-1",
      }),
    );
  });

  it("keeps the cloud-team-issue persona on the N=1 stand-down branch when launch is disabled", async () => {
    process.env.TEAM_ISSUE_TEST_MODE = "true";
    await usePgliteDispatcherDb();
    await insertPgliteAgent({
      id: "cloud-team-issue",
      watchGlobs: [],
      watchRules: [{
        paths: ["/github/repos/AgentWorkforce/cloud/issues/**"],
        events: ["issues.labeled"],
        conditions: [{ field: "label.name", equals: "team" }],
      }],
      spec: teamIssuePersona,
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "issues.labeled",
      connectionId: "conn-1",
      deliveryId: "delivery-1",
      paths: ["/github/repos/AgentWorkforce/cloud/issues/123.json"],
      payload: {
        label: { name: "team" },
        issue: { number: 123, state: "open" },
        repository: { full_name: "AgentWorkforce/cloud" },
      },
    });

    expect(result).toEqual({ matched: 1, delivered: 0, failed: 0 });
    expect(mocks.dispatchTeamLaunchN1).not.toHaveBeenCalled();
    expect(mocks.enqueueIntegrationWatchDelivery).not.toHaveBeenCalled();
    expect(mocks.drainIntegrationWatchDeliveries).not.toHaveBeenCalled();
    expect(mocks.dbExecute.mock.calls.some(([query]) =>
      sqlText(query).includes("integration_watch_issue_dispatch_dedup")
    )).toBe(false);
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Integration watch teamSolve N=1 stand-down",
      expect.objectContaining({
        area: "team-launch-n1",
        diag: "disabled",
        agentId: "cloud-team-issue",
      }),
    );
  });

  it("queues Linear [factory] issues to the cloud factory brain even when teamSolve launch is disabled", async () => {
    process.env.FACTORY_BRAIN_TEST_MODE = "true";
    await usePgliteDispatcherDb();
    await insertPgliteAgent({
      id: "cloud-factory-brain",
      watchGlobs: [],
      watchRules: [{
        paths: ["/linear/issues/**"],
        events: ["issues.updated"],
      }],
      spec: wrappedDeploymentSpec({
        id: "cloud-factory-brain",
        capabilities: { teamSolve: { enabled: true, maxMembers: 1 } },
      }),
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "linear",
      eventType: "issues.updated",
      connectionId: "conn-1",
      deliveryId: "delivery-1",
      paths: ["/linear/issues/AR-267__issue-1.json"],
      payload: {
        id: "issue-1",
        identifier: "AR-267",
        title: "[factory] Phase 2 cloud lift",
        description: "Lift the factory brain into the cloud worker.",
        labels: ["factory", "agent:team", "cloud"],
        state: { name: "Ready for Agent" },
      },
    });

    expect(result).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        agentId: "cloud-factory-brain",
        deliveryId: "delivery-1",
        payload: expect.objectContaining({
          provider: "linear",
          eventType: "issues.updated",
          factoryBrain: true,
          resource: expect.objectContaining({
            identifier: "AR-267",
          }),
        }),
      }),
    );
    expect(mocks.enqueueIntegrationWatchDelivery.mock.calls[0]?.[0].payload).not.toHaveProperty("teamLaunchN1");
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Integration watch factory brain matched",
      expect.objectContaining({
        area: "factory-cloud-brain",
        diag: "matched",
        agentId: "cloud-factory-brain",
      }),
    );
  });

  it("matches Linear issue watch rules by /linear/issues paths, labels, and state", async () => {
    await usePgliteDispatcherDb();
    await insertPgliteAgent({
      id: "linear-factory-triage",
      watchGlobs: [],
      watchRules: [{
        paths: ["/linear/issues/**"],
        events: ["issue.update"],
        conditions: [
          { field: "labels.nodes.name", equals: "factory" },
          { field: "state.name", equals: "Ready for Agent" },
        ],
      }],
      spec: {},
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "linear",
      eventType: "issue.update",
      connectionId: "conn-linear",
      deliveryId: "linear-delivery-1",
      paths: ["/linear/issues/issue_123.json"],
      payload: {
        id: "issue_123",
        identifier: "AR-267",
        title: "[factory] Linear webhook ingress",
        labels: { nodes: [{ name: "factory" }, { name: "cloud" }] },
        state: { name: "Ready for Agent" },
      },
    });

    expect(result).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      agentId: "linear-factory-triage",
      deliveryId: "linear-delivery-1",
      payload: expect.objectContaining({
        provider: "linear",
        eventType: "issue.update",
        resource: expect.objectContaining({
          identifier: "AR-267",
        }),
      }),
    }));
  });

  it("coalesces Linear issue label churn through the issue-level cooldown", async () => {
    await usePgliteDispatcherDb();
    await insertPgliteAgent({
      id: "linear-factory-triage",
      watchGlobs: [],
      watchRules: [{
        paths: ["/linear/issues/**"],
        events: ["issue.update"],
        conditions: [{ field: "labels", equals: "factory" }],
      }],
      spec: {},
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");
    const baseInput = {
      workspaceId: "workspace-1",
      provider: "linear",
      eventType: "issue.update",
      connectionId: "conn-linear",
      paths: ["/linear/issues/issue_123.json"],
    } as const;

    await dispatchIntegrationWatchEvent({
      ...baseInput,
      deliveryId: "linear-delivery-1",
      payload: {
        id: "issue_123",
        identifier: "AR-267",
        labels: ["factory", "cloud"],
      },
    });
    mocks.enqueueIntegrationWatchDelivery.mockClear();

    const result = await dispatchIntegrationWatchEvent({
      ...baseInput,
      deliveryId: "linear-delivery-2",
      payload: {
        id: "issue_123",
        identifier: "AR-267",
        labels: ["factory", "relay"],
      },
    });

    expect(result).toEqual({ matched: 1, delivered: 0, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).not.toHaveBeenCalled();
    const pending = await pg!.query(
      "SELECT delivery_id, pending_delivery_id, pending_payload FROM integration_watch_issue_dispatch_dedup WHERE issue_key = $1 AND agent_id = $2",
      ["linear:issue_123", "linear-factory-triage"],
    );
    expect(pending.rows).toEqual([
      expect.objectContaining({
        delivery_id: "linear-delivery-1",
        pending_delivery_id: "linear-delivery-2",
        pending_payload: expect.objectContaining({
          deliveryId: "linear-delivery-2",
          resource: expect.objectContaining({
            labels: ["factory", "relay"],
          }),
        }),
      }),
    ]);
  });

  it("stands down the factory brain (no enqueue) when the dormant-flip flag is off", async () => {
    // FACTORY_BRAIN_TEST_MODE / CLOUD_FACTORY_BRAIN_ENABLED unset → flag off.
    await usePgliteDispatcherDb();
    await insertPgliteAgent({
      id: "cloud-factory-brain",
      watchGlobs: [],
      watchRules: [{
        paths: ["/linear/issues/**"],
        events: ["issues.updated"],
      }],
      spec: wrappedDeploymentSpec({
        id: "cloud-factory-brain",
        capabilities: { teamSolve: { enabled: true, maxMembers: 1 } },
      }),
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "linear",
      eventType: "issues.updated",
      connectionId: "conn-1",
      deliveryId: "delivery-1",
      paths: ["/linear/issues/AR-267__issue-1.json"],
      payload: {
        id: "issue-1",
        identifier: "AR-267",
        title: "[factory] Phase 2 cloud lift",
        description: "Lift the factory brain into the cloud worker.",
        labels: ["factory", "agent:team", "cloud"],
        state: { name: "Ready for Agent" },
      },
    });

    // No factory enqueue: the candidate falls through to today's teamSolve N=1
    // stand-down (launch flag also off in beforeEach), exactly the dormant state.
    expect(result).toEqual({ matched: 1, delivered: 0, failed: 0 });
    expect(
      mocks.enqueueIntegrationWatchDelivery.mock.calls.some(
        ([arg]) => (arg as { payload?: Record<string, unknown> })?.payload?.factoryBrain === true,
      ),
    ).toBe(false);
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Integration watch factory brain stand-down",
      expect.objectContaining({
        area: "factory-cloud-brain",
        diag: "disabled",
        agentId: "cloud-factory-brain",
      }),
    );
    expect(mocks.loggerInfo).not.toHaveBeenCalledWith(
      "Integration watch factory brain matched",
      expect.anything(),
    );
  });

  it("queues enabled teamSolve N=1 rows with a team-launch marker", async () => {
    mocks.isTeamLaunchN1Enabled.mockReturnValue(true);
    await usePgliteDispatcherDb();
    await insertPgliteAgent({
      id: "agent-1",
      watchGlobs: [],
      watchRules: [{
        paths: ["/github/repos/AgentWorkforce/cloud/issues/**"],
        events: ["issues.labeled"],
        conditions: [{ field: "label.name", equals: "team" }],
      }],
      spec: wrappedDeploymentSpec({
        capabilities: { teamSolve: { enabled: true, maxMembers: 1 } },
      }),
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "issues.labeled",
      connectionId: "conn-1",
      deliveryId: "delivery-1",
      paths: ["/github/repos/AgentWorkforce/cloud/issues/123.json"],
      payload: {
        label: { name: "team" },
        issue: { number: 123 },
        repository: { full_name: "AgentWorkforce/cloud" },
      },
    });

    expect(result).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(mocks.buildTeamLaunchPayload).not.toHaveBeenCalled();
    expect(mocks.dispatchTeamLaunchN1).not.toHaveBeenCalled();
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        agentId: "agent-1",
        deliveryId: "delivery-1",
        payload: expect.objectContaining({
          provider: "github",
          eventType: "issues.labeled",
          paths: expect.arrayContaining(["/github/repos/AgentWorkforce/cloud/issues/123.json"]),
          teamLaunchN1: true,
        }),
      }),
    );
    expect(mocks.drainIntegrationWatchDeliveries).not.toHaveBeenCalled();
  });

  it("routes maxMembers>1 teamSolve rows to the team-launch marker when the multi flag is on", async () => {
    vi.stubEnv("TEAM_LAUNCH_MULTI_TEST_MODE", "1");
    try {
      await usePgliteDispatcherDb();
      await insertPgliteAgent({
        id: "agent-1",
        watchGlobs: [],
        watchRules: [{
          paths: ["/github/repos/AgentWorkforce/cloud/issues/**"],
          events: ["issues.labeled"],
          conditions: [{ field: "label.name", equals: "team" }],
        }],
        spec: wrappedDeploymentSpec({
          capabilities: { teamSolve: { enabled: true, maxMembers: 3 } },
        }),
      });
      const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

      const result = await dispatchIntegrationWatchEvent({
        workspaceId: "workspace-1",
        provider: "github",
        eventType: "issues.labeled",
        connectionId: "conn-1",
        deliveryId: "delivery-1",
        paths: ["/github/repos/AgentWorkforce/cloud/issues/123.json"],
        payload: {
          label: { name: "team" },
          issue: { number: 123 },
          repository: { full_name: "AgentWorkforce/cloud" },
        },
      });

      expect(result).toEqual({ matched: 1, delivered: 1, failed: 0 });
      // Same sweep-only contract as N=1: marker enqueued, nothing inline.
      expect(mocks.dispatchTeamLaunchN1).not.toHaveBeenCalled();
      expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ teamLaunchN1: true }),
        }),
      );
      expect(mocks.drainIntegrationWatchDeliveries).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps maxMembers>1 teamSolve rows on the teamIssue stand-down when the multi flag is off", async () => {
    // No multi env stub: the real isTeamLaunchMultiEnabled reads falsy.
    await usePgliteDispatcherDb();
    await insertPgliteAgent({
      id: "agent-1",
      watchGlobs: [],
      watchRules: [{
        paths: ["/github/repos/AgentWorkforce/cloud/issues/**"],
        events: ["issues.labeled"],
        conditions: [{ field: "label.name", equals: "team" }],
      }],
      spec: wrappedDeploymentSpec({
        capabilities: { teamSolve: { enabled: true, maxMembers: 3 } },
      }),
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "issues.labeled",
      connectionId: "conn-1",
      deliveryId: "delivery-1",
      paths: ["/github/repos/AgentWorkforce/cloud/issues/123.json"],
      payload: {
        label: { name: "team" },
        issue: { number: 123 },
        repository: { full_name: "AgentWorkforce/cloud" },
      },
    });

    expect(result).toEqual({ matched: 1, delivered: 0, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).not.toHaveBeenCalled();
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Integration watch teamSolve stand-down",
      expect.objectContaining({ maxMembers: 3 }),
    );
  });

  it("does not build N=1 launch credentials inline before queueing", async () => {
    mocks.isTeamLaunchN1Enabled.mockReturnValue(true);
    mocks.buildTeamLaunchPayload.mockRejectedValueOnce(
      new mocks.TeamLaunchOptionsUnavailableError("missing launch credentials"),
    );
    await usePgliteDispatcherDb();
    await insertPgliteAgent({
      id: "agent-1",
      watchGlobs: [],
      watchRules: [{
        paths: ["/github/repos/AgentWorkforce/cloud/issues/**"],
        events: ["issues.labeled"],
        conditions: [{ field: "label.name", equals: "team" }],
      }],
      spec: {
        capabilities: { teamSolve: { enabled: true, maxMembers: 1 } },
      },
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "issues.labeled",
      connectionId: "conn-1",
      deliveryId: "delivery-1",
      paths: ["/github/repos/AgentWorkforce/cloud/issues/123.json"],
      payload: {
        label: { name: "team" },
        issue: { number: 123 },
        repository: { full_name: "AgentWorkforce/cloud" },
      },
    });

    expect(result).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(mocks.buildTeamLaunchPayload).not.toHaveBeenCalled();
    expect(mocks.dispatchTeamLaunchN1).not.toHaveBeenCalled();
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ teamLaunchN1: true }),
    }));
    expect(mocks.releaseWebhookDelivery).not.toHaveBeenCalled();
  });

  it("logs the N=1 launch-leg queue branch before enqueueing", async () => {
    mocks.isTeamLaunchN1Enabled.mockReturnValue(true);
    await usePgliteDispatcherDb();
    await insertPgliteAgent({
      id: "cloud-team-issue",
      watchGlobs: [],
      watchRules: [{
        paths: ["/github/repos/AgentWorkforce/cloud/issues/**"],
        events: ["issues.labeled"],
        conditions: [{ field: "label.name", equals: "team" }],
      }],
      spec: {
        capabilities: { teamSolve: { enabled: true, maxMembers: 1 } },
      },
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "issues.labeled",
      connectionId: "conn-1",
      deliveryId: "delivery-1",
      paths: ["/github/repos/AgentWorkforce/cloud/issues/123.json"],
      payload: {
        label: { name: "team" },
        issue: { number: 123 },
        repository: { full_name: "AgentWorkforce/cloud" },
      },
    });

    expect(result).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(mocks.buildTeamLaunchPayload).not.toHaveBeenCalled();
    expect(mocks.dispatchTeamLaunchN1).not.toHaveBeenCalled();
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "team-launch-n1 launch-leg diag",
      expect.objectContaining({
        area: "team-launch-n1-launch-diag",
        diag: "launch-branch-entered",
        agentId: "cloud-team-issue",
        deployedByUserIdPresent: true,
        organizationIdPresent: true,
        issueDedupe: "claimed",
        vfsDedupe: "claimed",
      }),
    );
  });

  it("logs N=1 launch-leg VFS dedupe skips before returning", async () => {
    mocks.isTeamLaunchN1Enabled.mockReturnValue(true);
    mocks.claimWebhookDelivery.mockResolvedValue(false);
    await usePgliteDispatcherDb();
    await insertPgliteAgent({
      id: "cloud-team-issue",
      watchGlobs: [],
      watchRules: [{
        paths: ["/github/repos/AgentWorkforce/cloud/issues/**"],
        events: ["issues.labeled"],
        conditions: [{ field: "label.name", equals: "team" }],
      }],
      spec: {
        capabilities: { teamSolve: { enabled: true, maxMembers: 1 } },
      },
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "issues.labeled",
      connectionId: "conn-1",
      deliveryId: "delivery-1",
      paths: ["/github/repos/AgentWorkforce/cloud/issues/123.json"],
      payload: {
        label: { name: "team" },
        issue: { number: 123 },
        repository: { full_name: "AgentWorkforce/cloud" },
      },
    });

    expect(result).toEqual({ matched: 1, delivered: 0, failed: 0 });
    expect(mocks.buildTeamLaunchPayload).not.toHaveBeenCalled();
    expect(mocks.dispatchTeamLaunchN1).not.toHaveBeenCalled();
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "team-launch-n1 launch-leg diag",
      expect.objectContaining({
        area: "team-launch-n1-launch-diag",
        diag: "vfs-dedupe-skipped",
        agentId: "cloud-team-issue",
        issueDedupe: "claimed",
        vfsDedupe: "skipped",
      }),
    );
  });

  it("logs N=1 launch-leg issue dedupe skips before returning", async () => {
    mocks.isTeamLaunchN1Enabled.mockReturnValue(true);
    await usePgliteDispatcherDb();
    await insertPgliteAgent({
      id: "cloud-team-issue",
      watchGlobs: [],
      watchRules: [{
        paths: ["/github/repos/AgentWorkforce/cloud/issues/**"],
        events: ["issues.labeled"],
        conditions: [{ field: "label.name", equals: "team" }],
      }],
      spec: {
        capabilities: { teamSolve: { enabled: true, maxMembers: 1 } },
      },
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");
    const baseInput = {
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "issues.labeled",
      connectionId: "conn-1",
      paths: ["/github/repos/AgentWorkforce/cloud/issues/123.json"],
      payload: {
        label: { name: "team" },
        issue: { number: 123 },
        repository: { full_name: "AgentWorkforce/cloud" },
      },
    } as const;
    await dispatchIntegrationWatchEvent({ ...baseInput, deliveryId: "delivery-1" });
    mocks.loggerInfo.mockClear();
    mocks.buildTeamLaunchPayload.mockClear();
    mocks.dispatchTeamLaunchN1.mockClear();

    const result = await dispatchIntegrationWatchEvent({ ...baseInput, deliveryId: "delivery-2" });

    expect(result).toEqual({ matched: 1, delivered: 0, failed: 0 });
    expect(mocks.buildTeamLaunchPayload).not.toHaveBeenCalled();
    expect(mocks.dispatchTeamLaunchN1).not.toHaveBeenCalled();
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "team-launch-n1 launch-leg diag",
      expect.objectContaining({
        area: "team-launch-n1-launch-diag",
        diag: "issue-dedupe-skipped",
        agentId: "cloud-team-issue",
        issueDedupe: "skipped",
      }),
    );
  });

  it("routes the cloud-team-issue persona to marked N=1 delivery queue rows", async () => {
    process.env.TEAM_ISSUE_TEST_MODE = "true";
    mocks.isTeamLaunchN1Enabled.mockReturnValue(true);
    await usePgliteDispatcherDb();
    await insertPgliteAgent({
      id: "cloud-team-issue",
      watchGlobs: [],
      watchRules: [{
        paths: ["/github/repos/AgentWorkforce/cloud/issues/**"],
        events: ["issues.labeled"],
        conditions: [{ field: "label.name", equals: "team" }],
      }],
      spec: teamIssuePersona,
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "issues.labeled",
      connectionId: "conn-1",
      deliveryId: "delivery-1",
      paths: ["/github/repos/AgentWorkforce/cloud/issues/123.json"],
      payload: {
        label: { name: "team" },
        issue: { number: 123, state: "open" },
        repository: { full_name: "AgentWorkforce/cloud" },
      },
    });

    expect(result).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(mocks.buildTeamLaunchPayload).not.toHaveBeenCalled();
    expect(mocks.dispatchTeamLaunchN1).not.toHaveBeenCalled();
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        agentId: "cloud-team-issue",
        deliveryId: "delivery-1",
        payload: expect.objectContaining({
          provider: "github",
          eventType: "issues.labeled",
          paths: expect.arrayContaining(["/github/repos/AgentWorkforce/cloud/issues/123.json"]),
          teamLaunchN1: true,
        }),
      }),
    );
    expect(mocks.drainIntegrationWatchDeliveries).not.toHaveBeenCalled();
  });

  it("keeps the cloud team issue fallback flag default-off", async () => {
    const { isCloudTeamIssueEnabled } = await import("./integration-watch-dispatcher");

    expect(isCloudTeamIssueEnabled()).toBe(false);
  });

  it("stands down non-N=1 teamSolve rows when the team issue flag is disabled", async () => {
    mocks.isTeamLaunchN1Enabled.mockReturnValue(true);
    await usePgliteDispatcherDb();
    await insertPgliteAgent({
      id: "agent-1",
      watchGlobs: [],
      watchRules: [{
        paths: ["/github/repos/AgentWorkforce/cloud/issues/**"],
        events: ["issues.labeled"],
        conditions: [{ field: "label.name", equals: "team" }],
      }],
      spec: {
        capabilities: { teamSolve: { enabled: true, maxMembers: 4 } },
      },
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "issues.labeled",
      connectionId: "conn-1",
      deliveryId: "delivery-1",
      paths: ["/github/repos/AgentWorkforce/cloud/issues/123.json"],
      payload: {
        label: { name: "team" },
        issue: { number: 123 },
        repository: { full_name: "AgentWorkforce/cloud" },
      },
    });

    expect(result).toEqual({ matched: 1, delivered: 0, failed: 0 });
    expect(mocks.dispatchTeamLaunchN1).not.toHaveBeenCalled();
    expect(mocks.enqueueIntegrationWatchDelivery).not.toHaveBeenCalled();
    expect(mocks.drainIntegrationWatchDeliveries).not.toHaveBeenCalled();
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Integration watch teamSolve stand-down",
      expect.objectContaining({
        area: "team-issue",
        diag: "disabled",
        agentId: "agent-1",
        maxMembers: 4,
      }),
    );
  });

  it("routes non-N=1 teamSolve rows to normal delivery when the team issue flag is enabled", async () => {
    process.env.TEAM_ISSUE_TEST_MODE = "true";
    mocks.isTeamLaunchN1Enabled.mockReturnValue(true);
    await usePgliteDispatcherDb();
    await insertPgliteAgent({
      id: "agent-1",
      watchGlobs: [],
      watchRules: [{
        paths: ["/github/repos/AgentWorkforce/cloud/issues/**"],
        events: ["issues.labeled"],
        conditions: [{ field: "label.name", equals: "team" }],
      }],
      spec: {
        capabilities: { teamSolve: { enabled: true, maxMembers: 4 } },
      },
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "issues.labeled",
      connectionId: "conn-1",
      deliveryId: "delivery-1",
      paths: ["/github/repos/AgentWorkforce/cloud/issues/123.json"],
      payload: {
        label: { name: "team" },
        issue: { number: 123, state: "open" },
        repository: { full_name: "AgentWorkforce/cloud" },
      },
    });

    expect(result).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(mocks.dispatchTeamLaunchN1).not.toHaveBeenCalled();
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      deliveryId: "delivery-1",
    }));
  });

  it("does not log launch-leg diagnostics for non-N=1 teamSolve dedupe skips", async () => {
    process.env.TEAM_ISSUE_TEST_MODE = "true";
    mocks.isTeamLaunchN1Enabled.mockReturnValue(true);
    await usePgliteDispatcherDb();
    await insertPgliteAgent({
      id: "cloud-team-issue",
      watchGlobs: [],
      watchRules: [{
        paths: ["/github/repos/AgentWorkforce/cloud/issues/**"],
        events: ["issues.labeled"],
        conditions: [{ field: "label.name", equals: "team" }],
      }],
      spec: {
        capabilities: { teamSolve: { enabled: true, maxMembers: 4 } },
      },
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");
    const baseInput = {
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "issues.labeled",
      connectionId: "conn-1",
      paths: ["/github/repos/AgentWorkforce/cloud/issues/123.json"],
      payload: {
        label: { name: "team" },
        issue: { number: 123, state: "open" },
        repository: { full_name: "AgentWorkforce/cloud" },
      },
    } as const;

    await dispatchIntegrationWatchEvent({ ...baseInput, deliveryId: "delivery-1" });
    mocks.loggerInfo.mockClear();
    mocks.enqueueIntegrationWatchDelivery.mockClear();

    const result = await dispatchIntegrationWatchEvent({ ...baseInput, deliveryId: "delivery-2" });

    expect(result).toEqual({ matched: 1, delivered: 0, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).not.toHaveBeenCalled();
    expect(mocks.loggerInfo).not.toHaveBeenCalledWith(
      "team-launch-n1 launch-leg diag",
      expect.any(Object),
    );
  });

  it("does not route cloud-team-issue opened events because the N=1 contract is label-only", async () => {
    process.env.TEAM_ISSUE_TEST_MODE = "true";
    await usePgliteDispatcherDb();
    await insertPgliteAgent({
      id: "cloud-team-issue",
      watchGlobs: [],
      watchRules: [{
        paths: ["/github/repos/AgentWorkforce/cloud/issues/**"],
        events: ["issues.labeled"],
        conditions: [{ field: "label.name", equals: "team" }],
      }],
      spec: teamIssuePersona,
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "issues.opened",
      connectionId: "conn-1",
      deliveryId: "delivery-1",
      paths: ["/github/repos/AgentWorkforce/cloud/issues/123.json"],
      payload: {
        issue: {
          number: 123,
          state: "open",
          labels: [{ name: "bug" }, { name: "team" }],
        },
        repository: { full_name: "AgentWorkforce/cloud" },
      },
    });

    expect(result).toEqual({ matched: 0, delivered: 0, failed: 0 });
    expect(mocks.dispatchTeamLaunchN1).not.toHaveBeenCalled();
    expect(mocks.enqueueIntegrationWatchDelivery).not.toHaveBeenCalled();
  });

  it("does not route non-team labels into the teamSolve adapter", async () => {
    mocks.isTeamLaunchN1Enabled.mockReturnValue(true);
    await usePgliteDispatcherDb();
    await insertPgliteAgent({
      id: "agent-1",
      watchGlobs: [],
      watchRules: [{
        paths: ["/github/repos/AgentWorkforce/cloud/issues/**"],
        events: ["issues.labeled"],
        conditions: [{ field: "label.name", equals: "team" }],
      }],
      spec: {
        capabilities: { teamSolve: { enabled: true, maxMembers: 1 } },
      },
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "issues.labeled",
      connectionId: "conn-1",
      deliveryId: "delivery-1",
      paths: ["/github/repos/AgentWorkforce/cloud/issues/123.json"],
      payload: {
        label: { name: "small" },
        issue: { number: 123 },
        repository: { full_name: "AgentWorkforce/cloud" },
      },
    });

    expect(result).toEqual({ matched: 0, delivered: 0, failed: 0 });
    expect(mocks.dispatchTeamLaunchN1).not.toHaveBeenCalled();
    expect(mocks.enqueueIntegrationWatchDelivery).not.toHaveBeenCalled();
  });

  it("skips pr-reviewer self-trigger synchronize events from its own fix push", async () => {
    mocks.dbExecute.mockResolvedValue({
      rows: [
        {
          id: "agent-pr-reviewer",
          deployed_name: "pr-reviewer",
          watch_globs: ["/github/repos/**/**/pulls/**"],
          spec: {
            intent: "review",
            integrations: {
              github: { triggers: [{ on: "pull_request.synchronize" }] },
            },
          },
        },
        {
          id: "agent-audit",
          deployed_name: "audit-agent",
          watch_globs: ["/github/repos/**/**/pulls/**"],
          spec: {
            intent: "audit",
            integrations: {
              github: { triggers: [{ on: "pull_request.synchronize" }] },
            },
          },
        },
      ],
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "pull_request.synchronize",
      connectionId: "conn-1",
      deliveryId: "delivery-pr-sync",
      paths: ["/github/repos/AgentWorkforce/cloud/pulls/1421__probe6/meta.json"],
      payload: {
        sender: { login: "file-by-agent-relay[bot]", type: "Bot" },
        pull_request: {
          number: 1421,
          head: {
            sha: "f3e232664213ad7dadacce199b7670c5067682ee",
            user: { login: "file-by-agent-relay[bot]", type: "Bot" },
          },
        },
      },
    });

    expect(result).toEqual({ matched: 2, delivered: 1, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent-audit",
    }));
    expect(mocks.enqueueIntegrationWatchDelivery).not.toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent-pr-reviewer",
    }));
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Integration watch dispatch skipped self-trigger",
      expect.objectContaining({
        diag: "self-trigger",
        matched: 2,
        skipped: 1,
      }),
    );
  });

  it("delivers a conflicting PR synchronize to a conflict-autofix persona", async () => {
    await usePgliteDispatcherDb();
    await insertPgliteAgent({
      id: "agent-conflict-autofix",
      deployedName: "conflict-autofix",
      watchGlobs: [],
      watchRules: [
        {
          paths: ["/github/repos/**/pulls/**"],
          events: ["pull_request.synchronize"],
          conditions: [{ field: "action", in: ["synchronize"] }],
        },
      ],
      spec: wrappedDeploymentSpec({ capabilities: { conflictAutofix: true } }),
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "pull_request.synchronize",
      connectionId: "conn-1",
      deliveryId: "delivery-autofix-human",
      paths: ["/github/repos/AgentWorkforce/cloud/pulls/77__feature/meta.json"],
      payload: {
        action: "synchronize",
        sender: { login: "a-human", type: "User" },
        number: 77,
        head: { sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
      },
    });

    expect(result).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-conflict-autofix" }),
    );
  });

  it("suppresses the conflict-autofix bot's own rebase push (no infinite loop)", async () => {
    await usePgliteDispatcherDb();
    await insertPgliteAgent({
      id: "agent-conflict-autofix",
      deployedName: "conflict-autofix",
      watchGlobs: [],
      watchRules: [
        {
          paths: ["/github/repos/**/pulls/**"],
          events: ["pull_request.synchronize"],
          conditions: [{ field: "action", in: ["synchronize"] }],
        },
      ],
      spec: wrappedDeploymentSpec({ capabilities: { conflictAutofix: true } }),
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "pull_request.synchronize",
      connectionId: "conn-1",
      deliveryId: "delivery-autofix-selftrigger",
      paths: ["/github/repos/AgentWorkforce/cloud/pulls/77__feature/meta.json"],
      payload: {
        action: "synchronize",
        // the safe rebase push surfaces as a synchronize from the autofix bot
        sender: { login: "relay-conflict-autofix[bot]", type: "Bot" },
        number: 77,
        head: {
          sha: "cafebabecafebabecafebabecafebabecafebabe",
          user: { login: "relay-conflict-autofix[bot]", type: "Bot" },
        },
      },
    });

    expect(result).toEqual({ matched: 1, delivered: 0, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).not.toHaveBeenCalled();
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Integration watch dispatch skipped self-trigger",
      expect.objectContaining({ diag: "self-trigger", matched: 1, skipped: 1 }),
    );
  });

  it("does not suppress a non-autofix bot push for a conflict-autofix persona", async () => {
    await usePgliteDispatcherDb();
    await insertPgliteAgent({
      id: "agent-conflict-autofix",
      deployedName: "conflict-autofix",
      watchGlobs: [],
      watchRules: [
        {
          paths: ["/github/repos/**/pulls/**"],
          events: ["pull_request.synchronize"],
          conditions: [{ field: "action", in: ["synchronize"] }],
        },
      ],
      spec: { capabilities: { conflictAutofix: true } },
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "pull_request.synchronize",
      connectionId: "conn-1",
      deliveryId: "delivery-autofix-other-bot",
      paths: ["/github/repos/AgentWorkforce/cloud/pulls/77__feature/meta.json"],
      payload: {
        action: "synchronize",
        sender: { login: "dependabot[bot]", type: "Bot" },
        number: 77,
        head: {
          sha: "f00df00df00df00df00df00df00df00df00df00d",
          user: { login: "dependabot[bot]", type: "Bot" },
        },
      },
    });

    expect(result).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-conflict-autofix" }),
    );
  });

  it("skips conflict-resolve issue comments without the opt-in directive", async () => {
    await usePgliteDispatcherDb();
    await insertPgliteAgent({
      id: "agent-conflict-resolve",
      deployedName: "conflict-resolve",
      watchGlobs: [],
      watchRules: [
        {
          paths: ["/github/repos/**/issues/**"],
          events: ["issue_comment.created"],
          conditions: [{ field: "action", in: ["created"] }],
        },
      ],
      spec: wrappedDeploymentSpec({ capabilities: { conflictResolve: true } }),
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "issue_comment.created",
      connectionId: "conn-1",
      deliveryId: "delivery-conflict-resolve-no-directive",
      paths: ["/github/repos/AgentWorkforce/cloud/issues/77/comments/comment-1.json"],
      payload: {
        action: "created",
        sender: { login: "a-human", type: "User" },
        comment: { body: "please take a look" },
        issue: { number: 77, pull_request: { url: "https://api.github.com/repos/AgentWorkforce/cloud/pulls/77" } },
        repository: { full_name: "AgentWorkforce/cloud" },
      },
    });

    expect(result).toEqual({ matched: 0, delivered: 0, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).not.toHaveBeenCalled();
  });

  it("delivers conflict-resolve PR issue comments with the opt-in directive", async () => {
    await usePgliteDispatcherDb();
    await insertPgliteAgent({
      id: "agent-conflict-resolve",
      deployedName: "conflict-resolve",
      watchGlobs: [],
      watchRules: [
        {
          paths: ["/github/repos/**/issues/**"],
          events: ["issue_comment.created"],
          conditions: [{ field: "action", in: ["created"] }],
        },
      ],
      spec: wrappedDeploymentSpec({ capabilities: { conflictResolve: true } }),
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "issue_comment.created",
      connectionId: "conn-1",
      deliveryId: "delivery-conflict-resolve-directive",
      paths: ["/github/repos/AgentWorkforce/cloud/issues/77/comments/comment-1.json"],
      payload: {
        action: "created",
        sender: { login: "a-human", type: "User" },
        comment: { body: "@relay fix conflicts" },
        issue: { number: 77, pull_request: { url: "https://api.github.com/repos/AgentWorkforce/cloud/pulls/77" } },
        repository: { full_name: "AgentWorkforce/cloud" },
      },
    });

    expect(result).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-conflict-resolve" }),
    );
  });

  it("skips pr-reviewer self-trigger synchronize events from the renamed agent-relay bot", async () => {
    mocks.dbExecute.mockResolvedValue({
      rows: [
        {
          id: "agent-pr-reviewer",
          deployed_name: "pr-reviewer",
          watch_globs: ["/github/repos/**/**/pulls/**"],
          spec: {
            intent: "review",
            integrations: {
              github: { triggers: [{ on: "pull_request.synchronize" }] },
            },
          },
        },
      ],
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "pull_request.synchronize",
      connectionId: "conn-1",
      deliveryId: "delivery-pr-sync-agent-relay-bot",
      paths: ["/github/repos/AgentWorkforce/cloud/pulls/60__probe/meta.json"],
      payload: {
        sender: { login: "agent-relay-bot[bot]", type: "Bot" },
        pull_request: {
          number: 60,
          head: {
            sha: "7a4cc44",
            user: { login: "agent-relay-bot[bot]", type: "Bot" },
          },
        },
      },
    });

    expect(result).toEqual({ matched: 1, delivered: 0, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).not.toHaveBeenCalled();
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Integration watch dispatch observed pull-request bot actor",
      expect.objectContaining({
        area: "pr-reviewer-self-trigger",
        actorLogin: "agent-relay-bot[bot]",
        actorType: "Bot",
        suppressed: true,
        eventType: "pull_request.synchronize",
      }),
    );
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Integration watch dispatch skipped self-trigger",
      expect.objectContaining({ diag: "self-trigger", matched: 1, skipped: 1 }),
    );
  });

  it("skips renamed bot events when the reviewer still has the old bot login explicitly configured", async () => {
    mocks.dbExecute.mockResolvedValue({
      rows: [
        {
          id: "agent-pr-reviewer",
          deployed_name: "pr-reviewer",
          watch_globs: ["/github/repos/**/**/pulls/**"],
          spec: {
            intent: "review",
            capabilities: {
              pullRequest: {
                checkout: true,
                writeback: true,
                formalReview: true,
                botIdentity: "file-by-agent-relay[bot]",
              },
            },
            integrations: {
              github: { triggers: [{ on: "pull_request.synchronize" }] },
            },
          },
        },
      ],
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "pull_request.synchronize",
      connectionId: "conn-1",
      deliveryId: "delivery-pr-sync-explicit-old-login",
      paths: ["/github/repos/AgentWorkforce/cloud/pulls/60__probe/meta.json"],
      payload: {
        sender: { login: "agent-relay-bot[bot]", type: "Bot" },
        pull_request: {
          number: 60,
          head: {
            sha: "7a4cc44",
            user: { login: "agent-relay-bot[bot]", type: "Bot" },
          },
        },
      },
    });

    expect(result).toEqual({ matched: 1, delivered: 0, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).not.toHaveBeenCalled();
  });

  it("uses explicit reviewer bot login from wrapped deployment snapshots", async () => {
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([]);
    mocks.dbExecute.mockResolvedValue({
      rows: [
        {
          id: "agent-wrapped-reviewer",
          deployed_name: "wrapped-reviewer",
          watch_globs: ["/github/repos/**/**/pulls/**"],
          spec: wrappedDeploymentSpec(
            {
              capabilities: {
                pullRequest: {
                  checkout: true,
                  writeback: true,
                  formalReview: true,
                  botIdentity: "wrapped-reviewer[bot]",
                },
              },
            },
            {
              triggers: {
                github: [{ on: "pull_request.synchronize" }],
              },
            },
          ),
        },
      ],
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "pull_request.synchronize",
      connectionId: "conn-1",
      deliveryId: "delivery-wrapped-reviewer-self-trigger",
      paths: ["/github/repos/AgentWorkforce/cloud/pulls/60__probe/meta.json"],
      payload: {
        sender: { login: "wrapped-reviewer[bot]", type: "Bot" },
        pull_request: {
          number: 60,
          head: {
            sha: "7a4cc44",
            user: { login: "wrapped-reviewer[bot]", type: "Bot" },
          },
        },
      },
    });

    expect(result).toEqual({ matched: 1, delivered: 0, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).not.toHaveBeenCalled();
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Integration watch dispatch observed pull-request bot actor",
      expect.objectContaining({
        area: "pr-reviewer-self-trigger",
        actorLogin: "wrapped-reviewer[bot]",
        actorType: "Bot",
        suppressed: true,
        eventType: "pull_request.synchronize",
      }),
    );
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Integration watch dispatch skipped self-trigger",
      expect.objectContaining({ diag: "self-trigger", matched: 1, skipped: 1 }),
    );
  });

  it("delivers human pull request review comments to the pr-reviewer checkout", async () => {
    mocks.dbExecute.mockResolvedValue({
      rows: [
        {
          id: "agent-pr-reviewer",
          deployed_name: "pr-reviewer",
          watch_globs: ["/github/repos/**/**/pulls/**"],
          spec: {
            intent: "review",
            integrations: {
              github: { triggers: [{ on: "pull_request_review_comment.created" }] },
            },
          },
        },
      ],
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "pull_request_review_comment.created",
      connectionId: "conn-1",
      deliveryId: "delivery-human-review-comment",
      paths: ["/github/repos/AgentWorkforce/cloud/pulls/60__probe/meta.json"],
      payload: {
        sender: { login: "human-reviewer", type: "User" },
        comment: { id: 987, user: { login: "human-reviewer", type: "User" } },
        pull_request: { number: 60, head: { sha: "7a4cc44" } },
      },
    });

    expect(result).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent-pr-reviewer",
      payload: expect.objectContaining({
        type: "github.pull_request_review_comment.created",
        eventType: "pull_request_review_comment.created",
      }),
    }));
  });

  it("suppresses the pr-reviewer's own pull request review comments from the renamed bot", async () => {
    mocks.dbExecute.mockResolvedValue({
      rows: [
        {
          id: "agent-pr-reviewer",
          deployed_name: "pr-reviewer",
          watch_globs: ["/github/repos/**/**/pulls/**"],
          spec: {
            intent: "review",
            integrations: {
              github: { triggers: [{ on: "pull_request_review_comment.created" }] },
            },
          },
        },
      ],
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "pull_request_review_comment.created",
      connectionId: "conn-1",
      deliveryId: "delivery-self-review-comment",
      paths: ["/github/repos/AgentWorkforce/cloud/pulls/60__probe/meta.json"],
      payload: {
        sender: { login: "agent-relay-bot[bot]", type: "Bot" },
        comment: { id: 988, user: { login: "agent-relay-bot[bot]", type: "Bot" } },
        pull_request: { number: 60, head: { sha: "7a4cc44" } },
      },
    });

    expect(result).toEqual({ matched: 1, delivered: 0, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).not.toHaveBeenCalled();
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Integration watch dispatch observed pull-request bot actor",
      expect.objectContaining({
        area: "pr-reviewer-self-trigger",
        actorLogin: "agent-relay-bot[bot]",
        actorType: "Bot",
        suppressed: true,
        eventType: "pull_request_review_comment.created",
      }),
    );
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Integration watch dispatch skipped self-trigger",
      expect.objectContaining({ diag: "self-trigger", matched: 1, skipped: 1 }),
    );
  });

  it("does not suppress unrelated bot synchronize events so external pushes re-fire review", async () => {
    mocks.dbExecute.mockResolvedValue({
      rows: [
        {
          id: "agent-pr-reviewer",
          deployed_name: "pr-reviewer",
          watch_globs: ["/github/repos/**/**/pulls/**"],
          spec: {
            intent: "review",
            integrations: {
              github: { triggers: [{ on: "pull_request.synchronize" }] },
            },
          },
        },
      ],
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "pull_request.synchronize",
      connectionId: "conn-1",
      deliveryId: "delivery-pr-sync-dependabot",
      paths: ["/github/repos/AgentWorkforce/cloud/pulls/60__probe/meta.json"],
      payload: {
        sender: { login: "dependabot[bot]", type: "Bot" },
        pull_request: {
          number: 60,
          head: {
            sha: "external123",
            user: { login: "dependabot[bot]", type: "Bot" },
          },
        },
      },
    });

    expect(result).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent-pr-reviewer",
    }));
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Integration watch dispatch observed pull-request bot actor",
      expect.objectContaining({
        area: "pr-reviewer-self-trigger",
        actorLogin: "dependabot[bot]",
        actorType: "Bot",
        suppressed: false,
        eventType: "pull_request.synchronize",
      }),
    );
    expect(mocks.loggerInfo).not.toHaveBeenCalledWith(
      "Integration watch dispatch skipped self-trigger",
      expect.anything(),
    );
  });

  it("does not suppress a custom reviewer when the default pr-reviewer bot pushes", async () => {
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([
      {
        workspaceId: "workspace-1",
        provider: "github-custom-reviewer",
        name: null,
        connectionId: "conn-custom-reviewer",
        providerConfigKey: "github-custom-reviewer",
        installationId: null,
        metadata: { app: { botLogin: "custom-reviewer[bot]" } },
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);
    mocks.dbExecute.mockResolvedValue({
      rows: [
        {
          id: "agent-custom-reviewer",
          deployed_name: "custom-reviewer",
          watch_globs: ["/github/repos/**/**/pulls/**"],
          spec: {
            intent: "review",
            integrations: {
              github: { triggers: [{ on: "pull_request.synchronize" }] },
            },
          },
        },
      ],
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "pull_request.synchronize",
      connectionId: "conn-custom-reviewer",
      deliveryId: "delivery-custom-reviewer-default-bot-push",
      paths: ["/github/repos/AgentWorkforce/cloud/pulls/1448__probe/meta.json"],
      payload: {
        sender: { login: "agent-relay-bot[bot]", type: "Bot" },
        pull_request: {
          number: 1448,
          head: {
            sha: "c931c9fa",
            user: { login: "agent-relay-bot[bot]", type: "Bot" },
          },
        },
      },
    });

    expect(result).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent-custom-reviewer",
    }));
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Integration watch dispatch observed pull-request bot actor",
      expect.objectContaining({
        actorLogin: "agent-relay-bot[bot]",
        suppressed: false,
      }),
    );
  });

  it("skips renamed review-intent personas when the event actor is their own bot", async () => {
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([
      {
        workspaceId: "workspace-1",
        provider: "github-custom-reviewer",
        name: null,
        connectionId: "conn-custom-reviewer",
        providerConfigKey: "github-custom-reviewer",
        installationId: null,
        metadata: { app: { botLogin: "custom-reviewer[bot]" } },
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);
    mocks.dbExecute.mockResolvedValue({
      rows: [
        {
          id: "agent-custom-reviewer",
          deployed_name: "custom-reviewer",
          watch_globs: ["/github/repos/**/**/pulls/**"],
          spec: {
            intent: "review",
            integrations: {
              github: { triggers: [{ on: "pull_request_review.submitted" }] },
            },
          },
        },
      ],
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "pull_request_review.submitted",
      connectionId: "conn-custom-reviewer",
      deliveryId: "delivery-custom-self-review",
      paths: ["/github/repos/AgentWorkforce/cloud/pulls/1448__probe/meta.json"],
      payload: {
        sender: { login: "custom-reviewer[bot]", type: "Bot" },
        review: { state: "commented", user: { login: "custom-reviewer[bot]", type: "Bot" } },
        pull_request: { number: 1448, head: { sha: "c931c9fa" } },
      },
    });

    expect(result).toEqual({ matched: 1, delivered: 0, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).not.toHaveBeenCalled();
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Integration watch dispatch skipped self-trigger",
      expect.objectContaining({ diag: "self-trigger", matched: 1, skipped: 1 }),
    );
  });

  it("logs when deriving the reviewer bot login from a workspace service account source name", async () => {
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([]);
    mocks.dbExecute.mockResolvedValue({
      rows: [
        {
          id: "agent-release-reviewer",
          deployed_name: "release-reviewer",
          watch_globs: ["/github/repos/**/**/pulls/**"],
          spec: wrappedDeploymentSpec(
            {
              intent: "review",
              integrations: {
                github: {
                  source: { kind: "workspace_service_account", name: "release-reviewer" },
                },
              },
            },
            {
              triggers: {
                github: [{ on: "issue_comment.created" }],
              },
            },
          ),
        },
      ],
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "issue_comment.created",
      connectionId: "conn-release-reviewer",
      deliveryId: "delivery-release-self-comment",
      paths: ["/github/repos/AgentWorkforce/cloud/issues/1448__probe/meta.json"],
      payload: {
        sender: { login: "release-reviewer[bot]", type: "Bot" },
        comment: { user: { login: "release-reviewer[bot]", type: "Bot" } },
        issue: { number: 1448, pull_request: {} },
      },
    });

    expect(result).toEqual({ matched: 1, delivered: 0, failed: 0 });
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "Integration watch dispatch used heuristic GitHub bot login fallback",
      expect.objectContaining({
        diag: "github-bot-login-source-name-fallback",
        agentId: "agent-release-reviewer",
        sourceName: "release-reviewer",
        derivedBotLogin: "release-reviewer[bot]",
      }),
    );
  });

  it("accepts explicit pullRequest capability as a reviewer gate without a hardcoded persona name", async () => {
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([
      {
        workspaceId: "workspace-1",
        provider: "github",
        name: null,
        connectionId: "conn-1",
        providerConfigKey: "github-relay",
        installationId: null,
        metadata: { githubBotLogin: "capability-reviewer[bot]" },
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);
    mocks.dbExecute.mockResolvedValue({
      rows: [
        {
          id: "agent-capability-reviewer",
          deployed_name: "capability-reviewer",
          watch_globs: ["/github/repos/**/**/pulls/**"],
          spec: {
            capabilities: {
              pullRequest: {
                checkout: true,
                writeback: true,
                formalReview: true,
              },
            },
            integrations: {
              github: { triggers: [{ on: "pull_request_review.submitted" }] },
            },
          },
        },
      ],
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "pull_request_review.submitted",
      connectionId: "conn-1",
      deliveryId: "delivery-capability-review",
      paths: ["/github/repos/AgentWorkforce/cloud/pulls/1448__probe/meta.json"],
      payload: {
        sender: { login: "capability-reviewer[bot]", type: "Bot" },
        review: { state: "commented", user: { login: "capability-reviewer[bot]", type: "Bot" } },
        pull_request: { number: 1448, head: { sha: "c931c9fa" } },
      },
    });

    expect(result).toEqual({ matched: 1, delivered: 0, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).not.toHaveBeenCalled();
  });

  it("does not use broad review tags as the reviewer self-trigger gate", async () => {
    mocks.dbExecute.mockResolvedValue({
      rows: [
        {
          id: "agent-tagged-reviewer",
          deployed_name: "tagged-reviewer",
          watch_globs: ["/github/repos/**/**/pulls/**"],
          spec: {
            tags: ["review"],
            integrations: {
              github: { triggers: [{ on: "pull_request_review.submitted" }] },
            },
          },
        },
      ],
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "pull_request_review.submitted",
      connectionId: "conn-1",
      deliveryId: "delivery-tagged-review",
      paths: ["/github/repos/AgentWorkforce/cloud/pulls/1448__probe/meta.json"],
      payload: {
        sender: { login: "file-by-agent-relay[bot]", type: "Bot" },
        review: { state: "commented", user: { login: "file-by-agent-relay[bot]", type: "Bot" } },
        pull_request: { number: 1448, head: { sha: "c931c9fa" } },
      },
    });

    expect(result).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent-tagged-reviewer",
    }));
  });

  it("does not skip human synchronize events that only spoof the fix commit message", async () => {
    mocks.dbExecute.mockResolvedValue({
      rows: [
        {
          id: "agent-pr-reviewer",
          deployed_name: "pr-reviewer",
          watch_globs: ["/github/repos/**/**/pulls/**"],
          spec: {
            intent: "review",
            integrations: {
              github: { triggers: [{ on: "pull_request.synchronize" }] },
            },
          },
        },
      ],
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "pull_request.synchronize",
      connectionId: "conn-1",
      deliveryId: "delivery-human-pr-sync",
      paths: ["/github/repos/AgentWorkforce/cloud/pulls/1421__probe6/meta.json"],
      payload: {
        sender: { login: "contributor", type: "User" },
        head_commit: { message: "chore: apply pr-reviewer fixes for #1421" },
        pull_request: {
          number: 1421,
          head: {
            sha: "abc123",
            user: { login: "contributor", type: "User" },
          },
        },
      },
    });

    expect(result).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent-pr-reviewer",
    }));
    expect(mocks.loggerInfo).not.toHaveBeenCalledWith(
      "Integration watch dispatch skipped self-trigger",
      expect.anything(),
    );
  });

  it("skips the pr-reviewer's own formal review (pull_request_review.submitted by the bot)", async () => {
    mocks.dbExecute.mockResolvedValue({
      rows: [
        {
          id: "agent-pr-reviewer",
          deployed_name: "pr-reviewer",
          watch_globs: ["/github/repos/**/**/pulls/**"],
          spec: {
            intent: "review",
            integrations: {
              github: { triggers: [{ on: "pull_request_review.submitted" }] },
            },
          },
        },
      ],
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "pull_request_review.submitted",
      connectionId: "conn-1",
      deliveryId: "delivery-self-review",
      paths: ["/github/repos/AgentWorkforce/cloud/pulls/1426__probe7/meta.json"],
      payload: {
        sender: { login: "file-by-agent-relay[bot]", type: "Bot" },
        review: { state: "commented", user: { login: "file-by-agent-relay[bot]", type: "Bot" } },
        pull_request: { number: 1426, head: { sha: "c931c9fa" } },
      },
    });

    expect(result).toEqual({ matched: 1, delivered: 0, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).not.toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent-pr-reviewer",
    }));
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Integration watch dispatch skipped self-trigger",
      expect.objectContaining({ diag: "self-trigger", matched: 1, skipped: 1 }),
    );
  });

  it("delivers another reviewer's review/comment so the pr-reviewer can act on it", async () => {
    mocks.dbExecute.mockResolvedValue({
      rows: [
        {
          id: "agent-pr-reviewer",
          deployed_name: "pr-reviewer",
          watch_globs: ["/github/repos/**/**/pulls/**"],
          spec: {
            intent: "review",
            integrations: {
              github: { triggers: [{ on: "pull_request_review.submitted" }] },
            },
          },
        },
      ],
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "pull_request_review.submitted",
      connectionId: "conn-1",
      deliveryId: "delivery-human-review",
      paths: ["/github/repos/AgentWorkforce/cloud/pulls/1426__probe7/meta.json"],
      payload: {
        sender: { login: "coderabbitai[bot]", type: "Bot" },
        review: { state: "changes_requested", user: { login: "coderabbitai[bot]", type: "Bot" } },
        pull_request: { number: 1426, head: { sha: "c931c9fa" } },
      },
    });

    expect(result).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent-pr-reviewer",
    }));
    expect(mocks.loggerInfo).not.toHaveBeenCalledWith(
      "Integration watch dispatch skipped self-trigger",
      expect.anything(),
    );
  });

  it("dispatches Relayfile workspace events to agents stored under the app workspace UUID", async () => {
    mocks.resolveAppWorkspaceIdForRuntime.mockResolvedValue(
      "50587328-441d-4acb-b8f3-dbe1b3c5de99",
    );
    mocks.dbExecute.mockResolvedValue({
      rows: [
        {
          id: "agent-1",
          watch_globs: ["/slack/**"],
          watch_rules: null,
          spec: {
            integrations: {
              slack: { triggers: [{ on: "app_mention" }] },
            },
          },
        },
      ],
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "rw_7ccfea89",
      provider: "slack",
      eventType: "app_mention",
      connectionId: "conn-slack",
      deliveryId: "delivery-slack",
      paths: ["/slack/events/app_mention/1.json"],
      payload: { text: "hello" },
    });

    expect(result).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
      agentId: "agent-1",
      payload: expect.objectContaining({
        workspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
        relayWorkspaceId: "rw_7ccfea89",
      }),
    }));
  });

  it("smoke: fires a GitHub forward event from a Relay workspace into an app-workspace persona", async () => {
    const appWorkspaceId = "50587328-441d-4acb-b8f3-dbe1b3c5de99";
    const relayWorkspaceId = "rw_7ccfea89";
    mocks.resolveAppWorkspaceIdForRuntime.mockResolvedValue(appWorkspaceId);
    mocks.dbExecute.mockResolvedValue({
      rows: [
        {
          id: "agent-small-issue",
          deployed_name: "small-issue",
          watch_globs: ["/github/repos/**/**/issues/**"],
          watch_rules: null,
          spec: {
            intent: "fix",
            integrations: {
              github: { triggers: [{ on: "issues.opened" }] },
            },
          },
        },
      ],
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: relayWorkspaceId,
      provider: "github",
      eventType: "issues.opened",
      connectionId: "conn-github",
      deliveryId: "delivery-github-forward-cold-start",
      paths: ["/github/repos/AgentWorkforce/cloud/issues/1452__probe/meta.json"],
      payload: {
        action: "opened",
        repository: { full_name: "AgentWorkforce/cloud" },
        issue: { number: 1452, title: "cold-start proactive firing probe" },
        sender: { login: "human-reviewer", type: "User" },
      },
    });

    expect(mocks.resolveAppWorkspaceIdForRuntime).toHaveBeenCalledWith(relayWorkspaceId);
    expect(
      mocks.resolveAppWorkspaceIdForRuntime.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.dbExecute.mock.invocationCallOrder[0]);
    const candidateQuery = mocks.dbExecute.mock.calls[0]?.[0];
    expect(sqlInterpolatedValues(candidateQuery)).toContain(appWorkspaceId);
    expect(sqlInterpolatedValues(candidateQuery)).not.toContain(relayWorkspaceId);
    expect(result).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Integration watch dispatch entered",
      expect.objectContaining({
        diag: "entry",
        workspaceId: appWorkspaceId,
        relayWorkspaceId,
        provider: "github",
        eventType: "issues.opened",
        deliveryId: "delivery-github-forward-cold-start",
      }),
    );
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Integration watch dispatch resolved candidates",
      expect.objectContaining({
        diag: "candidates",
        workspaceId: appWorkspaceId,
        relayWorkspaceId,
        provider: "github",
        eventType: "issues.opened",
        candidateCount: 1,
        candidateIds: ["agent-small-issue"],
      }),
    );
    expect(mocks.loggerWarn).not.toHaveBeenCalledWith(
      "Integration watch dispatch matched no agents",
      expect.anything(),
    );
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: appWorkspaceId,
      agentId: "agent-small-issue",
      deliveryId: "delivery-github-forward-cold-start",
      payload: expect.objectContaining({
        type: "github.issues.opened",
        eventType: "issues.opened",
        provider: "github",
        workspaceId: appWorkspaceId,
        relayWorkspaceId,
        connectionId: "conn-github",
        deliveryId: "delivery-github-forward-cold-start",
        paths: expect.arrayContaining([
          "/github/repos/AgentWorkforce/cloud/issues/1452__probe/meta.json",
        ]),
        resource: expect.objectContaining({
          action: "opened",
          issue: expect.objectContaining({ number: 1452 }),
          repository: expect.objectContaining({ full_name: "AgentWorkforce/cloud" }),
        }),
      }),
    }));
  });

  it("fails loudly when Relay workspace mapping lookup rejects", async () => {
    const mappingError = new Error("workspace binding lookup failed");
    mocks.resolveAppWorkspaceIdForRuntime.mockRejectedValueOnce(mappingError);
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    await expect(dispatchIntegrationWatchEvent({
      workspaceId: "rw_7ccfea89",
      provider: "github",
      eventType: "issues.opened",
      connectionId: "conn-github",
      deliveryId: "delivery-github",
      paths: ["/github/repos/acme/cloud/issues/42__bug/meta.json"],
      payload: { number: 42 },
    })).rejects.toThrow("workspace binding lookup failed");

    expect(mocks.loggerError).toHaveBeenCalledWith(
      "Integration watch dispatch workspace mapping failed",
      expect.objectContaining({
        diag: "workspace_mapping_failed",
        workspaceId: "rw_7ccfea89",
        provider: "github",
        eventType: "issues.opened",
        connectionId: "conn-github",
        deliveryId: "delivery-github",
        error: "workspace binding lookup failed",
      }),
    );
    expect(mocks.dbExecute).not.toHaveBeenCalled();
    expect(mocks.enqueueIntegrationWatchDelivery).not.toHaveBeenCalled();
  });

  it("fails loudly when a Relay workspace has no app workspace binding", async () => {
    mocks.resolveAppWorkspaceIdForRuntime.mockResolvedValueOnce(null);
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    await expect(dispatchIntegrationWatchEvent({
      workspaceId: "rw_7ccfea89",
      provider: "github",
      eventType: "pull_request.opened",
      connectionId: "conn-github",
      deliveryId: "delivery-pr",
      paths: ["/github/repos/acme/cloud/pulls/42__bug/meta.json"],
      payload: { number: 42 },
    })).rejects.toThrow(
      "Integration watch dispatch could not resolve Relay workspace rw_7ccfea89 to an app workspace",
    );

    expect(mocks.loggerError).toHaveBeenCalledWith(
      "Integration watch dispatch workspace mapping unresolved",
      expect.objectContaining({
        diag: "workspace_mapping_unresolved",
        workspaceId: "rw_7ccfea89",
        provider: "github",
        eventType: "pull_request.opened",
        connectionId: "conn-github",
        deliveryId: "delivery-pr",
      }),
    );
    expect(mocks.dbExecute).toHaveBeenCalledTimes(1);
    const failureQuery = mocks.dbExecute.mock.calls[0]?.[0];
    expect(sqlText(failureQuery)).toContain("INSERT INTO integration_watch_dispatch_failures");
    expect(sqlText(failureQuery)).toContain(
      "ON CONFLICT (relay_workspace_id, provider, event_type, delivery_id) DO UPDATE",
    );
    const failureValues = sqlInterpolatedValues(failureQuery);
    expect(failureValues).toEqual(expect.arrayContaining([
      "rw_7ccfea89",
      "github",
      "pull_request.opened",
      "conn-github",
      "delivery-pr",
      "workspace_mapping_unresolved",
      "Integration watch dispatch could not resolve Relay workspace rw_7ccfea89 to an app workspace",
    ]));
    expect(failureValues).toContain(JSON.stringify({
      paths: ["/github/repos/acme/cloud/pulls/42__bug/meta.json"],
      payload: { number: 42 },
    }));
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "Integration watch dispatch failure recorded",
      expect.objectContaining({
        metric: "integration_watch_dispatch_failures_total",
        reason: "workspace_mapping_unresolved",
        status: "failed",
        workspaceId: "rw_7ccfea89",
        provider: "github",
        eventType: "pull_request.opened",
        connectionId: "conn-github",
        deliveryId: "delivery-pr",
      }),
    );
    expect(mocks.enqueueIntegrationWatchDelivery).not.toHaveBeenCalled();
  });

  it("replays unresolved workspace dispatch failures after mapping recovers", async () => {
    const appWorkspaceId = "50587328-441d-4acb-b8f3-dbe1b3c5de99";
    const relayWorkspaceId = "rw_7ccfea89";
    mocks.resolveAppWorkspaceIdForRuntime.mockResolvedValueOnce(appWorkspaceId);
    mocks.dbExecute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "3094f185-163d-4c27-8e9e-7b98c1111fe1",
            relay_workspace_id: relayWorkspaceId,
            provider: "github",
            event_type: "deployment_status.created",
            connection_id: "conn-github",
            delivery_id: "delivery-replay-1",
            payload: {
              paths: ["/github/repos/AgentWorkforce/cloud/deployments/1/statuses/2.json"],
              payload: {
                state: "success",
                deployment: { id: 1 },
                repository: { full_name: "AgentWorkforce/cloud" },
              },
            },
            occurred_at: new Date("2026-06-19T14:22:23.732Z"),
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-deploy-watch",
            deployed_name: "deploy-watch",
            watch_globs: ["/github/repos/**/**/deployments/**"],
            watch_rules: null,
            delivery_max_concurrency_by_trigger: null,
            spec: {
              integrations: {
                github: { triggers: [{ on: "deployment_status.created" }] },
              },
            },
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const { drainIntegrationWatchDispatchFailures } = await import("./integration-watch-dispatcher");

    const result = await drainIntegrationWatchDispatchFailures({
      relayWorkspaceId,
      limit: 5,
      maxFailureAgeSeconds: 3600,
    });

    expect(result).toEqual({ attempted: 1, replayed: 1, failed: 0 });
    const replaySelect = mocks.dbExecute.mock.calls[0]?.[0];
    expect(sqlText(replaySelect)).toContain("FROM integration_watch_dispatch_failures");
    expect(sqlText(replaySelect)).toContain("created_at >= NOW()");
    expect(sqlInterpolatedValues(replaySelect)).toContain(relayWorkspaceId);
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: appWorkspaceId,
      agentId: "agent-deploy-watch",
      deliveryId: "delivery-replay-1",
      payload: expect.objectContaining({
        workspaceId: appWorkspaceId,
        relayWorkspaceId,
        provider: "github",
        eventType: "deployment_status.created",
        occurredAt: "2026-06-19T14:22:23.732Z",
      }),
    }));
    const markReplayed = mocks.dbExecute.mock.calls[2]?.[0];
    expect(sqlText(markReplayed)).toContain("SET status = 'replayed'");
  });

  it("keeps dispatch failures failed when replay dispatch errors", async () => {
    const replayError = new Error("binding lookup unavailable");
    mocks.resolveAppWorkspaceIdForRuntime.mockRejectedValueOnce(replayError);
    mocks.dbExecute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "3094f185-163d-4c27-8e9e-7b98c1111fe1",
            relay_workspace_id: "rw_7ccfea89",
            provider: "github",
            event_type: "deployment_status.created",
            connection_id: "conn-github",
            delivery_id: "delivery-replay-1",
            payload: { paths: [], payload: {} },
            occurred_at: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const { drainIntegrationWatchDispatchFailures } = await import("./integration-watch-dispatcher");

    const result = await drainIntegrationWatchDispatchFailures({
      relayWorkspaceId: "rw_7ccfea89",
      limit: 1,
    });

    expect(result).toEqual({ attempted: 1, replayed: 0, failed: 1 });
    const markFailed = mocks.dbExecute.mock.calls[1]?.[0];
    expect(sqlText(markFailed)).toContain("SET error =");
    expect(sqlText(markFailed)).not.toContain("SET status = 'replayed'");
    expect(sqlInterpolatedValues(markFailed)).toContain("binding lookup unavailable");
    expect(mocks.enqueueIntegrationWatchDelivery).not.toHaveBeenCalled();
  });

  it("normalises postgres text[] literal strings on watch_globs (fetch_types:false workaround)", async () => {
    // On worker the postgres-js client uses `fetch_types: false` and returns
    // `text[]` columns as raw literal strings rather than JS arrays. Without
    // normalisation in `readIntegrationWatchCandidateAgents`, the matcher's
    // `Array.isArray(row.watch_globs)` check fails and every agent is reported
    // as having no watch config — diag:no-match for events that should match.
    // This test exercises the postgres-literal-string path through the full
    // dispatcher.
    mocks.dbExecute.mockResolvedValue({
      rows: [
        {
          id: "agent-fetch-types-off",
          watch_globs: '{"/github/repos/**/**/issues/**"}',
          watch_rules: null,
          spec: {
            integrations: {
              github: { triggers: [{ on: "issues.opened" }] },
            },
          },
        },
      ],
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "issues.opened",
      connectionId: "conn-1",
      deliveryId: "delivery-1",
      paths: ["/github/repos/acme/cloud/issues/42__bug/meta.json"],
      payload: { number: 42 },
    });

    expect(result).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      agentId: "agent-fetch-types-off",
      deliveryId: "delivery-1",
      payload: expect.objectContaining({ eventType: "issues.opened" }),
    }));
  });

  it("does not enqueue when the path matches but the persona trigger action does not", async () => {
    mocks.dbExecute.mockResolvedValue({
      rows: [
        {
          id: "agent-1",
          watch_globs: ["/github/repos/**/**/issues/**"],
          spec: {
            integrations: {
              github: { triggers: [{ on: "issues.closed" }] },
            },
          },
        },
      ],
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "issues.opened",
      paths: ["/github/repos/acme/cloud/issues/42__bug/meta.json"],
    });

    expect(result).toEqual({ matched: 0, delivered: 0, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).not.toHaveBeenCalled();
  });

  it("continues enqueueing to other matching agents when one enqueue fails", async () => {
    mocks.dbExecute.mockResolvedValue({
      rows: [
        {
          id: "agent-1",
          watch_globs: ["/linear/issues/**"],
          spec: {
            integrations: {
              linear: { triggers: [{ on: "issue.updated" }] },
            },
          },
        },
        {
          id: "agent-2",
          watch_globs: ["/linear/issues/**"],
          spec: {
            integrations: {
              linear: { triggers: [{ on: "issue.updated" }] },
            },
          },
        },
      ],
    });
    mocks.enqueueIntegrationWatchDelivery
      .mockRejectedValueOnce(new Error("sandbox unavailable"))
      .mockResolvedValueOnce("queued");
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "linear",
      eventType: "issue.updated",
      paths: ["/linear/issues/LIN-1.json"],
    });

    expect(result).toEqual({ matched: 2, delivered: 1, failed: 1 });
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledTimes(2);
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "Integration watch dispatch had delivery failures",
      expect.objectContaining({ failed: 1, matched: 2 }),
    );
  });

  it("logs per-agent rejection reasons when enqueue fails", async () => {
    // Regression: without this, the delivery-failure error log only said
    // `matched: 1, failed: 1` with no `reason`, so a real 401 auth issue on
    // workspace 50587328 (post-WS-OPTION-B Worker→cloud-web outbound) had no
    // signal in CloudWatch. The failures array must expose each rejection
    // reason keyed by agentId.
    mocks.dbExecute.mockResolvedValue({
      rows: [
        {
          id: "agent-1",
          watch_globs: ["/github/repos/**/**/issues/**"],
          spec: {
            integrations: {
              github: { triggers: [{ on: "issues.opened" }] },
            },
          },
        },
      ],
    });
    mocks.enqueueIntegrationWatchDelivery.mockRejectedValueOnce(
      new Error("simulated deploy failure"),
    );
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "issues.opened",
      connectionId: "conn-1",
      deliveryId: "delivery-1",
      paths: ["/github/repos/acme/cloud/issues/42__bug/meta.json"],
      payload: { number: 42 },
    });

    expect(result).toEqual({ matched: 1, delivered: 0, failed: 1 });
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "Integration watch dispatch had delivery failures",
      expect.objectContaining({
        failed: 1,
        matched: 1,
        failures: [
          expect.objectContaining({
            agentId: "agent-1",
            error: "simulated deploy failure",
            errorName: "Error",
            errorStack: expect.any(String),
          }),
        ],
      }),
    );
  });

  it("keeps the Postgres claim authoritative when the DO broker reports a stale skip", async () => {
    mocks.dedupeBrokerEnabled = true;
    mocks.dbExecute.mockResolvedValue({
      rows: [
        {
          id: "agent-1",
          watch_globs: ["/github/repos/**/**/issues/**"],
          spec: {
            integrations: {
              github: { triggers: [{ on: "issues.opened" }] },
            },
          },
        },
        {
          id: "agent-2",
          watch_globs: ["/github/repos/**/**/issues/**"],
          spec: {
            integrations: {
              github: { triggers: [{ on: "issues.opened" }] },
            },
          },
        },
      ],
    });
    mocks.dedupeFetch.mockImplementation(async (request: Request) => {
      const body = await request.json() as { agentId: string };
      return Response.json({
        ok: true,
        data: {
          dedupe: body.agentId === "agent-1" ? "skipped" : "first",
        },
      });
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "issues.opened",
      deliveryId: "write-1",
      paths: ["/github/repos/acme/cloud/issues/42__bug/meta.json"],
    });

    expect(result).toEqual({ matched: 2, delivered: 2, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledTimes(2);
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-1" }),
    );
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-2" }),
    );
    expect(mocks.dedupeFetch).toHaveBeenCalledTimes(2);
    expect(mocks.claimWebhookDelivery).toHaveBeenCalledTimes(2);
    expect(mocks.releaseWebhookDelivery).not.toHaveBeenCalled();
  });

  it("falls back to local dedupe when the broker is unavailable", async () => {
    mocks.dedupeBrokerEnabled = false;
    mocks.dbExecute.mockResolvedValue({
      rows: [
        {
          id: "agent-1",
          watch_globs: ["/github/repos/**/**/issues/**"],
          spec: {
            integrations: {
              github: { triggers: [{ on: "issues.opened" }] },
            },
          },
        },
      ],
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "issues.opened",
      deliveryId: "write-1",
      paths: ["/github/repos/acme/cloud/issues/42__bug/meta.json"],
    });

    expect(result).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(mocks.dedupeFetch).not.toHaveBeenCalled();
    expect(mocks.claimWebhookDelivery).toHaveBeenCalledWith({
      surface: "webhook-dispatch",
      deliveryId: "workspace-1:integration-watch:agent-1:write-1",
    });
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledTimes(1);
  });

  it("fail-closes when broker and local dedupe claim are unavailable", async () => {
    mocks.dedupeBrokerEnabled = false;
    mocks.claimWebhookDelivery.mockRejectedValueOnce(new Error("dedupe db down"));
    mocks.dbExecute.mockResolvedValue({
      rows: [
        {
          id: "agent-1",
          watch_globs: ["/github/repos/**/**/issues/**"],
          spec: {
            integrations: {
              github: { triggers: [{ on: "issues.opened" }] },
            },
          },
        },
      ],
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "issues.opened",
      deliveryId: "write-1",
      paths: ["/github/repos/acme/cloud/issues/42__bug/meta.json"],
    });

    expect(result).toEqual({ matched: 1, delivered: 0, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).not.toHaveBeenCalled();
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "Integration watch local dedupe claim failed closed",
      expect.objectContaining({
        area: "integration-watch-dispatch",
        agentId: "agent-1",
        writeId: "write-1",
        error: "dedupe db down",
      }),
    );
  });

  it("derives a stable dedupe id when inline callers omit deliveryId", async () => {
    mocks.dedupeBrokerEnabled = true;
    mocks.dbExecute.mockResolvedValue({
      rows: [
        {
          id: "agent-1",
          watch_globs: ["/github/issues/opened/**"],
          spec: {
            integrations: {
              github: { triggers: [{ on: "issues.opened" }] },
            },
          },
        },
      ],
    });
    const brokerWriteIds: string[] = [];
    mocks.dedupeFetch.mockImplementation(async (request: Request) => {
      const body = await request.json() as { writeId: string };
      brokerWriteIds.push(body.writeId);
      return Response.json({ ok: true, data: { dedupe: "first" } });
    });
    const { dispatchIntegrationWatchEvent, deriveIntegrationWatchDeliveryId } = await import("./integration-watch-dispatcher");
    const input = {
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "issues.opened",
      connectionId: "conn-1",
      paths: ["/github/issues/opened/42.json"],
      payload: { issue: { id: 42, title: "bug" } },
    } as const;
    const expectedDeliveryId = deriveIntegrationWatchDeliveryId(input);

    const result = await dispatchIntegrationWatchEvent(input);

    expect(result).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(brokerWriteIds).toEqual([expectedDeliveryId]);
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      deliveryId: expectedDeliveryId,
      payload: expect.objectContaining({
        deliveryId: expectedDeliveryId,
        id: expectedDeliveryId,
      }),
    }));
  });

  it("derives distinct dedupe ids for multiple Linear AgentSessionEvent.prompted activities on the same issue", async () => {
    mocks.dedupeBrokerEnabled = true;
    mocks.dbExecute.mockResolvedValue({
      rows: [
        {
          id: "agent-linear",
          watch_globs: ["/linear/agent-sessions/**"],
          spec: {
            integrations: {
              linear: { triggers: [{ on: "AgentSessionEvent.prompted" }] },
            },
          },
        },
      ],
    });
    const brokerWriteIds: string[] = [];
    mocks.dedupeFetch.mockImplementation(async (request: Request) => {
      const body = await request.json() as { writeId: string };
      brokerWriteIds.push(body.writeId);
      return Response.json({ ok: true, data: { dedupe: "first" } });
    });
    const { dispatchIntegrationWatchEvent, deriveIntegrationWatchDeliveryId } = await import("./integration-watch-dispatcher");
    const baseInput = {
      workspaceId: "workspace-1",
      provider: "linear",
      eventType: "AgentSessionEvent.prompted",
      connectionId: "conn-linear",
      paths: ["/linear/agent-sessions/session-1.json"],
    } as const;
    const firstPayload = {
      type: "AgentSessionEvent",
      action: "prompted",
      agentSession: {
        id: "session-1",
        issue: { id: "issue-1", identifier: "AR-70" },
      },
      agentActivity: { id: "activity-1", body: "first prompt" },
    };
    const secondPayload = {
      type: "AgentSessionEvent",
      action: "prompted",
      agentSession: {
        id: "session-1",
        issue: { id: "issue-1", identifier: "AR-70" },
      },
      agentActivity: { id: "activity-2", body: "second prompt" },
    };
    const firstDeliveryId = deriveIntegrationWatchDeliveryId({
      ...baseInput,
      payload: firstPayload,
    });
    const secondDeliveryId = deriveIntegrationWatchDeliveryId({
      ...baseInput,
      payload: secondPayload,
    });

    await expect(dispatchIntegrationWatchEvent({
      ...baseInput,
      payload: firstPayload,
    })).resolves.toEqual({ matched: 1, delivered: 1, failed: 0 });
    await expect(dispatchIntegrationWatchEvent({
      ...baseInput,
      payload: secondPayload,
    })).resolves.toEqual({ matched: 1, delivered: 1, failed: 0 });

    expect(firstDeliveryId).not.toBe(secondDeliveryId);
    expect(firstDeliveryId).toContain("activity-1");
    expect(secondDeliveryId).toContain("activity-2");
    expect(brokerWriteIds).toEqual([firstDeliveryId, secondDeliveryId]);
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledTimes(2);
  });

  it("does not let a DO broker skip override the derived-id Postgres claim", async () => {
    mocks.dedupeBrokerEnabled = true;
    mocks.dbExecute.mockResolvedValue({
      rows: [
        {
          id: "agent-1",
          watch_globs: ["/github/issues/opened/**"],
          spec: {
            integrations: {
              github: { triggers: [{ on: "issues.opened" }] },
            },
          },
        },
      ],
    });
    const brokerWriteIds: string[] = [];
    mocks.dedupeFetch.mockImplementation(async (request: Request) => {
      const body = await request.json() as { writeId: string };
      brokerWriteIds.push(body.writeId);
      return Response.json({ ok: true, data: { dedupe: "skipped" } });
    });
    const { dispatchIntegrationWatchEvent, deriveIntegrationWatchDeliveryId } = await import("./integration-watch-dispatcher");
    const input = {
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "issues.opened",
      connectionId: "conn-1",
      paths: ["/github/issues/opened/42.json"],
      payload: { issue: { id: 42, title: "bug" } },
    } as const;
    const expectedDeliveryId = deriveIntegrationWatchDeliveryId(input);

    const result = await dispatchIntegrationWatchEvent(input);

    expect(result).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(brokerWriteIds).toEqual([expectedDeliveryId]);
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      deliveryId: expectedDeliveryId,
      payload: expect.objectContaining({
        deliveryId: expectedDeliveryId,
        id: expectedDeliveryId,
      }),
    }));
    expect(mocks.releaseWebhookDelivery).not.toHaveBeenCalled();
  });

  it("suppresses duplicate issue dispatches with ON CONFLICT workspace/issue/agent when the DO broker errors", async () => {
    mocks.dedupeBrokerEnabled = true;
    mocks.dedupeFetch.mockRejectedValue(new Error("workspace do overloaded"));
    mocks.claimWebhookDelivery.mockResolvedValue(true);
    const candidateRows = {
      rows: [
        {
          id: "agent-1",
          watch_globs: ["/github/repos/**/**/issues/**"],
          spec: {
            integrations: {
              github: { triggers: [{ on: "issues.opened" }] },
            },
          },
        },
      ],
    };
    const dbResults = [
      candidateRows,
      { rows: [{ id: "claim-1" }] },
      candidateRows,
      { rows: [] },
    ];
    const claimSql: string[] = [];
    mocks.dbExecute.mockImplementation(async (query: unknown) => {
      const text = sqlText(query);
      if (text.includes("integration_watch_issue_dispatch_dedup")) {
        claimSql.push(text);
      }
      return dbResults.shift() ?? { rows: [] };
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");
    const firstInput = {
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "issues.opened",
      deliveryId: "delivery-1",
      paths: ["/github/repos/acme/cloud/issues/42__bug/meta.json"],
      payload: { issue: { id: 42, title: "bug" } },
    } as const;
    const secondInput = {
      ...firstInput,
      deliveryId: "delivery-2",
    };

    const first = await dispatchIntegrationWatchEvent(firstInput);
    const second = await dispatchIntegrationWatchEvent(secondInput);

    expect(first).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(second).toEqual({ matched: 1, delivered: 0, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledTimes(1);
    expect(mocks.claimWebhookDelivery).toHaveBeenCalledTimes(1);
    expect(mocks.dedupeFetch).toHaveBeenCalledTimes(1);
    expect(claimSql.join("\n")).toContain(
      "ON CONFLICT (workspace_id, issue_key, agent_id) DO NOTHING",
    );
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Integration watch dispatch deduped",
      expect.objectContaining({
        area: "integration-watch-dispatch",
        deliveryId: "delivery-2",
        dedupe: "skipped",
        deduped: 1,
      }),
    );
  });

  it("coalesces PR-context issue dispatches only for the configured cooldown window", async () => {
    await usePgliteDispatcherDb();
    mocks.cooldownEnv = "60";
    await insertPgliteAgent({
      id: "agent-1",
      watchGlobs: ["/github/repos/**/**/issues/**"],
      spec: {
        integrations: {
          github: { triggers: [{ on: "issue_comment.created" }] },
        },
      },
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");
    const input = {
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "issue_comment.created",
      paths: ["/github/repos/acme/cloud/issues/42__bug/meta.json"],
      payload: {
        issue: { number: 42, pull_request: { url: "https://api.github.com/repos/acme/cloud/pulls/42" } },
        repository: { full_name: "acme/cloud" },
      },
    } as const;

    const first = await dispatchIntegrationWatchEvent({ ...input, deliveryId: "delivery-1" });
    const second = await dispatchIntegrationWatchEvent({ ...input, deliveryId: "delivery-2" });
    await pg!.exec(`
      UPDATE integration_watch_issue_dispatch_dedup
      SET updated_at = now() - interval '61 seconds'
      WHERE workspace_id = 'workspace-1'
        AND issue_key = 'github-pr:acme/cloud#42'
        AND agent_id = 'agent-1'
    `);
    const third = await dispatchIntegrationWatchEvent({ ...input, deliveryId: "delivery-3" });

    expect(first).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(second).toEqual({ matched: 1, delivered: 0, failed: 0 });
    expect(third).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledTimes(2);
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenNthCalledWith(1, expect.objectContaining({
      deliveryId: "delivery-1",
    }));
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenNthCalledWith(2, expect.objectContaining({
      deliveryId: "delivery-3",
    }));
  });

  it("records the LATEST within-window PR-context event as a pending coalesced re-dispatch (#1516 Bug 1 trailing edge)", async () => {
    await usePgliteDispatcherDb();
    mocks.cooldownEnv = "60";
    await insertPgliteAgent({
      id: "agent-1",
      watchGlobs: ["/github/repos/**/**/issues/**"],
      spec: {
        integrations: {
          github: { triggers: [{ on: "issue_comment.created" }] },
        },
      },
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");
    const input = {
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "issue_comment.created",
      paths: ["/github/repos/acme/cloud/issues/42__bug/meta.json"],
      payload: {
        issue: { number: 42, pull_request: { url: "https://api.github.com/repos/acme/cloud/pulls/42" } },
        repository: { full_name: "acme/cloud" },
      },
    } as const;

    await dispatchIntegrationWatchEvent({ ...input, deliveryId: "delivery-1" }); // claims, opens the window
    await dispatchIntegrationWatchEvent({ ...input, deliveryId: "delivery-2" }); // within-window → suppressed, pending recorded
    await dispatchIntegrationWatchEvent({ ...input, deliveryId: "delivery-3" }); // within-window → pending UPDATED (latest wins)

    const row = await pg!.query<{ pending_delivery_id: string | null; pending_payload: unknown }>(`
      SELECT pending_delivery_id, pending_payload
      FROM integration_watch_issue_dispatch_dedup
      WHERE workspace_id = 'workspace-1'
        AND issue_key = 'github-pr:acme/cloud#42'
        AND agent_id = 'agent-1'
    `);
    // Only the LATEST suppressed event survives as the pending re-dispatch, so
    // the trailing-edge sweep fires exactly once with the freshest payload —
    // coalescing all within-window reviewers (gemini→coderabbit→cubic) into one
    // run rather than dropping the slowest.
    expect(row.rows[0]!.pending_delivery_id).toBe("delivery-3");
    expect(row.rows[0]!.pending_payload).not.toBeNull();
  });

  it("dispatches a failing check_run and coalesces re-runs of the same PR within the cooldown window", async () => {
    await usePgliteDispatcherDb();
    mocks.cooldownEnv = "60";
    await insertPgliteAgent({
      id: "ci-fix-agent",
      watchGlobs: ["/github/repos/**/**/checks/**"],
      watchRules: [
        {
          paths: ["/github/repos/AgentWorkforce/cloud/checks/**"],
          events: ["check_run.completed"],
          conditions: [{ field: "conclusion", in: ["failure", "timed_out", "action_required"] }],
        },
      ],
      spec: {
        integrations: {
          github: { triggers: [{ on: "check_run.completed" }] },
        },
      },
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");
    // The dispatcher receives the check_run object itself (buildGitHubWebhookFileData
    // flattens it), so `conclusion` and `pull_requests[]` are top-level.
    const failingInput = {
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "check_run.completed",
      paths: ["/github/repos/AgentWorkforce/cloud/checks/991.json"],
      payload: {
        id: 991,
        conclusion: "failure",
        pull_requests: [
          { number: 77, url: "https://api.github.com/repos/AgentWorkforce/cloud/pulls/77" },
        ],
        repository: { full_name: "AgentWorkforce/cloud" },
      },
    } as const;

    const first = await dispatchIntegrationWatchEvent({ ...failingInput, deliveryId: "check-1" });
    const second = await dispatchIntegrationWatchEvent({ ...failingInput, deliveryId: "check-2" });
    // A passing re-run of the SAME checks must be filtered out entirely — this is
    // the loop breaker once the bot's fix turns CI green.
    const passing = await dispatchIntegrationWatchEvent({
      ...failingInput,
      deliveryId: "check-green",
      payload: { ...failingInput.payload, conclusion: "success" },
    });
    await pg!.exec(`
      UPDATE integration_watch_issue_dispatch_dedup
      SET updated_at = now() - interval '61 seconds'
      WHERE workspace_id = 'workspace-1'
        AND issue_key = 'github-pr:AgentWorkforce/cloud#77'
        AND agent_id = 'ci-fix-agent'
    `);
    const third = await dispatchIntegrationWatchEvent({ ...failingInput, deliveryId: "check-3" });

    expect(first).toEqual({ matched: 1, delivered: 1, failed: 0 });
    // Cooldown coalesces the second failing check_run for the same PR.
    expect(second).toEqual({ matched: 1, delivered: 0, failed: 0 });
    // Passing check_run is filtered by the watch-rule conclusion condition.
    expect(passing).toEqual({ matched: 0, delivered: 0, failed: 0 });
    // After the cooldown elapses, a still-failing PR re-dispatches.
    expect(third).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledTimes(2);
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenNthCalledWith(1, expect.objectContaining({
      deliveryId: "check-1",
      agentId: "ci-fix-agent",
    }));
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenNthCalledWith(2, expect.objectContaining({
      deliveryId: "check-3",
    }));
    // The cooldown was claimed on a PR-scoped key, not the check_run id, so every
    // failing check for PR #77 collapses onto one window.
    const dedupRows = await pg!.query(
      "SELECT issue_key FROM integration_watch_issue_dispatch_dedup WHERE agent_id = 'ci-fix-agent'",
    );
    expect((dedupRows.rows as Array<{ issue_key: string }>).map((row) => row.issue_key)).toEqual([
      "github-pr:AgentWorkforce/cloud#77",
    ]);
  });

  it("coalesces stripped review-comment dispatches using pull-request URL and pulls path context", async () => {
    await usePgliteDispatcherDb();
    mocks.cooldownEnv = "60";
    await insertPgliteAgent({
      id: "agent-1",
      watchGlobs: ["/github/repos/**/**/pulls/**"],
      spec: {
        integrations: {
          github: { triggers: [{ on: "pull_request_review_comment.created" }] },
        },
      },
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");
    const input = {
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "pull_request_review_comment.created",
      paths: ["/github/repos/AgentWorkforce/cloud/pulls/1495__comment-trigger/meta.json"],
      payload: {
        resource: {
          pull_request_url: "https://api.github.com/repos/AgentWorkforce/cloud/pulls/1495",
          repository: { full_name: "AgentWorkforce/cloud" },
          commit_id: "abc123",
          comment: {
            user: { login: "human-reviewer", type: "User" },
          },
        },
      },
    } as const;

    const first = await dispatchIntegrationWatchEvent({ ...input, deliveryId: "review-comment-1" });
    const second = await dispatchIntegrationWatchEvent({ ...input, deliveryId: "review-comment-2" });
    await pg!.exec(`
      UPDATE integration_watch_issue_dispatch_dedup
      SET updated_at = now() - interval '61 seconds'
      WHERE workspace_id = 'workspace-1'
        AND issue_key = 'github-pr:AgentWorkforce/cloud#1495'
        AND agent_id = 'agent-1'
    `);
    const third = await dispatchIntegrationWatchEvent({ ...input, deliveryId: "review-comment-3" });

    expect(first).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(second).toEqual({ matched: 1, delivered: 0, failed: 0 });
    expect(third).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledTimes(2);
    const rows = await pg!.query<{ issue_key: string }>(
      "SELECT issue_key FROM integration_watch_issue_dispatch_dedup ORDER BY issue_key",
    );
    expect(rows.rows.map((row) => row.issue_key)).toEqual([
      "github-pr:AgentWorkforce/cloud#1495",
    ]);
  });

  it("does not treat real issue paths as PR context when preserving permanent issue dedupe", async () => {
    await usePgliteDispatcherDb();
    mocks.cooldownEnv = "1";
    await insertPgliteAgent({
      id: "agent-1",
      watchGlobs: ["/github/repos/**/**/issues/**"],
      spec: {
        integrations: {
          github: { triggers: [{ on: "issues.opened" }] },
        },
      },
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");
    const input = {
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "issues.opened",
      paths: ["/github/repos/acme/cloud/issues/77__real-issue/meta.json"],
      payload: {
        issue: { number: 77, title: "real issue" },
        repository: { full_name: "acme/cloud" },
      },
    } as const;

    const first = await dispatchIntegrationWatchEvent({ ...input, deliveryId: "issue-path-1" });
    await pg!.exec(`
      UPDATE integration_watch_issue_dispatch_dedup
      SET updated_at = now() - interval '1 hour'
      WHERE workspace_id = 'workspace-1'
        AND issue_key = 'github:acme/cloud#77'
        AND agent_id = 'agent-1'
    `);
    const second = await dispatchIntegrationWatchEvent({ ...input, deliveryId: "issue-path-2" });

    expect(first).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(second).toEqual({ matched: 1, delivered: 0, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledTimes(1);
    const rows = await pg!.query<{ issue_key: string }>(
      "SELECT issue_key FROM integration_watch_issue_dispatch_dedup",
    );
    expect(rows.rows.map((row) => row.issue_key)).toEqual(["github:acme/cloud#77"]);
  });

  it("keeps one-shot Linear issue.created dispatches permanently deduped", async () => {
    await usePgliteDispatcherDb();
    mocks.cooldownEnv = "1";
    await insertPgliteAgent({
      id: "agent-linear",
      watchGlobs: ["/linear/issues/**"],
      spec: {
        integrations: {
          linear: { triggers: [{ on: "issue.created" }] },
        },
      },
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");
    const input = {
      workspaceId: "workspace-1",
      provider: "linear",
      eventType: "issue.created",
      paths: ["/linear/issues/LIN-77.json"],
      payload: {
        type: "Issue",
        action: "create",
        issue: { id: "lin-77", identifier: "LIN-77" },
      },
    } as const;

    const first = await dispatchIntegrationWatchEvent({ ...input, deliveryId: "linear-create-1" });
    await pg!.exec(`
      UPDATE integration_watch_issue_dispatch_dedup
      SET updated_at = now() - interval '1 hour'
      WHERE workspace_id = 'workspace-1'
        AND issue_key = 'linear:LIN-77'
        AND agent_id = 'agent-linear'
    `);
    const second = await dispatchIntegrationWatchEvent({ ...input, deliveryId: "linear-create-2" });

    expect(first).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(second).toEqual({ matched: 1, delivered: 0, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledTimes(1);
  });

  it("reclaims existing permanent-era rows for recurring Linear issue updates after the cooldown", async () => {
    await usePgliteDispatcherDb();
    mocks.cooldownEnv = "60";
    await insertPgliteAgent({
      id: "agent-linear",
      watchGlobs: ["/linear/issues/**"],
      spec: {
        integrations: {
          linear: { triggers: [{ on: "issue.updated" }] },
        },
      },
    });
    await pg!.exec(`
      INSERT INTO integration_watch_issue_dispatch_dedup (
        workspace_id,
        issue_key,
        agent_id,
        delivery_id,
        updated_at
      )
      VALUES (
        'workspace-1',
        'linear:LIN-77',
        'agent-linear',
        'old-permanent-claim',
        now() - interval '12 hours'
      )
    `);
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "linear",
      eventType: "issue.updated",
      deliveryId: "linear-update-recovered",
      paths: ["/linear/issues/LIN-77.json"],
      payload: {
        type: "Issue",
        action: "update",
        issue: { id: "lin-77", identifier: "LIN-77" },
      },
    });

    expect(result).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent-linear",
      deliveryId: "linear-update-recovered",
    }));
    const rows = await pg!.query<{
      delivery_id: string;
      pending_delivery_id: string | null;
    }>(`
      SELECT delivery_id, pending_delivery_id
      FROM integration_watch_issue_dispatch_dedup
      WHERE workspace_id = 'workspace-1'
        AND issue_key = 'linear:LIN-77'
        AND agent_id = 'agent-linear'
    `);
    expect(rows.rows).toEqual([{
      delivery_id: "linear-update-recovered",
      pending_delivery_id: null,
    }]);
  });

  it("coalesces recurring Linear issue updates only within the cooldown window", async () => {
    await usePgliteDispatcherDb();
    mocks.cooldownEnv = "60";
    await insertPgliteAgent({
      id: "agent-linear",
      watchGlobs: ["/linear/issues/**"],
      spec: {
        integrations: {
          linear: { triggers: [{ on: "issue.updated" }] },
        },
      },
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");
    const input = {
      workspaceId: "workspace-1",
      provider: "linear",
      eventType: "issue.updated",
      paths: ["/linear/issues/LIN-88.json"],
      payload: {
        type: "Issue",
        action: "update",
        issue: { id: "lin-88", identifier: "LIN-88" },
      },
    } as const;

    const first = await dispatchIntegrationWatchEvent({ ...input, deliveryId: "linear-update-1" });
    const second = await dispatchIntegrationWatchEvent({
      ...input,
      deliveryId: "linear-update-2",
      payload: {
        ...input.payload,
        issue: { id: "lin-88", identifier: "LIN-88", title: "latest title" },
      },
    });
    const withinWindow = await pg!.query<{ pending_delivery_id: string | null; pending_payload: unknown }>(`
      SELECT pending_delivery_id, pending_payload
      FROM integration_watch_issue_dispatch_dedup
      WHERE workspace_id = 'workspace-1'
        AND issue_key = 'linear:LIN-88'
        AND agent_id = 'agent-linear'
    `);
    await pg!.exec(`
      UPDATE integration_watch_issue_dispatch_dedup
      SET updated_at = now() - interval '61 seconds'
      WHERE workspace_id = 'workspace-1'
        AND issue_key = 'linear:LIN-88'
        AND agent_id = 'agent-linear'
    `);
    const third = await dispatchIntegrationWatchEvent({ ...input, deliveryId: "linear-update-3" });

    expect(first).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(second).toEqual({ matched: 1, delivered: 0, failed: 0 });
    expect(withinWindow.rows[0]!.pending_delivery_id).toBe("linear-update-2");
    expect(JSON.stringify(withinWindow.rows[0]!.pending_payload)).toContain("latest title");
    expect(third).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledTimes(2);
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenNthCalledWith(1, expect.objectContaining({
      deliveryId: "linear-update-1",
    }));
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenNthCalledWith(2, expect.objectContaining({
      deliveryId: "linear-update-3",
    }));
    const rows = await pg!.query<{ pending_delivery_id: string | null; pending_payload: unknown }>(`
      SELECT pending_delivery_id, pending_payload
      FROM integration_watch_issue_dispatch_dedup
      WHERE workspace_id = 'workspace-1'
        AND issue_key = 'linear:LIN-88'
        AND agent_id = 'agent-linear'
    `);
    expect(rows.rows[0]!.pending_delivery_id).toBeNull();
    expect(rows.rows[0]!.pending_payload).toBeNull();
  });

  it("routes unknown issue-scoped event types through cooldown instead of permanent dedupe", async () => {
    await usePgliteDispatcherDb();
    mocks.cooldownEnv = "60";
    await insertPgliteAgent({
      id: "agent-linear",
      watchGlobs: ["/linear/issues/**"],
      spec: {
        integrations: {
          linear: { triggers: [{ on: "issue.lifecycle" }] },
        },
      },
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");
    const input = {
      workspaceId: "workspace-1",
      provider: "linear",
      eventType: "issue.lifecycle",
      paths: ["/linear/issues/LIN-99.json"],
      payload: {
        type: "Issue",
        action: "updated",
        issue: { id: "lin-99", identifier: "LIN-99" },
      },
    } as const;

    const first = await dispatchIntegrationWatchEvent({ ...input, deliveryId: "unknown-1" });
    await pg!.exec(`
      UPDATE integration_watch_issue_dispatch_dedup
      SET updated_at = now() - interval '61 seconds'
      WHERE workspace_id = 'workspace-1'
        AND issue_key = 'linear:LIN-99'
        AND agent_id = 'agent-linear'
    `);
    const second = await dispatchIntegrationWatchEvent({ ...input, deliveryId: "unknown-2" });

    expect(first).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(second).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledTimes(2);
  });

  it("does not let a pr-reviewer bot self-trigger reset the PR-context cooldown row", async () => {
    await usePgliteDispatcherDb();
    mocks.cooldownEnv = "60";
    await insertPgliteAgent({
      id: "agent-pr-reviewer",
      deployedName: "pr-reviewer",
      watchGlobs: ["/github/repos/**/**/pulls/**"],
      spec: {
        intent: "review",
        integrations: {
          github: { triggers: [{ on: "pull_request.synchronize" }] },
        },
      },
    });
    await pg!.exec(`
      INSERT INTO integration_watch_issue_dispatch_dedup (
        workspace_id,
        issue_key,
        agent_id,
        delivery_id,
        updated_at
      )
      VALUES (
        'workspace-1',
        'github-pr:AgentWorkforce/cloud#60',
        'agent-pr-reviewer',
        'old-delivery',
        '2026-05-07T12:00:00Z'::timestamptz
      )
    `);
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "pull_request.synchronize",
      connectionId: "conn-1",
      deliveryId: "delivery-pr-sync",
      paths: ["/github/repos/AgentWorkforce/cloud/pulls/60__probe/meta.json"],
      payload: {
        number: 60,
        repository: { full_name: "AgentWorkforce/cloud" },
        sender: { login: "file-by-agent-relay[bot]", type: "Bot" },
        pull_request: {
          number: 60,
          head: {
            sha: "7a4cc44",
            user: { login: "file-by-agent-relay[bot]", type: "Bot" },
          },
        },
      },
    });

    const rows = await pg!.query<{ delivery_id: string; updated_at: string }>(`
      SELECT delivery_id, updated_at::text
      FROM integration_watch_issue_dispatch_dedup
      WHERE workspace_id = 'workspace-1'
        AND issue_key = 'github-pr:AgentWorkforce/cloud#60'
        AND agent_id = 'agent-pr-reviewer'
    `);
    expect(result).toEqual({ matched: 1, delivered: 0, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).not.toHaveBeenCalled();
    expect(mocks.claimWebhookDelivery).not.toHaveBeenCalled();
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].delivery_id).toBe("old-delivery");
    expect(new Date(rows.rows[0].updated_at).toISOString()).toBe("2026-05-07T12:00:00.000Z");
  });

  it("clears stale coalesced PR-reviewer pending work when the reviewer bot posts its own outcome", async () => {
    await usePgliteDispatcherDb();
    mocks.cooldownEnv = "60";
    await insertPgliteAgent({
      id: "agent-pr-reviewer",
      deployedName: "pr-reviewer",
      watchGlobs: ["/github/repos/**/**/pulls/**"],
      spec: {
        intent: "review",
        integrations: {
          github: { triggers: [{ on: "pull_request.synchronize" }] },
        },
      },
    });
    await pg!.exec(`
      INSERT INTO integration_watch_issue_dispatch_dedup (
        workspace_id,
        issue_key,
        agent_id,
        delivery_id,
        updated_at,
        pending_delivery_id,
        pending_payload
      )
      VALUES (
        'workspace-1',
        'github-pr:AgentWorkforce/cloud#1631',
        'agent-pr-reviewer',
        'initial-pr-review',
        '2026-05-07T12:00:00Z'::timestamptz,
        'slow-reviewer-delivery',
        '{"type":"github.pull_request_review.submitted","resource":{"pull_request":{"number":1631,"head":{"sha":"0dcf4ba"}}}}'::jsonb
      )
    `);
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "pull_request.synchronize",
      connectionId: "conn-1",
      deliveryId: "bot-fix-push",
      paths: ["/github/repos/AgentWorkforce/cloud/pulls/1631__probe/meta.json"],
      payload: {
        number: 1631,
        repository: { full_name: "AgentWorkforce/cloud" },
        sender: { login: "agent-relay-bot[bot]", type: "Bot" },
        pull_request: {
          number: 1631,
          head: {
            sha: "8ae8d0fb",
            user: { login: "agent-relay-bot[bot]", type: "Bot" },
          },
        },
      },
    });

    const rows = await pg!.query<{
      delivery_id: string;
      pending_delivery_id: string | null;
      pending_payload: unknown;
      updated_at: string;
    }>(`
      SELECT delivery_id, pending_delivery_id, pending_payload, updated_at::text
      FROM integration_watch_issue_dispatch_dedup
      WHERE workspace_id = 'workspace-1'
        AND issue_key = 'github-pr:AgentWorkforce/cloud#1631'
        AND agent_id = 'agent-pr-reviewer'
    `);
    expect(result).toEqual({ matched: 1, delivered: 0, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).not.toHaveBeenCalled();
    expect(mocks.claimWebhookDelivery).not.toHaveBeenCalled();
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].delivery_id).toBe("initial-pr-review");
    expect(rows.rows[0].pending_delivery_id).toBeNull();
    expect(rows.rows[0].pending_payload).toBeNull();
    expect(new Date(rows.rows[0].updated_at).toISOString()).toBe("2026-05-07T12:00:00.000Z");
  });

  it("does not let a stripped pr-reviewer bot review-comment reset the PR-context cooldown row", async () => {
    await usePgliteDispatcherDb();
    mocks.cooldownEnv = "60";
    await insertPgliteAgent({
      id: "agent-pr-reviewer",
      deployedName: "pr-reviewer",
      watchGlobs: ["/github/repos/**/**/pulls/**"],
      spec: {
        intent: "review",
        integrations: {
          github: { triggers: [{ on: "pull_request_review_comment.created" }] },
        },
      },
    });
    await pg!.exec(`
      INSERT INTO integration_watch_issue_dispatch_dedup (
        workspace_id,
        issue_key,
        agent_id,
        delivery_id,
        updated_at
      )
      VALUES (
        'workspace-1',
        'github-pr:AgentWorkforce/cloud#1495',
        'agent-pr-reviewer',
        'old-delivery',
        '2026-05-07T12:00:00Z'::timestamptz
      )
    `);
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "pull_request_review_comment.created",
      connectionId: "conn-1",
      deliveryId: "delivery-review-comment",
      paths: ["/github/repos/AgentWorkforce/cloud/pulls/1495__comment-trigger/meta.json"],
      payload: {
        resource: {
          pull_request_url: "https://api.github.com/repos/AgentWorkforce/cloud/pulls/1495",
          repository: { full_name: "AgentWorkforce/cloud" },
          comment: {
            user: { login: "agent-relay-bot[bot]", type: "Bot" },
          },
        },
      },
    });

    const rows = await pg!.query<{ delivery_id: string; updated_at: string }>(`
      SELECT delivery_id, updated_at::text
      FROM integration_watch_issue_dispatch_dedup
      WHERE workspace_id = 'workspace-1'
        AND issue_key = 'github-pr:AgentWorkforce/cloud#1495'
        AND agent_id = 'agent-pr-reviewer'
    `);
    expect(result).toEqual({ matched: 1, delivered: 0, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).not.toHaveBeenCalled();
    expect(mocks.claimWebhookDelivery).not.toHaveBeenCalled();
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].delivery_id).toBe("old-delivery");
    expect(new Date(rows.rows[0].updated_at).toISOString()).toBe("2026-05-07T12:00:00.000Z");
  });

  it("dedupes distinct PR-context issue keys independently", async () => {
    await usePgliteDispatcherDb();
    await insertPgliteAgent({
      id: "agent-1",
      watchGlobs: ["/github/repos/**/**/issues/**"],
      spec: {
        integrations: {
          github: { triggers: [{ on: "issue_comment.created" }] },
        },
      },
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");
    const base = {
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "issue_comment.created",
      payload: {
        issue: { pull_request: { url: "https://api.github.com/repos/acme/cloud/pulls/1" } },
        repository: { full_name: "acme/cloud" },
      },
    } as const;

    const first = await dispatchIntegrationWatchEvent({
      ...base,
      deliveryId: "delivery-pr-42",
      paths: ["/github/repos/acme/cloud/issues/42__bug/meta.json"],
      payload: { ...base.payload, issue: { ...base.payload.issue, number: 42 } },
    });
    const second = await dispatchIntegrationWatchEvent({
      ...base,
      deliveryId: "delivery-pr-43",
      paths: ["/github/repos/acme/cloud/issues/43__bug/meta.json"],
      payload: { ...base.payload, issue: { ...base.payload.issue, number: 43 } },
    });

    expect(first).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(second).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledTimes(2);
    const rows = await pg!.query<{ issue_key: string }>(
      "SELECT issue_key FROM integration_watch_issue_dispatch_dedup ORDER BY issue_key",
    );
    expect(rows.rows.map((row) => row.issue_key)).toEqual([
      "github-pr:acme/cloud#42",
      "github-pr:acme/cloud#43",
    ]);
  });

  it("keeps PR-context and real issue dedupe keys independent for the same GitHub number", async () => {
    await usePgliteDispatcherDb();
    await insertPgliteAgent({
      id: "agent-1",
      watchGlobs: [
        "/github/repos/**/**/issues/**",
        "/github/repos/**/**/pulls/**",
      ],
      spec: {
        integrations: {
          github: {
            triggers: [
              { on: "pull_request.synchronize" },
              { on: "issues.opened" },
            ],
          },
        },
      },
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const pr = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "pull_request.synchronize",
      deliveryId: "pr-delivery-42",
      paths: ["/github/repos/acme/cloud/pulls/42__bug/meta.json"],
      payload: {
        number: 42,
        repository: { full_name: "acme/cloud" },
        sender: { login: "octocat", type: "User" },
        pull_request: {
          number: 42,
          head: { user: { login: "octocat", type: "User" } },
        },
      },
    });
    const issue = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "issues.opened",
      deliveryId: "issue-delivery-42",
      paths: ["/github/repos/acme/cloud/issues/42__bug/meta.json"],
      payload: {
        issue: { number: 42, title: "same number" },
        repository: { full_name: "acme/cloud" },
      },
    });

    expect(pr).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(issue).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledTimes(2);
    const rows = await pg!.query<{ issue_key: string }>(
      "SELECT issue_key FROM integration_watch_issue_dispatch_dedup ORDER BY issue_key",
    );
    expect(rows.rows.map((row) => row.issue_key)).toEqual([
      "github-pr:acme/cloud#42",
      "github:acme/cloud#42",
    ]);
  });

  it("keeps real issue dispatch dedupe permanent even after the PR cooldown would elapse", async () => {
    await usePgliteDispatcherDb();
    mocks.cooldownEnv = "1";
    await insertPgliteAgent({
      id: "agent-1",
      watchGlobs: ["/github/repos/**/**/issues/**"],
      spec: {
        integrations: {
          github: { triggers: [{ on: "issues.opened" }] },
        },
      },
    });
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");
    const input = {
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "issues.opened",
      paths: ["/github/repos/acme/cloud/issues/42__bug/meta.json"],
      payload: {
        issue: { number: 42, title: "bug" },
        repository: { full_name: "acme/cloud" },
      },
    } as const;

    const first = await dispatchIntegrationWatchEvent({ ...input, deliveryId: "issue-delivery-1" });
    await pg!.exec(`
      UPDATE integration_watch_issue_dispatch_dedup
      SET updated_at = now() - interval '1 hour'
      WHERE workspace_id = 'workspace-1'
        AND issue_key = 'github:acme/cloud#42'
        AND agent_id = 'agent-1'
    `);
    const second = await dispatchIntegrationWatchEvent({ ...input, deliveryId: "issue-delivery-2" });

    expect(first).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(second).toEqual({ matched: 1, delivered: 0, failed: 0 });
    expect(mocks.enqueueIntegrationWatchDelivery).toHaveBeenCalledTimes(1);
  });

  it("releases only the failed agent claim so successful agents stay deduped", async () => {
    mocks.dedupeBrokerEnabled = true;
    mocks.dbExecute.mockResolvedValue({
      rows: [
        {
          id: "agent-1",
          watch_globs: ["/linear/issues/**"],
          spec: {
            integrations: {
              linear: { triggers: [{ on: "issue.updated" }] },
            },
          },
        },
        {
          id: "agent-2",
          watch_globs: ["/linear/issues/**"],
          spec: {
            integrations: {
              linear: { triggers: [{ on: "issue.updated" }] },
            },
          },
        },
      ],
    });
    const brokerCalls: Array<{ path: string; agentId: string }> = [];
    mocks.dedupeFetch.mockImplementation(async (request: Request) => {
      const body = await request.json() as { agentId: string };
      brokerCalls.push({ path: new URL(request.url).pathname, agentId: body.agentId });
      return Response.json({
        ok: true,
        data: {
          dedupe: request.url.endsWith("/release") ? "released" : "first",
        },
      });
    });
    mocks.enqueueIntegrationWatchDelivery
      .mockRejectedValueOnce(new Error("sandbox unavailable"))
      .mockResolvedValueOnce("queued");
    const { dispatchIntegrationWatchEvent } = await import("./integration-watch-dispatcher");

    const result = await dispatchIntegrationWatchEvent({
      workspaceId: "workspace-1",
      provider: "linear",
      eventType: "issue.updated",
      deliveryId: "write-1",
      paths: ["/linear/issues/LIN-1.json"],
    });

    expect(result).toEqual({ matched: 2, delivered: 1, failed: 1 });
    expect(brokerCalls).toContainEqual({
      path: "/internal/vfs-dedupe/release",
      agentId: "agent-1",
    });
    expect(brokerCalls).not.toContainEqual({
      path: "/internal/vfs-dedupe/release",
      agentId: "agent-2",
    });
  });
});
