import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dbExecute: vi.fn(),
  dbTransaction: vi.fn(),
  lockExecute: vi.fn(),
  deliverDeploymentTrigger: vi.fn(),
  pollDeploymentTriggerRun: vi.fn(),
  buildTeamLaunchPayload: vi.fn(),
  dispatchTeamLaunchN1: vi.fn(),
  buildTeamLaunchMemberOptions: vi.fn(),
  launchTeamMember: vi.fn(),
  teamSolveMaxMembers: vi.fn(),
  readTeamRosterMemberConfigs: vi.fn(),
  deriveIntegrationWatchIssueDedupeKey: vi.fn(),
  releaseIssueDispatchDedupe: vi.fn(),
  releaseVfsWatchDedupe: vi.fn(),
  dispatchFactoryBrainDelivery: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    execute: mocks.dbExecute,
    transaction: mocks.dbTransaction,
  }),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
}));

vi.mock("@/lib/proactive-runtime/integration-watch-dispatcher", () => ({
  readIssueDispatchCooldownSeconds: () => 180,
  deriveIntegrationWatchIssueDedupeKey: mocks.deriveIntegrationWatchIssueDedupeKey,
  releaseIssueDispatchDedupe: mocks.releaseIssueDispatchDedupe,
  releaseVfsWatchDedupe: mocks.releaseVfsWatchDedupe,
}));

vi.mock("@/lib/proactive-runtime/team-launch-n1", () => ({
  buildTeamLaunchPayload: mocks.buildTeamLaunchPayload,
  buildTeamLaunchMemberOptions: mocks.buildTeamLaunchMemberOptions,
  dispatchTeamLaunchN1: mocks.dispatchTeamLaunchN1,
  launchTeamMember: mocks.launchTeamMember,
  teamSolveMaxMembers: mocks.teamSolveMaxMembers,
  TeamLaunchOptionsUnavailableError: class TeamLaunchOptionsUnavailableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "TeamLaunchOptionsUnavailableError";
    }
  },
}));

vi.mock("@/lib/proactive-runtime/team-roster", () => ({
  readTeamRosterMemberConfigs: mocks.readTeamRosterMemberConfigs,
}));

vi.mock("@/lib/proactive-runtime/factory-cloud-orchestrator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/proactive-runtime/factory-cloud-orchestrator")>();
  return {
    ...actual,
    dispatchFactoryBrainDelivery: mocks.dispatchFactoryBrainDelivery,
  };
});

vi.mock("@/lib/proactive-runtime/deployment-trigger-delivery", () => ({
  DeploymentTriggerDeliveryError: class DeploymentTriggerDeliveryError extends Error {
    constructor(message: string, readonly code: string, readonly status: number) {
      super(message);
      this.name = "DeploymentTriggerDeliveryError";
    }
  },
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
    readonly status = 502;
    constructor(readonly sandboxId: string, state?: string | null) {
      super(`Sandbox ${sandboxId} entered terminal provisioning state${state ? ` (${state})` : ""}`);
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
  deliverDeploymentTrigger: mocks.deliverDeploymentTrigger,
  pollDeploymentTriggerRun: mocks.pollDeploymentTriggerRun,
}));

describe("integration watch pending deliveries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dbTransaction.mockImplementation(async (callback: (tx: { execute: typeof mocks.dbExecute }) => Promise<unknown>) =>
      callback({
        execute: vi.fn((query: { queryChunks?: Array<{ value?: unknown }> }) => {
          const text = (query.queryChunks ?? [])
            .map((chunk) => (Array.isArray(chunk?.value) ? chunk.value.join("") : ""))
            .join(" ");
          if (text.includes("pg_advisory_xact_lock")) {
            mocks.lockExecute(query);
            return Promise.resolve({ rows: [] });
          }
          return mocks.dbExecute(query);
        }),
      }),
    );
    mocks.deliverDeploymentTrigger.mockResolvedValue({
      agentId: "agent-1",
      workspaceId: "workspace-1",
      deploymentId: "deployment-1",
      status: "starting",
    });
    mocks.pollDeploymentTriggerRun.mockResolvedValue(undefined);
    mocks.buildTeamLaunchPayload.mockImplementation(async (input: { payload: Record<string, unknown> }) => ({
      ...input.payload,
      launchMember: { credentialBundle: {} },
    }));
    mocks.dispatchTeamLaunchN1.mockResolvedValue({
      status: "launched",
      workspaceId: "00000000-0000-0000-0000-000000000001",
      agentId: "00000000-0000-0000-0000-000000000002",
      deliveryId: "delivery-1",
      memberName: "cloud-team-issue-n1",
      role: "implementer",
      channel: "team-launch-n1-agent",
      sandboxId: "sandbox-1",
      assignedRoot: "/github/repos/AgentWorkforce/cloud/issues/123",
      localRoot: "/home/daytona/workspace/github/repos/AgentWorkforce/cloud/issues/123",
      writeScopes: ["relayfile:fs:write:/github/repos/AgentWorkforce/cloud/issues/123/*"],
    });
    mocks.readTeamRosterMemberConfigs.mockResolvedValue([]);
    mocks.teamSolveMaxMembers.mockReturnValue(1);
    mocks.deriveIntegrationWatchIssueDedupeKey.mockReturnValue("github:AgentWorkforce/cloud#123");
    mocks.releaseIssueDispatchDedupe.mockResolvedValue(undefined);
    mocks.releaseVfsWatchDedupe.mockResolvedValue("released");
    mocks.dispatchFactoryBrainDelivery.mockResolvedValue({
      issueKey: "AR-267",
      recipe: "team",
      emitted: 2,
      invocationIds: ["inv-1", "inv-2"],
    });
  });

  it("enqueues delivery rows idempotently by workspace, agent, and delivery id", async () => {
    mocks.dbExecute.mockResolvedValueOnce({ rows: [{ status: "pending" }] });
    const { enqueueIntegrationWatchDelivery } = await import("./integration-watch-deliveries");

    await expect(enqueueIntegrationWatchDelivery({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      agentId: "00000000-0000-0000-0000-000000000002",
      deliveryId: "delivery-1",
      payload: { type: "github.issues.opened" },
    })).resolves.toBe("queued");

    expect(mocks.dbExecute).toHaveBeenCalledTimes(1);
  });

  it("persists the matched trigger key when enqueueing delivery rows", async () => {
    mocks.dbExecute.mockResolvedValueOnce({ rows: [{ status: "pending" }] });
    const { enqueueIntegrationWatchDelivery } = await import("./integration-watch-deliveries");

    await expect(enqueueIntegrationWatchDelivery({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      agentId: "00000000-0000-0000-0000-000000000002",
      deliveryId: "delivery-1",
      triggerKey: "provider:github:trigger:1",
      payload: { type: "github.issues.opened" },
    })).resolves.toBe("queued");

    const query = mocks.dbExecute.mock.calls[0]?.[0] as { queryChunks?: unknown[] };
    const sqlText = (query.queryChunks ?? [])
      .map((chunk) => {
        const record = chunk as { value?: unknown };
        return Array.isArray(record?.value) ? record.value.join("") : "";
      })
      .join(" ");
    expect(sqlText).toContain("trigger_key");
    expect(sqlText).toContain("trigger_key = EXCLUDED.trigger_key");
    expect(query.queryChunks).toContain("provider:github:trigger:1");
  });

  it("drains pending rows and marks successful deliveries delivered", async () => {
    mocks.dbExecute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "00000000-0000-0000-0000-000000000010",
            workspace_id: "00000000-0000-0000-0000-000000000001",
            agent_id: "00000000-0000-0000-0000-000000000002",
            delivery_id: "delivery-1",
            payload: { type: "github.issues.opened" },
            attempt_count: 0,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const { drainIntegrationWatchDeliveries } = await import("./integration-watch-deliveries");

    await expect(drainIntegrationWatchDeliveries({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      agentId: "00000000-0000-0000-0000-000000000002",
      limit: 1,
    })).resolves.toEqual({
      attempted: 1,
      delivered: 1,
      failed: 0,
      pending: 0,
      terminal: 0,
    });

    expect(mocks.deliverDeploymentTrigger).toHaveBeenCalledWith({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      agentId: "00000000-0000-0000-0000-000000000002",
      deliveryId: "delivery-1",
      payload: { type: "github.issues.opened" },
      options: undefined,
    });
    expect(mocks.dbExecute).toHaveBeenCalledTimes(2);
  });

  it("drains factory brain rows through the cloud factory emitter and marks them delivered", async () => {
    const payload = {
      provider: "linear",
      eventType: "issues.updated",
      paths: ["/linear/issues/AR-267__issue-1.json"],
      resource: {
        id: "issue-1",
        identifier: "AR-267",
        title: "[factory] Phase 2 cloud lift",
        labels: ["factory", "agent:team", "cloud"],
      },
      factoryBrain: true,
    };
    mocks.dbExecute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "00000000-0000-0000-0000-000000000010",
            workspace_id: "00000000-0000-0000-0000-000000000001",
            agent_id: "00000000-0000-0000-0000-000000000002",
            delivery_id: "delivery-1",
            payload,
            attempt_count: 0,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ deployed_by_user_id: "user-1", organization_id: "org-1" }],
      })
      .mockResolvedValueOnce({ rows: [] });
    const { drainIntegrationWatchDeliveries } = await import("./integration-watch-deliveries");

    await expect(drainIntegrationWatchDeliveries({ limit: 1 })).resolves.toEqual({
      attempted: 1,
      delivered: 1,
      failed: 0,
      pending: 0,
      terminal: 0,
    });

    expect(mocks.dispatchFactoryBrainDelivery).toHaveBeenCalledWith({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      agentId: "00000000-0000-0000-0000-000000000002",
      deliveryId: "delivery-1",
      payload,
      deployedByUserId: "user-1",
    });
    expect(mocks.deliverDeploymentTrigger).not.toHaveBeenCalled();
    expect(mocks.dispatchTeamLaunchN1).not.toHaveBeenCalled();
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Integration watch factory brain delivery emitted",
      expect.objectContaining({
        area: "factory-cloud-brain",
        diag: "delivery-emitted",
        deliveryId: "delivery-1",
        invocationIds: ["inv-1", "inv-2"],
      }),
    );
  });

  it("serializes agent-scoped claims with an advisory transaction lock but leaves sweeps unlocked", async () => {
    mocks.dbExecute.mockResolvedValueOnce({ rows: [] });
    const { drainIntegrationWatchDeliveries } = await import("./integration-watch-deliveries");

    await expect(drainIntegrationWatchDeliveries({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      agentId: "00000000-0000-0000-0000-000000000002",
      deliveryId: "delivery-1",
      limit: 1,
    })).resolves.toMatchObject({ attempted: 0 });

    expect(mocks.dbTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.lockExecute).toHaveBeenCalledTimes(1);
    const lockSql = (mocks.lockExecute.mock.calls[0]?.[0]?.queryChunks ?? [])
      .map((chunk: { value?: unknown }) => (Array.isArray(chunk?.value) ? chunk.value.join("") : ""))
      .join(" ");
    expect(lockSql).toContain("pg_advisory_xact_lock");
    expect(lockSql).toContain("hashtext('iwd:' || ");

    vi.clearAllMocks();
    mocks.dbExecute.mockResolvedValueOnce({ rows: [] });
    await expect(drainIntegrationWatchDeliveries({ limit: 1 })).resolves.toMatchObject({ attempted: 0 });

    expect(mocks.dbTransaction).not.toHaveBeenCalled();
    expect(mocks.lockExecute).not.toHaveBeenCalled();
    expect(mocks.dbExecute).toHaveBeenCalledTimes(1);
  });

  it("drains pending rows across workspaces for the relaycron retry sweep", async () => {
    mocks.dbExecute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "00000000-0000-0000-0000-000000000010",
            workspace_id: "00000000-0000-0000-0000-000000000001",
            agent_id: "00000000-0000-0000-0000-000000000002",
            delivery_id: "delivery-1",
            payload: { type: "github.issues.opened" },
            attempt_count: 1,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const { drainIntegrationWatchDeliveries } = await import("./integration-watch-deliveries");

    await expect(drainIntegrationWatchDeliveries({
      limit: 1,
      deliveryOptions: {
        sandboxCreateTimeoutSeconds: 120,
        runScriptTimeoutMs: 15_000,
        asyncRunScript: true,
      },
    })).resolves.toEqual({
      attempted: 1,
      delivered: 1,
      failed: 0,
      pending: 0,
      terminal: 0,
    });

    expect(mocks.deliverDeploymentTrigger).toHaveBeenCalledWith({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      agentId: "00000000-0000-0000-0000-000000000002",
      deliveryId: "delivery-1",
      payload: { type: "github.issues.opened" },
      options: {
        sandboxCreateTimeoutSeconds: 120,
        runScriptTimeoutMs: 15_000,
        asyncRunScript: true,
      },
    });
  });

  it("defers marked team-launch rows unless the relaycron sweep allows them", async () => {
    mocks.dbExecute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "00000000-0000-0000-0000-000000000010",
            workspace_id: "00000000-0000-0000-0000-000000000001",
            agent_id: "00000000-0000-0000-0000-000000000002",
            delivery_id: "delivery-1",
            payload: {
              provider: "github",
              eventType: "issues.labeled",
              paths: ["/github/repos/AgentWorkforce/cloud/issues/123.json"],
              resource: { issue: { number: 123 }, repository: { full_name: "AgentWorkforce/cloud" } },
              teamLaunchN1: true,
            },
            attempt_count: 0,
            provisioning_sandbox_id: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const { drainIntegrationWatchDeliveries } = await import("./integration-watch-deliveries");

    await expect(drainIntegrationWatchDeliveries({ limit: 1 })).resolves.toEqual({
      attempted: 1,
      delivered: 0,
      failed: 1,
      pending: 1,
      terminal: 0,
    });

    expect(mocks.buildTeamLaunchPayload).not.toHaveBeenCalled();
    expect(mocks.dispatchTeamLaunchN1).not.toHaveBeenCalled();
    expect(mocks.deliverDeploymentTrigger).not.toHaveBeenCalled();
    expect(mocks.dbExecute).toHaveBeenCalledTimes(2);
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Integration watch teamSolve N=1 deferred to sweep",
      expect.objectContaining({ diag: "sweep-only", deliveryId: "delivery-1" }),
    );
  });

  it("launches marked team-launch rows during the relaycron sweep", async () => {
    const payload = {
      provider: "github",
      eventType: "issues.labeled",
      paths: ["/github/repos/AgentWorkforce/cloud/issues/123.json"],
      resource: { issue: { number: 123 }, repository: { full_name: "AgentWorkforce/cloud" } },
      teamLaunchN1: true,
    };
    mocks.dbExecute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "00000000-0000-0000-0000-000000000010",
            workspace_id: "00000000-0000-0000-0000-000000000001",
            agent_id: "00000000-0000-0000-0000-000000000002",
            delivery_id: "delivery-1",
            payload,
            attempt_count: 0,
            provisioning_sandbox_id: "sbx-starting",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ deployed_by_user_id: "user-1", organization_id: "org-1" }],
      })
      .mockResolvedValueOnce({ rows: [] });
    const { drainIntegrationWatchDeliveries } = await import("./integration-watch-deliveries");

    await expect(drainIntegrationWatchDeliveries({ limit: 1, allowTeamLaunchN1: true })).resolves.toEqual({
      attempted: 1,
      delivered: 1,
      failed: 0,
      pending: 0,
      terminal: 0,
    });

    expect(mocks.buildTeamLaunchPayload).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      agentId: "00000000-0000-0000-0000-000000000002",
      deliveryId: "delivery-1",
      payload,
      deployedByUserId: "user-1",
      organizationId: "org-1",
    }));
    expect(mocks.dispatchTeamLaunchN1).toHaveBeenCalledWith(
      expect.objectContaining({
        provisioningSandboxId: "sbx-starting",
        payload: expect.objectContaining({ launchMember: expect.any(Object) }),
      }),
      expect.objectContaining({
        buildLaunchOptions: expect.any(Function),
        launchMember: mocks.launchTeamMember,
      }),
    );
    expect(mocks.deliverDeploymentTrigger).not.toHaveBeenCalled();
  });

  it("treats a Daytona proxy 524 after the sandbox exists as ambiguous success and marks delivered", async () => {
    const payload = {
      provider: "github",
      eventType: "issues.labeled",
      paths: ["/github/repos/AgentWorkforce/cloud/issues/123.json"],
      resource: { issue: { number: 123 }, repository: { full_name: "AgentWorkforce/cloud" } },
      teamLaunchN1: true,
    };
    mocks.dbExecute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "00000000-0000-0000-0000-000000000010",
            workspace_id: "00000000-0000-0000-0000-000000000001",
            agent_id: "00000000-0000-0000-0000-000000000002",
            delivery_id: "delivery-1",
            payload,
            attempt_count: 0,
            provisioning_sandbox_id: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ deployed_by_user_id: "user-1", organization_id: "org-1" }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    mocks.buildTeamLaunchMemberOptions.mockImplementation(async (input: {
      onSandboxCreated?: (sandboxId: string) => Promise<void>;
    }) => {
      await input.onSandboxCreated?.("sbx-524");
      return { memberName: "cloud-team-issue-n1" };
    });
    mocks.dispatchTeamLaunchN1.mockImplementation(async (
      _input: unknown,
      deps: { buildLaunchOptions: (input: Record<string, unknown>) => Promise<unknown> },
    ) => {
      // The launcher created the box (persist callback fired), then the
      // member bootstrap exec timed out at the Daytona proxy.
      await deps.buildLaunchOptions({});
      throw new Error("Sandbox exec failed: HTTP 524 from proxy.app.daytona.io");
    });
    const { drainIntegrationWatchDeliveries } = await import("./integration-watch-deliveries");

    await expect(
      drainIntegrationWatchDeliveries({ limit: 1, allowTeamLaunchN1: true }),
    ).resolves.toEqual({
      attempted: 1,
      delivered: 1,
      failed: 0,
      pending: 0,
      terminal: 0,
    });

    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "Integration watch teamSolve launch ambiguous-success (proxy timeout after dispatch)",
      expect.objectContaining({
        diag: "launch-ambiguous-success",
        deliveryId: "delivery-1",
        sandboxId: "sbx-524",
      }),
    );
    expect(mocks.releaseIssueDispatchDedupe).not.toHaveBeenCalled();
    expect(mocks.releaseVfsWatchDedupe).not.toHaveBeenCalled();
  });

  it("keeps a Daytona proxy 524 retryable when no sandbox exists yet", async () => {
    const payload = {
      provider: "github",
      eventType: "issues.labeled",
      paths: ["/github/repos/AgentWorkforce/cloud/issues/123.json"],
      resource: { issue: { number: 123 }, repository: { full_name: "AgentWorkforce/cloud" } },
      teamLaunchN1: true,
    };
    mocks.dbExecute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "00000000-0000-0000-0000-000000000010",
            workspace_id: "00000000-0000-0000-0000-000000000001",
            agent_id: "00000000-0000-0000-0000-000000000002",
            delivery_id: "delivery-1",
            payload,
            attempt_count: 0,
            provisioning_sandbox_id: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ deployed_by_user_id: "user-1", organization_id: "org-1" }],
      })
      .mockResolvedValueOnce({ rows: [] });
    // No buildLaunchOptions call, no persist callback — the 524 happened
    // before any sandbox came into being (e.g. on the create call itself).
    mocks.dispatchTeamLaunchN1.mockRejectedValue(
      new Error("Sandbox create failed: HTTP 524 from proxy.app.daytona.io"),
    );
    const { drainIntegrationWatchDeliveries } = await import("./integration-watch-deliveries");

    const result = await drainIntegrationWatchDeliveries({ limit: 1, allowTeamLaunchN1: true });
    expect(result.delivered).toBe(0);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "Integration watch pending delivery failed",
      expect.objectContaining({ deliveryId: "delivery-1", terminal: false }),
    );
    expect(mocks.releaseIssueDispatchDedupe).not.toHaveBeenCalled();
  });

  it("clears the persisted provisioning id when the resumed sandbox no longer exists", async () => {
    const payload = {
      provider: "github",
      eventType: "issues.labeled",
      paths: ["/github/repos/AgentWorkforce/cloud/issues/123.json"],
      resource: { issue: { number: 123 }, repository: { full_name: "AgentWorkforce/cloud" } },
      teamLaunchN1: true,
    };
    mocks.dbExecute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "00000000-0000-0000-0000-000000000010",
            workspace_id: "00000000-0000-0000-0000-000000000001",
            agent_id: "00000000-0000-0000-0000-000000000002",
            delivery_id: "delivery-1",
            payload,
            attempt_count: 0,
            provisioning_sandbox_id: "sbx-reaped",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ deployed_by_user_id: "user-1", organization_id: "org-1" }],
      })
      .mockResolvedValueOnce({ rows: [] });
    const missingSandboxError = new Error("Workflow provisioning sandbox sbx-reaped was not found") as Error & {
      sandboxId: string;
    };
    missingSandboxError.name = "WorkflowSandboxResumeMissingError";
    missingSandboxError.sandboxId = "sbx-reaped";
    mocks.dispatchTeamLaunchN1.mockRejectedValue(missingSandboxError);
    const { drainIntegrationWatchDeliveries } = await import("./integration-watch-deliveries");

    const result = await drainIntegrationWatchDeliveries({ limit: 1, allowTeamLaunchN1: true });
    expect(result.delivered).toBe(0);

    // The mark-failed UPDATE must clear provisioning_sandbox_id (param true in
    // the CASE WHEN) so the next attempt provisions fresh instead of resuming
    // a dead id forever. Inspect the drizzle sql params of the final UPDATE.
    const failedUpdate = mocks.dbExecute.mock.calls[2]?.[0] as {
      queryChunks?: unknown[];
    };
    const chunkText = (failedUpdate?.queryChunks ?? [])
      .map((chunk) => {
        const record = chunk as { value?: unknown };
        if (Array.isArray(record?.value)) return record.value.join("");
        return "";
      })
      .join("");
    expect(chunkText).toContain("provisioning_sandbox_id = CASE");
    // Drizzle inlines params between text chunks: the element immediately
    // after the chunk ending "provisioning_sandbox_id = CASE\n WHEN " must be
    // the literal `true` (the clearProvisioningSandboxId flag).
    const chunks = (failedUpdate?.queryChunks ?? []) as Array<unknown>;
    const clearChunkIndex = chunks.findIndex((chunk) => {
      const record = chunk as { value?: unknown };
      return Array.isArray(record?.value) &&
        record.value.join("").includes("provisioning_sandbox_id = CASE");
    });
    expect(clearChunkIndex).toBeGreaterThan(-1);
    expect(chunks[clearChunkIndex + 1]).toBe(true);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "Integration watch pending delivery failed",
      expect.objectContaining({ deliveryId: "delivery-1" }),
    );
  });

  it("records a team-launch sandbox id as soon as the launcher creates it", async () => {
    const memberConfig = {
      memberName: "cloud-team-issue-n1",
      role: "implementer",
      personaSpec: {
        persona: {
          slug: "cloud-team-issue",
          harness: "claude",
          model: "claude-sonnet-4-6",
        },
        agent: {},
      },
    };
    const payload = {
      provider: "github",
      eventType: "issues.labeled",
      paths: ["/github/repos/AgentWorkforce/cloud/issues/123.json"],
      resource: { issue: { number: 123 }, repository: { full_name: "AgentWorkforce/cloud" } },
      teamLaunchN1: true,
    };
    mocks.readTeamRosterMemberConfigs.mockResolvedValueOnce([memberConfig]);
    let capturedBuildLaunchOptions: ((input: {
      workspaceId: string;
      agentId: string;
      deliveryId: string;
      payload: Record<string, unknown>;
      assignedRoot: string;
      localRoot: string;
    }) => Promise<unknown>) | undefined;
    mocks.dispatchTeamLaunchN1.mockImplementationOnce(async (_input, deps) => {
      capturedBuildLaunchOptions = deps.buildLaunchOptions;
      return {
        status: "launched",
        workspaceId: "00000000-0000-0000-0000-000000000001",
        agentId: "00000000-0000-0000-0000-000000000002",
        deliveryId: "delivery-1",
        memberName: "cloud-team-issue-n1",
        role: "implementer",
        channel: "team-launch-n1-agent",
        sandboxId: "sbx-created",
        assignedRoot: "/github/repos/AgentWorkforce/cloud/issues/123",
        localRoot: "/home/daytona/workspace/github/repos/AgentWorkforce/cloud/issues/123",
        writeScopes: ["relayfile:fs:write:/github/repos/AgentWorkforce/cloud/issues/123/*"],
      };
    });
    mocks.buildTeamLaunchMemberOptions.mockImplementationOnce(async (input) => {
      await input.onSandboxCreated("sbx-created");
      return { memberName: "cloud-team-issue-n1" };
    });
    mocks.dbExecute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "00000000-0000-0000-0000-000000000010",
            workspace_id: "00000000-0000-0000-0000-000000000001",
            agent_id: "00000000-0000-0000-0000-000000000002",
            delivery_id: "delivery-1",
            payload,
            attempt_count: 0,
            provisioning_sandbox_id: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ deployed_by_user_id: "user-1", organization_id: "org-1" }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const { drainIntegrationWatchDeliveries } = await import("./integration-watch-deliveries");

    await expect(drainIntegrationWatchDeliveries({ limit: 1, allowTeamLaunchN1: true })).resolves.toEqual({
      attempted: 1,
      delivered: 1,
      failed: 0,
      pending: 0,
      terminal: 0,
    });

    expect(capturedBuildLaunchOptions).toBeTypeOf("function");
    expect(mocks.readTeamRosterMemberConfigs).toHaveBeenCalledWith({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      leadAgentId: "00000000-0000-0000-0000-000000000002",
      memberName: null,
    });
    expect(mocks.buildTeamLaunchPayload).toHaveBeenCalledWith(expect.objectContaining({
      memberConfig,
    }));
    await capturedBuildLaunchOptions!({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      agentId: "00000000-0000-0000-0000-000000000002",
      deliveryId: "delivery-1",
      payload,
      assignedRoot: "/github/repos/AgentWorkforce/cloud/issues/123",
      localRoot: "/home/daytona/workspace/github/repos/AgentWorkforce/cloud/issues/123",
    });

    expect(mocks.buildTeamLaunchMemberOptions).toHaveBeenCalledWith(expect.objectContaining({
      memberConfig,
      onSandboxCreated: expect.any(Function),
      onProvisioningSandboxCreated: expect.any(Function),
    }));
    expect(mocks.dbExecute).toHaveBeenCalledTimes(4);
    expect(mocks.releaseIssueDispatchDedupe).not.toHaveBeenCalled();
    expect(mocks.releaseVfsWatchDedupe).not.toHaveBeenCalled();
  });

  function teamLaunchRowExecuteMocks(payloadOverride?: Record<string, unknown>) {
    const payload = payloadOverride ?? {
      provider: "github",
      eventType: "issues.labeled",
      paths: ["/github/repos/AgentWorkforce/cloud/issues/123.json"],
      resource: { issue: { number: 123 }, repository: { full_name: "AgentWorkforce/cloud" } },
      teamLaunchN1: true,
    };
    mocks.dbExecute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "00000000-0000-0000-0000-000000000010",
            workspace_id: "00000000-0000-0000-0000-000000000001",
            agent_id: "00000000-0000-0000-0000-000000000002",
            delivery_id: "delivery-1",
            payload,
            attempt_count: 0,
            provisioning_sandbox_id: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ deployed_by_user_id: "user-1", organization_id: "org-1", persona_spec: { persona: {}, agent: {} } }],
      })
      .mockResolvedValue({ rows: [] });
  }

  function executedSqlStrings(): string[] {
    return mocks.dbExecute.mock.calls.map((call) => {
      const chunks = (call[0]?.queryChunks ?? []) as Array<{ value?: unknown }>;
      return chunks
        .map((chunk) => (Array.isArray(chunk?.value) ? chunk.value.join("") : ""))
        .join(" ");
    });
  }

  it("launches every roster member up to maxMembers and records each member sandbox", async () => {
    const memberA = {
      memberId: "member-row-a",
      teamId: "team-1",
      sandboxId: null,
      memberName: "team-member-a",
      role: "implementer",
      personaSpec: { persona: {}, agent: {} },
    };
    const memberB = {
      memberId: "member-row-b",
      teamId: "team-1",
      sandboxId: null,
      memberName: "team-member-b",
      role: "reviewer",
      personaSpec: { persona: {}, agent: {} },
    };
    mocks.teamSolveMaxMembers.mockReturnValue(2);
    mocks.readTeamRosterMemberConfigs.mockResolvedValueOnce([memberA, memberB]);
    mocks.dispatchTeamLaunchN1
      .mockResolvedValueOnce({
        status: "launched",
        workspaceId: "00000000-0000-0000-0000-000000000001",
        agentId: "00000000-0000-0000-0000-000000000002",
        deliveryId: "delivery-1",
        memberName: "team-member-a",
        role: "implementer",
        channel: "team-launch-n1-agent",
        sandboxId: "sbx-a",
        assignedRoot: "/github/repos/AgentWorkforce/cloud/issues/123",
        localRoot: "/home/daytona/workspace/github/repos/AgentWorkforce/cloud/issues/123",
        writeScopes: ["relayfile:fs:write:/github/repos/AgentWorkforce/cloud/issues/123/*"],
      })
      .mockResolvedValueOnce({
        status: "launched",
        workspaceId: "00000000-0000-0000-0000-000000000001",
        agentId: "00000000-0000-0000-0000-000000000002",
        deliveryId: "delivery-1",
        memberName: "team-member-b",
        role: "reviewer",
        channel: "team-launch-n1-agent",
        sandboxId: "sbx-b",
        assignedRoot: "/github/repos/AgentWorkforce/cloud/issues/123",
        localRoot: "/home/daytona/workspace/github/repos/AgentWorkforce/cloud/issues/123",
        writeScopes: ["relayfile:fs:write:/github/repos/AgentWorkforce/cloud/issues/123/*"],
      });
    teamLaunchRowExecuteMocks();
    const { drainIntegrationWatchDeliveries } = await import("./integration-watch-deliveries");

    await expect(drainIntegrationWatchDeliveries({ limit: 1, allowTeamLaunchN1: true })).resolves.toEqual({
      attempted: 1,
      delivered: 1,
      failed: 0,
      pending: 0,
      terminal: 0,
    });

    expect(mocks.dispatchTeamLaunchN1).toHaveBeenCalledTimes(2);
    expect(mocks.buildTeamLaunchPayload).toHaveBeenNthCalledWith(1, expect.objectContaining({
      memberConfig: memberA,
    }));
    expect(mocks.buildTeamLaunchPayload).toHaveBeenNthCalledWith(2, expect.objectContaining({
      memberConfig: memberB,
    }));
    const memberUpdates = executedSqlStrings().filter((text) => text.includes("UPDATE team_members"));
    expect(memberUpdates).toHaveLength(2);
  });

  it("caps the roster at maxMembers and logs the dropped members", async () => {
    const memberA = {
      memberId: "member-row-a",
      teamId: "team-1",
      sandboxId: null,
      memberName: "team-member-a",
      role: "implementer",
      personaSpec: { persona: {}, agent: {} },
    };
    const memberB = {
      memberId: "member-row-b",
      teamId: "team-1",
      sandboxId: null,
      memberName: "team-member-b",
      role: "reviewer",
      personaSpec: { persona: {}, agent: {} },
    };
    mocks.teamSolveMaxMembers.mockReturnValue(1);
    mocks.readTeamRosterMemberConfigs.mockResolvedValueOnce([memberA, memberB]);
    teamLaunchRowExecuteMocks();
    const { drainIntegrationWatchDeliveries } = await import("./integration-watch-deliveries");

    await expect(drainIntegrationWatchDeliveries({ limit: 1, allowTeamLaunchN1: true })).resolves.toEqual({
      attempted: 1,
      delivered: 1,
      failed: 0,
      pending: 0,
      terminal: 0,
    });

    expect(mocks.dispatchTeamLaunchN1).toHaveBeenCalledTimes(1);
    expect(mocks.buildTeamLaunchPayload).toHaveBeenCalledWith(expect.objectContaining({
      memberConfig: memberA,
    }));
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "Integration watch teamSolve roster exceeds maxMembers; extra members not launched",
      expect.objectContaining({
        diag: "roster-capped",
        maxMembers: 1,
        rosterCount: 2,
        droppedMembers: ["team-member-b"],
      }),
    );
  });

  it("skips members whose sandbox is already recorded (idempotent drain retry)", async () => {
    const memberA = {
      memberId: "member-row-a",
      teamId: "team-1",
      sandboxId: "sbx-already-launched",
      memberName: "team-member-a",
      role: "implementer",
      personaSpec: { persona: {}, agent: {} },
    };
    const memberB = {
      memberId: "member-row-b",
      teamId: "team-1",
      sandboxId: null,
      memberName: "team-member-b",
      role: "reviewer",
      personaSpec: { persona: {}, agent: {} },
    };
    mocks.teamSolveMaxMembers.mockReturnValue(2);
    mocks.readTeamRosterMemberConfigs.mockResolvedValueOnce([memberA, memberB]);
    teamLaunchRowExecuteMocks();
    const { drainIntegrationWatchDeliveries } = await import("./integration-watch-deliveries");

    await expect(drainIntegrationWatchDeliveries({ limit: 1, allowTeamLaunchN1: true })).resolves.toEqual({
      attempted: 1,
      delivered: 1,
      failed: 0,
      pending: 0,
      terminal: 0,
    });

    // Only member B dispatches; member A's recorded sandbox short-circuits
    // the relaunch (the #1820 sibling-storm class for drain retries).
    expect(mocks.dispatchTeamLaunchN1).toHaveBeenCalledTimes(1);
    expect(mocks.buildTeamLaunchPayload).toHaveBeenCalledWith(expect.objectContaining({
      memberConfig: memberB,
    }));
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Integration watch teamSolve member already launched; skipping",
      expect.objectContaining({
        diag: "member-already-launched",
        memberName: "team-member-a",
        sandboxId: "sbx-already-launched",
      }),
    );
  });

  it("never offers an already-recorded member's row-level sandbox to the next member", async () => {
    // Crash window: a previous attempt recorded member A's sandbox on BOTH
    // team_members.sandbox_id AND the delivery row's provisioning_sandbox_id,
    // then died before the row was marked delivered. The retry must consume
    // the row-level orphan at A's skip — offering it to member B would resume
    // B into A's box and break per-member isolation (codex-6's #1893 finding).
    const memberA = {
      memberId: "member-row-a",
      teamId: "team-1",
      sandboxId: "sbx-a-orphan",
      memberName: "team-member-a",
      role: "implementer",
      personaSpec: { persona: {}, agent: {} },
    };
    const memberB = {
      memberId: "member-row-b",
      teamId: "team-1",
      sandboxId: null,
      memberName: "team-member-b",
      role: "reviewer",
      personaSpec: { persona: {}, agent: {} },
    };
    mocks.teamSolveMaxMembers.mockReturnValue(2);
    mocks.readTeamRosterMemberConfigs.mockResolvedValueOnce([memberA, memberB]);
    mocks.dbExecute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "00000000-0000-0000-0000-000000000010",
            workspace_id: "00000000-0000-0000-0000-000000000001",
            agent_id: "00000000-0000-0000-0000-000000000002",
            delivery_id: "delivery-1",
            payload: {
              provider: "github",
              eventType: "issues.labeled",
              paths: ["/github/repos/AgentWorkforce/cloud/issues/123.json"],
              resource: { issue: { number: 123 }, repository: { full_name: "AgentWorkforce/cloud" } },
              teamLaunchN1: true,
            },
            attempt_count: 1,
            // Row-level orphan equals member A's recorded sandbox.
            provisioning_sandbox_id: "sbx-a-orphan",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ deployed_by_user_id: "user-1", organization_id: "org-1", persona_spec: { persona: {}, agent: {} } }],
      })
      .mockResolvedValue({ rows: [] });
    const { drainIntegrationWatchDeliveries } = await import("./integration-watch-deliveries");

    await expect(drainIntegrationWatchDeliveries({ limit: 1, allowTeamLaunchN1: true })).resolves.toEqual({
      attempted: 1,
      delivered: 1,
      failed: 0,
      pending: 0,
      terminal: 0,
    });

    // Member A skipped; member B launched WITHOUT inheriting A's sandbox.
    expect(mocks.dispatchTeamLaunchN1).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchTeamLaunchN1).toHaveBeenCalledWith(
      expect.objectContaining({ provisioningSandboxId: undefined }),
      expect.anything(),
    );
    expect(mocks.buildTeamLaunchPayload).toHaveBeenCalledWith(expect.objectContaining({
      memberConfig: memberB,
    }));
  });

  it("still offers the row-level sandbox to the first UNRECORDED member (legitimate resume)", async () => {
    // Inverse pin: when the orphan does NOT match any recorded member, it
    // belongs to the member that was mid-launch when the previous attempt
    // died (launches are sequential in roster order) — resume must keep it.
    const memberA = {
      memberId: "member-row-a",
      teamId: "team-1",
      sandboxId: null,
      memberName: "team-member-a",
      role: "implementer",
      personaSpec: { persona: {}, agent: {} },
    };
    mocks.teamSolveMaxMembers.mockReturnValue(2);
    mocks.readTeamRosterMemberConfigs.mockResolvedValueOnce([memberA]);
    mocks.dbExecute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "00000000-0000-0000-0000-000000000010",
            workspace_id: "00000000-0000-0000-0000-000000000001",
            agent_id: "00000000-0000-0000-0000-000000000002",
            delivery_id: "delivery-1",
            payload: {
              provider: "github",
              eventType: "issues.labeled",
              paths: ["/github/repos/AgentWorkforce/cloud/issues/123.json"],
              resource: { issue: { number: 123 }, repository: { full_name: "AgentWorkforce/cloud" } },
              teamLaunchN1: true,
            },
            attempt_count: 1,
            provisioning_sandbox_id: "sbx-mid-launch",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ deployed_by_user_id: "user-1", organization_id: "org-1", persona_spec: { persona: {}, agent: {} } }],
      })
      .mockResolvedValue({ rows: [] });
    const { drainIntegrationWatchDeliveries } = await import("./integration-watch-deliveries");

    await expect(drainIntegrationWatchDeliveries({ limit: 1, allowTeamLaunchN1: true })).resolves.toEqual({
      attempted: 1,
      delivered: 1,
      failed: 0,
      pending: 0,
      terminal: 0,
    });

    expect(mocks.dispatchTeamLaunchN1).toHaveBeenCalledWith(
      expect.objectContaining({ provisioningSandboxId: "sbx-mid-launch" }),
      expect.anything(),
    );
  });

  it("keeps the delivery delivered when a later member fails after one launch (no retry storm)", async () => {
    const memberA = {
      memberId: "member-row-a",
      teamId: "team-1",
      sandboxId: null,
      memberName: "team-member-a",
      role: "implementer",
      personaSpec: { persona: {}, agent: {} },
    };
    const memberB = {
      memberId: "member-row-b",
      teamId: "team-1",
      sandboxId: null,
      memberName: "team-member-b",
      role: "reviewer",
      personaSpec: { persona: {}, agent: {} },
    };
    mocks.teamSolveMaxMembers.mockReturnValue(2);
    mocks.readTeamRosterMemberConfigs.mockResolvedValueOnce([memberA, memberB]);
    mocks.dispatchTeamLaunchN1
      .mockResolvedValueOnce({
        status: "launched",
        workspaceId: "00000000-0000-0000-0000-000000000001",
        agentId: "00000000-0000-0000-0000-000000000002",
        deliveryId: "delivery-1",
        memberName: "team-member-a",
        role: "implementer",
        channel: "team-launch-n1-agent",
        sandboxId: "sbx-a",
        assignedRoot: "/github/repos/AgentWorkforce/cloud/issues/123",
        localRoot: "/home/daytona/workspace/github/repos/AgentWorkforce/cloud/issues/123",
        writeScopes: ["relayfile:fs:write:/github/repos/AgentWorkforce/cloud/issues/123/*"],
      })
      .mockRejectedValueOnce(new Error("member B bootstrap exploded"));
    teamLaunchRowExecuteMocks();
    const { drainIntegrationWatchDeliveries } = await import("./integration-watch-deliveries");

    await expect(drainIntegrationWatchDeliveries({ limit: 1, allowTeamLaunchN1: true })).resolves.toEqual({
      attempted: 1,
      delivered: 1,
      failed: 0,
      pending: 0,
      terminal: 0,
    });

    expect(mocks.dispatchTeamLaunchN1).toHaveBeenCalledTimes(2);
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "Integration watch teamSolve member launch failed after partial success",
      expect.objectContaining({
        diag: "member-partial-failure",
        memberName: "team-member-b",
        launchedSoFar: 1,
      }),
    );
  });

  it("rethrows a first-member failure so the row stays retryable (zero launched)", async () => {
    const memberA = {
      memberId: "member-row-a",
      teamId: "team-1",
      sandboxId: null,
      memberName: "team-member-a",
      role: "implementer",
      personaSpec: { persona: {}, agent: {} },
    };
    mocks.teamSolveMaxMembers.mockReturnValue(2);
    mocks.readTeamRosterMemberConfigs.mockResolvedValueOnce([memberA]);
    mocks.dispatchTeamLaunchN1.mockRejectedValueOnce(new Error("first member launch failed"));
    teamLaunchRowExecuteMocks();
    const { drainIntegrationWatchDeliveries } = await import("./integration-watch-deliveries");

    await expect(drainIntegrationWatchDeliveries({ limit: 1, allowTeamLaunchN1: true })).resolves.toEqual({
      attempted: 1,
      delivered: 0,
      failed: 1,
      pending: 1,
      terminal: 0,
    });

    expect(mocks.loggerError).not.toHaveBeenCalled();
  });

  it("terminal-skips marked team-launch rows when the launch flag is off at drain time", async () => {
    mocks.dispatchTeamLaunchN1.mockResolvedValueOnce({
      status: "skipped",
      reason: "disabled",
      workspaceId: "00000000-0000-0000-0000-000000000001",
      agentId: "00000000-0000-0000-0000-000000000002",
      deliveryId: "delivery-1",
    });
    mocks.dbExecute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "00000000-0000-0000-0000-000000000010",
            workspace_id: "00000000-0000-0000-0000-000000000001",
            agent_id: "00000000-0000-0000-0000-000000000002",
            delivery_id: "delivery-1",
            payload: {
              provider: "github",
              eventType: "issues.labeled",
              paths: ["/github/repos/AgentWorkforce/cloud/issues/123.json"],
              resource: { issue: { number: 123 }, repository: { full_name: "AgentWorkforce/cloud" } },
              teamLaunchN1: true,
            },
            attempt_count: 0,
            provisioning_sandbox_id: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ deployed_by_user_id: "user-1", organization_id: "org-1" }],
      })
      .mockResolvedValueOnce({ rows: [] });
    const { drainIntegrationWatchDeliveries } = await import("./integration-watch-deliveries");

    await expect(drainIntegrationWatchDeliveries({ limit: 1, allowTeamLaunchN1: true })).resolves.toEqual({
      attempted: 1,
      delivered: 0,
      failed: 1,
      pending: 0,
      terminal: 1,
    });

    expect(mocks.releaseIssueDispatchDedupe).toHaveBeenCalledWith({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      agentId: "00000000-0000-0000-0000-000000000002",
      issueKey: "github:AgentWorkforce/cloud#123",
    });
    expect(mocks.releaseVfsWatchDedupe).toHaveBeenCalledWith({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      agentId: "00000000-0000-0000-0000-000000000002",
      writeId: "delivery-1",
    });
  });

  it("keeps generic team-launch build failures retryable with dedupe claims held", async () => {
    mocks.buildTeamLaunchPayload.mockRejectedValueOnce(new Error("relayauth timeout"));
    mocks.dbExecute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "00000000-0000-0000-0000-000000000010",
            workspace_id: "00000000-0000-0000-0000-000000000001",
            agent_id: "00000000-0000-0000-0000-000000000002",
            delivery_id: "delivery-1",
            payload: {
              provider: "github",
              eventType: "issues.labeled",
              paths: ["/github/repos/AgentWorkforce/cloud/issues/123.json"],
              resource: { issue: { number: 123 }, repository: { full_name: "AgentWorkforce/cloud" } },
              teamLaunchN1: true,
            },
            attempt_count: 0,
            provisioning_sandbox_id: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ deployed_by_user_id: "user-1", organization_id: "org-1" }],
      })
      .mockResolvedValueOnce({ rows: [] });
    const { drainIntegrationWatchDeliveries } = await import("./integration-watch-deliveries");

    await expect(drainIntegrationWatchDeliveries({ limit: 1, allowTeamLaunchN1: true, maxAttempts: 3 }))
      .resolves.toEqual({
        attempted: 1,
        delivered: 0,
        failed: 1,
        pending: 1,
        terminal: 0,
      });

    expect(mocks.releaseIssueDispatchDedupe).not.toHaveBeenCalled();
    expect(mocks.releaseVfsWatchDedupe).not.toHaveBeenCalled();
    expect(mocks.dispatchTeamLaunchN1).not.toHaveBeenCalled();
  });

  it("terminal-skips team-launch option-unavailable failures and releases dedupe claims", async () => {
    const { TeamLaunchOptionsUnavailableError } = await import("./team-launch-n1");
    mocks.buildTeamLaunchPayload.mockRejectedValueOnce(
      new TeamLaunchOptionsUnavailableError("RelayFile workspace binding not found"),
    );
    mocks.dbExecute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "00000000-0000-0000-0000-000000000010",
            workspace_id: "00000000-0000-0000-0000-000000000001",
            agent_id: "00000000-0000-0000-0000-000000000002",
            delivery_id: "delivery-1",
            payload: {
              provider: "github",
              eventType: "issues.labeled",
              paths: ["/github/repos/AgentWorkforce/cloud/issues/123.json"],
              resource: { issue: { number: 123 }, repository: { full_name: "AgentWorkforce/cloud" } },
              teamLaunchN1: true,
            },
            attempt_count: 0,
            provisioning_sandbox_id: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ deployed_by_user_id: "user-1", organization_id: "org-1" }],
      })
      .mockResolvedValueOnce({ rows: [] });
    const { drainIntegrationWatchDeliveries } = await import("./integration-watch-deliveries");

    await expect(drainIntegrationWatchDeliveries({ limit: 1, allowTeamLaunchN1: true })).resolves.toEqual({
      attempted: 1,
      delivered: 0,
      failed: 1,
      pending: 0,
      terminal: 1,
    });

    expect(mocks.releaseIssueDispatchDedupe).toHaveBeenCalled();
    expect(mocks.releaseVfsWatchDedupe).toHaveBeenCalled();
    expect(mocks.dispatchTeamLaunchN1).not.toHaveBeenCalled();
  });

  it("leaves failed deliveries pending with backoff until max attempts", async () => {
    mocks.deliverDeploymentTrigger.mockRejectedValueOnce(new Error("proxy.app.daytona.io | 524"));
    mocks.dbExecute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "00000000-0000-0000-0000-000000000010",
            workspace_id: "00000000-0000-0000-0000-000000000001",
            agent_id: "00000000-0000-0000-0000-000000000002",
            delivery_id: "delivery-1",
            payload: { type: "github.issues.opened" },
            attempt_count: 0,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const { drainIntegrationWatchDeliveries } = await import("./integration-watch-deliveries");

    await expect(drainIntegrationWatchDeliveries({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      agentId: "00000000-0000-0000-0000-000000000002",
      limit: 1,
      maxAttempts: 3,
      deliveryOptions: {
        sandboxCreateTimeoutSeconds: 120,
        runScriptTimeoutMs: 15_000,
        asyncRunScript: true,
      },
    })).resolves.toMatchObject({
      attempted: 1,
      delivered: 0,
      failed: 1,
      pending: 1,
      terminal: 0,
    });

    expect(mocks.deliverDeploymentTrigger).toHaveBeenCalledWith({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      agentId: "00000000-0000-0000-0000-000000000002",
      deliveryId: "delivery-1",
      payload: { type: "github.issues.opened" },
      options: {
        sandboxCreateTimeoutSeconds: 120,
        runScriptTimeoutMs: 15_000,
        asyncRunScript: true,
      },
    });
    expect(mocks.dbExecute).toHaveBeenCalledTimes(2);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "Integration watch pending delivery failed",
      expect.objectContaining({
        area: "integration-watch-delivery",
        deliveryId: "delivery-1",
        terminal: false,
      }),
    );
  });

  it("persists a provisioning sandbox id without consuming an attempt", async () => {
    const {
      DeploymentSandboxProvisioningPendingError,
    } = await import("./deployment-trigger-delivery");
    mocks.deliverDeploymentTrigger.mockRejectedValueOnce(
      new DeploymentSandboxProvisioningPendingError("sbx-starting", "starting"),
    );
    mocks.dbExecute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "00000000-0000-0000-0000-000000000010",
            workspace_id: "00000000-0000-0000-0000-000000000001",
            agent_id: "00000000-0000-0000-0000-000000000002",
            delivery_id: "delivery-1",
            payload: { type: "github.issues.opened" },
            attempt_count: 0,
            provisioning_sandbox_id: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const { drainIntegrationWatchDeliveries } = await import("./integration-watch-deliveries");

    await expect(drainIntegrationWatchDeliveries({
      limit: 1,
    })).resolves.toEqual({
      attempted: 1,
      delivered: 0,
      failed: 1,
      pending: 1,
      terminal: 0,
    });

    expect(mocks.deliverDeploymentTrigger).toHaveBeenCalledWith({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      agentId: "00000000-0000-0000-0000-000000000002",
      deliveryId: "delivery-1",
      payload: { type: "github.issues.opened" },
      options: undefined,
    });
    expect(mocks.dbExecute).toHaveBeenCalledTimes(2);
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Integration watch delivery sandbox still provisioning",
      expect.objectContaining({
        sandboxId: "sbx-starting",
        deliveryId: "delivery-1",
      }),
    );
  });

  it("passes a persisted provisioning sandbox id into the next drain attempt", async () => {
    mocks.dbExecute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "00000000-0000-0000-0000-000000000010",
            workspace_id: "00000000-0000-0000-0000-000000000001",
            agent_id: "00000000-0000-0000-0000-000000000002",
            delivery_id: "delivery-1",
            payload: { type: "github.issues.opened" },
            attempt_count: 0,
            provisioning_sandbox_id: "sbx-starting",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const { drainIntegrationWatchDeliveries } = await import("./integration-watch-deliveries");

    await drainIntegrationWatchDeliveries({ limit: 1 });

    expect(mocks.deliverDeploymentTrigger).toHaveBeenCalledWith({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      agentId: "00000000-0000-0000-0000-000000000002",
      deliveryId: "delivery-1",
      payload: { type: "github.issues.opened" },
      options: undefined,
      provisioningSandboxId: "sbx-starting",
    });
  });

  it("persists an async sandbox run without consuming an attempt", async () => {
    const {
      DeploymentTriggerRunPendingError,
    } = await import("./deployment-trigger-delivery");
    mocks.deliverDeploymentTrigger.mockRejectedValueOnce(
      new DeploymentTriggerRunPendingError({
        deploymentId: "deployment-async",
        sandboxId: "sbx-warm",
        sessionId: "tick-deployment-async",
        commandId: "cmd-123",
        startedAt: "2026-05-26T20:55:00.000Z",
        sandboxName: "cloud-small-issue-codex-abcd1234",
        mountConfigured: true,
      }),
    );
    mocks.dbExecute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "00000000-0000-0000-0000-000000000010",
            workspace_id: "00000000-0000-0000-0000-000000000001",
            agent_id: "00000000-0000-0000-0000-000000000002",
            delivery_id: "delivery-1",
            payload: { type: "github.issues.opened" },
            attempt_count: 0,
            provisioning_sandbox_id: null,
            run_deployment_id: null,
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
    const { drainIntegrationWatchDeliveries } = await import("./integration-watch-deliveries");

    await expect(drainIntegrationWatchDeliveries({ limit: 1 })).resolves.toEqual({
      attempted: 1,
      delivered: 0,
      failed: 1,
      pending: 1,
      terminal: 0,
    });

    expect(mocks.deliverDeploymentTrigger).toHaveBeenCalledWith({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      agentId: "00000000-0000-0000-0000-000000000002",
      deliveryId: "delivery-1",
      payload: { type: "github.issues.opened" },
      options: undefined,
    });
    expect(mocks.pollDeploymentTriggerRun).not.toHaveBeenCalled();
    expect(mocks.dbExecute).toHaveBeenCalledTimes(2);
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Integration watch delivery run still running",
      expect.objectContaining({
        sandboxId: "sbx-warm",
        commandId: "cmd-123",
        deliveryId: "delivery-1",
      }),
    );
  });

  it("polls a persisted async sandbox run instead of starting a new delivery", async () => {
    mocks.dbExecute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "00000000-0000-0000-0000-000000000010",
            workspace_id: "00000000-0000-0000-0000-000000000001",
            agent_id: "00000000-0000-0000-0000-000000000002",
            delivery_id: "delivery-1",
            payload: { type: "github.issues.opened" },
            attempt_count: 0,
            provisioning_sandbox_id: null,
            run_deployment_id: "deployment-async",
            run_sandbox_id: "sbx-warm",
            run_session_id: "tick-deployment-async",
            run_command_id: "cmd-123",
            run_started_at: "2026-05-26T20:55:00.000Z",
            run_sandbox_name: "cloud-small-issue-codex-abcd1234",
            run_mount_configured: true,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const { drainIntegrationWatchDeliveries } = await import("./integration-watch-deliveries");

    await expect(drainIntegrationWatchDeliveries({ limit: 1 })).resolves.toEqual({
      attempted: 1,
      delivered: 1,
      failed: 0,
      pending: 0,
      terminal: 0,
    });

    expect(mocks.deliverDeploymentTrigger).not.toHaveBeenCalled();
    expect(mocks.pollDeploymentTriggerRun).toHaveBeenCalledWith({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      agentId: "00000000-0000-0000-0000-000000000002",
      deliveryId: "delivery-1",
      payload: { type: "github.issues.opened" },
      deploymentId: "deployment-async",
      sandboxId: "sbx-warm",
      sessionId: "tick-deployment-async",
      commandId: "cmd-123",
      startedAt: "2026-05-26T20:55:00.000Z",
      sandboxName: "cloud-small-issue-codex-abcd1234",
      mountConfigured: true,
      options: undefined,
    });
  });
});
