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
/** Frames queued for a peer that is not reading (either direction); past this the client is closed 1013. */
const MAX_CLIENT_BUFFERED_BYTES = 2 * UPSTREAM_MAX_MESSAGE_BYTES;
/**
 * Bytes a client may send before its upgrade is answered. A WebSocket client
 * sends nothing until it has its 101, so anything here is already suspect;
 * past this the connection is dropped rather than buffered while its actor
 * is being asked.
 */
const MAX_EARLY_BYTES = 16 * 1024;
const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
/** A close reason is at most 123 bytes on the wire. */
const MAX_REASON_BYTES = 123;
const SOCKET_PATHS = new Set(['/v1/ws', '/v1/node/ws']);

export interface SocketBridge {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** Begin closing every bridged client with `code`; refuse the upgrades still pending and any that arrive after. */
  closeAll(code: number, reason: string): void;
  /** Drop the clients whose close handshake did not finish (the shutdown deadline). */
  terminateAll(): void;
  /** Open bridges. */
  readonly size: number;
}

export interface SocketBridgeOptions {
  pingIntervalMs?: number;
  connectTimeoutMs?: number;
  /** Bytes queued for a peer that is not reading before the client is closed 1013 (default twice the largest upstream frame). */
  maxBufferedBytes?: number;
}

/** The token from `?token=` or `Authorization: Bearer`, as the engine's `queryOrBearerToken`. */
export function queryOrBearerToken(req: IncomingMessage, url: URL): string | undefined {
  return url.searchParams.get('token')?.trim() || bearerToken(req);
}

/**
 * The code to relay a peer's close with: 1005 (it sent no status) is a normal
 * close and 1006 (its connection dropped) means it went away; the codes the
 * `ws` library refuses to put in a close frame become 1011.
 */
export function sendableCloseCode(code: number): number {
  if (code === 1005) return 1000;
  if (code === 1006) return 1001;
  const valid = (code >= 1000 && code <= 1014 && code !== 1004) || (code >= 3000 && code <= 4999);
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
  const maxBufferedBytes = options.maxBufferedBytes ?? MAX_CLIENT_BUFFERED_BYTES;
  if (!Number.isFinite(maxBufferedBytes) || maxBufferedBytes < 0) {
    throw new RangeError('maxBufferedBytes must be a finite non-negative number');
  }
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
      if (upstream.readyState !== WebSocket.OPEN) return;
      // The mirror of the client-side bound: an actor socket that stopped
      // reading must not let one client grow the outgoing queue without end.
      if (upstream.bufferedAmount > maxBufferedBytes) {
        client.close(1013, 'slow upstream');
        return;
      }
      upstream.send(data.toString());
    });
    upstream.on('message', (data) => {
      if (client.readyState !== WebSocket.OPEN) return;
      // The actor is not paused for a client that stopped reading; bound what
      // can pile up for one instead.
      if (client.bufferedAmount > maxBufferedBytes) {
        client.close(1013, 'slow consumer');
        return;
      }
      client.send(data.toString());
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

  interface Pending {
    socket: Duplex;
    /** Set once the control plane's socket is being opened. */
    upstream?: WebSocket;
    /** True once the upgrade was answered (bridged or refused), the client went away, or shutdown began. */
    settled: boolean;
    onGone: () => void;
    /**
     * Keeps the socket flowing while the upgrade is pending (Node leaves an
     * upgraded socket paused, so its FIN would go unread): bytes a client sends
     * before its 101 are kept for the handshake.
     */
    onData: (chunk: Buffer) => void;
    early: Buffer[];
    earlyBytes: number;
  }
  /** Upgrades between arrival and their answer, so a client that leaves or a shutdown can cancel them. */
  const pending = new Set<Pending>();
  let closing = false;

  /** Mark `entry` answered; false when something else (client gone, shutdown) already did. */
  function settle(entry: Pending): boolean {
    if (entry.settled) return false;
    entry.settled = true;
    pending.delete(entry);
    entry.socket.off('close', entry.onGone);
    entry.socket.off('end', entry.onGone);
    entry.socket.off('data', entry.onData);
    return true;
  }

  async function bridge(entry: Pending, req: IncomingMessage, head: Buffer, url: URL, requestId: string, workspaceId: string): Promise<void> {
    const { socket } = entry;
    const started = performance.now();
    const probe = await ctx.actors.handle(workspaceId, { method: 'GET', url: url.toString(), headers: probeHeaders(req, requestId), body: null });
    if (entry.settled) return;
    // Only a grant to the probe this gateway sent opens a socket; anything
    // else, including a 200 that is not a grant, refuses the upgrade.
    const principal = parseSocketGrant(probe);
    if (!principal) {
      const status = probe.status === 200 ? 502 : probe.status;
      ctx.logger.info('socket.refused', { path: url.pathname, workspace_id: workspaceId, request_id: requestId, status });
      settle(entry);
      rejectUpgrade(socket, status, jsonBody(probe.body));
      return;
    }
    const grant = await ctx.actors.findWebsocket(workspaceId, principal);
    if (entry.settled) return;
    if (grant.connectByMs < Date.now()) throw new ActorCallError('grant_expired', 'the socket grant expired before the gateway could use it');

    const upstream = new WebSocket(grant.websocketUrl, { maxPayload: UPSTREAM_MAX_MESSAGE_BYTES, handshakeTimeout: connectTimeoutMs });
    entry.upstream = upstream;
    const info: Bridged = { path: url.pathname, workspaceId, requestId, started };
    upstream.once('open', () => {
      if (!settle(entry)) {
        upstream.close(1001, 'client went away');
        return;
      }
      let piped = false;
      wss.handleUpgrade(req, socket, entry.early.length > 0 ? Buffer.concat([head, ...entry.early]) : head, (client) => {
        piped = true;
        ctx.logger.info('socket.open', { path: info.path, workspace_id: workspaceId, request_id: requestId, home_region: grant.homeRegion });
        pipe(client, upstream, info);
      });
      // The library calls back synchronously, and not at all for a client
      // whose socket is no longer usable: nothing would ever close the upstream.
      if (!piped) {
        ctx.logger.info('socket.client_gone', { path: info.path, workspace_id: workspaceId, request_id: requestId });
        upstream.close(1001, 'client went away');
      }
    });
    const failed = (error: unknown): void => {
      if (!settle(entry)) return;
      ctx.logger.error('socket.upstream_failed', { path: url.pathname, workspace_id: workspaceId, request_id: requestId, error: errorText(error) });
      // The client's handshake completes so it receives a close code rather than a dropped TCP connection.
      wss.handleUpgrade(req, socket, head, (client) => client.close(1011, 'upstream unavailable'));
    };
    upstream.once('error', failed);
    upstream.once('close', () => failed(new Error('upstream closed before open')));
  }

  const shuttingDown = JSON.stringify({ ok: false, error: { code: 'shutting_down', message: 'The gateway is restarting; retry' } });

  return {
    handleUpgrade(req, socket, head) {
      socket.on('error', () => {});
      if (closing) return rejectUpgrade(socket, 503, shuttingDown);
      const requestId = requestIdFor(req);
      const url = requestUrl(req, ctx.fallbackHost());
      if (!url) return rejectUpgrade(socket, 400, JSON.stringify({ ok: false, error: { code: 'invalid_request', message: 'Invalid request target or Host header' } }));
      if (!SOCKET_PATHS.has(url.pathname)) return rejectUpgrade(socket, 426);
      const token = queryOrBearerToken(req, url);
      if (!token) return rejectUpgrade(socket, 401, JSON.stringify({ ok: false, error: { code: 'unauthorized', message: 'Missing token' } }));
      const credential = parseArCredential(token);
      // Bytes that arrived with the handshake count too.
      if (head.byteLength > MAX_EARLY_BYTES) {
        ctx.logger.warn('socket.early_bytes', { path: url.pathname, workspace_id: credential?.workspaceId, request_id: requestId, bytes: head.byteLength });
        return rejectUpgrade(socket, 400, JSON.stringify({ ok: false, error: { code: 'invalid_request', message: 'Unexpected data before the WebSocket handshake' } }));
      }
      const entry: Pending = {
        socket,
        settled: false,
        // A client that leaves while its actor is being asked: the answer, if
        // any, has nobody to go to, and an upstream already opening is dropped.
        onGone: () => {
          if (!settle(entry)) return;
          ctx.logger.info('socket.client_gone', { path: url.pathname, workspace_id: credential?.workspaceId, request_id: requestId });
          entry.upstream?.terminate();
          socket.destroy();
        },
        onData: (chunk) => {
          entry.earlyBytes += chunk.byteLength;
          if (entry.earlyBytes > MAX_EARLY_BYTES) {
            if (!settle(entry)) return;
            ctx.logger.warn('socket.early_bytes', { path: url.pathname, workspace_id: credential?.workspaceId, request_id: requestId, bytes: entry.earlyBytes });
            entry.upstream?.terminate();
            socket.destroy();
            return;
          }
          entry.early.push(chunk);
        },
        early: [],
        earlyBytes: head.byteLength,
      };
      pending.add(entry);
      socket.once('close', entry.onGone);
      socket.once('end', entry.onGone);
      socket.on('data', entry.onData);
      void (async () => {
        if (!credential || !(await ctx.credentialTags.verify(token))) {
          if (!settle(entry)) return;
          rejectUpgrade(socket, 401, JSON.stringify({ ok: false, error: { code: 'unauthorized', message: 'An ar_ credential issued by this deployment is required' } }));
          return;
        }
        // The client may have left during the credential check: then no probe.
        if (!entry.settled) await bridge(entry, req, head, url, requestId, credential.workspaceId);
      })().catch((error: unknown) => {
        if (!settle(entry)) return;
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
      closing = true;
      // An upgrade still waiting on its actor is refused now rather than
      // completed into a bridge nobody will close.
      for (const entry of [...pending]) {
        if (!settle(entry)) continue;
        entry.upstream?.terminate();
        rejectUpgrade(entry.socket, 503, shuttingDown);
      }
      for (const client of clients) client.close(code, reason);
      wss.close();
    },
    terminateAll() {
      for (const client of clients) client.terminate();
      // Their close events follow on a later tick; the count is settled now.
      clients.clear();
    },
    get size() {
      return clients.size;
    },
  };
}
