import { Resource } from "sst";

/**
 * Resolve the Neon Postgres connection string for this runtime.
 *
 * Source order:
 *  1. `process.env.DATABASE_URL` — local dev and the drizzle-kit migration
 *     tooling (which sets it / runs under `sst shell`) take precedence so a
 *     developer can point at a throwaway database without touching SST.
 *  2. `Resource.NeonDatabaseUrl.value` — the deployed Lambda and Cloudflare
 *     Worker both read the linked SST secret here. `process.env` is empty in
 *     those runtimes, so this is the load-bearing path in production.
 *
 * Returns `undefined` when neither is configured; callers decide whether that
 * is fatal (it is on the Worker, where there is no other DB path).
 */
export function getNeonDatabaseUrl(): string | undefined {
  const envUrl = process.env.DATABASE_URL;
  if (typeof envUrl === "string" && envUrl.length > 0) {
    return envUrl;
  }

  try {
    const value = (Resource as unknown as { NeonDatabaseUrl?: { value?: unknown } })
      .NeonDatabaseUrl?.value;
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  } catch {
    // Resource proxy throws when the binding isn't attached (tests / local
    // dev without SST). Fall through to `undefined`.
  }

  return undefined;
}

/**
 * Like {@link getNeonDatabaseUrl} but throws when nothing is configured.
 * Use from handlers that cannot operate without a database.
 */
export function requireNeonDatabaseUrl(): string {
  const url = getNeonDatabaseUrl();
  if (!url) {
    throw new Error(
      "No Postgres connection string configured (set DATABASE_URL or the NeonDatabaseUrl secret)",
    );
  }
  return url;
}

/**
 * Whether a connection string points at a local database, in which case TLS is
 * disabled. Neon endpoints are always remote and TLS-required.
 */
export function isLocalConnectionString(connectionString: string): boolean {
  return /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString);
}

/**
 * Convert a pooled Neon connection string to its direct endpoint form.
 *
 * Most app traffic should use Neon's pooled `-pooler` host. Session-scoped
 * Postgres features such as `pg_advisory_lock` must not, because transaction
 * pooling does not pin the server-side backend session. Local and non-Neon
 * connection strings are returned unchanged.
 */
export function toDirectNeonConnectionString(connectionString: string): string {
  try {
    const parsed = new URL(connectionString);
    parsed.hostname = parsed.hostname.replace("-pooler.", ".");
    return parsed.toString();
  } catch {
    return connectionString;
  }
}

/**
 * node-postgres `Client`/`Pool` config for the current Neon connection string.
 * TLS is enabled for remote (Neon) endpoints and disabled for local dev.
 */
export function nodePgConnectionConfig():
  | { connectionString: string }
  | { connectionString: string; ssl: { rejectUnauthorized: boolean } } {
  const connectionString = requireNeonDatabaseUrl();
  return isLocalConnectionString(connectionString)
    ? { connectionString }
    : { connectionString, ssl: { rejectUnauthorized: false } };
}
