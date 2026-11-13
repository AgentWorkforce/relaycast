/**
 * Copy the local file store into S3 for a switch to `RELAYCAST_FILE_STORE=s3`.
 *
 * The database decides what to copy: every `files` row that is not deleted,
 * so a file deleted after an earlier run is never resurrected, and no file is
 * skipped because of its name. For each referenced key:
 *
 * - already in the bucket: verified against the local bytes (or the row's
 *   size when the local copy is gone); different bytes are a MISMATCH and are
 *   never overwritten;
 * - only on disk: copied with its content type, then verified by size and
 *   SHA-256;
 * - nowhere: a FAILURE for a `complete` file (its bytes are lost); fine for a
 *   `pending` one (an upload that never finished).
 *
 * Local objects no row references are counted and reported, never copied.
 * Idempotent and resumable; local files are never deleted. Memory: one file
 * per worker (`concurrency`, default 4) is held at a time.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { objectName, sha256Base64, type S3BlobStore } from './s3Blobs.js';

/** A `files` row the migration must account for. */
export interface FileRow {
  storageKey: string;
  status: string;
  sizeBytes: number;
}

export interface FileMigrationSummary {
  /** Objects uploaded and verified by this run. */
  copied: number;
  /** Objects already in the bucket and verified. */
  alreadyPresent: number;
  /** `pending` rows with no bytes anywhere (uploads that never finished). */
  pendingWithoutBytes: number;
  /** Local objects no live row references (not copied). */
  unreferenced: string[];
  /** Keys whose bucket object differs from the local bytes or the row (left untouched). */
  mismatched: string[];
  /** Keys that could not be copied or verified, with the reason. */
  failed: Array<{ key: string; error: string }>;
}

/** The temporary DiskBlobStore writes beside an object: `<name>.<uuid>.tmp` (and its `.ct`). */
const DISK_TEMPORARY = /\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp(\.ct)?$/;

/** Every regular file under `dir`, as `/`-separated relative paths. */
async function listFiles(dir: string): Promise<Set<string>> {
  const found = new Set<string>();
  const walk = async (path: string): Promise<void> => {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) found.add(relative(dir, full).split(sep).join('/'));
    }
  };
  await walk(dir);
  return found;
}

async function readLocal(dir: string, key: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  const path = join(dir, ...key.split('/'));
  try {
    const bytes = await readFile(path);
    const contentType = await readFile(`${path}.ct`, 'utf8').then((value) => value.trim() || 'application/octet-stream', () => 'application/octet-stream');
    return { bytes, contentType };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** True when the bucket holds exactly `bytes` under `key` (by stored SHA-256, else by reading it back). */
async function bucketMatches(store: S3BlobStore, key: string, bytes: Buffer, stored: { sizeBytes: number; sha256?: string }): Promise<boolean> {
  if (stored.sizeBytes !== bytes.byteLength) return false;
  const expected = sha256Base64(bytes);
  if (stored.sha256) return stored.sha256 === expected;
  // An S3-compatible store that does not return the checksum: compare the bytes.
  const object = await store.read(key);
  return object !== null && sha256Base64(object.bytes) === expected;
}

export async function migrateLocalFilesToS3(opts: {
  dir: string;
  store: S3BlobStore;
  rows: readonly FileRow[];
  log?: (line: string) => void;
  concurrency?: number;
}): Promise<FileMigrationSummary> {
  const log = opts.log ?? (() => {});
  const summary: FileMigrationSummary = { copied: 0, alreadyPresent: 0, pendingWithoutBytes: 0, unreferenced: [], mismatched: [], failed: [] };
  const rows = opts.rows.filter((row) => row.status !== 'deleted');
  const local = await listFiles(opts.dir);

  // `X.ct` beside an object `X` is X's content-type sidecar (each file has its
  // own `<workspace>/<fileId>/` directory, so a real upload named `*.ct` never
  // sits next to another object); DiskBlobStore's own temporaries are not
  // objects. Anything else on disk that no row references is reported.
  const referenced = new Set(rows.map((row) => row.storageKey));
  for (const path of local) {
    if (referenced.has(path)) continue;
    if (path.endsWith('.ct') && local.has(path.slice(0, -3))) continue;
    if (DISK_TEMPORARY.test(path)) continue;
    summary.unreferenced.push(path);
  }
  summary.unreferenced.sort();
  log(`file migration: ${rows.length} live file rows; ${local.size} local paths under ${opts.dir}`);

  const migrateOne = async (row: FileRow) => {
    const key = row.storageKey;
    try {
      objectName(opts.store.prefix, key);
      const onDisk = local.has(key) ? await readLocal(opts.dir, key) : null;
      const stored = await opts.store.statWithChecksum(key);
      if (stored) {
        const ok = onDisk
          ? await bucketMatches(opts.store, key, onDisk.bytes, stored)
          : row.status !== 'complete' || stored.sizeBytes === row.sizeBytes;
        if (ok) summary.alreadyPresent += 1;
        else summary.mismatched.push(key);
        return;
      }
      if (!onDisk) {
        if (row.status === 'complete') throw new Error('complete file is neither on disk nor in the bucket');
        summary.pendingWithoutBytes += 1;
        return;
      }
      if (row.status === 'complete' && onDisk.bytes.byteLength !== row.sizeBytes) {
        throw new Error(`local file is ${onDisk.bytes.byteLength} bytes, the row says ${row.sizeBytes}`);
      }
      await opts.store.write(key, onDisk.bytes, onDisk.contentType);
      const written = await opts.store.statWithChecksum(key);
      if (!written || !(await bucketMatches(opts.store, key, onDisk.bytes, written))) {
        throw new Error('uploaded object does not match the local bytes');
      }
      summary.copied += 1;
    } catch (err) {
      summary.failed.push({ key, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const concurrency = Math.max(1, opts.concurrency ?? 4);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
    while (next < rows.length) await migrateOne(rows[next++]!);
  }));
  summary.mismatched.sort();
  summary.failed.sort((a, b) => a.key.localeCompare(b.key));

  log(`file migration: copied=${summary.copied} already_present=${summary.alreadyPresent} pending_without_bytes=${summary.pendingWithoutBytes} unreferenced=${summary.unreferenced.length} mismatched=${summary.mismatched.length} failed=${summary.failed.length}`);
  for (const key of summary.mismatched) log(`file migration: MISMATCH (bucket object differs, left untouched): ${key}`);
  for (const { key, error } of summary.failed) log(`file migration: FAILED ${key}: ${error}`);
  for (const path of summary.unreferenced) log(`file migration: unreferenced local object (no live file row; not copied): ${path}`);
  return summary;
}
