import type { FleetWireJsonValue } from '@relaycast/types';

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
    _delivery: _dropDelivery,
    ...publicData
  } = data as T & {
    _deliveries?: unknown;
    _delivery_rejections?: unknown;
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
