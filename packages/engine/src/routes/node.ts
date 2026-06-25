import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireWorkspaceRead, requireWorkspaceKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { errorResponse } from '../lib/httpError.js';
import { isSafeExternalUrl } from '../lib/ssrf.js';
import {
  jsonCreated,
  jsonError,
  jsonNotFound,
  jsonNoContent,
  jsonOk,
  parseJsonBody,
} from '../lib/httpResponse.js';
import * as nodeEngine from '../engine/node.js';

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
});

const createNodeSchema = z.object({
  node_id: z.string().min(1).optional(),
  name: z.string().min(1),
  kind: nodeKindSchema.optional(),
  role: nodeRoleSchema.optional(),
  delivery_adapter: z.string().min(1).optional(),
  delivery: z.record(z.string(), z.unknown()).nullable().optional(),
  capabilities: z.array(z.string().min(1)).optional(),
  max_agents: z.number().int().nonnegative().optional(),
  tags: z.array(z.string()).optional(),
  version: z.string().optional(),
});

const bindAgentSchema = z.object({
  agent_name: z.string().min(1),
  session_ref: z.string().nullable().optional(),
  priority: z.number().int().optional(),
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

// POST /v1/nodes - enroll or rotate a node token (workspace-key only)
nodeRoutes.post('/nodes', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const parsed = await parseJsonBody(c, createNodeSchema, 'invalid node body');
    if (!parsed.ok) {
      return parsed.response;
    }
    const existing = await nodeEngine.getNodeByName(c.get('db'), c.get('workspace').id, parsed.data.name);
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
    const result = await nodeEngine.listNodes(c.get('db'), c.get('workspace').id, {
      capability: c.req.query('capability'),
      name: c.req.query('name'),
    });
    return jsonOk(c, result);
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
    return jsonOk(c, result);
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

// GET /v1/nodes/:name - single node roster entry
nodeRoutes.get('/nodes/:name', requireWorkspaceRead('nodes:read'), rateLimit, async (c) => {
  try {
    const result = await nodeEngine.getPublicNode(c.get('db'), c.get('workspace').id, c.req.param('name'));
    if (!result) {
      return jsonNotFound(c, 'node_not_found', 'Node not found');
    }
    return jsonOk(c, result);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});
