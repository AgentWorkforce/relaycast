import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  deliverDeploymentTrigger,
  DeploymentTriggerDeliveryError,
  DeploymentTriggerRunPendingError,
  DeploymentSandboxProvisioningPendingError,
  DeploymentSandboxProvisioningTerminalError,
  pollDeploymentTriggerRun,
  type DeploymentTriggerDeliveryOptions,
} from "@/lib/proactive-runtime/deployment-trigger-delivery";
import {
  deriveIntegrationWatchIssueDedupeKey,
  readIssueDispatchCooldownSeconds,
  releaseIssueDispatchDedupe,
  releaseVfsWatchDedupe,
} from "@/lib/proactive-runtime/integration-watch-dispatcher";
import {
  dispatchFactoryBrainDelivery,
  isFactoryBrainPayload,
} from "@/lib/proactive-runtime/factory-cloud-orchestrator";
import {
  buildTeamLaunchMemberOptions,
  buildTeamLaunchPayload,
  dispatchTeamLaunchN1,
  launchTeamMember,
  teamSolveMaxMembers,
  TeamLaunchOptionsUnavailableError,
} from "@/lib/proactive-runtime/team-launch-n1";
import {
  readTeamRosterMemberConfigs,
  type TeamRosterMemberConfig,
} from "@/lib/proactive-runtime/team-roster";

export type PendingIntegrationWatchDeliveryInput = {
  workspaceId: string;
  agentId: string;
  deliveryId: string;
  triggerKey?: string | null;
  payload: Record<string, unknown>;
};

export type DrainIntegrationWatchDeliveriesInput = {
  workspaceId?: string;
  agentId?: string;
  deliveryId?: string;
  limit?: number;
  leaseSeconds?: number;
  maxAttempts?: number;
  maxDeliveryAgeSeconds?: number;
  deliveryOptions?: DeploymentTriggerDeliveryOptions;
  allowTeamLaunchN1?: boolean;
};

export type DrainIntegrationWatchDeliveriesResult = {
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
  trigger_key: string | null;
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
  terminal_writeback_status: string | null;
  slack_terminal_reply_status: string | null;
};

function isNamedSandboxError(
  error: unknown,
  name: string,
): error is Error & { sandboxId: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === name &&
    "sandboxId" in error &&
    typeof (error as { sandboxId?: unknown }).sandboxId === "string"
  );
}

function isWorkflowSandboxProvisioningPendingError(
  error: unknown,
): error is Error & { sandboxId: string } {
  return isNamedSandboxError(error, "WorkflowSandboxProvisioningPendingError");
}

function isWorkflowSandboxResumeMissingError(error: unknown): boolean {
  return isNamedSandboxError(error, "WorkflowSandboxResumeMissingError");
}

type TeamLaunchAgentContext = {
  deployed_by_user_id: string | null;
  organization_id: string | null;
  // Pinned persona-version spec (wrapped {persona, agent} snapshot) so the
  // drain derives the member cap with the same resolver as the dispatcher.
  persona_spec: unknown;
};

const DEFAULT_DRAIN_LIMIT = 3;
const DEFAULT_LEASE_SECONDS = 180;
const DEFAULT_MAX_ATTEMPTS = 6;

type SqlExecutor = {
  execute(query: ReturnType<typeof sql>): Promise<unknown>;
};

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const candidate = result as { rows?: T[] };
  return Array.isArray(candidate?.rows) ? candidate.rows : [];
}

function truncateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 4000);
}

function errorIndicatesCleanupOnlyHandlerSuccess(
  error: unknown,
  row: Pick<PendingDeliveryRow, "terminal_writeback_status" | "slack_terminal_reply_status">,
): boolean {
  if (row.terminal_writeback_status !== null || row.slack_terminal_reply_status !== null) {
    return false;
  }
  const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, "");
  if (!message.includes("runner.handler.ok") || message.includes("runner.handler.error")) {
    return false;
  }
  if (!message.includes("relayfile.mount.cleanup")) {
    return false;
  }
  const cleanupNonZero =
    /"flushExitCode":(?!0\b)\d+/.test(message) ||
    /"killExitCode":(?!0\b)\d+/.test(message);
  if (!cleanupNonZero) {
    return false;
  }
  if (!message.includes('"pendingWriteback":0')) {
    return false;
  }
  if (!message.includes('"outboxNeedsAttention":false')) {
    return false;
  }
  if (!message.includes('"hasPendingWriteback":false')) {
    return false;
  }
  const undeliverable = message.match(/"commandDraftsUndeliverable":(\d+)/);
  return !undeliverable || Number(undeliverable[1]) === 0;
}

function retryDelaySeconds(nextAttempt: number): number {
  return Math.min(15 * 2 ** Math.max(0, nextAttempt - 1), 15 * 60);
}

function isTeamLaunchN1Payload(payload: Record<string, unknown>): boolean {
  return payload.teamLaunchN1 === true;
}

function isFactoryBrainDeliveryPayload(payload: Record<string, unknown>): boolean {
  return isFactoryBrainPayload(payload);
}

// Daytona fronts sandbox exec with a Cloudflare proxy that enforces a ~120s
// budget; a long-running member bootstrap surfaces as an HTTP 524 from
// `proxy.app.daytona.io` while the dispatched process keeps running in-box.
// Match conservatively: the proxy host, or a 524 status attributed to
// Daytona — NOT a bare "524" (which could be an issue number or byte count
// inside an unrelated error string).
function isDaytonaProxyTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message}` : String(error);
  if (/proxy\.app\.daytona\.io/iu.test(message)) {
    return true;
  }
  return /\b524\b/u.test(message) && /daytona/iu.test(message);
}

function payloadStringArray(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function rawResourceFromPayload(payload: Record<string, unknown>): unknown {
  return payload.resource ?? {};
}

function issueDedupeKeyFromDeliveryPayload(payload: Record<string, unknown>): string | null {
  const provider = payloadString(payload, "provider");
  if (!provider) return null;
  return deriveIntegrationWatchIssueDedupeKey({
    provider,
    eventPaths: payloadStringArray(payload, "paths"),
    payload: rawResourceFromPayload(payload),
  });
}

function claimPendingIntegrationWatchDeliveriesQuery(
  input: Required<
    Pick<DrainIntegrationWatchDeliveriesInput, "limit" | "leaseSeconds">
  > & {
    maxDeliveryAgeSeconds: number | null;
  } & Pick<
      DrainIntegrationWatchDeliveriesInput,
      "workspaceId" | "agentId" | "deliveryId"
    >,
): ReturnType<typeof sql> {
  return sql`
    WITH scoped AS (
      SELECT
        deliveries.id,
        deliveries.agent_id,
        deliveries.trigger_key,
        deliveries.status,
        deliveries.next_attempt_at,
        deliveries.created_at,
        CASE
          WHEN deliveries.trigger_key IS NULL THEN agents.delivery_max_concurrency
          WHEN jsonb_typeof(agents.delivery_max_concurrency_by_trigger) = 'object'
            AND agents.delivery_max_concurrency_by_trigger ? deliveries.trigger_key
            AND jsonb_typeof(agents.delivery_max_concurrency_by_trigger -> deliveries.trigger_key) = 'number'
            AND (agents.delivery_max_concurrency_by_trigger ->> deliveries.trigger_key) ~ '^[1-9][0-9]*$'
            THEN (agents.delivery_max_concurrency_by_trigger ->> deliveries.trigger_key)::integer
          ELSE NULL
        END AS delivery_max_concurrency
      FROM integration_watch_deliveries deliveries
      INNER JOIN agents ON agents.id = deliveries.agent_id
      WHERE (${input.workspaceId ?? null}::uuid IS NULL OR deliveries.workspace_id = ${input.workspaceId ?? null}::uuid)
        AND (
          ${input.maxDeliveryAgeSeconds ?? null}::integer IS NULL
          OR deliveries.created_at >= NOW() - (${input.maxDeliveryAgeSeconds ?? null} || ' seconds')::interval
        )
        AND (
          deliveries.status = 'pending'
          OR (deliveries.status = 'processing' AND deliveries.lease_until <= NOW())
          OR deliveries.status = 'running'
        )
        AND deliveries.next_attempt_at <= NOW()
        AND (${input.agentId ?? null}::uuid IS NULL OR deliveries.agent_id = ${input.agentId ?? null}::uuid)
        AND (${input.deliveryId ?? null}::text IS NULL OR deliveries.delivery_id = ${input.deliveryId ?? null})
    ),
    agent_active_counts AS (
      SELECT
        active_deliveries.agent_id,
        COUNT(*) FILTER (
          WHERE active_deliveries.status = 'processing'
            AND active_deliveries.lease_until > NOW()
        ) AS active_processing_count,
        COUNT(*) FILTER (
          WHERE active_deliveries.status = 'running'
            AND active_deliveries.next_attempt_at > NOW()
        ) AS non_due_running_count
      FROM integration_watch_deliveries active_deliveries
      WHERE active_deliveries.status IN ('processing', 'running')
        AND (${input.workspaceId ?? null}::uuid IS NULL OR active_deliveries.workspace_id = ${input.workspaceId ?? null}::uuid)
        AND (${input.agentId ?? null}::uuid IS NULL OR active_deliveries.agent_id = ${input.agentId ?? null}::uuid)
      GROUP BY active_deliveries.agent_id
    ),
    trigger_active_counts AS (
      SELECT
        active_deliveries.agent_id,
        active_deliveries.trigger_key,
        COUNT(*) FILTER (
          WHERE active_deliveries.status = 'processing'
            AND active_deliveries.lease_until > NOW()
        ) AS active_processing_count,
        COUNT(*) FILTER (
          WHERE active_deliveries.status = 'running'
            AND active_deliveries.next_attempt_at > NOW()
        ) AS non_due_running_count
      FROM integration_watch_deliveries active_deliveries
      WHERE active_deliveries.status IN ('processing', 'running')
        AND active_deliveries.trigger_key IS NOT NULL
        AND (${input.workspaceId ?? null}::uuid IS NULL OR active_deliveries.workspace_id = ${input.workspaceId ?? null}::uuid)
        AND (${input.agentId ?? null}::uuid IS NULL OR active_deliveries.agent_id = ${input.agentId ?? null}::uuid)
      GROUP BY active_deliveries.agent_id, active_deliveries.trigger_key
    ),
    ranked AS (
      SELECT
        scoped.id,
        scoped.trigger_key,
        scoped.delivery_max_concurrency,
        scoped.status,
        CASE
          WHEN scoped.trigger_key IS NULL THEN COALESCE(agent_active_counts.active_processing_count, 0)
          ELSE COALESCE(trigger_active_counts.active_processing_count, 0)
        END AS active_processing_count,
        CASE
          WHEN scoped.trigger_key IS NULL THEN COALESCE(agent_active_counts.non_due_running_count, 0)
          ELSE COALESCE(trigger_active_counts.non_due_running_count, 0)
        END AS non_due_running_count,
        ROW_NUMBER() OVER (
          PARTITION BY scoped.agent_id
          ORDER BY
            CASE WHEN scoped.status = 'running' THEN 0 ELSE 1 END,
            scoped.next_attempt_at ASC,
            scoped.created_at ASC
        ) AS agent_due_rank,
        ROW_NUMBER() OVER (
          PARTITION BY scoped.agent_id, scoped.trigger_key
          ORDER BY
            CASE WHEN scoped.status = 'running' THEN 0 ELSE 1 END,
            scoped.next_attempt_at ASC,
            scoped.created_at ASC
        ) AS trigger_due_rank,
        scoped.next_attempt_at,
        scoped.created_at
      FROM scoped
      LEFT JOIN agent_active_counts
        ON agent_active_counts.agent_id = scoped.agent_id
      LEFT JOIN trigger_active_counts
        ON trigger_active_counts.agent_id = scoped.agent_id
        AND trigger_active_counts.trigger_key = scoped.trigger_key
    ),
    candidates AS (
      SELECT deliveries.id
      FROM integration_watch_deliveries deliveries
      INNER JOIN ranked ON ranked.id = deliveries.id
      WHERE ranked.status = 'running'
        OR ranked.delivery_max_concurrency IS NULL
        OR (CASE
          WHEN ranked.trigger_key IS NULL THEN ranked.agent_due_rank
          ELSE ranked.trigger_due_rank
        END) <= GREATEST(
          delivery_max_concurrency - active_processing_count - non_due_running_count,
          0
        )
      ORDER BY ranked.next_attempt_at ASC, ranked.created_at ASC
      LIMIT ${input.limit}
      FOR UPDATE OF deliveries SKIP LOCKED
    )
    UPDATE integration_watch_deliveries deliveries
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
      deliveries.trigger_key,
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
      deliveries.terminal_writeback_status,
      deliveries.slack_terminal_reply_status
  `;
}

export async function enqueueIntegrationWatchDelivery(
  input: PendingIntegrationWatchDeliveryInput,
): Promise<"queued" | "delivered" | "failed"> {
  const result = await getDb().execute(sql`
    INSERT INTO integration_watch_deliveries (
      workspace_id,
      agent_id,
      delivery_id,
      trigger_key,
      payload,
      status,
      next_attempt_at,
      updated_at
    )
    VALUES (
      ${input.workspaceId},
      ${input.agentId},
      ${input.deliveryId},
      ${input.triggerKey ?? null},
      ${JSON.stringify(input.payload)}::jsonb,
      'pending',
      NOW(),
      NOW()
    )
    ON CONFLICT (workspace_id, agent_id, delivery_id) DO UPDATE
    SET payload = EXCLUDED.payload,
        trigger_key = EXCLUDED.trigger_key,
        status = CASE
          WHEN integration_watch_deliveries.status = 'delivered' THEN 'delivered'
          WHEN integration_watch_deliveries.status = 'failed' THEN 'failed'
          ELSE integration_watch_deliveries.status
        END,
        next_attempt_at = CASE
          WHEN integration_watch_deliveries.status = 'delivered' THEN integration_watch_deliveries.next_attempt_at
          ELSE LEAST(integration_watch_deliveries.next_attempt_at, NOW())
        END,
        updated_at = NOW()
    RETURNING status
  `);
  const [row] = rowsOf<{ status: string }>(result);
  if (row?.status === "delivered") return "delivered";
  if (row?.status === "failed") return "failed";
  return "queued";
}

async function claimPendingIntegrationWatchDeliveries(
  input: Required<
    Pick<DrainIntegrationWatchDeliveriesInput, "limit" | "leaseSeconds">
  > & {
    maxDeliveryAgeSeconds: number | null;
  } & Pick<
      DrainIntegrationWatchDeliveriesInput,
      "workspaceId" | "agentId" | "deliveryId"
    >,
): Promise<PendingDeliveryRow[]> {
  const query = claimPendingIntegrationWatchDeliveriesQuery(input);
  const db = getDb();
  const result = input.agentId
    ? await db.transaction(async (tx: SqlExecutor) => {
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(hashtext('iwd:' || ${input.agentId})::bigint)
      `);
      return tx.execute(query);
    })
    : await db.execute(query);
  return rowsOf<PendingDeliveryRow>(result);
}

async function markPendingDeliveryProvisioning(input: {
  id: string;
  sandboxId: string;
  error: unknown;
}): Promise<void> {
  await getDb().execute(sql`
    UPDATE integration_watch_deliveries
    SET status = 'pending',
        provisioning_sandbox_id = ${input.sandboxId},
        run_deployment_id = NULL,
        run_sandbox_id = NULL,
        run_session_id = NULL,
        run_command_id = NULL,
        run_started_at = NULL,
        run_sandbox_name = NULL,
        run_mount_configured = NULL,
        next_attempt_at = NOW() + ('15 seconds')::interval,
        lease_until = NULL,
        last_error = ${truncateError(input.error)},
        updated_at = NOW()
    WHERE id = ${input.id}
  `);
}

async function recordPendingDeliverySandboxCreated(input: {
  id: string;
  sandboxId: string;
}): Promise<void> {
  await getDb().execute(sql`
    UPDATE integration_watch_deliveries
    SET provisioning_sandbox_id = ${input.sandboxId},
        updated_at = NOW()
    WHERE id = ${input.id}
  `);
}

async function markPendingDeliveryTeamLaunchDeferred(input: {
  id: string;
  reason: string;
}): Promise<void> {
  await getDb().execute(sql`
    UPDATE integration_watch_deliveries
    SET status = 'pending',
        next_attempt_at = NOW() + ('15 seconds')::interval,
        lease_until = NULL,
        last_error = ${input.reason},
        updated_at = NOW()
    WHERE id = ${input.id}
  `);
}

async function markPendingDeliveryDelivered(id: string): Promise<void> {
  await getDb().execute(sql`
    UPDATE integration_watch_deliveries
    SET status = 'delivered',
        provisioning_sandbox_id = NULL,
        run_deployment_id = NULL,
        run_sandbox_id = NULL,
        run_session_id = NULL,
        run_command_id = NULL,
        run_started_at = NULL,
        run_sandbox_name = NULL,
        run_mount_configured = NULL,
        delivered_at = NOW(),
        lease_until = NULL,
        last_error = NULL,
        updated_at = NOW()
    WHERE id = ${id}
  `);
}

async function markPendingDeliveryRunning(input: {
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
  };
}): Promise<void> {
  await getDb().execute(sql`
    UPDATE integration_watch_deliveries
    SET status = 'running',
        provisioning_sandbox_id = NULL,
        run_deployment_id = ${input.run.deploymentId},
        run_sandbox_id = ${input.run.sandboxId},
        run_session_id = ${input.run.sessionId},
        run_command_id = ${input.run.commandId},
        run_started_at = ${input.run.startedAt}::timestamp with time zone,
        run_sandbox_name = ${input.run.sandboxName ?? null},
        run_mount_configured = ${input.run.mountConfigured ?? null},
        next_attempt_at = NOW() + ('15 seconds')::interval,
        lease_until = NULL,
        last_error = ${truncateError(input.error)},
        updated_at = NOW()
    WHERE id = ${input.id}
  `);
}

async function markPendingDeliveryFailed(input: {
  id: string;
  attemptCount: number;
  error: unknown;
  maxAttempts: number;
  clearProvisioningSandboxId?: boolean;
  clearRunState?: boolean;
}): Promise<"pending" | "failed"> {
  const nextAttempt = input.attemptCount + 1;
  const terminal = nextAttempt >= input.maxAttempts;
  // CAS / idempotent: the status guard ensures a crash-recovery mark-failed (e.g.
  // the Lane-6 terminal-box short-circuit) never clobbers a row that already
  // reached a genuine terminal state (delivered/failed) via another writer, and a
  // double mark-failed becomes a no-op. The return stays attempt-derived: a no-op
  // is a benign already-resolved row, and re-dispatch is driven by
  // next_attempt_at/the claim query, which the guard leaves untouched.
  await getDb().execute(sql`
    UPDATE integration_watch_deliveries
    SET status = ${terminal ? "failed" : "pending"},
        attempt_count = ${nextAttempt},
        next_attempt_at = CASE
          WHEN ${terminal} THEN next_attempt_at
          ELSE NOW() + (${retryDelaySeconds(nextAttempt)} || ' seconds')::interval
        END,
        lease_until = NULL,
        provisioning_sandbox_id = CASE
          WHEN ${Boolean(input.clearProvisioningSandboxId)} THEN NULL
          ELSE provisioning_sandbox_id
        END,
        run_deployment_id = CASE
          WHEN ${Boolean(input.clearRunState)} THEN NULL
          ELSE run_deployment_id
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
        last_error = ${truncateError(input.error)},
        updated_at = NOW()
    WHERE id = ${input.id}
      AND status NOT IN ('delivered', 'failed')
  `);
  return terminal ? "failed" : "pending";
}

async function markPendingDeliveryTerminal(input: {
  id: string;
  error: unknown;
  clearProvisioningSandboxId?: boolean;
}): Promise<void> {
  await getDb().execute(sql`
    UPDATE integration_watch_deliveries
    SET status = 'failed',
        next_attempt_at = next_attempt_at,
        lease_until = NULL,
        provisioning_sandbox_id = CASE
          WHEN ${Boolean(input.clearProvisioningSandboxId)} THEN NULL
          ELSE provisioning_sandbox_id
        END,
        last_error = ${truncateError(input.error)},
        updated_at = NOW()
    WHERE id = ${input.id}
      AND status NOT IN ('delivered', 'failed')
  `);
}

async function readTeamLaunchAgentContext(row: PendingDeliveryRow): Promise<TeamLaunchAgentContext | null> {
  const result = await getDb().execute(sql`
    SELECT
      agents.deployed_by_user_id,
      workspaces.organization_id,
      persona_versions.spec AS persona_spec
    FROM agents
    INNER JOIN workspaces ON workspaces.id = agents.workspace_id
    LEFT JOIN persona_versions ON persona_versions.id = agents.pinned_version_id
    WHERE agents.workspace_id = ${row.workspace_id}
      AND agents.id = ${row.agent_id}
    LIMIT 1
  `);
  const [context] = rowsOf<TeamLaunchAgentContext>(result);
  return context ?? null;
}

async function releaseTeamLaunchDedupeClaims(row: PendingDeliveryRow): Promise<void> {
  const issueKey = issueDedupeKeyFromDeliveryPayload(row.payload);
  await Promise.all([
    releaseIssueDispatchDedupe({
      workspaceId: row.workspace_id,
      agentId: row.agent_id,
      issueKey,
    }),
    releaseVfsWatchDedupe({
      workspaceId: row.workspace_id,
      agentId: row.agent_id,
      writeId: row.delivery_id,
    }),
  ]);
}

async function recordTeamMemberSandbox(input: {
  memberId: string;
  sandboxId: string;
}): Promise<void> {
  await getDb().execute(sql`
    UPDATE team_members
    SET sandbox_id = ${input.sandboxId},
        updated_at = NOW()
    WHERE id = ${input.memberId}
  `);
}

/**
 * Launch ONE roster member (or the verbatim null-roster fallback). Returns the
 * per-member outcome; throwing is reserved for errors the caller decides are
 * retryable (it rethrows only when nothing has launched yet).
 */
async function launchTeamMemberForDelivery(input: {
  row: PendingDeliveryRow;
  context: TeamLaunchAgentContext;
  memberConfig: TeamRosterMemberConfig | null;
  // Orphaned sandbox from a previous drain attempt — offered only to the
  // first not-yet-launched member so a resume reuses it instead of leaking it.
  provisioningSandboxId: string | null;
}): Promise<
  | { outcome: "launched"; sandboxId: string | null }
  | { outcome: "skipped"; reason: string }
> {
  const { row, context, memberConfig } = input;
  const launchPayload = await buildTeamLaunchPayload({
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    deliveryId: row.delivery_id,
    payload: row.payload,
    deployedByUserId: context.deployed_by_user_id,
    organizationId: context.organization_id ?? row.workspace_id,
    memberConfig,
  });
  let sandboxIdThisAttempt: string | null = input.provisioningSandboxId;
  const persistSandboxCreated = async (sandboxId: string) => {
    sandboxIdThisAttempt = sandboxId;
    await recordPendingDeliverySandboxCreated({
      id: row.id,
      sandboxId,
    });
  };
  let teamLaunch: Awaited<ReturnType<typeof dispatchTeamLaunchN1>>;
  try {
    teamLaunch = await dispatchTeamLaunchN1({
      workspaceId: row.workspace_id,
      agentId: row.agent_id,
      deliveryId: row.delivery_id,
      payload: launchPayload,
      provisioningSandboxId: input.provisioningSandboxId ?? undefined,
    }, {
      buildLaunchOptions: (buildInput) => buildTeamLaunchMemberOptions({
        ...buildInput,
        memberConfig,
        onSandboxCreated: persistSandboxCreated,
        onProvisioningSandboxCreated: persistSandboxCreated,
      }),
      launchMember: launchTeamMember,
    });
  } catch (error) {
    // 524-as-ambiguous-success: Daytona's exec proxy enforces a ~120s budget.
    // When the member bootstrap exec times out at the proxy AFTER the sandbox
    // exists, the bootstrap keeps running IN-BOX — the launch very likely
    // succeeded and only our observation of it failed. Treating that as a
    // generic failure is what manufactured the #1820 sibling-PR storm: each
    // retry re-dispatched another bootstrap into the same (or a fresh) box and
    // every sibling opened its own PR. With a sandbox id in hand, mark the
    // member launched and let the in-box run finish on its own; the
    // workflow-level run lock (acquire-run-lock step) makes a rare
    // false-positive retry a no-op rather than a duplicate member.
    if (sandboxIdThisAttempt && isDaytonaProxyTimeoutError(error)) {
      await logger.warn("Integration watch teamSolve launch ambiguous-success (proxy timeout after dispatch)", {
        area: "team-launch-n1",
        diag: "launch-ambiguous-success",
        workspaceId: row.workspace_id,
        agentId: row.agent_id,
        deliveryId: row.delivery_id,
        memberName: memberConfig?.memberName,
        sandboxId: sandboxIdThisAttempt,
        error: truncateError(error),
      });
      return { outcome: "launched", sandboxId: sandboxIdThisAttempt };
    }
    throw error;
  }
  if (teamLaunch.status === "skipped") {
    return { outcome: "skipped", reason: teamLaunch.reason };
  }

  await logger.info("Integration watch teamSolve member launched", {
    area: "team-launch-n1",
    diag: "launched",
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    deliveryId: row.delivery_id,
    memberName: teamLaunch.memberName,
    assignedRoot: teamLaunch.assignedRoot,
    localRoot: teamLaunch.localRoot,
    writeScopes: teamLaunch.writeScopes,
  });
  return { outcome: "launched", sandboxId: teamLaunch.sandboxId ?? sandboxIdThisAttempt };
}

async function deliverTeamLaunchN1(row: PendingDeliveryRow): Promise<"delivered" | "terminal"> {
  const context = await readTeamLaunchAgentContext(row);
  if (!context?.deployed_by_user_id) {
    throw new TeamLaunchOptionsUnavailableError(
      "teamLaunchN1 launch payload unavailable: deployedByUserId is missing",
    );
  }
  const rosterConfigs = await readTeamRosterMemberConfigs({
    workspaceId: row.workspace_id,
    leadAgentId: row.agent_id,
    memberName: null,
  });
  // Member cap re-derived from the persona spec with the same resolver the
  // dispatcher gate uses — nothing rides in the payload. No spec (legacy rows,
  // unpinned agents) degrades to the proven single-member behavior.
  const maxMembers = teamSolveMaxMembers(context.persona_spec) ?? 1;
  const cappedConfigs: Array<TeamRosterMemberConfig | null> =
    rosterConfigs.length > 0 ? rosterConfigs.slice(0, maxMembers) : [null];
  if (rosterConfigs.length > maxMembers) {
    // No silent caps: surfacing dropped roster rows is what makes a
    // misconfigured roster diagnosable from logs alone.
    await logger.warn("Integration watch teamSolve roster exceeds maxMembers; extra members not launched", {
      area: "team-launch-n1",
      diag: "roster-capped",
      workspaceId: row.workspace_id,
      agentId: row.agent_id,
      deliveryId: row.delivery_id,
      maxMembers,
      rosterCount: rosterConfigs.length,
      droppedMembers: rosterConfigs.slice(maxMembers).map((member) => member.memberName),
    });
  }

  let launched = 0;
  // The delivery row tracks at most one orphaned provisioning sandbox; offer
  // it to the first member that actually launches this attempt, then null.
  let provisioningSandboxId: string | null = row.provisioning_sandbox_id ?? null;
  for (const memberConfig of cappedConfigs) {
    if (memberConfig?.sandboxId) {
      // A previous drain attempt already launched this member (its sandbox id
      // is durably recorded) — a retry must not spawn a sibling (#1820 class).
      if (provisioningSandboxId && provisioningSandboxId === memberConfig.sandboxId) {
        // The row-level orphan is THIS member's box (crash window: member
        // sandbox recorded, delivery row not yet cleared). Consume it here so
        // it is never offered to a DIFFERENT member below — resuming member
        // B into member A's box would break per-member isolation.
        provisioningSandboxId = null;
      }
      await logger.info("Integration watch teamSolve member already launched; skipping", {
        area: "team-launch-n1",
        diag: "member-already-launched",
        workspaceId: row.workspace_id,
        agentId: row.agent_id,
        deliveryId: row.delivery_id,
        memberName: memberConfig.memberName,
        sandboxId: memberConfig.sandboxId,
      });
      launched += 1;
      continue;
    }
    let result: Awaited<ReturnType<typeof launchTeamMemberForDelivery>>;
    try {
      result = await launchTeamMemberForDelivery({
        row,
        context,
        memberConfig,
        provisioningSandboxId,
      });
    } catch (error) {
      if (launched === 0) {
        // Nothing launched yet: preserve the original retryable-failure
        // semantics (pending/terminal decided by the caller's attempt logic).
        throw error;
      }
      // Partial failure after at least one member launched: retrying the row
      // would re-launch nothing for recorded members (sandbox_id skip above)
      // but a retry storm risks sibling boxes for THIS member — log loudly,
      // keep the delivery delivered, and leave reconciliation to the sweep.
      await logger.error("Integration watch teamSolve member launch failed after partial success", {
        area: "team-launch-n1",
        diag: "member-partial-failure",
        workspaceId: row.workspace_id,
        agentId: row.agent_id,
        deliveryId: row.delivery_id,
        memberName: memberConfig?.memberName,
        launchedSoFar: launched,
        error: truncateError(error),
      });
      continue;
    }
    if (result.outcome === "skipped") {
      await logger.info("Integration watch teamSolve skipped in delivery drain", {
        area: "team-launch-n1",
        diag: "dispatch-skipped",
        workspaceId: row.workspace_id,
        agentId: row.agent_id,
        deliveryId: row.delivery_id,
        memberName: memberConfig?.memberName,
        skipReason: result.reason,
      });
      continue;
    }
    launched += 1;
    provisioningSandboxId = null;
    if (memberConfig?.memberId && result.sandboxId) {
      await recordTeamMemberSandbox({
        memberId: memberConfig.memberId,
        sandboxId: result.sandboxId,
      });
    }
  }

  return launched > 0 ? "delivered" : "terminal";
}

/**
 * #1516 Bug 1 — cooldown trailing edge. A PR-context dispatch suppressed by the
 * issue-dispatch cooldown records a pending coalesced re-dispatch on its dedup
 * row (`pending_delivery_id`/`pending_payload`, set by `claimIssueDispatchDedupe`).
 * This sweep, run once per drain tick, finds dedup rows whose cooldown window has
 * since expired and enqueues exactly ONE re-dispatch per (workspace, issue,
 * agent) — picking up reviewers (e.g. cubic) who commented inside the window and
 * were otherwise dropped. It atomically clears the pending marker and resets
 * `updated_at` (starting a fresh window), so it fires once per window and any
 * reviewer who comments during the re-fire coalesces into the next window.
 * Concurrency-safe via FOR UPDATE SKIP LOCKED. Best-effort: a failure logs and
 * is retried next tick — never breaks the main drain.
 */
export async function sweepCoalescedIssueDispatchRedispatches(input: {
  workspaceId?: string;
  agentId?: string;
}): Promise<number> {
  const cooldownSeconds = readIssueDispatchCooldownSeconds();
  let fired = 0;
  try {
    const result = await getDb().execute(sql`
      WITH expired AS (
        SELECT id, workspace_id, agent_id, issue_key, pending_delivery_id, pending_payload
        FROM integration_watch_issue_dispatch_dedup
        WHERE pending_delivery_id IS NOT NULL
          AND updated_at < NOW() - (${cooldownSeconds}::text || ' seconds')::interval
          AND (${input.workspaceId ?? null}::uuid IS NULL OR workspace_id = ${input.workspaceId ?? null}::uuid)
          AND (${input.agentId ?? null}::uuid IS NULL OR agent_id = ${input.agentId ?? null}::uuid)
        ORDER BY updated_at ASC
        LIMIT 50
        FOR UPDATE SKIP LOCKED
      ),
      cleared AS (
        UPDATE integration_watch_issue_dispatch_dedup d
        SET pending_delivery_id = NULL,
            pending_payload = NULL,
            updated_at = NOW()
        FROM expired e
        WHERE d.id = e.id
      )
      SELECT workspace_id, agent_id, pending_delivery_id, pending_payload
      FROM expired
    `);
    for (const row of rowsOf<{
      workspace_id: string;
      agent_id: string;
      pending_delivery_id: string;
      pending_payload: Record<string, unknown> | null;
    }>(result)) {
      // A pending row always carries a payload (recorded alongside the delivery
      // id); guard defensively so a malformed/null payload is skipped rather
      // than enqueuing a degenerate empty event.
      if (!row.pending_payload) {
        continue;
      }
      try {
        await enqueueIntegrationWatchDelivery({
          workspaceId: row.workspace_id,
          agentId: row.agent_id,
          deliveryId: row.pending_delivery_id,
          payload: row.pending_payload,
        });
        fired += 1;
      } catch (error) {
        await logger.warn("Integration watch coalesced re-dispatch enqueue failed", {
          area: "integration-watch-delivery",
          workspaceId: row.workspace_id,
          agentId: row.agent_id,
          deliveryId: row.pending_delivery_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    await logger.warn("Integration watch coalesced re-dispatch sweep failed", {
      area: "integration-watch-delivery",
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return fired;
}

export async function drainIntegrationWatchDeliveries(
  input: DrainIntegrationWatchDeliveriesInput,
): Promise<DrainIntegrationWatchDeliveriesResult> {
  const limit = input.limit ?? DEFAULT_DRAIN_LIMIT;
  const leaseSeconds = input.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxDeliveryAgeSeconds = input.maxDeliveryAgeSeconds ?? null;
  const rows = await claimPendingIntegrationWatchDeliveries({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    deliveryId: input.deliveryId,
    limit,
    leaseSeconds,
    maxDeliveryAgeSeconds,
  });

  let delivered = 0;
  let pending = 0;
  let terminal = 0;
  for (const row of rows) {
    const isTeamLaunchN1 = isTeamLaunchN1Payload(row.payload);
    const isFactoryBrain = isFactoryBrainDeliveryPayload(row.payload);
    try {
      if (isFactoryBrain) {
        const context = await readTeamLaunchAgentContext(row);
        const result = await dispatchFactoryBrainDelivery({
          workspaceId: row.workspace_id,
          agentId: row.agent_id,
          deliveryId: row.delivery_id,
          payload: row.payload,
          deployedByUserId: context?.deployed_by_user_id,
        });
        await logger.info("Integration watch factory brain delivery emitted", {
          area: "factory-cloud-brain",
          diag: "delivery-emitted",
          workspaceId: row.workspace_id,
          agentId: row.agent_id,
          deliveryId: row.delivery_id,
          issueKey: result.issueKey,
          recipe: result.recipe,
          emitted: result.emitted,
          invocationIds: result.invocationIds,
        });
        await markPendingDeliveryDelivered(row.id);
        delivered += 1;
        continue;
      }

      if (isTeamLaunchN1 && !input.allowTeamLaunchN1) {
        await markPendingDeliveryTeamLaunchDeferred({
          id: row.id,
          reason: "teamLaunchN1 delivery deferred to relaycron sweep",
        });
        pending += 1;
        await logger.info("Integration watch teamSolve N=1 deferred to sweep", {
          area: "team-launch-n1",
          diag: "sweep-only",
          workspaceId: row.workspace_id,
          agentId: row.agent_id,
          deliveryId: row.delivery_id,
        });
        continue;
      }

      if (isTeamLaunchN1) {
        const teamLaunchStatus = await deliverTeamLaunchN1(row);
        if (teamLaunchStatus === "terminal") {
          await releaseTeamLaunchDedupeClaims(row);
          await markPendingDeliveryTerminal({
            id: row.id,
            error: new Error("teamLaunchN1 skipped"),
          });
          terminal += 1;
        } else {
          await markPendingDeliveryDelivered(row.id);
          delivered += 1;
        }
      } else if (
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
          deliveryId: row.delivery_id,
          deploymentId: row.run_deployment_id,
          sandboxId: row.run_sandbox_id,
          sessionId: row.run_session_id,
          commandId: row.run_command_id,
          startedAt: row.run_started_at instanceof Date
            ? row.run_started_at.toISOString()
            : row.run_started_at,
          sandboxName: row.run_sandbox_name,
          mountConfigured: row.run_mount_configured ?? undefined,
          options: input.deliveryOptions,
        });
      } else {
        const triggerInput: Parameters<typeof deliverDeploymentTrigger>[0] = {
          workspaceId: row.workspace_id,
          agentId: row.agent_id,
          payload: row.payload,
          deliveryId: row.delivery_id,
          options: input.deliveryOptions,
        };
        if (row.provisioning_sandbox_id) {
          triggerInput.provisioningSandboxId = row.provisioning_sandbox_id;
        }
        await deliverDeploymentTrigger(triggerInput);
      }
      if (!isTeamLaunchN1) {
        await markPendingDeliveryDelivered(row.id);
        delivered += 1;
      }
    } catch (error) {
      if (
        error instanceof DeploymentSandboxProvisioningPendingError ||
        isWorkflowSandboxProvisioningPendingError(error)
      ) {
        await markPendingDeliveryProvisioning({
          id: row.id,
          sandboxId: error.sandboxId,
          error,
        });
        pending += 1;
        await logger.info("Integration watch delivery sandbox still provisioning", {
          area: "integration-watch-delivery",
          workspaceId: row.workspace_id,
          agentId: row.agent_id,
          deliveryId: row.delivery_id,
          sandboxId: error.sandboxId,
        });
        continue;
      }
      if (isTeamLaunchN1 && error instanceof TeamLaunchOptionsUnavailableError) {
        await releaseTeamLaunchDedupeClaims(row);
        await markPendingDeliveryTerminal({
          id: row.id,
          error,
        });
        terminal += 1;
        await logger.warn("Integration watch teamSolve N=1 terminal skip", {
          area: "team-launch-n1",
          workspaceId: row.workspace_id,
          agentId: row.agent_id,
          deliveryId: row.delivery_id,
          error: truncateError(error),
        });
        continue;
      }
      if (error instanceof DeploymentTriggerRunPendingError) {
        await markPendingDeliveryRunning({
          id: row.id,
          error,
          run: error.run,
        });
        pending += 1;
        await logger.info("Integration watch delivery run still running", {
          area: "integration-watch-delivery",
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
      if (errorIndicatesCleanupOnlyHandlerSuccess(error, row)) {
        await markPendingDeliveryDelivered(row.id);
        delivered += 1;
        await logger.info("delivery.cleanup_nonzero_but_complete", {
          area: "integration-watch-delivery",
          workspaceId: row.workspace_id,
          agentId: row.agent_id,
          deliveryId: row.delivery_id,
        });
        continue;
      }
      const nextStatus = await markPendingDeliveryFailed({
        id: row.id,
        attemptCount: row.attempt_count,
        error,
        maxAttempts,
        // WorkflowSandboxResumeMissingError: the persisted box was deleted
        // out from under us (operator kill or org auto-reaper). Clearing the
        // id makes the NEXT attempt provision fresh instead of resuming a
        // dead id forever; the attempt increment below makes each such cycle
        // burn retry budget, bounding the cross-box conveyor that drove the
        // #1820 sibling-PR storm.
        clearProvisioningSandboxId:
          error instanceof DeploymentSandboxProvisioningTerminalError ||
          isWorkflowSandboxResumeMissingError(error),
        clearRunState: Boolean(row.run_command_id),
      });
      if (nextStatus === "failed") {
        terminal += 1;
      } else {
        pending += 1;
      }
      await logger.warn("Integration watch pending delivery failed", {
        area: "integration-watch-delivery",
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
    await logger.info("Integration watch pending delivery drain completed", {
      area: "integration-watch-delivery",
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
