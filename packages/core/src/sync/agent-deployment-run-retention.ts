import { Client } from "pg";
import { nodePgConnectionConfig } from "../db/connection.js";

const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_BATCH_LIMIT = 500;
const MAX_SUMMARY_LENGTH = 1_000;
const MAX_ERROR_LINE_LENGTH = 500;

type QueryResult<Row> = {
  rows: Row[];
};

type QueryClient = {
  query: <Row = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<QueryResult<Row>>;
};

type AgentDeploymentRunRetentionCandidate = {
  id: string;
  status: string;
  exit_code: number | null;
  duration_ms: number | null;
  error: string | null;
};

export type AgentDeploymentRunRetentionResult = {
  compressed: number;
  retentionDays: number;
  batchLimit: number;
};

export function buildAgentDeploymentRunSummary(
  row: Pick<AgentDeploymentRunRetentionCandidate, "status" | "exit_code" | "duration_ms" | "error">,
): string {
  const outcome = row.exit_code === null ? row.status : `${row.status} (exit ${row.exit_code})`;
  const parts = [`${outcome} in ${formatDuration(row.duration_ms ?? 0)}`];
  const firstErrorLine = firstLine(row.error);

  if (firstErrorLine) {
    parts.push(`error: ${truncate(firstErrorLine, MAX_ERROR_LINE_LENGTH)}`);
  }

  return truncate(parts.join(" - "), MAX_SUMMARY_LENGTH);
}

export async function compactAgentDeploymentRuns(
  client: QueryClient,
  options: {
    now?: Date;
    retentionDays?: number;
    batchLimit?: number;
  } = {},
): Promise<AgentDeploymentRunRetentionResult> {
  const now = options.now ?? new Date();
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const batchLimit = options.batchLimit ?? DEFAULT_BATCH_LIMIT;
  const nowIso = now.toISOString();

  await client.query("BEGIN");

  try {
    const candidates = await client.query<AgentDeploymentRunRetentionCandidate>(
      `
        SELECT
          id,
          status,
          exit_code,
          duration_ms,
          error
        FROM agent_deployment_runs
        WHERE compressed_at IS NULL
          AND ended_at < $1::TIMESTAMPTZ - ($2::INTEGER * INTERVAL '1 day')
        ORDER BY ended_at ASC
        LIMIT $3
        FOR UPDATE SKIP LOCKED
      `,
      [nowIso, retentionDays, batchLimit],
    );

    for (const row of candidates.rows) {
      await client.query(
        `
          UPDATE agent_deployment_runs
          SET
            summary = $1,
            compressed_at = $2,
            stdout = NULL,
            stderr = NULL,
            mount_log_tail = NULL,
            stdout_truncated = FALSE,
            stderr_truncated = FALSE,
            updated_at = $2
          WHERE id = $3
        `,
        [buildAgentDeploymentRunSummary(row), nowIso, row.id],
      );
    }

    await client.query("COMMIT");

    return {
      compressed: candidates.rows.length,
      retentionDays,
      batchLimit,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

export const handler = async (): Promise<AgentDeploymentRunRetentionResult> => {
  const client = new Client(nodePgConnectionConfig());

  try {
    await client.connect();
    const result = await compactAgentDeploymentRuns(client, {
      retentionDays: readPositiveIntegerEnv(
        "AGENT_DEPLOYMENT_RUN_RETENTION_DAYS",
        DEFAULT_RETENTION_DAYS,
      ),
      batchLimit: readPositiveIntegerEnv(
        "AGENT_DEPLOYMENT_RUN_RETENTION_LIMIT",
        DEFAULT_BATCH_LIMIT,
      ),
    });

    console.log(
      `[agent-deployment-run-retention] Done - compressed: ${result.compressed}, retention days: ${result.retentionDays}, batch limit: ${result.batchLimit}`,
    );

    return result;
  } finally {
    await client.end();
  }
};

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return "0 ms";
  }

  if (durationMs < 1_000) {
    return `${Math.round(durationMs)} ms`;
  }

  const seconds = durationMs / 1_000;
  const decimals = seconds < 10 ? 1 : 0;
  return `${seconds.toFixed(decimals)} s`;
}

function firstLine(value: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.split(/\r?\n/, 1)[0]?.trim() || null;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}
