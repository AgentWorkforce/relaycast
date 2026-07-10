import { Resource } from "sst";
import { Client } from "pg";
import { nodePgConnectionConfig } from "../db/connection.js";
import { CredentialStore } from "./credential-store.js";
import { isCredentialSweepDisabled } from "./credential-sweep-config.js";
import {
  refreshCredential,
  type RefreshableCredentialProvider,
} from "./credential-refresher.js";
import { parseCredentialExpiry } from "./credential-expiry.js";

type SweepProvider = RefreshableCredentialProvider;

interface SweepRow {
  id: string;
  user_id: string;
  workspace_id: string;
  model_provider: string;
  refresh_attempts: number | null;
}

function getRequiredEnv(name: "CREDENTIAL_S3_BUCKET"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set`);
  }

  return value;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isSweepProvider(value: string): value is SweepProvider {
  return (
    value === "anthropic" ||
    value === "openai" ||
    value === "xai" ||
    value === "daytona"
  );
}

interface ExhaustedRow {
  id: string;
  user_id: string;
  workspace_id: string;
  model_provider: string;
  harness: string;
  auth_type: string;
  last_error: string | null;
  credential_expires_at: string | null;
  last_refresh_attempt_at: string | null;
}

/**
 * Emit ONE structured alarm line per sweep while ANY credential is
 * refresh-exhausted. Exhausted rows leave the sweep's refresh SELECT
 * forever (`refresh_exhausted = FALSE` filter), so without this census the
 * last log line fires at attempt 3 and the credential dies silently while
 * every harness run for that user 401s — that's how the 2026-06-04
 * pr-reviewer outage stayed invisible for hours. A line that repeats every
 * sweep is a continuous CloudWatch signal (metric-filter on
 * "credential sweep ALARM"); silence means healthy.
 */
export async function logExhaustedCredentialAlarm(
  client: Pick<Client, "query">,
): Promise<number> {
  // True total first (no-silent-caps): under mass exhaustion the sample is
  // capped at 50 but `count` must report reality, with `sampleTruncated`
  // making the cap explicit.
  const totalResult = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM provider_credentials
     WHERE refresh_exhausted = TRUE
       AND auth_type = 'provider_oauth'`,
  );
  const total = Number(totalResult.rows[0]?.count ?? 0);
  if (total === 0) {
    return 0;
  }
  const { rows } = await client.query<ExhaustedRow>(
    `SELECT id, user_id, workspace_id, model_provider, harness, auth_type,
            last_error, credential_expires_at, last_refresh_attempt_at
     FROM provider_credentials
     WHERE refresh_exhausted = TRUE
       AND auth_type = 'provider_oauth'
     ORDER BY credential_expires_at ASC NULLS LAST
     LIMIT 50`,
  );
  console.error(
    "[sweep] credential sweep ALARM: refresh-exhausted credentials — every harness run for these users fails until the provider is reconnected",
    JSON.stringify({
      count: total,
      sampleTruncated: total > rows.length,
      credentials: rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        workspaceId: row.workspace_id,
        provider: row.model_provider,
        harness: row.harness,
        authType: row.auth_type,
        lastError: row.last_error,
        // last_refresh_attempt_at stops advancing at exhaustion, so it
        // doubles as "exhausted since approximately".
        exhaustedSinceApprox: row.last_refresh_attempt_at,
        expiresAt: row.credential_expires_at,
      })),
    }),
  );
  return total;
}

export const handler = async (
  _event?: unknown,
): Promise<{
  refreshed: number;
  failed: number;
  skipped: number;
  exhausted: number;
}> => {
  if (isCredentialSweepDisabled()) {
    console.log("[sweep] Disabled via DISABLE_CREDENTIAL_SWEEP");
    return {
      refreshed: 0,
      failed: 0,
      skipped: 0,
      exhausted: 0,
    };
  }

  const client = new Client(nodePgConnectionConfig());

  let refreshed = 0;
  let failed = 0;
  let skipped = 0;
  let transactionOpen = false;

  try {
    await client.connect();

    const store = new CredentialStore({
      bucket: getRequiredEnv("CREDENTIAL_S3_BUCKET"),
      prefix: "credentials",
      encryptionKey: Resource.CredentialEncryptionKey.value,
    });

    await client.query("BEGIN");
    transactionOpen = true;

    let rows: SweepRow[];
    try {
      const result = await client.query<SweepRow>(
        `SELECT id, user_id, workspace_id, model_provider, refresh_attempts
         FROM provider_credentials
         WHERE credential_expires_at < NOW() + INTERVAL '2 days'
           AND refresh_exhausted = FALSE
           AND status = 'connected'
           AND auth_type = 'provider_oauth'
         ORDER BY credential_expires_at ASC
         LIMIT 50
         FOR UPDATE SKIP LOCKED`,
      );
      rows = result.rows;
    } catch (error) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      throw error;
    }

    for (const row of rows) {
      if (!isSweepProvider(row.model_provider)) {
        skipped += 1;
        continue;
      }

      let credentialJson: string | null;
      try {
        credentialJson = await store.retrieve(row.user_id, row.model_provider);
      } catch (error) {
        const message = getErrorMessage(error);
        const newAttempts = (row.refresh_attempts ?? 0) + 1;
        const exhausted = newAttempts >= 3;
        await client.query(
          `UPDATE provider_credentials SET
             refresh_attempts = $1,
             refresh_exhausted = $2,
             last_refresh_attempt_at = NOW(),
             last_error = $3,
             updated_at = NOW()
           WHERE id = $4`,
          [newAttempts, exhausted, message, row.id],
        );
        failed += 1;
        console.error(
          `[sweep] Failed to retrieve credential for ${row.model_provider} user ${row.user_id}: ${message}`,
          JSON.stringify({ provider: row.model_provider, userId: row.user_id, workspaceId: row.workspace_id, attempts: newAttempts, exhausted }),
        );
        continue;
      }

      if (credentialJson === null) {
        skipped += 1;
        continue;
      }

      try {
        const result = await refreshCredential(row.model_provider, credentialJson);
        const expiresAt =
          result.expiresAt ?? parseCredentialExpiry(result.credentialJson);

        await store.store(row.user_id, row.model_provider, result.credentialJson);
        await client.query(
          `UPDATE provider_credentials SET
             credential_expires_at = $1,
             credential_stored_at = NOW(),
             last_authenticated_at = NOW(),
             refresh_attempts = 0,
             refresh_exhausted = FALSE,
             last_refresh_attempt_at = NOW(),
             last_error = NULL,
             status = 'connected',
             updated_at = NOW()
           WHERE id = $2`,
          [expiresAt, row.id],
        );

        refreshed += 1;
        console.log(`[sweep] Refreshed ${row.model_provider} for user ${row.user_id}`);
      } catch (error) {
        const message = getErrorMessage(error);
        const newAttempts = (row.refresh_attempts ?? 0) + 1;
        const exhausted = newAttempts >= 3;

        await client.query(
          `UPDATE provider_credentials SET
             refresh_attempts = $1,
             refresh_exhausted = $2,
             last_refresh_attempt_at = NOW(),
             last_error = $3,
             status = $4,
             updated_at = NOW()
           WHERE id = $5`,
          [
            newAttempts,
            exhausted,
            message,
            exhausted ? "refresh_failed" : "connected",
            row.id,
          ],
        );

        failed += 1;
        console.error(
          `[sweep] Failed ${row.model_provider} for user ${row.user_id}: ${message}`,
          JSON.stringify({ provider: row.model_provider, userId: row.user_id, workspaceId: row.workspace_id, attempts: newAttempts, exhausted }),
        );
      }
    }

    await client.query("COMMIT");
    transactionOpen = false;

    // Census runs OUTSIDE the row-lock transaction: read-only, and it must
    // fire even on sweeps that had nothing to refresh. Best-effort: a census
    // read error must not fail a sweep whose refresh work already committed
    // (the next sweep's census converges).
    let exhaustedCount = 0;
    try {
      exhaustedCount = await logExhaustedCredentialAlarm(client);
    } catch (error) {
      console.error(
        "[sweep] exhausted-credential census failed; refresh results above still committed",
        getErrorMessage(error),
      );
    }

    console.log(
      `[sweep] Done — refreshed: ${refreshed}, failed: ${failed}, skipped: ${skipped}, exhausted: ${exhaustedCount}`,
    );

    return { refreshed, failed, skipped, exhausted: exhaustedCount };
  } catch (error) {
    if (transactionOpen) {
      await client.query("ROLLBACK");
    }
    throw error;
  } finally {
    await client.end();
  }
};
