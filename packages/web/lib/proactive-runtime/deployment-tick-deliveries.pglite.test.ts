import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { setDbForTesting } from "@/lib/db";

const mocks = vi.hoisted(() => ({
  createInitialAgentDeployment: vi.fn(),
  getAgentDeploymentTickTarget: vi.fn(),
  runDeploymentTrigger: vi.fn(),
  pollDeploymentTriggerRun: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  DeploymentSandboxProvisioningPendingError: class DeploymentSandboxProvisioningPendingError extends Error {
    readonly code = "sandbox_provisioning_pending";
    readonly status = 503;
    constructor(readonly sandboxId: string, state?: string | null) {
      super(`Sandbox ${sandboxId} is still provisioning${state ? ` (${state})` : ""}`);
      this.name = "DeploymentSandboxProvisioningPendingError";
    }
  },
  DeploymentSandboxProvisioningTerminalError: class DeploymentSandboxProvisioningTerminalError extends Error {
    readonly code = "sandbox_provisioning_terminal";
    readonly status = 500;
    constructor(readonly sandboxId: string, state?: string | null) {
      super(`Sandbox ${sandboxId} failed${state ? ` (${state})` : ""}`);
      this.name = "DeploymentSandboxProvisioningTerminalError";
    }
  },
  DeploymentTriggerRunPendingError: class DeploymentTriggerRunPendingError extends Error {
    readonly code = "deployment_run_pending";
    readonly status = 202;
    constructor(
      readonly run: {
        deploymentId: string;
        sandboxId: string;
        sessionId: string;
        commandId: string;
        startedAt: string;
        sandboxName?: string | null;
        mountConfigured?: boolean;
      },
    ) {
      super(`Deployment run ${run.commandId} is still running`);
      this.name = "DeploymentTriggerRunPendingError";
    }
  },
  DeploymentTriggerRunSandboxTerminalError: class DeploymentTriggerRunSandboxTerminalError extends Error {
    readonly code = "deployment_run_sandbox_terminal";
    readonly status = 500;
    constructor(
      readonly run: {
        deploymentId: string;
        sandboxId: string;
        sessionId: string;
        commandId: string;
        startedAt: string;
        sandboxName?: string | null;
        mountConfigured?: boolean;
      },
      state?: string | null,
    ) {
      super(`Deployment run ${run.commandId} failed${state ? ` (${state})` : ""}`);
      this.name = "DeploymentTriggerRunSandboxTerminalError";
    }
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
  },
}));

vi.mock("@/lib/proactive-runtime/persona-deploy", () => ({
  createInitialAgentDeployment: mocks.createInitialAgentDeployment,
  getAgentDeploymentTickTarget: mocks.getAgentDeploymentTickTarget,
}));

vi.mock("@/lib/proactive-runtime/deployment-trigger-delivery", () => ({
  DeploymentTriggerDeliveryError: class DeploymentTriggerDeliveryError extends Error {
    constructor(message: string, readonly code: string, readonly status: number) {
      super(message);
      this.name = "DeploymentTriggerDeliveryError";
    }
  },
  DeploymentSandboxProvisioningPendingError: mocks.DeploymentSandboxProvisioningPendingError,
  DeploymentSandboxProvisioningTerminalError: mocks.DeploymentSandboxProvisioningTerminalError,
  DeploymentTriggerRunPendingError: mocks.DeploymentTriggerRunPendingError,
  DeploymentTriggerRunSandboxTerminalError: mocks.DeploymentTriggerRunSandboxTerminalError,
  runDeploymentTrigger: mocks.runDeploymentTrigger,
  pollDeploymentTriggerRun: mocks.pollDeploymentTriggerRun,
}));

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
        const inner = (chunk as { value: unknown }).value;
        return Array.isArray(inner) ? inner.join("") : String(inner);
      }
      return "?";
    })
    .join("");
}

function target(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "00000000-0000-0000-0000-0000000000a1",
    deployedName: "weekly-digest",
    deployedByUserId: "00000000-0000-0000-0000-000000000099",
    spec: { id: "weekly-digest" },
    agentSpec: null,
    inputValues: { topic: "AI" },
    credentialSelections: {},
    specHash: "spec-hash",
    bundleSha256: "a".repeat(64),
    personaSlug: "weekly-digest",
    status: "active",
    webhookSecretHash: null,
    ...overrides,
  };
}

let pg: PGlite | null = null;

describe("deployment tick deliveries", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    pg = new PGlite();
    await pg.exec(`
      CREATE TABLE deployment_tick_deliveries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL,
        agent_id uuid NOT NULL,
        delivery_id text NOT NULL,
        payload jsonb NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        attempt_count integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        lease_until timestamptz,
        provisioning_sandbox_id text,
        run_deployment_id uuid,
        run_sandbox_id text,
        run_session_id text,
        run_command_id text,
        run_started_at timestamptz,
        run_sandbox_name text,
        run_mount_configured boolean,
        run_envelope text,
        last_error text,
        delivered_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (workspace_id, agent_id, delivery_id)
      );
      CREATE TABLE agent_deployments (
        id uuid PRIMARY KEY
      );
      CREATE TABLE agent_deployment_runs (
        id uuid PRIMARY KEY,
        workspace_id uuid NOT NULL,
        agent_id uuid NOT NULL,
        deployment_id uuid NOT NULL,
        started_at timestamptz NOT NULL,
        ended_at timestamptz NOT NULL,
        duration_ms integer NOT NULL DEFAULT 0,
        status text NOT NULL,
        error text,
        summary text,
        envelope text,
        envelope_omitted boolean NOT NULL DEFAULT false,
        compressed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    setDbForTesting(drizzle(pg) as never);
    mocks.createInitialAgentDeployment.mockResolvedValue(
      "00000000-0000-0000-0000-000000000099",
    );
    mocks.getAgentDeploymentTickTarget.mockResolvedValue(target());
    mocks.runDeploymentTrigger.mockResolvedValue(undefined);
    mocks.pollDeploymentTriggerRun.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    setDbForTesting(null);
    await pg?.close();
    pg = null;
  });

  it("keys tick delivery rows by occurrence id", async () => {
    const { enqueueDeploymentTickDelivery } = await import("./deployment-tick-deliveries");
    const waitUntil = vi.fn();

    await enqueueDeploymentTickDelivery({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      target: target(),
      payload: {
        type: "cron.tick",
        scheduleId: "sched_1",
        occurrenceEpoch: 1_781_000_000_000,
        occurrenceId: "occurrence-09",
      },
      waitUntil,
    });
    await enqueueDeploymentTickDelivery({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      target: target(),
      payload: {
        type: "cron.tick",
        scheduleId: "sched_1",
        occurrenceEpoch: 1_781_028_800_000,
        occurrenceId: "occurrence-17",
      },
      waitUntil,
    });

    const rows = await pg!.query<{ delivery_id: string; payload: Record<string, unknown> }>(
      "SELECT delivery_id, payload FROM deployment_tick_deliveries ORDER BY delivery_id",
    );
    expect(rows.rows).toEqual([
      {
        delivery_id: "deployment-tick:occurrence-09",
        payload: expect.objectContaining({ occurrenceId: "occurrence-09" }),
      },
      {
        delivery_id: "deployment-tick:occurrence-17",
        payload: expect.objectContaining({ occurrenceId: "occurrence-17" }),
      },
    ]);
  });

  it("dedupes repeated delivery attempts for the same occurrence and deletes the losing deployment", async () => {
    const { enqueueDeploymentTickDelivery } = await import("./deployment-tick-deliveries");
    const waitUntil = vi.fn();
    const createdIds = [
      "00000000-0000-0000-0000-000000000091",
      "00000000-0000-0000-0000-000000000092",
    ];
    mocks.createInitialAgentDeployment.mockImplementation(async () => {
      const id = createdIds.shift();
      if (!id) throw new Error("unexpected deployment creation");
      await pg!.query("INSERT INTO agent_deployments (id) VALUES ($1)", [id]);
      return id;
    });

    await enqueueDeploymentTickDelivery({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      target: target(),
      payload: {
        type: "cron.tick",
        scheduleId: "sched_1",
        occurrenceEpoch: 1_781_000_000_000,
        occurrenceId: "occurrence-09",
        attemptLabel: "first",
      },
      waitUntil,
    });
    await enqueueDeploymentTickDelivery({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      target: target(),
      payload: {
        type: "cron.tick",
        scheduleId: "sched_1",
        occurrenceEpoch: 1_781_000_000_000,
        occurrenceId: "occurrence-09",
        attemptLabel: "second",
      },
      waitUntil,
    });

    const rows = await pg!.query<{
      delivery_id: string;
      payload: Record<string, unknown>;
      run_deployment_id: string;
    }>(
      "SELECT delivery_id, payload, run_deployment_id FROM deployment_tick_deliveries",
    );
    expect(rows.rows).toEqual([
      {
        delivery_id: "deployment-tick:occurrence-09",
        payload: expect.objectContaining({
          occurrenceId: "occurrence-09",
          attemptLabel: "second",
        }),
        run_deployment_id: "00000000-0000-0000-0000-000000000091",
      },
    ]);
    const deployments = await pg!.query<{ id: string }>(
      "SELECT id FROM agent_deployments ORDER BY id",
    );
    expect(deployments.rows).toEqual([
      { id: "00000000-0000-0000-0000-000000000091" },
    ]);
  });

  it("persists provisioning-pending ticks instead of dropping them", async () => {
    const { enqueueDeploymentTickDelivery } = await import("./deployment-tick-deliveries");
    let background: Promise<unknown> | undefined;
    const waitUntil = vi.fn((promise: Promise<unknown>) => {
      background = promise;
    });
    mocks.runDeploymentTrigger.mockRejectedValueOnce(
      new mocks.DeploymentSandboxProvisioningPendingError("sbx-3", "starting"),
    );

    const result = await enqueueDeploymentTickDelivery({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      target: target(),
      payload: { type: "cron.tick", scheduleId: "sched_1" },
      waitUntil,
    });

    expect(waitUntil).toHaveBeenCalledTimes(1);
    await background;
    expect(result).toEqual({
      agentId: "00000000-0000-0000-0000-0000000000a1",
      workspaceId: "00000000-0000-0000-0000-000000000001",
      deploymentId: "00000000-0000-0000-0000-000000000099",
      status: "starting",
    });

    const rows = await pg!.query<{
      delivery_id: string;
      status: string;
      provisioning_sandbox_id: string | null;
      run_deployment_id: string | null;
      last_error: string | null;
    }>(
      "SELECT delivery_id, status, provisioning_sandbox_id, run_deployment_id, last_error FROM deployment_tick_deliveries",
    );
    expect(rows.rows).toEqual([
      {
        delivery_id: "deployment-tick:00000000-0000-0000-0000-000000000099",
        status: "pending",
        provisioning_sandbox_id: "sbx-3",
        run_deployment_id: "00000000-0000-0000-0000-000000000099",
        last_error: expect.stringContaining("Sandbox sbx-3 is still provisioning"),
      },
    ]);
  });

  it("sweeps a running tick through pollDeploymentTriggerRun and records the run row", async () => {
    const { drainDeploymentTickDeliveries } = await import("./deployment-tick-deliveries");
    await pg!.exec(`
      INSERT INTO deployment_tick_deliveries (
        id,
        workspace_id,
        agent_id,
        delivery_id,
        payload,
        status,
        attempt_count,
        next_attempt_at,
        run_deployment_id,
        run_sandbox_id,
        run_session_id,
        run_command_id,
        run_started_at,
        run_sandbox_name,
        run_mount_configured,
        run_envelope,
        created_at,
        updated_at
      )
      VALUES (
        '00000000-0000-0000-0000-000000000030',
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-0000000000a1',
        'deployment-tick:deployment-2',
        '{"type":"cron.tick","scheduleId":"sched_2"}'::jsonb,
        'running',
        0,
        now() - interval '1 minute',
        '00000000-0000-0000-0000-000000000099',
        'sbx-warm',
        'tick-deployment-2',
        'cmd-123',
        '2026-06-03T11:06:00.000Z',
        'deploy-sbx',
        true,
        '{"id":"tick-envelope","resource":{"scheduleId":"sched_2"}}',
        now() - interval '5 minutes',
        now() - interval '1 minute'
      );
    `);
    mocks.pollDeploymentTriggerRun.mockImplementationOnce(async (input: {
      workspaceId: string;
      agentId: string;
      payload: Record<string, unknown>;
      deploymentId: string;
      sandboxId: string;
      sessionId: string;
      commandId: string;
      startedAt: string;
      envelopeJson?: string | null;
    }) => {
      await pg!.exec(`
        INSERT INTO agent_deployment_runs (
          id,
          workspace_id,
          agent_id,
          deployment_id,
          started_at,
          ended_at,
          duration_ms,
          status,
          error,
          summary,
          envelope,
          envelope_omitted,
          created_at,
          updated_at
        )
        VALUES (
          '00000000-0000-0000-0000-000000000040',
          '${input.workspaceId}',
          '${input.agentId}',
          '${input.deploymentId}',
          '${input.startedAt}',
          '2026-06-03T11:06:24.000Z',
          24000,
          'succeeded',
          null,
          null,
          ${input.envelopeJson == null ? "null" : `'${input.envelopeJson}'`},
          false,
          now(),
          now()
        );
      `);
    });

    await expect(
      drainDeploymentTickDeliveries({
        limit: 1,
      }),
    ).resolves.toEqual({
      attempted: 1,
      delivered: 1,
      failed: 0,
      pending: 0,
      terminal: 0,
    });

    expect(mocks.pollDeploymentTriggerRun).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      agentId: "00000000-0000-0000-0000-0000000000a1",
      deploymentId: "00000000-0000-0000-0000-000000000099",
      sandboxId: "sbx-warm",
      sessionId: "tick-deployment-2",
      commandId: "cmd-123",
      startedAt: "2026-06-03 11:06:00+00",
      sandboxName: "deploy-sbx",
      mountConfigured: true,
      envelopeJson: '{"id":"tick-envelope","resource":{"scheduleId":"sched_2"}}',
      payload: { type: "cron.tick", scheduleId: "sched_2" },
      options: undefined,
    }));

    const deliveryRows = await pg!.query<{ delivery_id: string; status: string }>(
      "SELECT delivery_id, status FROM deployment_tick_deliveries",
    );
    expect(deliveryRows.rows).toEqual([
      {
        delivery_id: "deployment-tick:deployment-2",
        status: "delivered",
      },
    ]);

    const runRows = await pg!.query<{ deployment_id: string; status: string; envelope: string | null }>(
      "SELECT deployment_id, status, envelope FROM agent_deployment_runs",
    );
    expect(runRows.rows).toEqual([
      {
        deployment_id: "00000000-0000-0000-0000-000000000099",
        status: "succeeded",
        envelope: '{"id":"tick-envelope","resource":{"scheduleId":"sched_2"}}',
      },
    ]);
  });
});
