import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { requireAgentToken } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { parseIdempotencyKey, runIdempotent } from '../middleware/idempotency.js';
import * as groupDmEngine from '../engine/groupDm.js';
import { and, eq, isNull } from 'drizzle-orm';
import { dmParticipants } from '../db/schema.js';
import { fanoutToAgents } from './fanout.js';
import { runInBackground } from './background.js';

export const groupDmRoutes = new Hono<AppEnv>();

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
      const { participants, name } = await c.req.json();
      if (!participants || !Array.isArray(participants) || participants.length < 1) {
        return c.json({
          ok: false,
          error: { code: 'invalid_request', message: 'participants array is required with at least 1 member' },
        }, 400);
      }

      const result = await groupDmEngine.createGroupDm(
        db,
        workspace.id,
        agent!.id,
        { participants, name },
      );
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
      const { text } = await c.req.json();
      if (!text || typeof text !== 'string') {
        return c.json({
          ok: false,
          error: { code: 'invalid_request', message: 'text is required' },
        }, 400);
      }

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
        fingerprint: JSON.stringify({ conversationId, text }),
        kv: c.env.KV,
        operation: () =>
          groupDmEngine.postGroupMessage(
            db,
            workspace.id,
            conversationId,
            agent!.id,
            { text },
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
      const { agent } = await c.req.json();
      if (!agent || typeof agent !== 'string') {
        return c.json({
          ok: false,
          error: { code: 'invalid_request', message: 'agent name is required' },
        }, 400);
      }

      const conversationId = c.req.param('conversation_id');
      const result = await groupDmEngine.addParticipant(
        db,
        workspace.id,
        conversationId,
        agentCtx!.id,
        agent,
      );
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
