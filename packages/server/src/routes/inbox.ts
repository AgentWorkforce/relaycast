import { Router, Response } from 'express';
import { requireAgentToken, type AuthenticatedRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as inboxEngine from '../engine/inbox.js';

export const inboxRouter = Router();

// GET /v1/inbox — unified inbox for the calling agent
inboxRouter.get(
  '/inbox',
  requireAgentToken,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = await inboxEngine.getInbox(req.workspace!.id, req.agent!.id);
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
