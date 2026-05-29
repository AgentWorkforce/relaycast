import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireAuth, requireAgentToken } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as reactionEngine from '../engine/reaction.js';
import { and, eq } from 'drizzle-orm';
import { channels, messages } from '../db/schema.js';
import { fanoutToChannel, fanoutToAgents, getDmParticipantAgentIds } from './fanout.js';
import { runInBackground } from './background.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';

export const reactionRoutes = new Hono<AppEnv>();

const addReactionSchema = z.object({
  emoji: z.string().min(1),
});

// POST /v1/messages/:id/reactions - add reaction (idempotent)
reactionRoutes.post(
  '/messages/:id/reactions',
  requireAgentToken,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const agent = c.get('agent');
      const parsed = addReactionSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        return c.json({
          ok: false,
          error: { code: 'invalid_request', message: 'emoji is required' },
        }, 400);
      }
      const { emoji } = parsed.data;

      const result = await reactionEngine.addReaction(
        db,
        workspace.id,
        c.req.param('id'),
        agent!.id,
        emoji,
      );
      if (!result) {
        return c.json({
          ok: false,
          error: { code: 'message_not_found', message: 'Message not found' },
        }, 404);
      }

      // Strip internal channel_id/channel_name before sending to client
      const { channel_id, channel_name, ...reactionData } = result;

      const eventData = { ...reactionData, channel_name, agent_name: agent!.name };
      if (channel_id) {
        runInBackground(
          c,
          (async () => {
            const dmAgentIds = await getDmParticipantAgentIds(c, channel_id);
            if (dmAgentIds) {
              await fanoutToAgents(c, dmAgentIds, 'reaction.added', eventData);
            } else {
              await fanoutToChannel(c, channel_id, 'reaction.added', eventData);
            }
          })(),
          'fanout reaction.added',
        );
      }
      runInBackground(
        c,
        c.get('engine').webhookQueue.send({
          type: 'reaction.added',
          workspaceId: workspace.id,
          data: { ...reactionData, channel_id, channel_name, agent_name: agent!.name },
        }),
        'queue reaction.added',
      );
      emitServerEvent(c, workspace.id, 'relaycast_server_reaction_added', {
        message_id: c.req.param('id'),
        emoji,
        channel_id: channel_id ?? null,
      });

      return c.json({ ok: true, data: reactionData }, 201);
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, (error.status || 500) as any);
    }
  },
);

// DELETE /v1/messages/:id/reactions/:emoji - remove own reaction
reactionRoutes.delete(
  '/messages/:id/reactions/:emoji',
  requireAgentToken,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const agent = c.get('agent');
      const result = await reactionEngine.removeReaction(
        db,
        workspace.id,
        c.req.param('id'),
        agent!.id,
        c.req.param('emoji'),
      );
      if (result === null) {
        return c.json({
          ok: false,
          error: { code: 'message_not_found', message: 'Message not found' },
        }, 404);
      }

      const eventData = {
        message_id: c.req.param('id'),
        emoji: c.req.param('emoji'),
        agent_id: agent!.id,
        agent_name: agent!.name,
      };
      try {
        const [row] = await db
          .select({ channelId: messages.channelId, channelName: channels.name })
          .from(messages)
          .innerJoin(channels, eq(messages.channelId, channels.id))
          .where(and(eq(messages.id, c.req.param('id')), eq(channels.workspaceId, workspace.id)));
        if (row?.channelId) {
          const enriched = { ...eventData, channel_name: row.channelName };
          runInBackground(
            c,
            (async () => {
              const dmAgentIds = await getDmParticipantAgentIds(c, row.channelId);
              if (dmAgentIds) {
                await fanoutToAgents(c, dmAgentIds, 'reaction.removed', enriched);
              } else {
                await fanoutToChannel(c, row.channelId, 'reaction.removed', enriched);
              }
            })(),
            'fanout reaction.removed',
          );
        }
      } catch {
        // Ignore fanout failures
      }

      runInBackground(
        c,
        c.get('engine').webhookQueue.send({
          type: 'reaction.removed',
          workspaceId: workspace.id,
          data: eventData,
        }),
        'queue reaction.removed',
      );
      emitServerEvent(c, workspace.id, 'relaycast_server_reaction_removed', {
        message_id: c.req.param('id'),
        emoji: c.req.param('emoji'),
      });

      return c.body(null, 204);
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, (error.status || 500) as any);
    }
  },
);

// GET /v1/messages/:id/reactions - aggregated reactions
reactionRoutes.get(
  '/messages/:id/reactions',
  requireAuth,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const result = await reactionEngine.getReactions(
        db,
        workspace.id,
        c.req.param('id'),
      );
      if (result === null) {
        return c.json({
          ok: false,
          error: { code: 'message_not_found', message: 'Message not found' },
        }, 404);
      }

      return c.json({ ok: true, data: result });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, (error.status || 500) as any);
    }
  },
);
