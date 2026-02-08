import { Router, Response } from 'express';
import {
  requireAuth,
  type AuthenticatedRequest,
} from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as threadEngine from '../engine/thread.js';
import { publishEvent } from '../ws/pubsub.js';
import { deliverEvent } from '../engine/eventDelivery.js';

export const threadRouter = Router();

// POST /v1/messages/:id/replies - post a reply
threadRouter.post(
  '/messages/:id/replies',
  requireAuth,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { text } = req.body;
      if (!text || typeof text !== 'string') {
        res.status(400).json({
          ok: false,
          error: { code: 'invalid_request', message: 'text is required' },
        });
        return;
      }

      const agentId = req.agent?.id;
      if (!agentId) {
        res.status(403).json({
          ok: false,
          error: { code: 'agent_token_required', message: 'Agent token required to post replies' },
        });
        return;
      }

      const parentId = req.params.id as string;
      const result = await threadEngine.postReply(
        req.workspace!.id,
        parentId,
        agentId,
        { text },
      );
      res.status(201).json({ ok: true, data: result });

      // Fire-and-forget event publishing
      const eventData = { ...result };
      publishEvent({ type: 'thread.reply', workspace_id: req.workspace!.id, channel_id: result.channel_id, data: eventData, timestamp: new Date().toISOString() }).catch(() => {});
      deliverEvent(req.workspace!.id, 'thread.reply', eventData).catch(() => {});
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);

// GET /v1/messages/:id/replies - get thread
threadRouter.get(
  '/messages/:id/replies',
  requireAuth,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
      const before = req.query.before as string | undefined;
      const after = req.query.after as string | undefined;

      const parentId = req.params.id as string;
      const result = await threadEngine.getThread(
        req.workspace!.id,
        parentId,
        { limit, before, after },
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
