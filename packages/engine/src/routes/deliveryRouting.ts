import type { Context } from 'hono';
import { and, eq, inArray } from 'drizzle-orm';
import type { AppEnv } from '../env.js';
import * as deliveryEngine from '../engine/delivery.js';
import { buildDeliverFrame, buildDeliverPayload } from '../engine/deliveryWire.js';
import type {
  DeliveryFanoutRecord,
  DeliveryRejectionRecord,
} from '../engine/deliveryWrites.js';
import { agents } from '../db/schema.js';
import { fanoutToAgents } from './fanout.js';
type HonoContext = Context<AppEnv>;

function wireMode(mode: string): 'wait' | 'steer' {
  return mode === 'next-tool-call' ? 'steer' : 'wait';
}

async function resolveLiveLocations(
  c: HonoContext,
  workspaceId: string,
  deliveries: DeliveryFanoutRecord[],
): Promise<Map<string, { locationType: string; locationNodeId: string | null }>> {
  const uniqueAgentIds = [...new Set(deliveries.map((delivery) => delivery.agentId))];
  if (uniqueAgentIds.length === 0) return new Map();

  const rows = await c.get('db')
    .select({
      id: agents.id,
      locationType: agents.locationType,
      locationNodeId: agents.locationNodeId,
    })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), inArray(agents.id, uniqueAgentIds)));

  return new Map(rows.map((row) => [row.id, {
    locationType: row.locationType,
    locationNodeId: row.locationNodeId,
  }]));
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

    if (locationType === 'via_node' && locationNodeId) {
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
