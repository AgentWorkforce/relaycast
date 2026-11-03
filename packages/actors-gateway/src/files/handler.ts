/**
 * `/_relayfiles?token=…`: move file bytes between clients and the file
 * store, and report stored sizes and delete objects for workspace actors.
 * Actors sign the URLs (`SignedUrlFileStorage` in the engine); bytes never
 * pass through an actor. Browsers on any origin may use a signed URL (CORS),
 * and downloads of active content are sandboxed so an uploaded document
 * cannot run script on this origin. Store-agnostic: see {@link FileStore}.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { OBJECT_SIZE_HEADER, verifyFileToken } from '@relaycast/engine/gateway';
import { BodyTooLarge, readBody } from '../http.js';
import type { Logger } from '../log.js';
import { errorText } from '../log.js';
import { InvalidStorageKeyError, type FileStore } from './store.js';

// The signed URL is the credential (no cookies), so any origin may use it.
const FILE_CORS_HEADERS: Readonly<Record<string, string>> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, PUT, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-expose-headers': 'content-length, content-type, content-disposition',
  'access-control-max-age': '86400',
};

// Content types a browser may execute script in when rendered inline.
const ACTIVE_CONTENT_TYPE = /^\s*(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|[a-z]+\/[a-z0-9.+-]*(javascript|ecmascript))\b/i;

export interface FileRouteContext {
  store: FileStore;
  /** HMAC secret shared with the actors. */
  secret: string;
  logger: Logger;
}

function fileError(res: ServerResponse, status: number, code: string, message: string): void {
  const body = Buffer.from(JSON.stringify({ ok: false, error: { code, message } }));
  res.writeHead(status, { ...FILE_CORS_HEADERS, 'content-type': 'application/json', 'content-length': String(body.byteLength) });
  res.end(body);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export async function serveFile(req: IncomingMessage, res: ServerResponse, url: URL, ctx: FileRouteContext): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, FILE_CORS_HEADERS);
    res.end();
    return;
  }
  const payload = await verifyFileToken(ctx.secret, url.searchParams.get('token'));
  if (!payload) return fileError(res, 403, 'forbidden', 'Invalid or expired token');

  try {
    if (req.method === 'PUT' && payload.op === 'put') {
      // The token binds the size and content type the engine registered: refuse
      // a wrong declared length before reading, and stop reading a body as soon
      // as it runs past the signed size.
      const contentType = header(req, 'content-type');
      if (contentType !== payload.type) {
        return fileError(res, 400, 'content_type_mismatch', 'Content-Type does not match the upload');
      }
      const declared = header(req, 'content-length');
      if (declared !== undefined && Number(declared) !== payload.size) {
        return fileError(res, 400, 'size_mismatch', 'Body size does not match the upload');
      }
      let bytes: Buffer;
      try {
        bytes = await readBody(req, payload.size!);
      } catch (error) {
        if (error instanceof BodyTooLarge) return fileError(res, 400, 'size_mismatch', 'Body size does not match the upload');
        throw error;
      }
      if (bytes.byteLength !== payload.size) {
        return fileError(res, 400, 'size_mismatch', 'Body size does not match the upload');
      }
      await ctx.store.put(payload.key, bytes, { size: payload.size!, contentType: payload.type! });
      const body = Buffer.from(JSON.stringify({ ok: true }));
      res.writeHead(200, { ...FILE_CORS_HEADERS, 'content-type': 'application/json', 'content-length': String(body.byteLength) });
      res.end(body);
      return;
    }
    if (req.method === 'GET' && payload.op === 'get') {
      const object = await ctx.store.get(payload.key);
      if (!object) return fileError(res, 404, 'not_found', 'File not found');
      const headers: Record<string, string> = {
        ...FILE_CORS_HEADERS,
        'content-type': object.contentType,
        'content-length': String(object.size),
        // The stored type is the signed one; never let a browser sniff another,
        // and sandbox any document type that can run script (opaque origin,
        // scripts disabled).
        'x-content-type-options': 'nosniff',
      };
      if (ACTIVE_CONTENT_TYPE.test(object.contentType)) headers['content-security-policy'] = 'sandbox';
      res.writeHead(200, headers);
      try {
        await pipeline(object.stream, res);
      } catch (error) {
        // The client went away or the read failed mid-stream; nothing more to send.
        ctx.logger.warn('files.stream_failed', { error: errorText(error) });
        res.destroy();
      }
      return;
    }
    if (req.method === 'HEAD' && payload.op === 'stat') {
      const object = await ctx.store.stat(payload.key);
      if (!object) {
        res.writeHead(404, FILE_CORS_HEADERS);
        res.end();
        return;
      }
      res.writeHead(200, { ...FILE_CORS_HEADERS, [OBJECT_SIZE_HEADER]: String(object.size) });
      res.end();
      return;
    }
    if (req.method === 'DELETE' && payload.op === 'delete') {
      // Already gone is success. Any failure answers non-2xx so the engine's
      // cleanup queue retries it.
      try {
        await ctx.store.delete(payload.key);
      } catch (error) {
        ctx.logger.error('files.delete_failed', { error: errorText(error) });
        return fileError(res, 500, 'delete_failed', 'Could not delete the file');
      }
      res.writeHead(204, FILE_CORS_HEADERS);
      res.end();
      return;
    }
    return fileError(res, 405, 'method_not_allowed', 'Token/method mismatch');
  } catch (error) {
    // verifyFileToken already refuses keys outside `<workspace>/<file>/<name>`;
    // the store's own containment check is the second fence.
    if (error instanceof InvalidStorageKeyError) return fileError(res, 403, 'forbidden', 'Invalid storage key');
    ctx.logger.error('files.failed', { op: payload.op, error: errorText(error) });
    if (!res.headersSent) return fileError(res, 500, 'storage_failed', 'The file store failed');
    res.destroy();
  }
}
