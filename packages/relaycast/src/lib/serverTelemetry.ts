import type { InternalTelemetryEvent } from '@relaycast/types';
import type { Context } from 'hono';
import type { AppEnv } from '../env.js';
import { runInBackground } from '../routes/background.js';
import { extractOriginActor, requiredOriginInfo, UNKNOWN_ORIGIN_ACTOR } from './origin.js';
import { captureInternalTelemetryBatched, workspaceDistinctId } from './telemetry.js';

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

  // Prefer the value stashed by the logger middleware. Fall back to reading
  // the header directly so emitters that bypass middleware (e.g. test harnesses
  // or routes mounted before loggerMiddleware) still get a sane value.
  const originActor = c.get('originActor')
    ?? extractOriginActor(c.req.raw.headers)
    ?? UNKNOWN_ORIGIN_ACTOR;

  runInBackground(
    c,
    captureInternalTelemetryBatched(c.env, {
      event: event as InternalTelemetryEvent['event'],
      distinct_id: workspaceDistinctId(workspaceId),
      origin: requiredOriginInfo(c.req.raw),
      properties: {
        workspace_id: workspaceId,
        origin_actor: originActor,
        ...normalizedProperties,
      },
    }),
    `capture ${event}`,
  );
}
