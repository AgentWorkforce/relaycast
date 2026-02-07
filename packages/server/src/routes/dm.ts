import { Router, Response } from 'express';
import {
  requireAgentToken,
  type AuthenticatedRequest,
} from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as dmEngine from '../engine/dm.js';

export const dmRouter = Router();

// POST /v1/dm - send a DM
dmRouter.post(
  '/dm',
  requireAgentToken,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { to, text } = req.body;
      if (!to || typeof to !== 'string') {
        res.status(400).json({
          ok: false,
          error: {
            code: 'invalid_request',
            message: '"to" agent name is required',
          },
        });
        return;
      }
      if (!text || typeof text !== 'string') {
        res.status(400).json({
          ok: false,
          error: { code: 'invalid_request', message: 'text is required' },
        });
        return;
      }

      const result = await dmEngine.sendDm(req.workspace!.id, req.agent!.id, {
        to,
        text,
      });
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

// GET /v1/dm/conversations - list DM conversations
dmRouter.get(
  '/dm/conversations',
  requireAgentToken,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const conversations = await dmEngine.listConversations(
        req.workspace!.id,
        req.agent!.id,
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

// GET /v1/dm/:conversation_id/messages - get DM messages
dmRouter.get(
  '/dm/:conversation_id/messages',
  requireAgentToken,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const limit = req.query.limit
        ? parseInt(req.query.limit as string, 10)
        : undefined;
      const before = req.query.before as string | undefined;
      const after = req.query.after as string | undefined;

      const conversationId = req.params.conversation_id as string;
      const msgs = await dmEngine.getDmMessages(
        req.workspace!.id,
        conversationId,
        req.agent!.id,
        { limit, before, after },
      );
      res.json({ ok: true, data: msgs });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);

