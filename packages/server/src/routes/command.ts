import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as commandEngine from '../engine/command.js';
import * as channelEngine from '../engine/channel.js';
import { fanoutToChannel } from './fanout.js';
import { runInBackground } from './background.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';

export const commandRoutes = new Hono<AppEnv>();

const registerCommandSchema = z.object({
  command: z.string().min(1),
  description: z.string().min(1),
  handler_agent: z.string().min(1),
  parameters: z.array(
    z.object({
      name: z.string().min(1),
      description: z.string().optional(),
      type: z.string().min(1),
      required: z.boolean().optional(),
    }).passthrough(),
  ).optional(),
});

const invokeCommandSchema = z.object({
  channel: z.string().min(1),
  args: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

// POST /v1/commands - register a command
commandRoutes.post('/commands', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const parsed = registerCommandSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      const hasCommandIssue = parsed.error.issues.some((issue) => issue.path[0] === 'command');
      const hasDescriptionIssue = parsed.error.issues.some((issue) => issue.path[0] === 'description');
      const hasHandlerAgentIssue = parsed.error.issues.some((issue) => issue.path[0] === 'handler_agent');
      const message = hasCommandIssue
        ? 'command is required'
        : hasDescriptionIssue
          ? 'description is required'
          : hasHandlerAgentIssue
            ? 'handler_agent is required'
            : 'invalid command registration body';
      return c.json({
        ok: false,
        error: { code: 'invalid_request', message },
      }, 400);
    }
    const { command, description, handler_agent, parameters } = parsed.data;

    const result = await commandEngine.registerCommand(db, workspace.id, {
      command,
      description,
      handler_agent,
      parameters,
    });
    emitServerEvent(c, workspace.id, 'relaycast_server_command_registered', {
      command: result.command,
      handler_agent_name: handler_agent,
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
    emitServerEvent(c, workspace.id, 'relaycast_server_command_deleted', {
      command: c.req.param('command'),
    });
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
    const parsed = invokeCommandSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({
        ok: false,
        error: { code: 'invalid_request', message: 'channel is required' },
      }, 400);
    }
    const { channel, args, parameters } = parsed.data;

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
        runInBackground(c, fanoutToChannel(c, channelRecord.id, 'command.invoked', eventData), 'fanout command.invoked');
      }
    } catch {
      // Ignore fanout failures
    }

    runInBackground(
      c,
      c.env.WEBHOOK_QUEUE.send({
        type: 'command.invoked',
        workspaceId: workspace.id,
        data: { ...result, invoked_by_name: agent?.name },
      }),
      'queue command.invoked',
    );
    emitServerEvent(c, workspace.id, 'relaycast_server_command_invoked', {
      command: result.command,
      invocation_id: result.id,
      channel_name: result.channel,
      invoked_by_agent_id: agentId,
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
