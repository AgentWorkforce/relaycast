import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { z } from 'zod';
import type { FileStorage } from '../../ports/files.js';

const URL_TTL_SECONDS = 3600;
const ROUTE_PREFIX = '/_relayfiles';

const tokenPayloadSchema = z.object({
  key: z.string(),
  op: z.enum(['put', 'get']),
  exp: z.number(),
});

type TokenPayload = z.infer<typeof tokenPayloadSchema>;

/**
 * Local-filesystem file storage replacing Cloudflare R2 for self-host. Blobs are
 * written under `dir`; upload/download URLs are short-lived HMAC-signed links
 * pointing back at the engine-mounted handler ({@link createFileRouteHandler}),
 * so the client PUT/GET flow matches the hosted (presigned-R2) experience.
 */
export class LocalFileStorage implements FileStorage {
  constructor(
    private readonly dir: string,
    private readonly baseUrl: string,
    private readonly secret: string,
  ) {}

  private sign(payload: TokenPayload): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const mac = createHmac('sha256', this.secret).update(body).digest('base64url');
    return `${body}.${mac}`;
  }

  private url(payload: TokenPayload): string {
    const base = this.baseUrl.replace(/\/$/, '');
    return `${base}${ROUTE_PREFIX}?token=${this.sign(payload)}`;
  }

  async createUploadUrl(args: { storageKey: string; contentType: string; sizeBytes: number }): Promise<{ uploadUrl: string; expiresAt: string }> {
    const exp = Math.floor(Date.now() / 1000) + URL_TTL_SECONDS;
    return {
      uploadUrl: this.url({ key: args.storageKey, op: 'put', exp }),
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  async createDownloadUrl(args: { storageKey: string }): Promise<string> {
    const exp = Math.floor(Date.now() / 1000) + URL_TTL_SECONDS;
    return this.url({ key: args.storageKey, op: 'get', exp });
  }

  async deleteObjects(args: { storageKeys: string[] }): Promise<void> {
    for (const storageKey of args.storageKeys) {
      const path = this.resolvePath(storageKey);
      await Promise.all([
        rm(path, { force: true }),
        rm(`${path}.ct`, { force: true }),
      ]);
    }
  }

  /** Resolve a storage key to an absolute path under `dir`, rejecting traversal. */
  private resolvePath(key: string): string {
    const rel = normalize(key).replace(/^(\.\.(\/|\\|$))+/, '');
    const abs = join(this.dir, rel);
    if (!abs.startsWith(this.dir + sep) && abs !== this.dir) {
      throw Object.assign(new Error('invalid storage key'), { code: 'invalid_key', status: 400 });
    }
    return abs;
  }

  verify(token: string | null): TokenPayload | null {
    if (!token) return null;
    const dot = token.lastIndexOf('.');
    if (dot < 0) return null;
    const body = token.slice(0, dot);
    const mac = token.slice(dot + 1);
    const expected = createHmac('sha256', this.secret).update(body).digest('base64url');
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      const parsed = tokenPayloadSchema.safeParse(
        JSON.parse(Buffer.from(body, 'base64url').toString('utf8')),
      );
      if (!parsed.success) return null;
      const payload = parsed.data;
      if (payload.exp * 1000 < Date.now()) return null;
      return payload;
    } catch {
      return null;
    }
  }

  async write(key: string, bytes: Buffer, contentType: string): Promise<void> {
    const path = this.resolvePath(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    await writeFile(`${path}.ct`, contentType || 'application/octet-stream');
  }

  async read(key: string): Promise<{ bytes: Buffer; contentType: string } | null> {
    const path = this.resolvePath(key);
    try {
      const bytes = await readFile(path);
      let contentType = 'application/octet-stream';
      try {
        contentType = (await readFile(`${path}.ct`, 'utf8')).trim() || contentType;
      } catch { /* no sidecar */ }
      return { bytes, contentType };
    } catch {
      return null;
    }
  }
}

/**
 * Build a `fetch`-style handler for `${ROUTE_PREFIX}` PUT/GET. The Node
 * entrypoint mounts it so signed upload/download URLs resolve.
 */
export function createFileRouteHandler(storage: LocalFileStorage) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const payload = storage.verify(url.searchParams.get('token'));
    if (!payload) {
      return Response.json({ ok: false, error: { code: 'forbidden', message: 'Invalid or expired token' } }, { status: 403 });
    }

    try {
      if (request.method === 'PUT' && payload.op === 'put') {
        const bytes = Buffer.from(await request.arrayBuffer());
        await storage.write(payload.key, bytes, request.headers.get('content-type') ?? 'application/octet-stream');
        return Response.json({ ok: true });
      }
      if (request.method === 'GET' && payload.op === 'get') {
        const file = await storage.read(payload.key);
        if (!file) {
          return Response.json({ ok: false, error: { code: 'not_found', message: 'File not found' } }, { status: 404 });
        }
        return new Response(new Uint8Array(file.bytes), { status: 200, headers: { 'content-type': file.contentType } });
      }
    } catch (err) {
      const e = err as { status?: number; message?: string };
      return Response.json({ ok: false, error: { code: 'file_error', message: e.message ?? 'error' } }, { status: e.status ?? 500 });
    }

    return Response.json({ ok: false, error: { code: 'method_not_allowed', message: 'Token/method mismatch' } }, { status: 405 });
  };
}

export const FILE_ROUTE_PREFIX = ROUTE_PREFIX;
