import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env.js';
import { isFleetNodesEnabled } from '../lib/fleetNodes.js';

/**
 * Gate the fleet node control surface behind the per-workspace rollout flag
 * (Phase 6). When the flag is off, the node roster routes behave as if the
 * surface does not exist — a flat 404 — so legacy clients and old brokers see
 * no behavioural change. Must run after auth middleware so `c.get('workspace')`
 * is populated.
 */
export const requireFleetNodes = createMiddleware<AppEnv>(async (c, next) => {
  const workspace = c.get('workspace');
  const { kv, config } = c.get('engine');
  if (!workspace || !(await isFleetNodesEnabled(kv, workspace.id, config.fleetNodesEnabled ?? false))) {
    return c.json(
      { ok: false, error: { code: 'fleet_nodes_disabled', message: 'Fleet nodes are disabled for this workspace' } },
      404,
    );
  }
  await next();
});
