import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  createDeploymentSandboxRuntime,
  type DeploymentSandboxRuntime,
} from "@/lib/proactive-runtime/sandbox-runtime";
import {
  reapConversationSandboxLeases,
} from "@/lib/proactive-runtime/conversation-sandbox-lease";

const DEPLOYMENT_SANDBOX_LIST_LIMIT = 50;
const RECYCLE_DESTROY_CONCURRENCY = 6;
const WARM_POOL_DRAIN_DESTROY_CONCURRENCY = 50;
const STOPPED_REAPER_DESTROY_CONCURRENCY = 10;
const RELEASED_LEASE_DESTROY_CONCURRENCY = 10;
const STOPPED_REAPER_PAGE_SIZE = 100;
const RELEASED_LEASE_REAPER_LIMIT = 100;
const DEFAULT_STOPPED_REAPER_MIN_AGE_HOURS = 4;
// The proactive PR warm pool is the set of STARTED boxes carrying these two
// labels (see prSandboxLabels in pr-sandbox-lease.ts). Draining it = destroying
// those boxes so the next fire re-provisions fresh from the current snapshot.
const PR_WARM_POOL_LABELS = {
  purpose: "workforce-deploy",
  warmLease: "pull-request",
} as const;
const PROACTIVE_SANDBOX_LABELS = {
  purpose: "workforce-deploy",
} as const;
const WARM_POOL_DRAIN_LIST_LIMIT = 500;

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function affectedRowCount(result: unknown): number {
  const rowCount = (result as { rowCount?: unknown } | null)?.rowCount;
  return typeof rowCount === "number" ? rowCount : rowsOf(result).length;
}

export type RecycleDeploymentSandboxesResult = {
  deleted: number;
  failed: string[];
};

export type DrainPrSandboxWarmPoolResult = {
  found: number;
  deleted: number;
  failed: string[];
  leasesCleared: number;
};

export type ReapStoppedSandboxesResult = {
  found: number;
  eligible: number;
  deleted: number;
  failed: string[];
  skippedTooYoung: number;
  skippedMissingCreatedAt: number;
  skippedActiveLease: number;
  releasedFound: number;
  releasedDeleted: number;
  releasedFailed: string[];
  releasedSkippedActiveRun: number;
  conversationIdleFound: number;
  conversationIdleStopped: number;
  conversationCleanupFound: number;
  conversationCleanupDestroyed: number;
  conversationCleanupReleased: number;
  conversationCleanupFailed: string[];
  conversationCleanupSkippedActiveRun: number;
  leasesCleared: number;
};

type SandboxHandleWithTimestamps = {
  id: string;
  state?: string;
  createdAt?: string;
};

type ReleasedPrSandboxLeaseRow = {
  id: string;
  sandbox_id: string | null;
  active_delivery: boolean;
};

function readPositiveNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function stoppedReaperMinAgeHours(): number {
  return readPositiveNumber(
    process.env.STOPPED_REAPER_MIN_AGE_HOURS?.trim(),
    DEFAULT_STOPPED_REAPER_MIN_AGE_HOURS,
  );
}

function isStopped(handle: { state?: string }): boolean {
  return String(handle.state ?? "").trim().toUpperCase() === "STOPPED";
}

function createdAtMs(handle: SandboxHandleWithTimestamps): number | null {
  if (!handle.createdAt) return null;
  const timestamp = Date.parse(handle.createdAt);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function logDestroyFailure(input: {
  logPrefix: string;
  sandboxId: string;
  reason: unknown;
}): void {
  console.error(`${input.logPrefix}: failed to destroy sandbox ${input.sandboxId}`, {
    error: input.reason instanceof Error
      ? input.reason.stack ?? input.reason.message
      : String(input.reason),
  });
}

async function activePrLeaseSandboxIds(input: {
  sandboxIds: string[];
  now: Date;
}): Promise<Set<string>> {
  if (input.sandboxIds.length === 0) {
    return new Set();
  }
  const sandboxIdList = sql.join(input.sandboxIds.map((id) => sql`${id}`), sql`, `);
  const result = await getDb().execute(sql`
    SELECT sandbox_id
    FROM pr_sandbox_leases
    WHERE sandbox_id IN (${sandboxIdList})
      AND state IN ('warm', 'idle')
      AND (lease_until IS NULL OR lease_until > ${input.now})
  `);
  return new Set(
    rowsOf<{ sandbox_id: string | null }>(result)
      .map((row) => row.sandbox_id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
}

async function clearPrSandboxLeaseRows(input: {
  sandboxIds: string[];
  logPrefix: string;
}): Promise<number> {
  if (input.sandboxIds.length === 0) {
    return 0;
  }
  try {
    const sandboxIdList = sql.join(input.sandboxIds.map((id) => sql`${id}`), sql`, `);
    const result = await getDb().execute(sql`
      DELETE FROM pr_sandbox_leases
      WHERE sandbox_id IN (${sandboxIdList})
      RETURNING id
    `);
    return affectedRowCount(result);
  } catch (error) {
    console.warn(`${input.logPrefix}: lease-row cleanup failed (non-fatal)`, {
      destroyedCount: input.sandboxIds.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

async function releasedPrSandboxLeaseRows(input: {
  limit: number;
}): Promise<ReleasedPrSandboxLeaseRow[]> {
  const result = await getDb().execute(sql`
    SELECT
      id,
      sandbox_id,
      EXISTS (
        SELECT 1
        FROM integration_watch_deliveries
        WHERE integration_watch_deliveries.run_sandbox_id = pr_sandbox_leases.sandbox_id
          AND integration_watch_deliveries.status IN ('running', 'processing')
      ) AS active_delivery
    FROM pr_sandbox_leases
    WHERE state = 'released'
      AND sandbox_id IS NOT NULL
    ORDER BY updated_at ASC
    LIMIT ${input.limit}
  `);
  return rowsOf<ReleasedPrSandboxLeaseRow>(result);
}

async function findSandboxById(input: {
  runtime: DeploymentSandboxRuntime;
  sandboxId: string;
}): Promise<SandboxHandleWithTimestamps | null> {
  if (input.runtime.getById) {
    return input.runtime.getById(input.sandboxId, {
      states: null,
      owned: true,
    }) as Promise<SandboxHandleWithTimestamps | null>;
  }
  const handles = await input.runtime.findAllByLabels(
    { ...PR_WARM_POOL_LABELS },
    { states: null, limit: WARM_POOL_DRAIN_LIST_LIMIT, owned: true },
  );
  return (handles.find((handle) => handle.id === input.sandboxId) as SandboxHandleWithTimestamps | undefined) ?? null;
}

async function reapReleasedPrSandboxLeases(input: {
  runtime: DeploymentSandboxRuntime;
  clearLeases: boolean;
}): Promise<{
  found: number;
  deleted: number;
  failed: string[];
  skippedActiveRun: number;
  leasesCleared: number;
}> {
  const leases = await releasedPrSandboxLeaseRows({ limit: RELEASED_LEASE_REAPER_LIMIT });
  const activeLeases = leases.filter((lease) => lease.active_delivery);
  const eligibleLeases = leases.filter((lease) => !lease.active_delivery && lease.sandbox_id);
  const handles = await Promise.all(
    eligibleLeases.map(async (lease) => ({
      lease,
      handle: lease.sandbox_id
        ? await findSandboxById({ runtime: input.runtime, sandboxId: lease.sandbox_id })
        : null,
    })),
  );

  let deleted = 0;
  const failed: string[] = [];
  const clearSandboxIds: string[] = [];
  for (let i = 0; i < handles.length; i += RELEASED_LEASE_DESTROY_CONCURRENCY) {
    const batch = handles.slice(i, i + RELEASED_LEASE_DESTROY_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async ({ lease, handle }) => {
        if (handle) {
          await input.runtime.destroy(handle);
        }
        return lease.sandbox_id;
      }),
    );
    results.forEach((result, index) => {
      const sandboxId = batch[index].lease.sandbox_id;
      if (result.status === "fulfilled") {
        if (batch[index].handle) {
          deleted += 1;
        }
        if (sandboxId) {
          clearSandboxIds.push(sandboxId);
        }
      } else if (sandboxId) {
        failed.push(sandboxId);
        logDestroyFailure({
          logPrefix: "[sandbox-reaper] released PR lease reaper",
          sandboxId,
          reason: result.reason,
        });
      }
    });
  }

  const leasesCleared = input.clearLeases
    ? await clearPrSandboxLeaseRows({
      sandboxIds: clearSandboxIds,
      logPrefix: "[sandbox-reaper] released PR lease reaper",
    })
    : 0;

  return {
    found: leases.length,
    deleted,
    failed,
    skippedActiveRun: activeLeases.length,
    leasesCleared,
  };
}

export async function recycleDeploymentSandboxes(input: {
  workspaceId: string;
  agentId: string;
  runtime?: DeploymentSandboxRuntime;
}): Promise<RecycleDeploymentSandboxesResult> {
  const runtime = input.runtime ?? createDeploymentSandboxRuntime();
  // Daytona list is cursor-paginated; recycle must delete every warm sandbox for the agent.
  const handles = await runtime.findAllByLabels(
    {
      purpose: "workforce-deploy",
      workspaceId: input.workspaceId,
      agentId: input.agentId,
    },
    { states: ["STARTED"], limit: DEPLOYMENT_SANDBOX_LIST_LIMIT, owned: true },
  );

  let deleted = 0;
  const failed: string[] = [];
  for (let i = 0; i < handles.length; i += RECYCLE_DESTROY_CONCURRENCY) {
    const batch = handles.slice(i, i + RECYCLE_DESTROY_CONCURRENCY);
    const results = await Promise.allSettled(batch.map((handle) => runtime.destroy(handle)));
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        deleted += 1;
      } else {
        const sandboxId = batch[index].id;
        failed.push(sandboxId);
        logDestroyFailure({
          logPrefix: "[deployment-sandbox-recycle]",
          sandboxId,
          reason: result.reason,
        });
      }
    });
  }

  return {
    deleted,
    failed,
  };
}

/**
 * Reap old STOPPED proactive sandboxes so Daytona disk usage cannot accumulate
 * indefinitely. This is deliberately narrower than an org-wide cleanup: only
 * boxes carrying `purpose=workforce-deploy` are considered, STARTED and
 * transitional states are excluded at both the Daytona query and local filter,
 * and active PR-lease rows protect any stopped box still expected by a warm
 * lease.
 */
export async function reapStoppedSandboxes(input: {
  runtime?: DeploymentSandboxRuntime;
  minAgeHours?: number;
  now?: Date;
  clearLeases?: boolean;
} = {}): Promise<ReapStoppedSandboxesResult> {
  const runtime = input.runtime ?? createDeploymentSandboxRuntime();
  const now = input.now ?? new Date();
  const minAgeHours = input.minAgeHours ?? stoppedReaperMinAgeHours();
  const minAgeMs = Math.max(0, minAgeHours) * 60 * 60 * 1000;
  const clearLeases = input.clearLeases ?? true;
  // Daytona SDK `limit` is a per-page fetch size and `daytona.list()` follows
  // `nextCursor`; `findAllByLabels` drains that async iterator. Do not add a
  // total cap here: the production incident had a STOPPED backlog larger than a
  // single Daytona page.
  const handles = await runtime.findAllByLabels(
    { ...PROACTIVE_SANDBOX_LABELS },
    { states: ["STOPPED"], pageSize: STOPPED_REAPER_PAGE_SIZE, owned: true },
  );

  let skippedTooYoung = 0;
  let skippedMissingCreatedAt = 0;
  const oldStoppedHandles = handles.filter((handle) => {
    if (!isStopped(handle)) {
      return false;
    }
    const created = createdAtMs(handle as SandboxHandleWithTimestamps);
    if (created === null) {
      skippedMissingCreatedAt += 1;
      return false;
    }
    if (now.getTime() - created < minAgeMs) {
      skippedTooYoung += 1;
      return false;
    }
    return true;
  });

  const activeLeaseIds = await activePrLeaseSandboxIds({
    sandboxIds: oldStoppedHandles.map((handle) => handle.id),
    now,
  });
  const eligibleHandles = oldStoppedHandles.filter((handle) => !activeLeaseIds.has(handle.id));

  let deleted = 0;
  const failed: string[] = [];
  const destroyedIds: string[] = [];
  for (let i = 0; i < eligibleHandles.length; i += STOPPED_REAPER_DESTROY_CONCURRENCY) {
    const batch = eligibleHandles.slice(i, i + STOPPED_REAPER_DESTROY_CONCURRENCY);
    const results = await Promise.allSettled(batch.map((handle) => runtime.destroy(handle)));
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        deleted += 1;
        destroyedIds.push(batch[index].id);
      } else {
        const sandboxId = batch[index].id;
        failed.push(sandboxId);
        logDestroyFailure({
          logPrefix: "[sandbox-reaper] stopped-box reaper",
          sandboxId,
          reason: result.reason,
        });
      }
    });
  }

  const leasesCleared = clearLeases
    ? await clearPrSandboxLeaseRows({
      sandboxIds: destroyedIds,
      logPrefix: "[sandbox-reaper] stopped-box reaper",
    })
    : 0;
  const releasedReap = await reapReleasedPrSandboxLeases({ runtime, clearLeases });
  const conversationReap = await reapConversationSandboxLeases({
    runtime,
    now,
    stoppedMinAgeHours: minAgeHours,
  });

  return {
    found: handles.filter(isStopped).length,
    eligible: eligibleHandles.length,
    deleted,
    failed,
    skippedTooYoung,
    skippedMissingCreatedAt,
    skippedActiveLease: activeLeaseIds.size,
    releasedFound: releasedReap.found,
    releasedDeleted: releasedReap.deleted,
    releasedFailed: releasedReap.failed,
    releasedSkippedActiveRun: releasedReap.skippedActiveRun,
    conversationIdleFound: conversationReap.idleFound,
    conversationIdleStopped: conversationReap.idleStopped,
    conversationCleanupFound: conversationReap.cleanupFound,
    conversationCleanupDestroyed: conversationReap.cleanupDestroyed,
    conversationCleanupReleased: conversationReap.cleanupReleased,
    conversationCleanupFailed: conversationReap.cleanupFailed,
    conversationCleanupSkippedActiveRun: conversationReap.cleanupSkippedActiveRun,
    leasesCleared: leasesCleared + releasedReap.leasesCleared,
  };
}

/**
 * Drain the proactive PR warm pool: destroy every STARTED box carrying the
 * warm-pool labels (across all workspaces/agents) so subsequent fires
 * re-provision fresh from the current Daytona snapshot.
 *
 * This is the one-call release fallback for a RELAYFILE_MOUNT_VERSION bump when
 * the snapshot-version-aware lease gate is not yet deployed: destroying the box
 * invalidates BOTH reuse vectors in pr-sandbox-lease.ts (getById(sandbox_id)→null
 * and findByLabels(STARTED)→none). Once the version-aware gate IS deployed, a
 * bump auto-recycles and this becomes belt-and-suspenders / ad-hoc ops.
 *
 * NOTE: this is a DELIBERATE recycle, not idle-only — a box that is mid-delivery
 * will be destroyed. That is acceptable for a release recycle (pre-fix runs are
 * failing anyway); callers must not invoke it as a routine cleanup.
 */
export async function drainPrSandboxWarmPool(input: {
  runtime?: DeploymentSandboxRuntime;
  clearLeases?: boolean;
} = {}): Promise<DrainPrSandboxWarmPoolResult> {
  const runtime = input.runtime ?? createDeploymentSandboxRuntime();
  const clearLeases = input.clearLeases ?? true;
  const handles = await runtime.findAllByLabels(
    { ...PR_WARM_POOL_LABELS },
    { states: ["STARTED"], limit: WARM_POOL_DRAIN_LIST_LIMIT, owned: true },
  );

  let deleted = 0;
  const failed: string[] = [];
  const destroyedIds: string[] = [];
  for (let i = 0; i < handles.length; i += WARM_POOL_DRAIN_DESTROY_CONCURRENCY) {
    const batch = handles.slice(i, i + WARM_POOL_DRAIN_DESTROY_CONCURRENCY);
    const results = await Promise.allSettled(batch.map((handle) => runtime.destroy(handle)));
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        deleted += 1;
        destroyedIds.push(batch[index].id);
      } else {
        const sandboxId = batch[index].id;
        failed.push(sandboxId);
        logDestroyFailure({
          logPrefix: "[pr-sandbox-lease] warm-pool drain",
          sandboxId,
          reason: result.reason,
        });
      }
    });
  }

  // Best-effort: clear the lease rows for the boxes we actually destroyed so the
  // pool stays clean. Inert rows would not cause incorrect reuse (the box is
  // gone → getById/findByLabels return nothing), so a failure here is non-fatal.
  const leasesCleared = clearLeases
    ? await clearPrSandboxLeaseRows({
      sandboxIds: destroyedIds,
      logPrefix: "[pr-sandbox-lease] warm-pool drain",
    })
    : 0;

  return {
    found: handles.length,
    deleted,
    failed,
    leasesCleared,
  };
}
