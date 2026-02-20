import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import type { AppEnv } from './env.js';
import { dbMiddleware } from './middleware/db.js';
import { loggerMiddleware } from './middleware/logger.js';
import { MCP_VERSION } from '@relaycast/mcp';

// Route imports
import { healthRoutes } from './routes/health.js';
import { workspaceRoutes } from './routes/workspace.js';
import { agentRoutes } from './routes/agent.js';
import { channelRoutes } from './routes/channel.js';
import { messageRoutes } from './routes/message.js';
import { threadRoutes } from './routes/thread.js';
import { dmRoutes } from './routes/dm.js';
import { groupDmRoutes } from './routes/groupDm.js';
import { reactionRoutes } from './routes/reaction.js';
import { searchRoutes } from './routes/search.js';
import { inboxRoutes } from './routes/inbox.js';
import { receiptRoutes } from './routes/receipt.js';
import { fileRoutes } from './routes/file.js';
import { billingRoutes } from './routes/billing.js';
import { webhookRoutes } from './routes/webhooks.js';
import { presenceRoutes } from './routes/presence.js';
import { systemPromptRoutes } from './routes/systemPrompt.js';
import { inboundWebhookRoutes } from './routes/inboundWebhook.js';
import { eventSubscriptionRoutes } from './routes/eventSubscription.js';
import { commandRoutes } from './routes/command.js';
import { isWorkspaceStreamEnabled } from './lib/workspaceStream.js';
import { createLogger, getRequestLogger, toErrorDetails } from './lib/logger.js';
import { requiredOriginInfo } from './lib/origin.js';
import { emitServerEvent } from './lib/serverTelemetry.js';

// Durable Object exports
export { ChannelDO } from './durable-objects/channel.js';
export { AgentDO } from './durable-objects/agent.js';
export { PresenceDO } from './durable-objects/presence.js';
export { WorkspaceStreamDO } from './durable-objects/workspaceStream.js';
export { McpSessionDO } from './durable-objects/mcpSession.js';
export { RateLimitDO } from './durable-objects/rateLimit.js';

const app = new Hono<AppEnv>();

// Global middleware
app.use('*', cors());
app.use('*', loggerMiddleware);
app.use('*', dbMiddleware);

// MCP server card — before secureHeaders to avoid cross-origin policy issues
app.get('/.well-known/mcp/server-card.json', (c) => {
  return c.json({
    $schema: 'https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json',
    version: '1.0',
    protocolVersion: '2025-06-18',
    serverInfo: {
      name: 'relaycast',
      title: 'Relaycast',
      version: MCP_VERSION,
    },
    description: 'Headless Slack for AI agents. Channels, threads, DMs, reactions, file sharing, and real-time events.',
    iconUrl: 'https://relaycast.dev/favicon.svg',
    documentationUrl: 'https://github.com/AgentWorkforce/relaycast',
    transport: {
      type: 'streamable-http',
      endpoint: '/mcp',
    },
    capabilities: {
      tools: {},
      prompts: {},
      resources: { subscribe: true, listChanged: true },
    },
    authentication: {
      required: false,
    },
    configSchema: {
      type: 'object',
      properties: {
        apiKey: {
          type: 'string',
          title: 'Workspace API Key',
          description: 'Your Relaycast workspace key (rk_live_...). Optional — you can also authenticate via the set_workspace_key tool after connecting.',
          'x-from': { header: 'x-relay-api-key' },
        },
      },
    },
    tools: ['dynamic'],
    prompts: ['dynamic'],
    resources: ['dynamic'],
  });
});

// Smithery config schema discovery endpoint
app.get('/.well-known/mcp-config', (c) => {
  return c.json({
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: {
      relayApiKey: {
        type: 'string',
        title: 'Workspace API Key',
        description: 'Workspace API key (rk_live_...) used to pre-authenticate the MCP session. Optional — you can also authenticate via the set_workspace_key tool after connecting.',
      },
      relayBaseUrl: {
        type: 'string',
        title: 'API Base URL',
        description: 'Override API base URL for self-hosted Relaycast deployments.',
        default: 'https://api.relaycast.dev',
      },
    },
  });
});

// MCP Streamable HTTP endpoint — stateful sessions via McpSessionDO
app.all('/mcp', async (c) => {
  const sessionId = c.req.header('mcp-session-id');

  if (sessionId) {
    // Route to existing session DO.
    // The session ID is the DO's hex ID (from state.id.toString()), so we
    // must use idFromString() — NOT idFromName() which would hash it again
    // and route to a different, uninitialized DO.
    try {
      const doId = c.env.MCP_SESSION_DO.idFromString(sessionId);
      const stub = c.env.MCP_SESSION_DO.get(doId);
      return stub.fetch(c.req.raw);
    } catch {
      // Invalid session ID format — treat as expired session.
      return c.json(
        { jsonrpc: '2.0', error: { code: -32000, message: 'Invalid or expired session' }, id: null },
        { status: 404 },
      );
    }
  }

  // New session — create a DO with a fresh name.
  const newSessionId = crypto.randomUUID();
  const doId = c.env.MCP_SESSION_DO.idFromName(newSessionId);
  const stub = c.env.MCP_SESSION_DO.get(doId);

  // Forward the API key header if present.
  return stub.fetch(c.req.raw);
});

// Secure headers for remaining routes
app.use('*', secureHeaders());

// Health check
app.route('/health', healthRoutes);

// WebSocket upgrade route — proxies to AgentDO
app.get('/v1/ws', async (c) => {
  const upgradeHeader = c.req.header('Upgrade');
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
    return c.text('Expected WebSocket upgrade', 426);
  }

  const token = c.req.query('token');
  if (!token) {
    return c.json({ ok: false, error: { code: 'unauthorized', message: 'Missing token' } }, 401);
  }

  const { hashToken } = await import('./middleware/auth.js');
  const { getDb } = await import('./db/index.js');
  const { agents, workspaces } = await import('./db/schema.js');
  const { eq } = await import('drizzle-orm');

  const hash = hashToken(token);
  const db = getDb(c.env.DB);
  const url = new URL(c.req.url);
  url.pathname = '/ws';

  if (token.startsWith('at_live_')) {
    const [agent] = await db.select().from(agents).where(eq(agents.tokenHash, hash));

    if (!agent) {
      return c.json({ ok: false, error: { code: 'invalid_token', message: 'Invalid agent token' } }, 401);
    }

    const workspaceId = agent.workspaceId;
    const agentId = agent.id;
    const origin = requiredOriginInfo(c.req.raw);

    // Register the agent as online in PresenceDO (fire-and-forget)
    const presenceDoId = c.env.PRESENCE_DO.idFromName(workspaceId);
    const presenceStub = c.env.PRESENCE_DO.get(presenceDoId);
    presenceStub.fetch(new Request('http://do/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, workspaceId, agentName: agent.name }),
    })).catch(() => {});

    const doId = c.env.AGENT_DO.idFromName(`${workspaceId}:${agentId}`);
    const stub = c.env.AGENT_DO.get(doId);
    url.searchParams.set('workspace_id', workspaceId);
    url.searchParams.set('agent_id', agentId);
    url.searchParams.set('session_scope', 'agent');
    url.searchParams.set('origin_surface', origin.origin_surface);
    url.searchParams.set('origin_client', origin.origin_client);
    url.searchParams.set('origin_version', origin.origin_version);

    const response = await stub.fetch(new Request(url.toString(), c.req.raw));
    if (response.status === 101) {
      emitServerEvent(c, workspaceId, 'relaycast_server_ws_session_started', {
        agent_id: agentId,
        session_scope: 'agent',
      });
    }
    return response;
  }

  if (token.startsWith('rk_live_')) {
    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.apiKeyHash, hash));
    if (!workspace) {
      return c.json({ ok: false, error: { code: 'invalid_token', message: 'Invalid workspace key' } }, 401);
    }
    if (!(await isWorkspaceStreamEnabled(c.env, workspace.id))) {
      return c.json(
        { ok: false, error: { code: 'not_found', message: 'Workspace stream is disabled' } },
        404,
      );
    }

    const doId = c.env.WORKSPACE_STREAM_DO.idFromName(workspace.id);
    const stub = c.env.WORKSPACE_STREAM_DO.get(doId);
    const origin = requiredOriginInfo(c.req.raw);
    url.searchParams.set('workspace_id', workspace.id);
    url.searchParams.set('session_scope', 'workspace');
    url.searchParams.set('origin_surface', origin.origin_surface);
    url.searchParams.set('origin_client', origin.origin_client);
    url.searchParams.set('origin_version', origin.origin_version);

    const response = await stub.fetch(new Request(url.toString(), c.req.raw));
    if (response.status === 101) {
      emitServerEvent(c, workspace.id, 'relaycast_server_ws_session_started', {
        session_scope: 'workspace',
      });
    }
    return response;
  }

  return c.json({ ok: false, error: { code: 'invalid_token', message: 'Invalid token format' } }, 401);
});

// API v1 routes — specific routes before parameterized routes
const v1 = new Hono<AppEnv>();
v1.route('/', presenceRoutes);
v1.route('/', systemPromptRoutes);
v1.route('/', workspaceRoutes);
v1.route('/', agentRoutes);
v1.route('/', channelRoutes);
v1.route('/', messageRoutes);
v1.route('/', threadRoutes);
v1.route('/', dmRoutes);
v1.route('/', groupDmRoutes);
v1.route('/', reactionRoutes);
v1.route('/', searchRoutes);
v1.route('/', inboxRoutes);
v1.route('/', receiptRoutes);
v1.route('/', fileRoutes);
v1.route('/', billingRoutes);
v1.route('/', webhookRoutes);
v1.route('/', inboundWebhookRoutes);
v1.route('/', eventSubscriptionRoutes);
v1.route('/', commandRoutes);

app.route('/v1', v1);

// 404 handler
app.notFound((c) => {
  return c.json({ ok: false, error: { code: 'not_found', message: 'Route not found' } }, 404);
});

// Global error handler
app.onError((err, c) => {
  const error = err as Error & { code?: string; status?: number };
  const logger = getRequestLogger(c, 'worker.on_error');
  logger.error('Unhandled request error', {
    error_code: error.code ?? 'internal_error',
    error_status: error.status ?? 500,
    path: c.req.path,
    method: c.req.method,
    ...toErrorDetails(error),
  });

  if (error.message?.includes('JSON')) {
    return c.json({ ok: false, error: { code: 'invalid_json', message: 'Malformed JSON in request body' } }, 400);
  }
  const status = error.status || 500;
  return c.json({
    ok: false,
    error: {
      code: error.code || 'internal_error',
      message: error.message || 'Internal server error',
    },
  }, status as any);
});

// Queue consumer for webhook delivery
async function handleQueue(batch: MessageBatch, env: AppEnv['Bindings']) {
  const { getDb } = await import('./db/index.js');
  const { deliverEvent } = await import('./engine/eventDelivery.js');
  const db = getDb(env.DB);
  const logger = createLogger(env, { source: 'worker.queue' });

  for (const msg of batch.messages) {
    try {
      const event = msg.body as { type: string; workspaceId: string; data: Record<string, unknown> };
      const result = await deliverEvent(db, event.workspaceId, event.type, event.data);
      if (result.failed > 0) {
        logger.warn('Non-retryable webhook delivery failures', {
          event_type: event.type,
          workspace_id: event.workspaceId,
          failed: result.failed,
          attempted: result.attempted,
        });
      }
      msg.ack();
    } catch (error) {
      logger.error('Webhook queue message processing failed; retrying', {
        ...toErrorDetails(error),
      });
      msg.retry();
    }
  }
  await logger.flush();
}

// Scheduled handler for cleanup tasks
async function handleScheduled(event: ScheduledEvent, env: AppEnv['Bindings']) {
  const { getDb } = await import('./db/index.js');
  const db = getDb(env.DB);
  const logger = createLogger(env, { source: 'worker.scheduled' });

  // Clean up expired idempotency keys
  try {
    const { sql } = await import('drizzle-orm');
    await db.run(sql`DELETE FROM idempotency_keys WHERE expires_at < unixepoch()`);
  } catch (error) {
    logger.warn('Failed to clean expired idempotency keys', {
      ...toErrorDetails(error),
      schedule: event.cron ?? 'unknown',
    });
  }
  await logger.flush();
}

export default {
  fetch: app.fetch,
  queue: handleQueue,
  scheduled: handleScheduled,
};
