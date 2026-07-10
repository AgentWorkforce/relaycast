import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";

export const SLACK_DIRECT_PROXY_IDEMPOTENCY_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const SLACK_DIRECT_PROXY_PENDING_WAIT_MS = 5_000;
export const SLACK_DIRECT_PROXY_PENDING_POLL_MS = 100;

export type SlackDirectProxyIdempotencyStatus =
  | "pending"
  | "success"
  | "permanent_failure";

export type SlackDirectProxyIdempotencyRecord = {
  workspaceId: string;
  idempotencyKey: string;
  providerConfigKey: string;
  connectionId: string;
  status: SlackDirectProxyIdempotencyStatus;
  opId: string | null;
  slackTs: string | null;
  metadata: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
};

type IdempotencyRow = {
  workspace_id: string;
  idempotency_key: string;
  provider_config_key: string;
  connection_id: string;
  status: string;
  op_id: string | null;
  slack_ts: string | null;
  metadata: Record<string, unknown> | null;
  error_code: string | null;
  error_message: string | null;
};

function rowsFromResult<T extends Record<string, unknown>>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const candidate = result as { rows?: unknown[] };
  return Array.isArray(candidate.rows) ? (candidate.rows as T[]) : [];
}

function recordFromRow(row: IdempotencyRow): SlackDirectProxyIdempotencyRecord {
  return {
    workspaceId: row.workspace_id,
    idempotencyKey: row.idempotency_key,
    providerConfigKey: row.provider_config_key,
    connectionId: row.connection_id,
    status:
      row.status === "success" || row.status === "permanent_failure"
        ? row.status
        : "pending",
    opId: row.op_id,
    slackTs: row.slack_ts,
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : null,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  };
}

export async function claimSlackDirectProxyWriteback(input: {
  workspaceId: string;
  idempotencyKey: string;
  providerConfigKey: string;
  connectionId: string;
  opId: string;
  now?: Date;
  ttlMs?: number;
}): Promise<
  | { claimed: true }
  | { claimed: false; record: SlackDirectProxyIdempotencyRecord | null }
> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(
    now.getTime() + (input.ttlMs ?? SLACK_DIRECT_PROXY_IDEMPOTENCY_TTL_MS),
  );
  const inserted = await getDb().execute(sql`
    INSERT INTO slack_direct_proxy_writeback_idempotency (
      workspace_id,
      idempotency_key,
      provider_config_key,
      connection_id,
      status,
      op_id,
      created_at,
      updated_at,
      expires_at
    )
    VALUES (
      ${input.workspaceId},
      ${input.idempotencyKey},
      ${input.providerConfigKey},
      ${input.connectionId},
      'pending',
      ${input.opId},
      ${now.toISOString()},
      ${now.toISOString()},
      ${expiresAt.toISOString()}
    )
    ON CONFLICT (workspace_id, idempotency_key) DO UPDATE
      SET provider_config_key = EXCLUDED.provider_config_key,
          connection_id = EXCLUDED.connection_id,
          status = 'pending',
          op_id = EXCLUDED.op_id,
          slack_ts = NULL,
          metadata = NULL,
          error_code = NULL,
          error_message = NULL,
          updated_at = EXCLUDED.updated_at,
          expires_at = EXCLUDED.expires_at
      WHERE slack_direct_proxy_writeback_idempotency.expires_at <= ${now.toISOString()}
    RETURNING workspace_id
  `);
  if (rowsFromResult(inserted).length > 0) {
    return { claimed: true };
  }

  const record = await findSlackDirectProxyWritebackIdempotency({
    workspaceId: input.workspaceId,
    idempotencyKey: input.idempotencyKey,
    now,
  });
  return { claimed: false, record };
}

export async function findSlackDirectProxyWritebackIdempotency(input: {
  workspaceId: string;
  idempotencyKey: string;
  now?: Date;
}): Promise<SlackDirectProxyIdempotencyRecord | null> {
  const now = input.now ?? new Date();
  const result = await getDb().execute(sql`
    SELECT workspace_id, idempotency_key, provider_config_key, connection_id,
      status, op_id, slack_ts, metadata, error_code, error_message
    FROM slack_direct_proxy_writeback_idempotency
    WHERE workspace_id = ${input.workspaceId}
      AND idempotency_key = ${input.idempotencyKey}
      AND expires_at > ${now.toISOString()}
    LIMIT 1
  `);
  const [row] = rowsFromResult<IdempotencyRow>(result);
  return row ? recordFromRow(row) : null;
}

export async function completeSlackDirectProxyWriteback(input: {
  workspaceId: string;
  idempotencyKey: string;
  status: Exclude<SlackDirectProxyIdempotencyStatus, "pending">;
  slackTs?: string | null;
  metadata?: Record<string, unknown> | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  await getDb().execute(sql`
    UPDATE slack_direct_proxy_writeback_idempotency
    SET status = ${input.status},
        slack_ts = ${input.slackTs ?? null},
        metadata = ${input.metadata ? JSON.stringify(input.metadata) : null}::jsonb,
        error_code = ${input.errorCode ?? null},
        error_message = ${input.errorMessage ?? null},
        updated_at = ${now.toISOString()}
    WHERE workspace_id = ${input.workspaceId}
      AND idempotency_key = ${input.idempotencyKey}
  `);
}

export async function releaseSlackDirectProxyWritebackClaim(input: {
  workspaceId: string;
  idempotencyKey: string;
}): Promise<void> {
  await getDb().execute(sql`
    DELETE FROM slack_direct_proxy_writeback_idempotency
    WHERE workspace_id = ${input.workspaceId}
      AND idempotency_key = ${input.idempotencyKey}
      AND status = 'pending'
  `);
}

export async function waitForSlackDirectProxyWritebackResult(input: {
  workspaceId: string;
  idempotencyKey: string;
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<SlackDirectProxyIdempotencyRecord | null> {
  const timeoutMs = input.timeoutMs ?? SLACK_DIRECT_PROXY_PENDING_WAIT_MS;
  const pollMs = input.pollMs ?? SLACK_DIRECT_PROXY_PENDING_POLL_MS;
  const sleep =
    input.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const record = await findSlackDirectProxyWritebackIdempotency(input);
    if (!record || record.status !== "pending") {
      return record;
    }
    await sleep(pollMs);
  }
  return findSlackDirectProxyWritebackIdempotency(input);
}
