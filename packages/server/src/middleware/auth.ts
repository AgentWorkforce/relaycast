import { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { workspaces, agents } from '../db/schema.js';

export interface AuthenticatedRequest extends Request {
  workspace?: typeof workspaces.$inferSelect;
  agent?: typeof agents.$inferSelect;
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  return authHeader.slice(7);
}

export async function requireWorkspaceKey(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({
      ok: false,
      error: { code: 'unauthorized', message: 'Missing or invalid Authorization header' },
    });
    return;
  }

  if (!token.startsWith('rk_live_')) {
    res.status(401).json({
      ok: false,
      error: { code: 'unauthorized', message: 'Workspace key required (rk_live_...)' },
    });
    return;
  }

  const hash = hashToken(token);
  const db = getDb();
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.apiKeyHash, hash));

  if (!workspace) {
    res.status(401).json({
      ok: false,
      error: { code: 'unauthorized', message: 'Invalid API key' },
    });
    return;
  }

  req.workspace = workspace;
  next();
}

export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({
      ok: false,
      error: { code: 'unauthorized', message: 'Missing or invalid Authorization header' },
    });
    return;
  }

  const hash = hashToken(token);
  const db = getDb();

  if (token.startsWith('rk_live_')) {
    const [workspace] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.apiKeyHash, hash));
    if (!workspace) {
      res.status(401).json({
        ok: false,
        error: { code: 'unauthorized', message: 'Invalid API key' },
      });
      return;
    }
    req.workspace = workspace;
  } else if (token.startsWith('at_live_')) {
    const [agent] = await db.select().from(agents).where(eq(agents.tokenHash, hash));
    if (!agent) {
      res.status(401).json({
        ok: false,
        error: { code: 'unauthorized', message: 'Invalid agent token' },
      });
      return;
    }
    req.agent = agent;
    const [workspace] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, agent.workspaceId));
    if (!workspace) {
      res.status(401).json({
        ok: false,
        error: { code: 'unauthorized', message: 'Workspace not found' },
      });
      return;
    }
    req.workspace = workspace;
  } else {
    res.status(401).json({
      ok: false,
      error: { code: 'unauthorized', message: 'Invalid token format' },
    });
    return;
  }

  next();
}

export async function requireAgentToken(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({
      ok: false,
      error: { code: 'unauthorized', message: 'Missing or invalid Authorization header' },
    });
    return;
  }

  if (!token.startsWith('at_live_')) {
    res.status(401).json({
      ok: false,
      error: { code: 'unauthorized', message: 'Agent token required (at_live_...)' },
    });
    return;
  }

  const hash = hashToken(token);
  const db = getDb();
  const [agent] = await db.select().from(agents).where(eq(agents.tokenHash, hash));

  if (!agent) {
    res.status(401).json({
      ok: false,
      error: { code: 'unauthorized', message: 'Invalid agent token' },
    });
    return;
  }

  req.agent = agent;
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, agent.workspaceId));
  if (!workspace) {
    res.status(401).json({
      ok: false,
      error: { code: 'unauthorized', message: 'Workspace not found' },
    });
    return;
  }
  req.workspace = workspace;
  next();
}
