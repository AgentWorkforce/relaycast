import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ACTOR_FILE_ROUTE, OBJECT_SIZE_HEADER, signFileToken, type FileTokenPayload } from '@relaycast/engine/gateway';
import { LocalFileStore } from '../files/local.js';
import { InvalidStorageKeyError } from '../files/store.js';
import { createFileStore } from '../files/index.js';
import { FILE_SECRET, WORKSPACE_ID, readJson, startHarness, type Harness } from './harness.js';

const KEY = `${WORKSPACE_ID}/f1/report.html`;
const BYTES = Buffer.from('<html><script>alert(1)</script></html>');

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function signed(payload: Omit<FileTokenPayload, 'exp'> & { exp?: number }, secret = FILE_SECRET): Promise<string> {
  const token = await signFileToken(secret, { exp: Math.floor(Date.now() / 1000) + 60, ...payload });
  return `${harness!.baseUrl}${ACTOR_FILE_ROUTE}?token=${token}`;
}

describe('/_relayfiles with the local store', () => {
  it('stores an upload that matches its signed size and type, then serves, stats and deletes it', async () => {
    harness = await startHarness();
    const putUrl = await signed({ key: KEY, op: 'put', size: BYTES.byteLength, type: 'text/html' });
    const put = await fetch(putUrl, { method: 'PUT', headers: { 'content-type': 'text/html' }, body: BYTES });
    expect(put.status).toBe(200);
    expect(await readJson(put)).toEqual({ ok: true });
    expect(put.headers.get('access-control-allow-methods')).toBe('GET, PUT, OPTIONS');
    expect(await readFile(join(harness.fileDir, WORKSPACE_ID, 'f1', 'report.html.type'), 'utf8')).toBe('text/html');

    const get = await fetch(await signed({ key: KEY, op: 'get' }));
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe('text/html');
    expect(get.headers.get('content-length')).toBe(String(BYTES.byteLength));
    expect(get.headers.get('x-content-type-options')).toBe('nosniff');
    expect(get.headers.get('content-security-policy')).toBe('sandbox');
    expect(get.headers.get('access-control-allow-origin')).toBe('*');
    expect(Buffer.from(await get.arrayBuffer()).equals(BYTES)).toBe(true);

    const head = await fetch(await signed({ key: KEY, op: 'stat' }), { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get(OBJECT_SIZE_HEADER)).toBe(String(BYTES.byteLength));

    const del = await fetch(await signed({ key: KEY, op: 'delete' }), { method: 'DELETE' });
    expect(del.status).toBe(204);
    expect((await fetch(await signed({ key: KEY, op: 'stat' }), { method: 'HEAD' })).status).toBe(404);
    const missing = await fetch(await signed({ key: KEY, op: 'get' }));
    expect(missing.status).toBe(404);
    expect((await readJson(missing)).error).toMatchObject({ code: 'not_found' });
    // Already gone is success.
    expect((await fetch(await signed({ key: KEY, op: 'delete' }), { method: 'DELETE' })).status).toBe(204);
    await expect(stat(join(harness.fileDir, WORKSPACE_ID, 'f1', 'report.html.type'))).rejects.toThrow();
  });

  it('serves inactive content without a sandbox and with the stored type', async () => {
    harness = await startHarness();
    const key = `${WORKSPACE_ID}/f2/notes.txt`;
    await fetch(await signed({ key, op: 'put', size: 5, type: 'text/plain' }), { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'hello' });
    const get = await fetch(await signed({ key, op: 'get' }));
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe('text/plain');
    expect(get.headers.get('content-security-policy')).toBeNull();
    expect(await get.text()).toBe('hello');
  });

  it('refuses uploads whose type or size differ from the token', async () => {
    harness = await startHarness();
    const putUrl = await signed({ key: KEY, op: 'put', size: BYTES.byteLength, type: 'text/html' });
    const wrongType = await fetch(putUrl, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: BYTES });
    expect(wrongType.status).toBe(400);
    expect((await readJson(wrongType)).error).toMatchObject({ code: 'content_type_mismatch' });

    const declaredWrong = await fetch(putUrl, { method: 'PUT', headers: { 'content-type': 'text/html', 'content-length': '3' }, body: 'abc' });
    expect(declaredWrong.status).toBe(400);
    expect((await readJson(declaredWrong)).error).toMatchObject({ code: 'size_mismatch' });

    const tooShort = await fetch(putUrl, { method: 'PUT', headers: { 'content-type': 'text/html' }, body: BYTES.subarray(0, 5) });
    expect(tooShort.status).toBe(400);
    expect((await readJson(tooShort)).error).toMatchObject({ code: 'size_mismatch' });

    // A chunked body that runs past the signed size is cut off and refused.
    const tooLong = await fetch(putUrl, {
      method: 'PUT',
      headers: { 'content-type': 'text/html' },
      body: new ReadableStream({ start(controller) { controller.enqueue(BYTES); controller.enqueue(Buffer.from('extra')); controller.close(); } }),
      duplex: 'half',
    } as RequestInit).catch(() => undefined);
    if (tooLong) {
      expect(tooLong.status).toBe(400);
      expect((await readJson(tooLong)).error).toMatchObject({ code: 'size_mismatch' });
    }
    expect((await fetch(await signed({ key: KEY, op: 'stat' }), { method: 'HEAD' })).status).toBe(404);
  });

  it('refuses bad, expired or foreign tokens and token/method mismatches', async () => {
    harness = await startHarness();
    const forged = await fetch(`${harness.baseUrl}${ACTOR_FILE_ROUTE}?token=abc.def`);
    expect(forged.status).toBe(403);
    expect((await readJson(forged)).error).toMatchObject({ code: 'forbidden' });
    expect((await fetch(`${harness.baseUrl}${ACTOR_FILE_ROUTE}`)).status).toBe(403);
    expect((await fetch(await signed({ key: KEY, op: 'get', exp: Math.floor(Date.now() / 1000) - 1 }))).status).toBe(403);
    expect((await fetch(await signed({ key: KEY, op: 'get' }, 'other-secret'))).status).toBe(403);

    const mismatch = await fetch(await signed({ key: KEY, op: 'get' }), { method: 'DELETE' });
    expect(mismatch.status).toBe(405);
    expect((await readJson(mismatch)).error).toMatchObject({ code: 'method_not_allowed' });
    expect((await fetch(await signed({ key: KEY, op: 'put', size: 1, type: 'text/plain' }), { method: 'GET' })).status).toBe(405);

    const preflight = await fetch(`${harness.baseUrl}${ACTOR_FILE_ROUTE}?token=whatever`, { method: 'OPTIONS' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toBe('content-type');
  });

  it('answers 500 delete_failed when the store cannot delete', async () => {
    harness = await startHarness({
      gateway: {
        fileStore: {
          put: async () => {},
          get: async () => null,
          stat: async () => null,
          delete: async () => { throw new Error('disk on fire'); },
        },
      },
    });
    const del = await fetch(await signed({ key: KEY, op: 'delete' }), { method: 'DELETE' });
    expect(del.status).toBe(500);
    expect((await readJson(del)).error).toMatchObject({ code: 'delete_failed' });
  });
});

describe('LocalFileStore', () => {
  let root: string;
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('keeps every key under its root', async () => {
    root = await mkdtemp(join(tmpdir(), 'relaycast-local-store-'));
    const store = new LocalFileStore(root);
    expect(store.path('ws/file/name.txt')).toBe(join(root, 'ws', 'file', 'name.txt'));
    for (const key of ['../escape', 'ws/../../escape', 'ws/file/../../..', 'ws/../..']) {
      expect(() => store.path(key)).toThrow(InvalidStorageKeyError);
      await expect(store.get(key)).rejects.toThrow(InvalidStorageKeyError);
      await expect(store.delete(key)).rejects.toThrow(InvalidStorageKeyError);
    }
  });

  it('serves the stored content type and falls back to octet-stream without a sidecar', async () => {
    root = await mkdtemp(join(tmpdir(), 'relaycast-local-store-'));
    const store = new LocalFileStore(root);
    await store.put('ws/f/a.bin', new Uint8Array([1, 2, 3]), { size: 3, contentType: 'application/x-thing' });
    expect((await store.get('ws/f/a.bin'))?.contentType).toBe('application/x-thing');
    await rm(join(root, 'ws', 'f', 'a.bin.type'));
    expect((await store.get('ws/f/a.bin'))?.contentType).toBe('application/octet-stream');
    expect(await store.stat('ws/f/a.bin')).toEqual({ size: 3 });
    await expect(store.put('ws/f/b.bin', new Uint8Array([1]), { size: 2, contentType: 'text/plain' })).rejects.toThrow(/expected 2/);
    expect(await store.stat('ws/f/b.bin')).toBeNull();
  });

  it('is the only store the factory builds for now', () => {
    expect(createFileStore({ kind: 'local', fileDir: '/tmp/x' })).toBeInstanceOf(LocalFileStore);
    expect(() => createFileStore({ kind: 'gcs', fileDir: '/tmp/x' })).toThrow(/not implemented yet/);
    expect(() => createFileStore({ kind: 's3', fileDir: '/tmp/x' })).toThrow(/not implemented yet/);
  });
});
