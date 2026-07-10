import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { RuntimeHandle } from "@cloud/core/runtime/daytona.js";
import { getDb } from "@/lib/db";
import type { DeploymentSandboxRuntime } from "@/lib/proactive-runtime/sandbox-runtime";

export const DEFAULT_PR_SANDBOX_ACTIVE_LIMIT = 10;
export const PR_SANDBOX_SLOT_POOL_ID = "daytona-sandbox:global";
export const PR_SANDBOX_READY_STEP = "sandbox-ready";
export const DEFAULT_PR_SANDBOX_IDLE_TTL_SECONDS = 30 * 60;

export type PrSandboxLeaseState = "warm" | "idle" | "released" | "evicted";

export type PrSandboxKey = {
  workspaceId: string;
  agentId: string;
  repoFullName: string;
  prNumber: number;
};

export type PrSandboxSlotAcquireOptions = {
  ttlMs: number;
  poolId: string;
  cap: number;
};

export type PrSandboxSlotAcquireResult = {
  granted: boolean;
  retryAfterMs?: number | null;
};

export type PrSandboxSlotAdmission = {
  acquirePrSandboxSlot(
    leaseKey: string,
    options: PrSandboxSlotAcquireOptions,
  ): Promise<PrSandboxSlotAcquireResult>;
  releasePrSandboxSlot(leaseKey: string): Promise<void>;
  currentActiveCount(poolId: string): Promise<number>;
};

type PrSandboxLeaseRow = {
  id: string;
  workspace_id: string;
  agent_id: string;
  repo_full_name: string;
  pr_number: number;
  sandbox_id: string | null;
  sandbox_name: string;
  state: PrSandboxLeaseState;
  lease_until: Date | string | null;
  last_used_at: Date | string;
  attempt_count: number;
  current_step: string | null;
  snapshot_version: string | null;
};

export type PrSandboxCreateInput = {
  sandboxName: string;
  labels: Record<string, string>;
};

export type AcquirePrSandboxInput = PrSandboxKey & {
  runtime: DeploymentSandboxRuntime;
  leaseTtlSeconds: number;
  idleTtlSeconds?: number;
  // Daytona snapshot identity the box would be provisioned from for this fire
  // (caller passes the same value used to build the runtime, i.e.
  // `await getSnapshotName()`). A warm lease is only reused when its recorded
  // snapshot_version matches this exactly, so a RELAYFILE_MOUNT_VERSION bump
  // (which changes the snapshot name) auto-invalidates stale STARTED boxes.
  snapshotVersion: string;
  activeSandboxLimit?: number;
  slotAdmission?: PrSandboxSlotAdmission;
  slotPoolId?: string;
  createSandbox(input: PrSandboxCreateInput): Promise<RuntimeHandle>;
  now?: Date;
};

export type AcquirePrSandboxResult = {
  handle: RuntimeHandle;
  sandboxName: string;
  reused: boolean;
};

export type ReleasePrSandboxSlotResult = {
  released: boolean;
  destroyed: boolean;
  skippedActiveRun: boolean;
  sandboxId: string | null;
};

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function shortToken(value: string, length = 8): string {
  return value.replace(/[^a-zA-Z0-9]/gu, "").toLowerCase().slice(0, length) || "unknown";
}

function repoHash(repoFullName: string): string {
  return createHash("sha1").update(repoFullName).digest("hex").slice(0, 8);
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveIdleTtlSeconds(input: number | undefined): number {
  if (typeof input === "number" && Number.isFinite(input) && input > 0) {
    return Math.floor(input);
  }
  return readPositiveInteger(
    process.env.PR_SANDBOX_IDLE_TTL_SECONDS?.trim(),
    DEFAULT_PR_SANDBOX_IDLE_TTL_SECONDS,
  );
}

function timeValue(value: Date | string | null): number | null {
  if (!value) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function isWarmLeaseStillAdmitted(input: {
  lease: PrSandboxLeaseRow | null;
  now: Date;
  idleBefore: Date;
}): boolean {
  if (input.lease?.state !== "warm") {
    return false;
  }
  const leaseUntil = timeValue(input.lease.lease_until);
  const lastUsedAt = timeValue(input.lease.last_used_at);
  return !(
    leaseUntil !== null &&
    lastUsedAt !== null &&
    leaseUntil <= input.now.getTime() &&
    lastUsedAt <= input.idleBefore.getTime()
  );
}

export function buildPrSandboxName(input: PrSandboxKey): string {
  return [
    "pr-reviewer",
    shortToken(input.workspaceId),
    shortToken(input.agentId),
    repoHash(input.repoFullName),
    String(input.prNumber),
  ].join("-").slice(0, 63);
}

export function prSandboxLabels(input: PrSandboxKey): Record<string, string> {
  return {
    purpose: "workforce-deploy",
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    repoFullName: input.repoFullName,
    prNumber: String(input.prNumber),
    warmLease: "pull-request",
  };
}

export function prSandboxLeaseKey(input: PrSandboxKey): string {
  return [
    input.workspaceId,
    input.agentId,
    input.repoFullName,
    String(input.prNumber),
  ].join("/");
}

function isStarted(handle: RuntimeHandle | null): handle is RuntimeHandle {
  const state = String(handle?.state ?? "").trim().toUpperCase();
  return Boolean(handle && (state === "STARTED" || state === "RUNNING"));
}

function isStopped(handle: RuntimeHandle | null): handle is RuntimeHandle {
  return String(handle?.state ?? "").trim().toUpperCase() === "STOPPED";
}

async function findStartedSandbox(input: {
  runtime: DeploymentSandboxRuntime;
  lease: PrSandboxLeaseRow;
  key: PrSandboxKey;
}): Promise<RuntimeHandle | null> {
  if (input.lease.sandbox_id && input.runtime.getById) {
    const handle = await input.runtime.getById(input.lease.sandbox_id, {
      states: ["STARTED"],
      owned: true,
    });
    if (isStarted(handle)) return handle;
  }
  const handle = await input.runtime.findByLabels(
    {
      ...prSandboxLabels(input.key),
      sandboxName: input.lease.sandbox_name,
    },
    { states: ["STARTED"], limit: 1, owned: true },
  );
  return isStarted(handle) ? handle : null;
}

async function findSandbox(input: {
  runtime: DeploymentSandboxRuntime;
  lease: PrSandboxLeaseRow;
  key: PrSandboxKey;
  states?: readonly string[] | null;
}): Promise<RuntimeHandle | null> {
  if (input.lease.sandbox_id && input.runtime.getById) {
    const handle = await input.runtime.getById(input.lease.sandbox_id, {
      states: input.states ?? null,
      owned: true,
    });
    if (handle) return handle;
  }
  return input.runtime.findByLabels(
    {
      ...prSandboxLabels(input.key),
      sandboxName: input.lease.sandbox_name,
    },
    { states: input.states ?? null, limit: 1, owned: true },
  );
}

async function selectPrSandboxLease(key: PrSandboxKey): Promise<PrSandboxLeaseRow | null> {
  const result = await getDb().execute(sql`
    SELECT
      id,
      workspace_id,
      agent_id,
      repo_full_name,
      pr_number,
      sandbox_id,
      sandbox_name,
      state,
      lease_until,
      last_used_at,
      attempt_count,
      current_step,
      snapshot_version
    FROM pr_sandbox_leases
    WHERE workspace_id = ${key.workspaceId}
      AND agent_id = ${key.agentId}
      AND repo_full_name = ${key.repoFullName}
      AND pr_number = ${key.prNumber}
      AND state IN ('warm', 'idle', 'evicted')
    LIMIT 1
  `);
  return rowsOf<PrSandboxLeaseRow>(result)[0] ?? null;
}

async function selectLeastRecentlyUsedEvictableLease(input: {
  excludeKey: PrSandboxKey;
}): Promise<PrSandboxLeaseRow | null> {
  const result = await getDb().execute(sql`
    SELECT
      id,
      workspace_id,
      agent_id,
      repo_full_name,
      pr_number,
      sandbox_id,
      sandbox_name,
      state,
      lease_until,
      last_used_at,
      attempt_count,
      current_step,
      snapshot_version
    FROM pr_sandbox_leases
    WHERE state IN ('warm', 'idle')
      AND sandbox_id IS NOT NULL
      AND NOT (
        workspace_id = ${input.excludeKey.workspaceId}
        AND agent_id = ${input.excludeKey.agentId}
        AND repo_full_name = ${input.excludeKey.repoFullName}
        AND pr_number = ${input.excludeKey.prNumber}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM integration_watch_deliveries
        WHERE integration_watch_deliveries.run_sandbox_id = pr_sandbox_leases.sandbox_id
          AND integration_watch_deliveries.status IN ('running', 'processing')
      )
    ORDER BY last_used_at ASC
    LIMIT 1
  `);
  return rowsOf<PrSandboxLeaseRow>(result)[0] ?? null;
}

async function selectIdleExpiredLeases(input: {
  now: Date;
  idleBefore: Date;
  limit: number;
}): Promise<PrSandboxLeaseRow[]> {
  const result = await getDb().execute(sql`
    SELECT
      id,
      workspace_id,
      agent_id,
      repo_full_name,
      pr_number,
      sandbox_id,
      sandbox_name,
      state,
      lease_until,
      last_used_at,
      attempt_count,
      current_step,
      snapshot_version
    FROM pr_sandbox_leases
    WHERE state = 'warm'
      AND sandbox_id IS NOT NULL
      AND lease_until IS NOT NULL
      AND lease_until <= ${input.now}
      AND last_used_at <= ${input.idleBefore}
      AND NOT EXISTS (
        SELECT 1
        FROM integration_watch_deliveries
        WHERE integration_watch_deliveries.run_sandbox_id = pr_sandbox_leases.sandbox_id
          AND integration_watch_deliveries.status IN ('running', 'processing')
      )
    ORDER BY last_used_at ASC
    LIMIT ${input.limit}
  `);
  return rowsOf<PrSandboxLeaseRow>(result);
}

async function isSandboxInActiveDelivery(sandboxId: string | null): Promise<boolean> {
  if (!sandboxId) return false;
  const result = await getDb().execute(sql`
    SELECT 1
    FROM integration_watch_deliveries
    WHERE run_sandbox_id = ${sandboxId}
      AND status IN ('running', 'processing')
    LIMIT 1
  `);
  return rowsOf<{ "?column?": number }>(result).length > 0;
}

async function touchPrSandboxLease(input: {
  leaseId: string;
  leaseUntil: Date;
  now: Date;
}): Promise<void> {
  await getDb().execute(sql`
    UPDATE pr_sandbox_leases
    SET
      state = 'warm',
      lease_until = ${input.leaseUntil},
      last_used_at = ${input.now},
      attempt_count = attempt_count + 1,
      current_step = ${PR_SANDBOX_READY_STEP},
      updated_at = ${input.now}
    WHERE id = ${input.leaseId}
  `);
}

async function upsertPrSandboxLease(input: {
  key: PrSandboxKey;
  sandboxId: string;
  sandboxName: string;
  leaseUntil: Date;
  now: Date;
  snapshotVersion: string;
}): Promise<void> {
  await getDb().execute(sql`
    INSERT INTO pr_sandbox_leases (
      workspace_id,
      agent_id,
      repo_full_name,
      pr_number,
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
    )
    VALUES (
      ${input.key.workspaceId},
      ${input.key.agentId},
      ${input.key.repoFullName},
      ${input.key.prNumber},
      ${input.sandboxId},
      ${input.sandboxName},
      'warm',
      ${input.leaseUntil},
      ${input.now},
      1,
      ${PR_SANDBOX_READY_STEP},
      ${input.snapshotVersion},
      ${input.now},
      ${input.now}
    )
    ON CONFLICT (workspace_id, agent_id, repo_full_name, pr_number)
    DO UPDATE SET
      sandbox_id = EXCLUDED.sandbox_id,
      sandbox_name = EXCLUDED.sandbox_name,
      state = 'warm',
      lease_until = EXCLUDED.lease_until,
      last_used_at = EXCLUDED.last_used_at,
      attempt_count = pr_sandbox_leases.attempt_count + 1,
      current_step = EXCLUDED.current_step,
      snapshot_version = EXCLUDED.snapshot_version,
      updated_at = EXCLUDED.updated_at
  `);
}

async function markPrSandboxLeaseState(input: {
  leaseId: string;
  state: PrSandboxLeaseState;
  now: Date;
  currentStep?: string | null;
}): Promise<void> {
  await getDb().execute(sql`
    UPDATE pr_sandbox_leases
    SET
      state = ${input.state},
      lease_until = NULL,
      current_step = ${input.currentStep ?? input.state},
      updated_at = ${input.now}
    WHERE id = ${input.leaseId}
  `);
}

async function stopPrSandbox(input: {
  runtime: DeploymentSandboxRuntime;
  handle: RuntimeHandle;
}): Promise<void> {
  if (!input.runtime.stop) {
    throw new Error("Deployment sandbox runtime does not support stop");
  }
  await input.runtime.stop(input.handle);
}

async function startPrSandbox(input: {
  runtime: DeploymentSandboxRuntime;
  handle: RuntimeHandle;
}): Promise<RuntimeHandle> {
  if (!input.runtime.start) {
    throw new Error("Deployment sandbox runtime does not support start");
  }
  return input.runtime.start(input.handle);
}

async function stopIdleExpiredPrSandboxes(input: {
  runtime: DeploymentSandboxRuntime;
  now: Date;
  idleBefore: Date;
  limit: number;
}): Promise<number> {
  const leases = await selectIdleExpiredLeases({
    now: input.now,
    idleBefore: input.idleBefore,
    limit: input.limit,
  });
  let stopped = 0;
  for (const lease of leases) {
    if (await isSandboxInActiveDelivery(lease.sandbox_id)) {
      continue;
    }
    const key = {
      workspaceId: lease.workspace_id,
      agentId: lease.agent_id,
      repoFullName: lease.repo_full_name,
      prNumber: lease.pr_number,
    };
    const handle = await findStartedSandbox({ runtime: input.runtime, lease, key });
    if (handle) {
      await stopPrSandbox({ runtime: input.runtime, handle });
      stopped += 1;
    }
    await markPrSandboxLeaseState({
      leaseId: lease.id,
      state: "idle",
      now: input.now,
      currentStep: "idle-stopped",
    });
  }
  return stopped;
}

async function evictLeastRecentlyUsedPrSandbox(input: {
  runtime: DeploymentSandboxRuntime;
  excludeKey: PrSandboxKey;
  now: Date;
  slotAdmission: PrSandboxSlotAdmission;
}): Promise<boolean> {
  const lease = await selectLeastRecentlyUsedEvictableLease({ excludeKey: input.excludeKey });
  if (!lease) {
    return false;
  }
  if (await isSandboxInActiveDelivery(lease.sandbox_id)) {
    return false;
  }
  const key = {
    workspaceId: lease.workspace_id,
    agentId: lease.agent_id,
    repoFullName: lease.repo_full_name,
    prNumber: lease.pr_number,
  };
  const handle = await findStartedSandbox({ runtime: input.runtime, lease, key });
  if (handle) {
    await stopPrSandbox({ runtime: input.runtime, handle });
  }
  await markPrSandboxLeaseState({
    leaseId: lease.id,
    state: "evicted",
    now: input.now,
    currentStep: "lru-evicted",
  });
  await input.slotAdmission.releasePrSandboxSlot(prSandboxLeaseKey(key));
  return true;
}

export async function releasePrSandboxSlot(input: {
  runtime: DeploymentSandboxRuntime;
  key: PrSandboxKey;
  now?: Date;
}): Promise<ReleasePrSandboxSlotResult> {
  const now = input.now ?? new Date();
  const lease = await selectPrSandboxLease(input.key);
  if (!lease) {
    return {
      released: false,
      destroyed: false,
      skippedActiveRun: false,
      sandboxId: null,
    };
  }

  const active = await isSandboxInActiveDelivery(lease.sandbox_id);
  if (active) {
    await markPrSandboxLeaseState({
      leaseId: lease.id,
      state: "released",
      now,
      currentStep: "released-active-run",
    });
    return {
      released: true,
      destroyed: false,
      skippedActiveRun: true,
      sandboxId: lease.sandbox_id,
    };
  }

  const handle = await findSandbox({
    runtime: input.runtime,
    lease,
    key: input.key,
    states: null,
  });
  if (handle) {
    await input.runtime.destroy(handle);
  }
  await markPrSandboxLeaseState({
    leaseId: lease.id,
    state: "released",
    now,
    currentStep: "released",
  });
  return {
    released: true,
    destroyed: Boolean(handle),
    skippedActiveRun: false,
    sandboxId: lease.sandbox_id,
  };
}

export async function currentActiveSandboxCount(input: {
  runtime: DeploymentSandboxRuntime;
  poolId: string;
  limit: number;
}): Promise<number> {
  // Phase A's cap is Daytona sandbox concurrency, not Lambda/Worker runtime
  // pressure. Keep the query global + best-effort until Phase B wires the
  // exact Daytona cap and LRU eviction policy.
  const handles = await input.runtime.findAllByLabels(
    { purpose: "workforce-deploy" },
    { states: ["STARTED"], limit: input.limit + 1, owned: true },
  );
  return handles.length;
}

export function createDaytonaPrSandboxSlotAdmission(input: {
  runtime: DeploymentSandboxRuntime;
  isReentrant?: (leaseKey: string) => boolean | Promise<boolean>;
}): PrSandboxSlotAdmission {
  return {
    async acquirePrSandboxSlot(leaseKey, options) {
      if (await input.isReentrant?.(leaseKey)) {
        return { granted: true, retryAfterMs: null };
      }
      const activeCount = await currentActiveSandboxCount({
        runtime: input.runtime,
        poolId: options.poolId,
        limit: options.cap,
      });
      return activeCount >= options.cap
        ? { granted: false, retryAfterMs: Math.max(1, options.ttlMs) }
        : { granted: true, retryAfterMs: null };
    },
    async releasePrSandboxSlot() {
      // Interim Daytona-counting admission is stateless. Pear's shared DO
      // primitive will make this release meaningful; the Phase A method is
      // intentionally idempotent so the later swap is mechanical.
    },
    currentActiveCount(poolId) {
      return currentActiveSandboxCount({
        runtime: input.runtime,
        poolId,
        limit: DEFAULT_PR_SANDBOX_ACTIVE_LIMIT,
      });
    },
  };
}

export async function acquirePrSandbox(
  input: AcquirePrSandboxInput,
): Promise<AcquirePrSandboxResult> {
  const key: PrSandboxKey = {
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    repoFullName: input.repoFullName,
    prNumber: input.prNumber,
  };
  const now = input.now ?? new Date();
  const idleTtlSeconds = resolveIdleTtlSeconds(input.idleTtlSeconds);
  const idleBefore = new Date(now.getTime() - idleTtlSeconds * 1000);
  const leaseUntil = new Date(now.getTime() + Math.max(1, input.leaseTtlSeconds) * 1000);
  const existing = await selectPrSandboxLease(key);
  const leaseKey = prSandboxLeaseKey(key);
  await stopIdleExpiredPrSandboxes({
    runtime: input.runtime,
    now,
    idleBefore,
    limit: input.activeSandboxLimit ?? DEFAULT_PR_SANDBOX_ACTIVE_LIMIT,
  });
  const slotAdmission = input.slotAdmission ?? createDaytonaPrSandboxSlotAdmission({
    runtime: input.runtime,
    isReentrant: (candidate) => candidate === leaseKey && isWarmLeaseStillAdmitted({
      lease: existing,
      now,
      idleBefore,
    }),
  });
  const limit = input.activeSandboxLimit ?? DEFAULT_PR_SANDBOX_ACTIVE_LIMIT;
  const slotOptions = {
    ttlMs: Math.max(1, input.leaseTtlSeconds) * 1000,
    poolId: input.slotPoolId ?? PR_SANDBOX_SLOT_POOL_ID,
    cap: limit,
  };
  let slot = await slotAdmission.acquirePrSandboxSlot(leaseKey, slotOptions);
  if (!slot.granted) {
    const evicted = await evictLeastRecentlyUsedPrSandbox({
      runtime: input.runtime,
      excludeKey: key,
      now,
      slotAdmission,
    });
    if (!evicted) {
      throw new Error("PR sandbox active cap reached and no evictable warm lease was available");
    }
    slot = await slotAdmission.acquirePrSandboxSlot(leaseKey, slotOptions);
    if (!slot.granted) {
      throw new Error("PR sandbox active cap reached after evicting a warm lease");
    }
    console.info("[pr-sandbox-lease] active sandbox cap reached; evicted least recently used warm lease", {
      leaseKey,
      retryAfterMs: slot.retryAfterMs ?? null,
      limit,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      repoFullName: input.repoFullName,
      prNumber: input.prNumber,
    });
  }
  // Snapshot-version gate: only reuse a warm box that was provisioned from the
  // SAME Daytona snapshot we'd provision fresh from now. The snapshot name IS
  // the version identity (it embeds the relayfile-mount version), so once
  // RELAYFILE_MOUNT_VERSION is bumped + the snapshot rebuilt, every still-warm
  // box recorded under the old snapshot fails this check and is re-provisioned
  // instead of silently running the old binary. A NULL snapshot_version (legacy
  // rows written before this column existed) is treated as a mismatch — we
  // can't prove it's current — so it re-provisions exactly once. This single
  // row check gates BOTH reuse vectors inside findStartedSandbox (getById +
  // findByLabels).
  const snapshotMatches = existing?.snapshot_version === input.snapshotVersion;
  if (existing && !snapshotMatches) {
    console.info("[pr-sandbox-lease] skipping warm reuse on snapshot mismatch; provisioning fresh", {
      leaseKey,
      leasedSnapshotVersion: existing.snapshot_version,
      currentSnapshotVersion: input.snapshotVersion,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      repoFullName: input.repoFullName,
      prNumber: input.prNumber,
    });
    const staleHandle = await findSandbox({
      runtime: input.runtime,
      lease: existing,
      key,
      states: null,
    });
    if (staleHandle) {
      await input.runtime.destroy(staleHandle);
    }
  }
  if (existing && snapshotMatches) {
    const handle = await findSandbox({
      runtime: input.runtime,
      lease: existing,
      key,
      states: null,
    });
    if (handle) {
      const readyHandle = isStarted(handle)
        ? handle
        : isStopped(handle)
          ? await startPrSandbox({ runtime: input.runtime, handle })
          : null;
      if (!readyHandle) {
        throw new Error(`PR sandbox lease ${leaseKey} points at sandbox ${handle.id} in unsupported state ${handle.state ?? "unknown"}`);
      }
      await touchPrSandboxLease({
        leaseId: existing.id,
        leaseUntil,
        now,
      });
      return {
        handle: readyHandle,
        sandboxName: existing.sandbox_name,
        reused: true,
      };
    }
  }

  const sandboxName = buildPrSandboxName(key);
  const handle = await input.createSandbox({
    sandboxName,
    labels: {
      ...prSandboxLabels(key),
      sandboxName,
    },
  });
  await upsertPrSandboxLease({
    key,
    sandboxId: handle.id,
    sandboxName,
    leaseUntil,
    now,
    snapshotVersion: input.snapshotVersion,
  });
  return { handle, sandboxName, reused: false };
}
