import { Hono } from 'hono';
import type { Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { a2aAgents, agents, messages, workspaces } from '../db/schema.js';
import { requireAuth, hashToken } from '../middleware/auth.js';
import { asCodedError, errorResponse, type CodedError } from '../lib/httpError.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as a2aEngine from '../engine/a2a.js';
import * as dmEngine from '../engine/dm.js';
import {
  jsonCreated,
  jsonError,
  jsonNotFound,
  jsonOk,
  parseJsonBody,
  parseQueryParams,
} from '../lib/httpResponse.js';

export const a2aRoutes = new Hono<AppEnv>();

const registerA2aSchema = z.object({
  agent_card_url: z.string().url().optional(),
  agent_card: a2aEngine.A2aAgentCardSchema.optional(),
  auth_scheme: z.enum(['bearer', 'api_key', 'none']).optional(),
  auth_credential: z.string().optional(),
}).refine((value) => value.agent_card_url || value.agent_card, {
  message: 'agent_card_url or agent_card is required',
  path: ['agent_card_url'],
});

const rpcRequestSchema = a2aEngine.JsonRpcRequestSchema;
const rpcWebhookSchema = z.union([a2aEngine.JsonRpcRequestSchema, a2aEngine.JsonRpcResponseSchema]);
const directoryQuerySchema = z.object({
  skill: z.string().optional(),
  tag: z.string().optional(),
  q: z.string().optional(),
});

function jsonRpcHttpStatus(response: a2aEngine.A2aJsonRpcResponse): number {
  return response.error ? 400 : 200;
}

function jsonResponse(c: Context<AppEnv>, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function codedJsonError(c: Context<AppEnv>, err: unknown) {
  return errorResponse(c, err);
}

function a2aAgentNotFound(c: Context<AppEnv>) {
  return jsonNotFound(c, 'a2a_agent_not_found', 'A2A agent not found');
}

function buildAbsoluteUrl(c: Context<AppEnv>, path: string): string {
  const url = new URL(c.req.url);
  return `${url.origin}${path}`;
}

function extractWorkspaceHint(c: Context<AppEnv>): string | null {
  const explicit = c.req.query('workspace');
  if (explicit) return explicit;

  const host = c.req.header('Host') ?? new URL(c.req.url).host;
  const hostname = host.split(':')[0] ?? '';
  const hostSegments = hostname.split('.').filter(Boolean);
  const reserved = new Set(['api', 'www', 'localhost']);
  if (hostSegments.length >= 3 && !reserved.has(hostSegments[0]!)) {
    return hostSegments[0]!;
  }

  return c.req.param('workspace') || null;
}

function extractTargetAgentName(params: Record<string, unknown> | undefined, fallbackContextId?: string): string | null {
  const candidates = [
    params?.agent_name,
    params?.agent,
    params?.target_agent,
    typeof params?.metadata === 'object' && params?.metadata !== null
      ? (params.metadata as Record<string, unknown>).agent_name
      : undefined,
    typeof params?.metadata === 'object' && params?.metadata !== null
      ? (params.metadata as Record<string, unknown>).target_agent
      : undefined,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  if (fallbackContextId?.startsWith('agent:')) return fallbackContextId.slice('agent:'.length);
  if (fallbackContextId?.startsWith('agent/')) return fallbackContextId.slice('agent/'.length);

  return null;
}

function extractCorrelationId(payload: a2aEngine.A2aJsonRpcRequest | a2aEngine.A2aJsonRpcResponse): string | null {
  const parsedRequest = a2aEngine.JsonRpcRequestSchema.safeParse(payload);
  if (parsedRequest.success) {
    return typeof parsedRequest.data.id === 'string' || typeof parsedRequest.data.id === 'number'
      ? String(parsedRequest.data.id)
      : parsedRequest.data.params?.message?.message_id ?? null;
  }

  const parsedResponse = a2aEngine.JsonRpcResponseSchema.safeParse(payload);
  if (!parsedResponse.success) return null;

  return typeof parsedResponse.data.id === 'string' || typeof parsedResponse.data.id === 'number'
    ? String(parsedResponse.data.id)
    : parsedResponse.data.result?.message?.message_id
      ?? parsedResponse.data.result?.task?.id
      ?? null;
}

async function findWebhookAgentByName(db: AppEnv['Variables']['db'], relayName: string, workspaceId: string) {
  const [row] = await db
    .select({
      workspaceId: a2aAgents.workspaceId,
      relayAgentId: a2aAgents.relayAgentId,
      relayName: agents.name,
      tokenHash: agents.tokenHash,
    })
    .from(a2aAgents)
    .innerJoin(agents, eq(a2aAgents.relayAgentId, agents.id))
    .where(and(eq(agents.name, relayName), eq(a2aAgents.workspaceId, workspaceId)));

  return row ?? null;
}

// POST /v1/a2a/register
a2aRoutes.post('/v1/a2a/register', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const parsed = await parseJsonBody(c, registerA2aSchema, 'agent_card_url or agent_card is required');
    if (!parsed.ok) {
      return parsed.response;
    }

    const result = await a2aEngine.registerA2aAgent(db, workspace.id, {
      agentCardUrl: parsed.data.agent_card_url,
      agentCard: parsed.data.agent_card,
      authScheme: parsed.data.auth_scheme,
      authCredential: parsed.data.auth_credential,
    });

    return jsonCreated(c, {
      relay_name: result.relayName,
      relay_token: result.relayToken,
      webhook_url: buildAbsoluteUrl(c, result.webhookUrl),
      certification: result.certification,
    });
  } catch (err: unknown) {
    return codedJsonError(c, err);
  }
});

// DELETE /v1/a2a/agents/:name
a2aRoutes.delete('/v1/a2a/agents/:name', requireAuth, rateLimit, async (c) => {
  try {
    const deleted = await a2aEngine.removeA2aAgent(c.get('db'), c.get('workspace').id, c.req.param('name'));
    if (!deleted) {
      return a2aAgentNotFound(c);
    }

    return jsonOk(c, { name: c.req.param('name'), removed: true });
  } catch (err: unknown) {
    return codedJsonError(c, err);
  }
});

// GET /v1/a2a/agents
a2aRoutes.get('/v1/a2a/agents', requireAuth, rateLimit, async (c) => {
  try {
    const agentsList = await a2aEngine.listA2aAgents(c.get('db'), c.get('workspace').id);
    return jsonOk(c, agentsList);
  } catch (err: unknown) {
    return codedJsonError(c, err);
  }
});

// GET /v1/a2a/directory
a2aRoutes.get('/v1/a2a/directory', requireAuth, rateLimit, async (c) => {
  try {
    const parsed = parseQueryParams(c, directoryQuerySchema, 'Invalid A2A directory query');
    if (!parsed.ok) {
      return parsed.response;
    }

    const entries = await a2aEngine.listA2aDirectory(
      c.get('db'),
      c.get('workspace').id,
      new URL(c.req.url).origin,
      parsed.data,
    );
    return jsonOk(c, entries);
  } catch (err: unknown) {
    return codedJsonError(c, err);
  }
});

// GET /v1/a2a/agents/:name/card
a2aRoutes.get('/v1/a2a/agents/:name/card', requireAuth, rateLimit, async (c) => {
  try {
    const record = await a2aEngine.getA2aAgentByRelayName(c.get('db'), c.get('workspace').id, c.req.param('name'));
    if (!record) {
      return a2aAgentNotFound(c);
    }

    return jsonOk(c, record.agent_card);
  } catch (err: unknown) {
    return codedJsonError(c, err);
  }
});

async function resolveWorkspaceFromAuth(c: Context<AppEnv>): Promise<{ id: string; name: string } | null> {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7);
  const result = await c.get('engine').auth.authenticate({
    token,
    require: 'any',
    db: c.get('db'),
  });
  return result.ok ? result.workspace : null;
}

async function handleWorkspaceAgentCard(c: Context<AppEnv>) {
  try {
    const db = c.get('db');

    // Try auth header first, then query/path param
    let workspace = await resolveWorkspaceFromAuth(c);

    if (!workspace) {
      const workspaceHint = extractWorkspaceHint(c);
      if (workspaceHint) {
        const [ws] = await db
          .select()
          .from(workspaces)
          .where(eq(workspaces.name, workspaceHint));
        workspace = ws ?? null;
      }
    }

    if (!workspace) {
      return jsonNotFound(c, 'workspace_not_found', 'Workspace could not be inferred from request. Provide an Authorization header or ?workspace= query param.');
    }

    const card = await a2aEngine.getWorkspaceAgentCard(db, workspace.id, workspace.name, new URL(c.req.url).origin);
    return jsonResponse(c, card);
  } catch (err: unknown) {
    return codedJsonError(c, err);
  }
}

// GET /.well-known/agent-card.json
a2aRoutes.get('/.well-known/agent-card.json', handleWorkspaceAgentCard);
a2aRoutes.get('/:workspace/.well-known/agent-card.json', handleWorkspaceAgentCard);

// POST /a2a/rpc
a2aRoutes.post('/a2a/rpc', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const parsed = rpcRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return jsonResponse(c, a2aEngine.jsonRpcError(undefined, -32600, 'Invalid Request'), 400);
    }

    const request = parsed.data;
    const targetAgentName = extractTargetAgentName(
      request.params as Record<string, unknown> | undefined,
      request.params?.message?.context_id,
    );

    if (!targetAgentName) {
      const response = a2aEngine.jsonRpcError(request.id, -32602, 'target_agent or agent_name is required');
      return jsonResponse(c, response, jsonRpcHttpStatus(response));
    }

    const target = await a2aEngine.getA2aAgentByRelayName(db, workspace.id, targetAgentName);
    if (!target) {
      const response = a2aEngine.jsonRpcError(request.id, -32004, `Unknown A2A agent "${targetAgentName}"`);
      return jsonResponse(c, response, jsonRpcHttpStatus(response));
    }

    switch (request.method) {
      case 'message/send':
      case 'message/stream':
      case 'task/get':
      case 'task/cancel': {
        const upstream = await a2aEngine.sendToExternalAgent(target.external_url, request, {
          scheme: target.auth_scheme,
          credential: target.auth_credential,
        });
        await a2aEngine.incrementA2aMessagesSent(db, target.id);
        return jsonResponse(c, upstream.response ?? a2aEngine.jsonRpcSuccess(request.id, {}));
      }
      default: {
        const response = a2aEngine.jsonRpcError(request.id, -32601, `Unsupported method "${request.method}"`);
        return jsonResponse(c, response, jsonRpcHttpStatus(response));
      }
    }
  } catch (err: unknown) {
    const error = asCodedError(err) as CodedError & { data?: unknown };
    return jsonResponse(
      c,
      a2aEngine.jsonRpcError(undefined, -32000, error.message || 'Internal error', error.data),
      error.status || 500,
    );
  }
});

// POST /a2a/webhook/:workspace_id/:agent_name
a2aRoutes.post('/a2a/webhook/:workspace_id/:agent_name', async (c) => {
  try {
    const db = c.get('db');
    const workspaceId = c.req.param('workspace_id');
    const relayName = c.req.param('agent_name');
    const relayAgent = await findWebhookAgentByName(db, relayName, workspaceId);

    if (!relayAgent) {
      return a2aAgentNotFound(c);
    }

    const token = c.req.header('Authorization')?.startsWith('Bearer ')
      ? c.req.header('Authorization')!.slice(7)
      : null;
    const tokenHash = token ? await hashToken(token) : null;
    if (!tokenHash || tokenHash !== relayAgent.tokenHash) {
      return jsonError(c, 'unauthorized', 'Missing or invalid bearer token', 401);
    }

    const parsed = rpcWebhookSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return jsonResponse(c, a2aEngine.jsonRpcError(undefined, -32600, 'Invalid Request'), 400);
    }

    const payload = parsed.data;
    const relayMessage = a2aEngine.translateA2aToRelay(payload);
    const requestPayload = a2aEngine.JsonRpcRequestSchema.safeParse(payload);

    let targetAgentName = requestPayload.success
      ? extractTargetAgentName(
        requestPayload.data.params as Record<string, unknown> | undefined,
        requestPayload.data.params?.message?.context_id,
      )
      : null;

    if (!targetAgentName) {
      const correlationId = extractCorrelationId(payload);
      if (correlationId) {
        const [originalSender] = await db
          .select({ agentName: agents.name })
          .from(messages)
          .innerJoin(agents, eq(messages.agentId, agents.id))
          .where(and(eq(messages.workspaceId, relayAgent.workspaceId), eq(messages.id, correlationId)));
        targetAgentName = originalSender?.agentName ?? null;
      }
    }

    if (!targetAgentName) {
      const response = a2aEngine.jsonRpcError(
        extractCorrelationId(payload) ?? undefined,
        -32602,
        'target_agent or agent_name is required',
      );
      return jsonResponse(c, response, jsonRpcHttpStatus(response));
    }

    const sent = await dmEngine.sendDm(db, relayAgent.workspaceId, relayAgent.relayAgentId, {
      to: targetAgentName,
      text: relayMessage.text,
      mode: 'wait',
    }, {
      skipA2aIntercept: true,
    });
    const a2aRecord = await a2aEngine.getA2aAgentByRelayName(db, relayAgent.workspaceId, relayName);
    if (a2aRecord) {
      await a2aEngine.incrementA2aMessagesReceived(db, a2aRecord.id);
    }

    const response = a2aEngine.jsonRpcSuccess(extractCorrelationId(payload) ?? undefined, {
      task: {
        id: sent.message.id,
        context_id: relayMessage.thread_id ?? sent.conversation_id,
        status: {
          state: a2aEngine.mapRelayTaskState('queued'),
          message: 'Message accepted by Relaycast',
        },
        history: [{
          message_id: sent.message.id,
          role: 'agent',
          context_id: relayMessage.thread_id ?? sent.conversation_id,
          parts: [{ kind: 'text', text: sent.message.text }],
        }],
        metadata: {
          conversation_id: sent.conversation_id,
          relay_agent: relayName,
          target_agent: targetAgentName,
        },
      },
    });

    return jsonResponse(c, response);
  } catch (err: unknown) {
    const error = asCodedError(err) as CodedError & { data?: unknown };
    return jsonResponse(
      c,
      a2aEngine.jsonRpcError(undefined, -32000, error.message || 'Internal error', error.data),
      error.status || 500,
    );
  }
});
