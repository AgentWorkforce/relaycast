import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  getDb: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: mocks.getDb,
}));

import {
  acquireConversationSandbox,
  buildSlackConversationKey,
  ConversationSandboxLeaseBusyError,
  conversationSandboxLabels,
  createDaytonaConversationSandboxSlotAdmission,
  currentActiveConversationSandboxCount,
  markConversationSandboxLeaseAvailable,
  reapConversationSandboxLeases,
} from "./conversation-sandbox-lease";
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
    if (!chunk || typeof chunk !== "object") {
      return "?";
    }
    const value = (chunk as { value?: unknown }).value;
    return Array.isArray(value) ? value.join("") : "?";
  }).join("");
}

const uuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const now = new Date("2026-06-08T12:00:00.000Z");
const key = {
  workspaceId: "workspace-a",
  deploymentId: "deployment-12345678",
  agentId: "agent-87654321",
  conversationKey: buildSlackConversationKey({
    channel: "C123",
    threadTs: "1770000000.000100",
  }),
};

function leaseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "lease-1",
    workspace_id: key.workspaceId,
    deployment_id: key.deploymentId,
    agent_id: key.agentId,
    conversation_key: key.conversationKey,
    harness_session_id: "2f7d4d0a-0ccf-4e07-8ca2-7bd52ae19f5d",
    sandbox_id: "sbx-existing",
    sandbox_name: "conv-existing",
    state: "warm",
    lease_until: null,
    last_used_at: now,
    attempt_count: 1,
    current_step: "sandbox-ready",
    snapshot_version: "snapshot-v1",
    ...overrides,
  };
}

function installDefaultExecuteMock() {
  let claimCount = 0;
  mocks.execute.mockImplementation(async (query: unknown) => {
    const text = sqlText(query);
    if (text.includes("INSERT INTO conversation_sandbox_leases")) {
      claimCount += 1;
      return {
        rows: [leaseRow({
          id: `lease-claim-${claimCount}`,
          sandbox_id: null,
          sandbox_name: `conv-claimed-${claimCount}`,
          state: "warming",
          harness_session_id: `8b2d5a84-9a22-4e02-8e0b-3d8de624a98${claimCount}`,
        })],
      };
    }
    if (text.includes("UPDATE conversation_sandbox_leases")) {
      return { rowCount: 1, rows: [] };
    }
    return { rows: [] };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getDb.mockReturnValue({ execute: mocks.execute });
  installDefaultExecuteMock();
});

describe("acquireConversationSandbox", () => {
  it("creates a conversation-keyed box with a UUID harness session id, then reuses the same session id", async () => {
    const runtime = runtimeMock();
    const createdHandle = { id: "sbx-created", state: "STARTED", name: "conv-created" };
    const createSandbox = vi.fn().mockResolvedValue(createdHandle);

    installDefaultExecuteMock();

    const first = await acquireConversationSandbox({
      ...key,
      runtime,
      leaseTtlSeconds: 900,
      snapshotVersion: "snapshot-v1",
      createSandbox,
      now,
    });

    expect(first.reused).toBe(false);
    expect(first.handle).toBe(createdHandle);
    expect(first.harnessSessionId).toMatch(uuidV4Pattern);
    expect(createSandbox).toHaveBeenCalledWith({
      sandboxName: expect.stringMatching(/^conv-workspac-agent876-deployme-/u),
      labels: {
        ...conversationSandboxLabels(key),
        deploymentId: key.deploymentId,
        sandboxName: expect.stringMatching(/^conv-workspac-agent876-deployme-/u),
      },
    });
    expect(mocks.execute.mock.calls.some((call) =>
      sqlText(call[0]).includes("INSERT INTO conversation_sandbox_leases"),
    )).toBe(true);

    const reusedHandle = { id: "sbx-created", state: "STARTED", name: first.sandboxName };
    mocks.execute.mockReset();
    mocks.execute
      .mockResolvedValueOnce({
        rows: [leaseRow({
          sandbox_id: reusedHandle.id,
          sandbox_name: first.sandboxName,
          harness_session_id: first.harnessSessionId,
        })],
      })
      .mockImplementation(async (query: unknown) => {
        const text = sqlText(query);
        if (text.includes("INSERT INTO conversation_sandbox_leases")) {
          return { rows: [leaseRow({ id: "lease-claim-stale", state: "warming", sandbox_id: null })] };
        }
        if (text.includes("UPDATE conversation_sandbox_leases")) {
          return { rowCount: 1, rows: [] };
        }
        return { rows: [] };
      });
    vi.mocked(runtime.getById!).mockResolvedValue(reusedHandle);
    createSandbox.mockClear();

    const second = await acquireConversationSandbox({
      ...key,
      runtime,
      leaseTtlSeconds: 900,
      snapshotVersion: "snapshot-v1",
      createSandbox,
      now,
    });

    expect(second).toEqual({
      handle: reusedHandle,
      sandboxName: first.sandboxName,
      harnessSessionId: first.harnessSessionId,
      reused: true,
    });
    expect(createSandbox).not.toHaveBeenCalled();
    expect(sqlText(mocks.execute.mock.calls.at(-1)?.[0])).toContain("UPDATE conversation_sandbox_leases");
  });

  it("uses a different sandbox for a different conversation key", async () => {
    const runtime = runtimeMock();
    const createSandbox = vi.fn()
      .mockResolvedValueOnce({ id: "sbx-one", state: "STARTED", name: "conv-one" })
      .mockResolvedValueOnce({ id: "sbx-two", state: "STARTED", name: "conv-two" });

    const first = await acquireConversationSandbox({
      ...key,
      runtime,
      leaseTtlSeconds: 900,
      snapshotVersion: "snapshot-v1",
      createSandbox,
      now,
    });
    const secondKey = {
      ...key,
      conversationKey: buildSlackConversationKey({
        channel: "C123",
        threadTs: "1770000000.000200",
      }),
    };
    const second = await acquireConversationSandbox({
      ...secondKey,
      runtime,
      leaseTtlSeconds: 900,
      snapshotVersion: "snapshot-v1",
      createSandbox,
      now,
    });

    expect(first.handle.id).toBe("sbx-one");
    expect(second.handle.id).toBe("sbx-two");
    expect(first.harnessSessionId).not.toBe(second.harnessSessionId);
    expect(createSandbox).toHaveBeenNthCalledWith(2, {
      sandboxName: expect.any(String),
      labels: {
        ...conversationSandboxLabels(secondKey),
        deploymentId: secondKey.deploymentId,
        sandboxName: expect.any(String),
      },
    });
  });

  it("destroys a stale snapshot sandbox and provisions fresh while preserving the harness session id", async () => {
    const runtime = runtimeMock();
    const staleHandle = { id: "sbx-stale", state: "STARTED", name: "conv-stale" };
    const freshHandle = { id: "sbx-fresh", state: "STARTED", name: "conv-fresh" };
    mocks.execute
      .mockResolvedValueOnce({ rows: [leaseRow({
        sandbox_id: staleHandle.id,
        sandbox_name: staleHandle.name,
        snapshot_version: "snapshot-old",
      })] })
      .mockImplementation(async (query: unknown) => {
        const text = sqlText(query);
        if (text.includes("INSERT INTO conversation_sandbox_leases")) {
          return { rows: [leaseRow({ id: "lease-claim-idle", state: "warming", sandbox_id: null })] };
        }
        if (text.includes("UPDATE conversation_sandbox_leases")) {
          return { rowCount: 1, rows: [] };
        }
        return { rows: [] };
      });
    vi.mocked(runtime.getById!).mockResolvedValue(staleHandle);
    const createSandbox = vi.fn().mockResolvedValue(freshHandle);

    const result = await acquireConversationSandbox({
      ...key,
      runtime,
      leaseTtlSeconds: 900,
      snapshotVersion: "snapshot-new",
      createSandbox,
      now,
    });

    expect(result.reused).toBe(false);
    expect(result.handle).toBe(freshHandle);
    expect(result.harnessSessionId).toBe("2f7d4d0a-0ccf-4e07-8ca2-7bd52ae19f5d");
    expect(createSandbox).toHaveBeenCalledTimes(1);
  });

  it("idle-stops expired warm leases before provisioning", async () => {
    const runtime = runtimeMock();
    const idleHandle = { id: "sbx-idle", state: "STARTED", name: "conv-idle" };
    mocks.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [leaseRow({
          id: "lease-idle",
          sandbox_id: idleHandle.id,
          sandbox_name: idleHandle.name,
          lease_until: new Date("2026-06-08T11:00:00.000Z"),
          last_used_at: new Date("2026-06-08T11:00:00.000Z"),
        })],
      })
      .mockImplementation(async (query: unknown) => {
        const text = sqlText(query);
        if (text.includes("INSERT INTO conversation_sandbox_leases")) {
          return { rows: [leaseRow({ id: "lease-claim-evict", state: "warming", sandbox_id: null })] };
        }
        if (text.includes("UPDATE conversation_sandbox_leases")) {
          return { rowCount: 1, rows: [] };
        }
        return { rows: [] };
      });
    vi.mocked(runtime.getById!).mockResolvedValue(idleHandle);
    const createSandbox = vi.fn().mockResolvedValue({ id: "sbx-created", state: "STARTED" });

    await acquireConversationSandbox({
      ...key,
      runtime,
      leaseTtlSeconds: 900,
      idleTtlSeconds: 300,
      snapshotVersion: "snapshot-v1",
      createSandbox,
      now,
    });

    expect(runtime.stop).toHaveBeenCalledWith(idleHandle);
    expect(sqlText(mocks.execute.mock.calls[3]?.[0])).toContain("UPDATE conversation_sandbox_leases");
    expect(createSandbox).toHaveBeenCalledTimes(1);
  });

  it("evicts the least recently used lease within the same workspace when the workspace cap is reached", async () => {
    const runtime = runtimeMock();
    const evictedHandle = { id: "sbx-evict", state: "STARTED", name: "conv-evict" };
    const evictedLease = leaseRow({
      id: "lease-evict",
      deployment_id: "deployment-old",
      conversation_key: "C123:1760000000.000100",
      sandbox_id: evictedHandle.id,
      sandbox_name: evictedHandle.name,
      last_used_at: new Date("2026-06-08T10:00:00.000Z"),
    });
    mocks.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [evictedLease] })
      .mockResolvedValueOnce({ rows: [] })
      .mockImplementation(async (query: unknown) => {
        const text = sqlText(query);
        if (text.includes("INSERT INTO conversation_sandbox_leases")) {
          return { rows: [leaseRow({ id: "lease-claim-dead", state: "warming", sandbox_id: null })] };
        }
        if (text.includes("UPDATE conversation_sandbox_leases")) {
          return { rowCount: 1, rows: [] };
        }
        return { rows: [] };
      });
    vi.mocked(runtime.getById!).mockResolvedValue(evictedHandle);
    const slotAdmission = {
      acquireConversationSandboxSlot: vi.fn()
        .mockResolvedValueOnce({ granted: false, retryAfterMs: 900_000 })
        .mockResolvedValueOnce({ granted: true, retryAfterMs: null }),
      releaseConversationSandboxSlot: vi.fn().mockResolvedValue(undefined),
      currentActiveCount: vi.fn().mockResolvedValue(1),
    };
    const createSandbox = vi.fn().mockResolvedValue({ id: "sbx-new", state: "STARTED" });

    await acquireConversationSandbox({
      ...key,
      runtime,
      leaseTtlSeconds: 900,
      maxWarmPerWorkspace: 1,
      slotAdmission,
      snapshotVersion: "snapshot-v1",
      createSandbox,
      now,
    });

    expect(runtime.stop).toHaveBeenCalledWith(evictedHandle);
    expect(slotAdmission.releaseConversationSandboxSlot).toHaveBeenCalledWith(
      "workspace-a/agent-87654321/C123:1760000000.000100",
    );
    expect(createSandbox).toHaveBeenCalledTimes(1);
  });

  it("does not evict when the workspace cap is reached but every other lease is active", async () => {
    const runtime = runtimeMock();
    const slotAdmission = {
      acquireConversationSandboxSlot: vi.fn().mockResolvedValue({ granted: false, retryAfterMs: 900_000 }),
      releaseConversationSandboxSlot: vi.fn().mockResolvedValue(undefined),
      currentActiveCount: vi.fn().mockResolvedValue(1),
    };

    await expect(acquireConversationSandbox({
      ...key,
      runtime,
      leaseTtlSeconds: 900,
      maxWarmPerWorkspace: 1,
      slotAdmission,
      snapshotVersion: "snapshot-v1",
      createSandbox: vi.fn(),
      now,
    })).rejects.toThrow("no evictable lease");

    expect(runtime.stop).not.toHaveBeenCalled();
    expect(slotAdmission.releaseConversationSandboxSlot).not.toHaveBeenCalled();
  });

  it("falls back to fresh when the leased sandbox is terminal", async () => {
    const runtime = runtimeMock();
    const deadHandle = { id: "sbx-dead", state: "ERROR", name: "conv-dead" };
    const freshHandle = { id: "sbx-fresh", state: "STARTED", name: "conv-fresh" };
    mocks.execute
      .mockResolvedValueOnce({ rows: [leaseRow({
        sandbox_id: deadHandle.id,
        sandbox_name: deadHandle.name,
      })] })
      .mockImplementation(async (query: unknown) => {
        const text = sqlText(query);
        if (text.includes("sandbox_id = NULL")) {
          return { rows: [leaseRow({ id: "lease-claim-dead", state: "warming", sandbox_id: null })] };
        }
        if (text.includes("UPDATE conversation_sandbox_leases")) {
          return { rowCount: 1, rows: [] };
        }
        return { rows: [] };
      });
    vi.mocked(runtime.getById!).mockResolvedValue(deadHandle);
    const createSandbox = vi.fn().mockResolvedValue(freshHandle);

    const result = await acquireConversationSandbox({
      ...key,
      runtime,
      leaseTtlSeconds: 900,
      snapshotVersion: "snapshot-v1",
      createSandbox,
      now,
    });

    expect(result.reused).toBe(false);
    expect(result.handle).toBe(freshHandle);
    expect(runtime.destroy).toHaveBeenCalledWith(deadHandle);
    expect(createSandbox).toHaveBeenCalledTimes(1);
  });

  it("starts and reuses a stopped idle lease", async () => {
    const runtime = runtimeMock();
    const stoppedHandle = { id: "sbx-stopped", state: "STOPPED", name: "conv-stopped" };
    const startedHandle = { ...stoppedHandle, state: "STARTED" };
    mocks.execute
      .mockResolvedValueOnce({ rows: [leaseRow({
        state: "idle",
        sandbox_id: stoppedHandle.id,
        sandbox_name: stoppedHandle.name,
      })] })
      .mockImplementation(async (query: unknown) => {
        const text = sqlText(query);
        if (text.includes("UPDATE conversation_sandbox_leases")) {
          return { rowCount: 1, rows: [] };
        }
        return { rows: [] };
      });
    vi.mocked(runtime.getById!).mockResolvedValue(stoppedHandle);
    vi.mocked(runtime.start!).mockResolvedValue(startedHandle);
    const createSandbox = vi.fn();

    const result = await acquireConversationSandbox({
      ...key,
      runtime,
      leaseTtlSeconds: 900,
      maxWarmPerWorkspace: 1,
      snapshotVersion: "snapshot-v1",
      createSandbox,
      now,
    });

    expect(result).toEqual({
      handle: startedHandle,
      sandboxName: stoppedHandle.name,
      harnessSessionId: "2f7d4d0a-0ccf-4e07-8ca2-7bd52ae19f5d",
      reused: true,
    });
    expect(runtime.start).toHaveBeenCalledWith(stoppedHandle);
    expect(createSandbox).not.toHaveBeenCalled();
  });

  it("rejects warm reuse while the same conversation lease is already in use", async () => {
    const runtime = runtimeMock();
    mocks.execute.mockResolvedValueOnce({
      rows: [leaseRow({
        state: "in_use",
        lease_until: new Date("2026-06-08T12:10:00.000Z"),
      })],
    });
    const slotAdmission = {
      acquireConversationSandboxSlot: vi.fn().mockResolvedValue({ granted: false, retryAfterMs: 900_000 }),
      releaseConversationSandboxSlot: vi.fn().mockResolvedValue(undefined),
      currentActiveCount: vi.fn().mockResolvedValue(1),
    };

    await expect(acquireConversationSandbox({
      ...key,
      runtime,
      leaseTtlSeconds: 900,
      maxWarmPerWorkspace: 1,
      slotAdmission,
      snapshotVersion: "snapshot-v1",
      createSandbox: vi.fn(),
      now,
    })).rejects.toBeInstanceOf(ConversationSandboxLeaseBusyError);
    expect(slotAdmission.acquireConversationSandboxSlot).not.toHaveBeenCalled();
  });

  it("does not stop an idle-expired lease when the CAS update loses to a concurrent touch", async () => {
    const runtime = runtimeMock();
    const idleHandle = { id: "sbx-idle-race", state: "STARTED", name: "conv-idle-race" };
    mocks.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [leaseRow({
        id: "lease-idle-race",
        sandbox_id: idleHandle.id,
        sandbox_name: idleHandle.name,
        lease_until: new Date("2026-06-08T11:00:00.000Z"),
        last_used_at: new Date("2026-06-08T11:00:00.000Z"),
      })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const createSandbox = vi.fn().mockResolvedValue({ id: "sbx-created", state: "STARTED" });

    await acquireConversationSandbox({
      ...key,
      runtime,
      leaseTtlSeconds: 900,
      idleTtlSeconds: 300,
      snapshotVersion: "snapshot-v1",
      createSandbox,
      now,
    });

    expect(runtime.stop).not.toHaveBeenCalled();
  });

  it("records the latest deployment id when reusing an existing conversation lease", async () => {
    const runtime = runtimeMock();
    const reusedHandle = { id: "sbx-reuse-latest-deployment", state: "STARTED", name: "conv-reuse" };
    mocks.execute
      .mockResolvedValueOnce({
        rows: [leaseRow({
          deployment_id: "deployment-old",
          sandbox_id: reusedHandle.id,
          sandbox_name: reusedHandle.name,
        })],
      })
      .mockImplementation(async (query: unknown) => {
        const text = sqlText(query);
        if (text.includes("UPDATE conversation_sandbox_leases")) {
          return { rowCount: 1, rows: [] };
        }
        return { rows: [] };
      });
    vi.mocked(runtime.getById!).mockResolvedValue(reusedHandle);

    await acquireConversationSandbox({
      ...key,
      deploymentId: "deployment-new",
      runtime,
      leaseTtlSeconds: 900,
      snapshotVersion: "snapshot-v1",
      createSandbox: vi.fn(),
      now,
    });

    const reuseUpdate = mocks.execute.mock.calls
      .map((call) => sqlText(call[0]))
      .find((text) => text.includes("attempt_count = attempt_count + 1"));
    expect(reuseUpdate).toContain("deployment_id = ?");
  });

  it("keeps a returned warm lease eligible for idle expiry", async () => {
    mocks.execute
      .mockResolvedValueOnce({ rows: [leaseRow({ state: "in_use" })] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await expect(markConversationSandboxLeaseAvailable({
      key,
      now,
    })).resolves.toEqual({
      marked: true,
      sandboxId: "sbx-existing",
    });

    const markWarmUpdate = sqlText(mocks.execute.mock.calls[1]?.[0]);
    expect(markWarmUpdate).toContain("state = ?");
    expect(markWarmUpdate).toContain("lease_until = ?");
  });
});

describe("reapConversationSandboxLeases", () => {
  it("stops quiesced idle-expired warm leases globally", async () => {
    const runtime = runtimeMock();
    const idleHandle = { id: "sbx-global-idle", state: "STARTED", name: "conv-global-idle" };
    mocks.execute
      .mockResolvedValueOnce({ rows: [leaseRow({
        id: "lease-global-idle",
        sandbox_id: idleHandle.id,
        sandbox_name: idleHandle.name,
        lease_until: new Date("2026-06-08T11:00:00.000Z"),
        last_used_at: new Date("2026-06-08T11:00:00.000Z"),
      })] })
      .mockResolvedValueOnce({ rows: [leaseRow({
        id: "lease-global-idle",
        sandbox_id: idleHandle.id,
        sandbox_name: idleHandle.name,
        lease_until: new Date("2026-06-08T11:00:00.000Z"),
        last_used_at: new Date("2026-06-08T11:00:00.000Z"),
      })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    vi.mocked(runtime.getById!).mockResolvedValue(idleHandle);

    const result = await reapConversationSandboxLeases({
      runtime,
      now,
      idleTtlSeconds: 300,
    });

    expect(result.idleFound).toBe(1);
    expect(result.idleStopped).toBe(1);
    expect(runtime.stop).toHaveBeenCalledWith(idleHandle);
  });

  it("destroys old evicted leases and marks them released", async () => {
    const runtime = runtimeMock();
    const evictedHandle = { id: "sbx-evicted", state: "STOPPED", name: "conv-evicted" };
    mocks.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [leaseRow({
        id: "lease-evicted-cleanup",
        state: "evicted",
        sandbox_id: evictedHandle.id,
        sandbox_name: evictedHandle.name,
        updated_at: new Date("2026-06-08T07:00:00.000Z"),
        active_delivery: false,
      })] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    vi.mocked(runtime.getById!).mockResolvedValue(evictedHandle);

    const result = await reapConversationSandboxLeases({
      runtime,
      now,
      stoppedMinAgeHours: 4,
    });

    expect(result.cleanupFound).toBe(1);
    expect(result.cleanupDestroyed).toBe(1);
    expect(result.cleanupReleased).toBe(1);
    expect(runtime.destroy).toHaveBeenCalledWith(evictedHandle);
  });
});

describe("conversation sandbox slot admission", () => {
  it("counts warm conversation leases per workspace", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [{ count: "2" }] });

    await expect(currentActiveConversationSandboxCount({
      workspaceId: "workspace-a",
    })).resolves.toBe(2);

    expect(sqlText(mocks.execute.mock.calls[0]?.[0])).toContain("WHERE workspace_id = ?");
    expect(sqlText(mocks.execute.mock.calls[0]?.[0])).toContain("state = 'warming'");
  });

  it("keeps release idempotent", async () => {
    const slotAdmission = createDaytonaConversationSandboxSlotAdmission();

    await expect(slotAdmission.releaseConversationSandboxSlot("lease-key")).resolves.toBeUndefined();
    await expect(slotAdmission.releaseConversationSandboxSlot("lease-key")).resolves.toBeUndefined();
  });
});
