/**
 * The router in front of the SQLite workspace hosts. The gateway's control
 * plane URL and socket origin point here.
 *
 * A workspace is owned by the healthy host with the highest rendezvous hash
 * of (host, workspace): every router instance agrees without coordination,
 * and losing a host moves only its workspaces. Hosts are health-checked every
 * `checkMs`; a host is down after `downAfter` failed checks and back after
 * `upAfter` good ones, so a flapping host does not bounce ownership.
 * Ownership here is only routing: a stale host that still writes loses the
 * log slot and evicts itself (`workspace.ts`), so a routing disagreement
 * costs a retry, never a lost or forked write.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { HostLog } from './workspace.js';

export interface RouterHost {
  name: string;
  /** http(s) origin of the host. */
  url: string;
}

export interface RouterOptions {
  hosts: RouterHost[];
  checkMs?: number;
  downAfter?: number;
  upAfter?: number;
  log: HostLog;
}

const ACTOR_PATH = /^\/v1\/projects\/[^/]+\/actors\/Workspace\/([A-Za-z0-9._-]+)\/(invoke|find-websocket)$/;
const SOCKET_PATH = /^\/v1\/sockets\/([^/]+)\//;

interface HostState extends RouterHost {
  healthy: boolean;
  streak: number;
}

export class WorkspaceRouter {
  private readonly hosts: HostState[];
  private readonly server: Server;
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: RouterOptions) {
    this.hosts = options.hosts.map((host) => ({ ...host, healthy: true, streak: 0 }));
    this.server = createServer((req, res) => {
      this.route(req, res).catch((error) => respond(res, 502, { error: { code: 'router_failed', message: String(error) } }));
    });
    this.server.on('upgrade', (req, socket, head) => {
      const name = SOCKET_PATH.exec(new URL(req.url ?? '/', 'http://router').pathname)?.[1];
      const host = this.hosts.find((candidate) => candidate.name === decodeURIComponent(name ?? ''));
      if (!host) {
        socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
        return;
      }
      const upstream = new WebSocket(`${host.url.replace(/^http/, 'ws')}${req.url}`);
      upstream.once('open', () => {
        this.sockets.handleUpgrade(req, socket, head, (client) => pipe(client, upstream));
      });
      upstream.once('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
      upstream.once('unexpected-response', (_request, response) => socket.end(`HTTP/1.1 ${response.statusCode ?? 502} Upstream\r\n\r\n`));
    });
  }

  listen(port: number): Promise<void> {
    void this.check();
    this.timer = setInterval(() => void this.check(), this.options.checkMs ?? 500);
    this.timer.unref();
    return new Promise((resolve) => this.server.listen(port, resolve));
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    this.sockets.close();
    await new Promise((resolve) => this.server.close(resolve));
  }

  /** The healthy host that owns `workspaceId`, or none when every host is down. */
  owner(workspaceId: string): RouterHost | undefined {
    let best: HostState | undefined;
    let bestScore = '';
    for (const host of this.hosts) {
      if (!host.healthy) continue;
      const score = createHash('sha256').update(`${host.name}\0${workspaceId}`).digest('hex');
      if (score > bestScore) {
        best = host;
        bestScore = score;
      }
    }
    return best;
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://router');
    if (req.method === 'GET' && url.pathname === '/healthz') {
      const healthy = this.hosts.filter((host) => host.healthy).map((host) => host.name);
      return respond(res, healthy.length > 0 ? 200 : 503, { healthy });
    }
    const id = ACTOR_PATH.exec(url.pathname)?.[1];
    if (!id) return respond(res, 404, { error: { code: 'not_found', message: 'not found' } });
    const host = this.owner(id);
    if (!host) return respond(res, 503, { error: { code: 'no_healthy_host', message: 'no workspace host is healthy' } });
    const started = performance.now();
    const body = await readBody(req);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    for (const name of ['authorization', 'x-request-id', 'accept']) {
      const value = req.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    const upstream = await fetch(`${host.url}${url.pathname}`, { method: 'POST', headers, body });
    const text = await upstream.text();
    const total = performance.now() - started;
    const hostMs = Number(upstream.headers.get('x-host-ms') ?? NaN);
    this.options.log({
      event: 'sqlite_router_forward', workspace_id: id, host: host.name, action: url.pathname.endsWith('/invoke') ? 'invoke' : 'find-websocket',
      status: upstream.status, total_ms: round(total), ...(Number.isFinite(hostMs) ? { router_overhead_ms: round(total - hostMs) } : {}),
    });
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
    res.end(text);
  }

  private async check(): Promise<void> {
    await Promise.all(this.hosts.map(async (host) => {
      let ok = false;
      try {
        ok = (await fetch(`${host.url}/healthz`, { signal: AbortSignal.timeout(400) })).ok;
      } catch {
        ok = false;
      }
      if (ok === host.healthy) {
        host.streak = 0;
        return;
      }
      host.streak += 1;
      if (host.streak >= (ok ? this.options.upAfter ?? 3 : this.options.downAfter ?? 2)) {
        host.healthy = ok;
        host.streak = 0;
        this.options.log({ event: 'sqlite_router_host', host: host.name, healthy: ok, at_ms: Date.now() });
      }
    }));
  }
}

function pipe(client: WebSocket, upstream: WebSocket): void {
  client.on('message', (data, binary) => upstream.readyState === WebSocket.OPEN && upstream.send(data, { binary }));
  upstream.on('message', (data, binary) => client.readyState === WebSocket.OPEN && client.send(data, { binary }));
  client.on('close', (code, reason) => upstream.close(validClose(code), reason));
  upstream.on('close', (code, reason) => client.close(validClose(code), reason));
  client.on('error', () => upstream.terminate());
  upstream.on('error', () => client.terminate());
}

function validClose(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1011;
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

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}
