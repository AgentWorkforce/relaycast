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
import { buildHttpPushHeaders } from '../engine/httpPushDispatch.js';
import { isSafeExternalUrl } from '../lib/ssrf.js';
import { transformForClient, type WsEvent } from '../engine/wsTransform.js';
import type { EngineDb, EngineDeps } from '../ports/index.js';
import { fanoutToAgents } from './fanout.js';
import { sendNodeContextToAgents } from '../engine/nodeContext.js';
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
};

const HTTP_PUSH_RETRY_DELAY_MS = 30_000;

function routingContextFromHono(c: HonoContext): RoutingContext {
  return {
    db: c.get('db'),
    workspaceId: c.get('workspace').id,
    engine: c.get('engine'),
  };
}

function wireMode(mode: string): 'wait' | 'steer' {
  return mode === 'next-tool-call' ? 'steer' : 'wait';
}

function strictExternalUrl(engine: RoutingEngine): boolean {
  return engine.config?.environment !== 'test';
}

function buildEvent(
  type: string,
  workspaceId: string,
  data: Record<string, unknown>,
): WsEvent {
  return {
    type,
    workspace_id: workspaceId,
    data,
    timestamp: new Date().toISOString(),
  };
}

async function fanoutToAgentsForContext(
  ctx: RoutingContext,
  agentIds: string[],
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  const payload = transformForClient(buildEvent(type, ctx.workspaceId, data));
  const unique = [...new Set(agentIds)];
  const tasks: Promise<unknown>[] = [
    ctx.engine.realtime.publishToWorkspaceStream({ workspaceId: ctx.workspaceId, event: payload }),
    sendNodeContextToAgents(
      {
        db: ctx.db,
        nodeConnections: ctx.engine.nodeConnections,
        realtime: ctx.engine.realtime,
        workspaceId: ctx.workspaceId,
        environment: ctx.engine.config?.environment,
      },
      {
        agentIds: unique,
        event: type,
        data,
      },
    ),
  ];
  await Promise.allSettled(tasks);
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

async function recordHttpPushRetry(
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
      nextAttemptAt: new Date(Date.now() + HTTP_PUSH_RETRY_DELAY_MS),
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
    await recordHttpPushRetry(args.ctx, args.delivery.id, 'invalid http_push delivery config: missing url', { incrementAttempts: true });
    return 'failed';
  }
  if (!isSafeExternalUrl(url, { strict: strictExternalUrl(args.ctx.engine) })) {
    await recordHttpPushRetry(args.ctx, args.delivery.id, 'unsafe http_push delivery url', { incrementAttempts: true });
    return 'failed';
  }

  // Optional egress proxy: when the node opts in with `use_proxy`, POST to the
  // deployment-configured forwarder instead of the destination directly, passing
  // the real target via X-Forward-To. Used to reach receivers that block the
  // engine's own network origin (e.g. a webhook behind Cloudflare bot rules that
  // reject Cloudflare Workers). The real `url` is still SSRF-checked above; the
  // proxy URL is operator-configured and trusted.
  let requestUrl = url;
  const proxyHeaders: Record<string, string> = {};
  if (config.use_proxy === true) {
    const proxyCfg = args.ctx.engine.config?.httpPushProxy;
    if (!proxyCfg?.url) {
      await recordHttpPushRetry(args.ctx, args.delivery.id, 'use_proxy set but no http_push proxy configured', { incrementAttempts: true });
      return 'failed';
    }
    requestUrl = proxyCfg.url;
    proxyHeaders['X-Forward-To'] = url;
    if (proxyCfg.secret) proxyHeaders['X-Proxy-Auth'] = proxyCfg.secret;
  }

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
        nextAttemptAt: new Date(Date.now() + HTTP_PUSH_RETRY_DELAY_MS),
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
      await recordHttpPushRetry(args.ctx, args.delivery.id, `redirect not allowed (HTTP ${response.status})`);
      return 'failed';
    }

    if (!response.ok) {
      await recordHttpPushRetry(args.ctx, args.delivery.id, `HTTP ${response.status}`);
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
      await recordHttpPushRetry(args.ctx, args.delivery.id, 'response ack not signaled');
      return 'failed';
    }

    return 'delivered';
  } catch (err) {
    await recordHttpPushRetry(args.ctx, args.delivery.id, err instanceof Error ? err.message : 'HTTP delivery failed');
    return 'failed';
  }
}

async function routeOneDeliveryOutcome(
  ctx: RoutingContext,
  liveLocations: Map<string, DeliveryTarget>,
  recordedTargets: Map<string, DeliveryTarget>,
  delivery: DeliveryFanoutRecord,
  eventType: string,
  eventData: Record<string, unknown>,
): Promise<void> {
  const recordedTarget = recordedTargets.get(delivery.id);
  const liveLocation = liveLocations.get(delivery.agentId);
  const target = recordedTarget ?? liveLocation;
  const locationType = target?.locationType ?? delivery.locationType;
  const locationNodeId = target?.locationNodeId ?? delivery.locationNodeId;
  const nodeKind = target?.nodeKind ?? (locationNodeId ? 'ws' : null);
  const deliveryAdapter = normalizeDeliveryAdapter(target?.deliveryAdapter ?? delivery.deliveryAdapter, nodeKind);

  if (locationType === 'via_node' && locationNodeId && deliveryAdapter === 'ws.node.v1') {
    const sent = await ctx.engine.nodeConnections.sendToNode(ctx.workspaceId, locationNodeId, buildDeliverFrame({
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
    }
    return;
  }

  if (locationType === 'via_node' && locationNodeId && nodeKind === 'http_push' && target) {
    const result = await dispatchHttpPush({ ctx, delivery, target, eventType, eventData });
    if (result === 'delivered') {
      await deliveryEngine.markDeliveriesDelivered(ctx.db, ctx.workspaceId, [delivery.id]);
    }
    return;
  }

  // No agent-owned realtime socket exists anymore. If a legacy/unbound row
  // reaches this point, leave it queued so a later node binding/replay can
  // deliver it instead of falsely marking it delivered.
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
): Promise<void> {
  await routeDeliveryOutcomesForContext(routingContextFromHono(c), deliveries, eventType, eventData);
}

export async function sweepDueHttpPushDeliveries(
  engine: EngineDeps,
  opts: { workspaceId?: string; now?: Date; limit?: number } = {},
): Promise<number> {
  const due = await deliveryEngine.fetchDueHttpPushDeliveryEvents(engine.db, opts);
  await Promise.allSettled(due.map((event) => (
    routeDeliveryOutcomesForContext(
      { db: engine.db, workspaceId: event.workspaceId, engine },
      [event.delivery],
      event.eventType,
      event.eventData,
    )
  )));
  return due.length;
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

export async function notifyDeliveryFailures(
  c: HonoContext,
  notices: deliveryEngine.DeliveryFailureNotice[],
): Promise<void> {
  if (notices.length === 0) return;
  for (const notice of notices) {
    await fanoutToAgents(c, [notice.sender_agent_id], 'delivery.failed', {
      delivery_id: notice.delivery_id,
      message_id: notice.message_id,
      target_agent_id: notice.target_agent_id,
      target_agent_name: notice.target_agent_name,
      seq: notice.seq,
      reason: notice.reason,
      error: notice.error,
      retryable: notice.retryable,
    });
  }
}
