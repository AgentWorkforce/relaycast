import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireAuth, requireWorkspaceRead } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { jsonIdempotentOk, parseIdempotencyKey, runIdempotent } from '../middleware/idempotency.js';
import * as threadEngine from '../engine/thread.js';
import { resolveMailboxConfig } from '../engine/mailboxConfig.js';
import { publishWorkspaceEvent } from './fanout.js';
import { notifyDeliveryRejections, routeDeliveryOutcomes } from './deliveryRouting.js';
import { buildThreadReplyEventData } from '../engine/deliveryWire.js';
import {
  getMessageObserverResource,
  getObserverTokenFromContext,
  observerAllowsChannel,
  observerAllowsConversation,
} from '../engine/observerToken.js';
import { runInBackground } from './background.js';
import { sendWebhookEvent } from './webhookOutbox.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';
import { errorResponse } from '../lib/httpError.js';
import { jsonError, jsonOk, parseJsonBody } from '../lib/httpResponse.js';
import { parsePaginationQuery } from '../lib/httpQuery.js';

export const threadRoutes = new Hono<AppEnv>();

const postReplySchema = z.object({
  text: z.string().min(1),
  blocks: z.array(z.unknown()).nullable().optional(),
  data: z.record(z.string(), z.unknown()).nullable().optional(),
});

// POST /v1/messages/:id/replies - post a reply
threadRoutes.post(
  '/messages/:id/replies',
  requireAuth,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const agent = c.get('agent');
      const parsed = await parseJsonBody(c, postReplySchema, 'invalid reply body');
      if (!parsed.ok) {
        return parsed.response;
      }
      const { text, blocks, data } = parsed.data;

      const { key: idempotencyKey, error: idempotencyError } = parseIdempotencyKey(c.req.header('Idempotency-Key'));
      if (idempotencyError) {
        return jsonError(c, 'invalid_idempotency_key', idempotencyError, 400);
      }

      const agentId = agent?.id;
      if (!agentId) {
        return jsonError(c, 'agent_token_required', 'Agent token required to post replies', 403);
      }

      const parentId = c.req.param('id');
      const mailbox = resolveMailboxConfig(c.get('engine').config, workspace.id);
      const toThreadReplyEventData = (data: Awaited<ReturnType<typeof threadEngine.postReply>>) => buildThreadReplyEventData(data, {
        channelName: data.channel_name ?? '',
        fromName: agent?.name ?? 'unknown',
      });

      const idempotent = await runIdempotent({
        workspaceId: workspace.id,
        actorId: agentId,
        scope: `thread-reply:${parentId}`,
        key: idempotencyKey,
        status: 201,
        fingerprint: JSON.stringify({ parentId, text, blocks, data }),
        kv: c.get('engine').kv,
        operation: () =>
          threadEngine.postReply(
            db,
            workspace.id,
            parentId,
            agentId,
            { text, blocks, data },
            { mailbox },
          ),
        afterOperation: async (data) => {
          await sendWebhookEvent(c, {
            type: 'thread.reply',
            workspaceId: workspace.id,
            data: toThreadReplyEventData(data),
          });
        },
      });

      if (!idempotent.replayed) {
        const {
          _deliveries,
          _delivery_rejections,
          ...publicReplyData
        } = idempotent.data as typeof idempotent.data & {
          _deliveries?: Parameters<typeof routeDeliveryOutcomes>[1];
          _delivery_rejections?: Parameters<typeof notifyDeliveryRejections>[2];
        };
        const eventData = toThreadReplyEventData(idempotent.data);
        if (publicReplyData.channel_id) {
          runInBackground(
            c,
            publishWorkspaceEvent(c, 'thread.reply', eventData, publicReplyData.channel_id),
            'publish thread.reply',
          );
        }

        if (_deliveries && _deliveries.length > 0) {
          runInBackground(
            c,
            routeDeliveryOutcomes(c, _deliveries, 'thread.reply', eventData),
            'route thread deliveries',
          );
        }
        if (_delivery_rejections && _delivery_rejections.length > 0) {
          runInBackground(
            c,
            notifyDeliveryRejections(c, agentId, _delivery_rejections),
            'fanout delivery rejected',
          );
        }

        emitServerEvent(c, workspace.id, 'relaycast_server_thread_reply_created', {
          message_id: publicReplyData.id,
          parent_message_id: parentId,
          channel_id: publicReplyData.channel_id ?? null,
        });
      }

      return jsonIdempotentOk(c, idempotent);
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);

// GET /v1/messages/:id/replies - get thread
threadRoutes.get(
  '/messages/:id/replies',
  requireWorkspaceRead('threads:read'),
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const query = parsePaginationQuery(c);
      if (!query.ok) {
        return query.response;
      }
      const { limit, before, after } = query.data;

      const parentId = c.req.param('id');
      const observer = getObserverTokenFromContext(c);
      if (observer) {
        const resource = await getMessageObserverResource(db, workspace.id, parentId);
        if (!resource) {
          return jsonError(c, 'message_not_found', 'Parent message not found', 404);
        }
        const allowed = resource.conversation_id
          ? observerAllowsConversation(observer, resource.conversation_id)
          : observerAllowsChannel(observer, { id: resource.channel_id, name: resource.channel_name });
        if (!allowed) {
          return jsonError(c, 'message_not_found', 'Parent message not found', 404);
        }
      }
      const result = await threadEngine.getThread(
        db,
        workspace.id,
        parentId,
        { limit, before, after },
      );
      return jsonOk(c, result);
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);
