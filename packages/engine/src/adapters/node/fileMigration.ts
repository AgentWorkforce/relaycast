/**
 * One-shot copy of the local file store into S3 before switching a server to
 * `RELAYCAST_FILE_STORE=s3`. Idempotent and resumable: an object already in
 * the bucket with the same size and SHA-256 is skipped. An object there with
 * different bytes is reported and never overwritten. Local files are never
 * deleted, so the PVC stays a complete rollback until the operator removes it.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { objectName, sha256Base64, type S3BlobStore } from './s3Blobs.js';

export interface FileMigrationSummary {
  /** Objects uploaded and verified by this run. */
  copied: number;
  /** Objects already in the bucket with matching size and SHA-256. */
  alreadyPresent: number;
  /** Keys whose bucket object has different bytes (left untouched). */
  mismatched: string[];
  /** Keys that could not be copied or verified, with the reason. */
  failed: Array<{ key: string; error: string }>;
}

/** Storage keys under `dir`: every regular file except content-type sidecars and crashed-write temporaries. */
async function listKeys(dir: string): Promise<string[]> {
  const keys: string[] = [];
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && !entry.name.endsWith('.ct') && !/\.tmp(\.ct)?$/.test(entry.name)) {
        keys.push(relative(dir, full).split(sep).join('/'));
      }
    }
  };
  await walk(dir);
  return keys.sort();
}

export async function migrateLocalFilesToS3(opts: {
  dir: string;
  store: S3BlobStore;
  log?: (line: string) => void;
  concurrency?: number;
}): Promise<FileMigrationSummary> {
  const log = opts.log ?? (() => {});
  const summary: FileMigrationSummary = { copied: 0, alreadyPresent: 0, mismatched: [], failed: [] };
  const keys = await listKeys(opts.dir);
  log(`file migration: ${keys.length} local objects under ${opts.dir}`);

  const migrateOne = async (key: string) => {
    try {
      objectName(opts.store.prefix, key);
      const bytes = await readFile(join(opts.dir, ...key.split('/')));
      const contentType = await readFile(join(opts.dir, ...key.split('/')) + '.ct', 'utf8')
        .then((value) => value.trim() || 'application/octet-stream', () => 'application/octet-stream');
      const sha256 = sha256Base64(bytes);
      const existing = await opts.store.statWithChecksum(key);
      if (existing) {
        if (existing.sizeBytes === bytes.byteLength && existing.sha256 === sha256) {
          summary.alreadyPresent += 1;
          return;
        }
        summary.mismatched.push(key);
        return;
      }
      await opts.store.write(key, bytes, contentType);
      const stored = await opts.store.statWithChecksum(key);
      if (!stored || stored.sizeBytes !== bytes.byteLength || stored.sha256 !== sha256) {
        throw new Error('uploaded object does not match the local bytes');
      }
      summary.copied += 1;
    } catch (err) {
      summary.failed.push({ key, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const concurrency = Math.max(1, opts.concurrency ?? 8);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, async () => {
    while (next < keys.length) await migrateOne(keys[next++]!);
  }));

  log(`file migration: copied=${summary.copied} already_present=${summary.alreadyPresent} mismatched=${summary.mismatched.length} failed=${summary.failed.length}`);
  for (const key of summary.mismatched) log(`file migration: MISMATCH (bucket object differs, left untouched): ${key}`);
  for (const { key, error } of summary.failed) log(`file migration: FAILED ${key}: ${error}`);
  return summary;
}
