/**
 * File bytes in an S3 bucket (AWS, or anything speaking the S3 API, such as
 * MinIO, through `endpoint`), one object per storage key at `<prefix>/<key>`,
 * with the signed content type as the object's `Content-Type`. Ported from the
 * actors gateway's `files/s3.ts` (the gateway depends on the engine, so the
 * engine cannot import it).
 *
 * Credentials come only from the AWS SDK's default chain (IRSA / EKS Pod
 * Identity / instance role / shared config); the engine adds no static-key
 * configuration. Every write carries a SHA-256 checksum that S3 verifies and
 * stores, so an object's integrity can be checked later (see
 * {@link S3BlobStore.statWithChecksum}, used by the local-to-S3 migration).
 *
 * The SDK is imported on first use, never when the disk store is configured.
 */
import { createHash } from 'node:crypto';
import type { S3Client } from '@aws-sdk/client-s3';
import type { FileBlobStore } from './files.js';

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/** The slice of `S3Client` this store uses (a test fake implements it, answering real command instances). */
export type S3ClientLike = Pick<S3Client, 'send'>;

export interface S3BlobStoreOptions {
  bucket: string;
  region: string;
  /** Object key prefix without leading or trailing slash; empty or absent for none. */
  prefix?: string;
  /** Custom endpoint (MinIO and other S3-compatible stores); unset for AWS. */
  endpoint?: string;
  /** Path-style addressing (`https://<host>/<bucket>`), what most non-AWS endpoints need. */
  forcePathStyle?: boolean;
  /** Substitute client (tests); otherwise an `S3Client` built from the options, created on first use. */
  client?: S3ClientLike;
}

type Sdk = typeof import('@aws-sdk/client-s3');

/**
 * A missing object (`NoSuchKey` on GET, the bodiless `NotFound` on HEAD). A
 * missing bucket is also a 404 but is the store failing, not the file being
 * absent, so it propagates.
 */
function isMissing(error: unknown): boolean {
  const e = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
  if (e?.name === 'NoSuchBucket') return false;
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}

/** Base64 SHA-256 of `bytes`, the form S3's `ChecksumSHA256` takes. */
export function sha256Base64(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('base64');
}

/**
 * `key` as an object name under `prefix`. Keys are `<workspace>/<file>/<name>`
 * and already checked by the signed token; this second fence refuses an empty,
 * `.` or `..` segment (so also a leading or trailing slash) or a backslash.
 */
export function objectName(prefix: string, key: string): string {
  if (!key || key.includes('\\') || key.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw Object.assign(new Error('invalid storage key'), { code: 'invalid_key', status: 400 });
  }
  return prefix ? `${prefix}/${key}` : key;
}

export class S3BlobStore implements FileBlobStore {
  readonly bucket: string;
  readonly prefix: string;
  readonly region: string;
  readonly endpoint: string | undefined;
  readonly forcePathStyle: boolean;
  private readonly injected: S3ClientLike | undefined;
  private loaded: Promise<{ sdk: Sdk; client: S3ClientLike }> | undefined;

  constructor(options: S3BlobStoreOptions) {
    this.bucket = options.bucket;
    this.prefix = options.prefix ?? '';
    this.region = options.region;
    this.endpoint = options.endpoint;
    this.forcePathStyle = options.forcePathStyle ?? false;
    this.injected = options.client;
  }

  private load(): Promise<{ sdk: Sdk; client: S3ClientLike }> {
    this.loaded ??= import('@aws-sdk/client-s3').then((sdk) => ({ sdk, client: this.injected ?? this.createClient(sdk) }));
    return this.loaded;
  }

  private createClient(sdk: Sdk): S3ClientLike {
    const { region, endpoint, forcePathStyle } = this;
    return new sdk.S3Client({
      region,
      endpoint,
      forcePathStyle,
      // Non-AWS endpoints do not all accept the SDK's default CRC32 trailers;
      // only send checksums the request asks for (our explicit SHA-256).
      ...(endpoint ? { requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' } : {}),
    });
  }

  async write(key: string, bytes: Buffer, contentType: string): Promise<void> {
    const Key = objectName(this.prefix, key);
    const { sdk, client } = await this.load();
    // PutObject replaces the object atomically: a reader sees the old or the
    // new bytes, never a mix. S3 rejects the write if the bytes do not match
    // the checksum.
    await client.send(new sdk.PutObjectCommand({
      Bucket: this.bucket,
      Key,
      Body: bytes,
      ContentType: contentType || DEFAULT_CONTENT_TYPE,
      ContentLength: bytes.byteLength,
      ChecksumSHA256: sha256Base64(bytes),
    }));
  }

  async read(key: string): Promise<{ bytes: Buffer; contentType: string } | null> {
    const Key = objectName(this.prefix, key);
    const { sdk, client } = await this.load();
    let object;
    try {
      object = await client.send(new sdk.GetObjectCommand({ Bucket: this.bucket, Key }));
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    const body = object.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
    if (!body?.transformToByteArray) throw new Error('S3 returned an object body of an unexpected type');
    return {
      bytes: Buffer.from(await body.transformToByteArray()),
      contentType: object.ContentType || DEFAULT_CONTENT_TYPE,
    };
  }

  async stat(key: string): Promise<{ sizeBytes: number } | null> {
    const head = await this.statWithChecksum(key);
    return head ? { sizeBytes: head.sizeBytes } : null;
  }

  /** Size and stored SHA-256 (base64; undefined if the object was written without one), or null when absent. */
  async statWithChecksum(key: string): Promise<{ sizeBytes: number; sha256?: string } | null> {
    const Key = objectName(this.prefix, key);
    const { sdk, client } = await this.load();
    try {
      const head = await client.send(new sdk.HeadObjectCommand({ Bucket: this.bucket, Key, ChecksumMode: 'ENABLED' }));
      if (typeof head.ContentLength !== 'number') throw new Error('S3 returned an object without a Content-Length');
      return { sizeBytes: head.ContentLength, ...(head.ChecksumSHA256 ? { sha256: head.ChecksumSHA256 } : {}) };
    } catch (error) {
      if (!isMissing(error)) throw error;
      // A HEAD 404 has no body, so a missing bucket looks like a missing
      // object; tell them apart before reporting absence (which would make the
      // engine ask the client to upload again).
      await client.send(new sdk.HeadBucketCommand({ Bucket: this.bucket })).catch((cause: unknown) => {
        throw new Error(`S3 bucket ${this.bucket} is not reachable: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
      });
      return null;
    }
  }

  async delete(keys: string[]): Promise<void> {
    const { sdk, client } = await this.load();
    for (const key of keys) {
      // DeleteObject answers 204 for a key that is already gone.
      await client.send(new sdk.DeleteObjectCommand({ Bucket: this.bucket, Key: objectName(this.prefix, key) }));
    }
  }
}
