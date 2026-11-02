import type { MiddlewareHandler } from 'hono';
import { matchedRoutes } from 'hono/route';
import type { AppEnv } from '../env.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/** Sample before routing/authentication so failures share the same denominator.
 * POST /v1/agents/heartbeat is excluded to avoid heartbeat volume.
 * Only registered templates are exported; never infer a template from a URL.
 * Hosts own observation transport and analytics identity policy.
 */
export const requestObservationMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const registeredRoute = matchedRoutes(c).filter(route => route.method !== 'ALL').at(-1);
  if (c.req.method === 'POST' && registeredRoute?.path === '/v1/agents/heartbeat') return next();
  const configured = c.get('engine').config.telemetryRequestSampleRate ?? 0.01;
  const sampleRate = Number.isFinite(configured) ? Math.max(0, Math.min(1, configured)) : 0.01;
  const sampled = sampleRate > 0 && Math.random() < sampleRate;
  const startedAt = sampled ? performance.now() : 0;
  await next();
  if (!sampled) return;

  // Auth middleware can terminate before the endpoint runs. matchedRoutes still
  // contains its registered endpoint, unlike the current middleware routePath.
  const route = matchedRoutes(c).filter(route => route.method !== 'ALL').at(-1);
  const workspaceId = c.get('workspace')?.id;
  emitServerEvent(c, workspaceId, 'request.completed', {
    route_template: route?.path ?? 'unmatched',
    method: METHODS.has(c.req.method) ? c.req.method : 'OTHER',
    status_code: c.res.status,
    duration_ms: Math.max(0, performance.now() - startedAt),
    sample_rate: sampleRate,
  });
};
