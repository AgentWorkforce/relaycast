import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { AgentTypeSchema } from '@relaycast/types';
import type { AppEnv } from '../env.js';
import { requireWorkspaceKey, requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as agentEngine from '../engine/agent.js';
import * as directoryEngine from '../engine/directory.js';
import * as sessionEventEngine from '../engine/sessionEvent.js';
import { fanoutToWorkspace } from './fanout.js';
import { runInBackground } from './background.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';

export const agentRoutes = new Hono<AppEnv>();

const skillSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  tags: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const capabilitiesSchema = z.record(z.string(), z.unknown());

const registerAgentSchema = z.object({
  name: z.string().min(1),
  type: AgentTypeSchema.optional(),
  persona: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  skills: z.array(skillSchema).optional(),
  capabilities: capabilitiesSchema.optional(),
});

const AGENT_STATUSES = ['active', 'idle', 'blocked', 'waiting', 'offline', 'online'] as const;

const updateAgentSchema = z.object({
  status: z.enum(AGENT_STATUSES).optional(),
  persona: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  skills: z.array(skillSchema).optional(),
  capabilities: capabilitiesSchema.nullable().optional(),
});

const sessionEventSchema = z.object({
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
});

const spawnAgentSchema = z.object({
  name: z.string().min(1),
  cli: z.string().min(1),
  task: z.string().min(1),
  channel: z.string().nullable().optional(),
  persona: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const releaseAgentSchema = z.object({
  name: z.string().min(1),
  reason: z.string().nullable().optional(),
  delete_agent: z.boolean().optional(),
});

// POST /v1/agents - register agent (workspace key required)
agentRoutes.post(
  '/agents',
  requireWorkspaceKey,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const parsed = registerAgentSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        return c.json({
          ok: false,
          error: { code: 'invalid_request', message: 'name is required' },
        }, 400);
      }
      const { name, type, persona, metadata, skills, capabilities } = parsed.data;
      const agentType = typeof type === 'string' ? type : undefined;
      const nextMetadata = {
        ...(metadata || {}),
        ...(skills ? { skills } : {}),
      };

      const result = await agentEngine.registerAgent(db, workspace.id, {
        name,
        type: agentType,
        persona,
        metadata: nextMetadata,
        capabilities,
      });
      if (skills?.length) {
        await directoryEngine.syncSourceAgentDirectoryEntry(db, workspace.id, {
          id: result.id,
          name: result.name,
          status: result.status,
          metadata: nextMetadata,
        });
      }
      emitServerEvent(c, workspace.id, 'relaycast_server_agent_registered', {
        agent_id: result.id,
        agent_name: result.name,
        agent_type: type ?? 'agent',
      });
      return c.json({ ok: true, data: result }, 201);
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      const status = error.status || 500;
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, status as ContentfulStatusCode);
    }
  },
);

// GET /v1/agents - list agents
agentRoutes.get(
  '/agents',
  requireWorkspaceKey,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const status = c.req.query('status');
      const agents = await agentEngine.listAgents(db, workspace.id, status);
      return c.json({ ok: true, data: agents });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, (error.status || 500) as ContentfulStatusCode);
    }
  },
);

// GET /v1/agents/:name - get agent by name
agentRoutes.get(
  '/agents/:name',
  requireWorkspaceKey,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const name = c.req.param('name');
      const agent = await agentEngine.getAgentByName(db, workspace.id, name);
      if (!agent) {
        return c.json({
          ok: false,
          error: { code: 'agent_not_found', message: `Agent "${name}" not found` },
        }, 404);
      }
      return c.json({ ok: true, data: agent });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, (error.status || 500) as ContentfulStatusCode);
    }
  },
);

// PATCH /v1/agents/:name - update agent
agentRoutes.patch(
  '/agents/:name',
  requireWorkspaceKey,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const name = c.req.param('name');
      const parsed = updateAgentSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        return c.json({
          ok: false,
          error: { code: 'invalid_request', message: 'invalid agent update body' },
        }, 400);
      }
      const existing = await agentEngine.getAgentByName(db, workspace.id, name);
      if (!existing) {
        return c.json({
          ok: false,
          error: { code: 'agent_not_found', message: `Agent "${name}" not found` },
        }, 404);
      }

      const body = parsed.data;
      const nextMetadata = body.metadata !== undefined || body.skills !== undefined
        ? {
          ...(existing.metadata || {}),
          ...(body.metadata || {}),
          ...(body.skills ? { skills: body.skills } : body.skills === undefined ? {} : { skills: [] }),
        }
        : undefined;

      const updated = await agentEngine.updateAgent(db, workspace.id, name, {
        status: body.status,
        persona: body.persona,
        metadata: nextMetadata,
        capabilities: body.capabilities,
      });
      if (!updated) {
        return c.json({
          ok: false,
          error: { code: 'agent_not_found', message: `Agent "${name}" not found` },
        }, 404);
      }
      if (body.metadata !== undefined || body.skills !== undefined || body.status !== undefined) {
        await directoryEngine.syncSourceAgentDirectoryEntry(db, workspace.id, {
          id: updated.id,
          name: updated.name,
          status: updated.status,
          metadata: (updated.metadata || {}) as Record<string, unknown>,
        });
      }
      emitServerEvent(c, workspace.id, 'relaycast_server_agent_updated', {
        agent_name: name,
        changed_status: typeof body?.status === 'string',
        changed_persona: typeof body?.persona === 'string',
      });
      return c.json({ ok: true, data: updated });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, (error.status || 500) as ContentfulStatusCode);
    }
  },
);

// DELETE /v1/agents/:name - delete agent
agentRoutes.delete(
  '/agents/:name',
  requireWorkspaceKey,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const name = c.req.param('name');
      const deleted = await agentEngine.deleteAgent(db, workspace.id, name);
      if (!deleted) {
        return c.json({
          ok: false,
          error: { code: 'agent_not_found', message: `Agent "${name}" not found` },
        }, 404);
      }
      emitServerEvent(c, workspace.id, 'relaycast_server_agent_deleted', {
        agent_name: name,
      });
      return c.body(null, 204);
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, (error.status || 500) as ContentfulStatusCode);
    }
  },
);

// POST /v1/agents/spawn - spawn agent (registers if new, rotates token if exists)
agentRoutes.post(
  '/agents/spawn',
  requireWorkspaceKey,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const parsed = spawnAgentSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        const hasNameIssue = parsed.error.issues.some((issue) => issue.path[0] === 'name');
        const hasCliIssue = parsed.error.issues.some((issue) => issue.path[0] === 'cli');
        const hasTaskIssue = parsed.error.issues.some((issue) => issue.path[0] === 'task');
        const message = hasNameIssue
          ? 'name is required'
          : hasCliIssue
            ? 'cli is required'
            : hasTaskIssue
              ? 'task is required'
              : 'invalid spawn request';
        return c.json({
          ok: false,
          error: { code: 'invalid_request', message },
        }, 400);
      }
      const { name, cli, task, channel, persona, metadata } = parsed.data;

      const validClis = ['claude', 'codex', 'opencode', 'gemini', 'aider', 'goose'];
      if (!validClis.includes(cli)) {
        return c.json({
          ok: false,
          error: { code: 'invalid_request', message: `cli must be one of: ${validClis.join(', ')}` },
        }, 400);
      }

      const result = await agentEngine.spawnAgent(db, workspace.id, {
        name,
        cli,
        task,
        channel: channel ?? undefined,
        persona: persona ?? undefined,
        metadata,
      });

      const spawnEventData = {
        agent_id: result.id,
        agent_name: result.name,
        cli: result.cli,
        task: result.task,
        channel: result.channel,
        already_existed: result.already_existed,
      };

      runInBackground(c, fanoutToWorkspace(c, 'agent.spawn_requested', spawnEventData), 'fanout agent.spawn_requested');
      runInBackground(
        c,
        c.get('engine').webhookQueue.send({
          type: 'agent.spawn_requested',
          workspaceId: workspace.id,
          data: spawnEventData,
        }),
        'queue agent.spawn_requested',
      );
      emitServerEvent(c, workspace.id, 'relaycast_server_agent_spawn_requested', {
        agent_id: result.id,
        agent_name: result.name,
        cli: result.cli,
        already_existed: result.already_existed,
      });

      return c.json({ ok: true, data: result }, (result.already_existed ? 200 : 201) as ContentfulStatusCode);
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, (error.status || 500) as ContentfulStatusCode);
    }
  },
);

// POST /v1/agents/:name/events - harness emits a session event
agentRoutes.post(
  '/agents/:name/events',
  requireAuth,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const name = c.req.param('name');

      const parsed = sessionEventSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        return c.json(
          { ok: false, error: { code: 'invalid_request', message: 'type is required' } },
          400,
        );
      }

      const { type, payload } = parsed.data;

      if (!sessionEventEngine.isValidEventType(type)) {
        return c.json(
          { ok: false, error: { code: 'invalid_event_type', message: `Unknown event type: ${type}` } },
          400,
        );
      }

      const agentRecord = await agentEngine.getAgentByName(db, workspace.id, name);
      if (!agentRecord) {
        return c.json(
          { ok: false, error: { code: 'agent_not_found', message: `Agent "${name}" not found` } },
          404,
        );
      }

      // Agent tokens may only post events for themselves
      const callerAgent = c.get('agent');
      if (callerAgent && callerAgent.id !== agentRecord.id) {
        return c.json(
          { ok: false, error: { code: 'forbidden', message: 'Agent token can only post events for itself' } },
          403,
        );
      }

      // Validate status events before writing — reject early so no orphan row is created
      const VALID_STATUSES = new Set(['active', 'idle', 'blocked', 'waiting', 'offline', 'online']);
      if (type.startsWith('status.')) {
        const resolved = sessionEventEngine.resolveStatusFromEvent(type);
        const fromPayload = typeof payload.status === 'string' ? payload.status : undefined;
        const newStatus = resolved ?? fromPayload;

        if (!newStatus) {
          return c.json(
            { ok: false, error: { code: 'invalid_request', message: 'status.changed event requires payload.status' } },
            400,
          );
        }
        if (!VALID_STATUSES.has(newStatus)) {
          return c.json(
            { ok: false, error: { code: 'invalid_request', message: `Invalid status value: "${newStatus}". Must be one of: ${[...VALID_STATUSES].join(', ')}` } },
            400,
          );
        }
      }

      const event = await sessionEventEngine.recordSessionEvent(db, workspace.id, agentRecord.id, {
        type,
        payload,
      });

      // Update agent status after the event is durably written
      if (type.startsWith('status.')) {
        const resolved = sessionEventEngine.resolveStatusFromEvent(type);
        const newStatus = resolved ?? (payload.status as string);
        await agentEngine.updateAgent(db, workspace.id, name, { status: newStatus });
      }

      const eventData = { agent_name: name, ...event };
      runInBackground(c, fanoutToWorkspace(c, `harness.${type}`, eventData), `fanout harness.${type}`);
      runInBackground(
        c,
        c.get('engine').webhookQueue.send({
          type: `harness.${type}`,
          workspaceId: workspace.id,
          data: eventData,
        }),
        `queue harness.${type}`,
      );

      return c.json({ ok: true, data: event }, 201);
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      return c.json(
        { ok: false, error: { code: error.code || 'internal_error', message: error.message } },
        (error.status || 500) as ContentfulStatusCode,
      );
    }
  },
);

// GET /v1/agents/:name/events - list session events for an agent
agentRoutes.get(
  '/agents/:name/events',
  requireWorkspaceKey,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const name = c.req.param('name');
      const type = c.req.query('type');
      const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10), 500);

      const agent = await agentEngine.getAgentByName(db, workspace.id, name);
      if (!agent) {
        return c.json(
          { ok: false, error: { code: 'agent_not_found', message: `Agent "${name}" not found` } },
          404,
        );
      }

      const events = await sessionEventEngine.listSessionEvents(db, workspace.id, agent.id, {
        type,
        limit,
      });

      return c.json({ ok: true, data: events });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      return c.json(
        { ok: false, error: { code: error.code || 'internal_error', message: error.message } },
        (error.status || 500) as ContentfulStatusCode,
      );
    }
  },
);

// POST /v1/agents/release - release (mark offline) or delete an agent
agentRoutes.post(
  '/agents/release',
  requireWorkspaceKey,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const parsed = releaseAgentSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        return c.json({
          ok: false,
          error: { code: 'invalid_request', message: 'name is required' },
        }, 400);
      }
      const { name, reason, delete_agent } = parsed.data;

      const result = await agentEngine.releaseAgent(db, workspace.id, {
        name,
        reason: reason ?? undefined,
        delete_agent,
      });

      if (!result) {
        return c.json({
          ok: false,
          error: { code: 'agent_not_found', message: `Agent "${name}" not found` },
        }, 404);
      }

      const releaseEventData = {
        agent_name: result.name,
        reason: result.reason ?? null,
        deleted: result.deleted,
      };

      runInBackground(c, fanoutToWorkspace(c, 'agent.release_requested', releaseEventData), 'fanout agent.release_requested');
      runInBackground(
        c,
        c.get('engine').webhookQueue.send({
          type: 'agent.release_requested',
          workspaceId: workspace.id,
          data: releaseEventData,
        }),
        'queue agent.release_requested',
      );
      emitServerEvent(c, workspace.id, 'relaycast_server_agent_release_requested', {
        agent_name: result.name,
        deleted: result.deleted,
      });

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
