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
import { DurableEventQueue, InProcessEventQueue, type DurableEventQueueOptions } from './event-queue.js';
import { LocalFileStorage, createFileRouteHandler, FILE_ROUTE_PREFIX } from './files.js';
import { sweepOfflineNodes } from '../../engine/node.js';
import { sweepTimedOutInvocations } from '../../engine/action.js';
import { sendNodePresenceContext } from '../../engine/nodeContext.js';
import { sweepDueHttpPushDeliveries } from '../../routes/deliveryRouting.js';

export {
  InProcessRealtime,
  InProcessPresence,
  InProcessRateLimiter,
  InProcessKeyValueStore,
  InProcessEventQueue,
  DurableEventQueue,
  LocalFileStorage,
  createFileRouteHandler,
  FILE_ROUTE_PREFIX,
  getSqliteDb,
  runMigrations,
};
export type { EngineSocket, SocketHandle } from './realtime.js';
export type { SqliteDbHandle } from './database.js';
export type { InProcessPresenceOptions } from './presence.js';
export type { DurableEventQueueOptions, InProcessEventQueueOptions } from './event-queue.js';

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
  /** Durable webhook outbox tuning (poll interval, backoff, cleanup cadence). */
  eventQueue?: DurableEventQueueOptions;
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
  /** Durable webhook outbox; already started — exposed for graceful shutdown and tests. */
  webhookQueue: DurableEventQueue;
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
  const upstreamOnPresenceEvent = options.presence?.onPresenceEvent;
  const presence = new InProcessPresence(realtime, {
    ...options.presence,
    onPresenceEvent: async (workspaceId, event) => {
      await upstreamOnPresenceEvent?.(workspaceId, event);
      const subjectAgentId = typeof event.subject_agent_id === 'string' ? event.subject_agent_id : null;
      const eventType = typeof event.type === 'string' ? event.type : null;
      if (!subjectAgentId || !eventType) return;
      await sendNodePresenceContext(
        { db, nodeConnections: realtime, realtime, workspaceId },
        {
          subjectAgentId,
          event: eventType,
          data: {
            agent_id: subjectAgentId,
            agent_name: typeof event.agent_name === 'string' ? event.agent_name : subjectAgentId,
            status: event.status,
          },
        },
      );
    },
  });
  realtime.setPresence(presence);

  const rateLimiter = new InProcessRateLimiter();
  const kv = new InProcessKeyValueStore();
  const fileStorage = new LocalFileStorage(
    options.fileDir ?? `${process.cwd()}/relaycast-files`,
    options.baseUrl,
    options.fileSecret ?? randomBytes(32).toString('hex'),
  );
  const webhookQueue = new DurableEventQueue(
    db,
    (err, ctx) => telemetry.captureException(err, ctx),
    options.eventQueue,
  );
  // Resume any deliveries left over from a previous process (the outbox's point).
  webhookQueue.start();

  const auth = options.auth ?? new SqliteApiKeyAuthProvider();
  const entitlements = options.entitlements ?? new StaticEntitlementsProvider(kv);

  const deps: EngineDeps = {
    db,
    realtime,
    connections: realtime,
    nodeConnections: realtime,
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

  realtime.setNodeCompletionDeps(deps);

  const sweepTimer = setInterval(() => {
    void sweepOfflineNodes(db, realtime).catch(() => {});
    void sweepTimedOutInvocations(db, realtime).catch(() => {});
    void sweepDueHttpPushDeliveries(deps).catch(() => {});
  }, 15_000);
  (sweepTimer as { unref?: () => void }).unref?.();

  return {
    deps,
    realtime,
    presence,
    webhookQueue,
    fileHandler: createFileRouteHandler(fileStorage),
    handle,
    close() {
      clearInterval(sweepTimer);
      presence.stop();
      webhookQueue.stop();
      kv.dispose();
      try {
        handle.sqlite.close();
      } catch {
        // already closed
      }
    },
  };
}
