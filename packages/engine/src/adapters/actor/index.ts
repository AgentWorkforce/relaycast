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
import { createActorEngineDb, type ActorDatabase, type ActorSql } from './database.js';
import { ActorCredentialTag } from './credential-tag.js';
import { fixedCredentialTagger } from '../../auth/credentialTags.js';
import { restrictToArCredentials } from '../../auth/credentials.js';
import { isArWorkspaceId } from '@relaycast/types';
import { applyActorMigrations } from './migrations.js';
import { ActorKeyValueStore, ensureActorKvTable } from './kv.js';
import { ActorEventQueue } from './event-queue.js';
import { SignedUrlFileStorage } from './files.js';
import { ActorEphemeralOutbox, ensureActorOutboundTable } from './ephemeral-outbox.js';
import { isSafeExternalUrl } from '../../lib/ssrf.js';

export type { ActorDatabase, ActorSql, SqliteValue } from './database.js';
export type { ActorHttpRequest, ActorHttpResponse } from './http.js';
import type { ActorHttpRequest, ActorHttpResponse } from './http.js';

/** Liveness sweeps for connected nodes run on the self-host sweep cadence. */
const MAINTENANCE_INTERVAL_MS = 15_000;
const DEFAULT_BLOB_DELETE_BUDGET_MS = 15_000;
/** Work already due is retried no sooner than this, so a stuck row cannot spin the alarm. */
const MIN_RETRY_MS = 5_000;

export interface ActorRuntimeOptions {
  /** The actor's database (`this.db`, durable-actors >= 0.14.5). */
  sql: ActorDatabase;
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
   * Total time one maintenance pass may spend deleting blobs through the
   * gateway; the rest wait for the next pass. Positive; default 15s.
   */
  blobDeleteBudgetMs?: number;
  /**
   * Engine config. The runtime sets `workspaceId` (the actor id),
   * `credentialFormat: 'ar'` with the tag the gateway handed {@link
   * ActorRuntime.create} (a gateway routes by credential), and the outbound
   * transports.
   */
  config?: Omit<EngineConfig, 'workspaceId' | 'credentialFormat' | 'credentialTagger' | 'outboundWebhookFetch' | 'ephemeralEventFetch'>;
  auth?: AuthProvider;
  telemetry?: TelemetrySink;
}

/** The engine running inside one workspace actor. */
export interface ActorRuntime {
  readonly deps: EngineDeps;
  /**
   * Serve one HTTP request inside an actor call. Engine background
   * work is awaited, so it commits with the call. Each engine write group is
   * a nested actor transaction: a failed group rolls back alone and the
   * request goes on, as on the Node adapter.
   */
  handle(request: ActorHttpRequest): Promise<ActorHttpResponse>;
  /**
   * Create this actor's workspace (`POST /v1/workspaces`) inside an actor
   * call. `credentialTag` is the routing tag the gateway signed for the
   * workspace id (`createCredentialTagSigner(keyring).tag(id)`); the actor
   * keeps it and every `ar_` credential it mints carries it.
   */
  create(request: ActorHttpRequest, credentialTag: string): Promise<ActorHttpResponse>;
  /**
   * Run maintenance from the actor alarm: deliver the webhook outbox and
   * queued ephemeral events, redrive node deliveries and A2A egress, delete
   * blobs, run liveness and presence sweeps, expiry and retention. Re-arms the
   * alarm for the nearest outstanding deadline (see {@link nextMaintenanceAt}).
   * Each step runs in its own nested transaction: a step or write group that
   * fails rolls back alone, raises a `maintenance_rolled_back` alert, and the
   * rest of the pass commits.
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
  if (!isActorSql(options.sql)) throw new Error('the relaycast actor adapter requires durable-actors >= 0.14.5');
  const sql = options.sql;
  const blobDeleteBudgetMs = positiveDuration('blobDeleteBudgetMs', options.blobDeleteBudgetMs, DEFAULT_BLOB_DELETE_BUDGET_MS, 1);
  // `ar_` credentials carry the workspace as a 64-bit snowflake.
  if (!isArWorkspaceId(options.workspaceId)) {
    throw new Error(`Workspace actor id ${JSON.stringify(options.workspaceId)} must be a 64-bit snowflake`);
  }
  let maintaining = false;
  // Write groups of the running maintenance step: how many opened, and the failures.
  let stepGroups = 0;
  let stepFailures: { index: number; error: unknown }[] = [];

  applyActorMigrations(sql);
  ensureActorKvTable(sql);
  ensureActorOutboundTable(sql);
  const credentialTag = new ActorCredentialTag(sql);

  const db = createActorEngineDb(sql, {
    onGroupStart: () => { stepGroups += 1; },
    onGroupFailure: (error) => { if (maintaining) stepFailures.push({ index: stepGroups - 1, error }); },
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
  const files = new SignedUrlFileStorage({
    baseUrl: options.baseUrl,
    secret: options.fileSigningSecret,
    fetch: maintenanceOnly(blobDeleteFetch),
    statFetch,
  });
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
    credentialFormat: 'ar',
    credentialTagger: fixedCredentialTagger(options.workspaceId, () => credentialTag.get()),
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
  // A workspace actor's deployment never issued legacy credentials.
  restrictToArCredentials(db);
  const app = createEngine(deps);
  const runDeliveryMaintenance = createDeliveryMaintenanceRunner(deps);

  const alert = (step: string, writeGroup: number | null, error: unknown): void => {
    telemetry.captureException(error, {
      source: 'actor.maintenance',
      alert: 'maintenance_rolled_back',
      workspace_id: options.workspaceId,
      step,
      write_group: writeGroup,
      error_code: errorCode(error),
    });
  };

  /** Run one maintenance step in its own transaction; a failure rolls back that step (or group) alone. */
  const runStep = async (step: string, work: () => Promise<unknown>): Promise<void> => {
    stepGroups = 0;
    stepFailures = [];
    try {
      await sql.transaction(work);
    } catch (error) {
      // A group whose error the step rethrew is the step's failure, reported once.
      const failed = stepFailures.find((failure) => failure.error === error);
      stepFailures = stepFailures.filter((failure) => failure !== failed);
      alert(step, failed?.index ?? null, error);
    }
    // Groups that rolled back while the step went on.
    for (const failure of stepFailures) alert(step, failure.index, failure.error);
  };

  return {
    deps,

    async create(request, tag) {
      const { pathname } = new URL(request.url);
      if (request.method !== 'POST' || pathname !== '/v1/workspaces') {
        throw new Error('create serves POST /v1/workspaces only');
      }
      credentialTag.set(tag);
      return this.handle(request);
    },

    async handle(request) {
      applyActorMigrations(sql);
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
    },

    async maintain() {
      applyActorMigrations(sql);
      maintaining = true;
      blobDeadline = Date.now() + blobDeleteBudgetMs;
      try {
        const steps: [string, () => Promise<unknown>][] = [
          ['kv_expiry', async () => kv.prune()],
          ['presence', () => presence.sweep()],
          ['stale_agents', () => sweepStaleAgents(db)],
          ['offline_nodes', () => sweepOfflineNodes(db, realtime, deps)],
          ['invocations', () => sweepTimedOutInvocations(db, realtime, { completionDeps: deps })],
          ['workspace_expiry', () => reapExpiredWorkspaces(db, files)],
          ['deliveries', () => runDeliveryMaintenance()],
          ['a2a_egress', () => sweepPendingA2aEgress(db, undefined, outboundFetch)],
          ['webhooks', () => webhookQueue.drain()],
          ['ephemeral_events', () => ephemeralOutbox.drain()],
        ];
        for (const [step, work] of steps) await runStep(step, work);
      } finally {
        maintaining = false;
      }
      const next = nextMaintenanceAt(sql);
      if (next !== null) requestMaintenance(next);
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

function isActorSql(db: ActorDatabase): db is ActorSql {
  return typeof (db as Partial<ActorSql> | undefined)?.query === 'function' && typeof db.transaction === 'function';
}

/** The first string `code` along an error's cause chain (drizzle wraps driver errors). */
function errorCode(error: unknown): string | null {
  const seen = new Set<unknown>();
  for (let link = error; link !== null && typeof link === 'object' && !seen.has(link); link = (link as { cause?: unknown }).cause) {
    seen.add(link);
    const code = (link as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return null;
}

function positiveDuration(name: string, value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`${name} must be a finite number of milliseconds, at least ${minimum}`);
  }
  return value;
}
