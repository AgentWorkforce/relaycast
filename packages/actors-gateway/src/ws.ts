/**
 * The WebSocket bridge for `/v1/ws` and `/v1/node/ws`.
 *
 * A client's upgrade is answered only after its workspace actor granted it:
 * the gateway resolves the workspace from the token, probes the actor with
 * the upgrade request, asks the control plane for a socket URL with the
 * grant's principal as metadata, opens that socket, and then completes the
 * client's handshake and pipes text frames both ways until either side
 * closes. The control plane's socket URL is a credential and is never logged.
 */
import { STATUS_CODES, type IncomingMessage } from 'node:http';
import { performance } from 'node:perf_hooks';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import { parseArCredential } from '@relaycast/engine/gateway';
import { ActorCallError } from './actors.js';
import type { GatewayContext } from './context.js';
import { REQUEST_ID_HEADER, bearerToken, requestHeaders, requestIdFor, requestUrl } from './http.js';
import { errorText } from './log.js';
import { parseSocketGrant } from './socketGrant.js';

/** Largest frame a client may send upstream. */
export const CLIENT_MAX_MESSAGE_BYTES = 1024 * 1024;
const UPSTREAM_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
/** A close reason is at most 123 bytes on the wire. */
const MAX_REASON_BYTES = 123;
const SOCKET_PATHS = new Set(['/v1/ws', '/v1/node/ws']);

export interface SocketBridge {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** Close every bridged client with `code`, then drop the ones that do not answer. */
  closeAll(code: number, reason: string): void;
  /** Open bridges. */
  readonly size: number;
}

export interface SocketBridgeOptions {
  pingIntervalMs?: number;
  connectTimeoutMs?: number;
}

/** The token from `?token=` or `Authorization: Bearer`, as the engine's `queryOrBearerToken`. */
export function queryOrBearerToken(req: IncomingMessage, url: URL): string | undefined {
  return url.searchParams.get('token')?.trim() || bearerToken(req);
}

/** Codes the `ws` library will put in a close frame; others become 1011. */
export function sendableCloseCode(code: number): number {
  const valid = (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) || (code >= 3000 && code <= 4999);
  return valid ? code : 1011;
}

function closeReason(reason: Buffer | string): string {
  const text = typeof reason === 'string' ? reason : reason.toString('utf8');
  return Buffer.byteLength(text) <= MAX_REASON_BYTES ? text : Buffer.from(text).subarray(0, MAX_REASON_BYTES).toString('utf8').replace(/�$/, '');
}

/** Refuse an upgrade with a raw HTTP response (the handshake never completes). */
export function rejectUpgrade(socket: Duplex, status: number, body?: string): void {
  const lines = [`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Error'}`, 'Connection: close'];
  if (body !== undefined) lines.push('Content-Type: application/json', `Content-Length: ${Buffer.byteLength(body)}`);
  try {
    socket.write(`${lines.join('\r\n')}\r\n\r\n${body ?? ''}`);
    socket.destroy();
  } catch {
    // socket already gone
  }
}

function probeHeaders(req: IncomingMessage, requestId: string): [string, string][] {
  const headers = requestHeaders(req).filter(([name]) => !name.startsWith('sec-websocket-') && name !== REQUEST_ID_HEADER);
  headers.push(['upgrade', 'websocket'], ['connection', 'Upgrade'], [REQUEST_ID_HEADER, requestId]);
  return headers;
}

function jsonBody(body: string): string | undefined {
  try {
    JSON.parse(body);
    return body;
  } catch {
    return undefined;
  }
}

export function createSocketBridge(ctx: GatewayContext, options: SocketBridgeOptions = {}): SocketBridge {
  const pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const wss = new WebSocketServer({ noServer: true, maxPayload: CLIENT_MAX_MESSAGE_BYTES });
  const clients = new Set<WebSocket>();

  interface Bridged {
    path: string;
    workspaceId: string;
    requestId: string;
    started: number;
  }

  function pipe(client: WebSocket, upstream: WebSocket, info: Bridged): void {
    clients.add(client);
    let closed = false;
    const finish = (code: number, reason: string, side: 'client' | 'upstream'): void => {
      if (closed) return;
      closed = true;
      clearInterval(pinger);
      clients.delete(client);
      ctx.logger.info('socket.close', {
        path: info.path,
        workspace_id: info.workspaceId,
        request_id: info.requestId,
        closed_by: side,
        code,
        reason,
        ms: Math.round(performance.now() - info.started),
      });
    };

    client.on('message', (data, isBinary) => {
      if (isBinary) {
        client.close(1003, 'text frames only');
        return;
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data.toString());
    });
    upstream.on('message', (data) => {
      if (client.readyState === WebSocket.OPEN) client.send(data.toString());
    });

    upstream.on('close', (code, reason) => {
      const text = closeReason(reason);
      finish(code, text, 'upstream');
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close(sendableCloseCode(code), text);
    });
    client.on('close', (code, reason) => {
      const text = closeReason(reason);
      finish(code, text, 'client');
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close(sendableCloseCode(code), text);
    });
    client.on('error', () => {});
    upstream.on('error', (error) => {
      ctx.logger.warn('socket.upstream_error', { request_id: info.requestId, workspace_id: info.workspaceId, error: errorText(error) });
    });

    // Protocol-level liveness: the library answers pings from either side on
    // its own; this ping tells a vanished client from a quiet one.
    let alive = true;
    client.on('pong', () => { alive = true; });
    const pinger = setInterval(() => {
      if (!alive) {
        client.terminate();
        return;
      }
      alive = false;
      client.ping();
    }, pingIntervalMs);
  }

  async function bridge(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL, requestId: string, workspaceId: string): Promise<void> {
    const started = performance.now();
    const probe = await ctx.actors.handle(workspaceId, { method: 'GET', url: url.toString(), headers: probeHeaders(req, requestId), body: null });
    // Only a grant to the probe this gateway sent opens a socket; anything
    // else, including a 200 that is not a grant, refuses the upgrade.
    const principal = parseSocketGrant(probe);
    if (!principal) {
      const status = probe.status === 200 ? 502 : probe.status;
      ctx.logger.info('socket.refused', { path: url.pathname, workspace_id: workspaceId, request_id: requestId, status });
      rejectUpgrade(socket, status, jsonBody(probe.body));
      return;
    }
    const grant = await ctx.actors.findWebsocket(workspaceId, principal);
    if (grant.connectByMs < Date.now()) throw new ActorCallError('grant_expired', 'the socket grant expired before the gateway could use it');

    const upstream = new WebSocket(grant.websocketUrl, { maxPayload: UPSTREAM_MAX_MESSAGE_BYTES, handshakeTimeout: connectTimeoutMs });
    const info: Bridged = { path: url.pathname, workspaceId, requestId, started };
    let settled = false;
    upstream.once('open', () => {
      if (settled) return;
      settled = true;
      wss.handleUpgrade(req, socket, head, (client) => {
        ctx.logger.info('socket.open', { path: info.path, workspace_id: workspaceId, request_id: requestId, home_region: grant.homeRegion });
        pipe(client, upstream, info);
      });
    });
    const failed = (error: unknown): void => {
      if (settled) return;
      settled = true;
      ctx.logger.error('socket.upstream_failed', { path: url.pathname, workspace_id: workspaceId, request_id: requestId, error: errorText(error) });
      // The client's handshake completes so it receives a close code rather than a dropped TCP connection.
      wss.handleUpgrade(req, socket, head, (client) => client.close(1011, 'upstream unavailable'));
    };
    upstream.once('error', failed);
    upstream.once('close', () => failed(new Error('upstream closed before open')));
  }

  return {
    handleUpgrade(req, socket, head) {
      socket.on('error', () => {});
      const requestId = requestIdFor(req);
      const url = requestUrl(req, ctx.fallbackHost());
      if (!url) return rejectUpgrade(socket, 400, JSON.stringify({ ok: false, error: { code: 'invalid_request', message: 'Invalid Host header' } }));
      if (!SOCKET_PATHS.has(url.pathname)) return rejectUpgrade(socket, 426);
      const token = queryOrBearerToken(req, url);
      if (!token) return rejectUpgrade(socket, 401, JSON.stringify({ ok: false, error: { code: 'unauthorized', message: 'Missing token' } }));
      const credential = parseArCredential(token);
      void (async () => {
        if (!credential || !(await ctx.credentialTags.verify(token))) {
          rejectUpgrade(socket, 401, JSON.stringify({ ok: false, error: { code: 'unauthorized', message: 'An ar_ credential issued by this deployment is required' } }));
          return;
        }
        await bridge(req, socket, head, url, requestId, credential.workspaceId);
      })().catch((error: unknown) => {
        const status = error instanceof ActorCallError ? 502 : 500;
        ctx.logger.error('socket.failed', { path: url.pathname, workspace_id: credential?.workspaceId, request_id: requestId, error: errorText(error) });
        rejectUpgrade(socket, status, JSON.stringify({
          ok: false,
          error: status === 502
            ? { code: 'workspace_unavailable', message: 'The workspace could not be reached; retry' }
            : { code: 'internal_error', message: 'Internal server error' },
        }));
      });
    },
    closeAll(code, reason) {
      for (const client of clients) client.close(code, reason);
      wss.close();
    },
    get size() {
      return clients.size;
    },
  };
}
