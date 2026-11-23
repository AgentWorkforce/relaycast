/**
 * S3 file storage against a real S3 API. Skipped unless
 * RELAYCAST_S3_TEST_ENDPOINT, RELAYCAST_S3_TEST_REGION and
 * RELAYCAST_S3_TEST_BUCKET are set (any S3-compatible server, e.g. MinIO or
 * adobe/s3mock with the bucket pre-created; credentials from the AWS SDK's
 * default chain, e.g. AWS_ACCESS_KEY_ID in the test process).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { DiskBlobStore, SignedRouteFileStorage, createFileRouteHandler } from '../files.js';
import { S3BlobStore, sha256Base64 } from '../s3Blobs.js';
import { migrateLocalFilesToS3, type FileRow } from '../fileMigration.js';
import { runMigrateFilesToS3Command } from '../../../entrypoints/node.js';

const ENDPOINT = process.env.RELAYCAST_S3_TEST_ENDPOINT;
const REGION = process.env.RELAYCAST_S3_TEST_REGION;
const BUCKET = process.env.RELAYCAST_S3_TEST_BUCKET;
const enabled = Boolean(ENDPOINT && REGION && BUCKET);

const dirs: string[] = [];
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'relaycast-s3-test-'));
  dirs.push(dir);
  return dir;
}

describe.skipIf(!enabled)('S3 file storage (integration)', { timeout: 60_000 }, () => {
  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  /** A store under a fresh prefix so runs never see each other's objects. */
  const store = () => new S3BlobStore({ bucket: BUCKET!, region: REGION!, endpoint: ENDPOINT, forcePathStyle: true, prefix: `test/${randomUUID()}` });

  it('stores, reads, stats with checksum, and deletes objects idempotently', async () => {
    const s3 = store();
    const bytes = Buffer.from('hello relaycast');
    expect(await s3.stat('ws1/f1/a.txt')).toBeNull();
    expect(await s3.read('ws1/f1/a.txt')).toBeNull();
    await s3.write('ws1/f1/a.txt', bytes, 'text/plain');
    expect(await s3.statWithChecksum('ws1/f1/a.txt')).toEqual({ sizeBytes: bytes.byteLength, sha256: sha256Base64(bytes) });
    expect(await s3.read('ws1/f1/a.txt')).toEqual({ bytes, contentType: 'text/plain' });
    await s3.delete(['ws1/f1/a.txt', 'ws1/f1/never-existed.txt']);
    await s3.delete(['ws1/f1/a.txt']);
    expect(await s3.stat('ws1/f1/a.txt')).toBeNull();
    await expect(s3.write('ws1/../escape', bytes, 'text/plain')).rejects.toThrow('invalid storage key');
  });

  it('reports a missing bucket as an error, not as an absent object', async () => {
    const missing = new S3BlobStore({ bucket: `relaycast-missing-${randomUUID().slice(0, 8)}`, region: REGION!, endpoint: ENDPOINT, forcePathStyle: true });
    await expect(missing.stat('ws1/f1/a.txt')).rejects.toThrow(/not reachable/);
  });

  it('serves the signed upload / complete / download flow from the bucket', async () => {
    const storage = new SignedRouteFileStorage(store(), 'http://relay.test', 'test-secret');
    const handler = createFileRouteHandler(storage);
    const body = Buffer.from('{"attachment":true}');
    const { uploadUrl } = await storage.createUploadUrl({ storageKey: 'ws1/f2/data.json', contentType: 'application/json', sizeBytes: body.byteLength });

    const wrongSize = await handler(new Request(uploadUrl, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: Buffer.from('short') }));
    expect(wrongSize.status).toBe(400);
    expect(await storage.statObject({ storageKey: 'ws1/f2/data.json' })).toBeNull();

    const put = await handler(new Request(uploadUrl, { method: 'PUT', headers: { 'content-type': 'application/json' }, body }));
    expect(put.status).toBe(200);
    expect(await storage.statObject({ storageKey: 'ws1/f2/data.json' })).toEqual({ sizeBytes: body.byteLength });

    const get = await handler(new Request(await storage.createDownloadUrl({ storageKey: 'ws1/f2/data.json' })));
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe('application/json');
    expect(Buffer.from(await get.arrayBuffer())).toEqual(body);

    await storage.deleteObjects({ storageKeys: ['ws1/f2/data.json'] });
    const gone = await handler(new Request(await storage.createDownloadUrl({ storageKey: 'ws1/f2/data.json' })));
    expect(gone.status).toBe(404);
  });

  it('migrates every live file row once, verified, and never overwrites a different object', async () => {
    const dir = await scratch();
    const disk = new DiskBlobStore(dir);
    // Real uploads whose stored names end in .ct / .tmp are files like any other.
    const files: FileRow[] = [
      { storageKey: 'ws1/f1/f1.png', status: 'complete', sizeBytes: 9 },
      { storageKey: 'ws1/f2/f2.ct', status: 'complete', sizeBytes: 10 },
      { storageKey: 'ws1/f3/f3.tmp', status: 'complete', sizeBytes: 7 },
    ];
    await disk.write('ws1/f1/f1.png', Buffer.from('png-bytes'), 'image/png');
    await disk.write('ws1/f2/f2.ct', Buffer.from('ct upload!'), 'text/plain');
    await disk.write('ws1/f3/f3.tmp', Buffer.from('tmpfile'), 'application/octet-stream');
    // DiskBlobStore's own crashed-write temporary is not a file.
    await writeFile(join(dir, 'ws1', 'f1', `f1.png.${randomUUID()}.tmp`), 'partial');
    const s3 = store();

    const first = await migrateLocalFilesToS3({ dir, store: s3, rows: files });
    expect(first).toMatchObject({ copied: 3, alreadyPresent: 0, unreferenced: [], mismatched: [], failed: [] });
    expect(await s3.read('ws1/f2/f2.ct')).toEqual({ bytes: Buffer.from('ct upload!'), contentType: 'text/plain' });
    expect(await s3.read('ws1/f3/f3.tmp')).toEqual({ bytes: Buffer.from('tmpfile'), contentType: 'application/octet-stream' });

    const again = await migrateLocalFilesToS3({ dir, store: s3, rows: files });
    expect(again).toMatchObject({ copied: 0, alreadyPresent: 3, mismatched: [], failed: [] });

    // The bucket object changed (a newer upload): reported, left untouched.
    await s3.write('ws1/f2/f2.ct', Buffer.from('a newer upload'), 'text/plain');
    const mismatch = await migrateLocalFilesToS3({ dir, store: s3, rows: files });
    expect(mismatch.mismatched).toEqual(['ws1/f2/f2.ct']);
    expect((await s3.read('ws1/f2/f2.ct'))?.bytes).toEqual(Buffer.from('a newer upload'));
    // Local files are never deleted.
    expect(await disk.read('ws1/f1/f1.png')).not.toBeNull();
  });

  it('follows the database: deleted files are not resurrected, lost files fail, unfinished uploads are fine', async () => {
    const dir = await scratch();
    const disk = new DiskBlobStore(dir);
    await disk.write('ws2/d1/d1.txt', Buffer.from('deleted later'), 'text/plain');
    await disk.write('ws2/o1/o1.txt', Buffer.from('no row at all'), 'text/plain');
    await disk.write('ws2/p1/p1.txt', Buffer.from('pending'), 'text/plain');
    const s3 = store();
    const summary = await migrateLocalFilesToS3({
      dir,
      store: s3,
      rows: [
        { storageKey: 'ws2/d1/d1.txt', status: 'deleted', sizeBytes: 13 },
        { storageKey: 'ws2/p1/p1.txt', status: 'pending', sizeBytes: 7 },
        { storageKey: 'ws2/p2/p2.txt', status: 'pending', sizeBytes: 5 },
        { storageKey: 'ws2/c1/c1.txt', status: 'complete', sizeBytes: 4 },
      ],
    });
    expect(await s3.stat('ws2/d1/d1.txt')).toBeNull();
    expect(await s3.stat('ws2/o1/o1.txt')).toBeNull();
    expect(summary.unreferenced).toEqual(['ws2/d1/d1.txt', 'ws2/o1/o1.txt']);
    expect(summary.copied).toBe(1);
    expect(summary.pendingWithoutBytes).toBe(1);
    expect(summary.failed).toEqual([{ key: 'ws2/c1/c1.txt', error: 'complete file is neither on disk nor in the bucket' }]);
  });

  it('runs as a command: 0 when everything is verified, 1 on a mismatch or unreachable bucket, 64 on bad config', async () => {
    const dir = await scratch();
    await new DiskBlobStore(dir).write('ws3/f1/f1.bin', Buffer.from([1, 2, 3]), 'application/octet-stream');
    const prefix = `test/${randomUUID()}`;
    const env = {
      RELAYCAST_FILE_STORE: 's3',
      RELAYCAST_FILE_S3_BUCKET: BUCKET,
      RELAYCAST_FILE_S3_REGION: REGION,
      RELAYCAST_FILE_S3_PREFIX: prefix,
      RELAYCAST_FILE_S3_ENDPOINT: ENDPOINT,
      RELAYCAST_FILE_S3_FORCE_PATH_STYLE: 'true',
    };
    const lines: string[] = [];
    const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
    const loadFileRows = async () => [{ storageKey: 'ws3/f1/f1.bin', status: 'complete', sizeBytes: 3 }];
    expect(await runMigrateFilesToS3Command(['--from', dir], env, io, { loadFileRows })).toBe(0);
    expect(await runMigrateFilesToS3Command(['--from', dir], env, io, { loadFileRows })).toBe(0);
    await new S3BlobStore({ bucket: BUCKET!, region: REGION!, endpoint: ENDPOINT, forcePathStyle: true, prefix }).write('ws3/f1/f1.bin', Buffer.from([9]), 'application/octet-stream');
    expect(await runMigrateFilesToS3Command(['--from', dir], env, io, { loadFileRows })).toBe(1);
    expect(lines.some((line) => line.includes('MISMATCH') && line.includes('ws3/f1/f1.bin'))).toBe(true);
    expect(await runMigrateFilesToS3Command(['--from', dir], { ...env, RELAYCAST_FILE_S3_BUCKET: `relaycast-missing-${randomUUID().slice(0, 8)}` }, io, { loadFileRows })).toBe(1);
    expect(lines.some((line) => /not reachable/.test(line))).toBe(true);
    expect(await runMigrateFilesToS3Command(['--from', dir], { RELAYCAST_FILE_STORE: 'local' }, io, { loadFileRows })).toBe(64);
    expect(await runMigrateFilesToS3Command(['--bogus'], env, io, { loadFileRows })).toBe(64);
  });

  it('verifyAccess passes for a reachable bucket and fails for a missing one', async () => {
    await expect(store().verifyAccess()).resolves.toBeUndefined();
    const missing = new S3BlobStore({ bucket: `relaycast-missing-${randomUUID().slice(0, 8)}`, region: REGION!, endpoint: ENDPOINT, forcePathStyle: true });
    await expect(missing.verifyAccess()).rejects.toThrow(/not reachable/);
  });
});

describe('S3BlobStore bounds and warnings', () => {
  it('fails the startup bucket check within its bound against an endpoint that never answers', async () => {
    const net = await import('node:net');
    const held: import('node:net').Socket[] = [];
    const server = net.createServer((socket) => { held.push(socket); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as import('node:net').AddressInfo).port;
    try {
      const store = new S3BlobStore({ bucket: 'some-bucket', region: 'us-east-1', endpoint: `http://127.0.0.1:${port}`, forcePathStyle: true, startupCheckTimeoutMs: 1_500 });
      const started = Date.now();
      await expect(store.verifyAccess()).rejects.toThrow(/not reachable/);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      for (const socket of held) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('warns once when reads cannot be checksum-verified', async () => {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const client = {
      send: async (command: unknown) => {
        if (command instanceof GetObjectCommand) {
          return { ContentType: 'text/plain', Body: { transformToByteArray: async () => new TextEncoder().encode('hi') } };
        }
        throw new Error('unexpected command');
      },
    };
    const store = new S3BlobStore({ bucket: 'some-bucket', region: 'us-east-1', client: client as never });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await store.read('ws/f/f.txt'))?.bytes.toString()).toBe('hi');
      await store.read('ws/f/f.txt');
      expect(warn.mock.calls.filter(([line]) => String(line).includes('not checksum-verified'))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});
