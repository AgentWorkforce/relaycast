import { Buffer } from "node:buffer";
import { NextRequest, NextResponse } from "next/server";
import {
  and,
  desc,
  eq,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  WORKFORCE_RUNTIME_AWS_SMITHY_SPECS,
  WORKFORCE_RUNTIME_PACKAGE,
  WORKFORCE_RUNTIME_SMITHY_DIAGNOSTIC,
  WORKFORCE_RUNTIME_SMITHY_LOAD_CHECK,
  WORKFORCE_RUNTIME_SPEC,
  WORKFORCE_RUNTIME_VERSION,
  parseWorkforceRuntimePackageSpec,
} from "@cloud/core/proactive-runtime/runtime-package.js";
import {
  buildEvidenceFromHop,
  emitCloudEvidence,
} from "@cloud/core/observability/evidence-emitter.js";
import { resolveTelemetryMeta } from "@cloud/core/observability/telemetry-meta.js";
import { getCloudflareContext } from "@/lib/cloudflare-context";
import { getDb } from "@/lib/db";
import { agents, personas, personaVersions } from "@/lib/db/schema";
import { resolveProviderCredentialRuntimeEnv } from "@/lib/billing/provider-credential-runtime";
import { readCloudflareWaitUntil } from "@/lib/proactive-runtime/cloudflare-waituntil";
import { enqueueIntegrationWatchDeliveryDrain } from "@/lib/proactive-runtime/integration-watch-delivery-queue";
import { renderAgentsMd } from "@/lib/proactive-runtime/agents-md";
import type { AgentsMdInput } from "@/lib/proactive-runtime/agents-md";
import {
  requireAuthScope,
  requireSessionAuth,
  resolveRequestAuth,
} from "@/lib/auth/request-auth";
import {
  hasWorkspaceIntegrationAccess,
  resolveWorkspaceIntegrationIdentity,
} from "@/lib/workspaces/workspace-integration-identity";
import { recordPersonaBundleDeploymentCreated } from "@/lib/proactive-runtime/persona-deploy-audit";
import { recycleDeploymentSandboxes } from "@/lib/proactive-runtime/deployment-sandbox-recycle";
import {
  PersonaDeployError,
  createInitialAgentDeployment,
  parsePersonaBundleDeployRequest,
  preparePersonaDeploy,
  rollbackPreparedPersonaDeploy,
  type PersonaBundle,
} from "@/lib/proactive-runtime/persona-deploy";
import {
  DEFAULT_SANDBOX_TIMEOUT_SECONDS,
  isRecord,
  jsonError,
  readJsonBody,
  type ErrorResponse,
} from "../sandboxes/sandbox-utils";
import { POST as createSandbox } from "../sandboxes/route";
import { DELETE as deleteSandbox } from "../sandboxes/[sandboxId]/route";
import { POST as executeSandboxCommand } from "../sandboxes/[sandboxId]/exec/route";
import { PUT as uploadSandboxFiles } from "../sandboxes/[sandboxId]/files/route";

const WORKFORCE_RUNTIME_AWS_SMITHY_INSTALL_SPECS =
  WORKFORCE_RUNTIME_AWS_SMITHY_SPECS.join(" ");

type DeploymentRouteContext = {
  params: Promise<{ workspaceId: string }>;
};

type DeploymentWorkspaceContext = {
  routeWorkspaceId: string;
  appWorkspaceId: string;
  relayWorkspaceId: string;
};

type DeployResponse = {
  agentId: string;
  workspaceId: string;
  /**
   * `ready` — bundle + metadata persisted; no warm sandbox provisioned.
   *   The tick handler provisions a sandbox on the first trigger fire
   *   (cron tick / integration webhook), runs to completion, tears down.
   * `failed` — deploy POST itself failed (validation, DB, etc.). Sandbox
   *   failures can't happen at deploy time anymore — they surface on the
   *   tick path.
   *
   * `starting` / `active` are retained for legacy API consumers but are
   * never emitted by current code; deploy POST has been simplified to a
   * pure metadata operation per the cold-start runtime model.
   */
  status: "ready" | "failed" | "starting" | "active";
  deploymentId: string;
  recycledSandboxes?: number;
  recycleWarning?: string;
};

const STALE_SANDBOX_RECYCLE_WARNING =
  "Daytona sandbox recycle failed; stale warm sandbox persists, so the new bundle will not take effect until that sandbox is gone. The next deploy will retry recycle, or an operator can delete the sandbox manually.";

const STALE_SANDBOX_RECYCLE_LOG =
  "[persona-bundle-deploy] warm sandbox recycle failed after deploy commit; stale warm sandbox persists, so the new bundle will not take effect until that sandbox is gone";

const INTEGRATION_WATCH_LAPSE_HOURS = 12;
const INTEGRATION_WATCH_HEALTH_REDRIVE_LIMIT = 3;

type IntegrationWatchHealth = {
  status: "not_configured" | "healthy" | "unhealthy" | "unknown";
  reason: string | null;
  lastSuccessfulDeliveryAt: string | null;
  lastDeliveryAt: string | null;
  lastFailedDeliveryAt: string | null;
  pendingDeliveryCount: number;
  recentFailedDeliveryCount: number;
  recentWorkspaceDispatchFailureCount: number;
  latestWorkspaceDispatchFailureAt: string | null;
};

type ListResponse = {
  agents: Array<{
    agentId: string;
    personaId: string;
    deployedName: string;
    status: string;
    createdAt: string;
    lastUsedAt: string | null;
    lastFiredAt: string | null;
    lastCompletedAt: string | null;
    lastRunStatus: string | null;
    lastError: string | null;
    runCount: number;
    scheduleIds: string[];
    scheduleSpecs: DeploymentScheduleSpec[];
    inputValues: Record<string, string>;
    inputSpecs: DeploymentInputSpecs;
    imageUrl: string | null;
    personaDescription: string | null;
    deployedByUserId: string;
    integrationWatchHealth: IntegrationWatchHealth;
  }>;
  nextCursor: string | null;
};

type DeploymentInputPicker = {
  provider: string;
  resource: string;
};

type DeploymentInputSpec = {
  picker?: DeploymentInputPicker;
};

type DeploymentInputSpecs = Record<string, DeploymentInputSpec>;

type DeploymentScheduleSpec = {
  id?: string;
  cronExpression: string;
  timezone: string;
  name?: string;
};

type RawRows<T> = { rows?: T[] };

type AgentRunSummaryRow = {
  agent_id: string;
  last_fired_at: Date | string | null;
  last_completed_at: Date | string | null;
  run_count: number | string | bigint | null;
};

type AgentLatestRunRow = {
  agent_id: string;
  last_run_status: string | null;
  last_error: string | null;
};

export type AgentIntegrationWatchHealthRow = {
  agent_id: string;
  agent_created_at: Date | string;
  last_successful_delivery_at: Date | string | null;
  last_delivery_at: Date | string | null;
  last_failed_delivery_at: Date | string | null;
  recent_failed_delivery_count: number | string | bigint | null;
  pending_delivery_count: number | string | bigint | null;
};

type WorkspaceIntegrationWatchFailureSummaryRow = {
  recent_failure_count: number | string | bigint | null;
  latest_failure_at: Date | string | null;
};

function canDeploy(auth: NonNullable<Awaited<ReturnType<typeof resolveRequestAuth>>>): boolean {
  return (
    requireSessionAuth(auth) ||
    requireAuthScope(auth, "cli:auth") ||
    requireAuthScope(auth, "deployments:write")
  );
}

function canList(auth: NonNullable<Awaited<ReturnType<typeof resolveRequestAuth>>>): boolean {
  return (
    requireSessionAuth(auth) ||
    requireAuthScope(auth, "cli:auth") ||
    requireAuthScope(auth, "deployments:read")
  );
}

async function resolveDeploymentWorkspace(
  auth: NonNullable<Awaited<ReturnType<typeof resolveRequestAuth>>>,
  routeWorkspaceId: string,
): Promise<DeploymentWorkspaceContext | NextResponse<ErrorResponse>> {
  let identity: Awaited<ReturnType<typeof resolveWorkspaceIntegrationIdentity>>;
  try {
    identity = await resolveWorkspaceIntegrationIdentity(routeWorkspaceId);
  } catch {
    return jsonError("Workspace not found", "workspace_not_found", 404);
  }
  // Access check first so a non-existent/unbound id can't be distinguished
  // from a forbidden one (no existence leak).
  if (!hasWorkspaceIntegrationAccess(auth, identity)) {
    return jsonError("Forbidden", "forbidden", 403);
  }
  // The resolved app workspace id feeds uuid-typed DB columns
  // (e.g. agents.workspaceId). An unbound rw_ resolves to a null/non-uuid
  // app id; guard here so it returns a deterministic 404 instead of a
  // Postgres 22P02 (uncontrolled 500) downstream.
  const appWorkspaceId = identity.appWorkspaceId ?? identity.requestedWorkspaceId;
  if (!isUuid(appWorkspaceId)) {
    return jsonError("Workspace not found", "workspace_not_found", 404);
  }

  return {
    routeWorkspaceId: identity.requestedWorkspaceId,
    appWorkspaceId,
    relayWorkspaceId: identity.relayWorkspaceId,
  };
}

function packageJsonWithRuntimeDependency(packageJson: Record<string, unknown>): Record<string, unknown> {
  const dependencies =
    isRecord(packageJson.dependencies) ? { ...packageJson.dependencies } : {};
  dependencies[WORKFORCE_RUNTIME_PACKAGE] = WORKFORCE_RUNTIME_VERSION;
  for (const spec of WORKFORCE_RUNTIME_AWS_SMITHY_SPECS) {
    const { name, version } = parseWorkforceRuntimePackageSpec(spec);
    dependencies[name] = version;
  }
  return {
    ...packageJson,
    dependencies,
  };
}

function bundleFileEntries(bundle: PersonaBundle, persona: unknown, agentsMd?: string): Array<{
  source: Buffer;
  destination: string;
}> {
  const packageJson = packageJsonWithRuntimeDependency(bundle.packageJson);
  const entries: Array<{ source: Buffer; destination: string }> = [
    {
      source: Buffer.from(bundle.runner, "utf8"),
      destination: "/workspace/runner.mjs",
    },
    {
      source: Buffer.from(bundle.agent, "utf8"),
      destination: "/workspace/agent.bundle.mjs",
    },
    {
      source: Buffer.from(JSON.stringify(persona, null, 2), "utf8"),
      destination: "/workspace/persona.json",
    },
    {
      source: Buffer.from(JSON.stringify(packageJson, null, 2), "utf8"),
      destination: "/workspace/package.json",
    },
  ];
  if (agentsMd) {
    entries.push({
      source: Buffer.from(agentsMd, "utf8"),
      destination: "/workspace/AGENTS.md",
    });
  }
  return entries;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function requestWithJsonBody(
  parent: NextRequest,
  pathname: string,
  method: string,
  body?: unknown,
): NextRequest {
  const headers = new Headers(parent.headers);
  headers.set("content-type", "application/json");
  return new NextRequest(new URL(pathname, parent.url), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function readRouteJson<T>(
  response: NextResponse<T | ErrorResponse>,
  fallback: { message: string; code: string },
): Promise<T> {
  const payload = (await response.json().catch(() => null)) as
    | (T & Partial<ErrorResponse>)
    | null;
  if (!response.ok) {
    throw new PersonaDeployError(
      payload?.error ?? fallback.message,
      payload?.code ?? fallback.code,
      response.status,
      payload ?? undefined,
    );
  }
  if (!payload) {
    throw new PersonaDeployError(fallback.message, fallback.code, 500);
  }
  return payload as T;
}

type CreateSandboxResponse = {
  sandboxId: string;
  status: "running";
  authMode: "proxy";
  organizationId: string | null;
  expiresAt: string;
  execUrl: string;
  filesUrl: string;
};

type ExecSandboxResponse = {
  sandboxId: string;
  exitCode: number;
  output: string;
};

function runtimeAgentContext(input: {
  agentId: string;
  deployedName: string;
  inputValues: Record<string, string>;
}): string {
  return JSON.stringify({
    id: input.agentId,
    deployedName: input.deployedName,
    spawnedByAgentId: null,
    input_values: input.inputValues,
    inputValues: input.inputValues,
  });
}

function runtimeDeploymentContext(input: {
  deploymentId: string;
  triggerKind: "inbox" | "clock";
  parentDeploymentId?: string | null;
}): string {
  return JSON.stringify({
    id: input.deploymentId,
    triggerKind: input.triggerKind,
    parentDeploymentId: input.parentDeploymentId ?? null,
  });
}

function runtimeDependencyInstallScript(): string {
  return [
    "if [ -f package.json ]; then",
    `npm install --omit=dev --no-audit --no-fund ${WORKFORCE_RUNTIME_SPEC} ${WORKFORCE_RUNTIME_AWS_SMITHY_INSTALL_SPECS}`,
    "else",
    `npm init -y >/dev/null 2>&1 && npm install --omit=dev --no-audit --no-fund ${WORKFORCE_RUNTIME_SPEC} ${WORKFORCE_RUNTIME_AWS_SMITHY_INSTALL_SPECS}`,
    "fi",
    `node -e ${shellSingleQuote(WORKFORCE_RUNTIME_SMITHY_DIAGNOSTIC)} || true`,
    // Re-emit the diagnostic on load-check failure so its [smithy-diag] lines are
    // the last captured output (the run record keeps only the output tail).
    `node -e ${shellSingleQuote(`${WORKFORCE_RUNTIME_SMITHY_LOAD_CHECK}.catch((error)=>{console.error('[proactive-runtime] runtime load failed:', error && error.stack || error);process.exit(1)})`)} || { echo "[proactive-runtime] runtime load check failed"; node -e ${shellSingleQuote(WORKFORCE_RUNTIME_SMITHY_DIAGNOSTIC)} || true; exit 1; }`,
  ].join("\n");
}

function runnerStartScript(): string {
  return [
    runtimeDependencyInstallScript(),
    ": > runner.log",
    "node runner.mjs </dev/null >> runner.log 2>&1 &",
    "pid=$!",
    "echo $pid > runner.pid",
    "sleep 2",
    "if kill -0 \"$pid\" 2>/dev/null; then echo \"started:$pid\"; exit 0; fi",
    "status=0",
    "wait \"$pid\" || status=$?",
    "if [ \"$status\" -ne 0 ]; then cat runner.log >&2; exit \"$status\"; fi",
    "echo \"completed:$status\"",
  ].join("; ");
}

async function deleteAgentDeployment(deploymentId: string): Promise<void> {
  await getDb().execute(sql`
    DELETE FROM agent_deployments
    WHERE id = ${deploymentId}
  `);
}

async function provisionSandbox(input: {
  request: NextRequest;
  origin: string;
  workspaceId: string;
  personaId: string;
  deployedName: string;
  agentId: string;
  deploymentId: string;
  inputValues: Record<string, string>;
  watchGlobs: string[];
  scheduleIds: string[];
  credentialSelections: Record<string, string>;
  credentialEnv: Record<string, string>;
  relayfileMountPaths: string[];
  webhookSecret: string;
  bundle: PersonaBundle;
  persona: unknown;
  agentsMd: string;
}): Promise<string> {
  const createResponse = await createSandbox(
    requestWithJsonBody(
      input.request,
      `/api/v1/workspaces/${encodeURIComponent(input.workspaceId)}/sandboxes`,
      "POST",
      {
        purpose: "workforce-deploy",
        personaId: input.personaId,
        agentId: input.agentId,
        label: input.deployedName,
        env: {
          ...input.credentialEnv,
          WORKFORCE_AGENT_ID: input.agentId,
          WORKFORCE_WORKSPACE_ID: input.workspaceId,
          WORKFORCE_AGENT_CONTEXT: runtimeAgentContext({
            agentId: input.agentId,
            deployedName: input.deployedName,
            inputValues: input.inputValues,
          }),
          WORKFORCE_DEPLOYMENT_CONTEXT: runtimeDeploymentContext({
            deploymentId: input.deploymentId,
            triggerKind: "inbox",
          }),
          WORKFORCE_WATCH_GLOBS: JSON.stringify(input.watchGlobs),
          WORKFORCE_SCHEDULE_IDS: JSON.stringify(input.scheduleIds),
          WORKFORCE_CREDENTIAL_SELECTIONS: JSON.stringify(input.credentialSelections),
          WORKFORCE_USAGE_URL:
            `${input.origin}/api/v1/workspaces/${encodeURIComponent(input.workspaceId)}` +
            `/deployments/${encodeURIComponent(input.agentId)}/usage`,
          WORKFORCE_DEPLOYMENT_TOKEN: input.webhookSecret,
          RELAY_AGENT_NAME: input.agentId,
          RELAY_DEFAULT_WORKSPACE: input.workspaceId,
        },
        relayfileMountPaths: input.relayfileMountPaths,
        timeoutSeconds: DEFAULT_SANDBOX_TIMEOUT_SECONDS,
      },
    ),
    { params: Promise.resolve({ workspaceId: input.workspaceId }) },
  );
  const sandbox = await readRouteJson<CreateSandboxResponse>(createResponse, {
    message: "Failed to create sandbox",
    code: "sandbox_create_failed",
  });

  try {
    await uploadSandboxFiles(
      requestWithJsonBody(
        input.request,
        `/api/v1/workspaces/${encodeURIComponent(input.workspaceId)}` +
          `/sandboxes/${encodeURIComponent(sandbox.sandboxId)}/files`,
        "PUT",
        {
          entries: bundleFileEntries(input.bundle, input.persona, input.agentsMd).map((entry) => ({
            source: entry.source.toString("base64"),
            destination: entry.destination,
          })),
        },
      ),
      {
        params: Promise.resolve({
          workspaceId: input.workspaceId,
          sandboxId: sandbox.sandboxId,
        }),
      },
    ).then((response) =>
      readRouteJson<{ sandboxId: string | undefined; uploaded: number }>(response, {
        message: "Failed to upload bundle files",
        code: "sandbox_file_upload_failed",
      }),
    );

    const startCommand = `sh -lc ${shellSingleQuote(runnerStartScript())}`;
    const execResult = await executeSandboxCommand(
      requestWithJsonBody(
        input.request,
        `/api/v1/workspaces/${encodeURIComponent(input.workspaceId)}` +
          `/sandboxes/${encodeURIComponent(sandbox.sandboxId)}/exec`,
        "POST",
        {
          command: startCommand,
          cwd: "/workspace",
          timeoutSeconds: 10,
        },
      ),
      {
        params: Promise.resolve({
          workspaceId: input.workspaceId,
          sandboxId: sandbox.sandboxId,
        }),
      },
    ).then((response) =>
      readRouteJson<ExecSandboxResponse>(response, {
        message: "Failed to start runner.mjs",
        code: "sandbox_exec_failed",
      }),
    );
    if (execResult.exitCode !== 0) {
      throw new PersonaDeployError(
        `runner.mjs exited with code ${execResult.exitCode}`,
        "runner_start_failed",
        502,
        { output: execResult.output },
      );
    }

    return sandbox.sandboxId;
  } catch (error) {
    try {
      await deleteSandbox(
        requestWithJsonBody(
          input.request,
          `/api/v1/workspaces/${encodeURIComponent(input.workspaceId)}` +
            `/sandboxes/${encodeURIComponent(sandbox.sandboxId)}`,
          "DELETE",
        ),
        {
          params: Promise.resolve({
            workspaceId: input.workspaceId,
            sandboxId: sandbox.sandboxId,
          }),
        },
      );
    } catch (cleanupError) {
      console.error(
        "[persona-bundle-deploy] rollback failed for sandbox",
        sandbox.sandboxId,
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      );
    }
    throw error;
  }
}

function parseCursor(value: string | null): { createdAt: Date; id: string } | null {
  if (!value) {
    return null;
  }
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  const [createdAtRaw, id] = decoded.split("|");
  const createdAt = new Date(createdAtRaw ?? "");
  if (!id || Number.isNaN(createdAt.getTime())) {
    return null;
  }
  return { createdAt, id };
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const candidate = result as RawRows<T>;
  return Array.isArray(candidate?.rows) ? candidate.rows : [];
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function deploymentPersonaSpec(spec: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!spec) return null;
  return isRecord(spec.persona) ? spec.persona : spec;
}

function deploymentAgentSpec(spec: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!spec) return null;
  return isRecord(spec.agent) ? spec.agent : spec;
}

function extractDeploymentInputSpecs(spec: Record<string, unknown> | null | undefined): DeploymentInputSpecs {
  const personaSpec = deploymentPersonaSpec(spec);
  if (!personaSpec || !isRecord(personaSpec.inputs)) {
    return {};
  }

  const inputSpecs: DeploymentInputSpecs = {};
  for (const [name, rawInput] of Object.entries(personaSpec.inputs)) {
    if (!isRecord(rawInput)) {
      continue;
    }

    const key = readNonEmptyString(rawInput.env) ?? name;
    const inputSpec: DeploymentInputSpec = {};
    if (isRecord(rawInput.picker)) {
      const provider = readNonEmptyString(rawInput.picker.provider);
      const resource = readNonEmptyString(rawInput.picker.resource);
      if (provider && resource) {
        inputSpec.picker = { provider, resource };
      }
    }
    inputSpecs[key] = inputSpec;
  }

  return inputSpecs;
}

function extractDeploymentScheduleSpecs(
  spec: Record<string, unknown> | null | undefined,
  scheduleIds: readonly string[],
): DeploymentScheduleSpec[] {
  const agentSpec = deploymentAgentSpec(spec);
  const rawSchedules = Array.isArray(agentSpec?.schedules)
    ? agentSpec.schedules
    : Array.isArray(spec?.schedules)
    ? spec.schedules
    : [];
  const scheduleSpecs: DeploymentScheduleSpec[] = [];
  for (const [index, rawSchedule] of rawSchedules.entries()) {
    if (!isRecord(rawSchedule)) {
      continue;
    }
    const cronExpression = readNonEmptyString(rawSchedule.cronExpression) ?? readNonEmptyString(rawSchedule.cron);
    if (!cronExpression) {
      continue;
    }
    const timezone = readNonEmptyString(rawSchedule.timezone) ?? readNonEmptyString(rawSchedule.tz) ?? "UTC";
    const id = readNonEmptyString(scheduleIds[index]);
    const name = readNonEmptyString(rawSchedule.name);
    scheduleSpecs.push({
      ...(id ? { id } : {}),
      cronExpression,
      timezone,
      ...(name ? { name } : {}),
    });
  }
  return scheduleSpecs;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toUuidArrayLiteral(values: readonly string[]): string {
  if (values.length === 0) return "{}";
  return `{${values.join(",")}}`;
}

async function getAgentRunSummaries(agentIds: readonly string[]): Promise<Map<string, AgentRunSummaryRow>> {
  if (agentIds.length === 0) {
    return new Map();
  }
  const result = await getDb().execute(sql`
    SELECT
      a.id AS agent_id,
      MAX(r.started_at) AS last_fired_at,
      MAX(r.ended_at) AS last_completed_at,
      COUNT(DISTINCT r.id) AS run_count
    FROM agents a
    LEFT JOIN agent_deployments d ON d.agent_id = a.id
    LEFT JOIN agent_deployment_runs r ON r.deployment_id = d.id
    WHERE a.id = ANY(${toUuidArrayLiteral(agentIds)}::uuid[])
    GROUP BY a.id
  `);
  return new Map(rowsOf<AgentRunSummaryRow>(result).map((row) => [row.agent_id, row]));
}

async function getAgentLatestRunSummaries(
  agentIds: readonly string[],
): Promise<Map<string, AgentLatestRunRow>> {
  if (agentIds.length === 0) {
    return new Map();
  }
  const result = await getDb().execute(sql`
    SELECT DISTINCT ON (d.agent_id)
      d.agent_id,
      r.status AS last_run_status,
      r.error AS last_error
    FROM agent_deployment_runs r
    INNER JOIN agent_deployments d ON d.id = r.deployment_id
    WHERE d.agent_id = ANY(${toUuidArrayLiteral(agentIds)}::uuid[])
    ORDER BY d.agent_id, r.started_at DESC, r.id DESC
  `);
  return new Map(rowsOf<AgentLatestRunRow>(result).map((row) => [row.agent_id, row]));
}

function countValue(value: number | string | bigint | null | undefined): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value) || 0;
  return 0;
}

function hasIntegrationWatchConfig(row: { watchGlobs?: string[] | null; watchRules?: unknown[] | null }): boolean {
  return (Array.isArray(row.watchGlobs) && row.watchGlobs.length > 0)
    || (Array.isArray(row.watchRules) && row.watchRules.length > 0);
}

export async function getAgentIntegrationWatchHealthSummaries(
  workspaceId: string,
  agentIds: readonly string[],
): Promise<Map<string, AgentIntegrationWatchHealthRow>> {
  if (agentIds.length === 0) {
    return new Map();
  }
  const result = await getDb().execute(sql`
    SELECT
      a.id AS agent_id,
      a.created_at AS agent_created_at,
      MAX(iwd.delivered_at) FILTER (WHERE iwd.status = 'delivered') AS last_successful_delivery_at,
      MAX(iwd.created_at) AS last_delivery_at,
      MAX(iwd.updated_at) FILTER (WHERE iwd.status = 'failed') AS last_failed_delivery_at,
      COUNT(*) FILTER (
        WHERE iwd.status = 'failed'
          AND iwd.updated_at >= NOW() - (${INTEGRATION_WATCH_LAPSE_HOURS}::int * INTERVAL '1 hour')
      ) AS recent_failed_delivery_count,
      COUNT(*) FILTER (WHERE iwd.status IN ('pending', 'processing', 'running')) AS pending_delivery_count
    FROM agents a
    LEFT JOIN integration_watch_deliveries iwd
      ON iwd.workspace_id = a.workspace_id
      AND iwd.agent_id = a.id
    WHERE a.workspace_id = ${workspaceId}
      AND a.id = ANY(${toUuidArrayLiteral(agentIds)}::uuid[])
      AND (
        COALESCE(array_length(a.watch_globs, 1), 0) > 0
        OR (a.watch_rules IS NOT NULL AND jsonb_array_length(a.watch_rules) > 0)
      )
    GROUP BY a.id, a.created_at
  `);
  return new Map(rowsOf<AgentIntegrationWatchHealthRow>(result).map((row) => [row.agent_id, row]));
}

async function getWorkspaceIntegrationWatchFailureSummary(
  workspaceId: string,
): Promise<WorkspaceIntegrationWatchFailureSummaryRow> {
  const result = await getDb().execute(sql`
    SELECT
      COUNT(*) FILTER (
        WHERE status = 'failed'
          AND updated_at >= NOW() - (${INTEGRATION_WATCH_LAPSE_HOURS}::int * INTERVAL '1 hour')
      ) AS recent_failure_count,
      MAX(updated_at) FILTER (WHERE status = 'failed') AS latest_failure_at
    FROM integration_watch_dispatch_failures
    WHERE relay_workspace_id = ${workspaceId}
  `);
  return rowsOf<WorkspaceIntegrationWatchFailureSummaryRow>(result)[0] ?? {
    recent_failure_count: 0,
    latest_failure_at: null,
  };
}

function deriveIntegrationWatchHealth(input: {
  hasWatchConfig: boolean;
  row?: AgentIntegrationWatchHealthRow;
  workspaceFailureSummary: WorkspaceIntegrationWatchFailureSummaryRow;
  now?: Date;
}): IntegrationWatchHealth {
  const recentWorkspaceDispatchFailureCount = countValue(input.workspaceFailureSummary.recent_failure_count);
  const base = {
    lastSuccessfulDeliveryAt: toIso(input.row?.last_successful_delivery_at),
    lastDeliveryAt: toIso(input.row?.last_delivery_at),
    lastFailedDeliveryAt: toIso(input.row?.last_failed_delivery_at),
    pendingDeliveryCount: countValue(input.row?.pending_delivery_count),
    recentFailedDeliveryCount: countValue(input.row?.recent_failed_delivery_count),
    recentWorkspaceDispatchFailureCount,
    latestWorkspaceDispatchFailureAt: toIso(input.workspaceFailureSummary.latest_failure_at),
  };
  if (!input.hasWatchConfig) {
    return {
      status: "not_configured",
      reason: null,
      ...base,
    };
  }

  const now = input.now ?? new Date();
  const staleBefore = now.getTime() - INTEGRATION_WATCH_LAPSE_HOURS * 60 * 60 * 1000;
  const lastSuccess = input.row?.last_successful_delivery_at
    ? new Date(input.row.last_successful_delivery_at).getTime()
    : null;
  const agentCreatedAt = input.row?.agent_created_at
    ? new Date(input.row.agent_created_at).getTime()
    : null;
  const hasRecentSuccess = typeof lastSuccess === "number" && !Number.isNaN(lastSuccess) && lastSuccess >= staleBefore;
  const oldEnoughToJudge = typeof agentCreatedAt === "number" && !Number.isNaN(agentCreatedAt) && agentCreatedAt < staleBefore;

  if (base.recentFailedDeliveryCount > 0) {
    return {
      status: "unhealthy",
      reason: "delivery_failures",
      ...base,
    };
  }
  if (!hasRecentSuccess && oldEnoughToJudge && lastSuccess !== null) {
    return {
      status: "unhealthy",
      reason: "no_successful_delivery_recently",
      ...base,
    };
  }
  if (!hasRecentSuccess) {
    return {
      status: "unknown",
      reason: "awaiting_first_successful_delivery",
      ...base,
    };
  }
  return {
    status: "healthy",
    reason: null,
    ...base,
  };
}

function logUnhealthyIntegrationWatch(input: {
  workspaceId: string;
  agentId: string;
  deployedName: string;
  health: IntegrationWatchHealth;
}): void {
  if (input.health.status !== "unhealthy") {
    return;
  }
  const event = {
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    deployedName: input.deployedName,
    reason: input.health.reason,
    lastSuccessfulDeliveryAt: input.health.lastSuccessfulDeliveryAt,
    lastDeliveryAt: input.health.lastDeliveryAt,
    lastFailedDeliveryAt: input.health.lastFailedDeliveryAt,
    pendingDeliveryCount: input.health.pendingDeliveryCount,
    recentFailedDeliveryCount: input.health.recentFailedDeliveryCount,
    recentWorkspaceDispatchFailureCount: input.health.recentWorkspaceDispatchFailureCount,
    latestWorkspaceDispatchFailureAt: input.health.latestWorkspaceDispatchFailureAt,
  };
  console.warn("[deployments-list] integration watch unhealthy", JSON.stringify(event));

  let env: Record<string, unknown> = process.env;
  try {
    env = {
      ...process.env,
      ...(getCloudflareContext({ async: false }).env ?? {}),
    };
  } catch {
    // Lambda/local route path: process.env is the only available source.
  }
  const waitUntil = readCloudflareWaitUntil();
  const waitUntilContext = waitUntil ? { waitUntil } : undefined;
  emitCloudEvidence(
    env as { NIGHTCTO_EVIDENCE_URL?: string; NIGHTCTO_EVIDENCE_TOKEN?: string },
    waitUntilContext,
    buildEvidenceFromHop(resolveTelemetryMeta(env as Parameters<typeof resolveTelemetryMeta>[0], "cloud-web"), {
      path: "deployments.integration-watch.health",
      kind: "health",
      outcome: "error",
      severity: input.health.reason === "delivery_failures" ? 7 : 6,
      requestId: `integration-watch-health:${input.workspaceId}:${input.agentId}`,
      summary: `Integration watch unhealthy for ${input.deployedName}: ${input.health.reason ?? "unknown"}`,
      counts: {
        errors: 1,
        messages: input.health.pendingDeliveryCount,
      },
      errorCode: input.health.reason ?? "integration_watch_unhealthy",
      inspect: {
        logQuery: `"[deployments-list] integration watch unhealthy" "${input.agentId}"`,
      },
    }),
  );
  if (input.health.pendingDeliveryCount > 0) {
    const redrive = enqueueIntegrationWatchDeliveryDrain({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      limit: Math.min(input.health.pendingDeliveryCount, INTEGRATION_WATCH_HEALTH_REDRIVE_LIMIT),
    });
    if (waitUntil) {
      waitUntil(redrive);
    } else {
      void redrive;
    }
  }
}

export async function GET(
  request: NextRequest,
  context: DeploymentRouteContext,
): Promise<NextResponse<ListResponse | ErrorResponse>> {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return jsonError("Unauthorized", "unauthorized", 401);
  }
  if (!canList(auth)) {
    return jsonError("Forbidden", "forbidden", 403);
  }

  const { workspaceId } = await context.params;
  if (!workspaceId) {
    return jsonError("Workspace not found", "workspace_not_found", 404);
  }
  const workspace = await resolveDeploymentWorkspace(auth, workspaceId);
  if (workspace instanceof NextResponse) {
    return workspace;
  }

  const status = request.nextUrl.searchParams.get("status")?.trim();
  const personaId = request.nextUrl.searchParams.get("personaId")?.trim();
  const cursor = parseCursor(request.nextUrl.searchParams.get("cursor"));
  const predicates = [eq(agents.workspaceId, workspace.appWorkspaceId)];
  if (status) {
    predicates.push(eq(agents.status, status));
  } else {
    predicates.push(ne(agents.status, "destroyed"));
  }
  if (personaId) {
    const personaPredicates = [eq(agents.deployedName, personaId)];
    if (isUuid(personaId)) {
      personaPredicates.push(eq(agents.personaId, personaId));
    }
    predicates.push(or(...personaPredicates)!);
  }
  if (cursor) {
    predicates.push(
      or(
        lt(agents.createdAt, cursor.createdAt),
        and(eq(agents.createdAt, cursor.createdAt), lt(agents.id, cursor.id)),
      )!,
    );
  }

  const rows = await getDb()
    .select({
      agentId: agents.id,
      personaId: agents.personaId,
      deployedName: agents.deployedName,
      imageUrl: agents.imageUrl,
      status: agents.status,
      createdAt: agents.createdAt,
      lastUsedAt: agents.lastUsedAt,
      scheduleIds: agents.scheduleIds,
      watchGlobs: agents.watchGlobs,
      watchRules: agents.watchRules,
      inputValues: agents.inputValues,
      personaVersionSpec: personaVersions.spec,
      personaDescription: personas.description,
      deployedByUserId: agents.deployedByUserId,
    })
    .from(agents)
    .leftJoin(personas, eq(personas.id, agents.personaId))
    .leftJoin(personaVersions, eq(personaVersions.id, agents.pinnedVersionId))
    .where(and(...predicates))
    .orderBy(desc(agents.createdAt), desc(agents.id))
    .limit(101);

  const page = rows.slice(0, 100);
  const last = page[page.length - 1];
  const pageAgentIds = page.map((row) => row.agentId);
  if (page.length === 0) {
    return NextResponse.json({
      agents: [],
      nextCursor: null,
    });
  }
  const [
    runSummaries,
    latestRunSummaries,
    integrationWatchHealthSummaries,
    integrationWatchFailureSummary,
  ] = await Promise.all([
    getAgentRunSummaries(pageAgentIds),
    getAgentLatestRunSummaries(pageAgentIds),
    getAgentIntegrationWatchHealthSummaries(workspace.appWorkspaceId, pageAgentIds),
    // Keyed by relay_workspace_id (recordDispatchFailure stores the rw_ id),
    // so pass the bound relay id, not the app workspace uuid.
    getWorkspaceIntegrationWatchFailureSummary(workspace.relayWorkspaceId),
  ]);
  return NextResponse.json({
    agents: page.map((row) => {
      const runSummary = runSummaries.get(row.agentId);
      const latestRunSummary = latestRunSummaries.get(row.agentId);
      const integrationWatchHealth = deriveIntegrationWatchHealth({
        hasWatchConfig: hasIntegrationWatchConfig(row),
        row: integrationWatchHealthSummaries.get(row.agentId),
        workspaceFailureSummary: integrationWatchFailureSummary,
      });
      logUnhealthyIntegrationWatch({
        workspaceId: workspace.appWorkspaceId,
        agentId: row.agentId,
        deployedName: row.deployedName,
        health: integrationWatchHealth,
      });
      return {
        agentId: row.agentId,
        personaId: row.personaId,
        deployedName: row.deployedName,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
        lastFiredAt: toIso(runSummary?.last_fired_at),
        lastCompletedAt: toIso(runSummary?.last_completed_at),
        lastRunStatus: latestRunSummary?.last_run_status ?? null,
        lastError: latestRunSummary?.last_error ?? null,
        runCount: Number(runSummary?.run_count ?? 0),
        scheduleIds: row.scheduleIds ?? [],
        scheduleSpecs: extractDeploymentScheduleSpecs(row.personaVersionSpec, row.scheduleIds ?? []),
        inputValues: row.inputValues ?? {},
        inputSpecs: extractDeploymentInputSpecs(row.personaVersionSpec),
        imageUrl: row.imageUrl ?? null,
        personaDescription: row.personaDescription ?? null,
        deployedByUserId: row.deployedByUserId,
        integrationWatchHealth,
      };
    }),
    nextCursor: rows.length > 100 && last ? encodeCursor(last.createdAt, last.agentId) : null,
  });
}

async function deleteProvisionedSandbox(input: {
  request: NextRequest;
  workspaceId: string;
  sandboxId: string;
}): Promise<void> {
  await deleteSandbox(
    requestWithJsonBody(
      input.request,
      `/api/v1/workspaces/${encodeURIComponent(input.workspaceId)}` +
        `/sandboxes/${encodeURIComponent(input.sandboxId)}`,
      "DELETE",
    ),
    {
      params: Promise.resolve({
        workspaceId: input.workspaceId,
        sandboxId: input.sandboxId,
      }),
    },
  ).then((response) =>
    readRouteJson<{ sandboxId: string | undefined; deleted: boolean }>(response, {
      message: "Failed to delete sandbox",
      code: "sandbox_delete_failed",
    }),
  );
}

function errorResponse(error: unknown): NextResponse<ErrorResponse | { error: string; code: string; details?: unknown }> {
  if (error instanceof PersonaDeployError) {
    return NextResponse.json(
      { error: error.message, code: error.code, details: error.details },
      { status: error.status },
    );
  }

  console.error(
    "[persona-bundle-deploy] request failed:",
    error instanceof Error ? error.message : String(error),
  );
  // Diagnostic: drizzle wraps DB failures in a DrizzleQueryError whose
  // `.message` is only "Failed query: <sql> params: <...>" — the actual
  // Postgres cause (postgres.js `PostgresError`: code/severity/detail/
  // constraint/...) lives on the `.cause` chain and is otherwise never
  // logged, so a deploy 500 is undiagnosable from the response alone.
  // Walk and emit the cause chain's structured PG fields.
  const causeChain = describeErrorCauseChain(error);
  if (causeChain.length > 0) {
    console.error(
      "[persona-bundle-deploy] error cause chain:",
      JSON.stringify(causeChain),
    );
  }
  return NextResponse.json(
    { error: "Failed to deploy persona bundle", code: "deployment_failed" },
    { status: 500 },
  );
}

/**
 * Walk `error.cause` (bounded depth) and project each link to the
 * structured fields that matter for diagnosing a deploy failure. For
 * postgres.js `PostgresError`s this surfaces `code` (e.g. `42P10` "no
 * unique/exclusion constraint matching ON CONFLICT", `22007` "invalid
 * input syntax for type timestamp"), plus `detail`/`constraint`/
 * `column`/`routine`. Pure + defensive: never throws, never recurses
 * unbounded, no `any`.
 */
function describeErrorCauseChain(
  error: unknown,
): Array<Record<string, string>> {
  const chain: Array<Record<string, string>> = [];
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current != null; depth += 1) {
    if (typeof current !== "object") {
      chain.push({ value: String(current) });
      break;
    }
    const record = current as Record<string, unknown>;
    const link: Record<string, string> = {};
    for (const field of [
      "name",
      "code",
      "severity",
      "message",
      "detail",
      "hint",
      "constraint",
      "table",
      "column",
      "schema",
      "routine",
    ] as const) {
      const value = record[field];
      if (typeof value === "string" && value.length > 0) {
        // Bound each field; the SQL/params are already in the
        // preceding "request failed" log line.
        link[field] = value.slice(0, 500);
      }
    }
    if (Object.keys(link).length > 0) {
      chain.push(link);
    }
    if (!("cause" in record) || record.cause === current) {
      break;
    }
    current = record.cause;
  }
  return chain;
}

function resolveDeploymentPublicOrigin(request: NextRequest): string {
  const configured = process.env.CLOUD_PUBLIC_URL?.trim()
    || process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) {
    const url = new URL(configured);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new PersonaDeployError("CLOUD_PUBLIC_URL must use http or https", "invalid_config", 500);
    }
    return url.toString().replace(/\/+$/, "");
  }
  return new URL(request.url).origin;
}

export async function POST(
  request: NextRequest,
  context: DeploymentRouteContext,
): Promise<NextResponse<DeployResponse | ErrorResponse | { error: string; code: string; details?: unknown }>> {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return jsonError("Unauthorized", "unauthorized", 401);
  }
  if (!canDeploy(auth)) {
    return jsonError("Forbidden", "forbidden", 403);
  }

  const { workspaceId } = await context.params;
  if (!workspaceId) {
    return jsonError("Workspace not found", "workspace_not_found", 404);
  }
  const workspace = await resolveDeploymentWorkspace(auth, workspaceId);
  if (workspace instanceof NextResponse) {
    return workspace;
  }

  try {
    const body = parsePersonaBundleDeployRequest(await readJsonBody(request));
    const origin = resolveDeploymentPublicOrigin(request);
    const prepared = await preparePersonaDeploy({
      ...body,
      workspaceId: workspace.appWorkspaceId,
      userId: auth.userId,
      organizationId: auth.organizationId,
      requestOrigin: origin,
    });
    // Cold-start runtime: deploy POST persists persona/version/agent +
    // the initial deployment record, but does NOT provision a Daytona
    // sandbox. The tick handler (/deployments/{agentId}/ticks) is the
    // canonical entry point for execution — it provisions a sandbox
    // on-demand at first trigger fire (cron tick / integration webhook),
    // runs to completion, tears down. Rationale:
    //   - Idle cost: cron agents fire daily/weekly; an always-warm
    //     sandbox sits idle 23h59m/day. Cold-start trades 15-30s
    //     latency on first fire for 0 idle compute.
    //   - Failure isolation: deploy success no longer couples to
    //     Daytona/relayauth health. Deploys become pure metadata ops
    //     and stay reliable even while runtime deps churn.
    //   - Architectural symmetry: tick is already the trigger handler;
    //     making it the SOLE provisioning entry point removes duplicate
    //     bootstrapping logic in the deploy path.
    // The chat-style / always-watching use case (where sub-second latency
    // matters and the idle cost is justified) is intentionally out of
    // scope for deploy v1 — those should run via a different deploy
    // primitive when the time comes.
    let deploymentId: string | null = null;
    let recycledSandboxes = 0;
    let recycleWarning: string | undefined;
    try {
      // Resolve credential runtime env early to fail fast on missing
      // provider creds (returns 409 before any DB writes survive).
      try {
        await resolveProviderCredentialRuntimeEnv({
          workspaceId: workspace.appWorkspaceId,
          userId: auth.userId,
          credentialSelections: body.credentialSelections ?? {},
        });
      } catch (error) {
        throw new PersonaDeployError(
          error instanceof Error ? error.message : "Failed to resolve provider credentials",
          "provider_credential_resolution_failed",
          409,
        );
      }
      deploymentId = await createInitialAgentDeployment({
        agentId: prepared.agentId,
        specHash: prepared.specHash,
      });
    } catch (error) {
      if (deploymentId) {
        try {
          await deleteAgentDeployment(deploymentId);
        } catch (cleanupError) {
          console.error(
            "[persona-bundle-deploy] rollback failed for deployment row",
            deploymentId,
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          );
        }
      }
      await rollbackPreparedPersonaDeploy({
        agentId: prepared.agentId,
        agentCreated: prepared.agentCreated,
        versionId: prepared.versionId,
        versionCreated: prepared.versionCreated,
        relaycronScheduleIds: prepared.relaycronScheduleIds,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    if (!deploymentId) {
      throw new PersonaDeployError("Failed to create initial deployment", "deployment_insert_failed", 500);
    }
    try {
      const recycle = await recycleDeploymentSandboxes({
        workspaceId: workspace.appWorkspaceId,
        agentId: prepared.agentId,
      });
      recycledSandboxes = recycle.deleted;
      if (recycle.failed.length > 0) {
        recycleWarning = STALE_SANDBOX_RECYCLE_WARNING;
        console.warn(
          STALE_SANDBOX_RECYCLE_LOG,
          {
            workspaceId: workspace.appWorkspaceId,
            routeWorkspaceId: workspace.routeWorkspaceId,
            agentId: prepared.agentId,
            failedSandboxIds: recycle.failed,
          },
        );
      }
    } catch (error) {
      recycleWarning = STALE_SANDBOX_RECYCLE_WARNING;
      console.warn(
        STALE_SANDBOX_RECYCLE_LOG,
        {
          workspaceId: workspace.appWorkspaceId,
          routeWorkspaceId: workspace.routeWorkspaceId,
          agentId: prepared.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }

    recordPersonaBundleDeploymentCreated({
      workspaceId: workspace.appWorkspaceId,
      personaId: prepared.persona.id,
      agentId: prepared.agentId,
      deploymentId,
      sandboxId: null,
      requester: auth.userId,
      organizationId: auth.organizationId,
      watchGlobs: prepared.watchGlobs,
      scheduleIds: prepared.scheduleIds,
    });

    return NextResponse.json<DeployResponse>(
      {
        agentId: prepared.agentId,
        workspaceId: workspace.appWorkspaceId,
        status: "ready",
        deploymentId,
        recycledSandboxes,
        ...(recycleWarning ? { recycleWarning } : {}),
      },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
