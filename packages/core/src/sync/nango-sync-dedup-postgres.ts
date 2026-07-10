// Postgres-backed nango sync dedup store.
//
// This module imports `../db/client.js` (which imports `pg`) and is therefore
// Node/Hyperdrive-only. It MUST NOT be imported, statically or dynamically,
// from any Cloudflare Worker bundle entrypoint (see
// tests/b1-worker-import-safety.test.ts and .claude/rules/workers-fetch.md).
// The Worker-safe contract/types live in `./nango-sync-dedup.js`.

import { sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import type { AppDb } from "../db/client.js";
import {
  DEFAULT_NANGO_SYNC_DEDUP_LEASE_MS,
  type NangoSyncDedupStore,
  type NangoSyncDedupeClaimInput,
  type NangoSyncDedupeClaimResult,
  type NangoSyncDedupeKey,
} from "./nango-sync-dedup.js";
import { logHop } from "../observability/structured-log.js";

type DedupeStatus = "processing" | "completed" | "failed";

type QueryableDb = Pick<AppDb, "execute">;

type ClaimRow = {
  status: DedupeStatus;
  attempt_count: number;
  lease_expires_at: Date | string | null;
  completed_at: Date | string | null;
};

function rowsFromExecuteResult<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

function toDate(value: Date | string | null | undefined): Date | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value : new Date(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export class PostgresNangoSyncDedupStore implements NangoSyncDedupStore {
  constructor(private readonly db: QueryableDb = getDb()) {}

  async claim(
    input: NangoSyncDedupeClaimInput,
    options: { now?: Date; leaseMs?: number } = {},
  ): Promise<NangoSyncDedupeClaimResult> {
    const now = options.now ?? new Date();
    const leaseExpiresAt = new Date(
      now.getTime() + (options.leaseMs ?? DEFAULT_NANGO_SYNC_DEDUP_LEASE_MS),
    );
    let rows: ClaimRow[];
    try {
      rows = rowsFromExecuteResult<ClaimRow>(await this.db.execute(sql`
      INSERT INTO nango_sync_dedup (
        surface,
        dedupe_id,
        workspace_id,
        provider,
        connection_id,
        provider_config_key,
        sync_name,
        model,
        sync_window_key,
        cursor_key,
        payload_hash,
        status,
        attempt_count,
        lease_expires_at,
        last_error
      )
      VALUES (
        ${input.surface},
        ${input.dedupeId},
        ${input.workspaceId ?? null},
        ${input.provider ?? null},
        ${input.connectionId ?? null},
        ${input.providerConfigKey ?? null},
        ${input.syncName ?? null},
        ${input.model ?? null},
        ${input.syncWindowKey ?? null},
        ${input.cursorKey ?? null},
        ${input.payloadHash ?? null},
        'processing',
        1,
        ${leaseExpiresAt},
        NULL
      )
      ON CONFLICT (surface, dedupe_id) DO UPDATE
        SET status = 'processing',
            attempt_count = nango_sync_dedup.attempt_count + 1,
            lease_expires_at = EXCLUDED.lease_expires_at,
            last_error = NULL
        WHERE nango_sync_dedup.status = 'failed'
           OR (
             nango_sync_dedup.status = 'processing'
             AND (
               nango_sync_dedup.lease_expires_at IS NULL
               OR nango_sync_dedup.lease_expires_at <= ${now}
             )
           )
      RETURNING status, attempt_count, lease_expires_at, completed_at
    `));
    } catch (error) {
      // #743 trap: drizzle wraps the pg error in `cause` with the real PG
      // `code`. Surface the full chain so CloudWatch shows e.g. 42P01 /
      // 28P01 / 08006 instead of "Failed query".
      logHop({
        hop: "dedup",
        outcome: "error",
        note: "claim.insert",
        provider: input.provider,
        connectionId: input.connectionId,
        providerConfigKey: input.providerConfigKey,
        syncName: input.syncName,
        model: input.model,
        dedupeId: input.dedupeId,
        error,
      });
      throw error;
    }

    const key = { surface: input.surface, dedupeId: input.dedupeId };
    const claimed = rows[0];
    if (claimed) {
      return {
        type: "claimed",
        key,
        attemptCount: claimed.attempt_count,
        leaseExpiresAt: toDate(claimed.lease_expires_at) ?? leaseExpiresAt,
      };
    }

    let existingRows: ClaimRow[];
    try {
      existingRows = rowsFromExecuteResult<ClaimRow>(await this.db.execute(sql`
      SELECT status, attempt_count, lease_expires_at, completed_at
      FROM nango_sync_dedup
      WHERE surface = ${input.surface} AND dedupe_id = ${input.dedupeId}
      LIMIT 1
    `));
    } catch (error) {
      logHop({
        hop: "dedup",
        outcome: "error",
        note: "claim.select",
        provider: input.provider,
        connectionId: input.connectionId,
        providerConfigKey: input.providerConfigKey,
        syncName: input.syncName,
        model: input.model,
        dedupeId: input.dedupeId,
        error,
      });
      throw error;
    }
    const existing = existingRows[0];
    if (existing?.status === "completed") {
      return {
        type: "duplicate_completed",
        key,
        completedAt: toDate(existing.completed_at),
      };
    }

    return {
      type: "duplicate_in_flight",
      key,
      leaseExpiresAt: toDate(existing?.lease_expires_at),
    };
  }

  async complete(key: NangoSyncDedupeKey, options: { now?: Date } = {}): Promise<void> {
    const now = options.now ?? new Date();
    try {
      await this.db.execute(sql`
      UPDATE nango_sync_dedup
      SET status = 'completed',
          completed_at = ${now},
          lease_expires_at = NULL,
          last_error = NULL
      WHERE surface = ${key.surface} AND dedupe_id = ${key.dedupeId}
    `);
    } catch (error) {
      logHop({
        hop: "dedup",
        outcome: "error",
        note: "complete",
        dedupeId: key.dedupeId,
        error,
      });
      throw error;
    }
  }

  async fail(
    key: NangoSyncDedupeKey,
    error: unknown,
    options: { now?: Date } = {},
  ): Promise<void> {
    void options;
    try {
      await this.db.execute(sql`
      UPDATE nango_sync_dedup
      SET status = 'failed',
          lease_expires_at = NULL,
          last_error = ${errorMessage(error).slice(0, 4000)}
      WHERE surface = ${key.surface} AND dedupe_id = ${key.dedupeId}
    `);
    } catch (updateError) {
      logHop({
        hop: "dedup",
        outcome: "error",
        note: "fail.update",
        dedupeId: key.dedupeId,
        error: updateError,
      });
      throw updateError;
    }
  }
}
