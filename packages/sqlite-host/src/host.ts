/**
 * A SQLite workspace host, speaking the subset of the durable-actors control
 * plane wire protocol the relaycast gateway uses (`actors-gateway/src/actors.ts`):
 *
 *   POST /v1/projects/:project/actors/Workspace/:id/invoke          {requestId, method, args} → {outcome}
 *   POST /v1/projects/:project/actors/Workspace/:id/find-websocket  {metadata} → {websocketUrl, homeRegion, connectByMs}
 *   GET  /v1/sockets/:host/:token  (WebSocket upgrade; the grant)
 *   GET  /healthz
 *
 * so the gateway and the engine run unchanged. The router (`router.ts`)
 * decides which host owns a workspace; a host serves whatever it is sent and
 * relies on the log's create-only slots for correctness (see `workspace.ts`).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { FencedError, LoadedWorkspace, type HostLog, type WorkspaceConfig } from './workspace.js';
import type { LogStore } from './store.js';

export interface HostOptions {
  /** This host's name in socket URLs (the router dials `/v1/sockets/<name>/…` on it). */
  name: string;
  /** The origin socket URLs carry (the router's, or this host's for a direct setup). */
  socketOrigin: string;
  /** Bearer secret the gateway sends (DURABLE_ACTORS_SECRET); unset accepts any caller. */
  secret?: string;
  /** Signs socket grants. */
  grantSecret: string;
  store: LogStore;
  prefix: string;
  dataDir: string;
  config: WorkspaceConfig;
  baseEvery: number;
  durability: 'sync' | 'async';
  /** How often loaded workspaces check whether another host has written past them. Default 1 s. */
  fenceWatchMs?: number;
  log: HostLog;
}

const ACTOR_PATH = /^\/v1\/projects\/[^/]+\/actors\/Workspace\/([A-Za-z0-9._-]+)\/(invoke|find-websocket)$/;
const SOCKET_PATH = /^\/v1\/sockets\/([^/]+)\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;
const GRANT_TTL_MS = 30_000;

export class WorkspaceHost {
  private readonly workspaces = new Map<string, Promise<LoadedWorkspace>>();
  private readonly loaded = new Map<string, LoadedWorkspace>();
  private readonly server: Server;
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  private fenceTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: HostOptions) {
    this.server = createServer((req, res) => {
      this.route(req, res).catch((error) => respond(res, 500, { error: { code: 'internal', message: String(error) } }));
    });
    this.server.on('upgrade', (req, socket, head) => {
      const match = SOCKET_PATH.exec(new URL(req.url ?? '/', 'http://host').pathname);
      const grant = match && match[1] === this.options.name ? this.verifyGrant(match[2]) : undefined;
      if (!grant) {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      this.sockets.handleUpgrade(req, socket, head, (client) => void this.attach(client, grant.workspaceId, grant.metadata));
    });
  }

  listen(port: number): Promise<void> {
    this.fenceTimer = setInterval(() => void this.fenceWatch(), this.options.fenceWatchMs ?? 1000);
    this.fenceTimer.unref();
    return new Promise((resolve) => this.server.listen(port, resolve));
  }

  async close(): Promise<void> {
    clearInterval(this.fenceTimer);
    for (const loading of this.workspaces.values()) (await loading.catch(() => undefined))?.evict('host stopping');
    this.sockets.close();
    await new Promise((resolve) => this.server.close(resolve));
  }

  /** The workspace, loading it from the store the first time this host is asked for it. */
  workspace(id: string): Promise<LoadedWorkspace> {
    let loading = this.workspaces.get(id);
    if (!loading) {
      loading = LoadedWorkspace.load({
        workspaceId: id,
        store: this.options.store,
        prefix: this.options.prefix,
        dataDir: this.options.dataDir,
        config: this.options.config,
        baseEvery: this.options.baseEvery,
        durability: this.options.durability,
        log: this.options.log,
        onEvicted: (workspace) => {
          if (this.loaded.get(workspace.id) !== workspace) return;
          this.loaded.delete(workspace.id);
          this.workspaces.delete(workspace.id);
        },
      });
      loading.then((workspace) => this.loaded.set(id, workspace), () => this.workspaces.delete(id));
      this.workspaces.set(id, loading);
    }
    return loading;
  }

  /** Runs `method`; a call this copy lost the log race for reruns once on a fresh load. */
  async invoke(id: string, method: string, args: unknown[]): Promise<unknown> {
    try {
      return await (await this.workspace(id)).invoke(method, args);
    } catch (error) {
      if (!(error instanceof FencedError)) throw error;
      return (await this.workspace(id)).invoke(method, args);
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://host');
    if (req.method === 'GET' && url.pathname === '/healthz') return respond(res, 200, { ok: true, workspaces: this.workspaces.size });
    const match = ACTOR_PATH.exec(url.pathname);
    if (req.method !== 'POST' || !match) return respond(res, 404, { error: { code: 'not_found', message: 'not found' } });
    if (this.options.secret && req.headers.authorization !== `Bearer ${this.options.secret}`) {
      return respond(res, 401, { error: { code: 'unauthenticated', message: 'bad credential' } });
    }
    const [, id, action] = match;
    const body = JSON.parse(await readBody(req)) as { method?: string; args?: unknown[]; metadata?: unknown };
    if (action === 'find-websocket') {
      return respond(res, 200, {
        websocketUrl: `${this.options.socketOrigin.replace(/^http/, 'ws')}/v1/sockets/${encodeURIComponent(this.options.name)}/${this.signGrant(id, body.metadata)}`,
        homeRegion: 'local',
        connectByMs: Date.now() + GRANT_TTL_MS,
      });
    }
    const started = performance.now();
    let outcome: unknown;
    try {
      outcome = { type: 'completed', result: (await this.invoke(id, body.method ?? '', body.args ?? [])) ?? null };
    } catch (error) {
      outcome = { type: 'failed', code: 'actor_method_failed', message: (error as Error).message };
    }
    res.setHeader('x-host-ms', (performance.now() - started).toFixed(2));
    return respond(res, 200, { outcome });
  }

  private async attach(client: WebSocket, workspaceId: string, metadata: unknown): Promise<void> {
    const connection = {
      send: (data: string) => client.send(data),
      close: (code: number, reason: string) => client.close(code, reason),
    };
    // Frames that arrive while onConnect runs wait behind it, in order.
    const early: unknown[] = [];
    let socketId: string | undefined;
    let workspace: LoadedWorkspace | undefined;
    client.on('message', (data) => {
      let frame: unknown;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!socketId || !workspace) early.push(frame);
      else void workspace.message(socketId, frame).catch(() => undefined);
    });
    let closed = false;
    client.on('close', () => {
      closed = true;
      if (socketId && workspace) void workspace.disconnect(socketId).catch(() => undefined);
    });
    try {
      workspace = await this.workspace(workspaceId);
      socketId = await workspace.connect(metadata, connection);
    } catch {
      if (client.readyState === client.OPEN) client.close(1011, 'workspace unavailable');
      return;
    }
    for (const frame of early.splice(0)) void workspace.message(socketId, frame).catch(() => undefined);
    if (closed) void workspace.disconnect(socketId).catch(() => undefined);
  }

  /** Evicts every loaded workspace another host has written past (the router moved it). */
  private async fenceWatch(): Promise<void> {
    for (const loading of [...this.workspaces.values()]) {
      const workspace = await loading.catch(() => undefined);
      if (workspace && await workspace.superseded().catch(() => false)) workspace.evict('another host wrote past this copy');
    }
  }

  private signGrant(workspaceId: string, metadata: unknown): string {
    const payload = Buffer.from(JSON.stringify({ w: workspaceId, m: metadata, e: Date.now() + GRANT_TTL_MS })).toString('base64url');
    return `${payload}.${createHmac('sha256', this.options.grantSecret).update(payload).digest('base64url')}`;
  }

  private verifyGrant(token: string): { workspaceId: string; metadata: unknown } | undefined {
    const [payload, signature] = token.split('.');
    const expected = createHmac('sha256', this.options.grantSecret).update(payload).digest();
    const given = Buffer.from(signature, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    const grant = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { w: string; m: unknown; e: number };
    return grant.e >= Date.now() ? { workspaceId: grant.w, metadata: grant.m } : undefined;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
