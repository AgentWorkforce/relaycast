import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  getDb: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: mocks.getDb,
}));

import {
  acquirePrSandbox,
  buildPrSandboxName,
  createDaytonaPrSandboxSlotAdmission,
  currentActiveSandboxCount,
  prSandboxLeaseKey,
  prSandboxLabels,
  releasePrSandboxSlot,
} from "./pr-sandbox-lease";
import type { DeploymentSandboxRuntime } from "./sandbox-runtime";

function runtimeMock(): DeploymentSandboxRuntime {
  return {
    id: "daytona",
    findByLabels: vi.fn(),
    findAllByLabels: vi.fn(),
    getById: vi.fn(),
    launch: vi.fn(),
    launchDetached: vi.fn(),
    uploadBundle: vi.fn(),
    runScript: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    destroy: vi.fn(),
  };
}

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks.map((chunk) => {
    if (typeof chunk === "string") {
      return "?";
    }
    const value = (chunk as { value?: unknown }).value;
    return Array.isArray(value) ? value.join("") : "?";
  }).join("");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getDb.mockReturnValue({ execute: mocks.execute });
  mocks.execute.mockResolvedValue({ rows: [] });
});

describe("acquirePrSandbox", () => {
  const key = {
    workspaceId: "workspace-12345678",
    agentId: "agent-87654321",
    repoFullName: "AgentWorkforce/cloud",
    prNumber: 1449,
  };
  const now = new Date("2026-05-29T09:00:00.000Z");

  it("warm-reuses an existing lease when its sandbox is still started", async () => {
    const runtime = runtimeMock();
    const leasedHandle = {
      id: "sbx-existing",
      state: "STARTED",
      name: "existing-pr-sandbox",
    };
    mocks.execute.mockResolvedValueOnce({
      rows: [{
        id: "lease-1",
        workspace_id: key.workspaceId,
        agent_id: key.agentId,
        repo_full_name: key.repoFullName,
        pr_number: key.prNumber,
        sandbox_id: leasedHandle.id,
        sandbox_name: leasedHandle.name,
        state: "warm",
        lease_until: null,
        last_used_at: now,
        attempt_count: 1,
        current_step: "sandbox-ready",
        snapshot_version: "snapshot-v1",
      }],
    }).mockResolvedValue({ rows: [] });
    vi.mocked(runtime.getById!).mockResolvedValue(leasedHandle);
    const createSandbox = vi.fn();

    const result = await acquirePrSandbox({
      ...key,
      runtime,
      leaseTtlSeconds: 900,
      snapshotVersion: "snapshot-v1",
      createSandbox,
      now,
    });

    expect(result).toEqual({
      handle: leasedHandle,
      sandboxName: leasedHandle.name,
      reused: true,
    });
    expect(runtime.getById).toHaveBeenCalledWith("sbx-existing", {
      states: null,
      owned: true,
    });
    expect(createSandbox).not.toHaveBeenCalled();
    expect(
      mocks.execute.mock.calls
        .map((call) => sqlText(call[0]))
        .some((query) => query.includes("UPDATE pr_sandbox_leases")),
    ).toBe(true);
  });

  it("does NOT reuse a warm lease whose snapshot differs from the current snapshot; provisions fresh", async () => {
    const runtime = runtimeMock();
    const leasedHandle = {
      id: "sbx-stale",
      state: "STARTED",
      name: "stale-pr-sandbox",
    };
    // A lease recorded under the OLD snapshot — the box is still STARTED, so the
    // pre-version-aware code would have reused it (running the old binary).
    mocks.execute.mockResolvedValueOnce({
      rows: [{
        id: "lease-stale",
        workspace_id: key.workspaceId,
        agent_id: key.agentId,
        repo_full_name: key.repoFullName,
        pr_number: key.prNumber,
        sandbox_id: leasedHandle.id,
        sandbox_name: leasedHandle.name,
        state: "warm",
        lease_until: null,
        last_used_at: now,
        attempt_count: 3,
        current_step: "sandbox-ready",
        snapshot_version: "snapshot-OLD",
      }],
    }).mockResolvedValue({ rows: [] });
    vi.mocked(runtime.getById!).mockResolvedValue(leasedHandle);
    const createdHandle = {
      id: "sbx-fresh",
      state: "STARTED",
      name: buildPrSandboxName(key),
    };
    const createSandbox = vi.fn().mockResolvedValue(createdHandle);

    const result = await acquirePrSandbox({
      ...key,
      runtime,
      leaseTtlSeconds: 900,
      snapshotVersion: "snapshot-NEW",
      createSandbox,
      now,
    });

    expect(result).toEqual({
      handle: createdHandle,
      sandboxName: buildPrSandboxName(key),
      reused: false,
    });
    // The stale box must NOT have been adopted; it is destroyed before creating
    // the replacement so Daytona does not reject the deterministic sandbox name.
    expect(runtime.getById).toHaveBeenCalledWith("sbx-stale", {
      states: null,
      owned: true,
    });
    expect(runtime.destroy).toHaveBeenCalledWith(leasedHandle);
    expect(createSandbox).toHaveBeenCalledTimes(1);
    // The fresh provision records the CURRENT snapshot so the next fire reuses it.
    const insert = sqlText(mocks.execute.mock.calls.at(-1)?.[0]);
    expect(insert).toContain("INSERT INTO pr_sandbox_leases");
    expect(insert).toContain("snapshot_version");
  });

  it("treats a legacy NULL snapshot_version as a mismatch and re-provisions once", async () => {
    const runtime = runtimeMock();
    const leasedHandle = { id: "sbx-legacy", state: "STARTED", name: "legacy-pr-sandbox" };
    mocks.execute.mockResolvedValueOnce({
      rows: [{
        id: "lease-legacy",
        workspace_id: key.workspaceId,
        agent_id: key.agentId,
        repo_full_name: key.repoFullName,
        pr_number: key.prNumber,
        sandbox_id: leasedHandle.id,
        sandbox_name: leasedHandle.name,
        state: "warm",
        lease_until: null,
        last_used_at: now,
        attempt_count: 1,
        current_step: "sandbox-ready",
        snapshot_version: null,
      }],
    }).mockResolvedValue({ rows: [] });
    vi.mocked(runtime.getById!).mockResolvedValue(leasedHandle);
    const createSandbox = vi.fn().mockResolvedValue({
      id: "sbx-fresh",
      state: "STARTED",
      name: buildPrSandboxName(key),
    });

    const result = await acquirePrSandbox({
      ...key,
      runtime,
      leaseTtlSeconds: 900,
      snapshotVersion: "snapshot-NEW",
      createSandbox,
      now,
    });

    expect(result.reused).toBe(false);
    expect(runtime.getById).toHaveBeenCalledWith("sbx-legacy", {
      states: null,
      owned: true,
    });
    expect(runtime.destroy).toHaveBeenCalledWith(leasedHandle);
    expect(createSandbox).toHaveBeenCalledTimes(1);
  });

  it("creates and records a PR-keyed sandbox when no started lease exists", async () => {
    const runtime = runtimeMock();
    vi.mocked(runtime.findAllByLabels).mockResolvedValue([]);
    const createdHandle = {
      id: "sbx-created",
      state: "STARTED",
      name: buildPrSandboxName(key),
    };
    const createSandbox = vi.fn().mockResolvedValue(createdHandle);

    const result = await acquirePrSandbox({
      ...key,
      runtime,
      leaseTtlSeconds: 900,
      snapshotVersion: "snapshot-v1",
      createSandbox,
      now,
    });

    expect(result).toEqual({
      handle: createdHandle,
      sandboxName: buildPrSandboxName(key),
      reused: false,
    });
    expect(createSandbox).toHaveBeenCalledWith({
      sandboxName: buildPrSandboxName(key),
      labels: {
        ...prSandboxLabels(key),
        sandboxName: buildPrSandboxName(key),
      },
    });
    expect(sqlText(mocks.execute.mock.calls.at(-1)?.[0])).toContain("INSERT INTO pr_sandbox_leases");
  });

  it("restarts a stopped idle lease instead of creating a colliding sandbox name", async () => {
    const runtime = runtimeMock();
    vi.mocked(runtime.findAllByLabels).mockResolvedValue([]);
    const stoppedHandle = {
      id: "sbx-stopped",
      state: "STOPPED",
      name: "stopped-pr-sandbox",
    };
    const startedHandle = {
      ...stoppedHandle,
      state: "STARTED",
    };
    mocks.execute.mockResolvedValueOnce({
      rows: [{
        id: "lease-stopped",
        workspace_id: key.workspaceId,
        agent_id: key.agentId,
        repo_full_name: key.repoFullName,
        pr_number: key.prNumber,
        sandbox_id: stoppedHandle.id,
        sandbox_name: stoppedHandle.name,
        state: "idle",
        lease_until: null,
        last_used_at: now,
        attempt_count: 1,
        current_step: "idle-stopped",
        snapshot_version: "snapshot-v1",
      }],
    }).mockResolvedValue({ rows: [] });
    vi.mocked(runtime.getById!).mockResolvedValue(stoppedHandle);
    vi.mocked(runtime.start!).mockResolvedValue(startedHandle);
    const createSandbox = vi.fn();

    const result = await acquirePrSandbox({
      ...key,
      runtime,
      leaseTtlSeconds: 900,
      snapshotVersion: "snapshot-v1",
      createSandbox,
      now,
    });

    expect(result).toEqual({
      handle: startedHandle,
      sandboxName: stoppedHandle.name,
      reused: true,
    });
    expect(runtime.start).toHaveBeenCalledWith(stoppedHandle);
    expect(runtime.findAllByLabels).toHaveBeenCalledWith(
      { purpose: "workforce-deploy" },
      { states: ["STARTED"], limit: 11, owned: true },
    );
    expect(createSandbox).not.toHaveBeenCalled();
  });

  it("invokes the active sandbox cap seam before creating a new sandbox", async () => {
    const runtime = runtimeMock();
    const slotAdmission = {
      acquirePrSandboxSlot: vi.fn().mockResolvedValue({ granted: true, retryAfterMs: null }),
      releasePrSandboxSlot: vi.fn().mockResolvedValue(undefined),
      currentActiveCount: vi.fn().mockResolvedValue(3),
    };
    const createSandbox = vi.fn().mockResolvedValue({
      id: "sbx-created",
      state: "STARTED",
      name: buildPrSandboxName(key),
    });

    await acquirePrSandbox({
      ...key,
      runtime,
      leaseTtlSeconds: 900,
      activeSandboxLimit: 7,
      slotAdmission,
      snapshotVersion: "snapshot-v1",
      createSandbox,
      now,
    });

    expect(slotAdmission.acquirePrSandboxSlot).toHaveBeenCalledWith(
      prSandboxLeaseKey(key),
      { ttlMs: 900_000, poolId: "daytona-sandbox:global", cap: 7 },
    );
    expect(createSandbox).toHaveBeenCalled();
  });

  it("idle-stops expired warm leases before provisioning", async () => {
    const runtime = runtimeMock();
    vi.mocked(runtime.findAllByLabels).mockResolvedValue([]);
    const idleHandle = {
      id: "sbx-idle",
      state: "STARTED",
      name: "idle-pr-sandbox",
    };
    mocks.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: "lease-idle",
          workspace_id: "workspace-old",
          agent_id: "agent-old",
          repo_full_name: "AgentWorkforce/old",
          pr_number: 12,
          sandbox_id: idleHandle.id,
          sandbox_name: idleHandle.name,
          state: "warm",
          lease_until: new Date("2026-05-29T08:00:00.000Z"),
          last_used_at: new Date("2026-05-29T08:00:00.000Z"),
          attempt_count: 1,
          current_step: "sandbox-ready",
          snapshot_version: "snapshot-v1",
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValue({ rows: [] });
    vi.mocked(runtime.getById!).mockResolvedValue(idleHandle);
    const createSandbox = vi.fn().mockResolvedValue({
      id: "sbx-created",
      state: "STARTED",
      name: buildPrSandboxName(key),
    });

    await acquirePrSandbox({
      ...key,
      runtime,
      leaseTtlSeconds: 900,
      idleTtlSeconds: 300,
      snapshotVersion: "snapshot-v1",
      createSandbox,
      now,
    });

    expect(runtime.stop).toHaveBeenCalledWith(idleHandle);
    expect(sqlText(mocks.execute.mock.calls[3]?.[0])).toContain("state = ?");
    expect(sqlText(mocks.execute.mock.calls[3]?.[0])).toContain("lease_until = NULL");
    expect(createSandbox).toHaveBeenCalledTimes(1);
  });

  it("evicts the least recently used warm lease instead of creating over cap", async () => {
    const runtime = runtimeMock();
    const evictedHandle = {
      id: "sbx-evicted",
      state: "STARTED",
      name: "evicted-pr-sandbox",
    };
    const evictedKey = {
      workspaceId: "workspace-old",
      agentId: "agent-old",
      repoFullName: "AgentWorkforce/old",
      prNumber: 11,
    };
    mocks.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: "lease-evict",
          workspace_id: evictedKey.workspaceId,
          agent_id: evictedKey.agentId,
          repo_full_name: evictedKey.repoFullName,
          pr_number: evictedKey.prNumber,
          sandbox_id: evictedHandle.id,
          sandbox_name: evictedHandle.name,
          state: "warm",
          lease_until: new Date("2026-05-29T09:10:00.000Z"),
          last_used_at: new Date("2026-05-28T09:00:00.000Z"),
          attempt_count: 1,
          current_step: "sandbox-ready",
          snapshot_version: "snapshot-v1",
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValue({ rows: [] });
    vi.mocked(runtime.getById!).mockResolvedValue(evictedHandle);
    const slotAdmission = {
      acquirePrSandboxSlot: vi.fn()
        .mockResolvedValueOnce({ granted: false, retryAfterMs: 900_000 })
        .mockResolvedValueOnce({ granted: true, retryAfterMs: null }),
      releasePrSandboxSlot: vi.fn().mockResolvedValue(undefined),
      currentActiveCount: vi.fn().mockResolvedValue(10),
    };
    const createSandbox = vi.fn().mockResolvedValue({
      id: "sbx-created",
      state: "STARTED",
      name: buildPrSandboxName(key),
    });

    const result = await acquirePrSandbox({
      ...key,
      runtime,
      leaseTtlSeconds: 900,
      activeSandboxLimit: 10,
      slotAdmission,
      snapshotVersion: "snapshot-v1",
      createSandbox,
      now,
    });

    expect(result.reused).toBe(false);
    expect(runtime.stop).toHaveBeenCalledWith(evictedHandle);
    expect(slotAdmission.releasePrSandboxSlot).toHaveBeenCalledWith(prSandboxLeaseKey(evictedKey));
    expect(slotAdmission.acquirePrSandboxSlot).toHaveBeenCalledTimes(2);
    expect(slotAdmission.acquirePrSandboxSlot).toHaveBeenLastCalledWith(
      prSandboxLeaseKey(key),
      { ttlMs: 900_000, poolId: "daytona-sandbox:global", cap: 10 },
    );
    expect(createSandbox).toHaveBeenCalledTimes(1);
    expect(sqlText(mocks.execute.mock.calls[4]?.[0])).toContain("UPDATE pr_sandbox_leases");
  });

  it("releases and deletes a PR sandbox lease on close", async () => {
    const runtime = runtimeMock();
    const leasedHandle = {
      id: "sbx-close",
      state: "STARTED",
      name: "close-pr-sandbox",
    };
    mocks.execute
      .mockResolvedValueOnce({
        rows: [{
          id: "lease-close",
          workspace_id: key.workspaceId,
          agent_id: key.agentId,
          repo_full_name: key.repoFullName,
          pr_number: key.prNumber,
          sandbox_id: leasedHandle.id,
          sandbox_name: leasedHandle.name,
          state: "warm",
          lease_until: null,
          last_used_at: now,
          attempt_count: 1,
          current_step: "sandbox-ready",
          snapshot_version: "snapshot-v1",
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValue({ rows: [] });
    vi.mocked(runtime.getById!).mockResolvedValue(leasedHandle);

    await expect(
      releasePrSandboxSlot({ runtime, key, now }),
    ).resolves.toEqual({
      released: true,
      destroyed: true,
      skippedActiveRun: false,
      sandboxId: leasedHandle.id,
    });

    expect(runtime.destroy).toHaveBeenCalledWith(leasedHandle);
    expect(sqlText(mocks.execute.mock.calls[2]?.[0])).toContain("UPDATE pr_sandbox_leases");
  });

  it("marks a close release without deleting when the sandbox is still used by an active run", async () => {
    const runtime = runtimeMock();
    mocks.execute
      .mockResolvedValueOnce({
        rows: [{
          id: "lease-active",
          workspace_id: key.workspaceId,
          agent_id: key.agentId,
          repo_full_name: key.repoFullName,
          pr_number: key.prNumber,
          sandbox_id: "sbx-active",
          sandbox_name: "active-pr-sandbox",
          state: "warm",
          lease_until: null,
          last_used_at: now,
          attempt_count: 1,
          current_step: "sandbox-ready",
          snapshot_version: "snapshot-v1",
        }],
      })
      .mockResolvedValueOnce({ rows: [{ exists: 1 }] })
      .mockResolvedValue({ rows: [] });

    await expect(
      releasePrSandboxSlot({ runtime, key, now }),
    ).resolves.toEqual({
      released: true,
      destroyed: false,
      skippedActiveRun: true,
      sandboxId: "sbx-active",
    });

    expect(runtime.destroy).not.toHaveBeenCalled();
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(sqlText(mocks.execute.mock.calls[2]?.[0])).toContain("UPDATE pr_sandbox_leases");
  });

  it("defaults active sandbox counting to a global workforce-deploy best-effort query", async () => {
    const runtime = runtimeMock();
    vi.mocked(runtime.findAllByLabels).mockResolvedValue([
      { id: "sbx-1", state: "STARTED" },
      { id: "sbx-2", state: "STARTED" },
    ]);

    await expect(
      currentActiveSandboxCount({
        runtime,
        poolId: "daytona-sandbox:global",
        limit: 1,
      }),
    ).resolves.toBe(2);

    expect(runtime.findAllByLabels).toHaveBeenCalledWith(
      { purpose: "workforce-deploy" },
      { states: ["STARTED"], limit: 2, owned: true },
    );
  });

  it("makes interim slot admission re-entrant by lease key before counting Daytona sandboxes", async () => {
    const runtime = runtimeMock();
    const slotAdmission = createDaytonaPrSandboxSlotAdmission({
      runtime,
      isReentrant: (leaseKey) => leaseKey === prSandboxLeaseKey(key),
    });

    await expect(slotAdmission.acquirePrSandboxSlot(prSandboxLeaseKey(key), {
      ttlMs: 900_000,
      poolId: "daytona-sandbox:global",
      cap: 1,
    })).resolves.toEqual({ granted: true, retryAfterMs: null });

    expect(runtime.findAllByLabels).not.toHaveBeenCalled();
  });

  it("reports a denied interim slot when the active Daytona sandbox count reaches the cap", async () => {
    const runtime = runtimeMock();
    vi.mocked(runtime.findAllByLabels).mockResolvedValue([{ id: "sbx-1", state: "STARTED" }]);
    const slotAdmission = createDaytonaPrSandboxSlotAdmission({ runtime });

    await expect(slotAdmission.acquirePrSandboxSlot(prSandboxLeaseKey(key), {
      ttlMs: 30_000,
      poolId: "daytona-sandbox:global",
      cap: 1,
    })).resolves.toEqual({ granted: false, retryAfterMs: 30_000 });

    expect(runtime.findAllByLabels).toHaveBeenCalledWith(
      { purpose: "workforce-deploy" },
      { states: ["STARTED"], limit: 2, owned: true },
    );
  });

  it("keeps interim slot release idempotent", async () => {
    const runtime = runtimeMock();
    const slotAdmission = createDaytonaPrSandboxSlotAdmission({ runtime });

    await expect(slotAdmission.releasePrSandboxSlot(prSandboxLeaseKey(key))).resolves.toBeUndefined();
    await expect(slotAdmission.releasePrSandboxSlot(prSandboxLeaseKey(key))).resolves.toBeUndefined();
  });
});
