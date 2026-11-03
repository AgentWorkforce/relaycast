/**
 * File bytes in a Google Cloud Storage bucket, one object per key at
 * `<prefix>/<key>`, with the signed content type as the object's
 * `contentType`. Credentials come from Application Default Credentials
 * (Workload Identity, `GOOGLE_APPLICATION_CREDENTIALS`, or the metadata
 * server). Any number of gateway replicas may share a bucket.
 *
 * Uploads are always simple (`resumable: false`): bodies are bounded by
 * `RELAYCAST_MAX_UPLOAD_BYTES` and already in memory by the time the handler
 * calls `put`, so a resumable session would only add a round trip and
 * retry state for nothing.
 *
 * The SDK is imported on first use, never when another store is configured.
 */
import { Transform, type Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { objectName, type FileObject, type FilePutOptions, type FileStore } from './store.js';

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

export interface GcsObjectMetadata {
  size?: string | number;
  contentType?: string;
}

/** The slice of `@google-cloud/storage`'s `File` this store uses (a test fake implements it). */
export interface GcsFileLike {
  save(data: Uint8Array, options: { resumable: boolean; contentType: string }): Promise<void>;
  createWriteStream(options: { resumable: boolean; contentType: string }): Writable;
  createReadStream(): Readable;
  getMetadata(): Promise<[GcsObjectMetadata, ...unknown[]]>;
  delete(options: { ignoreNotFound: boolean }): Promise<unknown>;
}

/** The slice of `Storage` this store uses. */
export interface GcsStorageLike {
  bucket(name: string): { file(name: string): GcsFileLike };
}

export interface GcsFileStoreOptions {
  bucket: string;
  /** Object name prefix without leading or trailing slash; empty or absent for none. */
  prefix?: string;
  /** Substitute client (tests); otherwise `new Storage()` with ADC, created on first use. */
  storage?: GcsStorageLike;
}

/**
 * A missing object. The JSON API answers 404 for a missing bucket too ("The
 * specified bucket does not exist"); that is the store failing, not the file
 * being absent, so it propagates. (Checking the bucket with `exists()` would
 * need `storage.buckets.get`, which `roles/storage.objectAdmin` lacks.)
 */
function isMissing(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  return e?.code === 404 && !(typeof e.message === 'string' && /bucket/i.test(e.message));
}

/** Pass bytes through, failing the pipeline as soon as they exceed `size` or end short of it. */
function sized(size: number): Transform {
  let received = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.byteLength;
      if (received > size) return callback(new Error(`body exceeds ${size} bytes`));
      callback(null, chunk);
    },
    flush(callback) {
      if (received !== size) return callback(new Error(`body is ${received} bytes, expected ${size}`));
      callback();
    },
  });
}

export class GcsFileStore implements FileStore {
  readonly bucket: string;
  readonly prefix: string;
  private storage: Promise<GcsStorageLike> | undefined;

  constructor(options: GcsFileStoreOptions) {
    this.bucket = options.bucket;
    this.prefix = options.prefix ?? '';
    if (options.storage) this.storage = Promise.resolve(options.storage);
  }

  /** The object name for `key`; throws for a key this store refuses. */
  objectName(key: string): string {
    return objectName(this.prefix, key);
  }

  private async file(key: string): Promise<GcsFileLike> {
    const name = this.objectName(key);
    this.storage ??= import('@google-cloud/storage').then(({ Storage }) => new Storage());
    return (await this.storage).bucket(this.bucket).file(name);
  }

  async put(key: string, body: Readable | Uint8Array, options: FilePutOptions): Promise<void> {
    const file = await this.file(key);
    const upload = { resumable: false, contentType: options.contentType };
    if (body instanceof Uint8Array) {
      if (body.byteLength !== options.size) throw new Error(`body is ${body.byteLength} bytes, expected ${options.size}`);
      await file.save(body, upload);
    } else {
      await pipeline(body, sized(options.size), file.createWriteStream(upload));
    }
  }

  async get(key: string): Promise<FileObject | null> {
    const file = await this.file(key);
    let metadata: GcsObjectMetadata;
    try {
      [metadata] = await file.getMetadata();
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    return { stream: file.createReadStream(), size: Number(metadata.size ?? 0), contentType: metadata.contentType || DEFAULT_CONTENT_TYPE };
  }

  async stat(key: string): Promise<{ size: number } | null> {
    const file = await this.file(key);
    try {
      const [metadata] = await file.getMetadata();
      return { size: Number(metadata.size ?? 0) };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const file = await this.file(key);
    await file.delete({ ignoreNotFound: true });
  }
}
