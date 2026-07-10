import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  getDb: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: mocks.getDb,
}));

import {
  drainPrSandboxWarmPool,
  reapStoppedSandboxes,
} from "./deployment-sandbox-recycle";
import type { DeploymentSandboxRuntime } from "./sandbox-runtime";

const NO_RELEASED_REAP = {
  releasedFound: 0,
  releasedDeleted: 0,
  releasedFailed: [],
  releasedSkippedActiveRun: 0,
};

const NO_CONVERSATION_REAP = {
  conversationIdleFound: 0,
  conversationIdleStopped: 0,
  conversationCleanupFound: 0,
  conversationCleanupDestroyed: 0,
  conversationCleanupReleased: 0,
  conversationCleanupFailed: [],
  conversationCleanupSkippedActiveRun: 0,
};

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
    destroy: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getDb.mockReturnValue({ execute: mocks.execute });
  mocks.execute.mockResolvedValue({ rowCount: 0, rows: [] });
});

describe("drainPrSandboxWarmPool", () => {
  it("destroys every STARTED warm-pool box and returns the counts", async () => {
    const runtime = runtimeMock();
    const handles = [
      { id: "sbx-1", state: "STARTED" },
      { id: "sbx-2", state: "STARTED" },
      { id: "sbx-3", state: "STARTED" },
    ];
    vi.mocked(runtime.findAllByLabels).mockResolvedValue(handles);
    vi.mocked(runtime.destroy).mockResolvedValue(undefined);
    mocks.execute.mockResolvedValue({ rowCount: 3, rows: [] });

    const result = await drainPrSandboxWarmPool({ runtime });

    expect(runtime.findAllByLabels).toHaveBeenCalledWith(
      { purpose: "workforce-deploy", warmLease: "pull-request" },
      expect.objectContaining({ states: ["STARTED"], owned: true }),
    );
    expect(runtime.destroy).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      found: 3,
      deleted: 3,
      failed: [],
      leasesCleared: 3,
    });
  });

  it("reports failed destroys without aborting the drain", async () => {
    const runtime = runtimeMock();
    vi.mocked(runtime.findAllByLabels).mockResolvedValue([
      { id: "sbx-ok", state: "STARTED" },
      { id: "sbx-bad", state: "STARTED" },
    ]);
    vi.mocked(runtime.destroy).mockImplementation((handle) =>
      handle.id === "sbx-bad"
        ? Promise.reject(new Error("destroy failed"))
        : Promise.resolve(),
    );
    mocks.execute.mockResolvedValue({ rowCount: 1, rows: [] });

    const result = await drainPrSandboxWarmPool({ runtime });

    expect(result.found).toBe(2);
    expect(result.deleted).toBe(1);
    expect(result.failed).toEqual(["sbx-bad"]);
  });

  it("uses bulk drain concurrency for the release warm-pool endpoint", async () => {
    const runtime = runtimeMock();
    vi.mocked(runtime.findAllByLabels).mockResolvedValue(
      Array.from({ length: 55 }, (_, index) => ({
        id: `sbx-${index}`,
        state: "STARTED",
      })),
    );
    const destroyResolvers: Array<() => void> = [];
    vi.mocked(runtime.destroy).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          destroyResolvers.push(resolve);
        }),
    );

    const pending = drainPrSandboxWarmPool({ runtime });
    await new Promise((resolve) => setImmediate(resolve));

    expect(runtime.destroy).toHaveBeenCalledTimes(50);
    destroyResolvers.splice(0).forEach((resolve) => resolve());
    await new Promise((resolve) => setImmediate(resolve));

    expect(runtime.destroy).toHaveBeenCalledTimes(55);
    destroyResolvers.splice(0).forEach((resolve) => resolve());
    await expect(pending).resolves.toMatchObject({ found: 55, deleted: 55 });
  });

  it("skips lease cleanup when clearLeases is false", async () => {
    const runtime = runtimeMock();
    vi.mocked(runtime.findAllByLabels).mockResolvedValue([
      { id: "sbx-1", state: "STARTED" },
    ]);
    vi.mocked(runtime.destroy).mockResolvedValue(undefined);

    const result = await drainPrSandboxWarmPool({
      runtime,
      clearLeases: false,
    });

    expect(mocks.execute).not.toHaveBeenCalled();
    expect(result).toEqual({
      found: 1,
      deleted: 1,
      failed: [],
      leasesCleared: 0,
    });
  });

  it("counts cleaned lease rows from drivers that return rows instead of rowCount", async () => {
    const runtime = runtimeMock();
    vi.mocked(runtime.findAllByLabels).mockResolvedValue([
      { id: "sbx-1", state: "STARTED" },
    ]);
    vi.mocked(runtime.destroy).mockResolvedValue(undefined);
    mocks.execute.mockResolvedValue({ rows: [{ id: "lease-1" }] });

    const result = await drainPrSandboxWarmPool({ runtime });

    expect(result.leasesCleared).toBe(1);
  });

  it("is a no-op when the warm pool is empty", async () => {
    const runtime = runtimeMock();
    vi.mocked(runtime.findAllByLabels).mockResolvedValue([]);

    const result = await drainPrSandboxWarmPool({ runtime });

    expect(runtime.destroy).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(result).toEqual({
      found: 0,
      deleted: 0,
      failed: [],
      leasesCleared: 0,
    });
  });

  it("treats a lease-cleanup failure as non-fatal", async () => {
    const runtime = runtimeMock();
    vi.mocked(runtime.findAllByLabels).mockResolvedValue([
      { id: "sbx-1", state: "STARTED" },
    ]);
    vi.mocked(runtime.destroy).mockResolvedValue(undefined);
    mocks.execute.mockRejectedValue(new Error("db down"));

    const result = await drainPrSandboxWarmPool({ runtime });

    expect(result).toEqual({
      found: 1,
      deleted: 1,
      failed: [],
      leasesCleared: 0,
    });
  });
});

describe("reapStoppedSandboxes", () => {
  const now = new Date("2026-05-31T12:00:00.000Z");

  it("destroys only old STOPPED proactive boxes and preserves STARTED or young boxes", async () => {
    const runtime = runtimeMock();
    vi.mocked(runtime.findAllByLabels).mockResolvedValue([
      {
        id: "sbx-old",
        state: "STOPPED",
        createdAt: "2026-05-31T06:00:00.000Z",
      },
      {
        id: "sbx-young",
        state: "STOPPED",
        createdAt: "2026-05-31T11:00:00.000Z",
      },
      {
        id: "sbx-started",
        state: "STARTED",
        createdAt: "2026-05-31T01:00:00.000Z",
      },
      {
        id: "sbx-running",
        state: "RUNNING",
        createdAt: "2026-05-31T01:00:00.000Z",
      },
      {
        id: "sbx-destroying",
        state: "DESTROYING",
        createdAt: "2026-05-31T01:00:00.000Z",
      },
    ]);
    vi.mocked(runtime.destroy).mockResolvedValue(undefined);
    mocks.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const result = await reapStoppedSandboxes({ runtime, now, minAgeHours: 4 });

    expect(runtime.findAllByLabels).toHaveBeenCalledWith(
      { purpose: "workforce-deploy" },
      expect.objectContaining({
        states: ["STOPPED"],
        pageSize: 100,
        owned: true,
      }),
    );
    expect(runtime.destroy).toHaveBeenCalledTimes(1);
    expect(runtime.destroy).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sbx-old", state: "STOPPED" }),
    );
    expect(result).toEqual({
      found: 2,
      eligible: 1,
      deleted: 1,
      failed: [],
      skippedTooYoung: 1,
      skippedMissingCreatedAt: 0,
      skippedActiveLease: 0,
      ...NO_RELEASED_REAP,
      ...NO_CONVERSATION_REAP,
      leasesCleared: 1,
    });
  });

  it("skips stopped boxes still protected by active PR leases", async () => {
    const runtime = runtimeMock();
    vi.mocked(runtime.findAllByLabels).mockResolvedValue([
      {
        id: "sbx-leased",
        state: "STOPPED",
        createdAt: "2026-05-31T06:00:00.000Z",
      },
      {
        id: "sbx-free",
        state: "STOPPED",
        createdAt: "2026-05-31T06:00:00.000Z",
      },
    ]);
    vi.mocked(runtime.destroy).mockResolvedValue(undefined);
    mocks.execute
      .mockResolvedValueOnce({ rows: [{ sandbox_id: "sbx-leased" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const result = await reapStoppedSandboxes({ runtime, now, minAgeHours: 4 });

    expect(runtime.destroy).toHaveBeenCalledTimes(1);
    expect(runtime.destroy).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sbx-free" }),
    );
    expect(result.skippedActiveLease).toBe(1);
    expect(result.deleted).toBe(1);
    expect(result).toMatchObject(NO_RELEASED_REAP);
  });

  it("reports failed destroys without aborting the reaper", async () => {
    const runtime = runtimeMock();
    vi.mocked(runtime.findAllByLabels).mockResolvedValue([
      { id: "sbx-ok", state: "STOPPED", createdAt: "2026-05-31T06:00:00.000Z" },
      {
        id: "sbx-bad",
        state: "STOPPED",
        createdAt: "2026-05-31T06:00:00.000Z",
      },
    ]);
    vi.mocked(runtime.destroy).mockImplementation((handle) =>
      handle.id === "sbx-bad"
        ? Promise.reject(new Error("destroy failed"))
        : Promise.resolve(),
    );
    mocks.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const result = await reapStoppedSandboxes({ runtime, now, minAgeHours: 4 });

    expect(result.deleted).toBe(1);
    expect(result.failed).toEqual(["sbx-bad"]);
    expect(result.leasesCleared).toBe(1);
    expect(result).toMatchObject(NO_RELEASED_REAP);
  });

  it("uses bounded destroy concurrency", async () => {
    const runtime = runtimeMock();
    vi.mocked(runtime.findAllByLabels).mockResolvedValue(
      Array.from({ length: 12 }, (_, index) => ({
        id: `sbx-${index}`,
        state: "STOPPED",
        createdAt: "2026-05-31T06:00:00.000Z",
      })),
    );
    mocks.execute.mockResolvedValue({ rows: [] });
    const destroyResolvers: Array<() => void> = [];
    vi.mocked(runtime.destroy).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          destroyResolvers.push(resolve);
        }),
    );

    const pending = reapStoppedSandboxes({ runtime, now, minAgeHours: 4 });
    await new Promise((resolve) => setImmediate(resolve));

    expect(runtime.destroy).toHaveBeenCalledTimes(10);
    destroyResolvers.splice(0).forEach((resolve) => resolve());
    await new Promise((resolve) => setImmediate(resolve));

    expect(runtime.destroy).toHaveBeenCalledTimes(12);
    destroyResolvers.splice(0).forEach((resolve) => resolve());
    await expect(pending).resolves.toMatchObject({
      found: 12,
      eligible: 12,
      deleted: 12,
      ...NO_RELEASED_REAP,
    });
  });

  it("reaps beyond a single Daytona page with no total cap", async () => {
    const runtime = runtimeMock();
    const handles = Array.from({ length: 105 }, (_, index) => ({
      id: `sbx-${index}`,
      state: "STOPPED",
      createdAt: "2026-05-31T06:00:00.000Z",
    }));
    vi.mocked(runtime.findAllByLabels).mockResolvedValue(handles);
    vi.mocked(runtime.destroy).mockResolvedValue(undefined);
    mocks.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 105, rows: [] });

    const result = await reapStoppedSandboxes({ runtime, now, minAgeHours: 4 });

    expect(runtime.findAllByLabels).toHaveBeenCalledWith(
      { purpose: "workforce-deploy" },
      expect.objectContaining({
        states: ["STOPPED"],
        pageSize: 100,
        owned: true,
      }),
    );
    expect(runtime.destroy).toHaveBeenCalledTimes(105);
    expect(result).toMatchObject({
      found: 105,
      eligible: 105,
      deleted: 105,
      failed: [],
      ...NO_RELEASED_REAP,
      leasesCleared: 105,
    });
  });

  it("skips stopped boxes without a parseable creation timestamp", async () => {
    const runtime = runtimeMock();
    vi.mocked(runtime.findAllByLabels).mockResolvedValue([
      { id: "sbx-missing", state: "STOPPED" },
      { id: "sbx-invalid", state: "STOPPED", createdAt: "not-a-date" },
    ]);

    const result = await reapStoppedSandboxes({ runtime, now, minAgeHours: 4 });

    expect(runtime.destroy).not.toHaveBeenCalled();
    expect(mocks.execute).toHaveBeenCalledTimes(4);
    expect(result).toEqual({
      found: 2,
      eligible: 0,
      deleted: 0,
      failed: [],
      skippedTooYoung: 0,
      skippedMissingCreatedAt: 2,
      skippedActiveLease: 0,
      ...NO_RELEASED_REAP,
      ...NO_CONVERSATION_REAP,
      leasesCleared: 0,
    });
  });

  it("destroys released PR lease sandboxes once no active delivery references them", async () => {
    const runtime = runtimeMock();
    vi.mocked(runtime.findAllByLabels).mockResolvedValue([]);
    vi.mocked(runtime.getById!).mockResolvedValue({
      id: "sbx-released",
      state: "STARTED",
      createdAt: "2026-05-31T06:00:00.000Z",
    });
    vi.mocked(runtime.destroy).mockResolvedValue(undefined);
    mocks.execute
      .mockResolvedValueOnce({ rows: [{ id: "lease-released", sandbox_id: "sbx-released", active_delivery: false }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const result = await reapStoppedSandboxes({ runtime, now, minAgeHours: 4 });

    expect(runtime.getById).toHaveBeenCalledWith("sbx-released", {
      states: null,
      owned: true,
    });
    expect(runtime.destroy).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sbx-released" }),
    );
    expect(result).toEqual({
      found: 0,
      eligible: 0,
      deleted: 0,
      failed: [],
      skippedTooYoung: 0,
      skippedMissingCreatedAt: 0,
      skippedActiveLease: 0,
      releasedFound: 1,
      releasedDeleted: 1,
      releasedFailed: [],
      releasedSkippedActiveRun: 0,
      ...NO_CONVERSATION_REAP,
      leasesCleared: 1,
    });
  });

  it("keeps released PR lease sandboxes while an active delivery still references them", async () => {
    const runtime = runtimeMock();
    vi.mocked(runtime.findAllByLabels).mockResolvedValue([]);
    mocks.execute.mockResolvedValueOnce({
      rows: [{ id: "lease-active", sandbox_id: "sbx-active-run", active_delivery: true }],
    });

    const result = await reapStoppedSandboxes({ runtime, now, minAgeHours: 4 });

    expect(runtime.getById).not.toHaveBeenCalled();
    expect(runtime.destroy).not.toHaveBeenCalled();
    expect(result).toEqual({
      found: 0,
      eligible: 0,
      deleted: 0,
      failed: [],
      skippedTooYoung: 0,
      skippedMissingCreatedAt: 0,
      skippedActiveLease: 0,
      releasedFound: 1,
      releasedDeleted: 0,
      releasedFailed: [],
      releasedSkippedActiveRun: 1,
      ...NO_CONVERSATION_REAP,
      leasesCleared: 0,
    });
  });
});
