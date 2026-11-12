/**
 * An in-process stand-in for the durable-actors control plane: `/invoke`
 * runs a scripted `Workspace` actor, `/find-websocket` issues a one-shot
 * socket key, `/v1/socket` is the actor's end of a bridged WebSocket, and
 * `/healthz` answers readiness. Enough of the 0.14.6 wire protocol for the
 * gateway to be tested end to end without Bun or a sandbox.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import type { ActorHttpRequest, ActorHttpResponse } from '@relaycast/engine/gateway';

export interface FakeWorkspace {
  create?(request: ActorHttpRequest, credentialTag: string): ActorHttpResponse | Promise<ActorHttpResponse>;
  handle(request: ActorHttpRequest): ActorHttpResponse | Promise<ActorHttpResponse>;
  importData?(body: unknown, credentialTag: string): ActorHttpResponse | Promise<ActorHttpResponse>;
  fileStored?(key: string, size: number): { recorded: boolean } | Promise<{ recorded: boolean }>;
}

export interface Invocation {
  actorId: string;
  method: string;
  args: unknown[];
  requestId: string;
  headers: IncomingMessage['headers'];
}

export interface FakeControlPlaneOptions {
  /** When set, every call must carry `Authorization: Bearer <secret>`. */
  secret?: string;
  projectId?: string;
  workspace: (actorId: string) => FakeWorkspace | undefined;
}

export interface FakeControlPlane {
  url: string;
  projectId: string;
  invocations: Invocation[];
  findWebsocketCalls: { actorId: string; metadata: unknown; homeRegion?: unknown }[];
  /** The actor's end of each bridged socket, in connection order. */
  sessions: WebSocket[];
  /** Called with the actor's end of a new socket and the grant's metadata. Default: echo text frames. */
  onSession: (socket: WebSocket, metadata: unknown) => void;
  /** Override the reply to an `/invoke` call: a JSON document and HTTP status. */
  interceptInvoke?: (invocation: Invocation) => { status: number; body: unknown } | undefined;
  /** HTTP status `/find-websocket` fails with, when set. */
  failFindWebsocket?: number;
  /** When false, `/v1/socket` refuses the upgrade (simulates an upstream that cannot be reached). */
  acceptSockets: boolean;
  healthy: boolean;
  close(): Promise<void>;
}

export function jsonResponse(status: number, payload: unknown, headers: [string, string][] = []): ActorHttpResponse {
  return { status, headers: [['content-type', 'application/json'], ...headers], body: JSON.stringify(payload) };
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function reply(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) });
  res.end(body);
}

export async function startFakeControlPlane(options: FakeControlPlaneOptions): Promise<FakeControlPlane> {
  const projectId = options.projectId ?? 'local';
  const grants = new Map<string, unknown>();
  const wss = new WebSocketServer({ noServer: true });
  const actorRoute = new RegExp(`^/v1/projects/${projectId}/actors/Workspace/([^/]+)/(invoke|find-websocket)$`);

  const plane: FakeControlPlane = {
    url: '',
    projectId,
    invocations: [],
    findWebsocketCalls: [],
    sessions: [],
    onSession: (socket) => {
      socket.on('message', (data, isBinary) => {
        if (!isBinary) socket.send(JSON.stringify({ echo: data.toString() }));
      });
    },
    acceptSockets: true,
    healthy: true,
    close: async () => {},
  };

  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://fake');
      if (url.pathname === '/healthz') {
        res.writeHead(plane.healthy ? 200 : 503);
        res.end(plane.healthy ? 'ok' : 'down');
        return;
      }
      if (options.secret && req.headers.authorization !== `Bearer ${options.secret}`) {
        reply(res, 401, { error: { code: 'unauthenticated', message: 'bad credential' } });
        return;
      }
      const match = actorRoute.exec(url.pathname);
      if (!match || req.method !== 'POST') {
        reply(res, 404, { error: { code: 'not_found', message: `no route ${req.method} ${url.pathname}` } });
        return;
      }
      const actorId = decodeURIComponent(match[1]);
      const body = (await readJson(req)) as Record<string, unknown>;
      if (match[2] === 'find-websocket') {
        plane.findWebsocketCalls.push({ actorId, metadata: body.metadata, homeRegion: body.homeRegion });
        if (plane.failFindWebsocket) {
          reply(res, plane.failFindWebsocket, { error: { code: 'socket_unavailable', message: 'no host' } });
          return;
        }
        const key = randomUUID();
        grants.set(key, body.metadata);
        reply(res, 200, { websocketUrl: `${plane.url.replace(/^http/, 'ws')}/v1/socket?key=${key}`, homeRegion: 'local', connectByMs: Date.now() + 5_000 });
        return;
      }
      const invocation: Invocation = {
        actorId,
        method: String(body.method),
        args: Array.isArray(body.args) ? body.args : [],
        requestId: String(body.requestId),
        headers: req.headers,
      };
      plane.invocations.push(invocation);
      const intercepted = plane.interceptInvoke?.(invocation);
      if (intercepted) {
        reply(res, intercepted.status, intercepted.body);
        return;
      }
      const workspace = options.workspace(actorId);
      if (!workspace) {
        reply(res, 200, { outcome: { type: 'failed', code: 'actor_not_found', message: `no workspace ${actorId}` } });
        return;
      }
      try {
        const result = invocation.method === 'create'
          ? await workspace.create?.(invocation.args[0] as ActorHttpRequest, String(invocation.args[1]))
          : invocation.method === 'importData'
            ? await workspace.importData?.(invocation.args[0], String(invocation.args[1]))
          : invocation.method === 'fileStored'
            ? await workspace.fileStored?.(String(invocation.args[0]), Number(invocation.args[1]))
            : await workspace.handle(invocation.args[0] as ActorHttpRequest);
        if (!result) throw new Error(`actor has no method ${invocation.method}`);
        reply(res, 200, { outcome: { type: 'completed', result } });
      } catch (error) {
        reply(res, 200, { outcome: { type: 'failed', code: 'actor_error', message: (error as Error).message } });
      }
    } catch (error) {
      reply(res, 500, { error: { code: 'fake_failed', message: (error as Error).message } });
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const key = url.searchParams.get('key') ?? '';
    if (url.pathname !== '/v1/socket' || !grants.has(key) || !plane.acceptSockets) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const metadata = grants.get(key);
    grants.delete(key);
    wss.handleUpgrade(req, socket, head, (ws) => {
      plane.sessions.push(ws);
      plane.onSession(ws, metadata);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  plane.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  plane.close = () => new Promise<void>((resolve) => {
    for (const session of plane.sessions) session.terminate();
    wss.close();
    server.closeAllConnections();
    server.close(() => resolve());
  });
  return plane;
}

/** Wait for the next event of `name` on `emitter`, with its arguments. */
export function once<T extends unknown[]>(emitter: { once(event: string, listener: (...args: T) => void): unknown }, name: string): Promise<T> {
  return new Promise((resolve) => emitter.once(name, (...args: T) => resolve(args)));
}

/** Poll until `condition` holds, failing after `timeoutMs`. */
export async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
