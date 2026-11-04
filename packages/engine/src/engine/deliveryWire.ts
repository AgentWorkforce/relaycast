import type { FleetWireJsonValue, SentDelivery } from '@relaycast/types';
import type { DeliveryFanoutRecord } from './deliveryWrites.js';
import { deliveryStateOf } from './deliveryState.js';

/** Cap on the per-recipient `deliveries` a channel message send response carries. */
export const SENT_DELIVERIES_RESPONSE_MAX = 50;

/**
 * The sender-facing view of a delivery row just created by a send. A replayed
 * idempotent response reads the record back from JSON, where `expiresAt` is
 * already a string.
 */
export function sentDeliveryReceipt(
  record: Pick<DeliveryFanoutRecord, 'id' | 'agentId' | 'status'> & {
    expiresAt?: Date | string | null;
    acceptedAt?: Date | string | null;
    error?: string | null;
  },
): SentDelivery {
  return {
    id: record.id,
    agent_id: record.agentId,
    status: record.status as SentDelivery['status'],
    state: deliveryStateOf(record),
    accepted_at: isoOrNull(record.acceptedAt),
    error: record.error ?? null,
    expires_at: isoOrNull(record.expiresAt),
  };
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : (value ?? null);
}

/** `delivery` for a DM send response: the one recipient is implied, so `agent_id` is omitted. */
export function sentDmDeliveryReceipt(
  record: Parameters<typeof sentDeliveryReceipt>[0],
): Omit<SentDelivery, 'agent_id'> {
  return withoutRecipient(sentDeliveryReceipt(record));
}

/** Drop `agent_id` from a receipt whose recipient the response already implies. */
export function withoutRecipient(receipt: SentDelivery): Omit<SentDelivery, 'agent_id'> {
  const { agent_id: _recipient, ...rest } = receipt;
  return rest;
}

/** `deliveries` for a multi-recipient send response, capped with `deliveries_truncated`. */
export function sentDeliveriesResponseFields(
  records: readonly Parameters<typeof sentDeliveryReceipt>[0][] | undefined,
): { deliveries: SentDelivery[]; deliveries_truncated: boolean } {
  const all = records ?? [];
  return {
    deliveries: all.slice(0, SENT_DELIVERIES_RESPONSE_MAX).map(sentDeliveryReceipt),
    deliveries_truncated: all.length > SENT_DELIVERIES_RESPONSE_MAX,
  };
}

export function toFleetWireJson(value: unknown): FleetWireJsonValue {
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

export function buildDeliverPayload(eventType: string, eventData: Record<string, unknown>): FleetWireJsonValue {
  return toFleetWireJson({ type: eventType, data: eventData });
}

function stripDeliveryInternals<T extends Record<string, unknown>>(data: T): T {
  const {
    _deliveries: _dropDeliveries,
    _delivery_rejections: _dropRejections,
    _notifications_durable: _dropNotifications,
    _delivery: _dropDelivery,
    ...publicData
  } = data as T & {
    _deliveries?: unknown;
    _delivery_rejections?: unknown;
    _notifications_durable?: boolean;
    _delivery?: unknown;
  };
  return publicData as T;
}

export function buildMessageCreatedEventData(
  data: Record<string, unknown>,
  opts: { channelName: string; fromName: string; mode?: 'wait' | 'steer' },
): Record<string, unknown> {
  const publicData = stripDeliveryInternals(data);
  return {
    ...publicData,
    channel_name: opts.channelName,
    from_name: opts.fromName,
    injection_mode: (publicData.injection_mode as 'wait' | 'steer' | undefined) ?? opts.mode ?? 'wait',
  };
}

export function buildThreadReplyEventData(
  data: Record<string, unknown>,
  opts: { channelName: string; fromName: string },
): Record<string, unknown> {
  const publicData = stripDeliveryInternals(data);
  return {
    ...publicData,
    channel_name: opts.channelName,
    from_name: opts.fromName,
  };
}

export function buildDmReceivedEventData(
  data: Record<string, unknown>,
  opts: { fromName: string },
): Record<string, unknown> {
  const publicData = stripDeliveryInternals(data);
  return {
    ...publicData,
    from_name: opts.fromName,
  };
}

export function buildGroupDmReceivedEventData(
  data: Record<string, unknown>,
  opts: { fromName: string },
): Record<string, unknown> {
  const publicData = stripDeliveryInternals(data);
  return {
    ...publicData,
    from_name: opts.fromName,
  };
}

export function buildDeliverFrame(input: {
  delivery_id: string;
  agent_id: string;
  agent: string;
  msg_id: string;
  seq: number;
  mode: 'wait' | 'steer';
  payload: FleetWireJsonValue;
}) {
  return {
    v: 1 as const,
    type: 'deliver' as const,
    delivery_id: input.delivery_id,
    agent_id: input.agent_id,
    agent: input.agent,
    msg_id: input.msg_id,
    seq: input.seq,
    mode: input.mode,
    payload: input.payload,
  };
}
