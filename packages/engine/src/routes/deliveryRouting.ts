import type { Context } from 'hono';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AppEnv } from '../env.js';
import * as deliveryEngine from '../engine/delivery.js';
import { buildDeliverFrame, buildDeliverPayload } from '../engine/deliveryWire.js';
import type {
  DeliveryFanoutRecord,
  DeliveryRejectionRecord,
} from '../engine/deliveryWrites.js';
import { agents, agentNodeBindings, deliveries as deliveryRows, nodes } from '../db/schema.js';
import { hmacSha256Hex } from '../lib/crypto.js';
import { fanoutToAgents } from './fanout.js';
type HonoContext = Context<AppEnv>;

type DeliveryTarget = {
  locationType: string;
  locationNodeId: string | null;
  nodeKind: string | null;
  deliveryAdapter: string | null;
  deliveryConfig: Record<string, unknown> | null;
};

const HTTP_PUSH_RETRY_DELAY_MS = 30_000;

function wireMode(mode: string): 'wait' | 'steer' {
  return mode === 'next-tool-call' ? 'steer' : 'wait';
}

async function resolveLiveLocations(
  c: HonoContext,
  workspaceId: string,
  deliveries: DeliveryFanoutRecord[],
): Promise<Map<string, DeliveryTarget>> {
  const uniqueAgentIds = [...new Set(deliveries.map((delivery) => delivery.agentId))];
  if (uniqueAgentIds.length === 0) return new Map();

  const db = c.get('db');
  const bindings = await db
    .select({
      agentId: agentNodeBindings.agentId,
      nodeId: agentNodeBindings.nodeId,
      nodeKind: nodes.kind,
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
      eq(agentNodeBindings.workspaceId, workspaceId),
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
      deliveryAdapter: binding.deliveryAdapter,
      deliveryConfig: binding.deliveryConfig as Record<string, unknown> | null,
    });
  }

  const fallbackRows = await db
    .select({
      id: agents.id,
      locationType: agents.locationType,
      locationNodeId: agents.locationNodeId,
      nodeKind: nodes.kind,
      deliveryAdapter: nodes.deliveryAdapter,
      deliveryConfig: nodes.deliveryConfig,
    })
    .from(agents)
    .leftJoin(nodes, eq(agents.locationNodeId, nodes.id))
    .where(and(eq(agents.workspaceId, workspaceId), inArray(agents.id, uniqueAgentIds)));

  for (const row of fallbackRows) {
    if (byAgent.has(row.id)) continue;
    byAgent.set(row.id, {
      locationType: row.locationType,
      locationNodeId: row.locationNodeId,
      nodeKind: row.nodeKind ?? (row.locationNodeId ? 'fleet_ws' : null),
      deliveryAdapter: row.deliveryAdapter ?? (row.locationNodeId ? 'fleet.ws.v1' : null),
      deliveryConfig: row.deliveryConfig as Record<string, unknown> | null,
    });
  }

  return byAgent;
}

function publicHeaders(headers: Record<string, unknown> | undefined): Record<string, string> {
  if (!headers) return {};
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') result[name] = value;
  }
  return result;
}

async function dispatchHttpPush(args: {
  c: HonoContext;
  delivery: DeliveryFanoutRecord;
  target: DeliveryTarget;
  eventType: string;
  eventData: Record<string, unknown>;
}): Promise<'delivered' | 'acked' | 'failed'> {
  const config = args.target.deliveryConfig ?? {};
  const url = typeof config.url === 'string' ? config.url : null;
  if (!url) {
    await args.c.get('db')
      .update(deliveryRows)
      .set({
        dispatchAttempts: sql`coalesce(${deliveryRows.dispatchAttempts}, 0) + 1`,
        lastDispatchError: 'invalid http_push delivery config: missing url',
        nextAttemptAt: new Date(Date.now() + HTTP_PUSH_RETRY_DELAY_MS),
        updatedAt: new Date(),
      })
      .where(eq(deliveryRows.id, args.delivery.id));
    return 'failed';
  }

  const ackMode = config.ack_mode === 'on_2xx' || config.ack_mode === 'response'
    ? config.ack_mode
    : 'manual';
  const timestamp = new Date().toISOString();
  const body = JSON.stringify({
    type: args.eventType,
    workspace_id: args.c.get('workspace').id,
    delivery_id: args.delivery.id,
    message_id: args.delivery.messageId,
    agent_id: args.delivery.agentId,
    agent_name: args.delivery.agentName,
    seq: args.delivery.seq,
    mode: wireMode(args.delivery.mode),
    timestamp,
    data: args.eventData,
  });

  const auth = config.auth && typeof config.auth === 'object' && !Array.isArray(config.auth)
    ? config.auth as Record<string, unknown>
    : { type: 'none' };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Relaycast-Event': args.eventType,
    'X-Relaycast-Delivery': args.delivery.id,
  };
  if (auth.type === 'bearer' && typeof auth.token === 'string') {
    headers.Authorization = `Bearer ${auth.token}`;
  } else if (auth.type === 'static_headers') {
    Object.assign(headers, publicHeaders(auth.headers as Record<string, unknown> | undefined));
  } else if (auth.type === 'hmac_sha256' && typeof auth.secret === 'string') {
    const timestampHeader = typeof auth.timestamp_header === 'string' ? auth.timestamp_header : 'X-Relaycast-Timestamp';
    const signatureHeader = typeof auth.signature_header === 'string' ? auth.signature_header : 'X-Relaycast-Signature';
    const prefix = typeof auth.prefix === 'string' ? auth.prefix : 'sha256=';
    const signedPayload = auth.signed_payload === 'body' ? body : `${timestamp}.${body}`;
    headers[timestampHeader] = timestamp;
    headers[signatureHeader] = `${prefix}${await hmacSha256Hex(signedPayload, auth.secret)}`;
  }

  try {
    await args.c.get('db')
      .update(deliveryRows)
      .set({
        dispatchAttempts: sql`coalesce(${deliveryRows.dispatchAttempts}, 0) + 1`,
        lastDispatchError: null,
        nextAttemptAt: null,
        updatedAt: new Date(),
      })
      .where(eq(deliveryRows.id, args.delivery.id));

    const response = await globalThis.fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      await args.c.get('db')
        .update(deliveryRows)
        .set({
          lastDispatchError: `HTTP ${response.status}`,
          nextAttemptAt: new Date(Date.now() + HTTP_PUSH_RETRY_DELAY_MS),
          updatedAt: new Date(),
        })
        .where(eq(deliveryRows.id, args.delivery.id));
      return 'failed';
    }

    if (ackMode === 'on_2xx') {
      const acked = await deliveryEngine.ackDelivery(
        args.c.get('db'),
        args.c.get('workspace').id,
        args.delivery.agentId,
        args.delivery.id,
      );
      if (acked?.changed) {
        await fanoutToAgents(args.c, [args.delivery.agentId], 'delivery.delivered', {
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
            args.c.get('db'),
            args.c.get('workspace').id,
            args.delivery.agentId,
            args.delivery.id,
          );
          if (acked?.changed) {
            await fanoutToAgents(args.c, [args.delivery.agentId], 'delivery.delivered', {
              delivery_id: args.delivery.id,
              message_id: args.delivery.messageId,
            });
          }
          return 'acked';
        }
      }
    }

    return 'delivered';
  } catch (err) {
    await args.c.get('db')
      .update(deliveryRows)
      .set({
        lastDispatchError: err instanceof Error ? err.message : 'HTTP delivery failed',
        nextAttemptAt: new Date(Date.now() + HTTP_PUSH_RETRY_DELAY_MS),
        updatedAt: new Date(),
      })
      .where(eq(deliveryRows.id, args.delivery.id));
    return 'failed';
  }
}

export async function routeDeliveryOutcomes(
  c: HonoContext,
  deliveries: DeliveryFanoutRecord[],
  eventType: string,
  eventData: Record<string, unknown>,
): Promise<void> {
  if (deliveries.length === 0) return;

  const workspaceId = c.get('workspace').id;
  const db = c.get('db');
  const deliveredIds: string[] = [];
  const liveLocations = await resolveLiveLocations(c, workspaceId, deliveries);

  for (const delivery of deliveries) {
    const liveLocation = liveLocations.get(delivery.agentId);
    const locationType = liveLocation?.locationType ?? delivery.locationType;
    const locationNodeId = liveLocation?.locationNodeId ?? delivery.locationNodeId;
    const nodeKind = liveLocation?.nodeKind ?? (locationNodeId ? 'fleet_ws' : null);

    if (locationType === 'via_node' && locationNodeId && nodeKind === 'fleet_ws') {
      const sent = await c.get('engine').nodeConnections.sendToNode(workspaceId, locationNodeId, buildDeliverFrame({
        agent: delivery.agentName,
        msg_id: delivery.messageId,
        seq: delivery.seq,
        mode: wireMode(delivery.mode),
        payload: buildDeliverPayload(eventType, eventData),
      }));
      if (sent) deliveredIds.push(delivery.id);
      continue;
    }

    if (locationType === 'via_node' && locationNodeId && nodeKind === 'http_push' && liveLocation) {
      const result = await dispatchHttpPush({ c, delivery, target: liveLocation, eventType, eventData });
      if (result === 'delivered') deliveredIds.push(delivery.id);
      continue;
    }

    deliveredIds.push(delivery.id);
    await fanoutToAgents(c, [delivery.agentId], 'delivery.accepted', {
      delivery_id: delivery.id,
      message_id: delivery.messageId,
      channel_id: (eventData.channel_id as string | undefined) ?? null,
      reason: delivery.reason,
      seq: delivery.seq,
    });
  }

  await deliveryEngine.markDeliveriesDelivered(db, workspaceId, deliveredIds);
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
