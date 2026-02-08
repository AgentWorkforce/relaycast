import { Router, Response } from 'express';
import {
  requireAuth,
  type AuthenticatedRequest,
} from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as commandEngine from '../engine/command.js';
import { publishEvent } from '../ws/pubsub.js';
import { deliverEvent } from '../engine/eventDelivery.js';

export const commandRouter = Router();

// POST /v1/commands - register a command
commandRouter.post(
  '/commands',
  requireAuth,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { command, description, handler_agent, parameters } = req.body;
      if (!command || typeof command !== 'string') {
        res.status(400).json({
          ok: false,
          error: { code: 'invalid_request', message: 'command is required' },
        });
        return;
      }
      if (!description || typeof description !== 'string') {
        res.status(400).json({
          ok: false,
          error: { code: 'invalid_request', message: 'description is required' },
        });
        return;
      }
      if (!handler_agent || typeof handler_agent !== 'string') {
        res.status(400).json({
          ok: false,
          error: {
            code: 'invalid_request',
            message: 'handler_agent is required',
          },
        });
        return;
      }

      const result = await commandEngine.registerCommand(req.workspace!.id, {
        command,
        description,
        handler_agent,
        parameters,
      });
      res.status(201).json({ ok: true, data: result });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);

// GET /v1/commands - list commands
commandRouter.get(
  '/commands',
  requireAuth,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = await commandEngine.listCommands(req.workspace!.id);
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

// DELETE /v1/commands/:command - delete a command
commandRouter.delete(
  '/commands/:command',
  requireAuth,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const deleted = await commandEngine.deleteCommand(
        req.workspace!.id,
        req.params.command as string,
      );
      if (!deleted) {
        res.status(404).json({
          ok: false,
          error: { code: 'command_not_found', message: 'Command not found' },
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

// POST /v1/commands/:command/invoke - invoke a command
commandRouter.post(
  '/commands/:command/invoke',
  requireAuth,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { channel, args, parameters } = req.body;
      if (!channel || typeof channel !== 'string') {
        res.status(400).json({
          ok: false,
          error: { code: 'invalid_request', message: 'channel is required' },
        });
        return;
      }

      const agentId = req.agent?.id;
      if (!agentId) {
        res.status(403).json({
          ok: false,
          error: {
            code: 'agent_token_required',
            message: 'Agent token required to invoke commands',
          },
        });
        return;
      }

      const result = await commandEngine.invokeCommand(
        req.workspace!.id,
        req.params.command as string,
        { channel, invoked_by: agentId, args, parameters },
      );
      res.status(201).json({ ok: true, data: result });

      // Fire-and-forget event publishing
      const eventData = { command: result.command, channel, invoked_by: agentId, args: result.args };
      publishEvent({ type: 'command.invoked', workspace_id: req.workspace!.id, data: eventData, timestamp: new Date().toISOString() }).catch(() => {});
      deliverEvent(req.workspace!.id, 'command.invoked', eventData).catch(() => {});
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);
