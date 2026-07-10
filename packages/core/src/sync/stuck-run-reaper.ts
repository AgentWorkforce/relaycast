import { Client } from "pg";
import { nodePgConnectionConfig } from "../db/connection.js";
import {
  createRelayAuthClient,
  revokeWorkflowIdentity,
} from "../relayauth/client.js";

const DEFAULT_TIMEOUT_MINUTES = 5;
const REVOKE_REASON = "bootstrap_timeout";
const LAUNCH_FAILED_REASON = "workflow_launch_failed";

type QueryResult<Row> = {
  rows: Row[];
};

type QueryClient = {
  query: <Row = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<QueryResult<Row>>;
};

type ReapedRun = {
  id: string;
  relayauth_identity_id: string | null;
  error: string;
};

export type StuckRunReaperResult = {
  reaped: number;
  tokenSessionsRevoked: number;
  relayAuthIdentitiesRevoked: number;
};

export async function reapStuckRuns(
  client: QueryClient,
  options: {
    now?: Date;
    timeoutMinutes?: number;
  } = {},
): Promise<StuckRunReaperResult> {
  const now = options.now ?? new Date();
  const timeoutMinutes = options.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES;

  await client.query("BEGIN");

  try {
    const reaped = await client.query<ReapedRun>(
      `
        WITH candidates AS (
          SELECT
            wr.id,
            wr.relayauth_identity_id,
            CASE
              WHEN wlj.status = 'failed'
                THEN COALESCE(NULLIF(wlj.last_error, ''), $4)
              ELSE $1
            END AS error
          FROM workflow_runs wr
          LEFT JOIN workflow_launch_jobs wlj ON wlj.run_id = wr.id
          WHERE wr.status = 'pending'
            AND wr.created_at < $2::TIMESTAMPTZ - ($3::INTEGER * INTERVAL '1 minute')
            AND (
              wlj.id IS NULL
              OR wlj.status = 'failed'
            )
        ),
        reaped AS (
          UPDATE workflow_runs wr
          SET
            status = 'failed',
            error = candidates.error,
            updated_at = $2
          FROM candidates
          WHERE wr.id = candidates.id
          RETURNING wr.id, wr.relayauth_identity_id, candidates.error
        )
        SELECT id, relayauth_identity_id, error
        FROM reaped
      `,
      [REVOKE_REASON, now.toISOString(), timeoutMinutes, LAUNCH_FAILED_REASON],
    );

    let tokenSessionsRevoked = 0;
    for (const row of reaped.rows) {
      const revoked = await client.query(
        `
          UPDATE api_token_sessions
          SET
            revoked_at = $1,
            revoked_reason = $2,
            updated_at = $1
          WHERE run_id = $3
            AND revoked_at IS NULL
          RETURNING id
        `,
        [now.toISOString(), row.error, row.id],
      );
      tokenSessionsRevoked += revoked.rows.length;
    }

    await client.query("COMMIT");

    const relayAuthIdentitiesRevoked = await revokeRelayAuthIdentities(reaped.rows);

    return {
      reaped: reaped.rows.length,
      tokenSessionsRevoked,
      relayAuthIdentitiesRevoked,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

export const handler = async (): Promise<StuckRunReaperResult> => {
  const client = new Client(nodePgConnectionConfig());

  try {
    await client.connect();
    const result = await reapStuckRuns(client, {
      timeoutMinutes: readTimeoutMinutes(),
    });

    console.log(
      `[stuck-run-reaper] Done - reaped: ${result.reaped}, token sessions revoked: ${result.tokenSessionsRevoked}, RelayAuth identities revoked: ${result.relayAuthIdentitiesRevoked}`,
    );

    return result;
  } finally {
    await client.end();
  }
};

function readTimeoutMinutes(): number {
  const raw = process.env.STUCK_RUN_TIMEOUT_MINUTES;
  if (!raw) {
    return DEFAULT_TIMEOUT_MINUTES;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("STUCK_RUN_TIMEOUT_MINUTES must be a positive integer");
  }

  return parsed;
}

async function revokeRelayAuthIdentities(rows: ReapedRun[]): Promise<number> {
  const identityIds = rows
    .map((row) => row.relayauth_identity_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  if (identityIds.length === 0) {
    return 0;
  }

  const client = createRelayAuthClient();
  if (!client) {
    console.warn(
      `[stuck-run-reaper] Skipping RelayAuth identity cleanup for ${identityIds.length} reaped runs: RelayAuth client is not configured`,
    );
    return 0;
  }

  let revoked = 0;
  for (const identityId of identityIds) {
    try {
      await revokeWorkflowIdentity(client, identityId);
      revoked += 1;
    } catch (error) {
      console.warn(
        `[stuck-run-reaper] Failed to revoke RelayAuth identity ${identityId}: ${getErrorMessage(error)}`,
      );
    }
  }

  return revoked;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
