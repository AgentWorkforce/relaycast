import { Router, Response } from 'express';
import {
  requireWorkspaceKey,
  requireAuth,
  type AuthenticatedRequest,
} from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as statsEngine from '../engine/stats.js';
import * as activityEngine from '../engine/activity.js';
import * as dmAllEngine from '../engine/dmAll.js';
import * as tokenRotateEngine from '../engine/tokenRotate.js';

export const dashboardRouter = Router();

// GET /v1/workspace/stats — aggregated workspace stats
dashboardRouter.get(
  '/workspace/stats',
  requireWorkspaceKey,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const stats = await statsEngine.getWorkspaceStats(req.workspace!.id);
      res.json({ ok: true, data: stats });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);

// GET /v1/activity — recent activity feed
dashboardRouter.get(
  '/activity',
  requireWorkspaceKey,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const limit = req.query.limit
        ? parseInt(req.query.limit as string, 10)
        : 20;
      const items = await activityEngine.getActivityFeed(
        req.workspace!.id,
        limit,
      );
      res.json({ ok: true, data: items });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);

// GET /v1/dm/conversations/all — workspace-wide DM list
dashboardRouter.get(
  '/dm/conversations/all',
  requireWorkspaceKey,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const conversations = await dmAllEngine.listAllDmConversations(
        req.workspace!.id,
      );
      res.json({ ok: true, data: conversations });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);

// POST /v1/agents/:name/rotate-token — token rotation
dashboardRouter.post(
  '/agents/:name/rotate-token',
  requireWorkspaceKey,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = await tokenRotateEngine.rotateAgentToken(
        req.workspace!.id,
        req.params.name as string,
      );
      res.json({ ok: true, data: result });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);
