import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as commandEngine from '../engine/command.js';
import * as channelEngine from '../engine/channel.js';
import { fanoutToChannel } from './fanout.js';

export const commandRoutes = new Hono<AppEnv>();

// POST /v1/commands - register a command
commandRoutes.post('/commands', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const { command, description, handler_agent, parameters } = await c.req.json();

    if (!command || typeof command !== 'string') {
      return c.json({
        ok: false,
        error: { code: 'invalid_request', message: 'command is required' },
      }, 400);
    }
    if (!description || typeof description !== 'string') {
      return c.json({
        ok: false,
        error: { code: 'invalid_request', message: 'description is required' },
      }, 400);
    }
    if (!handler_agent || typeof handler_agent !== 'string') {
      return c.json({
        ok: false,
        error: { code: 'invalid_request', message: 'handler_agent is required' },
      }, 400);
    }

    const result = await commandEngine.registerCommand(db, workspace.id, {
      command,
      description,
      handler_agent,
      parameters,
    });
    return c.json({ ok: true, data: result }, 201);
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as any);
  }
});

// GET /v1/commands - list commands
commandRoutes.get('/commands', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const result = await commandEngine.listCommands(db, workspace.id);
    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as any);
  }
});

// DELETE /v1/commands/:command - delete a command
commandRoutes.delete('/commands/:command', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const deleted = await commandEngine.deleteCommand(
      db,
      workspace.id,
      c.req.param('command'),
    );
    if (!deleted) {
      return c.json({
        ok: false,
        error: { code: 'command_not_found', message: 'Command not found' },
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
});

// POST /v1/commands/:command/invoke - invoke a command
commandRoutes.post('/commands/:command/invoke', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const agent = c.get('agent');
    const { channel, args, parameters } = await c.req.json();

    if (!channel || typeof channel !== 'string') {
      return c.json({
        ok: false,
        error: { code: 'invalid_request', message: 'channel is required' },
      }, 400);
    }

    const agentId = agent?.id;
    if (!agentId) {
      return c.json({
        ok: false,
        error: {
          code: 'agent_token_required',
          message: 'Agent token required to invoke commands',
        },
      }, 403);
    }

    const result = await commandEngine.invokeCommand(
      db,
      workspace.id,
      c.req.param('command'),
      { channel, invoked_by: agentId, args, parameters },
    );

    try {
      const channelRecord = await channelEngine.getChannel(db, workspace.id, channel);
      if (channelRecord) {
        const eventData = { ...result, invoked_by_name: agent?.name };
        fanoutToChannel(c, channelRecord.id, 'command.invoked', eventData).catch(() => {});
      }
    } catch {
      // Ignore fanout failures
    }

    c.env.WEBHOOK_QUEUE.send({
      type: 'command.invoked',
      workspaceId: workspace.id,
      data: { ...result, invoked_by_name: agent?.name },
    });

    return c.json({ ok: true, data: result }, 201);
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as any);
  }
});
