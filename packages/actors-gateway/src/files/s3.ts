/**
 * File bytes in an S3 bucket (AWS, or anything speaking the S3 API such as
 * MinIO or Cloudflare R2 through `endpoint`), one object per key at
 * `<prefix>/<key>`, with the signed content type as the object's
 * `Content-Type`. Credentials come from the SDK's default chain (environment,
 * shared config, IRSA/instance role). Any number of gateway replicas may
 * share a bucket.
 *
 * S3 needs an upload's length up front; `put` sends `ContentLength: size`
 * (the signed size) so a stream body never has to be buffered here.
 *
 * The SDK is imported on first use, never when another store is configured.
 */
import { Readable } from 'node:stream';
import type { GetObjectCommandOutput, S3Client } from '@aws-sdk/client-s3';
import { objectName, type FileObject, type FilePutOptions, type FileStore } from './store.js';

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/** The slice of `S3Client` this store uses (a test fake implements it, answering real command instances). */
export type S3ClientLike = Pick<S3Client, 'send'>;

export interface S3FileStoreOptions {
  bucket: string;
  region: string;
  /** Object key prefix without leading or trailing slash; empty or absent for none. */
  prefix?: string;
  /** Custom endpoint (MinIO, R2); unset for AWS. */
  endpoint?: string;
  /** `https://<bucket>.<host>` (false) or `https://<host>/<bucket>` (true, what most non-AWS endpoints need). */
  forcePathStyle: boolean;
  /** Substitute client (tests); otherwise an `S3Client` built from the options, created on first use. */
  client?: S3ClientLike;
}

type Sdk = typeof import('@aws-sdk/client-s3');

/**
 * A missing object (`NoSuchKey` on GET, the bodiless `NotFound` on HEAD). A
 * missing bucket is also a 404 but is the store failing, not the file being
 * absent, so it propagates (a HEAD 404 carries no code and still reads as
 * absent; GET and PUT surface the bucket).
 */
function isMissing(error: unknown): boolean {
  const e = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
  if (e?.name === 'NoSuchBucket') return false;
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}

function toReadable(body: unknown): Readable {
  if (body instanceof Readable) return body;
  const web = body as { transformToWebStream?: () => ReadableStream } | null;
  if (web?.transformToWebStream) return Readable.fromWeb(web.transformToWebStream() as unknown as import('node:stream/web').ReadableStream);
  throw new Error('S3 returned an object body of an unexpected type');
}

export class S3FileStore implements FileStore {
  readonly bucket: string;
  readonly prefix: string;
  readonly region: string;
  readonly endpoint: string | undefined;
  readonly forcePathStyle: boolean;
  private readonly injected: S3ClientLike | undefined;
  private loaded: Promise<{ sdk: Sdk; client: S3ClientLike }> | undefined;

  constructor(options: S3FileStoreOptions) {
    this.bucket = options.bucket;
    this.prefix = options.prefix ?? '';
    this.region = options.region;
    this.endpoint = options.endpoint;
    this.forcePathStyle = options.forcePathStyle;
    this.injected = options.client;
  }

  /** The object key for `key`; throws for a key this store refuses. */
  objectName(key: string): string {
    return objectName(this.prefix, key);
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
      // Non-AWS endpoints do not all accept the SDK's default CRC32 trailers
      // (aws-chunked uploads); only send checksums when the operation requires one.
      ...(endpoint ? { requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' } : {}),
    });
  }

  async put(key: string, body: Readable | Uint8Array, options: FilePutOptions): Promise<void> {
    const Key = this.objectName(key);
    if (body instanceof Uint8Array && body.byteLength !== options.size) {
      throw new Error(`body is ${body.byteLength} bytes, expected ${options.size}`);
    }
    const { sdk, client } = await this.load();
    await client.send(new sdk.PutObjectCommand({ Bucket: this.bucket, Key, Body: body, ContentType: options.contentType, ContentLength: options.size }));
  }

  async get(key: string): Promise<FileObject | null> {
    const Key = this.objectName(key);
    const { sdk, client } = await this.load();
    let object: GetObjectCommandOutput;
    try {
      object = await client.send(new sdk.GetObjectCommand({ Bucket: this.bucket, Key }));
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    if (typeof object.ContentLength !== 'number') throw new Error('S3 returned an object without a Content-Length');
    return { stream: toReadable(object.Body), size: object.ContentLength, contentType: object.ContentType || DEFAULT_CONTENT_TYPE };
  }

  async stat(key: string): Promise<{ size: number } | null> {
    const Key = this.objectName(key);
    const { sdk, client } = await this.load();
    try {
      const head = await client.send(new sdk.HeadObjectCommand({ Bucket: this.bucket, Key }));
      if (typeof head.ContentLength !== 'number') throw new Error('S3 returned an object without a Content-Length');
      return { size: head.ContentLength };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const Key = this.objectName(key);
    const { sdk, client } = await this.load();
    // DeleteObject answers 204 for a key that is already gone.
    await client.send(new sdk.DeleteObjectCommand({ Bucket: this.bucket, Key }));
  }
}
