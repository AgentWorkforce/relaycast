/**
 * Node HTTP plumbing shared by the routes: request ids, bounded body reads,
 * the actor request/response shapes, JSON envelopes and CORS.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ActorHttpRequest, ActorHttpResponse } from '@relaycast/engine/gateway';

export const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The CORS policy the engine applies to its own responses (Hono `cors()`):
 * any origin, bearer credentials (no cookies), and `X-Request-Id` exposed.
 */
export const CORS_HEADERS: Readonly<Record<string, string>> = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'X-Request-Id',
};

/** Headers that describe one hop and never travel to an actor or back. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

/** The client's `x-request-id` when it is a safe token, else a fresh UUID. */
export function requestIdFor(req: IncomingMessage): string {
  const presented = req.headers[REQUEST_ID_HEADER];
  const value = Array.isArray(presented) ? presented[0] : presented;
  return value && REQUEST_ID.test(value) ? value : randomUUID();
}

/** The absolute URL the client used, honouring `x-forwarded-proto` from a TLS-terminating proxy. */
export function requestUrl(req: IncomingMessage, fallbackHost: string): URL {
  const forwarded = req.headers['x-forwarded-proto'];
  const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  const scheme = proto === 'https' || proto === 'http' ? proto : (req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http';
  const host = req.headers.host ?? fallbackHost;
  return new URL(req.url ?? '/', `${scheme}://${host}`);
}

/** The request headers as `[name, value]` pairs, without hop-by-hop ones. */
export function requestHeaders(req: IncomingMessage): [string, string][] {
  const pairs: [string, string][] = [];
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    if (Array.isArray(value)) for (const item of value) pairs.push([name, item]);
    else pairs.push([name, value]);
  }
  return pairs;
}

export function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  return header && /^bearer\s+/i.test(header) ? header.replace(/^bearer\s+/i, '').trim() || undefined : undefined;
}

export class BodyTooLarge extends Error {
  constructor(readonly limit: number) {
    super(`request body exceeds ${limit} bytes`);
    this.name = 'BodyTooLarge';
  }
}

/**
 * The whole request body, or a {@link BodyTooLarge} rejection as soon as it
 * runs past `limit` bytes (reading stops there and the connection is dropped).
 */
export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    length += buffer.byteLength;
    if (length > limit) {
      req.destroy();
      throw new BodyTooLarge(limit);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, length);
}

export function toActorRequest(req: IncomingMessage, url: URL, body: Buffer | null, requestId: string): ActorHttpRequest {
  const headers = requestHeaders(req).filter(([name]) => name !== REQUEST_ID_HEADER);
  headers.push([REQUEST_ID_HEADER, requestId]);
  return {
    method: req.method ?? 'GET',
    url: url.toString(),
    headers,
    body: body === null ? null : body.toString('utf8'),
  };
}

export function sendJson(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    ...CORS_HEADERS,
    ...headers,
    'content-type': 'application/json',
    'content-length': String(body.byteLength),
  });
  res.end(res.req.method === 'HEAD' ? undefined : body);
}

export function sendError(res: ServerResponse, status: number, code: string, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { ok: false, error: { code, message } }, headers);
}

export function sendEmpty(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...CORS_HEADERS, ...headers });
  res.end();
}

/** Write an actor's response to the client; the body's byte length replaces any `content-length` the actor set. */
export function sendActorResponse(res: ServerResponse, response: ActorHttpResponse, extraHeaders: Record<string, string> = {}): void {
  const headers: Record<string, string | string[]> = { ...CORS_HEADERS };
  for (const [name, value] of response.headers) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key) || key === 'content-length') continue;
    const existing = headers[key];
    headers[key] = existing === undefined ? value : [...(Array.isArray(existing) ? existing : [existing]), value];
  }
  Object.assign(headers, extraHeaders);
  const empty = response.status === 204 || response.status === 304;
  const body = empty ? null : Buffer.from(response.body);
  if (body) headers['content-length'] = String(body.byteLength);
  res.writeHead(response.status, headers);
  res.end(body && res.req.method !== 'HEAD' ? body : undefined);
}

export function sendPreflight(req: IncomingMessage, res: ServerResponse): void {
  const requested = req.headers['access-control-request-headers'];
  res.writeHead(204, {
    ...CORS_HEADERS,
    'access-control-allow-methods': 'GET,HEAD,PUT,POST,DELETE,PATCH',
    'access-control-allow-headers': (Array.isArray(requested) ? requested.join(',') : requested) ?? '',
    'access-control-max-age': '86400',
    vary: 'Access-Control-Request-Headers',
  });
  res.end();
}
