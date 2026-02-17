import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { requireWorkspaceKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as agentEngine from '../engine/agent.js';

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
agentRouter.post(
  '/agents/spawn',
  requireWorkspaceKey,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { name, cli, task, channel, persona, metadata } = req.body;

      if (!name || typeof name !== 'string') {
        res.status(400).json({
          ok: false,
          error: { code: 'invalid_request', message: 'name is required' },
        });
        return;
      }

      if (!cli || typeof cli !== 'string') {
        res.status(400).json({
          ok: false,
          error: { code: 'invalid_request', message: 'cli is required' },
        });
        return;
      }

      const validClis = ['claude', 'codex', 'gemini', 'aider', 'goose'];
      if (!validClis.includes(cli)) {
        res.status(400).json({
          ok: false,
          error: { code: 'invalid_request', message: `cli must be one of: ${validClis.join(', ')}` },
        });
        return;
      }

      if (!task || typeof task !== 'string') {
        res.status(400).json({
          ok: false,
          error: { code: 'invalid_request', message: 'task is required' },
        });
        return;
      }

      const result = await agentEngine.spawnAgent(req.workspace!.id, {
        name,
        cli,
        task,
        channel,
        persona,
        metadata,
      });

      res.status(result.already_existed ? 200 : 201).json({ ok: true, data: result });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);

// POST /v1/agents/release - release (mark offline) or delete an agent
agentRouter.post(
  '/agents/release',
  requireWorkspaceKey,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { name, reason, delete_agent } = req.body;

      if (!name || typeof name !== 'string') {
        res.status(400).json({
          ok: false,
          error: { code: 'invalid_request', message: 'name is required' },
        });
        return;
      }

      const result = await agentEngine.releaseAgent(req.workspace!.id, {
        name,
        reason,
        delete_agent,
      });

      if (!result) {
        res.status(404).json({
          ok: false,
          error: { code: 'agent_not_found', message: `Agent "${name}" not found` },
        });
        return;
      }

      res.json({ ok: true, data: result });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);
