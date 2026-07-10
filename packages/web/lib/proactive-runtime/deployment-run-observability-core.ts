import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  deriveDeploymentRunFailureClass,
  deriveDeploymentRunTerminalCause,
  deploymentRunErrorForApi,
  type DeploymentRunFailureInput,
  type DeploymentRunFailureClass,
  type DeploymentRunTerminalCause,
} from "./deployment-run-failure-class";
import { deploymentRunLogEntriesForApi } from "./deployment-run-structured-logs";
import { redactRunOutputSecretPatterns } from "./run-output-redaction";

type RawRow<T> = { rows?: T[] };

type RunFormat = "ui" | "compact";

export type AuthorizedRunListContext = {
  workspaceId: string;
  agentId: string;
};
export type AuthorizedRunDetailContext = AuthorizedRunListContext & {
  runId: string;
};

type DeploymentRunListRow = {
  id: string;
  deployment_id: string;
  agent_id: string;
  trigger_kind: string | null;
  event_source: string;
  sandbox_id: string | null;
  sandbox_name: string | null;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  exit_code: number | null;
  cleanup_status: unknown;
  started_at: Date | string;
  ended_at: Date | string;
  duration_ms: number;
  status: string;
  error: string | null;
  summary: string | null;
  compressed_at: Date | string | null;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  cache_read_tokens: number | string | null;
  cache_write_tokens: number | string | null;
  total_tokens: number | string | null;
  agent_total_tokens: number | string | null;
};

type DeploymentRunDetailRow = DeploymentRunListRow & {
  stdout: string | null;
  stderr: string | null;
  mount_log_tail: string | null;
};

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const candidate = result as RawRow<T>;
  return Array.isArray(candidate?.rows) ? candidate.rows : [];
}

function toIso(value: Date | string | null): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toTokenCount(value: number | string | null | undefined): number {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  }
  return 0;
}

function searchParams(request: Request): URLSearchParams {
  return new URL(request.url).searchParams;
}

function readLimit(request: Request): number {
  const value = Number(searchParams(request).get("limit"));
  if (!Number.isFinite(value)) return 50;
  return Math.min(Math.max(Math.trunc(value), 1), 100);
}

function readDateFilter(request: Request, key: string): string | null {
  const raw = searchParams(request).get(key)?.trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function readStringFilter(request: Request, key: string): string | null {
  return searchParams(request).get(key)?.trim() || null;
}

function readFormat(request: Request): RunFormat {
  return searchParams(request).get("format")?.trim().toLowerCase() === "compact"
    ? "compact"
    : "ui";
}

function failureInputForRow(
  row: DeploymentRunListRow | DeploymentRunDetailRow,
): DeploymentRunFailureInput {
  return {
    status: row.status,
    exitCode: row.exit_code,
    error: row.error,
    stdout: "stdout" in row ? row.stdout : undefined,
    stderr: "stderr" in row ? row.stderr : undefined,
    mountLogTail: "mount_log_tail" in row ? row.mount_log_tail : undefined,
    cleanupStatus: row.cleanup_status,
  };
}

function errorForRow(row: DeploymentRunListRow | DeploymentRunDetailRow): string | null {
  return deploymentRunErrorForApi(failureInputForRow(row));
}

function failureSignalsForRow(row: DeploymentRunListRow | DeploymentRunDetailRow): {
  error: string | null;
  failureClass: DeploymentRunFailureClass;
  terminalCause: DeploymentRunTerminalCause;
} {
  const input = failureInputForRow(row);
  const error = deploymentRunErrorForApi(input);
  const resolvedInput = { ...input, error };
  return {
    error,
    failureClass: deriveDeploymentRunFailureClass(resolvedInput),
    terminalCause: deriveDeploymentRunTerminalCause(resolvedInput),
  };
}

function serializeUiRun(row: DeploymentRunListRow) {
  const compressed = row.compressed_at !== null;

  return {
    id: row.id,
    deploymentId: row.deployment_id,
    agentId: row.agent_id,
    eventSource: row.event_source,
    sandboxId: row.sandbox_id,
    sandboxName: row.sandbox_name,
    stdoutTruncated: row.stdout_truncated,
    stderrTruncated: row.stderr_truncated,
    exitCode: row.exit_code,
    cleanupStatus: row.cleanup_status ?? {},
    startedAt: toIso(row.started_at),
    endedAt: toIso(row.ended_at),
    durationMs: row.duration_ms,
    status: row.status,
    error: errorForRow(row),
    summary: compressed ? row.summary ?? "Run output compressed after retention window." : row.summary,
    compressedAt: toIso(row.compressed_at),
    inputTokens: toTokenCount(row.input_tokens),
    outputTokens: toTokenCount(row.output_tokens),
    cacheReadTokens: toTokenCount(row.cache_read_tokens),
    cacheWriteTokens: toTokenCount(row.cache_write_tokens),
    totalTokens: toTokenCount(row.total_tokens),
  };
}

function serializeUiRunDetail(row: DeploymentRunDetailRow, workspaceId: string) {
  const compressed = row.compressed_at !== null;
  const summary = compressed
    ? row.summary ?? "Run output compressed after retention window."
    : row.summary;
  const stdout = compressed ? summary ?? "" : row.stdout ?? "";

  return {
    id: row.id,
    deploymentId: row.deployment_id,
    agentId: row.agent_id,
    eventSource: row.event_source,
    sandboxId: row.sandbox_id,
    sandboxName: row.sandbox_name,
    stdout,
    stderr: compressed ? "" : row.stderr ?? "",
    mountLogTail: compressed ? "" : row.mount_log_tail ?? "",
    entries: compressed ? [] : entriesForRow(row, stdout, workspaceId),
    stdoutTruncated: compressed ? false : row.stdout_truncated,
    stderrTruncated: compressed ? false : row.stderr_truncated,
    exitCode: row.exit_code,
    cleanupStatus: row.cleanup_status ?? {},
    startedAt: toIso(row.started_at),
    endedAt: toIso(row.ended_at),
    durationMs: row.duration_ms,
    status: row.status,
    error: errorForRow(row),
    summary,
    compressedAt: toIso(row.compressed_at),
  };
}

function compactBase(row: DeploymentRunListRow | DeploymentRunDetailRow) {
  const failureSignals = failureSignalsForRow(row);
  return {
    runId: row.id,
    deploymentId: row.deployment_id,
    agentId: row.agent_id,
    status: row.status,
    exitCode: row.exit_code,
    summary: row.compressed_at !== null
      ? row.summary ?? "Run output compressed after retention window."
      : row.summary,
    error: failureSignals.error,
    startedAt: toIso(row.started_at),
    endedAt: toIso(row.ended_at),
    durationMs: row.duration_ms,
    trigger: {
      kind: row.trigger_kind ?? "unknown",
      eventSource: row.event_source,
    },
    sandbox: {
      id: row.sandbox_id,
      name: row.sandbox_name,
    },
    failureClass: failureSignals.failureClass,
    terminalCause: failureSignals.terminalCause,
    origin: "hosted" as const,
  };
}

function serializeCompactRun(row: DeploymentRunListRow) {
  return compactBase(row);
}

function serializeCompactRunDetail(row: DeploymentRunDetailRow, workspaceId: string) {
  const compressed = row.compressed_at !== null;
  const summary = row.summary ?? "Run output compressed after retention window.";
  const stdout = compressed ? summary : row.stdout ?? "";
  return {
    ...compactBase(row),
    entries: compressed ? [] : entriesForRow(row, stdout, workspaceId),
    logs: {
      stdout,
      stderr: compressed ? "" : row.stderr ?? "",
      mountLogTail: compressed ? "" : row.mount_log_tail ?? "",
      stdoutTruncated: compressed ? false : row.stdout_truncated,
      stderrTruncated: compressed ? false : row.stderr_truncated,
    },
  };
}

function entriesForRow(row: DeploymentRunDetailRow, stdout: string, workspaceId: string) {
  return deploymentRunLogEntriesForApi({
    output: stdout,
    relayWorkspaceId: workspaceId,
    agentId: row.agent_id,
    deploymentId: row.deployment_id,
    eventSource: row.event_source,
    runId: row.id,
    sandboxId: row.sandbox_id,
  });
}

function listPredicates(request: Request, context: AuthorizedRunListContext) {
  const predicates = [
    sql`adr.agent_id = ${context.agentId}`,
    sql`a.workspace_id = ${context.workspaceId}`,
    sql`a.status != 'destroyed'`,
  ];
  const status = readStringFilter(request, "status");
  const triggerKind = readStringFilter(request, "triggerKind");
  const eventSource = readStringFilter(request, "eventSource");
  const from = readDateFilter(request, "from");
  const to = readDateFilter(request, "to");

  if (status) predicates.push(sql`adr.status = ${status}`);
  if (triggerKind) predicates.push(sql`d.trigger_kind = ${triggerKind}`);
  if (eventSource) predicates.push(sql`adr.event_source = ${eventSource}`);
  if (from) predicates.push(sql`adr.started_at >= ${from}::timestamp with time zone`);
  if (to) predicates.push(sql`adr.started_at <= ${to}::timestamp with time zone`);

  return predicates;
}

async function queryRunList(request: Request, context: AuthorizedRunListContext) {
  const limit = readLimit(request);
  const predicates = listPredicates(request, context);
  const result = await getDb().execute(sql`
    SELECT
      adr.id,
      adr.deployment_id,
      adr.agent_id,
      d.trigger_kind,
      adr.event_source,
      adr.sandbox_id,
      adr.sandbox_name,
      adr.stdout_truncated,
      adr.stderr_truncated,
      adr.exit_code,
      adr.cleanup_status,
      adr.started_at,
      adr.ended_at,
      adr.duration_ms,
      adr.status,
      adr.error,
      adr.summary,
      adr.compressed_at,
      COALESCE(run_usage.input_tokens, 0) AS input_tokens,
      COALESCE(run_usage.output_tokens, 0) AS output_tokens,
      COALESCE(run_usage.cache_read_tokens, 0) AS cache_read_tokens,
      COALESCE(run_usage.cache_write_tokens, 0) AS cache_write_tokens,
      COALESCE(run_usage.total_tokens, 0) AS total_tokens,
      COALESCE(agent_usage.total_tokens, 0) AS agent_total_tokens
    FROM agent_deployment_runs adr
    INNER JOIN agents a ON a.id = adr.agent_id
    INNER JOIN agent_deployments d ON d.id = adr.deployment_id
    LEFT JOIN (
      SELECT
        agent_id,
        run_id,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens,
        SUM(cache_write_tokens) AS cache_write_tokens,
        SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS total_tokens
      FROM harness_spend_events
      WHERE agent_id = ${context.agentId}
        AND run_id IS NOT NULL
      GROUP BY agent_id, run_id
    ) run_usage ON run_usage.agent_id = adr.agent_id AND run_usage.run_id = adr.id
    LEFT JOIN (
      SELECT
        agent_id,
        SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS total_tokens
      FROM harness_spend_events
      WHERE agent_id = ${context.agentId}
      GROUP BY agent_id
    ) agent_usage ON agent_usage.agent_id = adr.agent_id
    WHERE ${sql.join(predicates, sql` AND `)}
    ORDER BY adr.started_at DESC
    LIMIT ${limit}
  `);
  return rowsOf<DeploymentRunListRow>(result);
}

async function queryRunDetail(context: AuthorizedRunDetailContext) {
  const result = await getDb().execute(sql`
    SELECT
      adr.id,
      adr.deployment_id,
      adr.agent_id,
      d.trigger_kind,
      adr.event_source,
      adr.sandbox_id,
      adr.sandbox_name,
      adr.stdout,
      adr.stderr,
      adr.mount_log_tail,
      adr.stdout_truncated,
      adr.stderr_truncated,
      adr.exit_code,
      adr.cleanup_status,
      adr.started_at,
      adr.ended_at,
      adr.duration_ms,
      adr.status,
      adr.error,
      adr.summary,
      adr.compressed_at,
      0 AS input_tokens,
      0 AS output_tokens,
      0 AS cache_read_tokens,
      0 AS cache_write_tokens,
      0 AS total_tokens,
      0 AS agent_total_tokens
    FROM agent_deployment_runs adr
    INNER JOIN agents a ON a.id = adr.agent_id
    INNER JOIN agent_deployments d ON d.id = adr.deployment_id
    WHERE adr.agent_id = ${context.agentId}
      AND adr.id = ${context.runId}
      AND a.workspace_id = ${context.workspaceId}
      AND a.status != 'destroyed'
    LIMIT 1
  `);
  return rowsOf<DeploymentRunDetailRow>(result)[0] ?? null;
}

export async function listAuthorizedDeploymentRuns(
  request: Request,
  context: AuthorizedRunListContext,
): Promise<Response> {
  const rows = await queryRunList(request, context);
  if (readFormat(request) === "compact") {
    return Response.json({
      agentId: context.agentId,
      origin: "hosted",
      runs: rows.map(serializeCompactRun),
    });
  }

  return Response.json({
    agentId: context.agentId,
    totalTokens: toTokenCount(rows[0]?.agent_total_tokens),
    runs: rows.map(serializeUiRun),
  });
}

export async function getAuthorizedDeploymentRun(
  request: Request,
  context: AuthorizedRunDetailContext,
): Promise<Response> {
  const row = await queryRunDetail(context);
  if (!row) {
    return Response.json({ error: "Deployment run not found", code: "not_found" }, { status: 404 });
  }

  if (readFormat(request) === "compact") {
    return Response.json({ run: serializeCompactRunDetail(row, context.workspaceId) });
  }

  return Response.json({ run: serializeUiRunDetail(row, context.workspaceId) });
}

type DeploymentRunEnvelopeRow = {
  envelope: string | null;
  envelope_omitted: boolean;
};

async function queryRunEnvelope(
  context: AuthorizedRunDetailContext,
): Promise<DeploymentRunEnvelopeRow | null> {
  const result = await getDb().execute(sql`
    SELECT
      adr.envelope,
      adr.envelope_omitted
    FROM agent_deployment_runs adr
    INNER JOIN agents a ON a.id = adr.agent_id
    WHERE adr.agent_id = ${context.agentId}
      AND adr.id = ${context.runId}
      AND a.workspace_id = ${context.workspaceId}
      AND a.status != 'destroyed'
    LIMIT 1
  `);
  return rowsOf<DeploymentRunEnvelopeRow>(result)[0] ?? null;
}

/**
 * GET /runs/:runId/envelope (cloud#1841): the byte-exact gateway envelope
 * delivered to this run, for `agentworkforce runs export` fixture replay.
 *
 * REDACTION DECISION: the envelope is persisted RAW (ground truth) and
 * redacted ON READ with the secret-pattern pass only
 * (`redactRunOutputSecretPatterns` — gh tokens, relay tokens,
 * x-access-token URLs), NOT the broader diagnostics redaction: provider
 * payload text must survive intact for replay fidelity, and the secret
 * patterns match token characters only, so in-string replacement keeps the
 * JSON parseable. A payload that contained a credential is exactly the
 * payload we'd never want exported verbatim anyway. If redaction ever
 * renders the JSON unparseable (paranoia guard), the envelope is reported
 * as not-exposable rather than served mangled.
 */
export async function getAuthorizedDeploymentRunEnvelope(
  context: AuthorizedRunDetailContext,
): Promise<Response> {
  const row = await queryRunEnvelope(context);
  if (!row) {
    return Response.json({ error: "Deployment run not found", code: "not_found" }, { status: 404 });
  }

  if (row.envelope === null) {
    return Response.json({
      captured: false,
      omitted: Boolean(row.envelope_omitted),
      envelope: null,
    });
  }

  const redacted = redactRunOutputSecretPatterns(row.envelope);
  let parsed: unknown;
  try {
    parsed = JSON.parse(redacted);
  } catch {
    return Response.json({ captured: false, omitted: false, envelope: null });
  }

  return Response.json({
    captured: true,
    omitted: false,
    envelope: parsed,
  });
}
