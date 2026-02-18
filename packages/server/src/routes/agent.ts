import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { requireWorkspaceKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as agentEngine from '../engine/agent.js';
import { fanoutToWorkspace } from './fanout.js';

export const agentRoutes = new Hono<AppEnv>();

// POST /v1/agents - register agent (workspace key required)
agentRoutes.post(
  '/agents',
  requireWorkspaceKey,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const { name, type, persona, metadata } = await c.req.json();
      if (!name || typeof name !== 'string') {
        return c.json({
          ok: false,
          error: { code: 'invalid_request', message: 'name is required' },
        }, 400);
      }

      const result = await agentEngine.registerAgent(db, workspace.id, {
        name,
        type,
        persona,
        metadata,
      });
      return c.json({ ok: true, data: result }, 201);
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      const status = error.status || 500;
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, status as any);
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
      }, (error.status || 500) as any);
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
      }, (error.status || 500) as any);
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
      const body = await c.req.json();
      const updated = await agentEngine.updateAgent(db, workspace.id, name, body);
      if (!updated) {
        return c.json({
          ok: false,
          error: { code: 'agent_not_found', message: `Agent "${name}" not found` },
        }, 404);
      }
      return c.json({ ok: true, data: updated });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, (error.status || 500) as any);
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

// POST /v1/agents/spawn - spawn agent (registers if new, rotates token if exists)
agentRoutes.post(
  '/agents/spawn',
  requireWorkspaceKey,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const { name, cli, task, channel, persona, metadata } = await c.req.json();

      if (!name || typeof name !== 'string') {
        return c.json({
          ok: false,
          error: { code: 'invalid_request', message: 'name is required' },
        }, 400);
      }

      if (!cli || typeof cli !== 'string') {
        return c.json({
          ok: false,
          error: { code: 'invalid_request', message: 'cli is required' },
        }, 400);
      }

      const validClis = ['claude', 'codex', 'gemini', 'aider', 'goose'];
      if (!validClis.includes(cli)) {
        return c.json({
          ok: false,
          error: { code: 'invalid_request', message: `cli must be one of: ${validClis.join(', ')}` },
        }, 400);
      }

      if (!task || typeof task !== 'string') {
        return c.json({
          ok: false,
          error: { code: 'invalid_request', message: 'task is required' },
        }, 400);
      }

      const result = await agentEngine.spawnAgent(db, workspace.id, {
        name,
        cli,
        task,
        channel,
        persona,
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

      fanoutToWorkspace(c, 'agent.spawn_requested', spawnEventData).catch(() => {});
      c.env.WEBHOOK_QUEUE.send({
        type: 'agent.spawn_requested',
        workspaceId: workspace.id,
        data: spawnEventData,
      });

      return c.json({ ok: true, data: result }, (result.already_existed ? 200 : 201) as any);
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, (error.status || 500) as any);
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
      const { name, reason, delete_agent } = await c.req.json();

      if (!name || typeof name !== 'string') {
        return c.json({
          ok: false,
          error: { code: 'invalid_request', message: 'name is required' },
        }, 400);
      }

      const result = await agentEngine.releaseAgent(db, workspace.id, {
        name,
        reason,
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

      fanoutToWorkspace(c, 'agent.release_requested', releaseEventData).catch(() => {});
      c.env.WEBHOOK_QUEUE.send({
        type: 'agent.release_requested',
        workspaceId: workspace.id,
        data: releaseEventData,
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
