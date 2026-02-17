import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import type { AppEnv } from './env.js';
import { dbMiddleware } from './middleware/db.js';
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
import { dashboardRoutes } from './routes/dashboard.js';

// Durable Object exports
export { ChannelDO } from './durable-objects/channel.js';
export { AgentDO } from './durable-objects/agent.js';
export { PresenceDO } from './durable-objects/presence.js';
export { McpSessionDO } from './durable-objects/mcpSession.js';

const app = new Hono<AppEnv>();

// Global middleware
app.use('*', cors());
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
    const doId = c.env.MCP_SESSION_DO.idFromName(sessionId);
    const stub = c.env.MCP_SESSION_DO.get(doId);
    return stub.fetch(c.req.raw);
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

  // Validate agent token (at_live_...) and extract workspaceId + agentId
  if (!token.startsWith('at_live_')) {
    return c.json({ ok: false, error: { code: 'invalid_token', message: 'Agent token required (at_live_...)' } }, 401);
  }

  const { hashToken } = await import('./middleware/auth.js');
  const { getDb } = await import('./db/index.js');
  const { agents } = await import('./db/schema.js');
  const { eq } = await import('drizzle-orm');

  const hash = hashToken(token);
  const db = getDb(c.env.HYPERDRIVE.connectionString);
  const [agent] = await db.select().from(agents).where(eq(agents.tokenHash, hash));

  if (!agent) {
    return c.json({ ok: false, error: { code: 'invalid_token', message: 'Invalid agent token' } }, 401);
  }

  const workspaceId = agent.workspaceId;
  const agentId = agent.id;

  const doId = c.env.AGENT_DO.idFromName(`${workspaceId}:${agentId}`);
  const stub = c.env.AGENT_DO.get(doId);
  // Rewrite path from /v1/ws to /ws for the AgentDO handler
  const url = new URL(c.req.url);
  url.pathname = '/ws';
  return stub.fetch(new Request(url.toString(), c.req.raw));
});

// API v1 routes — specific routes before parameterized routes
const v1 = new Hono<AppEnv>();
v1.route('/', dashboardRoutes);
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
  const db = getDb(env.HYPERDRIVE.connectionString);

  for (const msg of batch.messages) {
    try {
      const event = msg.body as { type: string; workspaceId: string; data: Record<string, unknown> };
      await deliverEvent(db, event.workspaceId, event.type, event.data);
      msg.ack();
    } catch {
      msg.retry();
    }
  }
}

// Scheduled handler for cleanup tasks
async function handleScheduled(event: ScheduledEvent, env: AppEnv['Bindings']) {
  const { getDb } = await import('./db/index.js');
  const db = getDb(env.HYPERDRIVE.connectionString);

  // Clean up expired idempotency keys
  try {
    const { sql } = await import('drizzle-orm');
    await db.execute(sql`DELETE FROM idempotency_keys WHERE expires_at < NOW()`);
  } catch {
    // Table may not exist yet
  }
}

export default {
  fetch: app.fetch,
  queue: handleQueue,
  scheduled: handleScheduled,
};
