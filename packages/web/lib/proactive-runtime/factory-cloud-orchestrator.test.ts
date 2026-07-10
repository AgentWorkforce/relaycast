import { describe, expect, it, vi } from "vitest";
import {
  dispatchFactoryBrainDelivery,
  ingestFactoryInvocationCompletion,
  isFactoryIssuePayload,
  markFactoryBrainPayload,
} from "@/lib/proactive-runtime/factory-cloud-orchestrator";
import type {
  FactoryInFlightRecord,
  FactoryStateStore,
} from "@/lib/proactive-runtime/factory-state-store-do";
import type {
  FactoryFleetEmitter,
  FactorySpawnInput,
} from "@/lib/proactive-runtime/factory-fleet-emitter";

const mocks = vi.hoisted(() => ({
  dbInsert: vi.fn(),
  dbSelect: vi.fn(),
  loggerInfo: vi.fn(),
  inserts: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    insert: mocks.dbInsert,
    select: mocks.dbSelect,
  }),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

class MemoryState implements FactoryStateStore {
  readonly inFlight = new Map<string, FactoryInFlightRecord>();

  async getInFlight(workspaceId: string, issueId: string): Promise<FactoryInFlightRecord | null> {
    return this.inFlight.get(`${workspaceId}:${issueId}`) ?? null;
  }

  async putInFlight(record: FactoryInFlightRecord): Promise<void> {
    this.inFlight.set(`${record.workspaceId}:${record.issueId}`, record);
  }

  async deleteInFlight(workspaceId: string, issueId: string): Promise<void> {
    this.inFlight.delete(`${workspaceId}:${issueId}`);
  }

  async listInFlight(workspaceId: string): Promise<FactoryInFlightRecord[]> {
    return [...this.inFlight.values()].filter((record) => record.workspaceId === workspaceId);
  }

  async getWaitingClarification(): Promise<null> {
    return null;
  }

  async putWaitingClarification(): Promise<void> {}

  async deleteWaitingClarification(): Promise<void> {}
}

class RecordingFleet implements FactoryFleetEmitter {
  readonly spawns: FactorySpawnInput[] = [];

  async spawn(input: FactorySpawnInput): Promise<{ name: string; invocationId: string }> {
    this.spawns.push(input);
    return { name: input.name, invocationId: input.invocationId };
  }
}

function factoryPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return markFactoryBrainPayload({
    provider: "linear",
    eventType: "issues.updated",
    paths: ["/linear/issues/AR-267__issue-1.json"],
    resource: {
      id: "issue-1",
      identifier: "AR-267",
      title: "[factory] Implement cloud lift",
      description: "Lift the factory brain into the cloud worker.",
      labels: ["factory", "agent:team", "cloud", "relayfile"],
      state: { name: "Ready for Agent" },
      ...overrides,
    },
  });
}

function mockDbInsertChain(): void {
  mocks.inserts = [];
  mocks.dbInsert.mockReturnValue({
    values: vi.fn((values: Record<string, unknown>) => {
      mocks.inserts.push(values);
      return {
        onConflictDoNothing: vi.fn(async () => undefined),
      };
    }),
  });
  mocks.dbSelect.mockReturnValue({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => []),
      })),
    })),
  });
}

describe("factory cloud orchestrator", () => {
  it("recognizes [factory] Linear issue payloads", () => {
    expect(isFactoryIssuePayload(factoryPayload())).toBe(true);
    expect(isFactoryIssuePayload(factoryPayload({ title: "normal issue", labels: ["cloud"] }))).toBe(false);
  });

  it("expands agent:team into one implementer per repo label plus reviewer and stores invocation ids", async () => {
    mockDbInsertChain();
    const fleet = new RecordingFleet();
    const stateStore = new MemoryState();

    const result = await dispatchFactoryBrainDelivery({
      workspaceId: "workspace-a",
      agentId: "agent-a",
      deliveryId: "delivery-a",
      payload: factoryPayload(),
      deployedByUserId: "user-a",
    }, {
      fleet,
      stateStore,
      now: () => new Date("2026-06-16T12:00:00.000Z"),
    });

    expect(result).toMatchObject({ issueKey: "AR-267", recipe: "team", emitted: 3 });
    expect(fleet.spawns.map((spawn) => [spawn.capability, spawn.persona, spawn.repo])).toEqual([
      ["spawn:claude", "cloud-team-implementer", "AgentWorkforce/cloud"],
      ["spawn:claude", "cloud-team-implementer", "AgentWorkforce/relayfile"],
      ["spawn:claude", "cloud-team-reviewer", "AgentWorkforce/cloud"],
    ]);
    await expect(stateStore.getInFlight("workspace-a", "issue-1")).resolves.toMatchObject({
      workspaceId: "workspace-a",
      issueKey: "AR-267",
      recipe: "team",
      spawns: [
        { status: "dispatched", invocationId: "factory:workspace-a:AR-267:implementer:cloud" },
        { status: "dispatched", invocationId: "factory:workspace-a:AR-267:implementer:relayfile" },
        { status: "dispatched", invocationId: "factory:workspace-a:AR-267:reviewer:review" },
      ],
    });
  });

  it("defaults to spawn:claude when no harness label is present", async () => {
    mockDbInsertChain();
    const fleet = new RecordingFleet();
    const stateStore = new MemoryState();

    await dispatchFactoryBrainDelivery({
      workspaceId: "workspace-h",
      agentId: "agent-h",
      deliveryId: "delivery-h",
      payload: factoryPayload({ id: "issue-h", identifier: "AR-300", labels: ["factory", "agent:single", "cloud"] }),
    }, { fleet, stateStore });

    expect(fleet.spawns.map((spawn) => spawn.capability)).toEqual(["spawn:claude"]);
  });

  it("selects the harness from a harness:<cli> Linear label", async () => {
    mockDbInsertChain();
    const fleet = new RecordingFleet();
    const stateStore = new MemoryState();

    await dispatchFactoryBrainDelivery({
      workspaceId: "workspace-g",
      agentId: "agent-g",
      deliveryId: "delivery-g",
      payload: factoryPayload({
        id: "issue-g",
        identifier: "AR-301",
        labels: ["factory", "agent:team", "harness:opencode", "cloud", "relayfile"],
      }),
    }, { fleet, stateStore });

    expect(fleet.spawns.map((spawn) => spawn.capability)).toEqual([
      "spawn:opencode",
      "spawn:opencode",
      "spawn:opencode",
    ]);
  });

  it("falls back to spawn:claude for an unknown harness label", async () => {
    mockDbInsertChain();
    const fleet = new RecordingFleet();
    const stateStore = new MemoryState();

    await dispatchFactoryBrainDelivery({
      workspaceId: "workspace-u",
      agentId: "agent-u",
      deliveryId: "delivery-u",
      payload: factoryPayload({ id: "issue-u", identifier: "AR-302", labels: ["factory", "agent:single", "harness:bogus", "cloud"] }),
    }, { fleet, stateStore });

    expect(fleet.spawns.map((spawn) => spawn.capability)).toEqual(["spawn:claude"]);
  });

  it("keeps StateStore records partitioned by workspaceId", async () => {
    mockDbInsertChain();
    const stateStore = new MemoryState();
    const fleet = new RecordingFleet();

    await dispatchFactoryBrainDelivery({
      workspaceId: "workspace-a",
      agentId: "agent-a",
      deliveryId: "delivery-a",
      payload: factoryPayload({ id: "shared-issue", identifier: "AR-1", labels: ["factory", "agent:single", "cloud"] }),
      deployedByUserId: "user-a",
    }, { fleet, stateStore });
    await dispatchFactoryBrainDelivery({
      workspaceId: "workspace-b",
      agentId: "agent-b",
      deliveryId: "delivery-b",
      payload: factoryPayload({ id: "shared-issue", identifier: "AR-1", labels: ["factory", "agent:single", "relayfile"] }),
      deployedByUserId: "user-b",
    }, { fleet, stateStore });

    await expect(stateStore.listInFlight("workspace-a")).resolves.toHaveLength(1);
    await expect(stateStore.listInFlight("workspace-b")).resolves.toHaveLength(1);
    expect((await stateStore.getInFlight("workspace-a", "shared-issue"))?.spawns[0]?.repo).toBe("AgentWorkforce/cloud");
    expect((await stateStore.getInFlight("workspace-b", "shared-issue"))?.spawns[0]?.repo).toBe("AgentWorkforce/relayfile");
  });

  it("re-emits identical deterministic invocationIds on re-delivery (fleet dedupe key)", async () => {
    // Finding #5: a drain retry re-runs the whole emit set. The invocationIds
    // MUST be stable so the fleet collapses the duplicate spawns instead of
    // double-spawning.
    mockDbInsertChain();
    const fleet = new RecordingFleet();
    const stateStore = new MemoryState();
    const input = {
      workspaceId: "workspace-a",
      agentId: "agent-a",
      deliveryId: "delivery-a",
      payload: factoryPayload(),
      deployedByUserId: "user-a",
    } as const;

    const first = await dispatchFactoryBrainDelivery(input, { fleet, stateStore });
    const second = await dispatchFactoryBrainDelivery(input, { fleet, stateStore });

    expect(second.invocationIds).toEqual(first.invocationIds);
    expect(first.invocationIds).toEqual([
      "factory:workspace-a:AR-267:implementer:cloud",
      "factory:workspace-a:AR-267:implementer:relayfile",
      "factory:workspace-a:AR-267:reviewer:review",
    ]);
  });

  it("uses a deterministic, issue-scoped team id so duplicate deliveries collapse (no team accrual)", async () => {
    // Finding #4: two factory-candidate agents matching the same [factory]
    // issue each run recordTeamRecipeMetadata; a random team id would accrue a
    // duplicate teams row per match. The id is now derived from workspace+issue.
    mockDbInsertChain();
    const fleet = new RecordingFleet();
    const stateStore = new MemoryState();

    await dispatchFactoryBrainDelivery({
      workspaceId: "workspace-a",
      agentId: "agent-a",
      deliveryId: "delivery-a",
      payload: factoryPayload(),
      deployedByUserId: "user-a",
    }, { fleet, stateStore });
    const firstTeamRows = mocks.inserts.filter((row) => typeof row.sharedMountRoot === "string");

    await dispatchFactoryBrainDelivery({
      workspaceId: "workspace-a",
      agentId: "agent-b",
      deliveryId: "delivery-b",
      payload: factoryPayload(),
      deployedByUserId: "user-b",
    }, { fleet, stateStore });
    const allTeamRows = mocks.inserts.filter((row) => typeof row.sharedMountRoot === "string");

    expect(firstTeamRows).toHaveLength(1);
    expect(firstTeamRows[0]?.id).toBe("factory_team_workspace-a_ar-267");
    // Both deliveries produced the SAME deterministic team id → onConflictDoNothing collapses them.
    expect(allTeamRows.every((row) => row.id === "factory_team_workspace-a_ar-267")).toBe(true);
  });

  it("ingests invocation completions by invocationId, then runs merge gate and writebacks when all spawns are terminal", async () => {
    mockDbInsertChain();
    const fleet = new RecordingFleet();
    const stateStore = new MemoryState();
    const postLinear = vi.fn(async () => undefined);
    const postSlack = vi.fn(async () => undefined);

    await dispatchFactoryBrainDelivery({
      workspaceId: "workspace-a",
      agentId: "agent-a",
      deliveryId: "delivery-a",
      payload: factoryPayload(),
      deployedByUserId: "user-a",
    }, {
      fleet,
      stateStore,
      now: () => new Date("2026-06-16T12:00:00.000Z"),
    });

    const first = await ingestFactoryInvocationCompletion({
      workspaceId: "workspace-a",
      invocationId: "factory:workspace-a:AR-267:implementer:cloud",
      status: "completed",
      output: "cloud done",
    }, {
      stateStore,
      now: () => new Date("2026-06-16T12:10:00.000Z"),
      writeback: { postLinear, postSlack },
    });

    expect(first.status).toBe("updated");
    expect(postLinear).not.toHaveBeenCalled();
    expect(postSlack).not.toHaveBeenCalled();

    await ingestFactoryInvocationCompletion({
      workspaceId: "workspace-a",
      invocationId: "factory:workspace-a:AR-267:implementer:relayfile",
      status: "completed",
    }, {
      stateStore,
      now: () => new Date("2026-06-16T12:11:00.000Z"),
      writeback: { postLinear, postSlack },
    });
    const terminal = await ingestFactoryInvocationCompletion({
      workspaceId: "workspace-a",
      invocationId: "factory:workspace-a:AR-267:reviewer:review",
      status: "completed",
    }, {
      stateStore,
      now: () => new Date("2026-06-16T12:12:00.000Z"),
      writeback: { postLinear, postSlack },
    });

    expect(terminal).toMatchObject({
      status: "all_terminal",
      issueKey: "AR-267",
      mergeGate: { status: "ready" },
      linearWriteback: { status: "posted" },
      slackWriteback: { status: "posted" },
    });
    expect(postLinear).toHaveBeenCalledTimes(1);
    expect(postLinear).toHaveBeenCalledWith(expect.objectContaining({
      record: expect.objectContaining({ issueKey: "AR-267" }),
      message: expect.stringContaining("Merge gate: ready"),
    }));
    expect(postSlack).toHaveBeenCalledTimes(1);
    await expect(stateStore.getInFlight("workspace-a", "issue-1")).resolves.toMatchObject({
      completedAt: "2026-06-16T12:12:00.000Z",
      mergeGate: { status: "ready" },
      spawns: [
        { status: "completed", output: "cloud done" },
        { status: "completed" },
        { status: "completed" },
      ],
    });
  });

  it("blocks the merge gate and records writeback failure when a terminal spawn fails", async () => {
    mockDbInsertChain();
    const fleet = new RecordingFleet();
    const stateStore = new MemoryState();
    const postLinear = vi.fn(async () => {
      throw new Error("linear unavailable");
    });

    await dispatchFactoryBrainDelivery({
      workspaceId: "workspace-a",
      agentId: "agent-a",
      deliveryId: "delivery-a",
      payload: factoryPayload({ labels: ["factory", "agent:single", "cloud"] }),
      deployedByUserId: "user-a",
    }, { fleet, stateStore });

    const result = await ingestFactoryInvocationCompletion({
      workspaceId: "workspace-a",
      invocationId: "factory:workspace-a:AR-267:implementer:cloud",
      status: "failed",
      error: "tests failed",
    }, {
      stateStore,
      now: () => new Date("2026-06-16T12:12:00.000Z"),
      writeback: { postLinear },
    });

    expect(result).toMatchObject({
      status: "all_terminal",
      mergeGate: { status: "blocked" },
      linearWriteback: { status: "failed", error: "linear unavailable" },
    });
    await expect(stateStore.getInFlight("workspace-a", "issue-1")).resolves.toMatchObject({
      mergeGate: { status: "blocked" },
      spawns: [{ status: "failed", error: "tests failed" }],
      linearWriteback: { status: "failed" },
    });
  });
});
