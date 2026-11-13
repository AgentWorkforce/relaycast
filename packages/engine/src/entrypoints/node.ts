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
  type NodeTelemetryCollectorOptions,
  type NodeRuntimeOptions,
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
import { ConfigError } from '../bin/secretEnv.js';
import type { FileRow } from '../adapters/node/fileMigration.js';
export { ConfigError };
export { createCollectorTelemetrySink } from '../providers/collector-telemetry.js';
export type { NodeTelemetryCollectorOptions } from '../adapters/node/index.js';

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
  /** Opt-in self-host analytics collector; ignored when `telemetry` is set. */
  telemetryCollector?: NodeTelemetryCollectorOptions;
  /** Explicit analytics destination (`none` | `collector`); see `NodeRuntimeOptions.telemetryDestination`. */
  telemetryDestination?: NodeRuntimeOptions['telemetryDestination'];
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
  // S3 file storage is a PostgreSQL-server feature; refuse it here rather
  // than silently keep files on disk.
  if ((process.env.RELAYCAST_FILE_STORE ?? '').trim() === 's3' || Object.keys(process.env).some((name) => name.startsWith('RELAYCAST_FILE_S3_') && (process.env[name] ?? '').trim() !== '')) {
    throw new ConfigError('RELAYCAST_FILE_STORE=s3 and RELAYCAST_FILE_S3_* are supported only on the PostgreSQL backend (set RELAYCAST_DATABASE_*); the SQLite server stores files on local disk');
  }
  const runtime = createNodeRuntime({
    dbPath: options.dbPath,
    baseUrl,
    fileDir: options.fileDir,
    fileSecret: options.fileSecret,
    migrate: options.migrate,
    auth: options.auth,
    admission: options.admission,
    telemetry: options.telemetry,
    telemetryCollector: options.telemetryCollector,
    telemetryDestination: options.telemetryDestination,
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
  // Parsed before opening the database, so a refused file-store setting fails
  // fast (exit 64) without a connection.
  const { createFileBlobStore, describeFileStoreConfig, loadFileStoreConfig } = await import('../adapters/node/fileStoreConfig.js');
  const fileStore = loadFileStoreConfig(options.env ?? process.env, options.fileDir ?? `${process.cwd()}/relaycast-files`);
  log(describeFileStoreConfig(fileStore));
  const fileBlobs = createFileBlobStore(fileStore);
  // Refuse to serve with an S3 store that cannot work (SDK missing: exit 64;
  // bucket unreachable or access denied: exit 1) instead of failing uploads.
  if ('verifyAccess' in fileBlobs && typeof fileBlobs.verifyAccess === 'function') await fileBlobs.verifyAccess();
  const handle = await openPostgresEngineDb(config, { log });
  let runtime: NodeRuntimeWithDb;
  try {
    runtime = createNodeRuntimeWithDb(handle.db, {
      baseUrl,
      fileDir: options.fileDir,
      fileBlobs,
      fileSecret: options.fileSecret,
      auth: options.auth,
      admission: options.admission,
      telemetry: options.telemetry,
      telemetryCollector: options.telemetryCollector,
      telemetryDestination: options.telemetryDestination,
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

/** PostgreSQL subcommands the container entrypoint dispatches here. */
export const POSTGRES_COMMANDS = ['migrate', 'verify-db', 'migration-preflight', 'export-for-actors', 'migrate-files-to-s3'] as const;
export type PostgresCommand = (typeof POSTGRES_COMMANDS)[number];

/**
 * Run a PostgreSQL subcommand (`migrate`, `verify-db`, or the durable-actors
 * migration's `migration-preflight` / `export-for-actors` with their
 * arguments) and return its exit code, for the container entrypoint.
 */
export async function runPostgresCommand(command: PostgresCommand, argv: readonly string[] = []): Promise<number> {
  const cli = await import('../adapters/postgres/cli.js');
  switch (command) {
    case 'migrate': return cli.runMigrateCommand();
    case 'verify-db': return cli.runVerifyDbCommand();
    case 'migration-preflight': return cli.runMigrationPreflightCommand(argv);
    case 'export-for-actors': return cli.runMigrationExportCommand(argv);
    case 'migrate-files-to-s3': return runMigrateFilesToS3Command(argv);
  }
}

/** Every not-deleted `files` row, read with the runtime database credentials (`RELAYCAST_DATABASE_*`). */
async function loadFileRowsFromPostgres(env: NodeJS.ProcessEnv): Promise<FileRow[]> {
  const { loadPostgresConfig, openPostgresPool } = await import('../adapters/postgres/index.js');
  const pool = openPostgresPool(loadPostgresConfig(env, 'runtime'));
  try {
    const { rows } = await pool.query<{ storage_key: string; status: string; size_bytes: string | number }>(
      "SELECT storage_key, status, size_bytes FROM files WHERE status <> 'deleted' ORDER BY storage_key",
    );
    return rows.map((row) => ({ storageKey: row.storage_key, status: row.status, sizeBytes: Number(row.size_bytes) }));
  } finally {
    await pool.end();
  }
}

/**
 * `migrate-files-to-s3 [--from <dir>]`: copy the local file store (default
 * `<cwd>/relaycast-files`, `/data/relaycast-files` in the image) into the
 * bucket that `RELAYCAST_FILE_STORE=s3` and `RELAYCAST_FILE_S3_*` name, for
 * every live `files` row (read with the `RELAYCAST_DATABASE_*` runtime
 * credentials). Exit 0 when every live file is in the bucket and verified, 1
 * on any mismatch, missing file or failure, and 64 for a refused
 * configuration. Never deletes local files.
 */
export async function runMigrateFilesToS3Command(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  io: { out: (line: string) => void; err: (line: string) => void } = {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  },
  options: { loadFileRows?: (env: NodeJS.ProcessEnv) => Promise<FileRow[]> } = {},
): Promise<number> {
  const { createFileBlobStore, describeFileStoreConfig, loadFileStoreConfig } = await import('../adapters/node/fileStoreConfig.js');
  const { migrateLocalFilesToS3 } = await import('../adapters/node/fileMigration.js');
  let from = `${process.cwd()}/relaycast-files`;
  try {
    for (let i = 0; i < argv.length; i += 1) {
      if (argv[i] === '--from' && argv[i + 1]) from = argv[++i]!;
      else throw new ConfigError(`unknown argument ${JSON.stringify(argv[i])}; usage: migrate-files-to-s3 [--from <dir>]`);
    }
    const config = loadFileStoreConfig(env, from);
    if (config.kind !== 's3') throw new ConfigError('migrate-files-to-s3 needs RELAYCAST_FILE_STORE=s3 and RELAYCAST_FILE_S3_* set to the target bucket');
    io.out(describeFileStoreConfig(config));
    const { S3BlobStore } = await import('../adapters/node/s3Blobs.js');
    const store = createFileBlobStore(config) as InstanceType<typeof S3BlobStore>;
    await store.verifyAccess();
    // The live file rows decide what is copied (runtime credentials, read only).
    const rows = await (options.loadFileRows ?? loadFileRowsFromPostgres)(env);
    const summary = await migrateLocalFilesToS3({ dir: from, store, rows, log: io.out });
    return summary.mismatched.length === 0 && summary.failed.length === 0 ? 0 : 1;
  } catch (error) {
    io.err(`migrate-files-to-s3: ${error instanceof Error ? error.message : String(error)}`);
    return error instanceof ConfigError ? 64 : 1;
  }
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
      await Promise.all([
        new Promise<void>((resolve) => {
          (server as unknown as { close: (cb: () => void) => void }).close(() => resolve());
        }),
        // Bounded by the collector's shutdown timeout; immediate without one.
        runtime.closeTelemetry(),
      ]);
    },
  };
}
