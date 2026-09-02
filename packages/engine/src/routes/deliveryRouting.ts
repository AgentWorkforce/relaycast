import type { Context } from 'hono';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { AppEnv, EngineRuntime } from '../env.js';
import * as deliveryEngine from '../engine/delivery.js';
import { buildDeliverFrame, buildDeliverPayload } from '../engine/deliveryWire.js';
import type {
  DeliveryFanoutRecord,
  DeliveryRejectionRecord,
} from '../engine/deliveryWrites.js';
import { agents, agentNodeBindings, deliveries as deliveryRows, nodes } from '../db/schema.js';
import { buildHttpPushHeaders, resolveHttpPushProxy } from '../engine/httpPushDispatch.js';
import { isSafeExternalUrl } from '../lib/ssrf.js';
import { isProviderAgentDeliveryReady, type EngineDb, type EngineDeps } from '../ports/index.js';
import { fanoutToAgents } from './fanout.js';
import { publishEvent, publishEventsToAgents } from '../engine/eventDispatch.js';
type HonoContext = Context<AppEnv>;
type RoutingEngine = EngineRuntime | EngineDeps;
type RoutingContext = {
  db: EngineDb;
  workspaceId: string;
  engine: RoutingEngine;
};

type DeliveryTarget = {
  locationType: string;
  locationNodeId: string | null;
  nodeKind: string | null;
  nodeRole: string | null;
  deliveryAdapter: string | null;
  deliveryConfig: Record<string, unknown> | null;
  providerName?: string;
};

const DISPATCH_RETRY_DELAY_MS = 30_000;
// Fifty 50-row statements expire at most 2,500 deliveries per invocation.
// On a */5 schedule that is 720,000/day: above the measured 519,000/day peak
// while each UPDATE remains well below D1's 100-bound-parameter ceiling.
export const DELIVERY_EXPIRY_MAX_BATCHES = 50;

function routingContextFromHono(c: HonoContext, workspaceIdOverride?: string): RoutingContext {
  const workspaceId = workspaceIdOverride ?? c.get('workspace')?.id;
  if (!workspaceId) {
    throw new Error('Delivery routing requires workspace context');
  }
  return {
    db: c.get('db'),
    workspaceId,
    engine: c.get('engine'),
  };
}

function wireMode(mode: string): 'wait' | 'steer' {
  return mode === 'next-tool-call' ? 'steer' : 'wait';
}

/** Outside tests, node delivery URLs must pass the SSRF-safe external URL check. */
function strictExternalUrl(engine: RoutingEngine): boolean {
  return engine.config?.environment !== 'test';
}

/** Dispatch an agent-scoped routing event (stream + node context) for `agentIds`. */
async function fanoutToAgentsForContext(
  ctx: RoutingContext,
  agentIds: string[],
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  await publishEvent(
    { db: ctx.db, engine: ctx.engine },
    { workspaceId: ctx.workspaceId, type, data, scope: { kind: 'agents', agentIds } },
  );
}

async function resolveLiveLocations(
  ctx: RoutingContext,
  deliveries: DeliveryFanoutRecord[],
): Promise<Map<string, DeliveryTarget>> {
  const uniqueAgentIds = [...new Set(deliveries.map((delivery) => delivery.agentId))];
  if (uniqueAgentIds.length === 0) return new Map();

  const bindings = await ctx.db
    .select({
      agentId: agentNodeBindings.agentId,
      nodeId: agentNodeBindings.nodeId,
      nodeKind: nodes.kind,
      nodeRole: nodes.role,
      deliveryAdapter: nodes.deliveryAdapter,
      deliveryConfig: nodes.deliveryConfig,
      providerName: agents.providerName,
    })
    .from(agentNodeBindings)
    .innerJoin(agents, and(
      eq(agentNodeBindings.agentId, agents.id),
      eq(agents.locationType, 'via_node'),
      eq(agents.locationNodeId, agentNodeBindings.nodeId),
    ))
    .innerJoin(nodes, eq(agentNodeBindings.nodeId, nodes.id))
    .where(and(
      eq(agentNodeBindings.workspaceId, ctx.workspaceId),
      eq(agentNodeBindings.status, 'active'),
      inArray(agentNodeBindings.agentId, uniqueAgentIds),
    ))
    .orderBy(sql`${agentNodeBindings.priority} DESC`, agentNodeBindings.createdAt);

  const byAgent = new Map<string, DeliveryTarget>();
  for (const binding of bindings) {
    if (byAgent.has(binding.agentId)) continue;
    byAgent.set(binding.agentId, {
      locationType: 'via_node',
      locationNodeId: binding.nodeId,
      nodeKind: binding.nodeKind,
      nodeRole: binding.nodeRole,
      deliveryAdapter: binding.deliveryAdapter,
      deliveryConfig: binding.deliveryConfig as Record<string, unknown> | null,
      providerName: binding.providerName,
    });
  }

  const fallbackRows = await ctx.db
    .select({
      id: agents.id,
      locationType: agents.locationType,
      locationNodeId: agents.locationNodeId,
      nodeKind: nodes.kind,
      nodeRole: nodes.role,
      deliveryAdapter: nodes.deliveryAdapter,
      deliveryConfig: nodes.deliveryConfig,
      providerName: agents.providerName,
    })
    .from(agents)
    .leftJoin(nodes, eq(agents.locationNodeId, nodes.id))
    .where(and(eq(agents.workspaceId, ctx.workspaceId), inArray(agents.id, uniqueAgentIds)));

  for (const row of fallbackRows) {
    if (byAgent.has(row.id)) continue;
    byAgent.set(row.id, {
      locationType: row.locationType,
      locationNodeId: row.locationNodeId,
      nodeKind: row.nodeKind ?? (row.locationNodeId ? 'ws' : null),
      nodeRole: row.nodeRole ?? (row.locationNodeId ? 'broker' : null),
      deliveryAdapter: row.deliveryAdapter ?? (row.locationNodeId ? 'ws.node.v1' : null),
      deliveryConfig: row.deliveryConfig as Record<string, unknown> | null,
      providerName: row.providerName,
    });
  }

  return byAgent;
}

async function resolveRecordedTargets(
  ctx: RoutingContext,
  deliveries: DeliveryFanoutRecord[],
): Promise<Map<string, DeliveryTarget>> {
  const routeNodeIds = [...new Set(deliveries.flatMap((delivery) => (
    delivery.routeNodeId ? [delivery.routeNodeId] : []
  )))];
  const nodesById = new Map<string, typeof nodes.$inferSelect>();
  if (routeNodeIds.length > 0) {
    const rows = await ctx.db
      .select()
      .from(nodes)
      .where(and(
        eq(nodes.workspaceId, ctx.workspaceId),
        inArray(nodes.id, routeNodeIds),
      ));
    for (const row of rows) {
      nodesById.set(row.id, row);
    }
  }

  const byDelivery = new Map<string, DeliveryTarget>();
  for (const delivery of deliveries) {
    if (!delivery.routeNodeId) continue;
    const node = nodesById.get(delivery.routeNodeId);
    byDelivery.set(delivery.id, {
      locationType: 'via_node',
      locationNodeId: delivery.routeNodeId,
      nodeKind: delivery.routeNodeKind ?? node?.kind ?? null,
      nodeRole: delivery.routeNodeRole ?? node?.role ?? null,
      deliveryAdapter: delivery.deliveryAdapter ?? node?.deliveryAdapter ?? null,
      deliveryConfig: (node?.deliveryConfig as Record<string, unknown> | null | undefined) ?? null,
    });
  }
  return byDelivery;
}

function normalizeDeliveryAdapter(adapter: string | null | undefined, nodeKind: string | null | undefined): string | null {
  if (adapter === 'fleet.ws.v1' || adapter === 'direct.ws.v1') return 'ws.node.v1';
  if (adapter) return adapter;
  if (nodeKind === 'ws' || nodeKind === 'fleet_ws' || nodeKind === 'direct_ws') return 'ws.node.v1';
  if (nodeKind === 'http_push') return 'http.basic.v1';
  return null;
}

async function recordDispatchRetry(
  ctx: RoutingContext,
  deliveryId: string,
  error: string,
  opts: { incrementAttempts?: boolean } = {},
): Promise<void> {
  await ctx.db
    .update(deliveryRows)
    .set({
      ...(opts.incrementAttempts ? { dispatchAttempts: sql`coalesce(${deliveryRows.dispatchAttempts}, 0) + 1` } : {}),
      lastDispatchError: error,
      nextAttemptAt: new Date(Date.now() + DISPATCH_RETRY_DELAY_MS),
      updatedAt: new Date(),
    })
    .where(and(
      eq(deliveryRows.workspaceId, ctx.workspaceId),
      eq(deliveryRows.id, deliveryId),
      eq(deliveryRows.status, 'queued'),
    ));
}

async function dispatchHttpPush(args: {
  ctx: RoutingContext;
  delivery: DeliveryFanoutRecord;
  target: DeliveryTarget;
  eventType: string;
  eventData: Record<string, unknown>;
}): Promise<'delivered' | 'acked' | 'failed'> {
  const config = args.target.deliveryConfig ?? {};
  const url = typeof config.url === 'string' ? config.url : null;
  if (!url) {
    await recordDispatchRetry(args.ctx, args.delivery.id, 'invalid http_push delivery config: missing url', { incrementAttempts: true });
    return 'failed';
  }
  if (!isSafeExternalUrl(url, { strict: strictExternalUrl(args.ctx.engine) })) {
    await recordDispatchRetry(args.ctx, args.delivery.id, 'unsafe http_push delivery url', { incrementAttempts: true });
    return 'failed';
  }

  // Optional egress proxy: when the node opts in with `use_proxy`, route the POST
  // through the deployment-configured forwarder instead of the destination
  // directly (real target rides in X-Forward-To). Used to reach receivers that
  // block the engine's own network origin (e.g. a webhook behind Cloudflare bot
  // rules that reject Cloudflare Workers). The real `url` is still SSRF-checked
  // above; the proxy requires both a url and a secret.
  const proxied = resolveHttpPushProxy(url, config, args.ctx.engine.config?.httpPushProxy);
  if (!proxied.ok) {
    await recordDispatchRetry(args.ctx, args.delivery.id, proxied.reason, { incrementAttempts: true });
    return 'failed';
  }
  const requestUrl = proxied.requestUrl;
  const proxyHeaders = proxied.proxyHeaders;

  const ackMode = config.ack_mode === 'on_2xx' || config.ack_mode === 'response'
    ? config.ack_mode
    : 'manual';
  const timestamp = new Date().toISOString();
  const body = JSON.stringify({
    type: args.eventType,
    workspace_id: args.ctx.workspaceId,
    delivery_id: args.delivery.id,
    message_id: args.delivery.messageId,
    agent_id: args.delivery.agentId,
    agent_name: args.delivery.agentName,
    seq: args.delivery.seq,
    mode: wireMode(args.delivery.mode),
    timestamp,
    data: args.eventData,
  });

  try {
    const claimConditions = [
      eq(deliveryRows.workspaceId, args.ctx.workspaceId),
      eq(deliveryRows.id, args.delivery.id),
      eq(deliveryRows.status, 'queued'),
    ];
    if (args.delivery.nextAttemptAt) {
      claimConditions.push(eq(deliveryRows.nextAttemptAt, args.delivery.nextAttemptAt));
    } else {
      // Never-attempted rows (nextAttemptAt IS NULL) are now selectable by the
      // sweep. status stays 'queued' across the async fetch below, so without a
      // compare-and-swap token on nextAttemptAt two concurrent dispatchers
      // (inline vs cron, or two overlapping sweeps) could both match and
      // double-POST the webhook. Claiming on `nextAttemptAt IS NULL` makes this
      // atomic: the first claim stamps a non-null retry time, so the second no
      // longer matches and bails.
      claimConditions.push(isNull(deliveryRows.nextAttemptAt));
    }

    const started = await args.ctx.db
      .update(deliveryRows)
      .set({
        dispatchAttempts: sql`coalesce(${deliveryRows.dispatchAttempts}, 0) + 1`,
        lastDispatchError: null,
        nextAttemptAt: new Date(Date.now() + DISPATCH_RETRY_DELAY_MS),
        updatedAt: new Date(),
      })
      .where(and(...claimConditions))
      .returning({ id: deliveryRows.id });
    if (started.length === 0) return 'failed';

    // Build headers inside the claim/retry boundary so a signing failure is
    // recorded as a retryable dispatch error rather than rejecting uncaught.
    const headers = { ...(await buildHttpPushHeaders(config, args.eventType, args.delivery.id, body, timestamp)), ...proxyHeaders };
    const response = await globalThis.fetch(requestUrl, {
      method: 'POST',
      headers,
      body,
      // Do NOT follow redirects: a 3xx could point `url` at an internal address
      // and bypass the SSRF check above. Cloudflare Workers rejects
      // `redirect: 'error'` outright ("won't be implemented at the edge"), which
      // would throw on every dispatch and strand every http_push delivery — so
      // use 'manual' and reject any redirect ourselves below.
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });

    // `redirect: 'manual'` surfaces a redirect as a 3xx status (or an
    // opaqueredirect response with status 0); treat both as a hard failure.
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      await recordDispatchRetry(args.ctx, args.delivery.id, `redirect not allowed (HTTP ${response.status})`);
      return 'failed';
    }

    if (!response.ok) {
      await recordDispatchRetry(args.ctx, args.delivery.id, `HTTP ${response.status}`);
      return 'failed';
    }

    if (ackMode === 'on_2xx') {
      const acked = await deliveryEngine.ackDelivery(
        args.ctx.db,
        args.ctx.workspaceId,
        args.delivery.agentId,
        args.delivery.id,
      );
      if (acked?.changed) {
        await fanoutToAgentsForContext(args.ctx, [args.delivery.agentId], 'delivery.delivered', {
          delivery_id: args.delivery.id,
          message_id: args.delivery.messageId,
        });
      }
      return 'acked';
    }

    if (ackMode === 'response') {
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        const responseBody = await response.json().catch(() => null) as { ack?: unknown; delivery_status?: unknown } | null;
        if (responseBody?.ack === true || responseBody?.delivery_status === 'acked') {
          const acked = await deliveryEngine.ackDelivery(
            args.ctx.db,
            args.ctx.workspaceId,
            args.delivery.agentId,
            args.delivery.id,
          );
          if (acked?.changed) {
            await fanoutToAgentsForContext(args.ctx, [args.delivery.agentId], 'delivery.delivered', {
              delivery_id: args.delivery.id,
              message_id: args.delivery.messageId,
            });
          }
          return 'acked';
        }
      }
      await recordDispatchRetry(args.ctx, args.delivery.id, 'response ack not signaled');
      return 'failed';
    }

    return 'delivered';
  } catch (err) {
    await recordDispatchRetry(args.ctx, args.delivery.id, err instanceof Error ? err.message : 'HTTP delivery failed');
    return 'failed';
  }
}

/**
 * Result of routing a single delivery row.
 * - `delivered`: the row was sent and marked delivered.
 * - `deferred`: the row stayed queued and was stamped for a later retry (a
 *   readiness skip or a failed live send). An ordered ws redrive stops its
 *   agent's backlog here so a later seq never outruns this one.
 * - `noop`: no realtime target remained (legacy/unbound row); nothing to do.
 */
type DeliveryDispatchOutcome = 'delivered' | 'deferred' | 'noop';

async function routeOneDeliveryOutcome(
  ctx: RoutingContext,
  liveLocations: Map<string, DeliveryTarget>,
  recordedTargets: Map<string, DeliveryTarget>,
  delivery: DeliveryFanoutRecord,
  eventType: string,
  eventData: Record<string, unknown>,
): Promise<DeliveryDispatchOutcome> {
  const recordedTarget = recordedTargets.get(delivery.id);
  const liveLocation = liveLocations.get(delivery.agentId);
  const target = recordedTarget ?? liveLocation;
  const locationType = target?.locationType ?? delivery.locationType;
  const locationNodeId = target?.locationNodeId ?? delivery.locationNodeId;
  const nodeKind = target?.nodeKind ?? (locationNodeId ? 'ws' : null);
  const deliveryAdapter = normalizeDeliveryAdapter(target?.deliveryAdapter ?? delivery.deliveryAdapter, nodeKind);

  if (locationType === 'via_node' && locationNodeId && deliveryAdapter === 'ws.node.v1') {
    const providerName = liveLocation?.providerName ?? recordedTarget?.providerName ?? 'default';
    if (!isProviderAgentDeliveryReady(
      ctx.engine.nodeConnections,
      ctx.workspaceId,
      locationNodeId,
      providerName,
      delivery.agentId,
    )) {
      // The provider connection has not marked this identity delivery-ready
      // (cursor negotiation pending). Leave the row queued but stamp it so the
      // skip is observable and a later sweep retries it, instead of the row
      // silently sitting until its mailbox TTL dead-letters it. This is a skip,
      // not a dispatch attempt, so dispatch_attempts is not incremented.
      await recordDispatchRetry(ctx, delivery.id, 'provider connection not delivery-ready for agent');
      console.warn('[delivery.route] provider not delivery-ready; delivery deferred', {
        workspace_id: ctx.workspaceId,
        node_id: locationNodeId,
        provider_name: providerName,
        agent_id: delivery.agentId,
        delivery_id: delivery.id,
      });
      return 'deferred';
    }
    const sent = await ctx.engine.nodeConnections.sendToProvider(ctx.workspaceId, locationNodeId, providerName, buildDeliverFrame({
      delivery_id: delivery.id,
      agent_id: delivery.agentId,
      agent: delivery.agentName,
      msg_id: delivery.messageId,
      seq: delivery.seq,
      mode: wireMode(delivery.mode),
      payload: buildDeliverPayload(eventType, eventData),
    }));
    if (sent) {
      await deliveryEngine.markDeliveriesDelivered(ctx.db, ctx.workspaceId, [delivery.id]);
      return 'delivered';
    }
    // The provider was delivery-ready but the live send did not land (no open
    // socket, the provider detached mid-send, or `socket.send` threw). Leave the
    // row queued but stamp it so the periodic node sweep re-attempts with ~30s
    // spacing, instead of the row sitting silently until its mailbox TTL
    // dead-letters it. Unlike the readiness skip above this is a real dispatch
    // attempt, so it counts toward dispatch_attempts.
    await recordDispatchRetry(ctx, delivery.id, 'node socket send failed', { incrementAttempts: true });
    console.warn('[delivery.route] node send failed; delivery deferred', {
      workspace_id: ctx.workspaceId,
      node_id: locationNodeId,
      provider_name: providerName,
      agent_id: delivery.agentId,
      delivery_id: delivery.id,
    });
    return 'deferred';
  }

  if (locationType === 'via_node' && locationNodeId && nodeKind === 'http_push' && target) {
    const result = await dispatchHttpPush({ ctx, delivery, target, eventType, eventData });
    if (result === 'delivered') {
      await deliveryEngine.markDeliveriesDelivered(ctx.db, ctx.workspaceId, [delivery.id]);
      return 'delivered';
    }
    return 'deferred';
  }

  // No agent-owned realtime socket exists anymore. If a legacy/unbound row
  // reaches this point, leave it queued so a later node binding/replay can
  // deliver it instead of falsely marking it delivered.
  return 'noop';
}

async function routeDeliveryOutcomesForContext(
  ctx: RoutingContext,
  deliveries: DeliveryFanoutRecord[],
  eventType: string,
  eventData: Record<string, unknown>,
): Promise<void> {
  if (deliveries.length === 0) return;

  const liveLocations = await resolveLiveLocations(ctx, deliveries);
  const recordedTargets = await resolveRecordedTargets(ctx, deliveries);
  await Promise.allSettled(deliveries.map((delivery) => (
    routeOneDeliveryOutcome(ctx, liveLocations, recordedTargets, delivery, eventType, eventData)
  )));
}

export async function routeDeliveryOutcomes(
  c: HonoContext,
  deliveries: DeliveryFanoutRecord[],
  eventType: string,
  eventData: Record<string, unknown>,
  opts: { workspaceId?: string } = {},
): Promise<void> {
  await routeDeliveryOutcomesForContext(routingContextFromHono(c, opts.workspaceId), deliveries, eventType, eventData);
}

/**
 * Redrive a single ws-node agent's queued backlog in ascending `seq` order,
 * serially, stopping at the first row that does not deliver.
 *
 * A `ws.node.v1` deliver frame whose `seq != received_up_to_seq + 1` is treated
 * by the broker as a Gap and is NOT injected (it waits for the missing earlier
 * seq), while the engine's `sendToProvider` returns `true` on a successful
 * socket write — so a naive concurrent/unordered redrive can mark a higher seq
 * "delivered" while the broker silently held it, stranding the row until
 * reconnect replay or the mailbox TTL. To avoid that we always redrive from the
 * agent's LOWEST queued seq regardless of the individual row's `next_attempt_at`
 * due-ness (matching {@link deliverPendingToNode}'s replay ordering): once ANY
 * of the agent's rows is due, the whole queued backlog is re-attempted in order.
 * The moment a row cannot be delivered (readiness skip or failed send —
 * `routeOneDeliveryOutcome` has already stamped it for the next retry) we stop,
 * so a later seq can never outrun an earlier undelivered one.
 */
async function redriveWsBacklogForAgent(
  ctx: RoutingContext,
  agentId: string,
  now: Date,
): Promise<void> {
  const backlog = await deliveryEngine.fetchQueuedWsBacklogEvents(ctx.db, ctx.workspaceId, agentId, { now });
  if (backlog.length === 0) return;

  const backlogDeliveries = backlog.map((event) => event.delivery);
  const liveLocations = await resolveLiveLocations(ctx, backlogDeliveries);
  const recordedTargets = await resolveRecordedTargets(ctx, backlogDeliveries);

  for (const event of backlog) {
    const outcome = await routeOneDeliveryOutcome(
      ctx,
      liveLocations,
      recordedTargets,
      event.delivery,
      event.eventType,
      event.eventData,
    );
    if (outcome !== 'delivered') break;
  }
}

/**
 * Periodic redrive for queued node deliveries whose `next_attempt_at` is due (or
 * was never stamped). Covers http_push rows (their agent never connects to pull)
 * and ws-node rows whose single background dispatch was lost or failed.
 *
 * http_push rows are independent single-shot webhooks with no ordering
 * relationship, so they are dispatched concurrently per row (each re-routed
 * through {@link routeOneDeliveryOutcome}). ws-node rows for the same agent form
 * a monotonic `seq` stream that the broker injects in order, so they are grouped
 * per agent and redriven serially in ascending seq (see
 * {@link redriveWsBacklogForAgent}); different agents (and different nodes) are
 * still processed concurrently. Returns the number of due rows the sweep found.
 */
export async function sweepDueNodeDeliveries(
  engine: EngineDeps,
  opts: { workspaceId?: string; now?: Date; limit?: number } = {},
): Promise<number> {
  const now = opts.now ?? new Date();
  const due = await deliveryEngine.fetchDueNodeDeliveryEvents(engine.db, { ...opts, now });

  const httpPushEvents: typeof due = [];
  const wsAgents: { workspaceId: string; agentId: string }[] = [];
  const seenWsAgents = new Set<string>();
  for (const event of due) {
    if (event.delivery.routeNodeKind === 'http_push') {
      httpPushEvents.push(event);
      continue;
    }
    // Collision-safe key: workspace and agent ids are free-form, so encode the
    // tuple rather than joining on a separator (matches groupByNodeProvider).
    const key = JSON.stringify([event.workspaceId, event.delivery.agentId]);
    if (seenWsAgents.has(key)) continue;
    seenWsAgents.add(key);
    wsAgents.push({ workspaceId: event.workspaceId, agentId: event.delivery.agentId });
  }

  await Promise.allSettled([
    ...httpPushEvents.map((event) => (
      routeDeliveryOutcomesForContext(
        { db: engine.db, workspaceId: event.workspaceId, engine },
        [event.delivery],
        event.eventType,
        event.eventData,
      )
    )),
    ...wsAgents.map((agent) => (
      redriveWsBacklogForAgent(
        { db: engine.db, workspaceId: agent.workspaceId, engine },
        agent.agentId,
        now,
      )
    )),
  ]);
  return due.length;
}

/**
 * @deprecated Renamed to {@link sweepDueNodeDeliveries}, which also sweeps queued
 * ws-node rows. Kept as a thin alias because relaycast-cloud's cron imports this
 * name; delete once that host migrates.
 */
export const sweepDueHttpPushDeliveries = sweepDueNodeDeliveries;

/** Dispatch one `delivery.failed` event per undeliverable notice as a single bounded batch. */
async function notifyDeliveryFailures(
  engine: EngineDeps,
  notices: deliveryEngine.DeliveryFailureNotice[],
): Promise<void> {
  if (notices.length === 0) return;
  const notifications = notices.map((notice) => ({
    workspaceId: notice.workspace_id,
    agentId: notice.sender_agent_id,
    data: {
      delivery_id: notice.delivery_id,
      message_id: notice.message_id,
      target_agent_id: notice.target_agent_id,
      target_agent_name: notice.target_agent_name,
      seq: notice.seq,
      reason: notice.reason,
      error: notice.error,
      retryable: notice.retryable,
    },
  }));
  await publishEventsToAgents(
    { db: engine.db, engine },
    notifications.map((notification) => ({
      workspaceId: notification.workspaceId,
      agentId: notification.agentId,
      type: 'delivery.failed',
      data: notification.data,
    })),
  );
}

/**
 * Scheduled TTL expiry maintenance. One invocation advances through a bounded
 * number of small D1-safe statements, then batches the best-effort failure
 * fanout so increasing the drain rate does not multiply D1 reads per notice.
 */
export async function sweepExpiredDeliveries(
  engine: EngineDeps,
  opts: { workspaceId?: string; now?: Date; maxBatches?: number } = {},
): Promise<number> {
  const now = opts.now ?? new Date();
  const requestedMaxBatches = opts.maxBatches ?? DELIVERY_EXPIRY_MAX_BATCHES;
  const maxBatches = Number.isFinite(requestedMaxBatches)
    ? Math.min(Math.max(Math.floor(requestedMaxBatches), 1), DELIVERY_EXPIRY_MAX_BATCHES)
    : DELIVERY_EXPIRY_MAX_BATCHES;
  let expiredCount = 0;
  for (let batchNumber = 0; batchNumber < maxBatches; batchNumber++) {
    const batch = await deliveryEngine.expireDueDeliveryBatch(engine.db, opts.workspaceId, now);
    expiredCount += batch.expiredCount;
    // Flush every committed batch before another state transition can fail.
    // Otherwise a later D1 error would strand already-dead-lettered rows with
    // notices held only in this invocation's memory.
    await notifyDeliveryFailures(engine, batch.notices);
    if (batch.expiredCount < deliveryEngine.DELIVERY_EXPIRY_BATCH_SIZE) break;
  }
  return expiredCount;
}

export async function notifyDeliveryRejections(
  c: HonoContext,
  senderAgentId: string,
  rejections: DeliveryRejectionRecord[],
): Promise<void> {
  if (rejections.length === 0) return;
  for (const rejection of rejections) {
    await fanoutToAgents(c, [senderAgentId], 'delivery.failed', {
      delivery_id: null,
      message_id: rejection.messageId,
      target_agent_id: rejection.agentId,
      target_agent_name: rejection.agentName,
      reason: rejection.reason,
      error: rejection.error,
      retryable: rejection.retryable,
    });
  }
}
