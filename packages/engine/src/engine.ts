import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { eq } from 'drizzle-orm';
import { MCP_VERSION } from '@relaycast/mcp';
import type { AppEnv, EngineRuntime } from './env.js';
import type { EngineDeps } from './ports/index.js';
import { engineContext } from './middleware/engine-context.js';
import { loggerMiddleware } from './middleware/logger.js';
import { agents, workspaces } from './db/schema.js';
import { isWorkspaceStreamEnabled } from './lib/workspaceStream.js';
import { getRequestLogger, toErrorDetails } from './lib/logger.js';
import { requiredOriginInfo } from './lib/origin.js';
import { emitServerEvent } from './lib/serverTelemetry.js';

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
import { presenceRoutes } from './routes/presence.js';
import { systemPromptRoutes } from './routes/systemPrompt.js';
import { inboundWebhookRoutes } from './routes/inboundWebhook.js';
import { eventSubscriptionRoutes } from './routes/eventSubscription.js';
import { actionRoutes } from './routes/action.js';
import { a2aRoutes } from './routes/a2a.js';
import { certifyRoutes } from './routes/certify.js';
import { consoleRoutes } from './routes/console.js';
import { directoryRoutes } from './routes/directory.js';
import { routingRoutes } from './routes/routing.js';

/**
 * Build the platform-agnostic Relaycast engine as a Hono app.
 *
 * All infrastructure (database, realtime, presence, rate limiting, MCP
 * sessions, files, key/value, outbound queue) and the open-core providers
 * (auth, entitlements, telemetry) are injected via {@link EngineDeps}. An
 * adapter supplies concrete implementations:
 *  - the Node in-process adapter for self-host (Node + SQLite), or
 *  - the Cloudflare Durable Object adapter for the hosted product (cloud repo).
 *
 * The returned app has no `export default { fetch, queue, scheduled }` and binds
 * no Durable Objects — those concerns belong to the adapter/entrypoint.
 */
export function createEngine(deps: EngineDeps): Hono<AppEnv> {
  const runtime: EngineRuntime = {
    db: deps.db,
    realtime: deps.realtime,
    connections: deps.connections,
    presence: deps.presence,
    rateLimiter: deps.rateLimiter,
    mcp: deps.mcp,
    files: deps.files,
    kv: deps.kv,
    webhookQueue: deps.webhookQueue,
    auth: deps.auth,
    entitlements: deps.entitlements,
    telemetry: deps.telemetry,
    config: deps.config ?? {},
  };

  const app = new Hono<AppEnv>();

  // Inject the runtime first so the logger and all routes can read it.
  app.use('*', engineContext(runtime));
  app.use('*', cors());
  app.use('*', loggerMiddleware);

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
          default: 'https://gateway.relaycast.dev',
        },
      },
    });
  });

  // MCP Streamable HTTP endpoint — stateful sessions via the McpSessionHost port
  app.all('/mcp', async (c) => {
    const sessionId = c.req.header('mcp-session-id');
    return c.get('engine').mcp.handle(c.req.raw, sessionId ?? undefined);
  });

  // Secure headers for remaining routes
  app.use('*', secureHeaders());

  // A2A public and gateway routes before other route groups
  app.route('/', a2aRoutes);

  // Health check
  app.route('/health', healthRoutes);

  // WebSocket upgrade route — delegates to the ConnectionRegistry port
  app.get('/v1/ws', async (c) => {
    const upgradeHeader = c.req.header('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return c.text('Expected WebSocket upgrade', 426);
    }

    const token = c.req.query('token');
    if (!token) {
      return c.json({ ok: false, error: { code: 'unauthorized', message: 'Missing token' } }, 401);
    }

    const { auth, connections, kv, config } = c.get('engine');
    const db = c.get('db');
    const hash = auth.hashToken(token);
    const originInfo = requiredOriginInfo(c.req.raw);
    const origin = {
      surface: originInfo.origin_surface,
      client: originInfo.origin_client,
      version: originInfo.origin_version,
    };
    const harness = c.get('harness') ?? 'unknown';

    if (token.startsWith('at_live_')) {
      const [agent] = await db.select().from(agents).where(eq(agents.tokenHash, hash));
      if (!agent) {
        return c.json({ ok: false, error: { code: 'invalid_token', message: 'Invalid agent token' } }, 401);
      }
      const workspaceId = agent.workspaceId;

      // Register the agent online (fire-and-forget)
      c.get('engine').presence.heartbeat(workspaceId, agent.id, agent.name).catch(() => {});

      const response = await connections.upgrade({
        request: c.req.raw,
        scope: 'agent',
        workspaceId,
        agentId: agent.id,
        agentName: agent.name,
        origin,
        harness,
      });
      if (response.status === 101) {
        emitServerEvent(c, workspaceId, 'relaycast_server_ws_session_started', {
          agent_id: agent.id,
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
      if (!(await isWorkspaceStreamEnabled(kv, workspace.id, config.workspaceStreamEnabled ?? false))) {
        return c.json(
          { ok: false, error: { code: 'not_found', message: 'Workspace stream is disabled' } },
          404,
        );
      }

      const response = await connections.upgrade({
        request: c.req.raw,
        scope: 'workspace',
        workspaceId: workspace.id,
        origin,
        harness,
      });
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
  v1.route('/', inboundWebhookRoutes);
  v1.route('/', eventSubscriptionRoutes);
  v1.route('/', actionRoutes);
  v1.route('/', certifyRoutes);
  v1.route('/', consoleRoutes);
  v1.route('/', directoryRoutes);
  v1.route('/', routingRoutes);

  app.route('/v1', v1);

  // 404 handler
  app.notFound((c) => {
    return c.json({ ok: false, error: { code: 'not_found', message: 'Route not found' } }, 404);
  });

  // Global error handler
  app.onError((err, c) => {
    const error = err as Error & { code?: string; status?: number };
    const logger = getRequestLogger(c, 'engine.on_error');
    logger.error('Unhandled request error', {
      error_code: error.code ?? 'internal_error',
      error_status: error.status ?? 500,
      path: c.req.path,
      method: c.req.method,
      ...toErrorDetails(error),
    });

    const status = error.status || 500;
    if (status >= 500) {
      c.get('engine').telemetry.captureException(error, {
        path: c.req.path,
        method: c.req.method,
        status_code: status,
        error_code: error.code ?? 'internal_error',
        request_id: c.get('requestId'),
      });
    }

    if (error.message?.includes('JSON')) {
      return c.json({ ok: false, error: { code: 'invalid_json', message: 'Malformed JSON in request body' } }, 400);
    }
    return c.json({
      ok: false,
      error: {
        code: error.code || 'internal_error',
        message: error.message || 'Internal server error',
      },
    }, status as ContentfulStatusCode);
  });

  return app;
}
