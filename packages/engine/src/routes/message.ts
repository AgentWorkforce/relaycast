import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { parseIdempotencyKey, runIdempotent } from '../middleware/idempotency.js';
import * as messageEngine from '../engine/message.js';
import * as channelEngine from '../engine/channel.js';
import { fanoutToChannel, fanoutToAgents } from './fanout.js';
import { runInBackground } from './background.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';

export const messageRoutes = new Hono<AppEnv>();

const postMessageSchema = z.object({
  text: z.string().min(1),
  blocks: z.array(z.unknown()).nullable().optional(),
  attachments: z.array(z.string()).optional(),
  data: z.record(z.string(), z.unknown()).nullable().optional(),
  content_type: z.string().optional(),
  mode: z.enum(['wait', 'steer']).default('wait'),
});

// POST /v1/channels/:name/messages - post a message
messageRoutes.post(
  '/channels/:name/messages',
  requireAuth,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const agent = c.get('agent');
      const parsed = postMessageSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        return c.json({
          ok: false,
          error: { code: 'invalid_request', message: 'text is required' },
        }, 400);
      }
      const { text, blocks, attachments, data, content_type, mode } = parsed.data;

      const { key: idempotencyKey, error: idempotencyError } = parseIdempotencyKey(c.req.header('Idempotency-Key'));
      if (idempotencyError) {
        return c.json({
          ok: false,
          error: { code: 'invalid_idempotency_key', message: idempotencyError },
        }, 400);
      }

      const channelName = c.req.param('name');

      // Resolve channel name to ID
      const channel = await channelEngine.getChannel(db, workspace.id, channelName);
      if (!channel) {
        return c.json({
          ok: false,
          error: { code: 'channel_not_found', message: `Channel "${channelName}" not found` },
        }, 404);
      }

      // Determine agent ID (from agent token or body)
      const agentId = agent?.id;
      if (!agentId) {
        return c.json({
          ok: false,
          error: { code: 'agent_token_required', message: 'Agent token required to post messages' },
        }, 403);
      }

      const idempotent = await runIdempotent({
        workspaceId: workspace.id,
        actorId: agentId,
        scope: `channel-message:${channel.id}`,
        key: idempotencyKey,
        status: 201,
        fingerprint: JSON.stringify({ channelId: channel.id, text, blocks, attachments, data, content_type, mode }),
        kv: c.get('engine').kv,
        operation: () =>
          messageEngine.postMessage(
            db,
            workspace.id,
            channel.id,
            agentId,
            { text, blocks, attachments, data, content_type, mode },
          ),
      });

      if (idempotent.replayed) {
        c.header('Idempotency-Replayed', 'true');
      }

      // Durable event queue for webhook delivery; real-time pub/sub still fire-and-forget.
      // Only publish for fresh writes, not idempotent replays.
      if (!idempotent.replayed) {
        const { _deliveries, ...publicData } = idempotent.data as typeof idempotent.data & { _deliveries?: Array<{ id: string; agentId: string; reason: string }> };
        const eventData = {
          ...publicData,
          channel_name: channelName,
          from_name: agent?.name,
          injection_mode: publicData.injection_mode ?? mode,
        };
        runInBackground(c, fanoutToChannel(c, channel.id, 'message.created', eventData), 'fanout message.created');

        // Emit delivery.accepted to each recipient's AgentDO individually —
        // each agent sees only its own delivery entry, not other recipients'.
        if (_deliveries && _deliveries.length > 0) {
          for (const d of _deliveries) {
            runInBackground(
              c,
              fanoutToAgents(c, [d.agentId], 'delivery.accepted', {
                delivery_id: d.id,
                message_id: String(publicData.id),
                channel_id: channel.id,
                reason: d.reason,
              }),
              'fanout delivery.accepted',
            );
          }
        }

        runInBackground(
          c,
          c.get('engine').webhookQueue.send({ type: 'message.created', workspaceId: workspace.id, data: eventData }),
          'queue message.created',
        );
        emitServerEvent(c, workspace.id, 'relaycast_server_message_created', {
          channel_id: channel.id,
          message_id: String(publicData.id),
          message_kind: publicData.thread_id ? 'thread_reply' : 'channel_message',
          has_attachments: Boolean(publicData.has_attachments),
        });
      }

      // Strip internal _deliveries field before returning to client
      const { _deliveries: _drop, ...responseData } = idempotent.data as typeof idempotent.data & { _deliveries?: unknown };
      return c.json({ ok: true, data: responseData }, idempotent.status as any);
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, (error.status || 500) as any);
    }
  },
);

// GET /v1/channels/:name/messages - list messages
messageRoutes.get(
  '/channels/:name/messages',
  requireAuth,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const channelName = c.req.param('name');
      const channel = await channelEngine.getChannel(db, workspace.id, channelName);
      if (!channel) {
        return c.json({
          ok: false,
          error: { code: 'channel_not_found', message: `Channel "${channelName}" not found` },
        }, 404);
      }

      const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : undefined;
      const before = c.req.query('before');
      const after = c.req.query('after');

      const messages = await messageEngine.getMessages(
        db,
        workspace.id,
        channel.id,
        { limit, before, after },
      );
      return c.json({ ok: true, data: messages });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, (error.status || 500) as any);
    }
  },
);

// GET /v1/messages/:id - get single message
messageRoutes.get(
  '/messages/:id',
  requireAuth,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const messageId = c.req.param('id');
      const message = await messageEngine.getMessage(db, workspace.id, messageId);
      if (!message) {
        return c.json({
          ok: false,
          error: { code: 'message_not_found', message: 'Message not found' },
        }, 404);
      }
      return c.json({ ok: true, data: message });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, (error.status || 500) as any);
    }
  },
);
