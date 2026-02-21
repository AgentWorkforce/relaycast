import crypto from 'node:crypto';
import { createMiddleware } from 'hono/factory';
import { eq } from 'drizzle-orm';
import { workspaces, agents, organizations, sessions, users } from '../db/schema.js';
import { touchLastSeen } from '../engine/agent.js';
import type { AppEnv } from '../env.js';

const LAST_SEEN_DEBOUNCE_MS = 30_000; // 30 seconds

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function extractToken(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  return authHeader.slice(7);
}

function getCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? match[1] : null;
}

/** Check if a workspace is soft-deleted */
function isWorkspaceDeleted(workspace: typeof workspaces.$inferSelect) {
  return workspace.deletedAt !== null && workspace.deletedAt !== undefined;
}

export const requireWorkspaceKey = createMiddleware<AppEnv>(async (c, next) => {
  const token = extractToken(c.req.header('Authorization'));
  if (!token) {
    return c.json(
      { ok: false, error: { code: 'unauthorized', message: 'Missing or invalid Authorization header' } },
      401,
    );
  }

  if (!token.startsWith('rk_live_')) {
    return c.json(
      { ok: false, error: { code: 'unauthorized', message: 'Workspace key required (rk_live_...)' } },
      401,
    );
  }

  const hash = hashToken(token);
  const db = c.get('db');
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.apiKeyHash, hash));

  if (!workspace) {
    return c.json(
      { ok: false, error: { code: 'unauthorized', message: 'Invalid API key' } },
      401,
    );
  }

  if (isWorkspaceDeleted(workspace)) {
    return c.json(
      { ok: false, error: { code: 'workspace_expired', message: 'This workspace has been deactivated due to inactivity' } },
      410,
    );
  }

  c.set('workspace', workspace);
  const [org] = await db.select().from(organizations).where(eq(organizations.id, workspace.organizationId));
  if (org) c.set('organization', org);
  await next();
});

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = extractToken(c.req.header('Authorization'));
  if (!token) {
    return c.json(
      { ok: false, error: { code: 'unauthorized', message: 'Missing or invalid Authorization header' } },
      401,
    );
  }

  const hash = hashToken(token);
  const db = c.get('db');

  if (token.startsWith('rk_live_')) {
    const [workspace] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.apiKeyHash, hash));
    if (!workspace) {
      return c.json(
        { ok: false, error: { code: 'unauthorized', message: 'Invalid API key' } },
        401,
      );
    }
    if (isWorkspaceDeleted(workspace)) {
      return c.json(
        { ok: false, error: { code: 'workspace_expired', message: 'This workspace has been deactivated due to inactivity' } },
        410,
      );
    }
    c.set('workspace', workspace);
    const [org1] = await db.select().from(organizations).where(eq(organizations.id, workspace.organizationId));
    if (org1) c.set('organization', org1);
  } else if (token.startsWith('at_live_')) {
    const [agent] = await db.select().from(agents).where(eq(agents.tokenHash, hash));
    if (!agent) {
      return c.json(
        { ok: false, error: { code: 'unauthorized', message: 'Invalid agent token' } },
        401,
      );
    }
    c.set('agent', agent);

    // Touch lastSeen (debounced, fire-and-forget)
    if (Date.now() - agent.lastSeen.getTime() > LAST_SEEN_DEBOUNCE_MS) {
      touchLastSeen(db, agent.id).catch(() => {});
    }

    const [workspace] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, agent.workspaceId));
    if (!workspace) {
      return c.json(
        { ok: false, error: { code: 'unauthorized', message: 'Workspace not found' } },
        401,
      );
    }
    if (isWorkspaceDeleted(workspace)) {
      return c.json(
        { ok: false, error: { code: 'workspace_expired', message: 'This workspace has been deactivated due to inactivity' } },
        410,
      );
    }
    c.set('workspace', workspace);
    const [org2] = await db.select().from(organizations).where(eq(organizations.id, workspace.organizationId));
    if (org2) c.set('organization', org2);
  } else {
    return c.json(
      { ok: false, error: { code: 'unauthorized', message: 'Invalid token format' } },
      401,
    );
  }

  await next();
});

export const requireAgentToken = createMiddleware<AppEnv>(async (c, next) => {
  const token = extractToken(c.req.header('Authorization'));
  if (!token) {
    return c.json(
      { ok: false, error: { code: 'unauthorized', message: 'Missing or invalid Authorization header' } },
      401,
    );
  }

  if (!token.startsWith('at_live_')) {
    return c.json(
      { ok: false, error: { code: 'unauthorized', message: 'Agent token required (at_live_...)' } },
      401,
    );
  }

  const hash = hashToken(token);
  const db = c.get('db');
  const [agent] = await db.select().from(agents).where(eq(agents.tokenHash, hash));

  if (!agent) {
    return c.json(
      { ok: false, error: { code: 'unauthorized', message: 'Invalid agent token' } },
      401,
    );
  }

  c.set('agent', agent);

  // Touch lastSeen (debounced, fire-and-forget)
  if (Date.now() - agent.lastSeen.getTime() > LAST_SEEN_DEBOUNCE_MS) {
    touchLastSeen(db, agent.id).catch(() => {});
  }

  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, agent.workspaceId));
  if (!workspace) {
    return c.json(
      { ok: false, error: { code: 'unauthorized', message: 'Workspace not found' } },
      401,
    );
  }
  if (isWorkspaceDeleted(workspace)) {
    return c.json(
      { ok: false, error: { code: 'workspace_expired', message: 'This workspace has been deactivated due to inactivity' } },
      410,
    );
  }
  c.set('workspace', workspace);
  const [org] = await db.select().from(organizations).where(eq(organizations.id, workspace.organizationId));
  if (org) c.set('organization', org);
  await next();
});

/**
 * Authenticate via org API key (rk_org_*) or session cookie.
 * Sets c.var.organization on success. For session auth, also sets c.var.user.
 */
export const requireOrgAuth = createMiddleware<AppEnv>(async (c, next) => {
  const db = c.get('db');

  // Try org API key first
  const token = extractToken(c.req.header('Authorization'));
  if (token && token.startsWith('rk_org_')) {
    const hash = hashToken(token);
    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.orgApiKeyHash, hash));

    if (!org) {
      return c.json(
        { ok: false, error: { code: 'unauthorized', message: 'Invalid org API key' } },
        401,
      );
    }
    c.set('organization', org);
    await next();
    return;
  }

  // Try session cookie — resolves user + active org
  const sessionId = getCookie(c.req.header('Cookie'), 'relaycast_session');
  if (sessionId) {
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));

    if (session && session.expiresAt > new Date()) {
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.id, session.userId));

      if (user) {
        c.set('user', user);

        if (session.activeOrgId) {
          const [org] = await db
            .select()
            .from(organizations)
            .where(eq(organizations.id, session.activeOrgId));

          if (org) {
            c.set('organization', org);
            await next();
            return;
          }
        }

        // User has a session but no active org — they need to select one
        return c.json(
          { ok: false, error: { code: 'no_active_org', message: 'No active organization. Use POST /v1/user/orgs/switch to select one.' } },
          400,
        );
      }
    }
  }

  return c.json(
    { ok: false, error: { code: 'unauthorized', message: 'Org API key (rk_org_*) or session cookie required' } },
    401,
  );
});

/**
 * Authenticate via session cookie only — for user-level endpoints.
 * Sets c.var.user on success.
 */
export const requireUserAuth = createMiddleware<AppEnv>(async (c, next) => {
  const db = c.get('db');

  const sessionId = getCookie(c.req.header('Cookie'), 'relaycast_session');
  if (!sessionId) {
    return c.json(
      { ok: false, error: { code: 'unauthorized', message: 'Session cookie required. Log in first.' } },
      401,
    );
  }

  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId));

  if (!session || session.expiresAt < new Date()) {
    return c.json(
      { ok: false, error: { code: 'session_expired', message: 'Session expired. Please log in again.' } },
      401,
    );
  }

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, session.userId));

  if (!user) {
    return c.json(
      { ok: false, error: { code: 'unauthorized', message: 'User not found' } },
      401,
    );
  }

  c.set('user', user);

  // Also load active org if set
  if (session.activeOrgId) {
    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, session.activeOrgId));
    if (org) c.set('organization', org);
  }

  await next();
});

/**
 * Require X-Admin-Secret header matching ADMIN_SECRET binding.
 */
export const requireAdminSecret = createMiddleware<AppEnv>(async (c, next) => {
  const secret = c.req.header('X-Admin-Secret');
  const expected = c.env.ADMIN_SECRET;

  if (!expected || !secret || secret !== expected) {
    return c.json(
      { ok: false, error: { code: 'unauthorized', message: 'Invalid or missing admin secret' } },
      401,
    );
  }

  await next();
});
