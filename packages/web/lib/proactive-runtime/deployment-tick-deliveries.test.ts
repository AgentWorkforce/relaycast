import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dbExecute: vi.fn(),
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
  DeploymentTriggerRunTimedOutError: class DeploymentTriggerRunTimedOutError extends Error {
    readonly code = "deployment_run_timeout";
    readonly status = 504;
    constructor() {
      super("Deployment run exceeded runtime cap");
      this.name = "DeploymentTriggerRunTimedOutError";
    }
  },
  HarnessExit137Error: class HarnessExit137Error extends Error {
    readonly code = "harness_exit_137";
    readonly status = 502;
    constructor() {
      super("Harness exited with code 137");
      this.name = "HarnessExit137Error";
    }
  },
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({ execute: mocks.dbExecute }),
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
  DeploymentTriggerRunTimedOutError: mocks.DeploymentTriggerRunTimedOutError,
  HarnessExit137Error: mocks.HarnessExit137Error,
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
    agentId: "agent-1",
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

describe("deployment-tick deliveries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createInitialAgentDeployment.mockResolvedValue("deployment-1");
    mocks.getAgentDeploymentTickTarget.mockResolvedValue(target());
    mocks.runDeploymentTrigger.mockResolvedValue(undefined);
    mocks.pollDeploymentTriggerRun.mockResolvedValue(undefined);
    mocks.dbExecute.mockResolvedValue({ rows: [] });
  });

  it("enqueues a durable tick row and drains it to a completed run", async () => {
    const db = await import("./deployment-tick-deliveries");
    let background: Promise<unknown> | undefined;
    const waitUntil = vi.fn((promise: Promise<unknown>) => {
      background = promise;
    });

    mocks.dbExecute
      .mockResolvedValueOnce({ rows: [{ status: "pending" }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "delivery-row-1",
            workspace_id: "00000000-0000-0000-0000-000000000001",
            agent_id: "agent-1",
            delivery_id: "deployment-tick:deployment-1",
            payload: { type: "cron.tick", scheduleId: "sched_1" },
            attempt_count: 0,
            provisioning_sandbox_id: null,
            run_deployment_id: "deployment-1",
            run_sandbox_id: null,
            run_session_id: null,
            run_command_id: null,
            run_started_at: null,
            run_sandbox_name: null,
            run_mount_configured: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await db.enqueueDeploymentTickDelivery({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      target: target(),
      payload: { type: "cron.tick", scheduleId: "sched_1" },
      waitUntil,
    });

    expect(waitUntil).toHaveBeenCalledTimes(1);
    await background;
    expect(result).toEqual({
      agentId: "agent-1",
      workspaceId: "00000000-0000-0000-0000-000000000001",
      deploymentId: "deployment-1",
      status: "starting",
    });
    expect(mocks.createInitialAgentDeployment).toHaveBeenCalledWith({
      agentId: "agent-1",
      specHash: "spec-hash",
      triggerKind: "clock",
      triggerPayload: { type: "cron.tick", scheduleId: "sched_1" },
    });
    expect(mocks.runDeploymentTrigger).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      target: expect.objectContaining({
        agentId: "agent-1",
        deployedName: "weekly-digest",
        deployedByUserId: "00000000-0000-0000-0000-000000000099",
        specHash: "spec-hash",
      }),
      deploymentId: "deployment-1",
      triggerKind: "clock",
      payload: { type: "cron.tick", scheduleId: "sched_1" },
      provisioningSandboxId: null,
      // The drain enables provisioning-yield because it persists the sandbox id.
      options: { provisioningYieldEnabled: true },
    }));
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Deployment tick pending delivery drain completed",
      expect.objectContaining({
        area: "deployment-tick-delivery",
        workspaceId: "00000000-0000-0000-0000-000000000001",
        agentId: "agent-1",
        deliveryId: "deployment-tick:deployment-1",
        attempted: 1,
        delivered: 1,
        pending: 0,
        terminal: 0,
      }),
    );
  });

  it("polls a running tick and marks it delivered", async () => {
    const db = await import("./deployment-tick-deliveries");
    mocks.dbExecute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "delivery-row-2",
            workspace_id: "00000000-0000-0000-0000-000000000001",
            agent_id: "agent-1",
            delivery_id: "deployment-tick:deployment-2",
            payload: { type: "cron.tick", scheduleId: "sched_2" },
            attempt_count: 0,
            provisioning_sandbox_id: null,
            run_deployment_id: "deployment-2",
            run_sandbox_id: "sbx-2",
            run_session_id: "tick-deployment-2",
            run_command_id: "cmd-2",
            run_started_at: new Date("2026-06-03T11:06:00.000Z"),
            run_sandbox_name: "deploy-sbx",
            run_mount_configured: true,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      db.drainDeploymentTickDeliveries({
        workspaceId: "00000000-0000-0000-0000-000000000001",
        agentId: "agent-1",
        limit: 1,
      }),
    ).resolves.toEqual({
      attempted: 1,
      delivered: 1,
      failed: 0,
      pending: 0,
      terminal: 0,
    });

    expect(mocks.getAgentDeploymentTickTarget).not.toHaveBeenCalled();
    expect(mocks.pollDeploymentTriggerRun).toHaveBeenCalledWith({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      agentId: "agent-1",
      payload: { type: "cron.tick", scheduleId: "sched_2" },
      deploymentId: "deployment-2",
      sandboxId: "sbx-2",
      sessionId: "tick-deployment-2",
      commandId: "cmd-2",
      startedAt: "2026-06-03T11:06:00.000Z",
      sandboxName: "deploy-sbx",
      mountConfigured: true,
      envelopeJson: null,
      options: undefined,
    });
  });

  it("treats an inconclusive prior-run poll as still alive instead of clearing run state for re-invoke", async () => {
    const db = await import("./deployment-tick-deliveries");
    mocks.pollDeploymentTriggerRun.mockRejectedValueOnce(new Error("sandbox status unavailable"));
    mocks.dbExecute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "delivery-row-live",
            workspace_id: "00000000-0000-0000-0000-000000000001",
            agent_id: "agent-1",
            delivery_id: "deployment-tick:deployment-live:1781000000000",
            payload: {
              type: "cron.tick",
              scheduleId: "sched_live",
              occurrenceEpoch: 1_781_000_000_000,
              occurrenceId: "occurrence-live",
            },
            attempt_count: 0,
            provisioning_sandbox_id: null,
            run_deployment_id: "deployment-live",
            run_sandbox_id: "sbx-live",
            run_session_id: "tick-deployment-live",
            run_command_id: "cmd-live",
            run_started_at: new Date("2026-06-03T11:06:00.000Z"),
            run_sandbox_name: "deploy-sbx",
            run_mount_configured: true,
            run_envelope: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      db.drainDeploymentTickDeliveries({
        workspaceId: "00000000-0000-0000-0000-000000000001",
        agentId: "agent-1",
        limit: 1,
        maxAttempts: 6,
      }),
    ).resolves.toEqual({
      attempted: 1,
      delivered: 0,
      failed: 1,
      pending: 1,
      terminal: 0,
    });

    expect(mocks.runDeploymentTrigger).not.toHaveBeenCalled();
    const inconclusiveUpdate = mocks.dbExecute.mock.calls[1]?.[0];
    expect(sqlText(inconclusiveUpdate)).not.toContain("run_deployment_id = CASE");
    expect(sqlText(inconclusiveUpdate)).not.toContain("run_sandbox_id = CASE");
  });

  it("fails an inconclusive prior-run poll at max attempts without re-invoking", async () => {
    const db = await import("./deployment-tick-deliveries");
    mocks.pollDeploymentTriggerRun.mockRejectedValueOnce(new Error("sandbox status unavailable"));
    mocks.dbExecute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "delivery-row-live-terminal",
            workspace_id: "00000000-0000-0000-0000-000000000001",
            agent_id: "agent-1",
            delivery_id: "deployment-tick:deployment-live:1781000000000",
            payload: { type: "cron.tick" },
            attempt_count: 5,
            provisioning_sandbox_id: null,
            run_deployment_id: "deployment-live",
            run_sandbox_id: "sbx-live",
            run_session_id: "tick-deployment-live",
            run_command_id: "cmd-live",
            run_started_at: new Date("2026-06-03T11:06:00.000Z"),
            run_sandbox_name: "deploy-sbx",
            run_mount_configured: true,
            run_envelope: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      db.drainDeploymentTickDeliveries({
        workspaceId: "00000000-0000-0000-0000-000000000001",
        agentId: "agent-1",
        limit: 1,
        maxAttempts: 6,
      }),
    ).resolves.toEqual({
      attempted: 1,
      delivered: 0,
      failed: 1,
      pending: 0,
      terminal: 1,
    });

    expect(mocks.runDeploymentTrigger).not.toHaveBeenCalled();
    const inconclusiveUpdate = mocks.dbExecute.mock.calls[1]?.[0];
    expect(sqlText(inconclusiveUpdate)).not.toContain("run_deployment_id = CASE");
    expect(sqlText(inconclusiveUpdate)).not.toContain("run_sandbox_id = CASE");
  });

  it.each([
    ["timed-out", () => new mocks.DeploymentTriggerRunTimedOutError()],
    ["exit-137", () => new mocks.HarnessExit137Error()],
  ])("fails a definitive %s prior-run error without treating it as inconclusive", async (_label, errorFactory) => {
    const db = await import("./deployment-tick-deliveries");
    mocks.pollDeploymentTriggerRun.mockRejectedValueOnce(errorFactory());
    mocks.dbExecute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "delivery-row-definitive",
            workspace_id: "00000000-0000-0000-0000-000000000001",
            agent_id: "agent-1",
            delivery_id: "deployment-tick:deployment-live:1781000000000",
            payload: { type: "cron.tick" },
            attempt_count: 0,
            provisioning_sandbox_id: null,
            run_deployment_id: "deployment-live",
            run_sandbox_id: "sbx-live",
            run_session_id: "tick-deployment-live",
            run_command_id: "cmd-live",
            run_started_at: new Date("2026-06-03T11:06:00.000Z"),
            run_sandbox_name: "deploy-sbx",
            run_mount_configured: true,
            run_envelope: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      db.drainDeploymentTickDeliveries({
        workspaceId: "00000000-0000-0000-0000-000000000001",
        agentId: "agent-1",
        limit: 1,
        maxAttempts: 6,
      }),
    ).resolves.toEqual({
      attempted: 1,
      delivered: 0,
      failed: 1,
      pending: 1,
      terminal: 0,
    });

    expect(mocks.runDeploymentTrigger).not.toHaveBeenCalled();
    const failedUpdate = mocks.dbExecute.mock.calls[1]?.[0];
    expect(sqlText(failedUpdate)).toContain("run_sandbox_id = CASE");
  });

  it("fails an over-age running delivery without polling or re-invoking", async () => {
    const db = await import("./deployment-tick-deliveries");
    mocks.dbExecute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "delivery-row-too-old",
            workspace_id: "00000000-0000-0000-0000-000000000001",
            agent_id: "agent-1",
            delivery_id: "deployment-tick:occurrence-too-old",
            payload: { type: "cron.tick" },
            attempt_count: 0,
            provisioning_sandbox_id: null,
            run_deployment_id: "deployment-old",
            run_sandbox_id: "sbx-old",
            run_session_id: "tick-deployment-old",
            run_command_id: "cmd-old",
            run_started_at: new Date("2026-06-03T11:06:00.000Z"),
            run_sandbox_name: "deploy-sbx",
            run_mount_configured: true,
            run_envelope: null,
            created_at: new Date(Date.now() - 3_601_000),
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      db.drainDeploymentTickDeliveries({
        workspaceId: "00000000-0000-0000-0000-000000000001",
        agentId: "agent-1",
        limit: 1,
        maxDeliveryAgeSeconds: 3_600,
      }),
    ).resolves.toEqual({
      attempted: 1,
      delivered: 0,
      failed: 1,
      pending: 0,
      terminal: 1,
    });

    expect(mocks.pollDeploymentTriggerRun).not.toHaveBeenCalled();
    expect(mocks.runDeploymentTrigger).not.toHaveBeenCalled();
  });

  it("fails a pending tick when the deployment target is missing", async () => {
    const db = await import("./deployment-tick-deliveries");
    mocks.getAgentDeploymentTickTarget.mockResolvedValueOnce(null);
    mocks.dbExecute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "delivery-row-2a",
            workspace_id: "00000000-0000-0000-0000-000000000001",
            agent_id: "agent-1",
            delivery_id: "deployment-tick:deployment-2a",
            payload: { type: "cron.tick", scheduleId: "sched_2a" },
            attempt_count: 0,
            provisioning_sandbox_id: null,
            run_deployment_id: "deployment-2a",
            run_sandbox_id: null,
            run_session_id: null,
            run_command_id: null,
            run_started_at: null,
            run_sandbox_name: null,
            run_mount_configured: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      db.drainDeploymentTickDeliveries({
        workspaceId: "00000000-0000-0000-0000-000000000001",
        agentId: "agent-1",
        limit: 1,
        maxAttempts: 1,
      }),
    ).resolves.toEqual({
      attempted: 1,
      delivered: 0,
      failed: 1,
      pending: 0,
      terminal: 1,
    });

    expect(mocks.runDeploymentTrigger).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "Deployment tick pending delivery failed",
      expect.objectContaining({
        area: "deployment-tick-delivery",
        workspaceId: "00000000-0000-0000-0000-000000000001",
        agentId: "agent-1",
        deliveryId: "deployment-tick:deployment-2a",
        retryable: false,
      }),
    );
  });

  it("marks provisioning-pending ticks as pending with the sandbox id preserved", async () => {
    const db = await import("./deployment-tick-deliveries");
    const {
      DeploymentSandboxProvisioningPendingError,
    } = await import("./deployment-trigger-delivery");
    mocks.runDeploymentTrigger.mockRejectedValueOnce(
      new DeploymentSandboxProvisioningPendingError("sbx-3", "starting"),
    );
    mocks.dbExecute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "delivery-row-3",
            workspace_id: "00000000-0000-0000-0000-000000000001",
            agent_id: "agent-1",
            delivery_id: "deployment-tick:deployment-3",
            payload: { type: "cron.tick" },
            attempt_count: 0,
            provisioning_sandbox_id: null,
            run_deployment_id: "deployment-1",
            run_sandbox_id: null,
            run_session_id: null,
            run_command_id: null,
            run_started_at: null,
            run_sandbox_name: null,
            run_mount_configured: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      db.drainDeploymentTickDeliveries({
        workspaceId: "00000000-0000-0000-0000-000000000001",
        agentId: "agent-1",
        limit: 1,
        maxAttempts: 1,
      }),
    ).resolves.toEqual({
      attempted: 1,
      delivered: 0,
      failed: 1,
      pending: 1,
      terminal: 0,
    });

    expect(mocks.runDeploymentTrigger).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      deploymentId: "deployment-1",
    }));
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Deployment tick delivery sandbox still provisioning",
      expect.objectContaining({
        area: "deployment-tick-delivery",
        workspaceId: "00000000-0000-0000-0000-000000000001",
        agentId: "agent-1",
        deliveryId: "deployment-tick:deployment-3",
        sandboxId: "sbx-3",
      }),
    );
  });

  it("clears the persisted provisioning id when the provisioning sandbox is gone", async () => {
    const db = await import("./deployment-tick-deliveries");
    const {
      DeploymentSandboxProvisioningTerminalError,
    } = await import("./deployment-trigger-delivery");
    mocks.runDeploymentTrigger.mockRejectedValueOnce(
      new DeploymentSandboxProvisioningTerminalError("sbx-gone", "missing"),
    );
    mocks.dbExecute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "delivery-row-3b",
            workspace_id: "00000000-0000-0000-0000-000000000001",
            agent_id: "agent-1",
            delivery_id: "deployment-tick:deployment-3b",
            payload: { type: "cron.tick" },
            attempt_count: 0,
            provisioning_sandbox_id: "sbx-gone",
            run_deployment_id: "deployment-1",
            run_sandbox_id: null,
            run_session_id: null,
            run_command_id: null,
            run_started_at: null,
            run_sandbox_name: null,
            run_mount_configured: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      db.drainDeploymentTickDeliveries({
        workspaceId: "00000000-0000-0000-0000-000000000001",
        agentId: "agent-1",
        limit: 1,
      }),
    ).resolves.toEqual({
      attempted: 1,
      delivered: 0,
      failed: 1,
      pending: 1,
      terminal: 0,
    });

    const failedUpdate = mocks.dbExecute.mock.calls[1]?.[0] as {
      queryChunks?: unknown[];
    };
    const chunks = (failedUpdate?.queryChunks ?? []) as Array<unknown>;
    const clearChunkIndex = chunks.findIndex((chunk) => {
      const record = chunk as { value?: unknown };
      return Array.isArray(record?.value) &&
        record.value.join("").includes("provisioning_sandbox_id = CASE");
    });
    expect(clearChunkIndex).toBeGreaterThan(-1);
    expect(chunks[clearChunkIndex + 1]).toBe(true);
  });

  it("marks terminal failures failed and logs them", async () => {
    const db = await import("./deployment-tick-deliveries");
    mocks.runDeploymentTrigger.mockRejectedValueOnce(new Error("proxy.app.daytona.io | 524"));
    mocks.dbExecute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "delivery-row-4",
            workspace_id: "00000000-0000-0000-0000-000000000001",
            agent_id: "agent-1",
            delivery_id: "deployment-tick:deployment-4",
            payload: { type: "cron.tick" },
            attempt_count: 0,
            provisioning_sandbox_id: null,
            run_deployment_id: "deployment-1",
            run_sandbox_id: null,
            run_session_id: null,
            run_command_id: null,
            run_started_at: null,
            run_sandbox_name: null,
            run_mount_configured: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      db.drainDeploymentTickDeliveries({
        workspaceId: "00000000-0000-0000-0000-000000000001",
        agentId: "agent-1",
        limit: 1,
        maxAttempts: 1,
      }),
    ).resolves.toEqual({
      attempted: 1,
      delivered: 0,
      failed: 1,
      pending: 0,
      terminal: 1,
    });

    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "Deployment tick pending delivery failed",
      expect.objectContaining({
        area: "deployment-tick-delivery",
        workspaceId: "00000000-0000-0000-0000-000000000001",
        agentId: "agent-1",
        deliveryId: "deployment-tick:deployment-4",
        retryable: true,
      }),
    );
  });

  it("rolls back the deployment row if the durable queue insert fails", async () => {
    const db = await import("./deployment-tick-deliveries");
    mocks.dbExecute.mockImplementationOnce((query) => {
      if (sqlText(query).includes("INSERT INTO deployment_tick_deliveries")) {
        throw new Error("queue insert failed");
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(
      db.enqueueDeploymentTickDelivery({
        workspaceId: "00000000-0000-0000-0000-000000000001",
        target: target(),
        payload: { type: "cron.tick" },
        waitUntil: vi.fn(),
      }),
    ).rejects.toThrow("queue insert failed");

    expect(mocks.dbExecute.mock.calls.map(([query]) => sqlText(query)).join("\n")).toContain(
      "DELETE FROM agent_deployments",
    );
  });
});
