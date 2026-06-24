import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { eq } from 'drizzle-orm';
import type { AppEnv, EngineRuntime } from './env.js';
import type { EngineDeps } from './ports/index.js';
import { engineContext } from './middleware/engine-context.js';
import { loggerMiddleware } from './middleware/logger.js';
import { agents, nodes, workspaces } from './db/schema.js';
import { isWorkspaceStreamEnabled } from './lib/workspaceStream.js';
import { isFleetNodesEnabled } from './lib/fleetNodes.js';
import { getRequestLogger, toErrorDetails } from './lib/logger.js';
import { asCodedError } from './lib/httpError.js';
import { jsonError, jsonMalformedBody, jsonNotFound } from './lib/httpResponse.js';
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
import { deliveryRoutes } from './routes/delivery.js';
import { fileRoutes } from './routes/file.js';
import { presenceRoutes } from './routes/presence.js';
import { systemPromptRoutes } from './routes/systemPrompt.js';
import { inboundWebhookRoutes } from './routes/inboundWebhook.js';
import { eventSubscriptionRoutes } from './routes/eventSubscription.js';
import { actionRoutes } from './routes/action.js';
import { nodeRoutes } from './routes/node.js';
import { triggerRoutes } from './routes/trigger.js';
import { a2aRoutes } from './routes/a2a.js';
import { certifyRoutes } from './routes/certify.js';
import { consoleRoutes } from './routes/console.js';
import { directoryRoutes } from './routes/directory.js';
import { routingRoutes } from './routes/routing.js';

/**
 * Build the platform-agnostic Relaycast engine as a Hono app.
 *
 * All infrastructure (database, realtime, presence, rate limiting, files,
 * key/value, outbound queue) and the open-core providers
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
    nodeConnections: deps.nodeConnections,
    presence: deps.presence,
    rateLimiter: deps.rateLimiter,
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
      return jsonError(c, 'unauthorized', 'Missing token', 401);
    }

    const { auth, connections, kv, config } = c.get('engine');
    const db = c.get('db');
    const hash = await auth.hashToken(token);
    const originInfo = requiredOriginInfo(c.req.raw);
    const origin = {
      client: originInfo.origin_client,
      version: originInfo.origin_version,
    };
    const originActor = c.get('originActor') ?? 'unknown';

    if (token.startsWith('at_live_')) {
      const [agent] = await db.select().from(agents).where(eq(agents.tokenHash, hash));
      if (!agent) {
        return jsonError(c, 'invalid_token', 'Invalid agent token', 401);
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
        originActor,
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
        return jsonError(c, 'invalid_token', 'Invalid workspace key', 401);
      }
      if (!(await isWorkspaceStreamEnabled(kv, workspace.id, config.workspaceStreamEnabled ?? false))) {
        return jsonNotFound(c, 'not_found', 'Workspace stream is disabled');
      }

      const response = await connections.upgrade({
        request: c.req.raw,
        scope: 'workspace',
        workspaceId: workspace.id,
        origin,
        originActor,
      });
      if (response.status === 101) {
        emitServerEvent(c, workspace.id, 'relaycast_server_ws_session_started', {
          session_scope: 'workspace',
        });
      }
      return response;
    }

    return jsonError(c, 'invalid_token', 'Invalid token format', 401);
  });

  app.get('/v1/node/ws', async (c) => {
    const upgradeHeader = c.req.header('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return c.text('Expected WebSocket upgrade', 426);
    }

    // Accept the node token from the `?token=` query param (SDK/Pear convention)
    // OR an `Authorization: Bearer <token>` header (the relay Rust broker's
    // node_control client sends it this way). Supporting both keeps the engine
    // compatible with every node client without changing the shipped broker.
    const authHeader = c.req.header('Authorization') ?? c.req.header('authorization');
    const bearer = authHeader && /^bearer\s+/i.test(authHeader)
      ? authHeader.replace(/^bearer\s+/i, '').trim()
      : undefined;
    const token = c.req.query('token') ?? bearer;
    if (!token) {
      return jsonError(c, 'unauthorized', 'Missing token', 401);
    }
    if (!token.startsWith('nt_live_')) {
      return jsonError(c, 'invalid_token', 'Invalid node token format', 401);
    }

    const { auth, nodeConnections, kv, config } = c.get('engine');
    const db = c.get('db');
    const hash = await auth.hashToken(token);
    const [node] = await db.select().from(nodes).where(eq(nodes.tokenHash, hash));
    if (!node) {
      return jsonError(c, 'invalid_token', 'Invalid node token', 401);
    }

    // Phase 6 rollout flag: the node control surface is inert until a workspace
    // opts in. A node with a valid token still cannot attach while the flag is off.
    if (!(await isFleetNodesEnabled(kv, node.workspaceId, config.fleetNodesEnabled ?? false))) {
      return jsonNotFound(c, 'fleet_nodes_disabled', 'Fleet nodes are disabled for this workspace');
    }

    const originInfo = requiredOriginInfo(c.req.raw);
    const origin = {
      client: originInfo.origin_client,
      version: originInfo.origin_version,
    };
    const originActor = c.get('originActor') ?? 'unknown';
    const response = await nodeConnections.upgradeNode({
      request: c.req.raw,
      workspaceId: node.workspaceId,
      nodeId: node.id,
      nodeName: node.name,
      origin,
      originActor,
    });
    if (response.status === 101) {
      emitServerEvent(c, node.workspaceId, 'relaycast_server_ws_session_started', {
        node_id: node.id,
        session_scope: 'node',
      });
    }
    return response;
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
  v1.route('/', deliveryRoutes);
  v1.route('/', fileRoutes);
  v1.route('/', inboundWebhookRoutes);
  v1.route('/', eventSubscriptionRoutes);
  v1.route('/', actionRoutes);
  v1.route('/', nodeRoutes);
  v1.route('/', triggerRoutes);
  v1.route('/', certifyRoutes);
  v1.route('/', consoleRoutes);
  v1.route('/', directoryRoutes);
  v1.route('/', routingRoutes);

  app.route('/v1', v1);

  // 404 handler
  app.notFound((c) => {
    return jsonNotFound(c, 'not_found', 'Route not found');
  });

  // Global error handler
  app.onError((err, c) => {
    const error = asCodedError(err);
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
      return jsonMalformedBody(c);
    }
    return jsonError(
      c,
      error.code || 'internal_error',
      error.message || 'Internal server error',
      status as ContentfulStatusCode,
    );
  });

  return app;
}
