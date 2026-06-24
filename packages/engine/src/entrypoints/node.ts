import type { Server } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { createEngine } from '../engine.js';
import { jsonNotFound } from '../lib/httpResponse.js';
import type { AppEnv } from '../env.js';
import type { EngineConfig } from '../ports/index.js';
import type { AuthProvider } from '../ports/auth.js';
import type { EntitlementsProvider } from '../ports/entitlements.js';
import type { TelemetrySink } from '../ports/telemetry.js';
import {
  createNodeRuntime,
  FILE_ROUTE_PREFIX,
  type EngineSocket,
  type InProcessPresenceOptions,
  type NodeRuntime,
} from '../adapters/node/index.js';
import {
  authenticateNodeWs,
  authenticateRealtimeWs,
  missingWsToken,
  queryOrBearerToken,
} from '../engine/wsAuth.js';

export interface StartServerOptions {
  dbPath: string;
  port: number;
  /** Public origin. Default: `http://localhost:<port>`. */
  baseUrl?: string;
  fileDir?: string;
  fileSecret?: string;
  migrate?: boolean;
  auth?: AuthProvider;
  entitlements?: EntitlementsProvider;
  telemetry?: TelemetrySink;
  config?: EngineConfig;
  presence?: InProcessPresenceOptions;
}

export interface RunningServer {
  server: ServerType;
  runtime: NodeRuntime;
  stop(): Promise<void>;
}

function toEngineSocket(ws: WsSocket): EngineSocket {
  return {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
  };
}

function rejectUpgrade(socket: { write: (s: string) => void; destroy: () => void }, status: number, message: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  } catch {
    // socket already gone
  }
}

/**
 * Start the self-host Relaycast server: Node + SQLite, single process.
 *
 * Mounts the engine plus the local file upload/download route, and handles
 * WebSocket upgrades at the HTTP-server level (Node can't return a 101 from a
 * fetch handler), authenticating with the configured auth provider and wiring
 * each socket to the in-process realtime adapter.
 */
export function startServer(options: StartServerOptions): RunningServer {
  const baseUrl = options.baseUrl ?? `http://localhost:${options.port}`;
  const runtime = createNodeRuntime({
    dbPath: options.dbPath,
    baseUrl,
    fileDir: options.fileDir,
    fileSecret: options.fileSecret,
    migrate: options.migrate,
    auth: options.auth,
    entitlements: options.entitlements,
    telemetry: options.telemetry,
    config: options.config,
    presence: options.presence,
  });

  const engine = createEngine(runtime.deps);

  // Parent app: serve local files, then delegate everything else to the engine.
  const app = new Hono<AppEnv>();
  app.all(FILE_ROUTE_PREFIX, (c) => runtime.fileHandler(c.req.raw));
  app.route('/', engine);
  app.notFound((c) => jsonNotFound(c, 'not_found', 'Route not found'));

  const server = serve({ fetch: app.fetch, port: options.port });

  // WebSocket upgrades (Node owns these at the socket level).
  const wss = new WebSocketServer({ noServer: true });
  const { auth, db, kv, config } = runtime.deps;
  const wsAuthDeps = { auth, db, kv, config };

  (server as unknown as Server).on(
    'upgrade',
    (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? '/', baseUrl);
      if (url.pathname !== '/v1/ws' && url.pathname !== '/v1/node/ws') {
        rejectUpgrade(socket, 426, 'Upgrade Required');
        return;
      }
      // Accept the token from the `?token=` query param (SDK/Pear convention)
      // OR an `Authorization: Bearer <token>` header. The relay Rust broker's
      // node_control client authenticates the node control connection with the
      // header form, so the self-host upgrade path must honour both.
      const authHeader = req.headers['authorization'];
      const token = queryOrBearerToken(url.searchParams.get('token'), typeof authHeader === 'string' ? authHeader : undefined);
      if (!token) {
        const error = missingWsToken();
        rejectUpgrade(socket, error.status, error.upgradeMessage);
        return;
      }

      void (async () => {
        if (url.pathname === '/v1/node/ws') {
          const authResult = await authenticateNodeWs(wsAuthDeps, token);
          if (!authResult.ok) {
            rejectUpgrade(socket, authResult.status, authResult.upgradeMessage);
            return;
          }
          wss.handleUpgrade(req, socket, head, (ws) => {
            const handle = runtime.realtime.attachNodeSocket(
              authResult.node.workspaceId,
              authResult.node.id,
              toEngineSocket(ws),
            );
            ws.on('message', (data) => { void handle.handleMessage(data.toString()); });
            ws.on('close', () => { void handle.handleClose(); });
          });
          return;
        }

        const authResult = await authenticateRealtimeWs(wsAuthDeps, token);
        if (!authResult.ok) {
          rejectUpgrade(socket, authResult.status, authResult.upgradeMessage);
          return;
        }

        if (authResult.scope === 'agent') {
          wss.handleUpgrade(req, socket, head, (ws) => {
            const handle = runtime.realtime.attachAgentSocket(
              authResult.workspace.id,
              authResult.agent.id,
              toEngineSocket(ws),
            );
            runtime.deps.presence.heartbeat(
              authResult.workspace.id,
              authResult.agent.id,
              authResult.agent.name,
            ).catch(() => {});
            ws.on('message', (data) => { void handle.handleMessage(data.toString()); });
            ws.on('close', () => { void handle.handleClose(); });
          });
          return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
          const handle = runtime.realtime.attachWorkspaceSocket(authResult.workspace.id, toEngineSocket(ws));
          ws.on('message', (data) => { void handle.handleMessage(data.toString()); });
          ws.on('close', () => { void handle.handleClose(); });
        });
      })().catch(() => rejectUpgrade(socket, 500, 'Internal Server Error'));
    },
  );

  return {
    server,
    runtime,
    async stop() {
      runtime.close();
      wss.close();
      await new Promise<void>((resolve) => {
        (server as unknown as { close: (cb: () => void) => void }).close(() => resolve());
      });
    },
  };
}
