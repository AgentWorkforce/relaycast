import { drizzle } from "drizzle-orm/neon-serverless";
import { Pool, type PoolConfig } from "@neondatabase/serverless";
import type { AppDb } from "./client.js";
import { getNeonHttpDb } from "./worker-neon-http.js";
import * as schema from "./schema.js";

// Cloudflare Worker runtime DB client.
//
// Ordinary Worker queries use Neon's stateless HTTP driver. WebSocket sockets
// opened by @neondatabase/serverless are bound to the request IO context that
// created them; in production workerd tears those sockets down at request
// completion, which turns a busy webhook path into thousands of noisy
// "Network connection lost" pool errors.
//
// Why keep a neon-serverless (WebSocket Pool) path at all:
//   - The app uses interactive `db.transaction(...)` (auth/store, invites,
//     workers/dispatcher, ricky webhook-dedup, integration channels). The
//     neon-http driver is single-shot and cannot hold a transaction open;
//     the WebSocket-backed `Pool` from `@neondatabase/serverless` can, and is
//     wire-compatible with node-postgres so type/array parsing matches the
//     Lambda path.
//   - The pool must be per transaction and explicitly closed. Caching it across
//     requests leaves idle Worker-owned sockets behind, which workerd later
//     severs and reports as "Network connection lost".
//
// Neon exposes a public TLS endpoint, so the Worker connects to it directly —
// no Cloudflare Hyperdrive / cloudflared tunnel / in-VPC PgBouncer bridge
// (all removed; they existed only to reach a VPC-private Aurora cluster).
//
// On workerd the global `WebSocket` is used by the driver automatically; no
// `neonConfig.webSocketConstructor` shim is needed (that's only required under
// plain Node, which the Lambda path avoids by using node-postgres).

const cloudflareContextSymbol = Symbol.for("__cloudflare-context__");
const requestScopedClients = new WeakMap<object, AppDb>();
const workerNeonPoolConfig = {
  connectionTimeoutMillis: 3_000,
  idleTimeoutMillis: 1,
  max: 1,
  maxUses: 1,
} satisfies Pick<
  PoolConfig,
  "connectionTimeoutMillis" | "idleTimeoutMillis" | "max" | "maxUses"
>;

function readCloudflareContext(): object | undefined {
  const ctx = (globalThis as Record<symbol, unknown>)[cloudflareContextSymbol];
  return ctx && typeof ctx === "object" ? (ctx as object) : undefined;
}

function createNeonClient(connectionString: string): AppDb {
  const httpDb = getNeonHttpDb(connectionString) as unknown as AppDb;

  const runTransaction: AppDb["transaction"] = async (callback, config) => {
    const pool = new Pool({ connectionString, ...workerNeonPoolConfig });
    attachPoolErrorListener(pool);
    attachPoolLifecycleTelemetry(pool);
    const transactionDb = drizzle(pool, { schema }) as unknown as AppDb;
    try {
      return await transactionDb.transaction(callback, config);
    } finally {
      await closeTransactionPool(pool);
    }
  };

  return new Proxy(httpDb, {
    get(target, prop, receiver) {
      if (prop === "transaction") {
        return runTransaction;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

export function getWorkerNeonPoolConfigForTesting(): typeof workerNeonPoolConfig {
  return { ...workerNeonPoolConfig };
}

type InstrumentablePool = {
  connect: Pool["connect"];
  on(event: "connect" | "acquire" | "release" | "remove", listener: (...args: unknown[]) => void): unknown;
};

type PoolLifecycleSnapshot = {
  totalCount?: number;
  idleCount?: number;
  waitingCount?: number;
};

function readPoolLifecycleSnapshot(pool: unknown): PoolLifecycleSnapshot {
  const source = pool as {
    totalCount?: unknown;
    idleCount?: unknown;
    waitingCount?: unknown;
  };
  return {
    totalCount: typeof source.totalCount === "number" ? source.totalCount : undefined,
    idleCount: typeof source.idleCount === "number" ? source.idleCount : undefined,
    waitingCount:
      typeof source.waitingCount === "number" ? source.waitingCount : undefined,
  };
}

/**
 * Attribute Worker DB stalls to pool acquisition/connect time vs post-acquire
 * query work. Pool acquisition is the visible boundary shared by direct
 * `pool.connect()` transaction callers and `pool.query()` callers.
 */
export function attachPoolLifecycleTelemetry(pool: InstrumentablePool): void {
  const originalConnect = pool.connect.bind(pool) as Pool["connect"];
  pool.connect = ((callback?: unknown) => {
    const startedAt = Date.now();
    const logAcquire = (error?: unknown) => {
      const durationMs = Date.now() - startedAt;
      if (durationMs < 500 && !error) {
        return;
      }
      const snapshot = readPoolLifecycleSnapshot(pool);
      const level = error || durationMs >= 2_000 ? "warn" : "info";
      console[level]("[db] neon worker pool acquire timing", {
        durationMs,
        outcome: error ? "error" : "success",
        ...snapshot,
        error: error instanceof Error ? error.message : error ? String(error) : undefined,
      });
    };

    if (typeof callback === "function") {
      return originalConnect((error, client, done) => {
        logAcquire(error);
        (callback as Parameters<Pool["connect"]>[0])(error, client, done);
      });
    }

    return originalConnect().then(
      (client) => {
        logAcquire();
        return client;
      },
      (error) => {
        logAcquire(error);
        throw error;
      },
    );
  }) as Pool["connect"];

  if (process.env.WORKER_NEON_POOL_DEBUG === "1") {
    pool.on("connect", () => {
      console.info(
        "[db] neon worker pool client connected",
        readPoolLifecycleSnapshot(pool),
      );
    });
    pool.on("remove", () => {
      console.info(
        "[db] neon worker pool client removed",
        readPoolLifecycleSnapshot(pool),
      );
    });
  }
}

/**
 * Observe async socket errors emitted by the pool's idle connections.
 *
 * workerd severs a request's sockets (including the pool's idle Neon
 * WebSockets) when the owning request context ends. `Pool` re-emits those
 * connection errors as `error` events; with no listener attached, Node's
 * EventEmitter throws them as
 * `Unhandled error. (Uncaught Error: Network connection lost.)` — a noisy,
 * uncatchable log line on virtually every Worker request that touched the
 * DB. The severed socket is already unusable and the pool discards it, so
 * the only correct handling is to log and move on.
 */
export function attachPoolErrorListener(pool: {
  on(event: "error", listener: (error: unknown) => void): unknown;
}): void {
  pool.on("error", (error) => {
    console.warn(
      "[db] neon pool connection error (socket severed or lost):",
      serializePoolError(error),
    );
  });
}

async function closeTransactionPool(pool: Pool): Promise<void> {
  try {
    await pool.end();
  } catch (error) {
    console.warn(
      "[db] neon worker transaction pool close failed:",
      serializePoolError(error),
    );
  }
}

type SerializedPoolError = {
  name?: string;
  message?: string;
  type?: string;
  code?: string;
  constructorName?: string;
  error?: SerializedPoolError;
  value?: string;
};

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function codeValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function codeField(record: Record<string, unknown>, key: string): string | undefined {
  return codeValue(record[key]);
}

function serializePoolError(error: unknown, seen = new WeakSet<object>()): SerializedPoolError {
  if (error instanceof Error) {
    const errorWithCode = error as Error & { code?: unknown };
    return {
      name: error.name,
      message: error.message,
      code: codeValue(errorWithCode.code),
    };
  }

  if (error && typeof error === "object") {
    if (seen.has(error)) {
      return { value: "[Circular]" };
    }
    seen.add(error);

    const record = error as Record<string, unknown>;
    const nestedError = record.error;
    const serialized: SerializedPoolError = {
      name: stringField(record, "name"),
      message: stringField(record, "message"),
      type: stringField(record, "type"),
      code: codeField(record, "code"),
      constructorName: error.constructor?.name,
      error:
        nestedError && nestedError !== error
          ? serializePoolError(nestedError, seen)
          : undefined,
    };
    if (!serialized.message && serialized.error?.message) {
      serialized.message = serialized.error.message;
    }
    return serialized;
  }

  return { value: String(error) };
}

/**
 * Return a Neon-backed drizzle client for the current Worker request.
 *
 * A `Pool` opens sockets bound to the Worker request/IO context that created
 * them, so clients are scoped to the request-context object via a WeakMap and
 * are never cached process-globally. With no request context (e.g. a one-off
 * invocation outside a request), a fresh client is made and not cached.
 */
export function getNeonWorkerDb(connectionString: string): AppDb {
  const ctxKey = readCloudflareContext();
  if (!ctxKey) {
    return createNeonClient(connectionString);
  }

  const cached = requestScopedClients.get(ctxKey);
  if (cached) {
    return cached;
  }

  const db = createNeonClient(connectionString);
  requestScopedClients.set(ctxKey, db);
  return db;
}
