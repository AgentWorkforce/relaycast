import { Router, Response } from 'express';
import { requireAuth, requireWorkspaceKey, type AuthenticatedRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as systemPromptEngine from '../engine/systemPrompt.js';

export const systemPromptRouter = Router();

systemPromptRouter.get(
  '/workspace/system-prompt',
  requireAuth,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = await systemPromptEngine.getSystemPrompt(req.workspace!.id);
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

systemPromptRouter.put(
  '/workspace/system-prompt',
  requireWorkspaceKey,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { prompt, reset } = req.body;

      if (reset === true || prompt === null) {
        const result = await systemPromptEngine.setSystemPrompt(req.workspace!.id, null);
        res.json({ ok: true, data: result });
        return;
      }

      if (!prompt || typeof prompt !== 'string') {
        res.status(400).json({
          ok: false,
          error: { code: 'invalid_request', message: 'prompt must be a non-empty string' },
        });
        return;
      }

      const result = await systemPromptEngine.setSystemPrompt(req.workspace!.id, prompt);
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
