import { Router, Response } from 'express';
import {
  requireAuth,
  requireAgentToken,
  type AuthenticatedRequest,
} from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as receiptEngine from '../engine/receipt.js';
import { publishEvent } from '../ws/pubsub.js';
import { deliverEvent } from '../engine/eventDelivery.js';

export const receiptRouter = Router();

// POST /v1/messages/:id/read — Mark message as read
receiptRouter.post(
  '/messages/:id/read',
  requireAgentToken,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = await receiptEngine.markRead(
        req.workspace!.id,
        req.params.id as string,
        req.agent!.id,
      );
      if (!result) {
        res.status(404).json({
          ok: false,
          error: { code: 'message_not_found', message: 'Message not found' },
        });
        return;
      }

      res.status(200).json({ ok: true, data: result });

      // Fire-and-forget event publishing
      const eventData = { ...result };
      publishEvent({ type: 'message.read', workspace_id: req.workspace!.id, data: eventData, timestamp: new Date().toISOString() }).catch(() => {});
      deliverEvent(req.workspace!.id, 'message.read', eventData).catch(() => {});
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);

// GET /v1/messages/:id/readers — List agents who read
receiptRouter.get(
  '/messages/:id/readers',
  requireAuth,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = await receiptEngine.getReaders(
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

// GET /v1/channels/:name/read-status — Per-member read positions
receiptRouter.get(
  '/channels/:name/read-status',
  requireAuth,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = await receiptEngine.getReadStatus(
        req.workspace!.id,
        req.params.name as string,
      );
      if (result === null) {
        res.status(404).json({
          ok: false,
          error: { code: 'channel_not_found', message: 'Channel not found' },
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
