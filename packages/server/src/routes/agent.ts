import { Router, Response } from 'express';
import { requireWorkspaceKey, type AuthenticatedRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as agentEngine from '../engine/agent.js';
import { publishEvent } from '../ws/pubsub.js';
import { deliverEvent } from '../engine/eventDelivery.js';

export const agentRouter = Router();

function paramName(req: AuthenticatedRequest): string {
  return req.params.name as string;
}

// POST /v1/agents - register agent (workspace key required)
agentRouter.post(
  '/agents',
  requireWorkspaceKey,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { name, type, persona, metadata } = req.body;
      if (!name || typeof name !== 'string') {
        res.status(400).json({
          ok: false,
          error: { code: 'invalid_request', message: 'name is required' },
        });
        return;
      }

      const result = await agentEngine.registerAgent(req.workspace!.id, {
        name,
        type,
        persona,
        metadata,
      });
      res.status(201).json({ ok: true, data: result });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      const status = error.status || 500;
      res.status(status).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);

// GET /v1/agents - list agents
agentRouter.get(
  '/agents',
  requireWorkspaceKey,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const status = req.query.status as string | undefined;
      const agents = await agentEngine.listAgents(req.workspace!.id, status);
      res.json({ ok: true, data: agents });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);

// GET /v1/agents/:name - get agent by name
agentRouter.get(
  '/agents/:name',
  requireWorkspaceKey,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const agent = await agentEngine.getAgentByName(
        req.workspace!.id,
        paramName(req),
      );
      if (!agent) {
        res.status(404).json({
          ok: false,
          error: { code: 'agent_not_found', message: `Agent "${paramName(req)}" not found` },
        });
        return;
      }
      res.json({ ok: true, data: agent });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);

// PATCH /v1/agents/:name - update agent
agentRouter.patch(
  '/agents/:name',
  requireWorkspaceKey,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const updated = await agentEngine.updateAgent(
        req.workspace!.id,
        paramName(req),
        req.body,
      );
      if (!updated) {
        res.status(404).json({
          ok: false,
          error: { code: 'agent_not_found', message: `Agent "${paramName(req)}" not found` },
        });
        return;
      }
      res.json({ ok: true, data: updated });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);

// DELETE /v1/agents/:name - delete agent
agentRouter.delete(
  '/agents/:name',
  requireWorkspaceKey,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const deleted = await agentEngine.deleteAgent(
        req.workspace!.id,
        paramName(req),
      );
      if (!deleted) {
        res.status(404).json({
          ok: false,
          error: { code: 'agent_not_found', message: `Agent "${paramName(req)}" not found` },
        });
        return;
      }
      res.status(204).send();
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
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

      // Emit WS event so connected brokers can spawn local processes
      const spawnEventData = {
        agent_id: result.id,
        agent_name: result.name,
        cli: result.cli,
        task: result.task,
        channel: result.channel,
        already_existed: result.already_existed,
      };
      publishEvent({
        type: 'agent.spawn_requested',
        workspace_id: req.workspace!.id,
        data: spawnEventData,
        timestamp: new Date().toISOString(),
      }).catch(() => {});
      deliverEvent(req.workspace!.id, 'agent.spawn_requested', spawnEventData).catch(() => {});

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

      // Emit WS event so connected brokers can release local processes
      const releaseEventData = {
        agent_name: result.name,
        reason: result.reason ?? null,
        deleted: result.deleted,
      };
      publishEvent({
        type: 'agent.release_requested',
        workspace_id: req.workspace!.id,
        data: releaseEventData,
        timestamp: new Date().toISOString(),
      }).catch(() => {});
      deliverEvent(req.workspace!.id, 'agent.release_requested', releaseEventData).catch(() => {});

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
