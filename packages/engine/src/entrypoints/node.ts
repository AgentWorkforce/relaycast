import type { Server } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { createEngine } from '../engine.js';
import { isWorkspaceStreamEnabled } from '../lib/workspaceStream.js';
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
import { getNodeByTokenHash } from '../engine/node.js';

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

  const server = serve({ fetch: app.fetch, port: options.port });

  // WebSocket upgrades (Node owns these at the socket level).
  const wss = new WebSocketServer({ noServer: true });
  const { auth, db, kv, config } = runtime.deps;

  (server as unknown as Server).on(
    'upgrade',
    (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? '/', baseUrl);
      if (url.pathname !== '/v1/ws' && url.pathname !== '/v1/node/ws') {
        rejectUpgrade(socket, 426, 'Upgrade Required');
        return;
      }
      const token = url.searchParams.get('token');
      if (!token) {
        rejectUpgrade(socket, 401, 'Unauthorized');
        return;
      }

      void (async () => {
        if (url.pathname === '/v1/node/ws') {
          if (!token.startsWith('nt_live_')) {
            rejectUpgrade(socket, 401, 'Unauthorized');
            return;
          }
          const hash = await auth.hashToken(token);
          const node = await getNodeByTokenHash(db, hash);
          if (!node) {
            rejectUpgrade(socket, 401, 'Unauthorized');
            return;
          }
          wss.handleUpgrade(req, socket, head, (ws) => {
            const handle = runtime.realtime.attachNodeSocket(node.workspaceId, node.id, toEngineSocket(ws));
            ws.on('message', (data) => { void handle.handleMessage(data.toString()); });
            ws.on('close', () => { void handle.handleClose(); });
          });
          return;
        }

        if (token.startsWith('at_live_')) {
          const res = await auth.authenticate({ token, require: 'agent', db });
          if (!res.ok || !res.agent) {
            rejectUpgrade(socket, 401, 'Unauthorized');
            return;
          }
          const { workspace, agent } = res;
          wss.handleUpgrade(req, socket, head, (ws) => {
            const handle = runtime.realtime.attachAgentSocket(workspace.id, agent.id, toEngineSocket(ws));
            runtime.deps.presence.heartbeat(workspace.id, agent.id, agent.name).catch(() => {});
            ws.on('message', (data) => { void handle.handleMessage(data.toString()); });
            ws.on('close', () => { void handle.handleClose(); });
          });
          return;
        }

        if (token.startsWith('rk_live_')) {
          const res = await auth.authenticate({ token, require: 'workspace', db });
          if (!res.ok) {
            rejectUpgrade(socket, 401, 'Unauthorized');
            return;
          }
          const enabled = await isWorkspaceStreamEnabled(kv, res.workspace.id, config?.workspaceStreamEnabled ?? false);
          if (!enabled) {
            rejectUpgrade(socket, 404, 'Not Found');
            return;
          }
          const { workspace } = res;
          wss.handleUpgrade(req, socket, head, (ws) => {
            const handle = runtime.realtime.attachWorkspaceSocket(workspace.id, toEngineSocket(ws));
            ws.on('message', (data) => { void handle.handleMessage(data.toString()); });
            ws.on('close', () => { void handle.handleClose(); });
          });
          return;
        }

        rejectUpgrade(socket, 401, 'Unauthorized');
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
