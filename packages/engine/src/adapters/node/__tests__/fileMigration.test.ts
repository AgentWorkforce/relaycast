import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// A minimal in-memory stand-in for the parts of the S3 SDK the store uses.
vi.mock('@aws-sdk/client-s3', () => {
  class Command { constructor(public input: Record<string, unknown>) {} }
  return {
    S3Client: class {},
    PutObjectCommand: class PutObjectCommand extends Command {},
    HeadObjectCommand: class HeadObjectCommand extends Command {},
    HeadBucketCommand: class HeadBucketCommand extends Command {},
    GetObjectCommand: class GetObjectCommand extends Command {},
    DeleteObjectCommand: class DeleteObjectCommand extends Command {},
  };
});

import { S3BlobStore, sha256Base64 } from '../s3Blobs.js';
import { migrateLocalFilesToS3 } from '../fileMigration.js';

type Obj = { bytes: Buffer; sha: string };
function fakeS3(objects: Map<string, Obj>, beforePut?: (key: string) => void) {
  const fail = (name: string, status: number) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
  return {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      const key = command.input.Key as string;
      switch (command.constructor.name) {
        case 'HeadBucketCommand': return {};
        case 'HeadObjectCommand': {
          const o = objects.get(key);
          if (!o) throw fail('NotFound', 404);
          return { ContentLength: o.bytes.byteLength, ChecksumSHA256: o.sha };
        }
        case 'PutObjectCommand': {
          beforePut?.(key);
          if (command.input.IfNoneMatch === '*' && objects.has(key)) throw fail('PreconditionFailed', 412);
          const bytes = command.input.Body as Buffer;
          objects.set(key, { bytes, sha: sha256Base64(bytes) });
          return {};
        }
        default: throw new Error(`unexpected ${command.constructor.name}`);
      }
    },
  };
}

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await chmod(join(dir, 'w1'), 0o755).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
async function volume(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'relaycast-migrate-'));
  dirs.push(dir);
  for (const [key, body] of Object.entries(files)) {
    await mkdir(join(dir, ...key.split('/').slice(0, -1)), { recursive: true });
    await writeFile(join(dir, ...key.split('/')), body);
  }
  return dir;
}

describe('migrateLocalFilesToS3', () => {
  it('copies with a create-only write and never replaces bytes a live server stored meanwhile', async () => {
    const dir = await volume({ 'w1/f1/a.txt': 'old local bytes', 'w1/f2/b.txt': 'b' });
    const objects = new Map<string, Obj>();
    // A live server stores newer bytes for a.txt between the absence check and the copy.
    const newer = Buffer.from('newer bytes from a live server');
    const store = new S3BlobStore({ bucket: 'b', region: 'us-east-1', client: fakeS3(objects, (key) => {
      if (key === 'w1/f1/a.txt' && !objects.has(key)) objects.set(key, { bytes: newer, sha: sha256Base64(newer) });
    }) as never });
    const summary = await migrateLocalFilesToS3({ dir, store, rows: [
      { storageKey: 'w1/f1/a.txt', status: 'complete', sizeBytes: 15 },
      { storageKey: 'w1/f2/b.txt', status: 'complete', sizeBytes: 1 },
    ] });
    expect(objects.get('w1/f1/a.txt')!.bytes.equals(newer)).toBe(true);
    expect(summary.mismatched).toEqual(['w1/f1/a.txt']);
    expect(summary.copied).toBe(1);
    expect(summary.failed).toEqual([]);
  });

  it('fails instead of treating an unreadable directory as empty', async () => {
    if (process.getuid?.() === 0) return; // root reads through mode 000
    const dir = await volume({ 'w1/f1/a.txt': 'a' });
    await chmod(join(dir, 'w1'), 0o000);
    const store = new S3BlobStore({ bucket: 'b', region: 'us-east-1', client: fakeS3(new Map()) as never });
    await expect(migrateLocalFilesToS3({ dir, store, rows: [{ storageKey: 'w1/f1/a.txt', status: 'complete', sizeBytes: 1 }] }))
      .rejects.toThrow(/cannot read/);
  });

  it('treats a missing volume directory as empty', async () => {
    const store = new S3BlobStore({ bucket: 'b', region: 'us-east-1', client: fakeS3(new Map()) as never });
    const summary = await migrateLocalFilesToS3({ dir: join(tmpdir(), `relaycast-missing-${Date.now()}`), store, rows: [] });
    expect(summary.copied).toBe(0);
  });
});
