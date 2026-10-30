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
import { sweepStaleAgents } from '../../engine/agent.js';
import { sweepTimedOutInvocations } from '../../engine/action.js';
import { sweepPendingA2aEgress } from '../../engine/a2aEgress.js';
import { reapExpiredWorkspaces } from '../../engine/workspace.js';
import { createActorEngineDb, type ActorSql } from './database.js';
import { ActorCallScope, ActorReplayRequired, type ActorWriteGroupFailure } from './call-scope.js';
import { applyActorMigrations } from './migrations.js';
import { ActorKeyValueStore, ensureActorKvTable } from './kv.js';
import { ActorEventQueue } from './event-queue.js';
import { SignedUrlFileStorage } from './files.js';
import { isSafeExternalUrl } from '../../lib/ssrf.js';

export { ACTOR_FILE_ROUTE, SignedUrlFileStorage } from './files.js';
export { ActorKeyValueStore } from './kv.js';
export { ActorEventQueue } from './event-queue.js';
export { applyActorMigrations } from './migrations.js';
export { createActorEngineDb, execPositional, isReadStatement } from './database.js';
export type { ActorSql, ActorEngineDb, SqliteValue } from './database.js';
export {
  ActorCallScope,
  ActorReplayRequired,
  parseActorReplay,
  rehydrateError,
  serializeError,
} from './call-scope.js';
export type { ActorWriteGroupFailure, ActorSerializedError } from './call-scope.js';
export type { ActorHttpRequest, ActorHttpResponse } from './http.js';
import type { ActorHttpRequest, ActorHttpResponse } from './http.js';

/** How long the actor keeps its maintenance alarm armed after the last call. */
const ACTIVE_WINDOW_MS = 10 * 60_000;
/** Maintenance cadence while the workspace is active (the self-host sweep cadence). */
const MAINTENANCE_INTERVAL_MS = 15_000;

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
   * Outbound HTTP for webhooks and http_push nodes. Called only from
   * {@link ActorRuntime.maintain}, only for HTTPS URLs whose host is a public
   * name or global IP literal, and with redirects off. The host's transport
   * owns DNS-level SSRF protection (resolved-address checks).
   */
  outboundFetch: typeof globalThis.fetch;
  /**
   * The actor's alarm (`this.alarm`). The runtime arms it after calls and
   * when outbound work is queued, never pushing an earlier pending alarm back.
   */
  alarm: { get(): number | null; set(timestampMs: number): void };
  /** Engine config; `workspaceId` is set from the actor id. */
  config?: Omit<EngineConfig, 'workspaceId' | 'outboundWebhookFetch'>;
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
   * Run maintenance from the actor alarm: deliver the webhook outbox, redrive
   * node deliveries, A2A egress, liveness and presence sweeps, expiry and
   * retention. Re-arms the alarm while the workspace is active or outbound
   * work remains. Throws {@link ActorReplayRequired} when a maintenance write
   * group failed after writing, so the alarm call rolls back.
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
  let scope: ActorCallScope | undefined;
  let maintaining = false;
  let lastCallAt = 0;

  applyActorMigrations(sql);
  ensureActorKvTable(sql);

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
  // only from maintenance. In a request it fails fast; the engine records
  // the attempt as retryable, and maintenance redrives it.
  const outboundFetch: typeof globalThis.fetch = (input, init) => {
    if (!maintaining) {
      requestMaintenance();
      return Promise.reject(new ExternalIoOutsideMaintenance());
    }
    const url = input instanceof Request ? input.url : String(input);
    if (!isSafeExternalUrl(url, { strict: true, requireHttps: true })) {
      return Promise.reject(new Error('Outbound HTTP destination is not a public HTTPS URL'));
    }
    return options.outboundFetch(input, { ...init, redirect: 'manual' });
  };

  const telemetry = safeTelemetrySink(options.telemetry ?? new NoopTelemetrySink());
  const realtime = new InProcessRealtime(db);
  const presence = new InProcessPresence(realtime, { db, sweepIntervalMs: 0 });
  realtime.setPresenceTracker(presence);
  const kv = new ActorKeyValueStore(sql);
  const files = new SignedUrlFileStorage(options.baseUrl, options.fileSigningSecret);
  const webhookQueue = new ActorEventQueue(
    db,
    () => requestMaintenance(),
    (err, ctx) => telemetry.captureException(err, ctx),
    { fetch: outboundFetch },
  );

  const config: EngineConfig = {
    ...options.config,
    workspaceId: options.workspaceId,
    outboundWebhookFetch: outboundFetch,
    retention: options.config?.retention ?? { messageTtlDays: null },
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
        lastCallAt = Date.now();
        requestMaintenance(lastCallAt + MAINTENANCE_INTERVAL_MS);
        return { status: response.status, headers: [...response.headers], body };
      });
    },

    maintain() {
      return inScope([], async () => {
        maintaining = true;
        try {
          kv.prune();
          await presence.sweep().catch((err) => telemetry.captureException(err, { source: 'actor.maintenance', op: 'presence' }));
          const steps: [string, () => Promise<unknown>][] = [
            ['stale_agents', () => sweepStaleAgents(db)],
            ['offline_nodes', () => sweepOfflineNodes(db, realtime, deps)],
            ['invocations', () => sweepTimedOutInvocations(db, realtime, { completionDeps: deps })],
            ['workspace_expiry', () => reapExpiredWorkspaces(db, files)],
            ['deliveries', () => runDeliveryMaintenance()],
            ['a2a_egress', () => sweepPendingA2aEgress(db)],
            ['webhooks', () => webhookQueue.drain()],
          ];
          for (const [op, step] of steps) {
            await step().catch((err) => telemetry.captureException(err, { source: 'actor.maintenance', op }));
          }
        } finally {
          maintaining = false;
        }
        const pending = sql.exec(
          "SELECT 1 AS pending FROM pending_events WHERE status = 'pending' LIMIT 1",
        );
        if (pending.length > 0 || Date.now() - lastCallAt < ACTIVE_WINDOW_MS) {
          requestMaintenance(Date.now() + MAINTENANCE_INTERVAL_MS);
        }
      });
    },
  };
}
