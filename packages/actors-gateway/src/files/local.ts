/**
 * File bytes on the gateway's own disk under `root`. Each object is a file at
 * `<root>/<key>` with its content type in a `<key>.type` sidecar. Run one
 * gateway instance on persistent storage with this store, or pick an object
 * store (`RELAYCAST_FILE_STORE=gcs|s3`) for several.
 */
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { InvalidStorageKeyError, type FileObject, type FilePutOptions, type FileStore } from './store.js';

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

function isMissing(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'ENOENT';
}

export class LocalFileStore implements FileStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** The file for `key`; throws when the key would resolve outside the root. */
  path(key: string): string {
    const path = resolve(this.root, ...key.split('/'));
    const prefix = this.root.endsWith(sep) ? this.root : this.root + sep;
    if (!path.startsWith(prefix)) throw new InvalidStorageKeyError(key);
    return path;
  }

  async put(key: string, body: Readable | Uint8Array, options: FilePutOptions): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    // The type goes first: a failed write leaves no bytes for HEAD to report.
    await writeFile(`${path}.type`, options.contentType);
    // Bytes land under a temporary name and move into place whole, so a
    // reader never sees a partial object; the name is unique per call, so two
    // uploads of one key (a client retry overlapping the first) never share it.
    const partial = `${path}.part-${process.pid}-${randomUUID()}`;
    try {
      if (body instanceof Uint8Array) {
        await writeFile(partial, body);
      } else {
        await pipeline(body, createWriteStream(partial));
      }
      const written = await stat(partial);
      if (written.size !== options.size) throw new Error(`wrote ${written.size} bytes, expected ${options.size}`);
      await rename(partial, path);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
  }

  async get(key: string): Promise<FileObject | null> {
    const path = this.path(key);
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    // Only a missing sidecar means "no recorded type"; any other read failure is the store failing.
    const contentType = await readFile(`${path}.type`, 'utf8').catch((error: unknown) => {
      if (isMissing(error)) return DEFAULT_CONTENT_TYPE;
      throw error;
    });
    return { stream: createReadStream(path), size, contentType: contentType || DEFAULT_CONTENT_TYPE };
  }

  async stat(key: string): Promise<{ size: number } | null> {
    try {
      return { size: (await stat(this.path(key))).size };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.path(key);
    // Bytes, then type, each already-gone-is-success, so a retry after the
    // bytes are gone still removes the type.
    await rm(path, { force: true });
    await rm(`${path}.type`, { force: true });
  }
}
