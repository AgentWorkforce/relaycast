import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { parseIdempotencyKey, runIdempotent } from '../middleware/idempotency.js';
import * as threadEngine from '../engine/thread.js';
import { resolveMailboxConfig } from '../engine/mailboxConfig.js';
import { fanoutToChannel, fanoutToAgents, getDmParticipantAgentIds } from './fanout.js';
import { notifyDeliveryRejections, routeDeliveryOutcomes } from './deliveryRouting.js';
import { buildThreadReplyEventData } from '../engine/deliveryWire.js';
import { runInBackground } from './background.js';
import { sendWebhookEvent } from './webhookOutbox.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';
import { errorResponse } from '../lib/httpError.js';

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
      const parsed = postReplySchema.safeParse(await c.req.json());
      if (!parsed.success) {
        return c.json({
          ok: false,
          error: { code: 'invalid_request', message: 'text is required' },
        }, 400);
      }
      const { text, blocks, data } = parsed.data;

      const { key: idempotencyKey, error: idempotencyError } = parseIdempotencyKey(c.req.header('Idempotency-Key'));
      if (idempotencyError) {
        return c.json({
          ok: false,
          error: { code: 'invalid_idempotency_key', message: idempotencyError },
        }, 400);
      }

      const agentId = agent?.id;
      if (!agentId) {
        return c.json({
          ok: false,
          error: { code: 'agent_token_required', message: 'Agent token required to post replies' },
        }, 403);
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

      if (idempotent.replayed) {
        c.header('Idempotency-Replayed', 'true');
      }

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
          const channelId = publicReplyData.channel_id;
          runInBackground(
            c,
            (async () => {
              const dmAgentIds = await getDmParticipantAgentIds(c, channelId);
              if (dmAgentIds) {
                await fanoutToAgents(c, dmAgentIds, 'thread.reply', eventData);
              } else {
                await fanoutToChannel(c, channelId, 'thread.reply', eventData);
              }
            })(),
            'fanout thread.reply',
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

      const {
        _deliveries: _dropDeliveries,
        _delivery_rejections: _dropRejections,
        ...responseData
      } = idempotent.data as typeof idempotent.data & {
        _deliveries?: unknown;
        _delivery_rejections?: unknown;
      };
      return c.json({ ok: true, data: responseData }, idempotent.status as ContentfulStatusCode);
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);

// GET /v1/messages/:id/replies - get thread
threadRoutes.get(
  '/messages/:id/replies',
  requireAuth,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : undefined;
      const before = c.req.query('before');
      const after = c.req.query('after');

      const parentId = c.req.param('id');
      const result = await threadEngine.getThread(
        db,
        workspace.id,
        parentId,
        { limit, before, after },
      );
      return c.json({ ok: true, data: result });
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);
