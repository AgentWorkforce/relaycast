import { createMiddleware } from 'hono/factory';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { touchLastSeen } from '../engine/agent.js';
import type { AppEnv } from '../env.js';
import type { AuthRequire } from '../ports/auth.js';
import { jsonError } from '../lib/httpResponse.js';

// Re-exported for the WS upgrade, which looks tokens up
// directly. The active provider's `hashToken` is preferred at those call sites.
export { hashToken } from '../auth/index.js';

const LAST_SEEN_DEBOUNCE_MS = 30_000; // 30 seconds

function extractToken(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  return authHeader.slice(7);
}

function makeAuthMiddleware(require: AuthRequire) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const token = extractToken(c.req.header('Authorization'));
    if (!token) {
      return jsonError(c, 'unauthorized', 'Missing or invalid Authorization header', 401);
    }

    const db = c.get('db');
    const result = await c.get('engine').auth.authenticate({ token, require, db });
    if (!result.ok) {
      return jsonError(c, result.code, result.message, result.status as ContentfulStatusCode);
    }

    c.set('workspace', result.workspace);
    if (result.agent) {
      c.set('agent', result.agent);
      // Touch lastSeen (debounced, fire-and-forget)
      if (Date.now() - result.agent.lastSeen.getTime() > LAST_SEEN_DEBOUNCE_MS) {
        touchLastSeen(db, result.agent.id).catch(() => {});
      }
    }
    if (result.node) {
      c.set('node', result.node);
    }

    await next();
  });
}

/** Requires a workspace key (`rk_live_...`). */
export const requireWorkspaceKey = makeAuthMiddleware('workspace');

/** Accepts either a workspace key or an agent token. */
export const requireAuth = makeAuthMiddleware('any');

/** Requires an agent token (`at_live_...`). */
export const requireAgentToken = makeAuthMiddleware('agent');

/** Requires a node token (`nt_live_...`). */
export const requireNodeToken = makeAuthMiddleware('node');
