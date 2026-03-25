import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { parseIdempotencyKey, runIdempotent } from '../middleware/idempotency.js';
import * as threadEngine from '../engine/thread.js';
import { fanoutToChannel, fanoutToAgents, getDmParticipantAgentIds } from './fanout.js';
import { runInBackground } from './background.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';

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
      const idempotent = await runIdempotent({
        workspaceId: workspace.id,
        actorId: agentId,
        scope: `thread-reply:${parentId}`,
        key: idempotencyKey,
        status: 201,
        fingerprint: JSON.stringify({ parentId, text, blocks, data }),
        kv: c.env.KV,
        operation: () =>
          threadEngine.postReply(
            db,
            workspace.id,
            parentId,
            agentId,
            { text, blocks, data },
          ),
      });

      if (idempotent.replayed) {
        c.header('Idempotency-Replayed', 'true');
      }

      if (!idempotent.replayed) {
        const eventData = { ...idempotent.data, from_name: agent?.name };
        if (idempotent.data.channel_id) {
          const channelId = idempotent.data.channel_id;
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

        runInBackground(
          c,
          c.env.WEBHOOK_QUEUE.send({
            type: 'thread.reply',
            workspaceId: workspace.id,
            data: eventData,
          }),
          'queue thread.reply',
        );
        emitServerEvent(c, workspace.id, 'relaycast_server_thread_reply_created', {
          message_id: idempotent.data.id,
          parent_message_id: parentId,
          channel_id: idempotent.data.channel_id ?? null,
        });
      }

      return c.json({ ok: true, data: idempotent.data }, idempotent.status as ContentfulStatusCode);
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, (error.status || 500) as ContentfulStatusCode);
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
      const error = err as Error & { code?: string; status?: number };
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, (error.status || 500) as ContentfulStatusCode);
    }
  },
);
