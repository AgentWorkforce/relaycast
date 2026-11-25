/**
 * Where a workspace's durable log lives. Keys, under `<prefix>/<workspace>/`:
 *
 *   log/<seq>   one committed transaction's WAL segment; slot `seq` is
 *               written once (create-only), which fences writers: of two
 *               hosts that both think they own the workspace, only one wins
 *               each slot, and the other drops its copy and reloads.
 *   base/<seq>  the whole database file as of slot `seq`, written after a
 *               checkpoint; recovery starts from the newest one.
 *
 * Sequence numbers are zero-padded so keys sort, though S3 Express directory
 * buckets list unsorted and callers sort anyway.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';

export interface LogStore {
  /** Writes `key` only if it does not exist; `false` when another writer already did. */
  create(key: string, body: Buffer): Promise<boolean>;
  /** Overwrites `key` (base snapshots: a retry or a second writer writes the same bytes). */
  put(key: string, body: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  /** Every key under `prefix`, unsorted. */
  list(prefix: string): Promise<string[]>;
}

export function seqKey(seq: number): string {
  return String(seq).padStart(16, '0');
}

export function parseSeq(key: string): number {
  return Number(key.slice(key.lastIndexOf('/') + 1));
}

export class S3LogStore implements LogStore {
  constructor(private readonly client: S3Client, private readonly bucket: string) {}

  static fromEnvironment(bucket: string, region: string): S3LogStore {
    return new S3LogStore(new S3Client({ region }), bucket);
  }

  async create(key: string, body: Buffer): Promise<boolean> {
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, IfNoneMatch: '*' }));
      return true;
    } catch (error) {
      const status = (error as S3ServiceException).$metadata?.httpStatusCode;
      if (status === 412 || status === 409) return false;
      throw error;
    }
  }

  async put(key: string, body: Buffer): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body }));
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return Buffer.from(await response.Body!.transformToByteArray());
    } catch (error) {
      if ((error as S3ServiceException).$metadata?.httpStatusCode === 404) return null;
      throw error;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const object of page.Contents ?? []) if (object.Key) keys.push(object.Key);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }
}

/** A directory standing in for the bucket, for tests and local runs. */
export class FileLogStore implements LogStore {
  constructor(private readonly root: string) {}

  async create(key: string, body: Buffer): Promise<boolean> {
    const path = join(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, body, { flag: 'wx' });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  }

  async put(key: string, body: Buffer): Promise<void> {
    const path = join(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(join(this.root, key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const directory = join(this.root, prefix);
    try {
      return (await readdir(directory)).map((name) => `${prefix}${name}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}
