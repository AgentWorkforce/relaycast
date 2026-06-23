import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { errorResponse } from '../lib/httpError.js';
import { requireAgentToken } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { parseIdempotencyKey, runIdempotent } from '../middleware/idempotency.js';
import * as groupDmEngine from '../engine/groupDm.js';
import { resolveMailboxConfig } from '../engine/mailboxConfig.js';
import { and, eq, isNull } from 'drizzle-orm';
import { dmParticipants } from '../db/schema.js';
import { fanoutToAgents } from './fanout.js';
import { notifyDeliveryRejections, routeDeliveryOutcomes } from './deliveryRouting.js';
import { buildGroupDmReceivedEventData } from '../engine/deliveryWire.js';
import { runInBackground } from './background.js';
import { sendWebhookEvent } from './webhookOutbox.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';
import {
  jsonCreated,
  jsonError,
  jsonNoContent,
  jsonOk,
  parseJsonBody,
} from '../lib/httpResponse.js';

export const groupDmRoutes = new Hono<AppEnv>();

const createGroupDmSchema = z.object({
  participants: z.array(z.string()).min(1),
  name: z.string().optional(),
});

const postGroupDmMessageSchema = z.object({
  text: z.string().min(1),
  attachments: z.array(z.string()).optional(),
  mode: z.enum(['wait', 'steer']).default('wait'),
});

const addGroupDmParticipantSchema = z.object({
  agent_name: z.string().min(1),
});

// POST /v1/dm/group - create a group DM
groupDmRoutes.post(
  '/dm/group',
  requireAgentToken,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const agent = c.get('agent');
      const parsed = await parseJsonBody(
        c,
        createGroupDmSchema,
        'participants array is required with at least 1 member',
      );
      if (!parsed.ok) {
        return parsed.response;
      }
      const { participants, name } = parsed.data;

      const result = await groupDmEngine.createGroupDm(
        db,
        workspace.id,
        agent!.id,
        { participants, name },
      );
      emitServerEvent(c, workspace.id, 'relaycast_server_group_dm_created', {
        conversation_id: result.id,
        participant_count: result.participants.length,
      });
      return jsonCreated(c, result);
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);

// POST /v1/dm/:conversation_id/messages - post to group DM
groupDmRoutes.post(
  '/dm/:conversation_id/messages',
  requireAgentToken,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const agent = c.get('agent');
      const parsed = await parseJsonBody(c, postGroupDmMessageSchema, (failure) => {
        const hasTextIssue = failure.error.issues.some((issue) => issue.path[0] === 'text');
        const hasModeIssue = failure.error.issues.some((issue) => issue.path[0] === 'mode');
        const hasAttachmentsIssue = failure.error.issues.some((issue) => issue.path[0] === 'attachments');
        return hasTextIssue
          ? 'text is required'
          : hasModeIssue
            ? 'mode must be one of: wait, steer'
            : hasAttachmentsIssue
              ? 'attachments must be an array of file ids'
              : 'invalid group dm body';
      });
      if (!parsed.ok) {
        return parsed.response;
      }
      const { text, attachments, mode } = parsed.data;
      const normalizedAttachments = attachments && attachments.length > 0 ? attachments : undefined;

      const { key: idempotencyKey, error: idempotencyError } = parseIdempotencyKey(c.req.header('Idempotency-Key'));
      if (idempotencyError) {
        return jsonError(c, 'invalid_idempotency_key', idempotencyError, 400);
      }

      const conversationId = c.req.param('conversation_id');
      const mailbox = resolveMailboxConfig(c.get('engine').config, workspace.id);
      const toGroupDmReceivedEventData = (data: Awaited<ReturnType<typeof groupDmEngine.postGroupMessage>>) => buildGroupDmReceivedEventData(data, {
        fromName: agent!.name,
      });

      const idempotent = await runIdempotent({
        workspaceId: workspace.id,
        actorId: agent!.id,
        scope: `dm-group-message:${conversationId}`,
        key: idempotencyKey,
        status: 201,
        fingerprint: mode === 'steer'
          ? JSON.stringify({ conversationId, text, ...(normalizedAttachments ? { attachments: normalizedAttachments } : {}), mode })
          : JSON.stringify({ conversationId, text, ...(normalizedAttachments ? { attachments: normalizedAttachments } : {}) }),
        kv: c.get('engine').kv,
        operation: () =>
          groupDmEngine.postGroupMessage(
            db,
            workspace.id,
            conversationId,
            agent!.id,
            {
              text,
              attachments: normalizedAttachments,
              mode,
            },
            { mailbox },
          ),
        afterOperation: async (data) => {
          await sendWebhookEvent(c, {
            type: 'group_dm.received',
            workspaceId: workspace.id,
            data: toGroupDmReceivedEventData(data),
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
          ...publicGroupData
        } = idempotent.data as typeof idempotent.data & {
          _deliveries?: Parameters<typeof routeDeliveryOutcomes>[1];
          _delivery_rejections?: Parameters<typeof notifyDeliveryRejections>[2];
        };
        const eventData = toGroupDmReceivedEventData(idempotent.data);
        try {
          const rows = await db
            .select({ agentId: dmParticipants.agentId })
            .from(dmParticipants)
            .where(
              and(
                eq(dmParticipants.conversationId, conversationId),
                isNull(dmParticipants.leftAt),
              ),
            );
          runInBackground(
            c,
            fanoutToAgents(c, rows.map((r) => r.agentId), 'group_dm.received', eventData),
            'fanout group_dm.received',
          );
        } catch {
          // Ignore fanout failures
        }

        if (_deliveries && _deliveries.length > 0) {
          runInBackground(
            c,
            routeDeliveryOutcomes(c, _deliveries, 'group_dm.received', eventData),
            'route group dm deliveries',
          );
        }
        if (_delivery_rejections && _delivery_rejections.length > 0) {
          runInBackground(
            c,
            notifyDeliveryRejections(c, agent!.id, _delivery_rejections),
            'fanout delivery rejected',
          );
        }

        emitServerEvent(c, workspace.id, 'relaycast_server_group_dm_message_sent', {
          conversation_id: publicGroupData.conversation_id,
          message_id: publicGroupData.id,
          from_agent_id: agent!.id,
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
      return jsonOk(c, responseData, idempotent.status as ContentfulStatusCode);
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);

// POST /v1/dm/:conversation_id/participants - add participant
groupDmRoutes.post(
  '/dm/:conversation_id/participants',
  requireAgentToken,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const agentCtx = c.get('agent');
      const parsed = await parseJsonBody(c, addGroupDmParticipantSchema, 'agent_name is required');
      if (!parsed.ok) {
        return parsed.response;
      }
      const { agent_name: agentName } = parsed.data;

      const conversationId = c.req.param('conversation_id');
      const result = await groupDmEngine.addParticipant(
        db,
        workspace.id,
        conversationId,
        agentCtx!.id,
        agentName,
      );
      emitServerEvent(c, workspace.id, 'relaycast_server_group_dm_participant_added', {
        conversation_id: conversationId,
        agent_name: agentName,
        invited_by_agent_id: agentCtx!.id,
      });
      return jsonOk(c, result);
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);

// DELETE /v1/dm/:conversation_id/participants/:agent_name - remove participant (leave)
groupDmRoutes.delete(
  '/dm/:conversation_id/participants/:agent_name',
  requireAgentToken,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const agent = c.get('agent');
      const conversationId = c.req.param('conversation_id');
      await groupDmEngine.removeParticipant(
        db,
        workspace.id,
        conversationId,
        agent!.id,
      );
      emitServerEvent(c, workspace.id, 'relaycast_server_group_dm_participant_removed', {
        conversation_id: conversationId,
        agent_id: agent!.id,
      });
      return jsonNoContent(c);
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);
