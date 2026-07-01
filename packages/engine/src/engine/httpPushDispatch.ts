import { hmacSha256Hex } from '../lib/crypto.js';
import { isSafeExternalUrl } from '../lib/ssrf.js';

// Relaycast-controlled headers must always win over operator-supplied
// static_headers so a node config can't mask the event type or delivery id.
const RELAYCAST_CONTROLLED_HEADERS = new Set([
  'content-type',
  'x-relaycast-event',
  'x-relaycast-delivery',
  // Egress-proxy control headers: never let operator-supplied static_headers set
  // these (case-insensitively), or a node could inject `x-forward-to` to point
  // the proxy at an internal address and bypass the SSRF check on the real url.
  'x-forward-to',
  'x-proxy-auth',
]);

function publicHeaders(
  headers: Record<string, unknown> | undefined,
  reserved: Set<string> = new Set(),
): Record<string, string> {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return {};
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string' && !reserved.has(name.toLowerCase())) result[name] = value;
  }
  return result;
}

/**
 * Build the auth + signing headers for an http_push POST given the node's
 * delivery config and the exact body + timestamp being sent. Shared by durable
 * message dispatch (`deliveryRouting`) and ephemeral node-event dispatch so both
 * honor the same bearer / static-header / HMAC contract. May reject if signing
 * fails — callers run it inside their best-effort/retry boundary.
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
    // Merge operator headers without clobbering the Relaycast protocol headers.
    Object.assign(headers, publicHeaders(auth.headers as Record<string, unknown> | undefined, RELAYCAST_CONTROLLED_HEADERS));
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

export interface HttpPushProxyConfig {
  url?: string;
  secret?: string;
}

/**
 * Resolve the effective request target for an http_push POST. When the node opts
 * in with `delivery.use_proxy`, the POST is routed through the deployment's
 * configured forwarder (`proxy`) instead of the destination directly — the real
 * target rides in `X-Forward-To`, authenticated with `X-Proxy-Auth`. Used to
 * reach receivers that block the engine's own network origin. Shared by durable
 * message dispatch and ephemeral node-event dispatch so both honor `use_proxy`.
 * The real `realUrl` must already be SSRF-checked by the caller.
 */
export function resolveHttpPushProxy(
  realUrl: string,
  config: Record<string, unknown>,
  proxy: HttpPushProxyConfig | undefined,
): { ok: true; requestUrl: string; proxyHeaders: Record<string, string> } | { ok: false; reason: string } {
  if (config.use_proxy !== true) return { ok: true, requestUrl: realUrl, proxyHeaders: {} };
  if (!proxy?.url || !proxy.secret) {
    return { ok: false, reason: 'use_proxy set but no http_push proxy configured' };
  }
  return {
    ok: true,
    requestUrl: proxy.url,
    proxyHeaders: { 'X-Forward-To': realUrl, 'X-Proxy-Auth': proxy.secret },
  };
}

export interface EphemeralNodeEvent {
  workspaceId: string;
  eventType: string;
  eventData: Record<string, unknown>;
  /** Supplemental top-level body fields; cannot override the canonical fields. */
  extra?: Record<string, unknown>;
}

/**
 * Best-effort POST of an ephemeral node event (reaction, read receipt, presence
 * or context update) to an http_push node's receiver. Unlike durable message
 * dispatch there is no delivery row, ack, or retry — it mirrors the fire-and-
 * forget semantics of pushing a frame over a WebSocket node socket. Never
 * throws; returns whether the receiver acknowledged with a 2xx.
 */
export async function postEphemeralEventToHttpPushNode(args: {
  deliveryConfig: Record<string, unknown> | null | undefined;
  strict: boolean;
  event: EphemeralNodeEvent;
  /** Egress proxy for `use_proxy` nodes; omit to always POST direct. */
  proxy?: HttpPushProxyConfig;
}): Promise<boolean> {
  const config = args.deliveryConfig ?? {};
  const url = typeof config.url === 'string' ? config.url : null;
  if (!url) return false;
  if (!isSafeExternalUrl(url, { strict: args.strict })) return false;

  // Honor `use_proxy` here too, so a proxied node's ephemeral events reach the
  // receiver in the same environment durable messages do. Best-effort: if the
  // node opts in but no proxy is configured, drop the event rather than leaking
  // a direct request that would just be blocked.
  const resolved = resolveHttpPushProxy(url, config, args.proxy);
  if (!resolved.ok) return false;

  const timestamp = new Date().toISOString();
  // Spread `extra` first so the canonical event fields always win.
  const body = JSON.stringify({
    ...(args.event.extra ?? {}),
    type: args.event.eventType,
    workspace_id: args.event.workspaceId,
    timestamp,
    data: args.event.eventData,
  });

  try {
    const headers = { ...(await buildHttpPushHeaders(config, args.event.eventType, null, body, timestamp)), ...resolved.proxyHeaders };
    const response = await globalThis.fetch(resolved.requestUrl, {
      method: 'POST',
      headers,
      body,
      // Cloudflare Workers reject redirect:'error'; use 'manual' and treat any
      // 3xx as non-ok below (response.ok is false for 3xx).
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    // We only inspect status; release the connection instead of leaking the body.
    await response.body?.cancel().catch(() => {});
    return response.ok;
  } catch {
    return false;
  }
}
