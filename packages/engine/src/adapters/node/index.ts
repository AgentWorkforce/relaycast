import { safeTelemetrySink } from '../../ports/telemetry.js';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import type { EngineDeps, EngineConfig, EngineDb } from '../../ports/index.js';
import type { AuthProvider } from '../../ports/auth.js';
import type { AdmissionHooks } from '../../ports/admission.js';
import type { TelemetrySink } from '../../ports/telemetry.js';
import { SqliteApiKeyAuthProvider } from '../../auth/index.js';
import { NoopTelemetrySink } from '../../providers/noop-telemetry.js';
import {
  CollectorTelemetrySink,
  resolveTelemetryDestination,
  type TelemetryDestination,
} from '../../providers/collector-telemetry.js';
import { getSqliteDb, runMigrations, type SqliteDbHandle } from './database.js';
import { InProcessRealtime } from './realtime.js';
import { InProcessPresence, type InProcessPresenceOptions } from './presence.js';
import { InProcessRateLimiter } from './rate-limit.js';
import { InProcessKeyValueStore } from './kv.js';
import { DurableEventQueue, InProcessEventQueue, type DurableEventQueueOptions } from './event-queue.js';
import { LocalFileStorage, createFileRouteHandler, FILE_ROUTE_PREFIX } from './files.js';
import { sweepOfflineNodes } from '../../engine/node.js';
import { sweepStaleAgents } from '../../engine/agent.js';
import { sweepTimedOutInvocations } from '../../engine/action.js';
import { sendNodePresenceContext } from '../../engine/nodeContext.js';
import { createDeliveryMaintenanceRunner } from './delivery-maintenance.js';
import { sweepPendingA2aEgress } from '../../engine/a2aEgress.js';
import { reapExpiredWorkspaces } from '../../engine/workspace.js';
import { createNodeOutboundWebhookFetch } from './ssrf-fetch.js';
import { InProcessDeliveryWaiters } from '../../ports/deliveryWaiters.js';

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

/** Opt-in self-host analytics producer (see `CollectorTelemetrySink`). */
export interface NodeTelemetryCollectorOptions {
  /** Collector ingest URL: https, or http to localhost / `*.svc` / a single-label host. */
  url: string;
  /** Per-producer bearer token for the collector (required; read it from a Secret file; never log it). */
  bearerToken: string;
  /** Explicit, stable installation/deployment id on every exported event (required; no hostname default). */
  deployment: string;
  /** Default 1000. */
  queueMax?: number;
  /** Default 50. */
  batchMax?: number;
  /** Default 2000. */
  flushIntervalMs?: number;
  /** Transport attempts per batch, first try included. Default 3. */
  maxAttempts?: number;
  /** Local retry backoff, ms (retry n waits n * backoffMs). Default 500. */
  backoffMs?: number;
  /** Longest honored Retry-After, ms (0 ignores it, at most 30000). Default 30000. */
  retryAfterMaxMs?: number;
  /** Per-attempt request timeout, ms. Default 5000. */
  requestTimeoutMs?: number;
  /** Total delivery deadline per event from enqueue, ms. Default 60000. */
  deliveryDeadlineMs?: number;
  /** Longest shutdown drain, ms. Default 5000. */
  shutdownTimeoutMs?: number;
  /** Largest serialized event, UTF-8 bytes. Default 8192. */
  eventMaxBytes?: number;
  /** Largest serialized batch body, UTF-8 bytes. Default 262144. */
  batchMaxBytes?: number;
  /** Queue byte budget, UTF-8 bytes. Default 1048576. */
  queueMaxBytes?: number;
}

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
  /** Host admission and metering hooks (default: none, every request is admitted). */
  admission?: AdmissionHooks;
  /** Override the telemetry sink (default: no-op). Wins over `telemetryCollector`. */
  telemetry?: TelemetrySink;
  /** Export observations to a self-host collector. Ignored when `telemetry` is set. Default: off. */
  telemetryCollector?: NodeTelemetryCollectorOptions;
  /**
   * Explicit analytics destination: `none` (no export) or `collector`
   * (requires `telemetryCollector`, else startup fails). Any other value is
   * refused; there is no PostHog fallback. Unset: `telemetryCollector` alone
   * selects the collector.
   */
  telemetryDestination?: TelemetryDestination;
  /** Engine config (environment, version, workspace-stream default, etc.). Persist `workspaceBootstrapSecret` for replay across restarts. */
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
  /** Release timers + the database connection. Starts the telemetry drain (see `closeTelemetry`). */
  close(): void;
  /** Drain the built-in collector sink, bounded by its shutdown timeout; resolves at once without one. Idempotent. */
  closeTelemetry(): Promise<void>;
}

/**
 * Construct the in-process Node + SQLite runtime. Wires the realtime bus to the
 * presence tracker, opens (and optionally migrates) the database, and returns
 * everything `createEngine` and the entrypoint need.
 */
export function createNodeRuntime(options: NodeRuntimeOptions): NodeRuntime {
  const telemetry = createRuntimeTelemetry(options);
  let handle: SqliteDbHandle | undefined;
  try {
    const opened = getSqliteDb(options.dbPath);
    handle = opened;
    if (options.migrate !== false) runMigrations(opened);
    const runtime = assembleRuntime(opened.db, options, telemetry, () => {
      try { opened.sqlite.close(); } catch { /* already closed */ }
    });
    return { ...runtime, handle: opened };
  } catch (error) {
    try { handle?.sqlite.close(); } catch { /* already closed */ }
    void telemetry.closeTelemetry();
    throw error;
  }
}

function createRuntimeTelemetry(options: NodeRuntimeWithDbOptions) {
  const collectorOptions = resolveTelemetryDestination(options.telemetryDestination, options.telemetryCollector);
  const collector = !options.telemetry && collectorOptions
    ? new CollectorTelemetrySink({
        url: collectorOptions.url,
        bearerToken: collectorOptions.bearerToken,
        deployment: collectorOptions.deployment,
        // A deployment id equal to this pod's hostname is per-replica, not stable.
        replicaHostnames: [hostname(), process.env.HOSTNAME],
        queueMax: collectorOptions.queueMax,
        batchMax: collectorOptions.batchMax,
        flushIntervalMs: collectorOptions.flushIntervalMs,
        maxAttempts: collectorOptions.maxAttempts,
        backoffMs: collectorOptions.backoffMs,
        retryAfterMaxMs: collectorOptions.retryAfterMaxMs,
        requestTimeoutMs: collectorOptions.requestTimeoutMs,
        deliveryDeadlineMs: collectorOptions.deliveryDeadlineMs,
        shutdownTimeoutMs: collectorOptions.shutdownTimeoutMs,
        eventMaxBytes: collectorOptions.eventMaxBytes,
        batchMaxBytes: collectorOptions.batchMaxBytes,
        queueMaxBytes: collectorOptions.queueMaxBytes,
      })
    : undefined;
  let telemetryClosed: Promise<void> | undefined;
  const closeTelemetry = (): Promise<void> => {
    telemetryClosed ??= collector ? collector.close().catch(() => {}) : Promise.resolve();
    return telemetryClosed;
  };
  return { telemetry: safeTelemetrySink(options.telemetry ?? collector ?? new NoopTelemetrySink()), closeTelemetry };
}

/** Options for {@link createNodeRuntimeWithDb}: everything but opening the database. */
export type NodeRuntimeWithDbOptions = Omit<NodeRuntimeOptions, 'dbPath' | 'migrate'>;

/** {@link NodeRuntime} without the SQLite handle, for a runtime over an injected database. */
export type NodeRuntimeWithDb = Omit<NodeRuntime, 'handle'>;

/**
 * Assemble the in-process runtime over an opened, migrated and branded
 * engine database. The caller owns the database until assembly succeeds.
 * `closeDb` releases it on shutdown and must not throw.
 */
export function createNodeRuntimeWithDb(
  db: EngineDb,
  options: NodeRuntimeWithDbOptions,
  closeDb: () => void,
): NodeRuntimeWithDb {
  const telemetry = createRuntimeTelemetry(options);
  try {
    return assembleRuntime(db, options, telemetry, closeDb);
  } catch (error) {
    void telemetry.closeTelemetry();
    throw error;
  }
}

function assembleRuntime(
  db: EngineDb,
  options: NodeRuntimeWithDbOptions,
  { telemetry, closeTelemetry }: ReturnType<typeof createRuntimeTelemetry>,
  closeDb: () => void,
): NodeRuntimeWithDb {
  const testEnvironment = options.config?.environment === 'test';
  const testFetch: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init);
  const outboundWebhookFetch = options.config?.outboundWebhookFetch
    ?? (testEnvironment
      ? testFetch
      : createNodeOutboundWebhookFetch(options.config?.httpPushProxy?.url));
  const realtime = new InProcessRealtime(db);
  const upstreamOnPresenceEvent = options.presence?.onPresenceEvent;
  const presence = new InProcessPresence(realtime, {
    ...options.presence,
    db,
    onPresenceEvent: async (workspaceId, event) => {
      await upstreamOnPresenceEvent?.(workspaceId, event);
      const subjectAgentId = typeof event.subject_agent_id === 'string' ? event.subject_agent_id : null;
      const eventType = typeof event.type === 'string' ? event.type : null;
      if (!subjectAgentId || !eventType) return;
      // Fire-and-forget: presence broadcasts/offline sweeps await this handler,
      // so a slow or black-holed http_push receiver must not stall them. WS
      // context sends are in-memory; the http_push POST runs detached.
      void sendNodePresenceContext(
        {
          db,
          nodeConnections: realtime,
          realtime,
          workspaceId,
          environment: options.config?.environment,
          httpPushProxy: options.config?.httpPushProxy,
          ephemeralEventFetch: options.config?.ephemeralEventFetch ?? outboundWebhookFetch,
        },
        {
          subjectAgentId,
          event: eventType,
          data: {
            agent_id: subjectAgentId,
            agent_name: typeof event.agent_name === 'string' ? event.agent_name : subjectAgentId,
            status: event.status,
          },
        },
      ).catch(() => {});
    },
  });
  realtime.setPresenceTracker(presence);
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
    { ...options.eventQueue, fetch: options.eventQueue?.fetch ?? outboundWebhookFetch },
  );
  // Resume any deliveries left over from a previous process (the outbox's point).
  webhookQueue.start();

  const auth = options.auth ?? new SqliteApiKeyAuthProvider();

  // An explicit host-provided boundary is authoritative (the host may prune
  // outside this process). Otherwise report the same fallback the local Node
  // pruner uses; omitted/disabled message TTL is explicitly never-prune.
  const retentionOptions = options.eventQueue?.retention;
  const messageTtlDays = retentionOptions === false
    ? null
    : retentionOptions?.defaults?.messageTtlDays ?? null;
  const config: EngineConfig = {
    ...options.config,
    outboundWebhookFetch,
    retention: options.config?.retention ?? { messageTtlDays },
  };

  const deliveryWaiters = new InProcessDeliveryWaiters();
  const deps: EngineDeps = {
    db,
    realtime,
    connections: realtime,
    nodeConnections: realtime,
    presence,
    rateLimiter,
    deliveryWaiters,
    files: fileStorage,
    kv,
    webhookQueue,
    auth,
    admission: options.admission,
    telemetry,
    config,
  };

  realtime.setNodeCompletionDeps(deps);
  realtime.setAdmission(options.admission);

  const runDeliveryMaintenance = createDeliveryMaintenanceRunner(deps);

  let a2aRecoveryRunning = false;
  const sweepTimer = setInterval(() => {
    void sweepStaleAgents(db).catch(() => {});
    void sweepOfflineNodes(db, realtime, deps).catch(() => {});
    void sweepTimedOutInvocations(db, realtime, { completionDeps: deps }).catch(() => {});
    void reapExpiredWorkspaces(db, fileStorage).catch(() => {});
    void runDeliveryMaintenance();
    if (!a2aRecoveryRunning) {
      a2aRecoveryRunning = true;
      void sweepPendingA2aEgress(db).catch(() => {}).finally(() => { a2aRecoveryRunning = false; });
    }
  }, 15_000);
  (sweepTimer as { unref?: () => void }).unref?.();

  return {
    deps,
    realtime,
    presence,
    webhookQueue,
    fileHandler: createFileRouteHandler(fileStorage),
    close() {
      clearInterval(sweepTimer);
      // Parked long-polls answer now instead of holding their connections open.
      deliveryWaiters.close();
      presence.stop();
      webhookQueue.stop();
      kv.dispose();
      closeDb();
      void closeTelemetry();
    },
    closeTelemetry,
  };
}
