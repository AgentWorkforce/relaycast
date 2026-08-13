import { Hono } from 'hono';
import type { Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AgentRegistrationAuthoritySchema } from '@relaycast/types';
import type { AppEnv } from '../env.js';
import { a2aAgents, agents, messages, workspaces } from '../db/schema.js';
import { requireAuth, hashToken } from '../middleware/auth.js';
import { asCodedError, errorResponse, type CodedError } from '../lib/httpError.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { runIdempotent } from '../middleware/idempotency.js';
import { runInBackground } from './background.js';
import { resolveMailboxConfig } from '../engine/mailboxConfig.js';
import * as a2aEngine from '../engine/a2a.js';
import * as dmEngine from '../engine/dm.js';
import { buildDmReceivedEventData } from '../engine/deliveryWire.js';
import { publishWorkspaceEvent } from './fanout.js';
import { notifyDeliveryRejections, routeDeliveryOutcomes } from './deliveryRouting.js';
import { sendWebhookEvent } from './webhookOutbox.js';
import {
  jsonCreated,
  jsonError,
  jsonNotFound,
  jsonOk,
  parseJsonBody,
} from '../lib/httpResponse.js';

export const a2aRoutes = new Hono<AppEnv>();

const registerA2aSchema = z.object({
  agent_card_url: z.string().url().optional(),
  agent_card: a2aEngine.A2aAgentCardSchema.optional(),
  auth_scheme: z.enum(['bearer', 'api_key', 'none']).optional(),
  auth_credential: z.string().optional(),
  target_agent: z.string().min(1).optional(),
  registration_authority: AgentRegistrationAuthoritySchema.optional(),
}).refine((value) => value.agent_card_url || value.agent_card, {
  message: 'agent_card_url or agent_card is required',
  path: ['agent_card_url'],
});

const updateA2aConnectionSchema = z.object({
  auth_scheme: z.enum(['bearer', 'api_key', 'none']).optional(),
  auth_credential: z.string().min(1).nullable().optional(),
  target_agent: z.string().min(1).nullable().optional(),
}).refine(
  (value) => Object.values(value).some((field) => field !== undefined),
  { message: 'At least one connection field is required' },
);

const rpcRequestSchema = a2aEngine.JsonRpcRequestSchema;
const rpcWebhookSchema = z.union([a2aEngine.JsonRpcRequestSchema, a2aEngine.JsonRpcResponseSchema]);

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

  // An explicit path selector must beat host inference. Previously the host
  // branch was consulted first, so on any authority with three or more labels
  // — which the Relay identifier profile requires — the documented
  // `/:workspace/.well-known/agent-card.json` route could never take effect.
  const pathWorkspace = c.req.param('workspace');
  if (pathWorkspace) return pathWorkspace;

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
      targetAgent: parsed.data.target_agent,
      registrationAuthority: parsed.data.registration_authority,
      engineConfig: c.get('engine').config,
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

// PATCH /v1/a2a/agents/:name
a2aRoutes.patch('/v1/a2a/agents/:name', requireAuth, rateLimit, async (c) => {
  try {
    const parsed = await parseJsonBody(c, updateA2aConnectionSchema, 'At least one connection field is required');
    if (!parsed.ok) {
      return parsed.response;
    }

    const updated = await a2aEngine.updateA2aAgentConnection(
      c.get('db'),
      c.get('workspace').id,
      c.req.param('name'),
      {
        authScheme: parsed.data.auth_scheme,
        authCredential: parsed.data.auth_credential,
        targetAgent: parsed.data.target_agent,
      },
    );
    if (!updated) {
      return a2aAgentNotFound(c);
    }

    return jsonOk(c, {
      relay_name: updated.relay_name,
      auth_scheme: updated.auth_scheme,
      target_agent: updated.relay_metadata?.a2a_target_agent ?? null,
      updated: true,
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

    // A self-hosted, single-tenant deployment must answer the standard bare
    // well-known URL without requiring a Relaycast-specific query parameter.
    //
    // Two guards, and the distinction between them is deliberate:
    //
    // 1. An *explicit* selector is caller intent, so a misspelled `?workspace=`
    //    or `/:workspace/` must 404 rather than silently resolving to a
    //    different tenant. Host-label inference is not caller intent — it is a
    //    hosted workspace-per-subdomain convention, and on any authority with
    //    three or more labels it always produces a candidate. Treating it as an
    //    explicit selector would mean the fallback never fires on exactly the
    //    deployments it exists for.
    // 2. The row cap is what makes that safe: with two or more workspaces the
    //    fallback declines rather than guessing, so there is no tenant boundary
    //    to cross. It is `limit(2)` rather than a count so a large table is
    //    never scanned.
    //
    // Net effect: on a multi-tenant deployment an unresolved host label 404s;
    // on a single-tenant one it serves the only workspace there is. The card is
    // unauthenticated by design (A2A discovery), so this exposes nothing that
    // the standard well-known path is not already meant to publish.
    if (
      !workspace
      && !c.req.query('workspace')
      && !c.req.param('workspace')
    ) {
      const candidates = await db.select().from(workspaces).limit(2);
      if (candidates.length === 1) {
        workspace = candidates[0]!;
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

    // A bearer token issued by A2A registration identifies the remote
    // deployment's local proxy. Requests from that proxy land on a real local
    // agent; they must never be used as an authenticated open relay to another
    // external A2A target.
    const authenticatedAgent = c.get('agent');
    const [registeredCaller] = authenticatedAgent
      ? await db
        .select({ id: a2aAgents.id })
        .from(a2aAgents)
        .where(and(
          eq(a2aAgents.workspaceId, workspace.id),
          eq(a2aAgents.relayAgentId, authenticatedAgent.id),
        ))
      : [];

    if (registeredCaller) {
      if (request.method !== 'message/send') {
        // `message/stream` is deliberately refused here rather than served.
        //
        // This branch performs a single sendDm and returns a task already in a
        // terminal `queued` state with no stream channel. A client that calls
        // message/stream expects a `working` task plus somewhere to subscribe
        // for incremental updates; handing it a completed one-shot is a wrong
        // answer dressed as a right one, and it would silently truncate a
        // conversation the caller believes is still open. Refusing lets the
        // caller fall back to message/send immediately and correctly.
        const detail = request.method === 'message/stream'
          ? 'message/stream is not supported on inbound federated delivery; use message/send'
          : `Unsupported inbound method "${request.method}"`;
        const response = a2aEngine.jsonRpcError(request.id, -32601, detail);
        return jsonResponse(c, response, jsonRpcHttpStatus(response));
      }
      if (!request.params?.message) {
        const response = a2aEngine.jsonRpcError(request.id, -32602, 'message is required');
        return jsonResponse(c, response, jsonRpcHttpStatus(response));
      }
      if (target) {
        const response = a2aEngine.jsonRpcError(request.id, -32003, 'A registered A2A caller cannot relay to another external agent');
        return jsonResponse(c, response, 403);
      }

      const [localTarget] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.workspaceId, workspace.id), eq(agents.name, targetAgentName)));
      if (!localTarget) {
        const response = a2aEngine.jsonRpcError(request.id, -32004, `Unknown local agent "${targetAgentName}"`);
        return jsonResponse(c, response, jsonRpcHttpStatus(response));
      }

      const relayMessage = a2aEngine.translateA2aToRelay(request);

      // Inbound deliveries must be idempotent, because the sending side retries.
      // `sendToExternalAgent` re-sends on 5xx, and everything after the durable
      // DM write here — the counter, the webhook, the workspace event, delivery
      // routing — can still fail. Without a key, that retry writes a second DM
      // and the counterparty's proof or task is delivered twice. The DM route
      // already runs every send through `runIdempotent`; this path called
      // `sendDm` directly and skipped it.
      //
      // The key is the caller's own message id where it supplies one, falling
      // back to the JSON-RPC request id, scoped to the registered caller so two
      // counterparties cannot collide on the same value.
      const inboundMessageId =
        typeof request.params?.message?.message_id === 'string'
          ? request.params.message.message_id
          : typeof request.id === 'string' || typeof request.id === 'number'
            ? String(request.id)
            : null;

      const idempotent = await runIdempotent({
        workspaceId: workspace.id,
        actorId: authenticatedAgent!.id,
        scope: 'a2a:inbound',
        key: inboundMessageId ? `${registeredCaller.id}:${inboundMessageId}` : undefined,
        status: 200,
        fingerprint: JSON.stringify({
          to: targetAgentName,
          text: relayMessage.text,
          data: relayMessage.metadata ?? null,
        }),
        kv: c.get('engine').kv,
        operation: () => dmEngine.sendDm(db, workspace.id, authenticatedAgent!.id, {
          to: targetAgentName,
          text: relayMessage.text,
          mode: 'wait',
          data: relayMessage.metadata,
        }, {
          skipA2aIntercept: true,
          // Without this, sendDm falls back to its fixed one-hour / 1000-message
          // defaults and a registered peer's deliveries quietly ignore whatever
          // TTL and depth cap the operator configured — the one delivery path on
          // the deployment that is exempt from its own backpressure settings.
          mailbox: resolveMailboxConfig(c.get('engine').config, workspace.id),
        }),
      });
      const sent = idempotent.data;

      // A replay returns the original result and must not repeat the side
      // effects: re-counting the message, re-firing dm.received to webhooks and
      // the workspace stream, or re-routing delivery would make a retried
      // request observably different from a single one, which is the thing
      // idempotency exists to prevent. The response below is identical either
      // way, so the caller cannot tell — which is the point.
      if (!idempotent.replayed) {
        await a2aEngine.incrementA2aMessagesReceived(db, registeredCaller.id);

        // Fanout and delivery routing run in the background, as `/v1/dm` does.
        // Awaiting them made the counterparty's "message accepted" wait on our
        // recipient's delivery — including a slow HTTP-push receiver — so a
        // sluggish or failing local subscriber could delay or fail an A2A call
        // that had already been durably accepted. The write above is what the
        // response attests to; everything here is downstream of it.
        const eventData = buildDmReceivedEventData(sent, { fromName: authenticatedAgent!.name });
        runInBackground(
          c,
          sendWebhookEvent(c, { type: 'dm.received', workspaceId: workspace.id, data: eventData }),
          'a2a inbound webhook dm.received',
        );
        runInBackground(
          c,
          publishWorkspaceEvent(c, 'dm.received', eventData),
          'a2a inbound publish dm.received',
        );
        if (sent._delivery) {
          runInBackground(
            c,
            routeDeliveryOutcomes(c, [sent._delivery], 'dm.received', eventData),
            'a2a inbound route dm delivery',
          );
        }
        if (sent._delivery_rejections.length > 0) {
          runInBackground(
            c,
            notifyDeliveryRejections(c, authenticatedAgent!.id, sent._delivery_rejections),
            'a2a inbound fanout delivery rejected',
          );
        }
      }

      const response = a2aEngine.jsonRpcSuccess(request.id, {
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
            metadata: relayMessage.metadata,
          }],
          metadata: {
            conversation_id: sent.conversation_id,
            relay_agent: authenticatedAgent!.name,
            target_agent: targetAgentName,
          },
        },
      });
      return jsonResponse(c, response);
    }

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
      data: relayMessage.metadata,
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
