import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";

/**
 * Durable receipts for relayfile writeback operations.
 *
 * A writeback op is dispatched to the provider FIRST and acked to relayfile
 * SECOND. When the ack fails (relayfile outage), the bridge reports
 * `relayfile_ack_failed` and relayfile re-delivers the same op after
 * recovery. Without a durable record that the provider mutation already
 * succeeded, that retry would re-dispatch the provider op and double-apply it
 * (duplicate issues, duplicate comments, double merges).
 *
 * The receipt — keyed on (workspace_id, op_id) and written as soon as the
 * provider op reaches a terminal outcome, before the ack attempt — lets a
 * retry detect that only the ack is owed and ack without re-dispatching.
 * Persistence is Postgres (same pattern as `ricky_webhook_dedup`): an
 * in-memory cache would not survive Lambda/replica restarts, which is exactly
 * the window where retries arrive.
 */

export const RELAYFILE_WRITEBACK_RECEIPT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export type RelayfileWritebackReceiptOutcome = "success" | "permanent_failure";

export type RelayfileWritebackReceipt = {
  workspaceId: string;
  opId: string;
  provider: string;
  outcome: RelayfileWritebackReceiptOutcome;
  errorCode: string | null;
  errorMessage: string | null;
  metadata: Record<string, unknown> | null;
  ackedAt: Date | null;
};

type ReceiptRow = {
  workspace_id: string;
  op_id: string;
  provider: string;
  outcome: string;
  error_code: string | null;
  error_message: string | null;
  metadata: Record<string, unknown> | null;
  acked_at: Date | string | null;
};

function rowsFromResult<T extends Record<string, unknown>>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const candidate = result as { rows?: unknown[] };
  return Array.isArray(candidate.rows) ? (candidate.rows as T[]) : [];
}

function receiptFromRow(row: ReceiptRow): RelayfileWritebackReceipt {
  return {
    workspaceId: row.workspace_id,
    opId: row.op_id,
    provider: row.provider,
    outcome: row.outcome === "permanent_failure" ? "permanent_failure" : "success",
    errorCode: row.error_code,
    errorMessage: row.error_message,
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : null,
    ackedAt: row.acked_at ? new Date(row.acked_at) : null,
  };
}

export async function recordRelayfileWritebackReceipt(input: {
  workspaceId: string;
  opId: string;
  provider: string;
  outcome: RelayfileWritebackReceiptOutcome;
  errorCode?: string | null;
  errorMessage?: string | null;
  metadata?: Record<string, unknown> | null;
  ttlMs?: number;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(
    now.getTime() + (input.ttlMs ?? RELAYFILE_WRITEBACK_RECEIPT_TTL_MS),
  );
  // A conflicting row only exists when a previous receipt expired (the lookup
  // happens before dispatch) or when the lookup raced a concurrent dispatch of
  // the same op. Either way the freshest terminal outcome is the truth.
  await getDb().execute(sql`
    INSERT INTO relayfile_writeback_receipts (
      workspace_id,
      op_id,
      provider,
      outcome,
      error_code,
      error_message,
      metadata,
      created_at,
      expires_at
    )
    VALUES (
      ${input.workspaceId},
      ${input.opId},
      ${input.provider},
      ${input.outcome},
      ${input.errorCode ?? null},
      ${input.errorMessage ?? null},
      ${input.metadata ? JSON.stringify(input.metadata) : null}::jsonb,
      ${now.toISOString()},
      ${expiresAt.toISOString()}
    )
    ON CONFLICT (workspace_id, op_id) DO UPDATE
    SET provider = EXCLUDED.provider,
        outcome = EXCLUDED.outcome,
        error_code = EXCLUDED.error_code,
        error_message = EXCLUDED.error_message,
        metadata = EXCLUDED.metadata,
        acked_at = NULL,
        created_at = EXCLUDED.created_at,
        expires_at = EXCLUDED.expires_at
  `);
}

export async function findRelayfileWritebackReceipt(input: {
  workspaceId: string;
  opId: string;
  now?: Date;
}): Promise<RelayfileWritebackReceipt | null> {
  const now = input.now ?? new Date();
  const result = await getDb().execute(sql`
    SELECT workspace_id, op_id, provider, outcome, error_code, error_message, metadata, acked_at
    FROM relayfile_writeback_receipts
    WHERE workspace_id = ${input.workspaceId}
      AND op_id = ${input.opId}
      AND expires_at > ${now.toISOString()}
    LIMIT 1
  `);
  const [row] = rowsFromResult<ReceiptRow>(result);
  return row ? receiptFromRow(row) : null;
}

export async function markRelayfileWritebackReceiptAcked(input: {
  workspaceId: string;
  opId: string;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  await getDb().execute(sql`
    UPDATE relayfile_writeback_receipts
    SET acked_at = ${now.toISOString()}
    WHERE workspace_id = ${input.workspaceId}
      AND op_id = ${input.opId}
  `);
}

/** Out-of-band GC hook (mirrors the webhook-dedup pattern): expired receipts
 * are skipped by the lookup, so a slow sweep can never fail-closed dispatch. */
export async function pruneExpiredRelayfileWritebackReceipts(input?: {
  now?: Date;
}): Promise<void> {
  const now = input?.now ?? new Date();
  await getDb().execute(sql`
    DELETE FROM relayfile_writeback_receipts
    WHERE expires_at <= ${now.toISOString()}
  `);
}
