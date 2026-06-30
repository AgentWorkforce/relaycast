import { hmacSha256Hex } from '../lib/crypto.js';
import { isSafeExternalUrl } from '../lib/ssrf.js';

function publicHeaders(headers: Record<string, unknown> | undefined): Record<string, string> {
  if (!headers) return {};
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') result[name] = value;
  }
  return result;
}

/**
 * Build the auth + signing headers for an http_push POST given the node's
 * delivery config and the exact body + timestamp being sent. Shared by durable
 * message dispatch (`deliveryRouting`) and ephemeral node-event dispatch so both
 * honor the same bearer / static-header / HMAC contract.
 */
export async function buildHttpPushHeaders(
  config: Record<string, unknown>,
  eventType: string,
  deliveryId: string | null,
  body: string,
  timestamp: string,
): Promise<Record<string, string>> {
  const auth = config.auth && typeof config.auth === 'object' && !Array.isArray(config.auth)
    ? config.auth as Record<string, unknown>
    : { type: 'none' };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Relaycast-Event': eventType,
  };
  if (deliveryId) headers['X-Relaycast-Delivery'] = deliveryId;

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

  return headers;
}

/** `true` outside the test environment — keeps SSRF hardening on by default. */
export function strictHttpPushDispatch(environment: string | undefined): boolean {
  return environment !== 'test';
}

export interface EphemeralNodeEvent {
  workspaceId: string;
  eventType: string;
  eventData: Record<string, unknown>;
  /** Top-level body fields beyond `type`/`workspace_id`/`timestamp`/`data`. */
  extra?: Record<string, unknown>;
}

/**
 * Best-effort POST of an ephemeral node event (reaction, read receipt, presence
 * or context update) to an http_push node's receiver. Unlike durable message
 * dispatch there is no delivery row, ack, or retry — it mirrors the fire-and-
 * forget semantics of pushing a frame over a WebSocket node socket. Returns
 * whether the receiver acknowledged with a 2xx.
 */
export async function postEphemeralEventToHttpPushNode(args: {
  deliveryConfig: Record<string, unknown> | null | undefined;
  strict: boolean;
  event: EphemeralNodeEvent;
}): Promise<boolean> {
  const config = args.deliveryConfig ?? {};
  const url = typeof config.url === 'string' ? config.url : null;
  if (!url) return false;
  if (!isSafeExternalUrl(url, { strict: args.strict })) return false;

  const timestamp = new Date().toISOString();
  const body = JSON.stringify({
    type: args.event.eventType,
    workspace_id: args.event.workspaceId,
    ...(args.event.extra ?? {}),
    timestamp,
    data: args.event.eventData,
  });
  const headers = await buildHttpPushHeaders(config, args.event.eventType, null, body, timestamp);

  try {
    const response = await globalThis.fetch(url, {
      method: 'POST',
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
