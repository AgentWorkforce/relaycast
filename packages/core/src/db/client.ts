import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";
import * as schema from "./schema.js";
import { getNeonDatabaseUrl, isLocalConnectionString } from "./connection.js";
import { getNeonWorkerDb } from "./worker-neon.js";

const createDb = () => drizzle(getPool(), { schema });
export type AppDb = PgDatabase<any, typeof schema> & { $client: unknown };

declare global {
  var __appDbPool: Pool | undefined;
  var __appDbOverride: AppDb | undefined;
}

type CoreDbRuntimeDiagnosticSnapshot = {
  selectedDbClient:
    | "override"
    | "neon-worker"
    | "worker-neon-unavailable"
    | "node-postgres";
  hasDatabaseUrl: boolean;
  hasNeonConnectionString: boolean;
  hasAppDbPool: boolean;
  cloudflareContextType: string;
  cloudflareContextHasEnv: boolean;
  cloudflareContextEnvKeys: number;
  navigatorUserAgent: string | null;
};

const cloudflareContextSymbol = Symbol.for("__cloudflare-context__");
let lastCoreDbRuntimeDiagnosticSnapshot:
  | CoreDbRuntimeDiagnosticSnapshot
  | undefined;

function getDbConfig() {
  const connectionString = getNeonDatabaseUrl();
  if (!connectionString) {
    throw new Error(
      "[db] No Postgres connection string configured (set DATABASE_URL or the NeonDatabaseUrl secret)",
    );
  }

  // Neon requires TLS; local dev databases generally don't.
  if (isLocalConnectionString(connectionString)) {
    return { connectionString, max: 10 };
  }
  return { connectionString, max: 10, ssl: { rejectUnauthorized: false } };
}

function createPool() {
  return new Pool(getDbConfig());
}

function getPool() {
  if (!globalThis.__appDbPool) {
    globalThis.__appDbPool = createPool();
  }
  return globalThis.__appDbPool;
}

function isWorkerRuntime(): boolean {
  const context = (globalThis as Record<symbol, unknown>)[cloudflareContextSymbol];
  if (context && typeof context === "object") {
    return true;
  }
  const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator;
  return (
    typeof nav?.userAgent === "string" &&
    nav.userAgent.includes("Cloudflare-Workers")
  );
}

export function getDb() {
  if (globalThis.__appDbOverride) {
    lastCoreDbRuntimeDiagnosticSnapshot =
      buildCoreDbRuntimeDiagnosticSnapshot("override");
    return globalThis.__appDbOverride;
  }

  // Cloudflare Worker runtime: node-postgres TCP pools don't work on workerd.
  // The Worker client is HTTP-first and keeps a lazy Neon WebSocket pool only
  // for interactive transaction callers.
  if (isWorkerRuntime()) {
    const connectionString = getNeonDatabaseUrl();
    if (connectionString) {
      lastCoreDbRuntimeDiagnosticSnapshot =
        buildCoreDbRuntimeDiagnosticSnapshot("neon-worker");
      return getNeonWorkerDb(connectionString);
    }
    lastCoreDbRuntimeDiagnosticSnapshot =
      buildCoreDbRuntimeDiagnosticSnapshot("worker-neon-unavailable");
    throw new Error(
      "[db] Neon connection string unavailable on worker runtime (NeonDatabaseUrl not bound)",
    );
  }

  // Node / Lambda runtime: node-postgres pool over a direct TCP connection to
  // Neon's public endpoint.
  lastCoreDbRuntimeDiagnosticSnapshot =
    buildCoreDbRuntimeDiagnosticSnapshot("node-postgres");
  return createDb();
}

export function setDbForTesting(db: AppDb | null) {
  globalThis.__appDbOverride = db ?? undefined;
}

export function readCoreDbRuntimeDiagnosticSnapshot():
  | CoreDbRuntimeDiagnosticSnapshot
  | undefined {
  return lastCoreDbRuntimeDiagnosticSnapshot
    ? { ...lastCoreDbRuntimeDiagnosticSnapshot }
    : undefined;
}

function buildCoreDbRuntimeDiagnosticSnapshot(
  selectedDbClient: CoreDbRuntimeDiagnosticSnapshot["selectedDbClient"],
): CoreDbRuntimeDiagnosticSnapshot {
  const context = (globalThis as Record<symbol, unknown>)[cloudflareContextSymbol];
  return {
    selectedDbClient,
    hasDatabaseUrl:
      typeof process.env.DATABASE_URL === "string" &&
      process.env.DATABASE_URL.length > 0,
    hasNeonConnectionString: !!getNeonDatabaseUrl(),
    hasAppDbPool: !!globalThis.__appDbPool,
    cloudflareContextType: typeof context,
    cloudflareContextHasEnv: hasObjectEnv(context),
    cloudflareContextEnvKeys: countContextEnvKeys(context),
    navigatorUserAgent: readNavigatorUserAgent(),
  };
}

function readNavigatorUserAgent(): string | null {
  const navigatorLike = (globalThis as { navigator?: { userAgent?: unknown } })
    .navigator;
  return typeof navigatorLike?.userAgent === "string"
    ? navigatorLike.userAgent
    : null;
}

function hasObjectEnv(context: unknown): boolean {
  return (
    !!context &&
    typeof context === "object" &&
    !!(context as { env?: unknown }).env &&
    typeof (context as { env?: unknown }).env === "object"
  );
}

function countContextEnvKeys(context: unknown): number {
  if (!hasObjectEnv(context)) {
    return 0;
  }
  return Object.keys((context as { env: Record<string, unknown> }).env).length;
}
