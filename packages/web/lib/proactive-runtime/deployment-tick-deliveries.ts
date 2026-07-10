import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  createInitialAgentDeployment,
  getAgentDeploymentTickTarget,
} from "@/lib/proactive-runtime/persona-deploy";
import {
  DeploymentSandboxProvisioningPendingError,
  DeploymentSandboxProvisioningTerminalError,
  DeploymentTriggerDeliveryError,
  DeploymentTriggerRunPendingError,
  DeploymentTriggerRunSandboxTerminalError,
  pollDeploymentTriggerRun,
  runDeploymentTrigger,
  type DeploymentTriggerDeliveryOptions,
  type DeploymentTriggerDeliveryResult,
} from "@/lib/proactive-runtime/deployment-trigger-delivery";

export type PendingDeploymentTickDeliveryInput = {
  workspaceId: string;
  target: NonNullable<Awaited<ReturnType<typeof getAgentDeploymentTickTarget>>>;
  payload: unknown;
  waitUntil: (promise: Promise<unknown>) => void;
  onDelivered?: () => Promise<unknown>;
  options?: DeploymentTriggerDeliveryOptions;
};

export type DrainDeploymentTickDeliveriesInput = {
  workspaceId?: string;
  agentId?: string;
  deliveryId?: string;
  limit?: number;
  leaseSeconds?: number;
  maxDeliveryAgeSeconds?: number;
  maxAttempts?: number;
  deliveryOptions?: DeploymentTriggerDeliveryOptions;
};

export type DrainDeploymentTickDeliveriesResult = {
  attempted: number;
  delivered: number;
  failed: number;
  pending: number;
  terminal: number;
};

type PendingDeliveryRow = {
  id: string;
  workspace_id: string;
  agent_id: string;
  delivery_id: string;
  payload: Record<string, unknown>;
  attempt_count: number;
  provisioning_sandbox_id: string | null;
  run_deployment_id: string | null;
  run_sandbox_id: string | null;
  run_session_id: string | null;
  run_command_id: string | null;
  run_started_at: string | Date | null;
  run_sandbox_name: string | null;
  run_mount_configured: boolean | null;
  run_envelope: string | null;
  created_at: string | Date;
};

type EnqueueDeliveryRow = {
  status: string;
  run_deployment_id: string | null;
};

const DEFAULT_DRAIN_LIMIT = 3;
const DEFAULT_LEASE_SECONDS = 180;
const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_MAX_DELIVERY_AGE_SECONDS = 60 * 60;
const DELIVERY_ID_PREFIX = "deployment-tick";
const PENDING_RETRY_SECONDS = 15;

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const candidate = result as { rows?: T[] };
  return Array.isArray(candidate?.rows) ? candidate.rows : [];
}

function truncateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 4000);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function occurrenceEpochForPayload(payload: Record<string, unknown>): number | null {
  const value = payload.occurrenceEpoch;
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return numberValue(value);
}

function deploymentTickDeliveryId(deploymentId: string, payload: unknown): string {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    const occurrenceId = stringValue(record.occurrenceId);
    if (occurrenceId) {
      return `${DELIVERY_ID_PREFIX}:${occurrenceId}`;
    }
    const scheduleKey = stringValue(record.gatewayScheduleId) ?? stringValue(record.scheduleId);
    const occurrenceEpoch = occurrenceEpochForPayload(record);
    if (scheduleKey && occurrenceEpoch !== null) {
      return `${DELIVERY_ID_PREFIX}:${scheduleKey}:${occurrenceEpoch}`;
    }
  }
  return `${DELIVERY_ID_PREFIX}:${deploymentId}`;
}

function timestampMs(value: unknown): number {
  return value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
}

function isDeliveryExpired(input: {
  createdAt: unknown;
  maxDeliveryAgeSeconds: number | null;
}): boolean {
  if (input.maxDeliveryAgeSeconds === null) return false;
  const createdAt = timestampMs(input.createdAt);
  return Number.isFinite(createdAt) &&
    Date.now() - createdAt >= input.maxDeliveryAgeSeconds * 1000;
}

function isInconclusivePriorRunPollError(error: unknown): boolean {
  const errorCode = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : null;
  const errorName = error instanceof Error ? error.name : null;
  return !(error instanceof DeploymentTriggerRunSandboxTerminalError) &&
    errorCode !== "deployment_run_timeout" &&
    errorCode !== "harness_exit_137" &&
    errorName !== "DeploymentTriggerRunTimedOutError" &&
    errorName !== "HarnessExit137Error";
}

function triggerKindForPayload(payload: unknown): "inbox" | "clock" {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    const rawType = record.type ?? record.eventType;
    if (typeof rawType === "string" && (rawType === "cron.tick" || rawType.startsWith("cron."))) {
      return "clock";
    }
  }
  return "clock";
}

async function deleteAgentDeployment(deploymentId: string): Promise<void> {
  await getDb().execute(sql`
    DELETE FROM agent_deployments
    WHERE id = ${deploymentId}
  `);
}

async function markDeploymentTickProvisioning(input: {
  id: string;
  sandboxId: string;
  error: unknown;
}): Promise<void> {
  await getDb().execute(sql`
    UPDATE deployment_tick_deliveries
    SET status = 'pending',
        provisioning_sandbox_id = ${input.sandboxId},
        run_sandbox_id = NULL,
        run_session_id = NULL,
        run_command_id = NULL,
        run_started_at = NULL,
        run_sandbox_name = NULL,
        run_mount_configured = NULL,
        run_envelope = NULL,
        next_attempt_at = NOW() + (${PENDING_RETRY_SECONDS} || ' seconds')::interval,
        lease_until = NULL,
        last_error = ${truncateError(input.error)},
        updated_at = NOW()
    WHERE id = ${input.id}
  `);
}

async function markDeploymentTickRunning(input: {
  id: string;
  error: unknown;
  run: {
    deploymentId: string;
    sandboxId: string;
    sessionId: string;
    commandId: string;
    startedAt: string;
    sandboxName?: string | null;
    mountConfigured?: boolean;
    envelopeJson?: string | null;
  };
}): Promise<void> {
  await getDb().execute(sql`
    UPDATE deployment_tick_deliveries
    SET status = 'running',
        provisioning_sandbox_id = NULL,
        run_deployment_id = ${input.run.deploymentId},
        run_sandbox_id = ${input.run.sandboxId},
        run_session_id = ${input.run.sessionId},
        run_command_id = ${input.run.commandId},
        run_started_at = ${input.run.startedAt}::timestamp with time zone,
        run_sandbox_name = ${input.run.sandboxName ?? null},
        run_mount_configured = ${input.run.mountConfigured ?? null},
        run_envelope = ${input.run.envelopeJson ?? null},
        next_attempt_at = NOW() + (${PENDING_RETRY_SECONDS} || ' seconds')::interval,
        lease_until = NULL,
        last_error = ${truncateError(input.error)},
        updated_at = NOW()
    WHERE id = ${input.id}
  `);
}

async function markDeploymentTickDelivered(id: string): Promise<void> {
  await getDb().execute(sql`
    UPDATE deployment_tick_deliveries
    SET status = 'delivered',
        provisioning_sandbox_id = NULL,
        run_sandbox_id = NULL,
        run_session_id = NULL,
        run_command_id = NULL,
        run_started_at = NULL,
        run_sandbox_name = NULL,
        run_mount_configured = NULL,
        run_envelope = NULL,
        delivered_at = NOW(),
        lease_until = NULL,
        last_error = NULL,
        updated_at = NOW()
    WHERE id = ${id}
  `);
}

async function markDeploymentTickFailed(input: {
  id: string;
  attemptCount: number;
  error: unknown;
  maxAttempts: number;
  clearProvisioningSandboxId?: boolean;
  clearRunState?: boolean;
}): Promise<"pending" | "failed"> {
  const nextAttempt = input.attemptCount + 1;
  const terminal = nextAttempt >= input.maxAttempts;
  await getDb().execute(sql`
    UPDATE deployment_tick_deliveries
    SET status = ${terminal ? "failed" : "pending"},
        attempt_count = ${nextAttempt},
        next_attempt_at = CASE
          WHEN ${terminal} THEN next_attempt_at
          ELSE NOW() + (${PENDING_RETRY_SECONDS} || ' seconds')::interval
        END,
        lease_until = NULL,
        provisioning_sandbox_id = CASE
          WHEN ${Boolean(input.clearProvisioningSandboxId)} THEN NULL
          ELSE provisioning_sandbox_id
        END,
        run_sandbox_id = CASE
          WHEN ${Boolean(input.clearRunState)} THEN NULL
          ELSE run_sandbox_id
        END,
        run_session_id = CASE
          WHEN ${Boolean(input.clearRunState)} THEN NULL
          ELSE run_session_id
        END,
        run_command_id = CASE
          WHEN ${Boolean(input.clearRunState)} THEN NULL
          ELSE run_command_id
        END,
        run_started_at = CASE
          WHEN ${Boolean(input.clearRunState)} THEN NULL
          ELSE run_started_at
        END,
        run_sandbox_name = CASE
          WHEN ${Boolean(input.clearRunState)} THEN NULL
          ELSE run_sandbox_name
        END,
        run_mount_configured = CASE
          WHEN ${Boolean(input.clearRunState)} THEN NULL
          ELSE run_mount_configured
        END,
        run_envelope = CASE
          WHEN ${Boolean(input.clearRunState)} THEN NULL
          ELSE run_envelope
        END,
        last_error = ${truncateError(input.error)},
        updated_at = NOW()
    WHERE id = ${input.id}
      AND status NOT IN ('delivered', 'failed')
  `);
  return terminal ? "failed" : "pending";
}

async function markDeploymentTickRunInconclusive(input: {
  id: string;
  attemptCount: number;
  error: unknown;
  maxAttempts: number;
}): Promise<"running" | "failed"> {
  const nextAttempt = input.attemptCount + 1;
  const terminal = nextAttempt >= input.maxAttempts;
  await getDb().execute(sql`
    UPDATE deployment_tick_deliveries
    SET status = ${terminal ? "failed" : "running"},
        attempt_count = ${nextAttempt},
        next_attempt_at = CASE
          WHEN ${terminal} THEN next_attempt_at
          ELSE NOW() + (${PENDING_RETRY_SECONDS} || ' seconds')::interval
        END,
        lease_until = NULL,
        last_error = ${truncateError(input.error)},
        updated_at = NOW()
    WHERE id = ${input.id}
      AND status NOT IN ('delivered', 'failed')
  `);
  return terminal ? "failed" : "running";
}

async function claimPendingDeploymentTickDeliveries(
  input: Required<Pick<DrainDeploymentTickDeliveriesInput, "limit" | "leaseSeconds">> &
    Pick<DrainDeploymentTickDeliveriesInput, "workspaceId" | "agentId" | "deliveryId">,
): Promise<PendingDeliveryRow[]> {
  const deliveryIdPrefix = `${DELIVERY_ID_PREFIX}:`;
  const result = await getDb().execute(sql`
    WITH candidates AS (
      SELECT id
      FROM deployment_tick_deliveries
      WHERE (${input.workspaceId ?? null}::uuid IS NULL OR workspace_id = ${input.workspaceId ?? null}::uuid)
        AND (
          status = 'pending'
          OR (status = 'processing' AND lease_until <= NOW())
          OR status = 'running'
        )
        AND next_attempt_at <= NOW()
        AND (${input.agentId ?? null}::uuid IS NULL OR agent_id = ${input.agentId ?? null}::uuid)
        AND (
          (
            ${input.deliveryId ?? null}::text IS NOT NULL
            AND delivery_id = ${input.deliveryId ?? null}
          )
          OR (
            ${input.deliveryId ?? null}::text IS NULL
            AND delivery_id LIKE ${deliveryIdPrefix} || '%'
          )
        )
      ORDER BY next_attempt_at ASC, created_at ASC
      LIMIT ${input.limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE deployment_tick_deliveries deliveries
    SET status = 'processing',
        lease_until = NOW() + (${input.leaseSeconds} || ' seconds')::interval,
        updated_at = NOW()
    FROM candidates
    WHERE deliveries.id = candidates.id
    RETURNING
      deliveries.id,
      deliveries.workspace_id,
      deliveries.agent_id,
      deliveries.delivery_id,
      deliveries.payload,
      deliveries.attempt_count,
      deliveries.provisioning_sandbox_id,
      deliveries.run_deployment_id,
      deliveries.run_sandbox_id,
      deliveries.run_session_id,
      deliveries.run_command_id,
      deliveries.run_started_at,
      deliveries.run_sandbox_name,
      deliveries.run_mount_configured,
      deliveries.run_envelope,
      deliveries.created_at
  `);
  return rowsOf<PendingDeliveryRow>(result);
}

export async function enqueueDeploymentTickDelivery(
  input: PendingDeploymentTickDeliveryInput,
): Promise<DeploymentTriggerDeliveryResult> {
  const triggerKind = triggerKindForPayload(input.payload);
  const deploymentId = await createInitialAgentDeployment({
    agentId: input.target.agentId,
    specHash: input.target.specHash,
    triggerKind,
    triggerPayload: input.payload,
  });
  const deliveryId = deploymentTickDeliveryId(deploymentId, input.payload);
  let owningDeploymentId = deploymentId;

  try {
    const result = await getDb().execute(sql`
    INSERT INTO deployment_tick_deliveries (
        workspace_id,
        agent_id,
        delivery_id,
        payload,
        status,
        attempt_count,
        next_attempt_at,
        provisioning_sandbox_id,
        run_deployment_id,
        run_sandbox_id,
        run_session_id,
        run_command_id,
        run_started_at,
        run_sandbox_name,
        run_mount_configured,
        run_envelope,
        last_error,
        updated_at
      )
      VALUES (
        ${input.workspaceId},
        ${input.target.agentId},
        ${deliveryId},
        ${JSON.stringify(input.payload)}::jsonb,
        'pending',
        0,
        NOW(),
        NULL,
        ${deploymentId},
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NOW()
      )
      ON CONFLICT (workspace_id, agent_id, delivery_id) DO UPDATE
      SET payload = EXCLUDED.payload,
          run_deployment_id = COALESCE(deployment_tick_deliveries.run_deployment_id, EXCLUDED.run_deployment_id),
          status = CASE
            WHEN deployment_tick_deliveries.status = 'delivered' THEN 'delivered'
            WHEN deployment_tick_deliveries.status = 'failed' THEN 'failed'
            ELSE deployment_tick_deliveries.status
          END,
          next_attempt_at = CASE
            WHEN deployment_tick_deliveries.status = 'delivered' THEN deployment_tick_deliveries.next_attempt_at
            ELSE LEAST(deployment_tick_deliveries.next_attempt_at, NOW())
          END,
          updated_at = NOW()
      RETURNING status, run_deployment_id
    `);
    const row = rowsOf<EnqueueDeliveryRow>(result)[0];
    if (row?.run_deployment_id && row.run_deployment_id !== deploymentId) {
      owningDeploymentId = row.run_deployment_id;
      await deleteAgentDeployment(deploymentId);
    }
  } catch (error) {
    try {
      await deleteAgentDeployment(deploymentId);
    } catch (cleanupError) {
      console.error(
        "[persona-bundle-deploy] failed to roll back deployment row after tick queue insert error:",
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      );
    }
    throw error;
  }

  input.waitUntil(
    drainDeploymentTickDeliveries({
      workspaceId: input.workspaceId,
      agentId: input.target.agentId,
      deliveryId,
      limit: 1,
      deliveryOptions: input.options,
    })
      .then((result) => {
        if (result.delivered > 0) {
          return input.onDelivered?.();
        }
        return undefined;
      })
      .catch((error) => {
        console.error(
          "[persona-bundle-deploy] background tick delivery failed:",
          error instanceof Error ? error.message : String(error),
        );
      }),
  );

  return {
    agentId: input.target.agentId,
    workspaceId: input.workspaceId,
    deploymentId: owningDeploymentId,
    status: "starting",
  };
}

export async function drainDeploymentTickDeliveries(
  input: DrainDeploymentTickDeliveriesInput,
): Promise<DrainDeploymentTickDeliveriesResult> {
  const limit = input.limit ?? DEFAULT_DRAIN_LIMIT;
  const leaseSeconds = input.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxDeliveryAgeSeconds = input.maxDeliveryAgeSeconds ?? DEFAULT_MAX_DELIVERY_AGE_SECONDS;
  const rows = await claimPendingDeploymentTickDeliveries({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    deliveryId: input.deliveryId,
    limit,
    leaseSeconds,
  });

  let delivered = 0;
  let pending = 0;
  let terminal = 0;

  for (const row of rows) {
    try {
      if (isDeliveryExpired({
        createdAt: row.created_at,
        maxDeliveryAgeSeconds,
      })) {
        await markDeploymentTickFailed({
          id: row.id,
          attemptCount: maxAttempts - 1,
          error: new Error("Deployment tick delivery exceeded max delivery age"),
          maxAttempts,
          clearProvisioningSandboxId: false,
          clearRunState: false,
        });
        terminal += 1;
        continue;
      }
      if (
        row.run_deployment_id &&
        row.run_sandbox_id &&
        row.run_session_id &&
        row.run_command_id &&
        row.run_started_at
      ) {
        await pollDeploymentTriggerRun({
          workspaceId: row.workspace_id,
          agentId: row.agent_id,
          payload: row.payload,
          deploymentId: row.run_deployment_id,
          sandboxId: row.run_sandbox_id,
          sessionId: row.run_session_id,
          commandId: row.run_command_id,
          startedAt: row.run_started_at instanceof Date
            ? row.run_started_at.toISOString()
            : row.run_started_at,
          sandboxName: row.run_sandbox_name,
          mountConfigured: row.run_mount_configured ?? undefined,
          envelopeJson: row.run_envelope ?? null,
          options: input.deliveryOptions,
        });
      } else {
        const target = await getAgentDeploymentTickTarget({
          workspaceId: row.workspace_id,
          agentId: row.agent_id,
        });
        if (!target) {
          throw new DeploymentTriggerDeliveryError(
            "Deployment target not found",
            "not_found",
            404,
          );
        }
        if (!row.run_deployment_id) {
          throw new DeploymentTriggerDeliveryError(
            "Deployment tick delivery missing deployment id",
            "deployment_tick_delivery_missing_deployment_id",
            500,
          );
        }
        await runDeploymentTrigger({
          workspaceId: row.workspace_id,
          target,
          deploymentId: row.run_deployment_id,
          triggerKind: triggerKindForPayload(row.payload),
          payload: row.payload,
          deliveryId: row.delivery_id,
          provisioningSandboxId: row.provisioning_sandbox_id,
          // This drain is the only caller that catches
          // DeploymentSandboxProvisioningPendingError (below) and persists
          // provisioning_sandbox_id, so it's the only place yielding mid-provision
          // is safe — enable it explicitly here rather than inferring from payload.
          options: { ...input.deliveryOptions, provisioningYieldEnabled: true },
        });
      }
      await markDeploymentTickDelivered(row.id);
      delivered += 1;
    } catch (error) {
      if (error instanceof DeploymentSandboxProvisioningPendingError) {
        await markDeploymentTickProvisioning({
          id: row.id,
          sandboxId: error.sandboxId,
          error,
        });
        pending += 1;
        await logger.info("Deployment tick delivery sandbox still provisioning", {
          area: "deployment-tick-delivery",
          workspaceId: row.workspace_id,
          agentId: row.agent_id,
          deliveryId: row.delivery_id,
          sandboxId: error.sandboxId,
        });
        continue;
      }
      if (error instanceof DeploymentTriggerRunPendingError) {
        await markDeploymentTickRunning({
          id: row.id,
          error,
          run: error.run,
        });
        pending += 1;
        await logger.info("Deployment tick delivery run still running", {
          area: "deployment-tick-delivery",
          workspaceId: row.workspace_id,
          agentId: row.agent_id,
          deliveryId: row.delivery_id,
          deploymentId: error.run.deploymentId,
          sandboxId: error.run.sandboxId,
          sessionId: error.run.sessionId,
          commandId: error.run.commandId,
        });
        continue;
      }
      if (
        row.run_deployment_id &&
        row.run_sandbox_id &&
        row.run_session_id &&
        row.run_command_id &&
        row.run_started_at &&
        isInconclusivePriorRunPollError(error)
      ) {
        const nextStatus = await markDeploymentTickRunInconclusive({
          id: row.id,
          attemptCount: row.attempt_count,
          error,
          maxAttempts,
        });
        if (nextStatus === "failed") {
          terminal += 1;
        } else {
          pending += 1;
        }
        await logger.warn("Deployment tick prior run poll inconclusive", {
          area: "deployment-tick-delivery",
          workspaceId: row.workspace_id,
          agentId: row.agent_id,
          deliveryId: row.delivery_id,
          attempt: row.attempt_count + 1,
          maxAttempts,
          terminal: nextStatus === "failed",
          error: truncateError(error),
        });
        continue;
      }
      const nextStatus = await markDeploymentTickFailed({
        id: row.id,
        attemptCount: row.attempt_count,
        error,
        maxAttempts,
        clearProvisioningSandboxId: error instanceof DeploymentSandboxProvisioningTerminalError,
        clearRunState: Boolean(row.run_command_id) || error instanceof DeploymentTriggerRunSandboxTerminalError,
      });
      if (nextStatus === "failed") {
        terminal += 1;
      } else {
        pending += 1;
      }
      await logger.warn("Deployment tick pending delivery failed", {
        area: "deployment-tick-delivery",
        workspaceId: row.workspace_id,
        agentId: row.agent_id,
        deliveryId: row.delivery_id,
        attempt: row.attempt_count + 1,
        maxAttempts,
        terminal: nextStatus === "failed",
        retryable:
          !(error instanceof DeploymentTriggerDeliveryError) ||
          error.status >= 500,
        error: truncateError(error),
      });
    }
  }

  if (rows.length > 0) {
    await logger.info("Deployment tick pending delivery drain completed", {
      area: "deployment-tick-delivery",
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      deliveryId: input.deliveryId,
      attempted: rows.length,
      delivered,
      pending,
      terminal,
    });
  }

  return {
    attempted: rows.length,
    delivered,
    failed: pending + terminal,
    pending,
    terminal,
  };
}
