import { Router, Response } from 'express';
import {
  requireAuth,
  requireAgentToken,
  type AuthenticatedRequest,
} from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as reactionEngine from '../engine/reaction.js';

export const reactionRouter = Router();

// POST /v1/messages/:id/reactions — add reaction (idempotent)
reactionRouter.post(
  '/messages/:id/reactions',
  requireAgentToken,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { emoji } = req.body;
      if (!emoji || typeof emoji !== 'string') {
        res.status(400).json({
          ok: false,
          error: { code: 'invalid_request', message: 'emoji is required' },
        });
        return;
      }

      const result = await reactionEngine.addReaction(
        req.workspace!.id,
        req.params.id as string,
        req.agent!.id,
        emoji,
      );
      if (!result) {
        res.status(404).json({
          ok: false,
          error: { code: 'message_not_found', message: 'Message not found' },
        });
        return;
      }

      res.status(201).json({ ok: true, data: result });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);

// DELETE /v1/messages/:id/reactions/:emoji — remove own reaction
reactionRouter.delete(
  '/messages/:id/reactions/:emoji',
  requireAgentToken,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = await reactionEngine.removeReaction(
        req.workspace!.id,
        req.params.id as string,
        req.agent!.id,
        req.params.emoji as string,
      );
      if (result === null) {
        res.status(404).json({
          ok: false,
          error: { code: 'message_not_found', message: 'Message not found' },
        });
        return;
      }

      res.status(204).send();
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);

// GET /v1/messages/:id/reactions — aggregated reactions
reactionRouter.get(
  '/messages/:id/reactions',
  requireAuth,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = await reactionEngine.getReactions(
        req.workspace!.id,
        req.params.id as string,
      );
      if (result === null) {
        res.status(404).json({
          ok: false,
          error: { code: 'message_not_found', message: 'Message not found' },
        });
        return;
      }

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
