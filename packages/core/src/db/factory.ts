import { getDb, setDbForTesting } from "./client.js";
import type { AppDb } from "./client.js";

export type { AppDb };
export { setDbForTesting };

/**
 * Select the appropriate DB client for the current runtime.
 *
 * Runtime detection and connection-string resolution now live entirely in
 * `client.ts` / `connection.ts`:
 *   - Cloudflare Worker → Neon HTTP with lazy WebSocket transactions.
 *   - Node / Lambda      → node-postgres pool.
 *
 * Both runtimes read the same `NeonDatabaseUrl` secret (or `DATABASE_URL`),
 * so this factory no longer needs a per-call connection string. It remains as
 * a thin compatibility shim for existing import sites.
 */
export function selectDbClient(): AppDb {
  return getDb();
}
