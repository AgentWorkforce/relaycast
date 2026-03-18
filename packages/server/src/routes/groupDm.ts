import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireAgentToken } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { parseIdempotencyKey, runIdempotent } from '../middleware/idempotency.js';
import * as groupDmEngine from '../engine/groupDm.js';
import { and, eq, isNull } from 'drizzle-orm';
import { dmParticipants } from '../db/schema.js';
import { fanoutToAgents } from './fanout.js';
import { runInBackground } from './background.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';

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
      const parsed = createGroupDmSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        return c.json({
          ok: false,
          error: { code: 'invalid_request', message: 'participants array is required with at least 1 member' },
        }, 400);
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
      return c.json({ ok: true, data: result }, 201);
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, (error.status || 500) as any);
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
      const parsed = postGroupDmMessageSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        const hasTextIssue = parsed.error.issues.some((issue) => issue.path[0] === 'text');
        const hasModeIssue = parsed.error.issues.some((issue) => issue.path[0] === 'mode');
        const hasAttachmentsIssue = parsed.error.issues.some((issue) => issue.path[0] === 'attachments');
        const message = hasTextIssue
          ? 'text is required'
          : hasModeIssue
            ? 'mode must be one of: wait, steer'
            : hasAttachmentsIssue
              ? 'attachments must be an array of file ids'
              : 'invalid group dm body';
        return c.json({
          ok: false,
          error: { code: 'invalid_request', message },
        }, 400);
      }
      const { text, attachments, mode } = parsed.data;

      const { key: idempotencyKey, error: idempotencyError } = parseIdempotencyKey(c.req.header('Idempotency-Key'));
      if (idempotencyError) {
        return c.json({
          ok: false,
          error: { code: 'invalid_idempotency_key', message: idempotencyError },
        }, 400);
      }

      const conversationId = c.req.param('conversation_id');
      const idempotent = await runIdempotent({
        workspaceId: workspace.id,
        actorId: agent!.id,
        scope: `dm-group-message:${conversationId}`,
        key: idempotencyKey,
        status: 201,
        fingerprint: mode === 'steer'
          ? JSON.stringify({ conversationId, text, attachments, mode })
          : JSON.stringify({ conversationId, text, attachments }),
        kv: c.env.KV,
        operation: () =>
          groupDmEngine.postGroupMessage(
            db,
            workspace.id,
            conversationId,
            agent!.id,
            { text, attachments, mode },
          ),
      });

      if (idempotent.replayed) {
        c.header('Idempotency-Replayed', 'true');
      }

      if (!idempotent.replayed) {
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
          const eventData = { ...idempotent.data, from_name: agent!.name };
          runInBackground(
            c,
            fanoutToAgents(c, rows.map((r) => r.agentId), 'group_dm.received', eventData),
            'fanout group_dm.received',
          );
        } catch {
          // Ignore fanout failures
        }

        runInBackground(
          c,
          c.env.WEBHOOK_QUEUE.send({
            type: 'group_dm.received',
            workspaceId: workspace.id,
            data: { ...idempotent.data, from_name: agent!.name },
          }),
          'queue group_dm.received',
        );
        emitServerEvent(c, workspace.id, 'relaycast_server_group_dm_message_sent', {
          conversation_id: idempotent.data.conversation_id,
          message_id: idempotent.data.id,
          from_agent_id: agent!.id,
        });
      }

      return c.json({ ok: true, data: idempotent.data }, idempotent.status as any);
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, (error.status || 500) as any);
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
      const parsed = addGroupDmParticipantSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        return c.json({
          ok: false,
          error: { code: 'invalid_request', message: 'agent_name is required' },
        }, 400);
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
