import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { agents } from '../db/schema.js';
import type { AppEnv } from '../env.js';
import { requireSender, requireWorkspaceKey, requireWorkspaceRead } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { jsonIdempotentOk, parseIdempotencyKey, runIdempotent } from '../middleware/idempotency.js';
import * as messageEngine from '../engine/message.js';
import * as channelEngine from '../engine/channel.js';
import * as triggerEngine from '../engine/trigger.js';
import { resolveMailboxConfig } from '../engine/mailboxConfig.js';
import { publishWorkspaceEvent } from './fanout.js';
import { notifyDeliveryRejections, routeDeliveryOutcomes } from './deliveryRouting.js';
import { buildMessageCreatedEventData } from '../engine/deliveryWire.js';
import {
  getChannelObserverResource,
  getMessageObserverResource,
  getObserverTokenFromContext,
  observerAllowsChannel,
  observerAllowsMessageResource,
  observerAllowsMessage,
} from '../engine/observerToken.js';
import { runInBackground } from './background.js';
import { sendWebhookEvent } from './webhookOutbox.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';
import { errorResponse } from '../lib/httpError.js';
import {
  jsonError,
  jsonNotFound,
  jsonOk,
  parseJsonBody,
  parseQueryParams,
} from '../lib/httpResponse.js';
import { parsePaginationQuery, positiveIntQueryParam } from '../lib/httpQuery.js';
import {
  getMessagesBySessionRef,
  MAX_SESSION_REF_LENGTH,
  SESSION_MESSAGE_MAX_LIMIT,
} from '../engine/sessionMessages.js';

export const messageRoutes = new Hono<AppEnv>();

const postMessageSchema = z.object({
  text: z.string().min(1),
  blocks: z.array(z.unknown()).nullable().optional(),
  attachments: z.array(z.string()).optional(),
  data: z.record(z.string(), z.unknown()).nullable().optional(),
  content_type: z.string().optional(),
  mode: z.enum(['wait', 'steer']).default('wait'),
  // Node-token posts attribute the message to `from` — an agent name resolved
  // strictly within the node token's workspace. Agent-token posts must omit it.
  from: z.string().min(1).optional(),
});

const sessionMessagesQuerySchema = z.object({
  limit: positiveIntQueryParam({ max: SESSION_MESSAGE_MAX_LIMIT }),
  after: z.string().min(1).optional(),
});

type ValidationFailure = { error: { issues: Array<{ path: PropertyKey[] }> } };

function postMessageInvalidMessage(failure: ValidationFailure) {
  const field = failure.error.issues[0]?.path[0];
  if (field === 'text') return 'text is required';
  if (field === 'mode') return 'mode must be "wait" or "steer"';
  if (field === 'attachments') return 'attachments must be an array of strings';
  if (field === 'blocks') return 'blocks must be an array';
  if (field === 'data') return 'data must be an object';
  if (field === 'content_type') return 'content_type must be a string';
  return 'invalid message body';
}

// POST /v1/channels/:name/messages - post a message
messageRoutes.post(
  '/channels/:name/messages',
  requireSender,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const agent = c.get('agent');
      const node = c.get('node');
      const parsed = await parseJsonBody(c, postMessageSchema, postMessageInvalidMessage);
      if (!parsed.ok) {
        return parsed.response;
      }
      const { text, blocks, attachments, data, content_type, mode, from } = parsed.data;

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

      // Resolve the sender. An agent token posts as itself; a node token posts
      // as `from`, an agent resolved strictly within the node's workspace (so a
      // node credential can never attribute a message to another workspace).
      let senderAgentId: string;
      let senderAgentName: string;
      if (agent) {
        if (from !== undefined) {
          return jsonError(c, 'from_not_allowed', '"from" is only valid with a node token', 400);
        }
        senderAgentId = agent.id;
        senderAgentName = agent.name;
      } else if (node) {
        if (!from) {
          return jsonError(c, 'from_required', 'A node token must set "from" (an agent name in the node workspace)', 400);
        }
        const [fromAgent] = await db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(and(eq(agents.workspaceId, workspace.id), eq(agents.name, from)));
        if (!fromAgent) {
          return jsonNotFound(c, 'agent_not_found', `Agent "${from}" not found in this workspace`);
        }
        senderAgentId = fromAgent.id;
        senderAgentName = fromAgent.name;
      } else {
        return jsonError(c, 'agent_token_required', 'Agent or node token required to post messages', 403);
      }

      const mailbox = resolveMailboxConfig(c.get('engine').config, workspace.id);
      const toMessageCreatedEventData = (data: Awaited<ReturnType<typeof messageEngine.postMessage>>) => buildMessageCreatedEventData(data, {
        channelName,
        fromName: senderAgentName,
        mode,
      });

      const idempotent = await runIdempotent({
        workspaceId: workspace.id,
        actorId: senderAgentId,
        scope: `channel-message:${channel.id}`,
        key: idempotencyKey,
        status: 201,
        fingerprint: JSON.stringify({ channelId: channel.id, text, blocks, attachments, data, content_type, mode, from }),
        kv: c.get('engine').kv,
        operation: () =>
          messageEngine.postMessage(
            db,
            workspace.id,
            channel.id,
            senderAgentId,
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
        runInBackground(c, publishWorkspaceEvent(c, 'message.created', eventData, channel.id), 'publish message.created');
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
            notifyDeliveryRejections(c, senderAgentId, _delivery_rejections),
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
          (async () => {
            const { nodeConnections } = c.get('engine');
            await triggerEngine.fireMessageTriggers({
              db,
              nodeConnections,
              workspaceId: workspace.id,
              message: {
                id: String(publicData.id),
                channel_id: channel.id,
                channel_name: channelName,
                agent_id: senderAgentId,
                agent_name: senderAgentName,
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

      return jsonIdempotentOk(c, idempotent);
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);

// GET /v1/sessions/:session_ref/messages - bounded, indexed replay slice.
// A full workspace key is required because one session can span channels and
// DMs; scoped observer-token filters cannot safely authorize that aggregate.
messageRoutes.get(
  '/sessions/:session_ref/messages',
  requireWorkspaceKey,
  rateLimit,
  async (c) => {
    const sessionRef = c.req.param('session_ref');
    if (sessionRef.length === 0 || sessionRef.length > MAX_SESSION_REF_LENGTH) {
      return jsonError(
        c,
        'invalid_session_ref',
        `session_ref must contain between 1 and ${MAX_SESSION_REF_LENGTH} characters`,
        400,
      );
    }
    const query = parseQueryParams(c, sessionMessagesQuerySchema, 'Invalid session message query');
    if (!query.ok) return query.response;

    const result = await getMessagesBySessionRef(
      c.get('db'),
      c.get('workspace').id,
      sessionRef,
      {
        limit: query.data.limit,
        after: query.data.after,
        deploymentMessageTtlDays: c.get('engine').config.retention?.messageTtlDays,
      },
    );
    return jsonOk(c, result);
  },
);

// GET /v1/channels/:name/messages - list messages
messageRoutes.get(
  '/channels/:name/messages',
  requireWorkspaceRead('messages:read'),
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const channelName = c.req.param('name');
      const observer = getObserverTokenFromContext(c);
      if (observer) {
        const resource = await getChannelObserverResource(db, workspace.id, channelName);
        if (!resource || !observerAllowsChannel(observer, resource)) {
          return jsonNotFound(c, 'channel_not_found', `Channel "${channelName}" not found`);
        }
      }
      const channel = await channelEngine.getChannel(db, workspace.id, channelName);
      if (!channel) {
        return jsonNotFound(c, 'channel_not_found', `Channel "${channelName}" not found`);
      }

      const query = parsePaginationQuery(c);
      if (!query.ok) {
        return query.response;
      }
      const { limit, before, after } = query.data;

      const messages = await messageEngine.getMessages(
        db,
        workspace.id,
        channel.id,
        { limit, before, after },
      );
      return jsonOk(c, messages.filter((message) => observerAllowsMessage(observer, message)));
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);

// GET /v1/messages/:id - get single message
messageRoutes.get(
  '/messages/:id',
  requireWorkspaceRead(['messages:read', 'dms:read']),
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const messageId = c.req.param('id');
      const observer = getObserverTokenFromContext(c);
      if (observer) {
        const resource = await getMessageObserverResource(db, workspace.id, messageId);
        if (!resource) {
          return jsonNotFound(c, 'message_not_found', 'Message not found');
        }
        if (!observerAllowsMessageResource(observer, resource, { normalScope: 'messages:read' })) {
          return jsonNotFound(c, 'message_not_found', 'Message not found');
        }
      }
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
