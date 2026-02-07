import { Router, Response } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as presenceEngine from '../engine/presence.js';

export const presenceRouter = Router();

presenceRouter.get(
  '/agents/presence',
  requireAuth,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = await presenceEngine.getPresence(req.workspace!.id);
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
