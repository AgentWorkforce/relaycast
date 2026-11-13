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
import { afterAll, describe, expect, it } from 'vitest';
import { DiskBlobStore, SignedRouteFileStorage, createFileRouteHandler } from '../files.js';
import { S3BlobStore, sha256Base64 } from '../s3Blobs.js';
import { migrateLocalFilesToS3 } from '../fileMigration.js';
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

  it('migrates local files once, verifies them, skips them on re-run, and never overwrites a different object', async () => {
    const dir = await scratch();
    const disk = new DiskBlobStore(dir);
    await disk.write('ws1/f1/a.png', Buffer.from('png-bytes'), 'image/png');
    await disk.write('ws2/f9/notes.txt', Buffer.from('some notes'), 'text/plain');
    // A crashed write's temporary is not an object.
    await writeFile(join(dir, 'ws1', 'f1', 'a.png.1234.tmp'), 'partial');
    const s3 = store();

    const first = await migrateLocalFilesToS3({ dir, store: s3 });
    expect(first).toEqual({ copied: 2, alreadyPresent: 0, mismatched: [], failed: [] });
    expect(await s3.read('ws1/f1/a.png')).toEqual({ bytes: Buffer.from('png-bytes'), contentType: 'image/png' });
    expect(await s3.read('ws2/f9/notes.txt')).toEqual({ bytes: Buffer.from('some notes'), contentType: 'text/plain' });

    const again = await migrateLocalFilesToS3({ dir, store: s3 });
    expect(again).toEqual({ copied: 0, alreadyPresent: 2, mismatched: [], failed: [] });

    // The bucket object changed (a newer upload): reported, left untouched.
    await s3.write('ws2/f9/notes.txt', Buffer.from('a newer upload'), 'text/plain');
    const mismatch = await migrateLocalFilesToS3({ dir, store: s3 });
    expect(mismatch.mismatched).toEqual(['ws2/f9/notes.txt']);
    expect((await s3.read('ws2/f9/notes.txt'))?.bytes).toEqual(Buffer.from('a newer upload'));
    // Local files are never deleted.
    expect(await disk.read('ws1/f1/a.png')).not.toBeNull();
  });

  it('runs as a command: 0 when everything is verified, 1 on a mismatch, 64 without an s3 config', async () => {
    const dir = await scratch();
    await new DiskBlobStore(dir).write('ws3/f1/x.bin', Buffer.from([1, 2, 3]), 'application/octet-stream');
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
    expect(await runMigrateFilesToS3Command(['--from', dir], env, io)).toBe(0);
    expect(await runMigrateFilesToS3Command(['--from', dir], env, io)).toBe(0);
    await new S3BlobStore({ bucket: BUCKET!, region: REGION!, endpoint: ENDPOINT, forcePathStyle: true, prefix }).write('ws3/f1/x.bin', Buffer.from([9]), 'application/octet-stream');
    expect(await runMigrateFilesToS3Command(['--from', dir], env, io)).toBe(1);
    expect(await runMigrateFilesToS3Command(['--from', dir], { RELAYCAST_FILE_STORE: 'local' }, io)).toBe(64);
    expect(await runMigrateFilesToS3Command(['--bogus'], env, io)).toBe(64);
    expect(lines.some((line) => line.includes('MISMATCH') && line.includes('ws3/f1/x.bin'))).toBe(true);
  });
});
