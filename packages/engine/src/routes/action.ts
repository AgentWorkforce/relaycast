import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as actionEngine from '../engine/action.js';
import { fanoutToWorkspace, fanoutToAgents } from './fanout.js';
import { runInBackground } from './background.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';

export const actionRoutes = new Hono<AppEnv>();

const registerActionSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  handler_agent: z.string().min(1),
  input_schema: z.record(z.string(), z.unknown()).optional(),
  output_schema: z.record(z.string(), z.unknown()).optional(),
  available_to: z.array(z.string().min(1)).optional(),
});

const invokeActionSchema = z.object({
  input: z.record(z.string(), z.unknown()).optional(),
});

const completeInvocationSchema = z.object({
  output: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
  duration_ms: z.number().int().nonnegative().optional(),
});

// POST /v1/actions - register an action
actionRoutes.post('/actions', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const parsed = registerActionSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      const hasNameIssue = parsed.error.issues.some((i) => i.path[0] === 'name');
      const hasDescIssue = parsed.error.issues.some((i) => i.path[0] === 'description');
      const hasHandlerIssue = parsed.error.issues.some((i) => i.path[0] === 'handler_agent');
      const message = hasNameIssue
        ? 'name is required'
        : hasDescIssue
          ? 'description is required'
          : hasHandlerIssue
            ? 'handler_agent is required'
            : 'invalid action registration body';
      return c.json({ ok: false, error: { code: 'invalid_request', message } }, 400);
    }

    // If called with an agent token, handler_agent must match the calling agent
    const callerAgent = c.get('agent');
    if (callerAgent && parsed.data.handler_agent !== callerAgent.name) {
      return c.json(
        { ok: false, error: { code: 'forbidden', message: `Agent "${callerAgent.name}" may only register actions it will handle itself` } },
        403,
      );
    }

    const result = await actionEngine.registerAction(db, workspace.id, parsed.data);

    emitServerEvent(c, workspace.id, 'relaycast_server_action_registered', {
      action_name: result.name,
      handler_agent_name: parsed.data.handler_agent,
    });
    runInBackground(
      c,
      fanoutToWorkspace(c, 'action.registered', { action_name: result.name }),
      'fanout action.registered',
    );

    return c.json({ ok: true, data: result }, 201);
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json(
      { ok: false, error: { code: error.code || 'internal_error', message: error.message } },
      (error.status || 500) as any,
    );
  }
});

// GET /v1/actions - list actions
actionRoutes.get('/actions', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const result = await actionEngine.listActions(db, workspace.id);
    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json(
      { ok: false, error: { code: error.code || 'internal_error', message: error.message } },
      (error.status || 500) as any,
    );
  }
});

// GET /v1/actions/:name - get a single action
actionRoutes.get('/actions/:name', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const result = await actionEngine.getAction(db, workspace.id, c.req.param('name'));
    if (!result) {
      return c.json(
        { ok: false, error: { code: 'action_not_found', message: 'Action not found' } },
        404,
      );
    }
    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json(
      { ok: false, error: { code: error.code || 'internal_error', message: error.message } },
      (error.status || 500) as any,
    );
  }
});

// DELETE /v1/actions/:name - delete an action
actionRoutes.delete('/actions/:name', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const agent = c.get('agent');
    const deleted = await actionEngine.deleteAction(db, workspace.id, c.req.param('name'), {
      caller_agent_id: agent?.id,
    });
    if (!deleted) {
      return c.json(
        { ok: false, error: { code: 'action_not_found', message: 'Action not found' } },
        404,
      );
    }
    emitServerEvent(c, workspace.id, 'relaycast_server_action_deleted', {
      action_name: c.req.param('name'),
    });
    return c.body(null, 204);
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json(
      { ok: false, error: { code: error.code || 'internal_error', message: error.message } },
      (error.status || 500) as any,
    );
  }
});

// POST /v1/actions/:name/invoke - invoke an action
actionRoutes.post('/actions/:name/invoke', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const agent = c.get('agent');

    if (!agent) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'agent_token_required',
            message: 'Agent token required to invoke actions',
          },
        },
        403,
      );
    }

    const parsed = invokeActionSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json(
        { ok: false, error: { code: 'invalid_request', message: 'invalid invocation body' } },
        400,
      );
    }

    const result = await actionEngine.invokeAction(
      db,
      workspace.id,
      c.req.param('name'),
      {
        input: parsed.data.input,
        caller_id: agent.id,
        caller_name: agent.name,
      },
    );

    const eventData = {
      invocation_id: result.invocation_id,
      action_name: result.action_name,
      caller_name: agent.name,
      handler_agent_id: result.handler_agent_id,
    };

    runInBackground(
      c,
      fanoutToWorkspace(c, 'action.invoked', eventData),
      'fanout action.invoked',
    );
    runInBackground(
      c,
      c.get('engine').webhookQueue.send({
        type: 'action.invoked',
        workspaceId: workspace.id,
        data: eventData,
      }),
      'queue action.invoked',
    );
    emitServerEvent(c, workspace.id, 'relaycast_server_action_invoked', {
      action_name: result.action_name,
      invocation_id: result.invocation_id,
      caller_agent_id: agent.id,
    });

    return c.json({ ok: true, data: result }, 201);
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json(
      { ok: false, error: { code: error.code || 'internal_error', message: error.message } },
      (error.status || 500) as any,
    );
  }
});

// POST /v1/actions/:name/invocations/:id/complete - handler reports result
actionRoutes.post('/actions/:name/invocations/:id/complete', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const parsed = completeInvocationSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json(
        { ok: false, error: { code: 'invalid_request', message: 'invalid completion body' } },
        400,
      );
    }

    const agent = c.get('agent');
    const result = await actionEngine.completeInvocation(
      db,
      workspace.id,
      c.req.param('name'),
      c.req.param('id'),
      { ...parsed.data, caller_agent_id: agent?.id },
    );

    if (!result) {
      return c.json(
        { ok: false, error: { code: 'invocation_not_found', message: 'Invocation not found' } },
        404,
      );
    }

    const eventType = result.status === 'failed' ? 'action.failed' : 'action.completed';
    const eventPayload = {
      invocation_id: result.invocation_id,
      action_name: result.action_name,
      status: result.status,
      output: result.output,
      error: result.error,
    };

    // Push directly to the invoking agent's AgentDO (targeted delivery)
    if (result.caller_id) {
      runInBackground(
        c,
        fanoutToAgents(c, [result.caller_id], eventType, eventPayload),
        `fanout ${eventType} to caller`,
      );
    }
    // Also broadcast on workspace stream for dashboard/workspace-key subscribers
    runInBackground(
      c,
      fanoutToWorkspace(c, eventType, eventPayload),
      `fanout ${eventType} workspace`,
    );
    runInBackground(
      c,
      c.get('engine').webhookQueue.send({ type: eventType, workspaceId: workspace.id, data: result }),
      `queue ${eventType}`,
    );

    // Strip caller_id from client response (internal routing detail)
    const { caller_id: _drop, ...publicResult } = result;
    return c.json({ ok: true, data: publicResult });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json(
      { ok: false, error: { code: error.code || 'internal_error', message: error.message } },
      (error.status || 500) as any,
    );
  }
});

// GET /v1/actions/:name/invocations/:id - get invocation status
actionRoutes.get('/actions/:name/invocations/:id', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const agent = c.get('agent');
    const result = await actionEngine.getInvocation(db, workspace.id, c.req.param('name'), c.req.param('id'), {
      caller_agent_id: agent?.id,
    });
    if (!result) {
      return c.json(
        { ok: false, error: { code: 'invocation_not_found', message: 'Invocation not found' } },
        404,
      );
    }
    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json(
      { ok: false, error: { code: error.code || 'internal_error', message: error.message } },
      (error.status || 500) as any,
    );
  }
});
