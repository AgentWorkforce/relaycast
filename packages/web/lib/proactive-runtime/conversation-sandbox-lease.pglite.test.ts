import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { setDbForTesting } from "@/lib/db";
import {
  acquireConversationSandbox,
  buildSlackConversationKey,
  ConversationSandboxLeaseBusyError,
  reapConversationSandboxLeases,
  releaseConversationSandboxLease,
} from "./conversation-sandbox-lease";
import type { DeploymentSandboxRuntime } from "./sandbox-runtime";

function runtimeMock(): DeploymentSandboxRuntime {
  return {
    id: "daytona",
    findByLabels: vi.fn().mockResolvedValue(null),
    findAllByLabels: vi.fn(),
    getById: vi.fn().mockResolvedValue(null),
    launch: vi.fn(),
    launchDetached: vi.fn(),
    uploadBundle: vi.fn(),
    runScript: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    destroy: vi.fn(),
  };
}

const now = new Date("2026-06-08T12:00:00.000Z");
const past = new Date("2026-06-08T10:00:00.000Z");
const future = new Date("2026-06-08T13:00:00.000Z");
const key = {
  workspaceId: "workspace-a",
  deploymentId: "deployment-fire-2",
  agentId: "agent-a",
  conversationKey: buildSlackConversationKey({
    channel: "C123",
    threadTs: "1770000000.000100",
  }),
};

let pg: PGlite | null = null;

async function queryRows<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const result = await pg!.query<T>(sql);
  return result.rows;
}

async function setupDb() {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE conversation_sandbox_leases (
      id text PRIMARY KEY DEFAULT ('lease-' || floor(random() * 1000000000)::text),
      workspace_id text NOT NULL,
      deployment_id text NOT NULL,
      agent_id text NOT NULL,
      conversation_key text NOT NULL,
      harness_session_id text NOT NULL,
      sandbox_id text,
      sandbox_name text NOT NULL,
      state text NOT NULL DEFAULT 'warm',
      lease_until timestamptz,
      last_used_at timestamptz NOT NULL DEFAULT now(),
      attempt_count integer NOT NULL DEFAULT 0,
      current_step text,
      snapshot_version text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX conversation_sandbox_leases_workspace_agent_conversation_unique
      ON conversation_sandbox_leases (workspace_id, agent_id, conversation_key);
    CREATE TABLE integration_watch_deliveries (
      id text PRIMARY KEY,
      run_sandbox_id text,
      status text NOT NULL
    );
    CREATE TABLE deployment_tick_deliveries (
      id text PRIMARY KEY,
      run_sandbox_id text,
      status text NOT NULL
    );
  `);
  setDbForTesting(drizzle(pg) as never);
}

async function insertLease(overrides: Record<string, unknown> = {}) {
  const row = {
    id: "lease-1",
    workspace_id: key.workspaceId,
    deployment_id: "deployment-fire-1",
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
    created_at: now,
    updated_at: now,
    ...overrides,
  };
  await pg!.query(
    `INSERT INTO conversation_sandbox_leases (
      id,
      workspace_id,
      deployment_id,
      agent_id,
      conversation_key,
      harness_session_id,
      sandbox_id,
      sandbox_name,
      state,
      lease_until,
      last_used_at,
      attempt_count,
      current_step,
      snapshot_version,
      created_at,
      updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
    )`,
    [
      row.id,
      row.workspace_id,
      row.deployment_id,
      row.agent_id,
      row.conversation_key,
      row.harness_session_id,
      row.sandbox_id,
      row.sandbox_name,
      row.state,
      row.lease_until,
      row.last_used_at,
      row.attempt_count,
      row.current_step,
      row.snapshot_version,
      row.created_at,
      row.updated_at,
    ],
  );
}

async function acquire(input: {
  runtime?: DeploymentSandboxRuntime;
  createSandbox?: ReturnType<typeof vi.fn>;
  deploymentId?: string;
  leaseTtlSeconds?: number;
} = {}) {
  const runtime = input.runtime ?? runtimeMock();
  const createSandbox = input.createSandbox ?? vi.fn().mockResolvedValue({
    id: "sbx-created",
    state: "STARTED",
  });
  const result = await acquireConversationSandbox({
    ...key,
    deploymentId: input.deploymentId ?? key.deploymentId,
    runtime,
    leaseTtlSeconds: input.leaseTtlSeconds ?? 900,
    maxWarmPerWorkspace: 1,
    snapshotVersion: "snapshot-v1",
    createSandbox: createSandbox as never,
    now,
  });
  return { result, runtime, createSandbox };
}

describe("conversation sandbox lease state machine (PGlite)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await setupDb();
  });

  afterEach(async () => {
    setDbForTesting(null);
    await pg?.close();
    pg = null;
  });

  it("reuses a lease across per-fire deployment ids by keying on workspace, agent, and conversation", async () => {
    await insertLease();
    const runtime = runtimeMock();
    const existingHandle = { id: "sbx-existing", state: "STARTED", name: "conv-existing" };
    vi.mocked(runtime.getById!).mockResolvedValue(existingHandle);
    const createSandbox = vi.fn();

    const { result } = await acquire({
      runtime,
      createSandbox,
      deploymentId: "deployment-fire-2",
    });

    expect(result).toEqual({
      handle: existingHandle,
      sandboxName: "conv-existing",
      harnessSessionId: "2f7d4d0a-0ccf-4e07-8ca2-7bd52ae19f5d",
      reused: true,
    });
    expect(createSandbox).not.toHaveBeenCalled();
  });

  it("reclaims a stale in-use lease instead of returning busy", async () => {
    await insertLease({
      state: "in_use",
      lease_until: past,
      sandbox_id: "sbx-stale",
      updated_at: past,
    });
    const runtime = runtimeMock();
    const staleHandle = { id: "sbx-stale", state: "STOPPED", name: "conv-stale" };
    vi.mocked(runtime.getById!).mockResolvedValue(staleHandle);
    const createSandbox = vi.fn().mockResolvedValue({
      id: "sbx-fresh",
      state: "STARTED",
      name: "conv-fresh",
    });

    const { result } = await acquire({ runtime, createSandbox });

    expect(result.reused).toBe(false);
    expect(result.harnessSessionId).toBe("2f7d4d0a-0ccf-4e07-8ca2-7bd52ae19f5d");
    expect(runtime.destroy).toHaveBeenCalledWith(staleHandle);
    expect(createSandbox).toHaveBeenCalledTimes(1);
    const [row] = await queryRows<{ state: string; sandbox_id: string; deployment_id: string }>(
      "SELECT state, sandbox_id, deployment_id FROM conversation_sandbox_leases",
    );
    expect(row).toEqual({
      state: "in_use",
      sandbox_id: "sbx-fresh",
      deployment_id: "deployment-fire-2",
    });
  });

  it("reclaims an in-use lease with a null lease timeout instead of returning busy", async () => {
    await insertLease({
      state: "in_use",
      lease_until: null,
      sandbox_id: "sbx-null-timeout",
      updated_at: past,
    });
    const runtime = runtimeMock();
    const staleHandle = { id: "sbx-null-timeout", state: "STOPPED", name: "conv-null-timeout" };
    vi.mocked(runtime.getById!).mockResolvedValue(staleHandle);
    const createSandbox = vi.fn().mockResolvedValue({
      id: "sbx-null-fresh",
      state: "STARTED",
      name: "conv-null-fresh",
    });

    const { result } = await acquire({ runtime, createSandbox });

    expect(result.reused).toBe(false);
    expect(runtime.destroy).toHaveBeenCalledWith(staleHandle);
    expect(createSandbox).toHaveBeenCalledTimes(1);
    const [row] = await queryRows<{ state: string; sandbox_id: string }>(
      "SELECT state, sandbox_id FROM conversation_sandbox_leases",
    );
    expect(row).toEqual({
      state: "in_use",
      sandbox_id: "sbx-null-fresh",
    });
  });

  it("lets only one concurrent acquire reclaim a stale in-use lease", async () => {
    await insertLease({
      state: "in_use",
      lease_until: past,
      sandbox_id: "sbx-stale",
      updated_at: past,
    });
    const runtime = runtimeMock();
    vi.mocked(runtime.getById!).mockResolvedValue({ id: "sbx-stale", state: "STOPPED" });
    let resolveCreate: (value: { id: string; state: string }) => void = (_value) => {
      throw new Error("createSandbox resolver was not installed");
    };
    const createSandbox = vi.fn().mockImplementation(() =>
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );

    const first = acquire({ runtime, createSandbox });
    await vi.waitUntil(() => createSandbox.mock.calls.length === 1);
    const second = acquire({ runtime, createSandbox });
    resolveCreate({ id: "sbx-fresh", state: "STARTED" });

    const settled = await Promise.allSettled([first, second]);

    expect(settled.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((entry) =>
      entry.status === "rejected" && entry.reason instanceof ConversationSandboxLeaseBusyError,
    )).toHaveLength(1);
    expect(createSandbox).toHaveBeenCalledTimes(1);
    const rows = await queryRows<{ sandbox_id: string; state: string }>(
      "SELECT sandbox_id, state FROM conversation_sandbox_leases",
    );
    expect(rows).toEqual([{ sandbox_id: "sbx-fresh", state: "in_use" }]);
  });

  it("does not reclaim an expired in-use lease while an active delivery still references it", async () => {
    await insertLease({
      state: "in_use",
      lease_until: past,
      sandbox_id: "sbx-live",
      updated_at: past,
    });
    await pg!.query(
      "INSERT INTO integration_watch_deliveries (id, run_sandbox_id, status) VALUES ($1, $2, $3)",
      ["delivery-1", "sbx-live", "running"],
    );

    await expect(acquire({ createSandbox: vi.fn() })).rejects.toBeInstanceOf(ConversationSandboxLeaseBusyError);

    const [row] = await queryRows<{ state: string; sandbox_id: string }>(
      "SELECT state, sandbox_id FROM conversation_sandbox_leases",
    );
    expect(row).toEqual({ state: "in_use", sandbox_id: "sbx-live" });
  });

  it("destroys and releases an abandoned in-use sandbox from the global reaper", async () => {
    await insertLease({
      state: "in_use",
      lease_until: past,
      sandbox_id: "sbx-abandoned",
      updated_at: past,
    });
    const runtime = runtimeMock();
    const handle = { id: "sbx-abandoned", state: "STARTED", name: "conv-abandoned" };
    vi.mocked(runtime.getById!).mockResolvedValue(handle);

    const result = await reapConversationSandboxLeases({
      runtime,
      now,
      stoppedMinAgeHours: 1,
    });

    expect(result.cleanupFound).toBe(1);
    expect(result.cleanupDestroyed).toBe(1);
    expect(result.cleanupReleased).toBe(1);
    expect(runtime.destroy).toHaveBeenCalledWith(handle);
    const [row] = await queryRows<{ state: string; current_step: string }>(
      "SELECT state, current_step FROM conversation_sandbox_leases",
    );
    expect(row).toEqual({ state: "released", current_step: "released" });
  });

  it("destroys and releases an abandoned in-use sandbox with a null lease timeout", async () => {
    await insertLease({
      state: "in_use",
      lease_until: null,
      sandbox_id: "sbx-null-abandoned",
      updated_at: past,
    });
    const runtime = runtimeMock();
    const handle = { id: "sbx-null-abandoned", state: "STARTED", name: "conv-null-abandoned" };
    vi.mocked(runtime.getById!).mockResolvedValue(handle);

    const result = await reapConversationSandboxLeases({
      runtime,
      now,
      stoppedMinAgeHours: 1,
    });

    expect(result.cleanupFound).toBe(1);
    expect(result.cleanupDestroyed).toBe(1);
    expect(result.cleanupReleased).toBe(1);
    expect(runtime.destroy).toHaveBeenCalledWith(handle);
    const [row] = await queryRows<{ state: string; current_step: string }>(
      "SELECT state, current_step FROM conversation_sandbox_leases",
    );
    expect(row).toEqual({ state: "released", current_step: "released" });
  });

  it("evicts the least-recently-used warm lease with a real CAS update", async () => {
    await insertLease({
      id: "lease-other",
      conversation_key: "C123:1770000000.000200",
      sandbox_id: "sbx-other",
      sandbox_name: "conv-other",
      lease_until: future,
      last_used_at: past,
      updated_at: past,
    });
    const runtime = runtimeMock();
    const evictedHandle = { id: "sbx-other", state: "STARTED", name: "conv-other" };
    vi.mocked(runtime.getById!).mockResolvedValue(evictedHandle);
    const slotAdmission = {
      acquireConversationSandboxSlot: vi.fn()
        .mockResolvedValueOnce({ granted: false, retryAfterMs: 900_000 })
        .mockResolvedValueOnce({ granted: true, retryAfterMs: null }),
      releaseConversationSandboxSlot: vi.fn().mockResolvedValue(undefined),
      currentActiveCount: vi.fn().mockResolvedValue(1),
    };
    const createSandbox = vi.fn().mockResolvedValue({
      id: "sbx-current",
      state: "STARTED",
      name: "conv-current",
    });

    const result = await acquireConversationSandbox({
      ...key,
      runtime,
      leaseTtlSeconds: 900,
      maxWarmPerWorkspace: 1,
      slotAdmission,
      snapshotVersion: "snapshot-v1",
      createSandbox,
      now,
    });

    expect(result.reused).toBe(false);
    expect(runtime.stop).toHaveBeenCalledWith(evictedHandle);
    expect(slotAdmission.releaseConversationSandboxSlot).toHaveBeenCalledWith(
      "workspace-a/agent-a/C123:1770000000.000200",
    );
    const rows = await queryRows<{ conversation_key: string; state: string; current_step: string | null }>(
      "SELECT conversation_key, state, current_step FROM conversation_sandbox_leases ORDER BY conversation_key",
    );
    expect(rows).toEqual([
      {
        conversation_key: "C123:1770000000.000100",
        state: "in_use",
        current_step: "sandbox-ready",
      },
      {
        conversation_key: "C123:1770000000.000200",
        state: "evicted",
        current_step: "lru-evicted",
      },
    ]);
  });

  it("reclaims a released thread row instead of timing out on the unique index", async () => {
    await insertLease({
      state: "released",
      lease_until: null,
      sandbox_id: null,
      updated_at: past,
    });
    const createSandbox = vi.fn().mockResolvedValue({
      id: "sbx-after-release",
      state: "STARTED",
      name: "conv-after-release",
    });

    const { result } = await acquire({ createSandbox });

    expect(result.reused).toBe(false);
    expect(createSandbox).toHaveBeenCalledTimes(1);
    const [row] = await queryRows<{ state: string; sandbox_id: string }>(
      "SELECT state, sandbox_id FROM conversation_sandbox_leases",
    );
    expect(row).toEqual({ state: "in_use", sandbox_id: "sbx-after-release" });
  });

  it("reacquires after exit-137 release without timing out on the released row", async () => {
    await insertLease({
      state: "in_use",
      lease_until: future,
      sandbox_id: "sbx-exit-137",
    });

    await expect(releaseConversationSandboxLease({ key, now })).resolves.toEqual({
      released: true,
      sandboxId: "sbx-exit-137",
    });

    const runtime = runtimeMock();
    vi.mocked(runtime.getById!).mockResolvedValue({ id: "sbx-exit-137", state: "STOPPED" });
    const createSandbox = vi.fn().mockResolvedValue({
      id: "sbx-retry",
      state: "STARTED",
      name: "conv-retry",
    });
    const { result } = await acquire({ runtime, createSandbox });

    expect(result.reused).toBe(false);
    expect(runtime.destroy).toHaveBeenCalledWith({ id: "sbx-exit-137", state: "STOPPED" });
    expect(createSandbox).toHaveBeenCalledTimes(1);
  });

  it("does not idle-stop an expired warm lease while an active delivery references it", async () => {
    await insertLease({
      state: "warm",
      lease_until: past,
      last_used_at: past,
      sandbox_id: "sbx-active-warm",
      updated_at: past,
    });
    await pg!.query(
      "INSERT INTO deployment_tick_deliveries (id, run_sandbox_id, status) VALUES ($1, $2, $3)",
      ["tick-1", "sbx-active-warm", "processing"],
    );
    const runtime = runtimeMock();

    const result = await reapConversationSandboxLeases({
      runtime,
      now,
      idleTtlSeconds: 300,
      stoppedMinAgeHours: 1,
    });

    expect(result.idleFound).toBe(0);
    expect(result.idleStopped).toBe(0);
    expect(runtime.stop).not.toHaveBeenCalled();
    const [row] = await queryRows<{ state: string }>("SELECT state FROM conversation_sandbox_leases");
    expect(row.state).toBe("warm");
  });
});
