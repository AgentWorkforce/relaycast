import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { errorResponse } from '../lib/httpError.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as actionEngine from '../engine/action.js';
import { emitInvocationCompletionEffects } from '../engine/invocationCompletion.js';
import { fanoutToWorkspace, fanoutToAgents } from './fanout.js';
import { runInBackground } from './background.js';
import { sendWebhookEvent } from './webhookOutbox.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';
import { asCodedError } from '../lib/httpError.js';

export const actionRoutes = new Hono<AppEnv>();

const registerActionSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  handler_agent: z.string().min(1).optional(),
  handler_node: z.string().min(1).optional(),
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
      const hasHandlerIssue = parsed.error.issues.some((i) => i.path[0] === 'handler_agent' || i.path[0] === 'handler_node');
      const message = hasNameIssue
        ? 'name is required'
        : hasDescIssue
          ? 'description is required'
          : hasHandlerIssue
            ? 'handler_agent or handler_node is required'
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
      handler_agent_name: parsed.data.handler_agent ?? null,
      handler_node_name: parsed.data.handler_node ?? null,
    });
    runInBackground(
      c,
      fanoutToWorkspace(c, 'action.registered', { action_name: result.name }),
      'fanout action.registered',
    );

    return c.json({ ok: true, data: result }, 201);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// GET /v1/actions - list actions
actionRoutes.get('/actions', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const agent = c.get('agent');
    const result = await actionEngine.listActions(db, workspace.id, agent?.name);
    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// GET /v1/actions/:name - get a single action
actionRoutes.get('/actions/:name', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const agent = c.get('agent');
    const result = await actionEngine.getAction(db, workspace.id, c.req.param('name'), agent?.name);
    if (!result) {
      return c.json(
        { ok: false, error: { code: 'action_not_found', message: 'Action not found' } },
        404,
      );
    }
    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// DELETE /v1/actions/:name - delete an action
actionRoutes.delete('/actions/:name', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const deleted = await actionEngine.deleteAction(db, workspace.id, c.req.param('name'));
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
    return errorResponse(c, err);
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
      { nodeConnections: c.get('engine').nodeConnections },
    );

    const eventData = {
      invocation_id: result.invocation_id,
      action_name: result.action_name,
      caller_name: agent.name,
      handler_agent_id: result.handler_agent_id,
      handler_node_id: result.handler_node_id,
    };

    if (result.handler_agent_id) {
      runInBackground(
        c,
        fanoutToAgents(c, [result.handler_agent_id], 'action.invoked', eventData),
        'fanout action.invoked',
      );
    }
    await sendWebhookEvent(c, {
      type: 'action.invoked',
      workspaceId: workspace.id,
      data: eventData,
    });
    emitServerEvent(c, workspace.id, 'relaycast_server_action_invoked', {
      action_name: result.action_name,
      invocation_id: result.invocation_id,
      caller_agent_id: agent.id,
    });

    return c.json({ ok: true, data: result }, 201);
  } catch (err: unknown) {
    const error = asCodedError(err);
    if (error.code === 'action_denied') {
      const workspace = c.get('workspace');
      const agent = c.get('agent')!;
      const eventData = {
        action_name: c.req.param('name'),
        caller_name: agent.name,
        error: error.message,
      };
      runInBackground(c, fanoutToAgents(c, [agent.id], 'action.denied', eventData), 'fanout action.denied');
      await sendWebhookEvent(c, {
        type: 'action.denied',
        workspaceId: workspace.id,
        data: eventData,
      });
    }
    return errorResponse(c, error);
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

    await emitInvocationCompletionEffects(c.get('engine'), workspace.id, result);

    // Strip caller_id from client response (internal routing detail)
    const { caller_id: _drop, ...publicResult } = result;
    return c.json({ ok: true, data: publicResult });
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// GET /v1/actions/:name/invocations/:id - get invocation status
actionRoutes.get('/actions/:name/invocations/:id', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const result = await actionEngine.getInvocation(db, workspace.id, c.req.param('name'), c.req.param('id'));
    if (!result) {
      return c.json(
        { ok: false, error: { code: 'invocation_not_found', message: 'Invocation not found' } },
        404,
      );
    }
    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});
