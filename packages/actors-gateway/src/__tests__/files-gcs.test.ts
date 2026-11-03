import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../config.js';
import { GcsFileStore, type GcsStorageLike } from '../files/gcs.js';
import { createFileStore } from '../files/index.js';
import { InvalidStorageKeyError } from '../files/store.js';
import { fakeGcsStorage } from './fakeObjectStores.js';

const KEY = 'ws/f1/report.html';
const BYTES = Buffer.from('<html>hi</html>');

async function text(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString();
}

describe('GcsFileStore', () => {
  it('names objects by key, under the prefix when there is one', () => {
    expect(new GcsFileStore({ bucket: 'b' }).objectName(KEY)).toBe(KEY);
    expect(new GcsFileStore({ bucket: 'b', prefix: '' }).objectName(KEY)).toBe(KEY);
    expect(new GcsFileStore({ bucket: 'b', prefix: 'relay/files' }).objectName(KEY)).toBe(`relay/files/${KEY}`);
  });

  it('refuses keys with empty, dot or parent segments, a leading slash or a backslash', async () => {
    const store = new GcsFileStore({ bucket: 'b', storage: fakeGcsStorage().storage });
    for (const key of ['', '/ws/f/a', 'ws//a', 'ws/f/a/', '../x', 'ws/../x', 'ws/./x', 'ws\\f\\a', 'ws/f/..']) {
      expect(() => store.objectName(key), key).toThrow(InvalidStorageKeyError);
      await expect(store.get(key), key).rejects.toThrow(InvalidStorageKeyError);
      await expect(store.stat(key), key).rejects.toThrow(InvalidStorageKeyError);
      await expect(store.delete(key), key).rejects.toThrow(InvalidStorageKeyError);
      await expect(store.put(key, BYTES, { size: BYTES.byteLength, contentType: 'text/html' }), key).rejects.toThrow(InvalidStorageKeyError);
    }
  });

  it('round-trips bytes, size and content type through simple uploads under the prefix', async () => {
    const fake = fakeGcsStorage();
    const store = new GcsFileStore({ bucket: 'bkt', prefix: 'p', storage: fake.storage });
    await store.put(KEY, BYTES, { size: BYTES.byteLength, contentType: 'text/html' });
    expect(fake.calls).toEqual([`save bkt/p/${KEY}`]);
    expect(fake.objects.get(`bkt/p/${KEY}`)).toEqual({ bytes: BYTES, contentType: 'text/html' });

    const object = await store.get(KEY);
    expect(object).toMatchObject({ size: BYTES.byteLength, contentType: 'text/html' });
    expect(await text(object!.stream)).toBe(BYTES.toString());
    expect(await store.stat(KEY)).toEqual({ size: BYTES.byteLength });

    // A stream body goes through a (simple) write stream.
    await store.put('ws/f2/a.txt', Readable.from([Buffer.from('he'), Buffer.from('llo')]), { size: 5, contentType: 'text/plain' });
    expect(fake.calls.at(-1)).toBe('write bkt/p/ws/f2/a.txt');
    expect(await store.stat('ws/f2/a.txt')).toEqual({ size: 5 });
    expect((await store.get('ws/f2/a.txt'))?.contentType).toBe('text/plain');
  });

  it('refuses a buffer whose length differs from the signed size before uploading', async () => {
    const fake = fakeGcsStorage();
    const store = new GcsFileStore({ bucket: 'b', storage: fake.storage });
    await expect(store.put(KEY, BYTES, { size: 3, contentType: 'text/html' })).rejects.toThrow(/expected 3/);
    expect(fake.calls).toEqual([]);
  });

  it('falls back to octet-stream for an object without a content type', async () => {
    const fake = fakeGcsStorage();
    fake.objects.set(`b/${KEY}`, { bytes: BYTES, contentType: undefined });
    expect((await new GcsFileStore({ bucket: 'b', storage: fake.storage }).get(KEY))?.contentType).toBe('application/octet-stream');
  });

  it('answers null for a missing object and deletes idempotently', async () => {
    const fake = fakeGcsStorage();
    const store = new GcsFileStore({ bucket: 'b', storage: fake.storage });
    expect(await store.get(KEY)).toBeNull();
    expect(await store.stat(KEY)).toBeNull();
    await store.put(KEY, BYTES, { size: BYTES.byteLength, contentType: 'text/html' });
    await store.delete(KEY);
    expect(fake.objects.size).toBe(0);
    await expect(store.delete(KEY)).resolves.toBeUndefined();
    expect(await store.stat(KEY)).toBeNull();
  });

  it('propagates failures other than 404', async () => {
    const fake = fakeGcsStorage();
    const forbidden = async () => { throw Object.assign(new Error('forbidden'), { code: 403 }); };
    const storage: GcsStorageLike = { bucket: (b) => ({ file: (n) => ({ ...fake.storage.bucket(b).file(n), getMetadata: forbidden }) }) };
    const store = new GcsFileStore({ bucket: 'b', storage });
    await expect(store.stat(KEY)).rejects.toThrow('forbidden');
    await expect(store.get(KEY)).rejects.toThrow('forbidden');
  });
  it('reports a missing bucket as a failure, not a missing file', async () => {
    const storage = {
      bucket: () => ({
        file: () => ({
          async getMetadata(): Promise<never> { throw Object.assign(new Error('The specified bucket does not exist.'), { code: 404 }); },
        } as never),
      }),
    };
    const store = new GcsFileStore({ bucket: 'gone', storage });
    await expect(store.get('ws/f/a')).rejects.toThrow(/bucket does not exist/);
    await expect(store.stat('ws/f/a')).rejects.toThrow(/bucket does not exist/);
  });

  it('refuses a stream whose length differs from the signed size', async () => {
    const fake = fakeGcsStorage();
    const store = new GcsFileStore({ bucket: 'bkt', storage: fake.storage });
    await expect(store.put('ws/f/short', Readable.from([Buffer.from('ab')]), { size: 3, contentType: 'text/plain' })).rejects.toThrow('body is 2 bytes, expected 3');
    await expect(store.put('ws/f/long', Readable.from([Buffer.from('ab'), Buffer.from('cd')]), { size: 3, contentType: 'text/plain' })).rejects.toThrow('body exceeds 3 bytes');
    expect(fake.objects.has('bkt/ws/f/short')).toBe(false);
    expect(fake.objects.has('bkt/ws/f/long')).toBe(false);
    await store.put('ws/f/exact', Readable.from([Buffer.from('abc')]), { size: 3, contentType: 'text/plain' });
    expect(fake.objects.get('bkt/ws/f/exact')?.bytes.toString()).toBe('abc');
  });
});

describe('createFileStore(gcs)', () => {
  it('needs RELAYCAST_GCS_BUCKET and normalises the prefix', () => {
    expect(() => createFileStore({ kind: 'gcs', fileDir: '/tmp/x', env: {} })).toThrow(ConfigError);
    expect(() => createFileStore({ kind: 'gcs', fileDir: '/tmp/x', env: {} })).toThrow(/RELAYCAST_GCS_BUCKET is required when RELAYCAST_FILE_STORE=gcs\./);
    expect(() => createFileStore({ kind: 'gcs', fileDir: '/tmp/x', env: { RELAYCAST_GCS_BUCKET: '  ' } })).toThrow(/RELAYCAST_GCS_BUCKET/);
    expect(() => createFileStore({ kind: 'gcs', fileDir: '/tmp/x', env: { RELAYCAST_GCS_BUCKET: 'b', RELAYCAST_GCS_PREFIX: 'a//b' } })).toThrow(/RELAYCAST_GCS_PREFIX/);
    expect(() => createFileStore({ kind: 'gcs', fileDir: '/tmp/x', env: { RELAYCAST_GCS_BUCKET: 'b', RELAYCAST_GCS_PREFIX: '../b' } })).toThrow(/RELAYCAST_GCS_PREFIX/);

    const bare = createFileStore({ kind: 'gcs', fileDir: '/tmp/x', env: { RELAYCAST_GCS_BUCKET: 'bkt' } }) as GcsFileStore;
    expect(bare).toBeInstanceOf(GcsFileStore);
    // A slash-only prefix is the documented "no prefix".
    expect((createFileStore({ kind: 'gcs', fileDir: '/tmp/x', env: { RELAYCAST_GCS_BUCKET: 'bkt', RELAYCAST_GCS_PREFIX: '/' } }) as GcsFileStore).prefix).toBe('');
    expect(bare.bucket).toBe('bkt');
    expect(bare.prefix).toBe('');
    const prefixed = createFileStore({ kind: 'gcs', fileDir: '/tmp/x', env: { RELAYCAST_GCS_BUCKET: 'bkt', RELAYCAST_GCS_PREFIX: '/relay/files/' } }) as GcsFileStore;
    expect(prefixed.prefix).toBe('relay/files');
    expect(prefixed.objectName(KEY)).toBe(`relay/files/${KEY}`);
  });
});
