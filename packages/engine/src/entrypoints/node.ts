import type { Server } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { createEngine } from '../engine.js';
import { assertInternalSecretStrength } from '../engine/internalAdmin.js';
import { jsonNotFound } from '../lib/httpResponse.js';
import type { AppEnv } from '../env.js';
import type { EngineConfig } from '../ports/index.js';
import type { AuthProvider } from '../ports/auth.js';
import type { AdmissionHooks } from '../ports/admission.js';
import type { TelemetrySink } from '../ports/telemetry.js';
import {
  createNodeRuntime,
  FILE_ROUTE_PREFIX,
  type DurableEventQueueOptions,
  type EngineSocket,
  type InProcessPresenceOptions,
  type NodeRuntime,
  type NodeRuntimeWithDb,
  createNodeRuntimeWithDb,
} from '../adapters/node/index.js';
import {
  authenticateNodeWs,
  authenticateRealtimeWs,
  missingWsToken,
  queryOrBearerToken,
} from '../engine/wsAuth.js';

export { credentialConfigFromEnv, type CredentialEnvConfig } from '../config/credentialEnv.js';
export { ConfigError } from '../bin/secretEnv.js';

export interface StartServerOptions {
  dbPath: string;
  port: number;
  /** Public origin. Default: `http://localhost:<port>`. */
  baseUrl?: string;
  fileDir?: string;
  fileSecret?: string;
  migrate?: boolean;
  auth?: AuthProvider;
  admission?: AdmissionHooks;
  telemetry?: TelemetrySink;
  config?: EngineConfig;
  presence?: InProcessPresenceOptions;
  /** Durable webhook outbox + retention pruning tuning. */
  eventQueue?: DurableEventQueueOptions;
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
  // Refuse a weak admin secret before opening SQLite or starting the queue
  // and sweeper, so a rejected config leaves nothing running.
  assertInternalSecretStrength(options.config?.internalSecret);
  const runtime = createNodeRuntime({
    dbPath: options.dbPath,
    baseUrl,
    fileDir: options.fileDir,
    fileSecret: options.fileSecret,
    migrate: options.migrate,
    auth: options.auth,
    admission: options.admission,
    telemetry: options.telemetry,
    config: options.config,
    presence: options.presence,
    eventQueue: options.eventQueue,
  });

  return serveRuntime(runtime, options.port, baseUrl);
}

/** The parts of {@link StartServerOptions} a PostgreSQL server takes; there is no database path. */
export type StartPostgresServerOptions = Omit<StartServerOptions, 'dbPath' | 'migrate'> & {
  /** Environment holding `RELAYCAST_DATABASE_*`. Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** One line per configuration summary or idle-client error; never carries credentials. */
  log?: (message: string) => void;
};

/** {@link RunningServer} over a PostgreSQL runtime, which has no SQLite handle. */
export interface RunningPostgresServer {
  server: ServerType;
  runtime: NodeRuntimeWithDb;
  stop(): Promise<void>;
}

/**
 * Start the self-host server on PostgreSQL. The runtime role and migration
 * ledger are verified on {@link openPostgresEngineDb} before the runtime exists
 * or the port is listened on, so a wrong identity or unmigrated database never
 * serves. Never touches SQLite, and takes no migration lock and runs no DDL.
 * The caller maps a {@link ConfigError} to exit 64 and a `PostgresIdentityError`
 * to exit 65; anything else is a failure.
 *
 * Loaded lazily so a SQLite server never imports pg.
 */
export async function startPostgresServer(options: StartPostgresServerOptions): Promise<RunningPostgresServer> {
  const baseUrl = options.baseUrl ?? `http://localhost:${options.port}`;
  assertInternalSecretStrength(options.config?.internalSecret);
  const { describePostgresConfig, loadPostgresConfig, openPostgresEngineDb } = await import('../adapters/postgres/index.js');
  const log = options.log ?? (() => {});
  const config = loadPostgresConfig(options.env ?? process.env, 'runtime');
  const safe = describePostgresConfig(config);
  log(`postgres runtime: host=${safe.host} port=${safe.port} database=${safe.database} schema=${safe.schema} expected_role=${safe.expectedRole} ca_sha256=${safe.caSha256}`);
  const handle = await openPostgresEngineDb(config, { log });
  let runtime: NodeRuntimeWithDb;
  try {
    runtime = createNodeRuntimeWithDb(handle.db, {
      baseUrl,
      fileDir: options.fileDir,
      fileSecret: options.fileSecret,
      auth: options.auth,
      admission: options.admission,
      telemetry: options.telemetry,
      config: options.config,
      presence: options.presence,
      eventQueue: options.eventQueue,
    }, () => { void handle.close().catch(() => {}); });
  } catch (err) {
    await handle.close().catch(() => {});
    throw err;
  }
  return serveRuntime(runtime, options.port, baseUrl);
}

/** Run `relaycast-engine migrate` or `verify-db` and return its exit code (for the container entrypoint). */
export async function runPostgresCommand(command: 'migrate' | 'verify-db'): Promise<number> {
  const cli = await import('../adapters/postgres/cli.js');
  return command === 'migrate' ? cli.runMigrateCommand() : cli.runVerifyDbCommand();
}

function serveRuntime<R extends NodeRuntimeWithDb>(
  runtime: R,
  port: number,
  baseUrl: string,
): { server: ServerType; runtime: R; stop(): Promise<void> } {
  let engine: ReturnType<typeof createEngine>;
  try {
    engine = createEngine(runtime.deps);
  } catch (err) {
    // Fail closed: never leave the DB handle and background workers behind.
    runtime.close();
    throw err;
  }

  // Parent app: serve local files, then delegate everything else to the engine.
  const app = new Hono<AppEnv>();
  app.all(FILE_ROUTE_PREFIX, (c) => runtime.fileHandler(c.req.raw));
  app.route('/', engine);
  app.notFound((c) => jsonNotFound(c, 'not_found', 'Route not found'));

  const server = serve({ fetch: app.fetch, port });

  // WebSocket upgrades (Node owns these at the socket level).
  const wss = new WebSocketServer({ noServer: true });
  const { auth, db } = runtime.deps;
  const wsAuthDeps = { auth, db };

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

        wss.handleUpgrade(req, socket, head, (ws) => {
          const handle = runtime.realtime.attachWorkspaceSocket(
            authResult.workspace.id,
            toEngineSocket(ws),
            authResult.observerToken,
          );
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
