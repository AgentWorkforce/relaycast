import type { Context } from 'hono';
import type { FleetWireJsonValue } from '@relaycast/types';
import type { AppEnv } from '../env.js';
import * as deliveryEngine from '../engine/delivery.js';
import type {
  DeliveryFanoutRecord,
  DeliveryRejectionRecord,
} from '../engine/deliveryWrites.js';
import { fanoutToAgents } from './fanout.js';

type HonoContext = Context<AppEnv>;

function toFleetWireJson(value: unknown): FleetWireJsonValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(toFleetWireJson);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') {
    const out: Record<string, FleetWireJsonValue> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = toFleetWireJson(nested);
    }
    return out;
  }
  return null;
}

function wireMode(mode: string): 'wait' | 'steer' {
  return mode === 'next-tool-call' ? 'steer' : 'wait';
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

  for (const delivery of deliveries) {
    if (delivery.locationType === 'via_node' && delivery.locationNodeId) {
      const sent = await c.get('engine').nodeConnections.sendToNode(workspaceId, delivery.locationNodeId, {
        v: 1,
        type: 'deliver',
        agent: delivery.agentName,
        msg_id: delivery.messageId,
        seq: delivery.seq,
        mode: wireMode(delivery.mode),
        payload: toFleetWireJson({ type: eventType, data: eventData }),
      });
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
