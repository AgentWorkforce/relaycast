import { Router, Response } from 'express';
import {
  requireAuth,
  type AuthenticatedRequest,
} from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { parseIdempotencyKey, runIdempotent } from '../middleware/idempotency.js';
import * as messageEngine from '../engine/message.js';
import * as channelEngine from '../engine/channel.js';
import { publishEvent } from '../ws/pubsub.js';
import { enqueueEvent } from '../engine/eventQueue.js';

export const messageRouter = Router();

// POST /v1/channels/:name/messages - post a message
messageRouter.post(
  '/channels/:name/messages',
  requireAuth,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { text, blocks, attachments, data, content_type } = req.body;
      if (!text || typeof text !== 'string') {
        res.status(400).json({
          ok: false,
          error: { code: 'invalid_request', message: 'text is required' },
        });
        return;
      }

      const { key: idempotencyKey, error: idempotencyError } = parseIdempotencyKey(req);
      if (idempotencyError) {
        res.status(400).json({
          ok: false,
          error: { code: 'invalid_idempotency_key', message: idempotencyError },
        });
        return;
      }

      const channelName = req.params.name as string;

      // Resolve channel name to ID
      const channel = await channelEngine.getChannel(
        req.workspace!.id,
        channelName,
      );
      if (!channel) {
        res.status(404).json({
          ok: false,
          error: { code: 'channel_not_found', message: `Channel "${channelName}" not found` },
        });
        return;
      }

      // Determine agent ID (from agent token or body)
      const agentId = req.agent?.id;
      if (!agentId) {
        res.status(403).json({
          ok: false,
          error: { code: 'agent_token_required', message: 'Agent token required to post messages' },
        });
        return;
      }

      const idempotent = await runIdempotent({
        workspaceId: req.workspace!.id,
        actorId: agentId,
        scope: `channel-message:${channel.id}`,
        key: idempotencyKey,
        status: 201,
        fingerprint: JSON.stringify({ channelId: channel.id, text, blocks, attachments, data, content_type }),
        operation: () =>
          messageEngine.postMessage(
            req.workspace!.id,
            channel.id,
            agentId,
            { text, blocks, attachments, data, content_type },
          ),
      });

      if (idempotent.replayed) {
        res.setHeader('Idempotency-Replayed', 'true');
      }

      res.status(idempotent.status).json({ ok: true, data: idempotent.data });

      // Durable event queue for webhook delivery; real-time pub/sub still fire-and-forget.
      // Only publish for fresh writes, not idempotent replays.
      if (!idempotent.replayed) {
        const eventData = { ...idempotent.data, channel_name: channelName, from_name: req.agent?.name };
        publishEvent({ type: 'message.created', workspace_id: req.workspace!.id, channel_id: channel.id, data: eventData, timestamp: new Date().toISOString() }).catch(() => {});
        enqueueEvent(req.workspace!.id, 'message.created', eventData).catch(() => {});
      }
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

// GET /v1/channels/:name/messages - list messages
messageRouter.get(
  '/channels/:name/messages',
  requireAuth,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const channelName = req.params.name as string;
      const channel = await channelEngine.getChannel(
        req.workspace!.id,
        channelName,
      );
      if (!channel) {
        res.status(404).json({
          ok: false,
          error: { code: 'channel_not_found', message: `Channel "${channelName}" not found` },
        });
        return;
      }

      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
      const before = req.query.before as string | undefined;
      const after = req.query.after as string | undefined;

      const messages = await messageEngine.getMessages(
        req.workspace!.id,
        channel.id,
        { limit, before, after },
      );
      res.json({ ok: true, data: messages });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);

// GET /v1/messages/:id - get single message
messageRouter.get(
  '/messages/:id',
  requireAuth,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const messageId = req.params.id as string;
      const message = await messageEngine.getMessage(
        req.workspace!.id,
        messageId,
      );
      if (!message) {
        res.status(404).json({
          ok: false,
          error: { code: 'message_not_found', message: 'Message not found' },
        });
        return;
      }
      res.json({ ok: true, data: message });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);
