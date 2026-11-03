/**
 * Where file bytes live. The actors never see bytes: they sign `/_relayfiles`
 * URLs and the gateway moves bytes in and out of a store behind this
 * interface. `local` keeps them on disk; `gcs` and `s3` implement the same
 * interface against an object store.
 */
import type { Readable } from 'node:stream';

export interface FilePutOptions {
  /** Exact byte length of `body`, as the signed upload token binds it. */
  size: number;
  /** Content type to serve the object with later (the signed one, never sniffed). */
  contentType: string;
}

export interface FileObject {
  stream: Readable;
  size: number;
  contentType: string;
}

export interface FileStore {
  put(key: string, body: Readable | Uint8Array, options: FilePutOptions): Promise<void>;
  get(key: string): Promise<FileObject | null>;
  stat(key: string): Promise<{ size: number } | null>;
  /** Idempotent: an object already gone is success. Any other failure throws. */
  delete(key: string): Promise<void>;
}

/** Thrown by a store for a key it refuses to resolve (for example one that would escape its root). */
export class InvalidStorageKeyError extends Error {
  constructor(key: string) {
    super(`Invalid storage key: ${key}`);
    this.name = 'InvalidStorageKeyError';
  }
}
