import { Hono } from 'hono';
import { z } from 'zod';
import { FleetNodeTagSchema } from '@relaycast/types';
import type { AppEnv } from '../env.js';
import { requireAuth, requireWorkspaceRead, requireWorkspaceKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { asCodedError, errorResponse } from '../lib/httpError.js';
import { isSafeExternalUrl } from '../lib/ssrf.js';
import {
  jsonCreated,
  jsonError,
  jsonNotFound,
  jsonNoContent,
  jsonOk,
  parseJsonBody,
  parseOptionalJsonBody,
} from '../lib/httpResponse.js';
import * as nodeEngine from '../engine/node.js';
import { serializeNodeOp } from '../engine/nodeLock.js';
import * as actionEngine from '../engine/action.js';
import { sendNodeDeliveriesToAgents } from '../engine/nodeDeliver.js';
import { fanoutToWorkspace } from './fanout.js';
import { runInBackground } from './background.js';
import { sendWebhookEvent } from './webhookOutbox.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';
import {
  getObserverTokenFromContext,
  normalizeObserverFilters,
  observerAllowsAgent,
} from '../engine/observerToken.js';

export const nodeRoutes = new Hono<AppEnv>();

const nodeKindSchema = z.enum(['ws', 'http_push', 'poll']);
const nodeRoleSchema = z.enum(['direct', 'broker']);
const deliveryAckModeSchema = z.enum(['on_2xx', 'manual', 'response']);
const headerNameSchema = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/);
const headerValueSchema = z.string().refine((value) => !/[\r\n]/.test(value), 'header values cannot contain CR/LF');
const deliveryAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('bearer'), token: z.string().min(1) }),
  z.object({ type: z.literal('static_headers'), headers: z.record(headerNameSchema, headerValueSchema) }),
  z.object({
    type: z.literal('hmac_sha256'),
    secret: z.string().min(1),
    signature_header: headerNameSchema.default('X-Relaycast-Signature'),
    timestamp_header: headerNameSchema.default('X-Relaycast-Timestamp'),
    signed_payload: z.enum(['body', 'timestamp.body']).default('timestamp.body'),
    encoding: z.literal('hex').default('hex'),
    prefix: z.string().default('sha256='),
  }),
]);

const httpDeliverySchema = z.object({
  url: z.url(),
  ack_mode: deliveryAckModeSchema.default('manual'),
  auth: deliveryAuthSchema.default({ type: 'none' }),
  // Opt this node's webhook delivery into the deployment-configured egress proxy
  // (EngineConfig.httpPushProxy). `url` stays the real destination; the engine
  // forwards through the proxy at dispatch time. See dispatchHttpPush.
  use_proxy: z.boolean().optional(),
});

const createNodeSchema = z.object({
  node_id: z.string().min(1).optional(),
  name: z.string().min(1),
  // Dedupe key for re-enrollment: a host that keeps no node_id gets a fresh
  // name each boot, and without this every boot minted another roster row.
  machine_id: z.string().min(1).optional(),
  kind: nodeKindSchema.optional(),
  role: nodeRoleSchema.optional(),
  delivery_adapter: z.string().min(1).optional(),
  delivery: z.record(z.string(), z.unknown()).nullable().optional(),
  capabilities: z.array(z.string().min(1)).optional(),
  max_agents: z.number().int().nonnegative().optional(),
  tags: z.array(FleetNodeTagSchema).optional(),
  version: z.string().optional(),
});

const bindAgentSchema = z.object({
  agent_name: z.string().min(1),
  session_ref: z.string().nullable().optional(),
  priority: z.number().int().optional(),
});

const invokeNodeActionSchema = z.object({
  input: z.record(z.string(), z.unknown()).optional(),
});

function normalizeDelivery(kind: z.infer<typeof nodeKindSchema>, delivery: Record<string, unknown> | null | undefined) {
  if (kind !== 'http_push') return delivery ?? null;
  const parsed = httpDeliverySchema.safeParse(delivery ?? {});
  if (!parsed.success) {
    return parsed;
  }
  return parsed.data;
}

function strictExternalUrl(c: Parameters<typeof jsonError>[0]): boolean {
  const environment = c.get('engine').config.environment;
  return environment !== 'test';
}

type NodeRosterEntry = Awaited<ReturnType<typeof nodeEngine.listNodes>>[number];
type NodeAgentBinding = NonNullable<Awaited<ReturnType<typeof nodeEngine.listNodeAgents>>>[number];
type ObserverContext = ReturnType<typeof getObserverTokenFromContext>;

function observerHasAgentFilter(observer: ObserverContext): boolean {
  return Boolean(observer && normalizeObserverFilters(observer.filters).agent_ids?.length);
}

function filterNodeAgentsForObserver(observer: ObserverContext, bindings: NodeAgentBinding[]): NodeAgentBinding[] {
  return bindings.filter((binding) => observerAllowsAgent(observer, binding.agent_id));
}

async function filterNodesForObserver(
  db: Parameters<typeof nodeEngine.listNodes>[0],
  workspaceId: string,
  observer: ObserverContext,
  roster: NodeRosterEntry[],
): Promise<NodeRosterEntry[]> {
  if (!observerHasAgentFilter(observer)) return roster;
  const visible: NodeRosterEntry[] = [];
  for (const node of roster) {
    const bindings = await nodeEngine.listNodeAgents(db, workspaceId, node.name);
    const visibleBindings = bindings ? filterNodeAgentsForObserver(observer, bindings) : [];
    if (visibleBindings.length > 0) {
      visible.push({ ...node, active_agents: visibleBindings.length });
    }
  }
  return visible;
}

// POST /v1/nodes - enroll or rotate a node token (workspace-key only)
nodeRoutes.post('/nodes', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const parsed = await parseJsonBody(c, createNodeSchema, 'invalid node body');
    if (!parsed.ok) {
      return parsed.response;
    }
    const existing = await nodeEngine.resolveNodeForEnroll(c.get('db'), c.get('workspace').id, parsed.data);
    const kind = parsed.data.kind ?? (existing?.kind as z.infer<typeof nodeKindSchema> | undefined) ?? 'ws';
    const role = parsed.data.role
      ?? (existing?.role as z.infer<typeof nodeRoleSchema> | undefined)
      ?? (kind === 'ws' || (parsed.data.max_agents !== undefined && parsed.data.max_agents > 1) ? 'broker' : 'direct');
    const deliveryInput = parsed.data.delivery === undefined
      ? existing?.deliveryConfig ?? null
      : parsed.data.delivery;
    const delivery = normalizeDelivery(kind, deliveryInput);
    if (delivery && 'success' in delivery && !delivery.success) {
      return jsonError(c, 'invalid_node_delivery', 'invalid node delivery body', 400);
    }
    if (kind === 'http_push') {
      const url = (delivery as { url?: string } | null)?.url;
      if (!url) {
        return jsonError(c, 'invalid_node_delivery', 'http_push nodes require delivery.url', 400);
      }
      if (!isSafeExternalUrl(url, { strict: strictExternalUrl(c) })) {
        return jsonError(c, 'unsafe_node_delivery_url', 'delivery.url is not allowed', 400);
      }
    }
    if (role === 'direct' && (parsed.data.max_agents ?? existing?.maxAgents ?? 1) !== 1) {
      return jsonError(c, 'direct_node_capacity_exceeded', 'direct nodes can bind at most one agent', 400);
    }
    const result = await nodeEngine.createNodeToken(c.get('db'), c.get('workspace').id, {
      ...parsed.data,
      kind,
      role,
      delivery: delivery && !('success' in delivery) ? delivery : null,
    });
    return jsonCreated(c, result);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// GET /v1/nodes?capability=&name= - node roster
nodeRoutes.get('/nodes', requireWorkspaceRead('nodes:read'), rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const result = await nodeEngine.listNodes(db, workspace.id, {
      capability: c.req.query('capability'),
      name: c.req.query('name'),
    });
    return jsonOk(c, await filterNodesForObserver(
      db,
      workspace.id,
      getObserverTokenFromContext(c),
      result,
    ));
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// GET /v1/nodes/:name/agents - active agent bindings for a node
nodeRoutes.get('/nodes/:name/agents', requireWorkspaceRead('nodes:read'), rateLimit, async (c) => {
  try {
    const result = await nodeEngine.listNodeAgents(c.get('db'), c.get('workspace').id, c.req.param('name'));
    if (!result) {
      return jsonNotFound(c, 'node_not_found', 'Node not found');
    }
    const observer = getObserverTokenFromContext(c);
    const visibleBindings = filterNodeAgentsForObserver(observer, result);
    // Mirror the single-node endpoint: an observer scoped to specific agents
    // must not be able to probe node existence, so hide nodes with no visible
    // bindings behind the same not-found response.
    if (observerHasAgentFilter(observer) && visibleBindings.length === 0) {
      return jsonNotFound(c, 'node_not_found', 'Node not found');
    }
    return jsonOk(c, visibleBindings);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// POST /v1/nodes/:name/agents - bind an agent to a node delivery host
nodeRoutes.post('/nodes/:name/agents', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const parsed = await parseJsonBody(c, bindAgentSchema, (failure) => {
      const hasAgentIssue = failure.error.issues.some((issue) => issue.path[0] === 'agent_name');
      return hasAgentIssue ? 'agent_name is required' : 'invalid node agent binding body';
    });
    if (!parsed.ok) {
      return parsed.response;
    }
    const result = await nodeEngine.bindAgentToNode(
      c.get('db'),
      c.get('workspace').id,
      c.req.param('name'),
      parsed.data.agent_name,
      {
        session_ref: parsed.data.session_ref,
        priority: parsed.data.priority,
      },
    );
    return jsonCreated(c, result);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// DELETE /v1/nodes/:name/agents/:agentName - remove an active node binding
nodeRoutes.delete('/nodes/:name/agents/:agentName', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const deleted = await nodeEngine.unbindAgentFromNode(
      c.get('db'),
      c.get('workspace').id,
      c.req.param('name'),
      c.req.param('agentName'),
    );
    if (!deleted) {
      return jsonNotFound(c, 'node_agent_binding_not_found', 'Node agent binding not found');
    }
    return jsonNoContent(c);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// POST /v1/nodes/:node/actions/:name/invoke - node-addressed action invoke
nodeRoutes.post('/nodes/:node/actions/:name/invoke', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const agent = c.get('agent');
    if (!agent) {
      return jsonError(c, 'agent_token_required', 'Agent token required to invoke actions', 403);
    }
    const node = await nodeEngine.getNodeByName(db, workspace.id, c.req.param('node'));
    if (!node) {
      return jsonNotFound(c, 'node_not_found', 'Node not found');
    }
    const parsed = await parseOptionalJsonBody(c, invokeNodeActionSchema, 'invalid invocation body');
    if (!parsed.ok) {
      return parsed.response;
    }

    const { nodeConnections } = c.get('engine');
    const actionName = c.req.param('name');
    const result = await actionEngine.invokeNodeAction(
      db,
      workspace.id,
      node.id,
      actionName,
      { input: parsed.data.input, caller_id: agent.id, caller_name: agent.name },
      { nodeConnections },
    );

    const eventData = {
      invocation_id: result.invocation_id,
      action_name: result.action_name,
      caller_name: agent.name,
      handler_agent_id: result.handler_agent_id,
      handler_node_id: result.handler_node_id,
    };
    await sendWebhookEvent(c, { type: 'action.invoked', workspaceId: workspace.id, data: eventData });
    emitServerEvent(c, workspace.id, 'relaycast_server_action_invoked', {
      action_name: result.action_name,
      invocation_id: result.invocation_id,
      caller_agent_id: agent.id,
    });
    runInBackground(c, fanoutToWorkspace(c, 'action.invoked', eventData), 'fanout action.invoked');
    return jsonCreated(c, result);
  } catch (err: unknown) {
    const error = asCodedError(err);
    if (error.code === 'action_denied') {
      const workspace = c.get('workspace');
      const agent = c.get('agent')!;
      const eventData = { action_name: c.req.param('name'), caller_name: agent.name, error: error.message };
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
      await sendWebhookEvent(c, { type: 'action.denied', workspaceId: workspace.id, data: eventData });
      runInBackground(c, fanoutToWorkspace(c, 'action.denied', eventData), 'fanout action.denied');
    }
    return errorResponse(c, error);
  }
});

// DELETE /v1/nodes/:node/providers/:name - remove a provider's attachment + manifest
nodeRoutes.delete('/nodes/:node/providers/:name', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const node = await nodeEngine.getNodeByName(db, workspace.id, c.req.param('node'));
    if (!node) {
      return jsonNotFound(c, 'node_not_found', 'Node not found');
    }
    // Serialize with node-control operations so removal can't race a concurrent
    // register/heartbeat's aggregate recompute.
    const engine = c.get('engine');
    await serializeNodeOp(workspace.id, node.id, () =>
      nodeEngine.deregisterProvider(db, engine.nodeConnections, workspace.id, node.id, c.req.param('name'), engine),
    );
    return jsonNoContent(c);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// GET /v1/nodes/:name - single node roster entry
nodeRoutes.get('/nodes/:name', requireWorkspaceRead('nodes:read'), rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const name = c.req.param('name');
    const result = await nodeEngine.getPublicNode(db, workspace.id, name);
    if (!result) {
      return jsonNotFound(c, 'node_not_found', 'Node not found');
    }
    const observer = getObserverTokenFromContext(c);
    if (observerHasAgentFilter(observer)) {
      const bindings = await nodeEngine.listNodeAgents(db, workspace.id, name);
      const visibleBindings = bindings ? filterNodeAgentsForObserver(observer, bindings) : [];
      if (visibleBindings.length === 0) {
        return jsonNotFound(c, 'node_not_found', 'Node not found');
      }
      return jsonOk(c, { ...result, active_agents: visibleBindings.length });
    }
    return jsonOk(c, result);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});
