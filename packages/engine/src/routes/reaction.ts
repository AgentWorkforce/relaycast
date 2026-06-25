import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireAgentToken, requireWorkspaceRead } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as reactionEngine from '../engine/reaction.js';
import { and, eq } from 'drizzle-orm';
import { channels, messages } from '../db/schema.js';
import {
  getMessageObserverResource,
  getObserverTokenFromContext,
  observerAllowsChannel,
  observerAllowsConversation,
} from '../engine/observerToken.js';
import { fanoutToChannel, fanoutToAgents, getDmParticipantAgentIds } from './fanout.js';
import { sendNodeDeliveriesForChannel } from '../engine/nodeDeliver.js';
import { runInBackground } from './background.js';
import { sendWebhookEvent } from './webhookOutbox.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';
import { errorResponse } from '../lib/httpError.js';
import {
  jsonCreated,
  jsonNoContent,
  jsonNotFound,
  jsonOk,
  parseJsonBody,
} from '../lib/httpResponse.js';

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
      const parsed = await parseJsonBody(c, addReactionSchema, 'emoji is required');
      if (!parsed.ok) {
        return parsed.response;
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
        return jsonNotFound(c, 'message_not_found', 'Message not found');
      }

      // Strip internal channel_id/channel_name before sending to client
      const { channel_id, channel_name, ...reactionData } = result;

      const eventData = { ...reactionData, channel_name, agent_name: agent!.name, action: 'added' };
      if (channel_id) {
        runInBackground(
          c,
          (async () => {
            const dmAgentIds = await getDmParticipantAgentIds(c, channel_id);
            if (dmAgentIds) {
              await fanoutToAgents(c, dmAgentIds, 'message.reacted', eventData);
            } else {
              await fanoutToChannel(c, channel_id, 'message.reacted', eventData);
            }
          })(),
          'fanout message.reacted',
        );
        runInBackground(
          c,
          sendNodeDeliveriesForChannel(
            {
              db,
              nodeConnections: c.get('engine').nodeConnections,
              workspaceId: workspace.id,
            },
            {
              channelId: channel_id,
              messageId: c.req.param('id'),
              event: 'message.reacted',
              eventKey: reactionData.id,
              data: eventData,
            },
          ),
          'node deliver message.reacted',
        );
      }
      await sendWebhookEvent(c, {
        type: 'message.reacted',
        workspaceId: workspace.id,
        data: { ...reactionData, channel_id, channel_name, agent_name: agent!.name, action: 'added' },
      });
      emitServerEvent(c, workspace.id, 'relaycast_server_reaction_added', {
        message_id: c.req.param('id'),
        emoji,
        channel_id: channel_id ?? null,
      });

      return jsonCreated(c, reactionData);
    } catch (err: unknown) {
      return errorResponse(c, err);
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
        return jsonNotFound(c, 'message_not_found', 'Message not found');
      }

      const eventData = {
        message_id: c.req.param('id'),
        emoji: c.req.param('emoji'),
        agent_id: agent!.id,
        agent_name: agent!.name,
        action: 'removed',
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
                await fanoutToAgents(c, dmAgentIds, 'message.reacted', enriched);
              } else {
                await fanoutToChannel(c, row.channelId, 'message.reacted', enriched);
              }
            })(),
            'fanout message.reacted',
          );
          runInBackground(
            c,
            sendNodeDeliveriesForChannel(
              {
                db,
                nodeConnections: c.get('engine').nodeConnections,
                workspaceId: workspace.id,
              },
              {
                channelId: row.channelId,
                messageId: c.req.param('id'),
                event: 'message.reacted',
                eventKey: `removed:${c.req.param('id')}:${agent!.id}:${Date.now()}`,
                data: enriched,
              },
            ),
            'node deliver message.reacted',
          );
        }
      } catch {
        // Ignore fanout failures
      }

      await sendWebhookEvent(c, {
        type: 'message.reacted',
        workspaceId: workspace.id,
        data: eventData,
      });
      emitServerEvent(c, workspace.id, 'relaycast_server_reaction_removed', {
        message_id: c.req.param('id'),
        emoji: c.req.param('emoji'),
      });

      return jsonNoContent(c);
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);

// GET /v1/messages/:id/reactions - aggregated reactions
reactionRoutes.get(
  '/messages/:id/reactions',
  requireWorkspaceRead(['messages:read', 'reactions:read']),
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const observer = getObserverTokenFromContext(c);
      if (observer) {
        const resource = await getMessageObserverResource(db, workspace.id, c.req.param('id'));
        if (!resource) {
          return jsonNotFound(c, 'message_not_found', 'Message not found');
        }
        const allowed = resource.conversation_id
          ? observerAllowsConversation(observer, resource.conversation_id)
          : observerAllowsChannel(observer, { id: resource.channel_id, name: resource.channel_name });
        if (!allowed) {
          return jsonNotFound(c, 'message_not_found', 'Message not found');
        }
      }
      const result = await reactionEngine.getReactions(
        db,
        workspace.id,
        c.req.param('id'),
      );
      if (result === null) {
        return jsonNotFound(c, 'message_not_found', 'Message not found');
      }

      return jsonOk(c, result);
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);
