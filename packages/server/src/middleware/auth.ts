import crypto from 'node:crypto';
import { createMiddleware } from 'hono/factory';
import { eq } from 'drizzle-orm';
import { workspaces, agents } from '../db/schema.js';
import { touchLastSeen } from '../engine/agent.js';
import { touchWorkspaceActivity } from '../engine/eviction.js';
import type { AppEnv } from '../env.js';

const LAST_SEEN_DEBOUNCE_MS = 30_000; // 30 seconds
const ACTIVITY_DEBOUNCE_MS = 5 * 60_000; // 5 minutes

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function extractToken(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  return authHeader.slice(7);
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

  c.set('workspace', workspace);

  // Touch workspace activity (debounced, fire-and-forget)
  if (Date.now() - workspace.lastActivityAt.getTime() > ACTIVITY_DEBOUNCE_MS) {
    touchWorkspaceActivity(db, workspace.id).catch(() => {});
  }

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
    c.set('workspace', workspace);
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
    c.set('workspace', workspace);
  } else {
    return c.json(
      { ok: false, error: { code: 'unauthorized', message: 'Invalid token format' } },
      401,
    );
  }

  // Touch workspace activity (debounced, fire-and-forget)
  const ws = c.get('workspace');
  if (ws && Date.now() - ws.lastActivityAt.getTime() > ACTIVITY_DEBOUNCE_MS) {
    touchWorkspaceActivity(db, ws.id).catch(() => {});
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
  c.set('workspace', workspace);

  // Touch workspace activity (debounced, fire-and-forget)
  if (Date.now() - workspace.lastActivityAt.getTime() > ACTIVITY_DEBOUNCE_MS) {
    touchWorkspaceActivity(db, workspace.id).catch(() => {});
  }

  await next();
});
