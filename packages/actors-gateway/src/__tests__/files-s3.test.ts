import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../config.js';
import { createFileStore } from '../files/index.js';
import { S3FileStore, type S3ClientLike } from '../files/s3.js';
import { InvalidStorageKeyError } from '../files/store.js';
import { fakeS3Client } from './fakeObjectStores.js';

const KEY = 'ws/f1/report.html';
const BYTES = Buffer.from('<html>hi</html>');
const BASE = { bucket: 'bkt', region: 'us-east-1', forcePathStyle: false };

async function text(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString();
}

describe('S3FileStore', () => {
  it('names objects by key, under the prefix when there is one', () => {
    expect(new S3FileStore(BASE).objectName(KEY)).toBe(KEY);
    expect(new S3FileStore({ ...BASE, prefix: '' }).objectName(KEY)).toBe(KEY);
    expect(new S3FileStore({ ...BASE, prefix: 'relay/files' }).objectName(KEY)).toBe(`relay/files/${KEY}`);
  });

  it('refuses keys with empty, dot or parent segments, a leading slash or a backslash', async () => {
    const store = new S3FileStore({ ...BASE, client: fakeS3Client().client });
    for (const key of ['', '/ws/f/a', 'ws//a', 'ws/f/a/', '../x', 'ws/../x', 'ws/./x', 'ws\\f\\a', 'ws/f/..']) {
      expect(() => store.objectName(key), key).toThrow(InvalidStorageKeyError);
      await expect(store.get(key), key).rejects.toThrow(InvalidStorageKeyError);
      await expect(store.stat(key), key).rejects.toThrow(InvalidStorageKeyError);
      await expect(store.delete(key), key).rejects.toThrow(InvalidStorageKeyError);
      await expect(store.put(key, BYTES, { size: BYTES.byteLength, contentType: 'text/html' }), key).rejects.toThrow(InvalidStorageKeyError);
    }
  });

  it('round-trips bytes, size and content type with ContentLength under the prefix', async () => {
    const fake = fakeS3Client();
    const store = new S3FileStore({ ...BASE, prefix: 'p', client: fake.client });
    await store.put(KEY, BYTES, { size: BYTES.byteLength, contentType: 'text/html' });
    expect(fake.calls).toEqual([`put bkt/p/${KEY}`]);
    expect(fake.objects.get(`bkt/p/${KEY}`)).toEqual({ bytes: BYTES, contentType: 'text/html' });

    const object = await store.get(KEY);
    expect(object).toMatchObject({ size: BYTES.byteLength, contentType: 'text/html' });
    expect(await text(object!.stream)).toBe(BYTES.toString());
    expect(await store.stat(KEY)).toEqual({ size: BYTES.byteLength });
    expect(fake.calls.slice(1)).toEqual([`get bkt/p/${KEY}`, `head bkt/p/${KEY}`]);

    // A stream body is sent with the signed size as its ContentLength.
    await store.put('ws/f2/a.txt', Readable.from([Buffer.from('he'), Buffer.from('llo')]), { size: 5, contentType: 'text/plain' });
    expect(await store.stat('ws/f2/a.txt')).toEqual({ size: 5 });
    expect((await store.get('ws/f2/a.txt'))?.contentType).toBe('text/plain');
    // ...and S3 refuses one whose bytes do not add up to it.
    await expect(store.put('ws/f3/b.txt', Readable.from([Buffer.from('hello')]), { size: 4, contentType: 'text/plain' })).rejects.toThrow();
    expect(await store.stat('ws/f3/b.txt')).toBeNull();
  });

  it('refuses a buffer whose length differs from the signed size before uploading', async () => {
    const fake = fakeS3Client();
    const store = new S3FileStore({ ...BASE, client: fake.client });
    await expect(store.put(KEY, BYTES, { size: 3, contentType: 'text/html' })).rejects.toThrow(/expected 3/);
    expect(fake.calls).toEqual([]);
  });

  it('falls back to octet-stream for an object without a content type', async () => {
    const fake = fakeS3Client();
    fake.objects.set(`bkt/${KEY}`, { bytes: BYTES, contentType: undefined });
    expect((await new S3FileStore({ ...BASE, client: fake.client }).get(KEY))?.contentType).toBe('application/octet-stream');
  });

  it('answers null for NoSuchKey / NotFound and deletes idempotently', async () => {
    const fake = fakeS3Client();
    const store = new S3FileStore({ ...BASE, client: fake.client });
    expect(await store.get(KEY)).toBeNull();
    expect(await store.stat(KEY)).toBeNull();
    await store.put(KEY, BYTES, { size: BYTES.byteLength, contentType: 'text/html' });
    await store.delete(KEY);
    expect(fake.objects.size).toBe(0);
    await expect(store.delete(KEY)).resolves.toBeUndefined();
    expect(await store.stat(KEY)).toBeNull();
  });

  it('propagates failures other than not-found', async () => {
    const denied = Object.assign(new Error('AccessDenied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
    const store = new S3FileStore({ ...BASE, client: { send: (async () => { throw denied; }) as S3ClientLike['send'] } });
    await expect(store.stat(KEY)).rejects.toThrow('AccessDenied');
    await expect(store.get(KEY)).rejects.toThrow('AccessDenied');
    await expect(store.delete(KEY)).rejects.toThrow('AccessDenied');
  });
});

describe('createFileStore(s3)', () => {
  const build = (env: Record<string, string>) => createFileStore({ kind: 's3', fileDir: '/tmp/x', env }) as S3FileStore;

  it('needs RELAYCAST_S3_BUCKET, and a region unless an endpoint is set', () => {
    expect(() => build({})).toThrow(ConfigError);
    expect(() => build({})).toThrow(/RELAYCAST_S3_BUCKET is required when RELAYCAST_FILE_STORE=s3\./);
    expect(() => build({ RELAYCAST_S3_BUCKET: 'b' })).toThrow(ConfigError);
    expect(() => build({ RELAYCAST_S3_BUCKET: 'b' })).toThrow(/RELAYCAST_S3_REGION is required when RELAYCAST_FILE_STORE=s3 and RELAYCAST_S3_ENDPOINT is unset\./);
    expect(() => build({ RELAYCAST_S3_BUCKET: 'b', RELAYCAST_S3_REGION: 'eu-west-1', RELAYCAST_S3_ENDPOINT: 'ftp://x' })).toThrow(/RELAYCAST_S3_ENDPOINT must be an http\(s\) URL/);
    expect(() => build({ RELAYCAST_S3_BUCKET: 'b', RELAYCAST_S3_REGION: 'eu-west-1', RELAYCAST_S3_FORCE_PATH_STYLE: 'maybe' })).toThrow(/RELAYCAST_S3_FORCE_PATH_STYLE/);
    expect(() => build({ RELAYCAST_S3_BUCKET: 'b', RELAYCAST_S3_REGION: 'eu-west-1', RELAYCAST_S3_PREFIX: 'a/../b' })).toThrow(/RELAYCAST_S3_PREFIX/);
  });

  it('defaults region and path style from the endpoint and normalises the prefix', () => {
    const aws = build({ RELAYCAST_S3_BUCKET: 'bkt', RELAYCAST_S3_REGION: 'eu-west-1' });
    expect(aws).toBeInstanceOf(S3FileStore);
    expect(aws.bucket).toBe('bkt');
    expect(aws.prefix).toBe('');
    expect(aws).toMatchObject({ region: 'eu-west-1', endpoint: undefined, forcePathStyle: false });

    const minio = build({ RELAYCAST_S3_BUCKET: 'bkt', RELAYCAST_S3_ENDPOINT: 'http://minio:9000', RELAYCAST_S3_PREFIX: '/relay/files/' });
    expect(minio.prefix).toBe('relay/files');
    expect(minio.objectName(KEY)).toBe(`relay/files/${KEY}`);
    expect(minio).toMatchObject({ region: 'us-east-1', endpoint: 'http://minio:9000', forcePathStyle: true });

    const virtual = build({ RELAYCAST_S3_BUCKET: 'bkt', RELAYCAST_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com', RELAYCAST_S3_REGION: 'auto', RELAYCAST_S3_FORCE_PATH_STYLE: 'false' });
    expect(virtual).toMatchObject({ region: 'auto', forcePathStyle: false });
    expect(build({ RELAYCAST_S3_BUCKET: 'bkt', RELAYCAST_S3_REGION: 'eu-west-1', RELAYCAST_S3_FORCE_PATH_STYLE: 'true' }).forcePathStyle).toBe(true);
  });
});
