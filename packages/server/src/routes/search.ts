import { Router, Response } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as searchEngine from '../engine/search.js';

export const searchRouter = Router();

// GET /v1/search?q=...&channel=...&from=...&limit=...&before=...&after=...
searchRouter.get(
  '/search',
  requireAuth,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const q = req.query.q as string | undefined;
      if (!q || typeof q !== 'string' || !q.trim()) {
        res.status(400).json({
          ok: false,
          error: { code: 'invalid_request', message: 'q (search query) is required' },
        });
        return;
      }

      const channel = req.query.channel as string | undefined;
      const from = req.query.from as string | undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
      const before = req.query.before as string | undefined;
      const after = req.query.after as string | undefined;

      const results = await searchEngine.searchMessages(req.workspace!.id, {
        q,
        channel,
        from,
        limit,
        before,
        after,
      });

      res.json({ ok: true, data: results });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);
