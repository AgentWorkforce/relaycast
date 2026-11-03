/**
 * The one place a file store is chosen (`RELAYCAST_FILE_STORE`). Object
 * stores plug in here behind {@link FileStore} without touching the handler;
 * each validates its own `RELAYCAST_GCS_*` / `RELAYCAST_S3_*` variables and
 * refuses to start with a {@link ConfigError} naming the bad one.
 */
import { z } from 'zod';
import { ConfigError, parseEnv, type Env, type FileStoreKind } from '../config.js';
import { GcsFileStore } from './gcs.js';
import { LocalFileStore } from './local.js';
import { S3FileStore } from './s3.js';
import type { FileStore } from './store.js';

export type { FileObject, FilePutOptions, FileStore } from './store.js';
export { InvalidStorageKeyError, objectName } from './store.js';
export { LocalFileStore } from './local.js';
export { GcsFileStore, type GcsFileStoreOptions, type GcsStorageLike, type GcsFileLike } from './gcs.js';
export { S3FileStore, type S3FileStoreOptions, type S3ClientLike } from './s3.js';

export interface FileStoreOptions {
  kind: FileStoreKind;
  /** `local`: the directory file bytes live in. */
  fileDir: string;
  /** Where `gcs`/`s3` read their settings from (default `process.env`). */
  env?: Env;
}

/** An object name prefix: slashes trimmed, segments non-empty and not `.`/`..`; empty means none. */
const prefix = z.string().transform((value) => value.replace(/^\/+|\/+$/g, ''))
  .refine((value) => !value.includes('\\') && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'), 'must be a path of non-empty segments without . or ..');

const GcsEnvSchema = z.object({
  RELAYCAST_GCS_BUCKET: z.string({ error: 'is required when RELAYCAST_FILE_STORE=gcs' }).min(1),
  RELAYCAST_GCS_PREFIX: prefix.optional(),
});

const S3EnvSchema = z.object({
  RELAYCAST_S3_BUCKET: z.string({ error: 'is required when RELAYCAST_FILE_STORE=s3' }).min(1),
  RELAYCAST_S3_REGION: z.string().min(1).optional(),
  RELAYCAST_S3_ENDPOINT: z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' }).optional(),
  RELAYCAST_S3_PREFIX: prefix.optional(),
  RELAYCAST_S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).optional(),
});

export function createFileStore(options: FileStoreOptions): FileStore {
  const env = options.env ?? process.env;
  switch (options.kind) {
    case 'local':
      return new LocalFileStore(options.fileDir);
    case 'gcs': {
      const settings = parseEnv(GcsEnvSchema, env);
      return new GcsFileStore({ bucket: settings.RELAYCAST_GCS_BUCKET, prefix: settings.RELAYCAST_GCS_PREFIX });
    }
    case 's3': {
      const settings = parseEnv(S3EnvSchema, env);
      const endpoint = settings.RELAYCAST_S3_ENDPOINT;
      // A custom endpoint rarely cares about the region, so default it there
      // and demand it for AWS, where it picks the service host.
      const region = settings.RELAYCAST_S3_REGION ?? (endpoint ? 'us-east-1' : undefined);
      if (!region) throw new ConfigError('invalid_config', 'RELAYCAST_S3_REGION is required when RELAYCAST_FILE_STORE=s3 and RELAYCAST_S3_ENDPOINT is unset.');
      return new S3FileStore({
        bucket: settings.RELAYCAST_S3_BUCKET,
        prefix: settings.RELAYCAST_S3_PREFIX,
        region,
        endpoint,
        // Virtual-hosted buckets are AWS's default; most other endpoints need path style.
        forcePathStyle: settings.RELAYCAST_S3_FORCE_PATH_STYLE ? settings.RELAYCAST_S3_FORCE_PATH_STYLE === 'true' : endpoint !== undefined,
      });
    }
  }
}
