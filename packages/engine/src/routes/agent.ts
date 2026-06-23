import { Hono } from 'hono';
import { z } from 'zod';
import { AgentTypeSchema, CliTypeSchema } from '@relaycast/types';
import type { AppEnv } from '../env.js';
import { requireWorkspaceKey, requireAuth, requireAgentToken } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as agentEngine from '../engine/agent.js';
import * as directoryEngine from '../engine/directory.js';
import * as sessionEventEngine from '../engine/sessionEvent.js';
import { fanoutToWorkspace } from './fanout.js';
import { runInBackground } from './background.js';
import { sendWebhookEvent } from './webhookOutbox.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';
import { errorResponse } from '../lib/httpError.js';
import {
  jsonCreated,
  jsonError,
  jsonNoContent,
  jsonNotFound,
  jsonOk,
  parseJsonBody,
} from '../lib/httpResponse.js';

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
  cli: CliTypeSchema,
  task: z.string().min(1),
  channel: z.string().nullable().optional(),
  persona: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const releaseAgentSchema = z.object({
  name: z.string().min(1),
  reason: z.string().nullable().optional(),
  delete_agent: z.boolean().optional(),
});

function canonicalStatus(status: string): 'active' | 'idle' | 'blocked' | 'waiting' | 'offline' | null {
  if (status === 'online') return 'active';
  if (status === 'active' || status === 'idle' || status === 'blocked' || status === 'waiting' || status === 'offline') {
    return status;
  }
  return null;
}

function agentNotFound(c: Parameters<typeof jsonNotFound>[0], name: string) {
  return jsonNotFound(c, 'agent_not_found', `Agent "${name}" not found`);
}

async function fanoutAgentStatus(c: Parameters<typeof runInBackground>[0], agent: { id: string; name: string }, status: string, eventId?: string): Promise<void> {
  const nextStatus = canonicalStatus(status);
  if (!nextStatus) return;
  const eventType = `agent.status.${nextStatus}`;
  const eventData = {
    agent_id: agent.id,
    agent_name: agent.name,
    status: nextStatus,
    ...(eventId ? { event_id: eventId } : {}),
  };
  runInBackground(c, fanoutToWorkspace(c, eventType, eventData), `fanout ${eventType}`);
  await sendWebhookEvent(c, {
    type: eventType,
    workspaceId: c.get('workspace').id,
    data: eventData,
  });
}

// GET /v1/agent - resolve the authenticated agent token to its identity
agentRoutes.get(
  '/agent',
  requireAgentToken,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const authAgent = c.get('agent');
      const agent = await agentEngine.getAgentByName(db, workspace.id, authAgent!.name);
      if (!agent) {
        return jsonNotFound(c, 'agent_not_found', 'Authenticated agent not found');
      }
      return jsonOk(c, agent);
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);

// POST /v1/agents - register agent (workspace key required)
agentRoutes.post(
  '/agents',
  requireWorkspaceKey,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const parsed = await parseJsonBody(c, registerAgentSchema, 'name is required');
      if (!parsed.ok) {
        return parsed.response;
      }
      const { name, type, persona, metadata, skills, capabilities } = parsed.data;
      const nextMetadata = {
        ...(metadata || {}),
        ...(skills ? { skills } : {}),
      };

      const result = await agentEngine.registerAgent(db, workspace.id, {
        name,
        type,
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
      return jsonCreated(c, result);
    } catch (err: unknown) {
      return errorResponse(c, err);
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
      return jsonOk(c, agents);
    } catch (err: unknown) {
      return errorResponse(c, err);
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
        return agentNotFound(c, name);
      }
      return jsonOk(c, agent);
    } catch (err: unknown) {
      return errorResponse(c, err);
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
      const parsed = await parseJsonBody(c, updateAgentSchema, 'invalid agent update body');
      if (!parsed.ok) {
        return parsed.response;
      }
      const existing = await agentEngine.getAgentByName(db, workspace.id, name);
      if (!existing) {
        return agentNotFound(c, name);
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
        return agentNotFound(c, name);
      }
      if (body.metadata !== undefined || body.skills !== undefined || body.status !== undefined) {
        await directoryEngine.syncSourceAgentDirectoryEntry(db, workspace.id, {
          id: updated.id,
          name: updated.name,
          status: updated.status,
          metadata: updated.metadata ?? {},
        });
      }
      if (body.status !== undefined) {
        await fanoutAgentStatus(c, updated, body.status);
      }
      emitServerEvent(c, workspace.id, 'relaycast_server_agent_updated', {
        agent_name: name,
        changed_status: typeof body?.status === 'string',
        changed_persona: typeof body?.persona === 'string',
      });
      return jsonOk(c, updated);
    } catch (err: unknown) {
      return errorResponse(c, err);
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
        return agentNotFound(c, name);
      }
      emitServerEvent(c, workspace.id, 'relaycast_server_agent_deleted', {
        agent_name: name,
      });
      return jsonNoContent(c);
    } catch (err: unknown) {
      return errorResponse(c, err);
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
      const parsed = await parseJsonBody(c, spawnAgentSchema, (failure) => {
        const hasNameIssue = failure.error.issues.some((issue) => issue.path[0] === 'name');
        const hasCliIssue = failure.error.issues.some((issue) => issue.path[0] === 'cli');
        const hasTaskIssue = failure.error.issues.some((issue) => issue.path[0] === 'task');
        return hasNameIssue
          ? 'name is required'
          : hasCliIssue
            ? `cli must be one of: ${CliTypeSchema.options.join(', ')}`
            : hasTaskIssue
              ? 'task is required'
              : 'invalid spawn request';
      });
      if (!parsed.ok) {
        return parsed.response;
      }
      const { name, cli, task, channel, persona, model, metadata } = parsed.data;

      const result = await agentEngine.spawnAgent(db, workspace.id, {
        name,
        cli,
        task,
        channel: channel ?? undefined,
        persona: persona ?? undefined,
        // Persist the requested model into agent metadata so it is visible via
        // list_agents, in addition to being emitted on the spawn event below.
        metadata: model ? { ...(metadata ?? {}), model } : metadata,
      });

      const spawnEventData = {
        agent_id: result.id,
        agent_name: result.name,
        cli: result.cli,
        task: result.task,
        channel: result.channel,
        model: model ?? null,
        already_existed: result.already_existed,
      };

      runInBackground(c, fanoutToWorkspace(c, 'agent.spawn_requested', spawnEventData), 'fanout agent.spawn_requested');
      await sendWebhookEvent(c, {
        type: 'agent.spawn_requested',
        workspaceId: workspace.id,
        data: spawnEventData,
      });
      emitServerEvent(c, workspace.id, 'relaycast_server_agent_spawn_requested', {
        agent_id: result.id,
        agent_name: result.name,
        cli: result.cli,
        already_existed: result.already_existed,
      });

      return result.already_existed ? jsonOk(c, result) : jsonCreated(c, result);
    } catch (err: unknown) {
      return errorResponse(c, err);
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

      const parsed = await parseJsonBody(c, sessionEventSchema, 'type is required');
      if (!parsed.ok) {
        return parsed.response;
      }

      const { type, payload } = parsed.data;

      if (!sessionEventEngine.isValidEventType(type)) {
        return jsonError(c, 'invalid_event_type', `Unknown event type: ${type}`, 400);
      }

      const agentRecord = await agentEngine.getAgentByName(db, workspace.id, name);
      if (!agentRecord) {
        return agentNotFound(c, name);
      }

      // Agent tokens may only post events for themselves
      const callerAgent = c.get('agent');
      if (callerAgent && callerAgent.id !== agentRecord.id) {
        return jsonError(c, 'forbidden', 'Agent token can only post events for itself', 403);
      }

      // Validate status events before writing — reject early so no orphan row is created
      const VALID_STATUSES = new Set(['active', 'idle', 'blocked', 'waiting', 'offline', 'online']);
      if (type.startsWith('status.')) {
        const resolved = sessionEventEngine.resolveStatusFromEvent(type);
        const fromPayload = typeof payload.status === 'string' ? payload.status : undefined;
        const newStatus = resolved ?? fromPayload;

        if (!newStatus) {
          return jsonError(c, 'invalid_request', 'status.changed event requires payload.status', 400);
        }
        if (!VALID_STATUSES.has(newStatus)) {
          return jsonError(c, 'invalid_request', `Invalid status value: "${newStatus}". Must be one of: ${[...VALID_STATUSES].join(', ')}`, 400);
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
        const eventType = type === 'status.changed' ? 'agent.status.changed' : `agent.status.${canonicalStatus(newStatus) ?? newStatus}`;
        const eventData = {
          agent_id: agentRecord.id,
          agent_name: name,
          status: canonicalStatus(newStatus) ?? newStatus,
          event_id: event.id,
          payload,
        };
        runInBackground(c, fanoutToWorkspace(c, eventType, eventData), `fanout ${eventType}`);
        await sendWebhookEvent(c, {
          type: eventType,
          workspaceId: workspace.id,
          data: eventData,
        });
      }

      if (!type.startsWith('status.')) {
        const { type: _sessionEventType, ...eventWithoutType } = event;
        const eventData = { agent_name: name, ...eventWithoutType };
        runInBackground(c, fanoutToWorkspace(c, `harness.${type}`, eventData), `fanout harness.${type}`);
        await sendWebhookEvent(c, {
          type: `harness.${type}`,
          workspaceId: workspace.id,
          data: eventData,
        });
      }

      return jsonCreated(c, event);
    } catch (err: unknown) {
      return errorResponse(c, err);
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
        return agentNotFound(c, name);
      }

      const events = await sessionEventEngine.listSessionEvents(db, workspace.id, agent.id, {
        type,
        limit,
      });

      return jsonOk(c, events);
    } catch (err: unknown) {
      return errorResponse(c, err);
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
      const parsed = await parseJsonBody(c, releaseAgentSchema, 'name is required');
      if (!parsed.ok) {
        return parsed.response;
      }
      const { name, reason, delete_agent } = parsed.data;

      const result = await agentEngine.releaseAgent(db, workspace.id, {
        name,
        reason: reason ?? undefined,
        delete_agent,
      });

      if (!result) {
        return agentNotFound(c, name);
      }

      const releaseEventData = {
        agent_name: result.name,
        reason: result.reason ?? null,
        deleted: result.deleted,
      };

      runInBackground(c, fanoutToWorkspace(c, 'agent.release_requested', releaseEventData), 'fanout agent.release_requested');
      await sendWebhookEvent(c, {
        type: 'agent.release_requested',
        workspaceId: workspace.id,
        data: releaseEventData,
      });
      emitServerEvent(c, workspace.id, 'relaycast_server_agent_release_requested', {
        agent_name: result.name,
        deleted: result.deleted,
      });

      return jsonOk(c, result);
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);
