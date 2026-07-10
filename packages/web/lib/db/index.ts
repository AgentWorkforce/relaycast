import {
  getDb as getCoreDb,
  readCoreDbRuntimeDiagnosticSnapshot,
  setDbForTesting as setCoreDbForTesting,
} from "@cloud/core/db/client.js";
import type { PgDatabase } from "drizzle-orm/pg-core";
import * as schema from "./schema.js";

export type AppDb = PgDatabase<any, typeof schema> & { $client: unknown };

// The runtime DB client selection (Neon serverless on the Cloudflare Worker,
// node-postgres on the Lambda) lives entirely in `@cloud/core/db/client`. Both
// runtimes resolve the same `NeonDatabaseUrl` secret (or `DATABASE_URL`), so
// this module is a thin re-export that keeps the `@/lib/db` import path.

export function getDb(): AppDb {
  return getCoreDb() as unknown as AppDb;
}

export function setDbForTesting(db: AppDb | null): void {
  setCoreDbForTesting(db as Parameters<typeof setCoreDbForTesting>[0]);
}

export function readDbRuntimeDiagnosticSnapshot() {
  return readCoreDbRuntimeDiagnosticSnapshot();
}
