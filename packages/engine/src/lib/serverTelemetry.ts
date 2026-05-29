import type { Context } from 'hono';
import type { AppEnv } from '../env.js';
import { extractHarness, requiredOriginInfo, UNKNOWN_HARNESS } from './origin.js';

type ServerEvent = `relaycast_server_${string}`;

export function normalizeRoutePathForTelemetry(value: string): string {
  const withoutQuery = value.split(/[?#]/)[0] ?? value;
  const compact = withoutQuery.replace(/\/+/g, '/').trim();
  const withLeadingSlash = compact.startsWith('/') ? compact : `/${compact}`;
  const segments = withLeadingSlash.split('/').filter(Boolean).map((segment) => {
    if (/^\d{6,}$/.test(segment)) return ':id';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(segment)) return ':id';
    if (/^(dm|dmch|cmd|sub|wh)_[a-zA-Z0-9_-]{8,}$/.test(segment)) return ':id';
    return segment;
  });
  return `/${segments.join('/')}`;
}

/**
 * Emit a server-side product-telemetry event through the injected
 * {@link TelemetrySink}. Self-host's default sink is a no-op; cloud injects
 * PostHog. The sink owns batching/background-flush, so this returns immediately.
 */
export function emitServerEvent(
  c: Context<AppEnv>,
  workspaceId: string,
  event: ServerEvent,
  properties: Record<string, unknown>,
): void {
  const normalizedProperties = { ...properties };
  if (typeof normalizedProperties.route_path === 'string') {
    normalizedProperties.route_path = normalizeRoutePathForTelemetry(normalizedProperties.route_path);
  }

  // Prefer the value stashed by the logger middleware. Fall back to reading the
  // header directly so emitters that bypass middleware still get a sane value.
  const harness = c.get('harness')
    ?? extractHarness(c.req.raw.headers)
    ?? UNKNOWN_HARNESS;

  const origin = requiredOriginInfo(c.req.raw);
  c.get('engine').telemetry.capture({
    name: event,
    distinctId: workspaceId,
    properties: {
      workspace_id: workspaceId,
      harness,
      origin_surface: origin.origin_surface,
      origin_client: origin.origin_client,
      origin_version: origin.origin_version,
      ...normalizedProperties,
    },
  });
}
