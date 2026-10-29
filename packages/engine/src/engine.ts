import { configureNodeLiveness } from './engine/nodeLiveness.js';
import { safeTelemetrySink } from './ports/telemetry.js';
import { NoopTelemetrySink } from './providers/noop-telemetry.js';
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import type { AppEnv, EngineRuntime } from './env.js';
import type { EngineDeps } from './ports/index.js';
import { engineContext } from './middleware/engine-context.js';
import { loggerMiddleware } from './middleware/logger.js';
import { getRequestLogger, toErrorDetails } from './lib/logger.js';
import { asCodedError, safeClientErrorMessage } from './lib/httpError.js';
import { jsonError, jsonMalformedBody, jsonNotFound } from './lib/httpResponse.js';
import { requiredOriginInfo } from './lib/origin.js';
import { emitServerEvent } from './lib/serverTelemetry.js';
import { engineOperationOf, runWithEngineDiagnostics } from './lib/engineDiagnostics.js';
import { runInBackground } from './routes/background.js';
import {
  authenticateNodeWs,
  authenticateRealtimeWs,
  missingWsToken,
  queryOrBearerToken,
} from './engine/wsAuth.js';

// Route imports
import { healthRoutes } from './routes/health.js';
import { workspaceRoutes } from './routes/workspace.js';
import { assertInternalSecretStrength } from './engine/internalAdmin.js';
import { observerTokenRoutes } from './routes/observerToken.js';
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
import { relayfileInboundRoutes } from './routes/relayfileInbound.js';
import { eventSubscriptionRoutes } from './routes/eventSubscription.js';
import { actionRoutes } from './routes/action.js';
import { nodeRoutes } from './routes/node.js';
import { triggerRoutes } from './routes/trigger.js';
import { a2aRoutes } from './routes/a2a.js';
import { certifyRoutes } from './routes/certify.js';
import { consoleRoutes } from './routes/console.js';
import { directoryRoutes } from './routes/directory.js';
import { routingRoutes } from './routes/routing.js';
import { internalRoutes } from './routes/internal.js';

/**
 * Build the platform-agnostic Relaycast engine as a Hono app.
 *
 * All infrastructure (database, realtime, presence, rate limiting, files,
 * key/value, outbound queue) and the open-core providers
 * (auth, admission, telemetry) are injected via {@link EngineDeps}. An
 * adapter supplies concrete implementations:
 *  - the Node in-process adapter for self-host (Node + SQLite), or
 *  - the Cloudflare Durable Object adapter for the hosted product (cloud repo).
 *
 * The returned app has no `export default { fetch, queue, scheduled }` and binds
 * no Durable Objects — those concerns belong to the adapter/entrypoint.
 */
export function createEngine(deps: EngineDeps): Hono<AppEnv> {
  assertInternalSecretStrength(deps.config?.internalSecret);
  if (deps.nodeLiveness) configureNodeLiveness(deps.db, deps.nodeLiveness);
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
    admission: deps.admission,
    telemetry: safeTelemetrySink(deps.telemetry ?? new NoopTelemetrySink()),
    config: deps.config ?? {},
  };

  const app = new Hono<AppEnv>();

  // Inject the runtime first so the logger and all routes can read it.
  // Each app's requests (and the background work they start) report to this
  // app's own diagnostics sink, or to none: never another app's.
  app.use('*', (_c, next) => runWithEngineDiagnostics(deps.diagnostics, next));
  app.use('*', engineContext(runtime));
  // Before CORS so a preflight, which returns without calling later
  // middleware, still carries the request id. exposeHeaders lets browser
  // clients read it.
  app.use('*', loggerMiddleware);
  app.use('*', cors({ exposeHeaders: ['X-Request-Id'] }));

  app.use('*', secureHeaders());

  // A2A public and gateway routes before other route groups
  app.route('/', a2aRoutes);

  // Health check
  app.route('/health', healthRoutes);

  // Internal admin API for a trusted control plane; 404 unless
  // config.internalSecret is set.
  app.route('/internal', internalRoutes);

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

    const { auth, connections } = c.get('engine');
    const db = c.get('db');
    const originInfo = requiredOriginInfo(c.req.raw);
    const origin = {
      client: originInfo.origin_client,
      version: originInfo.origin_version,
    };
    const originActor = c.get('originActor') ?? 'unknown';
    const authResult = await authenticateRealtimeWs({ auth, db }, token);

    if (!authResult.ok) {
      return jsonError(c, authResult.code, authResult.message, authResult.status);
    }

    const response = await connections.upgrade({
      request: c.req.raw,
      workspaceId: authResult.workspace.id,
      origin,
      originActor,
      observerToken: authResult.observerToken,
    });
    if (response.status === 101) {
      emitServerEvent(c, authResult.workspace.id, 'ws.session.started', {
        session_scope: 'workspace',
      }, {});
    }
    return response;
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
    const token = queryOrBearerToken(c.req.query('token'), c.req.header('Authorization'));
    if (!token) {
      const error = missingWsToken();
      return jsonError(c, error.code, error.message, error.status);
    }

    const { auth, nodeConnections } = c.get('engine');
    const db = c.get('db');
    const authResult = await authenticateNodeWs({ auth, db }, token);
    if (!authResult.ok) {
      return jsonError(c, authResult.code, authResult.message, authResult.status);
    }

    const originInfo = requiredOriginInfo(c.req.raw);
    const origin = {
      client: originInfo.origin_client,
      version: originInfo.origin_version,
    };
    const originActor = c.get('originActor') ?? 'unknown';
    const response = await nodeConnections.upgradeNode({
      request: c.req.raw,
      workspaceId: authResult.node.workspaceId,
      nodeId: authResult.node.id,
      nodeName: authResult.node.name,
      origin,
      originActor,
    });
    if (response.status === 101) {
      const workspaceId = authResult.node.workspaceId;
      runInBackground(
        c,
        (async () => {
          emitServerEvent(c, workspaceId, 'ws.session.started', {
            node_id: authResult.node.id,
            session_scope: 'node',
          }, {});
        })(),
        'emit node session telemetry',
      );
    }
    return response;
  });

  // API v1 routes — specific routes before parameterized routes
  const v1 = new Hono<AppEnv>();
  v1.route('/', presenceRoutes);
  v1.route('/', systemPromptRoutes);
  v1.route('/', workspaceRoutes);
  v1.route('/', observerTokenRoutes);
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
  v1.route('/', relayfileInboundRoutes);
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
    // Where the failure happened, so a 5xx can be traced to a tenant, a caller
    // and the engine operation in flight. Ids and route templates only: never a
    // raw path, which can carry names.
    const scope = errorScope(c, err);
    const logger = getRequestLogger(c, 'engine.on_error');
    logger.error('Unhandled request error', {
      error_code: error.code ?? 'internal_error',
      error_status: error.status ?? 500,
      path: c.req.path,
      method: c.req.method,
      ...scope,
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
        ...scope,
      });
    }

    if (error.code === 'invalid_json' || err instanceof SyntaxError) {
      return jsonMalformedBody(c);
    }
    const requestId = c.get('requestId');
    return c.json(
      {
        ok: false as const,
        error: {
          code: error.code || 'internal_error',
          message: safeClientErrorMessage(error),
          // Lets a caller quote a server error that the logs above can be found by.
          ...(status >= 500 && requestId ? { request_id: requestId } : {}),
        },
      },
      status as ContentfulStatusCode,
    );
  });

  return app;
}

function errorScope(c: Context<AppEnv>, err: unknown): Record<string, string> {
  const scope: Record<string, string> = {};
  const workspaceId = c.get('workspace')?.id;
  const agentId = c.get('agent')?.id;
  const operation = engineOperationOf(err);
  // Hono reports the matched template (`/v1/channels/:name/messages`); `*` is
  // a middleware match, not a route, so it is no better than nothing.
  const route = c.req.routePath;
  if (workspaceId) scope.workspace_id = workspaceId;
  if (agentId) scope.agent_id = agentId;
  if (operation) scope.engine_operation = operation;
  if (route && !route.includes('*')) scope.route = route;
  return scope;
}
