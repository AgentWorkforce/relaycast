/**
 * In-memory stand-ins for the slices of `@google-cloud/storage` and
 * `@aws-sdk/client-s3` the object stores use, with the SDKs' not-found
 * signalling (`code: 404` / `NoSuchKey` + `NotFound`).
 */
import { PassThrough, Readable, Writable } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { GcsFileLike, GcsStorageLike } from '../files/gcs.js';

export interface StoredObject {
  bytes: Buffer;
  contentType: string | undefined;
}

export interface FakeObjects {
  /** `<bucket>/<object name>` → object. */
  objects: Map<string, StoredObject>;
  /** Every call, in order, as `op bucket/name`. */
  calls: string[];
}

async function collect(body: unknown): Promise<Buffer> {
  if (body instanceof Uint8Array) return Buffer.from(body);
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array | string>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export function fakeGcsStorage(): FakeObjects & { storage: GcsStorageLike } {
  const objects = new Map<string, StoredObject>();
  const calls: string[] = [];
  const notFound = () => Object.assign(new Error('No such object'), { code: 404 });
  const file = (bucket: string, name: string): GcsFileLike => {
    const id = `${bucket}/${name}`;
    return {
      async save(data, options) {
        calls.push(`save ${id}`);
        objects.set(id, { bytes: Buffer.from(data), contentType: options.contentType });
      },
      createWriteStream(options) {
        calls.push(`write ${id}`);
        // The object exists once the stream finishes, as the SDK's does; a
        // source that fails never reaches `final` and the uploader hears it from `pipeline`.
        const chunks: Buffer[] = [];
        return new Writable({
          write(chunk: Buffer, _encoding, callback) {
            chunks.push(Buffer.from(chunk));
            callback();
          },
          final(callback) {
            objects.set(id, { bytes: Buffer.concat(chunks), contentType: options.contentType });
            callback();
          },
        });
      },
      createReadStream() {
        calls.push(`read ${id}`);
        const object = objects.get(id);
        if (!object) {
          const stream = new PassThrough();
          stream.destroy(notFound());
          return stream;
        }
        return Readable.from([object.bytes]);
      },
      async getMetadata() {
        calls.push(`metadata ${id}`);
        const object = objects.get(id);
        if (!object) throw notFound();
        return [{ size: String(object.bytes.byteLength), contentType: object.contentType }];
      },
      async delete(options) {
        calls.push(`delete ${id}`);
        if (!objects.delete(id) && !options.ignoreNotFound) throw notFound();
      },
    };
  };
  return { objects, calls, storage: { bucket: (bucket) => ({ file: (name) => file(bucket, name) }) } };
}

export function fakeS3Client(): FakeObjects & { client: Pick<S3Client, 'send'> } {
  const objects = new Map<string, StoredObject>();
  const calls: string[] = [];
  const missing = (name: 'NoSuchKey' | 'NotFound') => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: 404 } });
  const send = async (command: unknown): Promise<unknown> => {
    if (command instanceof PutObjectCommand) {
      const { Bucket, Key, Body, ContentType, ContentLength } = command.input;
      const id = `${Bucket}/${Key}`;
      calls.push(`put ${id}`);
      const bytes = await collect(Body);
      if (bytes.byteLength !== ContentLength) throw Object.assign(new Error('XAmzContentSHA256Mismatch'), { name: 'BadDigest' });
      objects.set(id, { bytes, contentType: ContentType });
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const id = `${command.input.Bucket}/${command.input.Key}`;
      calls.push(`get ${id}`);
      const object = objects.get(id);
      if (!object) throw missing('NoSuchKey');
      return { Body: Readable.from([object.bytes]), ContentLength: object.bytes.byteLength, ContentType: object.contentType };
    }
    if (command instanceof HeadObjectCommand) {
      const id = `${command.input.Bucket}/${command.input.Key}`;
      calls.push(`head ${id}`);
      const object = objects.get(id);
      if (!object) throw missing('NotFound');
      return { ContentLength: object.bytes.byteLength, ContentType: object.contentType };
    }
    if (command instanceof DeleteObjectCommand) {
      const id = `${command.input.Bucket}/${command.input.Key}`;
      calls.push(`delete ${id}`);
      objects.delete(id);
      return {};
    }
    throw new Error(`fake S3 client cannot answer ${(command as { constructor: { name: string } }).constructor.name}`);
  };
  return { objects, calls, client: { send: send as S3Client['send'] } };
}
