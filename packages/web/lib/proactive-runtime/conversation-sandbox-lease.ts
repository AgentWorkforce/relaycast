import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { RuntimeHandle } from "@cloud/core/runtime/daytona.js";
import { getDb } from "@/lib/db";
import { normalizeSlackChannelId } from "@/lib/integrations/slack-channel-id";
import type { DeploymentSandboxRuntime } from "@/lib/proactive-runtime/sandbox-runtime";

export const DEFAULT_CONVERSATION_SANDBOX_MAX_WARM_PER_WORKSPACE = 5;
export const DEFAULT_CONVERSATION_SANDBOX_IDLE_TTL_SECONDS = 10 * 60;
export const CONVERSATION_SANDBOX_SLOT_POOL_PREFIX = "daytona-sandbox:conversation";
export const CONVERSATION_SANDBOX_READY_STEP = "sandbox-ready";
const MIN_CONVERSATION_SANDBOX_IDLE_TTL_SECONDS = 5 * 60;
const MAX_CONVERSATION_SANDBOX_IDLE_TTL_SECONDS = 15 * 60;
const SANDBOX_NAME_MAX_LENGTH = 63;
const CLAIM_WAIT_ATTEMPTS = 20;
const CLAIM_WAIT_DELAY_MS = 250;

export type ConversationSandboxLeaseState = "warming" | "in_use" | "warm" | "idle" | "released" | "evicted";

export class ConversationSandboxLeaseBusyError extends Error {
  constructor(readonly leaseKey: string) {
    super(`Conversation sandbox lease is already in use: ${leaseKey}`);
    this.name = "ConversationSandboxLeaseBusyError";
  }
}

export type ConversationSandboxKey = {
  workspaceId: string;
  deploymentId: string;
  agentId: string;
  conversationKey: string;
};

export type ConversationSandboxCreateInput = {
  sandboxName: string;
  labels: Record<string, string>;
};

export type ConversationSandboxSlotAcquireOptions = {
  ttlMs: number;
  poolId: string;
  cap: number;
  workspaceId: string;
};

export type ConversationSandboxSlotAcquireResult = {
  granted: boolean;
  retryAfterMs?: number | null;
};

export type ConversationSandboxSlotAdmission = {
  acquireConversationSandboxSlot(
    leaseKey: string,
    options: ConversationSandboxSlotAcquireOptions,
  ): Promise<ConversationSandboxSlotAcquireResult>;
  releaseConversationSandboxSlot(leaseKey: string): Promise<void>;
  currentActiveCount(workspaceId: string): Promise<number>;
};

type ConversationSandboxLeaseRow = {
  id: string;
  workspace_id: string;
  deployment_id: string;
  agent_id: string;
  conversation_key: string;
  harness_session_id: string;
  sandbox_id: string | null;
  sandbox_name: string;
  state: ConversationSandboxLeaseState;
  lease_until: Date | string | null;
  last_used_at: Date | string;
  attempt_count: number;
  current_step: string | null;
  snapshot_version: string | null;
  updated_at?: Date | string;
};

export type AcquireConversationSandboxInput = ConversationSandboxKey & {
  runtime: DeploymentSandboxRuntime;
  leaseTtlSeconds: number;
  idleTtlSeconds?: number;
  snapshotVersion: string;
  maxWarmPerWorkspace?: number;
  slotAdmission?: ConversationSandboxSlotAdmission;
  slotPoolId?: string;
  createSandbox(input: ConversationSandboxCreateInput): Promise<RuntimeHandle>;
  now?: Date;
};

export type AcquireConversationSandboxResult = {
  handle: RuntimeHandle;
  sandboxName: string;
  harnessSessionId: string;
  reused: boolean;
};

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function affectedRowCount(result: unknown): number {
  const rowCount = (result as { rowCount?: unknown } | null)?.rowCount;
  if (typeof rowCount === "number") return rowCount;
  const affectedRows = (result as { affectedRows?: unknown } | null)?.affectedRows;
  if (typeof affectedRows === "number") return affectedRows;
  return rowsOf(result).length;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortToken(value: string, length = 8): string {
  return value.replace(/[^a-zA-Z0-9]/gu, "").toLowerCase().slice(0, length) || "unknown";
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function resolveIdleTtlSeconds(input: number | undefined): number {
  const raw = typeof input === "number" && Number.isFinite(input) && input > 0
    ? input
    : readPositiveInteger(
        process.env.CONVERSATION_SANDBOX_IDLE_TTL_SECONDS?.trim(),
        DEFAULT_CONVERSATION_SANDBOX_IDLE_TTL_SECONDS,
      );
  return clampInteger(
    raw,
    MIN_CONVERSATION_SANDBOX_IDLE_TTL_SECONDS,
    MAX_CONVERSATION_SANDBOX_IDLE_TTL_SECONDS,
  );
}

function resolveMaxWarmPerWorkspace(input: number | undefined): number {
  const raw = typeof input === "number" && Number.isFinite(input) && input > 0
    ? input
    : readPositiveInteger(
        process.env.CONVERSATION_SANDBOX_MAX_WARM_PER_WORKSPACE?.trim(),
        DEFAULT_CONVERSATION_SANDBOX_MAX_WARM_PER_WORKSPACE,
      );
  return Math.floor(raw);
}

function timeValue(value: Date | string | null): number | null {
  if (!value) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function isWarmLeaseStillAdmitted(input: {
  lease: ConversationSandboxLeaseRow | null;
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

function isSameKeyLeaseStillAdmitted(input: {
  lease: ConversationSandboxLeaseRow | null;
  key: ConversationSandboxKey;
  now: Date;
  idleBefore: Date;
}): boolean {
  if (!input.lease || !isSameConversationKey(input.key, input.lease)) {
    return false;
  }
  if (["warming", "in_use", "evicted", "released"].includes(input.lease.state)) {
    return true;
  }
  if (input.lease.state === "idle") {
    return true;
  }
  return isWarmLeaseStillAdmitted({
    lease: input.lease,
    now: input.now,
    idleBefore: input.idleBefore,
  });
}

function isSameConversationKey(
  left: ConversationSandboxKey,
  right: Pick<ConversationSandboxLeaseRow, "workspace_id" | "agent_id" | "conversation_key">,
): boolean {
  return left.workspaceId === right.workspace_id &&
    left.agentId === right.agent_id &&
    left.conversationKey === right.conversation_key;
}

export function buildSlackConversationKey(input: {
  channel: string;
  threadTs: string;
}): string {
  return `${normalizeSlackChannelId(input.channel)}:${input.threadTs}`;
}

export function buildConversationSandboxName(input: ConversationSandboxKey): string {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
  return [
    "conv",
    shortToken(input.workspaceId),
    shortToken(input.agentId),
    shortToken(input.deploymentId),
    suffix,
  ].join("-").slice(0, SANDBOX_NAME_MAX_LENGTH);
}

export function conversationSandboxLabels(input: ConversationSandboxKey): Record<string, string> {
  return {
    purpose: "workforce-deploy",
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    conversationKey: input.conversationKey,
    warmLease: "conversational",
  };
}

export function conversationSandboxLeaseKey(input: ConversationSandboxKey): string {
  return [
    input.workspaceId,
    input.agentId,
    input.conversationKey,
  ].join("/");
}

export function createConversationHarnessSessionId(): string {
  return randomUUID();
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
  lease: ConversationSandboxLeaseRow;
  key: ConversationSandboxKey;
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
      ...conversationSandboxLabels(input.key),
      sandboxName: input.lease.sandbox_name,
    },
    { states: ["STARTED"], limit: 1, owned: true },
  );
  return isStarted(handle) ? handle : null;
}

async function findSandbox(input: {
  runtime: DeploymentSandboxRuntime;
  lease: ConversationSandboxLeaseRow;
  key: ConversationSandboxKey;
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
      ...conversationSandboxLabels(input.key),
      sandboxName: input.lease.sandbox_name,
    },
    { states: input.states ?? null, limit: 1, owned: true },
  );
}

async function selectConversationSandboxLease(
  key: ConversationSandboxKey,
): Promise<ConversationSandboxLeaseRow | null> {
  const result = await getDb().execute(sql`
    SELECT
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
      updated_at
    FROM conversation_sandbox_leases
    WHERE workspace_id = ${key.workspaceId}
      AND agent_id = ${key.agentId}
      AND conversation_key = ${key.conversationKey}
      AND state IN ('warming', 'in_use', 'warm', 'idle', 'evicted', 'released')
    LIMIT 1
  `);
  return rowsOf<ConversationSandboxLeaseRow>(result)[0] ?? null;
}

async function selectLeastRecentlyUsedEvictableLease(input: {
  workspaceId: string;
  excludeKey: ConversationSandboxKey;
}): Promise<ConversationSandboxLeaseRow | null> {
  const result = await getDb().execute(sql`
    SELECT
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
      snapshot_version
    FROM conversation_sandbox_leases
    WHERE workspace_id = ${input.workspaceId}
      AND state IN ('warm', 'idle')
      AND sandbox_id IS NOT NULL
      AND NOT (
        workspace_id = ${input.excludeKey.workspaceId}
        AND agent_id = ${input.excludeKey.agentId}
        AND conversation_key = ${input.excludeKey.conversationKey}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM integration_watch_deliveries
        WHERE integration_watch_deliveries.run_sandbox_id = conversation_sandbox_leases.sandbox_id
          AND integration_watch_deliveries.status IN ('running', 'processing')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM deployment_tick_deliveries
        WHERE deployment_tick_deliveries.run_sandbox_id = conversation_sandbox_leases.sandbox_id
          AND deployment_tick_deliveries.status IN ('running', 'processing')
      )
    ORDER BY last_used_at ASC
    LIMIT 1
  `);
  return rowsOf<ConversationSandboxLeaseRow>(result)[0] ?? null;
}

async function selectIdleExpiredLeases(input: {
  workspaceId?: string;
  excludeKey?: ConversationSandboxKey;
  now: Date;
  idleBefore: Date;
  limit: number;
}): Promise<ConversationSandboxLeaseRow[]> {
  const result = await getDb().execute(sql`
    SELECT
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
      updated_at
    FROM conversation_sandbox_leases
    WHERE (${input.workspaceId ?? null}::text IS NULL OR workspace_id = ${input.workspaceId ?? null})
      AND state = 'warm'
      AND sandbox_id IS NOT NULL
      AND lease_until IS NOT NULL
      AND lease_until <= ${input.now}
      AND last_used_at <= ${input.idleBefore}
      AND NOT (
        ${input.excludeKey?.workspaceId ?? null}::text IS NOT NULL
        AND workspace_id = ${input.excludeKey?.workspaceId ?? null}
        AND agent_id = ${input.excludeKey?.agentId ?? null}
        AND conversation_key = ${input.excludeKey?.conversationKey ?? null}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM integration_watch_deliveries
        WHERE integration_watch_deliveries.run_sandbox_id = conversation_sandbox_leases.sandbox_id
          AND integration_watch_deliveries.status IN ('running', 'processing')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM deployment_tick_deliveries
        WHERE deployment_tick_deliveries.run_sandbox_id = conversation_sandbox_leases.sandbox_id
          AND deployment_tick_deliveries.status IN ('running', 'processing')
      )
    ORDER BY last_used_at ASC
    LIMIT ${input.limit}
  `);
  return rowsOf<ConversationSandboxLeaseRow>(result);
}

async function isSandboxInActiveDelivery(sandboxId: string | null): Promise<boolean> {
  if (!sandboxId) return false;
  const result = await getDb().execute(sql`
    SELECT 1
    FROM (
      SELECT run_sandbox_id
      FROM integration_watch_deliveries
      WHERE run_sandbox_id = ${sandboxId}
        AND status IN ('running', 'processing')
      UNION ALL
      SELECT run_sandbox_id
      FROM deployment_tick_deliveries
      WHERE run_sandbox_id = ${sandboxId}
        AND status IN ('running', 'processing')
    ) active_leases
    LIMIT 1
  `);
  return rowsOf<{ "?column?": number }>(result).length > 0;
}

async function isConversationSandboxLeaseLive(input: {
  lease: ConversationSandboxLeaseRow;
  now: Date;
}): Promise<boolean> {
  const leaseUntil = timeValue(input.lease.lease_until);
  if (leaseUntil !== null && leaseUntil > input.now.getTime()) {
    return true;
  }
  return isSandboxInActiveDelivery(input.lease.sandbox_id);
}

async function touchConversationSandboxLease(input: {
  leaseId: string;
  deploymentId: string;
  leaseUntil: Date;
  now: Date;
}): Promise<boolean> {
  const result = await getDb().execute(sql`
    UPDATE conversation_sandbox_leases
    SET
      deployment_id = ${input.deploymentId},
      state = 'in_use',
      lease_until = ${input.leaseUntil},
      last_used_at = ${input.now},
      attempt_count = attempt_count + 1,
      current_step = ${CONVERSATION_SANDBOX_READY_STEP},
      updated_at = ${input.now}
    WHERE id = ${input.leaseId}
      AND state IN ('warm', 'idle')
      AND current_step IS DISTINCT FROM 'idle-stopping'
      AND current_step IS DISTINCT FROM 'lru-evicting'
  `);
  return affectedRowCount(result) > 0;
}

async function insertConversationSandboxProvisionClaim(input: {
  key: ConversationSandboxKey;
  harnessSessionId: string;
  sandboxName: string;
  leaseUntil: Date;
  now: Date;
  snapshotVersion: string;
}): Promise<ConversationSandboxLeaseRow | null> {
  const result = await getDb().execute(sql`
    INSERT INTO conversation_sandbox_leases (
      workspace_id,
      deployment_id,
      agent_id,
      conversation_key,
      harness_session_id,
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
      ${input.key.deploymentId},
      ${input.key.agentId},
      ${input.key.conversationKey},
      ${input.harnessSessionId},
      ${input.sandboxName},
      'warming',
      ${input.leaseUntil},
      ${input.now},
      0,
      'provisioning',
      ${input.snapshotVersion},
      ${input.now},
      ${input.now}
    )
    ON CONFLICT (workspace_id, agent_id, conversation_key)
    DO NOTHING
    RETURNING
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
      updated_at
  `);
  return rowsOf<ConversationSandboxLeaseRow>(result)[0] ?? null;
}

async function claimExistingConversationSandboxProvision(input: {
  lease: ConversationSandboxLeaseRow;
  key: ConversationSandboxKey;
  sandboxName: string;
  leaseUntil: Date;
  now: Date;
  snapshotVersion: string;
}): Promise<ConversationSandboxLeaseRow | null> {
  const result = await getDb().execute(sql`
    UPDATE conversation_sandbox_leases
    SET
      deployment_id = ${input.key.deploymentId},
      agent_id = ${input.key.agentId},
      sandbox_id = NULL,
      sandbox_name = ${input.sandboxName},
      state = 'warming',
      lease_until = ${input.leaseUntil},
      last_used_at = ${input.now},
      current_step = 'provisioning',
      snapshot_version = ${input.snapshotVersion},
      updated_at = ${input.now}
    WHERE id = ${input.lease.id}
      AND agent_id = ${input.key.agentId}
      AND (
        state IN ('warm', 'idle', 'evicted', 'released')
        OR (
          state IN ('warming', 'in_use')
          AND (
            lease_until IS NULL
            OR lease_until <= ${input.now}
          )
          -- Defense in depth: acquire's live gate normally blocks active deliveries before this reclaim CAS.
          AND NOT EXISTS (
            SELECT 1
            FROM integration_watch_deliveries
            WHERE integration_watch_deliveries.run_sandbox_id = conversation_sandbox_leases.sandbox_id
              AND integration_watch_deliveries.status IN ('running', 'processing')
          )
          AND NOT EXISTS (
            SELECT 1
            FROM deployment_tick_deliveries
            WHERE deployment_tick_deliveries.run_sandbox_id = conversation_sandbox_leases.sandbox_id
              AND deployment_tick_deliveries.status IN ('running', 'processing')
          )
        )
      )
      AND sandbox_id IS NOT DISTINCT FROM ${input.lease.sandbox_id}
      AND current_step IS DISTINCT FROM 'idle-stopping'
      AND current_step IS DISTINCT FROM 'lru-evicting'
      AND current_step IS DISTINCT FROM 'released-destroying'
    RETURNING
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
      updated_at
  `);
  const row = rowsOf<ConversationSandboxLeaseRow>(result)[0];
  if (row) return row;
  if (affectedRowCount(result) > 0) {
    return {
      ...input.lease,
      deployment_id: input.key.deploymentId,
      sandbox_id: null,
      sandbox_name: input.sandboxName,
      state: "warming",
      lease_until: input.leaseUntil,
      last_used_at: input.now,
      current_step: "provisioning",
      snapshot_version: input.snapshotVersion,
      updated_at: input.now,
    };
  }
  return null;
}

async function completeConversationSandboxProvision(input: {
  leaseId: string;
  sandboxId: string;
  now: Date;
}): Promise<boolean> {
  const result = await getDb().execute(sql`
    UPDATE conversation_sandbox_leases
    SET
      sandbox_id = ${input.sandboxId},
      state = 'in_use',
      attempt_count = attempt_count + 1,
      current_step = ${CONVERSATION_SANDBOX_READY_STEP},
      updated_at = ${input.now}
    WHERE id = ${input.leaseId}
      AND state = 'warming'
  `);
  return affectedRowCount(result) > 0;
}

async function deleteConversationSandboxProvisionClaim(input: {
  leaseId: string;
}): Promise<void> {
  await getDb().execute(sql`
    DELETE FROM conversation_sandbox_leases
    WHERE id = ${input.leaseId}
      AND state = 'warming'
      AND sandbox_id IS NULL
  `);
}

async function markConversationSandboxLeaseState(input: {
  leaseId: string;
  state: ConversationSandboxLeaseState;
  now: Date;
  currentStep?: string | null;
  leaseUntil?: Date | null;
}): Promise<boolean> {
  const result = await getDb().execute(sql`
    UPDATE conversation_sandbox_leases
    SET
      state = ${input.state},
      lease_until = ${input.leaseUntil ?? null},
      current_step = ${input.currentStep ?? input.state},
      updated_at = ${input.now}
    WHERE id = ${input.leaseId}
  `);
  return affectedRowCount(result) > 0;
}

async function claimIdleExpiredConversationSandbox(input: {
  lease: ConversationSandboxLeaseRow;
  now: Date;
  idleBefore: Date;
}): Promise<boolean> {
  const result = await getDb().execute(sql`
    UPDATE conversation_sandbox_leases
    SET
      state = 'idle',
      lease_until = NULL,
      current_step = 'idle-stopping',
      updated_at = ${input.now}
    WHERE id = ${input.lease.id}
      AND state = 'warm'
      AND sandbox_id IS NOT DISTINCT FROM ${input.lease.sandbox_id}
      AND lease_until IS NOT NULL
      AND lease_until <= ${input.now}
      AND last_used_at <= ${input.idleBefore}
      AND NOT EXISTS (
        SELECT 1
        FROM integration_watch_deliveries
        WHERE integration_watch_deliveries.run_sandbox_id = conversation_sandbox_leases.sandbox_id
          AND integration_watch_deliveries.status IN ('running', 'processing')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM deployment_tick_deliveries
        WHERE deployment_tick_deliveries.run_sandbox_id = conversation_sandbox_leases.sandbox_id
          AND deployment_tick_deliveries.status IN ('running', 'processing')
      )
  `);
  return affectedRowCount(result) > 0;
}

async function claimLeastRecentlyUsedConversationSandboxEviction(input: {
  lease: ConversationSandboxLeaseRow;
  now: Date;
}): Promise<boolean> {
  const result = await getDb().execute(sql`
    UPDATE conversation_sandbox_leases
    SET
      state = 'evicted',
      lease_until = NULL,
      current_step = 'lru-evicting',
      updated_at = ${input.now}
    WHERE id = ${input.lease.id}
      AND state IN ('warm', 'idle')
      AND sandbox_id IS NOT NULL
      AND sandbox_id IS NOT DISTINCT FROM ${input.lease.sandbox_id}
      AND last_used_at <= ${input.lease.last_used_at}
      AND current_step IS DISTINCT FROM 'idle-stopping'
      AND current_step IS DISTINCT FROM 'lru-evicting'
      AND NOT EXISTS (
        SELECT 1
        FROM integration_watch_deliveries
        WHERE integration_watch_deliveries.run_sandbox_id = conversation_sandbox_leases.sandbox_id
          AND integration_watch_deliveries.status IN ('running', 'processing')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM deployment_tick_deliveries
        WHERE deployment_tick_deliveries.run_sandbox_id = conversation_sandbox_leases.sandbox_id
          AND deployment_tick_deliveries.status IN ('running', 'processing')
      )
  `);
  return affectedRowCount(result) > 0;
}

async function stopConversationSandbox(input: {
  runtime: DeploymentSandboxRuntime;
  handle: RuntimeHandle;
}): Promise<void> {
  if (!input.runtime.stop) {
    throw new Error("Deployment sandbox runtime does not support stop");
  }
  await input.runtime.stop(input.handle);
}

async function startConversationSandbox(input: {
  runtime: DeploymentSandboxRuntime;
  handle: RuntimeHandle;
}): Promise<RuntimeHandle> {
  if (!input.runtime.start) {
    throw new Error("Deployment sandbox runtime does not support start");
  }
  return input.runtime.start(input.handle);
}

async function stopIdleExpiredConversationSandboxes(input: {
  runtime: DeploymentSandboxRuntime;
  workspaceId?: string;
  excludeKey?: ConversationSandboxKey;
  now: Date;
  idleBefore: Date;
  limit: number;
}): Promise<number> {
  const leases = await selectIdleExpiredLeases({
    workspaceId: input.workspaceId,
    excludeKey: input.excludeKey,
    now: input.now,
    idleBefore: input.idleBefore,
    limit: input.limit,
  });
  let stopped = 0;
  for (const lease of leases) {
    if (await isSandboxInActiveDelivery(lease.sandbox_id)) {
      continue;
    }
    const claimed = await claimIdleExpiredConversationSandbox({
      lease,
      now: input.now,
      idleBefore: input.idleBefore,
    });
    if (!claimed) {
      continue;
    }
    const key = {
      workspaceId: lease.workspace_id,
      deploymentId: lease.deployment_id,
      agentId: lease.agent_id,
      conversationKey: lease.conversation_key,
    };
    const handle = await findStartedSandbox({ runtime: input.runtime, lease, key });
    if (handle) {
      await stopConversationSandbox({ runtime: input.runtime, handle });
      stopped += 1;
    }
    await markConversationSandboxLeaseState({
      leaseId: lease.id,
      state: "idle",
      now: input.now,
      currentStep: "idle-stopped",
    });
  }
  return stopped;
}

type DestroyableConversationSandboxLeaseRow = ConversationSandboxLeaseRow & {
  active_delivery: boolean;
};

async function selectDestroyableConversationSandboxLeases(input: {
  now: Date;
  destroyBefore: Date;
  limit: number;
}): Promise<DestroyableConversationSandboxLeaseRow[]> {
  const result = await getDb().execute(sql`
    SELECT
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
      updated_at,
      (
        EXISTS (
          SELECT 1
          FROM integration_watch_deliveries
          WHERE integration_watch_deliveries.run_sandbox_id = conversation_sandbox_leases.sandbox_id
            AND integration_watch_deliveries.status IN ('running', 'processing')
        )
        OR EXISTS (
          SELECT 1
          FROM deployment_tick_deliveries
          WHERE deployment_tick_deliveries.run_sandbox_id = conversation_sandbox_leases.sandbox_id
            AND deployment_tick_deliveries.status IN ('running', 'processing')
        )
      ) AS active_delivery
    FROM conversation_sandbox_leases
    WHERE (
        state IN ('idle', 'evicted', 'released')
        OR (
          state IN ('warming', 'in_use')
          AND (
            lease_until IS NULL
            OR lease_until <= ${input.now}
          )
        )
      )
      AND updated_at <= ${input.destroyBefore}
    ORDER BY updated_at ASC
    LIMIT ${input.limit}
  `);
  return rowsOf<DestroyableConversationSandboxLeaseRow>(result);
}

async function claimConversationSandboxRelease(input: {
  lease: ConversationSandboxLeaseRow;
  now: Date;
}): Promise<boolean> {
  const result = await getDb().execute(sql`
    UPDATE conversation_sandbox_leases
    SET
      state = 'released',
      lease_until = NULL,
      current_step = 'released-destroying',
      updated_at = ${input.now}
    WHERE id = ${input.lease.id}
      AND (
        state IN ('idle', 'evicted', 'released')
        OR (
          state IN ('warming', 'in_use')
          AND (
            lease_until IS NULL
            OR lease_until <= ${input.now}
          )
        )
      )
      AND sandbox_id IS NOT DISTINCT FROM ${input.lease.sandbox_id}
      AND NOT EXISTS (
        SELECT 1
        FROM integration_watch_deliveries
        WHERE integration_watch_deliveries.run_sandbox_id = conversation_sandbox_leases.sandbox_id
          AND integration_watch_deliveries.status IN ('running', 'processing')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM deployment_tick_deliveries
        WHERE deployment_tick_deliveries.run_sandbox_id = conversation_sandbox_leases.sandbox_id
          AND deployment_tick_deliveries.status IN ('running', 'processing')
      )
  `);
  return affectedRowCount(result) > 0;
}

export type ReapConversationSandboxLeasesResult = {
  idleFound: number;
  idleStopped: number;
  cleanupFound: number;
  cleanupDestroyed: number;
  cleanupReleased: number;
  cleanupFailed: string[];
  cleanupSkippedActiveRun: number;
};

export async function reapConversationSandboxLeases(input: {
  runtime: DeploymentSandboxRuntime;
  now?: Date;
  idleTtlSeconds?: number;
  stoppedMinAgeHours?: number;
  limit?: number;
}): Promise<ReapConversationSandboxLeasesResult> {
  const now = input.now ?? new Date();
  const limit = input.limit ?? 100;
  const idleTtlSeconds = resolveIdleTtlSeconds(input.idleTtlSeconds);
  const idleBefore = new Date(now.getTime() - idleTtlSeconds * 1000);
  const idleLeases = await selectIdleExpiredLeases({
    now,
    idleBefore,
    limit,
  });
  const idleStopped = await stopIdleExpiredConversationSandboxes({
    runtime: input.runtime,
    now,
    idleBefore,
    limit,
  });
  const minAgeMs = Math.max(0, input.stoppedMinAgeHours ?? 0) * 60 * 60 * 1000;
  const destroyBefore = new Date(now.getTime() - minAgeMs);
  const cleanupLeases = await selectDestroyableConversationSandboxLeases({
    now,
    destroyBefore,
    limit,
  });

  let cleanupDestroyed = 0;
  let cleanupReleased = 0;
  let cleanupSkippedActiveRun = 0;
  const cleanupFailed: string[] = [];
  for (const lease of cleanupLeases) {
    if (lease.active_delivery) {
      cleanupSkippedActiveRun += 1;
      continue;
    }
    const claimed = await claimConversationSandboxRelease({ lease, now });
    if (!claimed) {
      continue;
    }
    const key = {
      workspaceId: lease.workspace_id,
      deploymentId: lease.deployment_id,
      agentId: lease.agent_id,
      conversationKey: lease.conversation_key,
    };
    const handle = await findSandbox({
      runtime: input.runtime,
      lease,
      key,
      states: null,
    });
    if (!handle) {
      await markConversationSandboxLeaseState({
        leaseId: lease.id,
        state: "released",
        now,
        currentStep: "released",
      });
      cleanupReleased += 1;
      continue;
    }
    try {
      await input.runtime.destroy(handle);
      await markConversationSandboxLeaseState({
        leaseId: lease.id,
        state: "released",
        now,
        currentStep: "released",
      });
      cleanupDestroyed += 1;
      cleanupReleased += 1;
    } catch (error) {
      await markConversationSandboxLeaseState({
        leaseId: lease.id,
        state: "released",
        now,
        currentStep: "released",
      }).catch(() => undefined);
      cleanupFailed.push(lease.sandbox_id ?? lease.id);
      console.error("[conversation-sandbox-lease] failed to destroy released idle/evicted sandbox", {
        sandboxId: lease.sandbox_id,
        leaseId: lease.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    idleFound: idleLeases.length,
    idleStopped,
    cleanupFound: cleanupLeases.length,
    cleanupDestroyed,
    cleanupReleased,
    cleanupFailed,
    cleanupSkippedActiveRun,
  };
}

export async function releaseConversationSandboxLease(input: {
  key: ConversationSandboxKey;
  now?: Date;
}): Promise<{ released: boolean; sandboxId: string | null }> {
  const now = input.now ?? new Date();
  const lease = await selectConversationSandboxLease(input.key);
  if (!lease) {
    return { released: false, sandboxId: null };
  }
  const released = await markConversationSandboxLeaseState({
    leaseId: lease.id,
    state: "released",
    now,
    currentStep: "exit-137-released",
  });
  return { released, sandboxId: lease.sandbox_id };
}

export async function markConversationSandboxLeaseAvailable(input: {
  key: ConversationSandboxKey;
  now?: Date;
}): Promise<{ marked: boolean; sandboxId: string | null }> {
  const now = input.now ?? new Date();
  const lease = await selectConversationSandboxLease(input.key);
  if (!lease) {
    return { marked: false, sandboxId: null };
  }
  const marked = await markConversationSandboxLeaseState({
    leaseId: lease.id,
    state: "warm",
    now,
    currentStep: CONVERSATION_SANDBOX_READY_STEP,
    leaseUntil: now,
  });
  return { marked, sandboxId: lease.sandbox_id };
}

async function evictLeastRecentlyUsedConversationSandbox(input: {
  runtime: DeploymentSandboxRuntime;
  workspaceId: string;
  excludeKey: ConversationSandboxKey;
  now: Date;
  slotAdmission: ConversationSandboxSlotAdmission;
}): Promise<boolean> {
  const lease = await selectLeastRecentlyUsedEvictableLease({
    workspaceId: input.workspaceId,
    excludeKey: input.excludeKey,
  });
  if (!lease) {
    return false;
  }
  if (await isSandboxInActiveDelivery(lease.sandbox_id)) {
    return false;
  }
  const claimed = await claimLeastRecentlyUsedConversationSandboxEviction({
    lease,
    now: input.now,
  });
  if (!claimed) {
    return false;
  }
  const key = {
    workspaceId: lease.workspace_id,
    deploymentId: lease.deployment_id,
    agentId: lease.agent_id,
    conversationKey: lease.conversation_key,
  };
  const handle = await findStartedSandbox({ runtime: input.runtime, lease, key });
  if (handle) {
    await stopConversationSandbox({ runtime: input.runtime, handle });
  }
  await markConversationSandboxLeaseState({
    leaseId: lease.id,
    state: "evicted",
    now: input.now,
    currentStep: "lru-evicted",
  });
  await input.slotAdmission.releaseConversationSandboxSlot(conversationSandboxLeaseKey(key));
  return true;
}

export async function currentActiveConversationSandboxCount(input: {
  workspaceId: string;
}): Promise<number> {
  const result = await getDb().execute(sql`
    SELECT COUNT(*)::int AS count
    FROM conversation_sandbox_leases
    WHERE workspace_id = ${input.workspaceId}
      AND state IN ('warming', 'in_use', 'warm', 'idle')
      AND (
        state = 'warming'
        OR sandbox_id IS NOT NULL
      )
  `);
  const value = rowsOf<{ count: number | string | null }>(result)[0]?.count;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function createDaytonaConversationSandboxSlotAdmission(input: {
  isReentrant?: (leaseKey: string) => boolean | Promise<boolean>;
} = {}): ConversationSandboxSlotAdmission {
  return {
    async acquireConversationSandboxSlot(leaseKey, options) {
      if (await input.isReentrant?.(leaseKey)) {
        return { granted: true, retryAfterMs: null };
      }
      const activeCount = await currentActiveConversationSandboxCount({
        workspaceId: options.workspaceId,
      });
      return activeCount >= options.cap
        ? { granted: false, retryAfterMs: Math.max(1, options.ttlMs) }
        : { granted: true, retryAfterMs: null };
    },
    async releaseConversationSandboxSlot() {
      // DB-backed count admission is stateless; release is intentionally
      // idempotent so a future queue-backed swap stays mechanical.
    },
    currentActiveCount(workspaceId) {
      return currentActiveConversationSandboxCount({ workspaceId });
    },
  };
}

export async function acquireConversationSandbox(
  input: AcquireConversationSandboxInput,
): Promise<AcquireConversationSandboxResult> {
  const key: ConversationSandboxKey = {
    workspaceId: input.workspaceId,
    deploymentId: input.deploymentId,
    agentId: input.agentId,
    conversationKey: input.conversationKey,
  };
  const now = input.now ?? new Date();
  const idleTtlSeconds = resolveIdleTtlSeconds(input.idleTtlSeconds);
  const idleBefore = new Date(now.getTime() - idleTtlSeconds * 1000);
  const leaseUntil = new Date(now.getTime() + Math.max(1, input.leaseTtlSeconds) * 1000);
  const leaseKey = conversationSandboxLeaseKey(key);
  const limit = resolveMaxWarmPerWorkspace(input.maxWarmPerWorkspace);

  for (let attempt = 0; attempt <= CLAIM_WAIT_ATTEMPTS; attempt += 1) {
    const existing = await selectConversationSandboxLease(key);

    await stopIdleExpiredConversationSandboxes({
      runtime: input.runtime,
      workspaceId: input.workspaceId,
      excludeKey: key,
      now,
      idleBefore,
      limit,
    });

    if (existing?.state === "warming") {
      if (await isConversationSandboxLeaseLive({ lease: existing, now })) {
        await sleep(CLAIM_WAIT_DELAY_MS);
        continue;
      }
    }
    if (existing?.state === "in_use") {
      if (await isConversationSandboxLeaseLive({ lease: existing, now })) {
        throw new ConversationSandboxLeaseBusyError(leaseKey);
      }
    }

    const slotAdmission = input.slotAdmission ?? createDaytonaConversationSandboxSlotAdmission({
      isReentrant: (candidate) => candidate === leaseKey && isSameKeyLeaseStillAdmitted({
        lease: existing,
        key,
        now,
        idleBefore,
      }),
    });
    const slotOptions = {
      ttlMs: Math.max(1, input.leaseTtlSeconds) * 1000,
      poolId: input.slotPoolId ?? `${CONVERSATION_SANDBOX_SLOT_POOL_PREFIX}:${input.workspaceId}`,
      cap: limit,
      workspaceId: input.workspaceId,
    };

    let slot = await slotAdmission.acquireConversationSandboxSlot(leaseKey, slotOptions);
    if (!slot.granted) {
      const evicted = await evictLeastRecentlyUsedConversationSandbox({
        runtime: input.runtime,
        workspaceId: input.workspaceId,
        excludeKey: key,
        now,
        slotAdmission,
      });
      if (!evicted) {
        throw new Error("Conversation sandbox per-workspace warm cap reached and no evictable lease was available");
      }
      slot = await slotAdmission.acquireConversationSandboxSlot(leaseKey, slotOptions);
      if (!slot.granted) {
        throw new Error("Conversation sandbox per-workspace warm cap reached after evicting a warm lease");
      }
      console.info("[conversation-sandbox-lease] per-workspace warm cap reached; evicted least recently used lease", {
        leaseKey,
        retryAfterMs: slot.retryAfterMs ?? null,
        limit,
        workspaceId: input.workspaceId,
        deploymentId: input.deploymentId,
        agentId: input.agentId,
      });
    }

    const snapshotMatches = existing?.snapshot_version === input.snapshotVersion;
    if (existing && !snapshotMatches) {
      console.info("[conversation-sandbox-lease] skipping warm reuse on snapshot mismatch; provisioning fresh", {
        leaseKey,
        leasedSnapshotVersion: existing.snapshot_version,
        currentSnapshotVersion: input.snapshotVersion,
        workspaceId: input.workspaceId,
        deploymentId: input.deploymentId,
        agentId: input.agentId,
      });
    }

    if (existing && snapshotMatches && (existing.state === "warm" || existing.state === "idle")) {
      const claimedForReuse = await touchConversationSandboxLease({
        leaseId: existing.id,
        deploymentId: input.deploymentId,
        leaseUntil,
        now,
      });
      if (!claimedForReuse) {
        await sleep(CLAIM_WAIT_DELAY_MS);
        continue;
      }
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
            ? await startConversationSandbox({ runtime: input.runtime, handle })
            : null;
        if (readyHandle) {
          return {
            handle: readyHandle,
            sandboxName: existing.sandbox_name,
            harnessSessionId: existing.harness_session_id,
            reused: true,
          };
        }
        console.warn("[conversation-sandbox-lease] leased sandbox is not reusable; provisioning fresh", {
          leaseKey,
          sandboxId: handle.id,
          state: handle.state ?? null,
          workspaceId: input.workspaceId,
          deploymentId: input.deploymentId,
          agentId: input.agentId,
        });
        await Promise.resolve(input.runtime.destroy(handle)).catch(() => undefined);
        await markConversationSandboxLeaseState({
          leaseId: existing.id,
          state: "evicted",
          now,
          currentStep: "terminal-reuse-evicted",
        });
      } else {
        await markConversationSandboxLeaseState({
          leaseId: existing.id,
          state: "evicted",
          now,
          currentStep: "missing-reuse-evicted",
        });
      }
    }

    const sandboxName = buildConversationSandboxName(key);
    const harnessSessionId = existing && isSameConversationKey(key, existing)
      ? existing.harness_session_id
      : createConversationHarnessSessionId();
    const claim = existing
      ? await claimExistingConversationSandboxProvision({
          lease: existing,
          key,
          sandboxName,
          leaseUntil,
          now,
          snapshotVersion: input.snapshotVersion,
        })
      : await insertConversationSandboxProvisionClaim({
          key,
          harnessSessionId,
          sandboxName,
          leaseUntil,
          now,
          snapshotVersion: input.snapshotVersion,
        });
    if (!claim) {
      await sleep(CLAIM_WAIT_DELAY_MS);
      continue;
    }

    let handle: RuntimeHandle | null = null;
    try {
      if (existing?.sandbox_id) {
        const oldHandle = await findSandbox({
          runtime: input.runtime,
          lease: existing,
          key,
          states: null,
        });
        if (oldHandle) {
          await Promise.resolve(input.runtime.destroy(oldHandle)).catch(() => undefined);
        }
      }
      handle = await input.createSandbox({
        sandboxName,
        labels: {
          ...conversationSandboxLabels(key),
          deploymentId: input.deploymentId,
          sandboxName,
        },
      });
      const completed = await completeConversationSandboxProvision({
        leaseId: claim.id,
        sandboxId: handle.id,
        now,
      });
      if (!completed) {
        await input.runtime.destroy(handle);
        await sleep(CLAIM_WAIT_DELAY_MS);
        continue;
      }
      return { handle, sandboxName, harnessSessionId: claim.harness_session_id, reused: false };
    } catch (error) {
      await deleteConversationSandboxProvisionClaim({ leaseId: claim.id });
      if (handle) {
        await Promise.resolve(input.runtime.destroy(handle)).catch(() => undefined);
      }
      throw error;
    }
  }

  throw new Error("Timed out waiting for conversation sandbox provisioning claim");
}
