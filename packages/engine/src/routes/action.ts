import { Hono } from 'hono';
import { z } from 'zod';
import { AgentRegistrationAuthoritySchema, FleetWireJsonValueSchema } from '@relaycast/types';
import type { AppEnv } from '../env.js';
import { errorResponse } from '../lib/httpError.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as actionEngine from '../engine/action.js';
import { emitInvocationCompletionEffects } from '../engine/invocationCompletion.js';
import { sendNodeDeliveriesToAgents } from '../engine/nodeDeliver.js';
import { fanoutToWorkspace } from './fanout.js';
import { runInBackground } from './background.js';
import { sendWebhookEvent } from './webhookOutbox.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';
import { asCodedError } from '../lib/httpError.js';
import { authorizeExistingAgentCredential } from '../engine/agentCredentialAuthority.js';
import {
  jsonCreated,
  jsonError,
  jsonNoContent,
  jsonNotFound,
  jsonOk,
  parseJsonBody,
  parseOptionalJsonBody,
} from '../lib/httpResponse.js';

export const actionRoutes = new Hono<AppEnv>();

const registerActionSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  handler_agent: z.string().min(1).optional(),
  handler_node: z.string().min(1).optional(),
  input_schema: z.record(z.string(), z.unknown()).optional(),
  output_schema: z.record(z.string(), z.unknown()).optional(),
  available_to: z.array(z.string().min(1)).optional(),
}).refine(
  ({ handler_agent, handler_node }) => Boolean(handler_agent || handler_node),
  {
    path: ['handler_agent'],
    message: 'handler_agent or handler_node is required',
  },
);

const invokeActionSchema = z.object({
  input: z.record(z.string(), z.unknown()).optional(),
  // Kept outside `input`: authority material must be consumed by Relaycast and
  // never persisted in the invocation record or forwarded to an action host.
  registration_authority: AgentRegistrationAuthoritySchema.optional(),
});

const completeInvocationSchema = z.object({
  output: FleetWireJsonValueSchema.optional(),
  error: z.string().optional(),
  duration_ms: z.number().int().nonnegative().optional(),
});

// POST /v1/actions - register an action
actionRoutes.post('/actions', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const parsed = await parseJsonBody(c, registerActionSchema, (failure) => {
      const hasNameIssue = failure.error.issues.some((i) => i.path[0] === 'name');
      const hasDescIssue = failure.error.issues.some((i) => i.path[0] === 'description');
      const hasHandlerIssue = failure.error.issues.some((i) => i.path[0] === 'handler_agent' || i.path[0] === 'handler_node');
      return hasNameIssue
        ? 'name is required'
        : hasDescIssue
          ? 'description is required'
          : hasHandlerIssue
            ? 'handler_agent or handler_node is required'
            : 'invalid action registration body';
    });
    if (!parsed.ok) {
      return parsed.response;
    }

    // If called with an agent token, handler_agent must match the calling agent
    const callerAgent = c.get('agent');
    if (callerAgent && parsed.data.handler_agent !== callerAgent.name) {
      return jsonError(c, 'forbidden', `Agent "${callerAgent.name}" may only register actions it will handle itself`, 403);
    }

    const { created, action } = await actionEngine.registerAction(db, workspace.id, parsed.data, {
      completionDeps: c.get('engine'),
    });

    emitServerEvent(c, workspace.id, 'relaycast_server_action_registered', {
      action_name: action.name,
      handler_agent_name: parsed.data.handler_agent ?? null,
      handler_node_name: parsed.data.handler_node ?? null,
    });
    runInBackground(
      c,
      fanoutToWorkspace(c, 'action.registered', { action_name: action.name }),
      'fanout action.registered',
    );

    // 201 when the action was created, 200 when an existing registration was
    // refreshed (idempotent re-register).
    return created ? jsonCreated(c, action) : jsonOk(c, action);
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
    return jsonOk(c, result);
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
      return jsonNotFound(c, 'action_not_found', 'Action not found');
    }
    return jsonOk(c, result);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// DELETE /v1/actions/:name - delete an action
actionRoutes.delete('/actions/:name', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const deleted = await actionEngine.deleteAction(db, workspace.id, c.req.param('name'), {
      completionDeps: c.get('engine'),
    });
    if (!deleted) {
      return jsonNotFound(c, 'action_not_found', 'Action not found');
    }
    emitServerEvent(c, workspace.id, 'relaycast_server_action_deleted', {
      action_name: c.req.param('name'),
    });
    return jsonNoContent(c);
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
      return jsonError(c, 'agent_token_required', 'Agent token required to invoke actions', 403);
    }

    const parsed = await parseOptionalJsonBody(c, invokeActionSchema, 'invalid invocation body');
    if (!parsed.ok) {
      return parsed.response;
    }

    // `release` is a built-in action, so the generic action endpoint reaches
    // the same destructive lifecycle as POST /v1/agents/release. Do not let an
    // agent token bypass that route's sponsor/work-unit ownership check.
    const actionName = c.req.param('name');
    const actionInput = parsed.data.input;
    if (actionName === 'release' && actionInput?.delete_agent === true) {
      const targetName = actionInput.name;
      if (typeof targetName !== 'string' || targetName.length === 0) {
        return jsonError(c, 'invalid_release_request', 'release action input.name is required', 400);
      }
      await authorizeExistingAgentCredential(
        db,
        c.get('engine').config,
        workspace.id,
        targetName,
        parsed.data.registration_authority,
      );
    }

    const { nodeConnections } = c.get('engine');
    const result = await actionEngine.invokeAction(
      db,
      workspace.id,
      actionName,
      {
        input: parsed.data.input,
        caller_id: agent.id,
        caller_name: agent.name,
      },
      {
        nodeConnections,
      },
    );

    const eventData = {
      invocation_id: result.invocation_id,
      action_name: result.action_name,
      caller_name: agent.name,
      handler_agent_id: result.handler_agent_id,
      handler_node_id: result.handler_node_id,
    };

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
    // Surface the invocation on the workspace observer stream so dashboards see
    // actions happening (spawns, callbacks) and not just their completions.
    // The completion side already publishes action.completed / action.failed.
    runInBackground(
      c,
      fanoutToWorkspace(c, 'action.invoked', eventData),
      'fanout action.invoked',
    );

    return jsonCreated(c, result);
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
      runInBackground(
        c,
        sendNodeDeliveriesToAgents(
          {
            db: c.get('db'),
            nodeConnections: c.get('engine').nodeConnections,
            environment: c.get('engine').config?.environment,
            httpPushProxy: c.get('engine').config?.httpPushProxy,
            workspaceId: workspace.id,
          },
          {
            agentIds: [agent.id],
            event: 'action.denied',
            eventKey: `${c.req.param('name')}:${agent.id}`,
            data: eventData,
            messageId: c.req.param('name'),
          },
        ),
        'node deliver action.denied',
      );
      await sendWebhookEvent(c, {
        type: 'action.denied',
        workspaceId: workspace.id,
        data: eventData,
      });
      runInBackground(
        c,
        fanoutToWorkspace(c, 'action.denied', eventData),
        'fanout action.denied',
      );
    }
    return errorResponse(c, error);
  }
});

// POST /v1/actions/:name/invocations/:id/complete - handler reports result
actionRoutes.post('/actions/:name/invocations/:id/complete', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const parsed = await parseOptionalJsonBody(c, completeInvocationSchema, 'invalid completion body');
    if (!parsed.ok) {
      return parsed.response;
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
      return jsonNotFound(c, 'invocation_not_found', 'Invocation not found');
    }

    await emitInvocationCompletionEffects(c.get('engine'), workspace.id, result);

    // Strip caller_id from client response (internal routing detail)
    const { caller_id: _drop, ...publicResult } = result;
    return jsonOk(c, publicResult);
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
      return jsonNotFound(c, 'invocation_not_found', 'Invocation not found');
    }
    return jsonOk(c, result);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});
