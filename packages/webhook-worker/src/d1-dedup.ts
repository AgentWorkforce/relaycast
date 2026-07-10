import {
  DEFAULT_DEDUP_LEASE_MS,
  type DedupeClaimInput,
  type DedupeClaimResult,
  type DedupeKey,
  type NangoSyncDedupStore,
} from "./dedup";

type DedupeStatus = "processing" | "completed" | "failed";

type ClaimRow = {
  status: DedupeStatus;
  attempt_count: number;
  lease_expires_at: string | null;
  completed_at: string | null;
};

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS nango_sync_dedup (
  surface TEXT NOT NULL,
  dedupe_id TEXT NOT NULL,
  workspace_id TEXT,
  provider TEXT,
  connection_id TEXT,
  provider_config_key TEXT,
  sync_name TEXT,
  model TEXT,
  sync_window_key TEXT,
  cursor_key TEXT,
  payload_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 1,
  lease_expires_at TEXT,
  completed_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (surface, dedupe_id)
)
`;

const CREATE_STATUS_LEASE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS nango_sync_dedup_status_lease_idx
    ON nango_sync_dedup (status, lease_expires_at)
`;

function toIsoString(value: Date): string {
  return value.toISOString();
}

function toDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  return new Date(value);
}

function rowsFromResult<T>(result: D1Result<T>): T[] {
  return result.results ?? [];
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export class D1NangoSyncDedupStore implements NangoSyncDedupStore {
  private schemaReady: Promise<void> | undefined;

  constructor(private readonly db: D1Database) {}

  private async ensureSchema(): Promise<void> {
    this.schemaReady ??= (async () => {
      await this.db.prepare(CREATE_TABLE_SQL).run();
      await this.db.prepare(CREATE_STATUS_LEASE_INDEX_SQL).run();
    })();
    await this.schemaReady;
  }

  async claim(
    input: DedupeClaimInput,
    options: { now?: Date; leaseMs?: number } = {},
  ): Promise<DedupeClaimResult> {
    await this.ensureSchema();

    const now = options.now ?? new Date();
    const nowIso = toIsoString(now);
    const leaseExpiresAt = new Date(
      now.getTime() + (options.leaseMs ?? DEFAULT_DEDUP_LEASE_MS),
    );
    const leaseExpiresAtIso = toIsoString(leaseExpiresAt);
    const claimedResult = await this.db
      .prepare(`
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
          completed_at,
          last_error,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', 1, ?, NULL, NULL, ?)
        ON CONFLICT(surface, dedupe_id) DO UPDATE
          SET status = 'processing',
              workspace_id = excluded.workspace_id,
              provider = excluded.provider,
              connection_id = excluded.connection_id,
              provider_config_key = excluded.provider_config_key,
              sync_name = excluded.sync_name,
              model = excluded.model,
              sync_window_key = excluded.sync_window_key,
              cursor_key = excluded.cursor_key,
              payload_hash = excluded.payload_hash,
              attempt_count = nango_sync_dedup.attempt_count + 1,
              lease_expires_at = excluded.lease_expires_at,
              completed_at = NULL,
              last_error = NULL,
              updated_at = excluded.updated_at
          WHERE nango_sync_dedup.status = 'failed'
             OR (
               nango_sync_dedup.status = 'processing'
               AND (
                 nango_sync_dedup.lease_expires_at IS NULL
                 OR nango_sync_dedup.lease_expires_at <= ?
               )
             )
        RETURNING status, attempt_count, lease_expires_at, completed_at
      `)
      .bind(
        input.surface,
        input.dedupeId,
        input.workspaceId ?? null,
        input.provider ?? null,
        input.connectionId ?? null,
        input.providerConfigKey ?? null,
        input.syncName ?? null,
        input.model ?? null,
        input.syncWindowKey ?? null,
        input.cursorKey ?? null,
        input.payloadHash ?? null,
        leaseExpiresAtIso,
        nowIso,
        nowIso,
      )
      .all<ClaimRow>();

    const key = { surface: input.surface, dedupeId: input.dedupeId };
    const claimed = rowsFromResult(claimedResult)[0];
    if (claimed) {
      return {
        type: "claimed",
        key,
        attemptCount: claimed.attempt_count,
        leaseExpiresAt: toDate(claimed.lease_expires_at) ?? leaseExpiresAt,
      };
    }

    const existingResult = await this.db
      .prepare(`
        SELECT status, attempt_count, lease_expires_at, completed_at
        FROM nango_sync_dedup
        WHERE surface = ? AND dedupe_id = ?
        LIMIT 1
      `)
      .bind(input.surface, input.dedupeId)
      .all<ClaimRow>();
    const existing = rowsFromResult(existingResult)[0];

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

  async complete(key: DedupeKey, options: { now?: Date } = {}): Promise<void> {
    await this.ensureSchema();

    const nowIso = toIsoString(options.now ?? new Date());
    await this.db
      .prepare(`
        UPDATE nango_sync_dedup
        SET status = 'completed',
            completed_at = ?,
            lease_expires_at = NULL,
            last_error = NULL,
            updated_at = ?
        WHERE surface = ? AND dedupe_id = ?
      `)
      .bind(nowIso, nowIso, key.surface, key.dedupeId)
      .run();
  }

  async fail(
    key: DedupeKey,
    error: unknown,
    options: { now?: Date } = {},
  ): Promise<void> {
    await this.ensureSchema();

    const nowIso = toIsoString(options.now ?? new Date());
    await this.db
      .prepare(`
        UPDATE nango_sync_dedup
        SET status = 'failed',
            lease_expires_at = NULL,
            last_error = ?,
            updated_at = ?
        WHERE surface = ? AND dedupe_id = ?
      `)
      .bind(errorMessage(error).slice(0, 4000), nowIso, key.surface, key.dedupeId)
      .run();
  }
}
