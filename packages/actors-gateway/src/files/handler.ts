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
import { BodyTooLarge, CLOSE_AFTER, readBody, sendError } from '../http.js';
import type { Logger } from '../log.js';
import { errorText } from '../log.js';
import { InvalidStorageKeyError, type FileStore } from './store.js';
import { ActorCallError } from '../actors.js';

// The signed URL is the credential (no cookies), so any origin may use it.
const FILE_CORS_HEADERS: Readonly<Record<string, string>> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, PUT, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-expose-headers': 'content-length, content-type, content-disposition, retry-after',
  'access-control-max-age': '86400',
};

/** `Retry-After` on a PUT whose bytes were stored but not reported to the workspace actor. */
const RECORD_STORED_RETRY_AFTER_SECONDS = 1;

// Content types a browser may run script from when rendered inline: HTML,
// any XML (an XHTML or SVG document can hide under any `+xml` type), script
// types, and PDF (viewers run embedded JavaScript and active forms).
const ACTIVE_CONTENT_TYPE = /^\s*(text\/html|text\/xml|application\/xml|application\/pdf|[a-z]+\/[a-z0-9.+-]*(\+xml|javascript|ecmascript))\b/i;

export interface FileRouteContext {
  store: FileStore;
  /** HMAC secret shared with the actors. */
  secret: string;
  /** `RELAYCAST_MAX_UPLOAD_BYTES`: a signed size past it is refused before any byte is read. */
  maxUploadBytes: number;
  logger: Logger;
  /**
   * Report a stored upload to the actor of the workspace in its key
   * (`fileStored`), so its completion needs no call back to this gateway.
   * The PUT is acknowledged only once the actor has the record: an actor
   * may be unable to reach this gateway, so an upload it was not told about
   * might never complete.
   */
  recordStored: (key: string, size: number) => Promise<unknown>;
}

/** The engine's error envelope with the file route's CORS set. */
function fileError(res: ServerResponse, status: number, code: string, message: string, headers: Readonly<Record<string, string>> = {}): void {
  sendError(res, status, code, message, { ...FILE_CORS_HEADERS, ...headers });
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
      // Refusals before (or while) the body is read close the connection
      // rather than leave an unread upload on it.
      if (payload.size! > ctx.maxUploadBytes) {
        return fileError(res, 413, 'payload_too_large', `Uploads are capped at ${ctx.maxUploadBytes} bytes on this gateway`, CLOSE_AFTER);
      }
      const contentType = header(req, 'content-type');
      if (contentType !== payload.type) {
        return fileError(res, 400, 'content_type_mismatch', 'Content-Type does not match the upload', CLOSE_AFTER);
      }
      const declared = header(req, 'content-length');
      if (declared !== undefined && Number(declared) !== payload.size) {
        return fileError(res, 400, 'size_mismatch', 'Body size does not match the upload', CLOSE_AFTER);
      }
      let bytes: Buffer;
      try {
        bytes = await readBody(req, payload.size!);
      } catch (error) {
        if (error instanceof BodyTooLarge) return fileError(res, 400, 'size_mismatch', 'Body size does not match the upload', CLOSE_AFTER);
        throw error;
      }
      if (bytes.byteLength !== payload.size) {
        return fileError(res, 400, 'size_mismatch', 'Body size does not match the upload');
      }
      await ctx.store.put(payload.key, bytes, { size: payload.size!, contentType: payload.type! });
      // The size reported is the byte count just stored, which equals the
      // signed size (checked above): nothing the client declared.
      // A failed or timed-out report fails the PUT with a retryable 503: the
      // bytes are stored, and retrying the same signed URL overwrites them
      // with the same signed size and reports again (the actor's record is
      // an upsert), so a retry within the URL's lifetime succeeds.
      try {
        await ctx.recordStored(payload.key, bytes.byteLength);
      } catch (error) {
        ctx.logger.warn('files.record_stored_failed', {
          workspace_id: payload.key.split('/')[0],
          code: error instanceof ActorCallError ? error.code : null,
          error: errorText(error),
        });
        return fileError(res, 503, 'workspace_unavailable', 'The upload was stored but the workspace could not be told; retry the PUT', {
          'retry-after': String(RECORD_STORED_RETRY_AFTER_SECONDS),
        });
      }
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
