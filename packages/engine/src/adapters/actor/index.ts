import { createEngine } from '../../engine.js';
import { safeTelemetrySink } from '../../ports/telemetry.js';
import type { EngineConfig, EngineDeps } from '../../ports/index.js';
import type { AuthProvider } from '../../ports/auth.js';
import type { TelemetrySink } from '../../ports/telemetry.js';
import { SqliteApiKeyAuthProvider } from '../../auth/index.js';
import { NoopTelemetrySink } from '../../providers/noop-telemetry.js';
import { InProcessRealtime } from '../node/realtime.js';
import { InProcessPresence } from '../node/presence.js';
import { InProcessRateLimiter } from '../node/rate-limit.js';
import { createDeliveryMaintenanceRunner } from '../node/delivery-maintenance.js';
import { sweepOfflineNodes } from '../../engine/node.js';
import { AGENT_LIVENESS_TTL_MS, sweepStaleAgents } from '../../engine/agent.js';
import {
  ACTION_DISPATCH_TIMEOUT_MS,
  ACTION_HANDLER_UNREACHABLE_TTL_MS,
  PENDING_INVOCATION_MAX_AGE_MS,
  sweepTimedOutInvocations,
} from '../../engine/action.js';
import { A2A_EGRESS_RETRY_WINDOW_MS, sweepPendingA2aEgress } from '../../engine/a2aEgress.js';
import { reapExpiredWorkspaces } from '../../engine/workspace.js';
import { createActorEngineDb, type ActorSql } from './database.js';
import { ActorCallScope, ActorReplayRequired, type ActorWriteGroupFailure } from './call-scope.js';
import { applyActorMigrations } from './migrations.js';
import { ActorKeyValueStore, ensureActorKvTable } from './kv.js';
import { ActorEventQueue } from './event-queue.js';
import { SignedUrlFileStorage } from './files.js';
import { ActorEphemeralOutbox, ensureActorOutboundTable } from './ephemeral-outbox.js';
import { isSafeExternalUrl } from '../../lib/ssrf.js';

export type { ActorSql, SqliteValue } from './database.js';
export { ActorReplayRequired } from './call-scope.js';
export type { ActorWriteGroupFailure, ActorSerializedError } from './call-scope.js';
export type { ActorHttpRequest, ActorHttpResponse } from './http.js';
import type { ActorHttpRequest, ActorHttpResponse } from './http.js';

/** Liveness sweeps for connected nodes run on the self-host sweep cadence. */
const MAINTENANCE_INTERVAL_MS = 15_000;
const DEFAULT_BLOB_DELETE_BUDGET_MS = 15_000;
/** Wait before the next maintenance pass after one that rolled back. */
const DEFAULT_MAINTENANCE_RETRY_MS = 5 * 60_000;
/** Work already due is retried no sooner than this, so a stuck row cannot spin the alarm. */
const MIN_RETRY_MS = 5_000;

export interface ActorRuntimeOptions {
  /** The actor's database (`this.db`). */
  sql: ActorSql;
  /** The actor id, which is the workspace id. */
  workspaceId: string;
  /** Public origin clients reach this deployment on; file URLs point at its `/_relayfiles`. */
  baseUrl: string;
  /** HMAC secret shared with the gateway that serves `/_relayfiles`. */
  fileSigningSecret: string;
  /**
   * Outbound HTTP. Called only from {@link ActorRuntime.maintain}. Webhooks,
   * http_push nodes, ephemeral events and A2A egress reach it only for HTTPS
   * URLs whose host is a public name or global IP literal, with redirects off;
   * the host's transport owns DNS-level SSRF protection (resolved-address
   * checks). Blob deletes go to `baseUrl`.
   */
  outboundFetch: typeof globalThis.fetch;
  /**
   * The actor's alarm (`this.alarm`). The runtime arms it after calls and
   * when outbound work is queued, never pushing an earlier pending alarm back.
   */
  alarm: { get(): number | null; set(timestampMs: number): void };
  /**
   * When a maintenance pass rolls back, the next one runs this long after it
   * (a request can pull it earlier, to its own maintenance deadline). At
   * least 5 seconds; default 5 minutes.
   */
  maintenanceRetryMs?: number;
  /**
   * Total time one maintenance pass may spend deleting blobs through the
   * gateway; the rest wait for the next pass. Positive; default 15s.
   */
  blobDeleteBudgetMs?: number;
  /**
   * Engine config. The runtime sets `workspaceId` (the actor id),
   * `credentialFormat: 'self_routing'` (a gateway routes by credential) and
   * the outbound transports.
   */
  config?: Omit<EngineConfig, 'workspaceId' | 'credentialFormat' | 'outboundWebhookFetch' | 'ephemeralEventFetch'>;
  auth?: AuthProvider;
  telemetry?: TelemetrySink;
}

/** The engine running inside one workspace actor. */
export interface ActorRuntime {
  readonly deps: EngineDeps;
  /**
   * Serve one HTTP request inside an `@Atomic` actor call. Engine background
   * work is awaited, so it commits with the call. Throws
   * {@link ActorReplayRequired} when the call must roll back and run again
   * with the given failures (see `call-scope.ts`); the actor method must let
   * it propagate.
   */
  handle(request: ActorHttpRequest, replay: readonly ActorWriteGroupFailure[]): Promise<ActorHttpResponse>;
  /**
   * Run maintenance from the actor alarm: deliver the webhook outbox and
   * queued ephemeral events, redrive node deliveries and A2A egress, delete
   * blobs, run liveness and presence sweeps, expiry and retention. Re-arms the
   * alarm for the nearest outstanding deadline (see {@link nextMaintenanceAt}).
   * Throws {@link ActorReplayRequired} when a maintenance write group failed
   * after writing, so the alarm call rolls back.
   */
  maintain(): Promise<void>;
}

class ExternalIoOutsideMaintenance extends Error {
  constructor() {
    super('Outbound HTTP is deferred to actor maintenance');
    this.name = 'ExternalIoOutsideMaintenance';
  }
}

export function createActorRuntime(options: ActorRuntimeOptions): ActorRuntime {
  const { sql } = options;
  const blobDeleteBudgetMs = positiveDuration('blobDeleteBudgetMs', options.blobDeleteBudgetMs, DEFAULT_BLOB_DELETE_BUDGET_MS, 1);
  const maintenanceRetryMs = positiveDuration('maintenanceRetryMs', options.maintenanceRetryMs, DEFAULT_MAINTENANCE_RETRY_MS, MIN_RETRY_MS);
  // Self-routing credentials embed the workspace id between `_` separators.
  if (!/^[A-Za-z0-9]+$/.test(options.workspaceId)) {
    throw new Error(`Workspace actor id ${JSON.stringify(options.workspaceId)} must be alphanumeric`);
  }
  let scope: ActorCallScope | undefined;
  let maintaining = false;

  applyActorMigrations(sql);
  ensureActorKvTable(sql);
  ensureActorOutboundTable(sql);

  const db = createActorEngineDb(sql, {
    observer: { onWrite: () => scope?.onWrite() },
    runGroup: (body) => {
      if (!scope) throw new Error('Engine write group outside an actor call');
      return scope.runGroup(body);
    },
  });

  const requestMaintenance = (atMs: number = Date.now()): void => {
    const current = options.alarm.get();
    // A past timestamp is an alarm that already fired (or is firing now).
    if (current !== null && current > Date.now() && current <= atMs) return;
    options.alarm.set(atMs);
  };

  // Outbound HTTP holds the actor's mailbox for its whole duration, so it runs
  // only from maintenance. In a request it fails fast; durable work (webhook
  // outbox, http_push deliveries, A2A egress, blob cleanup) records a
  // retryable attempt, and maintenance redrives it.
  const maintenanceOnly = (fetchImpl: typeof globalThis.fetch): typeof globalThis.fetch => (input, init) => {
    if (!maintaining) {
      requestMaintenance();
      return Promise.reject(new ExternalIoOutsideMaintenance());
    }
    return fetchImpl(input, init);
  };
  const guardedFetch: typeof globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!isSafeExternalUrl(url, { strict: true, requireHttps: true })) {
      return Promise.reject(new Error('Outbound HTTP destination is not a public HTTPS URL'));
    }
    return options.outboundFetch(input, { ...init, redirect: 'manual' });
  };
  const outboundFetch = maintenanceOnly(guardedFetch);
  // Ephemeral events have no delivery row to retry from, so a request queues
  // them in the actor database (they commit or roll back with the call) and
  // maintenance sends them.
  const ephemeralOutbox = new ActorEphemeralOutbox(sql, guardedFetch);
  const ephemeralEventFetch: typeof globalThis.fetch = async (input, init) => {
    if (maintaining) return guardedFetch(input, init);
    await ephemeralOutbox.enqueue(new Request(input, init));
    requestMaintenance();
    return new Response(null, { status: 202 });
  };

  const telemetry = safeTelemetrySink(options.telemetry ?? new NoopTelemetrySink());
  const realtime = new InProcessRealtime(db);
  const presence = new InProcessPresence(realtime, { db, sweepIntervalMs: 0 });
  realtime.setPresenceTracker(presence);
  const kv = new ActorKeyValueStore(sql);
  // Blob deletes share one time budget per maintenance pass, so a gateway that
  // hangs can hold the mailbox for at most that long.
  let blobDeadline = 0;
  const blobDeleteFetch: typeof globalThis.fetch = (input, init) => {
    const remaining = blobDeadline - Date.now();
    if (remaining <= 0) return Promise.reject(new Error('Blob delete budget for this maintenance pass is spent'));
    const budget = AbortSignal.timeout(remaining);
    return options.outboundFetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, budget]) : budget });
  };
  // Completion's size check runs in the request: a short, bounded call to our
  // own gateway (not an outside destination).
  const statFetch: typeof globalThis.fetch = (input, init) => options.outboundFetch(input, init);
  const files = new SignedUrlFileStorage(options.baseUrl, options.fileSigningSecret, maintenanceOnly(blobDeleteFetch), statFetch);
  const messageTtlDays = options.config?.retention?.messageTtlDays ?? null;
  const webhookQueue = new ActorEventQueue(
    db,
    () => requestMaintenance(),
    (err, ctx) => telemetry.captureException(err, ctx),
    { fetch: outboundFetch, retention: { defaults: { messageTtlDays } } },
  );

  const config: EngineConfig = {
    ...options.config,
    workspaceId: options.workspaceId,
    credentialFormat: 'self_routing',
    outboundWebhookFetch: outboundFetch,
    ephemeralEventFetch,
    retention: { messageTtlDays },
  };

  const deps: EngineDeps = {
    db,
    realtime,
    connections: realtime,
    nodeConnections: realtime,
    presence,
    rateLimiter: new InProcessRateLimiter(),
    files,
    kv,
    webhookQueue,
    auth: options.auth ?? new SqliteApiKeyAuthProvider(),
    telemetry,
    config,
  };
  realtime.setNodeCompletionDeps(deps);
  const app = createEngine(deps);
  const runDeliveryMaintenance = createDeliveryMaintenanceRunner(deps);

  async function inScope<T>(replay: readonly ActorWriteGroupFailure[], work: () => Promise<T>): Promise<T> {
    if (scope) throw new Error('Actor calls do not overlap; a call is already running');
    applyActorMigrations(sql);
    const current = new ActorCallScope(replay);
    scope = current;
    try {
      const result = await work();
      if (current.mustRollBack) throw new ActorReplayRequired([...replay, ...current.failures]);
      return result;
    } finally {
      scope = undefined;
    }
  }

  return {
    deps,

    handle(request, replay) {
      return inScope(replay, async () => {
        const background: Promise<unknown>[] = [];
        const executionCtx = {
          waitUntil: (promise: Promise<unknown>) => { background.push(promise); },
          passThroughOnException() {},
          props: {},
        };
        const response = await app.fetch(
          new Request(request.url, {
            method: request.method,
            headers: request.headers,
            body: request.body,
          }),
          {},
          executionCtx,
        );
        const body = await response.text();
        // Background work can schedule more background work; settle all of it
        // so it commits (or rolls back) with this call.
        for (let settled = 0; settled < background.length; settled = background.length) {
          await Promise.allSettled(background.slice(settled));
        }
        const next = nextMaintenanceAt(sql);
        if (next !== null) requestMaintenance(next);
        return { status: response.status, headers: [...response.headers], body };
      });
    },

    async maintain() {
      let failedStep: string | undefined;
      let pass: ActorCallScope | undefined;
      try {
        await inScope([], async () => {
          pass = scope;
          maintaining = true;
          blobDeadline = Date.now() + blobDeleteBudgetMs;
          try {
            kv.prune();
            await presence.sweep().catch((err) => telemetry.captureException(err, { source: 'actor.maintenance', op: 'presence' }));
            const steps: [string, () => Promise<unknown>][] = [
              ['stale_agents', () => sweepStaleAgents(db)],
              ['offline_nodes', () => sweepOfflineNodes(db, realtime, deps)],
              ['invocations', () => sweepTimedOutInvocations(db, realtime, { completionDeps: deps })],
              ['workspace_expiry', () => reapExpiredWorkspaces(db, files)],
              ['deliveries', () => runDeliveryMaintenance()],
              ['a2a_egress', () => sweepPendingA2aEgress(db, undefined, outboundFetch)],
              ['webhooks', () => webhookQueue.drain()],
              ['ephemeral_events', () => ephemeralOutbox.drain()],
            ];
            for (const [op, step] of steps) {
              await step().catch((err) => telemetry.captureException(err, { source: 'actor.maintenance', op }));
              if (!failedStep && pass?.mustRollBack) failedStep = op;
            }
          } finally {
            maintaining = false;
          }
          const next = nextMaintenanceAt(sql);
          if (next !== null) requestMaintenance(next);
        });
      } catch (error) {
        // A rolled-back pass has no caller to replay it (an alarm has no
        // outside caller), so it alerts and runs again after a fixed interval.
        // The alarm is the one thing the rollback keeps. A runtime savepoint
        // (TerseAI/durable-actors#370) removes this case.
        const failure = error instanceof ActorReplayRequired ? error.failures.at(-1) : undefined;
        telemetry.captureException(error, {
          source: 'actor.maintenance',
          alert: 'maintenance_rolled_back',
          workspace_id: options.workspaceId,
          step: failedStep ?? null,
          write_group: failure?.index ?? null,
          error_code: maintenanceErrorCode(failure, error),
        });
        options.alarm.set(Date.now() + maintenanceRetryMs);
        throw error;
      }
    },
  };
}

/**
 * When maintenance next has something to do, from the workspace's own
 * outstanding work: the nearest due time of the webhook outbox, unfinished
 * deliveries (redrive and expiry), A2A egress, the invocation timeouts the
 * invocation sweep acts on, including task deadlines (a plain queue waiting
 * for its node to reconnect has none: the reconnect is a request, which
 * re-arms), agent
 * liveness, blob cleanup, workspace expiry, idempotency-record expiry, A2A
 * retention, and queued ephemeral events, and
 * the sweep cadence while nodes are connected. `null` when nothing is
 * outstanding, so an idle workspace's actor goes dormant.
 */
export function nextMaintenanceAt(sql: ActorSql): number | null {
  const [row] = sql.exec(
    `SELECT MIN(due) AS due FROM (
      SELECT MIN(process_after) AS due FROM pending_events WHERE status = 'pending'
      UNION ALL SELECT MIN(next_attempt_at) FROM deliveries WHERE status NOT IN ('acked', 'dead_lettered', 'failed')
      UNION ALL SELECT MIN(expires_at) FROM deliveries WHERE status NOT IN ('acked', 'dead_lettered', 'failed')
      UNION ALL SELECT MIN(COALESCE(lease_until, 0)) FROM a2a_egress WHERE status IN ('pending', 'sending')
      UNION ALL SELECT MIN(dispatched_at + ?) FROM action_invocations WHERE status = 'dispatched'
      UNION ALL SELECT MIN(retry_after_at) FROM action_invocations WHERE status = 'pending'
      UNION ALL SELECT MIN(created_at + ?) FROM action_invocations WHERE status = 'pending' AND dispatch_attempts = 0
      UNION ALL SELECT MIN(handler_unreachable_since + ?) FROM action_invocations WHERE status IN ('pending', 'dispatched')
      UNION ALL SELECT MIN(unixepoch(json_extract(task_state, '$.deadline'))) FROM action_invocations
        WHERE task_state IS NOT NULL AND status IN ('pending', 'dispatched', 'running')
      UNION ALL SELECT MIN(last_seen + ?) FROM agents WHERE status IN ('active', 'online')
      UNION ALL SELECT MIN(unixepoch() + ?) FROM nodes WHERE status != 'offline'
      UNION ALL SELECT MIN(process_after) FROM file_cleanup_queue
      UNION ALL SELECT MIN(expires_at) FROM workspaces
      UNION ALL SELECT MIN(expires_at) / 1000 FROM _actor_kv
      UNION ALL SELECT MIN(created_at + ?) FROM a2a_egress WHERE status NOT IN ('pending', 'sending')
      UNION ALL SELECT MIN(created_at + ?) FROM a2a_inbound
      UNION ALL SELECT MIN(created_at + ?) FROM direct_dm_idempotency
      UNION ALL SELECT MIN(0) FROM _actor_outbound
    )`,
    Math.ceil(ACTION_DISPATCH_TIMEOUT_MS / 1000),
    Math.ceil(PENDING_INVOCATION_MAX_AGE_MS / 1000),
    Math.ceil(ACTION_HANDLER_UNREACHABLE_TTL_MS / 1000),
    Math.ceil(AGENT_LIVENESS_TTL_MS / 1000),
    Math.ceil(MAINTENANCE_INTERVAL_MS / 1000),
    Math.ceil(A2A_EGRESS_RETRY_WINDOW_MS / 1000),
    Math.ceil(A2A_EGRESS_RETRY_WINDOW_MS / 1000),
    Math.ceil(A2A_EGRESS_RETRY_WINDOW_MS / 1000),
  ) as { due: number | bigint | null }[];
  if (row?.due === null || row?.due === undefined) return null;
  return Math.max(Number(row.due) * 1000, Date.now() + MIN_RETRY_MS);
}

/** The most specific code of a maintenance failure: the failing group's error chain, else the thrown error. */
function maintenanceErrorCode(failure: ActorWriteGroupFailure | undefined, error: unknown): string | null {
  for (const link of failure?.error ?? []) {
    const code = (JSON.parse(link.fields) as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

function positiveDuration(name: string, value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`${name} must be a finite number of milliseconds, at least ${minimum}`);
  }
  return value;
}
