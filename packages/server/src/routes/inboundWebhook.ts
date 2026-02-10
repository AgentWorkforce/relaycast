import { Router, Request, Response } from 'express';
import {
  requireAuth,
  type AuthenticatedRequest,
} from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as inboundWebhookEngine from '../engine/inboundWebhook.js';
import * as channelEngine from '../engine/channel.js';
import { publishEvent } from '../ws/pubsub.js';
import { deliverEvent } from '../engine/eventDelivery.js';

export const inboundWebhookRouter = Router();

// POST /v1/webhooks - create an inbound webhook
inboundWebhookRouter.post(
  '/webhooks',
  requireAuth,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { name, channel } = req.body;
      if (!name || typeof name !== 'string') {
        res.status(400).json({
          ok: false,
          error: { code: 'invalid_request', message: 'name is required' },
        });
        return;
      }
      if (!channel || typeof channel !== 'string') {
        res.status(400).json({
          ok: false,
          error: { code: 'invalid_request', message: 'channel is required' },
        });
        return;
      }

      // Resolve channel name to ID
      const ch = await channelEngine.getChannel(req.workspace!.id, channel);
      if (!ch) {
        res.status(404).json({
          ok: false,
          error: { code: 'channel_not_found', message: `Channel "${channel}" not found` },
        });
        return;
      }

      const result = await inboundWebhookEngine.createWebhook(
        req.workspace!.id,
        ch.id,
        { name },
        req.agent?.id,
      );
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

// GET /v1/webhooks - list webhooks
inboundWebhookRouter.get(
  '/webhooks',
  requireAuth,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = await inboundWebhookEngine.listWebhooks(req.workspace!.id);
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

// DELETE /v1/webhooks/:id - delete a webhook
inboundWebhookRouter.delete(
  '/webhooks/:id',
  requireAuth,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const deleted = await inboundWebhookEngine.deleteWebhook(
        req.workspace!.id,
        req.params.id as string,
      );
      if (!deleted) {
        res.status(404).json({
          ok: false,
          error: { code: 'webhook_not_found', message: 'Webhook not found' },
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

// POST /v1/hooks/:webhookId - trigger a webhook (external callers)
inboundWebhookRouter.post(
  '/hooks/:webhookId',
  async (req: Request, res: Response) => {
    try {
      const { text, source, payload } = req.body || {};
      const result = await inboundWebhookEngine.triggerWebhook(
        req.params.webhookId as string,
        { text, source, payload },
      );
      if (!result) {
        res.status(404).json({
          ok: false,
          error: { code: 'webhook_not_found', message: 'Webhook not found or inactive' },
        });
        return;
      }
      const { workspace_id, channel_id, ...responseData } = result;
      res.status(201).json({ ok: true, data: responseData });

      // Fire-and-forget event publishing
      const eventData = { webhook_id: result.webhook_id, channel: result.channel, channel_name: result.channel, message_id: result.message_id, text: result.text, source: result.source };
      publishEvent({ type: 'webhook.received', workspace_id, channel_id, data: eventData, timestamp: new Date().toISOString() }).catch(() => {});
      deliverEvent(workspace_id, 'webhook.received', eventData).catch(() => {});
    } catch (err: unknown) {
      if (!res.headersSent) {
        const error = err as Error & { code?: string; status?: number };
        res.status(error.status || 500).json({
          ok: false,
          error: { code: error.code || 'internal_error', message: error.message },
        });
      }
    }
  },
);
