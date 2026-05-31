import { randomBytes } from 'node:crypto';
import type { EngineDeps, EngineConfig } from '../../ports/index.js';
import type { AuthProvider } from '../../ports/auth.js';
import type { EntitlementsProvider } from '../../ports/entitlements.js';
import type { TelemetrySink } from '../../ports/telemetry.js';
import { SqliteApiKeyAuthProvider } from '../../auth/index.js';
import { StaticEntitlementsProvider } from '../../providers/static-entitlements.js';
import { NoopTelemetrySink } from '../../providers/noop-telemetry.js';
import { getSqliteDb, runMigrations, type SqliteDbHandle } from './database.js';
import { InProcessRealtime } from './realtime.js';
import { InProcessPresence, type InProcessPresenceOptions } from './presence.js';
import { InProcessRateLimiter } from './rate-limit.js';
import { InProcessKeyValueStore } from './kv.js';
import { InProcessEventQueue } from './event-queue.js';
import { LocalFileStorage, createFileRouteHandler, FILE_ROUTE_PREFIX } from './files.js';

export {
  InProcessRealtime,
  InProcessPresence,
  InProcessRateLimiter,
  InProcessKeyValueStore,
  InProcessEventQueue,
  LocalFileStorage,
  createFileRouteHandler,
  FILE_ROUTE_PREFIX,
  getSqliteDb,
  runMigrations,
};
export type { EngineSocket, SocketHandle } from './realtime.js';
export type { SqliteDbHandle } from './database.js';
export type { InProcessPresenceOptions } from './presence.js';

export interface NodeRuntimeOptions {
  /** SQLite file path, or ':memory:' for tests. */
  dbPath: string;
  /** This server's own origin, used for signed file URLs. */
  baseUrl: string;
  /** Directory blobs are written to. Default: `<cwd>/relaycast-files`. */
  fileDir?: string;
  /** HMAC secret for signed file URLs. Default: a random per-process secret. */
  fileSecret?: string;
  /** Run migrations on startup. Default: true. */
  migrate?: boolean;
  /** Override the auth provider (default: built-in API-key auth). */
  auth?: AuthProvider;
  /** Override the entitlements provider (default: static, kv-backed usage). */
  entitlements?: EntitlementsProvider;
  /** Override the telemetry sink (default: no-op). */
  telemetry?: TelemetrySink;
  /** Engine config (environment, version, workspace-stream default, etc.). */
  config?: EngineConfig;
  /** Presence TTL / sweep tuning (tests use short windows). */
  presence?: InProcessPresenceOptions;
}

/**
 * The assembled Node runtime: the {@link EngineDeps} to pass to `createEngine`,
 * plus the concrete adapters the entrypoint needs to wire WebSocket upgrades,
 * serve files, and shut down cleanly.
 */
export interface NodeRuntime {
  deps: EngineDeps;
  realtime: InProcessRealtime;
  presence: InProcessPresence;
  /** `fetch`-style handler for the `${FILE_ROUTE_PREFIX}` upload/download routes. */
  fileHandler: (request: Request) => Promise<Response>;
  handle: SqliteDbHandle;
  /** Release timers + the database connection. */
  close(): void;
}

/**
 * Construct the in-process Node + SQLite runtime. Wires the realtime bus to the
 * presence tracker, opens (and optionally migrates) the database, and returns
 * everything `createEngine` and the entrypoint need.
 */
export function createNodeRuntime(options: NodeRuntimeOptions): NodeRuntime {
  const handle = getSqliteDb(options.dbPath);
  if (options.migrate !== false) {
    try {
      runMigrations(handle);
    } catch (err) {
      // Don't leak the open file handle if startup migrations fail.
      try { handle.sqlite.close(); } catch { /* ignore */ }
      throw err;
    }
  }
  const db = handle.db;

  const telemetry = options.telemetry ?? new NoopTelemetrySink();
  const realtime = new InProcessRealtime(db);
  const presence = new InProcessPresence(realtime, options.presence);
  realtime.setPresence(presence);

  const rateLimiter = new InProcessRateLimiter();
  const kv = new InProcessKeyValueStore();
  const fileStorage = new LocalFileStorage(
    options.fileDir ?? `${process.cwd()}/relaycast-files`,
    options.baseUrl,
    options.fileSecret ?? randomBytes(32).toString('hex'),
  );
  const webhookQueue = new InProcessEventQueue(db, (err, ctx) => telemetry.captureException(err, ctx));

  const auth = options.auth ?? new SqliteApiKeyAuthProvider();
  const entitlements = options.entitlements ?? new StaticEntitlementsProvider(kv);

  const deps: EngineDeps = {
    db,
    realtime,
    connections: realtime,
    presence,
    rateLimiter,
    files: fileStorage,
    kv,
    webhookQueue,
    auth,
    entitlements,
    telemetry,
    config: options.config ?? {},
  };

  return {
    deps,
    realtime,
    presence,
    fileHandler: createFileRouteHandler(fileStorage),
    handle,
    close() {
      presence.stop();
      kv.dispose();
      try {
        handle.sqlite.close();
      } catch {
        // already closed
      }
    },
  };
}
