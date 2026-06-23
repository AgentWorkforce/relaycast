import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { parseIdempotencyKey, runIdempotent } from '../middleware/idempotency.js';
import * as messageEngine from '../engine/message.js';
import * as channelEngine from '../engine/channel.js';
import * as triggerEngine from '../engine/trigger.js';
import { resolveMailboxConfig } from '../engine/mailboxConfig.js';
import { fanoutToChannel } from './fanout.js';
import { notifyDeliveryRejections, routeDeliveryOutcomes } from './deliveryRouting.js';
import { buildMessageCreatedEventData } from '../engine/deliveryWire.js';
import { runInBackground } from './background.js';
import { isFleetNodesEnabled } from '../lib/fleetNodes.js';
import { sendWebhookEvent } from './webhookOutbox.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';
import { errorResponse } from '../lib/httpError.js';
import {
  jsonError,
  jsonNotFound,
  jsonOk,
  parseJsonBody,
} from '../lib/httpResponse.js';

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
      const parsed = await parseJsonBody(c, postMessageSchema, 'text is required');
      if (!parsed.ok) {
        return parsed.response;
      }
      const { text, blocks, attachments, data, content_type, mode } = parsed.data;

      const { key: idempotencyKey, error: idempotencyError } = parseIdempotencyKey(c.req.header('Idempotency-Key'));
      if (idempotencyError) {
        return jsonError(c, 'invalid_idempotency_key', idempotencyError, 400);
      }

      const channelName = c.req.param('name');

      // Resolve channel name to ID
      const channel = await channelEngine.getChannel(db, workspace.id, channelName);
      if (!channel) {
        return jsonNotFound(c, 'channel_not_found', `Channel "${channelName}" not found`);
      }

      // Determine agent ID (from agent token or body)
      const agentId = agent?.id;
      if (!agentId) {
        return jsonError(c, 'agent_token_required', 'Agent token required to post messages', 403);
      }

      const mailbox = resolveMailboxConfig(c.get('engine').config, workspace.id);
      const toMessageCreatedEventData = (data: Awaited<ReturnType<typeof messageEngine.postMessage>>) => buildMessageCreatedEventData(data, {
        channelName,
        fromName: agent?.name ?? 'unknown',
        mode,
      });

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
            { mailbox },
          ),
        afterOperation: async (data) => {
          await sendWebhookEvent(c, {
            type: 'message.created',
            workspaceId: workspace.id,
            data: toMessageCreatedEventData(data),
          });
        },
      });

      if (idempotent.replayed) {
        c.header('Idempotency-Replayed', 'true');
      }

      // Durable event queue for webhook delivery; real-time pub/sub still fire-and-forget.
      // Only publish for fresh writes, not idempotent replays.
      if (!idempotent.replayed) {
        const {
          _deliveries,
          _delivery_rejections,
          ...publicData
        } = idempotent.data as typeof idempotent.data & {
          _deliveries?: Parameters<typeof routeDeliveryOutcomes>[1];
          _delivery_rejections?: Parameters<typeof notifyDeliveryRejections>[2];
        };
        const eventData = toMessageCreatedEventData(idempotent.data);
        runInBackground(c, fanoutToChannel(c, channel.id, 'message.created', eventData), 'fanout message.created');
        if (_deliveries && _deliveries.length > 0) {
          runInBackground(
            c,
            routeDeliveryOutcomes(c, _deliveries, 'message.created', eventData),
            'route message deliveries',
          );
        }
        if (_delivery_rejections && _delivery_rejections.length > 0) {
          runInBackground(
            c,
            notifyDeliveryRejections(c, agentId, _delivery_rejections),
            'fanout delivery rejected',
          );
        }

        emitServerEvent(c, workspace.id, 'relaycast_server_message_created', {
          channel_id: channel.id,
          message_id: String(publicData.id),
          message_kind: publicData.thread_id ? 'thread_reply' : 'channel_message',
          has_attachments: Boolean(publicData.has_attachments),
        });

        runInBackground(
          c,
          // Phase 6 rollout flag: declarative trigger evaluation is part of the
          // fleet node control surface, so it is skipped entirely when the flag is
          // off. Checked here (not per-trigger) so the policy lives at one boundary.
          (async () => {
            const { kv, config, nodeConnections } = c.get('engine');
            if (!(await isFleetNodesEnabled(kv, workspace.id, config.fleetNodesEnabled ?? false))) {
              return;
            }
            await triggerEngine.fireMessageTriggers({
              db,
              nodeConnections,
              workspaceId: workspace.id,
              message: {
                id: String(publicData.id),
                channel_id: channel.id,
                channel_name: channelName,
                agent_id: agentId,
                agent_name: agent?.name,
                text: String(publicData.text ?? text),
                mentions: Array.isArray(publicData.mentions) ? publicData.mentions as string[] : [],
                metadata: (publicData.metadata ?? null) as Record<string, unknown> | null,
                created_at: String(publicData.created_at),
              },
            });
          })(),
          'fire message triggers',
        );
      }

      // Strip internal _deliveries field before returning to client
      const {
        _deliveries: _dropDeliveries,
        _delivery_rejections: _dropRejections,
        ...responseData
      } = idempotent.data as typeof idempotent.data & {
        _deliveries?: unknown;
        _delivery_rejections?: unknown;
      };
      return jsonOk(c, responseData, idempotent.status as ContentfulStatusCode);
    } catch (err: unknown) {
      return errorResponse(c, err);
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
        return jsonNotFound(c, 'channel_not_found', `Channel "${channelName}" not found`);
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
      return jsonOk(c, messages);
    } catch (err: unknown) {
      return errorResponse(c, err);
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
        return jsonNotFound(c, 'message_not_found', 'Message not found');
      }
      return jsonOk(c, message);
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);
