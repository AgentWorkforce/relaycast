import { createMiddleware } from 'hono/factory';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { touchLastSeen } from '../engine/agent.js';
import type { AppEnv } from '../env.js';
import type { AuthRequire } from '../ports/auth.js';
import { jsonError } from '../lib/httpResponse.js';
import {
  hasAnyObserverScope,
  type ObserverScope,
} from '../engine/observerToken.js';

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
    if (result.observerToken) {
      c.set('observerToken', result.observerToken);
    }

    await next();
  });
}

interface WorkspaceReadOptions {
  allowAgent?: boolean;
  allowNode?: boolean;
}

function scopesArray(scopes: ObserverScope | ObserverScope[]): ObserverScope[] {
  return Array.isArray(scopes) ? scopes : [scopes];
}

export function requireWorkspaceRead(
  scopes: ObserverScope | ObserverScope[],
  options: WorkspaceReadOptions = {},
) {
  const requiredScopes = scopesArray(scopes);
  const allowAgent = options.allowAgent ?? true;
  const allowNode = options.allowNode ?? true;

  return createMiddleware<AppEnv>(async (c, next) => {
    const token = extractToken(c.req.header('Authorization'));
    if (!token) {
      return jsonError(c, 'unauthorized', 'Missing or invalid Authorization header', 401);
    }

    const db = c.get('db');
    const require: AuthRequire = token.startsWith('ot_live_')
      ? 'observer'
      : allowAgent || allowNode
        ? 'any'
        : 'workspace';
    const result = await c.get('engine').auth.authenticate({ token, require, db });
    if (!result.ok) {
      return jsonError(c, result.code, result.message, result.status as ContentfulStatusCode);
    }

    if (result.observerToken) {
      if (!hasAnyObserverScope(result.observerToken, requiredScopes)) {
        return jsonError(c, 'insufficient_scope', 'Observer token lacks the required scope', 403);
      }
      c.set('workspace', result.workspace);
      c.set('agent', undefined);
      c.set('node', undefined);
      c.set('observerToken', result.observerToken);
      await next();
      return;
    }

    if (result.agent && !allowAgent) {
      return jsonError(c, 'forbidden', 'Agent token cannot access this resource', 403);
    }
    if (result.node && !allowNode) {
      return jsonError(c, 'forbidden', 'Node token cannot access this resource', 403);
    }

    c.set('workspace', result.workspace);
    if (result.agent) {
      c.set('agent', result.agent);
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
